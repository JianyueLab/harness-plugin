import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";
import { report } from "../src/core/report.mjs";
import { host, QUIET_MS } from "../src/hosts/claude-code.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-cc-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const line = (requestId, usage, { model = "claude-opus-5", stop = "end_turn", id = "msg_1" } = {}) =>
  JSON.stringify({ type: "assistant", requestId, timestamp: "2026-09-08T00:00:00.000Z", message: { id, model, stop_reason: stop, usage } });
const assistant = (requestId, usage, model) => line(requestId, usage, { model });
const userLine = JSON.stringify({ type: "user", message: { role: "user", content: "x" } });

function transcript(name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const age = (file, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
};

test("reads usage out of assistant entries", () => {
  const file = transcript("a.jsonl", [
    assistant("req_1", { input_tokens: 2, output_tokens: 389, cache_read_input_tokens: 22141, cache_creation: { ephemeral_1h_input_tokens: 18259 } }),
  ]);

  const { events, entry } = host.read(file, {});

  expect(events).toEqual([{
    requestId: "req_1",
    messageId: "msg_1",
    ts: "2026-09-08T00:00:00.000Z",
    model: "claude-opus-5",
    inputTokens: 2,
    outputTokens: 389,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 18259,
    cacheReadTokens: 22141,
  }]);
  expect(entry.offset).toBe(fs.statSync(file).size);
});

test("attributes an untyped cache-creation total to the 5-minute bucket", () => {
  const file = transcript("b.jsonl", [assistant("req_2", { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 900 })]);
  expect(host.read(file, {}).events[0].cacheWrite5mTokens).toBe(900);
});

test("ignores locally fabricated messages", () => {
  const file = transcript("c.jsonl", [assistant("req_3", { input_tokens: 5, output_tokens: 5 }, "<synthetic>")]);
  expect(host.read(file, {}).events).toEqual([]);
});

test("stops at the last complete line", () => {
  const file = path.join(dir, "d.jsonl");
  fs.writeFileSync(file, assistant("req_4", { input_tokens: 1, output_tokens: 1 }) + "\n{\"type\":\"assis");
  const { events, entry } = host.read(file, {});
  expect(events).toHaveLength(1);
  expect(entry.offset).toBeLessThan(fs.statSync(file).size);
});

test("restarts from zero when a transcript shrinks", () => {
  const file = transcript("e.jsonl", [assistant("req_5", { input_tokens: 1, output_tokens: 1 })]);
  const { events } = host.read(file, { offset: 10_000 });
  expect(events).toHaveLength(1);
});

test("probe reports the unread tail, and null once the file is gone", () => {
  const file = transcript("f.jsonl", [assistant("req_6", { input_tokens: 1, output_tokens: 1 })]);
  expect(host.probe(file, { offset: 0 }).pending).toBe(fs.statSync(file).size);
  fs.rmSync(file);
  expect(host.probe(file, { offset: 0 })).toBeNull();
});

test("describePending phrases the unread tail in bytes", () => {
  expect(host.describePending(2, 4096)).toBe("2 transcript(s), 4096 byte(s)");
  expect(host.describePending(0, 0)).toBe("0 transcript(s), 0 byte(s)");
});

test("skips a session already metered by the portal's proxy", () => {
  process.env.ANTHROPIC_BASE_URL = "https://llm.jianyuelab.net";
  try {
    expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net", reportGatewayTraffic: false })).toMatch(/portal/i);
    expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net", reportGatewayTraffic: true })).toBeNull();
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
});

// --- one request, several lines -------------------------------------------

const base = { input_tokens: 2, cache_read_input_tokens: 68792, cache_creation_input_tokens: 1016 };

test("merges the lines of one request into one event with the final output tokens", () => {
  const file = transcript("m1.jsonl", [
    line("req_m", { ...base, output_tokens: 6 }, { stop: null }),
    line("req_m", { ...base, output_tokens: 21 }, { stop: null }),
    userLine,
    line("req_m", { ...base, output_tokens: 924 }, { stop: "tool_use" }),
  ]);

  const { events, entry } = host.read(file, {});

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ requestId: "req_m", inputTokens: 2, outputTokens: 924, cacheReadTokens: 68792, cacheWrite5mTokens: 1016 });
  expect(entry.offset).toBe(fs.statSync(file).size);
});

test("a following request settles one that never carried a stop reason", () => {
  const file = transcript("m2.jsonl", [
    line("req_a", { ...base, output_tokens: 5 }, { stop: null }),
    line("req_a", { ...base, output_tokens: 300 }, { stop: null }),
    userLine,
    line("req_b", { ...base, output_tokens: 40 }, { stop: "end_turn", id: "msg_2" }),
  ]);

  const { events } = host.read(file, {});

  expect(events.map((e) => [e.requestId, e.outputTokens])).toEqual([["req_a", 300], ["req_b", 40]]);
});

test("holds back a request still being written, and reports it whole on the next read", () => {
  const file = transcript("m3.jsonl", [
    line("req_0", { ...base, output_tokens: 10 }, { id: "msg_0" }),
    userLine,
    line("req_p", { ...base, output_tokens: 5 }, { stop: null }),
  ]);

  const first = host.read(file, {});
  expect(first.events.map((e) => e.requestId)).toEqual(["req_0"]);
  const held = Buffer.byteLength(line("req_0", { ...base, output_tokens: 10 }, { id: "msg_0" }) + "\n" + userLine + "\n");
  expect(first.entry.offset).toBe(held);
  expect(host.probe(file, first.entry).pending).toBeGreaterThan(0);

  fs.appendFileSync(file, line("req_p", { ...base, output_tokens: 3016 }, { stop: "end_turn" }) + "\n");
  const second = host.read(file, first.entry);

  expect(second.events).toHaveLength(1);
  expect(second.events[0]).toMatchObject({ requestId: "req_p", outputTokens: 3016 });
  expect(second.entry.offset).toBe(fs.statSync(file).size);
});

test("a quiet transcript releases its trailing request without a stop reason", () => {
  const file = transcript("m4.jsonl", [line("req_q", { ...base, output_tokens: 7 }, { stop: null })]);
  age(file, QUIET_MS + 60_000);

  const { events, entry } = host.read(file, {});

  expect(events.map((e) => [e.requestId, e.outputTokens])).toEqual([["req_q", 7]]);
  expect(entry.offset).toBe(fs.statSync(file).size);
});

test("across runs, a request read half-written is reported once with its final usage", async () => {
  const sent = [];
  globalThis.fetch = async (_u, init) => {
    const { events } = JSON.parse(init.body);
    sent.push(...events);
    return new Response(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: [] }), { status: 200 });
  };
  const store = createStore(path.join(dir, "state-x"));
  const config = { baseUrl: "https://portal.example", apiKey: "jyl-k", enabled: true, reportGatewayTraffic: false };
  const file = transcript("m5.jsonl", [line("req_x", { ...base, output_tokens: 5 }, { stop: null })]);

  await report(host, store, config, [file], { sweep: true });
  expect(sent).toEqual([]);
  expect(store.readSeen()).toEqual([]);

  fs.appendFileSync(file, line("req_x", { ...base, output_tokens: 3016 }, { stop: "tool_use" }) + "\n");
  await report(host, store, config, [], { sweep: true });

  expect(sent.map((e) => [e.requestId, e.outputTokens])).toEqual([["req_x", 3016]]);
  expect(store.readSeen()).toEqual(["req_x"]);
});
