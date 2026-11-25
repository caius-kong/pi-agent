#!/usr/bin/env node
/**
 * agent-goal UNIT test — drives the real extension on a mock ExtensionAPI.
 *
 * The contract under test is the single-string one:
 *   set_goal({ goal })   goal = summary of the session's still-open goals,
 *                        <= 300 chars, "" clears the line.
 * The extension only stores and displays that text; which goal is finished,
 * cancelled, superseded or paused is the main agent's judgement, so nothing here
 * asserts a mode, a parent/child relation or a validator.
 *
 * Covered: single-parameter schema (no `mode`), the 300-char boundary, "" as a
 * legal clear, storage restore (including an entry written by the older
 * two-field contract), display (two single entries, no nested row), ANSI
 * stripping, the fixed-text footprint budget (declaration + snippet +
 * guidelines <= 888 chars, chars/4 <= 222), and the SHIPPED instruction
 * surface: a candidate measured in a temp file is not delivered until these
 * assertions see its wording in `index.ts` (scenario E).
 *
 * Run: node tests/agent-goal-state.test.mjs   (node >= 23.6 with --experimental-strip-types default)
 * Requires local node_modules symlinks to the resolved deps; auto-created below.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDep } from "./resolve-dep.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      // existsSync is false for a dangling symlink left behind by an older install.
      fs.rmSync(dest, { force: true });
      fs.symlinkSync(target, dest, "dir");
    }
  }
}
ensureDeps();

const EXT = path.join(__dirname, "..", "agent", "extensions", "agent-goal", "index.ts");
const { default: agentGoal } = await import(EXT);

const GOAL_MAX_LEN = 300;
// Fixed prompt footprint budget: the tool declaration as the PROVIDER receives it
// (`{ type: "function", function: { name, description, parameters } }` — the
// wrapper costs 31 chars on top of the bare object), the `- set_goal: <snippet>`
// line and the rendered `- <guideline>` lines together.
const FOOTPRINT_MAX_CHARS = 888;

// ── minimal mock of the ExtensionAPI surface the extension touches ────────
function makePI({ initialBranch = [] } = {}) {
  const entries = []; // appendEntry log
  const handlers = {};
  const tools = {};
  const widgetLines = {}; // WIDGET_KEY -> string[] (latest)
  const statuses = {}; // STATUS_KEY -> string (latest)
  let branch = [...initialBranch]; // what sessionManager.getBranch() returns

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
    setActiveTools() {},
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

// ── scenario A: one MockPI, sequential chain exercising the whole contract ─
const A = makePI();
agentGoal(A.pi);
fire(A.handlers, "session_start", {}, A.ctx); // initial load (empty state)
const setGoal = A.tools["set_goal"];
const run = async (params) => setGoal.execute("call-1", params, undefined, undefined, A.ctx);
const goalEntries = (lines) => (lines || []).filter((l) => l.startsWith("agent_goal:"));

console.log(`\n== A: single-string contract ==`);
{
  // A1 — one parameter, no `mode`, explicit 300-char budget
  const schema = setGoal.parameters;
  check(JSON.stringify(Object.keys(schema.properties)) === JSON.stringify(["goal"]),
    "schema declares exactly one parameter: goal", JSON.stringify(schema.properties));
  check(schema.properties.goal.maxLength === GOAL_MAX_LEN,
    `schema states the ${GOAL_MAX_LEN}-char limit`, JSON.stringify(schema.properties.goal));
  check(!("mode" in schema.properties), "schema has no mode/rewrite/expand parameter");
  check(JSON.stringify(schema.required) === JSON.stringify(["goal"]), "goal is required");

  // A2 — a first summary sets the goal line
  await run({ goal: "Ship CSV export with passing tests" });
  let s = stateOf(A.entries);
  check(s.goal === "Ship CSV export with passing tests", "summary sets the goal line", JSON.stringify(s));
  check(JSON.stringify(A.widgetLines["agent-goal"]) === JSON.stringify(["agent_goal: Ship CSV export with passing tests"]),
    "widget shows one goal entry", JSON.stringify(A.widgetLines["agent-goal"]));
  check(!("subGoal" in s), "no nested sub-goal is stored");

  // A3 — a supplemented summary replaces the line, still one entry
  await run({ goal: "Ship CSV export with passing tests; add ISO-8601 timestamps" });
  s = stateOf(A.entries);
  check(s.goal === "Ship CSV export with passing tests; add ISO-8601 timestamps",
    "second summary replaces the line", JSON.stringify(s));
  check(A.widgetLines["agent-goal"].length === 1, "widget keeps a single goal entry (no nesting)",
    JSON.stringify(A.widgetLines["agent-goal"]));
  check(!A.widgetLines["agent-goal"].some((l) => l.includes("└─")), "no nested focus row is rendered");

  // A4 — session restart restores the summary from the persisted entry
  fire(A.handlers, "session_start", {}, A.ctx);
  s = A.entries[A.entries.length - 1].data;
  check(s.goal === "Ship CSV export with passing tests; add ISO-8601 timestamps",
    "restart restores the summary from agent-goal-state", JSON.stringify(s));
  check(goalEntries(A.widgetLines["agent-goal"]).length === 1, "widget restored with one goal entry",
    JSON.stringify(A.widgetLines["agent-goal"]));

  // A5 — the 300-char boundary: exactly 300 is kept, 301 is cut to 300
  await run({ goal: "a".repeat(GOAL_MAX_LEN) });
  s = stateOf(A.entries);
  check(s.goal.length === GOAL_MAX_LEN, `exactly ${GOAL_MAX_LEN} chars is stored as-is`, String(s.goal.length));
  await run({ goal: "b".repeat(GOAL_MAX_LEN + 1) });
  s = stateOf(A.entries);
  check(s.goal.length === GOAL_MAX_LEN && s.goal === "b".repeat(GOAL_MAX_LEN),
    `${GOAL_MAX_LEN + 1} chars is cut to ${GOAL_MAX_LEN}`, String(s.goal.length));
  check(goalEntries(A.widgetLines["agent-goal"]).length === 1,
    "a maximum-length summary is still one widget entry (the TUI wraps it)",
    JSON.stringify(A.widgetLines["agent-goal"].map((l) => l.slice(0, 20))));

  // A6 — an empty string is a legal declaration: no goal left
  fire(A.handlers, "input", { text: "which Node API did you use?", source: "interactive" }, A.ctx);
  const cleared = await run({ goal: "" });
  check(!cleared.details?.error, "empty goal is accepted, not an error", JSON.stringify(cleared));
  s = stateOf(A.entries);
  check(s.goal === null, "empty goal clears the stored line", JSON.stringify(s));
  check(goalEntries(A.widgetLines["agent-goal"]).length === 0, "widget drops the goal entry",
    JSON.stringify(A.widgetLines["agent-goal"]));
  check(JSON.stringify(A.widgetLines["agent-goal"]) === JSON.stringify(["user_prompt: which Node API did you use?"]),
    "user_prompt line survives the clear", JSON.stringify(A.widgetLines["agent-goal"]));

  // A7 — whitespace-only and ANSI-only goals also clear (they carry no text)
  await run({ goal: "  real goal  " });
  await run({ goal: "   " });
  check(stateOf(A.entries).goal === null, "whitespace-only goal clears the line");

  // A8 — ANSI/control bytes are stripped from the stored summary
  await run({ goal: "clean\x1b[31mred\x1b[0m goal" });
  check(stateOf(A.entries).goal === "cleanred goal", "ANSI CSI sequences stripped",
    JSON.stringify(stateOf(A.entries).goal));

  // A9 — a merged summary keeps its first-seen order and its ";" separator
  await run({ goal: "Fix data row 7; rename variables; write README.md" });
  check(stateOf(A.entries).goal === "Fix data row 7; rename variables; write README.md",
    "multiple goals keep the order and separator the agent wrote");
}

// ── scenario B: restore from an entry written by the older contract ───────
console.log(`\n== B: restoring an older session entry ==`);
{
  const oldEntry = {
    type: "custom",
    customType: "agent-goal-state",
    data: { goal: "Create data.txt and summarize.mjs", subGoal: "Fix row 7", goalSetAt: 1, lastPrompt: null, lastPromptAt: null },
  };
  const B = makePI({ initialBranch: [oldEntry] });
  agentGoal(B.pi);
  fire(B.handlers, "session_start", {}, B.ctx);
  const lines = B.widgetLines["agent-goal"];
  check(JSON.stringify(lines) === JSON.stringify(["agent_goal: Create data.txt and summarize.mjs"]),
    "the old goal line is restored", JSON.stringify(lines));
  check(!lines.some((l) => l.includes("Fix row 7") || l.includes("└─")),
    "the dropped subGoal is not rendered");
}

// ── scenario C: clearing with nothing set, and the user_prompt layer ──────
console.log(`\n== C: empty clear and user_prompt display ==`);
{
  const C = makePI();
  agentGoal(C.pi);
  fire(C.handlers, "session_start", {}, C.ctx);
  const g = C.tools["set_goal"];
  const res = await g.execute("c", { goal: "" }, undefined, undefined, C.ctx);
  check(!res.details?.error, "clearing an already-empty goal is legal");
  check(C.widgetLines["agent-goal"] === undefined, "nothing is painted when there is no goal and no prompt",
    JSON.stringify(C.widgetLines["agent-goal"]));

  await g.execute("c", { goal: "prompt display test" }, undefined, undefined, C.ctx);
  fire(C.handlers, "input", { text: "please add escaping logic", source: "interactive" }, C.ctx);
  const lines = C.widgetLines["agent-goal"];
  check(lines && lines[0] === "user_prompt: please add escaping logic",
    "input event renders the user_prompt line", JSON.stringify(lines));
  check(lines[1] === "agent_goal: prompt display test", "goal entry follows the prompt line", JSON.stringify(lines));
  const s = stateOf(C.entries);
  check(s.goal === "prompt display test" && s.lastPrompt === "please add escaping logic",
    "input event updates lastPrompt, never touches the goal");

  fire(C.handlers, "input", { text: "/agent-goal off", source: "interactive" }, C.ctx);
  check(stateOf(C.entries).lastPrompt === "please add escaping logic",
    "a slash command does not become the user_prompt");
}

// ── scenario D: fixed prompt footprint ────────────────────────────────────
console.log(`\n== D: fixed prompt footprint ==`);
{
  const fn = { name: setGoal.name, description: setGoal.description, parameters: setGoal.parameters };
  // The provider receives the OpenAI-shaped wrapper, so the wrapper is part of
  // the fixed text. Some providers also get `"strict": false` inside it.
  const declaration = JSON.stringify({ type: "function", function: fn });
  const declarationWithStrict = JSON.stringify({ type: "function", function: { ...fn, strict: false } });
  const snippetLine = `- ${setGoal.name}: ${setGoal.promptSnippet}`;
  const ruleLines = setGoal.promptGuidelines.map((g) => `- ${g}`).join("\n");
  const total = declaration.length + snippetLine.length + ruleLines.length;
  const totalWithStrict = declarationWithStrict.length + snippetLine.length + ruleLines.length;
  check(total <= FOOTPRINT_MAX_CHARS && totalWithStrict <= FOOTPRINT_MAX_CHARS,
    `declaration+snippet+guidelines = ${total} chars (with "strict":false ${totalWithStrict}; <= ${FOOTPRINT_MAX_CHARS}, chars/4 = ${total / 4})`,
    `declaration ${declaration.length} + snippet ${snippetLine.length} + guidelines ${ruleLines.length}`);
}

// ── scenario E: the shipped instruction surface ───────────────────────────
// A candidate only ever measured through `--extension <temp file>` leaves this
// file untouched and every earlier scenario green, because they all pass a
// temp copy. These assertions read what `index.ts` itself registers, so
// "validated" and "delivered" cannot drift apart silently.
console.log(`\n== E: shipped instruction surface ==`);
{
  const description = setGoal.description ?? "";
  const guidelines = (setGoal.promptGuidelines ?? []).join("\n");
  const surface = `${description}\n${guidelines}`;

  // E1 — the description states WHEN to call, not only what is displayed.
  check(/\bCall\b/.test(description) && /(change|clear|first)/i.test(description),
    "the shipped description says when to call", description);
  // E2 — the rejected trigger must not come back: no "every user message".
  check(!/(each|every)\s+(new\s+)?user message/i.test(surface),
    "the shipped instruction does not restore the update-on-every-message trigger", description);
  // E3 — the three summary rules the approved contract needs are present.
  check(/(merge|fold|incorporat)/i.test(guidelines), "the guideline says to merge added requirements", guidelines);
  check(/(retain|keep|unfinished|open)/i.test(guidelines), "the guideline says to retain unfinished work", guidelines);
  check(/(omit|remove|drop)/i.test(guidelines), "the guideline says to drop finished or cancelled work", guidelines);

  // E4 — the README's cost numbers describe THIS surface, not an older one.
  const readme = fs.readFileSync(path.join(__dirname, "..", "agent", "extensions", "agent-goal", "README.md"), "utf8");
  const fn = { name: setGoal.name, description, parameters: setGoal.parameters };
  const declaration = JSON.stringify({ type: "function", function: fn });
  const snippetLine = `- ${setGoal.name}: ${setGoal.promptSnippet}`;
  const ruleLines = (setGoal.promptGuidelines ?? []).map((g) => `- ${g}`).join("\n");
  const total = declaration.length + snippetLine.length + ruleLines.length;
  check(readme.includes(`${total} 字符`), `the README states the measured ${total} chars`, readme.split("\n").find((l) => l.includes("固定输入")) ?? "");
  check(readme.includes(`${Math.round(total / 4)} token`), `the README states the measured ~${Math.round(total / 4)} tokens`,
    readme.split("\n").find((l) => l.includes("固定输入")) ?? "");
}

console.log(`\n===== unit: ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
