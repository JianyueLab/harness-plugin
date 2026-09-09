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
    // The old fixture buried its varint twelve layers below `maxDepth: 3`, so
    // `sc.varints` was always empty and `.every()` passed vacuously over
    // nothing — the assertion would have survived deleting the depth check
    // entirely. Nesting the marker exactly at the boundary and one layer past
    // it tests the boundary itself: a field's own contents are read
    // regardless of depth (recursion only gates descending into a *nested*
    // message), so a varint exactly `maxDepth` layers down is still found,
    // and one `maxDepth + 1` layers down is not, because the recursion that
    // would have exposed it never happens.
    const nest = (n, inner) => {
      let b = inner;
      for (let i = 0; i < n; i++) b = msg(bytes(1, b));
      return b;
    };
    const atBoundary = scan(nest(3, msg(vint(9, 111))), { maxDepth: 3 });
    const pastBoundary = scan(nest(4, msg(vint(9, 111))), { maxDepth: 3 });

    expect(atBoundary.varints.get("1.1.1.9")).toEqual([111]);
    expect(pastBoundary.varints.size).toBe(0);
  });

  test("a blown node budget keeps what it already indexed", () => {
    const many = msg(...Array.from({ length: 50 }, (_, i) => vint(i + 1, i + 1)));
    const sc = scan(many, { maxNodes: 10 });
    expect(sc.varints.size).toBeGreaterThan(0);
    expect(sc.varints.size).toBeLessThan(50);
  });
});
