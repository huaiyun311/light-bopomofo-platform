"""生成 MongoDB 的三個 collection（2d），輸出成 NDJSON 給 mongoimport。

輸入：import.sh 從 PostgreSQL 匯出的 data/build/pg_*.csv，以及 replay.py 留下的 review_history.tsv。
先匯完 PostgreSQL 再產生，文件裡的 entry_id、word_id、user_id 才會跟關聯式資料庫對得上。

  selection_events  約 200 萬筆  輸入法的選字紀錄：打了什麼注音、選了哪個詞條、在第幾名
  query_logs        約 5 萬筆    網頁的詞庫查詢紀錄
  review_history    約 3,800 筆  每一次審核決定（PostgreSQL 的 word_reviews 只留最後一次）

選字的規則
  - 只能選到當時已經發布、而且這台裝置的輸入法版本已經有的詞條；停用的詞條發布停用後就選不到
  - 詞頻越高越常被選；名次＝同樣打法的候選裡，詞頻比它高的有幾個（再加一點雜訊）
    所以同音詞多、詞頻又不高的詞，常要翻到後面才選得到
  - 約 3% 是詞庫沒有的詞（使用者逐字組出來），entry_id 為 null
"""
import bisect
import csv
import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
BUILD = HERE / "build"
TZ = timezone(timedelta(hours=8))
END = datetime(2026, 11, 18, 0, 0, tzinfo=TZ)
N_SELECTIONS = 2_000_000
N_QUERIES = 50_000
rng = random.Random(2026)


def read_csv(name):
    with open(BUILD / name, encoding="utf-8") as f:
        return list(csv.reader(f))


def parse(t):
    return datetime.fromisoformat(t.replace(" ", "T")) if t else None


def mongo_date(t):
    return {"$date": t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"}


def initials(reading):
    return "".join(s[0] for s in reading.split(" "))


def typed_for(reading):
    syls = [s.rstrip("ˊˇˋ˙") for s in reading.split(" ")]
    r = rng.random()
    if r < 0.65:
        return "".join(s[0] for s in syls)
    if r < 0.90:
        return "".join(syls)
    return syls[0] + "".join(s[0] for s in syls[1:])


def cumulative(weights):
    out, total = [], 0
    for w in weights:
        total += w
        out.append(total)
    return out


def pick(cum):
    return bisect.bisect_left(cum, rng.random() * cum[-1])


def main():
    # entry_id, text, bopomofo, frequency, available_from, available_until
    entries = [(int(r[0]), r[1], r[2], int(r[3]), parse(r[4]), parse(r[5]))
               for r in read_csv("pg_entries.csv") if r[4]]
    releases = sorted((parse(r[1]), r[0]) for r in read_csv("pg_releases.csv"))
    devices = [(r[0], parse(r[1]), parse(r[2])) for r in read_csv("pg_devices.csv")]
    users = [(int(r[0]), parse(r[1])) for r in read_csv("pg_users.csv")]
    pending = [r[0] for r in read_csv("pg_pending_readings.csv")]
    word_ids = {r[1]: int(r[0]) for r in read_csv("pg_decided_words.csv")}

    def version_at(t):
        i = bisect.bisect_right([p for p, _ in releases], t)
        return releases[max(i - 1, 0)][1]

    # 同一種打法（首字注音、不打聲調的完整注音…）會跳出哪些候選：存每組的詞頻（負值，方便二分搜尋）
    competitors = {}
    for _, _, reading, freq, _, stop in entries:
        if stop:
            continue
        syls = [x.rstrip("ˊˇˋ˙") for x in reading.split(" ")]
        for key in {"".join(x[0] for x in syls), "".join(syls), syls[0] + "".join(x[0] for x in syls[1:])}:
            competitors.setdefault(key, []).append(-freq)
    for group in competitors.values():
        group.sort()

    # ---------- selection_events ----------
    cum = cumulative((e[3] + 1) ** 0.8 for e in entries)
    dev_cum = cumulative(max(1.0, (last - first).total_seconds() / 3600) for _, first, last in devices)
    n = 0
    with open(BUILD / "selection_events.ndjson", "w", encoding="utf-8") as f:
        while n < N_SELECTIONS:
            device_id, first, last = devices[pick(dev_cum)]
            if last <= first:
                continue
            t = first + (last - first) * rng.random()
            seen = t - timedelta(hours=rng.uniform(0, 24))   # 輸入法晚一點才更新到新版本
            app = version_at(seen)
            if rng.random() < 0.03:
                doc = {"device_id": device_id, "app_version": app, "typed": rng.choice(pending),
                       "entry_id": None, "rank": None, "shown": rng.randint(5, 9), "ts": mongo_date(t)}
            else:
                entry_id, text, reading, freq, start, stop = entries[pick(cum)]
                if start > seen or (stop and stop <= t):
                    continue  # 這台裝置當時還沒有、或已經停用的詞條
                typed = typed_for(reading)
                # 名次：候選窗依詞頻排序，同樣打法、詞頻比它高的詞條有幾個，它就排第幾名後面
                group = competitors.get(typed)
                rank = 1 + (bisect.bisect_left(group, -freq) if group else 0)
                rank = max(1, min(rank + rng.choice((-1, 0, 0, 0, 1)), 60))
                doc = {"device_id": device_id, "app_version": app, "typed": typed,
                       "entry_id": entry_id, "rank": rank, "shown": max(rank, rng.randint(5, 9)),
                       "ts": mongo_date(t)}
            f.write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1

    # ---------- query_logs ----------
    live = [e for e in entries if not e[5]]
    by_initials, by_bopomofo, by_pair = {}, [], {}
    for e in live:
        by_initials.setdefault(initials(e[2]), []).append(e)
        for i in range(len(e[1]) - 1):
            by_pair.setdefault(e[1][i:i + 2], []).append(e)
    by_bopomofo = sorted(live, key=lambda e: e[2])
    keys = [e[2] for e in by_bopomofo]
    init_keys = sorted(by_initials)
    live_cum = cumulative((e[3] + 1) ** 0.5 for e in live)
    users.sort(key=lambda u: u[1])
    user_times = [u[1] for u in users]
    start = releases[0][0]
    with open(BUILD / "query_logs.ndjson", "w", encoding="utf-8") as f:
        n = 0
        while n < N_QUERIES:
            t = start + (END - start) * math.sqrt(rng.random())
            k = bisect.bisect_left(user_times, t)
            user = users[rng.randrange(k)][0] if k and rng.random() < 0.6 else None
            _, text, reading, _, _, _ = live[pick(live_cum)]
            mode = rng.choices(("initials", "bopomofo", "text"), (50, 25, 25))[0]
            if mode == "initials":
                query = initials(reading)[:rng.randint(2, 4)]
                lo = bisect.bisect_left(init_keys, query)
                hits = []
                for key in init_keys[lo:]:
                    if not key.startswith(query):
                        break
                    hits += by_initials[key]
            elif mode == "bopomofo":
                query = " ".join(reading.split(" ")[:rng.randint(1, 2)])
                lo, hi = bisect.bisect_left(keys, query), bisect.bisect_left(keys, query + "￿")
                hits = by_bopomofo[lo:hi]
            else:
                if len(text) < 2:
                    continue
                i = rng.randrange(len(text) - 1)
                query = text[i:i + 2]
                hits = by_pair.get(query, [])
            top = sorted(hits, key=lambda e: -e[3])[:10]
            f.write(json.dumps({"user_id": user, "mode": mode, "query": query, "result_count": len(hits),
                                "top_entry_ids": [e[0] for e in top], "ts": mongo_date(t)},
                               ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1

    # ---------- review_history ----------
    n_history = 0
    with open(BUILD / "review_history.tsv", encoding="utf-8") as src, \
            open(BUILD / "review_history.ndjson", "w", encoding="utf-8") as f:
        for line in src:
            t, text, status, editor = line.rstrip("\n").split("\t")
            f.write(json.dumps({"word_id": word_ids[text], "text": text, "from": "pending", "to": status,
                                "editor_id": int(editor), "ts": mongo_date(parse(t))},
                               ensure_ascii=False, separators=(",", ":")) + "\n")
            n_history += 1

    print(f"   selection_events {N_SELECTIONS:,}、query_logs {N_QUERIES:,}、review_history {n_history:,}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
