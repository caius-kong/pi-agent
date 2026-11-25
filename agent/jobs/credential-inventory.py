#!/usr/bin/env python3
"""晨报「凭据到期」板块的数据工具：只输出数据行，不做 HTML 排版。

数据源是 jobs/credentials.json：每个 entry 声明一组位置（locations），
每个位置 = {host?, file, key, regex?}；不写 host 表示本机，写了 regex 才去读文件。
到期日从 key 自身解出（JWT 的 exp），所以轮换后无需改这个脚本或那个 JSON。

输出每行一条 entry（字段用 | 分隔，| 不出现在字段内）：
  KEY|<label>|<EXP 文案>|<ok|bad>|<loc1> ; <loc2> ; ...

新增一个 key = 在 credentials.json 里加一条 entry。
"""
import base64
import datetime
import json
import os
import re
import socket
import sys

WARN_DAYS = 21
CRIT_DAYS = 7
JOBS_DIR = os.path.dirname(os.path.abspath(__file__))
INVENTORY = os.path.join(JOBS_DIR, "credentials.json")
LOCAL_HOST = socket.gethostname().split(".")[0]


def expand(path):
    return os.path.expanduser(path)


def decode_exp(token):
    parts = token.split(".")
    if len(parts) < 3:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return None
    exp = data.get("exp")
    return datetime.datetime.fromtimestamp(exp) if isinstance(exp, int) else None


def scan_locations(entry):
    """返回 (tokens, [(host, file, key, 状态), ...])。没有 regex 的位置只展示、不读取。"""
    tokens = []
    places = []
    for loc in entry.get("locations", []):
        host = loc.get("host") or LOCAL_HOST
        rel = loc["file"]
        key = loc.get("key", "")
        regex = loc.get("regex")
        if not regex:
            places.append((host, rel, key, "未探测"))
            continue
        path = expand(rel)
        if not os.path.exists(path):
            places.append((host, rel, key, "文件不存在"))
            continue
        try:
            text = open(path, encoding="utf-8", errors="ignore").read()
        except Exception as exc:
            places.append((host, rel, key, f"读取失败: {type(exc).__name__}"))
            continue
        m = re.search(regex, text, re.MULTILINE)
        if not m:
            places.append((host, rel, key, "未匹配到 key"))
            continue
        tokens.append(m.group(1).strip().strip("'\""))
        places.append((host, rel, key, "ok"))
    return tokens, places


def main():
    today = datetime.date.today()
    try:
        data = json.load(open(INVENTORY, encoding="utf-8"))
    except Exception as exc:
        print(f"ERR|读不到 {INVENTORY}: {type(exc).__name__}")
        return

    for entry in data.get("entries", []):
        label = entry.get("label") or entry.get("id", "?")
        tokens, places = scan_locations(entry)

        exps = sorted({e.date() for e in (decode_exp(t) for t in tokens) if e})
        if exps:
            exp = exps[0]
            days = (exp - today).days
            if days < 0:
                exp_text, state = f"{exp} · 已过期 {-days} 天", "bad"
            elif days <= WARN_DAYS:
                exp_text, state = f"{exp} · 剩 {days} 天", "bad"
            else:
                exp_text, state = f"{exp} · 剩 {days} 天", "ok"
        elif tokens:
            exp_text, state = "无 exp（非 JWT）", "bad"
        else:
            exp_text, state = "未取到 key", "bad"

        locs = []
        for host, rel, key, st in places:
            line = f"{host} - {rel} - {key}" if key else f"{host} - {rel}"
            if st not in ("ok", "未探测"):
                line += f" [{st}]"
            locs.append(line)

        print(f"KEY|{label}|{exp_text}|{state}|{' ; '.join(locs)}")


if __name__ == "__main__":
    sys.exit(main())
