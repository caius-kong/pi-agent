import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = path.join(repo, "agent/extensions/auto-compact");
const temp = await mkdtemp(path.join(os.tmpdir(), "pi-auto-compact-herdr-"));
const project = path.join(temp, "project");
const extensions = path.join(temp, "extensions");
const sessions = path.join(temp, "sessions");
const model = "trendmicro/qwen3.8-27b";
const timeoutMs = 5 * 60 * 1000;

async function collectFiles(directory) {
  let files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files = files.concat(await collectFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
  }
  return files;
}

function spawnPi(prompts, mode = "text") {
  return new Promise((resolve, reject) => {
    const args = [
      "--print", "--mode", mode, "--model", model, "--thinking", "off", "--approve",
      "--no-extensions", "--extension", path.join(extensions, "index.ts"),
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
      "--tools", "read,bash,request_compaction", "--session-dir", sessions,
      ...prompts,
    ];
    const child = spawn(process.env.PI_CLI ?? "pi", args, {
      cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

try {
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await mkdir(extensions, { recursive: true });
  await mkdir(sessions, { recursive: true });

  const controller = await readFile(path.join(extensionSource, "controller.mjs"), "utf8");
  assert.ok(controller.includes("export const DEFAULT_THRESHOLD_PERCENT = 40;"), "production default must remain 40%");
  const testController = controller.replace(
    "export const DEFAULT_THRESHOLD_PERCENT = 40;",
    "export const DEFAULT_THRESHOLD_PERCENT = 5;",
  );
  assert.notEqual(testController, controller, "temporary agent default must be changed to 5%");
  await writeFile(path.join(extensions, "controller.mjs"), testController);
  await writeFile(path.join(extensions, "index.ts"), await readFile(path.join(extensionSource, "index.ts")));
  await writeFile(path.join(project, ".pi/settings.json"), JSON.stringify({
    compaction: { reserveTokens: 4096, keepRecentTokens: 1000 },
  }));

  const inputDir = path.join(project, "inputs");
  await mkdir(inputDir, { recursive: true });
  const records = Array.from({ length: 20 }, (_, index) => {
    const fileId = String(index + 1).padStart(2, "0");
    const target = index === 9 ? " TARGET-CODE: MAPLE-82." : "";
    const body = `Stage verification record ${fileId}. Preserve exact identifiers; this is reference material for a two-stage continuation.\n`
      + Array.from({ length: 40 }, (_, row) => `Entry ${fileId}-${String(row + 1).padStart(2, "0")}: immutable audit marker ${fileId}-${String(row + 1).padStart(2, "0")}. Every marker is unique and must not be confused with other records.${row === 11 ? target : ""}`).join("\n");
    return { name: `segment-${fileId}.txt`, body };
  });
  await Promise.all(records.map(record => writeFile(path.join(inputDir, record.name), record.body)));

  const first = `Use bash to inspect every file in inputs/: ${records.map(record => record.name).join(", ")}. Find the exact TARGET-CODE and reply only STAGE1-DONE followed by that code. Do not call request_compaction in stage 1; wait for the next user message.`;
  const stageTwo = `The stage 1 result is TARGET-CODE: MAPLE-82. Stage 2 remains: append -VERIFIED to that exact code and reply only with the transformed code. This is the safe checkpoint: stage 1 ended as a distinct completed assistant answer; no tools are running, no delegated work exists, and no decision is pending. Call request_compaction as the only tool now, then continue.`;
  const second = "Stage 1 is complete: the exact code is known. Stage 2 remains: append -VERIFIED to the exact TARGET-CODE and return only the transformed code. This is a safe checkpoint: stage 1 is a coherent work unit, nothing is pending, and stage 2 remains. Call request_compaction as the only tool now, then continue.";
  const models = JSON.parse(await readFile(path.join(repo, "agent/models.json"), "utf8"));
  const configuredModel = models.providers.trendmicro.models.find(entry => entry.id === "qwen3.8-27b");
  assert.ok(configuredModel?.contextWindow, "acceptance model must declare its context window");
  const inputChars = records.reduce((sum, record) => sum + record.body.length, 0);
  assert.ok(inputChars > configuredModel.contextWindow * 0.05 * 4, "input material must exceed the temporary 5% threshold estimate");

  const stageOne = await spawnPi([first]);
  assert.equal(stageOne.code, 0, `stage 1 failed: ${stageOne.stderr.slice(-2000)} ${stageOne.stdout.slice(-1000)}`);
  assert.match(stageOne.stdout, /STAGE1-DONE MAPLE-82/, "stage 1 did not identify the target code");
  const result = await spawnPi([stageTwo]);
  assert.equal(result.code, 0, `Pi exit ${result.code ?? result.signal}: ${result.stderr.slice(-2500)}\n${result.stdout.slice(-2500)}`);
  assert.match(result.stdout, /MAPLE-82-VERIFIED/, `continued task did not produce the exact final result; stdout=${result.stdout.slice(-3000)} stderr=${result.stderr.slice(-2000)}`);
  assert.match(result.stderr, /\[auto-compact\] Automatic compaction completed and is active in the session context\./, `print notification missing: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Automatic compaction failed/, "summary generation reported a failure");

  const sessionFiles = await collectFiles(sessions);
  assert.ok(sessionFiles.length > 0, "no test session was persisted");
  const entries = (await Promise.all(sessionFiles.map(file => readFile(file, "utf8"))))
    .join("\n").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const compactions = entries.filter(entry => entry.type === "compaction");
  assert.equal(compactions.length, 1, "expected exactly one persisted compaction entry");
  assert.ok(compactions[0].summary.length > 0, "compaction summary must not be empty");
  const continuation = entries.filter(entry => entry.type === "custom_message" && entry.customType === "auto-compact-continuation")
    .filter(entry => JSON.stringify(entry.content).includes("Context was compacted. Continue the task."));
  assert.equal(continuation.length, 1, "expected exactly one persisted continuation message");

  console.log(`PASS: ${model} completed the 5%-threshold auto-compact task.`);
  console.log("PASS: one compaction and one continuation were persisted; the final stage completed.");
  console.log("PASS: print mode reported compaction on stderr; production threshold remains 40%.");
  console.log(`Temporary project/session removed after test; input=${inputChars.toLocaleString()} characters, context=${configuredModel.contextWindow.toLocaleString()} tokens.`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
