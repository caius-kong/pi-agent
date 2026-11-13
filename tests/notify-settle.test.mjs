import assert from "node:assert/strict";
import test from "node:test";

const extensionUrl = new URL("../agent/extensions/notify/index.ts", import.meta.url);

function fakePi() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    events: {
      on(channel, handler) {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel).push(handler);
        return () => {};
      },
    },
    emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
    emitBus(channel, payload) {
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    },
  };
}

function context({ mode = "tui", idle = true, pending = false } = {}) {
  return {
    mode,
    cwd: "/work/payments-api",
    isIdle: () => idle,
    hasPendingMessages: () => pending,
  };
}

async function settle(ms = 5) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(options = {}) {
  const { registerCompletionNotifier } = await import(extensionUrl);
  const pi = fakePi();
  const notifications = [];
  registerCompletionNotifier(pi, {
    graceMs: 0,
    notify: async (title, body) => notifications.push({ title, body }),
    // The real resolver probes Herdr when HERDR_ENV is set, which the test host inherits.
    resolveContext: async (ctx) => ({
      title: `Pi · ${ctx.cwd.split("/").filter(Boolean).at(-1)}`,
      body: "Run finished; ready for input",
    }),
    ...options,
  });
  return { pi, notifications };
}

test("notifies once the session stays idle past the settle boundary", async () => {
  const { pi, notifications } = await register();
  pi.emit("agent_settled", { aborted: false }, context());
  await settle();
  assert.deepEqual(notifications, [{ title: "Pi · payments-api", body: "Run finished; ready for input" }]);
});

test("stays silent when another run starts during the settle boundary", async () => {
  const { pi, notifications } = await register();
  pi.emit("agent_settled", { aborted: false }, context());
  pi.emit("agent_start");
  await settle();
  assert.equal(notifications.length, 0);
});

test("stays silent when messages are queued behind the settle", async () => {
  const { pi, notifications } = await register();
  pi.emit("agent_settled", { aborted: false }, context({ pending: true }));
  await settle();
  assert.equal(notifications.length, 0);
});

test("stays silent when the run was aborted", async () => {
  const { pi, notifications } = await register();
  pi.emit("agent_settled", { aborted: true }, context());
  await settle();
  assert.equal(notifications.length, 0);
});

test("ignores non-interactive sessions", async () => {
  const { pi, notifications } = await register();
  pi.emit("agent_settled", { aborted: false }, context({ mode: "rpc" }));
  await settle();
  assert.equal(notifications.length, 0);
});

test("waits for background subagents to drain before notifying", async () => {
  const { pi, notifications } = await register();
  pi.emitBus("subagent:async-started", { id: "run-1" });
  pi.emit("agent_settled", { aborted: false }, context());
  await settle();
  assert.equal(notifications.length, 0, "background work is still running");

  pi.emitBus("subagent:async-complete", { runId: "run-1" });
  await settle();
  assert.equal(notifications.length, 1, "the completion did not wake a turn, so notify now");
});

test("does not notify if a new run starts while resolving notification context", async () => {
  let idle = true;
  let contextStarted;
  let releaseContext;
  const started = new Promise((resolve) => { contextStarted = resolve; });
  const resolving = new Promise((resolve) => { releaseContext = resolve; });
  const ctx = context();
  ctx.isIdle = () => idle;
  const { pi, notifications } = await register({
    resolveContext: async () => {
      contextStarted();
      return resolving;
    },
  });

  pi.emit("agent_settled", { aborted: false }, ctx);
  await started;
  idle = false;
  pi.emit("agent_start");
  releaseContext({ title: "Pi", body: "Run finished; ready for input" });
  await settle();

  assert.equal(notifications.length, 0, "a stale settled notification must not leak into the next run");
});

test("a wake turn keeps the notification quiet until that run settles", async () => {
  const { pi, notifications } = await register();
  let idle = true;
  const ctx = {
    mode: "tui",
    cwd: "/work/payments-api",
    isIdle: () => idle,
    hasPendingMessages: () => false,
  };

  pi.emitBus("subagent:async-started", { id: "run-1" });
  pi.emit("agent_settled", { aborted: false }, ctx);
  await settle();
  assert.equal(notifications.length, 0);

  // The subagent result wakes the parent instead of leaving it idle.
  idle = false;
  pi.emit("agent_start");
  pi.emitBus("subagent:async-complete", { runId: "run-1" });
  await settle();
  assert.equal(notifications.length, 0, "the wake turn owns the completion now");

  idle = true;
  pi.emit("agent_settled", { aborted: false }, ctx);
  await settle();
  assert.equal(notifications.length, 1);
});

test("ignores background events without a run id", async () => {
  const { pi, notifications } = await register();
  pi.emitBus("subagent:async-started", {});
  pi.emit("agent_settled", { aborted: false }, context());
  await settle();
  assert.equal(notifications.length, 1);
});
