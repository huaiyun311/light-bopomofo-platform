#!/bin/bash
# MongoDB 第一次啟動（資料是空的）時自動執行：backup/ 裡有備份就還原。
set -e
if ls /backup/mongo.archive.gz.part-* >/dev/null 2>&1; then
  echo "== 還原 MongoDB 備份"
  cat /backup/mongo.archive.gz.part-* | mongorestore --quiet --archive --gzip
fi
