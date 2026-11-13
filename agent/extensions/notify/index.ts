/**
 * Send Pi completion notifications through the host OS or Herdr's local API.
 *
 * `agent_settled` is the end of one run, not the end of the user's task. Pi keeps
 * working without another user turn when another extension queues a continuation
 * during the settle boundary (goal mode, subagent wake) or when background
 * subagents are still running. Announcing "finished; ready for input" at that
 * instant tells the user to come back while the agent is mid-task, so the
 * notification waits out the settle boundary and only fires for a quiescent
 * session.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifySystem } from "../lib/system-notification.ts";

const execFileAsync = promisify(execFile);

/** One settle boundary plus slack for a queued continuation to start its run. */
const SETTLE_GRACE_MS = 250;

/** pi-subagents emits these on the in-process bus; without it the set stays empty. */
const BACKGROUND_STARTED_EVENT = "subagent:async-started";
const BACKGROUND_FINISHED_EVENTS = ["subagent:async-complete", "subagent:process-terminal"];

async function readHerdrLabel(
  args: string[],
  env: NodeJS.ProcessEnv,
  run: typeof execFileAsync,
): Promise<string | undefined> {
  const herdr = env.HERDR_BIN_PATH || "herdr";
  try {
    const { stdout } = await run(herdr, args, { timeout: 1000 });
    const payload = JSON.parse(stdout);
    return payload.result?.workspace?.label ?? payload.result?.tab?.label;
  } catch {
    return undefined;
  }
}

export async function resolveNotificationContext(
  ctx: Pick<ExtensionContext, "cwd">,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof execFileAsync = execFileAsync,
) {
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1") {
    const project = ctx.cwd.split(/[\\/]/).filter(Boolean).at(-1);
    return {
      title: project ? `Pi · ${project}` : "Pi",
      body: "Run finished; ready for input",
    };
  }

  const workspaceId = env.HERDR_WORKSPACE_ID;
  const tabId = env.HERDR_TAB_ID;
  const [workspaceLabel, tabLabel] = await Promise.all([
    workspaceId ? readHerdrLabel(["workspace", "get", workspaceId], env, run) : undefined,
    tabId ? readHerdrLabel(["tab", "get", tabId], env, run) : undefined,
  ]);
  const workspace = workspaceLabel || workspaceId || "workspace";
  const tab = tabLabel || tabId;

  return {
    title: `Pi · ${workspace}${tab ? ` / ${tab}` : ""}`,
    body: `Run finished; ready for input${paneId ? ` · ${paneId}` : ""}`,
  };
}

function backgroundRunId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { id?: unknown; runId?: unknown };
  if (typeof record.id === "string" && record.id) return record.id;
  if (typeof record.runId === "string" && record.runId) return record.runId;
  return undefined;
}

export interface CompletionNotifierOptions {
  /** How long to wait out the settle boundary before trusting that Pi is idle. */
  graceMs?: number;
  notify?: (title: string, body: string) => Promise<void>;
  resolveContext?: (ctx: Pick<ExtensionContext, "cwd">) => Promise<{ title: string; body: string }>;
}

/**
 * Notify the user when Pi settles with nothing left to run: no continuation
 * started, no queued messages, and no background subagent still working.
 */
export function registerCompletionNotifier(
  pi: Pick<ExtensionAPI, "on" | "events">,
  options: CompletionNotifierOptions = {},
): void {
  const graceMs = options.graceMs ?? SETTLE_GRACE_MS;
  const notify = options.notify ?? notifySystem;
  const resolveContext = options.resolveContext ?? resolveNotificationContext;
  const liveRuns = new Set<string>();
  let settledCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activityVersion = 0;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  async function deliver(ctx: ExtensionContext, version: number): Promise<void> {
    if (ctx.isIdle?.() !== true) return;
    if (ctx.hasPendingMessages?.() === true) return;
    if (liveRuns.size > 0) return;
    const notification = await resolveContext(ctx);
    if (version !== activityVersion) return;
    if (ctx.isIdle?.() !== true) return;
    if (ctx.hasPendingMessages?.() === true) return;
    if (liveRuns.size > 0) return;
    await notify(notification.title, notification.body);
  }

  function arm(): void {
    if (!settledCtx) return;
    cancel();
    const ctx = settledCtx;
    const version = activityVersion;
    timer = setTimeout(() => {
      timer = undefined;
      void deliver(ctx, version);
    }, graceMs);
    timer.unref?.();
  }

  pi.events.on(BACKGROUND_STARTED_EVENT, (payload) => {
    const id = backgroundRunId(payload);
    if (id) {
      activityVersion++;
      liveRuns.add(id);
    }
  });
  for (const event of BACKGROUND_FINISHED_EVENTS) {
    pi.events.on(event, (payload) => {
      const id = backgroundRunId(payload);
      if (!id) return;
      liveRuns.delete(id);
      // The completion may not wake the session; re-check once the last one drains.
      if (liveRuns.size === 0) arm();
    });
  }

  // A new run means Pi decided to keep going; the notification waits for its settle.
  pi.on("agent_start", () => {
    activityVersion++;
    cancel();
    settledCtx = undefined;
  });
  pi.on("session_shutdown", () => {
    activityVersion++;
    cancel();
    liveRuns.clear();
    settledCtx = undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    if (ctx?.mode !== "tui" || ctx?.isIdle?.() !== true) return;
    if (event?.aborted) return;
    activityVersion++;
    settledCtx = ctx;
    arm();
  });
}

export default function (pi: ExtensionAPI) {
  registerCompletionNotifier(pi);
}
