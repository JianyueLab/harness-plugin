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
 * A 400 identifying `source` as the problem — the portal does not (yet)
 * recognise this plugin's `source` value, e.g. before a new host's events are
 * accepted server-side. That is a transitional configuration problem, exactly
 * like the revoked key that 401 already spools for below, not a payload this
 * version can never produce correctly: once the portal is updated the very
 * same bytes succeed.
 *
 * Checked two ways, in that order. The machine-readable one first: llm-web's
 * ingest route answers with an OpenAI-shaped error body and sets
 * `error.code: "invalid_source"` (`src/server/routes/v1.ts`), and that field
 * is what actually gets matched. Matching prose instead would fail in exactly
 * the direction this fail-safe exists to guard against — a copy edit to the
 * portal's error message would silently stop the match, the batch would
 * revert to dropped, and the spend would be lost. The prose regex survives
 * only as a fallback for an older portal build whose response predates the
 * `code` field. Parsing never throws: a 400 with an empty or non-JSON body
 * just falls through to the fallback (and, failing that, to "drop").
 */
const UNKNOWN_SOURCE_CODE = "invalid_source";
const UNKNOWN_SOURCE_RE = /`source`\s+must\s+be\s+one\s+of/i;

function isUnknownSourceError(text) {
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && body.error?.code === UNKNOWN_SOURCE_CODE) return true;
  } catch {
    /* not JSON: fall through to the prose match below */
  }
  return UNKNOWN_SOURCE_RE.test(text);
}

/**
 * POST one batch.
 *
 * The return value splits failures by whether *the same bytes* could ever
 * succeed. Network trouble, rate limits and server errors obviously can, and so
 * can 401/403: a revoked or mistyped key is a configuration problem someone
 * fixes, and discarding real usage while they do would be the plugin quietly
 * losing the thing it exists to record. A 400 naming an unrecognised `source`
 * is the same kind of problem and gets the same treatment. Everything else — a
 * payload this version cannot produce correctly — is dropped, because retrying
 * it forever only grows the spool.
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
      res.status === 401 ||
      res.status === 403 ||
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 400 && isUnknownSourceError(text));
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
