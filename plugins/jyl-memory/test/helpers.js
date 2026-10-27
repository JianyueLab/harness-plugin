import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../.temp/', import.meta.url));

/** A fresh directory under <repo>/.temp; remove it with cleanup(). */
export function tempDir(name) {
  const dir = join(ROOT, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** JSONL text: one JSON value per line, trailing newline. */
export function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
}

/** Writes JSONL to `path`, creating directories; `mtime` (Date) sets atime and mtime. */
export function writeJsonl(path, lines, mtime) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonl(lines));
  if (mtime) utimesSync(path, mtime, mtime);
}

/** A writable that records everything written. */
export function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}
