/**
 * agent-goal — the main agent's session goals, shown above the editor
 *
 * Two display lines, nothing else:
 *   user_prompt:  the last real user prompt (from the `input` event)
 *   agent_goal:   the still-open goals of this session (from `set_goal`)
 *
 * `set_goal({ goal })` takes exactly one string:
 *   - a non-empty summary replaces the goal line with up to 300 characters
 *     describing the current goals or remaining todos.
 *   - an empty string clears the goal line (no goal left).
 *
 * Which goal is finished, cancelled, superseded or paused is the MAIN agent's
 * judgement; this extension only stores and displays the text. There is no task
 * database, no validator, no automatic call, no continuation.
 *
 * `user_prompt` and `agent_goal` are each one widget entry; the TUI word-wraps a
 * long entry, so a long summary needs no nested or extra rows.
 *
 * Visibility is a loadout concern, not a state-machine concern: `set_goal` is
 * `exposure: "model-only"` (never callable from another tool, so codemode cannot
 * inline its rules) and `prepareLoadout` hides its declaration whenever the
 * extension is off or the session has no UI to show it in. Hidden means hidden
 * from the provider: no declaration, no `promptSnippet`, no `promptGuidelines`.
 * The tool stays active, so toggling never rebuilds the active set and cannot
 * drop tools that are still waiting to register.
 *
 * Widget key : "agent-goal"   (above editor; the only display surface)
 * Tool       : set_goal       (session-scoped, persist via appendEntry)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── constants ────────────────────────────────────────────────────────────

const WIDGET_KEY = "agent-goal";
const STATE_ENTRY_TYPE = "agent-goal-state";
const TOOL_NAME = "set_goal";
const GOAL_MAX_LEN = 300; // the goal line's length budget, stated in the parameter docs
const PROMPT_MAX_LEN = 400;

// ─── state ────────────────────────────────────────────────────────────────

interface GoalState {
  goal: string | null; // summary of the still-open goals; null = no goal left
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
    lastPrompt: null,
    lastPromptAt: null,
  };
  let lastCtx: ExtensionContext | null = null;
  let enabled = true;
  // Whether this session can show the goal at all. Set from `ctx.hasUI` on every
  // event; the tool is only declared to the provider when it is true.
  let hasUI = false;

  // ─── visibility (loadout) ─────────────────────────────────────────────

  /** Whether `set_goal` may be declared to the model right now. */
  function toolVisible(): boolean {
    return enabled && hasUI;
  }

  /**
   * Re-run the loadout so a visibility change takes effect on the next request.
   *
   * `setActiveTools` with the SAME active set is a loadout refresh, not a tool
   * change: `AgentSession.setActiveToolsByName()` only clears `_pendingToolNames`
   * when a previously active tool left the set (`previous.some(name => !active.has(name))`),
   * which cannot happen here because every name passed in came from
   * `getActiveTools()`. Re-sending the same set keeps tools that were restored
   * from the transcript and are still waiting to register. `getActiveToolNames()`
   * returns `agent.state.tools`, which still contains tools whose declarations
   * `prepareLoadout` hides, so `set_goal` stays in the set while hidden.
   */
  function refreshLoadout(): void {
    try {
      pi.setActiveTools(pi.getActiveTools());
    } catch (e) {
      console.error("[agent-goal] loadout refresh failed:", e);
    }
  }

  function persist(): void {
    if (!enabled) return;
    try {
      pi.appendEntry(STATE_ENTRY_TYPE, {
        goal: state.goal,
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
    state.lastPrompt = null;
    state.lastPromptAt = null;
    try {
      // Scan the ACTIVE branch path only, nearest-to-leaf first. getEntries()
      // returns every branch in file order, so reverse-scanning it could pick
      // a stale state entry from an abandoned branch. getBranch() walks the
      // parentId chain from the current leaf, so it can only see this path.
      //
      // Entries written before the single-string contract may carry a `subGoal`
      // or a `goalSetAt`; `goal` was already the display line then, so reading it
      // is the whole restore. The dropped fields are simply not read.
      for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
        if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
          const d = entry.data as Record<string, unknown>;
          state.goal = cleanString(d.goal, null);
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
    }

    if (lines.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, lines);
  }

  // ─── events ─────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    hasUI = ctx.hasUI;
    load(ctx);
    refreshLoadout();
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

  // Session-tree navigation (/tree) emits only session_tree, not session_start.
  // Reload state when the active branch changes so /tree to a branch without a
  // goal/prompt clears the display instead of showing a stale previous branch.
  pi.on("session_tree", (_event, ctx) => {
    lastCtx = ctx;
    hasUI = ctx.hasUI;
    load(ctx);
    refreshLoadout();
    refresh();
  });

  // ─── set_goal tool (L2) ─────────────────────────────────────────────────

  pi.registerTool({
    name: TOOL_NAME,
    label: "Set Current Goals",
    // `model-only`: declared to the model while active, never callable from
    // another tool. codemode lists every callable tool's description and
    // guidelines in its own description, so a callable set_goal would leak its
    // maintenance rules into that one tool's declaration even when hidden.
    exposure: "model-only",
    description: "Display one sentence about this session's current goals or remaining todos. Call when goals first become clear or materially change, after a user message or during work.",
    promptSnippet: "Show the current session goal or remaining todos",
    promptGuidelines: [
      "Call set_goal before replying or starting work on a new or changed goal. Refresh the summary when you discover, finish or change a goal, not for routine steps. Merge added requirements, retain unfinished work (including paused work), and omit completed, cancelled or superseded work.",
    ],
    parameters: Type.Object({
      goal: Type.String({
        maxLength: GOAL_MAX_LEN,
        description: "Still-open goals; \"\" clears.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // A model can still emit a call for a tool whose declaration it no longer
      // sees. Off or headless means no display, so such a call must not touch
      // state, the transcript, or the widget.
      if (!enabled || !ctx.hasUI) {
        return {
          content: [{ type: "text", text: "agent-goal is off; the goal was not recorded." }],
          details: { skipped: true },
        };
      }
      lastCtx = ctx;
      const goal = stripAnsi(typeof params.goal === "string" ? params.goal : "");
      if (!goal) {
        // An empty summary is a valid declaration: no goal is left.
        state.goal = null;
        persist();
        refresh();
        return {
          content: [{ type: "text", text: "No open goal: the goal line is cleared." }],
          details: {},
        };
      }
      state.goal = goal.slice(0, GOAL_MAX_LEN);
      persist();
      refresh();
      return {
        content: [{ type: "text", text: `Open goals: ${state.goal}` }],
        details: {},
      };
    },
    // Hide the declaration (and with it the snippet and the guidelines) from the
    // provider whenever this session cannot show a goal. The tool stays active
    // and keeps its persisted state, so turning it back on only restores the
    // declaration.
    prepareLoadout() {
      return { hiddenDeclarations: toolVisible() ? [] : [TOOL_NAME] };
    },
  });

  // ─── toggle command ────────────────────────────────────────────────────

  pi.registerCommand("agent-goal", {
    description: "Stop or restore the goal tool's declaration and display (history is kept): /agent-goal on|off",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      hasUI = ctx.hasUI;
      const arg = args.trim().toLowerCase();
      if (arg === "off" || arg === "disable") {
        enabled = false;
        refreshLoadout();
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.notify("agent-goal: OFF", "warning");
        return;
      }
      enabled = true;
      refreshLoadout();
      refresh();
      ctx.ui.notify("agent-goal: ON", "info");
    },
  });
}
