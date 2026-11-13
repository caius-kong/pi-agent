import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "../agent/npm/node_modules/jiti/lib/jiti.cjs";

const extensionPath = path.resolve("agent/extensions/session-budget/index.ts");
const harnessRoot = await mkdtemp(path.join(os.tmpdir(), "session-budget-fork-test-"));
const piShimPath = path.join(harnessRoot, "pi-coding-agent.cjs");
await writeFile(piShimPath, 'module.exports = { getAgentDir: () => globalThis.__sessionBudgetTestAgentDir };\n');
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": piShimPath },
});
const { default: sessionBudgetExtension } = await jiti.import(extensionPath);

function sessionHeader(id, parentSession) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-10T00:00:00.000Z",
    cwd: "/tmp/project",
    ...(parentSession ? { parentSession } : {}),
  };
}

function assistantEntry(id, cost, responseId, parentId = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-10T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [],
      usage: { cost: { total: cost } },
      responseId,
    },
  };
}

async function writeSession(file, header, entries) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [header, ...entries].map(JSON.stringify).join("\n") + "\n");
}

async function createSessionInstance({ agentDir, cwd, sessionFile, entries, parentSession }) {
  const handlers = new Map();
  const commands = new Map();
  sessionBudgetExtension({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  let aborts = 0;
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => sessionFile,
      getHeader: () => parentSession ? sessionHeader(path.basename(sessionFile, ".jsonl"), parentSession) : { type: "session", id: path.basename(sessionFile, ".jsonl") },
      getSessionId: () => `session-${path.basename(sessionFile)}`,
    },
    ui: {
      setStatus: () => {},
      notify: () => {},
      theme: { fg: (_color, text) => text },
    },
    abort: () => { aborts++; },
  };
  await handlers.get("session_start")({}, ctx);
  return {
    aborts: () => aborts,
    checkTurnStart: () => handlers.get("turn_start")({}, ctx),
    runCommand: (args) => commands.get("budget").handler(args, ctx),
  };
}

async function createHarness(t, rootEntries, forkSpecs, prepareSessions = async () => {}, activeAsyncRuns = [], rpcFailure = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-budget-fork-fixture-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const sessionFile = path.join(root, "sessions", "root-session.jsonl");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    sessionBudget: { maxCostUsd: 5, mode: "enforce" },
  }));
  const forkFiles = new Map();
  for (const fork of forkSpecs) {
    const parentFile = fork.parentId ? forkFiles.get(fork.parentId) : sessionFile;
    assert.ok(parentFile, `parent fork ${fork.parentId} must be defined first`);
    const forkDir = path.join(path.dirname(parentFile), path.basename(parentFile, ".jsonl"), "forks");
    const forkFile = path.join(forkDir, `${fork.id}.jsonl`);
    forkFiles.set(fork.id, forkFile);
    await writeSession(forkFile, sessionHeader(fork.id, parentFile), fork.entries);
  }

  await prepareSessions({ sessionFile, forkFiles, rootEntries, agentDir });
  await writeSession(sessionFile, sessionHeader("root"), rootEntries);

  globalThis.__sessionBudgetTestAgentDir = agentDir;
  t.after(() => { delete globalThis.__sessionBudgetTestAgentDir; });
  const handlers = new Map();
  const commands = new Map();
  const eventHandlers = new Map();
  const rpcRequests = [];
  const events = {
    on: (channel, handler) => {
      const listeners = eventHandlers.get(channel) ?? new Set();
      listeners.add(handler);
      eventHandlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit: (channel, data) => {
      if (channel === "subagents:rpc:v1:request") {
        rpcRequests.push(data);
        if (rpcFailure) throw new Error("RPC transport unavailable");
        const reply = {
          version: 1,
          requestId: data.requestId,
          method: data.method,
          success: true,
          data: data.method === "status"
            ? { asyncSnapshot: { runs: activeAsyncRuns } }
            : { state: "stopping" },
        };
        for (const listener of eventHandlers.get(`subagents:rpc:v1:reply:${data.requestId}`) ?? []) listener(reply);
      }
      for (const listener of eventHandlers.get(channel) ?? []) listener(data);
    },
  };
  sessionBudgetExtension({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    events,
  });
  const statuses = [];
  const notifications = [];
  let aborts = 0;
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: {
      getEntries: () => rootEntries,
      getSessionFile: () => sessionFile,
      getHeader: () => sessionHeader("root"),
      getSessionId: () => "root-session-id",
    },
    ui: {
      setStatus: (_key, text) => statuses.push(text),
      notify: (message) => notifications.push(message),
      theme: { fg: (_color, text) => text },
    },
    abort: () => { aborts++; },
  };
  await handlers.get("session_start")({}, ctx);
  return {
    aborts: () => aborts,
    statuses,
    notifications,
    rpcRequests,
    forkFiles,
    rootEntries,
    sessionFile,
    agentDir,
    cwd,
    checkTurnEnd: () => handlers.get("turn_end")({}, ctx),
    runCommand: (args) => commands.get("budget").handler(args, ctx),
  };
}

test("/budget off disables enforcement for this session and is visible in the TUI", async (t) => {
  const harness = await createHarness(t, [assistantEntry("over-budget", 5.1, "response-over")], []);
  const sessionFile = harness.sessionFile;

  await harness.runCommand("off");
  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "the session must continue even though its configured cap is exceeded");
  assert.equal(harness.statuses.at(-1), "Budget off");
  assert.ok(harness.notifications.some((message) => message.includes("Session budget disabled for this run")));
  await assert.rejects(readFile(`${sessionFile}.session-budget.json`, "utf8"), { code: "ENOENT" });
  await harness.runCommand("5");
  assert.equal(harness.aborts(), 1, "setting a cap again must re-enable enforcement");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.rpcRequests.map((request) => request.method), ["status"]);

  await harness.runCommand("off");
  await harness.runCommand("5");
  await assert.rejects(readFile(`${sessionFile}.session-budget.json`, "utf8"), { code: "ENOENT" });
  assert.equal(harness.aborts(), 2, "the optional integration does not change budget enforcement");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.rpcRequests.map((request) => request.method), ["status", "status"]);
});

test("main session owns its budget; optional subagent stop is best-effort; overrides are in-memory", async (t) => {
  const rootEntry = assistantEntry("root-over-budget", 5.1, "response-root");
  const harness = await createHarness(t, [rootEntry], [], async () => {}, [{ id: "async-over-budget", state: "running" }]);
  const { sessionFile: parentFile, agentDir, cwd } = harness;
  const settingsFile = path.join(agentDir, "settings.json");
  const settingsBefore = await readFile(settingsFile, "utf8");
  const ledgerBefore = await readFile(parentFile, "utf8");

  await harness.runCommand("off");
  await harness.checkTurnEnd();
  assert.equal(harness.aborts(), 0, "the main session is off after disabling its budget");
  const resumedParent = await createSessionInstance({ agentDir, cwd, sessionFile: parentFile, entries: [rootEntry] });
  await resumedParent.checkTurnStart();
  assert.equal(resumedParent.aborts(), 1, "a resumed session must start from the configured cap, not the prior run's override");

  const forkFile = path.join(path.dirname(parentFile), path.basename(parentFile, ".jsonl"), "forks", "fork-child.jsonl");
  const forkEntry = assistantEntry("fork-over-budget", 6.0, "response-fork", rootEntry.id);
  await writeSession(forkFile, sessionHeader("fork-child", parentFile), [rootEntry, forkEntry]);
  const fork = await createSessionInstance({ agentDir, cwd, sessionFile: forkFile, entries: [rootEntry, forkEntry], parentSession: parentFile });
  await fork.checkTurnStart();
  assert.equal(fork.aborts(), 0, "a fork subagent must not apply a separate cap to inherited history");

  for (const kind of ["sync", "async"]) {
    const childFile = path.join(path.dirname(parentFile), path.basename(parentFile, ".jsonl"), `${kind}-run`, "run-0", "session.jsonl");
    const childEntry = assistantEntry(`${kind}-over-budget`, 6.0, `response-${kind}`);
    await writeSession(childFile, sessionHeader(`${kind}-child`, parentFile), [childEntry]);
    const child = await createSessionInstance({ agentDir, cwd, sessionFile: childFile, entries: [childEntry], parentSession: parentFile });
    await child.checkTurnStart();
    assert.equal(child.aborts(), 0, `${kind} subagent must not enforce a separate budget`);
    await child.runCommand("off");
    await child.runCommand("8");
    assert.equal(child.aborts(), 0, `${kind} subagent must not write or enforce a budget override`);
  }

  const nestedFile = path.join(path.dirname(forkFile), path.basename(forkFile, ".jsonl"), "run-0", "session.jsonl");
  const nestedEntry = assistantEntry("nested-over-budget", 6.0, "response-nested");
  await writeSession(nestedFile, sessionHeader("nested-child", forkFile), [nestedEntry]);
  const nested = await createSessionInstance({ agentDir, cwd, sessionFile: nestedFile, entries: [nestedEntry], parentSession: forkFile });
  await nested.checkTurnStart();
  assert.equal(nested.aborts(), 0, "a nested subagent must not enforce a separate budget");

  const resumedFork = await createSessionInstance({ agentDir, cwd, sessionFile: forkFile, entries: [rootEntry, forkEntry], parentSession: parentFile });
  await resumedFork.checkTurnStart();
  assert.equal(resumedFork.aborts(), 0, "a resumed fork remains outside the main-session cap");

  const independentFile = path.join(path.dirname(parentFile), "independent-session.jsonl");
  const independentEntry = assistantEntry("independent-over-budget", 6.0, "response-independent");
  await writeSession(independentFile, sessionHeader("independent"), [independentEntry]);
  const independent = await createSessionInstance({ agentDir, cwd, sessionFile: independentFile, entries: [independentEntry] });
  await independent.checkTurnStart();
  assert.equal(independent.aborts(), 1, "an unrelated main session must continue enforcing its configured cap");

  assert.deepEqual(harness.rpcRequests.map((request) => request.method), [], "off sessions must not query or stop subagents");

  await harness.runCommand("5");
  await new Promise((resolve) => setImmediate(resolve));
  const parentAbortsBeforeRestore = harness.aborts();
  assert.deepEqual(harness.rpcRequests.map((request) => request.method), ["status", "stop"]);
  assert.equal(harness.rpcRequests[1].params.id, "async-over-budget");
  await harness.checkTurnEnd();
  assert.equal(harness.aborts(), parentAbortsBeforeRestore + 1, "restoring enforcement must reactivate the main-session cap");
  const forkAbortsBeforeParentRestore = fork.aborts();
  await fork.checkTurnStart();
  assert.equal(fork.aborts(), forkAbortsBeforeParentRestore, "subagents remain outside the main-session cap");

  assert.equal(await readFile(settingsFile, "utf8"), settingsBefore, "session overrides must never modify global settings");
  assert.equal(await readFile(parentFile, "utf8"), ledgerBefore, "session overrides must not modify the session cost ledger");

});

test("budget enforcement proceeds when the optional subagent stop RPC throws", async (t) => {
  const harness = await createHarness(t, [assistantEntry("over-budget", 5.1, "response-over")], [], async () => {}, [], true);

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "RPC transport failure must not prevent the parent abort");
  assert.ok(harness.notifications.some((message) => message.includes("Session budget exceeded")));
});

test("root budget counts only new usage from a fork at the turn boundary", async (t) => {
  const inherited = assistantEntry("parent-response", 1.0, "response-parent");
  const rootRemainder = assistantEntry("root-remainder", 3.8, "response-root", inherited.id);
  const forkIncrement = assistantEntry("fork-response", 0.3, "response-fork", rootRemainder.id);
  const harness = await createHarness(t, [inherited, rootRemainder], [{
    id: "fork-child",
    entries: [inherited, rootRemainder, forkIncrement],
  }]);

  assert.equal(harness.aborts(), 0, "root usage alone is $4.80");
  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.80 root plus $0.30 new fork usage must exceed the $5 cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
  assert.ok(harness.notifications.some((message) => message.includes("Session budget exceeded: $5.10 / $5.00")));
});

test("root budget counts both sibling fork increments without recounting their shared parent", async (t) => {
  const inherited = assistantEntry("parent-response", 1.0, "response-parent");
  const rootRemainder = assistantEntry("root-remainder", 3.3, "response-root", inherited.id);
  const forkAIncrement = assistantEntry("fork-a-response", 0.4, "response-fork-a", rootRemainder.id);
  const forkBIncrement = assistantEntry("fork-b-response", 0.4, "response-fork-b", rootRemainder.id);
  const harness = await createHarness(t, [inherited, rootRemainder], [
    { id: "fork-a", entries: [inherited, rootRemainder, forkAIncrement] },
    { id: "fork-b", entries: [inherited, rootRemainder, forkBIncrement] },
  ]);

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.30 root plus $0.80 sibling increments must exceed the $5 cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("root budget counts a nested fork increment once after excluding its inherited ancestor usage", async (t) => {
  const inherited = assistantEntry("root-response", 1.0, "response-root");
  const rootRemainder = assistantEntry("root-remainder", 3.1, "response-root-remainder", inherited.id);
  const forkAIncrement = assistantEntry("fork-a-response", 0.5, "response-fork-a", rootRemainder.id);
  const forkBIncrement = assistantEntry("fork-b-response", 0.5, "response-fork-b", forkAIncrement.id);
  const harness = await createHarness(t, [inherited, rootRemainder], [
    { id: "fork-a", entries: [inherited, rootRemainder, forkAIncrement] },
    { id: "fork-b", parentId: "fork-a", entries: [inherited, rootRemainder, forkAIncrement, forkBIncrement] },
  ]);

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.10 root plus $0.50 from each fork must exceed the $5 cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("counts usage entries and branch summary cost without charging inherited summaries twice", async (t) => {
  const parentMessage = assistantEntry("parent-response", 4.0, "response-parent");
  const parentUsage = {
    type: "usage",
    id: "parent-usage",
    parentId: parentMessage.id,
    timestamp: "2026-10-10T00:00:01.000Z",
    kind: "cache_warm",
    usage: { cost: { total: 0.3 } },
  };
  const rootEntries = [parentMessage, parentUsage];
  const forkSummary = {
    type: "branch_summary",
    id: "fork-summary",
    parentId: parentUsage.id,
    timestamp: "2026-10-10T00:00:02.000Z",
    fromId: parentMessage.id,
    summary: "summary",
    usage: { cost: { total: 0.8 } },
  };
  const harness = await createHarness(t, rootEntries, [{
    id: "fork-summary-child",
    entries: [parentMessage, parentUsage, forkSummary],
  }]);

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.30 root plus $0.80 new branch-summary usage must exceed the cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("bypasses fork accounting with a warning when a fork ledger cannot be parsed", async (t) => {
  const warnings = captureWarnings(t);
  const parent = assistantEntry("parent-response", 4.0, "response-parent");
  const harness = await createHarness(t, [parent], [{
    id: "damaged-fork",
    entries: [parent, assistantEntry("fork-response", 0.1, "response-fork", parent.id)],
  }], async ({ forkFiles, agentDir }) => {
    await stageSubagentsPackage(agentDir, "0.81.0");
    await writeFile(forkFiles.get("damaged-fork"), "{invalid json}\n");
  });

  // Criterion: an incompatible dependency must not stop the session. The happy path
  // is abandoned instead: subagent spend is not counted, and the user is told.
  assert.equal(harness.aborts(), 0, "an unparseable fork ledger must not abort the session");
  assert.ok(warnings.some((message) => message.includes("incompatible with the installed pi-subagents")), "the bypass must be warned about");
  assert.ok(
    harness.statuses.at(-1).includes("$4.00 / $5.00") && harness.statuses.at(-1).includes("subagent excluded"),
    "the figure must show only the main-agent spend, and say that subagent spend is excluded",
  );
  assert.ok(
    !harness.statuses.some((status) => status.includes("$4.10")),
    "the partial fork total must be discarded, not reported as if it were complete",
  );
});

test("counts fork usage appended after root session start at the next turn boundary", async (t) => {
  const inherited = assistantEntry("parent-response", 1.0, "response-parent");
  const rootRemainder = assistantEntry("root-remainder", 3.8, "response-root", inherited.id);
  const forkIncrement = assistantEntry("fork-response", 0.3, "response-fork", rootRemainder.id);
  const harness = await createHarness(t, [inherited, rootRemainder], [{
    id: "active-fork",
    entries: [inherited, rootRemainder],
  }]);

  assert.equal(harness.aborts(), 0, "the fork has not spent its increment yet");
  await writeSession(harness.forkFiles.get("active-fork"), sessionHeader("active-fork", path.join(path.dirname(harness.forkFiles.get("active-fork")), "..", "..", "root-session.jsonl")), [inherited, rootRemainder, forkIncrement]);
  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "the next complete turn check must see the appended $0.30");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("does not double-count a sync fork result and still counts its new summary usage", async (t) => {
  const parent = assistantEntry("parent-response", 4.0, "response-parent");
  const syncResult = {
    type: "message",
    id: "sync-result",
    parentId: parent.id,
    timestamp: "2026-10-10T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { mode: "single", results: [{ usage: { cost: { total: 0.6 } }, sessionFile: "/unused" }] },
      usage: { cost: { total: 0.6 } },
    },
  };
  const dispatch = assistantEntry("dispatch", 0, "response-dispatch", parent.id);
  syncResult.parentId = dispatch.id;
  const forkIncrement = assistantEntry("fork-response", 0.6, "response-fork", dispatch.id);
  const forkSummary = {
    type: "branch_summary",
    id: "fork-summary",
    parentId: forkIncrement.id,
    timestamp: "2026-10-10T00:00:02.000Z",
    fromId: forkIncrement.id,
    summary: "fork summary",
    usage: { cost: { total: 0.4 } },
  };
  const harness = await createHarness(t, [parent, dispatch, syncResult], [{
    id: "sync-fork",
    entries: [parent, dispatch, forkIncrement, forkSummary],
  }], async ({ forkFiles, rootEntries }) => {
    rootEntries[2].message.details.results[0].sessionFile = forkFiles.get("sync-fork");
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.00 parent plus $0.60 reported assistant and $0.40 summary reaches $5.00");
  assert.ok(harness.statuses.at(-1).includes("$5.00 / $5.00"));
});

test("bypasses fork accounting with a warning when a sync result names a ledger that does not exist", async (t) => {
  const warnings = captureWarnings(t);
  const parent = assistantEntry("parent-response", 4.0, "response-parent");
  const ghostReference = {
    type: "message",
    id: "ghost-reference",
    parentId: parent.id,
    timestamp: "2026-10-10T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { mode: "single", results: [{ usage: { cost: { total: 0.5 } }, sessionFile: "/unused" }] },
      usage: { cost: { total: 0.5 } },
    },
  };
  const harness = await createHarness(t, [parent, ghostReference], [], async ({ rootEntries, sessionFile }) => {
    rootEntries[1].message.details.results[0].sessionFile = path.join(path.dirname(sessionFile), "ghost", "forks", "deleted.jsonl");
  });

  assert.equal(harness.aborts(), 0, "a vanished fork ledger must not abort the session");
  assert.ok(warnings.some((message) => message.includes("incompatible with the installed pi-subagents")));
  assert.ok(harness.statuses.at(-1).includes("subagent excluded"), "the figure must disclose what it excludes");
});

test("accepts a fork whose inherited history names a sibling fork", async (t) => {
  // A fork snapshot carries the parent's entries, including a sync-fork toolResult
  // that names an earlier SIBLING in the parent's forks/ directory. Demanding that
  // path under the child's own forks/ rejected an intact ledger and aborted.
  const parent = assistantEntry("parent-response", 3.0, "response-parent");
  const siblingReference = {
    type: "message",
    id: "child-a-sibling-reference",
    parentId: parent.id,
    timestamp: "2026-10-10T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { mode: "single", results: [{ usage: { cost: { total: 0.5 } }, sessionFile: "/unused" }] },
      usage: { cost: { total: 0.5 } },
    },
  };
  const siblingIncrement = assistantEntry("child-b-response", 0.5, "response-child-b", parent.id);
  const harness = await createHarness(t, [parent, siblingReference], [
    { id: "child-a", entries: [parent, siblingReference] },
    { id: "child-b", entries: [parent, siblingIncrement] },
  ], async ({ forkFiles, rootEntries, sessionFile }) => {
    rootEntries[1].message.details.results[0].sessionFile = forkFiles.get("child-b");
    // The child inherits that same reference from the parent's history.
    await writeSession(forkFiles.get("child-a"), sessionHeader("child-a", sessionFile), [parent, siblingReference]);
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "an intact ledger must not abort; the sibling reference is not a missing file");
  assert.ok(harness.statuses.at(-1).includes("$3.50 / $5.00"), "charged once: $3.00 parent plus the $0.50 reported fork, not the fork file again");
});

test("counts new branch-summary usage from a fork", async (t) => {
  const parent = assistantEntry("parent-response", 4.2, "response-parent");
  const summary = {
    type: "branch_summary",
    id: "fork-summary",
    parentId: parent.id,
    timestamp: "2026-10-10T00:00:01.000Z",
    fromId: parent.id,
    summary: "fork summary",
    usage: { cost: { total: 0.9 } },
  };
  const harness = await createHarness(t, [parent], [{
    id: "summary-fork",
    entries: [parent, summary],
  }]);

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.20 parent plus $0.90 new branch-summary cost exceeds the cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("counts async child sessions stored under the configured session root", async (t) => {
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const childAssistant = assistantEntry("child-response", 1.0, "response-child");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile }) => {
    const childFile = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0", "2026-10-16T08-53-11-480Z_child.jsonl");
    await writeSession(childFile, sessionHeader("async-run"), [childAssistant]);
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.10 main plus $1.00 asynchronous child cost exceeds the cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

/**
 * pi-subagents 0.81.0, measured on a real dispatch: a detached result keeps
 * `details.runId` but drops `results[].sessionFile` (it carries `transcriptPath`
 * instead). Dedup must key on the run id, and the child must not be charged twice
 * when the tool-result usage already covers it.
 */
function detachedSubagentResult(runId, cost, transcriptPath) {
  return {
    type: "message",
    id: `detached-${runId}`,
    parentId: null,
    timestamp: "2026-10-23T02:16:12.423Z",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: {
        mode: "single",
        runId,
        results: [{ agent: "reviewer", detached: true, transcriptPath, usage: { cost: { total: cost } } }],
      },
      usage: { cost: { total: cost } },
    },
  };
}

test("dedupes a 0.81.0 detached result by run id, since it carries no sessionFile", async (t) => {
  const warnings = captureWarnings(t);
  const runId = "d1cf1fe2-detached";
  const dispatch = detachedSubagentResult(runId, 0.5, "/tmp/subagent-artifacts/d1cf1fe2_reviewer_0_transcript.jsonl");
  const harness = await createHarness(t, [assistantEntry("root-response", 4.4, "response-root", dispatch.id)], [], async ({ sessionFile }) => {
    // The child's own ledger still exists on disk under the run id; the detached
    // result just does not name it.
    const childFile = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), runId, "run-0", "session.jsonl");
    await writeSession(childFile, sessionHeader(runId), [assistantEntry("child-response", 0.5, "response-child")]);
  });

  await harness.checkTurnEnd();

  assert.deepEqual(compatWarnings(warnings), [], "the 0.81.0 detached shape is not incompatibility evidence");
  assert.equal(harness.aborts(), 0, "$4.90 total is under the $5 cap");
  assert.ok(harness.statuses.at(-1).includes("$4.90 / $5.00"), "$4.40 root plus $0.50 charged once from the tool result");
  assert.ok(!harness.statuses.at(-1).includes("$5.40"), "the child ledger must not be charged a second time");
  assert.ok(!harness.statuses.at(-1).includes("subagent excluded"));
});

test("counts a nested fork under an ordinary async child session", async (t) => {
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const childAssistant = assistantEntry("child-response", 0.5, "response-child", rootAssistant.id);
  const nestedForkUsage = {
    type: "usage",
    id: "nested-fork-usage",
    parentId: childAssistant.id,
    timestamp: "2026-10-10T00:00:02.000Z",
    kind: "compaction",
    usage: { cost: { total: 0.5 } },
  };
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile }) => {
    const childFile = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0", "2026-10-16T08-53-11-481Z_child.jsonl");
    await writeSession(childFile, sessionHeader("async-run"), [childAssistant]);
    const forkFile = path.join(path.dirname(childFile), path.basename(childFile, ".jsonl"), "forks", "nested-fork.jsonl");
    await writeSession(forkFile, sessionHeader("nested-fork", childFile), [childAssistant, nestedForkUsage]);
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.10 root plus $0.50 child and $0.50 nested fork usage exceeds the cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("bypasses fork accounting with a warning when a billed fork entry lacks a stable id", async (t) => {
  const warnings = captureWarnings(t);
  const parent = assistantEntry("parent-response", 4.0, "response-parent");
  const forkEntry = assistantEntry("fork-response", 0.1, "response-fork", parent.id);
  delete forkEntry.id;
  const harness = await createHarness(t, [parent], [{
    id: "unkeyed-fork",
    entries: [parent, forkEntry],
  }]);

  assert.equal(harness.aborts(), 0, "an unkeyed fork entry must not abort the session");
  assert.ok(warnings.some((message) => message.includes("incompatible with the installed pi-subagents")));
  assert.ok(harness.statuses.at(-1).includes("subagent excluded"));
});

test("tolerates a torn final line from a concurrent append instead of aborting", async (t) => {
  const parent = assistantEntry("parent-response", 4.0, "response-parent");
  const forkIncrement = assistantEntry("fork-response", 0.1, "response-fork", parent.id);
  const harness = await createHarness(t, [parent], [{
    id: "torn-fork",
    entries: [parent],
  }]);

  assert.equal(harness.aborts(), 0);
  await writeFile(
    harness.forkFiles.get("torn-fork"),
    [sessionHeader("torn-fork", path.join(path.dirname(harness.forkFiles.get("torn-fork")), "..", "..", "root-session.jsonl")), parent, forkIncrement]
      .map(JSON.stringify)
      .join("\n") + "\n" + '{"type":"message","id":"partial"',
  );
  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "a half-written tail line must not be treated as a damaged ledger");
  assert.ok(!harness.notifications.some((message) => message.includes("incompatible")), "torn tail must not trigger the bypass");
  assert.ok(!harness.statuses.at(-1).includes("subagent excluded"), "torn tail must not exclude subagent spend");
});

test("counts a fork's own async child run without dropping the fork increment", async (t) => {
  const inherited = assistantEntry("parent-response", 1.0, "response-parent");
  const rootRemainder = assistantEntry("root-remainder", 3.0, "response-root", inherited.id);
  const forkIncrement = assistantEntry("fork-response", 0.5, "response-fork", rootRemainder.id);
  const asyncChild = assistantEntry("async-child-response", 0.6, "response-async-child", rootRemainder.id);
  const harness = await createHarness(t, [inherited, rootRemainder], [{
    id: "fork-dispatch",
    entries: [inherited, rootRemainder, forkIncrement],
  }], async ({ forkFiles }) => {
    const forkFile = forkFiles.get("fork-dispatch");
    const childFile = path.join(path.dirname(forkFile), path.basename(forkFile, ".jsonl"), "async-run", "run-0", "2026-10-16T08-53-11-482Z_child.jsonl");
    await writeSession(childFile, sessionHeader("async-run"), [asyncChild]);
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.00 root plus $0.50 fork and $0.60 fork async child exceeds the cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

test("counts sync fork usage reported with a numeric cost field", async (t) => {
  // pi-subagents' sumResultsUsage() reports `cost` as a plain number, whereas
  // pi core's message usage uses `cost: { total }`. Both shapes must be charged.
  const parent = assistantEntry("parent-response", 4.3, "response-parent");
  const dispatch = assistantEntry("dispatch", 0, "response-dispatch", parent.id);
  const syncResult = {
    type: "message",
    id: "sync-result",
    parentId: dispatch.id,
    timestamp: "2026-10-10T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { mode: "single", results: [{ usage: { cost: 0.8, turns: 2 }, sessionFile: "/unused" }] },
      usage: { cost: { total: 0.8 } },
    },
  };
  const forkIncrement = assistantEntry("fork-response", 0.8, "response-fork", dispatch.id);
  const harness = await createHarness(t, [parent, dispatch, syncResult], [{
    id: "numeric-cost-fork",
    entries: [parent, dispatch, forkIncrement],
  }], async ({ forkFiles, rootEntries }) => {
    rootEntries[2].message.details.results[0].sessionFile = forkFiles.get("numeric-cost-fork");
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "$4.30 parent plus $0.80 reported fork usage exceeds the cap");
  assert.ok(harness.statuses.at(-1).includes("$5.10 / $5.00"));
});

function captureWarnings(t) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  t.after(() => { console.warn = original; });
  return warnings;
}

/**
 * pi-subagents writes `subagent-artifacts/<id>_<agent>_transcript.jsonl` beside
 * the child session file. Its lines are message records keyed by `recordType`,
 * not session entries: no `type: "session"` header, and the assistant records it
 * replays are already billed through the child's own session.jsonl.
 */
function transcriptLines(runId, agent) {
  return [
    {
      version: 1,
      recordType: "message",
      source: "async",
      runId,
      agent,
      childIndex: 0,
      cwd: "/tmp/project",
      ts: 1792655853457,
      timestamp: "2026-10-22T07:57:33.457Z",
      sourceEventType: "initial_prompt",
      role: "user",
      text: "[prompt redacted]",
      message: { role: "user", content: [{ type: "text", text: "[prompt redacted]" }] },
    },
    {
      version: 1,
      recordType: "message",
      source: "async",
      runId,
      agent,
      childIndex: 0,
      ts: 1792655853900,
      timestamp: "2026-10-22T07:57:33.900Z",
      role: "assistant",
      text: "done",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { cost: { total: 0.5 } } },
    },
  ];
}

test("ignores a subagent transcript artifact beside a child session instead of aborting the turn", async (t) => {
  // Recorded symptom: an async researcher's streamed transcript was left as a
  // `*_transcript.jsonl` inside the run directory. It is not a session ledger, so
  // parsing it as one aborted turn_end with "Invalid JSONL ... at line 1".
  const warnings = captureWarnings(t);
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const childAssistant = assistantEntry("child-response", 0.5, "response-child");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile }) => {
    const runDir = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0");
    await writeSession(path.join(runDir, "session.jsonl"), sessionHeader("async-run"), [childAssistant]);
    const artifacts = path.join(runDir, "subagent-artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(artifacts, "182ccd69-99dd-4961-9b5c-6de11abf6bc0_researcher_transcript.jsonl"),
      transcriptLines("182ccd69-99dd-4961-9b5c-6de11abf6bc0", "researcher").map(JSON.stringify).join("\n") + "\n",
    );
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "a transcript artifact must not abort turn_end accounting");
  assert.ok(harness.statuses.at(-1).includes("$4.60 / $5.00"), "$4.10 root plus $0.50 child, transcript not double counted");
  assert.ok(
    warnings.some((message) => message.includes("researcher_transcript.jsonl") && message.includes("not a session ledger")),
    "skipping the artifact must be visible in the log",
  );
});

test("degrades past a torn tail in a child session ledger", async (t) => {
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const childAssistant = assistantEntry("child-response", 0.5, "response-child");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile }) => {
    const childFile = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0", "child.jsonl");
    await writeSession(childFile, sessionHeader("async-run"), [childAssistant]);
    // The run was stopped mid-write: the last line never completed.
    await writeFile(childFile, await readFile(childFile, "utf8") + '{"type":"message","id":"partial","message":{"role":"assistant",');
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "an incomplete trailing entry must not abort the turn");
  assert.ok(harness.statuses.at(-1).includes("$4.60 / $5.00"), "complete entries are still charged");
});

test("bypasses the scan, naming the line, when a child ledger has a corrupt line", async (t) => {
  const warnings = captureWarnings(t);
  const rootAssistant = assistantEntry("root-response", 4.0, "response-root");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile }) => {
    const childFile = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0", "child.jsonl");
    await mkdir(path.dirname(childFile), { recursive: true });
    await writeFile(
      childFile,
      [
        sessionHeader("async-run"),
        assistantEntry("child-a", 0.5, "response-child-a"),
        "\u0000 truncated write",
        assistantEntry("child-b", 0.1, "response-child-b"),
      ].map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
    );
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "a corrupt interior line must not abort the turn");
  // A line the scan cannot read means the happy path no longer describes this data,
  // so the partial subagent total is discarded instead of reported as complete.
  assert.ok(harness.statuses.at(-1).includes("$4.00 / $5.00"), "only the main agent is counted");
  assert.ok(harness.statuses.at(-1).includes("subagent excluded"), "the exclusion must be visible");
  assert.ok(
    warnings.some((message) => message.includes("child.jsonl") && message.includes("line 3")),
    "the skipped line must be named in the log",
  );
});

/** The pi-subagents release this accounting is verified against, as pinned in the extension. */
const PINNED_SUBAGENTS_VERSION = /const SUBAGENTS_EXPECTED_VERSION = "([^"]+)"/.exec(await readFile(extensionPath, "utf8"))?.[1];
assert.ok(PINNED_SUBAGENTS_VERSION, "the extension must pin the pi-subagents version it was verified against");

/** A release other than the pinned one, so "version differs" stays testable across re-pins. */
const OTHER_SUBAGENTS_VERSION = (() => {
  const [major, minor] = PINNED_SUBAGENTS_VERSION.split(".");
  return `${major}.${Number(minor) + 1}.0`;
})();

async function stageSubagentsPackage(agentDir, version) {
  const dir = path.join(agentDir, "npm", "node_modules", "pi-subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "pi-subagents", version }));
}

const compatWarnings = (warnings) => warnings.filter((message) => message.includes("incompatible with the installed pi-subagents"));
/** A billed session entry with no `type:"session"` header: a ledger this accounting cannot attribute. */
const headerlessLedgerLine = (cost) => JSON.stringify({ type: "message", id: "headerless", message: { role: "assistant", usage: { cost: { total: cost } } } });

async function writeChildRun(sessionFile, lines) {
  const runDir = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0");
  await mkdir(runDir, { recursive: true });
  const file = path.join(runDir, "child.jsonl");
  await writeFile(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

test("accounts without a compatibility report when pi-subagents matches the pinned version", async (t) => {
  const warnings = captureWarnings(t);
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const childAssistant = assistantEntry("child-response", 1.0, "response-child");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile, agentDir }) => {
    await stageSubagentsPackage(agentDir, PINNED_SUBAGENTS_VERSION);
    await writeChildRun(sessionFile, [sessionHeader("async-run"), childAssistant]);
  });

  await harness.checkTurnEnd();

  assert.deepEqual(compatWarnings(warnings), [], "an intact layout must stay quiet");
  assert.equal(harness.aborts(), 1, "$4.10 root plus $1.00 child exceeds the cap");
  assert.ok(harness.notifications.some((message) => message.includes("Session budget exceeded")));
});

test("a compatible pi-subagents upgrade is not reported, only the version it was verified against is pinned", async (t) => {
  // Criterion: pi-subagents releases move often and most leave this layout alone.
  // A version difference on its own is not evidence of incompatibility, so a
  // compatible upgrade must stay silent rather than nag on every bump.
  const warnings = captureWarnings(t);
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const childAssistant = assistantEntry("child-response", 1.0, "response-child");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile, agentDir }) => {
    await stageSubagentsPackage(agentDir, "99.1.0");
    await writeChildRun(sessionFile, [sessionHeader("async-run"), childAssistant]);
  });

  await harness.checkTurnEnd();

  assert.deepEqual(compatWarnings(warnings), [], "a version difference alone must not raise a compatibility report");
  assert.equal(harness.aborts(), 1, "accounting is unaffected: $4.10 root plus $1.00 child exceeds the cap");
  assert.ok(harness.notifications.some((message) => message.includes("Session budget exceeded")));
});

test("reports an incompatible pi-subagents layout with both operator choices, without breaking accounting", async (t) => {
  const warnings = captureWarnings(t);
  const rootAssistant = assistantEntry("root-response", 4.1, "response-root");
  const harness = await createHarness(t, [rootAssistant], [], async ({ sessionFile, agentDir }) => {
    await stageSubagentsPackage(agentDir, OTHER_SUBAGENTS_VERSION);
    // A billed ledger whose header moved: the scan can read it but cannot attribute it.
    await writeChildRun(sessionFile, [headerlessLedgerLine(0.5)]);
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0, "an unverified layout must not break the session");
  const reported = compatWarnings(warnings);
  assert.equal(reported.length, 1, "the incompatibility must be logged exactly once");
  assert.ok(reported[0].includes(OTHER_SUBAGENTS_VERSION) && reported[0].includes(PINNED_SUBAGENTS_VERSION), "the report must name both versions");
  assert.ok(reported[0].includes("child.jsonl"), "the report must name the file that could not be attributed");
  assert.ok(reported[0].includes("SUBAGENT SPEND IS NOT COUNTED"), "the report must state what is lost by ignoring it");
  assert.ok(
    reported[0].includes(`Sync the version: install pi-subagents ${PINNED_SUBAGENTS_VERSION}`),
    "choice 1 must be to sync the package to a supported release",
  );
  assert.ok(
    reported[0].includes("Ignore this warning") && reported[0].includes("accept that subagent spend is not counted"),
    "choice 2 must be to keep the upgrade and accept the lost subagent spend",
  );
  assert.ok(
    reported[0].includes("README.md") && reported[0].includes("Troubleshooting"),
    "the report must point at the runbook that upgrades this extension",
  );
  assert.ok(
    harness.notifications.some((message) => message.includes("incompatible") && message.includes("Subagent spend is not counted now")),
    "the operator must see the incompatibility and its cost in the TUI",
  );

  await harness.checkTurnEnd();
  assert.equal(compatWarnings(warnings).length, 1, "re-scanning must not repeat the report");
  assert.equal(harness.notifications.filter((message) => message.includes("Subagent spend is not counted now")).length, 1);
});

test("reports an unattributable layout even on the pinned version, which is a new shape rather than a drift", async (t) => {
  const warnings = captureWarnings(t);
  const harness = await createHarness(t, [assistantEntry("root-response", 4.1, "response-root")], [], async ({ sessionFile, agentDir }) => {
    await stageSubagentsPackage(agentDir, PINNED_SUBAGENTS_VERSION);
    await writeChildRun(sessionFile, [headerlessLedgerLine(0.5)]);
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0);
  const [reported] = compatWarnings(warnings);
  assert.ok(reported, "the report is driven by what the scan met, not by the version alone");
  assert.ok(reported.includes(PINNED_SUBAGENTS_VERSION) && reported.includes("verified against"), "it must still name the verified release");
});

test("does not report a subagent transcript artifact as a compatibility problem", async (t) => {
  // A transcript is a known side file whose assistant records are already billed
  // through the child session; it must stay a quiet skip, not an incompatibility.
  const warnings = captureWarnings(t);
  const harness = await createHarness(t, [assistantEntry("root-response", 1.0, "response-root")], [], async ({ sessionFile, agentDir }) => {
    await stageSubagentsPackage(agentDir, "99.1.0");
    await writeChildRun(sessionFile, transcriptLines("182ccd69-99dd-4961-9b5c-6de11abf6bc0", "researcher"));
  });

  await harness.checkTurnEnd();

  assert.deepEqual(compatWarnings(warnings), []);
  assert.equal(harness.aborts(), 0);
});

test("/budget doctor reports both versions and how each child ledger was classified", async (t) => {
  const harness = await createHarness(t, [assistantEntry("root-response", 1.0, "response-root")], [], async ({ sessionFile, agentDir }) => {
    await stageSubagentsPackage(agentDir, OTHER_SUBAGENTS_VERSION);
    const runDir = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0");
    await writeSession(path.join(runDir, "session.jsonl"), sessionHeader("async-run"), [
      assistantEntry("child-response", 0.5, "response-child"),
    ]);
    await mkdir(path.join(runDir, "subagent-artifacts"), { recursive: true });
    await writeFile(
      path.join(runDir, "subagent-artifacts", "abc_researcher_transcript.jsonl"),
      transcriptLines("abc", "researcher").map(JSON.stringify).join("\n") + "\n",
    );
    await writeFile(path.join(runDir, "headerless.jsonl"), headerlessLedgerLine(0.25) + "\n");
  });

  await harness.runCommand("doctor");

  const report = harness.notifications.find((message) => message.startsWith("session-budget doctor"));
  assert.ok(report, "the doctor report must be shown");
  assert.equal(harness.aborts(), 0, "a self-check must never abort");
  assert.ok(report.includes(`verified against pi-subagents ${PINNED_SUBAGENTS_VERSION}`), "it must state what the scan is verified against");
  assert.ok(report.includes(`installed pi-subagents ${OTHER_SUBAGENTS_VERSION}`), "it must state what is installed");
  assert.ok(report.includes("version: differs"), "a version difference is reported as a difference, not as incompatibility");
  assert.ok(/ledger \(counted\): .*session\.jsonl/.test(report), "a real ledger must be classified as counted");
  assert.ok(/not a ledger \(skipped.*transcript\.jsonl/.test(report), "a transcript artifact must be classified as a skipped side file");
  assert.ok(/BILLED ENTRIES WITHOUT A SESSION HEADER.*headerless\.jsonl/.test(report), "a moved ledger header must be flagged as evidence");
  assert.ok(report.includes("recorded incompatibility evidence: 1"), "the evidence count must be visible");
});

test("a bypassed session counts the main agent only, and stays bypassed on later checks", async (t) => {
  const warnings = captureWarnings(t);
  const parent = assistantEntry("parent-response", 4.0, "response-parent");
  const childAssistant = assistantEntry("child-response", 0.5, "response-child");
  const harness = await createHarness(t, [parent], [], async ({ sessionFile }) => {
    // A child run the scan CAN read, plus a fork ledger it cannot: the readable
    // child cost must be discarded too, because the total would otherwise look
    // complete while the fork part is missing.
    const runDir = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "async-run", "run-0");
    await writeSession(path.join(runDir, "session.jsonl"), sessionHeader("async-run"), [childAssistant]);
    const forkFile = path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "forks", "broken.jsonl");
    await mkdir(path.dirname(forkFile), { recursive: true });
    await writeFile(forkFile, "not json\n");
  });

  await harness.checkTurnEnd();
  const first = harness.statuses.at(-1);
  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 0);
  assert.ok(first.includes("$4.00 / $5.00"), "the readable child cost must be excluded as well: $4.00, not $4.50");
  assert.ok(harness.statuses.at(-1).includes("$4.00 / $5.00"), "a later check must not re-add the excluded costs");
  assert.equal(
    warnings.filter((message) => message.includes("incompatible with the installed pi-subagents")).length,
    1,
    "the bypass is reported once, not on every check",
  );
});

test("a bypassed session still enforces the cap on the main-agent figure", async (t) => {
  // The most load-bearing property of the bypass: excluding subagent spend must not
  // switch the cap off. Main-agent spend alone crossing the cap must still abort,
  // and the abort must disclose that the figure excludes subagents.
  const parent = assistantEntry("parent-over-budget", 5.1, "response-parent");
  const harness = await createHarness(t, [parent], [{
    id: "broken-fork",
    entries: [assistantEntry("fork-response", 0.1, "response-fork", parent.id)],
  }], async ({ forkFiles }) => {
    await writeFile(forkFiles.get("broken-fork"), "not json\n");
  });

  await harness.checkTurnEnd();

  assert.equal(harness.aborts(), 1, "main-agent spend over the cap must still abort while bypassed");
  const exceeded = harness.notifications.find((message) => message.includes("Session budget exceeded"));
  assert.ok(exceeded, "the cap breach must be reported as a cap breach, not as an accounting failure");
  assert.ok(exceeded.includes("$5.10 / $5.00"), "the figure must be the main-agent one");
  assert.ok(exceeded.includes("subagent excluded"), "the breach must disclose what the figure leaves out");
  assert.ok(!harness.notifications.some((message) => message.includes("accounting failed")));
});

test("stays quiet when pi-subagents is not installed at all", async (t) => {
  const warnings = captureWarnings(t);
  const harness = await createHarness(t, [assistantEntry("root-response", 1.0, "response-root")], []);

  await harness.checkTurnEnd();

  assert.deepEqual(compatWarnings(warnings), [], "an optional integration that is absent is not a compatibility problem");
  assert.equal(harness.aborts(), 0);
});

test.after(async () => {
  delete globalThis.__sessionBudgetTestAgentDir;
  await rm(harnessRoot, { recursive: true, force: true });
});
