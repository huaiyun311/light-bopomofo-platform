#!/usr/bin/env bash
# 從頭建立正式資料庫 lexicon：清空 → 載入 db/*.sql → 匯入資料。
# 用法：bash data/import.sh
# 會清掉 lexicon 裡現有的所有資料。
set -eu
cd "$(dirname "$0")/.."

# 預設連到 docker compose 的 PostgreSQL；設定 PSQL 可以改連別的（例如 PSQL="psql -d lexicon"）
if [ -z "${PSQL:-}" ]; then
  docker compose up -d --wait postgres >/dev/null
  PSQL="docker compose exec -T postgres psql -U lexicon -d lexicon"
fi
db() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
copy() {  # copy 資料表 "欄位" 檔案
  echo "   $1"
  db -c "COPY $1 ($2) FROM STDIN (FORMAT csv)" < "data/build/$3"
}
reset_ids() {
  # 自己指定了代號，要把自動編號接到最大值後面，之後新增的才不會撞號
  db <<'SQL'
DO $$
DECLARE r record; m bigint;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND is_identity = 'YES' LOOP
    EXECUTE format('SELECT coalesce(max(%I), 0) FROM %I', r.column_name, r.table_name) INTO m;
    PERFORM setval(pg_get_serial_sequence(r.table_name, r.column_name), m + 1, false);
  END LOOP;
END $$;
SQL
}
started=$(date +%s)
step() { echo "== [$(( $(date +%s) - started ))s] $1"; }

step "下載真實資料"
bash data/fetch.sh

step "清理成 CSV"
python3 data/prepare_real.py

step "重建資料表"
db -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
for f in db/*.sql; do db < "$f"; done

step "2a 匯入真實資料"
db <<'SQL'
INSERT INTO sources (source_id, name, license, url, version) VALUES
  (1, '新酷音 tsi.csv', 'LGPL-2.1-or-later', 'https://github.com/chewing/libchewing-data', '2025.8.19'),
  (2, '使用者投稿', NULL, NULL, NULL),
  (3, '編輯', NULL, NULL, NULL);
SQL
copy words "word_id, text, corpus_count" words.csv
copy lexicon_entries "entry_id, word_id, bopomofo, frequency, source_id, status, updated_at" lexicon_entries.csv
copy word_pairs "word_id, next_word_id, pmi" word_pairs.csv

reset_ids

step "2b 重演真實版本"
python3 data/replay.py | db -o /dev/null

step "收尾"
reset_ids
db -c "ANALYZE"

step "版本"
db -c "SELECT r.version AS 版本, to_char(r.published_at AT TIME ZONE 'Asia/Taipei', 'MM-DD HH24:MI') AS 發布,
              count(*) FILTER (WHERE c.action = 'add') AS 新增, count(*) FILTER (WHERE c.action = 'remove') AS 停用
         FROM releases r LEFT JOIN release_changes c USING (release_id)
        GROUP BY r.release_id ORDER BY version_key(r.version)"

step "完成，各表筆數："
db -c "SELECT relname AS 資料表, n_live_tup AS 筆數 FROM pg_stat_user_tables ORDER BY n_live_tup DESC"
