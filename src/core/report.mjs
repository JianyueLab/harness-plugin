/**
 * One reporting pass, for any host.
 *
 * This module knows nothing about transcripts, databases or byte offsets. A
 * host adapter hands it *units* (a file, a conversation — whatever that host
 * stores usage in) and an opaque `entry` per unit; the pass asks the adapter
 * what is unread, what a unit's new events are, and gives back an entry to
 * store. `state.files[unit]` is whatever the adapter last returned and is never
 * inspected here.
 *
 * **What the contract asks of `probe`.** `pending > 0` means "there is work here
 * the sweep should pick up", and an entry reporting it is kept past the ordinary
 * retention window rather than dropped mid-stranding. An adapter whose `pending`
 * can stay positive *permanently* — Claude Code's does, for a transcript whose
 * tail is a partial line that will never gain its newline — therefore keeps that
 * entry alive until the hard cutoff below, not for ever. Adapters should not
 * report `pending > 0` for work they can never actually consume.
 *
 * **Optional: `host.describePending(count, totalPending)`.** `--status` sums
 * `probe().pending` across every tracked unit that has any, and an adapter can
 * turn that into a human phrase — Claude Code's `pending` is bytes, so it
 * reports "N transcript(s), M byte(s)"; Antigravity's is a 0/1 "did this
 * database's mtime move" flag, so summing it would only restate `count`, and
 * its phrasing says that honestly ("N conversation(s) with new generations")
 * rather than dressing a flag up as a size. An adapter that omits this key
 * gets the plain unit count.
 */

import { upload } from "./upload.mjs";

/** Stale units drained per catch-up sweep. The rest wait for the next run. */
const MAX_SWEEP_FILES = 25;
/** How long a *finished* unit stays in `state.json` before being forgotten. */
const STATE_RETENTION_DAYS = 90;
/**
 * `MAX_EVENT_AGE_DAYS` in llm-web — the oldest event its ingest route accepts.
 * The hard ceiling on how long any entry survives, unread work or not.
 */
const MAX_EVENT_AGE_DAYS = 100;

/** The key both this plugin and the portal deduplicate on. */
export const keyOf = (event) => event.requestId || event.messageId;

/**
 * Decide which units this run reads, and forget the entries it should.
 *
 * **The sweep is what makes automatic reporting whole.** Before it, a run only
 * ever read the transcript Claude Code named in the hook payload — so a turn
 * written after a session's last hook, or a hook that lost the lock to a
 * concurrent session and bowed out, left bytes that nothing would ever come
 * back for. They were not late; they were gone, recoverable only if someone
 * thought to run `--backfill`. On the machine this was written for, three
 * transcripts had been sitting on 410k unreported tokens, one of them for ten
 * days. Anything still tracked that the adapter reports unread work for is now
 * picked up by whichever session next fires a hook. Age is not a reason to
 * skip one: the portal accepts events up to 100 days old.
 *
 * Pruning shares the walk because it needs the same `probe` per unit. It
 * used to wait until 200 files had accumulated to avoid that walk — a
 * threshold that in practice never tripped, so `state.json` only ever grew.
 * The walk now happens anyway, and a few dozen stats is a rounding error
 * beside the HTTP request at the end of the run.
 *
 * **There are two cutoffs, and they are cutoffs for different reasons.** The
 * soft one, `STATE_RETENTION_DAYS`, only forgets units with nothing left unread
 * — which is what that constant always meant. It used to fire regardless, and at
 * 90 days against a portal that accepts 100 that was a bug: it dropped entries
 * *inside* the acceptance window that still had unread bytes, stranding exactly
 * what the sweep exists to rescue. But "keep anything pending" has no ceiling of
 * its own — a transcript whose tail is a partial line never advances, so its
 * `pending` stays positive for ever and the entry would sit in `state.json`
 * burning one of the 25 sweep slots on every single run. So the hard one,
 * `MAX_EVENT_AGE_DAYS`, prunes unconditionally: past the portal's own window the
 * events would be rejected anyway, so keeping the entry buys nothing and costs a
 * slot every run.
 *
 * Freshest first, and capped: a run that drains `MAX_SWEEP_FILES` has done
 * more than its share, and the next one resumes where it stopped. Dropping an
 * entry stays safe in the direction that matters — a unit that is still around
 * and later grows is re-read from the start, and the portal stores none of it
 * twice.
 */
function sweepTargets(host, store, state, explicit, sweep) {
  const now = Date.now();
  const softCutoff = now - STATE_RETENTION_DAYS * 86_400_000;
  const hardCutoff = now - MAX_EVENT_AGE_DAYS * 86_400_000;
  const stale = [];
  for (const [unit, entry] of Object.entries(state.files)) {
    const probe = host.probe(unit, entry);
    if (probe === null) {
      delete state.files[unit]; // the adapter says this unit is gone
      continue;
    }
    const expired =
      probe.mtimeMs < hardCutoff || (probe.pending <= 0 && probe.mtimeMs < softCutoff);
    if (expired) {
      delete state.files[unit];
      continue;
    }
    if (!sweep || explicit.includes(unit)) continue;
    if (probe.pending > 0) stale.push({ unit, mtimeMs: probe.mtimeMs });
  }

  stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = stale.slice(0, MAX_SWEEP_FILES);
  if (stale.length > picked.length) {
    store.log(
      `sweep: ${stale.length - picked.length} stale ${host.unitLabel}(s) held over to the next run`,
    );
  }
  return [...explicit, ...picked.map((s) => s.unit)];
}

/**
 * Read one unit's new events and advance its cursor.
 *
 * Deduplication used to happen here, against that transcript's own key list.
 * It moved out to `report`, where one window spans every unit — the only
 * place a fork of an earlier session can be recognised for what it is.
 *
 * The entry shape is the adapter's business entirely: `null` back from `read`
 * means the unit is gone and the core forgets it.
 */
function collect(host, state, unit) {
  const { events, entry } = host.read(unit, state.files[unit] ?? {});
  if (entry === null) delete state.files[unit];
  else state.files[unit] = entry;
  return events;
}

/**
 * One reporting pass: whatever is owed from last time, plus whatever the given
 * units — and, with `sweep`, the ones nothing came back for — have produced
 * since.
 *
 * Both durable writes happen **after** the upload, and in this order: the spool
 * (what is still owed) then the cursors (what has been read). Every crash window
 * that leaves therefore re-reads lines rather than losing them, and re-read
 * lines are free — the portal deduplicates on request id and stores nothing the
 * second time. The reverse order would trade a harmless duplicate for a
 * permanently missing turn.
 *
 * An upload that failed still advances the cursor, because those events are on
 * the spool now; not advancing is what would make the same lines be read for
 * ever.
 */
export async function report(host, store, config, units, { sweep = false } = {}) {
  const state = store.loadState();
  // Snapshot before anything touches it, the migration included: a run whose
  // only change is a v1→v2 upgrade or a pruned entry must still persist it.
  const stateBefore = JSON.stringify(state, null, 2);
  const carried = state.carried ?? [];
  delete state.carried;

  const targets = sweepTargets(host, store, state, units, sweep);

  const found = [];
  for (const unit of targets) found.push(...collect(host, state, unit));

  // The dedup window is only read when there is something to check against it,
  // which leaves a hook with no new turns at a probe per tracked unit and
  // no large file touched at all.
  let fresh = found;
  let dedupWindow = null;
  let added = [];
  if (found.length > 0 || carried.length > 0) {
    dedupWindow = [...store.readSeen(), ...carried];
    added = [...carried];
    const seen = new Set(dedupWindow);
    fresh = [];
    for (const event of found) {
      const key = keyOf(event);
      if (seen.has(key)) continue;
      seen.add(key);
      dedupWindow.push(key);
      added.push(key);
      fresh.push(event);
    }
  }
  const known = found.length - fresh.length;

  // Cursors and dedup keys are recorded together, and only once the upload has
  // had its say. Writing `state.json` unconditionally was the one cost this
  // plugin paid on a turn where it had nothing to do.
  const persist = () => {
    if (dedupWindow) store.persistSeen(dedupWindow, added);
    const stateAfter = JSON.stringify(state, null, 2);
    if (stateAfter !== stateBefore) store.saveState(state);
  };

  const pending = store.readSpool();
  const all = [...pending, ...fresh];
  if (all.length === 0) {
    // Still record the cursors: the lines just read were real, they simply
    // held no usage (user turns, tool results), and re-reading them is waste.
    persist();
    return { sent: 0, accepted: 0, duplicates: 0, rejected: 0, spooled: 0, known };
  }

  const { tally, failed } = await upload(
    { config, source: host.source, client: host.client, log: store.log },
    all,
  );
  store.writeSpool(failed);
  persist();

  store.log(
    `reported ${tally.sent} event(s) from ${targets.length} ${host.unitLabel}(s): ` +
      `${tally.accepted} accepted, ${tally.duplicates} duplicate, ` +
      `${tally.rejected} rejected, ${tally.spooled} spooled` +
      (known > 0 ? `, ${known} skipped as already sent` : ""),
  );
  return { ...tally, known };
}
