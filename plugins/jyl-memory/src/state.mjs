import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class StateError extends Error {}

export const LOCK_STALE_MS = 60_000;

export function loadState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sessions: {} };
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StateError(`state file is not valid JSON: ${path}`);
  }
  if (!data || data.version !== 1 || typeof data.sessions !== 'object' || data.sessions === null) {
    throw new StateError(`state file has an unknown format: ${path}`);
  }
  return data;
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Runs `fn` while holding `<dir>/lock`. The lock holds a per-run token; its mtime is refreshed every
 * staleMs/3 while `fn` runs. A lock older than `staleMs` is taken over. Release removes the lock only
 * if it still holds this run's token.
 */
export async function withLock(dir, fn, { now = Date.now, waitMs = 5000, staleMs = LOCK_STALE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'lock');
  const token = randomUUID();
  const deadline = now() + waitMs;
  for (;;) {
    let fd;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age;
      try {
        age = now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > staleMs) {
        rmSync(lock, { force: true });
        continue;
      }
      if (now() >= deadline) throw new StateError('another jyl-memory run holds the lock');
      await sleep(100);
      continue;
    }
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    break;
  }
  const touch = () => {
    const t = new Date(now());
    try {
      utimesSync(lock, t, t);
    } catch {
      // lock removed or replaced; release checks ownership
    }
  };
  touch();
  const timer = setInterval(touch, Math.max(1, Math.floor(staleMs / 3)));
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    let held;
    try {
      held = readFileSync(lock, 'utf8');
    } catch {
      held = undefined;
    }
    if (held === token) rmSync(lock, { force: true });
  }
}

/** Messages not yet uploaded, in session order. Ignores the decision. */
export function unsentMessages(session, record) {
  const sent = new Set(record?.sent_message_ids ?? []);
  return session.messages.filter((m) => !sent.has(m.id));
}
