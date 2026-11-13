/**
 * Pi Session Budget Extension
 *
 * Hard session cost cap driven by pi settings files (no CLI flags), read from
 * the `sessionBudget` key:
 *   - Global:  ~/.pi/agent/settings.json
 *   - Project: <cwd>/.pi/settings.json (overrides global; requires project trust)
 *
 *   "sessionBudget": { "maxCostUsd": 5, "mode": "enforce" }   // mode: "enforce" | "off"
 *
 * Cost accounting mirrors pi core's footer/session totals
 * (see dist/core/usage-totals.js getUsageCostBreakdown):
 *   - assistant messages            -> usage.cost.total
 *   - toolResult messages           -> usage.cost.total (subagent/nested LLM spend)
 *   - compaction / branch summaries -> usage.cost.total
 *   - type "usage" entries          -> usage.cost.total
 *
 * COVERAGE: the resulting figure is main agent + sync subagent + async subagent +
 * fork subagent (plus compaction / branch summaries). pi's own statusline /
 * `/session` / `get_session_stats` cover only main + sync subagent, so this
 * extension is a strict superset of them.
 *
 * Two deliberate departures from that helper, both required for the cap to bind:
 *
 *  1. Iterate getEntries(), not getBranch(). pi core's footer and
 *     getSessionStats() aggregate over every entry so the figure is "what was
 *     actually billed across the session". getBranch() walks only the current
 *     path, so after a /tree jump or branch navigation it silently omits
 *     abandoned history and disagrees with the footer.
 *  2. Add subagent spend that never reaches this session file. Async subagents
 *     are the default; their completion arrives as a `subagent-notify` custom
 *     message with no usage, so the cost only ever exists in the child session
 *     file on disk. A sync (usage-bearing) toolResult already carries the same
 *     child cost, so those runs are deduped by run id to avoid double counting.
 *  3. Add fork subagent spend. A fork is created by branching the parent
 *     session, so its file starts as a copy of the parent's history: charging
 *     the whole file would double count everything already in W. Only entries
 *     that are not present in the direct parent snapshot are charged, keyed on
 *     entry id with a billing fingerprint that makes an in-place rewrite of
 *     inherited billing data an error rather than a silent re-charge.
 *
 * ASYNC SUBAGENT ALGORITHM (the child-file scan):
 *   W = sum of usage.cost.total over every entry of THIS session, whether or not
 *       it is on the current branch. Assistants, toolResults, "usage" entries,
 *       compaction/branch summaries. This equals the statusline figure and
 *       already contains the cost of any sync dispatch.
 *   A = run ids this session already accounted for. A usage-bearing toolResult
 *       names them: `details.runId` and `details.asyncId` are the child run
 *       directory name, and `results[].sessionFile` / `completions[].results[]
 *       .sessionFile` resolve to the same run directory (parent directory).
 *   C = child cost of those accounted runs, computed from their own session
 *       files. By construction C equals the sync usage already inside W, which
 *       is asserted at runtime rather than trusted (see INTEGRITY below).
 *   U = child cost of every other session file recursively under a run directory
 *       beside this session's JSONL, i.e. runs whose cost never reached this
 *       session file (async/detached). Pi's timestamp-named sessions under
 *       `async-<id>/run-N/` are included; `forks/` is handled by F below.
 *   F = fork increment. For each `forks/*.jsonl`: charge only entries whose id
 *       is absent from the direct parent snapshot, i.e. work the fork added
 *       after branching. Inherited entries are verified fingerprint-identical
 *       and skipped. Recurses into a child's own `forks/` and `run-N/`, so a
 *       fork nested under an ordinary child is still counted once.
 *   cost = W + U + F        (no double counting: C is inside W, not inside U)
 *
 * DEPENDENCY: this extension imports no pi-subagents modules or config. Aggregate
 * child accounting recognizes the package's on-disk session layout, tool-result
 * fields and fork parentSession lineage; layout drift sends the session to the
 * compatibility bypass (COMPATIBILITY GATE below) instead of blocking it. Its
 * event-bus RPC is an additional, best-effort stop integration: it is attempted
 * when available and never delays parent abort.
 *
 * DEPENDENCY VERSION: the layout read above is a contract with one pi-subagents
 * release, pinned in SUBAGENTS_EXPECTED_VERSION below. A shared extension cannot
 * assume any particular release is installed, and a newer release is NOT evidence
 * that the layout moved - most upgrades are compatible - so the version alone never
 * warns (that would train operators to ignore it). What is reported is EVIDENCE:
 * data the scan can read but cannot attribute to that layout (a billed child ledger
 * whose header moved, an unreadable line in one). The report names both versions and
 * the broken file, and states the choice: sync pi-subagents back to a supported
 * release, or keep the upgrade and accept that subagent spend is no longer complete.
 * Teaching the extension the new layout is deliberate work with its own runbook -
 * "Troubleshooting" in README.md - so the report points there instead of guessing.
 * Accounting always proceeds unchanged: this extension must never refuse to work, or
 * abort a turn, because a user is on a different pi-subagents. An absent package is
 * not evidence - it cannot have written any child session.
 *
 * COMPATIBILITY GATE (the shape of every dependency risk): the child/fork scan is
 * the happy path. It is written against one pi-subagents layout, and it either reads
 * that layout completely or it is abandoned as a whole.
 *   - Happy path: the scan reads every child and fork ledger. Its strict checks (a
 *     billed fork entry with no id, two entries sharing an id, an inherited entry
 *     whose billing data was rewritten, a `parentSession` that is not the
 *     directory's parent, a sync result whose reported usage disagrees, an
 *     unparseable fork file) are how "this data does not match the layout" is
 *     detected; they never charge a figure that is known to be wrong, and failing
 *     one moves the session to bypass instead of aborting it.
 *   - Bypass: the first evidence that the layout is not the verified one - data the
 *     scan cannot attribute (a billed ledger without a session header, an unreadable
 *     line) or a scan that throws - abandons the whole child/fork figure for the rest
 *     of the session. Main-agent spend is still counted from pi core's own entries,
 *     the figure is labelled "subagent excluded", and the operator gets one warning
 *     with the two ways out: sync pi-subagents to a supported release, or accept that
 *     subagent spend is not counted. Teaching this extension the new layout is a
 *     deliberate act with a runbook (DEPENDENCY VERSION, README Troubleshooting).
 *   The partial total is discarded on purpose: an incomplete subagent figure invites
 *   the operator to trust a cap that silently does not hold. A torn final line from a
 *   concurrent append is NOT evidence - it is skipped and seen whole next check.
 *
 * DEGRADE (child ledgers): a file under a run directory is not automatically a
 * ledger. pi-subagents writes `subagent-artifacts/*_transcript.jsonl` beside the
 * child session file; those are message records (no `type: "session"` header)
 * that replay messages the child's own session file already bills. Treating one
 * as a ledger aborted a whole turn over a file that proves nothing. So a file
 * whose first line is not a session header is skipped, where a torn header waits
 * for the next scan.
 *
 * INTEGRITY (runtime self-check): C is recomputed every refresh and compared to
 * the sync usage already inside W. They are the same money by construction, so a
 * divergence beyond float noise means the layout or tool-result shape drifted -
 * the one case that could double count. A warning is logged once; the figure is
 * still reported rather than silently changed, so the operator can see it.
 *
 * PERFORMANCE (the scan must stay off the hot path): validation is wall-clock
 * cheap and happens only when it can change a decision.
 *   - When: turn_start / turn_end / session_start / `/budget` always validate.
 *     `tool_result` (the per-tool path) validates only if the known total is
 *     already within CHILD_REFRESH_NEAR_CAP_FRACTION of the cap AND at most once
 *     per CHILD_REFRESH_MIN_INTERVAL_MS. So an idle, far-from-cap, or
 *     many-tool-call turn does no disk work on the hot path.
 *   - What: two directory listings per run-N directory; one stat per known
 *     child file; and bytes read only for files that actually grew.
 *   - Child trees are re-listed at turn boundaries so async nesting levels and
 *     timestamp-named Pi session files are discovered; unchanged files reuse
 *     cached parsed costs.
 *   - A grown child file is parsed incrementally: only the bytes past the
 *     accounted cursor are read, and a prefix fingerprint proves they were
 *     appended rather than rewritten in place (rewrite/truncation falls back to
 *     a full re-parse). Child session files are append-only in practice.
 *   - Child directory listing cost grows with nested session files; parsing stays
 *     incremental for unchanged/growing files.
 * Cost is recomputed on every check, so raising the cap can never strand
 * history: it can only ever make the figure larger and more accurate.
 *
 * mode "enforce": when session cost >= maxCostUsd, the current run is
 *   aborted (turn_start also blocks already-over sessions, so queued
 *   messages cannot spend past the cap). Raise the cap via config file or
 *   /budget <usd> to continue.
 * Only a main session enforces its aggregate cap; child sessions identified by
 * their parentSession header never enforce a separate cap over inherited history.
 * `/budget off` and `/budget <usd>` are in-memory overrides for the current run;
 * a new or resumed session starts from settings again. If the optional
 * pi-subagents stop RPC is available, it is attempted on cap/fail-closed events;
 * missing RPC support never delays parent abort.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";

const STATUS_KEY = "session-budget";
const SETTINGS_KEY = "sessionBudget";
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

interface BudgetConfig {
	maxCostUsd: number;
	mode: "enforce" | "off";
}

interface UsageLike {
	cost?: { total?: number } | number;
	role?: string;
}

function costOf(usage: UsageLike | undefined | null): number {
	const cost = usage?.cost;
	if (typeof cost === "number") return Number.isFinite(cost) ? cost : 0;
	const total = cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function usageCost(usage: UsageLike | undefined | null): number {
	return costOf(usage);
}

/**
 * Subagent runs that already contributed usage to this session file.
 * A sync dispatch returns a toolResult carrying the children's aggregated usage
 * and `details.runId`/`details.asyncId` equal to the child's run directory name;
 * `results[].sessionFile` points at the child session file somewhere below
 * `<sessionDir>/<runDir>`; Pi may use timestamped filenames under `run-N/`.
 */
function accountedRunIds(entries: readonly unknown[], sessionFile?: string): Set<string> {
	const names = new Set<string>();
	for (const entry of entries) {
		const e = entry as { type?: string; message?: { role?: string; usage?: UsageLike; details?: unknown } };
		if (e.type !== "message" || e.message?.role !== "toolResult" || !e.message.usage) continue;
		const details = e.message.details as Record<string, unknown> | undefined;
		if (!details || typeof details !== "object") continue;
		for (const key of ["runId", "asyncId"]) {
			const value = details[key];
			if (typeof value === "string" && value.length > 0) names.add(value);
		}
		const files: unknown[] = [];
		for (const result of (details.results as unknown[] | undefined) ?? []) {
			files.push((result as { sessionFile?: unknown } | undefined)?.sessionFile);
		}
		for (const completion of (details.completions as unknown[] | undefined) ?? []) {
			for (const result of ((completion as { results?: unknown[] } | undefined)?.results) ?? []) {
				files.push((result as { sessionFile?: unknown } | undefined)?.sessionFile);
			}
		}
		for (const file of files) {
			if (typeof file !== "string" || file.length === 0) continue;
			const runDir = sessionFile
				? relative(resolve(sessionFile.replace(/\.jsonl$/, "")), resolve(file)).split(/[\\/]/)[0]
				: file.split(/[\\/]/).slice(-3, -2)[0];
			if (runDir && runDir !== ".." && runDir !== "forks") names.add(runDir);
		}
	}
	return names;
}

/** Cost of complete `assistant` lines in a JSONL buffer (assistant usage only). */
function costOfAssistantLines(raw: string): number {
	let total = 0;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let entry: { type?: string; message?: { role?: string; usage?: UsageLike } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message?.role === "assistant") {
			total += usageCost(entry.message.usage);
		}
	}
	return total;
}

/** Bytes of prefix re-checked to distinguish an append from an in-place rewrite. */
const APPEND_OVERLAP_BYTES = 64;

/** FNV-1a over a byte range; used only as an append/rewrite discriminator. */
function hashBytes(buf: Buffer): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < buf.length; i++) {
		h ^= buf[i] as number;
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Fold newly appended lines into a cached child cost. `buf` starts at absolute
 * offset `start`; `consumed` is the absolute offset already accounted for.
 * Returns the updated cursor, cost and prefix fingerprint, or undefined when no
 * complete new line exists yet (the partial tail is left for the next pass).
 */
function foldAppendedLines(
	buf: Buffer,
	start: number,
	consumed: number,
	previousCost: number,
): { cost: number; consumed: number; prefixHash: number } | undefined {
	const tailStart = consumed - start;
	if (tailStart >= buf.length) return undefined;
	const tail = buf.subarray(tailStart);
	const lastNewline = tail.lastIndexOf(0x0a);
	if (lastNewline < 0) return undefined;
	const newConsumed = consumed + lastNewline + 1;
	const end = newConsumed - start;
	return {
		cost: previousCost + costOfAssistantLines(tail.subarray(0, lastNewline + 1).toString("utf8")),
		consumed: newConsumed,
		prefixHash: hashBytes(buf.subarray(Math.max(0, end - APPEND_OVERLAP_BYTES), end)),
	};
}

/** Read bytes [start, end) of a file, or undefined when unreadable. */
function readRange(path: string, start: number, end: number): Buffer | undefined {
	const length = end - start;
	if (length <= 0) return Buffer.alloc(0);
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, start);
		return buffer.subarray(0, read);
	} catch {
		return undefined;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// Closing must never mask the accounting result.
		}
	}
}

function readdirIfDirectory(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry: Dirent) => entry.isDirectory())
			.map((entry: Dirent) => entry.name);
	} catch {
		return [];
	}
}

function statIfFile(path: string): Stats | undefined {
	try {
		const info = statSync(path);
		return info.isFile() ? info : undefined;
	} catch {
		return undefined;
	}
}

function statIfDirectory(path: string): Stats | undefined {
	try {
		const info = statSync(path);
		return info.isDirectory() ? info : undefined;
	} catch {
		return undefined;
	}
}

function readFileSyncSafe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

interface ChildFileCacheEntry {
	mtimeMs: number;
	size: number;
	cost: number;
	/** Byte offset up to the last complete line folded into `cost`. */
	consumed: number;
	/**
	 * Fingerprint of the bytes immediately before `consumed`. On growth it is
	 * re-checked against the file: an unchanged prefix proves the file was
	 * appended to, while a changed one means it was rewritten (even if it also
	 * grew), which the offset cursor alone cannot distinguish. See PERFORMANCE.
	 */
	prefixHash: number;
}

interface ChildScanEntry {
	cost: number;
	files: Map<string, ChildFileCacheEntry>;
	/** Run-dir mtime; changes only when a run-N subdirectory is added or removed. */
	dirMtimeMs: number;
}

/**
 * Cached view of child-session spend. Keyed by absolute run directory, so both
 * the accounted (C) and unaccounted (U) halves read from one cache and only
 * re-parse a child file when its size or mtime changed.
 */
const childScanCache = new Map<string, ChildScanEntry>();

/** CHILD_REFRESH_* bound how often validation runs; see PERFORMANCE above. */
const CHILD_REFRESH_MIN_INTERVAL_MS = 2000;
const CHILD_REFRESH_NEAR_CAP_FRACTION = 0.9;

/** True when the cache entry is structurally intact; garbage forces a reparse. */
function cacheEntryValid(entry: ChildScanEntry | undefined): entry is ChildScanEntry {
	return (
		entry !== undefined &&
		typeof entry.cost === "number" &&
		Number.isFinite(entry.cost) &&
		entry.files instanceof Map
	);
}

/**
 * Re-stat one known child file. Unchanged files reuse their cached cost; grown
 * files parse only the appended bytes (append-only session files); a shrunken or
 * rewritten file falls back to a full re-parse. Returns undefined when the file
 * has vanished.
 */
function revalidateChildFile(file: string, cached: ChildFileCacheEntry, info: Stats): ChildFileCacheEntry | undefined {
	if (cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;

	// Growth with an intact prefix is an append: read only the overlap plus the new
	// bytes. Any other change (truncation, in-place rewrite, first sight) re-reads.
	if (info.size > cached.consumed) {
		const start = Math.max(0, cached.consumed - APPEND_OVERLAP_BYTES);
		const buf = readRange(file, start, info.size);
		if (buf !== undefined) {
			const overlap = cached.consumed - start;
			const prefixIntact = overlap === 0 || hashBytes(buf.subarray(0, overlap)) === cached.prefixHash;
			if (prefixIntact) {
				const folded = foldAppendedLines(buf, start, cached.consumed, cached.cost);
				// No complete line yet: refresh metadata but keep the cursor and cost.
				if (!folded) return { ...cached, mtimeMs: info.mtimeMs, size: info.size };
				return { mtimeMs: info.mtimeMs, size: info.size, ...folded };
			}
		}
	}

	// Full re-parse, restarting the cursor and fingerprint.
	const raw = readFileSyncSafe(file);
	if (raw === undefined) return undefined;
	const buf = Buffer.from(raw, "utf8");
	return {
		mtimeMs: info.mtimeMs,
		size: info.size,
		cost: costOfAssistantLines(raw),
		consumed: info.size,
		prefixHash: hashBytes(buf.subarray(Math.max(0, buf.length - APPEND_OVERLAP_BYTES))),
	};
}

/** Re-stat known child files, re-parsing only what actually changed. */
function revalidateChildFiles(files: Map<string, ChildFileCacheEntry>): { cost: number; files: Map<string, ChildFileCacheEntry> } {
	const next = new Map<string, ChildFileCacheEntry>();
	let total = 0;
	for (const [file, cached] of files) {
		const info = statIfFile(file);
		if (!info) continue; // child file pruned
		const updated = revalidateChildFile(file, cached, info) ?? cached;
		next.set(file, updated);
		total += updated.cost;
	}
	return { cost: total, files: next };
}

/**
 * Sum one child run directory. The expensive part is discovering `run-N`
 * subdirectories, so the directory listing is re-read only when the run dir's own
 * mtime moved - a child writing into an existing `run-N` changes that subdir's
 * mtime, not this one. Everything else is a stat. See PERFORMANCE above.
 */
function childSessionFiles(runDir: string, maxDepth = 8): string[] {
	const files: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > 8) throw new Error(`Subagent session nesting exceeds the scan depth at '${dir}'`);
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "forks") continue;
			const file = join(dir, entry.name);
			if (entry.isDirectory() && depth < maxDepth) visit(file, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
		}
	};
	visit(runDir, 0);
	return files;
}

function scanRunDir(runDir: string, previous: ChildScanEntry | undefined): ChildScanEntry {
	const dirInfo = statIfDirectory(runDir);
	if (!dirInfo) return { cost: 0, files: new Map(), dirMtimeMs: 0 };
	const previousFiles = cacheEntryValid(previous) ? previous.files : undefined;
	const keep = new Map<string, ChildFileCacheEntry>();
	for (const file of childSessionFiles(runDir)) {
		const cached = previousFiles?.get(file);
		if (cached) keep.set(file, cached);
		else keep.set(file, { mtimeMs: 0, size: -1, cost: 0, consumed: 0, prefixHash: 0 });
	}
	const { cost, files } = revalidateChildFiles(keep);
	return { cost, files, dirMtimeMs: dirInfo.mtimeMs };
}

/**
 * Revalidate the cache against disk. Returns the raw scan totals plus the
 * per-run costs, which the caller splits by accounted/unaccounted run id.
 */
function runChildScan(sessionFile: string | undefined): Map<string, number> {
	const runDirCosts = new Map<string, number>();
	if (!sessionFile) return runDirCosts;
	const sessionDir = sessionFile.replace(/\.jsonl$/, "");
	const live = new Set<string>();
	for (const name of readdirIfDirectory(sessionDir)) {
		const dir = join(sessionDir, name);
		live.add(dir);
		const entry = scanRunDir(dir, childScanCache.get(dir));
		childScanCache.set(dir, entry);
		runDirCosts.set(name, entry.cost);
	}
	// Drop cache rows for run dirs that no longer exist, so a pruned or deleted
	// child cannot keep contributing cost for the rest of the session.
	for (const dir of childScanCache.keys()) {
		if (!live.has(dir)) childScanCache.delete(dir);
	}
	return runDirCosts;
}

function sessionEntryCost(value: unknown): number {
	const entry = value as { type?: string; message?: { role?: string; usage?: UsageLike }; usage?: UsageLike };
	if (entry.type === "message" && entry.message && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
		return usageCost(entry.message.usage);
	}
	if (entry.type === "usage" || ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)) {
		return usageCost(entry.usage);
	}
	return 0;
}

function entryLineageKey(value: unknown): string | undefined {
	const entry = value as { id?: unknown };
	return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
}

function indexLineageEntries(entries: readonly unknown[], source: string): Map<string, string> {
	const byId = new Map<string, string>();
	for (const entry of entries) {
		const cost = sessionEntryCost(entry);
		const id = entryLineageKey(entry);
		if (!id) {
			if (cost > 0) throw new Error(`Billed session entry without an id in '${source}'`);
			continue;
		}
		const fingerprint = entryBillingFingerprint(entry);
		if (byId.has(id)) throw new Error(`Duplicate session entry id '${id}' in '${source}'`);
		byId.set(id, fingerprint);
	}
	return byId;
}

function entryBillingFingerprint(value: unknown): string {
	const entry = value as { type?: string; timestamp?: string; message?: { role?: string; responseId?: string }; usage?: UsageLike };
	return JSON.stringify([
		entry.type,
		entry.timestamp,
		entry.message?.role,
		entry.message?.responseId,
		sessionEntryCost(value),
	]);
}

function readSessionFile(
	file: string,
	options?: { onInvalidLine?: (invalid: { file: string; line: number; reason: string }) => void },
): { header: { type?: string; parentSession?: string }; entries: unknown[] } {
	const raw = readFileSyncSafe(file);
	if (raw === undefined) throw new Error(`Cannot read session '${file}'`);
	const lines = raw.split("\n");
	// A concurrent append can leave the last line torn. It will be seen whole at
	// the next check, so skip that one line instead of failing the whole session.
	const tornTail = !raw.endsWith("\n") && lines.length > 0;
	const lastIndex = lines.length - 1;
	const entries: unknown[] = [];
	let header: { type?: string; parentSession?: string } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (!header) {
				const first = value as { type?: string; parentSession?: string };
				if (first.type !== "session") throw new Error(`the first line is not a session header`);
				header = first;
			} else {
				entries.push(value);
			}
		} catch (error) {
			if (tornTail && i === lastIndex) break;
			const reason = error instanceof Error ? error.message : String(error);
			// A child ledger can only ever undercount when a line is dropped, so a
			// caller that passes `onInvalidLine` degrades instead of aborting. Fork
			// ledgers cannot: skipping a line there re-charges inherited history.
			if (!header || !options?.onInvalidLine) {
				throw new Error(`Invalid JSONL in session '${file}' at line ${i + 1}: ${reason}`, { cause: error });
			}
			options.onInvalidLine({ file, line: i + 1, reason });
		}
	}
	if (!header) throw new Error(`Session '${file}' has no session header`);
	return { header, entries };
}

/**
 * A `.jsonl` file is a ledger only if pi wrote it as one. This decides the two
 * degradations that keep a non-authoritative file from aborting a turn: a file
 * that is not a session ledger is skipped, and a file whose header is still
 * mid-write is left for the next scan. See DEGRADE at the top of this file.
 * Classification is memoized per path (session files are append-only, so it
 * cannot change); a mid-write header is not memoized and is re-sniffed next scan.
 */
const LEDGER_HEADER_SNIFF_BYTES = 8192;
const ledgerClassCache = new Map<string, "session" | "other" | "incomplete">();
const warnedLedgerFiles = new Set<string>();

function jsonlKind(file: string, size: number): "session" | "other" | "incomplete" {
	const cached = ledgerClassCache.get(file);
	if (cached === "session" || cached === "other") return cached;
	const head = readRange(file, 0, Math.min(size, LEDGER_HEADER_SNIFF_BYTES));
	if (head === undefined) return "incomplete";
	const newline = head.indexOf(0x0a);
	if (newline < 0) {
		// A session header is a few hundred bytes; anything longer is not one.
		return size > LEDGER_HEADER_SNIFF_BYTES ? "other" : "incomplete";
	}
	let kind: "session" | "other" = "other";
	try {
		const first = JSON.parse(head.subarray(0, newline).toString("utf8")) as { type?: unknown } | null;
		if (first && typeof first === "object" && first.type === "session") kind = "session";
	} catch {
		kind = "other";
	}
	ledgerClassCache.set(file, kind);
	return kind;
}

/** Log a skipped or degraded ledger file once per session, so a recurring state cannot flood the log. */
function warnLedgerOnce(key: string, message: string): void {
	if (warnedLedgerFiles.has(key)) return;
	warnedLedgerFiles.add(key);
	console.warn(`[session-budget] ${message}`);
}

/**
 * Whether a file's first entries are billed session entries without a session
 * header - i.e. something this accounting should charge but cannot attribute. A
 * pi-subagents transcript is not one of these: its lines are keyed by `recordType`
 * and carry no top-level `type`, so only a real layout change trips this.
 */
function looksLikeLedgerEntries(file: string, size: number): boolean {
	const head = readRange(file, 0, Math.min(size, LEDGER_HEADER_SNIFF_BYTES));
	if (head === undefined) return false;
	const lines = head.toString("utf8").split("\n").slice(0, 5);
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: unknown } | null;
			if (entry && typeof entry === "object" && sessionEntryCost(entry) > 0) return true;
		} catch {
			return false; // A torn line says nothing about the format.
		}
	}
	return false;
}

/**
 * Read a child ledger for the nested-fork scan, degrading instead of aborting:
 * non-session JSONL is skipped (pi-subagents writes `subagent-artifacts/
 * *_transcript.jsonl` in the same run directory; those replay the child's own
 * messages, whose spend the child's session file already carries), and a corrupt
 * interior line is skipped with a warning. Returns undefined when the file holds
 * no ledger this scan can use.
 */
function readChildLedger(file: string): { header: { type?: string; parentSession?: string }; entries: unknown[] } | undefined {
	const info = statIfFile(file);
	if (!info) return undefined;
	const kind = jsonlKind(file, info.size);
	if (kind === "incomplete") return undefined;
	if (kind === "other") {
		warnLedgerOnce(
			file,
			`Skipping '${file}': it is not a session ledger (no \`type: "session\"\` header), so it cannot hold spend this scan should charge. Nested forks under it are not counted.`,
		);
		// A billed entry with no session header is not a transcript: it is a ledger
		// this accounting cannot attribute, i.e. evidence the layout changed.
		if (looksLikeLedgerEntries(file, info.size)) {
			noteCompatAnomaly(`'${file}' holds billed session entries but no \`type: "session"\` header, so it was skipped by the fork scan`);
		}
		return undefined;
	}
	return readSessionFile(file, {
		onInvalidLine: ({ line, reason }) => {
			warnLedgerOnce(
				`${file}:${line}`,
				`Skipping unreadable line ${line} of child ledger '${file}' (${reason}). Spend recorded on that line is not counted; the session total may understate.`,
			);
			noteCompatAnomaly(`line ${line} of child ledger '${file}' is not readable (${reason}), so any spend on it is missing`);
		},
	});
}

function readForkSession(file: string): { parentSession: string; entries: unknown[] } {
	const session = readSessionFile(file);
	if (typeof session.header.parentSession !== "string") {
		throw new Error(`Fork session '${file}' has no parentSession lineage`);
	}
	return { parentSession: session.header.parentSession, entries: session.entries };
}

function sessionDirectories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function validateForkBranch(childFile: string, childEntries: readonly unknown[]): void {
	for (const entry of childEntries) {
		const record = entry as { id?: unknown; parentId?: unknown };
		if (!entryLineageKey(entry)) throw new Error(`Fork session '${childFile}' has an entry without an id`);
		if (record.parentId !== null && (typeof record.parentId !== "string" || record.parentId.length === 0)) {
			throw new Error(`Fork session '${childFile}' has an entry with a malformed parent pointer`);
		}
	}
}

function subagentResults(details: Record<string, unknown>): Array<{ sessionFile?: unknown; usage?: UsageLike }> {
	return [
		...((details.results as Array<{ sessionFile?: unknown; usage?: UsageLike }> | undefined) ?? []),
		...(((details.completions as Array<{ results?: Array<{ sessionFile?: unknown; usage?: UsageLike }> }> | undefined) ?? []).flatMap((completion) => completion.results ?? [])),
	];
}

function isForkSessionPath(file: unknown): file is string {
	return typeof file === "string" && file.split(/[\\/]/).includes("forks");
}

function accountedForkSessionFiles(entries: readonly unknown[]): Map<string, number> {
	const files = new Map<string, number>();
	for (const value of entries) {
		const entry = value as { type?: string; message?: { role?: string; usage?: UsageLike; details?: Record<string, unknown> } };
		if (entry.type !== "message" || entry.message?.role !== "toolResult" || !entry.message.usage) continue;
		for (const result of subagentResults(entry.message.details ?? {})) {
			if (!isForkSessionPath(result.sessionFile)) continue;
			if (result.usage?.cost === undefined) {
				throw new Error(`Missing reported usage for sync fork result '${result.sessionFile}'`);
			}
			const file = resolve(result.sessionFile);
			if (files.has(file)) throw new Error(`Duplicate sync fork result for '${file}'`);
			files.set(file, usageCost(result.usage));
		}
	}
	return files;
}

/** Count only entries added after the direct parent snapshot; a fork is a branch, not a new billing history. */
function scanForkSessions(sessionFile: string | undefined, parentEntries: readonly unknown[], visited = new Set<string>()): number {
	if (!sessionFile) return 0;
	const currentFile = resolve(sessionFile);
	if (visited.has(currentFile)) throw new Error(`Session lineage cycle at '${currentFile}'`);
	visited.add(currentFile);
	const sessionDir = sessionFile.replace(/\.jsonl$/, "");
	const forkDir = join(sessionDir, "forks");
	let names: string[];
	try {
		names = readdirSync(forkDir).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
		else throw error;
	}

	const parentById = indexLineageEntries(parentEntries, sessionFile);
	const accountedFiles = accountedForkSessionFiles(parentEntries);
	const discoveredFiles = new Set(names.map((name) => resolve(forkDir, name)));
	// A fork snapshot inherits the parent's history, including a sync-fork toolResult
	// that names an EARLIER sibling in the parent's forks/ directory. Demanding that
	// path under this child's own forks/ failed closed on an intact ledger, so a
	// not-discovered reference is accepted when the file exists. Such a reference is
	// then trusted on its reported usage (it is charged inside W) rather than
	// cross-checked against the file; a genuinely missing one still aborts.
	for (const file of accountedFiles.keys()) {
		if (!discoveredFiles.has(file) && !existsSync(file)) throw new Error(`Sync result fork session '${file}' is missing`);
	}
	let total = 0;
	for (const name of names) {
		const childFile = resolve(forkDir, name);
		const child = readForkSession(childFile);
		if (resolve(child.parentSession!) !== resolve(sessionFile)) {
			throw new Error(`Fork session '${childFile}' points to unexpected parent '${child.parentSession}'`);
		}
		validateForkBranch(childFile, child.entries);
		const childById = indexLineageEntries(child.entries, childFile);
		let newAssistantCost = 0;
		for (const entry of child.entries) {
			const id = entryLineageKey(entry);
			const cost = sessionEntryCost(entry);
			if (id && parentById.has(id)) {
				if (parentById.get(id) !== childById.get(id)) {
					throw new Error(`Fork lineage entry '${id}' changed billing data in '${childFile}'`);
				}
				continue;
			}
			if ((entry as { type?: string; message?: { role?: string } }).type === "message" && (entry as { message?: { role?: string } }).message?.role === "assistant") {
				newAssistantCost += cost;
				if (accountedFiles.has(childFile)) continue;
			}
			total += cost;
		}
		const reportedForkCost = accountedFiles.get(childFile);
		if (reportedForkCost !== undefined && Math.abs(reportedForkCost - newAssistantCost) > CHILD_INTEGRITY_TOLERANCE_USD) {
			throw new Error(`Fork result usage ${fmtUsd(reportedForkCost)} differs from new assistant usage ${fmtUsd(newAssistantCost)} in '${childFile}'`);
		}

		const accountedRuns = accountedRunIds(child.entries, childFile);
		for (const [runId, cost] of runChildScan(childFile)) {
			if (runId !== "forks" && !accountedRuns.has(runId)) total += cost;
		}
		total += scanForkSessions(childFile, child.entries, visited);
	}

	for (const runId of sessionDirectories(sessionDir)) {
		if (runId === "forks") continue;
		const runDir = join(sessionDir, runId);
		for (const childFile of childSessionFiles(runDir, 2)) {
			const child = readChildLedger(childFile);
			if (!child) continue;
			total += scanForkSessions(childFile, child.entries, visited);
		}
	}
	return total;
}

/**
 * Session cost: every billed entry in this session file, plus subagent spend that
 * only exists in child session files. Matches pi core's getSessionStats() walk
 * (getEntries, not getBranch) so it never understates after /tree navigation.
 * Coverage: main agent + sync subagent + async subagent. See the ASYNC SUBAGENT
 * ALGORITHM / INTEGRITY / PERFORMANCE notes at the top of this file.
 */
function sessionCostUsd(
	ctx: { sessionManager: { getEntries(): unknown[]; getSessionFile?(): string | undefined; getHeader?(): { parentSession?: string } | null } },
	refreshChildren: boolean,
): number {
	const header = ctx.sessionManager.getHeader?.();
	if (typeof header?.parentSession === "string" && header.parentSession.length > 0) return 0;
	const entries = ctx.sessionManager.getEntries();
	let total = 0;
	for (const entry of entries) total += sessionEntryCost(entry);
	if (!refreshChildren) return total + lastChildUnaccounted + lastForkUnaccounted;

	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (compatBypass) {
		lastChildUnaccounted = 0;
		lastForkUnaccounted = 0;
		return total;
	}
	// COMPATIBILITY GATE: the child/fork scan is the happy path. It either reads the
	// installed pi-subagents layout completely, or it is abandoned as a whole. See the
	// COMPATIBILITY GATE note at the top of this file.
	try {
		const accounted = accountedRunIds(entries, sessionFile);
		const runDirCosts = runChildScan(sessionFile);
		let accountedCost = 0;
		let unaccountedCost = 0;
		for (const [name, cost] of runDirCosts) {
			// A fork holds main-agent history that W already counts, so it is never a child run.
			if (name === "forks") continue;
			if (accounted.has(name)) accountedCost += cost;
			else unaccountedCost += cost;
		}
		const forkCost = scanForkSessions(sessionFile, entries);
		// The scans record evidence when they meet data they cannot attribute, and throw
		// when the data contradicts itself. Either way the happy path no longer describes
		// this install, so the partial total is discarded rather than reported: a subagent
		// figure that is silently incomplete invites the operator to trust it.
		if (compatAnomalies.length > 0) {
			enterCompatBypass();
		} else {
			lastChildUnaccounted = unaccountedCost;
			lastForkUnaccounted = forkCost;

			// INTEGRITY: accountedCost and the sync usage inside W are the same money.
			// Divergence means the child layout or the tool-result shape drifted, which is
			// the only way this can double count. Warn once; report the figure unchanged.
			const drift = Math.abs(accountedCost - syncUsageInEntries(entries));
			if (drift > CHILD_INTEGRITY_TOLERANCE_USD && !integrityWarned) {
				integrityWarned = true;
				console.warn(
					`[session-budget] Child accounting integrity: accounted child cost ${fmtUsd(accountedCost)} ` +
						`differs from sync subagent usage in the session (${fmtUsd(syncUsageInEntries(entries))}, drift ${fmtUsd(drift)}). ` +
						"pi-subagents layout or tool-result shape may have changed; treating unaccounted child runs conservatively.",
				);
			}
		}
	} catch (error) {
		enterCompatBypass(error instanceof Error ? error.message : String(error));
	}
	if (compatBypass) {
		lastChildUnaccounted = 0;
		lastForkUnaccounted = 0;
		return total;
	}
	return total + lastChildUnaccounted + lastForkUnaccounted;
}

/**
 * True once the happy path had to be abandoned for this session: the installed
 * pi-subagents layout is not the one this accounting was written for. Sticky for the
 * session - the files on disk do not repair themselves - and reset on session start.
 */
let compatBypass = false;

/** Cost this extension believes it has already taken from the session file. */
let lastChildUnaccounted = 0;
let lastForkUnaccounted = 0;
let lastChildRefreshAt = 0;
let integrityWarned = false;
const CHILD_INTEGRITY_TOLERANCE_USD = 0.01;

/**
 * SYNC FORK RESULT: when a fork was dispatched via the ordinary sync `subagent`
 * tool, its new assistant cost is already inside the toolResult's own usage (W),
 * and the result additionally reports the same amount in `results[].usage`. The
 * scan therefore skips those assistant entries in F and asserts that the amount
 * the result reports matches what the fork file proves, up to this tolerance.
 * A result that reports more than the toolResult charges is an error.
 */

/** Sync subagent usage that lives in this session file, per the child session files. */
function syncUsageInEntries(entries: readonly unknown[]): number {
	let total = 0;
	for (const value of entries) {
		const entry = value as { type?: string; message?: { role?: string; usage?: UsageLike; details?: Record<string, unknown> } };
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		let forkUsage = 0;
		for (const result of subagentResults(entry.message.details ?? {})) {
			if (isForkSessionPath(result.sessionFile)) forkUsage += usageCost(result.usage);
		}
		const usage = usageCost(entry.message.usage);
		if (forkUsage - usage > CHILD_INTEGRITY_TOLERANCE_USD) {
			throw new Error(`Sync fork child usage ${fmtUsd(forkUsage)} exceeds tool-result usage ${fmtUsd(usage)}`);
		}
		total += usage - forkUsage;
	}
	return total;
}

/**
 * The pi-subagents release this accounting was verified against: its run-directory
 * layout, `details.runId` / `details.asyncId` / `results[].sessionFile` fields, its
 * `subagent-artifacts/` side files and fork `parentSession` lineage. Bump only
 * after re-verifying the scan - and its tests - against the new release.
 *
 * 0.81.0 was verified on this machine: run directories are unchanged
 * (`<runId>/run-0/session.jsonl`, `type:"session"` header), `details.runId` is still
 * present, and a completed attached result still carries `results[].sessionFile`.
 * One measured difference: a DETACHED result drops `results[].sessionFile` and
 * carries `transcriptPath` instead - dedup then keys on `details.runId`, which is
 * present, so the child is still charged exactly once (pinned by a test). A pin is
 * the release the scan was PROVEN against, not merely the installed one.
 */
const SUBAGENTS_EXPECTED_VERSION = "0.81.0";

/** The version of the pi-subagents pi actually loads, per its install manifest. */
function installedSubagentsVersion(): string | undefined {
	// pi installs npm packages under <agentDir>/npm (docs/packages.md).
	const manifest = readJsonObjectFile(join(getAgentDir(), "npm", "node_modules", "pi-subagents", "package.json"));
	const version = manifest?.version;
	return typeof version === "string" && version.length > 0 ? version : undefined;
}

/**
 * Evidence that the installed pi-subagents writes something this accounting was
 * not written for: data the scan can read but cannot attribute. A version number
 * alone is not evidence - pi-subagents releases often leave this layout alone, and
 * reporting every bump would train operators to ignore the report - so the report
 * is driven by what the scan actually met, and the versions only explain it.
 */
const compatAnomalies: string[] = [];
let compatReported = false;

/** Record data the scan could not attribute. Idempotent per detail, so re-scans do not inflate it. */
function noteCompatAnomaly(detail: string): void {
	if (compatAnomalies.includes(detail)) return;
	compatAnomalies.push(detail);
}

/**
 * Abandon the happy path for this session. `detail` is recorded when the caller is
 * the one that noticed the incompatibility (a failed scan); when the scans already
 * recorded evidence, the detail is already there.
 */
function enterCompatBypass(detail?: string): void {
	if (detail !== undefined) noteCompatAnomaly(detail);
	if (compatAnomalies.length === 0) noteCompatAnomaly("the child-session scan could not complete");
	compatBypass = true;
}

/**
 * Tell the operator that this accounting no longer matches the installed
 * pi-subagents, and lay out the choice: sync the package back to the verified
 * release, or keep the upgrade and accept missing subagent spend. Fixing the
 * extension itself is a deliberate act - see "Troubleshooting" in README.md, which
 * is the runbook for re-verifying this scan against a new layout. Nothing here
 * changes the figure or stops the run. See DEPENDENCY VERSION.
 */
function reportCompatAnomalies(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): void {
	if (compatReported || compatAnomalies.length === 0) return;
	compatReported = true;
	let installed: string | undefined;
	try {
		installed = installedSubagentsVersion();
	} catch {
		installed = undefined; // A version probe must never affect accounting.
	}
	const verified = SUBAGENTS_EXPECTED_VERSION;
	const versionLine = installed
		? installed === verified
			? `pi-subagents ${installed} is the release this accounting was verified against, so this is a new shape rather than a version drift.`
			: `pi-subagents ${installed} is installed; this accounting was verified against ${verified}.`
		: `pi-subagents is not installed under <agentDir>/npm, so its version could not be read (verified against ${verified}).`;
	const body =
		`Session budget: this accounting is incompatible with the installed pi-subagents. ${versionLine} ` +
		`What the scan met: ${compatAnomalies.map((a) => `\n- ${a}`).join("")}\n` +
		"The session continues and main-agent spend is still counted, but SUBAGENT SPEND IS NOT COUNTED WHILE THIS " +
		"STAYS UNRESOLVED, so the cap no longer covers subagent work. The child-session scan is bypassed for the rest " +
		"of this session. Options:\n" +
		`1. Sync the version: install pi-subagents ${verified} (or whichever release you want supported). ` +
		"This restores complete accounting." +
		"\n2. Ignore this warning: keep the installed release and accept that subagent spend is not counted." +
		"\n3. Update this extension to support the installed release: ask your agent to follow " +
		"`agent/extensions/session-budget/README.md` -> Troubleshooting -> upgrading to a new pi-subagents " +
		"(re-verify the scan, then bump SUBAGENTS_EXPECTED_VERSION and run `node --test tests/`).";
	console.warn(`[session-budget] ${body}`);
	if (ctx.hasUI) {
		const headline = body.split("\n")[0];
		ctx.ui.notify(`${headline}\nSubagent spend is not counted now: sync pi-subagents ${verified}, or ignore at that cost. See the log for the full report.`, "warning");
	}
}

function readJsonObjectFile(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	} catch (err) {
		console.warn(`[session-budget] Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

function validateMode(mode: unknown): mode is BudgetConfig["mode"] {
	return mode === "enforce" || mode === "off";
}

/** Project settings override global. Returns null when inert (off / unset / invalid). */
function loadConfig(cwd: string): BudgetConfig | null {
	const globalSettings = readJsonObjectFile(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonObjectFile(join(cwd, ".pi", "settings.json"));
	const merged: Partial<BudgetConfig> = {
		...(globalSettings?.[SETTINGS_KEY] as Partial<BudgetConfig> | undefined),
		...(projectSettings?.[SETTINGS_KEY] as Partial<BudgetConfig> | undefined),
	};

	if (merged.mode !== undefined && !validateMode(merged.mode)) {
		console.warn(`[session-budget] Invalid mode "${String(merged.mode)}" (expected "enforce" | "off"), staying off`);
		return null;
	}
	if (merged.mode === "off") return null;
	if (merged.maxCostUsd === undefined) return null;
	if (typeof merged.maxCostUsd !== "number" || !Number.isFinite(merged.maxCostUsd) || merged.maxCostUsd <= 0) {
		console.warn(`[session-budget] Invalid maxCostUsd ${String(merged.maxCostUsd)}, staying off`);
		return null;
	}
	return { maxCostUsd: merged.maxCostUsd, mode: "enforce" };
}

function fmtUsd(v: number): string {
	return `$${v.toFixed(2)}`;
}

function isSubagentSession(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): boolean {
	const header = (ctx.sessionManager as typeof ctx.sessionManager & { getHeader?(): { parentSession?: string } | null }).getHeader?.();
	return typeof header?.parentSession === "string" && header.parentSession.length > 0;
}

export default function (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
	let config: BudgetConfig | null = null;
	let sessionOverrideOff = false;
	let overNotified = false;

	/**
	 * Self-check for the pi-subagents dependency: what the scan is verified against,
	 * what is installed, and how it classifies every child `.jsonl` it can see. Read
	 * only - it changes no figure and no state, and it never aborts. This is what the
	 * Troubleshooting runbook in README.md starts from.
	 */
	function doctorReport(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): string {
		let installed: string | undefined;
		try {
			installed = installedSubagentsVersion();
		} catch {
			installed = undefined;
		}
		const verified = SUBAGENTS_EXPECTED_VERSION;
		const lines = [
			"session-budget doctor",
			`verified against pi-subagents ${verified}`,
			`installed pi-subagents ${installed ?? "(unreadable: no package.json under <agentDir>/npm/node_modules/pi-subagents)"}`,
			installed === undefined
				? "version: not comparable (package not installed; no child sessions can exist)"
				: installed === verified
					? "version: matches"
					: "version: differs (a difference alone is not incompatibility; see the ledger classification below)",
			`recorded incompatibility evidence: ${compatAnomalies.length === 0 ? "none" : `${compatAnomalies.length}`}`,
			...compatAnomalies.map((a) => `  - ${a}`),
		];
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (!sessionFile) {
			lines.push("child ledgers: unsaved session, nothing on disk to classify");
			return lines.join("\n");
		}
		const sessionDir = sessionFile.replace(/\.jsonl$/, "");
		const found: string[] = [];
		for (const runId of sessionDirectories(sessionDir)) {
			if (runId === "forks") continue;
			for (const file of childSessionFiles(join(sessionDir, runId), 2)) {
				const info = statIfFile(file);
				const kind = info ? jsonlKind(file, info.size) : "incomplete";
				const verdict =
					kind === "session"
						? "ledger (counted)"
						: kind === "incomplete"
							? "header still being written (retried next scan)"
							: info && looksLikeLedgerEntries(file, info.size)
								? "BILLED ENTRIES WITHOUT A SESSION HEADER - this is incompatibility evidence"
								: "not a ledger (skipped, e.g. a subagent-artifacts transcript)";
				found.push(`  ${verdict}: ${file}`);
			}
		}
		lines.push(`child ledgers under '${sessionDir}':${found.length === 0 ? " none" : ""}`, ...found);
		return lines.join("\n");
	}

	function updateStatus(ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void; theme: { fg(color: string, text: string): string } } }, cost: number): void {
		if (!ctx.hasUI) return;
		if (!config) {
			ctx.ui.setStatus(STATUS_KEY, sessionOverrideOff ? ctx.ui.theme.fg("warning", "Budget off") : undefined);
			return;
		}
		const over = cost >= config.maxCostUsd;
		const color = over || compatBypass ? "error" : cost >= config.maxCostUsd * 0.9 ? "warning" : "muted";
		// The exclusion is part of the figure's meaning, so it stays visible on every
		// render instead of only in the one-time warning. See COMPATIBILITY GATE.
		const scope = compatBypass ? " (subagent excluded)" : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `Budget ${fmtUsd(cost)} / ${fmtUsd(config.maxCostUsd)}${scope}`));
	}

	/**
	 * Whether a tool_result boundary may revalidate child files. Validation is what
	 * keeps the cap honest, but it is also the only part of this extension that
	 * touches disk, so it stays off the per-tool hot path: only when the known
	 * total is close enough to the cap that a late child could change the verdict,
	 * and at most once every CHILD_REFRESH_MIN_INTERVAL_MS. Turn boundaries and
	 * explicit queries always validate.
	 */
	function shouldRefreshChildren(cost: number, boundary: "turn" | "tool"): boolean {
		if (boundary === "turn") return true;
		if (!config) return false;
		if (cost < config.maxCostUsd * CHILD_REFRESH_NEAR_CAP_FRACTION) return false;
		const now = Date.now();
		if (now - lastChildRefreshAt < CHILD_REFRESH_MIN_INTERVAL_MS) return false;
		lastChildRefreshAt = now;
		return true;
	}

	async function rpcRequest(method: "status" | "stop", params?: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!pi.events?.on || !pi.events.emit) throw new Error("pi-subagents RPC is unavailable");
		const requestId = `session-budget-${method}-${randomUUID()}`;
		const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
		return await new Promise((resolveReply, rejectReply) => {
			let settled = false;
			let unsubscribe = () => {};
			let timer: ReturnType<typeof setTimeout>;
			const finish = (error?: Error, data?: Record<string, unknown>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				if (error) rejectReply(error);
				else resolveReply(data ?? {});
			};
			unsubscribe = pi.events.on(replyEvent, (reply) => {
				const response = reply as { version?: number; requestId?: string; method?: string; success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
				if (response.version !== 1 || response.requestId !== requestId || response.method !== method) return;
				if (!response.success) finish(new Error(response.error?.message ?? `Subagent ${method} request failed`));
				else finish(undefined, response.data);
			});
			timer = setTimeout(() => finish(new Error(`Timed out waiting for subagent ${method} acknowledgement`)), 1000);
			timer.unref?.();
			try {
				pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method, ...(params ? { params } : {}) });
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async function stopActiveAsyncSubagents(): Promise<void> {
		const response = await rpcRequest("status");
		const snapshot = response.asyncSnapshot as { runs?: Array<{ id?: unknown; state?: unknown }> } | undefined;
		const activeRuns = (snapshot?.runs ?? []).filter((run) => typeof run.id === "string" && (run.state === "running" || run.state === "queued"));
		const results = await Promise.allSettled(activeRuns.map((run) => rpcRequest("stop", { id: run.id as string })));
		for (const [index, result] of results.entries()) {
			if (result.status === "rejected") console.error(`[session-budget] Could not stop async subagent '${activeRuns[index]?.id}': ${result.reason instanceof Error ? result.reason.message : result.reason}`);
		}
	}

	function requestStopActiveAsyncSubagents(): void {
		if (!pi.events?.on || !pi.events.emit) return;
		void stopActiveAsyncSubagents().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.startsWith("Timed out waiting for subagent status")) {
				console.error(`[session-budget] Could not stop async subagents: ${message}`);
			}
		});
	}

	/** The versions, for any report that aborts: an abort on an unverified release is a version problem first. */
	function versionContext(): string {
		let installed: string | undefined;
		try {
			installed = installedSubagentsVersion();
		} catch {
			installed = undefined;
		}
		const verified = SUBAGENTS_EXPECTED_VERSION;
		return installed === undefined
			? ` (pi-subagents version unreadable under <agentDir>/npm; accounting verified against ${verified})`
			: installed === verified
				? ` (pi-subagents ${installed}, the verified release)`
				: ` (pi-subagents ${installed} is installed; this accounting was verified against ${verified} — upgrading may be the fix)`;
	}

	async function failClosed(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, phase: string, error: unknown): Promise<void> {
		const reason = error instanceof Error ? error.message : String(error);
		if (!overNotified) {
			overNotified = true;
			requestStopActiveAsyncSubagents();
			const message = `Session budget accounting failed (${phase}) — aborting to avoid unverified spend: ${reason}${versionContext()}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			console.error(`[session-budget] ${message}`);
		}
		ctx.abort();
	}

	async function check(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, phase: string, boundary: "turn" | "tool" = "turn"): Promise<void> {
		if (isSubagentSession(ctx)) return;
		if (!config) return;
		let cost: number;
		try {
			const known = sessionCostUsd(ctx, false);
			cost = shouldRefreshChildren(known, boundary) ? sessionCostUsd(ctx, true) : known;
		} catch (error) {
			await failClosed(ctx, phase, error);
			return;
		}
		reportCompatAnomalies(ctx);
		updateStatus(ctx, cost);
		if (cost < config.maxCostUsd) {
			overNotified = false;
			return;
		}
		if (!overNotified) {
			overNotified = true;
			requestStopActiveAsyncSubagents();
			const msg = `Session budget exceeded: ${fmtUsd(cost)} / ${fmtUsd(config.maxCostUsd)}${compatBypass ? " (subagent excluded)" : ""} — aborting (${phase}). Raise the cap via settings.json (${SETTINGS_KEY}) or /budget <usd>.`;
			if (ctx.hasUI) ctx.ui.notify(msg, "error");
			console.warn(`[session-budget] ${msg}`);
		}
		ctx.abort();
	}

	pi.on("session_start", async (_event, ctx) => {
		config = isSubagentSession(ctx) ? null : loadConfig(ctx.cwd);
		sessionOverrideOff = false;
		overNotified = false;
		lastChildUnaccounted = 0;
		lastForkUnaccounted = 0;
		integrityWarned = false;
		childScanCache.clear();
		ledgerClassCache.clear();
		warnedLedgerFiles.clear();
		lastChildRefreshAt = 0;
		// Compat state is per session, so it is reset regardless of whether this session
		// enforces a cap: a session that starts with the budget off and later runs
		// `/budget <usd>` must not inherit another session's bypass.
		compatAnomalies.length = 0;
		compatReported = false;
		compatBypass = false;
		if (config) {
			try {
				updateStatus(ctx, sessionCostUsd(ctx, true));
			} catch (error) {
				await failClosed(ctx, "session_start", error);
			}
			// The scan may already have found the layout incompatible; report it here too,
			// so a session that ends its first turn still told the operator.
			reportCompatAnomalies(ctx);
		} else {
			updateStatus(ctx, 0);
		}
	});

	// Hard cap: block new turns of already-over sessions (covers queued steering/follow-up messages).
	pi.on("turn_start", async (_event, ctx) => check(ctx, "turn_start"));
	// Mid-turn stop: cumulative LLM spend crossed the cap while tools are running.
	pi.on("tool_result", async (_event, ctx) => check(ctx, "tool_result", "tool"));
	// Turn-end safety net: everything (incl. toolResult usage) is persisted by now.
	pi.on("turn_end", async (_event, ctx) => check(ctx, "turn_end"));

	pi.registerCommand("budget", {
		description: "Show budget status, set a current-run cap, disable enforcement, or self-check the pi-subagents dependency: /budget [usd|off|doctor]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (isSubagentSession(ctx)) {
				if (ctx.hasUI) ctx.ui.notify("Session budget is managed by the parent session", "info");
				return;
			}
			if (trimmed === "doctor") {
				// Reports the dependency, not the cap, so it works with enforcement off too.
				const report = doctorReport(ctx);
				if (ctx.hasUI) ctx.ui.notify(report, "info");
				else console.log(`[session-budget]\n${report}`);
				if (compatAnomalies.length > 0) reportCompatAnomalies(ctx);
				return;
			}
			if (trimmed === "off") {
				config = null;
				sessionOverrideOff = true;
				overNotified = false;
				updateStatus(ctx, 0);
				if (ctx.hasUI) ctx.ui.notify("Session budget disabled for this run", "info");
				return;
			}
			if (trimmed !== "") {
				const value = parseFloat(trimmed);
				if (!Number.isFinite(value) || value <= 0) {
					if (ctx.hasUI) ctx.ui.notify(`Invalid amount: ${trimmed}. Usage: /budget 5.00`, "error");
					return;
				}
				config = { maxCostUsd: value, mode: "enforce" };
				sessionOverrideOff = false;
				overNotified = false;
				if (ctx.hasUI) ctx.ui.notify(`Session budget set to ${fmtUsd(value)} (current run)`, "info");
				await check(ctx, "/budget");
				return;
			}
			if (!config) {
				if (ctx.hasUI) {
					const status = sessionOverrideOff
						? "Session budget is off for this run. Use /budget <usd> to turn it back on."
						: `No session budget active. Configure ${SETTINGS_KEY} in settings.json or run /budget <usd>.`;
					ctx.ui.notify(status, "info");
				}
				return;
			}
			let cost: number;
			try {
				cost = sessionCostUsd(ctx, true);
			} catch (error) {
				await failClosed(ctx, "/budget", error);
				return;
			}
			reportCompatAnomalies(ctx);
			const remaining = Math.max(0, config.maxCostUsd - cost);
			const scope = compatBypass ? "; subagent excluded" : "";
			const status = `Session budget: ${fmtUsd(cost)} / ${fmtUsd(config.maxCostUsd)} (remaining ${fmtUsd(remaining)}, mode ${config.mode}${scope})`;
			if (ctx.hasUI) ctx.ui.notify(status, "info");
			else console.log(`[session-budget] ${status}`);
		},
	});
}
