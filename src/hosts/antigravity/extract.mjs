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
 * Because the mapping is inferred, it is checked rather than trusted: the
 * output total must equal thinking plus text. A future `agy` that renumbers
 * these fields makes the check fail, and a failed check means the row is
 * skipped — under-reporting, which `--status` shows, instead of wrong numbers,
 * which nobody would notice.
 */

import { scan } from "../../lib/protobuf.mjs";

const USAGE_PATHS = ["1.4", "1.17.2"];
const MODEL_PATH = "1.19";
const PAIRS_PATH = "1.20";

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
    const at = (field) => int(sc.varints.get(`${base}.${field}`)?.[0]);
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

export function eventFromBlob(data, { ts }) {
  const sc = scan(data);

  const model = sc.strings.get(MODEL_PATH)?.[0]?.trim();
  if (!model) return null;

  const requestId = pairsFrom(sc).get("request_id")?.trim();
  if (!requestId) return null;

  const usage = usageFrom(sc);
  if (!usage) return null;
  if (usage.input + usage.cached + usage.output === 0) return null;

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
