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
    if (configProblem(cfg)) {
      store.log(`not reporting: ${configProblem(cfg)}`);
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
      // Forward compatibility: a harness that grows more events must not make
      // this tool log an error on every one of them.
      if (payload.event !== EVENT) {
        store.log(`ignoring event ${payload.event}`);
        return;
      }
    }

    await store.withLock(async () => {
      // The throttle table (`wakatimeSeen`) and the project/branch cache
      // (`wakatimeProjects`) both live inside jyl-usage's own state object.
      // `store.loadState()` returns extra keys untouched as long as its own
      // `version` still matches STATE_VERSION -- a deliberate dependency on
      // that behaviour, not an oversight. If jyl-usage ever bumps
      // STATE_VERSION, this throttle table resets silently; the cost is one
      // extra batch of heartbeats, which is acceptable.
      const state = store.loadState();
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
 * `~/.wakatime.cfg` or creates a real `~/.config/jyl-wakatime/`. Production
 * (the entry point below) calls this with no overrides at all.
 */
export async function main(argv, stdinText, overrides = {}) {
  const { command } = parseArgs(argv);
  const cfg = overrides.cfg ?? loadWakaConfig({});
  const store = overrides.store ?? createStore(STATE_DIR);

  if (command === "--status") {
    process.stdout.write(renderStatus({ store, cfg }) + "\n");
    return 0;
  }
  // --flush is --hook with nothing on stdin: it drains whatever is spooled.
  await runHook({ store, stdinText: command === "--flush" ? "" : stdinText, cfg, now: Date.now() });
  return 0;
}

if (import.meta.main ?? process.argv[1]?.endsWith("main.mjs")) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  process.exit(await main(process.argv.slice(2), Buffer.concat(chunks).toString("utf8")));
}
