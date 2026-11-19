
export const DEFAULT_THRESHOLD_PERCENT = 40;
// Models whose cost carries request-wide input pricing tiers (e.g. gpt-6.1-sol doubles
// every rate above 272k input tokens) get their check threshold capped to the tier
// boundary, minus this margin, so the check starts before the price step instead of after.
export const COST_TIER_SAFETY_TOKENS = 16_384;
// The check is injected transiently into a model request that was going to happen
// anyway; Pi restores the transcript afterwards, so the model only sees it on the
// turns it is injected. Re-injecting on every turn (still at most once per turn)
// keeps it present at whichever turn turns out to be the natural checkpoint.
// Set to 3 to emit it only every third turn (cheaper, but leaves blind windows).
const HINT_INTERVAL_TURNS = 1;
const COMPACTION_CALLBACK_TIMEOUT_MS = 120_000;
const SUBAGENT_STATUS_TIMEOUT_MS = 10_000;
let subagentStatusRequestId = 0;

function askMessage(percent) {
  return {
    role: "user",
    content: [{
      type: "text",
      text: `[Pi auto-compact check] Context usage (${percent.toFixed(1)}% of the model window) is above the active auto-compact threshold. Do not compact before doing any work on the active request. At the first safe checkpoint within that request, call request_compaction alone before starting the next substantial unit: a coherent unit is complete, the goal, decisions, constraints and next action can survive summarization, and no tool, delegated work, message or user decision is pending. Pi will resume the remaining work after compaction. Remaining task steps are not pending activity: a completed tool result can mark a checkpoint before the next substantial step. If a tool, delegation, message or decision is actually pending, keep working where possible. If only the final answer or a small wrap-up remains, finish normally. After compaction, wait for a new completed unit before requesting again.`,
    }],
    timestamp: Date.now(),
  };
}

// The held user request starts its own run, so nothing competes with this decision:
// the request is data here, not a pending commitment to serve.
export function judgmentMessage(percent, input) {
  return `[Pi pre-turn compact check] Context usage (${percent.toFixed(1)}% of the model window) is above the active auto-compact threshold. A user request is held and is delivered after this decision — do not perform it here. It is:\n\n${input}\n\nReply only SKIP-COMPACTION if a tool, delegation or queued message is pending, the request answers a question in an ongoing interview, a decision is unresolved, or needs exact prior details a summary could lose. Otherwise, if the request is independent or only needs a stable result or constraint a summary can preserve, call request_compaction exactly once as your only output. If neither case is clear, reply only SKIP-COMPACTION.`;
}

// Percent of the window at which a model's cheapest pricing tier stops applying.
function tierThresholdPercent(model, contextWindow) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const tiers = model?.cost?.tiers;
  if (!Array.isArray(tiers)) return undefined;
  const boundaries = tiers
    .map((tier) => tier?.inputTokensAbove)
    .filter((tokens) => Number.isFinite(tokens) && tokens > 0);
  if (boundaries.length === 0) return undefined;
  return ((Math.min(...boundaries) - COST_TIER_SAFETY_TOKENS) / contextWindow) * 100;
}

export function createAutoCompactController({
  thresholdPercent: configuredThresholdPercent = DEFAULT_THRESHOLD_PERCENT,
  costTiersOverride = true,
} = {}) {
  let thresholdPercent = configuredThresholdPercent;
  let enabled = true;
  let pending = false;
  let lastAskTurn = -Infinity;
  let turnIndex = 0;
  let judging = false;

  // The configured threshold, capped by the model's cost-tier boundary when that cap
  // applies. The cap can only make the check earlier, never later.
  const thresholdState = (ctx, usage = ctx.getContextUsage()) => {
    const tierCap = costTiersOverride
      ? tierThresholdPercent(ctx.model, usage?.contextWindow ?? ctx.model?.contextWindow)
      : undefined;
    const capped = tierCap !== undefined && tierCap < thresholdPercent ? tierCap : undefined;
    return { threshold: capped ?? thresholdPercent, tierCap: capped };
  };

  const contextPercent = (ctx) => {
    if (!enabled) return undefined;
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    if (!Number.isFinite(percent)) return undefined;
    return percent > thresholdState(ctx, usage).threshold ? percent : undefined;
  };

  return {
    configure(value, { costTiersOverride: nextCostTiersOverride } = {}) {
      if (nextCostTiersOverride !== undefined) costTiersOverride = nextCostTiersOverride;
      if (value === "off") {
        enabled = false;
        return { enabled, thresholdPercent };
      }
      thresholdPercent = value;
      enabled = true;
      return { enabled, thresholdPercent };
    },

    getConfiguration() {
      return { enabled, thresholdPercent, costTiersOverride };
    },

    describeThreshold(ctx) {
      return thresholdState(ctx);
    },

    onTurnStart(index) {
      if (Number.isFinite(index)) turnIndex = index;
    },

    onAgentStart() {
      lastAskTurn = -Infinity;
    },

    // Usage above the threshold, or undefined when auto-compact does not apply.
    percent(ctx) {
      return contextPercent(ctx);
    },

    setJudging(value) {
      judging = value;
    },

    // Transient hint appended to the next model request, never persisted.
    ask(ctx) {
      if (pending || judging) return undefined;
      const percent = contextPercent(ctx);
      if (percent === undefined) return undefined;
      if (turnIndex - lastAskTurn < HINT_INTERVAL_TURNS) return undefined;
      lastAskTurn = turnIndex;
      return askMessage(percent);
    },

    request(ctx) {
      if (ctx.hasPendingMessages()) return "unsafe_state";
      if (contextPercent(ctx) === undefined) return "below_threshold";
      pending = true;
      return "queued";
    },

    consumeRequest() {
      const requested = pending;
      pending = false;
      return requested;
    },

    isAboveThreshold(ctx) {
      return contextPercent(ctx) !== undefined;
    },

    isEnabled() {
      return enabled;
    },

    clearRequest() {
      pending = false;
    },
  };
}

function hasOnlyCompactionToolCall(event) {
  const messages = event.context.contextMessages;
  if (!Array.isArray(messages)) return false;
  const assistant = messages.findLast((message) => message.role === "assistant");
  if (!assistant?.content?.some((part) => part.type === "toolCall")) return false;
  const calls = assistant.content.filter((part) => part.type === "toolCall");
  return calls.length === 1 && calls[0].name === "request_compaction";
}

function hasPendingSupervisorDecision(event, ctx) {
  const requests = (event.context.contextMessages ?? []).filter((message) =>
    message.role === "custom" && message.customType === "subagent_supervisor_request" && message.details?.expectsReply === true);
  if (requests.length === 0) return false;
  const requested = new Set(requests.map((message) => message.details.requestId ?? message.details.id));
  if ([...requested].some((id) => typeof id !== "string" || id.length === 0)) return true;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "subagent_supervisor_reply" && typeof entry.data?.requestId === "string") {
      requested.delete(entry.data.requestId);
    }
  }
  return requested.size > 0;
}

function hasNoActiveSubagents(pi, signal, timeoutMs = SUBAGENT_STATUS_TIMEOUT_MS) {
  let tools;
  try {
    tools = pi.getAllTools();
  } catch {
    return Promise.resolve(false);
  }
  if (!Array.isArray(tools)) return Promise.resolve(false);
  if (!tools.some((tool) => tool.name === "subagent")) return Promise.resolve(true);
  if (typeof pi.events?.on !== "function" || typeof pi.events?.emit !== "function") return Promise.resolve(false);

  const requestId = `auto-compact-${Date.now()}-${++subagentStatusRequestId}`;
  const replyChannel = `subagents:rpc:v1:reply:${requestId}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (safe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { unsubscribe(); } catch { /* Optional status service must not fail the agent. */ }
      signal?.removeEventListener("abort", onAbort);
      resolve(safe);
    };
    const onAbort = () => finish(false);
    let unsubscribe = () => {};
    const timeout = setTimeout(() => finish(false), timeoutMs);
    try {
      unsubscribe = pi.events.on(replyChannel, (reply) => {
      if (reply?.version !== 1 || reply.requestId !== requestId || reply.method !== "status" || reply.success !== true) {
        finish(false);
        return;
      }
      const data = reply.data;
      const snapshot = data?.asyncSnapshot;
      if (
        !Number.isSafeInteger(data?.fleet?.totalActive) ||
        snapshot?.kind !== "pi-subagents.async-status-snapshot" ||
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.runs) ||
        !Number.isSafeInteger(snapshot.omitted?.runs) ||
        !Number.isSafeInteger(snapshot.omitted?.children) ||
        typeof snapshot.omitted?.byteLimitExceeded !== "boolean" ||
        snapshot.omitted.runs !== 0 ||
        snapshot.omitted?.children !== 0 ||
        snapshot.omitted?.byteLimitExceeded !== false ||
        (snapshot.caps && (!Number.isSafeInteger(snapshot.caps.maxRuns) || snapshot.runs.length > snapshot.caps.maxRuns))
      ) {
        finish(false);
        return;
      }
      const allSettled = (nodes) => nodes.every((node) =>
        node && typeof node === "object" && SETTLED_SUBAGENT_STATES.has(node.state) &&
        (node.children === undefined || Array.isArray(node.children)) && allSettled(node.children ?? []));
      finish(data.fleet.totalActive === 0 && allSettled(snapshot.runs));
      });
    } catch {
      finish(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return finish(false);
    try {
      pi.events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method: "status",
        params: {},
      });
    } catch {
      finish(false);
    }
  });
}

export const THRESHOLD_PERCENT = DEFAULT_THRESHOLD_PERCENT;
export const AUTO_COMPACT_CONTINUE = "Context was compacted. Continue the task.";

const SETTLED_SUBAGENT_STATES = new Set(["complete", "failed", "stopped", "rejected"]);

function readThresholdPercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

export function registerAutoCompact(pi, {
  loadCompactionModule = () => Promise.reject(new Error("Pi compaction SDK loader was not configured")),
  timeoutMs = COMPACTION_CALLBACK_TIMEOUT_MS,
  subagentStatusTimeoutMs = SUBAGENT_STATUS_TIMEOUT_MS,
} = {}) {
  const controller = createAutoCompactController();
  // Settings cannot be read while the extension is loading (the runtime is not bound
  // yet), so they are applied on the first event instead of at registration.
  let settingsApplied = false;
  const applySettingsOnce = () => {
    if (settingsApplied) return;
    settingsApplied = true;
    const settings = pi.getSettings()?.auto_compact;
    controller.configure(
      readThresholdPercent(settings?.compressionThresholdPercent) ?? DEFAULT_THRESHOLD_PERCENT,
      { costTiersOverride: settings?.enableCostTiersOverrideThreshold !== false },
    );
  };
  const on = (event, handler) => pi.on(event, (...args) => {
    applySettingsOnce();
    return handler(...args);
  });
  let pendingNotice;
  pi.registerCommand("auto_compact", {
    description: "Set automatic compaction threshold (0-100%) or turn it off",
    handler: async (args, ctx) => {
      applySettingsOnce();
      const value = args.trim();
      if (!value) {
        const { enabled, thresholdPercent } = controller.getConfiguration();
        if (!enabled) {
          ctx.ui.notify("Auto-compact: off", "info");
          return;
        }
        const { tierCap } = controller.describeThreshold(ctx);
        ctx.ui.notify(
          tierCap === undefined
            ? `Auto-compact threshold: ${thresholdPercent}%`
            : `Auto-compact threshold: ${thresholdPercent}% (effective ${tierCap.toFixed(1)}% — ${ctx.model?.id ?? "model"} cost tier cap)`,
          "info",
        );
        return;
      }
      if (/^off$/i.test(value)) {
        controller.configure("off");
        ctx.ui.notify("Auto-compact: off", "info");
        return;
      }
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
        ctx.ui.notify("Usage: /auto_compact [0-100|off]", "warning");
        return;
      }
      const thresholdPercent = Number(value);
      if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
        ctx.ui.notify("Threshold must be between 0 and 100", "warning");
        return;
      }
      controller.configure(thresholdPercent);
      ctx.ui.notify(`Auto-compact threshold set to ${thresholdPercent}%`, "info");
    },
  });
  const reportCommitted = (ctx) => {
    if (!pendingNotice) return;
    const committed = ctx.sessionManager.getBranch().some(entry =>
      entry.type === "custom_message" && entry.customType === "auto-compact-continuation" &&
      entry.details?.noticeId === pendingNotice);
    if (!committed) return;
    pendingNotice = undefined;
    if (ctx.mode === "print") console.error("[auto-compact] Automatic compaction completed and is active in the session context.");
  };
  const deferred = [];
  // Held requests come back through the input hook; match them by text so a delivered
  // request is not judged again and a request typed meanwhile is still judged.
  const redelivering = [];

  const hasPriorAssistantTurn = (ctx) => ctx.sessionManager.getBranch()
    .some((entry) => entry.type === "message" && entry.message?.role === "assistant");

  // Hold the request so the judgment runs on its own, with nothing pending to serve.
  on("input", (event, ctx) => {
    if (redelivering[0] === event.text) {
      redelivering.shift();
      return { action: "continue" };
    }
    if (event.streamingBehavior || event.text.trimStart().startsWith("/")) return { action: "continue" };
    // Holding needs a mode where an extension can start a run while the agent is idle;
    // print and json prompts arrive as their own run and would be swallowed.
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return { action: "continue" };
    if (!ctx.isIdle?.()) return { action: "continue" };
    if (deferred.length > 0 || !controller.isEnabled() || !hasPriorAssistantTurn(ctx)) return { action: "continue" };
    const percent = controller.percent(ctx);
    if (percent === undefined) return { action: "continue" };
    deferred.push(event.text);
    controller.setJudging(true);
    pi.sendMessage({
      customType: "auto-compact-pre-turn",
      display: true,
      content: judgmentMessage(percent, event.text),
    }, { triggerTurn: true });
    return { action: "handled" };
  });
  on("before_agent_start", (event) => {
    if (event.messageType === "custom" && event.message?.customType === "auto-compact-pre-turn") controller.setJudging(true);
  });
  on("agent_start", () => controller.onAgentStart());
  on("turn_start", (event) => controller.onTurnStart(event.turnIndex));
  on("context", (event, ctx) => {
    reportCommitted(ctx);
    const hint = controller.ask(ctx);
    if (hint) event.messages.push(hint);
  });
  pi.registerTool({
    name: "request_compaction",
    label: "Request context compaction",
    description:
      `Queue context compaction for Pi's final pre-settlement boundary. Call once as the only tool in the batch when context usage is strictly above the active auto-compact threshold, the active check identifies a safe boundary and nothing is pending. The held request in a pre-turn check is the next work, not a blocker. Pi commits the compaction and continuation drafts before continuing. Do not call it to wrap up a finished task, at the threshold or below, when auto-compact is off, or with unknown usage.`,
    promptSnippet: "Queue safe context compaction after this agent run settles",
    promptGuidelines: [
      "Call request_compaction at most once per run, as the only tool in its batch, and only when the injected Pi runtime check reports context usage strictly above the active auto-compact threshold and the active check’s branch-specific criteria hold. The tool ends the current run so the extension can prepare a compaction draft at Pi's final pre-settlement boundary; Pi commits it before continuing.",
      "Do not call it to wrap up a finished task with no next work. In pre-turn checks, the held request is the next work.",
      "Call it alone, not alongside other tools; Pi only ends the run when every tool in the batch opts into termination.",
      "Before calling, confirm no tool is running, no delegated work or supervisor decision is pending, and no queued message exists. Ensure the goal, key decisions, constraints, and next action can survive summarization.",
      "At or below the active threshold, when auto-compact is off, with unknown usage, or if the tool declines, keep working.",
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = controller.request(ctx);
      if (result !== "queued") {
        const { enabled, thresholdPercent } = controller.getConfiguration();
        const reason = result === "unsafe_state"
          ? "there are queued messages"
          : enabled ? `context usage is unknown or not above ${thresholdPercent}%` : "auto-compact is off";
        return {
          content: [{ type: "text", text: `Compaction not queued: ${reason}.` }],
          details: { queued: false, reason },
        };
      }

      return {
        content: [{ type: "text", text: "Compaction queued for the end of this agent run." }],
        details: { queued: true },
        terminate: true,
      };
    },
  });

  on("agent_before_settle", async (event, ctx) => {
    if (!controller.consumeRequest()) return;
    const resume = () => {
      // A held request is delivered at settle; a "continue the task" continuation here would
      // make the model answer it first and answer it again after delivery.
      if (deferred.length > 0) return undefined;
      if (event.outcome !== "completed" || ctx.signal?.aborted || event.continue ||
        event.context.pendingMessages.length > 0 || ctx.hasPendingMessages() || hasPendingSupervisorDecision(event, ctx) ||
        !hasOnlyCompactionToolCall(event)) return;
      return { entries: [...event.entries, {
        type: "custom_message", customType: "auto-compact-deferred", display: false,
        content: "Context was not compacted. Continue the task normally. Reassess compaction at a later natural checkpoint if context remains above the active threshold; no token-growth wait is required.",
      }], continue: true };
    };
    if (
      event.outcome !== "completed" ||
      ctx.signal?.aborted ||
      event.continue ||
      event.context.pendingMessages.length > 0 ||
      ctx.hasPendingMessages() ||
      hasPendingSupervisorDecision(event, ctx) ||
      !hasOnlyCompactionToolCall(event)
    ) return;
    if (!controller.isAboveThreshold(ctx)) return resume();
    if (!await hasNoActiveSubagents(pi, ctx.signal, subagentStatusTimeoutMs)) return resume();
    if (ctx.hasPendingMessages() || !controller.isEnabled() || !controller.isAboveThreshold(ctx)) return resume();
    const model = ctx.model;
    if (!model) return resume();
    const branch = ctx.sessionManager.getBranch();
    const settings = pi.getSettings();
    const compaction = settings.compaction;
    const override = compaction?.modelOverrides?.[`${model.provider}/${model.id}`];
    const compactionSettings = {
      enabled: compaction?.enabled ?? true,
      reserveTokens: override?.reserveTokens ?? compaction?.reserveTokens ?? 16384,
      keepRecentTokens: override?.keepRecentTokens ?? compaction?.keepRecentTokens ?? 20000,
    };
    if (!compactionSettings.enabled) return resume();

    const drafts = await new Promise((resolve) => {
      let settled = false;
      const abortController = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, abortController.signal]) : abortController.signal;
      const timeout = setTimeout(() => {
        abortController.abort();
        fail(new Error("compaction timed out"));
      }, timeoutMs);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        const message = `Automatic compaction failed: ${error.message}`;
        try {
          ctx.ui.notify(message, "warning");
          if (!ctx.hasUI) console.error(message);
        } catch (notifyError) {
          console.error(`${message}; notification failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`);
        } finally {
          finish(undefined);
        }
      };
      void (async () => {
        const compactionSdk = await loadCompactionModule();
        const preparation = compactionSdk.prepareCompaction(branch, compactionSettings);
        if (!preparation) throw new Error("Nothing to compact (session too small)");
        const retry = {
          enabled: settings.retry?.enabled ?? true,
          maxRetries: settings.retry?.maxRetries ?? 3,
          baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
          maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? 60_000,
        };
        const result = await compactionSdk.compact(
          preparation,
          model,
          undefined,
          undefined,
          undefined,
          signal,
          ctx.thinkingLevel,
          (summaryModel, transcript, options) => ctx.modelRegistry.streamSimple(summaryModel, transcript, options),
          undefined,
          retry,
          undefined,
          ctx.sessionManager.getSessionId(),
        );
        if (settled || signal.aborted || ctx.hasPendingMessages() || !controller.isEnabled() || !controller.isAboveThreshold(ctx) ||
          hasPendingSupervisorDecision(event, ctx) || !hasOnlyCompactionToolCall(event)) return finish(undefined);
        if (!await hasNoActiveSubagents(pi, signal, subagentStatusTimeoutMs)) return finish(undefined);
        if (settled || signal.aborted || ctx.hasPendingMessages() || !controller.isEnabled() ||
          hasPendingSupervisorDecision(event, ctx) || !hasOnlyCompactionToolCall(event)) return finish(undefined);
        pendingNotice = `auto-compact-${Date.now()}-${++subagentStatusRequestId}`;
        const entries = [...event.entries];
        finish([
          ...entries,
          {
            type: "compaction",
            summary: result.summary,
            firstKeptEntryId: result.firstKeptEntryId,
            details: result.details,
            usage: result.usage,
          },
          {
            type: "custom_message",
            customType: "auto-compact-continuation",
            content: deferred.length > 0 ? deferred.shift() : AUTO_COMPACT_CONTINUE,
            display: true,
            details: { noticeId: pendingNotice },
          },
        ]);
      })().catch(fail);
    });
    if (!drafts) return resume();
    return { entries: drafts, continue: true };
  });
  on("agent_settled", (_event, ctx) => {
    reportCommitted(ctx);
    pendingNotice = undefined;
    controller.clearRequest();
    controller.setJudging(false);
    if (deferred.length === 0) return;
    // The request was held but no compaction is carrying it: deliver it anyway.
    for (const text of deferred.splice(0, deferred.length)) {
      redelivering.push(text);
      pi.sendUserMessage(text);
    }
  });
}
