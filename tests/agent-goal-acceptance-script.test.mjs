#!/usr/bin/env node
/**
 * agent-goal ACCEPTANCE-SCRIPT test — deterministic end to end, no model.
 *
 * `tests/fixtures/fake-pi/pi` stands in for `pi --mode rpc` and replays the
 * records, session entries and provider payloads a real run produces. That makes
 * the acceptance script testable without model calls: semantic retention,
 * in-turn discovery, no redundant update, and failure/evidence handling.
 *
 * Run: node --test tests/agent-goal-acceptance-script.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "evals", "agent-goal", "run-acceptance.cjs");
const FAKE_BIN = path.join(__dirname, "fixtures", "fake-pi");

function runAcceptance(env = {}, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      PI_NO_TELEMETRY: "1",
      ...env,
    },
  });
  const evidenceMatch = /evidence: (.+)/.exec(result.stdout || "");
  const evidenceDir = evidenceMatch ? evidenceMatch[1].trim() : null;
  let evidence = null;
  if (evidenceDir) {
    try { evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "result.json"), "utf8")); } catch { /* reported below */ }
  }
  return { ...result, evidenceDir, evidence };
}

test("the acceptance script tracks the session goals across five turns", () => {
  const run = runAcceptance();
  try {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /GOAL TRACKING ACCEPTED/);
    assert.ok(run.evidenceDir, "the run must report its evidence directory");

    const turns = run.evidence.turns;
    assert.equal(turns.length, 5);

    const byId = Object.fromEntries(turns.map((turn) => [turn.id, turn]));
    assert.match(byId["task1-start"].state.goal, /numbers|stats/i);
    assert.match(byId["task1-supplement"].state.goal, /json/i);
    assert.match(byId["task2-joins"].state.goal, /readme/i);
    assert.deepEqual(byId["same-goal"].calls, []);
    assert.equal(byId["same-goal"].state.goal, byId["task2-joins"].state.goal);
    assert.match(byId.discovery.state.goal, /Japanese/);
    assert.match(byId.discovery.state.goal, /median/);
    assert.deepEqual(byId.discovery.events, ["read", "set_goal"]);
    assert.ok(turns.every((turn) => turn.providerResponses > 0), "every turn really ran");
    assert.deepEqual(turns.flatMap((turn) => turn.providerErrors), []);
    assert.ok(Array.isArray(turns[0].payloadLines) && turns[0].payloadLines[1] > turns[0].payloadLines[0], "payload evidence is addressed");
    assert.equal(run.evidence.off.paints, 0, "the widget stayed cleared after OFF");
    assert.deepEqual(run.evidence.off.calls, [], "nothing was declared after OFF");
    assert.deepEqual(run.evidence.off.stateEntries[0], run.evidence.off.stateEntries[1],
      "the OFF turn wrote no state entry, so the stored summary was left alone");

    // The payload log is preserved next to result.json, so the ranges resolve.
    const payloadLines = fs.readFileSync(path.join(run.evidenceDir, "payloads.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = turns[turns.length - 1];
    assert.ok(payloadLines.length >= last.payloadLines[1]);
    assert.ok(fs.existsSync(path.join(run.evidenceDir, "sessions")), "the session trail is preserved");
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("each acceptance run gets its own evidence directory", () => {
  const first = runAcceptance();
  const second = runAcceptance();
  try {
    assert.ok(first.evidenceDir && second.evidenceDir);
    assert.notEqual(first.evidenceDir, second.evidenceDir);
  } finally {
    for (const dir of [first.evidenceDir, second.evidenceDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit candidate path reaches Pi and is recorded in the evidence", () => {
  const candidate = path.join(__dirname, "fixtures", "candidate.ts"); // Fake Pi only records argv.
  const run = runAcceptance({}, ["--extension", candidate]);
  try {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.evidence.extension, candidate);
    assert.equal(run.evidence.status, "passed");
    assert.equal(run.evidence.pendingTurn, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.evidenceDir, "work", "loaded-extensions.json"), "utf8"))[0], candidate);
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("an unchanged goal must not be refreshed", () => {
  const run = runAcceptance({ FAKE_PI_MODE: "redundant" });
  try {
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /follow-up leaves the goals unchanged: no declaration expected/);
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("a summary joining goals in prose passes", () => {
  const run = runAcceptance({ FAKE_PI_SEPARATOR: " and also " });
  try {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.evidence.turns.find((turn) => turn.id === "task2-joins").state.goal, /and also/);
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("a stale summary after discovery is a behavior failure", () => {
  const run = runAcceptance({ FAKE_PI_MODE: "stale-discovery" });
  try {
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /✗ .*updated after discovering the new goal/);
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("a provider error makes the run invalid, not a goal-tracking failure", () => {
  const run = runAcceptance({ FAKE_PI_MODE: "provider-error" });
  try {
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /ACCEPTANCE INVALID/);
    assert.doesNotMatch(run.stdout, /GOAL TRACKING (ACCEPTED|FAILED)/);
    assert.ok(run.evidenceDir, "an invalid run keeps its evidence");
    assert.equal(run.evidence.status, "invalid");
    assert.equal(run.evidence.turns[0].providerErrors[0], "rate limited");
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("an interrupted Pi run keeps the completed turns and the pending turn", () => {
  const run = runAcceptance({ FAKE_PI_MODE: "exit-mid-run" });
  try {
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /evidence directory: /);
    assert.equal(run.evidence.status, "invalid");
    assert.deepEqual(run.evidence.turns.map((turn) => turn.id), ["task1-start"]);
    assert.equal(run.evidence.pendingTurn, "task1-supplement");
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});

test("a model that never declares stays a behavior failure", () => {
  const run = runAcceptance({ FAKE_PI_MODE: "no-declaration" });
  try {
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /GOAL TRACKING FAILED/);
    assert.doesNotMatch(run.stdout, /ACCEPTANCE INVALID/);
  } finally {
    if (run.evidenceDir) fs.rmSync(run.evidenceDir, { recursive: true, force: true });
  }
});
