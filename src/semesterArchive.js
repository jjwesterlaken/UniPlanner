/* ==================================================================
   semesterArchive.js — the semester lifecycle

   The problem this solves is time, not features: a student reusing
   "Semester 1" across years grows the blob without bound, and reuse
   alone breaches the 1 MB budget before any feature adds a byte
   (see reference.js). Caps bound features; this bounds years.

   THE SHAPE, and why each half is what it is:

   - The archive lives in its own table, `semester_archives`, one row
     per archive event holding the bucket VERBATIM. The server is where
     growth is cheap; the device is where it is not.

   - In the blob, archiving strips every live item to a bare tombstone
     `{id, deletedAt, updatedAt}` — the same stripped shape pruneStats
     already writes. Stripped tombstones are the only representation
     that both PROPAGATES (per-item last-write-wins carries a deletion
     to every device, old builds included) and actually SHRINKS the
     blob (a full-payload tombstone keeps the 583 KB around for the
     whole 60-day purge window). Hard removal is the one thing merge
     can never propagate — union by id resurrects absence forever.

   ORDERING: row FIRST, then shrink the blob. The same rule as
   aiNotesStore's migration, for the same reason — an interruption
   leaves the semester in both places, which a retry resolves; the
   reverse loses it. The archive id is parked on this device before
   the insert so a crash retries under the SAME id, and the retry
   deletes any half-landed row before re-inserting, so a row can never
   hold an older snapshot than the blob that was stripped.

   THE ONE ABSOLUTE RULE — AI-note stubs are never tombstoned and
   never removed by archiving. reconcilePlan (aiNotesStore.js) deletes
   the `ai_notes` row for any tombstoned AI stub, and that behaviour
   is ALREADY SHIPPED: no flag a new build adds will stop an old build
   on a second device from syncing the tombstones and destroying every
   archived lecture's content, permanently. Live stubs instead gain
   `archivedIn` (an ordinary field, riding the per-item merge), which
   new builds filter from the default lists and old builds harmlessly
   show. Tombstoned AI stubs are left ENTIRELY untouched — stripping
   one would erase its aiMeta, reconciliation would stop recognising
   it as an AI tombstone, and the row it was meant to delete would
   leak on the server forever.
   ================================================================== */

import { COLLECTIONS, COUNTABLE_COLLECTIONS, mergeList } from "./sync.js";
import { isAiNote } from "./aiNotesStore.js";
import { summarise } from "./grades.js";
import { TOTALS_ID } from "./srs.js";

const TABLE = "semester_archives";

/* ---------- the budget line-items ----------

   Both are CEILINGS the residue test proves by running the real
   transform over a realistic fixture and measuring — never figures
   typed from a model. Raising either means re-measuring, not editing.

   Steady residue is what an archived bucket costs the blob FOREVER:
   the settings-row marker plus the flagged AI-note stubs (previews
   stripped — a hidden stub renders no preview, and the archive row
   keeps the full copy for restore). Transitional residue adds the
   stripped tombstones, which purgeOldTombstones clears 60 days after
   the archive syncs. */
export const ARCHIVE_STEADY_RESIDUE_BYTES = 16 * 1024;
export const ARCHIVE_TRANSITIONAL_RESIDUE_BYTES = 120 * 1024;

/* ---------- reading the state ---------- */

/** The archive marker, carried on the live settings row. */
export function archiveMarkerOf(bucket) {
  const row = ((bucket && bucket.settings) || []).find((s) => s && !s.deletedAt && s.archive);
  return (row && row.archive) || null;
}

/** A live AI-note stub that belongs to an archive rather than the term. */
export const isArchivedStub = (p) => !!(p && !p.deletedAt && p.archivedIn);

/** Default label: "2026 · Semester 1", editable at the moment of archiving. */
export const defaultArchiveLabel = (semesterName, now = new Date()) =>
  `${now.getFullYear()} · ${semesterName}`;

/**
 * Whether the bucket holds live content of the student's own — the
 * check that refuses a restore. Archived lecture stubs don't count
 * (they belong to the archive, not the term), and neither does
 * bookkeeping: a bucket holding only a calendar row is an empty one.
 */
export function bucketOccupied(bucket) {
  for (const key of COUNTABLE_COLLECTIONS) {
    for (const it of (bucket && bucket[key]) || []) {
      if (!it || it.deletedAt) continue;
      if (key === "pages" && it.archivedIn) continue;
      return true;
    }
  }
  return false;
}

/**
 * Items that turned up live in a bucket whose marker says archived —
 * edits made on a device that had not yet seen the archive, surviving
 * the tombstones by their newer updatedAt. Surfaced, never swept:
 * moving someone's edit on an inference about their intent is the
 * remedy this project refuses everywhere else. The copy is
 * device-neutral on purpose — on the device that made the edits,
 * "another device" would be false.
 */
export function lateEdits(bucket) {
  if (!archiveMarkerOf(bucket)) return [];
  const out = [];
  for (const key of COUNTABLE_COLLECTIONS) {
    for (const it of (bucket && bucket[key]) || []) {
      if (!it || it.deletedAt) continue;
      if (key === "pages" && it.archivedIn) continue;
      out.push({ key, item: it });
    }
  }
  return out;
}

/** The marker taken off in place — "this bucket is a term again". */
export function clearArchiveMarker(bucket, at) {
  return {
    ...bucket,
    settings: ((bucket && bucket.settings) || []).map((s) => {
      if (!s || !s.archive) return s;
      const { archive, ...rest } = s;
      return { ...rest, updatedAt: at };
    }),
  };
}

/**
 * Creating content in an archived bucket IS starting the new term, so
 * the marker comes off with it — otherwise the student's own first
 * course of the year would be surfaced back at them as a "late edit".
 * Only the student's own collections count: logging study minutes or
 * a calendar edit is not a decision about the term.
 *
 * Deliberately LOCAL-ONLY in effect: items arriving via merge never
 * pass through addItem, so edits made on a not-yet-synced device
 * still surface as late edits rather than silently unarchiving.
 */
export function markerClearedOnCreate(bucket, key, at) {
  if (!COUNTABLE_COLLECTIONS.includes(key)) return bucket;
  if (!archiveMarkerOf(bucket)) return bucket;
  return clearArchiveMarker(bucket, at);
}

/* ---------- the summary, which is what v1 keeps visible ---------- */

/**
 * What the archive list shows without fetching megabytes: item count
 * and each course's marks. Stored in its own column so listing never
 * pulls `data`.
 */
export function buildSummary(bucket) {
  const liveOf = (list) => (list || []).filter((it) => it && !it.deletedAt);
  let items = 0;
  for (const key of COUNTABLE_COLLECTIONS) items += liveOf(bucket[key]).length;
  const courses = liveOf(bucket.courses).map((c) => {
    const s = summarise(liveOf(bucket.assessments).filter((a) => a.course === c.name));
    return {
      name: c.name,
      // The average across what was marked — null when nothing was.
      average: s.average,
      complete: s.weightSum > 0 && s.remainingWeight === 0,
    };
  });
  return { items, courses };
}

/* ---------- the blob-side transform ---------- */

/**
 * One item's tombstone, payload stripped. An existing tombstone keeps
 * its ORIGINAL stamps — restamping would extend its purge life for
 * nothing — and only loses the payload, which nothing reads (the
 * differential render in test-archive.mjs is what makes that a
 * contract rather than an accident).
 */
export const stripTombstone = (it, at) =>
  it.deletedAt
    ? { id: it.id, deletedAt: it.deletedAt, updatedAt: it.updatedAt || it.deletedAt }
    : { id: it.id, deletedAt: at, updatedAt: at };

/**
 * The archived bucket: what the blob holds after the row is safely on
 * the server. Safe to re-run (the late-edit fold does): flagging,
 * seeding and the marker are all idempotent in shape.
 *
 * - settings: one live row carrying the marker, keeping the rounding
 *   rule (the student's university convention, which inheritedRounding
 *   reads across semesters) and dropping the calendar — a new term has
 *   new dates.
 * - studyStats: the totals row is re-seeded with the streak carried
 *   and the minutes reset. A streak is about the student; minutes are
 *   about the courses, and the courses just left.
 * - pages: AI stubs per the absolute rule above; previews emptied on
 *   the flagged copy because a hidden stub renders none and the row
 *   keeps the full copy.
 * - everything else: stripped tombstones.
 */
export function archiveTransform(bucket, { archiveId, label, at, uid, items }) {
  const count = items != null ? items : buildSummary(bucket).items;
  const out = {};
  for (const key of COLLECTIONS) {
    const list = (bucket[key] || []).filter(Boolean);
    if (key === "settings") {
      const row = list.find((s) => !s.deletedAt);
      out[key] = [
        {
          id: (row && row.id) || uid(),
          ...(row && row.rounding ? { rounding: row.rounding } : {}),
          archive: { id: archiveId, label, at, items: count },
          updatedAt: at,
        },
        ...list.filter((s) => s.deletedAt).map((s) => stripTombstone(s, at)),
      ];
      continue;
    }
    if (key === "studyStats") {
      const totals = list.find((it) => it.id === TOTALS_ID && !it.deletedAt);
      out[key] = [
        ...(totals
          ? [{ id: TOTALS_ID, cur: totals.cur || 0, max: totals.max || 0, last: totals.last || null, mins: {}, updatedAt: at }]
          : []),
        ...list.filter((it) => it.id !== TOTALS_ID).map((it) => stripTombstone(it, at)),
      ];
      continue;
    }
    if (key === "pages") {
      out[key] = list.map((p) => {
        if (isAiNote(p)) {
          if (p.deletedAt) return p; // untouched: reconciliation must keep seeing an AI tombstone
          if (p.archivedIn) return p; // already belongs to an earlier archive; its flag stands
          return { ...p, archivedIn: archiveId, updatedAt: at, aiMeta: { ...p.aiMeta, previews: {} } };
        }
        return stripTombstone(p, at);
      });
      continue;
    }
    out[key] = list.map((it) => stripTombstone(it, at));
  }
  return out;
}

/**
 * The bucket after a restore: the archived copy UNIONED over what is
 * there, never a wholesale replacement — anything the current bucket
 * holds that the archive doesn't (later tombstones, say) survives as
 * itself and purges on its own schedule.
 *
 * Live items are restamped so they beat their own archive-time
 * tombstones on every device; archived-at-the-time tombstones keep
 * their old stamps and STAY DEAD — restoring must not resurrect
 * something the student deleted before archiving. The `archivedIn`
 * flags come off (this is the un-archive), and any surviving marker
 * is cleared in place.
 */
export function restoreTransform(currentBucket, archivedBucket, { at }) {
  const out = {};
  for (const key of COLLECTIONS) {
    const restored = ((archivedBucket && archivedBucket[key]) || []).filter(Boolean).map((it) => {
      if (it.deletedAt) return it;
      const { archivedIn, ...rest } = it;
      return { ...rest, updatedAt: at };
    });
    out[key] = mergeList((currentBucket && currentBucket[key]) || [], restored);
  }
  out.settings = (out.settings || []).map((s) => {
    if (!s || !s.archive) return s;
    const { archive, ...rest } = s;
    return { ...rest, updatedAt: at };
  });
  return out;
}

/* ---------- the parked id, so a retry can't fork ----------

   Device-local on purpose (a half-finished archive is this device's
   problem), and scoped to the bucket so archiving the OTHER semester
   never inherits it. */

const PENDING_KEY = "uni-planner-archive-pending";

const defaultPendingStore = {
  get(semesterName) {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.sem === semesterName ? parsed.id : null;
    } catch (e) {
      return null;
    }
  },
  set(semesterName, id) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ sem: semesterName, id }));
    } catch (e) {
      /* a lost park costs one duplicate, deletable row — fail towards keeping */
    }
  },
  clear() {
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      /* ignore */
    }
  },
};

/* ---------- the server side, under RLS ----------

   Every read has THREE outcomes and they must stay distinct: got it,
   definitively absent, and failed-so-we-know-nothing. Only the middle
   one may ever be acted on as absence — a dropped connection, a 500,
   an expired token and a rate limit all look like "no data" to a
   caller that only checks whether something came back. */

/**
 * Archive one semester. Row first; the caller applies the returned
 * bucket to the blob only on ok. `stillCurrent` is re-checked after
 * the insert because the insert takes real time and a recording can
 * save itself mid-flight — stripping a bucket the snapshot no longer
 * matches would lose the difference from both places. On "changed"
 * the parked id is kept, so the retry deletes the stale row and
 * re-snapshots under the same id.
 */
export async function archiveSemester({
  supabaseClient,
  userId,
  semesterName,
  bucket,
  label,
  uid,
  now,
  stillCurrent,
  pendingStore = defaultPendingStore,
}) {
  if (!supabaseClient || !userId) return { ok: false, reason: "unauthenticated" };
  if (archiveMarkerOf(bucket)) return { ok: false, reason: "already-archived" };
  const at = now || new Date().toISOString();
  const archiveId = pendingStore.get(semesterName) || uid();
  pendingStore.set(semesterName, archiveId);

  // A retried id may have a half-landed row holding an older snapshot;
  // delete-then-insert replaces it without needing an update policy.
  const { error: delErr } = await supabaseClient.from(TABLE).delete().eq("id", archiveId);
  if (delErr) return { ok: false, reason: "failed" };
  const { error } = await supabaseClient.from(TABLE).insert({
    id: archiveId,
    user_id: userId,
    label,
    summary: buildSummary(bucket),
    data: bucket,
  });
  if (error) return { ok: false, reason: "failed" };
  if (stillCurrent && !stillCurrent()) return { ok: false, reason: "changed" };

  const out = archiveTransform(bucket, { archiveId, label, at, uid });
  pendingStore.clear();
  return { ok: true, archiveId, bucket: out };
}

/** List this user's archives — summaries only, never `data`. */
export async function listArchives({ supabaseClient, userId }) {
  if (!supabaseClient || !userId) return { failed: true };
  try {
    const { data, error } = await supabaseClient
      .from(TABLE)
      .select("id,label,summary,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error || !Array.isArray(data)) return { failed: true };
    return { archives: data };
  } catch (e) {
    return { failed: true };
  }
}

/** One archive's content: {data} | {missing:true} | {failed:true}. */
export async function fetchArchive({ supabaseClient, id }) {
  if (!supabaseClient || !id) return { failed: true };
  try {
    const { data, error } = await supabaseClient.from(TABLE).select("label,data").eq("id", id).maybeSingle();
    if (error) return { failed: true };
    if (!data) return { missing: true };
    return { label: data.label, data: data.data };
  } catch (e) {
    return { failed: true };
  }
}

/**
 * Delete an archive for good. A row already gone is a success — that
 * is the retry case — and a failure reports itself so the student is
 * never told something is gone that isn't.
 */
export async function deleteArchive({ supabaseClient, id }) {
  if (!supabaseClient || !id) return { ok: false };
  const { error } = await supabaseClient.from(TABLE).delete().eq("id", id);
  return { ok: !error };
}

/**
 * Fold late edits into their archive. The table has no update policy
 * (written once, read, deleted — the ai_notes shape), so this is
 * insert-new-then-delete-old: an interruption leaves BOTH rows
 * visible and deletable, which is the keeping direction.
 *
 * Only the late items are merged in. Merging the whole bucket would
 * hand the archive its own stripped tombstones — newer than the
 * archived originals, so per-item merge would kill every item the
 * archive exists to keep.
 */
export async function foldLateEditsIntoArchive({ supabaseClient, userId, bucket, uid, now, stillCurrent }) {
  const marker = archiveMarkerOf(bucket);
  if (!marker) return { ok: false, reason: "no-archive" };
  if (!supabaseClient || !userId) return { ok: false, reason: "unauthenticated" };

  const existing = await fetchArchive({ supabaseClient, id: marker.id });
  if (existing.failed) return { ok: false, reason: "failed" };
  if (existing.missing) return { ok: false, reason: "missing" };

  const at = now || new Date().toISOString();
  const late = lateEdits(bucket);
  const merged = {};
  for (const key of COLLECTIONS) {
    const additions = late.filter((l) => l.key === key).map((l) => l.item);
    merged[key] = additions.length
      ? mergeList(existing.data[key] || [], additions)
      : existing.data[key] || [];
  }

  const newId = uid();
  const { error } = await supabaseClient.from(TABLE).insert({
    id: newId,
    user_id: userId,
    label: existing.label,
    summary: buildSummary(merged),
    data: merged,
  });
  if (error) return { ok: false, reason: "failed" };
  /* Checked BEFORE the old row is deleted: on "changed" both rows
     survive (a visible, deletable duplicate — the keeping direction)
     and the marker still points at the old one, so a retry re-folds
     from an intact archive. */
  if (stillCurrent && !stillCurrent()) return { ok: false, reason: "changed" };
  await supabaseClient.from(TABLE).delete().eq("id", marker.id);

  return {
    ok: true,
    archiveId: newId,
    bucket: archiveTransform(bucket, {
      archiveId: newId,
      label: existing.label,
      at,
      uid,
      items: buildSummary(merged).items,
    }),
  };
}
