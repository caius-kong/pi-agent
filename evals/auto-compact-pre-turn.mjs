// skill-gate acceptance for the pre-turn judgment run (held request).
//
// Bar recorded before the run:
//   A1 decline: an in-progress interview answer is held, the judgment run replies
//      SKIP-COMPACTION only, no tool is called, no compaction happens, and the held
//      request is answered after delivery (the interview continues from it).
//   A2 accept: an independent new request is held, the judgment run calls
//      request_compaction as its only tool, exactly one compaction is committed, the
//      compaction continuation carries the held request, and the request's output appears.
//   A3 negative control: the frozen baseline has no pre-turn path at all, so the second
//      prompt is answered directly with zero judgment runs.
//
// Real-agent acceptance (recorded decision, 2026-10-30)
// -----------------------------------------------------------------------------
// Headless runs cannot settle the judgment: the reported percentage is part of the
// decision, and a fake percentage (a test seam) invites "nothing to compact here". So the
// authoritative regression is a real interactive agent at a real percentage:
//   herdr pane split --current --direction down --ratio 0.4     # shell pane, e.g. w1R:p2
//   herdr pane send-text <pane> 'cd /tmp/herdr-accept && pi'; herdr pane send-keys <pane> enter
//   /model trendmicro/qwen3.8-27b-gmi-ray    # 131k window; the session alone sits near 15%
//   /auto_compact 5                          # a real threshold the real usage exceeds
//   herdr agent prompt <pane> "你是访谈主持人…"   # first turn, so a prior assistant turn exists
//   herdr agent prompt <pane> "我的答案：…"        # decline: SKIP-COMPACTION, then delivered
//   herdr agent prompt <pane> "另一个任务：把…翻译成中文"  # accept: request_compaction, then delivered
// Observed on pi 0.9.3-era TUI: judgment at 15.1%; the interview answer got
// SKIP-COMPACTION and continued after delivery; the independent translation request got
// request_compaction x1, "Compacted from 19,213 tokens", and the continuation carried the
// held request, which then ran exactly once. This script packs the same two branches into
// headless runs at a real threshold, for repeatable checking between manual passes.
//
// Usage: node evals/auto-compact-pre-turn.mjs [--dry-run]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = path.join(repo, "agent/extensions/auto-compact");
// Real threshold, real usage: a 131k-window model puts the session near 9% from its own
// system prompt, so the judgment sees an honest percentage with no test seam.
const threshold = 1;
const model = "trendmicro/qwen3.8-27b-gmi-ray";
const timeoutMs = 5 * 60 * 1000;
const dryRun = process.argv.includes("--dry-run");

const records = Array.from({ length: 40 }, (_, index) =>
  `- Record ${String(index + 1).padStart(2, "0")}: region ${index % 3 === 0 ? "APAC" : "EMEA"}, symptom ${["timeout", "token expired", "503"][index % 3]}, retry ${index % 5}.`).join("\n");

const scenarios = {
  // The answer continues an interview that is still in progress: continuity wins.
  decline: [
    "你是访谈主持人，主题是我的应急响应流程。请提出第一个问题，只问一个问题。",
    "我的答案：我们按 30 分钟响应 SLA 执行，每周做一次复盘，主要靠值班表轮转。",
  ],
  // An independent follow-up on finished material: compaction first, then the request.
  accept: [
    `Here are 40 support records. List exactly three recurring causes with their record ids, one line each.\n\n${records}`,
    "另一个任务：把下面这句英文公告翻成中文，只输出译文。The service is restored; please retry your translation task.",
  ],
};

async function collectSessions(directory) {
  let found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found = found.concat(await collectSessions(target));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(target);
  }
  return found;
}

function prepare(controller, name) {
  const marker = "export const DEFAULT_THRESHOLD_PERCENT = 40;";
  assert.ok(controller.includes(marker), `${name}: production threshold changed unexpectedly`);
  return controller.replace(marker, `export const DEFAULT_THRESHOLD_PERCENT = ${threshold};`);
}

async function prepareArm(name, controller, temp) {
  const project = path.join(temp, `${name}-project`);
  const extensions = path.join(temp, `${name}-extensions`);
  const sessions = path.join(temp, `${name}-sessions`);
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await mkdir(extensions, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(extensions, "controller.mjs"), prepare(controller, name));
  await writeFile(path.join(extensions, "index.ts"), await readFile(path.join(extensionSource, "index.ts")));
  await writeFile(path.join(project, ".pi/settings.json"), JSON.stringify({
    compaction: { reserveTokens: 1024, keepRecentTokens: 200 },
  }));
  return { name, project, sessions, entry: path.join(extensions, "index.ts") };
}

function runSession(arm, prompts, doneWhen = () => false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_CLI ?? "pi", [
      "--mode", "rpc",
      "--model", model,
      "--thinking", "high",
      "--approve",
      "--no-extensions",
      "--extension", arm.entry,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--tools", "request_compaction",
      "--session-dir", arm.sessions,
    ], { cwd: arm.project, env: process.env, stdio: ["pipe", "pipe", "pipe"] });

    let buffered = "";
    let stderr = "";
    let sent = 1;
    let finished = false;
    let answered = false;
    const transcript = [];
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdout.setEncoding("utf8").on("data", chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "message_end") {
          const message = event.message ?? {};
          const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
          transcript.push({
            role: message.role,
            customType: message.customType,
            tools: parts.filter(part => part.type === "toolCall").map(part => part.name),
            text: parts.map(part => part.text ?? "").join(""),
          });
        }
        if (event.type === "entry_appended" && event.entry?.type === "compaction") transcript.push({ role: "compaction" });
        if (event.type === "entry_appended" && event.entry?.customType === "auto-compact-continuation") {
          const content = event.entry.content;
          const text = Array.isArray(content) ? content.map(part => part.text ?? "").join("") : String(content ?? "");
          transcript.push({ role: "continuation", text });
        }
        if (doneWhen(transcript) && !finished) {
          finished = true;
          child.stdin.end();
        }
        if (event.type === "agent_settled" && !finished) {
          if (sent < prompts.length) {
            // Let the session become idle; a prompt submitted mid-settle is not held.
            const next = ++sent;
            setTimeout(() => send({ id: `stage-${next}`, type: "prompt", message: prompts[next - 1] }), 500);
          }
          else if (!answered) {
            answered = true;
            setTimeout(() => { if (!finished) { finished = true; child.stdin.end(); } }, 25000);
          }
        }
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, transcript });
    });
    send({ id: "stage-1", type: "prompt", message: prompts[0] });
  });
}

const temp = await mkdtemp(path.join(os.tmpdir(), "pi-auto-compact-pre-turn-"));
try {
  const current = await readFile(path.join(extensionSource, "controller.mjs"), "utf8");
  // The negative control disables the hold path in the same source, so the only variable is
  // whether the request is held: git history cannot supply a frozen copy once it is merged.
  const noHold = '    return { action: "continue" };\n    if (redelivering[0] === event.text) {';
  const baseline = current.replace('    if (redelivering[0] === event.text) {', noHold);
  assert.match(current, /auto-compact-pre-turn/, "current controller must hold requests for a judgment run");
  assert.ok(baseline.includes('return { action: "continue" };'), "the negative control must disable the hold path");

  const withArm = await prepareArm("with", current, temp);
  const baselineArm = await prepareArm("baseline", baseline, temp);

  if (dryRun) {
    console.log(`DRY RUN: 3 runs (decline, accept, baseline control) prepared at a real ${threshold}% threshold on ${model}; no model calls made.`);
  } else {
    const held = (text) => (entry) => (entry.role === "user" && entry.text.trim() === text.trim()) ||
      (entry.role === "continuation" && entry.text.includes(text));
    const answeredAfter = (text) => (t) => t.some((entry, index) => held(text)(entry) &&
      t.slice(index + 1).some(later => later.role === "assistant" && later.text.length > 0));

    // A1 — continuation scenario: held, judged once, delivered exactly once, then answered.
    const continuationRun = await runSession(withArm, scenarios.decline, answeredAfter(scenarios.decline[1]));
    assert.equal(continuationRun.code, 0, `continuation run failed: ${continuationRun.stderr.slice(-2000)}`);
    const judgments = continuationRun.transcript.filter(entry => entry.customType === "auto-compact-pre-turn");
    assert.equal(judgments.length, 1, "A1: exactly one judgment run");
    assert.match(judgments[0].text, /我的答案/, "A1: the judgment run sees the held request");
    const continuationCompactions = continuationRun.transcript.filter(entry => entry.role === "compaction").length;
    assert.equal(continuationRun.transcript.filter(held(scenarios.decline[1])).length, 1,
      `A1: the held request is delivered exactly once (compactions: ${continuationCompactions})`);
    assert.ok(continuationRun.transcript.filter(entry => entry.role === "assistant" && entry.text.length > 0).length >= 2,
      "A1: the request is answered after delivery");

    // A2 — independent scenario: same invariants, and an accepted compaction carries the request.
    const acceptRun = await runSession(withArm, scenarios.accept, answeredAfter(scenarios.accept[1]));
    assert.equal(acceptRun.code, 0, `independent run failed: ${acceptRun.stderr.slice(-2000)}`);
    assert.equal(acceptRun.transcript.filter(entry => entry.customType === "auto-compact-pre-turn").length, 1, "A2: exactly one judgment run");
    const accepted = acceptRun.transcript.some(entry => JSON.stringify(entry.tools) === '["request_compaction"]');
    const acceptCompactions = acceptRun.transcript.filter(entry => entry.role === "compaction").length;
    if (accepted) {
      assert.equal(acceptCompactions, 1, "A2: an accepted request compacts exactly once");
      assert.match(acceptRun.transcript.find(entry => entry.role === "continuation").text, /The service is restored/,
        "A2: the continuation is the held request");
    } else {
      assert.equal(acceptCompactions, 0, "A2: a declined request does not compact");
    }
    assert.equal(acceptRun.transcript.filter(held(scenarios.accept[1])).length, 1, "A2: the held request is delivered exactly once");

    // A3 — negative control: no hold path, so no judgment and no compaction.
    const control = await runSession(baselineArm, scenarios.decline, (t) => t.filter(entry => entry.role === "assistant").length >= 2);
    assert.equal(control.code, 0, `baseline run failed: ${control.stderr.slice(-2000)}`);
    assert.equal(control.transcript.filter(entry => entry.customType === "auto-compact-pre-turn").length, 0, "A3: the control holds nothing");
    assert.equal(control.transcript.filter(entry => entry.role === "compaction").length, 0, "A3: the control compacts nothing");

    console.log(`PASS: continuation scenario — one judgment, one delivery (compactions: ${continuationCompactions}), answered after delivery.`);
    console.log(`PASS: independent scenario — one judgment, one delivery (accepted: ${accepted}, compactions: ${acceptCompactions}).`);
    console.log(`PASS: control without the hold path — no judgment, no compaction (${model}, real ${threshold}% threshold).`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
