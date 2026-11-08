import { describe, expect, test } from 'bun:test';
import jylMemory from '../hooks/post/jyl-memory.ts';

const inventoryDeps = { run: () => null, readFile: () => null, exists: () => false, listDirs: () => [] };

function start() {
  const handlers = {};
  const calls = [];
  const render = (template, cwd, deps) => { calls.push(deps.inventoryDeps); return 'RECALL'; };
  jylMemory({ on: (name, fn) => (handlers[name] = fn) }, { render, inventoryDeps });
  return { handler: handlers.before_agent_start, calls };
}

describe('omp hook', () => {
  test('recall is rendered only for a string or array system prompt, once per hook', async () => {
    const { handler, calls } = start();
    for (const systemPrompt of [undefined, null, 3, { text: 'x' }]) {
      expect(await handler({ systemPrompt }, {})).toBeUndefined();
    }
    expect(calls).toEqual([]);
    expect(await handler({ systemPrompt: 'base' }, {})).toEqual({ systemPrompt: 'base\n\nRECALL' });
    expect(await handler({ systemPrompt: ['a'] }, {})).toEqual({ systemPrompt: ['a', 'RECALL'] });
    expect(calls).toEqual([inventoryDeps]);
  });

  test('a non-object second argument falls back to the defaults', async () => {
    for (const options of [null, 'x']) {
      const handlers = {};
      expect(() => jylMemory({ on: (name, fn) => (handlers[name] = fn) }, options)).not.toThrow();
      const result = await handlers.before_agent_start({ systemPrompt: 'base' }, {});
      expect(result.systemPrompt.startsWith('base\n\n')).toBe(true);
      expect(result.systemPrompt).toContain('jyl_project_list');
    }
  });
});
