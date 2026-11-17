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
 * Usage: node run-acceptance.cjs [--model <provider/model>]
 * Exit: 0 if every tracking assertion holds.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(process.env.HOME, ".pi/agent/extensions/agent-goal/index.ts");
const PROBE = "/tmp/ag-accept/probe.ts";
const ROOT = "/tmp/ag-accept";
const SESS_DIR = path.join(ROOT, "sessions");
const WORK = path.join(ROOT, "work");
const PAYLOAD_LOG = path.join(ROOT, "payloads.jsonl");
const SID = "accept-goal-tracking";
const MODEL = (() => {
  const i = process.argv.indexOf("--model");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.ACC_MODEL || "trendmicro/deepseek-v4.1-flash";
})();

const clean = (s) => (s || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
const cleanDeep = (v) => (Array.isArray(v) ? v.map(cleanDeep) : typeof v === "string" ? clean(v) : v);
const PASS = (m) => { console.log(`  ✓ ${m}`); return true; };
const FAIL = (m) => { console.log(`  ✗ ${m}`); return false; };

fs.rmSync(ROOT, { recursive: true, force: true });
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
  "--thinking", "low",
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
  { id: "start", say: "在 /tmp/ag-accept/work 创建 data.txt，写入 20 行整数（每行一个），再写 summarize.mjs 读取它并打印总和与行数，然后实际运行 node summarize.mjs 验证。", modes: ["new"], goal: /summar|data|脚本|script/i, label: "task start" },
  { id: "constraint", say: "summarize.mjs 还要输出最大值和中位数，改完重新运行一次。", modes: ["rewrite", "expand"], goal: /summar|data|脚本|script/i, label: "added constraint (same outcome)" },
  { id: "subproblem", say: "先把 data.txt 第 7 行的数字改成 70 —— 这是修数据的前置问题，处理完再继续。", modes: ["expand", null], goal: /summar|data|脚本|script/i, label: "sub-problem (parent must survive)" },
  { id: "step", say: "把 summarize.mjs 里的变量名改得更清楚一点。", modes: ["expand", null], goal: /summar|data|脚本|script/i, label: "mere step (no reset)" },
  { id: "pivot", say: "脚本先不管了，改做另一件事：在 /tmp/ag-accept/work 写一个 README.md，说明这个目录里有什么。", modes: ["new"], goal: /readme/i, label: "pivot to a different outcome" },
  { id: "continue", say: "README.md 里再补一段运行示例。", modes: ["rewrite", "expand", null], goal: /readme/i, label: "continue the same outcome" },
];

const widgets = () => records
  .filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal")
  .map((r) => cleanDeep(r.widgetLines));
const footerStatusWrites = () => records
  .filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "agent-status");

function readSession() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.includes(SID) && f.endsWith(".jsonl")); } catch {}
  if (!files.length) return [];
  files.sort();
  return fs.readFileSync(path.join(SESS_DIR, files[files.length - 1]), "utf8")
    .split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Calls grouped by the user turn that started them. */
function callsByTurn() {
  const turns = [];
  for (const e of readSession()) {
    const m = e.message;
    if (e.type !== "message" || !m) continue;
    if (m.role === "user") { turns.push([]); continue; }
    if (m.role !== "assistant" || !turns.length) continue;
    for (const c of m.content ?? []) {
      if (c.type === "toolCall" && (c.name ?? c.toolName) === "set_goal") {
        turns[turns.length - 1].push({ mode: c.arguments?.mode ?? "new", goal: clean(c.arguments?.goal) });
      }
    }
  }
  return turns;
}

/** Persisted goal after each user turn (the state entry written in that turn). */
function stateByTurn() {
  const turns = [];
  for (const e of readSession()) {
    if (e.type === "message" && e.message?.role === "user") { turns.push(null); continue; }
    if (e.type === "custom" && e.customType === "agent-goal-state" && e.data && turns.length) {
      turns[turns.length - 1] = { goal: clean(e.data.goal), subGoal: clean(e.data.subGoal) };
    }
  }
  return turns;
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

(async () => {
  let ok = true;
  try {
    console.log(`== goal-tracking acceptance · ${MODEL} ==`);
    for (const t of TURNS) await turn(t.say);

    const perTurn = callsByTurn();
    const state = stateByTurn();

    console.log("\n-- what the model declared, per user turn --");
    TURNS.forEach((t, i) => {
      const calls = perTurn[i] ?? [];
      const shown = calls.length ? calls.map((c) => `${c.mode}: ${c.goal}`).join(" | ") : "(no call)";
      console.log(`  ${i + 1}. ${t.id.padEnd(10)} ${shown.slice(0, 150)}`);
    });

    console.log("\n-- goal tracking --");
    TURNS.forEach((t, i) => {
      const calls = perTurn[i] ?? [];
      const last = calls.length ? calls[calls.length - 1] : null;
      const modeOk = t.modes.includes(last ? last.mode : null);
      ok = (modeOk
        ? PASS(`${t.label}: mode ${last ? `"${last.mode}"` : "(none)"}`)
        : FAIL(`${t.label}: expected mode ${JSON.stringify(t.modes)}, got ${last ? `"${last.mode}"` : "(none)"}`)) && ok;

      const persisted = state[i];
      const goalOk = persisted && t.goal.test(persisted.goal || "");
      ok = (goalOk
        ? PASS(`${t.label}: goal line still tracks the task ("${(persisted.goal || "").slice(0, 60)}")`)
        : FAIL(`${t.label}: goal line lost the task (got "${persisted ? persisted.goal : "(none)"}")`)) && ok;

      if (t.id === "subproblem" || t.id === "step") {
        const nested = persisted?.subGoal;
        const fine = !calls.length || (last.mode === "expand" && (nested || "").length > 0);
        ok = (fine
          ? PASS(`${t.label}: parent kept${nested ? `, focus nested as "${nested.slice(0, 50)}"` : ", no call"}`)
          : FAIL(`${t.label}: parent/focus handling wrong (mode ${last.mode}, subGoal "${nested || ""}")`)) && ok;
      }
    });

    console.log("\n-- display --");
    const all = widgets().filter(Boolean);
    const goalRenders = all.flat().filter((l) => typeof l === "string" && l.startsWith("agent_goal:"));
    const nestedRenders = all.flat().filter((l) => typeof l === "string" && l.trim().startsWith("└─"));
    ok = (goalRenders.length > 0 ? PASS(`goal line rendered ${goalRenders.length}x`) : FAIL("goal line never rendered")) && ok;
    ok = (goalRenders.length >= 2 && new Set(goalRenders).size >= 2 ? PASS(`goal line updated ${new Set(goalRenders).size} distinct texts`) : FAIL("goal line never changed")) && ok;
    ok = (nestedRenders.length > 0 ? PASS(`nested focus row rendered: "${nestedRenders[0].trim().slice(0, 60)}"`) : FAIL("no └─ focus row was rendered")) && ok;
    ok = (footerStatusWrites().length === 0 ? PASS("footer status line untouched (the widget is the only surface)") : FAIL(`no agent-status footer writes (got ${footerStatusWrites().length})`)) && ok;

    console.log("\n-- OFF --");
    const offAt = records.length;
    const callsBeforeOff = perTurn.flat().length;
    proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "/agent-goal off" })}\n`);
    await waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal" && r.widgetLines === undefined, "widget cleared", 60000);
    await turn("再给 data.txt 追加一行 42，然后告诉我总行数。");
    const callsAfterOff = callsByTurn().flat().length;
    const painted = records.slice(offAt).filter((r) => r.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "agent-goal" && r.widgetLines && r.widgetLines.length > 0).length;
    ok = (callsAfterOff === callsBeforeOff ? PASS(`no declaration after OFF (${callsBeforeOff} -> ${callsAfterOff})`) : FAIL(`declared after OFF (${callsBeforeOff} -> ${callsAfterOff})`)) && ok;
    ok = (painted === 0 ? PASS("widget stayed cleared after OFF") : FAIL(`widget repainted ${painted}x after OFF`)) && ok;

    proc.stdin.end();
    await new Promise((r) => { if (exited) return r(); const t = setTimeout(() => { proc.kill("SIGTERM"); r(); }, 15000); proc.on("exit", () => { clearTimeout(t); r(); }); });

    const files = fs.readdirSync(WORK).sort();
    console.log(`\n-- real work on disk --\n  ${files.join(", ")}`);
    ok = (files.includes("data.txt") && files.includes("summarize.mjs") && files.includes("README.md") ? PASS("the agent really did the work with its own tools") : FAIL(`missing files: ${files.join(", ")}`)) && ok;

    console.log(`\n-- scheduling cost (informational, expected) --\n  status-only turns: ${statusOnlyTurns()}`);
    console.log(`\n===== ${ok ? "GOAL TRACKING ACCEPTED" : "GOAL TRACKING FAILED"} =====`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`\n✗ acceptance threw: ${e.message}`);
    try { proc.kill("SIGTERM"); } catch {}
    process.exit(1);
  }
})();
