// Usage: node evals/auto-compact-history.mjs [session-directory]
// Counts observable events, not opportunities. Transient mid-turn hints are not journaled.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.argv[2] ?? 'agent/sessions';
const totals = {
  files: 0, malformedLines: 0, preTurnMarkersOnDisk: 0, preTurnChecks: 0, explicitSkips: 0, cleanRequests: 0,
  cleanRequestsWithoutObservedCommit: 0, protocolViolations: 0, indeterminateJudgments: 0,
  preTurnJudgmentsWithCommit: 0, preTurnCommits: 0, unattributedRequestCalls: 0, otherAutoCompactCommits: 0,
  unlinkedContinuations: 0, allRequestCalls: 0, exactSkipRepliesOutsideJudgment: 0,
  midTurnEligibleCheckpoints: null, midTurnMissRate: null,
};
const events = new Map();
const key = e => `${e.timestamp}/${e.id}/${e.type}`;
const isCustom = (e, name) => e?.type === 'custom_message' && e.customType === `auto-compact-${name}`;
const parts = e => Array.isArray(e?.message?.content) ? e.message.content : [];
const calls = e => parts(e).filter(p => p.type === 'toolCall');
const requestCalls = e => calls(e).filter(p => p.name === 'request_compaction');
const text = e => parts(e).filter(p => p.type === 'text').map(p => p.text).join('').trim();
const isAssistant = e => e.type === 'message' && e.message?.role === 'assistant';
const isInput = e => e.type === 'message' && e.message?.role === 'user';

async function scan(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) { await scan(path); continue; }
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    totals.files++;
    const links = new Map();
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { totals.malformedLines++; continue; }
      if (!e?.id) continue;
      // Keep only structural ancestry plus the few relevant event attributes in memory.
      const parent = links.get(e.parentId);
      let link = parent;
      if (isCustom(e, 'pre-turn')) {
        totals.preTurnMarkersOnDisk++;
        const id = key(e);
        if (!events.has(id)) events.set(id, { kind: 'judgment', replies: new Map(), commits: new Map() });
        link = { judgment: id };
      } else if (isCustom(e, 'continuation')) {
        const id = key(e);
        const linked = Boolean(parent?.compaction && parent?.request);
        if (!events.has(id)) events.set(id, { kind: 'continuation', linked, pre: Boolean(parent?.judgment) });
        if (linked && parent.judgment) events.get(parent.judgment).commits.set(id, parent.request);
        link = undefined;
      } else if (isInput(e)) {
        link = undefined;
      } else if (isAssistant(e)) {
        const count = requestCalls(e).length;
        const skip = calls(e).length === 0 && text(e) === 'SKIP-COMPACTION' && e.message.stopReason === 'stop';
        const clean = count === 1 && calls(e).length === 1 && !text(e) && e.message.stopReason === 'toolUse';
        const failure = ['error', 'aborted'].includes(e.message.stopReason);
        const id = key(e);
        if (count || skip || parent?.judgment) {
          if (!events.has(id)) events.set(id, { kind: 'assistant', count, skip, clean, failure, pre: Boolean(parent?.judgment) });
          if (parent?.judgment) events.get(parent.judgment).replies.set(id, parent.reply);
        }
        link = { judgment: parent?.judgment, reply: id, request: count ? id : undefined };
      } else if (e.type === 'compaction') {
        link = { ...parent, compaction: true };
      }
      links.set(e.id, link);
    }
  }
}

await scan(root);
for (const e of events.values()) {
  if (e.kind === 'assistant') {
    totals.allRequestCalls += e.count;
    if (!e.pre) {
      totals.unattributedRequestCalls += e.count;
      if (e.skip) totals.exactSkipRepliesOutsideJudgment++;
    }
  } else if (e.kind === 'continuation') {
    if (!e.linked) totals.unlinkedContinuations++;
    else if (!e.pre) totals.otherAutoCompactCommits++;
  } else {
    totals.preTurnChecks++;
    const [id] = e.replies.keys();
    const reply = events.get(id);
    totals.preTurnCommits += e.commits.size;
    if (e.commits.size) totals.preTurnJudgmentsWithCommit++;
    const branched = new Set(e.replies.values()).size !== e.replies.size;
    if (!reply || reply.failure || branched) totals.indeterminateJudgments++;
    else if (e.replies.size !== 1) totals.protocolViolations++;
    else if (reply.skip) totals.explicitSkips++;
    else if (reply.clean) {
      totals.cleanRequests++;
      if (!Array.from(e.commits.values()).includes(id)) totals.cleanRequestsWithoutObservedCommit++;
    } else totals.protocolViolations++;
  }
}
const rate = n => totals.preTurnChecks ? n / totals.preTurnChecks : null;
console.log(JSON.stringify({ ...totals,
  preTurnSkipRate: rate(totals.explicitSkips), preTurnRequestRate: rate(totals.cleanRequests),
  preTurnCommitRate: rate(totals.preTurnJudgmentsWithCommit),
}, null, 2));
