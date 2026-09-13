/**
 * harness's RunEnd payload -> WakaTime heartbeats.
 *
 * Two kinds come out of one payload:
 *
 *   - one `file` heartbeat per tool call that carries a path;
 *   - exactly one `app` heartbeat for the run itself, which is where the
 *     token fields ride.
 *
 * Keeping the tokens on the run heartbeat is not tidiness: a run that edits
 * five files would otherwise report the same tokens five times. The run
 * heartbeat also covers the run where the agent did nothing but `bash` —
 * work happened, and the time should not be zero because no file was named.
 */
import { languageFor } from "./language.mjs";

export const THROTTLE_MS = 120_000;
const SEEN_TTL_MS = 24 * 3600 * 1000;
const CATEGORY = "ai coding";

/** Tools that mean "this file was written", per WakaTime's is_write. */
const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

/**
 * WakaTime's own convention for hidden names: keep the extension so language
 * stats survive, drop everything identifying.
 */
const obfuscate = (p) => {
  const dot = p.lastIndexOf(".");
  return dot > 0 ? `HIDDEN${p.slice(dot)}` : "HIDDEN";
};

export function heartbeatsFrom(payload, { project, branch, hideFileNames } = {}) {
  const beats = [];

  for (const call of Array.isArray(payload.tools) ? payload.tools : []) {
    // No path means no entity. bash, glob, grep and every MCP tool land here;
    // inventing an entity for them would be a lie. `call` itself can be
    // null/undefined too — `"tools": [null, {...}]` is valid JSON — so guard
    // that before touching `.path`, or a malformed batch throws and the hook
    // loses every heartbeat in the run, not just the bad entry.
    if (!call || typeof call.path !== "string" || !call.path) continue;

    const beat = {
      entity: hideFileNames ? obfuscate(call.path) : call.path,
      type: "file",
      time: call.at,
      category: CATEGORY,
      is_write: WRITE_TOOLS.has(call.name),
    };
    if (project) beat.project = project;
    if (branch) beat.branch = branch;
    const lang = languageFor(call.path);
    if (lang) beat.language = lang;
    beats.push(beat);
  }

  const usage = payload.usage ?? {};
  const run = {
    entity: "harness",
    type: "app",
    time: payload.ended_at,
    category: CATEGORY,
    ai_session: payload.session_id,
    // Cache reads go in their own field rather than being folded into
    // ai_input_tokens. An earlier draft summed all three input counters
    // because "WakaTime has no field to split them out" — that reason was
    // checked against the live API in Task 8 and is false:
    // `ai_cached_input_tokens` exists and is writable (4242 was sent and came
    // back stored). Folding them together made a run's fresh input look larger
    // than it was, for no gain.
    //
    // **Cache *creation* stays on the fresh side, with `input_tokens`.** Only
    // the read counter moves. Creation tokens are tokens the model actually
    // processed this turn — they were sent up in full and written into the
    // cache on the way through, which is why providers bill them at a premium
    // rather than at the cache-hit rate. Only `cache_read_input_tokens` names
    // tokens that were *served from* the cache instead of processed. The two
    // fields therefore still add up to the same total as before; nothing is
    // lost or double-counted, the split just stops overstating fresh input.
    ai_input_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    ai_cached_input_tokens: usage.cache_read_input_tokens ?? 0,
    ai_output_tokens: usage.output_tokens ?? 0,
    ai_prompt_length: payload.prompt_chars ?? 0,
  };
  if (project) run.project = project;
  beats.push(run);

  return beats;
}

/**
 * WakaTime's rule for editor plugins: skip a heartbeat if the same file went
 * out within 120 seconds, unless it is a write.
 *
 * The last-sent time per entity lives in the shared state file. It is not in
 * `store`'s `seen` file — that is a set of keys and cannot carry a timestamp.
 *
 * The window is judged per beat, from that beat's own `time` (epoch seconds,
 * straight from harness's payload) — not from `nowMs`. A single run can span
 * several minutes, so every beat in one batch sharing one clock reading would
 * collapse repeat edits of the same file into one heartbeat regardless of how
 * far apart they actually happened, and would judge a late-processed batch's
 * fresh beats against a stale clock. `nowMs` keeps exactly one job: the
 * 24-hour prune below, which is about how stale the *state file* is, not any
 * one beat.
 *
 * The rule applies to `file` beats only. The `app` beat is a once-per-run
 * bookkeeping record, not a repeated touch of anything, and each one carries
 * that run's own token counts: two short runs finishing within 120s of each
 * other (the ordinary case, not an edge case) must not have the second run's
 * counts silently dropped because the first run's app beat is still in the
 * window.
 */
export function throttle(beats, state, nowMs) {
  const seen = (state.wakatimeSeen ??= {});
  const out = [];

  for (const beat of beats) {
    if (beat.type !== "file") {
      out.push(beat);
      continue;
    }

    const at = Number.isFinite(beat.time) ? beat.time * 1000 : nowMs;
    const last = seen[beat.entity];
    if (!beat.is_write && typeof last === "number" && at - last < THROTTLE_MS) continue;
    seen[beat.entity] = at;
    out.push(beat);
  }

  // Prune on every call (not just writes) so the state file cannot grow
  // without bound.
  for (const [entity, at] of Object.entries(seen)) {
    if (nowMs - at > SEEN_TTL_MS) delete seen[entity];
  }
  return out;
}
