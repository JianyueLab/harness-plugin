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
  // Final review I-4: `tally.accepted` is one of the two numbers --status
  // reports as "is it working", and deleting the line that produces it left
  // all 187 tests green -- every healthy run would then render `accepted 0`,
  // indistinguishable from the total-loss reading. `sent` counts what was
  // attempted and cannot stand in for it.
  expect(res.tally.accepted).toBe(60);
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

// --- per-item verdicts inside an accepted bulk response (final review I-2) ---
//
// The wire shape below is not invented: Task 8 posted real heartbeats to
// api.wakatime.com and recorded the reply (spec §5) -- `202 ACCEPTED` with
// `{"responses": [[{"data": {"id": …}}, 201], …]}`, one `[body, status]` pair
// per heartbeat. Reading only `res.ok`, as this file used to, counted a batch
// WakaTime refused item by item as fully delivered: measured against a fake
// service answering 202 + per-item 400, `--status` showed `spool 0, accepted 3,
// failed 0`, no PROBLEM, and no log file at all.
const bulk202 = (statuses) =>
  new Response(
    JSON.stringify({
      responses: statuses.map((s) =>
        s >= 200 && s < 300 ? [{ data: { id: `id-${s}` } }, s] : [{ errors: ["nope"] }, s],
      ),
    }),
    { status: 202 },
  );

const logging = (responder) => {
  const { ctx, calls } = ctxWith(responder);
  const lines = [];
  ctx.log = (line) => lines.push(line);
  return { ctx, calls, lines };
};

test("per-item rejections inside a 202 are dropped and logged, never counted as accepted", async () => {
  const { ctx, lines } = logging(() => bulk202([201, 400, 201]));
  const res = await sendAll(ctx, beats(3));

  expect(res.tally.accepted).toBe(2);
  expect(res.tally.rejected).toBe(1);
  expect(res.failed).toHaveLength(0); // the same bytes would be refused again
  expect(lines.join("\n")).toContain("wakatime rejected 1 of 3 heartbeat(s) individually, dropping: 400 x1");
});

test("a per-item transient code is owed back to the spool; a per-item 401 is an auth failure", async () => {
  const { ctx, lines } = logging(() => bulk202([500, 401, 201]));
  const res = await sendAll(ctx, beats(3));

  expect(res.tally.accepted).toBe(1);
  expect(res.tally.rejected).toBe(0);
  // Positional, not "the first N": entries line up with the heartbeats as sent.
  expect(res.failed.map((b) => b.entity)).toEqual(["/f0.go", "/f1.go"]);
  expect(res.authFailed).toBe(true);
  expect(lines.join("\n")).toContain("deferred 2 of 3 heartbeat(s) individually (will retry): 500 x1, 401 x1");
});

test("a 202 that carries no per-item verdict is read as accepted, not as lost", async () => {
  // A self-hosted wakapi/hakatime answering `{}`, a body that is not JSON at
  // all, and an empty `responses` array all mean "nothing said about any item".
  // Reading silence as failure would spool every heartbeat such a server
  // accepted, forever.
  for (const body of ["{}", "not json at all", JSON.stringify({ responses: [] })]) {
    const { ctx, lines } = logging(() => new Response(body, { status: 202 }));
    const res = await sendAll(ctx, beats(3));

    expect(res.tally.accepted).toBe(3);
    expect(res.tally.rejected).toBe(0);
    expect(res.failed).toHaveLength(0);
    expect(lines).toHaveLength(0);
  }
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

// Final review M-13. A model id comes straight from the user's own
// config.toml, so a non-ASCII one is reachable -- and it is not a cosmetic
// problem: `fetch` refuses any header value holding a codepoint above U+00FF,
// which `postBatch` catches as a *network* error, so every heartbeat goes back
// to the spool on every run, forever, with nothing naming the cause. The
// runtimes disagree only on the message (bun: "Header 'User-Agent' has invalid
// value"; node: "Cannot convert argument to a ByteString..."), not on the
// throw. Reporting no model is a clean parse (probe P12: `ai_model: null`).
test("a model name the User-Agent cannot carry reports no model, rather than breaking every send", () => {
  expect(aiModelToken("模型-5")).toBe("");
  expect(aiModelToken("claude-模型")).toBe("");
  expect(aiModelToken("模型")).toBe("");
  // latin1 would survive the header layer, but a name whose reading depends on
  // the server's decoding is not the stable bucket name this token exists to
  // be. Printable ASCII or nothing.
  expect(aiModelToken("café-5")).toBe("");
  // A control character is not `\s`, so it survives the whitespace collapse --
  // and would break the header just as surely.
  expect(aiModelToken("gpt\u0001-5")).toBe("");
  // Ordinary ASCII punctuation a gateway might use is untouched.
  expect(aiModelToken("qwen:7b")).toBe("qwen:7b");

  const noModel = "wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 harness/27.0.17 harness-wakatime/0.1.0";
  expect(userAgent({ ...UA_ARGS, model: "模型-5" })).toBe(noModel);

  // The invariant that matters, asserted against the same layer that enforces
  // it in production: whatever the model is, the User-Agent must be a header.
  expect(() => new Headers({ "User-Agent": "模型-5" })).toThrow(); // the hazard is real
  for (const model of ["模型-5", "claude-opus-5", "café-5", "anthropic/claude opus 5", "gpt\u0001-5"]) {
    expect(() => new Headers({ "User-Agent": userAgent({ ...UA_ARGS, model }) })).not.toThrow();
  }
});
