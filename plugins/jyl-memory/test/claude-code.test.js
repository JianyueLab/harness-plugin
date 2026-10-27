import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as claudeCode from '../src/sources/claude-code.mjs';
import { claudeSession } from './fixtures.js';
import { cleanup, jsonl, tempDir, writeJsonl } from './helpers.js';

describe('claude-code parse', () => {
  const session = claudeCode.parse(jsonl(claudeSession()), '/x/c-1.jsonl');

  test('keeps only user and assistant text, in file order', () => {
    expect(session.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['u1', 'user', 'How do we deploy?'],
      ['a3', 'assistant', 'We deploy with kubectl.'],
    ]);
  });

  test('takes session fields from the lines', () => {
    expect(session).toMatchObject({
      platform: 'claude-code', id: 'c-1', cwd: '/work/alpha', gitBranch: 'main', toolVersion: '2.1.0',
      title: 'Deploy question', startedAt: '2026-10-27T01:00:00.000Z', gitRemote: null,
    });
  });

  test('falls back to the first user message for the title', () => {
    const lines = claudeSession().filter((l) => l.type !== 'ai-title');
    expect(claudeCode.parse(jsonl(lines), '/x/c-1.jsonl').title).toBe('How do we deploy?');
  });

  test('drops generated user text and compact summaries', () => {
    const base = { type: 'user', sessionId: 'c-1', cwd: '/work/alpha', timestamp: '2026-10-27T01:00:30.000Z' };
    const user = (uuid, content, extra = {}) => ({ ...base, uuid, message: { role: 'user', content }, ...extra });
    const extra = [
      user('g1', '<bash-input>ls</bash-input>'),
      user('g2', '<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>'),
      user('g3', '<bash-stderr>oops</bash-stderr>'),
      user('g4', '<task-notification>\n<task-id>t1</task-id>\n</task-notification>'),
      user('g5', '<local-command-caveat>Caveat: generated</local-command-caveat>'),
      user('g6', '<local-command-stdout>done</local-command-stdout>'),
      user('g7', [{ type: 'text', text: '<command-name>/model</command-name>' }]),
      user('g8', 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
    ];
    const parsed = claudeCode.parse(jsonl([...claudeSession(), ...extra]), '/x/c-1.jsonl');
    expect(parsed.messages.map((m) => m.id)).toEqual(['u1', 'a3']);
  });
});

describe('claude-code files', () => {
  test('lists <projects>/<dir>/*.jsonl, honouring CLAUDE_CONFIG_DIR, and skips nested subagent files', () => {
    const home = tempDir('claude-files');
    try {
      const root = join(home, 'alt-claude');
      writeJsonl(join(root, 'projects', '-work-alpha', 'c-1.jsonl'), claudeSession());
      writeJsonl(join(root, 'projects', '-work-alpha', 'c-1', 'subagents', 'agent-1.jsonl'), claudeSession('s'));
      expect(claudeCode.files({ home, env: { CLAUDE_CONFIG_DIR: root } })).toEqual([
        join(root, 'projects', '-work-alpha', 'c-1.jsonl'),
      ]);
    } finally {
      cleanup(home);
    }
  });
});
