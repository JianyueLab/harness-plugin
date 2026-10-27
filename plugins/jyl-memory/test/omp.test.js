import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as omp from '../src/sources/omp.mjs';
import { ompSession } from './fixtures.js';
import { cleanup, jsonl, tempDir, writeJsonl } from './helpers.js';

describe('omp parse', () => {
  const session = omp.parse(jsonl(ompSession()), '/x/2026_o-1.jsonl');

  test('follows the active branch from the last entry and keeps user/assistant text only', () => {
    expect(session.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['e3', 'user', 'New branch question'],
      ['e4', 'assistant', 'New branch answer'],
    ]);
  });

  test('takes id, cwd and the title slot', () => {
    expect(session).toMatchObject({ platform: 'omp', id: 'o-1', cwd: '/work/beta', title: '📡 Beta work', startedAt: '2026-10-27T02:00:03.000Z' });
  });

  test('stops on a parent cycle instead of looping', () => {
    const lines = [
      { type: 'session', id: 'o-2', version: 3, cwd: '/w', timestamp: '2026-10-27T02:00:00.000Z' },
      { type: 'message', id: 'a', parentId: 'b', timestamp: '2026-10-27T02:00:01.000Z', message: { role: 'user', content: 'A' } },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-10-27T02:00:02.000Z', message: { role: 'assistant', content: 'B' } },
    ];
    expect(omp.parse(jsonl(lines), '/x/o-2.jsonl').messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('falls back to the first user message for the title', () => {
    const lines = ompSession().filter((l) => l.type !== 'title');
    expect(omp.parse(jsonl(lines), '/x/o-1.jsonl').title).toBe('New branch question');
  });
});

describe('omp files', () => {
  test('lists <agent dir>/sessions/<dir>/*.jsonl, honouring PI_CODING_AGENT_DIR', () => {
    const home = tempDir('omp-files');
    try {
      const agentDir = join(home, 'agent-alt');
      writeJsonl(join(agentDir, 'sessions', '-work-beta', '2026_o-1.jsonl'), ompSession());
      expect(omp.files({ home, env: { PI_CODING_AGENT_DIR: agentDir } })).toEqual([
        join(agentDir, 'sessions', '-work-beta', '2026_o-1.jsonl'),
      ]);
    } finally {
      cleanup(home);
    }
  });
});
