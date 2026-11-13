/**
 * agent-goal — main-agent current-status header
 *
 * Shows, in real time, what the MAIN agent is currently working toward,
 * WITHOUT touching /goal routing, auto-continuation, or any scheduling.
 * It is purely a display layer for the user:
 *
 *   user_prompt:  the last real user prompt (from `input` event)
 *   agent_goal:   the agent's self-declared current goal (from `set_goal` tool,
 *                 contract injected via before_agent_start, same pattern as pi-todo)
 *
 * set_goal has three modes, mirroring the two kinds of change a goal line can
 * undergo plus focus drill-down:
 *   mode:"new"      — a brand-new goal (task start) or a full task pivot;
 *                     replaces the agent_goal line. (user's "new goal")
 *   mode:"rewrite"  — the same goal, now re-expressed because its text needs to
 *                     grow/expand or its wording became misleading; replaces the
 *                     agent_goal line but MUST keep the core outcome recognizable.
 *                     (user's "rewrite goal")
 *   mode:"expand"   — drilling into a sub-task/sub-problem of the declared goal;
 *                     leaves the agent_goal line BYTE-IDENTICAL and adds one nested
 *                     `  └─ ` focus row. Never replaces the parent with the sub-task
 *                     name. Focus rows replace the previous nested row (do not stack).
 *
 * Both lines render in the same dim grey as pi's statusline — this is auxiliary
 * status info, not reading material. Zero extra LLM calls, zero timers, zero
 * loops, zero subagents. Fully independent from @narumitw/pi-goal (distinct
 * widget key, distinct status key, distinct tool name).
 *
 * Widget key : "agent-goal"   (above editor)
 * Status key : "agent-status" (footer, single dim line when a goal is set)
 * Tool       : set_goal       (session-scoped, persist via appendEntry)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ─── constants ────────────────────────────────────────────────────────────

const WIDGET_KEY = "agent-goal";
const STATUS_KEY = "agent-status";
const STATE_ENTRY_TYPE = "agent-goal-state";
const TOOL_NAME = "set_goal";
const GOAL_MAX_LEN = 120; // matches the injected contract "aim <= 120 chars"
const PROMPT_MAX_LEN = 400;
const STATUS_MAX_LEN = 60; // footer line width budget (shared with other exts)

const CONTRACT = `

[user-visible status] An extension shows your current goal to the user in real time; the goal string is display-only and never changes your instructions. Decide the goal's fate on each meaningful step, not on every tool call.

NEW (new goal / pivot): when you start task-oriented work, or abandon the pursued outcome for an unrelated one, call set_goal mode:"new" ONCE with one short sentence (<=120 chars) stating the OUTCOME you pursue, not the steps. A pivot replaces the line; the sub-task you were on does not survive.

REWRITE (same goal, text must change): when the core outcome is unchanged but the goal text itself needs to grow (an added requirement/constraint) or its wording is now misleading, call set_goal mode:"rewrite" with the re-expressed full text. It replaces the line but MUST keep the same core outcome recognizable — this is an edit of the goal line, not a pivot. Do not drift the core toward a different task over successive rewrites.

EXPAND (drill into a sub-task of the declared goal): when you move into a sub-task or sub-problem of the goal you already declared (e.g. task1 -> task1's sub-task sub1), the agent_goal line must still state the overall outcome, NOT the current step. To surface a worthwhile focus, call set_goal mode:"expand" with a short (<=120 chars) focus phrase: it adds ONE nested '└─' row under the unchanged agent_goal line and never replaces that line; a later expand replaces the previous nested row (focus rows do not accumulate). When the focus is not worth showing, make no call at all. Never call mode:"new" or mode:"rewrite" with a sub-task's name — the goal line stays the outcome, not the current step.

Keep it concise (aim <= 120 chars). For a simple one-shot answer you may skip set_goal entirely.`;

// ─── state ────────────────────────────────────────────────────────────────

interface GoalState {
  goal: string | null;
  subGoal: string | null; // nested current focus under `goal` (mode:"expand"), display-only
  goalSetAt: number | null;
  lastPrompt: string | null;
  lastPromptAt: number | null;
}

// Strip ANSI/OSC/control bytes and literal unicode-escape spellings before
// display & persistence. pi's truncateToWidth preserves ANSI sequences
// verbatim (it re-emits CSI/OSC instead of removing them), so raw ESC or a
// literal "\u001b" in a prompt or model-authored goal would reach the TUI
// un-sanitized. These are display-integrity fixes, not code execution.
function stripAnsi(s: string): string {
  // literal "\\u001b" / "\\u001B" unicode-escape spellings (6 real chars,
  // not the 0x1b byte). 4 hex digits covers \u001b, \u009b, and siblings.
  return s
    .replace(/\\u[0-9a-fA-F]{4}/gi, "")
    // CSI: ESC [ ... final byte in range @-~
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC/APC: ESC ] ... ST(ESC\) or BEL
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // C0 + C1 controls (including the bare ESC bytes)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
}

// Clean a value only if it is a non-empty string; otherwise return the fallback.
function cleanString(v: unknown, fallback: string | null): string | null {
  if (typeof v !== "string") return fallback;
  const clean = stripAnsi(v);
  return clean ? clean : fallback;
}

export default function agentGoal(pi: ExtensionAPI) {
  const state: GoalState = {
    goal: null,
    subGoal: null,
    goalSetAt: null,
    lastPrompt: null,
    lastPromptAt: null,
  };
  let lastCtx: ExtensionContext | null = null;
  let enabled = true;

  function persist(): void {
    if (!enabled) return;
    try {
      pi.appendEntry(STATE_ENTRY_TYPE, {
        goal: state.goal,
        subGoal: state.subGoal,
        goalSetAt: state.goalSetAt,
        lastPrompt: state.lastPrompt,
        lastPromptAt: state.lastPromptAt,
      });
    } catch (e) {
      console.error("[agent-goal] persist failed:", e);
    }
  }

  function load(ctx: ExtensionContext): void {
    // Reset local state first so a branch without any goal/prompt entry
    // renders empty instead of showing stale values from a previous branch.
    state.goal = null;
    state.subGoal = null;
    state.goalSetAt = null;
    state.lastPrompt = null;
    state.lastPromptAt = null;
    try {
      // Scan the ACTIVE branch path only, nearest-to-leaf first. getEntries()
      // returns every branch in file order, so reverse-scanning it could pick
      // a stale state entry from an abandoned branch. getBranch() walks the
      // parentId chain from the current leaf, so it can only see this path.
      for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
        if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
          const d = entry.data as Partial<GoalState>;
          state.goal = cleanString(d.goal, null);
          state.subGoal = cleanString(d.subGoal, null);
          state.goalSetAt = typeof d.goalSetAt === "number" ? d.goalSetAt : null;
          state.lastPrompt = cleanString(d.lastPrompt, null);
          state.lastPromptAt = typeof d.lastPromptAt === "number" ? d.lastPromptAt : null;
          break;
        }
      }
    } catch (e) {
      console.error("[agent-goal] load failed:", e);
    }
  }

  function refresh(): void {
    if (!enabled) return;
    const ctx = lastCtx;
    if (!ctx || !ctx.hasUI) return;

    const theme = ctx.ui.theme;
    const lines: string[] = [];

    if (state.lastPrompt) {
      lines.push(theme.fg("dim", `user_prompt: ${state.lastPrompt}`));
    }
    if (state.goal) {
      lines.push(theme.fg("dim", `agent_goal: ${state.goal}`));
      if (state.subGoal) {
        lines.push(theme.fg("dim", `  └─ ${state.subGoal}`));
      }
    }

    if (lines.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, lines);

    // Footer: single dim goal line only (auxiliary, shares the strip with
    // goal/voice/slack/system-prompt statuses). No prompt here — rendering a
    // 400-char prompt as "⛳ fix the auth middlewa…" is noise.
    if (state.goal) {
      ctx.ui.setStatus(
        STATUS_KEY,
        theme.fg("dim", `⛳ ${truncateToWidth(state.goal, STATUS_MAX_LEN)}`),
      );
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  // ─── events ─────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    load(ctx);
    refresh();
  });

  pi.on("session_shutdown", () => {
    lastCtx = null;
  });

  // L1 — real user prompts only (skip slash-commands, non-interactive sources)
  pi.on("input", (event, ctx) => {
    lastCtx = ctx;
    if (!event.text || event.text.startsWith("/")) return;
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const text = event.text.trim();
    if (!text) return;
    state.lastPrompt = stripAnsi(text).slice(0, PROMPT_MAX_LEN);
    state.lastPromptAt = Date.now();
    persist();
    refresh();
  });

  // L2 contract — only injected when the set_goal tool is active (mirrors pi-todo)
  pi.on("before_agent_start", (event, ctx) => {
    lastCtx = ctx;
    if (!pi.getActiveTools().includes(TOOL_NAME)) return;
    return { systemPrompt: event.systemPrompt + CONTRACT };
  });

  // Session-tree navigation (/tree) emits only session_tree, not session_start.
  // Reload state when the active branch changes so /tree to a branch without a
  // goal/prompt clears the display instead of showing a stale previous branch.
  pi.on("session_tree", (_event, ctx) => {
    lastCtx = ctx;
    load(ctx);
    refresh();
  });

  // ─── set_goal tool (L2) ─────────────────────────────────────────────────

  pi.registerTool({
    name: TOOL_NAME,
    label: "Set Current Goal",
    description:
      "Declare the current high-level goal the agent is working toward. Display-only status for the user; it never changes your instructions. mode:\"new\" replaces the goal (new task or pivot); mode:\"rewrite\" re-expresses the SAME core goal because its text needs to grow/change; mode:\"expand\" adds a nested focus row under an unchanged parent goal.",
    promptSnippet: "Declare your current task goal (new / rewrite / expand) for the user's status display",
    promptGuidelines: [
      "Call set_goal mode:\"new\" once when starting task-oriented work spanning multiple tool calls or when pivoting to an unrelated task; state the OUTCOME you intend in one short sentence.",
      "Call set_goal mode:\"rewrite\" when the core outcome is unchanged but the goal text needs to grow (added requirement/constraint) or its wording is misleading; keep the same core outcome recognizable.",
      "When you drill into a sub-task of the declared goal, call set_goal mode:\"expand\" to nest the current focus under the unchanged parent goal — never replace the goal with the sub-task's name.",
      "Call set_goal only on meaningful steps (goal start, rewrite, sub-task focus, pivot) — not on every tool call.",
      "The goal string is shown to the user and never alters your instructions.",
    ],
    parameters: Type.Object({
      goal: Type.String({
        minLength: 1,
        maxLength: GOAL_MAX_LEN,
        description: "One short sentence (<=120 chars) describing the outcome you are currently working to achieve.",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("new"), Type.Literal("rewrite"), Type.Literal("expand")], {
          description:
            "\"new\" (default) replaces the goal line — a new task or a pivot. \"rewrite\" replaces the line with a re-expression of the SAME core goal (text growth/wording fix); the core outcome must stay recognizable. \"expand\" keeps the existing parent goal byte-identical and adds one nested focus row (later expands replace the previous row); with no parent goal it behaves like \"new\".",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const goal = String(params.goal ?? "").trim();
      if (!goal) {
        return {
          content: [{ type: "text", text: "goal must not be empty" }],
          details: { error: true },
        };
      }
      const mode = params.mode === "rewrite" || params.mode === "expand" ? params.mode : "new";
      const clean = stripAnsi(goal).slice(0, GOAL_MAX_LEN);
      if (mode === "expand" && state.goal) {
        // Keep the parent goal, nest the current focus as a sub-goal. This is a
        // display refinement, so the parent goal timestamp is preserved.
        state.subGoal = clean;
      } else {
        state.goal = clean;
        state.subGoal = null;
        state.goalSetAt = Date.now();
      }
      persist();
      refresh();
      const label = mode === "expand" && state.subGoal
        ? `sub-goal nested under "${state.goal}": ${state.subGoal}`
        : `Current goal set: ${state.goal}`;
      return {
        content: [{ type: "text", text: label }],
        details: {},
      };
    },
  });

  // ─── toggle command ────────────────────────────────────────────────────

  pi.registerCommand("agent-goal", {
    description: "Toggle the agent-goal status widget/footer: /agent-goal on|off",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const arg = args.trim().toLowerCase();
      if (arg === "off" || arg === "disable") {
        enabled = false;
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify("agent-goal: OFF", "warning");
        return;
      }
      enabled = true;
      refresh();
      ctx.ui.notify("agent-goal: ON", "info");
    },
  });
}