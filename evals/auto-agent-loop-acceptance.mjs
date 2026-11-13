// End-to-end acceptance for the auto-agent-loop admission change: a real headless Pi
// process, the unmodified extension, and the configured Flash and Jev models.
//
// What it proves, and why each part is needed:
//   1. ctx.getContextUsage() really reports a finite token count at agent_before_settle
//      in a live process - the measurement the admission guard now rests on.
//   2. After the byte/estimate code was removed, a real settle boundary still produces a
//      real Flash summary and a real Jev probability, and no capacity error.
// The >1M-token direction (the guard refusing an oversized context) is covered by
// tests/auto-agent-loop-guard.test.mjs: driving a real 1M-token context through two paid
// models is not something this acceptance is allowed to spend.
//
// Cost: one main-model turn, at most one Flash summary and one Jev verdict.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = path.join(repo, "agent/extensions/auto-agent-loop");
const temp = await mkdtemp(path.join(os.tmpdir(), "pi-auto-agent-loop-acceptance-"));
const project = path.join(temp, "project");
const extensions = path.join(temp, "extensions");
const sessions = path.join(temp, "sessions");
const model = "trendmicro/qwen3.8-27b-gmi-ray";
const timeoutMs = 8 * 60 * 1000;

async function collectFiles(directory) {
  let found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found = found.concat(await collectFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(target);
  }
  return found;
}

function runPi(prompts) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print", "--mode", "json",
      "--model", model, "--thinking", "off", "--approve",
      "--no-extensions",
      "--extension", path.join(extensions, "index.ts"),
      "--extension", path.join(extensions, "probe.ts"),
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
      "--tools", "read",
      "--session-dir", sessions,
      ...prompts,
    ];
    const child = spawn(process.env.PI_CLI ?? "pi", args, { cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

try {
  await mkdir(path.join(project, "inputs"), { recursive: true });
  await mkdir(extensions, { recursive: true });
  await mkdir(sessions, { recursive: true });

  // The production controller, unmodified. Only the entry point differs: it supplies the
  // config inline so the acceptance does not depend on the machine's settings.json.
  await writeFile(path.join(extensions, "controller.mjs"), await readFile(path.join(extensionSource, "controller.mjs")));
  await writeFile(path.join(extensions, "index.ts"), `import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, registerAgentLoop } from "./controller.mjs";
// The same lookup the shipped index.ts does: pi-ai is pi's dependency, so it is taken from
// pi's package - as a sibling of it, else inside its node_modules - and imported by path.
function typesafeSystemOne() {
  const relative = join("pi-ai", "dist", "api", "typesafe-system-one.lazy.js");
  const candidates = [
    join(getPackageDir(), "..", relative),
    join(getPackageDir(), "node_modules", "@earendil-works", relative),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("typesafe-system-one module not found: neither " + candidates.join(" nor ") + " exists");
  return found;
}
export default function (pi: any) {
  registerAgentLoop(pi, {
    getConfig: () => ({ ...DEFAULT_CONFIG, enabled: true, maxContinuations: 1, timeoutMs: 240_000 }),
    loadTypesafeProvider: () => import(pathToFileURL(typesafeSystemOne()).href),
  });
}
`);
  // Records what pi reports about the context at the exact boundary the guard reads.
  await writeFile(path.join(extensions, "probe.ts"), `export default function (pi: any) {
  pi.on("agent_before_settle", (_event: unknown, ctx: any) => {
    const usage = ctx.getContextUsage?.();
    console.error("PROBE contextUsage=" + JSON.stringify(usage ?? null));
  });
}
`);

  await writeFile(path.join(project, "inputs/plan.md"), [
    "# Release checklist",
    "",
    "Step 1: read this file and report its exact release code.",
    "Step 2: append -VERIFIED to the release code and report the result.",
    "",
    "Release code: EMBER-31.",
    "",
  ].join("\n"));

  const prompt = "Read inputs/plan.md. Do step 1 now: report the exact release code. Step 2 is required and already authorized, but it must happen after this turn ends - do not do it now, and do not ask me to confirm it.";

  const result = await runPi([prompt]);
  assert.equal(result.code, 0, `pi exited with ${result.code ?? result.signal}. stderr: ${result.stderr.slice(-4000)}`);

  // 1. The measurement the guard reads exists and is a real count in a live process.
  const probes = [...result.stderr.matchAll(/PROBE contextUsage=(.+)/gu)].map((match) => JSON.parse(match[1]));
  assert.ok(probes.length > 0, `probe never ran at a settle boundary. stderr: ${result.stderr.slice(-4000)}`);
  const usage = probes.at(-1);
  assert.ok(Number.isFinite(usage?.tokens) && usage.tokens > 0, `getContextUsage() must report tokens, got ${JSON.stringify(usage)}`);
  assert.ok(Number.isFinite(usage?.percent) && usage.percent > 0 && usage.percent < 100, `percent must be a real percentage, got ${JSON.stringify(usage)}`);
  assert.ok(usage.contextWindow > 0, `contextWindow must be declared, got ${JSON.stringify(usage)}`);

  // 2. No admission false positive: the reported count is far under Flash's window.
  assert.doesNotMatch(result.stderr, /Flash context capacity/u, `the guard rejected a small context: ${result.stderr.slice(-4000)}`);

  // 3. The pipeline still ran end to end on the real models after the cleanup.
  const entries = (await Promise.all((await collectFiles(sessions)).map((file) => readFile(file, "utf8"))))
    .join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const states = entries.filter((entry) => entry.type === "custom" && entry.customType === "auto-agent-loop-state").map((entry) => entry.data);
  assert.ok(states.length > 0, "the loop never persisted a state entry at a settle boundary");
  const failed = states.filter((state) => state.status === "error" || state.error);
  assert.equal(failed.length, 0, `the loop hit an error: ${JSON.stringify(failed.at(-1) ?? null).slice(-600)}`);
  const judged = states.filter((state) => Number.isFinite(state.probability));
  assert.ok(judged.length > 0, `Jev never returned a probability: ${JSON.stringify(states.at(-1)).slice(-800)} stderr: ${result.stderr.slice(-2000)}`);
  const state = judged.at(-1);
  assert.match(state.summary ?? "", /\[\[SUMMARY-END\]\]/u, "the persisted summary did not come from a complete Flash response");
  assert.ok(state.probability >= 0 && state.probability <= 1, `probability out of range: ${state.probability}`);
  const verdicts = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "auto-agent-loop-continuation");
  console.log(`PASS: getContextUsage() reported ${usage.tokens.toLocaleString()} tokens (${usage.percent.toFixed(1)}% of ${usage.contextWindow.toLocaleString()}) at the settle boundary.`);
  console.log(`PASS: real Flash summary (${state.summary.length} chars) and real Jev verdict (probability ${state.probability}) with no capacity error.`);
  console.log(`PASS: ${verdicts.length} continuation message(s) injected; state entries: ${states.length}.`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
