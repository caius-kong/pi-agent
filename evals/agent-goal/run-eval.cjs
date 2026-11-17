#!/usr/bin/env node
/**
 * agent-goal eval — end-to-end behavior of the display layer on a REAL model.
 *
 * Two layers are asserted for every scenario:
 *   1. DISPLAY — `extension_ui_request` records (`setWidget` for key "agent-goal",
 *      `setStatus` for key "agent-status") as Pi actually emits them to a client.
 *   2. STATE   — the session JSONL: the `set_goal` call sequence and the last
 *      `agent-goal-state` custom entry.
 *
 * Behavior scenarios run in RPC mode (`pi --mode rpc`): `ctx.hasUI` is true there,
 * so `set_goal` is declared and the widget/status calls really happen. Print mode
 * (`-p`) has no UI, which is now its own scenario: the tool must be invisible to
 * the provider there.
 *
 * A generated probe extension records every provider payload
 * (`before_provider_request`), so "the provider never saw set_goal" is asserted on
 * the actual request, not inferred from behavior.
 *
 * Every scenario runs its own session with only this extension loaded.
 *
 * Usage: node run-eval.cjs [--keep] [--scenario s1,s3] [--model <id>]
 *   --keep      keep session dirs and payload logs (default: wiped before/after)
 *   --scenario  comma-separated scenario ids (default: all)
 *   --model     override the model id (default: $AG_EVAL_MODEL or the cheap default)
 * Exit: 0 if all scenarios pass, 1 otherwise.
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(process.env.HOME, ".pi/agent/extensions/agent-goal/index.ts");
const ROOT = "/tmp/ag-eval";
const SESS_DIR = path.join(ROOT, "sessions");
const WORK_DIR = path.join(ROOT, "work");
const PROBE = path.join(ROOT, "probe.ts");
const PAYLOAD_DIR = path.join(ROOT, "payloads");

// Default model for the eval: the cheap flash model. Override with
// AG_EVAL_MODELS='[...]' or --model when a different model needs checking.
const MODELS = process.env.AG_EVAL_MODELS
  ? JSON.parse(process.env.AG_EVAL_MODELS)
  : ["trendmicro/deepseek-v4.1-flash"];
const BUDGET_USD = 5;
const TURN_TIMEOUT_MS = 240000;

let keep = process.argv.includes("--keep");
let only = null;
{
  const idx = process.argv.indexOf("--scenario");
  if (idx !== -1) only = new Set((process.argv[idx + 1] || "").split(",").filter(Boolean));
}
const modelArg = process.argv.indexOf("--model");
const MODELS_TO_RUN = modelArg !== -1 ? [process.argv[modelArg + 1]] : MODELS;

const PREAMBLE =
  "You are simulating a working session on a fictional project; your only tool is set_goal. " +
  "Use set_goal per its guidelines when the displayed goal should change, then reply with one short line. " +
  "Do not explore files or run code.";

// ── probe extension (records the provider payload) ────────────────────────
const PROBE_SOURCE = `
import fs from "node:fs";

export default function agentGoalEvalProbe(pi: any) {
  pi.on("before_provider_request", (event: any) => {
    const target = process.env.AG_EVAL_PAYLOAD_LOG;
    if (!target) return;
    try {
      fs.appendFileSync(target, JSON.stringify({ payload: event.payload }) + "\\n");
    } catch {}
  });
}
`;

// ── helpers ───────────────────────────────────────────────────────────────

function cleanText(s) {
  return (s || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
}

function stripAnsiDeep(value) {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(stripAnsiDeep);
  return value;
}

function sessionFiles(scenarioId) {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.includes(scenarioId) && f.endsWith(".jsonl")); } catch {}
  files.sort();
  return files.map((f) => path.join(SESS_DIR, f));
}

function readSession(scenarioId) {
  const files = sessionFiles(scenarioId);
  if (!files.length) return [];
  const out = [];
  for (const line of fs.readFileSync(files[files.length - 1], "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return out;
}

function summarizeState(scenarioId) {
  const entries = readSession(scenarioId);
  const goalCalls = [];
  let finalState = null;
  let providerResponses = 0;
  let costUsd = 0;
  const modelErrors = [];
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "assistant") {
      providerResponses++;
      const usage = e.message.usage;
      costUsd += usage?.cost?.total ?? (typeof usage?.cost === "number" ? usage.cost : 0);
      if (e.message.stopReason === "error") modelErrors.push(cleanText(e.message.errorMessage).slice(0, 200));
      for (const c of e.message.content ?? []) {
        if (c.type === "toolCall" && (c.toolName ?? c.name) === "set_goal") {
          goalCalls.push({ mode: c.arguments?.mode ?? "new", goal: cleanText(c.arguments?.goal) });
        }
      }
    }
    if (e.type === "custom" && e.customType === "agent-goal-state" && e.data) {
      finalState = { goal: cleanText(e.data.goal), subGoal: cleanText(e.data.subGoal) };
    }
  }
  return { goalCalls, finalState, providerResponses, costUsd, modelErrors };
}

/**
 * A provider rejection (bad model id, revoked key) is not a scenario failure: it
 * must surface as a thrown error so `main()` falls back to the next model instead
 * of reporting the scenario as broken.
 */
function assertModelUsable(state) {
  if (state.modelErrors.length > 0) throw new Error(`model error: ${state.modelErrors[0]}`);
}

function readPayloads(scenarioId) {
  const file = path.join(PAYLOAD_DIR, `${scenarioId}.jsonl`);
  const out = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line).payload); } catch { /* torn tail */ }
    }
  } catch {}
  return out;
}

/**
 * The part of a provider payload that declares tools and instructions: the tool
 * declarations and the system prompt (a top-level `system` field for some APIs,
 * a `role: "system"` message for OpenAI-compatible ones). Conversation text is
 * excluded — the eval's own prompt names the tool.
 */
function payloadToolSurface(payload) {
  const parts = [];
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  if (payload.system) parts.push(typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system));
  for (const message of payload.messages ?? []) {
    if (message.role !== "system") continue;
    parts.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  }
  return parts.join("\n");
}

function payloadMentionsSetGoal(payload) {
  return /set_goal/.test(payloadToolSurface(payload));
}

/** Display-layer timeline from `extension_ui_request` records. */
function widgetStates(records) {
  return records
    .filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal")
    .map((r) => stripAnsiDeep(r.widgetLines));
}
function statusStates(records) {
  return records
    .filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "agent-status")
    .map((r) => (r.statusText === undefined ? undefined : cleanText(r.statusText)));
}
const lastOf = (list) => (list.length ? list[list.length - 1] : undefined);

const PASS = (label) => { console.log(`  ✓ ${label}`); return true; };
const FAIL = (label) => { console.log(`  ✗ ${label}`); return false; };

// ── RPC client ────────────────────────────────────────────────────────────

function rpcArgs(scenarioId, model, payloadLog) {
  return [
    "--mode", "rpc",
    "--session-dir", SESS_DIR,
    "--session-id", scenarioId,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-themes",
    "--no-builtin-tools",
    "-e", EXT,
    "-e", PROBE,
    "--tools", "set_goal",
    "--approve",
    "--thinking", "low",
    "--model", model,
  ];
}

function startRpc(scenarioId, model) {
  const payloadLog = path.join(PAYLOAD_DIR, `${scenarioId}.jsonl`);
  fs.rmSync(payloadLog, { force: true });
  const proc = spawn("pi", rpcArgs(scenarioId, model, payloadLog), {
    cwd: WORK_DIR,
    env: { ...process.env, PI_NO_TELEMETRY: "1", AG_EVAL_PAYLOAD_LOG: payloadLog },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  const waiters = [];
  let buffer = "";
  let stderr = "";
  let exited = null;

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    // Strict JSONL framing: split on LF only (never on U+2028/U+2029).
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      records.push(record);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(record, records)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(record);
        }
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  proc.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`pi exited (${code}/${signal}) while waiting for ${waiter.label}\n${stderr.slice(-800)}`));
  });

  function waitFor(predicate, label, timeoutMs = TURN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label}\n${stderr.slice(-800)}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, label, timer });
    });
  }

  const send = (command) => proc.stdin.write(`${JSON.stringify(command)}\n`);

  async function turn(message) {
    const id = `req-${records.length}-${Math.random().toString(36).slice(2, 7)}`;
    const settledTarget = records.filter((r) => r.type === "agent_settled").length + 1;
    const settled = waitFor(
      (_record, all) => all.filter((r) => r.type === "agent_settled").length >= settledTarget,
      `agent_settled after "${message.slice(0, 40)}"`,
    );
    settled.catch(() => {});
    send({ id, type: "prompt", message });
    const response = await waitFor((r) => r.type === "response" && r.id === id, `response to "${message.slice(0, 40)}"`, 60000);
    if (!response.success) throw new Error(`prompt rejected: ${response.error}`);
    const disposition = response.data?.disposition;
    if (disposition === "handled") {
      settled.catch(() => {});
      return disposition;
    }
    await settled;
    return disposition;
  }

  async function close() {
    proc.stdin.end();
    await new Promise((resolve) => {
      if (exited) return resolve();
      const timer = setTimeout(() => { proc.kill("SIGTERM"); resolve(); }, 20000);
      proc.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  return { proc, records, send, turn, waitFor, close, stderr: () => stderr };
}

// ── scenario definitions ──────────────────────────────────────────────────

const scenarios = [
  {
    id: "s1-first-prompt",
    turns: [PREAMBLE + "\nUser: We need to add CSV export to our app. Go."],
    check({ records }) {
      let ok = true;
      const widgets = widgetStates(records);
      const promptLine = widgets.flat().filter((l) => typeof l === "string").find((l) => l.startsWith("user_prompt:"));
      ok = (promptLine && /csv export/i.test(promptLine)
        ? PASS(`display: widget shows "${promptLine.slice(0, 60)}"`)
        : FAIL(`display: widget shows the user_prompt line (got ${JSON.stringify(widgets)}`)) && ok;
      return ok;
    },
  },

  {
    id: "s2-new-start",
    turns: [PREAMBLE + "\nUser: We need to add CSV export to our app. Go."],
    check({ records, state }) {
      let ok = true;
      const widgets = widgetStates(records);
      const statuses = statusStates(records);
      const goalLine = widgets.flat().filter((l) => typeof l === "string").find((l) => l.startsWith("agent_goal:"));
      ok = (goalLine && /csv|export/i.test(goalLine)
        ? PASS(`display: agent_goal line "${goalLine.slice(0, 60)}"`)
        : FAIL(`display: agent_goal line for the new outcome (got ${JSON.stringify(widgets.slice(-1))})`)) && ok;
      const footer = statuses.filter(Boolean).pop();
      ok = (footer && footer.includes("⛳")
        ? PASS(`display: footer status "${footer.slice(0, 40)}"`)
        : FAIL(`display: footer status with ⛳ (got ${JSON.stringify(statuses)})`)) && ok;
      const first = state.goalCalls[0];
      ok = (first && first.mode === "new"
        ? PASS(`state: first set_goal uses mode:"new"`)
        : FAIL(`state: first set_goal mode is new (got ${first ? first.mode : "no call"})`)) && ok;
      ok = (state.finalState && /csv|export/i.test(state.finalState.goal || "")
        ? PASS(`state: persisted goal "${state.finalState.goal.slice(0, 50)}"`)
        : FAIL(`state: persisted goal anchored on csv/export (got ${JSON.stringify(state.finalState)})`)) && ok;
      return ok;
    },
  },

  {
    id: "s3-rewrite",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: Also, the export must now additionally support ISO-8601 timestamps and a BOM for Excel — add that to the goal.",
    ],
    check({ records, state }) {
      let ok = true;
      const [first, second] = state.goalCalls;
      if (!first) return FAIL("state: no initial set_goal call");
      ok = (second && second.mode === "rewrite"
        ? PASS(`state: 2nd call mode:"rewrite"`)
        : FAIL(`state: 2nd call mode is rewrite (got ${second ? second.mode : "no call"})`)) && ok;
      ok = (second && /iso-?8601|bom|excel/i.test(second.goal)
        ? PASS(`state: rewritten goal "${second.goal.slice(0, 60)}"`)
        : FAIL(`state: rewritten goal mentions the new constraint (got ${second ? second.goal : ""})`)) && ok;
      ok = (state.finalState && /csv|export/i.test(state.finalState.goal || "")
        ? PASS(`state: core outcome kept ("${state.finalState.goal.slice(0, 50)}")`)
        : FAIL(`state: core outcome kept (got ${JSON.stringify(state.finalState)})`)) && ok;
      const widgets = widgetStates(records);
      const goalLines = widgets.flat().filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
      ok = (goalLines.length >= 2
        ? PASS(`display: goal line was replaced (${goalLines.length} distinct renders)`)
        : FAIL(`display: goal line was replaced (got ${JSON.stringify(goalLines)})`)) && ok;
      return ok;
    },
  },

  {
    id: "s4-expand",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: While working on it I realize we first need to fix the date-column formatting — a sub-problem of the export. Get on that.",
    ],
    check({ records, state }) {
      let ok = true;
      const [first, second] = state.goalCalls;
      if (!first) return FAIL("state: no initial set_goal call");
      if (!second) ok = PASS("state: 2nd turn made no goal call (allowed)") && ok;
      else if (second.mode === "expand") ok = PASS(`state: 2nd call mode:"expand"`) && ok;
      else ok = FAIL(`state: a sub-problem must not replace the goal; got mode:"${second.mode}" goal="${second.goal}"`) && ok;
      ok = (state.finalState && /csv|export/i.test(state.finalState.goal || "")
        ? PASS(`state: parent goal unchanged ("${state.finalState.goal.slice(0, 50)}")`)
        : FAIL(`state: parent goal unchanged (got ${JSON.stringify(state.finalState)})`)) && ok;
      if (second && second.mode === "expand") {
        ok = (state.finalState && /date/i.test(state.finalState.subGoal || "")
          ? PASS(`state: nested focus "${state.finalState.subGoal}"`)
          : FAIL(`state: nested focus mentions the date sub-problem (got ${JSON.stringify(state.finalState)})`)) && ok;
        const nested = widgetStates(records).flat().filter((l) => typeof l === "string" && l.includes("└─"));
        ok = (nested.length > 0
          ? PASS(`display: nested row "${nested[nested.length - 1].trim().slice(0, 50)}"`)
          : FAIL(`display: nested └─ row appears`)) && ok;
      }
      return ok;
    },
  },

  {
    id: "s5-pivot",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: Actually, drop the export feature entirely. We now need to build a CLI arg parser instead. Update the goal.",
    ],
    check({ records, state }) {
      let ok = true;
      const [first, second] = state.goalCalls;
      if (!first) return FAIL("state: no initial set_goal call");
      ok = (second && second.mode === "new"
        ? PASS(`state: pivot uses mode:"new"`)
        : FAIL(`state: pivot uses mode:"new" (got ${second ? second.mode : "no call"})`)) && ok;
      ok = (second && /cli|arg\s*parser/i.test(second.goal)
        ? PASS(`state: pivoted goal "${second.goal.slice(0, 60)}"`)
        : FAIL(`state: pivoted goal mentions cli/arg parser (got ${second ? second.goal : ""})`)) && ok;
      // The outcome must no longer be the export; naming the abandoned feature in
      // passing ("CSV export dropped") is fine, but a goal that keeps pursuing it
      // ("build a CLI parser, keep the CSV export too") is not.
      const stillExport = (goal) =>
        /add(ing)? csv export|export to our app|keep[^.]{0,24}(csv|export)/i.test(goal || "");
      ok = (state.finalState && !stillExport(state.finalState.goal) && /cli|arg\s*parser/i.test(state.finalState.goal || "")
        ? PASS(`state: old outcome replaced ("${(state.finalState.goal || "").slice(0, 50)}")`)
        : FAIL(`state: old outcome replaced (got ${JSON.stringify(state.finalState)})`)) && ok;
      const goalLines = widgetStates(records).flat().filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
      const lastGoalLine = goalLines[goalLines.length - 1] ?? "";
      ok = (goalLines.length > 0 && !stillExport(lastGoalLine) && /cli|arg\s*parser/i.test(lastGoalLine)
        ? PASS("display: last agent_goal line states the new outcome")
        : FAIL(`display: last agent_goal line states the new outcome (got ${JSON.stringify(goalLines.slice(-1))})`)) && ok;
      return ok;
    },
  },

  {
    id: "s6-step",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "User: Create the utils module for the escaping logic (just a step of the goal).",
    ],
    check({ state }) {
      let ok = true;
      const [first, second] = state.goalCalls;
      if (!first) return FAIL("state: no initial set_goal call");
      if (!second) ok = PASS("state: a step made no goal call") && ok;
      else if (second.mode === "expand") ok = PASS("state: a step call was an expand (allowed, not required)") && ok;
      else ok = FAIL(`state: a mere step must not rewrite the goal; got mode:"${second.mode}"`) && ok;
      return ok;
    },
  },

  {
    id: "s7-toggle",
    turns: [
      PREAMBLE + "\nUser: We need to add CSV export to our app. Go.",
      "/agent-goal off",
      "User: keep going, just a step.",
      "/agent-goal on",
      "User: Now continue with the export work.",
    ],
    check({ records, turnPayloads }) {
      let ok = true;
      const widgets = widgetStates(records);
      const statuses = statusStates(records);
      const offIndex = widgets.findIndex((lines) => lines === undefined);
      ok = (offIndex !== -1
        ? PASS("display: /agent-goal off cleared the widget")
        : FAIL(`display: /agent-goal off cleared the widget (got ${JSON.stringify(widgets)})`)) && ok;
      const clearedStatus = statuses.findIndex((text) => text === undefined);
      ok = (clearedStatus !== -1
        ? PASS("display: /agent-goal off cleared the footer status")
        : FAIL(`display: /agent-goal off cleared the footer status (got ${JSON.stringify(statuses)})`)) && ok;
      const lastWidget = lastOf(widgets);
      ok = (lastWidget && lastWidget.some((l) => String(l).startsWith("agent_goal:"))
        ? PASS(`display: /agent-goal on restored "${lastWidget.find((l) => String(l).startsWith("agent_goal:")).slice(0, 50)}"`)
        : FAIL(`display: /agent-goal on restored the goal line (got ${JSON.stringify(lastWidget)})`)) && ok;
      const lastStatus = lastOf(statuses);
      ok = (lastStatus && lastStatus.includes("⛳")
        ? PASS("display: /agent-goal on restored the footer status")
        : FAIL(`display: /agent-goal on restored the footer status (got ${JSON.stringify(lastStatus)})`)) && ok;
      // The turn that ran while OFF must not have shown the tool to the provider.
      const offPayloads = turnPayloads[2] ?? [];
      ok = (offPayloads.length > 0 && offPayloads.every((p) => !payloadMentionsSetGoal(p))
        ? PASS(`provider: no set_goal declaration/rules in the ${offPayloads.length} request(s) while OFF`)
        : FAIL(`provider: no set_goal in requests while OFF (${offPayloads.filter(payloadMentionsSetGoal).length}/${offPayloads.length} leaked)`)) && ok;
      const onPayloads = turnPayloads[4] ?? [];
      ok = (onPayloads.length > 0 && onPayloads.every((p) => payloadMentionsSetGoal(p))
        ? PASS(`provider: set_goal declared again in the ${onPayloads.length} request(s) after /agent-goal on`)
        : FAIL(`provider: set_goal declared again after /agent-goal on (${onPayloads.filter((p) => !payloadMentionsSetGoal(p)).length}/${onPayloads.length} missing)`)) && ok;
      return ok;
    },
  },

  {
    id: "s8-headless",
    headless: true,
    // No simulation preamble here: it names the tool, and a prompt that names a
    // tool is not evidence about what the provider declared. A neutral task prompt
    // is what a real headless run looks like.
    turns: ["We need to add CSV export to our app. Go."],
    check({ state, payloads, headless }) {
      let ok = true;
      ok = (headless.status === 0
        ? PASS("headless: pi -p finished")
        : FAIL(`headless: pi -p exit ${headless.status} — ${headless.stderr.slice(-300)}`)) && ok;
      ok = (payloads.length > 0
        ? PASS(`headless: captured ${payloads.length} provider payload(s)`)
        : FAIL("headless: captured a provider payload")) && ok;
      const leaked = payloads.filter(payloadMentionsSetGoal).length;
      ok = (payloads.length > 0 && leaked === 0
        ? PASS("headless: provider payload has no set_goal declaration, snippet or rule")
        : FAIL(`headless: provider payload has no set_goal (${leaked}/${payloads.length} leaked)`)) && ok;
      ok = (state.goalCalls.length === 0
        ? PASS("headless: the model made no set_goal call")
        : FAIL(`headless: the model made ${state.goalCalls.length} set_goal call(s)`)) && ok;
      return ok;
    },
  },
];

// ── runner ────────────────────────────────────────────────────────────────

function wipeScenarioSession(scenarioId) {
  for (const file of sessionFiles(scenarioId)) fs.rmSync(file, { force: true });
}

async function runRpcScenario(sc, model) {
  wipeScenarioSession(sc.id);
  const rpc = startRpc(sc.id, model);
  try {
    const turnPayloads = [];
    let seen = 0;
    for (const turn of sc.turns) {
      await rpc.turn(turn);
      const all = readPayloads(sc.id);
      turnPayloads.push(all.slice(seen));
      seen = all.length;
    }
    const state = summarizeState(sc.id);
    assertModelUsable(state);
    return {
      records: rpc.records,
      payloads: readPayloads(sc.id),
      turnPayloads,
      state,
    };
  } finally {
    await rpc.close();
  }
}

function runHeadlessScenario(sc, model) {
  wipeScenarioSession(sc.id);
  const payloadLog = path.join(PAYLOAD_DIR, `${sc.id}.jsonl`);
  fs.rmSync(payloadLog, { force: true });
  const args = [
    "-p",
    "--session-dir", SESS_DIR,
    "--session-id", sc.id,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-themes",
    "--no-builtin-tools",
    "-e", EXT,
    "-e", PROBE,
    "--tools", "set_goal",
    "--approve",
    "--thinking", "low",
    "--model", model,
    "--",
  ];
  const result = spawnSync("pi", [...args, ...sc.turns], {
    cwd: WORK_DIR,
    env: { ...process.env, PI_NO_TELEMETRY: "1", AG_EVAL_PAYLOAD_LOG: payloadLog },
    timeout: TURN_TIMEOUT_MS,
    encoding: "utf8",
  });
  const state = summarizeState(sc.id);
  assertModelUsable(state);
  return {
    records: [],
    payloads: readPayloads(sc.id),
    state,
    headless: { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" },
  };
}

async function main() {
  const toRun = scenarios.filter((s) => (only ? only.has(s.id) : true));
  if (!keep) {
    try { fs.rmSync(SESS_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(PAYLOAD_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(SESS_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  fs.writeFileSync(PROBE, PROBE_SOURCE);

  let passed = 0;
  let failed = 0;
  let totalCost = 0;
  let totalResponses = 0;
  const perScenario = [];

  for (const sc of toRun) {
    console.log(`\n== ${sc.id} ==`);
    let result = null;
    let modelUsed = MODELS_TO_RUN[0];
    for (const model of MODELS_TO_RUN) {
      try {
        result = sc.headless ? runHeadlessScenario(sc, model) : await runRpcScenario(sc, model);
        modelUsed = model;
        break;
      } catch (e) {
        console.error(`  [${model}] ${String(e.message || e).split("\n")[0]}`);
      }
    }
    if (!result) {
      console.log("  ✗ scenario could not run on any configured model");
      failed++;
      perScenario.push({ id: sc.id, ok: false, model: modelUsed, costUsd: 0, responses: 0, display: null });
      continue;
    }

    const cost = result.state.costUsd;
    totalCost += cost;
    totalResponses += result.state.providerResponses;
    let ok = false;
    try {
      ok = sc.check(result) !== false;
    } catch (e) {
      console.log(`  ✗ scenario threw: ${e.message}`);
      ok = false;
    }
    ok ? passed++ : failed++;
    perScenario.push({
      id: sc.id,
      ok,
      model: modelUsed,
      costUsd: cost,
      responses: result.state.providerResponses,
      display: {
        widget: lastOf(widgetStates(result.records)) ?? null,
        status: lastOf(statusStates(result.records)) ?? null,
        payloads: result.payloads.length,
      },
      calls: result.state.goalCalls,
    });
    if (totalCost > BUDGET_USD) {
      console.log(`\n!! budget exceeded: $${totalCost.toFixed(4)} > $${BUDGET_USD} — stopping`);
      failed += toRun.length - (passed + failed);
      break;
    }
  }

  console.log(`\n===== ${passed}/${passed + failed} scenarios passed =====`);
  console.log(`model responses: ${totalResponses} · reported cost: $${totalCost.toFixed(4)}`);
  for (const row of perScenario) {
    console.log(`  ${row.ok ? "PASS" : "FAIL"} ${row.id} · ${row.model} · ${row.responses} response(s) · $${row.costUsd.toFixed(4)}`);
    if (row.display) {
      console.log(`       widget: ${JSON.stringify(row.display.widget)}`);
      console.log(`       status: ${JSON.stringify(row.display.status)}`);
      console.log(`       set_goal calls: ${JSON.stringify(row.calls)}`);
    }
  }

  if (!keep) {
    try { fs.rmSync(SESS_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(PAYLOAD_DIR, { recursive: true, force: true }); } catch {}
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
