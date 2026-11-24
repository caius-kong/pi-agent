#!/usr/bin/env python3
"""晨报的「凭据到期」板块。

数据源是 jobs/credentials.json：每个 entry 声明一组「key 所在的文件 + 抓取它的正则」。
到期日从 key 自身解出（JWT 的 exp），所以轮换后无需改这个脚本或那个 JSON。

新增一个 key = 在 credentials.json 里加一条 entry。
"""
import base64
import datetime
import json
import os
import re
import sys

WARN_DAYS = 21
CRIT_DAYS = 7
JOBS_DIR = os.path.dirname(os.path.abspath(__file__))
INVENTORY = os.path.join(JOBS_DIR, "credentials.json")


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


def scan_entry(entry):
    """返回 (token, [(位置, 状态), ...])；token 用于去重。"""
    tokens = []
    places = []
    for src in entry.get("sources", []):
        path = expand(src["file"])
        rel = src["file"]
        if not os.path.exists(path):
            places.append((rel, "文件不存在"))
            continue
        try:
            text = open(path, encoding="utf-8", errors="ignore").read()
        except Exception as exc:
            places.append((rel, f"读取失败: {type(exc).__name__}"))
            continue
        m = re.search(src["regex"], text, re.MULTILINE)
        if not m:
            places.append((rel, "未匹配到 key"))
            continue
        tokens.append(m.group(1).strip().strip("'\""))
        places.append((rel, "ok"))
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
        tokens, places = scan_entry(entry)

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

        files = []
        for rel, state in places:
            if state == "ok":
                files.append(f"<code>{rel}</code>")
            else:
                files.append(f'<code>{rel}</code> <span class="bad">{state}</span>')
        for r in entry.get("remote", []):
            files.append(f'<code>{r}</code> <span class="meta">需人工核对</span>')

        rows.append(
            "<tr>"
            f"<td>{label}</td>"
            f"{exp_cell}"
            f"<td>{'<br>'.join(files)}</td>"
            "</tr>"
        )

    out = [
        "<section>",
        "  <h2>🔑 凭据到期</h2>",
        '  <table class="cred">',
        "    <thead><tr><th>KEY</th><th>EXP</th><th>Related Files</th></tr></thead>",
        "    <tbody>",
    ]
    out += ["      " + r for r in rows] or ['      <tr><td colspan="3" class="empty">inventory 里没有条目</td></tr>']
    out += ["    </tbody>", "  </table>", "</section>"]
    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
