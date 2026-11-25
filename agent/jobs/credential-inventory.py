#!/usr/bin/env python3
"""晨报的「凭据到期」板块。

数据源是 jobs/credentials.json：每个 entry 声明一组位置（locations），
每个位置 = {host?, file, key, regex?}；不写 host 表示本机，写了 regex 才去读文件。
到期日从 key 自身解出（JWT 的 exp），所以轮换后无需改这个脚本或那个 JSON。

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
        print(f'<section><h2>🔑 凭据到期</h2><p class="error">读不到 {INVENTORY}: {type(exc).__name__}</p></section>')
        return

    rows = []
    for entry in data.get("entries", []):
        label = entry.get("label") or entry.get("id", "?")
        tokens, places = scan_locations(entry)

        exps = sorted({e.date() for e in (decode_exp(t) for t in tokens) if e})
        if exps:
            exp = exps[0]
            days = (exp - today).days
            if days < 0:
                exp_cell = f'<td class="bad">{exp} · 已过期 {-days} 天</td>'
            elif days <= WARN_DAYS:
                exp_cell = f'<td class="bad">{exp} · 剩 {days} 天</td>'
            else:
                exp_cell = f'<td>{exp} · 剩 {days} 天</td>'
        elif tokens:
            exp_cell = '<td class="bad">无 exp（非 JWT）</td>'
        else:
            exp_cell = '<td class="bad">未取到 key</td>'

        locs = []
        for host, rel, key, state in places:
            line = f"{host} - {rel} - {key}" if key else f"{host} - {rel}"
            if state not in ("ok", "未探测"):
                line += f' <span class="bad">{state}</span>'
            locs.append(f'<span class="loc">{line}</span>')

        rows.append(
            "<tr>"
            f"<td>{label}</td>"
            f"{exp_cell}"
            f"<td>{''.join(locs)}</td>"
            "</tr>"
        )

    out = [
        "<section>",
        "  <h2>🔑 凭据到期</h2>",
        '  <table class="cred">',
        "    <thead><tr><th>KEY</th><th>EXP</th><th>Locations</th></tr></thead>",
        "    <tbody>",
    ]
    out += ["      " + r for r in rows] or ['      <tr><td colspan="3" class="empty">inventory 里没有条目</td></tr>']
    out += ["    </tbody>", "  </table>", "</section>"]
    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
