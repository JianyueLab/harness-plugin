/**
 * Per-host on-disk state: log, lock, spool, dedup window and transcript offsets.
 *
 * Every path here is rooted at `stateDir`, so two hosts (or two test runs)
 * given different directories share nothing — no lock contention, no dedup
 * bleed, no log interleaving.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

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
/** Maximum retained retry events; readers hold cursors when this queue is full. */
export const MAX_SPOOL_EVENTS = 5_000;
const MAX_LOG_BYTES = 256 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
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
    pendingDir: path.join(stateDir, "pending-units"),
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

  // Each hook owns one immutable file. A lock holder cannot consume a
  // concurrent append, and a contended hook never loses its discovery.
  function queueUnits(units, { excluded = false } = {}) {
    if (units.length === 0) return;
    fs.mkdirSync(paths.pendingDir, { recursive: true });
    const file = path.join(paths.pendingDir, `${process.pid}-${randomUUID()}.json`);
    writeTextAtomic(file, JSON.stringify({ units, excluded }));
  }

  function pendingUnits() {
    let names;
    try { names = fs.readdirSync(paths.pendingDir); } catch { return []; }
    return names.filter((name) => name.endsWith(".json")).map((name) => {
      const file = path.join(paths.pendingDir, name);
      const value = readJson(file, {});
      return { file, units: Array.isArray(value.units) ? value.units.filter((unit) => typeof unit === "string") : [], excluded: value.excluded === true };
    });
  }

  function acknowledgeUnits(entries) {
    for (const { file } of entries) {
      try { fs.unlinkSync(file); } catch { /* Already acknowledged. */ }
    }
  }

  // -------------------------------------------------------------------------
  // Lock — several sessions run hooks at the same time and share one state file
  // -------------------------------------------------------------------------

  function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  }

  // Lamport's bakery protocol serializes acquisition/reclamation. Contenders
  // own unique paths, never a replaceable guard pathname. Only dead processes'
  // immutable entries are reclaimed; a descheduled live contender is not stale.
  async function acquisitionTurn() {
    const dir = path.join(paths.dir, "lock-turns");
    fs.mkdirSync(dir, { recursive: true });
    const id = `${process.pid}-${randomUUID()}`;
    const choosing = path.join(dir, `${id}.choosing`);
    const ticketFile = path.join(dir, `${id}.ticket`);
    const deadline = Date.now() + 1200;
    const release = () => {
      for (const file of [choosing, ticketFile]) {
        try { fs.unlinkSync(file); } catch { /* Already removed. */ }
      }
    };
    const entries = () => {
      while (Date.now() < deadline) {
        const found = [];
        let changed = false;
        for (const name of fs.readdirSync(dir)) {
          const match = /^(\d+)-(.+)\.(choosing|ticket)$/.exec(name);
          if (!match) continue;
          const file = path.join(dir, name);
          if (!alive(Number(match[1]))) {
            try { fs.unlinkSync(file); } catch { /* Another reader reaped this dead entry. */ }
            continue;
          }
          try {
            found.push({ id: `${match[1]}-${match[2]}`, choosing: match[3] === "choosing", ticket: Number(fs.readFileSync(file, "utf8")) || 0 });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            // A choosing->ticket transition can replace a captured pathname.
            // Re-enumerate: dropping it could omit a live, higher-priority turn.
            changed = true;
            break;
          }
        }
        if (!changed) return found;
      }
      return null;
    };
    fs.writeFileSync(choosing, "", { flag: "wx" });
    try {
      const initial = entries();
      if (initial === null) { release(); return null; }
      const ticket = initial.reduce((max, entry) => Math.max(max, entry.ticket), 0) + 1;
      fs.writeFileSync(ticketFile, String(ticket), { flag: "wx" });
      fs.unlinkSync(choosing);
      for (;;) {
        const current = entries();
        if (current === null) { release(); return null; }
        const blocked = current.some((entry) => entry.id !== id &&
          (entry.choosing || entry.ticket < ticket || (entry.ticket === ticket && entry.id < id)));
        if (!blocked) return release;
        if (Date.now() >= deadline) { release(); return null; }
        await delay(20);
      }
    } catch (error) {
      release();
      throw error;
    }
  }

  async function withLock(fn) {
    fs.mkdirSync(paths.dir, { recursive: true });
    const releaseTurn = await acquisitionTurn();
    if (!releaseTurn) return false;
    let fd = null;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          fd = fs.openSync(paths.lockFile, "wx");
          fs.writeSync(fd, String(process.pid));
          break;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
          try {
            if (Date.now() - fs.statSync(paths.lockFile).mtimeMs > LOCK_STALE_MS) {
              const owner = Number(fs.readFileSync(paths.lockFile, "utf8"));
              if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) {
                fs.unlinkSync(paths.lockFile);
                continue;
              }
            }
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          await delay(200);
        }
      }
    } finally {
      releaseTurn();
    }
    // The hook's immutable discovery remains queued for the next lock holder.
    if (fd === null) return false;

    // Heartbeat is diagnostic only. A live process is never reclaimed solely
    // because it was paused longer than the stale interval.
    const heartbeat = setInterval(() => {
      try {
        const now = new Date();
        fs.futimesSync(fd, now, now);
      } catch {
        /* the owner is already exiting or the fd was closed */
      }
    }, LOCK_HEARTBEAT_MS);
    try {
      await fn();
    } finally {
      clearInterval(heartbeat);
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      // Never remove an externally replaced owner's lock on release.
      try {
        if (fs.readFileSync(paths.lockFile, "utf8") === String(process.pid)) {
          fs.unlinkSync(paths.lockFile);
        }
      } catch {
        /* already gone or replaced */
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
    // Usage readers stop at headroom before reaching this cap. WakaTime's
    // independent best-effort queue retains its existing drop-oldest policy.
    const kept = events.length > MAX_SPOOL_EVENTS ? events.slice(-MAX_SPOOL_EVENTS) : events;
    if (kept.length < events.length) {
      log(`spool overflow: dropped ${events.length - kept.length} oldest events`);
    }
    writeTextAtomic(paths.spoolFile, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
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

  return { ...paths, log, withLock, loadState, saveState, readSpool, writeSpool, readSeen, persistSeen, queueUnits, pendingUnits, acknowledgeUnits };
}
