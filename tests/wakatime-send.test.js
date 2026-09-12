import { expect, test } from "bun:test";
import { BATCH_SIZE, authHeader, sendAll, userAgent } from "../src/wakatime/send.mjs";

const beat = (i) => ({ entity: `/f${i}.go`, type: "file", time: i, category: "ai coding" });
const beats = (n) => Array.from({ length: n }, (_, i) => beat(i));

function ctxWith(responder) {
  const calls = [];
  return {
    calls,
    ctx: {
      apiUrl: "https://api.wakatime.com/api/v1",
      apiKey: "waka_secret",
      ua: "wakatime/1.0.0 (darwin) harness/27.0.17 harness-wakatime/0.1.0",
      log: () => {},
      fetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return responder(calls.length);
      },
    },
  };
}

const ok = () => new Response(JSON.stringify({ responses: [] }), { status: 201 });

test("the key goes in the header, never in the url", async () => {
  const { ctx, calls } = ctxWith(ok);
  await sendAll(ctx, beats(1));

  expect(calls[0].url).toBe("https://api.wakatime.com/api/v1/users/current/heartbeats.bulk");
  expect(calls[0].url).not.toContain("waka_secret");
  expect(calls[0].init.headers.Authorization).toBe(authHeader("waka_secret"));
  expect(calls[0].init.headers.Authorization.startsWith("Basic ")).toBe(true);
  expect(calls[0].init.headers["User-Agent"]).toContain("harness-wakatime/");
});

test("60 heartbeats go out as 25 / 25 / 10", async () => {
  const { ctx, calls } = ctxWith(ok);
  const res = await sendAll(ctx, beats(60));

  expect(calls.map((c) => c.body.length)).toEqual([25, 25, 10]);
  expect(BATCH_SIZE).toBe(25);
  expect(res.tally.sent).toBe(60);
  expect(res.failed).toHaveLength(0);
});

test("network trouble and 5xx go back to the spool", async () => {
  for (const responder of [
    () => { throw new Error("ECONNREFUSED"); },
    () => new Response("boom", { status: 500 }),
  ]) {
    const { ctx } = ctxWith(responder);
    const res = await sendAll(ctx, beats(3));
    expect(res.failed).toHaveLength(3);
  }
});

test("429 spools and stops sending further batches this run", async () => {
  const { ctx, calls } = ctxWith(() => new Response("slow down", { status: 429 }));
  const res = await sendAll(ctx, beats(60));

  expect(calls).toHaveLength(1);          // gave up after the first 429
  expect(res.failed).toHaveLength(60);    // including the batches never attempted
});

test("401 spools and is reported as an auth failure", async () => {
  const { ctx } = ctxWith(() => new Response("bad key", { status: 401 }));
  const res = await sendAll(ctx, beats(2));

  expect(res.failed).toHaveLength(2);
  expect(res.authFailed).toBe(true);
});

test("400 drops the batch — the same bytes will never be accepted", async () => {
  const { ctx } = ctxWith(() => new Response("malformed", { status: 400 }));
  const res = await sendAll(ctx, beats(2));

  expect(res.failed).toHaveLength(0);
  expect(res.tally.rejected).toBe(2);
});

test("the user agent names the editor, its version and the plugin", () => {
  const ua = userAgent({
    harnessVersion: "27.0.17", pluginVersion: "0.1.0",
    platform: "darwin", release: "27.0.0", arch: "arm64",
  });
  expect(ua).toBe("wakatime/1.0.0 (darwin-27.0.0-arm64) harness/27.0.17 harness-wakatime/0.1.0");
});
