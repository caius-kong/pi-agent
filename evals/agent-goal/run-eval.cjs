#!/usr/bin/env node
/**
 * agent-goal eval — end-to-end behavior of the display layer on a REAL model.
 *
 * Two layers are asserted for every scenario:
 *   1. DISPLAY — `extension_ui_request` records (`setWidget` for key "agent-goal";
 *      the extension must not write the footer status line at all) as Pi
 *      actually emits them to a client.
 *   2. STATE   — the session JSONL: the `set_goal` call sequence and the last
 *      `agent-goal-state` custom entry.
 *
 * The user messages are the whole prompt: no eval preamble, nothing that names
 * set_goal and nothing that tells the model when the summary should change. Only
 * `set_goal` is declared here (`--no-builtin-tools`), so this is the cheap
 * scripted half of the check; `run-acceptance.cjs` is the one that runs a real
 * agent with its own tools.
 *
 * Behavior scenarios run in RPC mode (`pi --mode rpc`): `ctx.hasUI` is true there,
 * so `set_goal` is declared and the widget calls really happen. Print mode (`-p`)
 * has no UI, which is its own scenario: the tool must be invisible to the
 * provider there.
 *
 * A generated probe extension records every provider payload
 * (`before_provider_request`), so "the provider never saw set_goal" is asserted on
 * the actual request, not inferred from behavior. The scan covers tools, a
 * top-level `system` field, and `role:"system"` / `role:"developer"` messages —
 * the DeepSeek payload this repo runs against carries its rules in `developer`.
 *
 * Every scenario runs its own session with only this extension loaded, inside a
 * fresh `os.tmpdir()/ag-eval-*` directory. A run that fails keeps that directory
 * (session, payload log, work dir) instead of deleting the evidence.
 *
 * `invalid` is not `failed`: an invalid run never reached a behavior verdict
 * (provider/model error, no provider response, or requests that did not carry the
 * requested model/thinking level). Invalid runs are reported separately and are
 * not retried to green; a red behavior assertion is never retried either.
 *
 * Usage: node run-eval.cjs [--keep] [--scenario e1,e3] [--model <id>] [--thinking <level>]
 *   --keep      keep the evidence directory even when everything passes
 *   --scenario  comma-separated scenario ids (default: all)
 *   --model     override the model id (default: $AG_EVAL_MODEL or the cheap default)
 *   --thinking  override the thinking level (default: "high")
 * Exit: 0 all scenarios pass · 1 behavior failure · 2 invalid run(s) only.
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  stripAnsiDeep,
  parseSessionJsonl,
  callsIn,
  providerErrorsIn,
  sessionSnapshot,
  payloadMentionsSetGoal,
  payloadConfigMismatch,
  evidenceDir,
} = require("./lib/goal-evidence.cjs");

const EXT = path.join(__dirname, "../../agent/extensions/agent-goal/index.ts");
const ROOT = evidenceDir("ag-eval");
const SESS_DIR = path.join(ROOT, "sessions");
const WORK_DIR = path.join(ROOT, "work");
const PROBE = path.join(ROOT, "probe.ts");
const PAYLOAD_DIR = path.join(ROOT, "payloads");
const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
};
const THINKING = argOf("--thinking") || "high";

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
const modelArg = argOf("--model");
const MODELS_TO_RUN = modelArg ? [modelArg] : MODELS;

const START = "We need to add CSV export to our app. Go.";

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

function sessionFiles(scenarioId) {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.includes(scenarioId) && f.endsWith(".jsonl")); } catch {}
  files.sort();
  return files.map((f) => path.join(SESS_DIR, f));
}

function readSession(scenarioId) {
  const files = sessionFiles(scenarioId);
  if (!files.length) return [];
  return parseSessionJsonl(fs.readFileSync(files[files.length - 1], "utf8"));
}

function summarizeState(scenarioId) {
  const entries = readSession(scenarioId);
  let providerResponses = 0;
  let costUsd = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      providerResponses++;
      const usage = entry.message.usage;
      costUsd += usage?.cost?.total ?? (typeof usage?.cost === "number" ? usage.cost : 0);
    }
  }
  return {
    goalCalls: callsIn(entries),
    finalState: sessionSnapshot(entries, 0, entries.length).state,
    providerResponses,
    costUsd,
    modelErrors: providerErrorsIn(entries),
  };
}

/** The run itself failed; its assertions say nothing about goal tracking. */
class InfraInvalid extends Error {}
/** A run that may succeed on another attempt (rate limit, dropped connection). */
class TransientInfra extends InfraInvalid {}

/**
 * A provider rejection (bad model id, revoked key) is not a scenario failure: it
 * must surface as an invalid run so `main()` can fall back to the next model
 * instead of reporting the scenario as broken. It is not retried on the same
 * model — a rejection will not clear by itself.
 */
function assertModelUsable(state) {
  const invalid = (ErrorClass, message) => {
    const error = new ErrorClass(message);
    error.costUsd = state.costUsd;
    error.responses = state.providerResponses;
    return error;
  };
  if (state.modelErrors.length > 0) throw invalid(InfraInvalid, `model error: ${state.modelErrors[0]}`);
  // A turn that produced no provider response at all is a failed run, not a
  // scenario result: reporting it as an assertion failure hides a transient
  // (rate limit, dropped connection) behind a red goal-tracking check.
  if (state.providerResponses === 0) throw invalid(TransientInfra, "no provider response (transient)");
}

function assertRequestConfig(payloads, model) {
  const mismatch = payloadConfigMismatch(payloads, { model, thinking: THINKING });
  if (mismatch) throw new InfraInvalid(`request config not honored: ${mismatch}`);
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

/** Display-layer timeline from `extension_ui_request` records. */
function widgetStates(records) {
  return records
    .filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal")
    .map((r) => stripAnsiDeep(r.widgetLines));
}
function goalLines(records) {
  return widgetStates(records).flat().filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
}
function footerStatusWrites(records) {
  return records.filter(
    (r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "agent-status",
  );
}
const lastOf = (list) => (list.length ? list[list.length - 1] : undefined);
const summaryOf = (state) => state?.goal ?? "";

const PASS = (label) => { console.log(`  ✓ ${label}`); return true; };
const FAIL = (label) => { console.log(`  ✗ ${label}`); return false; };

// ── RPC client ────────────────────────────────────────────────────────────

function commonArgs(scenarioId) {
  return [
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
    "--thinking", THINKING,
  ];
}

function startRpc(scenarioId, model) {
  const payloadLog = path.join(PAYLOAD_DIR, `${scenarioId}.jsonl`);
  fs.rmSync(payloadLog, { force: true });
  const proc = spawn("pi", ["--mode", "rpc", ...commonArgs(scenarioId), "--model", model], {
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
    id: "e1-first-prompt",
    turns: [START],
    check({ records, state }) {
      let ok = true;
      const widgets = widgetStates(records);
      const promptLine = widgets.flat().find((l) => typeof l === "string" && l.startsWith("user_prompt:"));
      ok = (promptLine && /csv export/i.test(promptLine)
        ? PASS(`display: widget shows "${promptLine.slice(0, 60)}"`)
        : FAIL(`display: widget shows the user_prompt line (got ${JSON.stringify(widgets)})`)) && ok;
      const lines = goalLines(records);
      ok = (lines.length > 0 && /csv|export/i.test(lines[lines.length - 1])
        ? PASS(`display: agent_goal line "${lines[lines.length - 1].slice(0, 60)}"`)
        : FAIL(`display: agent_goal line for the task (got ${JSON.stringify(lines)})`)) && ok;
      ok = (footerStatusWrites(records).length === 0
        ? PASS("display: footer status line untouched (the widget is the only surface)")
        : FAIL(`display: no agent-status footer writes (got ${footerStatusWrites(records).length})`)) && ok;
      ok = (state.goalCalls.length > 0 && /csv|export/i.test(summaryOf(state.finalState))
        ? PASS(`state: persisted summary "${summaryOf(state.finalState).slice(0, 50)}"`)
        : FAIL(`state: persisted summary anchored on csv/export (got ${JSON.stringify(state.finalState)})`)) && ok;
      return ok;
    },
  },

  {
    id: "e2-supplement",
    turns: [START, "Also, the export must additionally support ISO-8601 timestamps and a BOM for Excel — add that to the goal."],
    check({ records, state }) {
      let ok = true;
      const summary = summaryOf(state.finalState);
      ok = (state.goalCalls.length >= 2
        ? PASS(`state: ${state.goalCalls.length} declarations across the two turns`)
        : FAIL(`state: a second declaration after the added constraint (got ${state.goalCalls.length})`)) && ok;
      ok = (/iso-?8601|bom|excel/i.test(summary)
        ? PASS(`state: the added constraint is in the summary ("${summary.slice(0, 60)}")`)
        : FAIL(`state: the added constraint is in the summary (got "${summary}")`)) && ok;
      ok = (/csv|export/i.test(summary)
        ? PASS("state: the core outcome is still there")
        : FAIL(`state: the core outcome is still there (got "${summary}")`)) && ok;
      const distinct = new Set(goalLines(records));
      ok = (distinct.size >= 2
        ? PASS(`display: goal line replaced (${distinct.size} distinct renders)`)
        : FAIL(`display: goal line replaced (got ${JSON.stringify([...distinct])})`)) && ok;
      return ok;
    },
  },

  {
    id: "e3-second-goal",
    turns: [START, "Separately, write a README for the project. Neither task is finished yet."],
    check({ state }) {
      let ok = true;
      const summary = summaryOf(state.finalState);
      ok = (/(csv|export)/i.test(summary) && /readme|documentation/i.test(summary)
        ? PASS(`state: both goals are represented ("${summary}")`)
        : FAIL(`state: both goals should be represented (got "${summary}")`)) && ok;
      return ok;
    },
  },

  {
    id: "e4-finished",
    turns: [START, "The CSV export is finished, so drop it from the goal. Nothing else is open."],
    check({ records, state }) {
      let ok = true;
      const lastCall = lastOf(state.goalCalls);
      ok = (lastCall && lastCall.goal === ""
        ? PASS("state: the last declaration is an empty goal")
        : FAIL(`state: an empty goal once nothing is left (got ${JSON.stringify(lastCall)})`)) && ok;
      ok = (summaryOf(state.finalState) === ""
        ? PASS("state: no goal left")
        : FAIL(`state: no goal left (got "${summaryOf(state.finalState)}")`)) && ok;
      const lastWidget = lastOf(widgetStates(records));
      const stillShown = (lastWidget ?? []).some((l) => typeof l === "string" && l.startsWith("agent_goal:"));
      ok = (!stillShown
        ? PASS("display: the goal entry is gone from the widget")
        : FAIL(`display: the goal entry is gone (got ${JSON.stringify(lastWidget)})`)) && ok;
      return ok;
    },
  },

  {
    id: "e5-toggle",
    turns: [
      START,
      "/agent-goal off",
      "keep going, just a step.",
      "/agent-goal on",
      "Now continue with the export work.",
    ],
    check({ records, turnPayloads }) {
      let ok = true;
      const widgets = widgetStates(records);
      const offIndex = widgets.findIndex((lines) => lines === undefined);
      ok = (offIndex !== -1
        ? PASS("display: /agent-goal off cleared the widget")
        : FAIL(`display: /agent-goal off cleared the widget (got ${JSON.stringify(widgets)})`)) && ok;
      const lastWidget = lastOf(widgets);
      ok = (lastWidget && lastWidget.some((l) => String(l).startsWith("agent_goal:"))
        ? PASS(`display: /agent-goal on restored "${lastWidget.find((l) => String(l).startsWith("agent_goal:")).slice(0, 50)}"`)
        : FAIL(`display: /agent-goal on restored the goal line (got ${JSON.stringify(lastWidget)})`)) && ok;
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
    id: "e6-headless",
    headless: true,
    // No preamble here either: a prompt that names a tool is not evidence about
    // what the provider declared. A neutral task prompt is what a real headless
    // run looks like.
    turns: [START],
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
    const payloads = readPayloads(sc.id);
    assertRequestConfig(payloads, model);
    return { records: rpc.records, payloads, turnPayloads, state };
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
    ...commonArgs(sc.id),
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
  const payloads = readPayloads(sc.id);
  assertRequestConfig(payloads, model);
  return {
    records: [],
    payloads,
    state,
    headless: { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" },
  };
}

async function main() {
  const toRun = scenarios.filter((s) => (only ? only.has(s.id) : true));
  fs.mkdirSync(SESS_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  fs.writeFileSync(PROBE, PROBE_SOURCE);

  let passed = 0;
  let failed = 0;
  let invalid = 0;
  let totalCost = 0;
  let totalResponses = 0;
  const perScenario = [];

  for (const sc of toRun) {
    console.log(`\n== ${sc.id} ==`);
    let result = null;
    let modelUsed = MODELS_TO_RUN[0];
    let invalidReason = null;
    for (const model of MODELS_TO_RUN) {
      for (let attempt = 1; attempt <= 2 && !result; attempt++) {
        try {
          result = sc.headless ? runHeadlessScenario(sc, model) : await runRpcScenario(sc, model);
          modelUsed = model;
        } catch (e) {
          invalidReason = String(e.message || e).split("\n")[0];
          totalCost += typeof e.costUsd === "number" ? e.costUsd : 0;
          totalResponses += typeof e.responses === "number" ? e.responses : 0;
          console.error(`  [${model}${attempt > 1 ? ` attempt ${attempt}` : ""}] ${invalidReason}`);
          // Only a transient failure may be retried; a rejected model or a
          // request that ignored the requested config will fail the same way.
          if (e instanceof InfraInvalid && !(e instanceof TransientInfra)) break;
        }
      }
      if (result) break;
    }
    if (!result) {
      console.log(`  ! invalid run (not a goal-tracking verdict): ${invalidReason}`);
      invalid++;
      perScenario.push({ id: sc.id, status: "invalid", ok: false, model: modelUsed, costUsd: 0, responses: 0, reason: invalidReason });
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
      status: ok ? "pass" : "fail",
      ok,
      model: modelUsed,
      costUsd: cost,
      responses: result.state.providerResponses,
      display: {
        widget: lastOf(widgetStates(result.records)) ?? null,
        footerStatusWrites: footerStatusWrites(result.records).length,
        payloads: result.payloads.length,
      },
      calls: result.state.goalCalls,
    });
    if (totalCost > BUDGET_USD) {
      console.log(`\n!! budget exceeded: $${totalCost.toFixed(4)} > $${BUDGET_USD} — stopping`);
      failed += toRun.length - (passed + failed + invalid);
      break;
    }
  }

  const summary = [`${passed}/${passed + failed} scenarios passed`];
  if (invalid) summary.push(`${invalid} invalid`);
  console.log(`\n===== ${summary.join(" · ")} =====`);
  console.log(`model responses: ${totalResponses} · reported cost: $${totalCost.toFixed(4)}`);
  for (const row of perScenario) {
    const verdict = row.status === "invalid" ? "INVALID" : row.ok ? "PASS" : "FAIL";
    console.log(`  ${verdict} ${row.id} · ${row.model} · ${row.responses} response(s) · $${row.costUsd.toFixed(4)}`);
    if (row.reason) console.log(`       reason: ${row.reason}`);
    if (row.display) {
      console.log(`       widget: ${JSON.stringify(row.display.widget)}`);
      console.log(`       footer status writes: ${row.display.footerStatusWrites}`);
      console.log(`       set_goal calls: ${JSON.stringify(row.calls)}`);
    }
  }

  const clean = passed + failed > 0 && failed === 0 && invalid === 0;
  if (clean && !keep) fs.rmSync(ROOT, { recursive: true, force: true });
  else console.log(`\nevidence: ${ROOT}`);
  process.exit(failed ? 1 : invalid ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
