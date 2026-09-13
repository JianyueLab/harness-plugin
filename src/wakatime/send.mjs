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

  if (res.ok) return { ok: true };

  const text = await res.text().catch(() => "");
  // 401/403 retries for the same reason upload.mjs spools them: a revoked or
  // mistyped key is a configuration problem someone will fix, and the hours
  // behind it are worth keeping. The spool cap is what stops it growing
  // forever, and `authFailed` is what --status shouts about.
  if (res.status === 401 || res.status === 403) {
    return { retry: true, auth: true, status: res.status, message: text };
  }
  if (res.status === 429 || res.status >= 500) {
    return { retry: true, rateLimited: res.status === 429, status: res.status, message: text };
  }
  return { retry: false, status: res.status, message: text };
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
      tally.accepted += batch.length;
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
