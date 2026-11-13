/**
 * Real-data exactness regression for session-budget fork accounting.
 *
 * The extension only exposes cost through a 2-dp status string, so rounding
 * cannot prove cent-level accuracy. This test instead uses the extension's own
 * abort decision as a precise comparator (it aborts iff computedCost >= cap) and
 * binary-searches the cap to recover the computed total to ~1e-9. That total is
 * then compared against an independent reference implementation that re-derives
 * W and F straight from the recorded JSONL, sharing no code with the extension.
 *
 * It discovers the most recent recorded session that actually has a forks/
 * directory; if none exists (fresh machine, pruned history) it skips, because
 * there is nothing to validate against.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, cp, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createJiti } from "../agent/npm/node_modules/jiti/lib/jiti.cjs";

const SESSIONS_DIR = path.resolve("agent/sessions");

// A session still being appended cannot be compared: its copy tears mid-line, and
// its cost grows between the two reads. Only a quiet one holds still long enough.
const QUIET_MS = 120_000;

function forkCandidates() {
  if (process.env.SB_REALDATA_SESSION) return [{ file: path.resolve(process.env.SB_REALDATA_SESSION), mtimeMs: 0 }];
  if (!existsSync(SESSIONS_DIR)) return [];
  const candidates = [];
  for (const project of readdirSync(SESSIONS_DIR)) {
    const projectDir = path.join(SESSIONS_DIR, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projectDir, name);
      const forksDir = joinForks(file);
      if (existsSync(forksDir) && readdirSync(forksDir).some((n) => n.endsWith(".jsonl"))) {
        candidates.push({ file, mtimeMs: statSync(file).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.filter((c) => Date.now() - c.mtimeMs > QUIET_MS);
}

const joinForks = (sessionFile) => path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "forks");

const lineCost = (v) => {
  if (v.type === "message") {
    const m = v.message ?? {};
    return m.role === "assistant" || m.role === "toolResult" ? m.usage?.cost?.total ?? 0 : 0;
  }
  if (v.type === "usage") return v.usage?.cost?.total ?? 0;
  if (v.type === "compaction" || v.type === "branch_summary") return v.usage?.cost?.total ?? 0;
  return 0;
};
const parse = (file) => readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const candidates = forkCandidates();

test("fork increment on recorded data matches an independent reference exactly", { skip: candidates.length ? false : "no quiescent recorded session with forks/ (the newest are still being appended)" }, async (t) => {
  // --- extension, on a copy (source session is never mutated) ----------------
  const root = await mkdtemp(path.join(os.tmpdir(), "sb-realdata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const piShim = path.join(root, "pi-coding-agent.cjs");
  await writeFile(piShim, "module.exports = { getAgentDir: () => globalThis.__sbRealDataAgentDir };\n");
  const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": piShim } });
  const { default: ext } = await jiti.import(path.resolve("agent/extensions/session-budget/index.ts"));

  // The copy must parse whole before either side sees it: a torn copy from a live
  // append would be a snapshot defect, not a disagreement between the two sides.
  let srcFile;
  let sessionFile;
  let copyForks;
  let parentEntries;
  for (const [index, candidate] of candidates.entries()) {
    const attemptFile = path.join(root, "sessions", `try-${index}`, path.basename(candidate.file));
    const attemptForks = joinForks(attemptFile);
    try {
      await mkdir(path.dirname(attemptFile), { recursive: true });
      await cp(joinForks(candidate.file), attemptForks, { recursive: true });
      // The copies must point at each other, mirroring the real layout: fork
      // headers name their parent, and a sync fork toolResult names its fork file.
      // Leaving either pointing at the source makes the copy self-inconsistent
      // and the extension fails closed on "sync result fork session is missing".
      const srcForksPrefix = `${joinForks(candidate.file)}${path.sep}`;
      const copyForksPrefix = `${attemptForks}${path.sep}`;
      // Text-level, not field-level: a sync fork reference can sit in any of
      // several detail shapes, and a missed shape fails the extension closed.
      const rebaseLine = (line) => line.split(srcForksPrefix).join(copyForksPrefix);
      await writeFile(attemptFile, readFileSync(candidate.file, "utf8").split("\n").map(rebaseLine).join("\n"));
      for (const name of readdirSync(attemptForks).filter((n) => n.endsWith(".jsonl"))) {
        const f = path.join(attemptForks, name);
        const lines = readFileSync(f, "utf8").split("\n").map(rebaseLine);
        const header = JSON.parse(lines[0]);
        header.parentSession = attemptFile;
        lines[0] = JSON.stringify(header);
        await writeFile(f, lines.join("\n"));
      }
      parentEntries = parse(attemptFile).filter((v) => v.type !== "session");
      for (const name of readdirSync(attemptForks).filter((n) => n.endsWith(".jsonl"))) parse(path.join(attemptForks, name));
    } catch (error) {
      t.diagnostic(`snapshot of ${path.basename(candidate.file)} failed (${error?.message}); trying the next candidate`);
      continue;
    }
    srcFile = candidate.file;
    sessionFile = attemptFile;
    copyForks = attemptForks;
    break;
  }
  assert.ok(sessionFile, "every candidate session copy failed to snapshot (copy error or unparseable bytes)");

  // --- independent reference, derived from the SAME copied bytes ------------
  // Deriving it from the source path instead would race a concurrent append:
  // the reference and the extension could read different bytes.
  const parentIds = new Set(parentEntries.map((v) => v.id).filter(Boolean));
  const refW = parentEntries.reduce((a, v) => a + lineCost(v), 0);
  const accountedRuns = new Set();
  for (const entry of parentEntries) {
    const message = entry.message;
    if (message?.role !== "toolResult" || !message.usage) continue;
    const details = message.details ?? {};
    for (const key of ["runId", "asyncId"]) {
      if (typeof details[key] === "string") accountedRuns.add(details[key]);
    }
    for (const result of [...(details.results ?? []), ...(details.completions ?? []).flatMap((completion) => completion.results ?? [])]) {
      if (typeof result.sessionFile === "string") {
        const relative = path.relative(`${sessionFile.slice(0, -".jsonl".length)}`, result.sessionFile);
        accountedRuns.add(relative.split(path.sep)[0]);
      }
    }
  }
  let refU = 0;
  const parentSessionDir = sessionFile.slice(0, -".jsonl".length);
  for (const name of readdirSync(parentSessionDir).filter((entry) => statSync(path.join(parentSessionDir, entry)).isDirectory() && entry !== "forks")) {
    if (accountedRuns.has(name)) continue;
    const runRoot = path.join(parentSessionDir, name);
    for (const run of readdirSync(runRoot).filter((entry) => entry.startsWith("run-") && statSync(path.join(runRoot, entry)).isDirectory())) {
      const runDir = path.join(runRoot, run);
      for (const childName of readdirSync(runDir).filter((entry) => entry.endsWith(".jsonl"))) {
        for (const entry of parse(path.join(runDir, childName))) {
          if (entry.type === "message" && entry.message?.role === "assistant") refU += entry.message.usage?.cost?.total ?? 0;
        }
      }
    }
  }
  // A fork dispatched synchronously is reported in the parent's toolResult, so its
  // assistant cost already sits inside W: charge it once, as the extension does.
  const reportedForkFiles = new Set();
  for (const entry of parentEntries) {
    const details = entry.message?.details ?? {};
    for (const result of [...(details.results ?? []), ...(details.completions ?? []).flatMap((completion) => completion.results ?? [])]) {
      if (typeof result?.sessionFile === "string" && result.sessionFile.includes(`${path.sep}forks${path.sep}`)) reportedForkFiles.add(path.resolve(result.sessionFile));
    }
  }
  let refF = 0;
  for (const name of readdirSync(copyForks).filter((n) => n.endsWith(".jsonl"))) {
    const forkFile = path.resolve(copyForks, name);
    for (const v of parse(forkFile)) {
      if (v.type === "session") continue;
      if (v.id && parentIds.has(v.id)) continue; // inherited, already in W
      if (reportedForkFiles.has(forkFile) && v.type === "message" && v.message?.role === "assistant") continue; // already in W
      refF += lineCost(v);
    }
  }

  const agentDir = path.join(root, "agent");
  const settingsFile = path.join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  globalThis.__sbRealDataAgentDir = agentDir;
  t.after(() => { delete globalThis.__sbRealDataAgentDir; });

  const entries = parse(sessionFile).filter((v) => v.type !== "session");
  const handlers = new Map();
  ext({ on: (e, h) => handlers.set(e, h), registerCommand: () => {} });
  let aborts = 0;
  const ctx = {
    cwd: path.dirname(sessionFile),
    hasUI: false,
    sessionManager: { getEntries: () => entries, getSessionFile: () => sessionFile, getHeader: () => ({ type: "session", id: "realdata" }) },
    ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, text) => text } },
    abort: () => { aborts++; },
  };

  // Binary-search the cap to recover the extension's computed total. A cap is a
  // coarse instrument: past the ceiling the search saturates, and a fail-closed
  // abort (rejected fork ledger) fires at every cap, so probe that separately and
  // say which happened instead of reporting the ceiling as the computed cost.
  const abortsAtCap = async (cap) => {
    await writeFile(settingsFile, JSON.stringify({ sessionBudget: { maxCostUsd: cap, mode: "enforce" } }));
    await handlers.get("session_start")({}, ctx);
    aborts = 0;
    await handlers.get("turn_end")({}, ctx);
    return aborts > 0;
  };

  const measure = async () => {
    let lo = 0;
    let hi = 1000;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (await abortsAtCap(mid)) lo = mid;
      else hi = mid;
    }
    const rejectAll = await abortsAtCap(1e9);
    return { value: (lo + hi) / 2, rejectAll };
  };

  const saturated = (name, m) => assert.fail(`${name}: the extension aborted at every cap up to 1e9 — either its total exceeds the search ceiling or it rejected the fork ledger (fail-closed)`);

  const withForksResult = await measure();
  if (withForksResult.rejectAll) saturated("withForks", withForksResult);
  const withForks = withForksResult.value;

  const tol = 1e-6;
  assert.ok(Math.abs(refW + refU + refF - withForks) <= tol, `W+U+F: reference ${refW + refU + refF} vs extension ${withForks}`);

  // Splitting that total into (W+U) and F means hiding forks/, which is only sound
  // when the parent records no sync fork results: their paths then dangle and the
  // extension fails closed by design (it must not silently charge 0 for a fork).
  const syncForkRefs = parentEntries.some((entry) => {
    const details = entry.message?.details ?? {};
    const results = [...(details.results ?? []), ...(details.completions ?? []).flatMap((c) => c.results ?? [])];
    return results.some((result) => typeof result?.sessionFile === "string" && result.sessionFile.includes(`${path.sep}forks${path.sep}`));
  });
  if (syncForkRefs) {
    t.diagnostic("session records sync fork results: the W+U / F split is not measurable by hiding forks/ (fail-closed by design) — total only");
    return;
  }
  const disabledForks = path.join(root, "forks-disabled");
  await rename(copyForks, disabledForks);
  const withoutForksResult = await measure();
  await rename(disabledForks, copyForks);
  if (withoutForksResult.rejectAll) saturated("withoutForks", withoutForksResult);
  const withoutForks = withoutForksResult.value;
  assert.ok(Math.abs(refW + refU - withoutForks) <= tol, `W+U: reference ${refW + refU} vs extension ${withoutForks}`);
  assert.ok(Math.abs(refF - (withForks - withoutForks)) <= tol, `F: reference ${refF} vs extension ${withForks - withoutForks}`);
});