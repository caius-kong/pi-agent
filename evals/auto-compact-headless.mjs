import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = path.join(repo, "agent/extensions/auto-compact");
const temp = await mkdtemp(path.join(os.tmpdir(), "pi-auto-compact-headless-"));
const project = path.join(temp, "project");
const extensions = path.join(temp, "extensions");
const sessions = path.join(temp, "sessions");
const threshold = 5;
const model = "trendmicro/qwen3.8-27b-gmi-ray";
const timeoutMs = 5 * 60 * 1000;

async function collectFiles(directory) {
  let found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found = found.concat(await collectFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(target);
  }
  return found;
}

function piArgs(mode) {
  return [
    "--mode", mode,
    "--model", model,
    "--thinking", "off",
    "--approve",
    "--no-extensions",
    "--extension", path.join(extensions, "index.ts"),
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--tools", "read,request_compaction",
    "--session-dir", sessions,
  ];
}

function runPi(prompts, mode = "text") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_CLI ?? "pi", ["--print", ...piArgs(mode), ...prompts], {
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

function runPiRpc(firstPrompt, secondPrompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_CLI ?? "pi", piArgs("rpc"), {
      cwd: project, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let stageOneComplete = false;
    let stageTwoSent = false;
    let finalAnswerSeen = false;
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = (event.message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
          if (text.includes("STAGE1-DONE") && !stageTwoSent) stageOneComplete = true;
          if (text.includes("CINDER-47-VERIFIED")) finalAnswerSeen = true;
        }
        if (event.type === "agent_settled") {
          if (stageOneComplete && !stageTwoSent) {
            stageTwoSent = true;
            send({ id: "stage-2", type: "prompt", message: secondPrompt });
          } else if (finalAnswerSeen) {
            child.stdin.end();
          }
        }
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    send({ id: "stage-1", type: "prompt", message: firstPrompt });
  });
}

try {
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await mkdir(extensions, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const controller = await readFile(path.join(extensionSource, "controller.mjs"), "utf8");
  const productionThreshold = "export const DEFAULT_THRESHOLD_PERCENT = 40;";
  assert.ok(controller.includes(productionThreshold), "production threshold changed unexpectedly");
  await writeFile(path.join(extensions, "controller.mjs"), controller.replace(
    productionThreshold,
    `export const DEFAULT_THRESHOLD_PERCENT = ${threshold};`,
  ));
  await writeFile(path.join(extensions, "index.ts"), await readFile(path.join(extensionSource, "index.ts")));
  await writeFile(path.join(project, ".pi/settings.json"), JSON.stringify({
    compaction: { reserveTokens: 4096, keepRecentTokens: 1000 },
  }));

  const inputs = path.join(project, "inputs");
  await mkdir(inputs, { recursive: true });
  const inputFiles = Array.from({ length: 18 }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    const target = index === 9 ? " TARGET-CODE: CINDER-47." : "";
    const body = `Archive segment ${id}. This is historical reference material for a staged verification. Retain relevant identifiers; do not summarize away exact code values.\n`
      + Array.from({ length: 24 }, (_, row) => `Record ${id}-${String(row + 1).padStart(2, "0")}: the observation remains stable; sequence label ${id}-${row + 1} is retained for the audit.${row === 11 ? target : ""}`).join("\n");
    return { name: `segment-${id}.txt`, body };
  });
  await Promise.all(inputFiles.map(file => writeFile(path.join(inputs, file.name), file.body)));
  const firstPrompt = `Use the read tool to inspect every file under inputs/: ${inputFiles.map(file => file.name).join(", ")}. Identify the exact TARGET-CODE and reply only STAGE1-DONE followed by that code. Do not call request_compaction during this stage even if a check appears; the next message will provide a safe checkpoint.`;
  const secondPrompt = "Stage 1 is complete. Stage 2 remains: append -VERIFIED to the exact TARGET-CODE and return only the transformed code. This acceptance test deliberately sets the extension threshold to 5%, and the context is above it. Stage 1 is a coherent completed unit, stage 2 remains, and no tool, delegated work, user message, or decision is pending. Call request_compaction as the only tool now, then continue with stage 2.";
  const models = JSON.parse(await readFile(path.join(repo, "agent/models.json"), "utf8"));
  const configuredModel = models.providers.trendmicro.models.find(entry => entry.id === "qwen3.8-27b-gmi-ray");
  assert.ok(configuredModel?.contextWindow, "configured test model must declare its context window");
  const promptChars = inputFiles.reduce((sum, file) => sum + file.body.length, 0);
  assert.ok(promptChars > configuredModel.contextWindow * threshold / 100 * 4, "readable records must exceed the 5% character-estimate threshold");

  const mode = process.argv.includes("--rpc") ? "rpc" : process.argv.includes("--json") ? "json" : "text";
  const result = mode === "rpc"
    ? await runPiRpc(firstPrompt, secondPrompt)
    : await runPi([firstPrompt, secondPrompt], mode);
  assert.equal(result.code, 0, `Pi exited with ${result.code ?? result.signal}. stderr: ${result.stderr.slice(-4000)} stdout tail: ${result.stdout.slice(-5000)}`);
  assert.doesNotMatch(result.stderr, /Automatic compaction failed/, `compaction failed: ${result.stderr.slice(-4000)}`);
  if (result.stdout.trimStart().startsWith("{")) {
    const events = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const finalText = events.filter(event => event.type === "message_end" && event.message?.role === "assistant")
      .flatMap(event => event.message.content ?? [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");
    assert.ok(events.some(event => event.type === "agent_end"), "JSON mode should emit lifecycle events");
    assert.ok(events.some(event => event.type === "entry_appended" && event.entry?.type === "compaction"), "JSON mode should report successful boundary compaction");
    assert.ok(events.some(event => event.type === "entry_appended" && event.entry?.type === "custom_message" && event.entry?.customType === "auto-compact-continuation"), "JSON mode should report the continuation draft");
    assert.match(finalText, /CINDER-47-VERIFIED/, `final JSON-mode continuation missing: ${finalText.slice(-4000)}`);
  } else {
    assert.match(result.stderr, /\[auto-compact\] Automatic compaction completed and is active in the session context\./, "print mode must explicitly report successful auto-compaction on stderr");
    assert.match(result.stdout, /CINDER-47-VERIFIED/, `final continuation missing. exit=${result.code} stderr: ${result.stderr.slice(-6000)} stdout: ${result.stdout.slice(-4000)}`);
  }

  const sessionFiles = await collectFiles(sessions);
  assert.ok(sessionFiles.length > 0, "Pi did not persist a test session");
  const entries = (await Promise.all(sessionFiles.map(file => readFile(file, "utf8"))))
    .join("\n")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const compactions = entries.filter(entry => entry.type === "compaction");
  assert.equal(compactions.length, 1, "expected exactly one persisted compaction");
  assert.ok(compactions[0].summary.length > 0, "compaction summary should be persisted");
  const continueMessages = entries.filter(entry => entry.type === "custom_message" && entry.customType === "auto-compact-continuation")
    .filter(entry => JSON.stringify(entry.content).includes("Context was compacted. Continue the task."));
  assert.equal(continueMessages.length, 1, "expected exactly one continuation draft");
  console.log(`PASS: ${model} ${mode} mode compacted once at temporary ${threshold}% threshold and resumed to the final answer.`);
  console.log(`PASS: one compaction entry and one continuation message persisted; the production threshold remains 40%.`);
  console.log(`Configured context window: ${configuredModel.contextWindow.toLocaleString()} tokens; readable records: ${promptChars.toLocaleString()} characters. Temporary threshold override and session were removed.`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
