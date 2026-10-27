import { afterAll, afterEach, expect, jest, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createStore } from "../src/core/store.mjs";
import { report } from "../src/core/report.mjs";
import { host } from "../src/hosts/claude-code.mjs";
import { loadWakaConfig, configProblem } from "../src/wakatime/cfg.mjs";
import { heartbeatsFrom } from "../src/wakatime/heartbeats.mjs";

const scratch = path.resolve(import.meta.dir, "../../.temp/audit-fixes-2026-10-26/GatewayReporter");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "reporter-regression-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; jest.useRealTimers(); });
const config = { baseUrl: "https://portal.invalid", apiKey: "jyl-test", enabled: true, reportGatewayTraffic: false };
const event = (id) => ({ requestId: id, model: "m", ts: new Date().toISOString(), inputTokens: 1, outputTokens: 1 });
const line = (id) => JSON.stringify({ type: "assistant", requestId: id, timestamp: new Date().toISOString(), message: { id: `msg_${id}`, model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n";
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
const entry = path.resolve(import.meta.dir, "../src/reporter.mjs");
async function cli(home, baseUrl, command, hook = {}, extraEnv = {}) {
  const child = spawn("node", [entry, command], { env: { ...process.env, HOME: home, USERPROFILE: home, JYL_USAGE_BASE_URL: baseUrl, JYL_API_KEY: "jyl-test", JYL_USAGE_DISABLED: "0", ANTHROPIC_BASE_URL: "", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stderr += b; });
  child.stdin.end(JSON.stringify(hook));
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(code).toBe(0);
  return { stdout, stderr };
}
function endpoint() {
  const ids = new Set();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const payload = await req.json();
    let accepted = 0, duplicates = 0;
    for (const e of payload.events) { if (ids.has(e.requestId)) duplicates++; else { ids.add(e.requestId); accepted++; } }
    return Response.json({ accepted, duplicates, rejected: [] });
  } });
  return { ids, server, url: `http://127.0.0.1:${server.port}` };
}

test("HP-001: documented subagents layout is reported and growth swept without duplicate request IDs", async () => {
  const main = write(path.join(root, "subagents-layout/projects/p/session.jsonl"), line("main") + line("shared"));
  const sub = write(path.join(root, "subagents-layout/projects/p/session/subagents/agent-a.jsonl"), line("sub") + line("shared"));
  const store = createStore(path.join(root, "subagent-state"));
  const received = new Set();
  globalThis.fetch = async (_url, init) => { const events = JSON.parse(init.body).events; for (const e of events) received.add(e.requestId); return Response.json({ accepted: events.length, duplicates: 0, rejected: [] }); };
  await report(host, store, config, host.unitsFromHook({ transcript_path: main, agent_transcript_path: sub }), { sweep: true });
  expect([...received].sort()).toEqual(["main", "shared", "sub"]);
  expect(store.loadState().files[sub]).toBeDefined();
  fs.appendFileSync(sub, line("sub-later"));
  await report(host, store, config, [main], { sweep: true });
  expect(received.has("sub-later")).toBe(true);
});

test("HP-002: 5200 events survive a 401 and report the actual retained queue", async () => {
  const unit = write(path.join(root, "overflow-5200.jsonl"), Array.from({ length: 5200 }, (_, index) => line(`401-${index}`)).join(""));
  const store = createStore(path.join(root, "overflow-state-5200"));
  const received = new Set();
  let healthy = false;
  globalThis.fetch = async (_url, init) => {
    if (!healthy) return new Response("retry", { status: 401 });
    const events = JSON.parse(init.body).events;
    for (const event of events) received.add(event.requestId);
    return Response.json({ accepted: events.length, duplicates: 0, rejected: [] });
  };
  const first = await report(host, store, config, [unit]);
  expect(first.spooled).toBe(store.readSpool().length);
  healthy = true;
  for (let pass = 0; pass < 5 && received.size < 5200; pass++) {
    const tally = await report(host, store, config, [unit], { sweep: true });
    expect(tally.spooled).toBe(store.readSpool().length);
  }
  expect(received.size).toBe(5200);
});

test("HP-002: all 16000 events arrive once across a sustained 20-per-minute window", async () => {
  const started = Math.floor(Date.now() / 1000) * 1000;
  jest.useFakeTimers();
  jest.setSystemTime(new Date(started));
  const retryAt = started + 60_000;
  const unit = write(path.join(root, "sustained-16000.jsonl"), Array.from({ length: 16000 }, (_, index) => line(`window-${index}`)).join(""));
  const store = createStore(path.join(root, "sustained-state"));
  const accepted = new Map();
  const requests = new Map();
  let limited = 0;
  globalThis.fetch = async (_url, init) => {
    const window = Math.floor((Date.now() - started) / 60_000);
    const count = (requests.get(window) ?? 0) + 1;
    requests.set(window, count);
    if (count > 20) {
      limited++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    }
    const events = JSON.parse(init.body).events;
    for (const event of events) accepted.set(event.requestId, (accepted.get(event.requestId) ?? 0) + 1);
    return Response.json({ accepted: events.length, duplicates: 0, rejected: [] });
  };
  const pass = async () => {
    const tally = await report(host, store, config, [unit], { sweep: true });
    expect(tally.spooled).toBe(store.readSpool().length);
    return tally;
  };
  await pass();
  await pass();
  expect(accepted.size).toBe(10_000);
  const held = await pass();
  expect(limited).toBe(1);
  expect(requests.get(0)).toBe(21);
  expect(held.spooled).toBe(5000);
  expect(host.probe(unit, store.loadState().files[unit]).pending).toBeGreaterThan(0);
  await pass();
  jest.setSystemTime(new Date(retryAt - 1));
  await pass();
  expect(requests.get(0)).toBe(21);
  expect(limited).toBe(1);
  jest.setSystemTime(new Date(retryAt));
  for (let attempt = 0; attempt < 4 && accepted.size < 16000; attempt++) await pass();
  expect(accepted.size).toBe(16000);
  expect([...accepted.values()].every((count) => count === 1)).toBe(true);
  expect(requests.get(1)).toBe(12);
  expect(limited).toBe(1);
  expect(store.readSpool()).toHaveLength(0);
  expect(host.probe(unit, store.loadState().files[unit]).pending).toBe(0);
});

for (const [name, header, delayMs] of [
  ["HTTP-date", "date", 20_000],
  ["missing", null, 60_000],
  ["malformed", "not-a-date", 60_000],
  ["past", "-100", 1000],
  ["extreme", "86400", 3_600_000],
]) {
  test(`HP-002: ${name} Retry-After bounds retain events until a resumable deadline`, async () => {
    const started = Math.floor(Date.now() / 1000) * 1000;
    jest.useFakeTimers();
    jest.setSystemTime(new Date(started));
    const unit = write(path.join(root, `retry-bound-${name}.jsonl`), line(`retry-${name}`));
    const store = createStore(path.join(root, `retry-bound-${name}`));
    let calls = 0;
    const received = [];
    globalThis.fetch = async (_url, init) => {
      calls++;
      if (calls === 1) {
        const value = header === "date" ? new Date(started + delayMs).toUTCString() : header;
        return new Response("limited", { status: 429, headers: value === null ? {} : { "retry-after": value } });
      }
      received.push(...JSON.parse(init.body).events.map((event) => event.requestId));
      return Response.json({ accepted: 1, duplicates: 0, rejected: [] });
    };
    await report(host, store, config, [unit]);
    jest.setSystemTime(new Date(started + delayMs - 1));
    const waiting = await report(host, store, config, [unit]);
    expect(calls).toBe(1);
    expect(waiting.spooled).toBe(1);
    jest.setSystemTime(new Date(started + delayMs));
    await report(host, store, config, [unit]);
    expect(received).toEqual([`retry-${name}`]);
    expect(store.readSpool()).toHaveLength(0);
  });
}

test("HP-002: discoveries remain durable while a shared retry deadline defers uploads", async () => {
  const started = Date.now();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(started));
  const first = write(path.join(root, "deferred-first.jsonl"), line("deferred-first"));
  const discovered = write(path.join(root, "deferred-discovered.jsonl"), line("deferred-discovered"));
  const store = createStore(path.join(root, "deferred-discoveries"));
  let calls = 0;
  const received = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) return new Response("limited", { status: 429, headers: { "retry-after": "60" } });
    const events = JSON.parse(init.body).events;
    received.push(...events.map((event) => event.requestId));
    return Response.json({ accepted: events.length, duplicates: 0, rejected: [] });
  };
  await report(host, store, config, [first]);
  store.queueUnits([discovered]);
  await report(host, store, config, [], { sweep: true });
  expect(calls).toBe(1);
  expect(store.loadState().files[discovered]).toBeDefined();
  expect(host.probe(discovered, store.loadState().files[discovered]).pending).toBeGreaterThan(0);
  jest.setSystemTime(new Date(started + 60_000));
  await report(host, store, config, [], { sweep: true });
  expect(received.sort()).toEqual(["deferred-discovered", "deferred-first"]);
});

test("HP-002: a 429 stops dispatching later batches in the same pass", async () => {
  const store = createStore(path.join(root, "429-state"));
  const unit = write(path.join(root, "429.jsonl"), Array.from({ length: 1600 }, (_, i) => line(`rate-${i}`)).join(""));
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("limited", { status: 429 }); };
  const tally = await report(host, store, config, [unit]);
  expect(calls).toBe(1);
  expect(tally.spooled).toBe(store.readSpool().length);
});

test("HP-002: real CLI queued count matches its spool and a fixed key recovers all 5200 events", async () => {
  const home = path.join(root, "overflow-cli-home");
  write(path.join(home, ".claude/projects/p/backfill.jsonl"), Array.from({ length: 5200 }, (_, index) => line(`cli-${index}`)).join(""));
  const ids = new Set();
  let healthy = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!healthy) return new Response("wrong synthetic key", { status: 401 });
    const payload = await request.json();
    for (const event of payload.events) ids.add(event.requestId);
    return Response.json({ accepted: payload.events.length, duplicates: 0, rejected: [] });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  const store = createStore(path.join(home, ".claude/jyl-usage"));
  try {
    const first = await cli(home, url, "--backfill");
    const queued = Number(/(\d+) queued for retry/.exec(first.stdout)?.[1]);
    expect(queued).toBe(store.readSpool().length);
    expect(queued).toBeGreaterThan(0);
    healthy = true;
    for (let pass = 0; pass < 5 && ids.size < 5200; pass++) await cli(home, url, "--backfill");
    expect(ids.size).toBe(5200);
    expect(store.readSpool()).toHaveLength(0);
  } finally { server.stop(true); }
}, 15_000);

test("HP-003: an observed gateway exclusion survives direct backfill and sweep", async () => {
  const home = path.join(root, "gateway-home");
  const unit = write(path.join(home, ".claude/projects/p/gateway.jsonl"), line("gateway-observed"));
  const other = write(path.join(home, ".claude/projects/p/direct.jsonl"), line("direct"));
  const remote = endpoint();
  try {
    await cli(home, remote.url, "--hook", { transcript_path: unit }, { ANTHROPIC_BASE_URL: remote.url });
    await cli(home, remote.url, "--backfill");
    fs.appendFileSync(unit, line("gateway-later"));
    await cli(home, remote.url, "--hook", { transcript_path: other });
    expect([...remote.ids]).toEqual(["direct"]);
    write(path.join(home, ".claude/projects/p/unknown.jsonl"), line("unknown-history"));
    await cli(home, remote.url, "--backfill", {}, { ANTHROPIC_BASE_URL: remote.url });
    expect([...remote.ids].sort()).toEqual(["direct", "unknown-history"]);
  } finally { remote.server.stop(true); }
});

test("HP-003: explicit exclusion wins over inclusion and included observed units can be recovered", async () => {
  const allowed = write(path.join(root, "policy-allowed.jsonl"), line("explicit-include"));
  const excluded = write(path.join(root, "policy-excluded.jsonl"), line("explicit-exclude"));
  const store = createStore(path.join(root, "policy-state"));
  store.saveState({ version: 2, files: { [allowed]: { excluded: true }, [excluded]: {} } });
  const received = [];
  globalThis.fetch = async (_url, init) => {
    const events = JSON.parse(init.body).events;
    received.push(...events.map((event) => event.requestId));
    return Response.json({ accepted: events.length, duplicates: 0, rejected: [] });
  };
  await report(host, store, { ...config, includedTranscripts: [allowed, excluded], excludedTranscripts: [excluded] }, [allowed, excluded], { sweep: true });
  expect(received).toEqual(["explicit-include"]);
});

test("HP-004: the next uncontended hook rescues a session whose hooks all lost the lock", async () => {
  const home = path.join(root, "contended-home");
  const lost = write(path.join(home, ".claude/projects/p/lost.jsonl"), line("contended"));
  const other = write(path.join(home, ".claude/projects/p/other.jsonl"), line("other"));
  const store = createStore(path.join(home, ".claude/jyl-usage"));
  const remote = endpoint();
  try {
    await store.withLock(async () => {
      for (const hook_event_name of ["SessionStart", "Stop", "SessionEnd"]) await cli(home, remote.url, "--hook", { transcript_path: lost, hook_event_name });
    });
    await cli(home, remote.url, "--hook", { transcript_path: other });
    expect([...remote.ids].sort()).toEqual(["contended", "other"]);
  } finally { remote.server.stop(true); }
}, 15_000);

test("HP-005: multiline path privacy hides matching files and their branch", () => {
  const cfgPath = write(path.join(root, "privacy.cfg"), "[settings]\napi_key = test\nhide_file_names =\n    .*private.*\n    .*sensitive.*\n");
  const config = loadWakaConfig({ env: {}, cfgPath, jsonPath: path.join(root, "absent.json") });
  const beats = heartbeatsFrom({ tools: [{ name: "read_file", path: "/synthetic/private/file.ts", at: 1 }, { name: "read_file", path: "/synthetic/public/file.ts", at: 2 }], usage: {} }, { ...config, project: "synthetic", branch: "synthetic-branch" });
  expect(beats[0].entity).toBe("HIDDEN.ts");
  expect(beats[0].branch).toBeUndefined();
  expect(beats[1].entity).toBe("/synthetic/public/file.ts");
  expect(beats[1].branch).toBe("synthetic-branch");
});

test("HP-005: invalid privacy configuration blocks transmission, booleans retain meaning", () => {
  for (const value of ["[", "maybe"]) {
    const cfgPath = write(path.join(root, `invalid-privacy-${value.length}.cfg`), `[settings]\napi_key = test\nhide_file_names = ${value}\n`);
    const config = loadWakaConfig({ env: {}, cfgPath, jsonPath: path.join(root, "absent.json") });
    expect(configProblem(config)).not.toBeNull();
  }
  for (const [raw, hidden] of [["true", true], ["false", false]]) {
    const cfgPath = write(path.join(root, `privacy-${raw}.cfg`), `[settings]\napi_key = test\nhide_file_names = ${raw}\n`);
    const config = loadWakaConfig({ env: {}, cfgPath, jsonPath: path.join(root, "absent.json") });
    const beats = heartbeatsFrom({ tools: [{ name: "read_file", path: "/synthetic/file.ts", at: 1 }] }, config);
    expect(beats[0].entity).toBe(hidden ? "HIDDEN.ts" : "/synthetic/file.ts");
  }
});
