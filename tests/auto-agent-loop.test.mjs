import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, registerAgentLoop, serializeForSummary, validateConfig, configFromSettings, band, pauseReason, readConfig, defaultSummarize, defaultJudge, assertCompleteSummary, IncompleteSummaryError, SUMMARY_END_MARKER } from "../agent/extensions/auto-agent-loop/controller.mjs";

const COMPLETE_SUMMARY = `## 1. Goals\n- ship it\n\n## 2. Completed\n- wrote the code\n\n## 3. Remaining necessary work\n- run the regression suite\n\n## 4. Authorization and boundaries\n- no approval pending\n\n## 5. Unknowns\n- none\n\n${SUMMARY_END_MARKER}`;

function setup(options = {}) {
  const handlers = {}, commands = {}, entries = [], notices = [], statuses = [], widgets = [];
  let branch = [];
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, value) => { commands[name] = value; },
    appendEntry: (customType, data) => {
      const entry = { type: "custom", customType, data: structuredClone(data) };
      entries.push(entry); branch.push(entry);
    },
    getAllTools: () => [],
  };
  const ctx = {
    hasUI: true, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (text) => notices.push(text), setStatus: (key, text) => statuses.push([key, text]),
      setWidget: (key, lines) => widgets.push([key, lines]) },
  };
  const controller = registerAgentLoop(pi, {
    summarize: async () => "Current requirements: run tests. Remaining authorized work: run tests.",
    judge: async () => 0.95,
    ...options,
  });
  return { pi, ctx, controller, handlers, commands, entries, notices, statuses, widgets, setBranch: (value) => { branch = value; } };
}
const boundary = (overrides = {}) => ({
  outcome: "completed", continue: false, entries: [],
  context: { canContinue: true, pendingMessages: [], contextMessages: [
    { role: "user", content: "Implement and test the change" },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented, tests not yet run." }] },
  ] }, ...overrides,
});
const on = (s) => s.commands["auto-agent-loop"].handler("on", s.ctx);
// The verdict is rendered in the widget only; notify("info"/"warning") shares that area.
const verdictOf = (s) => s.widgets.at(-1)?.[1]?.[0] ?? "";
const settle = (s, event = boundary()) => s.handlers.agent_before_settle(event, s.ctx);
const input = (s, source = "interactive", text = "Also test the new behavior") => s.handlers.input({ source, text }, s.ctx);

test("off by default; on enables monitoring without submitting a fixed goal or starting work", async () => {
  const s = setup({ summarize: async () => assert.fail("off must not call models") });
  assert.equal(await settle(s), undefined);
  assert.equal(s.controller.state.enabled, false);
  await on(s);
  assert.equal(s.controller.state.enabled, true);
  assert.equal(s.controller.state.continuations, 0);
  assert.equal(s.controller.state.goal, undefined);
});

test("high probability continues with visible remaining work; low probability ends without disabling or claiming completion", async () => {
  const s = setup(); await on(s);
  const event = boundary(); event.context.canContinue = false;
  const next = await settle(s, event);
  assert.equal(next.continue, true);
  assert.match(next.entries.at(-1).content, /run tests/);
  assert.match(next.entries.at(-1).content, /untrusted/i);
  assert.equal(s.controller.state.continuations, 1);
  assert.equal(s.controller.state.probability, 0.95);
  const low = setup({ judge: async () => 0.2 }); await on(low);
  assert.equal(await settle(low), undefined);
  assert.equal(low.controller.state.enabled, true);
  assert.equal(low.controller.state.status, "ended");
  assert.doesNotMatch(low.notices.at(-1), /complete/i);
});

test("thresholds are inclusive and uncertain verdict never continues", async () => {
  for (const [probability, expected] of [[0, "ended"], [0.2, "ended"], [0.21, "uncertain"], [0.79, "uncertain"], [0.8, "continue"], [1, "continue"]]) {
    const s = setup({ judge: async () => probability }); await on(s); await settle(s);
    assert.equal(s.controller.state.status, expected, String(probability));
  }
});

test("footer always shows the switch, not a verdict", async () => {
  const s = setup();
  s.handlers.session_start({}, s.ctx);
  assert.deepEqual(s.statuses.at(-1), ["auto-agent-loop", "auto-agent-loop: off"]);
  await on(s);
  assert.deepEqual(s.statuses.at(-1), ["auto-agent-loop", "auto-agent-loop: on"]);
  await settle(s); assert.equal(s.controller.state.status, "continue");
  assert.deepEqual(s.statuses.at(-1), ["auto-agent-loop", "auto-agent-loop: on"]);
  await s.commands["auto-agent-loop"].handler("status", s.ctx);
  assert.deepEqual(s.statuses.at(-1), ["auto-agent-loop", "auto-agent-loop: on"]);
  await s.commands["auto-agent-loop"].handler("off", s.ctx);
  assert.deepEqual(s.statuses.at(-1), ["auto-agent-loop", "auto-agent-loop: off"]);
});

test("the last verdict survives the turn in a widget, not only in a transient notice", async () => {
  const s = setup({ judge: async () => 0.11 }); await on(s);
  assert.deepEqual(s.widgets.at(-1), ["auto-agent-loop", undefined]);
  await settle(s);
  assert.deepEqual(s.widgets.at(-1), ["auto-agent-loop", ["auto-agent-loop: ended · Probability(continue)=0.11 ≤ 0.20 · loop 0/3"]]);
  input(s);
  assert.deepEqual(s.widgets.at(-1), ["auto-agent-loop", undefined]);
  const cont = setup(); await on(cont); await settle(cont);
  assert.match(cont.widgets.at(-1)[1][0], /continue · Probability\(continue\)=0\.95 ≥ 0\.80 · loop 1\/3/u);
  await cont.commands["auto-agent-loop"].handler("off", cont.ctx);
  assert.deepEqual(cont.widgets.at(-1), ["auto-agent-loop", undefined]);
  const ended = setup({ judge: async () => 0.11 }); await on(ended); await settle(ended);
  const restored = setup(); restored.setBranch(ended.entries); restored.handlers.session_start({}, restored.ctx);
  // A verdict describes the turn that produced it; after a restart that turn is gone.
  assert.equal(restored.controller.state.status, "ready");
  assert.deepEqual(restored.widgets.at(-1), ["auto-agent-loop", undefined]);
});

test("settings enable turns monitoring on at session start; default is off", async () => {
  const off = setup(); off.handlers.session_start({}, off.ctx);
  assert.equal(off.controller.state.enabled, false);
  assert.equal(off.controller.state.status, "off");
  const auto = setup({ config: { ...DEFAULT_CONFIG, enabled: true } });
  auto.handlers.session_start({}, auto.ctx);
  assert.equal(auto.controller.state.enabled, true);
  assert.equal(auto.controller.state.status, "ready");
  assert.equal((await settle(auto)).continue, true);
  await auto.commands["auto-agent-loop"].handler("off", auto.ctx);
  assert.equal(auto.controller.state.enabled, false);
  const broken = setup({ config: { ...DEFAULT_CONFIG, enabled: true }, getConfig: () => { throw new Error("bad config"); } });
  broken.handlers.session_start({}, broken.ctx);
  assert.equal(broken.controller.state.enabled, false);
  // A malformed config is reported, not swallowed: the footer stays off, the verdict says why.
  assert.equal(broken.controller.state.status, "error");
  assert.match(broken.controller.state.error, /bad config/u);
  assert.ok(broken.notices.some((notice) => /configuration error/u.test(notice)));
});

test("configurable fuse defaults to 3; only real non-command user input resets it", async () => {
  assert.equal(DEFAULT_CONFIG.maxContinuations, 3);
  const s = setup({ config: { ...DEFAULT_CONFIG, maxContinuations: 4 } }); await on(s);
  for (let i = 0; i < 4; i++) assert.equal((await settle(s)).continue, true);
  assert.equal(await settle(s), undefined);
  assert.equal(s.controller.state.status, "max_loop_limited");
  input(s, "extension"); input(s, "interactive", "/auto-agent-loop on");
  await on(s);
  assert.equal(s.controller.state.continuations, 4);
  assert.equal(await settle(s), undefined);
  await s.commands["auto-agent-loop"].handler("off", s.ctx); await on(s);
  assert.equal(s.controller.state.continuations, 4);
  input(s, "rpc");
  assert.equal(s.controller.state.continuations, 0);
  assert.equal((await settle(s)).continue, true);
});

test("on clears a previous verdict so ready is never shown next to a stale probability", async () => {
  const s = setup({ judge: async () => 0.18 });
  await on(s); await settle(s);
  assert.equal(s.controller.state.status, "ended");
  assert.equal(s.controller.state.probability, 0.18);
  await on(s);
  assert.equal(s.controller.state.status, "ready");
  assert.equal(s.controller.state.probability, undefined);
  assert.equal(s.controller.state.error, undefined);
  await s.commands["auto-agent-loop"].handler("status", s.ctx);
  assert.match(s.notices.at(-1), /auto-agent-loop: on · ready \(operational, not a verdict\) · loop 0\/3/u);
  assert.doesNotMatch(s.notices.at(-1), /Probability\(continue\)/u);
});

test("branch navigation cannot roll back or resurrect the current user request fuse", async () => {
  const s = setup(); await on(s);
  const earlyBranch = structuredClone(s.entries);
  for (let i = 0; i < 3; i++) assert.equal((await settle(s)).continue, true);
  const spentBranch = [{ type: "custom", customType: "auto-agent-loop-state", data: s.controller.state }];
  s.setBranch(earlyBranch); s.handlers.session_tree({}, s.ctx);
  assert.equal(s.controller.state.continuations, 3);
  assert.equal(await settle(s), undefined);
  assert.equal(s.controller.state.status, "max_loop_limited");
  input(s);
  s.setBranch(spentBranch); s.handlers.session_tree({}, s.ctx);
  assert.equal(s.controller.state.continuations, 0);
  assert.equal((await settle(s)).continue, true);
});

test("each settle independently sees changed user requirements, compaction/custom context and full tool output, not old summaries", async () => {
  const seen = [];
  const s = setup({ summarize: async (text) => { seen.push(text); return "unique-prior-summary-marker"; }, judge: async () => 0.1 });
  await on(s); await settle(s); input(s);
  const event = boundary(); event.context.contextMessages.unshift(
    { role: "compactionSummary", summary: "Earlier accepted goal: preserve compatibility" },
    { role: "custom", customType: "external-result", content: "Deployment blocked" },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(4000) + "TEST FAILED AT END" }] },
  );
  event.context.contextMessages.push({ role: "user", content: "Cancel the implementation; only discuss alternatives" }, boundary().context.contextMessages.at(-1));
  await settle(s, event);
  assert.match(seen[1], /preserve compatibility/);
  assert.match(seen[1], /Deployment blocked/);
  assert.match(seen[1], /TEST FAILED AT END/);
  assert.match(seen[1], /only discuss alternatives/);
  assert.doesNotMatch(seen[1], /unique-prior-summary-marker/);
  assert.doesNotMatch(serializeForSummary([{ role: "custom", customType: "auto-agent-loop-continuation", content: "stale injected summary" }]), /stale injected summary/);
});

test("abort, queued messages, existing continuation and unusable context fail closed", async () => {
  const contexts = [
    { ...boundary().context, pendingMessages: [{}] },
    { ...boundary().context, contextMessages: [{ role: "assistant", stopReason: "toolUse" }] },
  ];
  for (const event of [boundary({ outcome: "aborted" }), boundary({ continue: true }), ...contexts.map((context) => boundary({ context }))]) {
    const s = setup({ summarize: async () => assert.fail("must not verify") }); await on(s);
    assert.equal(await settle(s, event), undefined);
    assert.equal(s.controller.state.status, "paused");
  }
});

test("unknown or active subagents block verification; a valid fully settled RPC snapshot allows it", async () => {
  for (const mode of ["unknown", "active", "settled"]) {
    const s = setup(); s.pi.getAllTools = () => [{ name: "subagent" }];
    if (mode !== "unknown") {
      let handler;
      s.pi.events = { on: (_name, fn) => { handler = fn; return () => {}; }, emit: (_name, request) => handler({ ...request, success: true, data: {
        fleet: { totalActive: mode === "active" ? 1 : 0 },
        asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
      } }) };
    }
    await on(s); const result = await settle(s);
    assert.equal(result?.continue, mode === "settled" ? true : undefined);
  }
});

test("an unrecognized pi-subagents status contract pauses and warns once", async () => {
  const s = setup(); s.pi.getAllTools = () => [{ name: "subagent" }];
  let handler;
  s.pi.events = { on: (_name, fn) => { handler = fn; return () => {}; }, emit: (_name, request) => handler({ ...request, version: 2, success: true }) };
  await on(s);
  assert.equal(await settle(s), undefined);
  assert.equal(await settle(s), undefined);
  assert.equal(s.controller.state.status, "paused");
  assert.match(s.controller.state.error, /unrecognized/u);
  assert.equal(s.notices.filter((notice) => /pi-subagents status contract not recognized/u.test(notice)).length, 1);
});

test("off/on, new user input or branch change during verification suppress stale verdicts", async () => {
  for (const change of [async (s) => { await s.commands["auto-agent-loop"].handler("off", s.ctx); await on(s); }, async (s) => input(s), async (s) => s.handlers.session_tree({}, s.ctx)]) {
    let resolve;
    const s = setup({ judge: () => new Promise((done) => { resolve = done; }) }); await on(s);
    const work = settle(s);
    while (!resolve) await new Promise((done) => setImmediate(done));
    await change(s); resolve(0.99);
    assert.equal(await work, undefined);
    assert.equal(s.controller.state.continuations, 0);
  }
});

test("failures, invalid probabilities, malformed answers and verification timeout never continue", async () => {
  for (const options of [
    { summarize: async () => { throw Error("summary failed"); } },
    { summarize: async () => "" },
    { judge: async () => { throw Error("judge failed"); } },
    ...[NaN, -1, 1.1, {}, { stopReason: "error" }, { stopReason: "stop", answers: { should_continue: { type: "choice", probability: 1 } } }].map((value) => ({ judge: async () => value })),
    { summarize: () => new Promise(() => {}), timeoutMs: 5 },
  ]) {
    const s = setup(options); await on(s);
    assert.equal(await settle(s), undefined);
    assert.equal(s.controller.state.status, "error");
    assert.equal(s.controller.state.enabled, true);
  }
});

test("a verdict is printed once: the widget, never a duplicate notify line", async () => {
  const ended = setup({ judge: async () => 0.05 }); await on(ended); await settle(ended);
  assert.match(verdictOf(ended), /auto-agent-loop: ended/u);
  assert.ok(ended.notices.every((line) => !/Probability\(continue\)|auto-agent-loop: ended/u.test(line)), `duplicated verdict: ${ended.notices.join(" | ")}`);
  const cont = setup({ judge: async () => 0.95 }); await on(cont); await settle(cont);
  assert.match(verdictOf(cont), /auto-agent-loop: continue/u);
  assert.ok(cont.notices.every((line) => !/Probability\(continue\)|auto-agent-loop: continue/u.test(line)));
  // Headless runs have no widget, so the verdict must still reach the log.
  const logged = [];
  const original = console.error; console.error = (line) => logged.push(String(line));
  try {
    const headless = setup({ judge: async () => 0.05, summarize: async () => COMPLETE_SUMMARY });
    headless.ctx.hasUI = false;
    await on(headless); await settle(headless);
  } finally { console.error = original; }
  assert.ok(logged.some((line) => /auto-agent-loop: ended/u.test(line)));
});

test("the settling deadline comes from settings.json and names its configured budget", async () => {
  const never = () => new Promise(() => {});
  const s = setup({ summarize: never, getConfig: () => ({ ...DEFAULT_CONFIG, timeoutMs: 30 }) });
  await on(s); await settle(s);
  assert.equal(s.controller.state.error, "flash timed out after 0s");
  const configured = setup({ judge: never, getConfig: () => ({ ...DEFAULT_CONFIG, timeoutMs: 2_000 }) });
  await on(configured); await settle(configured);
  assert.equal(configured.controller.state.error, "jev timed out after 2s");
});

test("a timeout names the stage that ran out, in both the notice and the stored error", async () => {
  const flash = setup({ summarize: () => new Promise(() => {}), timeoutMs: 5 }); await on(flash); await settle(flash);
  assert.equal(flash.controller.state.error, "flash timed out after 0s");
  assert.match(verdictOf(flash), /error · flash timed out after 0s/u);
  const jev = setup({ judge: () => new Promise(() => {}), timeoutMs: 500 }); await on(jev); await settle(jev);
  assert.equal(jev.controller.state.error, "jev timed out after 1s");
  assert.match(verdictOf(jev), /error · jev timed out after 1s/u);
  assert.equal(pauseReason("flash timed out after 120s"), "flash timed out after 120s");
});

test("a settle decision reports the verdict only; the summary stays in status", async () => {
  const summary = "1. Goals:\n- ship it\n\n2. Completed:\n- wrote code\n\n3. Remaining necessary work and specific next actions:\n- run the regression suite\n- fix the failing case\n\n4. Authorization:\n- none needed\n\n5. Unknowns:\n- none";
  const s = setup({ summarize: async () => summary, judge: async () => 0.09 });
  await on(s); await settle(s);
  const ended = verdictOf(s);
  assert.match(ended, /auto-agent-loop: ended · Probability\(continue\)=0\.09 ≤ 0\.20 · loop 0\/3/u);
  assert.doesNotMatch(ended, /Remaining necessary work/u);
  assert.doesNotMatch(ended, /run the regression suite/u);
  await s.commands["auto-agent-loop"].handler("status", s.ctx);
  assert.match(s.notices.at(-1), /Agent State Summary:\n1\. Goals/u);
  assert.match(s.notices.at(-1), /5\. Unknowns/u);
  const cont = setup({ summarize: async () => summary, judge: async () => 0.95 });
  await on(cont); await settle(cont);
  assert.equal(cont.controller.state.status, "continue");
  assert.match(verdictOf(cont), /auto-agent-loop: continue · Probability\(continue\)=0\.95 ≥ 0\.80 · loop 1\/3/u);
  assert.doesNotMatch(verdictOf(cont), /run the regression suite/u);
});

test("verdict bands and pause reasons state the thresholds they compare against", () => {
  assert.equal(band(0.09), "0.09 ≤ 0.20");
  assert.equal(band(0.2), "0.20 ≤ 0.20");
  assert.equal(band(0.21), "0.20 < 0.21 < 0.80");
  assert.equal(band(0.8), "0.80 ≥ 0.80");
  assert.equal(pauseReason("Unsafe settle boundary: outcome=completed, continuation=false, queued=0, pending=false, aborted=false, supervisor=false, last=assistant/toolUse"), "still inside a tool call");
  assert.equal(pauseReason("Unsafe settle boundary: outcome=completed, continuation=false, queued=0, pending=false, aborted=true, supervisor=false, last=assistant/stop"), "run was aborted");
  assert.equal(pauseReason("Subagent check blocked continuation: subagents still active"), "subagents still running");
  assert.equal(pauseReason("Subagent check blocked continuation: status RPC reply unrecognized"), "pi-subagents contract not recognized");
  assert.equal(pauseReason(""), "reason unknown");
});

test("status exposes models, count, decision and latest summary; only new session state restores", async () => {
  const s = setup(); await on(s); await settle(s);
  await s.commands["auto-agent-loop"].handler("status", s.ctx);
  assert.match(s.notices.at(-1), /deepseek/); assert.match(s.notices.at(-1), /jev/); assert.match(s.notices.at(-1), /run tests/);
  const restored = setup(); restored.setBranch(s.entries); restored.handlers.session_start({}, restored.ctx);
  assert.equal(restored.controller.state.enabled, true);
});

test("configuration lives in settings.json under auto-agent-loop and rejects bad values instead of silently replacing them", () => {
  for (const config of [null, { ...DEFAULT_CONFIG, maxContinuations: -1 }, { ...DEFAULT_CONFIG, maxContinuations: 1.5 }, { ...DEFAULT_CONFIG, timeoutMs: 0 }, { ...DEFAULT_CONFIG, timeoutMs: -1 }, { ...DEFAULT_CONFIG, timeoutMs: 1.5 }, { ...DEFAULT_CONFIG, timeoutMs: "300000" }, { ...DEFAULT_CONFIG, flash: { provider: "", model: "x" } }, { ...DEFAULT_CONFIG, jev: { provider: "x" } }]) {
    assert.throws(() => validateConfig(config));
  }
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, maxContinuations: 8 }).maxContinuations, 8);
  assert.equal(DEFAULT_CONFIG.timeoutMs, 300_000);
  assert.deepEqual(configFromSettings({}), DEFAULT_CONFIG);
  assert.deepEqual(configFromSettings({ "auto-agent-loop": { "flash-model": "custom/flash", "jev-model": "custom/jev", "max-loop": 6 } }),
    { flash: { provider: "custom", model: "flash" }, jev: { provider: "custom", model: "jev" }, maxContinuations: 6, timeoutMs: 300_000, flashThinking: "high", enabled: false });
  assert.equal(configFromSettings({ "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j", "timeout-ms": 600_000 } }).timeoutMs, 600_000);
  // Flash thinking is configurable because it shares the 20k output cap with the summary
  // itself; the default is the level the summary was expected to run at all along.
  assert.equal(DEFAULT_CONFIG.flashThinking, "high");
  assert.equal(configFromSettings({ "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j" } }).flashThinking, "high");
  assert.equal(configFromSettings({ "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j", "flash-thinking": "medium" } }).flashThinking, "medium");
  for (const bad of ["high1", "HIGH", "", null, 1, true]) {
    assert.throws(() => configFromSettings({ "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j", "flash-thinking": bad } }));
  }
  for (const bad of [0, -1, 1.5, "300000", null]) {
    assert.throws(() => configFromSettings({ "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j", "timeout-ms": bad } }));
  }
  assert.equal(configFromSettings({ "auto-agent-loop": { "flash-model": "custom/flash", "jev-model": "custom/jev" } }).maxContinuations, 3);
  assert.equal(configFromSettings({ "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j", enable: true } }).enabled, true);
  for (const bad of [{ "flash-model": "no-slash" }, { "flash-model": "/flash" }, { "jev-model": "custom/" }, { "flash-model": "" }, [], { "flash-model": "c/f", "jev-model": "c/j", "max-loop": -2 }, { "flash-model": "c/f", "jev-model": "c/j", enable: "yes" }, { "flash-model": "c/f", "jev-model": "c/j", enable: null }]) {
    assert.throws(() => configFromSettings({ "auto-agent-loop": bad }));
  }
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-loop-config-"));
  try {
    const path = join(dir, "settings.json");
    assert.deepEqual(readConfig(path), DEFAULT_CONFIG);
    writeFileSync(path, "not JSON"); assert.throws(() => readConfig(path));
    writeFileSync(path, JSON.stringify({ theme: "dark", "auto-agent-loop": { "flash-model": "c/f", "jev-model": "c/j", "max-loop": 6 } }));
    assert.equal(readConfig(path).maxContinuations, 6);
    assert.equal(readConfig(path).flash.model, "f");
  } finally { rmSync(dir, { recursive: true }); }
});

test("Flash uses exact configured model and rejects overflow, truncated output, and output of 20k tokens", async () => {
  const calls = [];
  const model = { provider: "custom", id: "flash", contextWindow: 100000, maxTokens: 24000 };
  const ctx = { modelRegistry: { find: () => model, streamSimple: (...args) => ({ result: async () => { calls.push(args); return { stopReason: "stop", content: [{ type: "text", text: COMPLETE_SUMMARY }], usage: { output: 12 } }; } }) } };
  const config = { ...DEFAULT_CONFIG, flash: { provider: "custom", model: "flash" } };
  assert.equal(await defaultSummarize("Transcript", ctx, undefined, config), COMPLETE_SUMMARY);
  assert.equal(calls[0][0], model); assert.equal(calls[0][2].maxTokens, 20000);
  // The per-request cap outlives the settling deadline, otherwise the provider aborts first
  // and the notice loses its stage and budget.
  assert.equal(calls[0][2].timeoutMs, DEFAULT_CONFIG.timeoutMs + 15_000);
  // The Flash path has no stream fixture here, so pin the option that sends it to the same
  // pi-ai retry policy the Jev call is proven to use below.
  assert.equal(calls[0][2].maxRetries, 2);
  // `complete()` forwards options to the provider's raw stream, which only understands
  // provider-native knobs; `streamSimple` is the provider-neutral path that turns `reasoning`
  // into what the provider needs. Without it a deepseek-style gateway is sent
  // `thinking: {type:"disabled"}` on every round even when the user's thinking level is high.
  assert.equal(calls[0][2].reasoning, "high");
  assert.equal((await defaultSummarize("T", ctx, undefined, { ...config, flashThinking: "medium" })) && calls[1][2].reasoning, "medium");
  assert.equal((await defaultSummarize("T", ctx, undefined, { ...config, flashThinking: "off" })) && calls[2][2].reasoning, undefined);
  assert.equal((await defaultSummarize("T", ctx, undefined, { ...config, timeoutMs: 600_000 })) && calls[3][2].timeoutMs, 615_000);
  // Admission compares pi's reported context count against the Flash window.
  ctx.getContextUsage = () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await assert.rejects(defaultSummarize("x", ctx, undefined, config), /Flash context capacity.*80000.*90000/u);
  ctx.getContextUsage = () => ({ tokens: null, contextWindow: 100_000, percent: null });
  assert.equal(await defaultSummarize("x", ctx, undefined, config), COMPLETE_SUMMARY);
  delete ctx.getContextUsage;
  ctx.modelRegistry.find = () => undefined;
  await assert.rejects(defaultSummarize("x", ctx, undefined, config), /model/i);
  ctx.modelRegistry.find = () => ({ ...model, contextWindow: 20 });
  await assert.rejects(defaultSummarize("x".repeat(100), ctx, undefined, config), /limit|capacity|budget/i);
  ctx.modelRegistry.find = () => model;
  for (const response of [{ stopReason: "length" }, { stopReason: "stop", content: [{ type: "text", text: "x" }], usage: { output: 20001 } }]) {
    ctx.modelRegistry.streamSimple = () => ({ result: async () => response });
    await assert.rejects(defaultSummarize("x", ctx, undefined, config));
  }
});

test("a summary that stops mid-output or omits sections 3-5 pauses instead of reaching Jev", async () => {
  // The exact shape observed in a real session: a clean stopReason, two sections, cut mid-word.
  const truncated = "# Current Agent State Summary\n\n## 1. Goals\n- judge whether the prompt is still necessary\n\n## 2. Completed work and concrete evidence\n- the historical failures recorded at `~/.pi/agent/pi-hermes-memory/fail";
  assert.throws(() => assertCompleteSummary(truncated), /incomplete: missing end marker, section 3/u);
  assert.throws(() => assertCompleteSummary(COMPLETE_SUMMARY.replace("## 5. Unknowns", "## 6. Unknowns")), /section 5/u);
  assert.throws(() => assertCompleteSummary(COMPLETE_SUMMARY.replace(`\n${SUMMARY_END_MARKER}`, "")), /end marker/u);
  assert.equal(assertCompleteSummary(COMPLETE_SUMMARY), COMPLETE_SUMMARY);
  // Section numbers are accepted as the prompt asks for them, with or without heading marks.
  assert.equal(assertCompleteSummary("1. a\n2. b\n3. c\n4. d\n5. e\n" + SUMMARY_END_MARKER), "1. a\n2. b\n3. c\n4. d\n5. e\n" + SUMMARY_END_MARKER);
  const model = { provider: "custom", id: "flash", contextWindow: 100000, maxTokens: 24000 };
  const flash = { modelRegistry: { find: () => model, streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: truncated }], usage: { output: 90 } }) }) } };
  await assert.rejects(defaultSummarize("Transcript", flash, undefined, { ...DEFAULT_CONFIG, flash: { provider: "custom", model: "flash" } }), IncompleteSummaryError);

  let judged = 0;
  const s = setup({ summarize: async () => { throw new IncompleteSummaryError("Flash summary incomplete: missing section 3"); }, judge: async () => { judged++; return 0.9; } });
  await on(s);
  assert.equal(await settle(s), undefined);
  assert.equal(s.controller.state.status, "paused");
  assert.equal(judged, 0);
  assert.match(verdictOf(s), /paused · the Flash summary was incomplete/u);
});

test("Jev asks about authorized autonomous work, uses configured route/id, and rejects a provider-reported oversize input", async () => {
  const calls = [];
  const ctx = { modelRegistry: {
    findOfType: () => undefined,
    getAll: () => [{ provider: "trendmicro", baseUrl: "https://example.invalid/api" }],
    getApiKeyForProvider: async () => "test-key",
  } };
  const load = async () => ({ typesafeSystemOneApi: () => ({ classify: async (...args) => { calls.push(args); return { stopReason: "stop", answers: { should_continue: { type: "bool", probability: 0.9 } } }; } }) });
  await defaultJudge("Remaining authorized work: run tests", ctx, undefined, DEFAULT_CONFIG, load);
  assert.equal(calls[0][0].id, DEFAULT_CONFIG.jev.model);
  assert.match(calls[0][1].questions.should_continue.instructions, /authorized/i);
  assert.equal(calls[0][1].state.current_agent_state_summary, "Remaining authorized work: run tests");
  // The summary Flash produced is capped at 20k tokens by its own reported output, so
  // Jev's input needs no estimate of its own; the provider's count is the check.
  const registered = { type: "classifier", provider: "other", id: "custom-jev", contextWindow: 30000 };
  ctx.modelRegistry.findOfType = (type, provider, id) => provider === "other" && id === "custom-jev" ? registered : undefined;
  ctx.modelRegistry.classify = async (model, request) => {
    assert.equal(model, registered); assert.ok(request.questions.should_continue);
    return { stopReason: "stop", usage: { input: 30001 } };
  };
  await assert.rejects(defaultJudge("small", ctx, undefined, { ...DEFAULT_CONFIG, jev: { provider: "other", model: "custom-jev" } }, load), /over token limit/);
  await assert.rejects(defaultJudge("small", ctx, undefined, { ...DEFAULT_CONFIG, jev: { provider: "missing", model: "missing" } }, load), /model unavailable/);
});

// The session that reported "auto-agent-loop: error · System One API error (504)" got that text
// from a gateway HTML page, not from Jev. Both stage calls now ride pi-ai's own retry policy, so
// this drives the real transport with a scripted fetch: a transient 504 recovers, an exhausted
// retry still reports the provider error, and a permanent 4xx is never re-asked.
test("a transient 504 on the Jev call is retried; exhausted retries and permanent 4xx still fail", async () => {
  // Machine-local pnpm store, resolved at run time like agent-goal-state.test.mjs does: the
  // retry under test must be the one that ships, not a copy of it in this file.
  const resolveDep = (prefix, inner) => {
    const storeRoot = join(process.env.HOME ?? "", "Library", "pnpm", "global", "v11");
    let entries = []; try { entries = readdirSync(storeRoot); } catch {}
    for (const entry of entries) {
      const store = join(storeRoot, entry, "node_modules", ".pnpm");
      let names = []; try { names = readdirSync(store); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const candidate = join(store, name, "node_modules", inner);
        if (existsSync(candidate)) return candidate;
      }
    }
    throw new Error(`Cannot locate ${prefix} in the local pnpm store`);
  };
  const api = await import(pathToFileURL(join(resolveDep("@earendil-works+pi-ai@", join("@earendil-works", "pi-ai")), "dist", "api", "typesafe-system-one.lazy.js")).href);
  const ctx = { modelRegistry: {
    findOfType: () => undefined,
    getAll: () => [{ provider: "trendmicro", baseUrl: "https://example.invalid/api" }],
    getApiKeyForProvider: async () => "test-key",
  } };
  const load = async () => api;
  // The exact body shape the session stored.
  const gateway = () => new Response("<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n</html>", { status: 504 });
  const answer = () => new Response(JSON.stringify({ answers: { should_continue: { type: "noul", noul: 0.9 } } }), { status: 200, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  // The last response repeats once the script runs out, so a single entry means "always".
  const script = (responses) => {
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return (responses[calls.length - 1] ?? responses.at(-1))(); };
    return calls;
  };
  try {
    let calls = script([gateway, gateway, answer]);
    const result = await defaultJudge("Remaining authorized work: run tests", ctx, undefined, DEFAULT_CONFIG, load);
    assert.equal(result.answers.should_continue.probability, 0.9);
    assert.equal(calls.length, 3);
    assert.equal(calls[0], "https://example.invalid/api/systemone");

    calls = script([gateway]);
    const exhausted = await defaultJudge("x", ctx, undefined, DEFAULT_CONFIG, load);
    assert.equal(exhausted.stopReason, "error");
    assert.match(exhausted.errorMessage, /System One API error \(504\)/u);
    assert.equal(calls.length, 3);

    calls = script([() => new Response("bad request", { status: 400 })]);
    const permanent = await defaultJudge("x", ctx, undefined, DEFAULT_CONFIG, load);
    assert.equal(permanent.stopReason, "error");
    assert.match(permanent.errorMessage, /System One API error \(400\)/u);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = realFetch; }
});
