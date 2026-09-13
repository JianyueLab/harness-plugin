import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";
import { main, parseArgs, renderStatus, runHook } from "../src/wakatime/main.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-main-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const fixture = fs.readFileSync(path.join(import.meta.dir, "fixtures/runend.json"), "utf8");
const freshStore = (name) => createStore(path.join(root, name));

test("parseArgs defaults to the hook path", () => {
  expect(parseArgs([]).command).toBe("--hook");
  expect(parseArgs(["--status"]).command).toBe("--status");
  expect(parseArgs(["--flush"]).command).toBe("--flush");
  expect(parseArgs(["--detach"]).command).toBe("--hook"); // handled by the launcher
});

test("a good payload turns into heartbeats and goes out", async () => {
  const store = freshStore("happy");
  const sent = [];
  await runHook({
    store,
    stdinText: fixture,
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", hideFileNames: false, enabled: true },
    now: 1_000,
    // The fixture's workspace_root is a real repo on this machine (it is the
    // cross-repo contract with harness/hook/testdata/runend.json). Stubbing
    // runGit keeps this hermetic instead of forking a real git process against
    // whatever that directory happens to be.
    runGit: () => "",
    // I2: assert the ctx runHook actually builds, not just the beats -- with
    // no assertion here, swapping apiUrl/apiKey, mangling the User-Agent, or
    // deleting `log:` (which send.mjs calls unguarded) would leave every test
    // in this file green.
    send: async (ctx, beats) => {
      expect(typeof ctx.log).toBe("function");
      expect(ctx.apiKey).toBe("k");
      expect(ctx.apiUrl).toBe("https://x/api/v1");
      expect(ctx.ua).toContain("harness-wakatime/");
      // The model reaches WakaTime only through the User-Agent -- the
      // heartbeat resource has no model field. Nothing else in the suite
      // covers the wiring from `payload.model` to `userAgent({model})`, so
      // dropping that one property would otherwise stay green while the
      // account silently regained its phantom "Wakatime" model.
      expect(ctx.ua).toContain(" claude-opus-5 "); // fixture model, verbatim
      expect(ctx.ua).toContain(" harness/27.0.17 "); // fixture harness_version
      // Never split into name/version: that shape buckets by the half before
      // the slash, which is how harness's spend landed in Claude Code's row.
      expect(ctx.ua).not.toContain("claude/opus-5");
      sent.push(...beats);
      return { tally: { sent: beats.length }, failed: [], authFailed: false };
    },
  });

  expect(sent).toHaveLength(3);
  expect(store.readSpool()).toHaveLength(0);
});

// --flush has no payload, so there is no model to name. Asserted because the
// obvious "just always append a model token" refactor would emit a bare
// `undefined` here, and WakaTime would dutifully record an AI model called
// "Undefined" against the user's account.
test("a flush with nothing on stdin sends a user agent with no model token", async () => {
  const store = freshStore("flush-ua");
  store.writeSpool([{ entity: "/a.go", type: "file", time: 1, category: "ai coding" }]);
  let seen = null;
  await runHook({
    store,
    stdinText: "",
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", hideFileNames: false, enabled: true },
    now: 1_000,
    send: async (ctx, beats) => {
      seen = ctx.ua;
      return { tally: { sent: beats.length, accepted: beats.length }, failed: [], authFailed: false };
    },
  });

  expect(seen).toContain("go0.0.0 harness/");
  expect(seen).not.toContain("undefined");
  expect(seen).not.toContain("null");
});

test("what could not be delivered lands in the spool and goes again next run", async () => {
  const store = freshStore("spooling");
  let attempt = 0;
  const send = async (_ctx, beats) => {
    attempt++;
    return attempt === 1
      ? { tally: { sent: beats.length }, failed: beats, authFailed: false }
      : { tally: { sent: beats.length }, failed: [], authFailed: false };
  };

  await runHook({ store, stdinText: fixture, cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true }, now: 1_000, runGit: () => "", send });
  expect(store.readSpool()).toHaveLength(3);

  // Second run: nothing new on stdin, but the spool drains.
  await runHook({ store, stdinText: "", cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true }, now: 500_000, send });
  expect(store.readSpool()).toHaveLength(0);
});

test("a payload for another event is ignored, not an error", async () => {
  const store = freshStore("otherevent");
  let called = false;
  await runHook({
    store,
    stdinText: JSON.stringify({ event: "PostToolUse", tools: [] }),
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
    now: 1_000,
    send: async () => { called = true; return { tally: {}, failed: [], authFailed: false }; },
  });
  expect(called).toBe(false);
});

test("garbage on stdin is survivable", async () => {
  const store = freshStore("garbage");
  await expect(
    runHook({
      store, stdinText: "}{not json", now: 1_000,
      cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
      send: async () => { throw new Error("must not be reached"); },
    }),
  ).resolves.toBeUndefined();
});

test("no key configured: nothing is sent, nothing throws", async () => {
  const store = freshStore("nokey");
  await runHook({
    store, stdinText: fixture, now: 1_000,
    cfg: { apiKey: "", apiUrl: "https://x/api/v1", enabled: true },
    runGit: () => "",
    send: async () => { throw new Error("must not be reached"); },
  });
  expect(store.readSpool()).toHaveLength(0);
});

test("--status shows the url, a redacted key, the spool and auth failures", () => {
  const store = freshStore("status");
  store.writeSpool([{ entity: "/a.go" }, { entity: "/b.go" }]);
  store.saveState({ version: 2, files: {}, wakatimeAuthFailures: 3 });

  const out = renderStatus({
    store,
    cfg: { apiKey: "waka_0123456789abcdef", apiUrl: "https://wakapi.example/api/v1", enabled: true, source: "~/.wakatime.cfg" },
  });

  expect(out).toContain("https://wakapi.example/api/v1");
  expect(out).toContain("waka…cdef");
  expect(out).not.toContain("0123456789");   // the middle of the key never shows
  expect(out).toContain("2 heartbeat(s)");
  // M1 (controller ruling): toContain("3") passed on any "3" anywhere in the
  // block -- deleting the "auth fails" line and bumping VERSION to "0.1.3"
  // would have kept it green. Assert the actual line.
  expect(out).toContain("auth fails  3");
});

// Correction 2: the "last send" line must report what WakaTime actually kept
// (accepted), not what was merely attempted (sent) -- a run where every batch
// failed must not read as a success on --status.
test("--status's last-send line reports accepted, not attempted", async () => {
  const store = freshStore("accepted");
  await runHook({
    store,
    stdinText: fixture,
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
    now: 1_000,
    runGit: () => "",
    // 3 heartbeats attempted, only 1 accepted, 2 come back for the spool.
    send: async (_ctx, beats) => ({ tally: { sent: beats.length, accepted: 1, rejected: 0 }, failed: beats.slice(1), authFailed: false }),
  });

  const out = renderStatus({ store, cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true } });
  expect(out).toContain("accepted 1");
  expect(out).not.toContain("sent 3"); // tally.sent (attempted) must not read as delivered
});

// Correction 1: main() must accept injected collaborators so a unit test never
// touches the developer's real ~/.wakatime.cfg or ~/.config/jyl-wakatime.
test("main always returns 0", async () => {
  const store = freshStore("main-status");
  const cfg = { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true };
  expect(await main(["--status"], "", { store, cfg })).toBe(0);
  expect(await main([], "}{ not json", { store, cfg })).toBe(0);
  expect(await main(["--nonsense"], "", { store, cfg })).toBe(0);
});

// This is store.writeSpool's behaviour, not ours — asserted here because
// jyl-wakatime relies on it as its only defence against a permanently wrong
// key growing the spool forever. A silent cap would read as "everything was
// sent", which is why the drop is logged.
test("the spool is capped at 5000, oldest dropped, and the drop is logged", () => {
  const store = freshStore("cap");
  store.writeSpool(Array.from({ length: 5001 }, (_, i) => ({ entity: `/f${i}.go` })));

  const kept = store.readSpool();
  expect(kept).toHaveLength(5000);
  expect(kept[0].entity).toBe("/f1.go");                    // /f0.go was the oldest
  expect(kept.at(-1).entity).toBe("/f5000.go");
  expect(fs.readFileSync(store.logFile, "utf8")).toContain("spool overflow");
});

test("an unwritable state dir does not throw", async () => {
  // A directory where a file must go: every write inside runHook fails.
  const blocked = path.join(root, "blocked");
  fs.mkdirSync(path.join(blocked, "spool.jsonl"), { recursive: true });

  await expect(
    runHook({
      store: createStore(blocked),
      stdinText: fixture,
      cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
      now: 1_000,
      runGit: () => "",
      send: async (_c, beats) => ({ tally: { sent: beats.length }, failed: beats, authFailed: false }),
    }),
  ).resolves.toBeUndefined();
});

// Nothing above proves runHook actually threads runGit through to detectProject
// at all -- every case above injects an empty result, which is indistinguishable
// from runGit never being wired up in the first place. This one uses a real
// branch name and checks it lands on the emitted file heartbeats.
test("runGit is threaded through to detectProject, and the branch reaches the heartbeats", async () => {
  const store = freshStore("branch");
  const sent = [];
  await runHook({
    store,
    stdinText: fixture,
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
    now: 1_000,
    runGit: () => "feat/hook-system\n",
    send: async (_ctx, beats) => { sent.push(...beats); return { tally: { sent: beats.length, accepted: beats.length }, failed: [], authFailed: false }; },
  });

  const files = sent.filter((b) => b.type === "file");
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(f.branch).toBe("feat/hook-system");
});

// --- Fix round 1 (review: task-5-review.md) -------------------------------

// C1 (Critical): main()'s --status branch had no net of its own. renderStatus
// -> readSpool() throws EISDIR on an unwritable state dir, and that rejection
// used to propagate straight out of main(), turning the CLI's exit code non-
// zero on the one surface whose whole job is making this tool's silence
// visible.
test("C1: main resolves to 0 even when --status's own render blows up", async () => {
  const blocked = path.join(root, "blocked-status");
  fs.mkdirSync(path.join(blocked, "spool.jsonl"), { recursive: true });
  const cfg = { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true };

  await expect(main(["--status"], "", { store: createStore(blocked), cfg })).resolves.toBe(0);
});

// I1 (Important): the CLI entry point used to drain stdin to EOF before even
// looking at argv, so --status hung at an interactive prompt (or, as here, on
// a slow pipe) until stdin closed. This cannot be exercised through main() in-
// process -- the reading happens in the `import.meta.main` guard at the
// bottom of main.mjs, which only runs for the real entry point -- so this
// spawns the actual launcher, with HOME redirected to a throwaway temp dir so
// it never touches a real ~/.wakatime.cfg or ~/.config/jyl-wakatime.
//
// A plain `time sh -c "sleep 1 | wakatime --status"` cannot measure this: a
// shell pipeline waits for *every* stage before returning, including `sleep`,
// regardless of whether the second command ever touches its stdin (verified:
// `sh -c "sleep 1 | echo hi"` alone takes ~1s). Backgrounding the pipeline
// with a bare trailing `&` does not fix this from Node either: spawnSync's
// own stdio pipes for the `sh` child get inherited by `sleep` (its stderr is
// never redirected), so spawnSync itself blocks reading those pipes until
// `sleep` exits and closes them ~1s later -- the same idiom scripts/wakatime
// already uses for `--detach` (`( ... & ) </dev/null >/dev/null 2>&1`) is what
// detaches the whole backgrounded pipeline from spawnSync's pipes. What
// distinguishes "read stdin first" from "dispatched first" is instead how
// soon the output file --status writes to appears, polled below.
test("I1: --status returns instantly even while a slow pipe still has stdin open", async () => {
  const fakeHome = path.join(root, "faketty-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const launcher = path.join(import.meta.dir, "..", "scripts", "wakatime");
  const outFile = path.join(root, "i1-status-out.txt");

  const start = Date.now();
  spawnSync(
    "sh",
    ["-c", `(sleep 1 | '${launcher}' --status > '${outFile}' 2>&1 &) </dev/null >/dev/null 2>&1`],
    { env: { ...process.env, HOME: fakeHome } },
  );

  let elapsed = 0;
  for (;;) {
    elapsed = Date.now() - start;
    if (fs.existsSync(outFile) && fs.readFileSync(outFile, "utf8").length > 0) break;
    if (elapsed > 900) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  expect(fs.existsSync(outFile)).toBe(true);
  expect(fs.readFileSync(outFile, "utf8")).toContain("jyl-wakatime");
  // If the bug were back, nothing would appear in the file until the sleep's
  // pipe closes at ~1000ms.
  expect(elapsed).toBeLessThan(700);
});

// I3 (Important): a contended lock used to drop the payload with no trace at
// all -- store.withLock's `false` return (another run holds the lock) was
// never checked.
test("I3: a contended lock drops the payload but logs how many heartbeats it cost", async () => {
  const real = freshStore("contended");
  let withLockCalled = false;
  // Same store, except withLock reports contention without running the
  // callback -- exactly what store.mjs itself returns after ~1s of retries.
  const store = { ...real, withLock: async () => { withLockCalled = true; return false; } };

  await runHook({
    store,
    stdinText: fixture,
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
    now: 1_000,
    runGit: () => "",
    send: async () => { throw new Error("must not be reached -- the lock was never held"); },
  });

  expect(withLockCalled).toBe(true);
  const log = fs.readFileSync(real.logFile, "utf8");
  expect(log).toContain("another run held the lock");
  // The fixture yields 3 heartbeats (2 file + 1 app) from heartbeatsFrom().
  expect(log).toContain("dropped 3 fresh heartbeat(s)");
});

// M2 (Minor): stdin that parses to valid JSON but not an object (bare `null`,
// a number...) used to throw on `payload.event` and land in the outermost
// catch, logging "unexpected failure" -- indistinguishable from a real bug.
test("M2: a JSON payload that isn't an object is logged as malformed input, not an internal bug", async () => {
  const store = freshStore("nullpayload");
  await runHook({
    store, stdinText: "null", now: 1_000,
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
    send: async () => { throw new Error("must not be reached"); },
  });

  const log = fs.readFileSync(store.logFile, "utf8");
  expect(log).not.toContain("unexpected failure");
  expect(log).toContain("not a JSON object");
});

// M3 (controller ruling): "no key" (or any configProblem) must log once, not
// on every run, and must log again after the config is fixed and then broken
// a second time.
test("M3: the config-problem line logs once, then again after a fix and a fresh break", async () => {
  const store = freshStore("problemOnce");
  const badCfg = { apiKey: "", apiUrl: "https://x/api/v1", enabled: true };
  const goodCfg = { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true };
  const notReportingLines = () =>
    fs.readFileSync(store.logFile, "utf8").split("\n").filter((l) => l.includes("not reporting")).length;

  await runHook({ store, stdinText: "", cfg: badCfg, now: 1_000 });
  await runHook({ store, stdinText: "", cfg: badCfg, now: 2_000 });
  expect(notReportingLines()).toBe(1); // second run: flag already set, no repeat

  // The key comes back: a run with nothing to send but no config problem
  // clears the flag.
  await runHook({ store, stdinText: "", cfg: goodCfg, now: 3_000 });

  await runHook({ store, stdinText: "", cfg: badCfg, now: 4_000 });
  expect(notReportingLines()).toBe(2); // fresh line after the fix-then-break cycle
});

// --- Fix round 2 (re-review: task-5-rereview.md) --------------------------

// M3 follow-up (re-review defect): the config-problem flag's read-modify-write
// used to run *outside* store.withLock -- the one and only place in this file
// that touched state.json unlocked. Every hook invocation is a separate OS
// process, so this was a real inter-process race: the re-review built a
// deterministic repro where an unlocked "problem" read+write, ordered after a
// concurrent locked run's own save, clobbered that run's freshly-written
// wakatimeLastSend and throttle table with a stale snapshot. This test proves
// the read-modify-write is now structurally inside the lock: it wraps
// loadState/saveState to throw if either is ever called while withLock's own
// callback is not currently running, which would surface (caught by runHook's
// outermost net, so also asserted for below) if the fix regressed.
test("M3 follow-up: the config-problem flag's read-modify-write happens inside store.withLock", async () => {
  const real = freshStore("rmwInsideLock");
  let locked = false;
  const store = {
    ...real,
    withLock: async (fn) => {
      locked = true;
      try {
        await fn();
      } finally {
        locked = false;
      }
      return true;
    },
    loadState: (...args) => {
      if (!locked) throw new Error("loadState called outside store.withLock");
      return real.loadState(...args);
    },
    saveState: (...args) => {
      if (!locked) throw new Error("saveState called outside store.withLock");
      return real.saveState(...args);
    },
  };

  await runHook({ store, stdinText: "", cfg: { apiKey: "", apiUrl: "https://x/api/v1", enabled: true }, now: 1_000 });

  // If the guarded loadState/saveState above had thrown, runHook's own
  // outermost catch would have swallowed it silently -- so also confirm the
  // flag actually landed, proving the guarded calls really ran rather than
  // having been skipped entirely.
  expect(real.loadState().wakatimeConfigProblemLogged).toBe(true);
  expect(fs.readFileSync(real.logFile, "utf8")).toContain("not reporting");
});

// M3 follow-up (ruling): when the lock is contended, the flag must not be
// written and the line must not be logged -- losing one "not reporting" line
// costs nothing; writing state.json from a stale unlocked read is what
// clobbered another run's real bookkeeping.
test("M3 follow-up: a contended lock on the config-problem path writes nothing and logs nothing", async () => {
  const real = freshStore("problemContended");
  let withLockCalls = 0;
  const store = { ...real, withLock: async () => { withLockCalls++; return false; } };

  await runHook({ store, stdinText: "", cfg: { apiKey: "", apiUrl: "https://x/api/v1", enabled: true }, now: 1_000 });

  expect(withLockCalls).toBe(1); // the problem path now goes through the lock at all
  expect(fs.existsSync(real.stateFile)).toBe(false); // nothing was ever saved
  expect(fs.existsSync(real.logFile)).toBe(false); // nothing was ever logged
});

function which(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`]);
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

// C1 follow-up (re-review: "partially addressed"): the stdin-drain loop in
// the top-level entry point -- which runs *before* main() is ever called --
// had no net of its own, unlike main()'s own --status/render path. The
// re-review reproduced an uncaught EISDIR on the default --hook path, under
// the default runtime (bun), by piping a directory in as stdin. Node's stdin
// implementation does not throw on the same input, so this is verified under
// both runtimes scripts/wakatime supports -- their disagreement is exactly
// why the review asked for both.
for (const [name, runtimePath] of Object.entries({ bun: which("bun"), node: which("node") })) {
  test(`C1 follow-up (${name}): a directory piped in as stdin on the --hook path still exits 0`, () => {
    expect(runtimePath).toBeTruthy(); // this repo requires both runtimes present
    const fakeHome = path.join(root, `c1-stdin-${name}`);
    const aDir = path.join(fakeHome, "adir");
    fs.mkdirSync(aDir, { recursive: true });
    const launcher = path.join(import.meta.dir, "..", "scripts", "wakatime");

    const result = spawnSync("sh", ["-c", `'${launcher}' --hook < '${aDir}'`], {
      env: { ...process.env, HOME: fakeHome, JYL_WAKATIME_RUNTIME: runtimePath },
    });

    expect(result.status).toBe(0);
  });
}

// Confirms bun is the runtime that actually throws here (and that the entry
// point's own catch, not some unrelated success, is what produced exit 0
// above) -- without this, "exit 0" alone would not distinguish "caught the
// error" from "never hit the bug in the first place."
test("C1 follow-up: bun's own throw on directory-stdin is the one actually caught and logged", () => {
  const bunPath = which("bun");
  expect(bunPath).toBeTruthy();
  const fakeHome = path.join(root, "c1-stdin-bun-logcheck");
  const aDir = path.join(fakeHome, "adir");
  fs.mkdirSync(aDir, { recursive: true });
  const launcher = path.join(import.meta.dir, "..", "scripts", "wakatime");

  spawnSync("sh", ["-c", `'${launcher}' --hook < '${aDir}'`], {
    env: { ...process.env, HOME: fakeHome, JYL_WAKATIME_RUNTIME: bunPath },
  });

  const log = fs.readFileSync(path.join(fakeHome, ".config", "jyl-wakatime", "log"), "utf8");
  expect(log).toContain("unexpected failure reading stdin");
});

// M4 (Minor): main's --status branch wrote to the real process.stdout with no
// assertion on what it wrote -- exercised without being checked.
test("M4: main's --status branch writes renderStatus's own text to stdout", async () => {
  const store = freshStore("stdout");
  const cfg = { apiKey: "waka_0123456789abcdef", apiUrl: "https://x/api/v1", enabled: true };
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await main(["--status"], "", { store, cfg });
  } finally {
    process.stdout.write = original;
  }
  expect(chunks.join("")).toBe(renderStatus({ store, cfg }) + "\n");
});

// M5 (Minor): nothing asserted that --flush actually discards stdin and only
// drains the pre-existing spool -- it was verified by hand only.
test("M5: --flush discards stdin and only drains the pre-existing spool", async () => {
  const store = freshStore("flushDiscardsStdin");
  store.writeSpool([{ entity: "/old.go", type: "file" }]);
  const cfg = { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true };
  const sentBatches = [];
  const send = async (_ctx, beats) => {
    sentBatches.push(...beats);
    return { tally: { sent: beats.length, accepted: beats.length }, failed: [], authFailed: false };
  };

  // fixture has 3 fresh heartbeats on stdin; --flush must ignore every one of them.
  await main(["--flush"], fixture, { store, cfg, send });

  expect(sentBatches).toHaveLength(1);
  expect(sentBatches[0].entity).toBe("/old.go");
  expect(store.readSpool()).toHaveLength(0); // drained: send() accepted it
});

// I3 fix-round-2 (re-review defect): scripts/wakatime's no-runtime-found
// fallback log line and src/wakatime/cfg.mjs's STATE_DIR are computed in two
// different languages, and nothing else notices if they drift apart -- fix
// round 1 introduced exactly that drift by reading $XDG_CONFIG_HOME in the
// shell only. This asserts against the *real* STATE_DIR (read back from
// cfg.mjs itself, in a fresh process under the fake HOME -- not a path
// re-typed by hand in this file, which would just be the same mistake
// twice), not a hardcoded string, so a future change to either side shows up
// here. Run with XDG_CONFIG_HOME both unset and set, because the regression
// this guards against only appeared once it was set.
const cfgModulePath = path.join(import.meta.dir, "..", "src", "wakatime", "cfg.mjs");
const probeScript = path.join(root, "probe-state-dir.mjs");
fs.writeFileSync(probeScript, `import { STATE_DIR } from ${JSON.stringify(cfgModulePath)};\nconsole.log(STATE_DIR);\n`);

for (const xdg of [undefined, "elsewhere/xdgconf"]) {
  const label = xdg === undefined ? "XDG_CONFIG_HOME unset" : "XDG_CONFIG_HOME set to something else";
  test(`I3 fix-round-2: launcher's no-runtime log lands in cfg.mjs's own STATE_DIR (${label})`, () => {
    const fakeHome = path.join(root, `i3-drift-${xdg === undefined ? "noxdg" : "xdg"}`);
    fs.mkdirSync(fakeHome, { recursive: true });
    const envExtra = xdg === undefined ? {} : { XDG_CONFIG_HOME: path.join(fakeHome, xdg) };

    // The canonical log file, read from the real module under this exact
    // HOME/XDG_CONFIG_HOME combination -- this is what "in sync" means.
    const probe = spawnSync(process.execPath, [probeScript], {
      env: { ...process.env, HOME: fakeHome, ...envExtra },
    });
    expect(probe.status).toBe(0);
    const stateDir = probe.stdout.toString().trim();
    expect(stateDir.length).toBeGreaterThan(0);
    const expectedLogFile = createStore(stateDir).logFile;

    // Run the launcher with neither bun nor node reachable, so it must take
    // the no-runtime fallback path this test exists to check.
    const launcher = path.join(import.meta.dir, "..", "scripts", "wakatime");
    const result = spawnSync("sh", ["-c", `'${launcher}'`], {
      env: { ...process.env, HOME: fakeHome, PATH: "/usr/bin:/bin", JYL_WAKATIME_RUNTIME: "", ...envExtra },
      input: "",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(expectedLogFile)).toBe(true);
    expect(fs.readFileSync(expectedLogFile, "utf8")).toContain("no bun or node on PATH; not reporting");
  });
}
