import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { report } from "../src/core/report.mjs";

const config = { enabled: true, reportGatewayTraffic: false };

// Match Claude Code's pending-byte semantics without reading personal transcripts.
// Empty event batches exercise selection/cursor persistence without any upload.
function sweepFixture() {
  let state = { version: 2, files: {} };
  let inbox = [];
  const units = new Map();
  const reads = [];
  const store = {
    loadState: () => structuredClone(state),
    saveState: (next) => { state = structuredClone(next); },
    pendingUnits: () => structuredClone(inbox),
    acknowledgeUnits: () => { inbox = []; },
    readSpool: () => [],
    log: () => {},
  };
  const host = {
    unitLabel: "transcript",
    probe(unit, entry) {
      const file = units.get(unit);
      return file ? { mtimeMs: file.mtimeMs, pending: file.size - (entry.offset ?? 0) } : null;
    },
    read(unit) {
      reads.push(unit);
      return { events: [], entry: { offset: units.get(unit).size } };
    },
  };
  const add = (unit, entry = {}, mtimeMs = Date.now()) => {
    units.set(unit, { size: 4000, mtimeMs });
    state.files[unit] = entry;
  };
  const discover = (unit) => {
    units.set(unit, { size: 4000, mtimeMs: Date.now() });
    inbox.push({ units: [unit], excluded: true });
  };
  return { store, host, reads, add, discover };
}

for (const policy of ["observed gateway", "explicit exclusion"]) {
  test(`GR-HP-01: 25 fresher ${policy} units do not consume sweep slots`, async () => {
    const f = sweepFixture();
    f.add("direct", { offset: 1000 }, Date.now() - 60_000);
    const excluded = Array.from({ length: 25 }, (_, i) => `gateway-${i}`);
    for (const unit of excluded) f.add(unit, policy === "observed gateway" ? { excluded: true } : {});
    const cfg = { ...config, ...(policy === "explicit exclusion" ? { excludedTranscripts: excluded } : {}) };
    await report(f.host, f.store, cfg, [], { sweep: true });
    assert.deepEqual(f.reads, ["direct"]);
    assert.equal(f.store.loadState().files.direct.offset, 4000);
    for (const unit of excluded) assert.equal(f.store.loadState().files[unit].offset, undefined);
  });
}

test("GR-HP-01: Retry-After discoveries cannot starve a stranded direct transcript", async () => {
  const f = sweepFixture();
  f.add("direct", { offset: 1000 }, Date.now() - 60_000);
  const state = f.store.loadState();
  state.retryAt = Date.now() + 3_600_000;
  f.store.saveState(state);
  for (let i = 0; i < 25; i++) {
    f.discover(`gateway-${i}`);
    await report(f.host, f.store, config, [], { sweep: true });
  }
  assert.deepEqual(f.reads, []);
  assert.equal(f.store.pendingUnits().length, 0);
  assert.equal(f.store.loadState().files.direct.offset, 1000);
  assert.equal(Object.values(f.store.loadState().files).filter((entry) => entry.excluded).length, 25);
  const resumed = f.store.loadState();
  resumed.retryAt = Date.now() - 1;
  f.store.saveState(resumed);
  // A subsequent gateway hook is explicit; the other 25 are stale candidates.
  f.discover("gateway-next");
  await report(f.host, f.store, config, [], { sweep: true });
  assert.deepEqual(f.reads, ["direct"]);
  assert.equal(f.store.loadState().files.direct.offset, 4000);
  assert.equal(f.store.loadState().retryAt, undefined);
});

for (const override of ["includedTranscripts", "reportGatewayTraffic"]) {
  test(`GR-HP-01: ${override} still permits observed gateway sweep work`, async () => {
    const f = sweepFixture();
    f.add("gateway", { excluded: true });
    const cfg = { ...config, [override]: override === "includedTranscripts" ? ["gateway"] : true };
    await report(f.host, f.store, cfg, [], { sweep: true });
    assert.deepEqual(f.reads, ["gateway"]);
    assert.equal(f.store.loadState().files.gateway.excluded, true);
    assert.equal(f.store.loadState().files.gateway.offset, 4000);
  });
}

test("GR-HP-01: explicit exclusion wins over both gateway overrides during selection", async () => {
  const f = sweepFixture();
  f.add("gateway", { excluded: true });
  await report(f.host, f.store, {
    ...config, reportGatewayTraffic: true, includedTranscripts: ["gateway"], excludedTranscripts: ["gateway"],
  }, ["gateway"], { sweep: true });
  assert.deepEqual(f.reads, []);
});

// Supply config bytes through inherited descriptors, not /dev/fd paths:
// Node's subprocess "pipe" endpoints can be sockets that cannot be reopened.
// The child never reads HOME config, writes files, or invokes the network sender.
async function privacyPipeline(cfgText, json = {}) {
  const cfgUrl = new URL("../src/wakatime/cfg.mjs", import.meta.url).href;
  const mainUrl = new URL("../src/wakatime/main.mjs", import.meta.url).href;
  const fixtureUrl = new URL("./fixtures/runend.json", import.meta.url).href;
  const source = `(async () => {
    const { readFileSync } = await import('node:fs');
    const { loadWakaConfig, configProblem } = await import(${JSON.stringify(cfgUrl)});
    const { runHook } = await import(${JSON.stringify(mainUrl)});
    const cfg = loadWakaConfig({ env: {}, cfgPath: 3, jsonPath: 4 });
    const payload = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureUrl)}), 'utf8'));
    payload.workspace_root = '/synthetic';
    payload.tools = [
      { ...payload.tools[0], path: '/work/Secret/plan.md' },
      { ...payload.tools[0], path: '/work/secret/plan.md' },
      { ...payload.tools[0], path: '/work/Clients/x.ts' },
      { ...payload.tools[0], path: '/work/public/file.ts' },
    ];
    const now = Date.now();
    let state = { version: 2, files: {}, wakatimeProjects: {
      '/synthetic': { project: 'synthetic', branch: 'feat/b', at: now },
    } };
    const logs = [], batches = [];
    const store = {
      withLock: async (fn) => { await fn(); return true; },
      loadState: () => structuredClone(state),
      saveState: (next) => { state = structuredClone(next); },
      readSpool: () => [],
      writeSpool: (failed) => { if (failed.length) throw new Error('unexpected spool'); },
      log: (text) => logs.push(text),
    };
    await runHook({ store, cfg, stdinText: JSON.stringify(payload), now,
      send: async (_ctx, beats) => {
        batches.push(...beats);
        return { tally: { accepted: beats.length }, failed: [], authFailed: false };
      },
    });
    process.stdout.write(JSON.stringify({ problem: configProblem(cfg), batches, logs }));
  })().catch((err) => { console.error(err); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  const inputErrors = [];
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (const fd of [3, 4]) {
    child.stdio[fd].on("error", (err) => { inputErrors.push(`fd ${fd}: ${err.message}`); });
  }
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { resolve({ code, signal }); });
  });
  child.stdio[3].end(cfgText);
  child.stdio[4].end(JSON.stringify(json));
  const { code, signal } = await closed;
  assert.equal(code, 0, `privacy child exited ${code} (${signal ?? "no signal"}): ${stderr}`);
  assert.deepEqual(inputErrors, [], `privacy config pipe errors: ${stderr}`);
  return JSON.parse(stdout);
}

test("GR-HP-02: cfg list hides mixed-case paths and branches in the RunEnd pipeline", async () => {
  const result = await privacyPipeline("[settings]\napi_key = test\nhide_file_names =\n    secret\n    clients/\n");
  assert.equal(result.problem, null);
  assert.deepEqual(result.logs, []);
  const beats = result.batches.filter((beat) => beat.type === "file");
  assert.deepEqual(beats.map((beat) => beat.entity), [
    "HIDDEN.md", "HIDDEN.ts", "/work/public/file.ts",
  ]);
  for (const beat of beats.slice(0, 2)) assert.equal(beat.branch, undefined);
  assert.equal(beats[2].branch, "feat/b");
});

test("GR-HP-02: plugin JSON keeps case-sensitive JavaScript regex semantics", async () => {
  const result = await privacyPipeline("", { apiKey: "test", hideFileNames: ["secret", "clients/"] });
  assert.equal(result.problem, null);
  assert.deepEqual(result.logs, []);
  const beats = result.batches.filter((beat) => beat.type === "file");
  assert.deepEqual(beats.map((beat) => beat.entity), [
    "/work/Secret/plan.md", "HIDDEN.md", "/work/Clients/x.ts", "/work/public/file.ts",
  ]);
  assert.equal(beats[0].branch, "feat/b");
  assert.equal(beats[1].branch, undefined);
  assert.equal(beats[2].branch, "feat/b");
});

for (const value of ["secret", "\n    (?i)secret\n", "\n    [\n"]) {
  test(`GR-HP-02: unsupported cfg privacy stays fail-closed (${JSON.stringify(value)})`, async () => {
    const result = await privacyPipeline(`[settings]\napi_key = test\nhide_file_names = ${value}\n`);
    assert.ok(result.problem);
    assert.deepEqual(result.batches, []);
    assert.equal(result.logs.length, 1);
    assert.match(result.logs[0], /^not reporting:/);
  });
}
