/**
 * WakaTime on-disk state: log, lock, heartbeat spool and run bookkeeping.
 *
 * Every path is rooted at `stateDir`; different directories share no state.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Maximum retained retry heartbeats. */
const MAX_SPOOL_EVENTS = 5_000;
const MAX_LOG_BYTES = 256 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
/** State format used by existing WakaTime installations. */
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
    stateFile: path.join(stateDir, "state.json"),
    spoolFile: path.join(stateDir, "spool.jsonl"),
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
  // Spool — heartbeats not yet accepted
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
    // Retain the newest heartbeats when the retry queue reaches its cap.
    const kept = events.length > MAX_SPOOL_EVENTS ? events.slice(-MAX_SPOOL_EVENTS) : events;
    if (kept.length < events.length) {
      log(`spool overflow: dropped ${events.length - kept.length} oldest events`);
    }
    writeTextAtomic(paths.spoolFile, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  // -------------------------------------------------------------------------
  // State — throttle table, project cache and send status
  // -------------------------------------------------------------------------

  function loadState() {
    const raw = readJson(paths.stateFile, null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== STATE_VERSION) {
      return { version: STATE_VERSION };
    }
    return raw;
  }

  function saveState(state) {
    writeTextAtomic(paths.stateFile, JSON.stringify(state, null, 2));
  }

  return { ...paths, log, withLock, loadState, saveState, readSpool, writeSpool };
}
