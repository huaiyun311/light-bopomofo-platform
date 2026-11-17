"""生成使用者行為資料（2c），交給 replay.py 跟真實版本合在同一條時間軸上重演。

生成的規則（報告「資料建置方式」引用這裡）
  候選新詞
    - 現代新詞：data/modern_words.tsv，手動整理，最熱門
    - 教育部辭典裡、新酷音詞庫沒有的 2–4 字詞：以「最罕用的那個字有多常用」排名，取前 20,000 個；
      字的常用程度 = 新酷音詞庫裡這個單字所有讀音的詞頻總和
    - 亂打的詞：常用字隨機組合，很少人打，最後多半被封鎖
  時間：平台與 v0.1.0 同一天上線（2026-10-15），歷史到 2026-11-18 為止；越接近現在，新帳號與新裝置越多
  每一筆資料都在當下合法：例如投票一定在詞被審核之前，加入的詞一定進當時的草稿版本

固定亂數種子，每次產生的資料都一樣。只用 Python 標準函式庫。
"""
import bisect
import csv
import json
import lzma
import math
import random
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import prepare_real

HERE = Path(__file__).parent
TZ = timezone(timedelta(hours=8))
START = datetime(2026, 10, 15, 14, 30, tzinfo=TZ)   # v0.1.0 發布後
END = datetime(2026, 11, 18, 0, 0, tzinfo=TZ)       # 資料截止
rng = random.Random(115)

N_USERS = 5000          # 含維護者（user_id 1，由 replay.py 建立）
N_EDITORS = 20          # user_id 1–20
N_APP_DEVICES = 7400
N_WEB_DEVICES = 600
N_MOE = 20000
N_JUNK = 300
N_REPORTS = 3000
DEMO_PENDING = {"國旅券", "普發"}  # demo 要用，保持待審
# 每個草稿版本裡生成的「加入」個數；8.0 另有 9 個真實的；9.0 留一個名額給 demo
APPROVALS = {"3.0": 80, "4.0": 10, "5.0": 20, "6.0": 30, "7.0": 3, "7.1": 15, "8.0": 191, "9.0": 199}
REJECTIONS_PER_DAY = 90
PASSWORD_HASH = None  # replay.py 設定（所有測試帳號密碼相同）


def ts(t):
    return t.isoformat()


def between(a, b):
    return a + (b - a) * rng.random()


def later_skewed(a, b):
    """越接近 b 越多（平台成長）"""
    return a + (b - a) * math.sqrt(rng.random())


# ==================== 讀資料 ====================

def syllables(reading):
    return reading.split(" ")


def strip_tone(syl):
    return syl.rstrip("ˊˇˋ˙")


def typed_variants(reading):
    """使用者實際會打的注音：首字注音、不打聲調的完整注音、第一字完整其餘首字"""
    syls = [strip_tone(s) for s in syllables(reading)]
    return {
        "initials": "".join(s[0] for s in syls),
        "full": "".join(syls),
        "mixed": syls[0] + "".join(s[0] for s in syls[1:]),
    }


def pick_typed(reading):
    v = typed_variants(reading)
    r = rng.random()
    return v["initials"] if r < 0.65 else v["full"] if r < 0.90 else v["mixed"]


def moe_reading(raw):
    """教育部辭典的注音：輕聲寫在前面（˙ㄗ），改成新酷音的寫法（ㄗ˙）"""
    out = []
    for syl in raw.replace("　", " ").split():
        if syl.startswith("˙"):
            syl = syl[1:] + "˙"
        out.append(syl)
    return " ".join(out)


class Lexicon:
    """新酷音詞庫：詞條代號與 prepare_real.py 匯入時相同"""

    def __init__(self):
        entries, _ = prepare_real.read_tsi()
        self.entries = [(i, text, reading, freq) for i, ((text, reading), freq) in enumerate(entries.items(), 1)]
        self.words = {text for _, text, _, _ in self.entries}
        self.char_weight, self.char_reading = {}, {}
        for _, text, reading, freq in self.entries:
            if len(text) == 1:
                self.char_weight[text] = self.char_weight.get(text, 0) + freq
                self.char_reading.setdefault(text, reading)


def load_modern():
    rows = []
    with open(HERE / "modern_words.tsv", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            text, reading, share, birth = line.rstrip("\n").split("\t")
            rows.append(dict(text=text, reading=reading, share=float(share), kind="modern",
                             birth=datetime.fromisoformat(birth).replace(tzinfo=TZ)))
    return rows


def load_moe(lex):
    with lzma.open(HERE / "raw" / "dict-revised.json.xz", "rt", encoding="utf-8") as f:
        data = json.load(f)
    han = re.compile(r"^[㐀-䶿一-鿿豈-﫿\U00020000-\U000323af]{2,4}$")
    seen, out = set(), []
    for e in data:
        text = e.get("title", "")
        if not han.match(text) or text in lex.words or text in seen:
            continue
        hs = [h for h in e.get("heteronyms", []) if h.get("bopomofo")]
        if not hs:
            continue
        reading = moe_reading(hs[0]["bopomofo"])
        if not prepare_real.BOPOMOFO.match(reading) or len(syllables(reading)) != len(text):
            continue
        score = min(lex.char_weight.get(c, 0) for c in text)
        if score == 0:
            continue
        seen.add(text)
        out.append(dict(text=text, reading=reading, score=score, kind="moe", birth=START))
    out.sort(key=lambda c: -c["score"])
    out = out[:N_MOE]
    for rank, c in enumerate(out):
        c["rank"] = rank
        c["weight"] = 1 / (rank + 30)
    return out


def make_junk(lex, taken):
    common = sorted(lex.char_weight, key=lambda c: -lex.char_weight[c])[:1500]
    out = []
    while len(out) < N_JUNK:
        text = "".join(rng.choice(common) for _ in range(rng.choice((2, 2, 3))))
        if text in taken:
            continue
        taken.add(text)
        reading = " ".join(lex.char_reading[c] for c in text)
        out.append(dict(text=text, reading=reading, kind="junk", birth=START))
    return out


def load_real_approvals():
    """8.0 那 9 個真實審核通過的詞：投稿要在審核之前"""
    out = []
    with open(HERE / "real_events.tsv", encoding="utf-8") as f:
        for r in csv.reader((l for l in f if not l.startswith("#")), delimiter="\t"):
            if r[1] == "approve":
                out.append(dict(text=r[3], reading=" ".join(r[4].replace("ˉ", "").split()),
                                share=rng.uniform(0.02, 0.05), kind="real", birth=START,
                                deadline=datetime.fromisoformat(r[0]) - timedelta(hours=2)))
    return out


def release_windows():
    """真實版本的草稿期間：(版本, 開始, 發布或資料截止)"""
    opens, closes = {}, {}
    with open(HERE / "real_events.tsv", encoding="utf-8") as f:
        for r in csv.reader((l for l in f if not l.startswith("#")), delimiter="\t"):
            t = datetime.fromisoformat(r[0])
            if r[1] == "create_release":
                opens[r[2]] = t
            elif r[1] == "publish":
                closes[r[2]] = t
    return [(v, t, closes.get(v, END)) for v, t in opens.items()]


# ==================== 帳號與裝置 ====================

class People:
    def __init__(self):
        self.users = []  # dict(id, created, status, role)
        for uid in range(2, N_USERS + 1):
            editor = uid <= N_EDITORS
            created = between(START - timedelta(hours=14), START + timedelta(days=1)) if editor \
                else later_skewed(START, END)
            r = rng.random()
            status = "active" if editor or r > 0.015 else "suspended" if r > 0.005 else "deleted"
            self.users.append(dict(id=uid, created=created, status=status,
                                   role="editor" if editor else "user"))
        self.active = sorted((u for u in self.users if u["status"] == "active"), key=lambda u: u["created"])
        self.active_times = [u["created"] for u in self.active]
        self.editors = [1] + [u["id"] for u in self.users if u["role"] == "editor"]

        self.devices = []
        for _ in range(N_APP_DEVICES):
            owner = None
            if rng.random() < 0.7:
                owner = rng.choice(self.users)
                first = min(owner["created"] + timedelta(hours=rng.uniform(0, 48)), END - timedelta(hours=1))
            else:
                first = later_skewed(START, END - timedelta(hours=1))
            last = END if rng.random() < 0.85 else between(first, END)
            self.devices.append(dict(
                id=str(uuid.UUID(int=rng.getrandbits(128))), user=owner and owner["id"],
                platform="macos" if rng.random() < 0.75 else "windows",
                first=first, last=last, every=rng.choice((2, 4, 6, 8, 12)),
                lag=timedelta(hours=rng.uniform(0, 48))))
        for owner in rng.sample(self.active, N_WEB_DEVICES):
            self.devices.append(dict(id=str(uuid.UUID(int=rng.getrandbits(128))), user=owner["id"],
                                     platform="web", first=owner["created"], last=owner["created"]))

    def voter_before(self, t):
        """隨機一位在時間 t 之前就註冊的使用者"""
        n = bisect.bisect_left(self.active_times, t)
        return self.active[rng.randrange(n)]["id"] if n else None

    def users_copy(self):
        lines = []
        for u in self.users:
            deleted = u["status"] == "deleted"
            email = "" if deleted else (
                "editor@lightbopomofo.test" if u["id"] == 2 else
                "user@lightbopomofo.test" if u["id"] == N_EDITORS + 1 else
                f"{u['role']}{u['id']}@lightbopomofo.test")
            name = "" if deleted else (
                "示範編輯" if u["id"] == 2 else "示範使用者" if u["id"] == N_EDITORS + 1 else
                f"{'編輯' if u['role'] == 'editor' else '使用者'}{u['id']}")
            lines.append(f"{u['id']},{email},{PASSWORD_HASH},{name},{u['role']},{u['status']},{ts(u['created'])}")
        return copy_block("users (user_id, email, password_hash, display_name, role, status, created_at)", lines)

    def devices_copy(self, version_at):
        lines = []
        for d in self.devices:
            app = "" if d["platform"] == "web" else version_at(d["first"])
            lines.append(f"{d['id']},{d['user'] or ''},{d['platform']},{app},{ts(d['first'])},{ts(d['first'])}")
        return copy_block("devices (device_id, user_id, platform, app_version, first_seen, last_synced_at)", lines)


def copy_block(target, lines):
    return f"COPY {target} FROM STDIN (FORMAT csv);\n" + "\n".join(lines) + "\n\\.\n"


# ==================== 主程式 ====================

def build(password_hash):
    """回傳 (開頭的 SQL, 事件清單 [(時間, SQL)], 結尾的 SQL, 統計)"""
    global PASSWORD_HASH
    PASSWORD_HASH = password_hash
    lex = Lexicon()
    modern, real = load_modern(), load_real_approvals()
    moe = load_moe(lex)
    taken = lex.words | {c["text"] for c in modern + real + moe}
    junk = make_junk(lex, taken)
    people = People()
    windows = release_windows()
    published = sorted((close, v) for v, _, close in windows if close < END)

    def version_at(t, lag=timedelta(0)):
        i = bisect.bisect_right([p for p, _ in published], t - lag)
        return published[max(i - 1, 0)][1]

    events = []
    stats = {}

    # ---------- 1. 投稿：每台裝置打了哪些詞、什麼時候 ----------
    moe_cum = list(_cumulative(c["weight"] for c in moe))
    typed_by = {}    # (裝置, 詞) → (打的注音, 第一次打的時間, 次數)
    app_devices = [d for d in people.devices if d["platform"] != "web"]
    for d in app_devices:
        span = (d["last"] - d["first"]).total_seconds() / 86400
        for c in modern + real:
            if rng.random() < c["share"] * min(1, span / 10 + 0.2):
                lo = max(d["first"], c["birth"])
                hi = min(d["last"], c.get("deadline", END))
                if lo < hi:
                    typed_by[(d["id"], c["text"])] = (c, between(lo, hi))
        k = int(rng.lognormvariate(4.95, 0.7) * min(1, span / 12 + 0.15))
        for c in {moe[i]["text"]: moe[i] for i in _sample_indices(moe_cum, k)}.values():
            typed_by[(d["id"], c["text"])] = (c, between(d["first"], d["last"]))
    for c in junk:
        for d in rng.sample(app_devices, rng.randint(1, 4)):
            if d["first"] < d["last"]:
                typed_by[(d["id"], c["text"])] = (c, between(d["first"], d["last"]))

    # 依裝置的同步週期分批上傳；第一次上傳次數少，最後一次同步再補上累計次數
    device = {d["id"]: d for d in app_devices}
    batches, first_seen = {}, {}
    finals = {}
    for (dev_id, text), (c, t) in typed_by.items():
        d = device[dev_id]
        sync = _next_sync(d, t)
        if sync > d["last"]:
            continue
        typed = pick_typed(c["reading"])
        rows = [(text, typed)]
        if rng.random() < 0.15:  # 同一台裝置用兩種打法
            rows.append((text, typed_variants(c["reading"])["full"]))
        for text_, typed_ in rows:
            batches.setdefault((dev_id, sync), []).append(
                {"text": text_, "typed": typed_, "count": rng.randint(1, 3)})
            total = max(3, int(rng.lognormvariate(2.0, 1.0) * (3 if c["kind"] in ("modern", "real") else 1)))
            finals.setdefault(dev_id, []).append((t, {"text": text_, "typed": typed_, "count": total}))
        if c.get("deadline") and sync >= c["deadline"]:
            continue
        first_seen[text] = min(first_seen.get(text, sync), sync)
    for dev_id, items in finals.items():
        d = device[dev_id]
        last_sync = _last_sync(d)
        recent = [w for t, w in sorted(items, key=lambda x: x[0], reverse=True)[:30] if t < last_sync]
        if recent:
            batches.setdefault((dev_id, last_sync), []).extend(recent)
    n_rows = 0
    for (dev_id, sync), words in batches.items():
        d = device[dev_id]
        for i in range(0, len(words), 500):
            chunk = words[i:i + 500]
            n_rows += len(chunk)
            events.append((sync, (
                f"SELECT upload_words('{dev_id}', '{d['platform']}', '{version_at(sync, d['lag'])}', "
                f"'{json.dumps(chunk, ensure_ascii=False, separators=(',', ':'))}', '{ts(sync)}');")))
    stats["上傳批次"] = len(batches)
    stats["上傳的詞（含重送）"] = n_rows

    # ---------- 2. 審核：加入、不收、封鎖 ----------
    by_text = {c["text"]: c for c in modern + real + moe + junk}
    decided = {}  # 詞 → 決定時間
    for c in real:
        decided[c["text"]] = c["deadline"] + timedelta(hours=2)

    good = sorted((c for c in modern + moe if c["text"] in first_seen and c["text"] not in DEMO_PENDING
                   and (c["kind"] == "modern" or c["rank"] < 4000)),
                  key=lambda c: (c["kind"] != "modern", -(c.get("share") or 0), c.get("rank", 0)))
    for version, opened, closed in windows:
        times = sorted(between(opened + timedelta(minutes=5), closed - timedelta(minutes=5))
                       for _ in range(APPROVALS.get(version, 0)))
        for t in times:
            c = next((c for c in good if c["text"] not in decided and first_seen[c["text"]] < t - timedelta(hours=1)), None)
            if c is None:
                continue
            decided[c["text"]] = t
            readings = json.dumps([{"bopomofo": c["reading"], "frequency": _frequency(c)}], ensure_ascii=False)
            events.append((t, _approve_sql(c["text"], rng.choice(people.editors), readings, t)))
    stats["加入（生成）"] = sum(1 for c in good if c["text"] in decided)

    low = [c for c in moe if c["rank"] >= 6000 and c["text"] in first_seen]
    rng.shuffle(low)
    day = START.replace(hour=10, minute=0) + timedelta(days=1)
    n_rejected = 0
    while day < END:
        for _ in range(REJECTIONS_PER_DAY):
            t = day + timedelta(hours=rng.uniform(0, 12))
            c = next((c for c in low if c["text"] not in decided and first_seen[c["text"]] < t - timedelta(hours=1)), None)
            if c is None or t >= END:
                break
            decided[c["text"]] = t
            n_rejected += 1
            events.append((t, _decide_sql(c["text"], rng.choice(people.editors), "rejected", t)))
        day += timedelta(days=1)
    stats["不收"] = n_rejected

    n_blocked = 0
    for c in junk:
        if c["text"] in first_seen and rng.random() < 0.85:
            t = first_seen[c["text"]] + timedelta(hours=rng.uniform(6, 96))
            if t < END:
                decided[c["text"]] = t
                n_blocked += 1
                events.append((t, _decide_sql(c["text"], rng.choice(people.editors), "blocked", t)))
    stats["封鎖"] = n_blocked

    # ---------- 3. 投票：只在詞待審期間 ----------
    n_votes = 0
    devices_per_word = {}
    for (_, text) in typed_by:
        devices_per_word[text] = devices_per_word.get(text, 0) + 1
    for text, f in first_seen.items():
        c = by_text[text]
        until = decided.get(text, END) - timedelta(minutes=1)
        start = f + timedelta(minutes=1)
        if start >= until:
            continue
        rate = {"modern": 0.45, "real": 0.4, "moe": 0.2, "junk": 0.6}[c["kind"]]
        p_up = {"modern": 0.92, "real": 0.9, "junk": 0.15}.get(c["kind"]) or 0.85 - 0.5 * c["rank"] / N_MOE
        voters = set()
        for _ in range(int(devices_per_word[text] * rate + rng.random())):
            t = between(start, until)
            uid = people.voter_before(t)
            if uid is None or uid in voters:
                continue
            voters.add(uid)
            n_votes += 1
            value = 1 if rng.random() < p_up else -1
            events.append((t, (f"INSERT INTO votes VALUES ({uid}, (SELECT word_id FROM words WHERE text = "
                               f"'{text}'), {value}, '{ts(t)}');")))
    stats["投票"] = n_votes

    # ---------- 4. 回報與處理 ----------
    retired_real = {"史密斯"} | {r for r in _real_retired()}
    pool = [e for e in lex.entries if e[1] not in retired_real]
    cum = list(_cumulative(math.sqrt(e[3] + 1) for e in pool))
    chosen = {}
    while len(chosen) < N_REPORTS:
        e = pool[_sample_indices(cum, 1)[0]]
        chosen.setdefault(e[0], e)
    reports = []
    for entry_id, text, reading, freq in chosen.values():
        t = later_skewed(START + timedelta(days=1), END - timedelta(hours=1))
        uid = people.voter_before(t)
        if uid is None:
            continue
        kind = rng.choices(("wrong_reading", "not_word", "offensive"), (40, 45, 15))[0]
        reports.append((t, uid, entry_id, kind, freq))
    reports.sort()
    removed = set()
    n_handled = 0
    for report_id, (t, uid, entry_id, kind, freq) in enumerate(reports, 1):
        events.append((t, (f"INSERT INTO reports (report_id, user_id, entry_id, kind, created_at) "
                           f"VALUES ({report_id}, {uid}, {entry_id}, '{kind}', '{ts(t)}');")))
        if rng.random() > 0.6:
            continue
        h = t + timedelta(hours=rng.expovariate(1 / 48))
        if h >= END:
            continue
        n_handled += 1
        editor = rng.choice(people.editors)
        choice = rng.choices(("dismiss", "reweight", "remove"),
                             {"wrong_reading": (85, 15, 0), "not_word": (70, 20, 10), "offensive": (60, 0, 40)}[kind])[0]
        if choice == "dismiss":
            sql = f"SELECT resolve_report({report_id}, {editor}, 'dismiss', NULL, NULL, NULL, '{ts(h)}');"
        else:
            new_freq = "NULL"
            if choice == "reweight":
                new_freq = str(max(0, round(freq * rng.choice((0.3, 0.5, 1.5, 2.0)))))
                if new_freq == str(freq):
                    new_freq = str(freq + 10)
            else:
                removed.add(entry_id)
            sql = (f"SELECT resolve_report({report_id}, {editor}, '{choice}', "
                   f"(SELECT row_version FROM lexicon_entries WHERE entry_id = {entry_id}), {new_freq}, NULL, '{ts(h)}');")
        events.append((h, sql))
    stats["回報"] = len(reports)
    stats["已處理回報"] = n_handled

    # ---------- 開頭與結尾的整批資料 ----------
    head = people.users_copy() + people.devices_copy(version_at)
    tail, tail_stats = _tail(lex, people, modern, removed | {e[0] for e in lex.entries if e[1] in retired_real})
    stats.update(tail_stats)
    return head, events, tail, stats


def _tail(lex, people, modern, inactive):
    """個人詞、詞庫包、訂閱：放在最後，這時候所有詞條狀態都已確定"""
    out, stats = [], {}

    # 個人詞
    cum = list(_cumulative(e[3] + 1 for e in lex.entries))
    rows = {}
    for u in people.users:
        if u["status"] == "deleted":
            continue
        n = int(rng.lognormvariate(3.3, 0.9))
        for i in _sample_indices(cum, n):
            _, text, reading, _ = lex.entries[i]
            rows[(u["id"], text, reading)] = u
        for c in rng.sample(modern, rng.randint(0, 3)):
            rows[(u["id"], c["text"], c["reading"])] = u
    lines = []
    for (uid, text, reading), u in rows.items():
        status = "deleted" if rng.random() < 0.05 else "active"
        lines.append(f"{uid},{text},{reading},{status},{ts(between(u['created'], END))}")
    out.append("CREATE TEMP TABLE pw (user_id bigint, text text, bopomofo text, status text, updated_at timestamptz);\n")
    out.append(copy_block("pw", lines))
    out.append("INSERT INTO words (text) SELECT DISTINCT text FROM pw ON CONFLICT DO NOTHING;\n"
               "INSERT INTO personal_words SELECT pw.user_id, w.word_id, pw.bopomofo, pw.status, pw.updated_at\n"
               "  FROM pw JOIN words w USING (text);\nDROP TABLE pw;\n")
    stats["個人詞"] = len(lines)

    # 詞庫包：依字尾或關鍵字從上線中的詞條挑選
    themes = [
        ("台灣地名", "縣市鄉鎮區的名稱", r"^.{1,3}[市縣鄉鎮區]$"),
        ("道路街道", "路、街、大道", r"^.{1,4}(路|街|大道)$"),
        ("交通運輸", "車站、捷運、機場", r"(站|捷運|機場|鐵路|公車|客運)"),
        ("醫療健康", "疾病、症狀與藥物", r"(炎|症|病|藥|醫)$"),
        ("美食小吃", "飯麵湯餅與飲料", r"^.{1,3}(飯|麵|湯|餅|茶|糕|粥)$"),
        ("動物", "貓狗魚鳥蟲", r"^.{1,3}(貓|狗|魚|鳥|蟲|獸)$"),
        ("植物", "花草樹木", r"^.{1,3}(花|樹|草|木)$"),
        ("運動", "球類與比賽", r"(球|賽|跑|泳)"),
        ("音樂", "樂曲、歌曲與樂器", r"(曲|歌|樂團|琴|鼓)$"),
        ("法律", "法條與權利", r"(法|權|罪|訴)$"),
        ("資訊科技", "電腦、網路與程式", r"(電腦|網路|程式|資料|軟體|系統|晶片)"),
        ("天文地理", "星辰山河湖海", r"^.{1,3}(星|山|河|湖|海|洋)$"),
    ]
    pack_rows, entry_lines, sub_lines = [], [], []
    for pid, (name, desc, pattern) in enumerate(themes, 1):
        created = datetime(2026, 11, 10, 10, tzinfo=TZ) + timedelta(hours=rng.uniform(0, 96))
        pack_rows.append(f"({pid}, '{name}', '{desc}', {rng.choice(people.editors)}, '{ts(created)}')")
        rx = re.compile(pattern)
        hits = sorted((e for e in lex.entries if rx.search(e[1]) and e[0] not in inactive and len(e[1]) > 1),
                      key=lambda e: -e[3])[:500]
        entry_lines += [f"{pid},{e[0]}" for e in hits]
        if pid == 12:  # 一個還在草稿
            continue
        for u in rng.sample(people.active, 1100):
            t = max(created, u["created"]) + timedelta(hours=rng.uniform(1, 72))
            if t < END:
                sub_lines.append(f"{u['id']},{pid},{'cancelled' if rng.random() < 0.08 else 'active'},{ts(t)}")
    out.append("INSERT INTO packs (pack_id, name, description, owner_id, created_at) VALUES\n  "
               + ",\n  ".join(pack_rows) + ";\n")
    out.append(copy_block("pack_entries (pack_id, entry_id)", entry_lines))
    out.append("UPDATE packs SET status = 'published' WHERE pack_id <> 12;\n")
    out.append(copy_block("subscriptions (user_id, pack_id, status, subscribed_at)", sub_lines))
    out.append("UPDATE packs SET status = 'archived' WHERE pack_id = 11;\n")
    stats["詞庫包詞條"] = len(entry_lines)
    stats["訂閱"] = len(sub_lines)
    return "".join(out), stats


# ==================== 小工具 ====================

def _cumulative(weights):
    total = 0
    for w in weights:
        total += w
        yield total


def _sample_indices(cum, k):
    return [bisect.bisect_left(cum, rng.random() * cum[-1]) for _ in range(k)]


def _next_sync(d, t):
    """裝置每 every 小時同步一次"""
    step = d["every"] * 3600
    since = (t - d["first"]).total_seconds()
    return d["first"] + timedelta(seconds=math.ceil(since / step) * step + rng.uniform(0, 300))


def _last_sync(d):
    step = d["every"] * 3600
    since = (d["last"] - d["first"]).total_seconds()
    return d["first"] + timedelta(seconds=math.floor(since / step) * step)


def _frequency(c):
    if c["kind"] == "modern":
        return int(1000 + 6000 * c["share"])
    return int(300 + 1500 * (1 - c["rank"] / N_MOE))


def _approve_sql(text, editor, readings, t):
    return (f"SELECT approve_word(r.word_id, {editor}, r.row_version, '{readings}', '{ts(t)}')\n"
            f"  FROM word_reviews r JOIN words USING (word_id) WHERE text = '{text}';")


def _decide_sql(text, editor, status, t):
    return (f"SELECT decide_word(r.word_id, {editor}, r.row_version, '{status}', '{ts(t)}')\n"
            f"  FROM word_reviews r JOIN words USING (word_id) WHERE text = '{text}';")


def _real_retired():
    with open(HERE / "real_events.tsv", encoding="utf-8") as f:
        for r in csv.reader((l for l in f if not l.startswith("#")), delimiter="\t"):
            if r[1] == "retire_word":
                yield r[3]
