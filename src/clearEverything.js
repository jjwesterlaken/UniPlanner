/* ==================================================================
   clearEverything.js — what "Clear everything" leaves behind, which
   must be EVIDENCE OF DELETION rather than an absence.

   THE BUG THIS EXISTS TO FIX, reproduced on production 18 September
   2026: `reset` replaced the blob with empty semesters and dropped the
   localStorage key. It never touched the server, and it left no record
   that anything had been deleted — so about four seconds later the
   debounced sync pulled the server copy, merged it with the empty
   local one, and every course, assignment and note came back. It then
   PUSHED the restored data, cementing it.

   `mergeList` is a union by id with last-write-wins on `updatedAt`, so
   an item that is merely ABSENT locally is an item the remote is the
   only witness for. Hard removal is the one thing union-by-id merge
   resurrects for ever. Every other delete in this app already knew
   that — `tombstone()` and `deleteFolder()` both write `deletedAt` —
   and `reset` was the single path that removed instead of recording.

   SO CLEARING IS A TOMBSTONE PASS, not a wipe. Every live item becomes
   `{id, deletedAt, updatedAt}`, which is the shape `pruneStats` and
   `archiveTransform` already write, and which both PROPAGATES (per-item
   last-write-wins carries the deletion to every device, old builds
   included, with no merge change at all) and SHRINKS the blob.

   ------------------------------------------------------------------
   THE AI-NOTE RULE HERE IS THE EXACT OPPOSITE OF THE ARCHIVE'S, AND
   THAT IS DELIBERATE. READ BOTH BEFORE CHANGING EITHER.

   `archiveTransform` must NEVER write `deletedAt` on an AI-note stub:
   `reconcilePlan` deletes the `ai_notes` row for any tombstoned stub,
   so archiving one would destroy the lecture content an archive exists
   to keep.

   Clearing wants precisely that deletion. The student asked for
   everything to go, and a lecture summary sitting on our server after
   they pressed "Clear everything" is the same false promise the blob
   half of this bug already made. So stubs ARE tombstoned here, the
   rows go on the next reconcile, and the note cache is purged beside
   it.

   The two rules look like a contradiction and are not: archiving keeps
   content the student is keeping, clearing removes content the student
   is removing. Anyone "tidying" this to match the archive rule would
   silently restore the original bug for AI notes alone.

   ------------------------------------------------------------------
   AND THE ONE THING A CLEARED STUB MUST KEEP: `aiMeta`.

   `isAiNote` is `!!(page && page.aiMeta)`, and `reconcilePlan` filters
   on it. Strip a tombstoned stub bare with the ordinary
   `stripTombstone` and reconciliation can no longer SEE it — the row
   stays on the server with nothing pointing at it, for ever, which is
   the leak the archive section warns about from the other direction.
   So a cleared stub carries `aiMeta: {}`: truthy, so it is still
   recognised; empty, so the previews and translations still go.
   ================================================================== */

import { COLLECTIONS } from "./sync.js";
import { stripTombstone } from "./semesterArchive.js";
import { isAiNote } from "./aiNotesStore.js";

/**
 * One semester bucket, cleared.
 *
 * No collection is special-cased the way `archiveTransform`
 * special-cases `settings` and `studyStats`, and that is the
 * difference between the two: an archive KEEPS the rounding rule and
 * carries the streak into the new term, because the student is still
 * studying. Clearing keeps nothing — the calendar, the rounding rule
 * and the streak are all things the student asked to be rid of.
 */
export function clearTransform(bucket = {}, { at }) {
  if (!at) throw new Error("clearTransform needs an `at` timestamp");
  const out = {};
  for (const key of COLLECTIONS) {
    const list = (bucket[key] || []).filter(Boolean);
    if (key === "pages") {
      out[key] = list.map((p) => {
        if (!isAiNote(p)) return stripTombstone(p, at);
        /* Already a tombstone: leave it ENTIRELY alone. Its stamps are
           older, so restamping would extend its purge life for nothing,
           and reconciliation is already going to act on it. */
        if (p.deletedAt) return p;
        return { id: p.id, deletedAt: at, updatedAt: at, aiMeta: {} };
      });
      continue;
    }
    out[key] = list.map((it) => stripTombstone(it, at));
  }
  return out;
}

/**
 * The whole planner, cleared.
 *
 * `meta.updatedAt` is stamped with `at` and that is load-bearing twice
 * over. It is what makes the debounced push fire — the mechanism that
 * used to restore the data now carries the deletion instead. And
 * `DEFAULT.meta.updatedAt` is `nowISO()` evaluated ONCE AT MODULE
 * LOAD, so the old `{...DEFAULT}` reset stamped every clear with the
 * time the bundle was parsed: older than almost any real edit, and
 * therefore losing merges it should have won.
 */
export function clearedData(data = {}, { at }) {
  if (!at) throw new Error("clearedData needs an `at` timestamp");
  const semesters = {};
  for (const [name, bucket] of Object.entries(data.semesters || {})) {
    semesters[name] = clearTransform(bucket, { at });
  }
  return { ...data, semesters, meta: { ...(data.meta || {}), updatedAt: at } };
}

/** Every live item left in a planner — 0 is what "cleared" means. */
export function liveItemCount(data = {}) {
  let n = 0;
  for (const bucket of Object.values(data.semesters || {})) {
    for (const key of COLLECTIONS) {
      for (const it of (bucket || {})[key] || []) if (it && !it.deletedAt) n++;
    }
  }
  return n;
}
