/**
 * Per-host on-disk state: log, lock, spool, dedup window and transcript offsets.
 *
 * Every path here is rooted at `stateDir`, so two hosts (or two test runs)
 * given different directories share nothing — no lock contention, no dedup
 * bleed, no log interleaving.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Dedup keys kept in `seen` — globally, not per transcript.
 *
 * Per transcript was the wrong axis. Resuming or forking a session copies the
 * history into a *new* transcript file, so every already-reported turn in it
 * looked new and was POSTed again for the portal to reject: one observed run
 * sent 82 events to have 72 of them recognised at the far end. One shared
 * window recognises them here instead.
 */
const SEEN_KEYS = 3_000;
/** Rewrite `seen` once it has grown this far past the window; until then, append. */
const SEEN_COMPACT_AT = 4_500;
/** Spool ceiling. Past this the portal has been unreachable for a very long time. */
const MAX_SPOOL_EVENTS = 5_000;
const MAX_LOG_BYTES = 256 * 1024;
/** Bump when `state.json`'s shape changes; `loadState` migrates anything older. */
const STATE_VERSION = 2;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function createStore(stateDir) {
  const paths = {
    dir: stateDir,
    configFile: path.join(stateDir, "config.json"),
    stateFile: path.join(stateDir, "state.json"),
    spoolFile: path.join(stateDir, "spool.jsonl"),
    seenFile: path.join(stateDir, "seen"),
    lockFile: path.join(stateDir, "lock"),
    logFile: path.join(stateDir, "log"),
  };

  function log(message) {
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      if (fs.existsSync(paths.logFile) && fs.statSync(paths.logFile).size > MAX_LOG_BYTES) {
        // Keep the tail: the interesting part of a log nobody reads until
        // something is wrong is always the end.
        const kept = fs.readFileSync(paths.logFile, "utf8").slice(-MAX_LOG_BYTES / 2);
        fs.writeFileSync(paths.logFile, kept);
      }
      fs.appendFileSync(paths.logFile, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* logging must never be the thing that breaks a hook */
    }
  }

  // -------------------------------------------------------------------------
  // Lock — several sessions run hooks at the same time and share one state file
  // -------------------------------------------------------------------------

  async function withLock(fn) {
    fs.mkdirSync(paths.dir, { recursive: true });
    let fd = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fd = fs.openSync(paths.lockFile, "wx");
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // A lock left behind by a killed process would otherwise wedge reporting
        // permanently, so anything older than a minute is treated as debris.
        try {
          if (Date.now() - fs.statSync(paths.lockFile).mtimeMs > 60_000) {
            fs.unlinkSync(paths.lockFile);
            continue;
          }
        } catch {
          continue;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // Still contended: another hook run holds it and will drain the same shared
    // state. Bowing out is correct — the next Stop or SessionEnd picks this up.
    if (fd === null) return false;

    try {
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      await fn();
    } finally {
      try {
        fs.unlinkSync(paths.lockFile);
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Spool — usage that has been read but not yet accepted
  // -------------------------------------------------------------------------

  function readSpool() {
    if (!fs.existsSync(paths.spoolFile)) return [];
    const out = [];
    for (const line of fs.readFileSync(paths.spoolFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  function writeSpool(events) {
    fs.mkdirSync(paths.dir, { recursive: true });
    if (events.length === 0) {
      try {
        fs.unlinkSync(paths.spoolFile);
      } catch {
        /* already gone */
      }
      return;
    }
    // Drop the oldest first: newer usage is likelier to still be inside the
    // portal's acceptance window, so it is the half worth keeping.
    const kept = events.slice(-MAX_SPOOL_EVENTS);
    if (kept.length < events.length) {
      log(`spool overflow: dropped ${events.length - kept.length} oldest events`);
    }
    fs.writeFileSync(paths.spoolFile, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  // -------------------------------------------------------------------------
  // Seen keys — what the portal has already been handed
  // -------------------------------------------------------------------------

  /**
   * The dedup window, newest last.
   *
   * Two different things repeat a key. Claude Code writes one transcript entry
   * per content block, so a single API response restates its `requestId` and its
   * `usage` verbatim across several lines; and resuming a session copies the
   * whole history into a new transcript file. Either way the portal would reject
   * the repeat — filtering here just saves the round trip, and stops a healthy
   * run from logging like a broken one.
   *
   * It lives in its own file rather than inside `state.json` because
   * `state.json` is rewritten on every turn and this is the part of it that
   * grows: on one machine it had reached 162 KB, of which the keys were 150. Kept
   * apart, the hot path appends a few dozen bytes here and rewrites three
   * kilobytes there.
   */
  function readSeen() {
    try {
      return fs.readFileSync(paths.seenFile, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Persist the window: `all` is every key now known in order, `added` the tail
   * this run contributed.
   *
   * Appending is the hot path, so the full rewrite that enforces the window is
   * amortised — the file is allowed to overshoot to `SEEN_COMPACT_AT` and is then
   * trimmed back to `SEEN_KEYS` in one go. Dropping the oldest is safe: a key
   * ages out only once its transcript has long been read to the end, and if one
   * ever does come back the portal still refuses to store it twice.
   */
  function persistSeen(all, added) {
    if (added.length === 0) return;
    fs.mkdirSync(paths.dir, { recursive: true });
    if (all.length > SEEN_COMPACT_AT) {
      writeTextAtomic(paths.seenFile, all.slice(-SEEN_KEYS).join("\n") + "\n");
      return;
    }
    fs.appendFileSync(paths.seenFile, added.join("\n") + "\n");
  }

  // -------------------------------------------------------------------------
  // State — per-transcript byte offsets
  // -------------------------------------------------------------------------

  function loadState() {
    const raw = readJson(paths.stateFile, null);
    if (!raw || typeof raw !== "object" || !raw.files) return { version: STATE_VERSION, files: {} };
    if (raw.version === STATE_VERSION) return raw;

    // v1 → v2. Offsets carry over untouched; the per-transcript `seen` arrays are
    // folded into the one global window, so an upgrade costs nothing — none of
    // what v1 had already reported makes a second trip to the portal just
    // because the file layout changed. `carried` is transient: `report` writes it
    // into `seen` and deletes it before the state is serialised.
    const state = { version: STATE_VERSION, files: {}, carried: [] };
    for (const [file, entry] of Object.entries(raw.files)) {
      if (!entry || typeof entry !== "object") continue;
      state.files[file] = { offset: Number.isFinite(entry.offset) ? entry.offset : 0 };
      for (const key of Array.isArray(entry.seen) ? entry.seen : []) state.carried.push(key);
    }
    return state;
  }

  function saveState(state) {
    writeTextAtomic(paths.stateFile, JSON.stringify(state, null, 2));
  }

  return { ...paths, log, withLock, loadState, saveState, readSpool, writeSpool, readSeen, persistSeen };
}
