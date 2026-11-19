#!/usr/bin/env node
/**
 * agent-goal RUNTIME regression test — H1/H2 from plan-v4.
 *
 * Unlike `agent-goal-state.test.mjs` (state machine on a mock ExtensionAPI), this
 * drives the REAL stack: `createAgentSession` + `ExtensionRunner` + the loadout
 * and provider-projection path, with a scripted in-process provider
 * (`createFauxCore`) so the model request can be inspected exactly as the
 * provider receives it. Nothing here is a mock of the tool list or of the
 * handler return value.
 *
 * Covered:
 *   H1  agent-goal must not force the system prompt: a later extension's
 *       structured prompt section still reaches the provider.
 *   H2  ON: provider sees the `set_goal` declaration and its guidelines.
 *       OFF / hasUI=false: neither is visible.
 *       OFF between two responses of the SAME run: the next response is clean.
 *       Other active tools, pending restored tools, and externally excluded
 *       tools are unaffected.
 *       codemode `on` / `only`: no `set_goal` description or rule leaks into
 *       the codemode declaration when OFF/headless.
 *       A late `set_goal` call after OFF is a no-op; OFF -> ON restores display.
 *
 * Run: node --test tests/agent-goal-runtime.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

// The scripted provider never reaches the network; keep pi from trying either.
process.env.PI_OFFLINE = "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PNPM_GLOBAL = path.join(os.homedir(), "Library", "pnpm", "global", "v11");

function resolveDep(prefix, inner) {
  let entries = [];
  try { entries = fs.readdirSync(PNPM_GLOBAL); } catch {}
  for (const entry of entries) {
    const store = path.join(PNPM_GLOBAL, entry, "node_modules", ".pnpm");
    let names = [];
    try { names = fs.readdirSync(store); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const candidate = path.join(store, name, "node_modules", inner);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot locate ${prefix} in the local pnpm store`);
}

// agent-goal/index.ts resolves its bare specifiers from its own directory.
function ensureDeps() {
  const locations = [__dirname, path.join(__dirname, "..", "agent", "extensions")];
  const targets = [
    ["typebox", resolveDep("typebox@", "typebox")],
    ["@earendil-works/pi-tui", resolveDep("@earendil-works+pi-tui@", path.join("@earendil-works", "pi-tui"))],
  ];
  for (const dir of locations) {
    const nm = path.join(dir, "node_modules");
    fs.mkdirSync(path.join(nm, "@earendil-works"), { recursive: true });
    for (const [name, target] of targets) {
      const dest = path.join(nm, name);
      if (fs.existsSync(dest)) continue;
      fs.rmSync(dest, { force: true });
      fs.symlinkSync(target, dest, "dir");
    }
  }
}
ensureDeps();

const PI_CODING_AGENT = resolveDep("@earendil-works+pi-coding-agent@", "@earendil-works/pi-coding-agent");
const PI_AI = resolveDep("@earendil-works+pi-ai@", "@earendil-works/pi-ai");
const {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(path.join(PI_CODING_AGENT, "dist/index.js"));
const { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } =
  await import(path.join(PI_AI, "dist/index.js"));

const EXT = path.join(__dirname, "..", "agent", "extensions", "agent-goal", "index.ts");
const WIDGET_KEY = "agent-goal";

// ── harness ───────────────────────────────────────────────────────────────

function makeUIContext(ui) {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, notifyType) => ui.push({ method: "notify", message, notifyType }),
    onTerminalInput: () => () => {},
    setStatus: (key, text) => ui.push({ method: "setStatus", key, text }),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key, lines) => ui.push({ method: "setWidget", key, lines }),
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() { return { fg: (_style, text) => text }; },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "not supported in tests" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

/** Last widget payload the extension pushed (undefined = cleared). */
function widget(ui) {
  const entries = ui.filter((e) => e.method === "setWidget" && e.key === WIDGET_KEY);
  return entries.length > 0 ? entries[entries.length - 1].lines : undefined;
}
/** Every footer-status write the extension made (it must make none). */
function statusWrites(ui) {
  return ui.filter((e) => e.method === "setStatus");
}

/**
 * Build a real AgentSession whose provider is scripted in-process.
 * `requests` records the provider-facing context of every request, exactly as
 * `streamFunction` receives it (system sections, tool declarations, messages).
 */
async function createHarness({ hasUI = true, extraExtensions = [], codemode = undefined, tools = ["set_goal"], sessionManager = undefined } = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-goal-runtime-"));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const extensionFactories = [...extraExtensions];
  if (codemode) extensionFactories.push({ name: `codemode-${codemode}`, factory: createCodemodeExtension({ mode: codemode }) });

  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [EXT],
    extensionFactories,
  });
  await resourceLoader.reload();
  const loadErrors = resourceLoader.getExtensions().errors;
  assert.deepEqual(loadErrors, [], `extensions loaded without errors: ${JSON.stringify(loadErrors)}`);

  const faux = createFauxCore({
    provider: "anthropic",
    api: "anthropic-messages",
    models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
  });

  const { session } = await createAgentSession({
    cwd: agentDir,
    agentDir,
    model: faux.models[0],
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: sessionManager ?? SessionManager.inMemory(agentDir),
    ...(tools === null ? {} : { tools }),
  });

  const requests = [];
  session.agent.streamFunction = (requestModel, context, options) => {
    requests.push({ context });
    return faux.stream(requestModel, context, options);
  };

  const ui = [];
  if (hasUI) await session.bindExtensions({ uiContext: makeUIContext(ui), mode: "rpc" });
  else await session.bindExtensions({ mode: "print" });

  return {
    session,
    faux,
    ui,
    requests,
    /** Provider-facing view of request `index` (0-based). */
    request(index = requests.length - 1) {
      const context = requests[index].context;
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      return {
        systemPrompt,
        systemMessages: context.messages.filter((m) => m.role === "system"),
        declaredTools: getCurrentTools(context.messages).map((tool) => tool.name),
        toolDeclarations: getCurrentTools(context.messages),
      };
    },
    async run(responses, prompt = "Do the thing.") {
      faux.setResponses(responses);
      await session.prompt(prompt);
    },
    dispose() {
      session.dispose();
      fs.rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

const hasSetGoal = (view) => view.declaredTools.includes("set_goal");
const promptMentionsSetGoal = (view) => /set_goal/.test(view.systemPrompt);

// ── H1 ────────────────────────────────────────────────────────────────────

test("H1: agent-goal does not force the system prompt; later structured sections still reach the provider", async () => {
  const lateExtension = {
    name: "late-constraints",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections["acceptance"] = "<acceptance>\nLATE-CONSTRAINT-MARKER: always run the full test suite.\n</acceptance>";
      });
    },
  };
  const h = await createHarness({ extraExtensions: [lateExtension] });
  try {
    await h.run([fauxAssistantMessage("ok")], "Add CSV export.");
    const view = h.request(0);

    assert.ok(
      view.systemPrompt.includes("LATE-CONSTRAINT-MARKER"),
      "later extension's structured section is visible to the provider",
    );
    // A forced prompt (before_agent_start returning `systemPrompt`) replaces the
    // whole prompt with plain content and drops every section.
    assert.ok(
      view.systemMessages.some((m) => Object.keys(m.sections ?? {}).length > 0),
      "provider request carries structured prompt sections, not a forced systemPrompt",
    );
    assert.ok(!view.systemMessages.some((m) => typeof m.content === "string" && m.content.includes("You are a coding assistant")),
      "provider request does not carry a forced full-prompt content string");
  } finally {
    h.dispose();
  }
});

// ── H2: ON ────────────────────────────────────────────────────────────────

test("H2: ON — provider sees the set_goal declaration and its guidelines; widget renders the goal", async () => {
  const h = await createHarness();
  try {
    await h.run([fauxAssistantMessage([fauxToolCall("set_goal", { goal: "Ship CSV export" })]), fauxAssistantMessage("ok")], "Add CSV export.");
    const view = h.request(0);
    assert.ok(hasSetGoal(view), "set_goal is declared while enabled with a UI");
    assert.ok(promptMentionsSetGoal(view), "set_goal guidelines/rules are in the provider prompt");
    assert.match(view.systemPrompt, /- .*set_goal/, "a rule line mentions set_goal");

    const widgetLines = widget(h.ui);
    assert.ok(widgetLines && widgetLines.some((l) => l.includes("agent_goal: Ship CSV export")), `widget shows the goal: ${JSON.stringify(widgetLines)}`);
    assert.deepEqual(statusWrites(h.ui), [], "the goal is not duplicated in the footer status line");
  } finally {
    h.dispose();
  }
});

// ── H2: OFF ───────────────────────────────────────────────────────────────

test("H2: OFF — declaration and guidelines disappear from the provider; widget cleared", async () => {
  const h = await createHarness();
  try {
    await h.run([fauxAssistantMessage([fauxToolCall("set_goal", { goal: "Ship CSV export" })]), fauxAssistantMessage("ok")], "Add CSV export.");
    assert.ok(hasSetGoal(h.request(0)), "precondition: set_goal declared while ON");

    await h.session.prompt("/agent-goal off");
    assert.equal(widget(h.ui), undefined, "OFF clears the widget");

    await h.run([fauxAssistantMessage("ok")], "Keep going.");
    const view = h.request();
    assert.ok(!hasSetGoal(view), `set_goal is not declared while OFF (got ${view.declaredTools.join(",")})`);
    assert.ok(!promptMentionsSetGoal(view), "set_goal guidelines are gone from the provider prompt");
  } finally {
    h.dispose();
  }
});

// ── H2: headless ──────────────────────────────────────────────────────────

test("H2: headless (hasUI=false) — declaration and guidelines are never visible", async () => {
  const h = await createHarness({ hasUI: false });
  try {
    await h.run([fauxAssistantMessage("ok")], "Add CSV export.");
    const view = h.request(0);
    assert.ok(!hasSetGoal(view), `set_goal is not declared without a UI (got ${view.declaredTools.join(",")})`);
    assert.ok(!promptMentionsSetGoal(view), "set_goal guidelines are not in the provider prompt without a UI");
  } finally {
    h.dispose();
  }
});

// ── H2: OFF inside one run ────────────────────────────────────────────────

test("H2: OFF between two responses of the SAME run — the next response is clean", async () => {
  const h = await createHarness();
  try {
    let offPromise = null;
    h.session.subscribe((event) => {
      if (event.type === "turn_end" && event.message.role === "assistant" && !offPromise) {
        // Extension commands run immediately, even while the agent is streaming.
        offPromise = h.session.prompt("/agent-goal off");
      }
    });
    const original = h.session.agent.streamFunction;
    h.session.agent.streamFunction = async (requestModel, context, options) => {
      if (offPromise) await offPromise;
      return original(requestModel, context, options);
    };

    await h.run(
      [fauxAssistantMessage([fauxToolCall("set_goal", { goal: "Ship CSV export" })]), fauxAssistantMessage("done")],
      "Add CSV export.",
    );

    assert.equal(h.requests.length, 2, "the run made two provider requests");
    const first = h.request(0);
    const second = h.request(1);
    assert.ok(hasSetGoal(first), "precondition: first response saw set_goal declared");
    assert.ok(!hasSetGoal(second), `second response of the same run must not declare set_goal (got ${second.declaredTools.join(",")})`);
    assert.ok(!promptMentionsSetGoal(second), "second response of the same run carries no set_goal rule");
  } finally {
    h.dispose();
  }
});

// ── H2: other tools unaffected ────────────────────────────────────────────

test("H2: OFF/ON leaves other active tools and externally excluded tools alone", async () => {
  const h = await createHarness({ tools: ["set_goal", "read", "bash"] });
  try {
    await h.session.prompt("/agent-goal off");
    await h.session.prompt("/agent-goal on");
    const active = h.session.getActiveToolNames();
    assert.ok(active.includes("read") && active.includes("bash"), `other active tools survive the toggle: ${active.join(",")}`);
    assert.ok(active.includes("set_goal"), "set_goal is still active after OFF -> ON");
  } finally {
    h.dispose();
  }

  const excluded = await createHarness({ tools: ["set_goal", "read"], excludeTools: ["bash"] });
  try {
    await excluded.session.prompt("/agent-goal off");
    await excluded.session.prompt("/agent-goal on");
    assert.ok(!excluded.session.getActiveToolNames().includes("bash"), "an externally excluded tool is not added back");
    await excluded.run([fauxAssistantMessage("ok")], "Add CSV export.");
    assert.ok(!excluded.request(0).declaredTools.includes("bash"), "excluded tool stays undeclared");
  } finally {
    excluded.dispose();
  }
});

test("H2: a tool restored from the transcript stays pending across OFF/ON and activates when it registers", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-goal-pending-"));
  const sessionManager = SessionManager.inMemory(agentDir);
  sessionManager.appendMessage({
    role: "system",
    content: "",
    sections: {},
    toolsAdded: [{ name: "mcp__late__tool", description: "late tool", parameters: { type: "object", properties: {} } }],
    timestamp: Date.now(),
  });

  let registered = null;
  const lateTool = {
    name: "late-register",
    factory: (pi) => {
      // `input` fires before the run starts, which is when pi drops pending tools
      // that never registered. Registering here observes the pending set as it
      // was left by the OFF/ON toggles.
      pi.on("input", () => {
        if (registered) return;
        pi.registerTool({
          name: "mcp__late__tool",
          label: "Late tool",
          description: "registered after the session started",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        });
        registered = pi.getActiveTools();
        pi.refreshTools();
      });
    },
  };

  const h = await createHarness({ sessionManager, extraExtensions: [lateTool], tools: null });
  try {
    await h.session.prompt("/agent-goal off");
    await h.session.prompt("/agent-goal on");
    await h.run([fauxAssistantMessage("ok")], "Do the thing.");
    assert.ok(
      h.session.getActiveToolNames().includes("mcp__late__tool"),
      `a tool restored from the transcript still activates when it registers (active: ${h.session.getActiveToolNames().join(",")})`,
    );
  } finally {
    h.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ── H2: codemode ──────────────────────────────────────────────────────────

for (const mode of ["on", "only"]) {
  test(`H2: codemode mode="${mode}" — OFF/headless leaks neither set_goal's description nor its rules`, async () => {
    for (const hasUI of [true, false]) {
      const h = await createHarness({ hasUI, codemode: mode, tools: ["set_goal", "codemode"] });
      try {
        if (hasUI) await h.session.prompt("/agent-goal off");
        await h.run([fauxAssistantMessage("ok")], "Add CSV export.");
        const view = h.request(0);
        const codemodeTool = view.toolDeclarations.find((tool) => tool.name === "codemode");
        assert.ok(codemodeTool, "codemode is declared");
        assert.ok(!hasSetGoal(view), `set_goal is not declared (hasUI=${hasUI})`);
        assert.ok(
          !/set_goal/.test(codemodeTool.description),
          `codemode description does not mention set_goal (hasUI=${hasUI}): ${codemodeTool.description.slice(0, 400)}`,
        );
        assert.ok(
          !/still-open session goals|Still-open goals/i.test(codemodeTool.description),
          `codemode description does not inline set_goal's rules (hasUI=${hasUI})`,
        );
        assert.ok(!promptMentionsSetGoal(view), `provider prompt does not mention set_goal (hasUI=${hasUI})`);
      } finally {
        h.dispose();
      }
    }
  });
}

// ── H2: late call after OFF ───────────────────────────────────────────────

test("H2: a set_goal call after OFF is a no-op; OFF -> ON restores the display", async () => {
  const h = await createHarness();
  try {
    await h.run([fauxAssistantMessage([fauxToolCall("set_goal", { goal: "Ship CSV export" })]), fauxAssistantMessage("ok")], "Add CSV export.");
    const stateEntries = () => h.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "agent-goal-state");
    const before = stateEntries().length;
    assert.ok(before > 0, "precondition: state was persisted while ON");

    await h.session.prompt("/agent-goal off");
    const clearedWidget = widget(h.ui);
    assert.equal(clearedWidget, undefined, "OFF cleared the widget");

    // A model that still remembers the tool name can emit the call; the agent
    // executes it because the tool stays active (only its declaration is hidden).
    await h.run(
      [fauxAssistantMessage([fauxToolCall("set_goal", { goal: "LATE GOAL AFTER OFF" })]), fauxAssistantMessage("ok")],
      "Keep going.",
    );
    assert.equal(stateEntries().length, before, "a late call after OFF does not persist state");
    assert.equal(widget(h.ui), undefined, "a late call after OFF does not restore the widget");

    await h.session.prompt("/agent-goal on");
    const restored = widget(h.ui);
    assert.ok(restored && restored.some((l) => l.includes("agent_goal: Ship CSV export")), `ON restores the display: ${JSON.stringify(restored)}`);
    assert.ok(!JSON.stringify(restored).includes("LATE GOAL AFTER OFF"), "the late goal was never recorded");
  } finally {
    h.dispose();
  }
});
