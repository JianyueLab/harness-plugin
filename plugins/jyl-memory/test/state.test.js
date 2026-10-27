import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_STALE_MS, StateError, loadState, saveState, unsentMessages, withLock } from '../src/state.mjs';
import { cleanup, tempDir } from './helpers.js';

const session = { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] };

describe('state file', () => {
  let dir;
  beforeEach(() => { dir = tempDir('state'); });
  afterEach(() => cleanup(dir));

  test('a missing file is an empty state', () => {
    expect(loadState(join(dir, 'none.json'))).toEqual({ version: 1, sessions: {} });
  });

  test('save then load round-trips with mode 0600', () => {
    const path = join(dir, 'jyl-memory', 'state.json');
    const state = { version: 1, sessions: { 'omp:a': { decision: 'skipped', sent_message_ids: [], updated_at: 't' } } };
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('invalid JSON and unknown versions are errors, not silent resets', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{nope');
    expect(() => loadState(bad)).toThrow(StateError);
    writeFileSync(bad, JSON.stringify({ version: 2, sessions: {} }));
    expect(() => loadState(bad)).toThrow(StateError);
  });
});

describe('unsentMessages', () => {
  test('a session without a record has every message pending', () => {
    expect(unsentMessages(session, undefined).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  test('messages already recorded are excluded', () => {
    expect(unsentMessages(session, { sent_message_ids: ['m1', 'm2'] }).map((m) => m.id)).toEqual(['m3']);
  });
});

describe('withLock', () => {
  let dir;
  beforeEach(() => { dir = tempDir('lock'); });
  afterEach(() => cleanup(dir));

  test('runs fn and removes the lock', async () => {
    expect(await withLock(dir, async () => 42)).toBe(42);
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  test('removes the lock when fn throws', async () => {
    await expect(withLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  test('a held lock fails after waitMs', async () => {
    writeFileSync(join(dir, 'lock'), '');
    await expect(withLock(dir, async () => 1, { waitMs: 0 })).rejects.toThrow(StateError);
  });

  test('a stale lock is taken over', async () => {
    const lock = join(dir, 'lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(lock, old, old);
    expect(await withLock(dir, async () => 'ok', { waitMs: 0 })).toBe('ok');
  });

  test('a lock held longer than staleMs is refreshed, not taken over', async () => {
    const opts = { staleMs: 150, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let firstDone = false;
    const first = withLock(dir, async () => { await wait(450); firstDone = true; return 'first'; }, opts);
    await wait(250);
    await expect(withLock(dir, async () => 'second', { ...opts, waitMs: 50 })).rejects.toThrow(StateError);
    expect(firstDone).toBe(false);
    expect(await first).toBe('first');
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  test('release leaves a lock that holds another run\'s token', async () => {
    const lock = join(dir, 'lock');
    await withLock(dir, async () => { writeFileSync(lock, 'other-token'); });
    expect(readFileSync(lock, 'utf8')).toBe('other-token');
  });
});
