#!/usr/bin/env bash
# 從頭建立正式資料庫 lexicon：清空 → 載入 db/*.sql → 匯入資料。
# 用法：bash data/import.sh
# 會清掉 lexicon 裡現有的所有資料。
set -euo pipefail
cd "$(dirname "$0")/.."

# 預設連到 docker compose 的 PostgreSQL；設定 PSQL 可以改連別的（例如 PSQL="psql -d lexicon"）
if [ -z "${PSQL:-}" ]; then
  docker compose up -d --wait postgres >/dev/null
  PSQL="docker compose exec -T postgres psql -U lexicon -d lexicon"
fi
db() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
if [ -z "${MONGO:-}" ]; then
  docker compose up -d --wait mongo >/dev/null
  MONGO="docker compose exec -T mongo"
fi
export_csv() {  # export_csv 檔名 查詢：從 PostgreSQL 匯出給 generate_mongo.py
  db -c "SET TIME ZONE 'UTC'" -c "COPY ($2) TO STDOUT (FORMAT csv)" > "data/build/$1"
}
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

step "2b、2c 重演歷史（真實版本＋生成資料）"
python3 data/replay.py | db -o /dev/null

step "收尾"
reset_ids
db -c "REFRESH MATERIALIZED VIEW candidate_stats" -c "ANALYZE"

step "2d 生成 MongoDB 的紀錄"
ISO="'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'"
export_csv pg_entries.csv "
  SELECT e.entry_id, w.text, e.bopomofo, e.frequency,
         to_char(CASE WHEN e.source_id = 1 THEN (SELECT published_at FROM releases WHERE version = '0.1.0')
                      ELSE a.published_at END, $ISO),
         to_char(rm.published_at, $ISO)
    FROM lexicon_entries e JOIN words w USING (word_id)
    LEFT JOIN LATERAL (SELECT r.published_at FROM release_changes c JOIN releases r USING (release_id)
                        WHERE c.entry_id = e.entry_id AND c.action = 'add') a ON true
    LEFT JOIN LATERAL (SELECT r.published_at FROM release_changes c JOIN releases r USING (release_id)
                        WHERE c.entry_id = e.entry_id AND c.action = 'remove' AND r.status = 'published') rm ON true"
export_csv pg_releases.csv "SELECT version, to_char(published_at, $ISO) FROM releases WHERE status = 'published'"
export_csv pg_devices.csv "SELECT device_id, to_char(first_seen, $ISO), to_char(last_synced_at, $ISO) FROM devices WHERE platform <> 'web'"
export_csv pg_users.csv "SELECT user_id, to_char(created_at, $ISO) FROM users WHERE status = 'active'"
export_csv pg_pending_readings.csv "SELECT DISTINCT s.typed FROM submissions s JOIN word_reviews r USING (word_id) WHERE r.status = 'pending'"
export_csv pg_decided_words.csv "SELECT w.word_id, w.text FROM word_reviews r JOIN words w USING (word_id) WHERE r.status <> 'pending'"
python3 data/generate_mongo.py
if [ -z "${NO_MONGO:-}" ]; then
  for c in selection_events query_logs review_history; do
    echo "   匯入 $c"
    $MONGO mongoimport --quiet --db lexicon --collection "$c" --drop < "data/build/$c.ndjson"
  done
  $MONGO mongosh --quiet lexicon --eval "$(cat data/mongo_indexes.js)"
fi

step "版本"
db -c "SELECT r.version AS 版本, to_char(r.published_at AT TIME ZONE 'Asia/Taipei', 'MM-DD HH24:MI') AS 發布,
              count(*) FILTER (WHERE c.action = 'add') AS 新增, count(*) FILTER (WHERE c.action = 'remove') AS 停用
         FROM releases r LEFT JOIN release_changes c USING (release_id)
        GROUP BY r.release_id ORDER BY version_key(r.version)"

step "完成，各表筆數："
db -c "SELECT relname AS 資料表, n_live_tup AS 筆數 FROM pg_stat_user_tables ORDER BY n_live_tup DESC"
