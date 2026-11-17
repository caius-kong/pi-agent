#!/usr/bin/env node
/**
 * agent-goal ACCEPTANCE-SCRIPT test — deterministic end to end, no model.
 *
 * `tests/fixtures/fake-pi/pi` stands in for `pi --mode rpc` and replays the
 * records, session entries and provider payloads a real run produces. That makes
 * the acceptance script's own behavior testable:
 *
 *   1. A turn that legally makes no `set_goal` call is not read as "goal lost"
 *      (the extension persists on `input`, before core appends the user message).
 *   2. Each run gets its own evidence directory and leaves `result.json` with the
 *      per-turn state, widget, calls, provider errors and payload line ranges.
 *   3. A provider error makes the run INVALID (exit 2), never a behavior failure.
 *   4. A model that never declares stays a BEHAVIOR failure (exit 1) — a red
 *      behavior result is not laundered into "invalid", and is not retried.
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

function runAcceptance(env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
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

test("the acceptance script carries the goal across a legal no-call turn", () => {
  const run = runAcceptance();
  try {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /GOAL TRACKING ACCEPTED/);
    assert.ok(run.evidenceDir, "the run must report its evidence directory");

    const turns = run.evidence.turns;
    assert.equal(turns.length, 6);
    const last = turns[turns.length - 1];
    assert.deepEqual(last.calls, [], "the last turn made no declaration");
    assert.match(last.state.goal, /readme/i, "the goal line the previous turn set is still there");
    assert.ok(last.providerResponses > 0, "the turn really ran");
    assert.deepEqual(last.providerErrors, []);
    assert.ok(Array.isArray(last.payloadLines) && last.payloadLines[1] > last.payloadLines[0], "payload evidence is addressed");
    assert.equal(run.evidence.off.painted, 0, "the widget stayed cleared after OFF");

    // The payload log is preserved next to result.json, so the ranges resolve.
    const payloadLines = fs.readFileSync(path.join(run.evidenceDir, "payloads.jsonl"), "utf8").split("\n").filter(Boolean);
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

test("a provider error makes the run invalid, not a goal-tracking failure", () => {
  const run = runAcceptance({ FAKE_PI_MODE: "provider-error" });
  try {
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /ACCEPTANCE INVALID/);
    assert.doesNotMatch(run.stdout, /GOAL TRACKING (ACCEPTED|FAILED)/);
    assert.ok(run.evidenceDir, "an invalid run keeps its evidence");
    assert.equal(run.evidence.turns[0].providerErrors[0], "rate limited");
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
