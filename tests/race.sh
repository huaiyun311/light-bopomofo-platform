#!/usr/bin/env bash
# 併行測試：兩位編輯同時搶最後一個新詞名額。
# 編輯 A 加入「國旅券」後故意停 3 秒才提交；編輯 B 在第 1 秒按加入「普發」。
# 預期：B 會被擋住、等 A 提交，然後收到「名額已滿」，而不是兩個都成功（超賣）。
set -u
cd "$(dirname "$0")/.."
psql() { docker compose exec -T postgres psql -U lexicon -d lexicon_test -v ON_ERROR_STOP=1 -v VERBOSITY=terse -X -q "$@"; }

psql <<'SQL'
INSERT INTO users (user_id, email, password_hash, display_name, role) VALUES
  (901, 'a@test', 'x', '編輯A', 'editor'), (902, 'b@test', 'x', '編輯B', 'editor');
INSERT INTO sources (name) VALUES ('使用者投稿') ON CONFLICT DO NOTHING;
INSERT INTO words (word_id, text) VALUES (901, '國旅券'), (902, '普發');
INSERT INTO word_reviews (word_id) VALUES (901), (902);
INSERT INTO releases (version, max_new_words, created_by) VALUES ('9.0', 1, 901);
SQL

start=$(date +%s)
echo "[0s] 編輯 A 開始加入國旅券（交易會停 3 秒）"
psql -c "BEGIN;
         SELECT approve_word(901, 901, 1, '[{\"bopomofo\":\"ㄍㄨㄛˊ ㄌㄩˇ ㄑㄩㄢˋ\",\"frequency\":500}]');
         SELECT pg_sleep(3);
         COMMIT;" >/dev/null &
sleep 1
echo "[1s] 編輯 B 按下加入普發"
out=$(psql -c "SELECT approve_word(902, 902, 1, '[{\"bopomofo\":\"ㄆㄨˇ ㄈㄚ\",\"frequency\":300}]');" 2>&1)
echo "[$(( $(date +%s) - start ))s] 編輯 B 收到：${out}"
wait
echo "[$(( $(date +%s) - start ))s] 結果：9.0 的新詞 = $(psql -tAc "SELECT string_agg(w.text, '、') FROM release_changes c JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id)")"
