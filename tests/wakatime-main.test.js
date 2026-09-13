import { afterAll, expect, test } from "bun:test";
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
    send: async (_ctx, beats) => { sent.push(...beats); return { tally: { sent: beats.length }, failed: [], authFailed: false }; },
  });

  expect(sent).toHaveLength(3);
  expect(store.readSpool()).toHaveLength(0);
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
  expect(out).toContain("3");                 // the auth-failure count
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
