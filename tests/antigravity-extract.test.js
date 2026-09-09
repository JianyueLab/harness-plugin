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
    // Field 12: genuinely unused in real blobs, unlike field 7 (which is real
    // but holds a string — `bot-<uuid>` — never a varint, so encoding it as
    // one here would not be a shape `agy` could actually emit).
    const unknown = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 3507), vint(3, 2729), vint(5, 82207), vint(12, 123), vint(9, 993), vint(10, 1736))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-unk"))),
      )),
    );
    expect(eventFromBlob(unknown, { ts: TS })).toBeNull();
  });

  test("returns null if called without a timestamp", () => {
    expect(eventFromBlob(blob())).toBeNull();
  });

  test("does not skip a row carrying field 6 at its known value, 24", () => {
    // Field 6 was never agy drift — it is present on the very rows the design
    // doc's field table was built from (f545305a idx 0 and idx 40), which
    // just never enumerated it. The unknown-field guard was transcribed from
    // that table rather than derived from a blob, so it rejected every row on
    // first real use: 0 events from 462 real generations, until this fix.
    // Real figure: `1.4.6 == 24` on all 487 count-bearing rows across the 7
    // (of 9) local conversation databases that have any rows at all.
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

  test("skips a row where field 6 is present but not its pinned value, 24", () => {
    // Field 6 is permitted only at the one value ever observed. If a future
    // agy reuses this field number for a real count, this must fail rather
    // than silently pass the tokens through unread.
    const wrongSentinel = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 3507), vint(3, 2729), vint(5, 82207), vint(6, 25), vint(9, 993), vint(10, 1736))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-f6-wrong"))),
      )),
    );
    expect(eventFromBlob(wrongSentinel, { ts: TS })).toBeNull();
  });
});
