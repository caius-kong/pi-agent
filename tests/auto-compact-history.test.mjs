import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const reader = fileURLToPath(new URL('../evals/auto-compact-history.mjs', import.meta.url));
const content = text => [{ type: 'text', text }];
const message = (role, content, stopReason) => ({ type: 'message', message: { role, content, stopReason } });
const custom = customType => ({ type: 'custom_message', customType });
const call = { type: 'toolCall', name: 'request_compaction', id: 'tool1' };

test('attributes observed events by ancestry, ignoring prose, sibling outcomes, and copied entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-history-'));
  const entries = [];
  function add(entry, parent = entries.at(-1)?.id) {
    const id = String(entries.length + 1);
    entries.push({ id, parentId: parent, timestamp: '2026-11-01T00:00:00Z', ...entry });
    return id;
  }
  const judgment = add(custom('auto-compact-pre-turn'));
  add(message('assistant', [{ type: 'thinking', thinking: 'request_compaction' }, ...content('SKIP-COMPACTION')], 'stop'));
  add(message('user', content('SKIP-COMPACTION')));
  add(message('assistant', content('request_compaction [Pi auto-compact check]'), 'stop'));
  const request = add(message('assistant', [call], 'toolUse'), judgment);
  add({ type: 'compaction' }, request);
  add(custom('auto-compact-continuation'));
  add(custom('auto-compact-pre-turn'));
  add(message('assistant', [call], 'toolUse'));
  add(message('user', content('Delivered without compaction')));
  add(message('assistant', [call], 'toolUse'));
  add({ type: 'compaction' });
  add(custom('auto-compact-continuation'));
  add(custom('auto-compact-pre-turn'));
  const jsonl = es => es.map(e => JSON.stringify(e)).join('\n');
  try {
    writeFileSync(join(dir, 'a.jsonl'), jsonl(entries));
    writeFileSync(join(dir, 'fork.jsonl'), jsonl(entries.slice(0, 2)) + '\n{');
    const report = JSON.parse(execFileSync(process.execPath, [reader, dir], { encoding: 'utf8' }));
    assert.equal(report.preTurnChecks, 3);
    assert.equal(report.preTurnMarkersOnDisk, 4);
    // Sibling outcomes and a truncated judgment both lack a unique observed decision.
    assert.equal(report.protocolViolations, 0);
    assert.equal(report.indeterminateJudgments, 2);
    assert.equal(report.cleanRequests, 1);
    assert.equal(report.cleanRequestsWithoutObservedCommit, 1);
    assert.equal(report.preTurnCommits, 1);
    assert.equal(report.otherAutoCompactCommits, 1);
    assert.equal(report.allRequestCalls, 3);
    assert.equal(report.unattributedRequestCalls, 1);
    assert.equal(report.explicitSkips, 0);
    assert.equal(report.midTurnMissRate, null);
    assert.equal(report.malformedLines, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
