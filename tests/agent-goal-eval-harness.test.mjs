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
 *   1. A turn that legally makes no `set_goal` call still shows the goal the
 *      previous turn left behind (the extension persists on `input`, BEFORE core
 *      appends the user message, so entry order is not turn order).
 *   2. The instruction surface of a provider payload includes `developer` blocks
 *      and a top-level `system` field, not only `role:"system"` messages.
 *   3. "The parent goal survived" compares the parent line to the previous turn's
 *      parent line instead of a loose topic regex.
 *   4. The recorded payload really carries the requested model and thinking level.
 *   5. A failed run (provider error / no provider response) is classified invalid,
 *      not as a behavior failure.
 *   6. Evidence directories are unique per run.
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

const stateEntry = (goal, subGoal = null) => ({
  type: "custom",
  customType: "agent-goal-state",
  data: { goal, subGoal, goalSetAt: null, lastPrompt: null, lastPromptAt: null },
});
const userMsg = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantText = (text) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantCall = (mode, goal) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "set_goal", arguments: { mode, goal } }] },
});
const assistantError = (message) => ({
  type: "message",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage: message },
});

test("a turn with no set_goal call keeps the goal the previous turn left behind", () => {
  const entries = [
    stateEntry(null), // session start / first input
    userMsg("Write a README for this directory."),
    assistantCall("new", "Write README.md describing this directory"),
    stateEntry("Write README.md describing this directory"), // set_goal persist
    stateEntry("Write README.md describing this directory"), // 2nd input persist, before its user message
    userMsg("Also add a run example to it."),
    assistantText("Added the example."), // legal no-call turn
  ];

  const first = sessionSnapshot(entries, 0, 4);
  assert.equal(first.state?.goal, "Write README.md describing this directory");
  assert.equal(first.calls.length, 1);

  const second = sessionSnapshot(entries, 4, entries.length);
  assert.deepEqual(second.calls, [], "the second turn made no declaration");
  assert.equal(second.state?.goal, "Write README.md describing this directory");
  assert.equal(second.state?.subGoal, null);
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

const TRACKING_TURNS = [
  { id: "start", modes: ["new"], goal: /summar|data|脚本|script/i, label: "task start" },
  { id: "subproblem", modes: ["expand", null], goal: /summar|data|脚本|script/i, label: "sub-problem (parent must survive)" },
];

const snapshot = (state, calls = []) => ({ state, calls, providerErrors: [], providerResponses: 1 });

test("a parent goal that was replaced fails the parent-preserved check", () => {
  const replaced = [
    snapshot({ goal: "Create data.txt and summarize.mjs", subGoal: null }, [
      { mode: "new", goal: "Create data.txt and summarize.mjs" },
    ]),
    snapshot({ goal: "Rename variables in summarize.mjs", subGoal: "Rename variables" }, [
      { mode: "expand", goal: "Rename variables" },
    ]),
  ];

  const verdict = trackingChecks(TRACKING_TURNS, replaced);
  assert.equal(verdict.ok, false, "a parent line that changed must fail even if it still matches the topic regex");
  assert.ok(verdict.results.some((result) => !result.ok && /parent/.test(result.label)));
});

test("an unchanged parent with a nested focus passes the parent-preserved check", () => {
  const kept = [
    snapshot({ goal: "Create data.txt and summarize.mjs", subGoal: null }, [
      { mode: "new", goal: "Create data.txt and summarize.mjs" },
    ]),
    snapshot({ goal: "Create data.txt and summarize.mjs", subGoal: "Fix row 7 of data.txt" }, [
      { mode: "expand", goal: "Fix row 7 of data.txt" },
    ]),
  ];
  assert.equal(trackingChecks(TRACKING_TURNS, kept).ok, true);

  const noCall = [kept[0], snapshot({ goal: "Create data.txt and summarize.mjs", subGoal: null }, [])];
  assert.equal(trackingChecks(TRACKING_TURNS, noCall).ok, true);
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
