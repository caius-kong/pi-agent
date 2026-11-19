#!/usr/bin/env node
/**
 * Real-session acceptance for agent-goal: does the model actually TRACK the session goals?
 *
 * A real `pi --mode rpc` agent with its normal built-in tools works through a real
 * task on disk: establish a goal, add a requirement, add independent work,
 * answer a follow-up without refreshing the goals, and update after discovering
 * a new deliverable from a tool result. Deferred work stays visible.
 *
 * The prompt is the user's own message, nothing else: no eval preamble, no hint
 * that names set_goal and no hint about when the summary should change. What the
 * model decides to declare is the behavior under test.
 *
 * LOADOUT — the run is isolated by construction, not by reduction: `--no-extensions`
 * plus `-e agent-goal` and `-e <payload probe>` is the whole extension set (no
 * user extensions, skills, context files or themes), while every built-in tool
 * stays available so the agent really does the work. A run that quietly loaded a
 * second extension would make "the model followed OUR rules" unprovable, so the
 * probe is the only other file loaded.
 *
 * Evidence is captured per turn, immediately after `agent_settled`: the cumulative
 * persisted summary, the current widget, the `set_goal` calls of that turn, the
 * order of the turn's tool calls, and the provider payloads it produced. Every run
 * writes to its own fresh directory (`os.tmpdir()/ag-accept-*`) and leaves it in
 * place, so parallel runs cannot delete each other and a failure keeps its
 * session/payload trail.
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

fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "next.txt"), "Translate the introduction into Japanese.\n");
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

// ── scenarios: one part of the contract per ordinary user message ─────────
const TURNS = [
  {
    id: "task1-start",
    say: `在 ${WORK} 创建 numbers.txt，写入 20 行整数（每行一个），再写 stats.mjs 读取它并打印总和。这个脚本最后要输出总和、最大值、中位数三个统计量；这一轮只做总和，最大值和中位数等我批准后再加。`,
    label: "task 1 starts: the sum is done now, max/median wait for approval",
    expect: [
      { label: "task 1 is on the goal line", match: /numbers|stats/i },
      { label: "unfinished statistics are retained", match: /median|中位数/i },
    ],
  },
  {
    id: "task1-supplement",
    say: "另外，stats.mjs 算完还要把结果写进 stats.json。",
    label: "added constraint folded into task 1",
    expect: [
      { label: "the added constraint is folded in", match: /json/i },
      { label: "task 1 still includes unfinished statistics", match: /median|中位数/i },
    ],
  },
  {
    id: "task2-joins",
    say: `再开一件独立的事：在 ${WORK} 写 README.md 初稿，说明这个目录里有什么；最后的运行示例等我确认目录结构后再补。`,
    label: "task 2 joins as a draft whose run example waits for approval",
    expect: [
      { label: "the deferred statistic is retained", match: /median|中位数/i },
      { label: "the new documentation goal is included", match: /readme|documentation|文档/i },
    ],
  },
  {
    id: "same-goal",
    say: "不改变已有要求。只确认一下 numbers.txt 当前有几行，不用改任何文件。",
    label: "an informational follow-up leaves the goals unchanged",
    call: "forbidden",
    expect: [{ label: "unfinished work stays visible", match: /readme/i }],
  },
  {
    id: "discovery",
    say: "读取 next.txt，文件里是我已委托的下一项任务，把它纳入本会话待办，告诉我是什么，但等我确认范围后再执行。",
    label: "new evidence changes the goal within one user turn",
    expect: [
      { label: "the pending translation is reflected", match: /Japanese|日语|日文/i },
      { label: "prior open statistics remain", match: /median|中位数/i },
      { label: "prior open documentation remains", match: /readme|文档/i },
    ],
    afterWork: /Japanese|日语|日文/i,
  },
];

// After OFF the tool is undeclared, so a normal user message must not declare.
// Whether the stored summary was really left alone is checked by counting the
// `agent-goal-state` entries before and after the turn: an `expect` on the goal
// text cannot tell "preserved" from "reset" once the summary is already empty.
const OFF_TURN = {
  id: "off",
  say: "再给 numbers.txt 追加一行 42，然后告诉我总行数。",
  label: "OFF: no declaration, no paint, no state write",
  call: "forbidden",
};

const widgets = () => records
  .filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal")
  .map((r) => stripAnsiDeep(r.widgetLines));
const currentWidget = () => {
  const all = widgets();
  return all.length ? all[all.length - 1] : undefined;
};
const goalLinesOf = (lines) => (lines ?? []).filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
const footerStatusWrites = () => records
  .filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "agent-status");

function readSession() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.includes(SID) && f.endsWith(".jsonl")); } catch {}
  if (!files.length) return [];
  files.sort();
  return parseSessionJsonl(fs.readFileSync(path.join(SESS_DIR, files[files.length - 1]), "utf8"));
}

/** How many `agent-goal-state` entries the session has written so far. */
function stateEntryCount() {
  return readSession().filter((entry) => entry.type === "custom" && entry.customType === "agent-goal-state").length;
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
    say: turnEvidence.say,
    state: turnEvidence.state,
    calls: turnEvidence.calls,
    callOrder: turnEvidence.callOrder,
    events: turnEvidence.events,
    providerErrors: turnEvidence.providerErrors,
    providerResponses: turnEvidence.providerResponses,
    widget: turnEvidence.widget,
    entries: turnEvidence.entries,
    payloadLines: turnEvidence.payloadLines,
  };
}

(async () => {
  let ok = true;
  const evidence = { model: MODEL, thinking: THINKING, root: ROOT, extension: EXT, status: "running", loadout: { extensions: ["agent-goal", "acceptance-probe"], builtinTools: "all" }, turns: [], checks: [], off: null };
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
    console.log(`evidence directory: ${ROOT}`);
    console.log(`== goal-tracking acceptance · ${MODEL} @${THINKING} ==`);
    console.log("   loadout: built-in tools only + agent-goal + payload probe (no preamble)");
    const turnEvidence = [];
    const turns = TURNS;
    for (const t of turns) {
      evidence.pendingTurn = t.id;
      save();
      const snapshot = await runTurn(t.say);
      turnEvidence.push(snapshot);
      evidence.turns.push(evidenceOf(t.id, snapshot));
      delete evidence.pendingTurn;
      save();
    }

    console.log("\n-- what the model declared, per user turn --");
    turns.forEach((t, i) => {
      const calls = turnEvidence[i].calls;
      const shown = calls.length ? calls.map((c) => JSON.stringify(c.goal)).join(" | ") : "(no call)";
      console.log(`  ${i + 1}. ${t.id.padEnd(22)} ${shown.slice(0, 150)}`);
    });

    console.log("\n-- goal tracking --");
    const tracking = trackingChecks(turns, turnEvidence);
    for (const result of tracking.results) ok = (result.ok ? PASS(result.label) : FAIL(result.label)) && ok;
    evidence.checks = tracking.results;

    console.log("\n-- provider payload --");
    const invalid = [];
    turnEvidence.forEach((snapshot, i) => {
      const label = turns[i].label;
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
    const painted = widgets().filter(Boolean);
    const goalRenders = painted.flat().filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
    const nestedRenders = painted.flat().filter((l) => typeof l === "string" && l.trim().startsWith("└─"));
    ok = (goalRenders.length > 0 ? PASS(`goal line rendered ${goalRenders.length}x`) : FAIL("goal line never rendered")) && ok;
    ok = (new Set(goalRenders).size >= 2 ? PASS(`goal line updated ${new Set(goalRenders).size} distinct texts`) : FAIL("goal line never changed")) && ok;
    ok = (nestedRenders.length === 0 ? PASS("no nested focus row: the summary is one line") : FAIL(`no nested row expected, got ${nestedRenders.length}`)) && ok;
    ok = (footerStatusWrites().length === 0 ? PASS("footer status line untouched (the widget is the only surface)") : FAIL(`no agent-status footer writes (got ${footerStatusWrites().length})`)) && ok;

    console.log("\n-- OFF --");
    proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "/agent-goal off" })}\n`);
    await waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal" && r.widgetLines === undefined, "widget cleared", 60000);
    const offFrom = readSession().length;
    const offPayloadFrom = readPayloads().length;
    const offRecords = records.length;
    const offStateBefore = stateEntryCount();
    const offTurn = await runTurn(OFF_TURN.say);
    const offStateAfter = stateEntryCount();
    const offPayloads = readPayloads().slice(offPayloadFrom);
    const offPaints = records.slice(offRecords).filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal" && r.widgetLines && r.widgetLines.length > 0).length;
    evidence.off = { ...evidenceOf("off", { ...offTurn, entries: [offFrom, readSession().length] }), paints: offPaints, stateEntries: [offStateBefore, offStateAfter] };
    const offVerdict = turnVerdict(offTurn);
    if (offVerdict.status !== "ok") invalid.push(`OFF turn: ${offVerdict.reason}`);
    if (!offPayloads.length) invalid.push("OFF turn: no provider request captured");
    const offTracking = trackingChecks([OFF_TURN], [offTurn]);
    for (const result of offTracking.results) ok = (result.ok ? PASS(result.label) : FAIL(result.label)) && ok;
    ok = (offPaints === 0 ? PASS("widget stayed cleared after OFF") : FAIL(`widget repainted ${offPaints}x after OFF`)) && ok;
    // "The summary is unchanged" is only observable as "the extension wrote no
    // state entry": a goal-text comparison cannot tell preserved from reset once
    // the summary is already empty (the previous turn cleared it).
    ok = (offStateAfter === offStateBefore
      ? PASS("OFF wrote no agent-goal-state entry (the stored summary was left alone)")
      : FAIL(`OFF wrote ${offStateAfter - offStateBefore} agent-goal-state entr(ies)`)) && ok;
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
    ok = (files.includes("numbers.txt") && files.includes("stats.mjs") && files.includes("README.md") ? PASS("the agent really did the work with its own tools") : FAIL(`missing files: ${files.join(", ")}`)) && ok;
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
