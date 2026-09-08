import { describe, expect, test } from "bun:test";
import { scan } from "../src/lib/protobuf.mjs";
import { bytes, msg, str, vint } from "./helpers/pb.js";

describe("scan", () => {
  test("indexes varints, strings and submessages by dotted path", () => {
    const inner = msg(vint(2, 26404), vint(3, 193), vint(9, 136), vint(10, 57));
    const blob = msg(bytes(1, msg(bytes(4, inner), str(19, "gemini-3.8-flash"))));

    const sc = scan(blob);

    expect(sc.varints.get("1.4.2")).toEqual([26404]);
    expect(sc.varints.get("1.4.3")).toEqual([193]);
    expect(sc.strings.get("1.19")).toEqual(["gemini-3.8-flash"]);
    expect(sc.submessages.get("1.4")).toHaveLength(1);
  });

  test("keeps repeated fields in encounter order", () => {
    const pair = (k, v) => bytes(20, msg(str(1, k), str(2, v)));
    const blob = msg(bytes(1, msg(pair("trajectory_id", "abc"), pair("request_id", "abc-40"))));

    const entries = scan(blob).submessages.get("1.20");

    expect(entries).toHaveLength(2);
    expect(scan(entries[0]).strings.get("1")).toEqual(["trajectory_id"]);
    expect(scan(entries[1]).strings.get("2")).toEqual(["abc-40"]);
  });

  test("returns empty maps for bytes that are not protobuf at all", () => {
    const sc = scan(Buffer.from("not a protobuf, just text", "utf8"));
    expect(sc.varints.size + sc.strings.size + sc.submessages.size).toBe(0);
  });

  test("does not recurse past maxDepth", () => {
    let blob = msg(vint(1, 99));
    for (let i = 0; i < 12; i++) blob = msg(bytes(1, blob));
    const sc = scan(blob, { maxDepth: 3 });
    expect([...sc.varints.keys()].every((k) => k.split(".").length <= 4)).toBe(true);
  });

  test("a blown node budget keeps what it already indexed", () => {
    const many = msg(...Array.from({ length: 50 }, (_, i) => vint(i + 1, i + 1)));
    const sc = scan(many, { maxNodes: 10 });
    expect(sc.varints.size).toBeGreaterThan(0);
    expect(sc.varints.size).toBeLessThan(50);
  });
});
