/**
 * One `gen_metadata` blob → one reportable event.
 *
 * `agy` ships no schema for this, so the paths below were established by
 * reading real blobs from agy 2.12.0 and are documented in
 * `docs/superpowers/specs/2026-09-08-agy-usage-reporter-design.md`:
 *
 *   1.19   the model id, as a plain string ("gemini-3.8-flash")
 *   1.20   a repeated {1: key, 2: value} table holding `request_id` among others
 *   1.4    the counts, mirrored at 1.17.2
 *
 * Inside the counts message, field 1 is *not* a token count — it is the model
 * enum, constant across every row of a conversation (1318 ↔
 * `MODEL_PLACEHOLDER_M318` in the same blob's key/value table). Mistaking it for
 * input tokens would have added a fixed 1318 to every request.
 *
 * Because the mapping is inferred, it is checked rather than trusted:
 * 1. The output total must equal thinking plus text (fields 3, 9, 10) — this
 *    catches drift in the output triad.
 * 2. Every varint field number in the counts message must be from the known set
 *    {1, 2, 3, 5, 6, 9, 10} — this catches renumbering that introduces new fields.
 * 3. Neither guard catches a permutation among the six token-bearing field numbers.
 *
 * A failed check means the row is skipped — under-reporting, which `--status`
 * shows, instead of wrong numbers, which nobody would notice.
 *
 * **Field 6 was never `agy` drift — it was in the design document's own
 * evidence all along.** It is present on `f545305a…` idx 0 and idx 40, the
 * exact two rows the design doc's field table quotes verbatim ("26404 on the
 * first generation", "3507 … then 82207", `request_id …-40`). The unknown-field
 * guard landed at `e7e0ff3` citing a real-data run made *before* the guard
 * existed (`6b69c48`, 168/168) as its validation, so `KNOWN_USAGE_FIELDS` was
 * transcribed from the design doc's table rather than derived from a blob —
 * Task 11 was the guard's first real test, not a vendor change catching it.
 * Commit `c126cdc` names the cause as agy 1.1.27 drift; that is wrong, left as
 * history, corrected here and in the design doc. Real figures: field 6 is
 * `24` on all 487 count-bearing rows across the 7 (of 9) local conversation
 * databases that have any rows — constant regardless of token counts, so it
 * is not itself a token count, but its value is pinned rather than merely
 * permitted (below): a future `agy` reusing field 6 for a real count must
 * fail the guard, not silently vanish into an unread field.
 */

import { scan } from "../../lib/protobuf.mjs";

const USAGE_PATHS = ["1.4", "1.17.2"];
const MODEL_PATH = "1.19";
const PAIRS_PATH = "1.20";

/** Every varint field number we have ever seen in a counts message. */
const KNOWN_USAGE_FIELDS = new Set([1, 2, 3, 5, 6, 9, 10]);
/**
 * Field 6's only ever-observed value. Permitting the field's presence
 * unconditionally would let a future `agy` repurpose it for a real count and
 * have those tokens silently dropped — exactly the failure this whole guard
 * exists to prevent. Pinning it converts "always 24 in practice" from an
 * assertion in a comment into something the code actually checks.
 */
const FIELD_6_SENTINEL = 24;

const int = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function pairsFrom(sc) {
  const out = new Map();
  for (const entry of sc.submessages.get(PAIRS_PATH) ?? []) {
    const inner = scan(entry, { maxDepth: 2 });
    const key = inner.strings.get("1")?.[0];
    const value = inner.strings.get("2")?.[0];
    if (key) out.set(key, value ?? "");
  }
  return out;
}

function usageFrom(sc) {
  for (const base of USAGE_PATHS) {
    // Check that all field numbers are from the known set.
    const prefix = `${base}.`;
    const presentFields = [...sc.varints.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => {
        const remainder = k.substring(prefix.length);
        const parts = remainder.split(".");
        // Only count direct children (single number segment)
        return parts.length === 1 ? parseInt(remainder, 10) : null;
      })
      .filter((f) => f !== null);
    if (presentFields.some((f) => !KNOWN_USAGE_FIELDS.has(f))) continue;

    const at = (field) => int(sc.varints.get(`${base}.${field}`)?.[0]);
    // Field 6 is permitted only at its one ever-observed value. A future
    // `agy` reusing this field number for a real count must fail here, not
    // pass through unread — see the header.
    if (presentFields.includes(6) && at(6) !== FIELD_6_SENTINEL) continue;
    const total = at(3);
    const thinking = at(9);
    const text = at(10);
    const input = at(2);
    const cached = at(5);
    if (total === 0 && input === 0 && cached === 0) continue;
    if (total !== thinking + text) continue; // the invariant; see the header
    return { input, cached, output: total };
  }
  return null;
}

export function eventFromBlob(data, { ts } = {}) {
  if (!ts) return null;

  const sc = scan(data);

  const model = sc.strings.get(MODEL_PATH)?.[0]?.trim();
  if (!model) return null;

  const requestId = pairsFrom(sc).get("request_id")?.trim();
  if (!requestId) return null;

  const usage = usageFrom(sc);
  if (!usage) return null;

  return {
    requestId,
    ts,
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    // Gemini's implicit caching has no separately-priced write, so both write
    // buckets are structurally zero here rather than merely unknown.
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: usage.cached,
  };
}
