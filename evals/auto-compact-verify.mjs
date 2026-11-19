// Check one real-session journal against the scenario contract; see auto-compact-prompts.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [id, file, traceFile] = process.argv.slice(2);
assert.ok(id && file, 'usage: node evals/auto-compact-verify.mjs CASE SESSION.jsonl [events.ndjson]');
const read = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const rows = read(file);
const messages = rows.flatMap(r => r.message ? [r.message] : []);
const text = m => m?.content?.filter?.(p => p.type === 'text').map(p => p.text).join('').trim();
const calls = m => m?.content?.filter?.(p => p.type === 'toolCall').map(p => p.name) ?? [];
const assistant = messages.filter(m => m.role === 'assistant');
assert.ok(assistant.every(m => ['stop', 'toolUse'].includes(m.stopReason)), 'transport failure or interruption');
const final = text(assistant.at(-1));
assert.equal(assistant.at(-1)?.stopReason, 'stop');
const tagged = name => rows.filter(r => r.type === 'custom_message' && r.customType === `auto-compact-${name}`);
const judgment = tagged('pre-turn');
const continuation = tagged('continuation');
const compactions = rows.filter(r => r.type === 'compaction');
const mid = id.startsWith('M');
assert.equal(judgment.length, mid || id === 'A3' ? 0 : 1);
const verdict = judgment.length ? rows.slice(rows.indexOf(judgment[0]) + 1).find(r => r.message?.role === 'assistant')?.message : undefined;
if (id === 'A3') {
  assert.equal(messages.filter(m => m.role === 'user').length, 2);
  assert.equal(assistant.length, 2);
}
const requiresCommit = ['A2', 'P3plus', 'P5', 'M1', 'M5'].includes(id);
const expected = requiresCommit || (id === 'P4plus' && calls(verdict).length > 0) ? 1 : 0;
assert.equal(compactions.length, expected);
assert.equal(continuation.length, expected);
assert.equal(assistant.flatMap(calls).filter(name => name === 'request_compaction').length, expected);
if (verdict) {
  const held = judgment[0].content.split('\n\n')[1];
  assert.ok(held);
  if (expected) {
    assert.deepEqual(calls(verdict), ['request_compaction']);
    assert.equal(text(verdict), '');
    assert.equal(continuation[0].content, held);
  } else {
    assert.deepEqual(calls(verdict), []);
    assert.equal(text(verdict), 'SKIP-COMPACTION');
  }
  assert.equal(messages.filter(m => m.role === 'user' && text(m) === held).length, 1 - expected);
  const delivery = expected ? continuation[0] : rows.find(r => r.message?.role === 'user' && text(r.message) === held);
  assert.equal(rows.slice(rows.indexOf(delivery) + 1).filter(r => r.message?.role === 'assistant').length, 1);
}
const used = assistant.flatMap(calls);
if (mid || id === 'P6') {
  const trace = read(traceFile);
  const boundary = trace.find(e => e.hint && e.last === 'stage_one' && e.percent > 5);
  assert.ok(boundary, 'must observe a real above-threshold mid-turn hint after stage one');
  assert.equal(boundary.delegated, ['M2', 'P6'].includes(id));
  assert.deepEqual(used, expected ? ['stage_one', 'request_compaction', 'stage_two'] : id === 'M2' ? ['stage_one', 'wait_fixture'] : ['stage_one']);
  if (expected) {
    const request = assistant.find(m => calls(m).includes('request_compaction'));
    assert.deepEqual(calls(request), ['request_compaction']);
    assert.ok(rows.findIndex(r => r.message === request) < rows.indexOf(compactions[0]));
    assert.ok(rows.indexOf(compactions[0]) < rows.indexOf(continuation[0]));
    const after = rows.slice(rows.indexOf(continuation[0]) + 1).filter(r => r.message?.role === 'assistant');
    assert.deepEqual(calls(after[0]?.message), ['stage_two']);
    assert.equal(continuation[0].content, 'Context was compacted. Continue the task.');
    for (const word of ['route-731', 'blue', 'green', 'red']) assert.match(final, new RegExp(word, 'i'));
  }
}
switch (id) {
  case 'A1': for (const word of [/30\s*分钟/, /每周/, /值班/, /[?？]/]) assert.match(final, word); break;
  case 'A2': case 'A3': assert.match(final, /^服务已恢复.*翻译任务[。.]?$/s); break;
  case 'P3plus': assert.match(final, /^COUNT: 3\s+SUM: 16\s+MAX: 8$/); break;
  case 'P3minus': assert.match(final, /429/); assert.match(final, /pending|unresolved|unassigned|undecided|open choice/i); assert.doesNotMatch(final, /classify (?:it|this) as P[12]/i); break;
  case 'P4plus': assert.equal(final, 'ready-731'); break;
  case 'P4minus': assert.match(final, /option A.*option B/is); assert.match(final, /select|choo[sc]|pick/i); break;
  case 'P5': case 'M4': assert.equal(final, 'route-731'); break;
  case 'P6': assert.match(final, /^服务已恢复[。.]?$/); break;
  case 'M2': assert.match(final, /route-731/i); assert.match(final, /delegated review/i); break;
  case 'M3': assert.match(final, /public.*private/is); assert.match(final, /[?？]/); break;
  case 'M1': case 'M5': break;
  default: assert.fail(`unknown case ${id}`);
}
console.log(`PASS ${id}: ${expected} committed compaction(s)`);
