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
    // inventing an entity for them would be a lie.
    if (typeof call.path !== "string" || !call.path) continue;

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
    // All three input counters. Cache reads are tokens the model processed and
    // the subscription paid for; WakaTime has no field to split them out.
    ai_input_tokens:
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
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
 */
export function throttle(beats, state, nowMs) {
  const seen = (state.wakatimeSeen ??= {});
  const out = [];

  for (const beat of beats) {
    const last = seen[beat.entity];
    if (!beat.is_write && typeof last === "number" && nowMs - last < THROTTLE_MS) continue;
    seen[beat.entity] = nowMs;
    out.push(beat);
  }

  // Prune on write so the state file cannot grow without bound.
  for (const [entity, at] of Object.entries(seen)) {
    if (nowMs - at > SEEN_TTL_MS) delete seen[entity];
  }
  return out;
}
