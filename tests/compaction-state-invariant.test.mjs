#!/usr/bin/env node
/**
 * Compaction/state invariant — session state must survive a compaction.
 *
 * Pi's compaction never deletes entries: it appends a `compaction` entry and only
 * changes the MODEL-VISIBLE projection (`buildContextEntries()` drops everything
 * before `firstKeptEntryId`). `sessionManager.getBranch()` stays the raw, append-only
 * path. So state that lives in an entry survives a compaction; state that lives only
 * in the model-visible context does not.
 *
 * agent-goal and auto-agent-loop restore from `getBranch()`, which is why they need
 * no re-injection after a compaction. These tests lock that: every mock session
 * manager below offers BOTH views (raw `getBranch()` and the compaction-filtered
 * projection), and the assertions only pass while the extensions read the raw one.
 * Rewriting `load()` to use `buildContextEntries()`/`buildSessionContext()` — the
 * plausible "simplification", and the view a context-presence check would use —
 * makes them fail.
 *
 * auto-compact's ordering (its `auto-compact-continuation` is committed after the
 * `compaction` entry, so it is inside the kept range) is asserted in
 * tests/auto-compact.test.mjs: "carries the held request through compaction as the
 * continuation".
 *
 * Run: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDep } from "./resolve-dep.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS = path.join(__dirname, "..", "agent", "extensions");

// agent-goal/index.ts resolves bare specifiers from its own directory, so the
// runtime deps it needs must be linked there (node_modules is gitignored).
function ensureDeps() {
  const locations = [__dirname, EXTENSIONS];
  const targets = [
    ["typebox", resolveDep("typebox@", "typebox")],
    ["@earendil-works/pi-tui", resolveDep("@earendil-works+pi-tui@", path.join("@earendil-works", "pi-tui"))],
  ];
  for (const dir of locations) {
    const nm = path.join(dir, "node_modules");
    fs.mkdirSync(path.join(nm, "@earendil-works"), { recursive: true });
    for (const [name, target] of targets) {
      const dest = path.join(nm, name);
      if (fs.existsSync(dest)) continue;
      fs.rmSync(dest, { force: true }); // a dangling symlink from an older install
      fs.symlinkSync(target, dest, "dir");
    }
  }
}
ensureDeps();

const PI = resolveDep("@earendil-works+pi-coding-agent@", "@earendil-works/pi-coding-agent");
// The real projection function, not a copy: this is the code whose behavior the
// invariant depends on, so it is the code the test reads.
const { buildContextEntries, sessionEntryToContextMessages } = await import(
  pathToFileURL(path.join(PI, "dist", "core", "session-manager.js")).href
);
const { default: agentGoal } = await import(path.join(EXTENSIONS, "agent-goal", "index.ts"));
const { DEFAULT_CONFIG, registerAgentLoop, validateConfig } = await import(
  path.join(EXTENSIONS, "auto-agent-loop", "controller.mjs")
);

// ─── fixtures ─────────────────────────────────────────────────────────────

const text = (role, value) => ({ type: "message", message: { role, content: [{ type: "text", text: value }] } });

/** Give a plain entry list real ids and a parentId chain. */
function asPath(entries) {
  return entries.map((entry, index) => ({
    id: String(index + 1),
    parentId: index === 0 ? null : String(index),
    timestamp: "2026-11-20T00:00:00Z",
    ...entry,
  }));
}

/**
 * A branch where `stateEntry` was summarized away: it sits before the compaction
 * cut, while the entries after the cut are still in the model's context.
 */
function summarizedAway(stateEntry) {
  return asPath([
    text("user", "start the audit"), // 1  summarized
    stateEntry, // 2  summarized — where the state entry lives
    text("assistant", "working"), // 3  summarized
    text("user", "keep going"), // 4  kept (firstKeptEntryId)
    { type: "compaction", summary: "earlier work", firstKeptEntryId: "4", tokensBefore: 100 }, // 5
    {
      type: "custom_message", // 6  committed after the cut, still visible
      customType: "auto-compact-continuation",
      content: "Context was compacted. Continue the task.",
    },
  ]);
}

/**
 * A session manager that answers both ways, like the real one: the raw branch and
 * the compaction-filtered view. Both are built with pi's own functions, so a
 * reader that switches to the filtered view fails for the right reason.
 */
function sessionManager(branch) {
  const projection = buildContextEntries(branch);
  return {
    getBranch: () => branch,
    buildContextEntries: () => projection,
    buildSessionContext: () => ({ messages: projection.flatMap(sessionEntryToContextMessages) }),
  };
}

// ─── the invariant ────────────────────────────────────────────────────────

test("compaction hides summarized entries from the model but keeps them in the branch", () => {
  const branch = summarizedAway({ type: "custom", customType: "agent-goal-state", data: { goal: "ship the audit" } });
  const projection = buildContextEntries(branch);
  const ids = (list) => list.map((entry) => entry.id);
  const has = (list, id) => list.some((entry) => entry.id === id);

  assert.deepEqual(ids(branch), ["1", "2", "3", "4", "5", "6"], "getBranch() is the raw, append-only path");
  assert.ok(has(projection, "5"), "the projection carries the compaction entry itself");
  for (const summarized of ["1", "2", "3"]) {
    assert.equal(has(projection, summarized), false, `summarized entry ${summarized} is gone from the model-visible context`);
  }
  assert.equal(projection.some((entry) => entry.customType === "agent-goal-state"), false,
    "the state entry is genuinely gone from the model-visible context");
  for (const kept of ["4", "6"]) {
    assert.equal(has(projection, kept), true, `entry ${kept} is still in the model-visible context`);
  }
  assert.equal(projection.some((entry) => entry.customType === "auto-compact-continuation"), true,
    "an entry committed after the compaction entry stays in the model-visible context");
});

// ─── agent-goal ───────────────────────────────────────────────────────────

function goalHarness(branch) {
  const widgets = [];
  const handlers = {};
  const pi = {
    appendEntry() {},
    getActiveTools: () => ["set_goal"],
    setActiveTools() {},
    on: (event, handler) => { handlers[event] = handler; },
    registerTool() {},
    registerCommand() {},
  };
  const ctx = {
    hasUI: true,
    ui: {
      theme: { fg: (_style, value) => value },
      setWidget: (key, lines) => widgets.push([key, lines]),
      setStatus() {},
      notify() {},
    },
    sessionManager: sessionManager(branch),
  };
  agentGoal(pi);
  return { ctx, handlers, widgets };
}

test("agent-goal restores the goal line although a compaction summarized its state entry", () => {
  const branch = summarizedAway({
    type: "custom",
    customType: "agent-goal-state",
    data: { goal: "ship the audit", lastPrompt: "audit the extensions", lastPromptAt: 1 },
  });
  const { ctx, handlers, widgets } = goalHarness(branch);

  handlers.session_start({}, ctx);

  assert.deepEqual(widgets.at(-1), ["agent-goal", [
    "user_prompt: audit the extensions",
    "agent_goal: ship the audit",
  ]]);
});

// ─── auto-agent-loop ──────────────────────────────────────────────────────

function loopHarness(branch) {
  const handlers = {};
  const pi = {
    on: (event, handler) => { handlers[event] = handler; },
    registerCommand() {},
    appendEntry() {},
    getAllTools: () => [],
  };
  const ctx = {
    hasUI: true,
    sessionManager: sessionManager(branch),
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  };
  // settings leave the loop off: only the branch can turn it on here.
  const controller = registerAgentLoop(pi, { getConfig: () => validateConfig(DEFAULT_CONFIG) });
  return { ctx, handlers, controller };
}

test("auto-agent-loop restores the switch and the fuse although a compaction summarized its state entry", () => {
  const branch = summarizedAway({
    type: "custom",
    customType: "auto-agent-loop-state",
    data: { enabled: true, continuations: 2, status: "continue", probability: 0.95 },
  });
  const { ctx, handlers, controller } = loopHarness(branch);

  handlers.session_start({}, ctx);

  const state = controller.state;
  assert.equal(state.enabled, true, "the switch survives the compaction");
  assert.equal(state.continuations, 2, "the fuse survives the compaction");
  assert.equal(state.status, "ready", "a verdict from the summarized turn is not resurrected");
  assert.equal(state.probability, undefined, "the probability belongs to the summarized turn");
});
