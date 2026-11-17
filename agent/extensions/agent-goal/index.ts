/**
 * agent-goal — main-agent current-status header
 *
 * Shows, in real time, what the MAIN agent is currently working toward,
 * WITHOUT touching /goal routing, auto-continuation, or any scheduling.
 * It is purely a display layer for the user:
 *
 *   user_prompt:  the last real user prompt (from `input` event)
 *   agent_goal:   the agent's self-declared current goal (from `set_goal` tool;
 *                 the instruction lives only in the tool's `promptGuidelines`)
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
 * Visibility is a loadout concern, not a state-machine concern: `set_goal` is
 * `exposure: "model-only"` (never callable from another tool, so codemode cannot
 * inline its rules) and `prepareLoadout` hides its declaration whenever the
 * extension is off or the session has no UI to show it in. Hidden means hidden
 * from the provider: no declaration, no `promptSnippet`, no `promptGuidelines`.
 * The tool stays active, so toggling never rebuilds the active set and cannot
 * drop tools that are still waiting to register.
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
const GOAL_MAX_LEN = 120; // the goal line's length budget, stated in the parameter docs
const PROMPT_MAX_LEN = 400;
const STATUS_MAX_LEN = 60; // footer line width budget (shared with other exts)

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
    label: "Set Current Goal",
    // `model-only`: declared to the model while active, never callable from
    // another tool. codemode lists every callable tool's description and
    // guidelines in its own description, so a callable set_goal would leak its
    // maintenance rules into that one tool's declaration even when hidden.
    exposure: "model-only",
    description:
      "Show the user the outcome you are currently working toward. Optional display bookkeeping; it never changes your instructions. mode:\"new\" replaces the goal line, mode:\"rewrite\" re-expresses the same outcome after its text changed, mode:\"expand\" adds one nested focus row under an unchanged parent goal.",
    promptSnippet: "Show the user the outcome you are working toward (new / rewrite / expand)",
    promptGuidelines: [
      "set_goal is optional display bookkeeping: it shows the user the outcome you are working toward and never changes your instructions or what you do next.",
      "Call set_goal mode:\"new\" only when you start an independent outcome — there is no current goal, or the user has moved to a different outcome. Continuing the same outcome is not a reason to call it, even right after a new user message; a separate new task inside the same repo still counts as an independent outcome.",
      "Call set_goal mode:\"rewrite\" only when the text of the same outcome has to change (an added constraint, or wording that is now misleading) and the core outcome stays recognizable.",
      "Call set_goal mode:\"expand\" when a sub-problem worth showing becomes the current focus; the parent goal line stays unchanged and a later expand replaces the nested row.",
      "When a tool call is independently necessary and can be safely batched in the same response, send set_goal together with it; never spend an extra round trip or extra work only to refresh the display — otherwise skip or defer the optional update.",
      "Do show the goal at the start of a genuinely complex task and when the outcome really pivots; a simple one-shot answer needs no call.",
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
        ctx.ui.setStatus(STATUS_KEY, undefined);
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