#!/usr/bin/env node
/**
 * Real-session acceptance for agent-goal: does the model actually TRACK the task goal?
 *
 * A real `pi --mode rpc` agent with its normal built-in tools works through a real
 * task on disk. Each user message exercises one scenario from the requirement:
 *   start / added constraint / sub-problem / mere step / pivot / continue-same-outcome.
 * Assertions are about goal tracking (which mode, whether the parent line survives),
 * not about how many round trips the scheduler spends.
 *
 * Unlike run-eval.cjs, the tool set is NOT reduced: this is a real agent doing real
 * work, so it is the check that the display still tracks a goal outside a simulated
 * conversation. It needs a model that follows tool guidelines; weaker models
 * under-declare, so a failing run is a model signal as much as a code signal.
 *
 * Evidence is captured per turn, immediately after `agent_settled`: the cumulative
 * persisted state, the current widget, the `set_goal` calls and provider errors of
 * that turn, and the provider payloads it produced. Every run writes to its own
 * fresh directory (`os.tmpdir()/ag-accept-*`) and leaves it in place, so parallel
 * runs cannot delete each other and a failure keeps its session/payload trail.
 *
 * A run is INVALID (exit 2) when the run itself failed — a provider error, a turn
 * the provider was never asked about, or a request that did not carry the
 * requested model/thinking level. Invalid runs are never retried and never
 * reported as goal-tracking results. A turn that really ran and still failed an
 * assertion is a BEHAVIOR failure (exit 1); it is not retried either.
 *
 * Usage: node run-acceptance.cjs [--extension <file>] [--model <provider/model>] [--thinking <level>]
 * Exit: 0 every tracking assertion holds · 1 behavior failure · 2 invalid run.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  stripAnsiDeep,
  parseSessionJsonl,
  sessionSnapshot,
  turnVerdict,
  trackingChecks,
  payloadMentionsSetGoal,
  payloadConfigMismatch,
  evidenceDir,
  writeJson,
} = require("./lib/goal-evidence.cjs");

const ROOT = evidenceDir("ag-accept");
const PROBE = path.join(ROOT, "probe.ts");
const SESS_DIR = path.join(ROOT, "sessions");
const WORK = path.join(ROOT, "work");
const PAYLOAD_LOG = path.join(ROOT, "payloads.jsonl");
const SID = "accept-goal-tracking";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const EXT = path.resolve(arg("--extension") || path.join(__dirname, "../../agent/extensions/agent-goal/index.ts"));
const MODEL = arg("--model") || process.env.ACC_MODEL || "trendmicro/deepseek-v4.1-flash";
const THINKING = arg("--thinking") || process.env.ACC_THINKING || "high";

const PASS = (m) => { console.log(`  ✓ ${m}`); return true; };
const FAIL = (m) => { console.log(`  ✗ ${m}`); return false; };

console.log(`evidence directory: ${ROOT}`);
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(PROBE, `
import fs from "node:fs";

export default function agentGoalAcceptanceProbe(pi: any) {
  pi.on("before_provider_request", (event: any) => {
    const target = process.env.AG_EVAL_PAYLOAD_LOG;
    if (!target) return;
    try {
      fs.appendFileSync(target, JSON.stringify({ payload: event.payload }) + "\\n");
    } catch {}
  });
}
`);

const proc = spawn("pi", [
  "--mode", "rpc",
  "--session-dir", SESS_DIR,
  "--session-id", SID,
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-themes",
  "-e", EXT,
  "-e", PROBE,
  "--approve",
  "--thinking", THINKING,
  "--model", MODEL,
], {
  cwd: WORK,
  env: { ...process.env, PI_NO_TELEMETRY: "1", AG_EVAL_PAYLOAD_LOG: PAYLOAD_LOG },
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
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i).replace(/\r$/, "");
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    records.push(rec);
    for (const w of [...waiters]) if (w.predicate(rec, records)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(rec); }
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { stderr += c; });
proc.on("exit", (code, signal) => {
  exited = { code, signal };
  for (const w of waiters.splice(0)) w.reject(new Error(`pi exited ${code}/${signal} waiting for ${w.label}\n${stderr.slice(-500)}`));
});

function waitFor(predicate, label, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex((w) => w.timer === timer);
      if (idx !== -1) waiters.splice(idx, 1);
      reject(new Error(`timeout waiting for ${label}\n${stderr.slice(-500)}`));
    }, timeoutMs);
    waiters.push({ predicate, label, timer, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}

async function turn(message) {
  const id = `req-${records.length}-${Math.random().toString(36).slice(2, 7)}`;
  const target = records.filter((r) => r.type === "agent_settled").length + 1;
  const settled = waitFor((_r, all) => all.filter((x) => x.type === "agent_settled").length >= target, `settled after "${message.slice(0, 30)}"`);
  settled.catch(() => {});
  proc.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  const res = await waitFor((r) => r.type === "response" && r.id === id, "prompt response", 60000);
  if (!res.success) throw new Error(`prompt rejected: ${res.error}`);
  if (res.data?.disposition === "handled") return;
  await settled;
}

// ── scenarios from the requirement ────────────────────────────────────────
const TURNS = [
  { id: "start", say: `在 ${WORK} 创建 data.txt，写入 20 行整数（每行一个），再写 summarize.mjs 读取它并打印总和与行数，然后实际运行 node summarize.mjs 验证。`, modes: ["new"], goal: /summar|data|脚本|script/i, label: "task start" },
  { id: "constraint", say: "summarize.mjs 还要输出最大值和中位数，改完重新运行一次。", modes: ["rewrite", "expand"], goal: /summar|data|脚本|script/i, label: "added constraint (same outcome)" },
  { id: "subproblem", say: "先把 data.txt 第 7 行的数字改成 70 —— 这是修数据的前置问题，处理完再继续。", modes: ["expand", null], goal: /summar|data|脚本|script/i, label: "sub-problem (parent must survive)" },
  { id: "step", say: "把 summarize.mjs 里的变量名改得更清楚一点。", modes: ["expand", null], goal: /summar|data|脚本|script/i, label: "mere step (no reset)" },
  { id: "pivot", say: `脚本先不管了，改做另一件事：在 ${WORK} 写一个 README.md，说明这个目录里有什么。`, modes: ["new"], goal: /readme/i, label: "pivot to a different outcome" },
  { id: "continue", say: "README.md 里再补一段运行示例。", modes: ["rewrite", "expand", null], goal: /readme/i, label: "continue the same outcome" },
];

const widgets = () => records
  .filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal")
  .map((r) => stripAnsiDeep(r.widgetLines));
const currentWidget = () => {
  const all = widgets();
  return all.length ? all[all.length - 1] : undefined;
};
const footerStatusWrites = () => records
  .filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "agent-status");

function readSession() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.includes(SID) && f.endsWith(".jsonl")); } catch {}
  if (!files.length) return [];
  files.sort();
  return parseSessionJsonl(fs.readFileSync(path.join(SESS_DIR, files[files.length - 1]), "utf8"));
}

function readPayloads() {
  try {
    return parseSessionJsonl(fs.readFileSync(PAYLOAD_LOG, "utf8")).map((line) => line.payload);
  } catch {
    return [];
  }
}

function statusOnlyTurns() {
  let n = 0;
  for (const e of readSession()) {
    const m = e.message;
    if (e.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const calls = m.content.filter((c) => c.type === "toolCall");
    if (calls.length === 1 && (calls[0].name ?? calls[0].toolName) === "set_goal") n++;
  }
  return n;
}

/**
 * Run one prompt and record what the turn left behind, read immediately after
 * `agent_settled` (not reconstructed afterwards from entry positions).
 */
async function runTurn(say) {
  const entryFrom = readSession().length;
  const payloadFrom = readPayloads().length;
  await turn(say);
  const entries = readSession();
  const snapshot = sessionSnapshot(entries, entryFrom, entries.length);
  const payloads = readPayloads();
  return {
    ...snapshot,
    say,
    entries: [entryFrom, entries.length],
    widget: currentWidget(),
    payloads: payloads.slice(payloadFrom),
    payloadLines: [payloadFrom, payloads.length],
  };
}

/** The part of a turn worth persisting: payload bodies stay in payloads.jsonl. */
function evidenceOf(id, turnEvidence) {
  return {
    id,
    state: turnEvidence.state,
    calls: turnEvidence.calls,
    providerErrors: turnEvidence.providerErrors,
    providerResponses: turnEvidence.providerResponses,
    widget: turnEvidence.widget,
    entries: turnEvidence.entries,
    payloadLines: turnEvidence.payloadLines,
  };
}

(async () => {
  let ok = true;
  const evidence = { model: MODEL, thinking: THINKING, extension: EXT, root: ROOT, turns: [], checks: [], off: null, status: "running" };
  const save = () => writeJson(path.join(ROOT, "result.json"), evidence);
  const finish = (code) => {
    evidence.ok = code === 0;
    evidence.status = code === 0 ? "passed" : code === 1 ? "failed" : "invalid";
    save();
    console.log(`\nevidence: ${ROOT}`);
    try { proc.kill("SIGTERM"); } catch {}
    process.exit(code);
  };

  try {
    save();
    console.log(`== goal-tracking acceptance · ${MODEL} @${THINKING} ==`);
    const turnEvidence = [];
    for (const t of TURNS) {
      evidence.pendingTurn = t.id;
      save();
      const snapshot = await runTurn(t.say);
      turnEvidence.push(snapshot);
      evidence.turns.push(evidenceOf(t.id, snapshot));
      delete evidence.pendingTurn;
      save();
    }

    console.log("\n-- what the model declared, per user turn --");
    TURNS.forEach((t, i) => {
      const calls = turnEvidence[i].calls;
      const shown = calls.length ? calls.map((c) => `${c.mode}: ${c.goal}`).join(" | ") : "(no call)";
      console.log(`  ${i + 1}. ${t.id.padEnd(10)} ${shown.slice(0, 150)}`);
    });

    console.log("\n-- goal tracking --");
    const tracking = trackingChecks(TURNS, turnEvidence);
    for (const result of tracking.results) ok = (result.ok ? PASS(result.label) : FAIL(result.label)) && ok;
    evidence.checks = tracking.results;

    console.log("\n-- provider payload --");
    const invalid = [];
    turnEvidence.forEach((snapshot, i) => {
      const label = TURNS[i].label;
      const verdict = turnVerdict(snapshot);
      if (verdict.status !== "ok") invalid.push(`${label}: ${verdict.reason}`);
      if (!snapshot.payloads.length) invalid.push(`${label}: no provider request captured`);
      const mismatch = payloadConfigMismatch(snapshot.payloads, { model: MODEL, thinking: THINKING });
      if (mismatch) invalid.push(`${label}: ${mismatch}`);
      const leaked = snapshot.payloads.filter((p) => !payloadMentionsSetGoal(p)).length;
      if (snapshot.payloads.length && leaked) {
        ok = FAIL(`${label}: set_goal missing from ${leaked}/${snapshot.payloads.length} request(s) while ON`) && ok;
      } else if (snapshot.payloads.length) {
        ok = PASS(`${label}: set_goal declared in all ${snapshot.payloads.length} request(s)`) && ok;
      }
    });
    const configMismatch = payloadConfigMismatch(readPayloads(), { model: MODEL, thinking: THINKING });
    ok = (configMismatch ? FAIL(`requested config not honored: ${configMismatch}`) : PASS(`requests carry ${MODEL} @${THINKING}`)) && ok;

    console.log("\n-- display --");
    const all = widgets().filter(Boolean);
    const goalRenders = all.flat().filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
    const nestedRenders = all.flat().filter((l) => typeof l === "string" && l.trim().startsWith("└─"));
    ok = (goalRenders.length > 0 ? PASS(`goal line rendered ${goalRenders.length}x`) : FAIL("goal line never rendered")) && ok;
    ok = (goalRenders.length >= 2 && new Set(goalRenders).size >= 2 ? PASS(`goal line updated ${new Set(goalRenders).size} distinct texts`) : FAIL("goal line never changed")) && ok;
    ok = (nestedRenders.length > 0 ? PASS(`nested focus row rendered: "${nestedRenders[0].trim().slice(0, 60)}"`) : FAIL("no └─ focus row was rendered")) && ok;
    ok = (footerStatusWrites().length === 0 ? PASS("footer status line untouched (the widget is the only surface)") : FAIL(`no agent-status footer writes (got ${footerStatusWrites().length})`)) && ok;

    console.log("\n-- OFF --");
    proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "/agent-goal off" })}\n`);
    await waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal" && r.widgetLines === undefined, "widget cleared", 60000);
    const offFrom = readSession().length;
    const offPayloadFrom = readPayloads().length;
    const offRecords = records.length;
    const offTurn = await runTurn("再给 data.txt 追加一行 42，然后告诉我总行数。");
    const offPayloads = readPayloads().slice(offPayloadFrom);
    const painted = records.slice(offRecords).filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal" && r.widgetLines && r.widgetLines.length > 0).length;
    evidence.off = { ...evidenceOf("off", { ...offTurn, entries: [offFrom, readSession().length] }), painted };
    const offVerdict = turnVerdict(offTurn);
    if (offVerdict.status !== "ok") invalid.push(`OFF turn: ${offVerdict.reason}`);
    if (!offPayloads.length) invalid.push("OFF turn: no provider request captured");
    ok = (offTurn.calls.length === 0 ? PASS("no declaration after OFF") : FAIL(`declared after OFF: ${JSON.stringify(offTurn.calls)}`)) && ok;
    ok = (painted === 0 ? PASS("widget stayed cleared after OFF") : FAIL(`widget repainted ${painted}x after OFF`)) && ok;
    // A payload that hides the declaration but still carries the rules is a leak;
    // the scan covers tools, top-level system, role:system and role:developer.
    const offLeaks = offPayloads.filter(payloadMentionsSetGoal).length;
    ok = (offPayloads.length > 0 && offLeaks === 0
      ? PASS(`no set_goal declaration or rule in the ${offPayloads.length} request(s) while OFF`)
      : FAIL(`set_goal leaked while OFF (${offLeaks}/${offPayloads.length} requests; captured ${offPayloads.length})`)) && ok;

    proc.stdin.end();
    await new Promise((r) => { if (exited) return r(); const t = setTimeout(() => { proc.kill("SIGTERM"); r(); }, 15000); proc.on("exit", () => { clearTimeout(t); r(); }); });

    const files = fs.readdirSync(WORK).sort();
    console.log(`\n-- real work on disk --\n  ${files.join(", ")}`);
    ok = (files.includes("data.txt") && files.includes("summarize.mjs") && files.includes("README.md") ? PASS("the agent really did the work with its own tools") : FAIL(`missing files: ${files.join(", ")}`)) && ok;
    evidence.files = files;

    console.log(`\n-- scheduling cost (informational, expected) --\n  status-only turns: ${statusOnlyTurns()}`);

    if (invalid.length) {
      console.log("\n-- invalid run (infrastructure, not a goal-tracking verdict) --");
      for (const reason of invalid) console.log(`  ! ${reason}`);
      console.log("\n===== ACCEPTANCE INVALID (fix the run, then re-run; not retried to green) =====");
      finish(2);
      return;
    }
    console.log(`\n===== ${ok ? "GOAL TRACKING ACCEPTED" : "GOAL TRACKING FAILED"} =====`);
    finish(ok ? 0 : 1);
  } catch (e) {
    console.error(`\n✗ acceptance threw: ${e.message}`);
    evidence.error = e.message;
    finish(2);
  }
})();
