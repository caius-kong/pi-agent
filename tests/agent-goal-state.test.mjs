#!/usr/bin/env node
/**
 * agent-goal UNIT test — drives the real extension on a mock ExtensionAPI and
 * exhaustively verifies the set_goal state machine across all modes/branches.
 *
 * Complements the behavioral eval (run-eval.cjs, which proves a REAL model picks
 * the right mode). This proves the MECHANISM honors each mode exactly:
 *   mode:"new"      replaces goal + clears subGoal + updates goalSetAt
 *   mode:"rewrite"  replaces goal + CLEARS any existing subGoal + updates goalSetAt
 *   mode:"expand"   keeps goal byte-identical + replaces the nested focus row
 *                   (no accumulation) + preserves goalSetAt
 * plus: default mode is "new", invalid mode falls back to "new",
 *       expand with no parent behaves like "new", empty goal errors,
 *       ANSI stripping, widget/`└─` rendering, session restart restore.
 *
 * Run: node tests/agent-goal-state.test.mjs   (node >= 23.6 with --experimental-strip-types default)
 * Requires local node_modules symlinks to the pnpm store; auto-created below.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// STORE paths are machine-local and change whenever pnpm rebuilds its virtual store,
// so they are resolved at run time instead of being pinned to one hash directory.
const PNPM_GLOBAL = path.join(os.homedir(), "Library", "pnpm", "global", "v11");
function resolveDep(prefix, inner) {
  let entries = [];
  try { entries = fs.readdirSync(PNPM_GLOBAL); } catch {}
  for (const entry of entries) {
    const store = path.join(PNPM_GLOBAL, entry, "node_modules", ".pnpm");
    let names = [];
    try { names = fs.readdirSync(store); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const candidate = path.join(store, name, "node_modules", inner);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot locate ${prefix} in the local pnpm store`);
}

// ── auto-link runtime deps of agent-goal/index.ts (typebox, pi-tui) ──────
// agent-goal/index.ts resolves bare specifiers from ITS directory (agent/extensions),
// so symlinks must exist there; we also link a copy under ./node_modules so the
// test harness itself could import them if needed. Both are idempotent.
// NOTE: store paths are machine-local (this is a local eval utility).
function ensureDeps() {
  const locations = [
    __dirname, // tests
    path.join(__dirname, "..", "agent", "extensions"), // where extension resolves from
  ];
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
      // existsSync is false for a dangling symlink left behind by an older pnpm store.
      fs.rmSync(dest, { force: true });
      fs.symlinkSync(target, dest, "dir");
    }
  }
}
ensureDeps();

const EXT = path.join(__dirname, "..", "agent", "extensions", "agent-goal", "index.ts");
const { default: agentGoal } = await import(EXT);

// ── minimal mock of the ExtensionAPI surface the extension touches ────────
function makePI() {
  const entries = []; // appendEntry log
  const handlers = {};
  const tools = {};
  const widgetLines = {}; // WIDGET_KEY -> string[] (latest)
  const statuses = {}; // STATUS_KEY -> string (latest)
  let branch = []; // what sessionManager.getBranch() returns

  // persist keeps a mirror of the latest state entry for getBranch()/load()
  const mirrorEntry = () => {
    const last = entries[entries.length - 1];
    branch = last && last.type.startsWith("agent-goal")
      ? [{ type: "custom", customType: last.type, data: { ...last.data } }]
      : [];
  };

  const pi = {
    appendEntry(type, data) {
      entries.push({ type, data: { ...data } });
      mirrorEntry();
    },
    getActiveTools: () => ["set_goal"],
    on(event, handler) {
      (handlers[event] || (handlers[event] = [])).push(handler);
    },
    registerTool(def) {
      tools[def.name] = def;
    },
    registerCommand() {},
  };
  const ctx = {
    hasUI: true,
    ui: {
      theme: { fg: (_style, s) => s },
      setWidget(key, lines) {
        if (lines === undefined) delete widgetLines[key];
        else widgetLines[key] = lines;
      },
      setStatus(key, line) {
        if (line === undefined) delete statuses[key];
        else statuses[key] = line;
      },
      notify() {},
    },
    sessionManager: { getBranch: () => branch },
  };
  return { pi, entries, handlers, tools, widgetLines, statuses, ctx };
}

// fire every registered handler for an event (extensions register one each)
function fire(handlers, event, eventArg, ctx) {
  for (const h of handlers[event] || []) h(eventArg, ctx);
}

let passed = 0, failed = 0;
function ok(label) { console.log(`  ✓ ${label}`); passed++; }
function bad(label, extra) { console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); failed++; }
function check(cond, label, extra) { cond ? ok(label) : bad(label, extra); }
function stateOf(entries) { return { ...entries[entries.length - 1].data }; }

// ── scenario A: one MockPI, sequential chain exercising all branches ──────
const A = makePI();
agentGoal(A.pi);
fire(A.handlers, "session_start", {}, A.ctx); // initial load (empty state)
const setGoal = A.tools["set_goal"];
const run = async (params) => {
  const r = await setGoal.execute("call-1", params, undefined, undefined, A.ctx);
  return r;
};

console.log(`\n== A: mode state machine (single extension instance) ==`);
{
  // A1 — new: first goal
  await run({ goal: "Ship CSV export with passing tests", mode: "new" });
  let s = stateOf(A.entries);
  check(s.goal === "Ship CSV export with passing tests", "new sets goal", JSON.stringify(s));
  check(s.subGoal === null, "new clears subGoal (was null)");
  const t1 = s.goalSetAt;
  check(typeof t1 === "number", "new stamps goalSetAt");
  check(JSON.stringify(A.widgetLines["agent-goal"]) === JSON.stringify(["agent_goal: Ship CSV export with passing tests"]),
    "widget shows single goal line", JSON.stringify(A.widgetLines["agent-goal"]));

  // A2 — expand under existing goal: parent byte-identical, focus nested
  await run({ goal: "fix date-column formatting first", mode: "expand" });
  s = stateOf(A.entries);
  check(s.goal === "Ship CSV export with passing tests", "expand keeps parent goal byte-identical", JSON.stringify(s));
  check(s.subGoal === "fix date-column formatting first", "expand nests focus as subGoal");
  check(s.goalSetAt === t1, "expand preserves goalSetAt (parent unchanged)");
  check(JSON.stringify(A.widgetLines["agent-goal"]) ===
    JSON.stringify(["agent_goal: Ship CSV export with passing tests", "  └─ fix date-column formatting first"]),
    "widget renders parent + one '└─' nested row", JSON.stringify(A.widgetLines["agent-goal"]));

  // A3 — repeated expand: replaces previous nested row, does NOT accumulate
  await run({ goal: "date utc parsing edge", mode: "expand" });
  s = stateOf(A.entries);
  check(s.subGoal === "date utc parsing edge", "second expand REPLACES the nested row (no stacking)");
  check(A.widgetLines["agent-goal"].filter((l) => l.includes("└─")).length === 1,
    "widget has exactly one '└─' row", JSON.stringify(A.widgetLines["agent-goal"]));

  // A4 — session restart: state (goal + subGoal) restores from persisted entry
  fire(A.handlers, "session_start", {}, A.ctx);
  s = (A.entries.length && A.entries[A.entries.length - 1].data);
  check(s && s.goal === "Ship CSV export with passing tests" && s.subGoal === "date utc parsing edge",
    "restart restores goal + nested focus from agent-goal-state", JSON.stringify(s));
  check(A.widgetLines["agent-goal"] && A.widgetLines["agent-goal"].some((l) => l.includes("└─")),
    "widget restored with nested row after restart");

  // A5 — rewrite: replaces goal text, CLEARS stale subGoal, updates timestamp
  await run({ goal: "Ship CSV export with passing tests + ISO-8601 + BOM for Excel", mode: "rewrite" });
  s = stateOf(A.entries);
  check(s.goal.includes("ISO-8601") && s.goal.includes("BOM"),
    "rewrite replaces goal text with grown version", s.goal);
  check(s.subGoal === null, "rewrite CLEARS previously nested subGoal");
  check(typeof s.goalSetAt === "number" && s.goalSetAt >= t1, "rewrite re-stamps goalSetAt");
  check(A.widgetLines["agent-goal"].length === 1 && !A.widgetLines["agent-goal"][0].includes("└─"),
    "widget back to single line after rewrite", JSON.stringify(A.widgetLines["agent-goal"]));

  // A6 — empty goal → error, state unchanged
  const before = stateOf(A.entries);
  const err = await run({ goal: "   " });
  check(err.details && err.details.error === true, "empty goal returns error");
  s = stateOf(A.entries);
  check(s.goal === before.goal && s.subGoal === before.subGoal && s.goalSetAt === before.goalSetAt,
    "failed call leaves state untouched");

  // A7 — ANSI/control bytes stripped from stored goal
  await run({ goal: "clean\x1b[31mred\x1b[0m goal", mode: "new" });
  s = stateOf(A.entries);
  check(s.goal === "cleanred goal", "ANSI CSI sequences stripped", JSON.stringify(s.goal));

  // A8 — default mode (omitted) == new
  await run({ goal: "demo default mode" });
  s = stateOf(A.entries);
  check(s.goal === "demo default mode" && s.subGoal === null, "omitted mode defaults to new");

  // A9 — invalid mode falls back to new
  await run({ goal: "invalid mode goal", mode: "bogus" });
  s = stateOf(A.entries);
  check(s.goal === "invalid mode goal", "invalid mode falls back to new");
}

// ── scenario B: fresh instance — expand with NO parent behaves like new ───
console.log(`\n== B: expand with no parent goal ==`);
{
  const B = makePI();
  agentGoal(B.pi);
  fire(B.handlers, "session_start", {}, B.ctx);
  const g = B.tools["set_goal"];
  await g.execute("c", { goal: "brand new standalone", mode: "expand" }, undefined, undefined, B.ctx);
  const s = stateOf(B.entries);
  check(s.goal === "brand new standalone" && s.subGoal === null,
    "expand with no parent behaves like new (sets goal)", JSON.stringify(s));
}

// ── scenario C: input event drives user_prompt line; goal untouched ───────
console.log(`\n== C: user_prompt display (input event) ==`);
{
  const C = makePI();
  agentGoal(C.pi);
  fire(C.handlers, "session_start", {}, C.ctx);
  const g = C.tools["set_goal"];
  await g.execute("c", { goal: "prompt display test" }, undefined, undefined, C.ctx);
  fire(C.handlers, "input", { text: "please add escaping logic", source: "interactive" }, C.ctx);
  const lines = C.widgetLines["agent-goal"];
  check(lines && lines[0] === "user_prompt: please add escaping logic",
    "input event renders user_prompt line", JSON.stringify(lines));
  const s = stateOf(C.entries);
  check(s.goal === "prompt display test" && s.lastPrompt === "please add escaping logic",
    "input event updates lastPrompt, never touches goal");
}

console.log(`\n===== unit: ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);