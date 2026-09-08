#!/usr/bin/env node
/**
 * jyl-usage — report agent token usage to the JianyueLab LLM portal.
 *
 * The CLI, and nothing else. What a host stores usage in — Claude Code's
 * session transcripts, Antigravity's conversation databases — lives behind a
 * host adapter in `src/hosts/`; the pass that reads, dedups, uploads and
 * persists lives in `src/core/report.mjs`. This file picks a host, loads its
 * config and state, and dispatches.
 *
 * **Only counts leave this machine.** Model id, timestamps, request id and
 * token totals — never prompts, completions, file paths, project names or
 * anything else the host happens to keep beside them.
 *
 * Design constraints, in the order they matter:
 *
 *   1. **Never slow the agent down, never break it.** Every hook is declared
 *      `async`, every failure path exits 0, and the only work on the hot path is
 *      reading what has been appended since last time.
 *   2. **Never lose usage, never double-count it.** A cursor per unit means each
 *      turn is read once; every run also sweeps the units it already tracks for
 *      work nothing ever came back for, so a hook that lost the lock or a
 *      session that never reached SessionEnd cannot strand a turn; a failed
 *      upload spools to disk and is retried on the next hook rather than
 *      dropped; and the server dedups on request id, so a retry that actually
 *      did land inserts nothing.
 *   3. **Zero dependencies, zero build.** Plain ESM on node/bun built-ins, so
 *      the plugin is the source and there is no dist/ to keep in sync.
 */

import fs from "node:fs";
import { parseArgs } from "./core/args.mjs";
import { configFiles, configProblem, loadConfig, redactKey } from "./core/config.mjs";
import { report } from "./core/report.mjs";
import { createStore } from "./core/store.mjs";
import { host as claudeCode } from "./hosts/claude-code.mjs";
import { host as antigravity } from "./hosts/antigravity.mjs";

/** Every host this reporter knows how to read. `--host` names one. */
const HOSTS = { "claude-code": claudeCode, antigravity };

/** Units touched within this many days are in scope for `--backfill`. */
const DEFAULT_BACKFILL_DAYS = 30;

const hostFor = (name) => HOSTS[name] ?? HOSTS["claude-code"];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Read the hook payload the host writes to stdin. `{}` when there is none. */
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

async function status(host, store, config) {
  const state = store.loadState();
  const spool = store.readSpool();
  const problem = configProblem(config);

  // What the next hook's sweep will pick up. Reported because a number here is
  // the difference between "nothing to do" and usage that has not been sent —
  // and, via `describePending` when the adapter has one, the difference
  // between a three-byte tail and a four-hundred-kilobyte one.
  let waiting = 0;
  let totalPending = 0;
  for (const [unit, entry] of Object.entries(state.files)) {
    const probe = host.probe(unit, entry);
    if (probe && probe.pending > 0) {
      waiting += 1;
      totalPending += probe.pending;
    }
  }
  const pendingLabel = host.describePending
    ? host.describePending(waiting, totalPending)
    : `${waiting} ${host.unitLabel}(s)`;

  // Antigravity reads SQLite through whichever backend exists; when none does,
  // that — not the config — is why nothing is being reported.
  let backendLine = null;
  if (host.id === "antigravity") {
    const { sqliteBackend } = await import("./lib/sqlite.mjs");
    const backend = sqliteBackend();
    backendLine = `  sqlite:      ${backend ?? "none — needs bun, node:sqlite, or sqlite3 on PATH"}`;
  }

  const row = (label, value) => `  ${label.padEnd(22)} ${value}`;
  const lines = [
    host.title,
    "",
    `  portal:      ${config.baseUrl || "(unset)"}`,
    `  api key:     ${redactKey(config.apiKey)}`,
    `  enabled:     ${config.enabled}`,
    `  config file: ${config.source ?? `${store.configFile} (absent)`}`,
    ...(backendLine ? [backendLine] : []),
    `  status:      ${problem ? `NOT reporting — ${problem}` : "ready"}`,
    "",
    row(`${host.unitLabel}s tracked:`, Object.keys(state.files).length),
    row("unread tails:", `${pendingLabel} — the next hook sweeps these`),
    row("events awaiting retry:", spool.length),
    row("dedup window:", `${store.readSeen().length} key(s)`),
  ];
  lines.push(...host.statusNotes(config));
  if (fs.existsSync(store.logFile)) {
    const tail = fs.readFileSync(store.logFile, "utf8").trimEnd().split("\n").slice(-8);
    lines.push("", "  recent log:", ...tail.map((l) => `    ${l}`));
  }
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = hostFor(args.host);
  const store = createStore(host.stateDir);
  const config = loadConfig({ files: configFiles(store.configFile) });

  if (args.command === "--status") return status(host, store, config);

  const problem = configProblem(config);
  if (problem) {
    // Silent on the hook path: an unconfigured plugin must be inert, not noisy.
    if (args.command !== "--hook") console.error(`jyl-usage: not reporting — ${problem}`);
    return;
  }

  const skip = host.skipReason(config);
  if (skip) {
    if (args.command !== "--hook") {
      console.error(
        `jyl-usage: ${skip}. ` +
          'Set "reportGatewayTraffic": true in the config to report anyway.',
      );
    }
    return;
  }

  if (args.command === "--backfill") {
    const days = args.days || DEFAULT_BACKFILL_DAYS;
    const units = host.recentUnits(days);
    const ran = await store.withLock(async () => {
      const t = await report(host, store, config, units);
      console.log(
        `jyl-usage: scanned ${units.length} ${host.unitLabel}(s) from the last ${days} day(s) — ` +
          `${t.accepted} new, ${t.duplicates} already reported, ${t.spooled} queued for retry.`,
      );
    });
    if (!ran) console.error("jyl-usage: another run holds the lock; try again in a moment.");
    return;
  }

  if (args.command === "--flush") {
    const ran = await store.withLock(async () => {
      const t = await report(host, store, config, []);
      console.log(`jyl-usage: flushed ${t.sent} queued event(s) — ${t.accepted} accepted.`);
    });
    if (!ran) console.error("jyl-usage: another run holds the lock; try again in a moment.");
    return;
  }

  // Default: the hook path — whatever the host just named, plus a catch-up
  // sweep over the units already tracked that have grown since anything last
  // read them. The sweep is why this is the path that changed: a lost lock or a
  // session that never reached SessionEnd used to strand a turn for good, and
  // `--backfill` only helped the people who knew to run it.
  const hook = await readHookInput();
  await store.withLock(() => report(host, store, config, host.unitsFromHook(hook), { sweep: true }));
}

main().catch((err) => {
  // The store is per-host and built inside main(), so a failure before that
  // point has no logger to hand. Rebuilding one from the same argv puts the
  // stack in the same log it would have gone to, and the rebuild is itself
  // wrapped: nothing here may throw.
  try {
    createStore(hostFor(parseArgs(process.argv.slice(2)).host).stateDir).log(
      `unhandled: ${err?.stack ?? err}`,
    );
  } catch {
    /* nowhere left to write; exiting 0 is still the right answer */
  }
  // Exiting non-zero would surface an error in the agent for a plugin whose
  // entire job is bookkeeping. The log is where failures belong.
  process.exit(0);
});
