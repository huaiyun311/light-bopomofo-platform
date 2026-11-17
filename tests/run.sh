#!/usr/bin/env bash
# 建一個臨時的測試資料庫 lexicon_test，載入 db/*.sql，跑冒煙測試和併行測試，跑完就刪掉。
# 正式資料庫 lexicon 完全不會被碰到。
# 用法：bash tests/run.sh（會自動啟動資料庫並等它準備好）
set -eu
cd "$(dirname "$0")/.."
admin() { docker compose exec -T postgres psql -U lexicon -d postgres -X -q "$@"; }
test_db() { docker compose exec -T postgres psql -U lexicon -d lexicon_test -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "== 等資料庫準備好"
docker compose up -d --wait postgres

echo "== 建立測試資料庫"
admin -c "DROP DATABASE IF EXISTS lexicon_test" -c "CREATE DATABASE lexicon_test"
for f in db/*.sql; do
  echo "   載入 $f"
  test_db < "$f"
done

echo "== 冒煙測試"
test_db < tests/smoke.sql 2>&1 | sed 's/^NOTICE:  //'

echo "== 併行測試"
bash tests/race.sh

echo "== 清掉測試資料庫"
admin -c "DROP DATABASE lexicon_test"
