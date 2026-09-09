import { describe, expect, test } from "bun:test";
import { eventFromBlob } from "../src/hosts/antigravity/extract.mjs";
import { bytes, msg, str, vint } from "./helpers/pb.js";

const TS = "2026-09-08T03:58:59Z";

/** One `gen_metadata.data` blob, shaped like the ones agy 2.12.0 writes. */
function blob({ input = 3507, cached = 82207, think = 993, text = 1736, model = "gemini-3.8-flash", requestId = "traj-40" } = {}) {
  const usage = msg(
    vint(1, 1318), // model enum, not a token count
    vint(2, input),
    vint(3, think + text),
    vint(5, cached),
    vint(9, think),
    vint(10, text),
  );
  const pair = (k, v) => bytes(20, msg(str(1, k), str(2, v)));
  return msg(
    bytes(1, msg(
      bytes(4, usage),
      str(19, model),
      pair("trajectory_id", "traj"),
      pair("request_id", requestId),
      pair("model_enum", "MODEL_PLACEHOLDER_M318"),
    )),
  );
}

describe("eventFromBlob", () => {
  test("maps agy's counts onto the portal's fields", () => {
    expect(eventFromBlob(blob(), { ts: TS })).toEqual({
      requestId: "traj-40",
      ts: TS,
      model: "gemini-3.8-flash",
      inputTokens: 3507,
      outputTokens: 2729,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 82207,
    });
  });

  test("treats a missing cache field as zero, not as a broken row", () => {
    const first = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 26404), vint(3, 193), vint(9, 136), vint(10, 57))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-0"))),
      )),
    );
    const event = eventFromBlob(first, { ts: TS });
    expect(event.cacheReadTokens).toBe(0);
    expect(event.inputTokens).toBe(26404);
    expect(event.outputTokens).toBe(193);
  });

  test("skips a row whose output total does not equal its parts", () => {
    const drifted = msg(
      bytes(1, msg(
        bytes(4, msg(vint(2, 100), vint(3, 999), vint(9, 10), vint(10, 20))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-1"))),
      )),
    );
    expect(eventFromBlob(drifted, { ts: TS })).toBeNull();
  });

  test("skips a row with no request id, which could never be deduplicated", () => {
    expect(eventFromBlob(blob({ requestId: "" }), { ts: TS })).toBeNull();
  });

  test("skips a row that spent nothing", () => {
    expect(eventFromBlob(blob({ input: 0, cached: 0, think: 0, text: 0 }), { ts: TS })).toBeNull();
  });

  test("reports whatever model the row names, Gemini or not", () => {
    const event = eventFromBlob(blob({ model: "claude-sonnet-5" }), { ts: TS });
    expect(event.model).toBe("claude-sonnet-5");
  });

  test("skips a row with no model, which could never be reported", () => {
    const noModel = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 3507), vint(3, 2729), vint(5, 82207), vint(9, 993), vint(10, 1736))),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-0"))),
      )),
    );
    expect(eventFromBlob(noModel, { ts: TS })).toBeNull();
  });

  test("reads counts from the 1.17.2 fallback path", () => {
    const fallback = msg(
      bytes(1, msg(
        bytes(17, msg(bytes(2, msg(vint(1, 1318), vint(2, 1000), vint(3, 500), vint(9, 200), vint(10, 300))))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-fb"))),
      )),
    );
    const event = eventFromBlob(fallback, { ts: TS });
    expect(event).toEqual({
      requestId: "traj-fb",
      ts: TS,
      model: "gemini-3.8-flash",
      inputTokens: 1000,
      outputTokens: 500,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    });
  });

  test("skips a row with an unrecognised field number in the counts message", () => {
    const unknown = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 3507), vint(3, 2729), vint(5, 82207), vint(7, 123), vint(9, 993), vint(10, 1736))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-unk"))),
      )),
    );
    expect(eventFromBlob(unknown, { ts: TS })).toBeNull();
  });

  test("returns null if called without a timestamp", () => {
    expect(eventFromBlob(blob())).toBeNull();
  });

  test("does not skip a row carrying field 6 — a real agy 1.1.27 addition, constant across every sampled row", () => {
    // Found on real conversation databases while running Task 11's end-to-end
    // verification: agy 1.1.27 (the design doc's fixtures predate it, written
    // against "agy 2.12.0") adds a seventh varint to the counts message,
    // `1.4.6`, holding a constant `24` in every one of ~500 real rows across
    // 8 conversations regardless of token counts — not a token count itself,
    // just a field this plugin had never seen. Before this fix every row on
    // that machine was skipped by the unknown-field guard: 0 events from 462
    // real generations.
    const withField6 = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 3507), vint(3, 2729), vint(5, 82207), vint(6, 24), vint(9, 993), vint(10, 1736))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-f6"))),
      )),
    );
    const event = eventFromBlob(withField6, { ts: TS });
    expect(event).toEqual({
      requestId: "traj-f6",
      ts: TS,
      model: "gemini-3.8-flash",
      inputTokens: 3507,
      outputTokens: 2729,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 82207,
    });
  });
});
