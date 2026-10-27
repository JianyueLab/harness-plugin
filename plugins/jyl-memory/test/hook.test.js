import { describe, expect, test } from 'bun:test';
import { hook } from '../src/hook.mjs';
import { sink } from './helpers.js';

function deps(overrides = {}) {
  const spawned = [];
  const stdout = sink();
  return {
    spawned,
    stdout,
    deps: { env: {}, readStdin: async () => '', stdout, spawnWorker: (p) => spawned.push(p), recallText: 'RECALL', ...overrides },
  };
}

describe('hook', () => {
  test('start prints the recall prompt', async () => {
    const { deps: d, stdout } = deps();
    expect(await hook(['start'], d)).toBe(0);
    expect(stdout.text()).toBe('RECALL');
  });

  test('inside a distill run every event is a no-op', async () => {
    const { deps: d, stdout, spawned } = deps({ env: { JYL_MEMORY_DISTILL: '1' }, readStdin: async () => '{"transcript_path":"/t"}' });
    await hook(['start'], d);
    await hook(['end'], d);
    expect(stdout.text()).toBe('');
    expect(spawned).toEqual([]);
  });

  test('end hands the session to the worker; Codex is detected by PLUGIN_ROOT', async () => {
    const payload = JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/w', hook_event_name: 'SessionEnd' });
    const claude = deps({ readStdin: async () => payload });
    await hook(['end'], claude.deps);
    expect(claude.spawned).toEqual([{ host: 'claude-code', transcript_path: '/t.jsonl', session_id: 's', cwd: '/w' }]);
    const codex = deps({ env: { PLUGIN_ROOT: '/p' }, readStdin: async () => payload });
    await hook(['end'], codex.deps);
    expect(codex.spawned[0].host).toBe('codex');
  });

  test('end with --host omp uses that host', async () => {
    const { deps: d, spawned } = deps({ readStdin: async () => '{"transcript_path":"/o.jsonl"}' });
    await hook(['end', '--host', 'omp'], d);
    expect(spawned).toEqual([{ host: 'omp', transcript_path: '/o.jsonl', session_id: null, cwd: null }]);
  });

  test('end without a transcript path, with bad JSON, or an unknown event does nothing', async () => {
    for (const input of ['', 'nope', '{}', '{"transcript_path":""}']) {
      const { deps: d, spawned } = deps({ readStdin: async () => input });
      expect(await hook(['end'], d)).toBe(0);
      expect(spawned).toEqual([]);
    }
    const { deps: d, spawned, stdout } = deps({ readStdin: async () => '{"transcript_path":"/t"}' });
    expect(await hook(['bogus'], d)).toBe(0);
    expect(spawned).toEqual([]);
    expect(stdout.text()).toBe('');
  });
});
