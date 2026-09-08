/**
 * POST usage events to the portal's ingest route.
 *
 * `source`, `client` and `log` come from the caller rather than being module
 * constants, so one module serves every host this plugin reports for.
 */

/** Server's per-request cap (`MAX_INGEST_EVENTS` in llm-web). Batches are split to fit. */
const BATCH_SIZE = 500;
/** Upload timeout. A hook that hangs is worse than usage reported one turn late. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * POST one batch.
 *
 * The return value splits failures by whether *the same bytes* could ever
 * succeed. Network trouble, rate limits and server errors obviously can, and so
 * can 401/403: a revoked or mistyped key is a configuration problem someone
 * fixes, and discarding real usage while they do would be the plugin quietly
 * losing the thing it exists to record. Everything else — a payload this
 * version cannot produce correctly — is dropped, because retrying it forever
 * only grows the spool.
 */
async function postBatch({ config, source, client }, events) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/v1/usage/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ source, client, events }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, body: await res.json().catch(() => ({})) };
    const text = await res.text().catch(() => "");
    const retry =
      res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500;
    return { ok: false, retry, status: res.status, message: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, retry: true, message: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload everything, returning both a tally and whatever could not be
 * delivered. The caller owns the spool: writing it here would mean two
 * different functions deciding what is still owed.
 */
export async function upload(ctx, events) {
  const { log } = ctx;
  const tally = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, spooled: 0 };
  const failed = [];

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const result = await postBatch(ctx, batch);
    tally.sent += batch.length;
    if (result.ok) {
      tally.accepted += result.body.accepted ?? 0;
      tally.duplicates += result.body.duplicates ?? 0;
      const bad = result.body.rejected ?? [];
      tally.rejected += bad.length;
      if (bad.length > 0) log(`portal rejected ${bad.length} event(s): ${JSON.stringify(bad.slice(0, 5))}`);
    } else if (result.retry) {
      failed.push(...batch);
      log(`upload failed (will retry): ${result.status ?? "network"} ${result.message}`);
    } else {
      log(`upload rejected, dropping ${batch.length} event(s): ${result.status} ${result.message}`);
    }
  }

  tally.spooled = failed.length;
  return { tally, failed };
}
