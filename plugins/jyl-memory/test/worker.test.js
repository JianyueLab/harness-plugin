import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_FRESH_MS, distill, runHost, stateDir } from '../src/worker.mjs';
import { claudeSession, codexSession, ompSession } from './fixtures.js';
import { cleanup, tempDir, writeJsonl } from './helpers.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');

describe('distill', () => {
  let home;
  let calls;
  let exitCode;
  const deps = () => ({
    env: {},
    home,
    now: () => NOW,
    promptText: 'Use {{MCP_SERVER}}.',
    runHost: async (cmd, args, input, options) => {
      calls.push({ cmd, args, input, options });
      return exitCode;
    },
  });
  const statePath = () => join(stateDir({}, home), 'plugin-state.json');
  const transcript = (name, lines) => {
    const path = join(home, 'transcripts', name);
    writeJsonl(path, lines);
    return path;
  };

  beforeEach(() => {
    home = tempDir('worker');
    calls = [];
    exitCode = 0;
  });
  afterEach(() => cleanup(home));

  test('claude-code session: runs claude with the prompt on stdin and records progress', async () => {
    const lines = [...claudeSession('c-1'), { type: 'user', sessionId: 'c-1', cwd: '/work/alpha', uuid: 'u9', timestamp: '2026-10-27T01:01:00.000Z', message: { role: 'user', content: 'And the rollback?' } }, { type: 'user', sessionId: 'c-1', cwd: '/work/alpha', uuid: 'u10', timestamp: '2026-10-27T01:02:00.000Z', message: { role: 'user', content: 'Thanks.' } }];
    const path = transcript('c-1.jsonl', lines);
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-1', cwd: '/work/alpha' }, deps())).toBe('distilled');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].input.startsWith('Use memory.\n\n<session cwd="/work/alpha">')).toBe(true);
    expect(calls[0].input).toContain('How do we deploy?');
    expect(calls[0].options.env.JYL_MEMORY_DISTILL).toBe('1');
    expect(calls[0].options.cwd).toBe(stateDir({}, home));
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(state.sessions['claude-code:c-1'].sent_message_ids).toEqual(['u1', 'a3', 'u9', 'u10']);
    expect(existsSync(join(stateDir({}, home), 'pending', 'claude-code_c-1.txt'))).toBe(false);
  });

  test('a second run with no new messages is too short and does not call the host', async () => {
    const lines = [...ompSession('o-1'), { type: 'message', id: 'e8', parentId: 'e7', timestamp: '2026-10-27T02:00:08.000Z', message: { role: 'user', content: 'third' } }, { type: 'message', id: 'e9', parentId: 'e8', timestamp: '2026-10-27T02:00:09.000Z', message: { role: 'user', content: 'fourth' } }];
    const path = transcript('o-1.jsonl', lines);
    expect(await distill({ host: 'omp', transcript_path: path, session_id: 'o-1', cwd: null }, deps())).toBe('distilled');
    expect(await distill({ host: 'omp', transcript_path: path, session_id: 'o-1', cwd: null }, deps())).toBe('too_short');
    expect(calls).toHaveLength(1);
  });

  test('a failed host run keeps progress unchanged and removes the pending file', async () => {
    exitCode = 1;
    const lines = [...codexSession('x-1'), { timestamp: '2026-10-27T03:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u2', content: [{ type: 'input_text', text: 'two' }] } }, { timestamp: '2026-10-27T03:00:10.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u3', content: [{ type: 'input_text', text: 'three' }] } }];
    const path = transcript('rollout-x-1.jsonl', lines);
    expect(await distill({ host: 'codex', transcript_path: path, session_id: 'x-1', cwd: null }, deps())).toBe('failed');
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(join(stateDir({}, home), 'pending', 'codex_x-1.txt'))).toBe(false);
  });

  test('a fresh pending file means another run is in progress', async () => {
    const lines = [...claudeSession('c-2'), { type: 'user', sessionId: 'c-2', cwd: '/w', uuid: 'u9', message: { role: 'user', content: 'more' } }, { type: 'user', sessionId: 'c-2', cwd: '/w', uuid: 'u10', message: { role: 'user', content: 'again' } }];
    const path = transcript('c-2.jsonl', lines);
    const pending = join(stateDir({}, home), 'pending', 'claude-code_c-2.txt');
    mkdirSync(join(stateDir({}, home), 'pending'), { recursive: true });
    writeFileSync(pending, 'x');
    utimesSync(pending, new Date(NOW - 60_000), new Date(NOW - 60_000));
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-2', cwd: '/w' }, deps())).toBe('running');
    utimesSync(pending, new Date(NOW - PENDING_FRESH_MS - 1000), new Date(NOW - PENDING_FRESH_MS - 1000));
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-2', cwd: '/w' }, deps())).toBe('distilled');
  });

  test('disabled config, unreadable transcript and non-user Codex threads do nothing', async () => {
    mkdirSync(join(home, '.config', 'jyl-memory'), { recursive: true });
    writeFileSync(join(home, '.config', 'jyl-memory', 'plugin.json'), JSON.stringify({ enabled: false }));
    expect(await distill({ host: 'claude-code', transcript_path: '/nope', session_id: 'z', cwd: null }, deps())).toBe('disabled');
    writeFileSync(join(home, '.config', 'jyl-memory', 'plugin.json'), '{}');
    expect(await distill({ host: 'claude-code', transcript_path: join(home, 'missing.jsonl'), session_id: 'z', cwd: null }, deps())).toBe('unreadable');
    const guardian = transcript('rollout-g.jsonl', codexSession('g', '/w', 'guardian_review'));
    expect(await distill({ host: 'codex', transcript_path: guardian, session_id: 'g', cwd: null }, deps())).toBe('not_user_session');
    expect(calls).toHaveLength(0);
  });

  test('every outcome is logged with the session key', async () => {
    const path = transcript('c-3.jsonl', claudeSession('c-3'));
    await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-3', cwd: '/w' }, deps());
    expect(readFileSync(join(stateDir({}, home), 'plugin.log'), 'utf8')).toContain('claude-code:c-3 skip too_short');
  });
});

describe('runHost', () => {
  test('passes stdin through and returns the exit code; a missing binary is 127', async () => {
    const dir = tempDir('runhost');
    try {
      const out = join(dir, 'out.txt');
      const script = join(dir, 'fake.sh');
      writeFileSync(script, `#!/bin/sh\ncat > "${out}"\nexit 3\n`, { mode: 0o755 });
      expect(await runHost(script, [], 'hello', { env: process.env, cwd: dir })).toBe(3);
      expect(readFileSync(out, 'utf8')).toBe('hello');
      expect(await runHost(join(dir, 'missing'), [], '', { env: process.env, cwd: dir })).toBe(127);
    } finally {
      cleanup(dir);
    }
  });

  test('a host that ignores SIGTERM is killed after the grace period', async () => {
    const dir = tempDir('runhost');
    try {
      const script = join(dir, 'stubborn.sh');
      writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n", { mode: 0o755 });
      const started = Date.now();
      const code = await runHost(script, [], '', { env: process.env, cwd: dir, timeoutMs: 200, killGraceMs: 200 });
      expect(code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      cleanup(dir);
    }
  }, 5000);
});
