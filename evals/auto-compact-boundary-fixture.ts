// Test-only fixture for real TUI sessions. No fake usage or model calls.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const scenario = process.env.COMPACT_CASE;
  const evidence = process.env.COMPACT_EVENTS;
  if (!evidence) throw new Error('COMPACT_EVENTS must point to an isolated evidence file');
  const log = (record: object) => appendFileSync(evidence, JSON.stringify(record) + '\n');
  let delegated = false;

  for (const [name, description, text] of [
    ['stage_one', 'Inspect the route artifact (phase one).', 'Phase one is complete. The selected marker is route-731.'],
    ['stage_two', 'Perform phase two: obtain three independent checks of the selected marker.', 'Blue, green, and red checks passed for route-731.'],
    ['wait_fixture', 'Collect the pending delegated review result.', 'The delegated review agrees with route-731 and is complete.'],
  ]) {
    pi.registerTool({
      name, label: name, description, parameters: { type: 'object', properties: {} },
      async execute() {
        if (name === 'stage_one' && (scenario === 'M2' || scenario === 'P6')) delegated = true;
        if (name === 'wait_fixture') delegated = false;
        log({ tool: name, delegated });
        return { content: [{ type: 'text', text: text + (delegated ? ' A delegated review is still running; collect it with wait_fixture.' : '') }] };
      },
    });
  }
  if (scenario === 'P6' || scenario === 'M2') {
    // Expose a synthetic active delegation through the same status interface the controller checks.
    pi.registerTool({ name: 'subagent', label: 'fixture status', description: 'Test fixture; do not call.',
      parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error('unexpected fixture subagent call'); } });
    pi.events.on('subagents:rpc:v1:request', ({ requestId, method }) => {
      log({ status: method, delegated });
      pi.events.emit(`subagents:rpc:v1:reply:${requestId}`, {
        version: 1, requestId, method, success: true, data: {
          fleet: { totalActive: Number(delegated) }, asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot', version: 1,
            runs: delegated ? [{ state: 'running' }] : [],
            omitted: { runs: 0, children: 0, byteLimitExceeded: false },
          },
        },
      });
    });
  }
  pi.on('context', (event, ctx) => {
    const hint = event.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'text' && p.text.startsWith('[Pi auto-compact check] Context usage')));
    log({ hint, delegated, percent: ctx.getContextUsage()?.percent ?? null,
      last: event.messages.filter(m => m.role === 'toolResult').at(-1)?.toolName ?? null });
  });
}
