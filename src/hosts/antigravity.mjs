/**
 * Antigravity CLI → llm-web.
 *
 * `agy` records nothing about token spend where a reporter could simply read
 * it: the transcript it hands hooks carries steps and no counts, the logs carry
 * none, and `agentapi get-conversation-metadata` returns a title and some ids.
 * The only local copy is one protobuf blob per generation in
 * `conversations/<id>.db`, which is why this host reads SQLite while the Claude
 * Code host reads appended lines.
 *
 * The cursor is therefore a row index rather than a byte offset, and the mtime
 * rides along with it because a database's size says nothing about whether it
 * gained a row.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGenMetadata, sqliteBackend } from "../lib/sqlite.mjs";
import { eventFromBlob } from "./antigravity/extract.mjs";

const CLI_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");

/** Mutable so tests can point the adapter at a fixture tree. */
export const roots = {
  conversations: path.join(CLI_DIR, "conversations"),
  brain: path.join(CLI_DIR, "brain"),
};

const conversationId = (dbFile) => path.basename(dbFile, ".db");

/**
 * `gen_metadata.idx` is the same sequence as the transcript's `step_index` —
 * both tables in the database are keyed on it, and a generation at idx 40 is
 * step 40 in `transcript.jsonl`, whose `created_at` is the only real timestamp
 * on offer. Confirmed against agy 1.1.27 (`agy --version`) — 2.12.0, cited by
 * an earlier pass of this comment, is the Antigravity.app desktop bundle's
 * version, not the CLI's.
 */
export function timestampsFor(dbFile) {
  const file = path.join(roots.brain, conversationId(dbFile), ".system_generated", "logs", "transcript.jsonl");
  const out = new Map();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (typeof step.step_index === "number" && typeof step.created_at === "string") {
        out.set(step.step_index, step.created_at);
      }
    } catch {
      /* a half-written line is skipped, not fatal */
    }
  }
  return out;
}

export const host = {
  id: "antigravity",
  source: "antigravity",
  client: "antigravity-usage-reporter/0.3.0",
  title: "jyl-usage — Antigravity CLI → llm-web usage reporter",
  unitLabel: "conversation",
  stateDir: path.join(os.homedir(), ".gemini", "jyl-usage"),

  unitsFromHook(hook) {
    const id = typeof hook.conversationId === "string" ? hook.conversationId : null;
    return id ? [path.join(roots.conversations, `${id}.db`)] : [];
  },

  recentUnits(days) {
    const cutoff = Date.now() - days * 86_400_000;
    let names;
    try {
      names = fs.readdirSync(roots.conversations);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".db")) continue;
      const full = path.join(roots.conversations, name);
      try {
        if (fs.statSync(full).mtimeMs >= cutoff) out.push(full);
      } catch {
        /* vanished mid-walk */
      }
    }
    return out;
  },

  probe(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return null;
    }
    return { mtimeMs: stat.mtimeMs, pending: stat.mtimeMs > (entry.mtimeMs ?? 0) ? 1 : 0 };
  },

  /**
   * `log`, when given, is `store.log` — called at most once per read, and only
   * with numbers. This is the whole visibility story for an inferred field
   * mapping: a row that fails a guard does not just vanish into `extract.mjs`'s
   * `null`, it is counted here (where the row count is known) and surfaced
   * both in the log and, cumulatively via `entry.skipped`, in `--status` — see
   * `reporter.mjs`'s `status()`. Logging from inside `read()` rather than from
   * `report()` means the line is written during the walk itself, before
   * `report()` ever decides whether there was anything left to upload — so a
   * conversation that skips every row is not indistinguishable from an idle
   * machine just because zero events made it out the other end.
   */
  read(unit, entry, log) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return { events: [], entry: null };
    }
    const after = Number.isFinite(entry.idx) ? entry.idx : -1;
    const rows = readGenMetadata(unit, after);
    if (rows === null) return { events: [], entry }; // no sqlite backend; try again later
    if (rows.length === 0) {
      return { events: [], entry: { idx: after, mtimeMs: stat.mtimeMs, skipped: entry.skipped ?? 0 } };
    }

    const stamps = timestampsFor(unit);
    const fallback = new Date(stat.mtimeMs).toISOString();
    const events = [];
    let highest = after;
    let skippedThisRead = 0;
    for (const row of rows) {
      highest = Math.max(highest, row.idx);
      const event = eventFromBlob(row.data, { ts: stamps.get(row.idx) ?? fallback });
      if (event) events.push(event);
      else skippedThisRead++;
    }
    // One line per read, not per row: a conversation with hundreds of
    // unrecognised rows must not write hundreds of log lines. Counts only —
    // no conversation id, no path, no blob content.
    if (skippedThisRead > 0 && typeof log === "function") {
      log(
        `agy: skipped ${skippedThisRead} of ${rows.length} generation(s) in one conversation; ` +
          "the field mapping may have drifted",
      );
    }
    const skipped = (entry.skipped ?? 0) + skippedThisRead;
    return { events, entry: { idx: highest, mtimeMs: stat.mtimeMs, skipped } };
  },

  // `agy` cannot be pointed at the portal — it speaks Google's Code Assist
  // protocol, which `/v1` does not serve — so there is no double-counting to
  // guard against here.
  skipReason: () => null,

  // `pending` here is a 0/1 flag — "has this database's mtime moved since it
  // was last read" — not a byte count, so summing it would just restate the
  // count and dressing it up as a size would be dishonest. Say what it is.
  describePending: (count) => `${count} conversation(s) with new generations`,

  statusNotes: () =>
    sqliteBackend()
      ? [`  sqlite backend:        ${sqliteBackend()}`]
      : ["", "  NOTE: no sqlite backend (bun:sqlite, node:sqlite or the sqlite3 binary)", "        is available, so nothing can be read."],
};
