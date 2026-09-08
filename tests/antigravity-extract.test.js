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
});
