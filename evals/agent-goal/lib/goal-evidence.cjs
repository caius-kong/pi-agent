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
 * The contract read here is the single-string one: `set_goal({ goal })`, where
 * `goal` is the summary of the session's still-open goals, at most 300 chars,
 * and `""` means no goal is left. There is no mode and no parent/child line, so
 * nothing here compares a "parent goal" across turns.
 *
 * Keeping that reading here lets `tests/agent-goal-eval-harness.test.mjs` drive
 * it with deterministic fixtures: no model call, no `pi` process.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_ENTRY_TYPE = "agent-goal-state";
const GOAL_MAX_LEN = 300;

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

// Mirrors the extension's own reader: an empty persisted value means "no goal",
// so the snapshot shape is the same whether or not the field was written.
// Entries from the older two-field contract may carry `subGoal`/`goalSetAt`;
// `goal` was already the display line then, and the dropped fields are ignored.
function stateOf(entry) {
  return { goal: cleanText(entry.data.goal) || null };
}

/** Tool calls in the given entry range, in transcript order. */
function toolCallsIn(entries) {
  const calls = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const content of entry.message.content ?? []) {
      if (content.type === "toolCall") calls.push({ name: content.name ?? content.toolName, arguments: content.arguments ?? {} });
    }
  }
  return calls;
}

/**
 * What the assistant actually did, in order: `"text"` for a non-empty answer
 * chunk, the tool name for a tool call. The contract asks for the declaration
 * before the model answers OR acts, so an order check that only lists tool calls
 * cannot see a turn that answered first and declared afterwards.
 */
function turnEvents(entries) {
  const events = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const content of entry.message.content ?? []) {
      if (content.type === "text") {
        if (String(content.text ?? "").trim()) events.push("text");
      } else if (content.type === "toolCall") {
        events.push(content.name ?? content.toolName);
      }
    }
  }
  return events;
}

/**
 * `set_goal` calls in the given entry range, in order. A call with `goal: ""` is
 * a legal clear, so it is kept with an empty string rather than dropped.
 */
function callsIn(entries) {
  return toolCallsIn(entries)
    .filter((call) => call.name === "set_goal")
    .map((call) => ({ goal: typeof call.arguments.goal === "string" ? cleanText(call.arguments.goal) : null }));
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
 * `state` is the extension's persisted summary — the LAST state entry written up
 * to the settle boundary, which is the cumulative state even for a turn that
 * made no `set_goal` call. It must not be located relative to the user message:
 * the extension persists from its `input` handler, which core runs BEFORE it
 * appends the user message, so a state entry for turn N sits above turn N's user
 * message and any "state after the newest user message" reading reports turn N
 * as empty.
 *
 * `calls` are the `set_goal` declarations of the turn, `callOrder` every tool
 * name the turn called in transcript order, `events` everything the assistant did
 * in order (including `"text"`), `providerResponses` how many assistant entries
 * the turn produced, and `providerErrors` the failed provider responses (empty
 * means the turn really ran).
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
  return {
    state,
    calls: callsIn(window),
    callOrder: toolCallsIn(window).map((call) => call.name),
    events: turnEvents(window),
    providerErrors: providerErrorsIn(window),
    providerResponses,
  };
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
 * Goal-tracking assertions for one turn list.
 *
 * A turn declares what its own user message should leave behind:
 *   id, label, say
 *   expect   [{ label, match?: RegExp, check?: (summary) => boolean, empty?: true }] —
 *            the summary must pass every entry: `match` a regexp, `check` a
 *            predicate for a structural property a regexp cannot express, `empty`
 *            that no goal is left (the line is cleared).
 *   forbid   [{ label, match: RegExp }] — a finished, cancelled or superseded
 *            goal must not appear at all (only a paused goal keeps a marker).
 *   call     "required" for a material change, or "forbidden" otherwise.
 *   afterWork checks that a goal learned from work is declared after the read.
 * The 300-char limit is checked on the declared call, not the stored
 * summary — the extension truncates on write, so the stored value can never
 * exceed it and checking it would prove nothing. `snapshots[i]` is what
 * `sessionSnapshot` reported for that turn.
 */
function trackingChecks(turns, snapshots) {
  const results = [];
  turns.forEach((turn, index) => {
    const snap = snapshots[index] ?? {};
    const label = turn.label ?? turn.id;
    const summary = snap.state?.goal ?? "";
    const calls = snap.calls ?? [];
    const declared = calls.length > 0;

    if (turn.call === "forbidden") {
      results.push({
        ok: !declared,
        label: declared
          ? `${label}: no declaration expected, got ${JSON.stringify(calls)}`
          : `${label}: no declaration`,
      });
    } else {
      results.push({
        ok: declared,
        label: declared
          ? `${label}: declared the summary`
          : `${label}: expected a set_goal call for a material goal change, got none`,
      });
    }

    if (turn.afterWork) {
      const events = snap.events ?? [];
      const work = events.findIndex((event) => event === "read" || event === "bash");
      const lastGoal = events.lastIndexOf("set_goal");
      const ok = work >= 0 && lastGoal > work && turn.afterWork.test(calls.at(-1)?.goal ?? "")
        && events.slice(0, work).filter((e) => e === "set_goal").every((_, i) => !turn.afterWork.test(calls[i]?.goal ?? ""));
      results.push({ ok, label: `${label}: updated after discovering the new goal (events ${JSON.stringify(events)})` });
    }

    for (const expectation of turn.expect ?? []) {
      const expectationLabel = `${label}: ${expectation.label}`;
      if (expectation.empty) {
        results.push({
          ok: summary === "",
          label: summary === "" ? `${expectationLabel} (empty summary)` : `${expectationLabel} (got "${summary}")`,
        });
      } else {
        const ok = expectation.check ? expectation.check(summary) : expectation.match.test(summary);
        results.push({
          ok,
          label: ok ? `${expectationLabel} ("${summary.slice(0, 70)}")` : `${expectationLabel} (got "${summary}")`,
        });
      }
    }

    for (const forbidden of turn.forbid ?? []) {
      const ok = !forbidden.match.test(summary);
      results.push({
        ok,
        label: ok
          ? `${label}: ${forbidden.label}`
          : `${label}: ${forbidden.label} (still in "${summary}")`,
      });
    }

    const over = calls.filter((call) => typeof call.goal === "string" && call.goal.length > GOAL_MAX_LEN);
    results.push({
      ok: over.length === 0,
      label: over.length === 0
        ? `${label}: every declared goal is within ${GOAL_MAX_LEN} chars`
        : `${label}: a declared goal is ${over[0].goal.length} chars, over the ${GOAL_MAX_LEN} limit`,
    });
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
  GOAL_MAX_LEN,
  cleanText,
  stripAnsiDeep,
  parseSessionJsonl,
  callsIn,
  turnEvents,
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
