/**
 * The Claude Code host adapter.
 *
 * Claude Code already writes everything needed: every assistant turn lands in
 * the session transcript (`~/.claude/projects/<slug>/<session>.jsonl`) carrying
 * `message.model`, `message.usage` and the vendor's `requestId`. A "unit" here
 * is one transcript file, and the entry the core stores for it is a byte offset
 * — the point everything before which has already been read.
 *
 * **Only counts leave this machine.** Model id, timestamps, request id and
 * token totals — never prompts, completions, file paths, project names or
 * anything else the transcript holds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostOf } from "../core/config.mjs";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const int = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

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

/** The token counts a request's lines are merged over. */
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "cacheReadTokens",
];

/**
 * How long a transcript must go unwritten before a request in it with no stop
 * reason is taken as final. The longest gap observed between two lines of one
 * request is about seven minutes.
 */
export const QUIET_MS = 30 * 60_000;

/** The request an assistant entry belongs to, whether or not it is reportable. */
function requestKeyOf(entry) {
  if (!entry || entry.type !== "assistant") return null;
  if (typeof entry.requestId === "string" && entry.requestId) return entry.requestId;
  const id = entry.message?.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Read the bytes appended to a transcript since `offset`.
 *
 * Only whole lines are consumed: Claude Code may be mid-write, and advancing
 * past a partial line would drop the turn it belongs to. A file that shrank was
 * rotated or replaced, so the offset restarts rather than reading from the
 * middle of an unrelated line.
 *
 * Claude Code writes one line per content block, all under one request id, and
 * a line written before the response finished carries the `output_tokens`
 * counted so far. The lines of one request are merged into one event holding the
 * largest count of each kind. A request is emitted only once it is settled:
 *
 *   * one of its lines has a `stop_reason` — that line carries the final usage;
 *   * an assistant line of a different request follows it — requests do not
 *     interleave, so the next request starting means this one ended; or
 *   * the transcript has not been written for `QUIET_MS`.
 *
 * An unsettled request is held back: the cursor stops at its first line, so the
 * next run reads it again whole. Emitting it early would put its key in the
 * dedup window, and the complete line read later would be dropped as sent.
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
  let buf;
  try {
    const length = stat.size - from;
    buf = Buffer.allocUnsafe(length);
    buf = buf.subarray(0, fs.readSync(fd, buf, 0, length, from));
  } finally {
    fs.closeSync(fd);
  }

  const end = buf.lastIndexOf(0x0a) + 1;
  if (end === 0) return { events: [], offset: from }; // nothing complete yet

  /** key → { start, event, settled }, in order of first appearance. */
  const requests = new Map();
  let previous = null;
  for (let start = 0; start < end; ) {
    const newline = buf.indexOf(0x0a, start);
    const line = buf.toString("utf8", start, newline);
    const lineStart = start;
    start = newline + 1;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated or corrupt line is skipped, not fatal
    }
    const key = requestKeyOf(entry);
    if (key === null) continue;

    if (previous !== null && previous !== key) requests.get(previous).settled = true;
    previous = key;

    let request = requests.get(key);
    if (!request) {
      request = { start: lineStart, event: null, settled: false };
      requests.set(key, request);
    }
    if (typeof entry.message?.stop_reason === "string") request.settled = true;

    const event = eventFromEntry(entry);
    if (!event) continue;
    if (!request.event) {
      request.event = event;
      continue;
    }
    for (const field of TOKEN_FIELDS) {
      request.event[field] = Math.max(request.event[field], event[field]);
    }
    request.event.requestId ??= event.requestId;
    request.event.messageId ??= event.messageId;
  }

  const quiet = Date.now() - stat.mtimeMs >= QUIET_MS;
  const events = [];
  let held = end;
  for (const request of requests.values()) {
    if (!request.settled && !quiet) held = Math.min(held, request.start);
    else if (request.event) events.push(request.event);
  }
  return { events, offset: from + held };
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

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const host = {
  id: "claude-code",
  source: "claude-code",
  client: "claude-code-usage-reporter/0.3.0",
  title: "jyl-usage — Claude Code → llm-web usage reporter",
  unitLabel: "transcript",
  stateDir: path.join(CLAUDE_DIR, "jyl-usage"),
  unitsFromHook: (hook) => (typeof hook.transcript_path === "string" ? [hook.transcript_path] : []),
  recentUnits: (days) => recentTranscripts(days),
  probe(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return null;
    }
    return { mtimeMs: stat.mtimeMs, pending: Math.max(0, stat.size - (entry.offset ?? 0)) };
  },
  // `pending` here is bytes, so the total across every tracked transcript is a
  // real figure worth showing — the difference between a three-byte tail and a
  // four-hundred-kilobyte one is exactly what tells someone whether the plugin
  // is quietly stuck.
  describePending: (count, totalPending) => `${count} transcript(s), ${totalPending} byte(s)`,
  read(unit, entry) {
    const { events, offset, gone } = readNewEvents(unit, entry.offset ?? 0);
    return gone ? { events: [], entry: null } : { events, entry: { offset } };
  },
  skipReason(config) {
    if (config.reportGatewayTraffic) return null;
    return alreadyMeteredByPortal(config)
      ? "this session talks to the portal directly, so /v1 already metered it"
      : null;
  },
  statusNotes(config) {
    if (!alreadyMeteredByPortal(config) || config.reportGatewayTraffic) return [];
    return [
      "",
      "  NOTE: ANTHROPIC_BASE_URL points at the portal, so this session's",
      "        traffic is metered by the /v1 proxy already and is not reported.",
    ];
  },
};
