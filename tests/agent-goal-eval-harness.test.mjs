#!/usr/bin/env node
/**
 * agent-goal EVAL-HARNESS test — deterministic fixtures, no model, no `pi` process.
 *
 * The two eval scripts read session JSONL and provider payloads to decide whether
 * the extension tracked the goal. A wrong reader makes the eval lie in both
 * directions (false failures on legal behavior, false passes on real defects), so
 * the readers are driven here with hand-built fixtures that reproduce the exact
 * entry order a real session writes.
 *
 * Covered:
 *   1. A turn that legally makes no `set_goal` call still shows the summary the
 *      previous turn left behind (the extension persists on `input`, BEFORE core
 *      appends the user message, so entry order is not turn order).
 *   2. The instruction surface of a provider payload includes `developer` blocks
 *      and a top-level `system` field, not only `role:"system"` messages.
 *   3. The summary assertions: a missing part fails, a finished goal still on the
 *      line fails, and a legal empty summary (no goal left) passes.
 *   4. The declaration has to come first in the turn: a `set_goal` call after
 *      another tool call fails the order check.
 *   5. A summary over 300 characters fails.
 *   6. The recorded payload really carries the requested model and thinking level.
 *   7. A failed run (provider error / no provider response) is classified invalid,
 *      not as a behavior failure.
 *   8. Evidence directories are unique per run.
 *
 * Run: node --test tests/agent-goal-eval-harness.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  parseSessionJsonl,
  sessionSnapshot,
  turnVerdict,
  trackingChecks,
  payloadToolSurface,
  payloadMentionsSetGoal,
  payloadConfigMismatch,
  evidenceDir,
  writeJson,
} = require("../evals/agent-goal/lib/goal-evidence.cjs");

// ── session fixtures ──────────────────────────────────────────────────────
// Entry order mirrors a real session: the extension's `input` handler persists
// the carried-over state BEFORE core appends the user message for that turn.

const stateEntry = (goal) => ({
  type: "custom",
  customType: "agent-goal-state",
  data: { goal, lastPrompt: null, lastPromptAt: null },
});
const userMsg = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantText = (text) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolCall = (name, args = {}) => ({ type: "toolCall", id: `${name}-1`, name, arguments: args });
const assistantCalls = (...calls) => ({ type: "message", message: { role: "assistant", content: calls } });
const setGoal = (goal) => assistantCalls(toolCall("set_goal", { goal }));
const assistantError = (message) => ({
  type: "message",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage: message },
});

test("a turn with no set_goal call keeps the summary the previous turn left behind", () => {
  const entries = [
    stateEntry(null), // session start / first input
    userMsg("Write a README for this directory."),
    setGoal("Write README.md describing this directory"),
    stateEntry("Write README.md describing this directory"), // set_goal persist
    stateEntry("Write README.md describing this directory"), // 2nd input persist, before its user message
    userMsg("Also add a run example to it."),
    assistantText("Added the example."), // legal no-call turn
  ];

  const first = sessionSnapshot(entries, 0, 4);
  assert.equal(first.state?.goal, "Write README.md describing this directory");
  assert.deepEqual(first.calls, [{ goal: "Write README.md describing this directory" }]);

  const second = sessionSnapshot(entries, 4, entries.length);
  assert.deepEqual(second.calls, [], "the second turn made no declaration");
  assert.equal(second.state?.goal, "Write README.md describing this directory");
});

test("a legal clear is kept as an empty declaration, not dropped", () => {
  const entries = [
    stateEntry("Write README.md describing this directory"),
    userMsg("Nothing else to do."),
    setGoal(""),
    stateEntry(null),
  ];
  const snap = sessionSnapshot(entries, 1, entries.length);
  assert.deepEqual(snap.calls, [{ goal: "" }], "an empty goal is a declaration, not a missing one");
  assert.equal(snap.state?.goal, null);
});

test("the instruction surface covers developer blocks, role:system and top-level system", () => {
  const developer = { messages: [{ role: "developer", content: "set_goal: leaked guideline" }] };
  const systemMessage = { messages: [{ role: "system", content: "set_goal: leaked guideline" }] };
  const topLevel = { system: "set_goal: leaked guideline", messages: [] };
  const declared = { tools: [{ type: "function", function: { name: "set_goal" } }], messages: [] };

  for (const [name, payload] of Object.entries({ developer, systemMessage, topLevel, declared })) {
    assert.match(payloadToolSurface(payload), /set_goal/, `${name} must be part of the instruction surface`);
    assert.equal(payloadMentionsSetGoal(payload), true, `${name} must be detected`);
  }

  // Conversation text is not an instruction block: the eval's own prompt names
  // the tool, so a hit there would prove nothing.
  const conversation = { messages: [{ role: "user", content: "set_goal: please declare the goal" }] };
  assert.equal(payloadMentionsSetGoal(conversation), false);
});

// ── tracking assertions ───────────────────────────────────────────────────

const TURNS = [
  {
    id: "join",
    label: "task 2 joins",
    expect: [
      { label: "task 1 is still there", match: /stats|numbers/i },
      { label: "task 2 follows, separated by \"; \"", match: /(stats|numbers)[^;]*;[^;]*readme/is },
    ],
  },
  {
    id: "done",
    label: "task 2 finished",
    expect: [{ label: "task 1 remains", match: /stats|numbers/i }],
    forbid: [{ label: "the finished README goal is removed", match: /readme/i }],
  },
  {
    id: "clear",
    label: "no goals left",
    expect: [{ label: "no goal left: the summary is empty", empty: true }],
  },
];

// `events` is what the assistant actually emitted, in order: "text" for an answer
// chunk, the tool name for a call. It defaults to the tool calls plus a trailing
// answer, which is what a compliant turn looks like.
const snapshot = (state, calls = [], events = ["set_goal"]) => ({
  state,
  calls,
  callOrder: events.filter((event) => event !== "text"),
  events,
  providerErrors: [],
  providerResponses: 1,
});

test("the summary assertions hold for a real two-goal then cleared session", () => {
  const snapshots = [
    snapshot({ goal: "Write stats.mjs; write README.md" }, [{ goal: "Write stats.mjs; write README.md" }], ["set_goal", "bash"]),
    snapshot({ goal: "Write stats.mjs" }, [{ goal: "Write stats.mjs" }], ["set_goal"]),
    snapshot({ goal: null }, [{ goal: "" }], ["set_goal"]),
  ];
  const verdict = trackingChecks(TURNS, snapshots);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.results.filter((r) => !r.ok)));
});

test("a legal empty summary is not a failure", () => {
  const snapshots = [
    snapshot({ goal: "Write stats.mjs; write README.md" }, [{ goal: "Write stats.mjs; write README.md" }], ["set_goal"]),
    snapshot({ goal: "Write stats.mjs" }, [{ goal: "Write stats.mjs" }], ["set_goal"]),
    // The clear turn: state is null and the declaration itself is "".
    snapshot({ goal: null }, [{ goal: "" }], ["set_goal"]),
  ];
  const clearTurn = TURNS[2];
  const verdict = trackingChecks([clearTurn], [snapshots[2]]);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.results));
  assert.ok(verdict.results.some((r) => /empty summary/.test(r.label)));
});

test("a finished goal still on the summary fails", () => {
  const snapshots = [
    snapshot({ goal: "Write stats.mjs; write README.md" }, [{ goal: "Write stats.mjs; write README.md" }], ["set_goal"]),
    snapshot({ goal: "Write stats.mjs; write README.md" }, [{ goal: "Write stats.mjs; write README.md" }], ["set_goal"]),
    snapshot({ goal: null }, [{ goal: "" }], ["set_goal"]),
  ];
  const verdict = trackingChecks([TURNS[1]], [snapshots[1]]);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.results.some((r) => !r.ok && /README goal is removed/.test(r.label)), JSON.stringify(verdict.results));
});

test("a summary that lost a goal fails the retention check", () => {
  const lost = snapshot({ goal: "Write README.md" }, [{ goal: "Write README.md" }], ["set_goal"]);
  const verdict = trackingChecks([TURNS[0]], [lost]);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.results.some((r) => !r.ok && /task 1 is still there/.test(r.label)));
});

test("a turn that answers and never declares fails on both counts", () => {
  const chatty = snapshot({ goal: "Write stats.mjs" }, [], ["text"]);
  const verdict = trackingChecks([TURNS[1]], [chatty]);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.results.some((r) => !r.ok && /expected a set_goal call/.test(r.label)));
});

test("a turn that should have declared but did not fails", () => {
  const missing = snapshot({ goal: "Write stats.mjs" }, [], []);
  const verdict = trackingChecks([TURNS[1]], [missing]);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.results.some((r) => !r.ok && /expected a set_goal call/.test(r.label)));
});

test("the OFF turn must not declare", () => {
  const turn = { id: "off", label: "OFF turn", call: "forbidden", expect: [{ label: "summary unchanged", match: /stats/i }] };
  assert.equal(trackingChecks([turn], [snapshot({ goal: "Write stats.mjs" }, [], [])]).ok, true);
  const declared = trackingChecks([turn], [snapshot({ goal: "Write stats.mjs" }, [{ goal: "x" }], ["set_goal"])]);
  assert.equal(declared.ok, false);
});

test("a DECLARED goal over the 300-char limit fails even though the store truncated it", () => {
  // The extension stores `goal.slice(0, 300)`, so the persisted summary can never
  // exceed the limit. Reading the stored value would therefore always pass; the
  // declaration is the only place the over-long text is visible.
  const long = "x".repeat(301);
  const truncated = "x".repeat(300);
  const verdict = trackingChecks([{ id: "long", label: "long summary" }], [snapshot({ goal: truncated }, [{ goal: long }])]);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.results.some((r) => !r.ok && /301 chars, over the 300 limit/.test(r.label)), JSON.stringify(verdict.results));

  const legal = trackingChecks([{ id: "legal", label: "legal summary" }], [snapshot({ goal: truncated }, [{ goal: truncated }])]);
  assert.equal(legal.ok, true, JSON.stringify(legal.results));
});

// ── payload config ────────────────────────────────────────────────────────

test("payload config mismatch is reported for the wrong model or thinking level", () => {
  const config = { model: "trendmicro/deepseek-v4.1-flash", thinking: "high" };
  const good = { model: "deepseek-v4.1-flash", thinking: { type: "enabled" }, reasoning_effort: "high" };
  assert.equal(payloadConfigMismatch([good], config), null);

  // Provider-specific thinking shapes all count as "thinking was requested".
  assert.equal(payloadConfigMismatch([{ model: "deepseek-v4.1-flash", enable_thinking: true }], config), null);
  assert.equal(payloadConfigMismatch([{ model: "deepseek-v4.1-flash", thinking: "high" }], config), null);
  assert.equal(payloadConfigMismatch([{ model: "deepseek-v4.1-flash", reasoning: { effort: "high" } }], config), null);

  assert.match(payloadConfigMismatch([{ ...good, reasoning_effort: "low" }], config), /thinking effort "low"/);
  assert.match(payloadConfigMismatch([{ ...good, thinking: { type: "disabled" } }], config), /disables thinking/);
  assert.match(payloadConfigMismatch([{ ...good, model: "gpt-6.1-sol" }], config), /payload model "gpt-6.1-sol"/);
  assert.match(
    payloadConfigMismatch([{ model: "deepseek-v4.1-flash", messages: [] }], config),
    /no thinking config/,
  );
  // A model that takes no thinking parameter at all must not look invalid.
  assert.equal(payloadConfigMismatch([{ model: "some-plain-model" }], { model: "some-plain-model", thinking: "off" }), null);
});

test("thinking inside chat-template kwargs is read from enable_thinking", () => {
  const on = { model: "m", thinking: "high" };

  // chat-template kwargs carry the real switch: enable_thinking:false is not
  // "thinking on", whichever kwargs field the provider uses.
  assert.match(
    payloadConfigMismatch([{ model: "m", chat_template_kwargs: { enable_thinking: false } }], on),
    /disables thinking/,
  );
  assert.match(
    payloadConfigMismatch([{ model: "m", chat_template_args: { enable_thinking: false } }], on),
    /disables thinking/,
  );
  assert.equal(payloadConfigMismatch([{ model: "m", chat_template_kwargs: { enable_thinking: true } }], on), null);
});

test("an explicit off request is verified instead of skipped", () => {
  const off = { model: "m", thinking: "off" };

  // A payload that explicitly enables thinking does not honor an off request.
  assert.match(
    payloadConfigMismatch([{ model: "m", thinking: { type: "enabled" }, reasoning_effort: "high" }], off),
    /enables thinking/,
  );
  assert.match(payloadConfigMismatch([{ model: "m", enable_thinking: true }], off), /enables thinking/);
  assert.equal(payloadConfigMismatch([{ model: "m" }], off), null);
  assert.equal(payloadConfigMismatch([{ model: "m", thinking: { type: "disabled" } }], off), null);
  assert.equal(payloadConfigMismatch([{ model: "m", thinking: "off" }], off), null);
});

// ── invalid vs behavior failure ───────────────────────────────────────────

test("a provider error or a turn with no provider response is invalid, not a behavior failure", () => {
  const errored = sessionSnapshot([userMsg("go"), assistantError("rate limited")], 0, 2);
  assert.deepEqual(errored.providerErrors, ["rate limited"]);
  assert.equal(turnVerdict(errored).status, "invalid");
  assert.match(turnVerdict(errored).reason, /provider error: rate limited/);

  const silent = sessionSnapshot([userMsg("go"), stateEntry("Some goal")], 0, 2);
  assert.equal(silent.providerResponses, 0);
  assert.equal(turnVerdict(silent).status, "invalid");
  assert.match(turnVerdict(silent).reason, /no provider response/);

  const ran = sessionSnapshot([userMsg("go"), assistantText("done")], 0, 2);
  assert.equal(turnVerdict(ran).status, "ok");
});

// ── evidence dirs ─────────────────────────────────────────────────────────

test("each run gets its own evidence directory", () => {
  const first = evidenceDir("ag-eval-harness-test");
  const second = evidenceDir("ag-eval-harness-test");
  try {
    assert.notEqual(first, second);
    assert.ok(fs.existsSync(first) && fs.existsSync(second));
    writeJson(path.join(first, "result.json"), { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first, "result.json"), "utf8")), { ok: true });
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("a torn session line is dropped instead of breaking the reader", () => {
  const entries = parseSessionJsonl(`${JSON.stringify(userMsg("go"))}\n{"type":"message","mess`);
  assert.equal(entries.length, 1);
});
