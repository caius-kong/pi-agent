// The loop must not run inside a pi-subagents child session. It has no business
// evaluating settle boundaries for work that is waiting on its parent.
import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const fakePi = {
  on: (...a) => calls.push(["on", a[0]]),
  registerCommand: (...a) => calls.push(["registerCommand", a[0]]),
  appendEntry: () => {},
  getAllTools: () => [],
  events: { on: () => {}, emit: () => {} },
};

test("does not register anything inside a subagent child session", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  const { registerAgentLoop } = await import(`../agent/extensions/auto-agent-loop/controller.mjs?child=${Date.now()}`);
  const handle = registerAgentLoop(fakePi, { getConfig: () => ({ enabled: true, maxContinuations: 3 }) });
  assert.deepEqual(calls, []);
  assert.equal(handle.state.enabled, false);
});

test("registers normally in a top-level session", async () => {
  delete process.env.PI_SUBAGENT_CHILD;
  calls.length = 0;
  const { registerAgentLoop } = await import(`../agent/extensions/auto-agent-loop/controller.mjs?top=${Date.now()}`);
  registerAgentLoop(fakePi, { getConfig: () => ({ enabled: false, maxContinuations: 3 }) });
  assert.ok(calls.some(([k, name]) => k === "on" && name === "agent_before_settle"));
  assert.ok(calls.some(([k, name]) => k === "registerCommand" && name === "auto-agent-loop"));
});

const root = join(tmpdir(), `pi-subagents-uid-${process.getuid?.() ?? ""}`, "supervisor-channels");
function channel(name, { request, reply }) {
  const dir = join(root, name);
  mkdirSync(join(dir, "requests"), { recursive: true });
  mkdirSync(join(dir, "replies"), { recursive: true });
  if (request) writeFileSync(join(dir, "requests", `${request}.json`), "{}");
  if (reply) writeFileSync(join(dir, "replies", `${reply}.json`), "{}");
  return dir;
}

test("a pending supervisor request pauses the session (honest waiting)", async () => {
  delete process.env.PI_SUBAGENT_CHILD;
  const { registerAgentLoop } = await import(`../agent/extensions/auto-agent-loop/controller.mjs?pending=${Date.now()}`);
  const handlers = {};
  const persisted = [];
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: () => {}, appendEntry: (_type, data) => persisted.push(data),
    getAllTools: () => [], events: { on: () => {}, emit: () => {} },
  };
  registerAgentLoop(pi, { getConfig: () => ({ enabled: true, maxContinuations: 3, timeoutMs: 1000 }) });
  const ctx = {
    hasUI: false, sessionManager: { getBranch: () => [] }, hasPendingMessages: () => false,
    signal: undefined,
  };
  const liveDir = channel("test-pending-plan-0", { request: "r1" });   // a real, still-answerable request
  try {
  handlers["session_start"]?.({}, ctx);   // enabled flips here, not in the constructor
  const event = {
    outcome: "completed", continue: false, entries: [],
    context: { pendingMessages: [], contextMessages: [
      { role: "custom", customType: "subagent_supervisor_request", details: { requestId: "r1", expectsReply: true } },
      { role: "assistant", stopReason: "stop" },
    ] },
  };
  const result = await handlers["agent_before_settle"](event, ctx);
  // Paused, not continued: the reply that arrives later still triggers a turn,
  // which was measured on a live session rather than assumed.
  assert.equal(result, undefined);
  assert.equal(persisted.at(-1)?.status, "paused");
  } finally { rmSync(liveDir, { recursive: true, force: true }); }
});

// The pause that actually bothers the user: a request nobody will ever answer
// stays in the session's branch forever and every settle boundary reads it as
// "the human still owes a decision".
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, SUMMARY_END_MARKER, defaultSummarize, serializeForSummary } from "../agent/extensions/auto-agent-loop/controller.mjs";

test("a request whose channel is gone no longer counts as pending", async () => {
  const { pendingForTest } = await import(`../agent/extensions/auto-agent-loop/controller.mjs?stale=${Date.now()}`);
  assert.equal(pendingForTest("does-not-exist-anywhere"), false);
});

test("a live request still counts as pending, and a replied one does not", async () => {
  const { pendingForTest } = await import(`../agent/extensions/auto-agent-loop/controller.mjs?live=${Date.now()}`);
  const dir = channel("test-live-plan-0", { request: "live-1", reply: "done-1" });
  try {
    assert.equal(pendingForTest("live-1"), true);
    assert.equal(pendingForTest("done-1"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a verdict does not survive a restart", async () => {
  delete process.env.PI_SUBAGENT_CHILD;
  const { registerAgentLoop } = await import(`../agent/extensions/auto-agent-loop/controller.mjs?reload=${Date.now()}`);
  const handlers = {}; const persisted = [];
  const pi = {
    on: (name, fn) => { handlers[name] = fn; }, registerCommand: () => {},
    appendEntry: (_t, d) => persisted.push(d), getAllTools: () => [], events: { on: () => {}, emit: () => {} },
  };
  registerAgentLoop(pi, { getConfig: () => ({ enabled: true, maxContinuations: 3 }) });
  const branch = [{ type: "custom", customType: "auto-agent-loop-state", data: { enabled: true, status: "paused", continuations: 1, error: "stale" } }];
  const ctx = { hasUI: false, sessionManager: { getBranch: () => branch }, hasPendingMessages: () => false };
  handlers["session_start"]({}, ctx);
  // Restored enabled + fuse, but the stale verdict is gone.
  assert.equal(persisted.at(-1)?.status ?? "ready", "ready");
  assert.notEqual(persisted.at(-1)?.status, "paused");
});

// A live session showed "Flash context capacity exceeds conservative input token
// budget (1028576)" while the same session read 37%/1.0M in the status bar. The budget
// is a token count, and pi reports the provider's own count for the context it just
// sent - the number the status bar renders. Admission reads that count; nothing here
// estimates tokens from bytes or characters any more.
const FLASH = { provider: "trendmicro", id: "flash", contextWindow: 1_048_576, maxTokens: 20_000 };
const FLASH_LIMIT = FLASH.contextWindow - 20_000;   // 1,028,576, as printed in the error
const FLASH_CONFIG = { ...DEFAULT_CONFIG, flash: { provider: "trendmicro", model: "flash" } };
const COMPLETE_SUMMARY = `## 1. Goals\n- ship it\n\n## 2. Completed\n- wrote the code\n\n## 3. Remaining necessary work\n- run the regression suite\n\n## 4. Authorization and boundaries\n- no approval pending\n\n## 5. Unknowns\n- none\n\n${SUMMARY_END_MARKER}`;
const CJK = (repeats) => serializeForSummary([{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "中文会话记录，".repeat(repeats) }] }]);

// `tokens` is what ctx.getContextUsage() reports: the provider's count for the context
// just sent, the same number the status bar renders.
function flashCtx({ tokens } = {}) {
  return {
    getContextUsage: () => ({ tokens, contextWindow: FLASH.contextWindow, percent: tokens == null ? null : (tokens / FLASH.contextWindow) * 100 }),
    modelRegistry: { find: () => FLASH, complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: COMPLETE_SUMMARY }], usage: { output: 100 } }) },
  };
}

const overBudget = new RegExp(`Flash context capacity exceeds input token budget \\(${FLASH_LIMIT}; pi reports 1040000 tokens\\)`, "u");

test("a session at 37% of the Flash window is summarized, whatever its transcript weighs", async () => {
  // The reported shape: 37% of a 1M window, all CJK, so the same text is far over the
  // budget when it is counted as bytes.
  const transcript = CJK(50_000);
  assert.ok(Buffer.byteLength(transcript, "utf8") > FLASH_LIMIT, "precondition: the transcript exceeds the budget in bytes");
  assert.equal(await defaultSummarize(transcript, flashCtx({ tokens: 388_000 }), undefined, FLASH_CONFIG), COMPLETE_SUMMARY);
});

test("a reported count over the Flash window is rejected and the notice shows it", async () => {
  await assert.rejects(defaultSummarize("Transcript", flashCtx({ tokens: 1_040_000 }), undefined, FLASH_CONFIG), overBudget);
});

test("an unknown reported count leaves the request to the provider", async () => {
  // pi returns tokens: null between a compaction and the next response; there is no
  // number to compare then, and refusing to summarize would stall the loop after
  // every compaction.
  assert.equal(await defaultSummarize(CJK(50_000), flashCtx({ tokens: null }), undefined, FLASH_CONFIG), COMPLETE_SUMMARY);
});
