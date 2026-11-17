#!/bin/bash
# PostgreSQL 第一次啟動（資料是空的）時自動執行。
#  - backup/ 裡有備份：直接還原，馬上有完整資料（助教用這個）
#  - 沒有備份：只建立空的資料表，之後用 data/import.sh 匯入
set -e
if ls /backup/lexicon.pgdump.part-* >/dev/null 2>&1; then
  echo "== 還原 PostgreSQL 備份（約 1–2 分鐘）"
  cat /backup/lexicon.pgdump.part-* |
    pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-owner --exit-on-error
else
  echo "== 沒有備份，建立空的資料表"
  for f in /db/*.sql; do
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -q -f "$f"
  done
fi
