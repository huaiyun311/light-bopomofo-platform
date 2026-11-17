#!/usr/bin/env bash
# 跑效能量測，結果存進 bench/results/（報告直接引用）
#   indexes.sql      每個索引有無的差別
#   candidates.sql   待審列表三種寫法
#   concurrency.mjs  100 個請求同時搶名額、投票、上傳（透過網頁 API，跑完會還原）
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d --wait >/dev/null
mkdir -p bench/results
psql() { docker compose exec -T postgres psql -U lexicon -d lexicon -X -v ON_ERROR_STOP=1 "$@"; }

echo "== 索引"
# _helpers.sql 用 \ir 引入，所以把 bench/ 放進容器的暫存資料夾再執行
docker compose cp bench/. postgres:/tmp/bench >/dev/null
psql -f /tmp/bench/indexes.sql | tee bench/results/indexes.txt

echo "== 待審列表三種寫法（A 要跑 10 秒左右）"
psql -f /tmp/bench/candidates.sql | tee bench/results/candidates.txt

echo "== 併行"
docker compose exec -T web node --input-type=module < bench/concurrency.mjs | tee bench/results/concurrency.txt
