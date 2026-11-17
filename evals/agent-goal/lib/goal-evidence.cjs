#!/usr/bin/env node
/**
 * Model-free evidence helpers shared by the agent-goal evals and their tests.
 *
 * `run-acceptance.cjs` and `run-eval.cjs` both read two artifacts and must read
 * them the same way:
 *   - the session JSONL — what the model declared (`set_goal` calls), what the
 *     extension persisted (`agent-goal-state` custom entries), and whether the
 *     provider errored;
 *   - the provider payload log — what the provider was actually sent (model,
 *     thinking config, tool declarations and instruction blocks).
 *
 * Keeping that reading here lets `tests/agent-goal-eval-harness.test.mjs` drive
 * it with deterministic fixtures: no model call, no `pi` process.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_ENTRY_TYPE = "agent-goal-state";

function cleanText(s) {
  return (s || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
}

function stripAnsiDeep(value) {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(stripAnsiDeep);
  return value;
}

/** Session JSONL → entries (a torn tail line is dropped, not fatal). */
function parseSessionJsonl(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return entries;
}

// Mirrors the extension's own reader: an empty persisted value means "none", so
// the snapshot shape is the same whether or not the field was written.
function stateOf(entry) {
  return {
    goal: cleanText(entry.data.goal) || null,
    subGoal: cleanText(entry.data.subGoal) || null,
  };
}

/** `set_goal` calls in the given entry range, in order. */
function callsIn(entries) {
  const calls = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const content of entry.message.content ?? []) {
      if (content.type === "toolCall" && (content.name ?? content.toolName) === "set_goal") {
        calls.push({ mode: content.arguments?.mode ?? "new", goal: cleanText(content.arguments?.goal) });
      }
    }
  }
  return calls;
}

/**
 * Provider errors in the given entry range. A turn that ends with
 * `stopReason:"error"` is a failed run, not a goal-tracking result.
 */
function providerErrorsIn(entries) {
  const errors = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "error") {
      errors.push(cleanText(entry.message.errorMessage).slice(0, 200) || "(no errorMessage)");
    }
  }
  return errors;
}

/**
 * What the display layer held once the turn covering entries [from, to) settled.
 *
 * `state` is the extension's persisted goal — the LAST state entry written up to
 * the settle boundary, which is the cumulative state even for a turn that made
 * no `set_goal` call. It must not be located relative to the user message: the
 * extension persists from its `input` handler, which core runs BEFORE it appends
 * the user message, so a state entry for turn N sits above turn N's user message
 * and any "state after the newest user message" reading reports turn N as empty.
 *
 * `calls` are the declarations made during the turn, `providerResponses` how many
 * assistant entries the turn produced, and `providerErrors` the failed provider
 * responses (empty means the turn really ran).
 */
function sessionSnapshot(entries, from, to) {
  let state = null;
  for (let index = to - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data) {
      state = stateOf(entry);
      break;
    }
  }
  const window = entries.slice(from, to);
  const providerResponses = window.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length;
  return { state, calls: callsIn(window), providerErrors: providerErrorsIn(window), providerResponses };
}

/**
 * Whether a settled turn is usable evidence at all.
 *
 * `invalid` means the run itself failed (provider error, or the provider was
 * never asked), so its assertions say nothing about goal tracking. `ok` means
 * the turn really ran and a red assertion is a behavior failure.
 */
function turnVerdict(snapshot) {
  if (snapshot.providerErrors.length) return { status: "invalid", reason: `provider error: ${snapshot.providerErrors[0]}` };
  if (snapshot.providerResponses === 0) return { status: "invalid", reason: "no provider response" };
  return { status: "ok", reason: "" };
}

/**
 * Goal-tracking assertions for one acceptance turn list.
 *
 * `turns[i]` is the scenario (`id`, `modes`, `goal` regexp, `label`);
 * `snapshots[i]` is what `sessionSnapshot` reported once that turn settled.
 */
function trackingChecks(turns, snapshots) {
  const results = [];
  turns.forEach((turn, index) => {
    const calls = snapshots[index]?.calls ?? [];
    const last = calls.length ? calls[calls.length - 1] : null;
    const modeOk = turn.modes.includes(last ? last.mode : null);
    results.push({
      ok: modeOk,
      label: modeOk
        ? `${turn.label}: mode ${last ? `"${last.mode}"` : "(none)"}`
        : `${turn.label}: expected mode ${JSON.stringify(turn.modes)}, got ${last ? `"${last.mode}"` : "(none)"}`,
    });

    const persisted = snapshots[index]?.state;
    const goalOk = Boolean(persisted && turn.goal.test(persisted.goal || ""));
    results.push({
      ok: goalOk,
      label: goalOk
        ? `${turn.label}: goal line still tracks the task ("${(persisted.goal || "").slice(0, 60)}")`
        : `${turn.label}: goal line lost the task (got "${persisted ? persisted.goal : "(none)"}")`,
    });

    if (turn.id === "subproblem" || turn.id === "step") {
      const nested = persisted?.subGoal;
      // "The parent survived" means the parent LINE survived: it must be the
      // same line the previous turn left behind, byte for byte. A topic regex
      // alone cannot tell "Create data.txt and summarize.mjs" from the replaced
      // "Rename variables in summarize.mjs".
      const parent = snapshots[index - 1]?.state?.goal ?? null;
      const parentKept = parent === null || persisted?.goal === parent;
      const fine = !calls.length
        ? parentKept
        : last.mode === "expand" && parentKept && (nested || "").length > 0;
      results.push({
        ok: fine,
        label: fine
          ? `${turn.label}: parent kept${nested ? `, focus nested as "${nested.slice(0, 50)}"` : ", no call"}`
          : `${turn.label}: parent/focus handling wrong (parent ${parent === null ? "(none)" : `"${parent.slice(0, 50)}"`} -> "${(persisted?.goal || "").slice(0, 50)}", mode ${last?.mode ?? "(none)"}, subGoal "${nested || ""}")`,
      });
    }
  });
  return { ok: results.every((result) => result.ok), results };
}

/**
 * The part of a provider payload that declares tools and instructions: the tool
 * declarations plus every instruction block. Conversation text is excluded — the
 * eval's own prompt names the tool, so it is not evidence about what the
 * provider was told.
 *
 * Instruction blocks are not always `role:"system"` messages: the DeepSeek
 * payload this repo runs against carries its tool rules in a `role:"developer"`
 * message, and other providers use a top-level `system` field. Scanning only
 * `role:"system"` would report "no leak" for a payload that leaks everything.
 */
function payloadToolSurface(payload) {
  const parts = [];
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  if (payload.system) parts.push(typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system));
  for (const message of payload.messages ?? []) {
    if (message.role !== "system" && message.role !== "developer") continue;
    parts.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  }
  return parts.join("\n");
}

function payloadMentionsSetGoal(payload) {
  return /set_goal/.test(payloadToolSurface(payload));
}

/**
 * The thinking directive a payload carries, in whatever shape its provider uses:
 * `thinking.type` + `reasoning_effort` (deepseek/openai), `reasoning.effort`
 * (openrouter), `enable_thinking` (qwen), chat-template kwargs, or a top-level
 * `thinking` string. `null` means the request asks for no thinking at all.
 */
function thinkingDirective(payload) {
  if (typeof payload.thinking === "string") {
    const disabled = /^(off|none|disabled|false)$/i.test(payload.thinking.trim());
    return { enabled: !disabled, effort: disabled ? undefined : payload.thinking };
  }
  if (payload.thinking && typeof payload.thinking === "object") {
    return {
      enabled: payload.thinking.type ? payload.thinking.type !== "disabled" : true,
      effort: typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : undefined,
    };
  }
  if (typeof payload.reasoning_effort === "string") return { enabled: true, effort: payload.reasoning_effort };
  if (payload.reasoning && typeof payload.reasoning === "object") {
    return {
      enabled: payload.reasoning.enabled !== false,
      effort: typeof payload.reasoning.effort === "string" ? payload.reasoning.effort : undefined,
    };
  }
  if (typeof payload.enable_thinking === "boolean") return { enabled: payload.enable_thinking };
  // chat-template kwargs carry the switch INSIDE the kwargs object, so the
  // object's presence says nothing about thinking — its `enable_thinking` does.
  const templateArgs = payload.chat_template_kwargs ?? payload.chat_template_args;
  if (templateArgs && typeof templateArgs === "object" && typeof templateArgs.enable_thinking === "boolean") {
    return { enabled: templateArgs.enable_thinking };
  }
  return null;
}

/**
 * Whether the requests really carried the configured model and thinking level.
 * Returns a reason string on mismatch, `null` when the requests match.
 */
function payloadConfigMismatch(payloads, { model, thinking }) {
  const wantModel = String(model || "").split("/").pop();
  const offRequested = thinking === "off" || thinking === "none";
  const wantThinking = thinking && !offRequested ? thinking : null;
  for (const payload of payloads) {
    if (!payload) continue;
    if (payload.model && wantModel && payload.model !== wantModel) {
      return `payload model "${payload.model}" != requested "${wantModel}"`;
    }
    // An off request is checked too: a payload that explicitly enables thinking
    // does not honor it, and silence (no thinking config) does.
    if (offRequested) {
      if (thinkingDirective(payload)?.enabled) {
        return `payload enables thinking but thinking was requested "${thinking}"`;
      }
      continue;
    }
    if (!wantThinking) continue;
    const directive = thinkingDirective(payload);
    if (!directive) return `payload carries no thinking config for requested thinking "${wantThinking}"`;
    if (!directive.enabled) return `payload disables thinking but "${wantThinking}" was requested`;
    if (directive.effort && directive.effort !== wantThinking) {
      return `payload thinking effort "${directive.effort}" != requested "${wantThinking}"`;
    }
  }
  return null;
}

/** A fresh evidence directory, so parallel or repeated runs cannot delete each other. */
function evidenceDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  STATE_ENTRY_TYPE,
  cleanText,
  stripAnsiDeep,
  parseSessionJsonl,
  callsIn,
  providerErrorsIn,
  sessionSnapshot,
  turnVerdict,
  trackingChecks,
  payloadToolSurface,
  payloadMentionsSetGoal,
  payloadConfigMismatch,
  evidenceDir,
  writeJson,
};
