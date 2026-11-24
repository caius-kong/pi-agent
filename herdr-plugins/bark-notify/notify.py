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

Config is read from the first of these that exists, later keys not overriding
earlier ones, with the process environment winning last:

    HERDR_PLUGIN_CONFIG_DIR/.env     (plugin-owned, preferred)
    ~/.env                           (machine-wide secrets file)

Recognised keys: BARK_KEY, BARK_SERVER, BARK_GROUP, BARK_LEVEL, BARK_SOUND,
BARK_BLOCKED_DELAY.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

STATE_DIR = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR", "."))
CONFIG_DIR = Path(os.environ.get("HERDR_PLUGIN_CONFIG_DIR", "."))
STATE_FILE = STATE_DIR / "state.json"

CONFIG_KEYS = ("BARK_KEY", "BARK_SERVER", "BARK_GROUP", "BARK_LEVEL",
               "BARK_SOUND", "BARK_BLOCKED_DELAY")

# idle only counts as a completion when the pane was actually busy before.
COMPLETION_PREV = ("working", "blocked")

LABELS = {"blocked": "需要你", "done": "已完成", "unknown": "状态丢失", "exited": "已退出"}


def env_files():
    return [CONFIG_DIR / ".env", Path.home() / ".env"]


def load_config():
    cfg = {}
    source = None
    for path in env_files():
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[7:]
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key in CONFIG_KEYS and key not in cfg:
                cfg[key] = value.strip().strip('"').strip("'")
                source = source or path
    for key in CONFIG_KEYS:
        if os.environ.get(key):
            cfg[key] = os.environ[key]
            source = "environment"
    return cfg, source


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"panes": {}}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def push(cfg, title, body, dry_run=False):
    key = cfg.get("BARK_KEY")
    if not key:
        print("BARK_KEY not found in " + " or ".join(str(p) for p in env_files()),
              file=sys.stderr)
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


def describe(data, context, info):
    agent = (info.get("agent") or data.get("display_agent")
             or data.get("agent") or "agent")
    title = (info.get("terminal_title_stripped") or data.get("title") or "").strip()
    cwd = info.get("foreground_cwd") or info.get("cwd") or context.get("workspace_cwd") or ""
    repo = (context.get("worktree") or {}).get("repo_name", "")
    branch = git_branch(cwd)
    parts = [p for p in (title, repo, branch) if p]
    where = " · ".join(parts) or (os.path.basename(cwd) if cwd else "")
    return agent, where


def human(seconds):
    if not seconds or seconds < 0:
        return ""
    if seconds < 60:
        return "{}s".format(int(seconds))
    return "{}m{:02d}s".format(int(seconds // 60), int(seconds % 60))


def handle_event(cfg, state, dry_run=False):
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

    if not info:
        info = pane_info(pane_id)
    agent, where = describe(data, context, info)
    title = "{} {}".format(agent, LABELS[kind])
    if kind == "done":
        stamp = " ({})".format(duration or time.strftime("%H:%M"))
    else:
        stamp = ""
    body = (where + stamp) if where else (LABELS[kind] + stamp)
    push(cfg, title, body, dry_run=dry_run)
    return 0


def main(argv):
    cfg, source = load_config()
    action = argv[1] if len(argv) > 1 else None
    dry_run = "--dry-run" in argv

    if action == "test":
        ok = push(cfg, "herdr-bark 测试", "配置正确，推送链路通畅。", dry_run=dry_run)
        return 0 if ok else 1

    if action == "status":
        print("config source: {}".format(source or "none"))
        for path in env_files():
            print("  {} {}".format("✓" if path.is_file() else "·", path))
        print("state:         {}".format(STATE_FILE))
        print("key set:       {}".format(bool(cfg.get("BARK_KEY"))))
        print("server:        {}".format(cfg.get("BARK_SERVER", "https://api.day.app")))
        print("group:         {}".format(cfg.get("BARK_GROUP", "herdr")))
        for pane, entry in load_state().get("panes", {}).items():
            print("  {} -> {}".format(pane, entry.get("status")))
        return 0

    return handle_event(cfg, load_state(), dry_run=dry_run)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
