/**
 * POST heartbeats to WakaTime.
 *
 * This is not `src/core/upload.mjs`. That one is written for llm-web's ingest
 * route and bound to it — 500 per batch, the `invalid_source` code, the
 * accepted/duplicates/rejected body. What is copied from it is the part worth
 * keeping: classify every failure by whether *the same bytes* could ever
 * succeed, return `{tally, failed}`, and let the caller own the spool. Writing
 * the spool in here would mean two functions deciding what is still owed.
 */

/** WakaTime's documented cap for the bulk endpoint. */
export const BATCH_SIZE = 25;
/** A hook that hangs is worse than activity reported a run late. */
const REQUEST_TIMEOUT_MS = 10_000;

export function authHeader(apiKey) {
  return `Basic ${Buffer.from(apiKey).toString("base64")}`;
}

/**
 * The `go<version>` token below is **required by WakaTime's parser and its
 * value is ignored**, so it carries an obviously-synthetic one.
 *
 * WakaTime reads the User-Agent positionally, and the element between the
 * `(os-release-arch)` group and the AI-model slot must literally start with
 * `go`. Verified against the live API (Task 8, probes P5–P8): with the token
 * absent, the *leading* `wakatime/1.0.0` slides into the AI-model slot and the
 * account's model-cost breakdown grows a phantom model called "Wakatime";
 * with a non-`go` token in that position (`bun1.4.2`, `bun/1.4.2`) the parse
 * shifts exactly the same way. `go0.0.0` parses identically to a real
 * `go1.27.1` — `editor`, `version`, `os`, `cli_version`, `ai_model` and
 * `ai_model_version` all come back the same.
 *
 * `0.0.0` rather than harness's actual Go version because **this tool cannot
 * know it**: the RunEnd payload carries no Go version, so the only way to put
 * a real one here is to hardcode it, and a hardcoded toolchain version goes
 * stale silently while still reading as authoritative. A transparently fake
 * one cannot mislead. (`go_version` on the user-agent resource will read
 * `0.0.0`; nothing else consumes it.)
 */
const GO_TOKEN = "go0.0.0";

/**
 * The model name as **one bare token**, so WakaTime records the whole model
 * string as the AI-model name and nothing as its version.
 *
 * The result lands in `ai_model` with each `-`-separated segment title-cased,
 * and `ai_model_version` stays `null`. Read back from the live API:
 * `claude-opus-5` → `"Claude-Opus-5"` (P13), `gpt-5.6-sol` → `"Gpt-5.6-Sol"`
 * (P15), `anthropic-claude-opus-5` → `"Anthropic-Claude-Opus-5"` (P14).
 *
 * **Why one bare token and not `family/variant`.** WakaTime's summaries
 * attribute cost by `ai_model` **name only** — `ai_model_costs` is
 * `{name: cost}` and `ai_model_breakdown` rows are exactly
 * `{name, lines, cost}`, with the version appearing in neither. So whatever
 * goes in the family half *is* the bucket, and everything after the slash is
 * decoration. Sending `claude/opus-5` and `claude/sonnet-5` put both runs in
 * one `Claude` bucket — and that bucket is not "the Claude model" at all: in
 * this account it holds 200 user-agent rows created from Claude Code's own
 * `ClaudeCode/2.1.143` editor token, which WakaTime misreads as model `Claude`
 * version `2.1.143`. An earlier revision of this comment claimed the split
 * made harness "aggregate with" the other integrations; that was backwards.
 * Claude Code reports `opus/4-8` and `sonnet/5`, whose family names are `Opus`
 * and `Sonnet` — so `claude/…` aligns with neither, and merely buries
 * harness's spend inside another tool's bucket.
 *
 * **Why not mimic the other integrations and send the variant first**
 * (`opus/5`, the shape `Opus`/`Sonnet`/`Haiku`/`Gemini` come from): **it is not
 * computable.** `gpt-5.6-sol`'s family is its first segment, `claude-opus-5`'s
 * family is its *second*. Telling those apart requires a table of which
 * leading words are vendors rather than families — and that table rots exactly
 * the way the rest of this file's history warns about: when it is missing an
 * entry it does not fail, it silently mints a new bucket under the wrong name,
 * with no way to notice short of another live probe. One bucket per exact model
 * string needs no table and cannot be silently wrong.
 *
 * The cost of that choice is stated in the README: harness's `Opus` time will
 * not merge with Claude Code's `Opus` row. Per-tool slicing is what the
 * `editors` breakdown is for, and `Harness` is already its own row there.
 *
 * Two characters must be neutralised, and only these two are:
 *
 *  - **Whitespace**, because the User-Agent grammar is whitespace-delimited:
 *    one space inside a model name would split it into two tokens and shift
 *    every slot after it, the editor included.
 *  - **`/`**, because the slot is split on it into name/version — which is the
 *    whole thing this token exists to avoid. This is reachable, not theoretical:
 *    harness's `resolveModelSpec` splits a `/model` argument at the *first*
 *    slash only and deliberately leaves the remainder in the model name ("某些
 *    网关用路径式命名"), so `payload.model` can arrive as
 *    `anthropic/claude-opus-5`. Passing that through would have re-created the
 *    `family/variant` shape with a vendor as the bucket name.
 *
 * Both become `-`, which is already the separator a bare token tolerates, so
 * the full model string stays readable in the dashboard. Leading and trailing
 * hyphens are trimmed, and a name with nothing alphanumeric left reports no
 * model at all rather than a token like `---`.
 *
 * Returns `""` when there is no model to report, which is a legal parse: with
 * the `go` token present the slot is simply empty and `ai_model` comes back
 * `null` (P12). It does **not** reintroduce the "Wakatime" bug — that needs the
 * `go` token to be missing.
 */
export function aiModelToken(model) {
  if (typeof model !== "string") return "";
  const token = model
    .trim()
    .replace(/[\s/]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A model name this tool cannot put in a header reports **no model at all**,
  // rather than a mangled bucket name or a request that cannot be sent.
  //
  // This is not defensive tidiness. `fetch` refuses a header value holding any
  // codepoint above U+00FF -- measured on both runtimes this tool supports:
  // bun 1.4.2 throws `TypeError: Header 'User-Agent' has invalid value`, node
  // v26.8.2 throws `Cannot convert argument to a ByteString because the
  // character at index 0 has a value of 27169 which is greater than 255`. That
  // throw happens inside `postBatch`'s try, so it is classified as a *network*
  // error: every heartbeat goes back to the spool, every run, forever, with a
  // log line naming a header problem and nothing naming the cause. A model id
  // reaches here straight from the user's own `config.toml`, so a non-ASCII one
  // is reachable, not theoretical.
  //
  // The restriction is to printable ASCII rather than to latin1 (which the
  // header layer does accept -- `café-5` goes out fine) because this token's
  // only job is to be a stable bucket name in someone's dashboard, and a byte
  // sequence whose reading depends on how the server decodes it is not stable.
  // Dropping such a name costs one empty AI-model slot, which is a clean parse
  // (probe P12: `ai_model: null`, everything else intact) -- against a reporter
  // that silently never sends again.
  if (!/^[\x21-\x7e]+$/.test(token)) return "";
  return /[a-z0-9]/i.test(token) ? token : "";
}

/**
 * WakaTime detects editor, OS and the AI model by parsing this.
 *
 * Verified against the live API (Task 8): `harness/<ver>` in the editor slot is
 * recognised as `editor: "Harness"` with no registration, and `os` comes back
 * `"Mac"` on darwin. Two slots do **not** mean what their position suggests and
 * are documented where they are built: `GO_TOKEN` above, and `version` on the
 * user-agent resource, which reports *this plugin's* version (the last token),
 * never harness's — WakaTime discards the editor's own version for every plugin
 * in the account, so `harnessVersion` is sent but never surfaced there.
 */
export function userAgent({ harnessVersion, pluginVersion, platform, release, arch, model }) {
  const parts = [`wakatime/1.0.0`, `(${platform}-${release}-${arch})`, GO_TOKEN];
  const modelToken = aiModelToken(model);
  if (modelToken) parts.push(modelToken);
  parts.push(`harness/${harnessVersion}`, `harness-wakatime/${pluginVersion}`);
  return parts.join(" ");
}

/**
 * Which bucket a status code falls in. One function so a per-item code and a
 * whole-request code can never be classified by two drifting rules.
 *
 *  - `ok`          — kept by WakaTime, nothing owed
 *  - `auth`        — 401/403: back to the spool *and* bump `authFailures`
 *  - `rateLimited` — 429: back to the spool
 *  - `retry`       — 5xx and anything else transient: back to the spool
 *  - `drop`        — every other non-2xx: the same bytes will be refused again
 */
function verdictFor(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "retry";
  return "drop";
}

/**
 * The per-item verdicts inside an accepted bulk response, positionally
 * aligned with the batch that was sent.
 *
 * **The shape here was observed, not inferred.** Task 8 posted real heartbeats
 * to `api.wakatime.com` and recorded the reply (spec §5, §3): the bulk endpoint
 * answers **`202 ACCEPTED`**, not 201, with a body of
 * `{"responses": [[{"data": {"id": …}}, 201], …]}` — one `[body, status]` pair
 * per heartbeat, in the order they were sent, with the per-item code nested one
 * level deeper than §Sending's original "an array of per-item status codes"
 * suggested.
 *
 * Returns an array of `number | null`, `null` meaning *this position carried no
 * verdict*, which the caller reads as accepted. Unreadable bodies (not JSON, no
 * `responses` key, an entry that is not a `[body, status]` pair) are "no
 * information", never failure: a self-hosted wakapi or hakatime answering
 * `202 {}` must not have every heartbeat it accepted reported as lost. The
 * failure this whole function exists to end is the opposite one — silently
 * counting a *rejection* as success — and that only needs the codes that are
 * actually there to be read.
 */
export function perItemStatuses(bodyText, count) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const responses = body?.responses;
  if (!Array.isArray(responses) || responses.length === 0) return null;

  const out = [];
  for (let i = 0; i < count; i++) {
    const entry = responses[i];
    out.push(Array.isArray(entry) && typeof entry[1] === "number" ? entry[1] : null);
  }
  return out;
}

/** `[400, 400, 503]` -> `"400 x2, 503 x1"`. Codes only: no response bodies. */
function summarise(statuses) {
  const counts = new Map();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${status} x${n}`).join(", ");
}

async function postBatch(ctx, batch) {
  const url = `${ctx.apiUrl}/users/current/heartbeats.bulk`;
  const doFetch = ctx.fetch ?? fetch;

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(ctx.apiKey),
        "User-Agent": ctx.ua,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { retry: true, message: String(err?.message ?? err) };
  }

  // The body is read on the success path too, because "the request was
  // accepted" and "the heartbeats were accepted" are two different facts here:
  // a 202 carries a verdict per heartbeat, and reading only `res.ok` is how
  // individually-rejected heartbeats used to be counted as delivered.
  const text = await res.text().catch(() => "");

  if (res.ok) return { ok: true, statuses: perItemStatuses(text, batch.length) };

  // 401/403 retries for the same reason upload.mjs spools them: a revoked or
  // mistyped key is a configuration problem someone will fix, and the hours
  // behind it are worth keeping. The spool cap is what stops it growing
  // forever, and `authFailed` is what --status shouts about.
  const verdict = verdictFor(res.status);
  if (verdict === "drop") return { retry: false, status: res.status, message: text };
  return {
    retry: true,
    auth: verdict === "auth",
    rateLimited: verdict === "rateLimited",
    status: res.status,
    message: text,
  };
}

export async function sendAll(ctx, beats) {
  const tally = { sent: 0, accepted: 0, rejected: 0 };
  const failed = [];
  let authFailed = false;

  for (let i = 0; i < beats.length; i += BATCH_SIZE) {
    const batch = beats.slice(i, i + BATCH_SIZE);
    const result = await postBatch(ctx, batch);
    tally.sent += batch.length;

    if (result.ok) {
      // The request was accepted; each heartbeat inside it may still have been
      // refused on its own. Spec §Sending has always promised those are
      // logged; before this they were counted as accepted and left no trace at
      // all -- measured against a fake service answering 202 with a 400 for
      // every item: `spool 0, accepted 3, failed 0`, no PROBLEM, no log file.
      // Every indicator healthy, every heartbeat gone.
      if (!result.statuses) {
        tally.accepted += batch.length;
        continue;
      }

      const dropped = [];
      const deferred = [];
      for (let j = 0; j < batch.length; j++) {
        const status = result.statuses[j];
        // A position the response said nothing about is accepted: see
        // perItemStatuses on why silence is not failure.
        const verdict = status === null ? "ok" : verdictFor(status);
        if (verdict === "ok") {
          tally.accepted += 1;
          continue;
        }
        if (verdict === "drop") {
          dropped.push(status);
          continue;
        }
        // Everything the shared classifier calls transient is spooled, by the
        // same rule the whole-request path uses -- a heartbeat refused with a
        // per-item 503 or 401 is owed, not lost. What is *not* inherited is the
        // 429 rule's "stop sending further batches this run": that rule reads a
        // refused *request* as the endpoint pushing back on traffic, and a 202
        // is the endpoint accepting the traffic and objecting to one row in it.
        deferred.push(status);
        failed.push(batch[j]);
        if (verdict === "auth") authFailed = true;
      }

      tally.rejected += dropped.length;
      if (dropped.length) {
        ctx.log(
          `wakatime rejected ${dropped.length} of ${batch.length} heartbeat(s) individually, dropping: ${summarise(dropped)}`,
        );
      }
      if (deferred.length) {
        ctx.log(
          `wakatime deferred ${deferred.length} of ${batch.length} heartbeat(s) individually (will retry): ${summarise(deferred)}`,
        );
      }
      continue;
    }
    if (!result.retry) {
      tally.rejected += batch.length;
      ctx.log(`wakatime rejected ${batch.length} heartbeat(s), dropping: ${result.status} ${result.message}`);
      continue;
    }

    failed.push(...batch);
    if (result.auth) authFailed = true;
    ctx.log(`wakatime send failed (will retry): ${result.status ?? "network"} ${result.message}`);

    // A 429 means the whole run should stop, not just this batch — WakaTime
    // allows under 10 req/s averaged over five minutes, and hammering it with
    // the remaining batches is how a soft limit becomes a hard one.
    if (result.rateLimited) {
      failed.push(...beats.slice(i + BATCH_SIZE));
      break;
    }
  }

  return { tally, failed, authFailed };
}
