import { expect, test } from "bun:test";
import { BATCH_SIZE, aiModelToken, authHeader, sendAll, userAgent } from "../src/wakatime/send.mjs";

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

const UA_ARGS = {
  harnessVersion: "27.0.17", pluginVersion: "0.1.0",
  platform: "darwin", release: "27.0.0", arch: "arm64",
};

test("the user agent names the editor, its version, the plugin and the model", () => {
  const ua = userAgent({ ...UA_ARGS, model: "gpt-5.6-sol" });
  expect(ua).toBe(
    "wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 gpt-5.6-sol harness/27.0.17 harness-wakatime/0.1.0",
  );
});

// The go token is not decoration and its absence is not cosmetic: without it
// WakaTime's positional parse slides the leading `wakatime/1.0.0` into the
// AI-model slot, which showed up in the real account as a phantom model named
// "Wakatime" carrying a dollar cost (Task 8, probes P1-P8). A "tidy-up" that
// drops it would be silently wrong on the server and green here without this.
test("the go token sits between the platform group and the model", () => {
  const ua = userAgent({ ...UA_ARGS, model: "gpt-5.6-sol" });
  const tokens = ua.split(" ");
  expect(tokens[1]).toBe("(darwin-27.0.0-arm64)");
  expect(tokens[2]).toBe("go0.0.0");
  expect(tokens[3]).toBe("gpt-5.6-sol");
  // ...and it is still there when there is no model to report, because it is
  // what keeps `wakatime/1.0.0` out of the slot, not what fills it.
  expect(userAgent(UA_ARGS).split(" ")[2]).toBe("go0.0.0");
});

test("no model means no model token, and the rest of the string is unchanged", () => {
  const expected = "wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 harness/27.0.17 harness-wakatime/0.1.0";
  expect(userAgent(UA_ARGS)).toBe(expected);
  expect(userAgent({ ...UA_ARGS, model: "" })).toBe(expected);
  expect(userAgent({ ...UA_ARGS, model: "   " })).toBe(expected);
  expect(userAgent({ ...UA_ARGS, model: null })).toBe(expected);
  expect(userAgent({ ...UA_ARGS, model: 5 })).toBe(expected);
});

// The whole model string is ONE bare token, so WakaTime's cost breakdown --
// which buckets by `ai_model` name only, with the version appearing in neither
// ai_model_costs nor ai_model_breakdown -- gets one row per exact model. The
// `ai_model` values in the comments were read back from the live API, not
// predicted.
test("the model is one bare token, so each exact model gets its own bucket", () => {
  // -> ai_model "Claude-Opus-5", ai_model_version null   (probe P13)
  expect(aiModelToken("claude-opus-5")).toBe("claude-opus-5");
  // -> ai_model "Gpt-5.6-Sol", ai_model_version null     (probe P15)
  expect(aiModelToken("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  // -> ai_model "O3", ai_model_version null              (probe P11)
  expect(aiModelToken("o3")).toBe("o3");

  // No slash is ever emitted. A slash would make WakaTime split the token into
  // name/version, which is exactly the family/variant shape this replaced: it
  // buried harness's spend in a `Claude` bucket that is really Claude Code's
  // `ClaudeCode/<app version>` token misparsed as a model.
  for (const model of ["claude-opus-5", "gpt-5.6-sol", "anthropic/claude-opus-5", "a/b/c"]) {
    expect(aiModelToken(model)).not.toContain("/");
  }
});

test("the two characters that would shift or split the slot are neutralised", () => {
  // `/` is reachable, not theoretical: harness's resolveModelSpec splits a
  // /model argument at the FIRST slash only and leaves the rest in the model
  // name, so payload.model can arrive as "anthropic/claude-opus-5".
  // -> ai_model "Anthropic-Claude-Opus-5", ai_model_version null  (probe P14)
  expect(aiModelToken("anthropic/claude-opus-5")).toBe("anthropic-claude-opus-5");
  expect(aiModelToken("a//b")).toBe("a-b");

  // Whitespace would split one token into two and shift every later slot,
  // editor included -- the UA must stay exactly six tokens.
  expect(aiModelToken("gpt 5.6 sol")).toBe("gpt-5.6-sol");
  expect(aiModelToken("  gpt-5.6-sol  ")).toBe("gpt-5.6-sol");
  expect(userAgent({ ...UA_ARGS, model: "gpt 5.6 sol" }).split(" ")).toHaveLength(6);
  expect(userAgent({ ...UA_ARGS, model: "anthropic/claude opus 5" }).split(" ")).toHaveLength(6);

  // Neutralising can leave a hyphen stranded at either end; don't ship a
  // bucket named "-Gpt".
  expect(aiModelToken("/gpt/")).toBe("gpt");
  expect(aiModelToken("-gpt-")).toBe("gpt");

  // Nothing alphanumeric survived: report no model rather than a punctuation
  // bucket. "///" and " / " collapse to "" via the hyphen trim alone, so they
  // do not exercise the guard -- these do.
  expect(aiModelToken(".")).toBe("");
  expect(aiModelToken("_")).toBe("");
  expect(aiModelToken("..-..")).toBe("");
  expect(aiModelToken("///")).toBe("");
  expect(aiModelToken(" / ")).toBe("");

  expect(aiModelToken(undefined)).toBe("");
  expect(aiModelToken("")).toBe("");
});
