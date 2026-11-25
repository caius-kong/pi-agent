#!/usr/bin/env python3
"""Regression suite for the bark-notify Herdr plugin.

Hermetic: no network, no Herdr CLI, no real state directory. `pane_info`,
`workspace_label` and `push` are stubbed per test, and every path is a temp dir.

    cd ~/.pi/herdr-plugins/bark-notify
    python3 -m unittest discover -s tests -v
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN_DIR))
import notify  # noqa: E402  (path set up above)

# 2026-11-23 is a Monday.
MON, WED, FRI, SAT = 23, 25, 27, 28

QUIET = {
    "BARK_QUIET_ENABLE": "true",
    "BARK_QUIET_TZ": "Asia/Shanghai",
    "BARK_QUIET_DAYS": "mon-fri",
    "BARK_QUIET_HOURS": "09:00-12:00,14:00-18:00",
}


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bark-notify-test-"))
        self._saved = (notify.STATE_DIR, notify.STATE_FILE, notify.CONFIG_FILE)
        notify.STATE_DIR = self.tmp
        notify.STATE_FILE = self.tmp / "state.json"
        notify.CONFIG_FILE = self.tmp / ".env"

        self.pushed = []
        self._push = notify.push
        notify.push = lambda cfg, title, body, dry_run=False: (
            self.pushed.append((title, body)) or True)

        self.info = {}
        self._pane_info = notify.pane_info
        notify.pane_info = lambda pane_id: self.info

        self._label = notify.workspace_label
        notify.workspace_label = lambda workspace_id: ""

        for key in list(os.environ):
            if key.startswith("HERDR_PLUGIN_"):
                del os.environ[key]

    def tearDown(self):
        notify.STATE_DIR, notify.STATE_FILE, notify.CONFIG_FILE = self._saved
        notify.push = self._push
        notify.pane_info = self._pane_info
        notify.workspace_label = self._label
        for key in list(os.environ):
            if key.startswith("HERDR_PLUGIN_"):
                del os.environ[key]
        shutil.rmtree(self.tmp, ignore_errors=True)

    def event(self, data, context=None, cfg=None, force=False, dry_run=True):
        os.environ["HERDR_PLUGIN_EVENT_JSON"] = json.dumps({"data": data})
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = json.dumps(context or {})
        before = len(self.pushed)
        notify.handle_event(cfg if cfg is not None else {}, notify.load_state(),
                            dry_run=dry_run, force=force)
        return self.pushed[before] if len(self.pushed) > before else None

    def status(self, pane_id):
        return notify.load_state()["panes"].get(pane_id, {}).get("status")

    def write_session(self, entries):
        path = self.tmp / "session.jsonl"
        path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
        return str(path)


class StateMachine(Base):
    pane = {"pane_id": "w1:p1", "workspace_id": "w1"}

    def test_working_is_silent(self):
        self.assertIsNone(self.event(dict(self.pane, agent_status="working")))
        self.assertEqual(self.status("w1:p1"), "working")

    def test_working_to_idle_is_a_completion(self):
        self.event(dict(self.pane, agent_status="working"))
        title, _ = self.event(dict(self.pane, agent_status="idle"))
        self.assertEqual(title, "agent 已完成")

    def test_done_notifies(self):
        self.assertEqual(self.event(dict(self.pane, agent_status="done"))[0],
                         "agent 已完成")

    def test_done_then_idle_does_not_notify_twice(self):
        self.event(dict(self.pane, agent_status="done"))
        self.assertIsNone(self.event(dict(self.pane, agent_status="idle")))

    def test_blocked_notifies(self):
        self.assertEqual(self.event(dict(self.pane, agent_status="blocked"))[0],
                         "agent 需要你")

    def test_unknown_after_working_notifies(self):
        self.event(dict(self.pane, agent_status="working"))
        self.assertEqual(self.event(dict(self.pane, agent_status="unknown"))[0],
                         "agent 状态丢失")

    def test_unknown_after_idle_is_silent(self):
        self.event(dict(self.pane, agent_status="idle"))
        self.assertIsNone(self.event(dict(self.pane, agent_status="unknown")))

    def test_exited_uses_remembered_agent_name(self):
        self.event({"pane_id": "w9:p1", "agent_status": "done", "agent": "codex"})
        title, _ = self.event({"type": "pane_exited", "pane_id": "w9:p1"})
        self.assertEqual(title, "codex 已退出")

    def test_quiet_suppressed_event_still_records_status(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(self.event({"pane_id": "w2:p1", "agent_status": "done"},
                                         cfg=QUIET))
        self.assertEqual(self.status("w2:p1"), "done")


class BlockedRecheck(Base):
    """HIGH: an unreadable status must not swallow an approval request."""

    data = {"pane_id": "w1:p1", "agent_status": "blocked", "agent": "pi"}

    def setUp(self):
        super().setUp()
        self._sleep = notify.time.sleep
        notify.time.sleep = lambda seconds: None

    def tearDown(self):
        notify.time.sleep = self._sleep
        super().tearDown()

    def test_unreadable_status_still_notifies(self):
        self.info = {}
        self.assertIsNotNone(self.event(self.data, cfg={"BARK_BLOCKED_DELAY": "1"},
                                        dry_run=False))

    def test_real_non_blocked_status_cancels(self):
        self.info = {"agent_status": "idle"}
        self.assertIsNone(self.event(self.data, cfg={"BARK_BLOCKED_DELAY": "1"},
                                     dry_run=False))

    def test_real_blocked_status_keeps_notifying(self):
        self.info = {"agent_status": "blocked"}
        self.assertIsNotNone(self.event(self.data, cfg={"BARK_BLOCKED_DELAY": "1"},
                                        dry_run=False))

    def test_delay_is_clamped(self):
        seen = []
        notify.time.sleep = seen.append
        self.event(self.data, cfg={"BARK_BLOCKED_DELAY": "9999"}, dry_run=False)
        self.assertEqual(seen, [30])


class QuietHours(unittest.TestCase):
    def quiet(self, cfg, when, kind=None):
        return notify.in_quiet_hours(cfg, kind, when)

    def test_boundaries_are_left_closed_right_open(self):
        cases = [
            (at(MON, 8, 59), False), (at(MON, 9), True), (at(WED, 10, 20), True),
            (at(WED, 12), False), (at(WED, 13, 59), False), (at(WED, 14), True),
            (at(FRI, 17, 59), True), (at(FRI, 18), False),
        ]
        for when, want in cases:
            with self.subTest(when=when):
                self.assertEqual(self.quiet(QUIET, when), want)

    def test_weekend_is_outside_the_weekday_filter(self):
        self.assertFalse(self.quiet(QUIET, at(SAT, 10)))

    def test_midnight_wrap(self):
        cfg = {"BARK_QUIET_HOURS": "22:00-06:00"}
        self.assertTrue(self.quiet(cfg, at(WED, 23, 30)))
        self.assertTrue(self.quiet(cfg, at(WED, 5, 59)))
        self.assertFalse(self.quiet(cfg, at(WED, 6)))

    def test_enable_flag_off_disables_everything(self):
        self.assertFalse(self.quiet(dict(QUIET, BARK_QUIET_ENABLE="false"), at(WED, 10)))

    def test_exempt_kind_still_fires(self):
        cfg = dict(QUIET, BARK_QUIET_EXEMPT="blocked")
        self.assertFalse(self.quiet(cfg, at(WED, 10), kind="blocked"))
        self.assertTrue(self.quiet(cfg, at(WED, 10), kind="done"))

    def test_no_schedule_means_never_quiet(self):
        self.assertFalse(self.quiet({}, at(WED, 10)))

    def test_bad_spec_is_not_quiet_and_warns(self):
        """HIGH: a typo used to raise, which silenced every future notification."""
        for spec in ("09:00–12:00", "09:00~12:00", "nine-twelve"):
            with self.subTest(spec=spec):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    result = self.quiet({"BARK_QUIET_HOURS": spec}, at(WED, 10))
                self.assertFalse(result)
                self.assertIn("bad quiet-hours config", stderr.getvalue())

    def test_bad_days_does_not_raise(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(self.quiet(dict(QUIET, BARK_QUIET_DAYS="mon-xyz"), at(WED, 10)))


class Body(Base):
    def test_goal_wins_over_reply(self):
        path = self.write_session([
            {"type": "message", "message": {"role": "assistant",
                                            "content": [{"type": "text", "text": "reply"}]}},
            {"type": "custom", "customType": "agent-goal-state", "data": {"goal": "the goal"}},
        ])
        self.info = {"agent": "pi", "agent_session": {"value": path}}
        self.assertEqual(self.event({"pane_id": "w1:p1", "agent_status": "done"}),
                         ("pi 已完成", "w1:p1\nthe goal"))

    def test_last_assistant_message_when_no_goal(self):
        path = self.write_session([
            {"type": "message", "message": {"role": "assistant",
                                            "content": [{"type": "text", "text": "first"}]}},
            {"type": "message", "message": {"role": "assistant",
                                            "content": [{"type": "text", "text": "last one"}]}},
        ])
        self.info = {"agent": "pi", "agent_session": {"value": path}}
        self.assertTrue(self.event({"pane_id": "w1:p1", "agent_status": "done"})[1]
                        .endswith("\nlast one"))

    def test_terminal_title_when_there_is_no_transcript(self):
        self.info = {"agent": "codex", "terminal_title_stripped": "fix the flaky test"}
        self.assertEqual(self.event({"pane_id": "w1:p1", "agent_status": "done"})[1],
                         "w1:p1\nfix the flaky test")

    def test_single_line_when_nothing_is_known(self):
        self.info = {"agent": "claude"}
        self.assertEqual(self.event({"pane_id": "w1:p1", "agent_status": "done"})[1], "w1:p1")

    def test_workspace_label_names_the_pane(self):
        self.assertEqual(self.event({"pane_id": "w1:p1", "agent_status": "done"},
                                    context={"workspace_label": "t3code"})[1], "t3code")

    def test_workspace_get_is_the_fallback(self):
        notify.workspace_label = lambda workspace_id: "from-cli"
        self.assertEqual(self.event({"pane_id": "w1:p1", "workspace_id": "w1",
                                     "agent_status": "done"})[1], "from-cli")

    def test_tab_label_only_when_not_a_bare_number(self):
        self.assertEqual(self.event({"pane_id": "w1:p1", "agent_status": "done"},
                                    context={"tab_label": "1"})[1], "w1:p1")
        self.assertEqual(self.event({"pane_id": "w2:p1", "agent_status": "done"},
                                    context={"tab_label": "impl"})[1], "impl")

    def test_pane_id_is_the_last_resort(self):
        self.assertEqual(self.event({"pane_id": "w7:p9", "agent_status": "done"})[1], "w7:p9")

    def test_markdown_is_flattened(self):
        self.info = {"agent": "pi", "terminal_title_stripped":
                     "see [the docs](https://example.com/a) for **bold** and `code`"}
        self.assertEqual(
            self.event({"pane_id": "w1:p1", "agent_status": "done"})[1],
            "w1:p1\nsee the docs for bold and code")

    def test_truncation_marks_the_cut(self):
        self.info = {"agent": "pi", "terminal_title_stripped": "x" * 200}
        line = self.event({"pane_id": "w1:p1", "agent_status": "done"},
                          cfg={"BARK_GOAL_CHARS": "10"})[1].split("\n")[1]
        self.assertEqual(line, "x" * 9 + "…")

    def test_zero_chars_disables_the_source(self):
        self.info = {"agent": "pi", "terminal_title_stripped": "title"}
        self.assertEqual(
            self.event({"pane_id": "w1:p1", "agent_status": "done"},
                       cfg={"BARK_GOAL_CHARS": "0"})[1], "w1:p1")


class Robustness(Base):
    def test_malformed_event_still_exits_zero(self):
        os.environ["HERDR_PLUGIN_EVENT_JSON"] = "{not json"
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(notify.main(["notify.py"]), 0)
        self.assertIn("herdr-bark:", stderr.getvalue())

    def test_event_without_pane_id_is_ignored(self):
        self.assertIsNone(self.event({"agent_status": "done"}))

    def test_missing_and_garbage_session_files(self):
        for value in ("/nope/x.jsonl", str(Path("/etc/hosts")), "", None):
            with self.subTest(value=value):
                self.assertEqual(
                    notify.session_context({"agent_session": {"value": value}}, {}),
                    ("", ""))

    def test_non_jsonl_path_is_refused(self):
        """A compromised agent must not turn this into a file-exfiltration path."""
        secret = self.tmp / "id_rsa"
        secret.write_text("PRIVATE KEY")
        self.assertEqual(
            notify.session_context({"agent_session": {"value": str(secret)}}, {}), ("", ""))

    def test_garbage_char_config_falls_back_to_default(self):
        self.assertEqual(notify.as_int("abc", 200), 200)
        self.assertEqual(notify.as_int(None, 7), 7)
        self.assertEqual(notify.as_int(" 42 ", 0), 42)

    def test_clip_edges(self):
        self.assertEqual(notify.clip("", 10), "")
        self.assertEqual(notify.clip("text", 0), "")
        self.assertEqual(notify.clip("  a \n b  ", 10), "a b")


class State(Base):
    def test_write_leaves_no_temp_file(self):
        os.environ["HERDR_PLUGIN_EVENT_JSON"] = json.dumps(
            {"data": {"pane_id": "w1:p1", "agent_status": "done"}})
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = "{}"
        notify.main(["notify.py"])
        self.assertEqual(sorted(p.name for p in self.tmp.glob("state*")),
                         ["state.json", "state.lock"])

    def test_corrupt_state_is_ignored(self):
        notify.STATE_FILE.write_text("{broken")
        self.assertEqual(notify.load_state(), {"panes": {}})

    def test_pane_closed_drops_the_entry(self):
        self.event({"pane_id": "w1:p1", "agent_status": "done"})
        self.event({"type": "pane_closed", "pane_id": "w1:p1"})
        self.assertEqual(self.status("w1:p1"), None)

    def test_concurrent_events_keep_every_pane(self):
        """HIGH: unlocked read-modify-write lost panes under concurrency."""
        env = dict(os.environ, HERDR_PLUGIN_ROOT=str(PLUGIN_DIR),
                   HERDR_PLUGIN_STATE_DIR=str(self.tmp), BARK_KEY="dummy",
                   BARK_SERVER="http://127.0.0.1:1", BARK_QUIET_ENABLE="false",
                   HERDR_PLUGIN_CONTEXT_JSON="{}")
        procs = []
        for index in range(6):
            env["HERDR_PLUGIN_EVENT_JSON"] = json.dumps(
                {"data": {"pane_id": "w{}:p1".format(index), "agent_status": "done"}})
            procs.append(subprocess.Popen([sys.executable, str(PLUGIN_DIR / "notify.py")],
                                          env=env, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL))
        for proc in procs:
            proc.wait(timeout=30)
        self.assertEqual(len(notify.load_state()["panes"]), 6)


class Config(Base):
    def test_env_parsing_handles_quotes_export_and_unknown_keys(self):
        notify.CONFIG_FILE.write_text(
            'export BARK_KEY="quoted"\nBARK_GROUP=\'single\'\nNOT_A_KEY=1\n# BARK_SOUND=no\n')
        cfg = notify.load_config()
        self.assertEqual(cfg["BARK_KEY"], "quoted")
        self.assertEqual(cfg["BARK_GROUP"], "single")
        self.assertNotIn("NOT_A_KEY", cfg)
        self.assertNotIn("BARK_SOUND", cfg)

    def test_process_env_overrides_the_file(self):
        notify.CONFIG_FILE.write_text("BARK_GROUP=from-file\n")
        os.environ["BARK_GROUP"] = "from-env"
        try:
            self.assertEqual(notify.load_config()["BARK_GROUP"], "from-env")
        finally:
            del os.environ["BARK_GROUP"]

    def test_only_the_plugin_env_is_read(self):
        """No fallback chain: ~/.env must never be consulted."""
        home_env = self.tmp / "home.env"
        home_env.write_text("BARK_KEY=from-home\n")
        original = notify.CONFIG_FILE
        notify.CONFIG_FILE = self.tmp / "missing.env"
        try:
            self.assertNotIn("BARK_KEY", notify.load_config())
        finally:
            notify.CONFIG_FILE = original


class Push(unittest.TestCase):
    def test_dry_run_masks_the_key(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            notify.push({"BARK_KEY": "supersecret", "BARK_GROUP": "g",
                         "BARK_LEVEL": "timeSensitive"},
                        "title", "body", dry_run=True)
        printed = out.getvalue()
        self.assertNotIn("supersecret", printed)
        self.assertIn("<key>", printed)
        self.assertIn("level=timeSensitive", printed)

    def test_title_and_body_are_url_encoded(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            notify.push({"BARK_KEY": "k"}, "pi 已完成", "t3code\nline two", dry_run=True)
        url = out.getvalue().split(" ", 3)[3].strip()
        self.assertIn("pi%20%E5%B7%B2%E5%AE%8C%E6%88%90", url)
        self.assertIn("%0A", url)

    def test_unreachable_server_returns_false_without_raising(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            ok = notify.push({"BARK_KEY": "k", "BARK_SERVER": "http://127.0.0.1:1"},
                             "t", "b")
        self.assertFalse(ok)
        self.assertIn("bark push failed", stderr.getvalue())

    def test_missing_key_is_reported_not_raised(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertFalse(notify.push({}, "t", "b"))
        self.assertIn("BARK_KEY missing", stderr.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
