import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
