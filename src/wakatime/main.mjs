/**
 * jyl-wakatime — harness's RunEnd hook -> WakaTime heartbeats.
 *
 * **This tool sends file paths and project names off the machine.** That is
 * what it is for, and it is why it is a separate tool from jyl-usage rather
 * than a second sink inside it. It never sends prompts, completions, tool
 * arguments or tool results: harness's payload does not contain them.
 */
import os from "node:os";
import { createStore } from "../core/store.mjs";
import { STATE_DIR, configProblem, loadWakaConfig, redactKey } from "./cfg.mjs";
import { heartbeatsFrom, throttle } from "./heartbeats.mjs";
import { detectProject } from "./project.mjs";
import { sendAll, userAgent } from "./send.mjs";

export const VERSION = "0.1.0";
const EVENT = "RunEnd";

export function parseArgs(argv) {
  const out = { command: "--hook" };
  for (const arg of argv) {
    if (arg === "--detach") continue; // the launcher handles it
    if (arg.startsWith("--")) out.command = arg;
  }
  return out;
}

/**
 * One hook invocation: parse stdin, map, throttle, send, spool the remainder.
 *
 * Never throws. A broken reporter must not make a harness run go red.
 *
 * `runGit` is an escape hatch for tests only: it flows straight through to
 * `detectProject`, which defaults it to the real `git` runner when omitted.
 * Production never passes it.
 */
export async function runHook({ store, stdinText, cfg, now, send = sendAll, harnessVersion = "unknown", runGit }) {
  try {
    const problem = configProblem(cfg);
    if (problem) {
      // Logged once, not on every run (spec: "no key anywhere | log once,
      // exit 0"). The read-modify-write of this flag MUST happen inside
      // store.withLock, like every other write to state.json in this file --
      // that lock is the file's only concurrency rule, and this path used to
      // be the one exception, which reproducibly clobbered a concurrent
      // locked run's freshly-saved bookkeeping (wakatimeLastSend, the
      // throttle table) with a stale unlocked overwrite. If the lock is not
      // free, skip the flag and skip the log line entirely rather than write
      // unlocked: losing one "not reporting" line under contention costs
      // nothing; overwriting someone else's real accounting is real data
      // loss. It is cleared the moment the config is valid again (below,
      // inside its own withLock call), so a user who fixes their config and
      // later breaks it again still gets one fresh line, not permanent
      // silence.
      await store.withLock(async () => {
        const state = store.loadState();
        if (!state.wakatimeConfigProblemLogged) {
          store.log(`not reporting: ${problem}`);
          state.wakatimeConfigProblemLogged = true;
          store.saveState(state);
        }
      });
      return;
    }

    let payload = null;
    if (stdinText && stdinText.trim()) {
      try {
        payload = JSON.parse(stdinText);
      } catch (err) {
        store.log(`stdin was not JSON: ${err.message}`);
        return;
      }
      // Valid JSON but not the object harness always sends (bare `null`, a
      // number, a string...). `null.event` throws, and that thrown TypeError
      // would otherwise land in the outermost catch below and log as
      // "unexpected failure" -- indistinguishable from a real bug in this
      // tool. Malformed input is not that.
      if (!payload || typeof payload !== "object") {
        store.log(`stdin was not a JSON object: ${stdinText.slice(0, 200)}`);
        return;
      }
      // Forward compatibility: a harness that grows more events must not make
      // this tool log an error on every one of them.
      if (payload.event !== EVENT) {
        store.log(`ignoring event ${payload.event}`);
        return;
      }
    }

    const ran = await store.withLock(async () => {
      // The throttle table (`wakatimeSeen`) and the project/branch cache
      // (`wakatimeProjects`) both live inside jyl-usage's own state object.
      // `store.loadState()` returns extra keys untouched as long as its own
      // `version` still matches STATE_VERSION -- a deliberate dependency on
      // that behaviour, not an oversight. If jyl-usage ever bumps
      // STATE_VERSION, this throttle table resets silently; the cost is one
      // extra batch of heartbeats, which is acceptable.
      const state = store.loadState();
      // Reaching this line means configProblem(cfg) was falsy above: the
      // config is valid on this run, so reset the once-only log flag for the
      // next time it breaks.
      state.wakatimeConfigProblemLogged = false;
      let fresh = [];

      if (payload) {
        const { project, branch } = detectProject(payload.workspace_root ?? "", state, now, runGit);
        fresh = throttle(
          heartbeatsFrom(payload, { project, branch, hideFileNames: cfg.hideFileNames }),
          state,
          now,
        );
      }

      const queued = [...store.readSpool(), ...fresh];
      if (queued.length === 0) {
        store.saveState(state);
        return;
      }

      const ctx = {
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        ua: userAgent({
          harnessVersion: payload?.harness_version ?? harnessVersion,
          pluginVersion: VERSION,
          platform: process.platform,
          release: os.release(),
          arch: process.arch,
          // The model rides in the User-Agent, not on the heartbeat -- the
          // heartbeat resource has no model field at all (Task 8 sent one and
          // read it back; it was silently dropped). See send.mjs.
          //
          // It is deliberately read from `payload`, not carried on any
          // heartbeat, which means one thing worth naming: this UA labels
          // *every* heartbeat in the request, including any spooled by an
          // earlier run under a different model, and `--flush` (no payload at
          // all) sends no model token. `harness_version` above already has
          // exactly this property. Per-heartbeat attribution would need a
          // per-heartbeat UA, i.e. one request per model, which is not worth a
          // batch split for a field WakaTime only keeps per user-agent row.
          model: payload?.model,
        }),
        // send.mjs calls ctx.log unguarded -- this must never be absent.
        // store.log already swallows its own failures, so this satisfies
        // that as long as a ctx is never built without it.
        log: store.log,
      };

      const { tally, failed, authFailed } = await send(ctx, queued);
      store.writeSpool(failed);
      state.wakatimeAuthFailures = authFailed ? (state.wakatimeAuthFailures ?? 0) + 1 : 0;
      // "accepted", not "sent": tally.sent counts heartbeats attempted, and a
      // run where every batch failed must not render as "sent 12, failed 12"
      // on --status -- the word "sent" there would read as success.
      // tally.accepted is what WakaTime actually kept.
      state.wakatimeLastSend = { at: now, accepted: tally.accepted ?? 0, failed: failed.length };
      store.saveState(state);
    });

    if (!ran) {
      // Another run holds the lock. Unlike jyl-usage, there is nothing to
      // re-read afterwards -- this payload existed only on stdin -- so
      // whatever heartbeats it would have produced are gone, not merely
      // delayed. Spooling them here is not safe (writeSpool is a whole-file
      // rewrite, unsafe without the lock), so logging an honest count is the
      // right minimal remedy. The count comes from the pre-throttle
      // heartbeatsFrom() output, computed without touching state -- state is
      // exactly what we could not safely reach without the lock. Throttling
      // only ever removes entries, so this is an upper bound on what was
      // actually lost, never an undercount.
      const dropped = payload ? heartbeatsFrom(payload, { hideFileNames: cfg.hideFileNames }).length : 0;
      store.log(`another run held the lock; dropped ${dropped} fresh heartbeat(s)`);
    }
  } catch (err) {
    // The outermost net. Anything that got here is a bug, but the hook still
    // has to come back clean.
    try {
      store.log(`unexpected failure: ${err?.stack ?? err}`);
    } catch {
      /* logging must never be the thing that breaks a hook */
    }
  }
}

export function renderStatus({ store, cfg }) {
  const state = store.loadState();
  const spool = store.readSpool();
  const last = state.wakatimeLastSend;
  return [
    `jyl-wakatime ${VERSION}`,
    `  api url     ${cfg.apiUrl}`,
    `  api key     ${redactKey(cfg.apiKey)}   (from ${cfg.source ?? "nowhere"})`,
    `  spool       ${spool.length} heartbeat(s)`,
    `  last send   ${last ? `${new Date(last.at).toISOString()}  accepted ${last.accepted}, failed ${last.failed}` : "never"}`,
    `  auth fails  ${state.wakatimeAuthFailures ?? 0}`,
    configProblem(cfg) ? `  PROBLEM     ${configProblem(cfg)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * `overrides.store` and `overrides.cfg` replace the real store and config.
 * Tests always supply both, so a run never touches the developer's real
 * `~/.wakatime.cfg` or creates a real `~/.config/jyl-wakatime/`. `overrides.send`
 * additionally replaces `runHook`'s network call, for tests that need to
 * observe what `main()` itself does with stdin (e.g. `--flush` discarding it)
 * without going over the network. Production (the entry point below) calls
 * this with no overrides at all.
 *
 * Resolves to 0 on every path, never rejects -- see the try/catch below.
 */
export async function main(argv, stdinText, overrides = {}) {
  const { command } = parseArgs(argv);
  const cfg = overrides.cfg ?? loadWakaConfig({});
  const store = overrides.store ?? createStore(STATE_DIR);

  try {
    if (command === "--status") {
      process.stdout.write(renderStatus({ store, cfg }) + "\n");
      return 0;
    }
    // --flush is --hook with nothing on stdin: it drains whatever is spooled.
    await runHook({
      store,
      stdinText: command === "--flush" ? "" : stdinText,
      cfg,
      now: Date.now(),
      ...(overrides.send ? { send: overrides.send } : {}),
    });
    return 0;
  } catch (err) {
    // main()'s own net. `runHook` never throws, but `renderStatus` has no net
    // of its own -- `store.readSpool()` on an unwritable state dir throws
    // straight through it -- and `--status` is the one surface whose entire
    // job is making this tool's silence visible. It must not turn a bad state
    // dir into an uncaught rejection there. Mirrors `reporter.mjs`'s identical
    // `main().catch(...)` net for the sibling tool's version of this rule.
    try {
      store.log(`unexpected failure in main: ${err?.stack ?? err}`);
    } catch {
      /* logging must never be the thing that breaks this */
    }
    return 0;
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("main.mjs")) {
  // An IIFE, not a bare top-level block: reading stdin below can itself throw
  // (a directory piped in as stdin fails at fstat under Bun's stream
  // implementation) on a path main()'s own try/catch never sees, since that
  // read happens before main() is even called. Wrapping it needs an early
  // `return` on the error path, which only a function body allows at this
  // scope; a bare `if` cannot express "stop here" without one.
  (async () => {
    const argv = process.argv.slice(2);
    const { command } = parseArgs(argv);
    let stdinText = "";
    try {
      // Read stdin only for the hook path, and never at all on a real
      // terminal. --status and --flush do not need it, and draining stdin to
      // EOF before even looking at argv is what made --status hang at an
      // interactive prompt.
      if (command !== "--status" && command !== "--flush" && !process.stdin.isTTY) {
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        stdinText = Buffer.concat(chunks).toString("utf8");
      }
    } catch (err) {
      // Same "entry point has no net" class main()'s try/catch already
      // closed for --status's render path -- the stdin-read path needs the
      // identical treatment, not a special case. No store exists yet on this
      // path (main() hasn't run), so build one just for this log line.
      try {
        createStore(STATE_DIR).log(`unexpected failure reading stdin: ${err?.stack ?? err}`);
      } catch {
        /* logging must never be the thing that breaks this */
      }
      process.exit(0);
      return;
    }

    // main() itself never rejects (see its own try/catch above); this .catch
    // is a defense-in-depth backstop for the top level, not a path expected
    // to fire.
    await main(argv, stdinText)
      .then((code) => process.exit(code))
      .catch(() => process.exit(0));
  })();
}
