"""把真實資料清理成可以直接 COPY 進資料庫的 CSV（data/build/）。

輸入：data/raw/tsi.csv、data/raw/word-pairs.tsv（由 fetch.sh 下載）
輸出：words.csv、lexicon_entries.csv、word_pairs.csv

清理規則與資料庫的 CHECK 一致，清理掉的筆數會印出來，寫報告用。
只用 Python 標準函式庫。
"""
import csv
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
RAW, BUILD = HERE / "raw", HERE / "build"

# 與 01_schema.sql 的 han_text、bopomofo_text 相同
HAN = re.compile(r"^[㐀-䶿一-鿿豈-﫿\U00020000-\U000323af]{1,20}$")
BOPOMOFO = re.compile(r"^[ㄅ-ㄩˊˇˋ˙]+( [ㄅ-ㄩˊˇˋ˙]+)*$")

# 平台和 v0.1.0 同一天上線；原始詞庫視為這一刻匯入
BASELINE = "2026-10-15 00:00:00+08"
SOURCE_TSI = 1


def read_tsi():
    """新酷音詞庫：每行「詞,詞頻,讀音」。回傳 {(詞, 讀音): 詞頻}，保留檔案順序。"""
    entries, stats = {}, {"行數": 0, "不是詞（注音符號本身等）": 0,
                          "讀音前後有多餘空格": 0, "讀音格式不對": 0, "同詞同讀音重複": 0}
    with open(RAW / "tsi.csv", encoding="utf-8") as f:
        for row in csv.reader(f):
            if not row or row[0].startswith("#"):
                continue
            stats["行數"] += 1
            text, freq, reading = row[0], int(row[1]), row[2]
            if not HAN.match(text):
                stats["不是詞（注音符號本身等）"] += 1
                continue
            cleaned = " ".join(reading.split())
            if cleaned != reading:
                stats["讀音前後有多餘空格"] += 1
            if not BOPOMOFO.match(cleaned):
                stats["讀音格式不對"] += 1
                continue
            key = (text, cleaned)
            if key in entries:
                stats["同詞同讀音重複"] += 1
                freq = max(freq, entries[key])  # 留詞頻較高的那筆
            entries[key] = freq
    return entries, stats


def read_pairs():
    """FineWeb-2 詞組：每行「詞 TAB 語料次數 TAB 後詞 加分 TAB 後詞 加分 …」。"""
    counts, pairs = {}, []
    stats = {"詞組": 0, "含不合格的詞": 0, "加分超出範圍": 0}
    with open(RAW / "word-pairs.tsv", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            cols = line.rstrip("\n").split("\t")
            word, count = cols[0], int(cols[1])
            ok = bool(HAN.match(word))
            if ok:
                counts[word] = count
            for item in cols[2:]:
                nxt, score = item.rsplit(" ", 1)
                stats["詞組"] += 1
                if not ok or not HAN.match(nxt):
                    stats["含不合格的詞"] += 1
                    continue
                pmi = round(float(score), 1)
                if not -99.9 <= pmi <= 99.9:  # numeric(3,1)
                    stats["加分超出範圍"] += 1
                    continue
                pairs.append((word, nxt, pmi))
    return counts, pairs, stats


def main():
    BUILD.mkdir(exist_ok=True)
    entries, tsi_stats = read_tsi()
    counts, pairs, pair_stats = read_pairs()

    # 詞的代號：先依詞庫順序，再補上只出現在詞組裡的詞
    word_id = {}
    for text, _ in entries:
        word_id.setdefault(text, len(word_id) + 1)
    for a, b, _ in pairs:
        word_id.setdefault(a, len(word_id) + 1)
        word_id.setdefault(b, len(word_id) + 1)
    for text in counts:
        word_id.setdefault(text, len(word_id) + 1)

    with open(BUILD / "words.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for text, i in word_id.items():
            w.writerow([i, text, counts.get(text, 0)])

    with open(BUILD / "lexicon_entries.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for i, ((text, reading), freq) in enumerate(entries.items(), 1):
            w.writerow([i, word_id[text], reading, freq, SOURCE_TSI, "active", BASELINE])

    with open(BUILD / "word_pairs.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for a, b, pmi in pairs:
            w.writerow([word_id[a], word_id[b], f"{pmi:.1f}"])

    report = [
        ("新酷音詞庫", tsi_stats),
        ("FineWeb-2 詞組", pair_stats),
        ("輸出", {"words": len(word_id), "其中有收錄的詞": len({t for t, _ in entries}),
                  "lexicon_entries": len(entries), "word_pairs": len(pairs)}),
    ]
    for title, stats in report:
        print(f"   {title}：" + "、".join(f"{k} {v:,}" for k, v in stats.items()))


if __name__ == "__main__":
    sys.exit(main())
