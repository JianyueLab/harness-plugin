import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_FRESH_MS, STDOUT_KEEP_BYTES, distill, main, runHost, stateDir } from '../src/worker.mjs';
import { claudeSession, codexSession, ompSession } from './fixtures.js';
import { cleanup, tempDir, writeJsonl } from './helpers.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');

describe('distill', () => {
  let home;
  let calls;
  let exitCode;
  let stdout;
  const deps = () => ({
    env: {},
    home,
    now: () => NOW,
    promptText: 'Use {{MCP_SERVER}}.',
    runHost: async (cmd, args, input, options) => {
      calls.push({ cmd, args, input, options });
      return { code: exitCode, stdout };
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
    stdout = 'Recorded one memory.\n\ndone\n';
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

  test('a failed host run keeps progress unchanged, logs the exit code and removes the pending file', async () => {
    exitCode = 1;
    const lines = [...codexSession('x-1'), { timestamp: '2026-10-27T03:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u2', content: [{ type: 'input_text', text: 'two' }] } }, { timestamp: '2026-10-27T03:00:10.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u3', content: [{ type: 'input_text', text: 'three' }] } }];
    const path = transcript('rollout-x-1.jsonl', lines);
    expect(await distill({ host: 'codex', transcript_path: path, session_id: 'x-1', cwd: null }, deps())).toBe('failed');
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(join(stateDir({}, home), 'pending', 'codex_x-1.txt'))).toBe(false);
    expect(readFileSync(join(stateDir({}, home), 'plugin.log'), 'utf8')).toContain('codex:x-1 failed exit=1');
  });

  const fourMessageSession = (id) => [...claudeSession(id), { type: 'user', sessionId: id, cwd: '/w', uuid: 'u9', message: { role: 'user', content: 'more' } }, { type: 'user', sessionId: id, cwd: '/w', uuid: 'u10', message: { role: 'user', content: 'again' } }];

  test('exit 0 with a last non-empty line of done, in any case and padding, records progress', async () => {
    stdout = 'Added a memory.\n  DONE  \n\n';
    const path = transcript('c-d.jsonl', fourMessageSession('c-d'));
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-d', cwd: '/w' }, deps())).toBe('distilled');
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).sessions['claude-code:c-d'].decision).toBe('sent');
  });

  for (const text of ['', 'failed\n', 'done\nfailed\n', 'done.\n', 'I am done\n']) {
    test(`exit 0 without a final done line (${JSON.stringify(text)}) fails and keeps progress`, async () => {
      stdout = text;
      const path = transcript('c-n.jsonl', fourMessageSession('c-n'));
      expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-n', cwd: '/w' }, deps())).toBe('failed');
      expect(existsSync(statePath())).toBe(false);
      expect(existsSync(join(stateDir({}, home), 'pending', 'claude-code_c-n.txt'))).toBe(false);
      expect(readFileSync(join(stateDir({}, home), 'plugin.log'), 'utf8')).toContain('claude-code:c-n failed no-done');
    });
  }

  test('a nonzero exit fails even when the host printed done', async () => {
    exitCode = 2;
    const path = transcript('c-x.jsonl', fourMessageSession('c-x'));
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-x', cwd: '/w' }, deps())).toBe('failed');
    expect(existsSync(statePath())).toBe(false);
  });

  test('codex runs disable every other MCP server from CODEX_HOME/config.toml; other hosts do not read it', async () => {
    const codexHome = join(home, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.memory]\nurl = "x"\n[mcp_servers.github]\ncommand = "gh"\n');
    const lines = [...codexSession('x-2'), { timestamp: '2026-10-27T03:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u2', content: [{ type: 'input_text', text: 'two' }] } }, { timestamp: '2026-10-27T03:00:10.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u3', content: [{ type: 'input_text', text: 'three' }] } }];
    const path = transcript('rollout-x-2.jsonl', lines);
    expect(await distill({ host: 'codex', transcript_path: path, session_id: 'x-2', cwd: null }, { ...deps(), env: { CODEX_HOME: codexHome } })).toBe('distilled');
    const args = calls[0].args;
    expect(args.filter((a, i) => args[i - 1] === '-c')).toEqual(['mcp_servers.github.enabled=false']);
    const claudePath = transcript('c-o.jsonl', fourMessageSession('c-o'));
    await distill({ host: 'claude-code', transcript_path: claudePath, session_id: 'c-o', cwd: '/w' }, { ...deps(), env: { CODEX_HOME: codexHome } });
    expect(calls[1].args).not.toContain('-c');
  });

  test('main logs a worker error by name and message, without transcript content', async () => {
    const path = transcript('c-e.jsonl', fourMessageSession('c-e'));
    mkdirSync(stateDir({}, home), { recursive: true });
    writeFileSync(statePath(), '{corrupt');
    const { promptText, ...rest } = deps();
    await main([JSON.stringify({ host: 'claude-code', transcript_path: path, session_id: 'c-e', cwd: '/w' })], { ...rest, loadPrompt: () => promptText });
    const log = readFileSync(join(stateDir({}, home), 'plugin.log'), 'utf8');
    expect(log).toContain(`worker error: Error: state file is not valid JSON: ${statePath()}`);
    expect(log).not.toContain('again');
    expect(log.trimEnd().split('\n').filter((line) => line.includes('worker error'))).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test('main logs an unparsable payload', async () => {
    const { promptText, ...rest } = deps();
    await main(['not json'], { ...rest, loadPrompt: () => promptText });
    expect(readFileSync(join(stateDir({}, home), 'plugin.log'), 'utf8')).toContain('worker error: SyntaxError: ');
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
  test('passes stdin through and returns the exit code and stdout; a missing binary is 127', async () => {
    const dir = tempDir('runhost');
    try {
      const out = join(dir, 'out.txt');
      const script = join(dir, 'fake.sh');
      writeFileSync(script, `#!/bin/sh\ncat > "${out}"\necho working\necho done\nexit 3\n`, { mode: 0o755 });
      expect(await runHost(script, [], 'hello', { env: process.env, cwd: dir })).toEqual({ code: 3, stdout: 'working\ndone\n' });
      expect(readFileSync(out, 'utf8')).toBe('hello');
      expect(await runHost(join(dir, 'missing'), [], '', { env: process.env, cwd: dir })).toEqual({ code: 127, stdout: '' });
    } finally {
      cleanup(dir);
    }
  });

  test('keeps only the last STDOUT_KEEP_BYTES of stdout', async () => {
    const dir = tempDir('runhost');
    try {
      const script = join(dir, 'chatty.sh');
      writeFileSync(script, `#!/bin/sh\nhead -c ${STDOUT_KEEP_BYTES * 3} /dev/zero | tr '\\0' 'x'\necho\necho done\n`, { mode: 0o755 });
      const { code, stdout } = await runHost(script, [], '', { env: process.env, cwd: dir });
      expect(code).toBe(0);
      expect(Buffer.byteLength(stdout)).toBe(STDOUT_KEEP_BYTES);
      expect(stdout.endsWith('x\ndone\n')).toBe(true);
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
      const { code } = await runHost(script, [], '', { env: process.env, cwd: dir, timeoutMs: 200, killGraceMs: 200 });
      expect(code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      cleanup(dir);
    }
  }, 5000);
});
