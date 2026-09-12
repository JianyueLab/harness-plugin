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
 * WakaTime detects editor and OS by parsing this. The shape mirrors what
 * wakatime-cli sends.
 *
 * **Whether the dashboard recognises `harness` as an editor is unverified** —
 * see Task 8, which sends one real heartbeat and reads the User Agents
 * endpoint back.
 */
export function userAgent({ harnessVersion, pluginVersion, platform, release, arch }) {
  return `wakatime/1.0.0 (${platform}-${release}-${arch}) harness/${harnessVersion} harness-wakatime/${pluginVersion}`;
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
