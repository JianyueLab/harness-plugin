import { describe, expect, test } from 'bun:test';
import { hook } from '../src/hook.mjs';
import { sink } from './helpers.js';

const fakeRepo = {
  run(args) {
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --show-toplevel') return args[1] === '/w' ? '/w' : null;
    if (rest === 'config --get remote.origin.url') return 'https://github.com/o/w';
    return null;
  },
  readFile: () => null,
  exists: () => false,
  listDirs: () => [],
};

function deps(overrides = {}) {
  const spawned = [];
  const stdout = sink();
  return {
    spawned,
    stdout,
    deps: {
      env: {},
      readStdin: async () => '',
      stdout,
      spawnWorker: (p) => spawned.push(p),
      recallTemplate: 'RECALL\n{{REPOSITORIES}}',
      recallDeps: { env: {}, home: '/nonexistent-home', inventoryDeps: fakeRepo },
      ...overrides,
    },
  };
}

describe('hook', () => {
  test('start prints the recall prompt with the session cwd repositories', async () => {
    const { deps: d, stdout } = deps({ readStdin: async () => '{"cwd":"/w"}' });
    expect(await hook(['start'], d)).toBe(0);
    expect(stdout.text()).toBe('RECALL\n- /w origin=https://github.com/o/w project=none');
  });

  test('start without a usable stdin cwd prints the recall without repositories', async () => {
    for (const input of ['', 'nope', '{}', '{"cwd":3}']) {
      const { deps: d, stdout } = deps({ readStdin: async () => input });
      expect(await hook(['start'], d)).toBe(0);
      expect(stdout.text()).toBe('RECALL\n(no git repositories)');
    }
    const { deps: d, stdout } = deps({ readStdin: async () => { throw new Error('closed'); } });
    expect(await hook(['start'], d)).toBe(0);
    expect(stdout.text()).toBe('RECALL\n(no git repositories)');
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

  test('end takes the payload from JYL_MEMORY_PAYLOAD without reading stdin', async () => {
    const env = { JYL_MEMORY_PAYLOAD: '{"transcript_path":"/e.jsonl","session_id":"s","cwd":"/w"}' };
    const readStdin = async () => {
      throw new Error('stdin read');
    };
    const { deps: d, spawned } = deps({ env, readStdin });
    await hook(['end', '--host', 'omp'], d);
    expect(spawned).toEqual([{ host: 'omp', transcript_path: '/e.jsonl', session_id: 's', cwd: '/w' }]);
  });

  test('invalid JSON in JYL_MEMORY_PAYLOAD does nothing', async () => {
    const { deps: d, spawned } = deps({ env: { JYL_MEMORY_PAYLOAD: 'nope' }, readStdin: async () => '{"transcript_path":"/t"}' });
    expect(await hook(['end', '--host', 'omp'], d)).toBe(0);
    expect(spawned).toEqual([]);
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
