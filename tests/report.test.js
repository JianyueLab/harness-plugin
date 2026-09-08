import { afterEach, afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";
import { report } from "../src/core/report.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-report-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const config = { baseUrl: "https://portal.example", apiKey: "jyl-k", enabled: true, reportGatewayTraffic: false };
const ok = (body = { accepted: 0, duplicates: 0, rejected: [] }) => async () => new Response(JSON.stringify(body), { status: 200 });

/** An adapter whose units are plain arrays of events, handed out once. */
function fakeHost(units) {
  return {
    id: "fake", source: "fake", client: "fake/1", title: "fake", unitLabel: "unit",
    stateDir: path.join(root, `s${Math.random()}`),
    unitsFromHook: () => [], recentUnits: () => Object.keys(units),
    probe: (unit, entry) => (units[unit] ? { mtimeMs: 1, pending: entry.done ? 0 : 1 } : null),
    read: (unit, entry) => (entry.done ? { events: [], entry } : { events: units[unit], entry: { done: true } }),
    skipReason: () => null, statusNotes: () => [],
  };
}

const event = (id) => ({ requestId: id, ts: "2026-09-08T00:00:00.000Z", model: "m", inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 });

test("uploads new events and records the cursor", async () => {
  globalThis.fetch = ok({ accepted: 2, duplicates: 0, rejected: [] });
  const host = fakeHost({ u1: [event("a"), event("b")] });
  const store = createStore(host.stateDir);

  const tally = await report(host, store, config, ["u1"], {});

  expect(tally.accepted).toBe(2);
  expect(store.loadState().files.u1.done).toBe(true);
});

test("does not send the same event twice across units", async () => {
  let sent = 0;
  globalThis.fetch = async (_u, init) => {
    sent += JSON.parse(init.body).events.length;
    return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), { status: 200 });
  };
  const host = fakeHost({ u1: [event("dup")], u2: [event("dup")] });
  const store = createStore(host.stateDir);

  await report(host, store, config, ["u1", "u2"], {});

  expect(sent).toBe(1);
});

test("spools a failed upload and still advances the cursor", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const host = fakeHost({ u1: [event("x")] });
  const store = createStore(host.stateDir);

  await report(host, store, config, ["u1"], {});

  expect(store.readSpool()).toHaveLength(1);
  expect(store.loadState().files.u1.done).toBe(true);
});

test("retries the spool on the next pass", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const host = fakeHost({ u1: [event("y")] });
  const store = createStore(host.stateDir);
  await report(host, store, config, ["u1"], {});

  globalThis.fetch = ok({ accepted: 1, duplicates: 0, rejected: [] });
  const tally = await report(host, store, config, [], {});

  expect(tally.accepted).toBe(1);
  expect(store.readSpool()).toHaveLength(0);
});

test("the sweep picks up a tracked unit nobody named", async () => {
  globalThis.fetch = ok({ accepted: 1, duplicates: 0, rejected: [] });
  const host = fakeHost({ u1: [event("z")] });
  const store = createStore(host.stateDir);
  store.saveState({ version: 2, files: { u1: {} } });

  const tally = await report(host, store, config, [], { sweep: true });

  expect(tally.sent).toBe(1);
});

test("forgets a unit the adapter says is gone", async () => {
  globalThis.fetch = ok();
  const host = fakeHost({});
  const store = createStore(host.stateDir);
  store.saveState({ version: 2, files: { vanished: {} } });

  await report(host, store, config, [], { sweep: true });

  expect(store.loadState().files.vanished).toBeUndefined();
});
