import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_COMPACT_CONTINUE, DEFAULT_THRESHOLD_PERCENT, THRESHOLD_PERCENT, createAutoCompactController, registerAutoCompact } from "../agent/extensions/auto-compact/controller.mjs";

const AT_BOUNDARY = THRESHOLD_PERCENT;
const BELOW = THRESHOLD_PERCENT - 0.1;
const ABOVE = THRESHOLD_PERCENT + 1.25;

// trendmicro/gpt-6.1-sol: 1,050,000-token window, every rate doubles above 272k input tokens.
const TIERED_MODEL = {
  provider: "test",
  id: "gpt-6.1-sol",
  api: "test",
  contextWindow: 1_050_000,
  cost: {
    input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  },
};
const TIER_PERCENT = ((272_000 - 16_384) / 1_050_000) * 100;

function context({ percent = 50, mode = "tui", idle = true, pending = false, model = { provider: "test", id: "test", api: "test" }, contextWindow = 1000 } = {}) {
  return {
    mode,
    hasUI: mode === "tui",
    getContextUsage: () => percent == null ? undefined : { percent, tokens: 100, contextWindow },
    sessionManager: { getBranch: () => [], getSessionId: () => "test-session" },
    model,
    thinkingLevel: "off",
    modelRegistry: { streamSimple: () => { throw new Error("not expected"); } },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    compact: () => {},
    ui: { notify: () => {} },
  };
}

function fakePi(settings = { compaction: { enabled: true }, retry: { enabled: false } }) {
  const handlers = {};
  const commands = {};
  const tools = [];
  const messages = [];
  const eventListeners = new Map();
  return {
    handlers,
    commands,
    tools,
    messages,
    events: {
      on: (channel, handler) => {
        const listeners = eventListeners.get(channel) ?? new Set();
        listeners.add(handler);
        eventListeners.set(channel, listeners);
        return () => listeners.delete(handler);
      },
      emit: (channel, payload) => {
        for (const handler of eventListeners.get(channel) ?? []) handler(payload);
      },
    },
    getAllTools: () => tools.map(({ name }) => ({ name })),
    getSettings: () => settings,
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => { commands[name] = command; },
    on: (name, handler) => { handlers[name] = handler; },
    sendUserMessage: (text) => messages.push({ text }),
    sendMessage: (message, options) => messages.push({ custom: message, options }),
  };
}

function register(options, settings) {
  const pi = fakePi(settings);
  registerAutoCompact(pi, options);
  return { pi };
}

function makeSettledSubagentReply(request) {
  return {
    version: 1,
    requestId: request.requestId,
    method: "status",
    success: true,
    data: {
      fleet: { totalActive: 0 },
      asyncSnapshot: {
        kind: "pi-subagents.async-status-snapshot",
        version: 1,
        runs: [],
        omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      },
    },
  };
}

test("continues without compaction when the optional subagent status service is absent", async () => {
  const pi = fakePi();
  pi.getAllTools = () => [{ name: "subagent" }];
  registerAutoCompact(pi, { subagentStatusTimeoutMs: 5 });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } }, ctx);
  assert.equal(result?.continue, true);
  assert.ok(result.entries.every(entry => entry.type !== "compaction"));
  assert.match(result.entries[0].content, /not compacted/i);
  assert.equal((await pi.tools[0].execute("retry", {}, undefined, undefined, ctx)).terminate, true);
});

test("allows retry after subagent checks reject with unknown token usage", async () => {
  const pi = fakePi();
  pi.getAllTools = () => [{ name: "subagent" }];
  registerAutoCompact(pi, { subagentStatusTimeoutMs: 5 });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  ctx.getContextUsage = () => ({ percent: 50 });
  const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } }, ctx);
  assert.equal(result?.continue, true);
  ctx.getContextUsage = () => ({ percent: 50, tokens: 100, contextWindow: 1000 });
  assert.equal((await pi.tools[0].execute("retry", {}, undefined, undefined, ctx)).terminate, true);
});

test("restarts hint eligibility when a new agent run resets the turn index", () => {
  const controller = createAutoCompactController();
  const ctx = context();

  controller.onTurnStart(5);
  assert.ok(controller.ask(ctx));
  controller.onAgentStart();
  controller.onTurnStart(0);
  assert.ok(controller.ask(ctx));
});

test("allows a new checkpoint request on the next turn without token growth", () => {
  const controller = createAutoCompactController();
  const ctx = context();

  controller.onTurnStart(0);
  assert.ok(controller.ask(ctx));
  assert.equal(controller.request(ctx), "queued");
  controller.consumeRequest();

  controller.onTurnStart(1);
  assert.ok(controller.ask(ctx));
  assert.equal(controller.request(ctx), "queued");
});

test("treats supervisor requests without IDs as pending", async () => {
  const { pi } = register({ loadCompactionModule: async () => { assert.fail("must not generate a summary"); } });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
    { role: "custom", customType: "subagent_supervisor_request", details: { expectsReply: true } },
  ] } };
  assert.equal(await pi.handlers.agent_before_settle(event, ctx), undefined);
});

test("does not commit a compaction if auto-compact is turned off during summary generation", async () => {
  const pi = fakePi();
  const ctx = context();
  pi.getAllTools = () => [{ name: "subagent" }];
  pi.events.on("subagents:rpc:v1:request", request => {
    pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, makeSettledSubagentReply(request));
  });
  registerAutoCompact(pi, { loadCompactionModule: async () => ({
    prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
    compact: async () => {
      await pi.commands.auto_compact.handler("off", ctx);
      return { summary: "summary", firstKeptEntryId: "kept" };
    },
  }) });
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } }, ctx);
  assert.equal(result.entries.some(entry => entry.type === "compaction"), false);
});

test("does not commit a compaction if a supervisor decision arrives during summary generation", async () => {
  const pi = fakePi();
  const ctx = context();
  ctx.sessionManager.getBranch = () => [];
  registerAutoCompact(pi, { loadCompactionModule: async () => ({
    prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
    compact: async () => {
      event.context.contextMessages.push({
        role: "custom", customType: "subagent_supervisor_request",
        details: { expectsReply: true, requestId: "pending" },
      });
      return { summary: "summary", firstKeptEntryId: "kept" };
    },
  }) });
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } };
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const result = await pi.handlers.agent_before_settle(event, ctx);
  assert.equal(result?.continue, undefined);
  assert.ok(event.context.contextMessages.some(message => message.details?.requestId === "pending"));
});

test("reports print-mode success only after the compaction draft was committed", async () => {
  const pi = fakePi();
  registerAutoCompact(pi, { loadCompactionModule: async () => ({
    prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
    compact: async () => ({ summary: "summary", firstKeptEntryId: "kept" }),
  }) });
  const ctx = context({ mode: "print" });
  const notices = [];
  const originalError = console.error;
  console.error = message => notices.push(message);
  try {
    await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
    const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
      { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
    ] } }, ctx);
    assert.deepEqual(notices, []);
    ctx.sessionManager.getBranch = () => result.entries;
    pi.handlers.context({ messages: [] }, ctx);
    pi.handlers.agent_settled({}, ctx);
    assert.deepEqual(notices, ["[auto-compact] Automatic compaction completed and is active in the session context."]);
    assert.equal((await pi.tools[0].execute("retry", {}, undefined, undefined, ctx)).terminate, true);
  } finally {
    console.error = originalError;
  }
});

test("queued requests do not compact or force continuation on abort, new messages, or pending decisions", async () => {
  for (const reason of ["aborted", "signal", "queued", "supervisor"]) {
    const { pi } = register({ loadCompactionModule: async () => { assert.fail("must not generate a summary"); } });
    const ctx = context();
    await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
    const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [] } };
    if (reason === "aborted") event.outcome = "aborted";
    if (reason === "signal") ctx.signal = AbortSignal.abort();
    if (reason === "queued") event.context.pendingMessages.push({ role: "user" });
    if (reason === "supervisor") event.context.contextMessages.push({ role: "custom", customType: "subagent_supervisor_request", details: { expectsReply: true, requestId: "pending" } });
    assert.equal(await pi.handlers.agent_before_settle(event, ctx), undefined);
  }
});

test("drops a summary if a new message arrives during generation", async () => {
  const pi = fakePi();
  const ctx = context();
  registerAutoCompact(pi, { loadCompactionModule: async () => ({
    prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
    compact: async () => {
      ctx.hasPendingMessages = () => true;
      return { summary: "summary", firstKeptEntryId: "kept" };
    },
  }) });
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  assert.equal(await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [] } }, ctx), undefined);
});

test("a broken optional subagent event bus cannot fail the agent", async () => {
  const pi = fakePi();
  pi.getAllTools = () => [{ name: "subagent" }];
  pi.events.on = () => { throw new Error("service absent"); };
  registerAutoCompact(pi);
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } }, ctx);
  assert.equal(result.continue, true);
  assert.ok(result.entries.every(entry => entry.type !== "compaction"));
});

test("configures a session-local threshold and disables only auto-compact with off", async () => {
  const { pi } = register();
  const ctx = context();
  const notifications = [];
  ctx.ui.notify = (message, type) => notifications.push({ message, type });
  const command = pi.commands.auto_compact;
  assert.equal(typeof command.handler, "function");
  assert.deepEqual(createAutoCompactController().getConfiguration(), { enabled: true, thresholdPercent: 40, costTiersOverride: true });

  await command.handler("5", ctx);
  assert.equal(notifications.at(-1).message, "Auto-compact threshold set to 5%");
  pi.handlers.turn_start({ turnIndex: 0 });
  const enabled = { messages: [] };
  pi.handlers.context(enabled, ctx);
  assert.equal(enabled.messages.length, 1);

  await command.handler("off", ctx);
  assert.equal(notifications.at(-1).message, "Auto-compact: off");
  pi.handlers.turn_start({ turnIndex: 1 });
  const disabled = { messages: [] };
  pi.handlers.context(disabled, ctx);
  assert.equal(disabled.messages.length, 0);
  assert.equal((await pi.tools[0].execute("off", {}, undefined, undefined, ctx)).details.queued, false);

  await command.handler("7.5", ctx);
  assert.equal(notifications.at(-1).message, "Auto-compact threshold set to 7.5%");
  ctx.getContextUsage = () => ({ percent: 7.5, tokens: 75, contextWindow: 1000 });
  pi.handlers.turn_start({ turnIndex: 2 });
  const atThreshold = { messages: [] };
  pi.handlers.context(atThreshold, ctx);
  assert.equal(atThreshold.messages.length, 0);
  ctx.getContextUsage = () => ({ percent: 7.6, tokens: 76, contextWindow: 1000 });
  pi.handlers.turn_start({ turnIndex: 3 });
  const aboveThreshold = { messages: [] };
  pi.handlers.context(aboveThreshold, ctx);
  assert.equal(aboveThreshold.messages.length, 1);

  await command.handler("200", ctx);
  assert.equal(notifications.at(-1).type, "warning");
  await command.handler("", ctx);
  assert.match(notifications.at(-1).message, /7.5%/);
  assert.equal(DEFAULT_THRESHOLD_PERCENT, 40);
});

test("registers the model tool and loop handlers", () => {
  const { pi } = register();
  assert.equal(pi.tools[0].name, "request_compaction");
  for (const event of ["turn_start", "context", "agent_before_settle", "agent_settled"]) {
    assert.equal(typeof pi.handlers[event], "function", `missing ${event} handler`);
  }
});

test("injects no hint at or below the default threshold", () => {
  const { pi } = register();
  const at = (turnIndex, percent) => {
    pi.handlers.turn_start({ turnIndex });
    const event = { messages: [] };
    pi.handlers.context(event, context({ percent }));
    return event.messages;
  };

  assert.equal(at(0, AT_BOUNDARY).length, 0);
  assert.equal(at(1, BELOW).length, 0);
  assert.equal(at(2, null).length, 0);
});

test("injects one transient hint above the threshold on every turn", () => {
  const { pi } = register();
  const at = (turnIndex, percent) => {
    pi.handlers.turn_start({ turnIndex });
    const event = { messages: [] };
    pi.handlers.context(event, context({ percent }));
    return event.messages;
  };

  const first = at(0, ABOVE);
  assert.equal(first.length, 1);
  assert.ok(first[0].content[0].text.includes(`${ABOVE.toFixed(1)}%`));
  assert.equal(first[0].role, "user");

  assert.equal(at(1, ABOVE + 5).length, 1);
  assert.equal(at(2, ABOVE + 5).length, 1);
});

function hintAt(pi, ctx, turnIndex) {
  pi.handlers.turn_start({ turnIndex });
  const event = { messages: [] };
  pi.handlers.context(event, ctx);
  return event.messages;
}

const tiered = (percent) => context({ percent, model: TIERED_MODEL, contextWindow: TIERED_MODEL.contextWindow });

test("caps the threshold at the model's cost tier boundary", () => {
  const { pi } = register();
  assert.equal(hintAt(pi, tiered(TIER_PERCENT - 0.1), 0).length, 0);
  assert.equal(hintAt(pi, tiered(TIER_PERCENT), 1).length, 0);
  const hint = hintAt(pi, tiered(TIER_PERCENT + 0.1), 2);
  assert.equal(hint.length, 1);
  assert.ok(hint[0].content[0].text.includes(`${(TIER_PERCENT + 0.1).toFixed(1)}%`));
});

test("leaves the threshold alone when the cost tier sits at or beyond the window", () => {
  const { pi } = register();
  const model = { ...TIERED_MODEL, contextWindow: 272_000 };
  const at = (percent, turnIndex) => hintAt(pi, context({ percent, model, contextWindow: 272_000 }), turnIndex);
  assert.equal(at(TIER_PERCENT + 1, 0).length, 0);
  assert.equal(at(AT_BOUNDARY, 1).length, 0);
  assert.equal(at(ABOVE, 2).length, 1);
});

test("leaves the threshold alone for models without cost tiers", () => {
  const { pi } = register();
  const model = { ...TIERED_MODEL, cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } };
  assert.equal(hintAt(pi, context({ percent: TIER_PERCENT + 1, model }), 0).length, 0);
  assert.equal(hintAt(pi, context({ percent: ABOVE, model }), 1).length, 1);
});

test("turns the cost tier cap off when enableCostTiersOverrideThreshold is false", () => {
  const { pi } = register(undefined, { compaction: { enabled: true }, auto_compact: { enableCostTiersOverrideThreshold: false } });
  assert.equal(hintAt(pi, tiered(TIER_PERCENT + 1), 0).length, 0);
  assert.equal(hintAt(pi, tiered(ABOVE), 1).length, 1);
});

test("reads the threshold from settings and ignores invalid values", () => {
  for (const [configured, expected] of [[12, 12], [200, 40], ["12", 40], [-1, 40], [null, 40]]) {
    const { pi } = register(undefined, { compaction: { enabled: true }, auto_compact: { compressionThresholdPercent: configured } });
    assert.equal(hintAt(pi, context({ percent: expected }), 0).length, 0, `at ${configured}`);
    assert.equal(hintAt(pi, context({ percent: expected + 0.1 }), 1).length, 1, `above ${configured}`);
  }
});

test("command caps at the tier boundary and reports both thresholds", async () => {
  const { pi } = register();
  const notifications = [];
  const ctx = tiered(TIER_PERCENT + 1);
  ctx.ui.notify = (message) => notifications.push(message);

  await pi.commands.auto_compact.handler("10", ctx);
  assert.equal(hintAt(pi, tiered(10), 0).length, 0);
  assert.equal(hintAt(pi, tiered(10.1), 1).length, 1);

  await pi.commands.auto_compact.handler("50", ctx);
  assert.equal(hintAt(pi, tiered(TIER_PERCENT), 2).length, 0);
  assert.equal(hintAt(pi, tiered(TIER_PERCENT + 0.1), 3).length, 1);

  await pi.commands.auto_compact.handler("", ctx);
  assert.match(notifications.at(-1), /50%/);
  assert.match(notifications.at(-1), /effective 24\.3%/);

  await pi.commands.auto_compact.handler("off", ctx);
  assert.equal(notifications.at(-1), "Auto-compact: off");
});

test("holds the request at the cost tier cap before the configured threshold", () => {
  const { pi } = register();
  const at = (percent) => {
    const ctx = tiered(percent);
    ctx.sessionManager = { getBranch: () => priorBranch(), getSessionId: () => "test-session" };
    return pi.handlers.input({ type: "input", text: "next", source: "interactive" }, ctx);
  };
  assert.deepEqual(at(TIER_PERCENT - 0.1), { action: "continue" });
  assert.deepEqual(at(TIER_PERCENT + 0.1), { action: "handled" });
});

test("tool rejects usage below the cost tier cap", async () => {
  const { pi } = register();
  const invoke = async (percent) => (await pi.tools[0].execute("call", {}, undefined, undefined, tiered(percent))).details.queued;
  assert.equal(await invoke(TIER_PERCENT), false);
  assert.equal(await invoke(TIER_PERCENT + 0.1), true);
});

test("stops asking once compaction is queued", async () => {
  const { pi } = register();
  const ctx = context();
  pi.handlers.turn_start({ turnIndex: 0 });
  assert.equal((await pi.tools[0].execute("call", {}, undefined, undefined, ctx)).details.queued, true);

  for (const turnIndex of [3, 6, 9]) {
    pi.handlers.turn_start({ turnIndex });
    const event = { messages: [] };
    pi.handlers.context(event, ctx);
    assert.equal(event.messages.length, 0);
  }
});

test("injects a hint in headless modes above the threshold", () => {
  for (const mode of ["print", "json", "rpc"]) {
    const { pi } = register();
    pi.handlers.turn_start({ turnIndex: 0 });
    const event = { messages: [] };
    pi.handlers.context(event, context({ mode, percent: 90 }));
    assert.equal(event.messages.length, 1, `${mode} mode should receive a hint`);
  }
});

test("tool rejects unknown and at-or-below-threshold usage; accepts above", async () => {
  const { pi } = register();
  const invoke = async (ctx) => pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  assert.equal((await invoke(context({ percent: null }))).details.queued, false);
  assert.equal((await invoke(context({ percent: Number.NaN }))).details.queued, false);
  assert.equal((await invoke(context({ percent: AT_BOUNDARY }))).details.queued, false);
  const headless = await invoke(context({ mode: "rpc", percent: AT_BOUNDARY + 1 }));
  assert.equal(headless.details.queued, true);
  assert.equal(headless.terminate, true);
  const queued = await invoke(context({ mode: "print", percent: AT_BOUNDARY + 0.1 }));
  assert.equal(queued.details.queued, true);
  assert.equal(queued.terminate, true);
});

test("compacts and continues at the final actionable boundary in headless modes", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const pi = fakePi();
    registerAutoCompact(pi, {
      loadCompactionModule: async () => ({
        prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
        compact: async () => ({ summary: "summary", firstKeptEntryId: "kept", usage: { input: 1 } }),
      }),
    });
    const ctx = context({ mode });
    await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
    const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
      { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
    ] } };
    const result = await pi.handlers.agent_before_settle(event, ctx);
    assert.equal(result?.continue, true);
    assert.equal(result?.entries[0].type, "compaction");
    assert.equal(result?.entries[1].type, "custom_message");
  }
});

test("coalesces duplicate requests until the actionable boundary", () => {
  const controller = createAutoCompactController();
  const ctx = context();
  assert.equal(controller.request(ctx), "queued");
  assert.equal(controller.request(ctx), "queued");
  assert.equal(controller.consumeRequest(), true);
  assert.equal(controller.consumeRequest(), false);
});

test("rejects unknown and at-or-below-threshold context", () => {
  const controller = createAutoCompactController();
  controller.request(context());
  for (const percent of [AT_BOUNDARY, null, Number.NaN]) {
    assert.equal(controller.isAboveThreshold(context({ percent })), false);
  }
  assert.equal(controller.isAboveThreshold(context()), true);
  assert.equal(controller.consumeRequest(), true);
  assert.equal(controller.consumeRequest(), false);
});

test("rejects a compaction request batched with another tool", async () => {
  const { pi } = register({ loadCompactionModule: async () => { assert.fail("must not generate a summary"); } });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }, { type: "toolCall", name: "bash" }] },
  ] } };
  assert.equal(await pi.handlers.agent_before_settle(event, ctx), undefined);
});

test("compacts without an installed subagent extension or event bus", async () => {
  const pi = fakePi();
  delete pi.events;
  registerAutoCompact(pi, {
    loadCompactionModule: async () => ({
      prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
      compact: async () => ({ summary: "summary", firstKeptEntryId: "kept" }),
    }),
  });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } };
  const result = await pi.handlers.agent_before_settle(event, ctx);
  assert.equal(result.continue, true);
  assert.equal(result.entries[0].type, "compaction");
});

test("clears a refused compaction request when the run settles", async () => {
  const { pi } = register();
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: true, context: { pendingMessages: [] } };
  assert.equal(await pi.handlers.agent_before_settle(event, ctx), undefined);
  pi.handlers.agent_settled({}, ctx);
  const noRequest = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [] } };
  assert.equal(await pi.handlers.agent_before_settle(noRequest, ctx), undefined);
});

test("fails closed when subagent status reports active delegated work", async () => {
  const pi = fakePi();
  pi.getAllTools = () => [{ name: "subagent" }];
  pi.events.on("subagents:rpc:v1:request", (request) => {
    pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      ...makeSettledSubagentReply(request),
      data: {
        fleet: { totalActive: 1 },
        asyncSnapshot: {
          ...makeSettledSubagentReply(request).data.asyncSnapshot,
          runs: [{ id: "child", state: "running", children: [] }],
        },
      },
    });
  });
  registerAutoCompact(pi, {
    subagentStatusTimeoutMs: 5,
    loadCompactionModule: async () => ({
      prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
      compact: async () => ({ summary: "summary", firstKeptEntryId: "kept" }),
    }),
  });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } };
  const result = await pi.handlers.agent_before_settle(event, ctx);
  assert.equal(result.continue, true);
  assert.ok(result.entries.every(entry => entry.type !== "compaction"));
});

test("rechecks delegated work after summary generation and drops a stale compaction draft", async () => {
  const pi = fakePi();
  let statusCalls = 0;
  pi.getAllTools = () => [{ name: "subagent" }];
  pi.events.on("subagents:rpc:v1:request", (request) => {
    statusCalls++;
    const reply = makeSettledSubagentReply(request);
    if (statusCalls > 1) {
      reply.data.fleet.totalActive = 1;
      reply.data.asyncSnapshot.runs = [{ id: "child", state: "running", children: [] }];
    }
    pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, reply);
  });
  registerAutoCompact(pi, {
    subagentStatusTimeoutMs: 5,
    loadCompactionModule: async () => ({
      prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
      compact: async () => ({ summary: "summary", firstKeptEntryId: "kept" }),
    }),
  });
  const ctx = context();
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } };
  const result = await pi.handlers.agent_before_settle(event, ctx);
  assert.equal(result.continue, true);
  assert.ok(result.entries.every(entry => entry.type !== "compaction"));
});

test("fails closed when summary generation fails", async () => {
  const pi = fakePi();
  registerAutoCompact(pi, { loadCompactionModule: async () => { throw new Error("test error"); } });
  const notifications = [];
  const ctx = context();
  ctx.ui.notify = (message, type) => notifications.push({ message, type });

  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
  const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } };
  const result = await pi.handlers.agent_before_settle(event, ctx);
  assert.equal(result.continue, true);
  assert.ok(result.entries.every(entry => entry.type !== "compaction"));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Automatic compaction failed:/);
  assert.equal(notifications[0].type, "warning");
  assert.equal((await pi.tools[0].execute("retry", {}, undefined, undefined, ctx)).terminate, true);
});

test("waits for the compaction draft or fails closed after timeout", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);

  try {
    const { pi } = register({
      timeoutMs: 5,
      loadCompactionModule: () => new Promise(() => {}),
    });
    const ctx = context({ mode: "print" });
    await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
    const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
      { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
    ] } };
    await pi.handlers.agent_before_settle(event, ctx);
    assert.equal(event.entries.length, 0);
  } finally {
    console.error = originalError;
  }

  assert.match(errors[0], /Automatic compaction failed: compaction timed out/);
});

test("logs summary failure to stderr in headless mode", async () => {
  const pi = fakePi();
  registerAutoCompact(pi, { loadCompactionModule: async () => { throw new Error("test error"); } });
  const ctx = context({ mode: "print" });
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);

  try {
    await pi.tools[0].execute("call", {}, undefined, undefined, ctx);
    const event = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
      { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
    ] } };
    await pi.handlers.agent_before_settle(event, ctx);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(errors, ["Automatic compaction failed: test error"]);

});

test("does not compact when the run was aborted or the tool never ran", async () => {
  const { pi } = register();
  const ctx = context();
  let calls = 0;
  ctx.compact = () => calls++;

  const result = await pi.handlers.agent_before_settle(
    { outcome: "aborted", entries: [], continue: false, context: { pendingMessages: [] } },
    ctx,
  );
  assert.equal(result, undefined);
  pi.handlers.agent_settled({}, ctx);
  assert.equal(calls, 0);
});








function priorBranch() {
  return [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier work" }] } }];
}

function holdingContext(percent) {
  const ctx = context({ percent });
  ctx.sessionManager = { getBranch: () => priorBranch(), getSessionId: () => "test-session" };
  return ctx;
}

test("holds the request above the threshold and starts a judgment run", () => {
  const { pi } = register();
  const ctx = holdingContext(ABOVE);
  assert.deepEqual(pi.handlers.input({ type: "input", text: "summarize the records", source: "interactive" }, ctx), { action: "handled" });

  assert.equal(pi.messages.length, 1);
  const sent = pi.messages[0].custom;
  assert.equal(sent.customType, "auto-compact-pre-turn");
  assert.match(sent.content, /^\[Pi pre-turn compact check\]/);
  assert.match(sent.content, /summarize the records/);
  assert.match(sent.content, /SKIP-COMPACTION/);
  assert.equal(pi.messages[0].options.triggerTurn, true);
});

test("passes the request through when the check does not apply", () => {
  const cases = [
    ["below the threshold", { type: "input", text: "next", source: "interactive" }, () => holdingContext(BELOW)],
    ["a slash command", { type: "input", text: "/auto_compact 30", source: "interactive" }, () => holdingContext(ABOVE)],
    ["streamed input", { type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, () => holdingContext(ABOVE)],
    ["a busy agent", { type: "input", text: "queued", source: "tui" }, () => { const ctx = holdingContext(ABOVE); ctx.isIdle = () => false; return ctx; }],
    ["print mode", { type: "input", text: "batched", source: "print" }, () => { const ctx = holdingContext(ABOVE); ctx.mode = "print"; ctx.hasUI = false; return ctx; }],
    ["an empty session", { type: "input", text: "first request", source: "interactive" }, () => context({ percent: ABOVE })],
  ];
  for (const [label, event, makeContext] of cases) {
    const { pi } = register();
    const result = pi.handlers.input(event, makeContext());
    assert.deepEqual(result, { action: "continue" }, label);
    assert.equal(pi.messages.length, 0, label);
  }
});

test("suppresses the mid-run hint while the judgment run is in flight", () => {
  const { pi } = register();
  const ctx = holdingContext(ABOVE);
  pi.handlers.input({ type: "input", text: "next", source: "interactive" }, ctx);

  pi.handlers.turn_start({ turnIndex: 0 });
  const event = { messages: [] };
  pi.handlers.context(event, ctx);
  assert.equal(event.messages.length, 0);

  pi.handlers.agent_settled({}, ctx);
  pi.handlers.turn_start({ turnIndex: 1 });
  const later = { messages: [] };
  pi.handlers.context(later, ctx);
  assert.equal(later.messages.length, 1);
});

test("carries the held request through compaction as the continuation", async () => {
  const pi = fakePi();
  registerAutoCompact(pi, {
    loadCompactionModule: async () => ({
      prepareCompaction: () => ({ firstKeptEntryId: "kept" }),
      compact: async () => ({ summary: "summary", firstKeptEntryId: "kept", usage: { input: 1 } }),
    }),
  });
  const ctx = holdingContext(ABOVE);
  pi.handlers.input({ type: "input", text: "held request", source: "interactive" }, ctx);
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);

  const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } }, ctx);
  assert.equal(result.continue, true);
  assert.equal(result.entries[0].type, "compaction");
  assert.equal(result.entries[1].content, "held request");
});

test("delivers the held request when the model declines to compact", () => {
  const { pi } = register();
  const ctx = holdingContext(ABOVE);
  pi.handlers.input({ type: "input", text: "held request", source: "interactive" }, ctx);
  pi.handlers.agent_settled({}, ctx);

  const delivered = pi.messages.filter((message) => message.text !== undefined);
  assert.deepEqual(delivered.map((message) => message.text), ["held request"]);
});

test("does not hold the request it re-delivers", () => {
  const { pi } = register();
  const ctx = holdingContext(ABOVE);
  pi.handlers.input({ type: "input", text: "held request", source: "interactive" }, ctx);

  let reentrant;
  pi.sendUserMessage = (text) => {
    reentrant = pi.handlers.input({ type: "input", text, source: "interactive" }, ctx);
    // a later request from the user is judged again
    reentrantLater = pi.handlers.input({ type: "input", text: "a fresh request", source: "interactive" }, ctx);
  };
  let reentrantLater;
  pi.handlers.agent_settled({}, ctx);
  assert.deepEqual(reentrant, { action: "continue" });
  assert.deepEqual(reentrantLater, { action: "handled" });
});

test("does not continue the run while a request is still held", async () => {
  const pi = fakePi();
  registerAutoCompact(pi, {
    loadCompactionModule: async () => ({
      prepareCompaction: () => undefined,
      compact: async () => { throw new Error("must not summarize"); },
    }),
  });
  const ctx = holdingContext(ABOVE);
  pi.handlers.input({ type: "input", text: "held request", source: "interactive" }, ctx);
  await pi.tools[0].execute("call", {}, undefined, undefined, ctx);

  const result = await pi.handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], contextMessages: [
    { role: "assistant", content: [{ type: "toolCall", name: "request_compaction" }] },
  ] } }, ctx);
  assert.equal(result, undefined, "the held request is delivered at settle, not continued as a task");
});
