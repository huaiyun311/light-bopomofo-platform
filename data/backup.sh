#!/usr/bin/env bash
# 把目前的兩個資料庫匯出成備份，放進 backup/（進 git）。
# 切成 45 MB 一份：GitHub 單檔上限 100 MB，超過 50 MB 也會警告。
# 用法：bash data/import.sh 跑完之後，bash data/backup.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p backup
rm -f backup/*.part-*

echo "== 匯出 PostgreSQL"
docker compose exec -T postgres pg_dump --username lexicon --dbname lexicon --format custom --compress 9 |
  split -b 45m - backup/lexicon.pgdump.part-

echo "== 匯出 MongoDB"
docker compose exec -T mongo mongodump --quiet --db lexicon --archive --gzip |
  split -b 45m - backup/mongo.archive.gz.part-

ls -lh backup
