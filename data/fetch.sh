#!/usr/bin/env bash
# 下載真實資料到 data/raw/（不進 git）。都釘在固定版本，每次下載的內容都一樣。
set -eu
cd "$(dirname "$0")"
mkdir -p raw

# 新酷音詞庫（LGPL-2.1-or-later）：輕注音用的同一個版本
TSI_COMMIT=ea74f76dd2548b1d65d0ff70c3ae66057a6ad97d
# 輕注音 v8.0：FineWeb-2 統計出的 200 萬組詞組（ODC-By 1.0）
LB_COMMIT=4840989097de9a2ba2f39b3638e178a6b77ae299

get() {  # get 網址 檔名
  if [ -s "raw/$2" ]; then echo "   已有 raw/$2"; return; fi
  echo "   下載 raw/$2"
  curl -fsSL -o "raw/$2.part" "$1" && mv "raw/$2.part" "raw/$2"
}
get "https://raw.githubusercontent.com/chewing/libchewing-data/$TSI_COMMIT/dict/chewing/tsi.csv" tsi.csv
get "https://raw.githubusercontent.com/nvlznn/light-bopomofo/$LB_COMMIT/crates/lightbopomofo-core/word-pairs.tsv" word-pairs.tsv
# 教育部《重編國語辭典修訂本》（CC BY-ND 3.0 TW），g0v 整理的 JSON：只取詞和注音，當候選新詞
MOE_COMMIT=a6dc997417507eb510fc29822bc514de2c92728c
get "https://raw.githubusercontent.com/g0v/moedict-data/$MOE_COMMIT/dict-revised.json.xz" dict-revised.json.xz
