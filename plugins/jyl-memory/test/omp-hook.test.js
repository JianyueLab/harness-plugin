import { describe, expect, mock, test } from 'bun:test';

const rendered = [];
mock.module('../src/recall.mjs', () => ({ renderRecall: () => { rendered.push(1); return 'RECALL'; } }));
const { default: jylMemory } = await import('../hooks/post/jyl-memory.ts');

function start() {
  const handlers = {};
  jylMemory({ on: (name, fn) => (handlers[name] = fn) });
  return handlers.before_agent_start;
}

describe('omp hook', () => {
  test('recall is rendered only for a string or array system prompt', async () => {
    const handler = start();
    for (const systemPrompt of [undefined, null, 3, { text: 'x' }]) {
      expect(await handler({ systemPrompt }, {})).toBeUndefined();
    }
    expect(rendered).toEqual([]);
    expect(await handler({ systemPrompt: 'base' }, {})).toEqual({ systemPrompt: 'base\n\nRECALL' });
    expect(await handler({ systemPrompt: ['a'] }, {})).toEqual({ systemPrompt: ['a', 'RECALL'] });
    expect(rendered.length).toBe(1);
  });
});
