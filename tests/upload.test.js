import { afterEach, expect, test } from "bun:test";
import { upload } from "../src/core/upload.mjs";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const ctx = { config: { baseUrl: "https://portal.example", apiKey: "jyl-k" }, source: "antigravity", client: "test/1", log: () => {} };
const events = (n) => Array.from({ length: n }, (_, i) => ({ requestId: `r${i}` }));

test("posts the declared source and client to the ingest route", async () => {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ received: 1, accepted: 1, duplicates: 0, rejected: [] }), { status: 200 });
  };

  const { tally } = await upload(ctx, events(1));

  expect(seen.url).toBe("https://portal.example/v1/usage/ingest");
  expect(seen.body.source).toBe("antigravity");
  expect(seen.body.client).toBe("test/1");
  expect(seen.auth).toBe("Bearer jyl-k");
  expect(tally.accepted).toBe(1);
});

test("splits batches at the portal's 500-event cap", async () => {
  const sizes = [];
  globalThis.fetch = async (_url, init) => {
    sizes.push(JSON.parse(init.body).events.length);
    return new Response(JSON.stringify({ accepted: 0, duplicates: 0, rejected: [] }), { status: 200 });
  };

  await upload(ctx, events(1100));

  expect(sizes).toEqual([500, 500, 100]);
});

test("spools a rejected key rather than dropping real usage", async () => {
  globalThis.fetch = async () => new Response("bad key", { status: 401 });
  const { failed, tally } = await upload(ctx, events(3));
  expect(failed).toHaveLength(3);
  expect(tally.spooled).toBe(3);
});

test("drops a payload no retry could fix", async () => {
  globalThis.fetch = async () => new Response("unknown source", { status: 400 });
  const { failed } = await upload(ctx, events(3));
  expect(failed).toHaveLength(0);
});

test("spools when the network fails", async () => {
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  const { failed } = await upload(ctx, events(2));
  expect(failed).toHaveLength(2);
});
