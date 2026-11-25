/**
 * Permission Gate Extension
 *
 * Blocks or asks for confirmation before running potentially dangerous
 * destructive commands.  Covers:
 *   - File-system destruction (rm -rf, dd, mkfs, etc.)
 *   - Global state changes (sudo, chmod 777, chown)
 *   - npm / npx global destructive operations (skills remove --all,
 *     uninstall, npm rm -g, etc.)
 *   - Git destructive operations (push --force, hard reset, clean -fd)
 *
 * Supports "allow always" via a persistent allowlist stored at
 * ~/.pi/agent/permission-gate-allowlist.json.  Each entry is a
 * { command, timestamp } record.  Exact-command comparison is used so
 * the user must re-allow if anything in the command string changes.
 *
 * A native OS notification is fired only when an interactive approval is
 * pending in a real terminal session (mode "tui"): commands blocked without
 * waiting for the user, and prompts shown to a non-terminal UI (RPC, tests),
 * stay silent.
 *
 * ── YOLO ─────────────────────────────────────────────────────────────
 * "This machine is unattended, execute autonomously."  Three ways in:
 *
 *   0. IN SETTINGS (survives restarts):
 *        "permission-gate": { "yolo": true }   in ~/.pi/agent/settings.json
 *      Default is false.  When true, YOLO is armed from the first tool
 *      call of every session, for every cwd.  Read once per session, so
 *      an edit takes effect in the next session.
 *
 *   1. IN THE PROMPT (someone at the screen): the confirmation dialog
 *      offers a "YOLO - this session" option.  Choosing it arms YOLO for
 *      the rest of the current session, scoped to the session's cwd.
 *
 *   2. BEFORE LEAVING (nobody at the screen): call the slash command
 *        /yolo          # arm YOLO for this session (scoped to current cwd)
 *        /yolo off      # disarm (also overrides permission-gate.yolo=true
 *                       #  for the rest of this session)
 *        /yolo status   # show whether YOLO is active, and why
 *
 * While YOLO is active, dangerous commands auto-pass EXCEPT those in
 * hardDenyPatterns below (the safety floor that is ALWAYS enforced, so an
 * overnight run can never wipe the machine).
 *
 * The footer carries the switch as "yolo: on" while the gate is disarmed,
 * and nothing at all while it is armed (absence already means off).  The
 * status key is "agent-yolo" because pi sorts footer statuses by key and
 * this key sorts just before "auto-agent-loop".
 *
 * Only the settings switch persists.  Dialog/command YOLO is in-memory and
 * session-scoped: it expires when the pi process exits, and applies only to
 * tool calls rooted at the cwd that was active when it was armed.
 *
 * ── Hard-deny floor (ALWAYS blocked, never allowlisted/YOLO'd) ──────
 * The following are unconditionally blocked in every mode (interactive,
 * allowlist, YOLO).  An overnight/headless run can never execute these:
 *   - sudo rm -rf <anything>
 *   - rm -rf on root or root-equivalent: /, //, /., /../, quoted "/",
 *     followed by a shell separator (; | &), or path traversal ending in
 *     /.. that resolves to root (rm -rf /a/.. , /a/b/..)
 *   - rm -rf * (worktree wipe)
 *   - dd writing to a raw disk device (of=/dev/sd*, vd*, xvd*, rdisk*, zero)
 *   - mkfs / mkfs.* (filesystem creation)
 *   - :> /etc... (truncate a critical rooted path)
 *   - shutdown / reboot / poweroff / halt as a command (find via /yolo status)
 *   - git force-push that rewrites main/master: plain --force / -f (last flag
 *     wins over --force-with-lease), +refspec, --all + force, --mirror, any
 *     remote name.  --force-with-lease (effective last) to main is SAFE.
 *
 * ── Verification ─────────────────────────────────────────────────────
 * The logic is mirrored byte-for-byte in
 *   ~/.pi/tests/permission-gate-patterns.test.mjs  (run: node tests/permission-gate-patterns.test.mjs)
 * Keep the eval mirror in sync when changing any regex/predicate here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifySystem } from "../lib/system-notification.ts";

// Recursive `rm` whose recursive flag may sit anywhere among its flags:
// `-rf`, `-fr`, `-Rf`, `-r -f`, `-f -r`, `--recursive`.  Reordered or separated
// flags used to walk straight past every floor below, so the flag runs on both
// sides are part of the pattern instead of assuming the recursive flag leads.
const RM_FLAGS = String.raw`(?:-\S+\s+)*(?:-[a-z]*r[a-z]*|--recursive)(?:\s+-\S+)*`;

// ── Safety floor: ALWAYS blocked, even in YOLO mode ──────────────────
const hardDenyPatterns: RegExp[] = [
  new RegExp(String.raw`\bsudo\b.*\brm\s+(?:-[a-z]*r[a-z]*|--recursive)`, "i"), // sudo rm -rf <anything>
  // rm -rf on the root or root-equivalent path: bare `/`, `//`, `/.`, `/./`,
  // `/..`, `/../`, and quoted `"/"`.  A descendant like `/tmp/junk` is NOT
  // root and safe.
  new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+["']?\/+\.{0,2}\/?(?:\s|$|["';|&])`, "i"),
  // Path-traversal root equivalence: `rm -rf /a/..` and `rm -rf /a/b/..`
  // resolve upward to `/` (or a single top-level dir) - a machine wipe.
  // Conservative documented rule: hard-deny a trailing `..` on an absolute
  // path of 1-2 segments.  Deeper `..` (e.g. `/a/b/c/..` -> `/a/b`) stays
  // gate-level only, it is not root-equivalent.
  new RegExp(
    String.raw`\brm\s+${RM_FLAGS}\s+["']?\/[^\/\s"';|&]+\/(?:[^\/\s"';|&]*\/)?\.\.(?:\s|$|["';|&])`,
    "i",
  ),
  new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+\.?\s*\*`, "i"), // rm -rf * (worktree wipe)
  // Root glob: `rm -rf /*` expands to every top-level directory.  The worktree
  // wipe pattern above cannot see it because `*` is not adjacent to whitespace.
  new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+\/+\*`, "i"),
  /\bdd\s+if=.*\sof=\s*\/dev\/(zero|xv?a?d[a-z]|sd[a-z]|rdisk)/i,
  /\bmkfs(\.|\s)/i,
  // Truncate /etc (or other absolute-rooted critical path) with :>
  /:\s*>\s*\/etc(\s|$)/i,
  // shutdown/reboot/poweroff/halt as a COMMAND (start of line, after ; && |,
  // or after `sudo`) — anchored so words merely CONTAINING these (e.g.
  // `cat shutdown.log`, `npm run shutdown-script`) are not hard-denied.
  /(^|[;|&]\s*|sudo\s+)\b(shutdown|reboot|poweroff|halt)\b(\s|$)/i,
];

// Force-push to main/master is a hard deny.  Implemented as a token-scanning
// predicate, not a single regex, because force semantics depend on flag ORDER:
//   git applies the LAST force-family flag.  `--force-with-lease` is the SAFE
//   force push (lease-protected); `--force` / `-f` is unconditional force.
//   A leading `+` refspec (`+main`) is unconditional force by definition.
//   `--mirror` is force-by-definition; `--all` + plain force pushes every
//   branch including main.

/**
 * Does the command force-push (rewrite) a branch named main/master?
 *
 * Splits the push args into tokens and applies git's ordering semantics:
 *   git push --force-with-lease main -f   -> -f is LAST -> plain force
 *   git push main -f --force-with-lease   -> lease is LAST -> SAFE (lease)
 *   git push origin +main                 -> unconditional force refspec
 *   git push --all -f origin              -> every branch incl. main
 *   git push --mirror origin              -> force-by-definition
 *   git push -f fork main                 -> any remote name
 *   git push -f main                      -> no remote at all (err safe)
 *
 * Any non-flag token whose final segment is main/master is treated as
 * main-targeting (conservative): `main`, `HEAD:master`, `refs/heads/main`,
 * `feature/main` (final segment `main`) are all main-like.
 */
function isGitForcePushToMain(cmd: string): boolean {
  // Only commands that are actually `git push` belong here.  Without this
  // guard, a non-push command like `git fetch origin +main` would leave
  // afterPush = the whole input (String.replace returns the input unchanged
  // when the marker is absent), and the `+main` token would be misclassified
  // as an unconditional force-push-to-main.  A fetch is harmless.
  if (!/\bgit\s+push\b/i.test(cmd)) return false;
  const afterPush = cmd.replace(/^.*?\bgit\s+push\b/i, "");
  const tokens = afterPush.trim().split(/[\s;|&]+/).filter(Boolean);

  // The LAST force-family flag decides plain-vs-lease force.
  let lastForce: "plain" | "lease" | "none" = "none";
  for (const tok of tokens) {
    if (tok === "--force" || tok === "-f") lastForce = "plain";
    else if (tok === "--force-with-lease") lastForce = "lease";
  }

  // `--mirror` rewrites every ref (main included) with force semantics.
  if (tokens.includes("--mirror")) return true;
  // `--all` with an effective plain force rewrites every branch incl. main.
  if (lastForce === "plain" && tokens.includes("--all")) return true;

  const mainLike = (t: string): boolean => {
    const bare = t.replace(/^\+/, "").split(/[:/]/).pop()!;
    return /^(master|main)$/i.test(bare);
  };

  for (const tok of tokens) {
    if (tok.startsWith("--")) continue; // other long flags
    if (/^(-u|-v|--verbose|--porcelain|--set-upstream)$/i.test(tok)) continue;
    if (!mainLike(tok)) continue;
    // This token targets main/master:
    if (tok.startsWith("+")) return true; // +refspec: unconditional force
    if (lastForce === "plain") return true;
    // lastForce === "lease": lease-protected push to main — SAFE, keep
    // scanning in case a later token is a plain-force target.
  }
  return false;
}

function isHardDeny(cmd: string): boolean {
  return hardDenyPatterns.some((p) => p.test(cmd)) || isGitForcePushToMain(cmd);
}

// Patterns that REQUIRE confirmation
const dangerousPatterns: RegExp[] = [
  // ── File-system destruction ──────────────────────────────────────
  new RegExp(String.raw`\brm\s+(?:-[a-z]*r[a-z]*|--recursive)`, "i"),
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /:+\s*>\s*\S/,               // truncate redirection
  /\bfind\b.*\s-(exec|delete)\b/i,

  // ── Privilege escalation / permission changes ───────────────────
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,

  // ── npm / npx global destructive ─────────────────────────────────
  /\bnpx\s+skills.*\bremove\b.*(--all|'\*')/i,
  /\bnpm\s+(uninstall|remove|rm)\b.*-g/i,
  /\bnpx\s+.*\b(uninstall|remove)\b.*--all/i,

  // ── Git destructive operations ───────────────────────────────────
  // --force-with-lease is the SAFE force push - do not gate it
  /\bgit\s+push\b.*(--force(?!-with-lease)|-f)\b/i,
  // Leading `+` refspec (git push origin +main) is an unconditional force
  // push — gate it for confirmation like other force pushes.
  /\bgit\s+push\b[^\n]*\s\+[^\s]+/i,
  /\bgit\s+reset\b.*--hard/i,
  /\bgit\s+clean\b.*-f/i,
  /\bgit\s+branch\b.*-D\b/i,

  // ── Shell redirect overwrite ─────────────────────────────────────
  // Excludes /dev/null (harmless stderr suppression)
  />\s*\/(dev(?!\/null\b)|etc|proc|sys)/i,

  // ── System shutdown / halt (also hard-deny floor item) ────────────
  /\b(shutdown|reboot|halt|poweroff)(\s|\n|$)/i,
];

interface AllowlistEntry {
  command: string;
  timestamp: string;
}

// Session-scoped YOLO state: armed cwd (empty = not armed).
let yoloCwd: string | undefined;

// YOLO from settings.json ("permission-gate": { "yolo": true }).  undefined
// means "not read yet"; read lazily on the first tool call and cached for the
// session, so an edited settings.json applies from the next session on.
let settingsYolo: boolean | undefined;

function agentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}
function allowlistPath(): string {
  return path.join(agentDir(), "permission-gate-allowlist.json");
}

function loadAllowlist(): AllowlistEntry[] {
  try {
    const raw = fs.readFileSync(allowlistPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveAllowlist(entries: AllowlistEntry[]): void {
  fs.writeFileSync(allowlistPath(), JSON.stringify(entries, null, 2) + "\n");
}
function isAllowed(entries: AllowlistEntry[], cmd: string): boolean {
  return entries.some((e) => e.command === cmd);
}

/** `permission-gate.yolo` from ~/.pi/agent/settings.json; off by default. */
function readSettingsYolo(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf-8"));
    return raw?.["permission-gate"]?.yolo === true;
  } catch {
    return false;
  }
}

/** Squash whitespace/newlines and cap length for a notification banner. */
function oneLine(cmd: string, max = 160): string {
  const flat = cmd.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Is YOLO armed and does it cover this tool call's cwd? */
function yoloActive(ctxCwd: string): boolean {
  settingsYolo ??= readSettingsYolo();
  if (settingsYolo) return true; // settings switch is machine-wide, not cwd-scoped
  if (!yoloCwd) return false;
  // Armed cwd is a prefix of the call cwd (same dir or a subdir).
  return ctxCwd === yoloCwd || ctxCwd.startsWith(yoloCwd.replace(/\/+$/, "") + "/");
}

// Footer switch.  "agent-yolo" sorts just before "auto-agent-loop", which is
// the order we want on the single status line.
const STATUS_KEY = "agent-yolo";

function showStatus(ctx: {
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void; theme?: { fg(color: string, text: string): string } };
}): void {
  if (!ctx.hasUI) return;
  settingsYolo ??= readSettingsYolo();
  const on = settingsYolo || yoloCwd !== undefined;
  const text = "yolo: on";
  ctx.ui.setStatus(STATUS_KEY, on ? (ctx.ui.theme ? ctx.ui.theme.fg("warning", text) : text) : undefined);
}

export default function (pi: ExtensionAPI) {
  // The settings switch applies from the first tool call, so the footer must
  // show it from the start rather than waiting for the first /yolo.
  pi.on("session_start", (_event, ctx) => {
    showStatus(ctx);
  });

  // ── Slash command: arm / inspect YOLO before leaving ─────────────
  pi.registerCommand("yolo", {
    description:
      "YOLO - this session: auto-approve dangerous commands (hard-deny still enforced). Usage: /yolo [off|status]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "off") {
        yoloCwd = undefined;
        settingsYolo = false; // session-only override of permission-gate.yolo
        showStatus(ctx);
        ctx.ui.notify("YOLO off - permission gate re-armed", "info");
        return;
      }
      if (arg === "status") {
        settingsYolo ??= readSettingsYolo();
        ctx.ui.notify(
          settingsYolo
            ? "YOLO active (settings.json permission-gate.yolo)"
            : yoloCwd
              ? `YOLO active (armed in ${yoloCwd})`
              : "YOLO inactive",
          "info"
        );
        return;
      }
      if (arg !== "" && arg !== "on") {
        ctx.ui.notify("Usage: /yolo [on|off|status]", "warning");
        return;
      }
      yoloCwd = ctx.cwd;
      showStatus(ctx);
      ctx.ui.notify(
        `YOLO armed for this session (cwd: ${ctx.cwd}). Dangerous commands auto-approve; hard-deny still enforced.`,
        "info"
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // ── Hard-deny safety floor: ALWAYS enforced, before anything else ──
    // Runs first and unconditionally so the floor cannot be bypassed by the
    // allowlist, YOLO, or a dangerous-pattern miss (e.g. `rm -rf //` and
    // `git push --mirror origin` are floor-denied even though the base `rm`
    // / `git push` confirmation patterns cover them loosely).
    if (isHardDeny(command)) {
      return {
        block: true,
        reason:
          "Command matches hard-deny safety floor (always blocked): " + command,
      };
    }

    const isDangerous = dangerousPatterns.some((p) => p.test(command));
    if (!isDangerous) return undefined;

    // ── YOLO mode: auto-approve unless the hard-deny floor trips ───
    if (yoloActive(ctx.cwd)) {
      return undefined; // auto-approve
    }

    // Check persistent allowlist first
    const allowlist = loadAllowlist();
    if (isAllowed(allowlist, command)) return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          "Dangerous command blocked (no UI for confirmation). " +
          "Run interactively, add to the allowlist, or arm /yolo before starting.",
      };
    }

    // Alert the user a live approval is pending (macOS banner, etc.).  Only a
    // real terminal session gets a banner: RPC shows the prompt through the
    // client's own UI and tests stub the dialog, so a host-side banner there is
    // noise.  The delivery is awaited so the banner cannot land after the prompt
    // is gone (a fire-and-forget call races process teardown and falls back to
    // the OS).
    if (ctx.mode === "tui") {
      await notifySystem("Pi: approval needed", oneLine(command), { sound: "Glass" });
    }

    const choice = await ctx.ui.select(
      `⚠️  Dangerous command detected:\n\n  ${command}\n\nAllow this command?`,
      [
        "Yes — allow once",
        "Yes — allow always",
        "YOLO - this session",
        "No — block it",
      ]
    );

    if (choice === "Yes — allow always") {
      allowlist.push({ command, timestamp: new Date().toISOString() });
      saveAllowlist(allowlist);
      return undefined;
    }

    if (choice === "YOLO - this session") {
      yoloCwd = ctx.cwd;
      showStatus(ctx);
      ctx.ui.notify(
        `YOLO armed for this session (cwd: ${ctx.cwd}). Dangerous commands auto-approve; hard-deny still enforced.`,
        "info"
      );
      return undefined;
    }

    if (!choice?.startsWith("Yes")) {
      return { block: true, reason: "Blocked by user via permission-gate" };
    }

    return undefined;
  });
}
