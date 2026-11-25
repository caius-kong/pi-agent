#!/usr/bin/env python3
"""Herdr event hook -> Bark push. Stdlib only, no third-party code.

Two things Herdr does not give you for free, handled here:

1. A pane you are watching reports `idle` on completion, not `done`. A hook that
   only matches `done` drops that event silently. We remember the previous
   status per pane and treat `working|blocked -> idle` as a completion.
2. The event payload carries no task context (`title` is only present when
   something calls `herdr pane report-metadata`). We re-read the pane through
   `herdr agent list` to recover the agent kind, terminal title and cwd, then
   add the git branch.

Config lives in exactly one file: `<plugin root>/.env`. There is no fallback
chain, so the key cannot end up stored in two places by accident. Process
environment still overrides, for one-off testing.

Quiet hours silence pushes for the hours you are at the desk anyway:

    BARK_QUIET_ENABLE=true
    BARK_QUIET_TZ=Asia/Shanghai
    BARK_QUIET_DAYS=mon-fri
    BARK_QUIET_HOURS=09:00-12:00,14:00-18:00
    BARK_QUIET_EXEMPT=          # kinds that still fire, e.g. "blocked"

Recognised keys: BARK_KEY, BARK_SERVER, BARK_GROUP, BARK_LEVEL, BARK_SOUND,
BARK_BLOCKED_DELAY, BARK_REPLY_CHARS, BARK_GOAL_CHARS, BARK_QUIET_ENABLE,
BARK_QUIET_TZ, BARK_QUIET_DAYS, BARK_QUIET_HOURS, BARK_QUIET_EXEMPT.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

STATE_DIR = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR", "."))
PLUGIN_ROOT = Path(os.environ.get("HERDR_PLUGIN_ROOT") or Path(__file__).resolve().parent)
CONFIG_FILE = PLUGIN_ROOT / ".env"
STATE_FILE = STATE_DIR / "state.json"

CONFIG_KEYS = ("BARK_KEY", "BARK_SERVER", "BARK_GROUP", "BARK_LEVEL",
               "BARK_SOUND", "BARK_BLOCKED_DELAY", "BARK_REPLY_CHARS",
               "BARK_GOAL_CHARS", "BARK_QUIET_ENABLE", "BARK_QUIET_TZ",
               "BARK_QUIET_DAYS", "BARK_QUIET_HOURS", "BARK_QUIET_EXEMPT")

SESSION_TAIL_BYTES = 256 * 1024
LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# idle only counts as a completion when the pane was actually busy before.
COMPLETION_PREV = ("working", "blocked")

LABELS = {"blocked": "需要你", "done": "已完成", "unknown": "状态丢失", "exited": "已退出"}


def load_config():
    cfg = {}
    if CONFIG_FILE.is_file():
        try:
            text = CONFIG_FILE.read_text(encoding="utf-8")
        except OSError:
            text = ""
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[7:]
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key in CONFIG_KEYS:
                cfg[key] = value.strip().strip('"').strip("'")
    for key in CONFIG_KEYS:
        if os.environ.get(key):
            cfg[key] = os.environ[key]
    return cfg


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"panes": {}}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def parse_days(spec):
    days = set()
    for part in spec.lower().replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            start, end = part.split("-", 1)
            first, last = DAY_NAMES.index(start[:3]), DAY_NAMES.index(end[:3])
            if first <= last:
                days.update(range(first, last + 1))
            else:  # wrap, e.g. fri-mon
                days.update(range(first, 7))
                days.update(range(0, last + 1))
        else:
            days.add(DAY_NAMES.index(part[:3]))
    return days


def parse_windows(spec):
    windows = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        start, end = part.split("-", 1)
        windows.append((parse_hhmm(start), parse_hhmm(end)))
    return windows


def parse_hhmm(value):
    hour, _, minute = value.strip().partition(":")
    return int(hour) * 60 + int(minute or 0)


def local_now(cfg):
    tz = cfg.get("BARK_QUIET_TZ", "").strip()
    if tz:
        try:
            from zoneinfo import ZoneInfo
            return datetime.now(ZoneInfo(tz))
        except Exception:
            pass
    return datetime.now()


def in_quiet_hours(cfg, kind=None, now=None):
    if cfg.get("BARK_QUIET_ENABLE", "true").strip().lower() in ("0", "false", "no", "off"):
        return False
    spec = cfg.get("BARK_QUIET_HOURS", "").strip()
    if not spec:
        return False
    exempt = {p.strip().lower() for p in cfg.get("BARK_QUIET_EXEMPT", "").split(",") if p.strip()}
    if kind and kind.lower() in exempt:
        return False
    now = now or local_now(cfg)
    days = cfg.get("BARK_QUIET_DAYS", "").strip()
    if days and now.weekday() not in parse_days(days):
        return False
    minute = now.hour * 60 + now.minute
    for start, end in parse_windows(spec):
        if start <= end:
            if start <= minute < end:
                return True
        elif minute >= start or minute < end:  # crosses midnight
            return True
    return False


def push(cfg, title, body, dry_run=False):
    key = cfg.get("BARK_KEY")
    if not key:
        print("BARK_KEY missing in " + str(CONFIG_FILE), file=sys.stderr)
        return False
    server = cfg.get("BARK_SERVER", "https://api.day.app").rstrip("/")
    query = {"group": cfg.get("BARK_GROUP", "herdr")}
    if cfg.get("BARK_LEVEL"):
        query["level"] = cfg["BARK_LEVEL"]
    if cfg.get("BARK_SOUND"):
        query["sound"] = cfg["BARK_SOUND"]
    url = "{}/{}/{}/{}?{}".format(
        server,
        urllib.parse.quote(key, safe=""),
        urllib.parse.quote(title, safe=""),
        urllib.parse.quote(body, safe=""),
        urllib.parse.urlencode(query),
    )
    if dry_run:
        print("DRY-RUN would GET " + url.replace(key, "<key>"))
        return True
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            print("bark {} {}".format(resp.status, resp.read(200).decode("utf-8", "replace")))
        return True
    except Exception as exc:  # a failed push must never break the hook
        print("bark push failed: {}".format(exc), file=sys.stderr)
        return False


def pane_info(pane_id):
    """Re-read the pane through the Herdr CLI to recover what the event omits."""
    binary = os.environ.get("HERDR_BIN_PATH") or "herdr"
    try:
        out = subprocess.run([binary, "agent", "list"], capture_output=True,
                             text=True, timeout=10).stdout
        for agent in json.loads(out)["result"]["agents"]:
            if agent.get("pane_id") == pane_id:
                return agent
    except Exception:
        pass
    return {}


def git_branch(cwd):
    if not cwd:
        return ""
    try:
        done = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
                              capture_output=True, text=True, timeout=5)
        return done.stdout.strip() if done.returncode == 0 else ""
    except Exception:
        return ""


def as_int(value, default):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def clip(text, limit):
    flat = LINK_RE.sub(r"\1", text or "")
    flat = " ".join(flat.replace("**", "").replace("`", "").split())
    if limit <= 0 or not flat:
        return ""
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def read_session_tail(path):
    """Parse the last chunk of a JSONL session file, newest entries last."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            start = max(0, size - SESSION_TAIL_BYTES)
            handle.seek(start)
            data = handle.read()
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # the first line is probably cut mid-object
    entries = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def message_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "\n".join(parts)


def session_context(info, cfg):
    """Last reply and goal, from the agent's own session transcript.

    Herdr reports `agent_session.value` for agents that announce a session file
    (pi does; codex does not). Screen scraping cannot recover these reliably:
    the tail of an agent TUI is its input box and status bar.
    """
    path = (info.get("agent_session") or {}).get("value")
    want_reply = as_int(cfg.get("BARK_REPLY_CHARS"), 200)
    want_goal = as_int(cfg.get("BARK_GOAL_CHARS"), 120)
    if not path or (want_reply <= 0 and want_goal <= 0):
        return "", ""

    reply = goal = ""
    for entry in reversed(read_session_tail(path)):
        if not goal and want_goal > 0 and entry.get("customType") == "agent-goal-state":
            data = entry.get("data") or {}
            goal = clip(data.get("goal") or data.get("lastPrompt") or "", want_goal)
        if not reply and want_reply > 0 and entry.get("type") == "message":
            message = entry.get("message") or {}
            if message.get("role") == "assistant":
                reply = clip(message_text(message), want_reply)
        if (goal or want_goal <= 0) and (reply or want_reply <= 0):
            break
    return goal, reply


def workspace_label(workspace_id):
    binary = os.environ.get("HERDR_BIN_PATH") or "herdr"
    if not workspace_id:
        return ""
    try:
        out = subprocess.run([binary, "workspace", "get", workspace_id],
                             capture_output=True, text=True, timeout=10).stdout
        return (json.loads(out)["result"]["workspace"].get("label") or "").strip()
    except Exception:
        return ""


def agent_name(data, info):
    return (info.get("agent") or data.get("display_agent")
            or data.get("agent") or "agent")


def location(data, context, info):
    """Name the pane the way it was named in Herdr, not by its directory.

    Several workspaces can share one cwd (every `~/.pi` session shows `.pi`), so
    the renamed workspace label is the only part that tells them apart.
    """
    cwd = info.get("foreground_cwd") or info.get("cwd") or context.get("workspace_cwd") or ""
    parts = []

    label = (context.get("workspace_label") or "").strip()
    if not label:
        label = workspace_label(data.get("workspace_id") or context.get("workspace_id"))
    if not label:
        label = (info.get("terminal_title_stripped") or data.get("title") or "").strip()
    if label:
        parts.append(label)

    tab = (context.get("tab_label") or "").strip()
    if tab and not tab.isdigit() and tab not in parts:
        parts.append(tab)

    parts.extend(p for p in ((context.get("worktree") or {}).get("repo_name", ""),
                             git_branch(cwd)) if p)
    return " · ".join(parts) or (os.path.basename(cwd) if cwd else "")


def human(seconds):
    if not seconds or seconds < 0:
        return ""
    if seconds < 60:
        return "{}s".format(int(seconds))
    return "{}m{:02d}s".format(int(seconds // 60), int(seconds % 60))


def handle_event(cfg, state, dry_run=False, force=False):
    envelope = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON", "{}"))
    data = envelope.get("data", {})
    context = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
    pane_id = data.get("pane_id")
    if not pane_id:
        return 0

    panes = state.setdefault("panes", {})
    entry = panes.get(pane_id, {})
    prev = entry.get("status")
    status = data.get("agent_status")
    event_type = data.get("type")

    if event_type in ("pane_exited", "pane_closed"):
        kind = "exited"
    elif status == "blocked":
        kind = "blocked"
    elif status == "done":
        kind = "done"
    elif status == "idle" and prev in COMPLETION_PREV:
        kind = "done"
    elif status == "unknown" and prev in COMPLETION_PREV:
        kind = "unknown"
    else:
        kind = None

    if status == "working":
        entry["working_since"] = int(time.time())

    # blocked is often transient: agents that auto-approve pass straight through.
    info = {}
    if kind == "blocked" and not dry_run:
        delay = float(cfg.get("BARK_BLOCKED_DELAY", "3") or 0)
        if delay > 0:
            time.sleep(delay)
            info = pane_info(pane_id)
            if info.get("agent_status") != "blocked":
                kind = None

    duration = ""
    if kind in ("done", "unknown") and entry.get("working_since"):
        duration = human(time.time() - entry["working_since"])

    if status:
        entry["status"] = status
        entry["seen_at"] = int(time.time())
        panes[pane_id] = entry
    save_state(state)

    if not kind:
        return 0

    if not force and in_quiet_hours(cfg, kind):
        print("quiet hours {}, suppressed {}".format(
            cfg.get("BARK_QUIET_HOURS", ""), kind))
        return 0

    if not info:
        info = pane_info(pane_id)
    agent, where = agent_name(data, info), location(data, context, info)
    goal, reply = session_context(info, cfg)
    title = "{} {}".format(agent, LABELS[kind])
    if kind == "done":
        stamp = " ({})".format(duration or time.strftime("%H:%M"))
    else:
        stamp = ""
    lines = [(where + stamp) if where else (LABELS[kind] + stamp)]
    if goal:
        lines.append("目标：" + goal)
    if reply:
        lines.append(reply)
    push(cfg, title, "\n".join(lines), dry_run=dry_run)
    return 0


def main(argv):
    cfg = load_config()
    action = argv[1] if len(argv) > 1 else None
    dry_run = "--dry-run" in argv
    force = "--force" in argv

    if action == "test":
        ok = push(cfg, "herdr-bark 测试", "配置正确，推送链路通畅。", dry_run=dry_run)
        return 0 if ok else 1

    if action == "status":
        print("config:        {} {}".format(
            "✓" if CONFIG_FILE.is_file() else "·", CONFIG_FILE))
        print("state:         {}".format(STATE_FILE))
        print("key set:       {}".format(bool(cfg.get("BARK_KEY"))))
        print("server:        {}".format(cfg.get("BARK_SERVER", "https://api.day.app")))
        print("group:         {}".format(cfg.get("BARK_GROUP", "herdr")))
        print("quiet enabled: {}".format(
            cfg.get("BARK_QUIET_ENABLE", "true").strip().lower()
            not in ("0", "false", "no", "off")))
        print("quiet hours:   {} {} tz={}".format(
            cfg.get("BARK_QUIET_DAYS", "-") or "-",
            cfg.get("BARK_QUIET_HOURS", "-") or "-",
            cfg.get("BARK_QUIET_TZ", "-") or "-"))
        print("quiet exempt:  {}".format(cfg.get("BARK_QUIET_EXEMPT", "-") or "-"))
        print("reply chars:   {}".format(cfg.get("BARK_REPLY_CHARS", "200")))
        print("goal chars:    {}".format(cfg.get("BARK_GOAL_CHARS", "120")))
        now = local_now(cfg)
        print("now:           {} {}".format(
            now.strftime("%a %H:%M"),
            "QUIET" if in_quiet_hours(cfg) else "active"))
        for pane, entry in load_state().get("panes", {}).items():
            print("  {} -> {}".format(pane, entry.get("status")))
        return 0

    return handle_event(cfg, load_state(), dry_run=dry_run, force=force)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
