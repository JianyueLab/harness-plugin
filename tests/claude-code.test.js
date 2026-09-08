import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host } from "../src/hosts/claude-code.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-cc-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const assistant = (requestId, usage, model = "claude-opus-5") =>
  JSON.stringify({ type: "assistant", requestId, timestamp: "2026-09-08T00:00:00.000Z", message: { id: "msg_1", model, usage } });

function transcript(name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

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

test("skips a session already metered by the portal's proxy", () => {
  process.env.ANTHROPIC_BASE_URL = "https://llm.jianyuelab.net";
  try {
    expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net", reportGatewayTraffic: false })).toMatch(/portal/i);
    expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net", reportGatewayTraffic: true })).toBeNull();
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
});
