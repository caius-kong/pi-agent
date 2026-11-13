#!/usr/bin/env node
/**
 * agent-goal eval — verifies that the set_goal CONTRACT + tool schema produce the
 * intended instruction behavior on a REAL model (via headless pi sessions).
 *
 * The user's mental model has TWO goal-change categories:
 *   1. NEW goal      — brand-new task, or a task pivot (i.e. "new").
 *   2. REWRITE goal  — the goal text itself needs to grow/expand during the
 *                      conversation (add requirement/constraint) while the core
 *                      outcome stays the same. (This is the case the old contract
 *                      failed: agent_goal became {sub-task1} instead of staying
 *                      anchored on task1.)
 * Plus boundary conditions the contract must also police:
 *   3. EXPAND        — drilling into a sub-task of the declared goal must NOT
 *                      replace the parent goal with the sub-task's name.
 *   4. KEEP/no-call  — a mere step inside the goal needs no call at all.
 *
 * Each scenario runs real headless `pi` sessions with ONLY the agent-goal
 * extension's set_goal tool active (no built-in tools, no skills/context files),
 * so the model sees the injected CONTRACT + the set_goal tool and nothing else.
 * Scenarios are simulated conversations ("we are building feature X") so the
 * model is never tempted to explore files — its only job is goal management.
 * We then parse the session JSONL for:
 *   - the sequence of set_goal tool calls (mode + goal text)
 *   - the final persisted agent-goal-state custom entry
 * and assert per-scenario expected behavior. This is a behavioral eval of the
 * instruction, not a unit test of the state machine.
 *
 * Usage: node run-eval.cjs [--keep] [--scenario sX,sY]
 *   --keep       keep session dirs (default: wipe before/after)
 *   --scenario   comma-separated scenario ids to run (default: all)
 * Exit: 0 if all scenarios pass, 1 otherwise.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(process.env.HOME, ".pi/agent/extensions/agent-goal.ts");
const ROOT = "/tmp/ag-eval";
const SESS_DIR = path.join(ROOT, "sessions");
const WORK_DIR = path.join(ROOT, "work");
const MODELS = JSON.parse(process.env.AG_EVAL_MODELS || JSON.stringify(["deepseek-v4-flash-0731-gmi-ray", "deepseek-v4-pro"]));

let keep = process.argv.includes("--keep");
let only = null;
{
  const idx = process.argv.indexOf("--scenario");
  if (idx !== -1) only = new Set((process.argv[idx + 1] || "").split(",").filter(Boolean));
}

// A shared simulation preamble that fixes the model's context: we are working on
// a fictional app; the ONLY available tool is set_goal; reply tersely.
const PREAMBLE =
  "You are simulating a working session on a fictional project. Your ONLY available tool is set_goal. " +
  "On every user turn, use set_goal exactly when the displayed goal should change per its contract " +
  "(new goal / rewrite same goal / expand into a sub-task / or leave unchanged), then reply with one short line. " +
  "Do not try to explore files, run code, or call any other tool.";

// ── helpers ───────────────────────────────────────────────────────────────

function cleanText(s) {
  return (s || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
}

function readSession(scenarioId) {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.includes(scenarioId) && f.endsWith(".jsonl")); } catch {}
  if (!files.length) return [];
  files.sort();
  const f = path.join(SESS_DIR, files[files.length - 1]);
  const out = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function summarize(scenarioId) {
  const entries = readSession(scenarioId);
  const goalCalls = [];
  let finalState = null;
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c.type === "toolCall" && (c.toolName ?? c.name) === "set_goal") {
          goalCalls.push({ mode: c.arguments?.mode ?? "new", goal: cleanText(c.arguments?.goal) });
        }
      }
    }
    if (e.type === "custom" && e.customType === "agent-goal-state" && e.data) {
      finalState = { goal: cleanText(e.data.goal), subGoal: cleanText(e.data.subGoal) };
    }
  }
  return { goalCalls, finalState };
}

const PASS = (label) => { console.log(`  ✓ ${label}`); return 1; };
const FAIL = (label) => { console.log(`  ✗ ${label}`); return 0; };

// ── scenario definitions ──────────────────────────────────────────────────

const scenarios = [
  // ── NEW: task start ────────────────────────────────────────────────
  {
    id: "s1-new-start",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
    ],
    check({ goalCalls, finalState }) {
      let ok = true;
      const first = goalCalls[0];
      if (first && first.mode === "new") ok = ok && PASS(`first set_goal uses mode:"new"`);
      else ok = ok && FAIL(`first set_goal mode is new (got ${first ? first.mode : "no call"})`);
      if (first && /csv|export/i.test(first.goal)) ok = ok && PASS(`goal text mentions csv/export`);
      else ok = ok && FAIL(`goal text mentions csv/export (got "${first ? first.goal : ""}")`);
      if (finalState && /csv|export/i.test(finalState.goal)) ok = ok && PASS(`persisted goal anchored on csv/export`);
      else ok = ok && FAIL(`persisted goal anchored on csv/export (got "${finalState && finalState.goal}")`);
      return ok;
    },
  },

  // ── REWRITE: goal text grows mid-conversation ──────────────────────
  {
    id: "s2-rewrite-grow",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: Also, the export must now additionally support ISO-8601 timestamps and a BOM for Excel — add that to the goal.",
    ],
    check({ goalCalls, finalState }) {
      let ok = true;
      const [first, second] = goalCalls;
      if (!first) return FAIL("aborted: no initial set_goal call");
      if (second && second.mode === "rewrite") ok = ok && PASS(`2nd call uses mode:"rewrite" (same goal, text grew)`);
      else ok = ok && FAIL(`2nd call uses mode:"rewrite" (got ${second ? second.mode : "no call"})`);
      if (second && /iso-?8601|bom|excel/i.test(second.goal)) ok = ok && PASS(`rewritten goal mentions new constraint`);
      else ok = ok && FAIL(`rewritten goal mentions new constraint (got "${second ? second.goal : ""}")`);
      if (finalState && /csv|export/i.test(finalState.goal)) ok = ok && PASS(`persisted goal STILL anchored on csv/export (core kept)`);
      else ok = ok && FAIL(`persisted goal STILL anchored on csv/export (got "${finalState && finalState.goal}")`);
      return ok;
    },
  },

  // ── EXPAND: sub-task drill must NOT replace parent ─────────────────
  {
    id: "s3-expand-subtask",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: While working on it I realize we first need to fix the date-column formatting — a sub-problem of the export. Get on that.",
    ],
    check({ goalCalls, finalState }) {
      let ok = true;
      const [first, second] = goalCalls;
      if (!first) return FAIL("aborted: no initial set_goal call");
      // The exact user complaint: agent_goal must NOT become {sub-task1}.
      if (!second) ok = ok && PASS("2nd turn made no goal call (KEEP — acceptable)");
      else if (second.mode === "expand") ok = ok && PASS(`2nd call uses mode:"expand" (sub-task focus nested)`);
      else ok = ok && FAIL(`2nd call must NOT replace goal for a sub-task; got mode:"${second.mode}" goal="${second.goal}"`);
      // Regardless, the PERSISTED parent goal must stay on csv/export.
      if (finalState && /csv|export/i.test(finalState.goal)) ok = ok && PASS(`persisted goal STILL csv/export (parent not clobbered — core bug fixed)`);
      else ok = ok && FAIL(`persisted goal was clobbered, got "${finalState && finalState.goal}"`);
      if (second && second.mode === "expand") {
        if (finalState && finalState.subGoal && /date/i.test(finalState.subGoal)) ok = ok && PASS(`nested sub-goal mentions the date sub-task`);
        else ok = ok && FAIL(`nested sub-goal mentions the date sub-task (got "${finalState && finalState.subGoal}")`);
      }
      return ok;
    },
  },

  // ── KEEP: a mere step needs no call ────────────────────────────────
  {
    id: "s4-keep-step",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: Create the utils module for the escaping logic (just a step of the goal).",
    ],
    check({ goalCalls, finalState }) {
      let ok = true;
      const [first, second] = goalCalls;
      if (!first) return FAIL("aborted: no initial set_goal call");
      if (!second) ok = ok && PASS("2nd turn made no goal call (a step is KEEP, no call)");
      else if (second.mode === "expand") ok = ok && PASS(`2nd call expand is acceptable but not required`);
      else ok = ok && FAIL(`step must not trigger a goal rewrite; got mode:"${second.mode}"`);
      return ok;
    },
  },

  // ── NEW via pivot: abandoning task1 for task2 ──────────────────────
  {
    id: "s5-pivot-new",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: Actually, drop the export feature entirely. We now need to build a CLI arg parser instead. Update the goal.",
    ],
    check({ goalCalls, finalState }) {
      let ok = true;
      const [first, second] = goalCalls;
      if (!first) return FAIL("aborted: no initial set_goal call");
      if (second && second.mode === "new") ok = ok && PASS(`2nd call uses mode:"new" (pivot = new goal)`);
      else ok = ok && FAIL(`pivot must replace goal via mode:"new" (got ${second ? second.mode : "no call"})`);
      if (second && /cli|arg\s*parser/i.test(second.goal)) ok = ok && PASS(`pivoted goal mentions cli/arg parser`);
      else ok = ok && FAIL(`pivoted goal mentions cli/arg parser (got "${second ? second.goal : ""}")`);
      if (finalState && !/csv/i.test(finalState.goal || "")) ok = ok && PASS(`persisted goal no longer csv (abandoned)`);
      else ok = ok && FAIL(`persisted goal should have dropped csv (got "${finalState && finalState.goal}")`);
      return ok;
    },
  },
];

// ── runner ────────────────────────────────────────────────────────────────

function runPi(workDir, sessionId, prompt, modelIdx = 0) {
  if (modelIdx >= MODELS.length) throw new Error("all models failed to start");
  const args = [
    "-p",
    "--session-dir", SESS_DIR,
    "--session-id", sessionId, // reusing the same id continues the session
    "--no-skills",
    "--no-context-files",
    "--no-themes",
    "--no-builtin-tools",
    "-e", EXT,
    "--tools", "set_goal",
    "--approve",
    "--thinking", "low",
    "--model", MODELS[modelIdx],
    "--",
  ];
  const r = spawnSync("pi", [...args, prompt], {
    cwd: workDir,
    env: { ...process.env, PI_NO_TELEMETRY: "1" },
    timeout: 300000,
    encoding: "utf8",
  });
  if (r.status !== 0 && !/Ready for input/.test(r.stdout || "")) {
    if (/NO_API_KEY|401|403|quota|429|model not found/i.test(r.stderr + r.stdout)) {
      return runPi(workDir, sessionId, prompt, modelIdx + 1);
    }
    console.error(`  [pi exit ${r.status}] ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  return r;
}

function runScenario(sc) {
  console.log(`\n== ${sc.id} ==`);
  try {
    for (const f of fs.readdirSync(SESS_DIR)) {
      if (f.includes(sc.id) && f.endsWith(".jsonl")) fs.rmSync(path.join(SESS_DIR, f), { force: true });
    }
  } catch {}
  for (let i = 0; i < sc.turns.length; i++) {
    const r = runPi(WORK_DIR, sc.id, sc.turns[i]);
    if (r.status !== 0 && /Ready for input/.test(r.stdout || "")) {
      // treat "ready" as success even on odd exit
    } else if (r.status !== 0) {
      console.error(`  ✗ turn ${i + 1} pi failed (${r.status})`);
      return false;
    }
  }
  const ctx = summarize(sc.id);
  return sc.check(ctx);
}

function main() {
  const toRun = scenarios.filter((s) => (only ? only.has(s.id) : true));
  let passed = 0, failed = 0;
  if (!keep) {
    try { fs.rmSync(SESS_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(SESS_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  for (const sc of toRun) {
    try {
      if (runScenario(sc)) passed++; else failed++;
    } catch (e) {
      console.error(`  ✗ scenario ${sc.id} threw: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n===== ${passed}/${passed + failed} scenarios passed =====`);
  if (!keep) {
    try { fs.rmSync(SESS_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
  }
  process.exit(failed ? 1 : 0);
}

main();