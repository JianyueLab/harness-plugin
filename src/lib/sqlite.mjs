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
export function readViaBun(Database, dbFile, afterIdx) {
  try {
    const db = new Database(dbFile, { readonly: true });
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
export function readViaNode(DatabaseSync, dbFile, afterIdx) {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
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
export function readViaCli(dbFile, afterIdx) {
  try {
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
  } catch {
    return null;
  }
}

/**
 * Copy a WAL-mode database to a temp location so it can be read even after
 * agy has closed it and deleted the -wal and -shm files. Returns the path to
 * the temp copy and three paths to clean up (which may not all exist).
 *
 * Copy order matters: .db first, then -wal, then -shm. If a checkpoint lands
 * between the db and wal copy, the wal's salt no longer matches, which SQLite
 * ignores — yielding a consistent, slightly stale read rather than a corrupt one.
 *
 * If the copy is missing the -shm file (because agy deleted it), we convert
 * the database from WAL mode to DELETE mode so queries can proceed.
 */
function copyWalDatabase(dbFile, Database, DatabaseSync) {
  const tmpPath = path.join(
    os.tmpdir(),
    `jyl-sqlite-read-${Math.random().toString(36).slice(2)}.db`,
  );
  const tmpWal = tmpPath + "-wal";
  const tmpShm = tmpPath + "-shm";

  // Copy .db first
  fs.copyFileSync(dbFile, tmpPath);

  // Copy -wal if it exists
  const walFile = dbFile + "-wal";
  if (fs.existsSync(walFile)) {
    fs.copyFileSync(walFile, tmpWal);
  }

  // Copy -shm if it exists
  const shmFile = dbFile + "-shm";
  if (fs.existsSync(shmFile)) {
    fs.copyFileSync(shmFile, tmpShm);
  } else if (Database) {
    // If -shm doesn't exist (agy closed the database), convert from WAL to DELETE mode
    // so we can query the copy. This requires write access to the temp file.
    try {
      const db = new Database(tmpPath);
      db.run("PRAGMA journal_mode = DELETE");
      db.close();
    } catch {
      // If conversion fails, just proceed; the caller will get null from the query
    }
  }

  return { tmpPath, tmpWal, tmpShm };
}

export function readGenMetadata(dbFile, afterIdx) {
  if (!fs.existsSync(dbFile)) return [];
  const backend = pickBackend();
  if (!backend) return null;

  // Try direct read first
  let result;
  try {
    if (backend.kind === "bun") {
      result = readViaBun(backend.Database, dbFile, afterIdx);
    } else if (backend.kind === "node") {
      result = readViaNode(backend.DatabaseSync, dbFile, afterIdx);
    } else if (backend.kind === "cli") {
      result = readViaCli(dbFile, afterIdx);
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
  // copy it to a temp file and retry. If it's truly corrupt, the copy
  // will also fail and return null.
  const { tmpPath, tmpWal, tmpShm } = copyWalDatabase(
    dbFile,
    backend.kind === "bun" ? backend.Database : null,
    backend.kind === "node" ? backend.DatabaseSync : null,
  );
  try {
    if (backend.kind === "bun") {
      return readViaBun(backend.Database, tmpPath, afterIdx);
    } else if (backend.kind === "node") {
      return readViaNode(backend.DatabaseSync, tmpPath, afterIdx);
    } else if (backend.kind === "cli") {
      return readViaCli(tmpPath, afterIdx);
    }
  } catch {
    return null;
  } finally {
    // Clean up temp files, never let a failed delete throw
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpWal);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpShm);
    } catch {
      /* ignore */
    }
  }
}
