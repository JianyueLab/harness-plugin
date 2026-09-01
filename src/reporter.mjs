#!/usr/bin/env node
/**
 * jyl-usage — report Claude Code token usage to the JianyueLab LLM portal.
 *
 * Claude Code already writes everything needed: every assistant turn lands in
 * the session transcript (`~/.claude/projects/<slug>/<session>.jsonl`) carrying
 * `message.model`, `message.usage` and the vendor's `requestId`. This reads the
 * new lines of one transcript and POSTs the token counts to llm-web's
 * `/v1/usage/ingest`, so subscription spend shows up beside gateway traffic in
 * the portal instead of being invisible.
 *
 * **Only counts leave this machine.** Model id, timestamps, request id and
 * token totals — never prompts, completions, file paths, project names or
 * anything else the transcript holds.
 *
 * Design constraints, in the order they matter:
 *
 *   1. **Never slow Claude Code down, never break it.** Every hook is declared
 *      `async`, every failure path exits 0, and the only work on the hot path is
 *      reading the bytes appended since last time.
 *   2. **Never lose usage, never double-count it.** A byte offset per transcript
 *      means each line is read once; every run also sweeps the transcripts it
 *      already tracks for bytes nothing ever came back for, so a hook that lost
 *      the lock or a session that never reached SessionEnd cannot strand a
 *      turn; a failed upload spools to disk and is retried on the next hook
 *      rather than dropped; and the server dedups on request id, so a retry
 *      that actually did land inserts nothing.
 *   3. **Zero dependencies, zero build.** Plain ESM on node/bun built-ins, so
 *      the plugin is the source and there is no dist/ to keep in sync.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT = "claude-code-usage-reporter/0.2.0";
const SOURCE = "claude-code";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const STATE_DIR = path.join(CLAUDE_DIR, "jyl-usage");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SPOOL_FILE = path.join(STATE_DIR, "spool.jsonl");
const SEEN_FILE = path.join(STATE_DIR, "seen");
const LOCK_FILE = path.join(STATE_DIR, "lock");
const LOG_FILE = path.join(STATE_DIR, "log");

/** Server's per-request cap (`MAX_INGEST_EVENTS` in llm-web). Batches are split to fit. */
const BATCH_SIZE = 500;
/** Upload timeout. A hook that hangs is worse than usage reported one turn late. */
const REQUEST_TIMEOUT_MS = 10_000;
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
/** Transcripts touched within this many days are in scope for `--backfill`. */
const DEFAULT_BACKFILL_DAYS = 30;
/** Stale transcripts drained per catch-up sweep. The rest wait for the next run. */
const MAX_SWEEP_FILES = 25;
/** How long a finished transcript stays in `state.json` before being forgotten. */
const STATE_RETENTION_DAYS = 90;
/** Bump when `state.json`'s shape changes; `loadState` migrates anything older. */
const STATE_VERSION = 2;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      // Keep the tail: the interesting part of a log nobody reads until
      // something is wrong is always the end.
      const kept = fs.readFileSync(LOG_FILE, "utf8").slice(-MAX_LOG_BYTES / 2);
      fs.writeFileSync(LOG_FILE, kept);
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never be the thing that breaks a hook */
  }
}

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

const int = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Host of a URL, or null when it isn't one. Used to compare origins loosely. */
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Where to report and with what key.
 *
 * The environment wins over the file so a shell that already exports
 * `JYL_API_KEY` — the same variable `/setup` hands to Claude Code's
 * `apiKeyHelper` — needs no second copy of the secret on disk.
 *
 * `baseUrl` is the portal **origin**, not its `…/v1` base: this posts to
 * `<origin>/v1/usage/ingest`, and a value that already ends in `/v1` would
 * resolve to `/v1/v1/usage/ingest`. A trailing `/v1` is therefore stripped
 * rather than 404ing an hour later in a log nobody is reading.
 */
function loadConfig() {
  const file = readJson(CONFIG_FILE, {});
  const rawBase = process.env.JYL_USAGE_BASE_URL || process.env.JYL_LLM_BASE_URL || file.baseUrl || "";
  const baseUrl = rawBase.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return {
    baseUrl,
    apiKey: (process.env.JYL_USAGE_API_KEY || process.env.JYL_API_KEY || file.apiKey || "").trim(),
    enabled: process.env.JYL_USAGE_DISABLED === "1" ? false : file.enabled !== false,
    /**
     * Report even when this Claude Code session is itself pointed at the portal.
     * Off by default: the `/v1` proxy already metered that traffic, and
     * reporting it again would count the same tokens under both sources.
     */
    reportGatewayTraffic: file.reportGatewayTraffic === true,
  };
}

function configProblem(config) {
  if (!config.enabled) return "disabled";
  if (!config.baseUrl) return "no base URL configured";
  if (!config.apiKey) return "no API key configured";
  if (!hostOf(config.baseUrl)) return `base URL is not a URL: ${config.baseUrl}`;
  return null;
}

/**
 * True when this session's traffic already goes through the portal.
 *
 * Claude Code talks to whatever `ANTHROPIC_BASE_URL` names; when that is the
 * portal, `/v1/messages` metered every one of these turns on the way past.
 */
function alreadyMeteredByPortal(config) {
  const upstream = hostOf(process.env.ANTHROPIC_BASE_URL || "");
  return upstream !== null && upstream === hostOf(config.baseUrl);
}

// ---------------------------------------------------------------------------
// Lock — several sessions run hooks at the same time and share one state file
// ---------------------------------------------------------------------------

async function withLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fd = fs.openSync(LOCK_FILE, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // A lock left behind by a killed process would otherwise wedge reporting
      // permanently, so anything older than a minute is treated as debris.
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 60_000) {
          fs.unlinkSync(LOCK_FILE);
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
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Turn one transcript line into a reportable event, or null.
 *
 * Claude Code writes several entry kinds; only `assistant` entries carry
 * `message.usage`. Two are deliberately skipped:
 *
 *   * `model: "<synthetic>"` — messages Claude Code fabricates locally (API
 *     errors, interrupts). No request was made, so there is nothing to report.
 *   * entries whose token counts are all zero — nothing spent, and storing one
 *     would consume a dedup key for no information.
 */
function eventFromEntry(entry) {
  if (!entry || entry.type !== "assistant") return null;
  const message = entry.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;

  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (!model || model.startsWith("<")) return null;

  // Cache writes are split by TTL because the vendor prices the two differently
  // (1.25× input for 5m, 2× for 1h). Older transcripts carry only the total; it
  // goes in the 5m bucket, which is the default TTL and the cheaper guess.
  const creation = usage.cache_creation ?? {};
  const write1h = int(creation.ephemeral_1h_input_tokens);
  const write5mSplit = int(creation.ephemeral_5m_input_tokens);
  const writeTotal = int(usage.cache_creation_input_tokens);
  const write5m = Math.max(write5mSplit, writeTotal - write1h);

  const event = {
    requestId: typeof entry.requestId === "string" ? entry.requestId : undefined,
    messageId: typeof message.id === "string" ? message.id : undefined,
    ts: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
    model,
    inputTokens: int(usage.input_tokens),
    outputTokens: int(usage.output_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    cacheReadTokens: int(usage.cache_read_input_tokens),
  };
  if (!event.requestId && !event.messageId) return null;

  const total =
    event.inputTokens +
    event.outputTokens +
    event.cacheWrite5mTokens +
    event.cacheWrite1hTokens +
    event.cacheReadTokens;
  return total > 0 ? event : null;
}

/** The key both this plugin and the portal deduplicate on. */
const keyOf = (event) => event.requestId || event.messageId;

/**
 * Read the bytes appended to a transcript since `offset`.
 *
 * Only whole lines are consumed: Claude Code may be mid-write, and advancing
 * past a partial line would drop the turn it belongs to. A file that shrank was
 * rotated or replaced, so the offset restarts rather than reading from the
 * middle of an unrelated line.
 */
function readNewEvents(file, offset) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { events: [], offset, gone: true };
  }
  let from = offset > stat.size ? 0 : offset;
  if (from === stat.size) return { events: [], offset: from };

  const fd = fs.openSync(file, "r");
  let text;
  try {
    const length = stat.size - from;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, from);
    text = buf.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { events: [], offset: from }; // nothing complete yet
  const complete = text.slice(0, lastNewline + 1);

  const events = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated or corrupt line is skipped, not fatal
    }
    const event = eventFromEntry(entry);
    if (event) events.push(event);
  }
  return { events, offset: from + Buffer.byteLength(complete, "utf8") };
}

// ---------------------------------------------------------------------------
// Spool — usage that has been read but not yet accepted
// ---------------------------------------------------------------------------

function readSpool() {
  if (!fs.existsSync(SPOOL_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(SPOOL_FILE, "utf8").split("\n")) {
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
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (events.length === 0) {
    try {
      fs.unlinkSync(SPOOL_FILE);
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
  fs.writeFileSync(SPOOL_FILE, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Seen keys — what the portal has already been handed
// ---------------------------------------------------------------------------

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
    return fs.readFileSync(SEEN_FILE, "utf8").split("\n").filter(Boolean);
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
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (all.length > SEEN_COMPACT_AT) {
    writeTextAtomic(SEEN_FILE, all.slice(-SEEN_KEYS).join("\n") + "\n");
    return;
  }
  fs.appendFileSync(SEEN_FILE, added.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * POST one batch.
 *
 * The return value splits failures by whether *the same bytes* could ever
 * succeed. Network trouble, rate limits and server errors obviously can, and so
 * can 401/403: a revoked or mistyped key is a configuration problem someone
 * fixes, and discarding real usage while they do would be the plugin quietly
 * losing the thing it exists to record. Everything else — a payload this
 * version cannot produce correctly — is dropped, because retrying it forever
 * only grows the spool.
 */
async function postBatch(config, events) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/v1/usage/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ source: SOURCE, client: CLIENT, events }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, body: await res.json().catch(() => ({})) };
    const text = await res.text().catch(() => "");
    const retry =
      res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500;
    return { ok: false, retry, status: res.status, message: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, retry: true, message: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload everything, returning both a tally and whatever could not be
 * delivered. The caller owns the spool: writing it here would mean two
 * different functions deciding what is still owed.
 */
async function upload(config, events) {
  const tally = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, spooled: 0 };
  const failed = [];

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const result = await postBatch(config, batch);
    tally.sent += batch.length;
    if (result.ok) {
      tally.accepted += result.body.accepted ?? 0;
      tally.duplicates += result.body.duplicates ?? 0;
      const bad = result.body.rejected ?? [];
      tally.rejected += bad.length;
      if (bad.length > 0) log(`portal rejected ${bad.length} event(s): ${JSON.stringify(bad.slice(0, 5))}`);
    } else if (result.retry) {
      failed.push(...batch);
      log(`upload failed (will retry): ${result.status ?? "network"} ${result.message}`);
    } else {
      log(`upload rejected, dropping ${batch.length} event(s): ${result.status} ${result.message}`);
    }
  }

  tally.spooled = failed.length;
  return { tally, failed };
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

function loadState() {
  const raw = readJson(STATE_FILE, null);
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

/**
 * Decide which transcripts this run reads, and forget the entries it should.
 *
 * **The sweep is what makes automatic reporting whole.** Before it, a run only
 * ever read the transcript Claude Code named in the hook payload — so a turn
 * written after a session's last hook, or a hook that lost the lock to a
 * concurrent session and bowed out, left bytes that nothing would ever come
 * back for. They were not late; they were gone, recoverable only if someone
 * thought to run `--backfill`. On the machine this was written for, three
 * transcripts had been sitting on 410k unreported tokens, one of them for ten
 * days. Anything still tracked whose file has grown past its offset is now
 * picked up by whichever session next fires a hook. Age is not a reason to
 * skip one: the portal accepts events up to 400 days old.
 *
 * Pruning shares the walk because it needs the same `stat` per transcript. It
 * used to wait until 200 files had accumulated to avoid that walk — a
 * threshold that in practice never tripped, so `state.json` only ever grew.
 * The walk now happens anyway, and a few dozen stats is a rounding error
 * beside the HTTP request at the end of the run.
 *
 * Freshest first, and capped: a run that drains `MAX_SWEEP_FILES` has done
 * more than its share, and the next one resumes where it stopped. Dropping an
 * entry stays safe in the direction that matters — a transcript that is still
 * around and later grows is re-read from byte zero, and the portal stores none
 * of it twice.
 */
function sweepTargets(state, explicit, sweep) {
  const cutoff = Date.now() - STATE_RETENTION_DAYS * 86_400_000;
  const stale = [];
  for (const [file, entry] of Object.entries(state.files)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      delete state.files[file]; // transcript deleted
      continue;
    }
    if (stat.mtimeMs < cutoff) {
      delete state.files[file];
      continue;
    }
    if (!sweep || explicit.includes(file)) continue;
    if (stat.size > (entry.offset ?? 0)) stale.push({ file, mtimeMs: stat.mtimeMs });
  }

  stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = stale.slice(0, MAX_SWEEP_FILES);
  if (stale.length > picked.length) {
    log(`sweep: ${stale.length - picked.length} stale transcript(s) held over to the next run`);
  }
  return [...explicit, ...picked.map((s) => s.file)];
}

/**
 * Read one transcript's new events and advance its offset.
 *
 * Deduplication used to happen here, against that transcript's own key list.
 * It moved out to `report`, where one window spans every transcript — the only
 * place a fork of an earlier session can be recognised for what it is.
 */
function collect(state, file) {
  const entry = state.files[file] ?? { offset: 0 };
  const { events, offset, gone } = readNewEvents(file, entry.offset);
  if (gone) {
    delete state.files[file];
    return [];
  }
  state.files[file] = { offset };
  return events;
}

/** Every transcript touched in the last `days` days. */
function recentTranscripts(days) {
  const projects = path.join(CLAUDE_DIR, "projects");
  const cutoff = Date.now() - days * 86_400_000;
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          if (fs.statSync(full).mtimeMs >= cutoff) out.push(full);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(projects);
  return out;
}

/**
 * One reporting pass: whatever is owed from last time, plus whatever the given
 * transcripts — and, with `sweep`, the ones nothing came back for — have
 * appended since.
 *
 * Both durable writes happen **after** the upload, and in this order: the spool
 * (what is still owed) then the offsets (what has been read). Every crash window
 * that leaves therefore re-reads lines rather than losing them, and re-read
 * lines are free — the portal deduplicates on request id and stores nothing the
 * second time. The reverse order would trade a harmless duplicate for a
 * permanently missing turn.
 *
 * An upload that failed still advances the offset, because those events are on
 * the spool now; not advancing is what would make the same lines be read for
 * ever.
 */
async function report(config, files, { sweep = false } = {}) {
  const state = loadState();
  const carried = state.carried ?? [];
  delete state.carried;

  const targets = sweepTargets(state, files, sweep);
  const stateBefore = JSON.stringify(state, null, 2);

  const found = [];
  for (const file of targets) found.push(...collect(state, file));

  // The dedup window is only read when there is something to check against it,
  // which leaves a hook with no new turns at a stat per tracked transcript and
  // no large file touched at all.
  let fresh = found;
  let dedupWindow = null;
  let added = [];
  if (found.length > 0 || carried.length > 0) {
    dedupWindow = [...readSeen(), ...carried];
    added = [...carried];
    const seen = new Set(dedupWindow);
    fresh = [];
    for (const event of found) {
      const key = keyOf(event);
      if (seen.has(key)) continue;
      seen.add(key);
      dedupWindow.push(key);
      added.push(key);
      fresh.push(event);
    }
  }
  const known = found.length - fresh.length;

  // Offsets and dedup keys are recorded together, and only once the upload has
  // had its say. Writing `state.json` unconditionally was the one cost this
  // plugin paid on a turn where it had nothing to do.
  const persist = () => {
    if (dedupWindow) persistSeen(dedupWindow, added);
    const stateAfter = JSON.stringify(state, null, 2);
    if (stateAfter !== stateBefore) writeTextAtomic(STATE_FILE, stateAfter);
  };

  const pending = readSpool();
  const all = [...pending, ...fresh];
  if (all.length === 0) {
    // Still record the offsets: the lines just read were real, they simply
    // held no usage (user turns, tool results), and re-reading them is waste.
    persist();
    return { sent: 0, accepted: 0, duplicates: 0, rejected: 0, spooled: 0, known };
  }

  const { tally, failed } = await upload(config, all);
  writeSpool(failed);
  persist();

  log(
    `reported ${tally.sent} event(s) from ${targets.length} transcript(s): ` +
      `${tally.accepted} accepted, ${tally.duplicates} duplicate, ` +
      `${tally.rejected} rejected, ${tally.spooled} spooled` +
      (known > 0 ? `, ${known} skipped as already sent` : ""),
  );
  return { ...tally, known };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Read the hook payload Claude Code writes to stdin. `{}` when there is none. */
async function readHookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function redactKey(key) {
  if (!key) return "(unset)";
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function status(config) {
  const state = loadState();
  const spool = readSpool();
  const problem = configProblem(config);

  // What the next hook's sweep will pick up. Reported because a number here is
  // the difference between "nothing to do" and usage that has not been sent.
  let waitingFiles = 0;
  let waitingBytes = 0;
  for (const [file, entry] of Object.entries(state.files)) {
    try {
      const size = fs.statSync(file).size;
      if (size > (entry.offset ?? 0)) {
        waitingFiles += 1;
        waitingBytes += size - (entry.offset ?? 0);
      }
    } catch {
      /* transcript deleted; the next run forgets it */
    }
  }

  const lines = [
    "jyl-usage — Claude Code → llm-web usage reporter",
    "",
    `  portal:      ${config.baseUrl || "(unset)"}`,
    `  api key:     ${redactKey(config.apiKey)}`,
    `  enabled:     ${config.enabled}`,
    `  config file: ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? "" : " (absent)"}`,
    `  status:      ${problem ? `NOT reporting — ${problem}` : "ready"}`,
    "",
    `  transcripts tracked:   ${Object.keys(state.files).length}`,
    `  unread tails:          ${waitingFiles} transcript(s), ${waitingBytes} byte(s) — the next hook sweeps these`,
    `  events awaiting retry: ${spool.length}`,
    `  dedup window:          ${readSeen().length} key(s)`,
  ];
  if (alreadyMeteredByPortal(config) && !config.reportGatewayTraffic) {
    lines.push(
      "",
      "  NOTE: ANTHROPIC_BASE_URL points at the portal, so this session's",
      "        traffic is metered by the /v1 proxy already and is not reported.",
    );
  }
  if (fs.existsSync(LOG_FILE)) {
    const tail = fs.readFileSync(LOG_FILE, "utf8").trimEnd().split("\n").slice(-8);
    lines.push("", "  recent log:", ...tail.map((l) => `    ${l}`));
  }
  console.log(lines.join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => a.startsWith("--")) ?? "--hook";
  const config = loadConfig();

  if (command === "--status") return status(config);

  const problem = configProblem(config);
  if (problem) {
    // Silent on the hook path: an unconfigured plugin must be inert, not noisy.
    if (command !== "--hook") console.error(`jyl-usage: not reporting — ${problem}`);
    return;
  }

  if (alreadyMeteredByPortal(config) && !config.reportGatewayTraffic) {
    if (command !== "--hook") {
      console.error(
        "jyl-usage: this session talks to the portal directly, so /v1 already metered it. " +
          'Set "reportGatewayTraffic": true in the config to report anyway.',
      );
    }
    return;
  }

  if (command === "--backfill") {
    const days = Number(args.find((a) => /^\d+$/.test(a))) || DEFAULT_BACKFILL_DAYS;
    const files = recentTranscripts(days);
    const ran = await withLock(async () => {
      const t = await report(config, files);
      console.log(
        `jyl-usage: scanned ${files.length} transcript(s) from the last ${days} day(s) — ` +
          `${t.accepted} new, ${t.duplicates} already reported, ${t.spooled} queued for retry.`,
      );
    });
    if (!ran) console.error("jyl-usage: another run holds the lock; try again in a moment.");
    return;
  }

  if (command === "--flush") {
    const ran = await withLock(async () => {
      const t = await report(config, []);
      console.log(`jyl-usage: flushed ${t.sent} queued event(s) — ${t.accepted} accepted.`);
    });
    if (!ran) console.error("jyl-usage: another run holds the lock; try again in a moment.");
    return;
  }

  // Default: the hook path — the transcript Claude Code just named, plus a
  // catch-up sweep over the ones already tracked that have grown since anything
  // last read them. The sweep is why this is the path that changed: a lost lock
  // or a session that never reached SessionEnd used to strand a turn for good,
  // and `--backfill` only helped the people who knew to run it.
  const hook = await readHookInput();
  const transcript = typeof hook.transcript_path === "string" ? hook.transcript_path : null;
  await withLock(() => report(config, transcript ? [transcript] : [], { sweep: true }));
}

main().catch((err) => {
  log(`unhandled: ${err?.stack ?? err}`);
  // Exiting non-zero would surface an error in Claude Code for a plugin whose
  // entire job is bookkeeping. The log is where failures belong.
  process.exit(0);
});
