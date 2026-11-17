"""照時間順序重演平台的歷史，輸出一連串 SQL，交給 psql 執行。

每個事件都呼叫 db/03_functions.sql 的交易函式（approve_word、publish_release…），並傳入事件當時的時間。
所以重演出來的資料，每一步在當下都合法，trigger 全部會通過。

事件來源
  - data/real_events.tsv：輕注音的 10 個真實版本與詞庫調整（2b）
  - 之後加上生成的帳號、投稿、投票、審核、回報（2c）

用法：python3 data/replay.py | psql …
"""
import csv
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
MAINTAINER = 1  # 輕注音維護者，真實版本都由他建立與發布


def q(s):
    """SQL 字串常值"""
    return "'" + str(s).replace("'", "''") + "'"


def password_hash(password, salt):
    """與後端相同的格式：scrypt:鹽:雜湊（十六進位），N=16384、r=8、p=1"""
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
    return f"scrypt:{salt.hex()}:{digest.hex()}"


def normalize(bopomofo):
    """輕注音的調整檔用「ˉ」標一聲，新酷音詞庫不標；統一成不標"""
    return " ".join(bopomofo.replace("ˉ", "").split())


# ---------- 每種事件對應的 SQL ----------

def create_release(e):
    return f"INSERT INTO releases (version, created_by) VALUES ({q(e['version'])}, {MAINTAINER});"


def publish(e):
    return f"SELECT publish_release({MAINTAINER}, {q(e['at'])});"


def editor_add(e):
    return (f"SELECT add_entry({q(e['text'])}, {q(normalize(e['bopomofo']))}, {e['frequency']}, "
            f"{MAINTAINER}, {q(e['at'])});")


def retire_word(e):
    # 停用這個詞的所有讀音；row_version 直接從表裡取，等於「編輯看到的就是最新的」
    return (f"SELECT change_entry(e.entry_id, {MAINTAINER}, e.row_version, 'remove', NULL, {q(e['at'])})\n"
            f"  FROM lexicon_entries e JOIN words USING (word_id)\n"
            f" WHERE text = {q(e['text'])} AND status = 'active';")


def approve(e):
    readings = json.dumps([{"bopomofo": normalize(b), "frequency": int(e["frequency"])}
                           for b in e["bopomofo"].split("/")], ensure_ascii=False)
    # 詞和待審紀錄通常在投稿時就建好了；沒有的話補上
    return (f"INSERT INTO words (text) VALUES ({q(e['text'])}) ON CONFLICT DO NOTHING;\n"
            f"INSERT INTO word_reviews (word_id) SELECT word_id FROM words WHERE text = {q(e['text'])}\n"
            f"  ON CONFLICT DO NOTHING;\n"
            f"SELECT approve_word(r.word_id, {MAINTAINER}, r.row_version, {q(readings)}, {q(e['at'])})\n"
            f"  FROM word_reviews r JOIN words USING (word_id) WHERE text = {q(e['text'])};")


HANDLERS = {f.__name__: f for f in (create_release, publish, editor_add, retire_word, approve)}


# ---------- 讀事件、排序、輸出 ----------

def read_real_events():
    fields = ["at", "event", "version", "text", "bopomofo", "frequency"]
    with open(HERE / "real_events.tsv", encoding="utf-8") as f:
        rows = (line for line in f if not line.startswith("#"))
        return [dict(zip(fields, r)) for r in csv.reader(rows, delimiter="\t")]


def main():
    out = sys.stdout
    out.write("BEGIN;\n")
    out.write(
        "INSERT INTO users (user_id, email, password_hash, display_name, role, created_at) VALUES "
        f"({MAINTAINER}, 'maintainer@lightbopomofo.test', "
        f"{q(password_hash('demo1234', b'lightbopomofo-01'))}, '輕注音維護者', 'editor', "
        "'2026-10-15 00:00:00+08');\n")

    events = read_real_events()
    # 同一時間的事件：建立版本排最前面（要先有草稿才能加詞）
    events.sort(key=lambda e: (datetime.fromisoformat(e["at"]), e["event"] != "create_release"))
    for e in events:
        out.write(f"-- {e['at']} {e['event']} {e['version']} {e['text']}\n")
        out.write(HANDLERS[e["event"]](e) + "\n")

    out.write("COMMIT;\n")
    print(f"   重演 {len(events)} 個事件", file=sys.stderr)


if __name__ == "__main__":
    main()
