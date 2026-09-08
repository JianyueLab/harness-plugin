/**
 * Read-only access to `agy`'s conversation databases.
 *
 * Three interchangeable backends, tried in the order that costs least: bun's
 * built-in, node's built-in (22.5+, and still flagged experimental in some
 * releases), then the `sqlite3` binary. Which one is available depends on how
 * the hook happened to be launched, so the choice cannot be made at install
 * time.
 *
 * Always read-only, never a write, never a schema change: `agy` owns these
 * files, keeps them in WAL mode, and is very likely writing to one right now.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";

/**
 * `import()` is async and every caller here is on a synchronous path, so the two
 * built-in sqlite modules are loaded through `createRequire`. Both are
 * CJS-compatible, and a runtime missing either throws — which is the signal to
 * try the next backend.
 */
const req = createRequire(import.meta.url);

const SQL = "SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC";

let cached;

function pickBackend() {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const { Database } = req("bun:sqlite");
    cached = { kind: "bun", Database };
    return cached;
  } catch {
    /* not bun */
  }
  try {
    const { DatabaseSync } = req("node:sqlite");
    cached = { kind: "node", DatabaseSync };
    return cached;
  } catch {
    /* node too old, or built without it */
  }
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    cached = { kind: "cli" };
  } catch {
    /* no sqlite3 on PATH */
  }
  return cached;
}

export function sqliteBackend() {
  return pickBackend()?.kind ?? null;
}

export function readGenMetadata(dbFile, afterIdx) {
  if (!fs.existsSync(dbFile)) return [];
  const backend = pickBackend();
  if (!backend) return null;

  if (backend.kind === "bun") {
    const db = new backend.Database(dbFile, { readonly: true });
    try {
      return db
        .query(SQL)
        .all(afterIdx)
        .map((r) => ({ idx: Number(r.idx), data: new Uint8Array(r.data) }));
    } finally {
      db.close();
    }
  }

  if (backend.kind === "node") {
    const db = new backend.DatabaseSync(dbFile, { readOnly: true });
    try {
      return db
        .prepare(SQL)
        .all(afterIdx)
        .map((r) => ({ idx: Number(r.idx), data: new Uint8Array(r.data) }));
    } finally {
      db.close();
    }
  }

  // The CLI cannot hand back binary, so the blob comes over as hex.
  const out = execFileSync(
    "sqlite3",
    ["-readonly", "-noheader", "-list", "-separator", "|", dbFile,
     `SELECT idx, hex(data) FROM gen_metadata WHERE idx > ${Number(afterIdx) || 0} ORDER BY idx ASC`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    rows.push({
      idx: Number(line.slice(0, sep)),
      data: new Uint8Array(Buffer.from(line.slice(sep + 1), "hex")),
    });
  }
  return rows;
}
