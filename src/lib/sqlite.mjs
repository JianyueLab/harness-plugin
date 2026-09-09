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
import os from "node:os";
import path from "node:path";

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

/**
 * Read from `gen_metadata` using bun's built-in sqlite.
 * Returns null if the database is corrupt, locked, or has no table.
 */
export function readViaBun(Database, dbFile, afterIdx, { readonly = true } = {}) {
  try {
    const db = readonly ? new Database(dbFile, { readonly: true }) : new Database(dbFile);
    try {
      return db
        .query(SQL)
        .all(afterIdx)
        .map((r) => ({ idx: Number(r.idx), data: new Uint8Array(r.data) }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Read from `gen_metadata` using node's built-in sqlite (v22.5+).
 * Returns null if the database is corrupt, locked, or has no table.
 */
export function readViaNode(DatabaseSync, dbFile, afterIdx, { readonly = true } = {}) {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: readonly });
    try {
      return db
        .prepare(SQL)
        .all(afterIdx)
        .map((r) => ({ idx: Number(r.idx), data: new Uint8Array(r.data) }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Read from `gen_metadata` using the system `sqlite3` CLI.
 * Returns null if the database is corrupt, locked, or has no table.
 */
export function readViaCli(dbFile, afterIdx, { readonly = true } = {}) {
  try {
    // The CLI cannot hand back binary, so the blob comes over as hex.
    const args = [];
    if (readonly) args.push("-readonly");
    args.push("-noheader", "-list", "-separator", "|", dbFile);
    args.push(`SELECT idx, hex(data) FROM gen_metadata WHERE idx > ${Number(afterIdx) || 0} ORDER BY idx ASC`);
    const out = execFileSync("sqlite3", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // A corrupt or missing-table database is an expected, caught outcome
      // here (see below), not a surprise worth printing — silence stderr so
      // it does not leak past this function onto the hook's or `bun test`'s
      // own stderr. The exit code (and thus the throw the catch below relies
      // on) is unaffected by which streams are inherited.
      stdio: ["ignore", "pipe", "ignore"],
    });
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
  } catch {
    return null;
  }
}

export function readGenMetadata(dbFile, afterIdx) {
  if (!fs.existsSync(dbFile)) return [];
  const backend = pickBackend();
  if (!backend) return null;

  // Try direct read first (read-only against agy's original)
  let result;
  try {
    if (backend.kind === "bun") {
      result = readViaBun(backend.Database, dbFile, afterIdx, { readonly: true });
    } else if (backend.kind === "node") {
      result = readViaNode(backend.DatabaseSync, dbFile, afterIdx, { readonly: true });
    } else if (backend.kind === "cli") {
      result = readViaCli(dbFile, afterIdx, { readonly: true });
    }
  } catch {
    // A read failure means the database is unavailable, locked, or corrupt;
    // return null so the caller leaves the cursor unadvanced and retries later.
    return null;
  }

  // If direct read succeeded, return the result
  if (result !== null) {
    return result;
  }

  // Direct read failed. If this is a WAL-mode database that agy closed,
  // copy it to a temp file and read it in read-write mode so SQLite can
  // create the shared-memory files it needs. If it's truly corrupt, the
  // copy will also fail and return null. All filesystem operations are
  // guarded by this try/catch/finally to ensure cleanup and never throw.
  const tmpPath = path.join(
    os.tmpdir(),
    `jyl-sqlite-read-${Math.random().toString(36).slice(2)}.db`,
  );
  const tmpWal = tmpPath + "-wal";
  const tmpShm = tmpPath + "-shm";

  try {
    // Copy .db first, then -wal, then -shm. This order ensures consistency
    // if a checkpoint lands between the db and wal copy.
    fs.copyFileSync(dbFile, tmpPath);
    const walFile = dbFile + "-wal";
    if (fs.existsSync(walFile)) {
      fs.copyFileSync(walFile, tmpWal);
    }
    const shmFile = dbFile + "-shm";
    if (fs.existsSync(shmFile)) {
      fs.copyFileSync(shmFile, tmpShm);
    }

    // Read the copy in read-write mode. SQLite will create the shared-memory
    // files it needs, and all three backends work this way.
    if (backend.kind === "bun") {
      return readViaBun(backend.Database, tmpPath, afterIdx, { readonly: false });
    } else if (backend.kind === "node") {
      return readViaNode(backend.DatabaseSync, tmpPath, afterIdx, { readonly: false });
    } else if (backend.kind === "cli") {
      return readViaCli(tmpPath, afterIdx, { readonly: false });
    }
  } catch {
    // Copy failed or read failed; either way return null.
    return null;
  } finally {
    // Clean up all temp files, never let a failed delete throw.
    // The read-write open may have created -wal and -shm companions.
    for (const file of [tmpPath, tmpWal, tmpShm]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }
}
