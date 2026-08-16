/* The semester archive: the lifecycle that bounds TIME, where the caps
   bound features.

   The claims worth pinning, in rough order of what they cost if wrong:

   - Archiving NEVER writes deletedAt on an AI-note stub. reconcilePlan
     deletes the ai_notes row for any tombstoned stub, that behaviour is
     already shipped on every device, and no flag a new build adds can
     stop an old build acting on the tombstones it syncs. This is the
     constraint that shaped the whole design.
   - The residue constants are DERIVED by running the real transform
     over a realistic fixture, never typed from a model. The budget
     arithmetic uses the derived ceilings.
   - A stripped tombstone behaves exactly like a full one everywhere —
     merge, tie-break, purge, and RENDER. The render half is a
     differential mount: the same planner with full and stripped
     tombstones must produce byte-identical HTML on every tab, which is
     what turns "nothing reads a tombstone's content" from an accident
     into a contract.
   - Restore resurrects nothing the student deleted before archiving,
     and a restore of a two-month-old backup after archiving deletes
     nothing (the two most fragile mechanisms pointed at each other).
   - Every server read keeps three outcomes distinct: got it,
     definitively missing, and failed-so-we-know-nothing. Only the
     middle one is ever acted on as absence.

   Plain Node and `assert`. Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

import {
  ARCHIVE_STEADY_RESIDUE_BYTES,
  ARCHIVE_TRANSITIONAL_RESIDUE_BYTES,
  archiveMarkerOf,
  isArchivedStub,
  defaultArchiveLabel,
  bucketOccupied,
  lateEdits,
  clearArchiveMarker,
  markerClearedOnCreate,
  buildSummary,
  stripTombstone,
  archiveTransform,
  restoreTransform,
  archiveSemester,
  listArchives,
  fetchArchive,
  deleteArchive,
  foldLateEditsIntoArchive,
} from "../src/semesterArchive.js";
import { COLLECTIONS, COUNTABLE_COLLECTIONS, mergeData, mergeList, purgeOldTombstones } from "../src/sync.js";
import { reconcilePlan } from "../src/aiNotesStore.js";
import { BLOB_BUDGET_BYTES, MEASURED_POST_BATCH3_BYTES } from "../src/reference.js";
import { ARCHIVE_COPY } from "../src/archiveCopy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v) || "");
const AT = "2026-08-16T02:00:00.000Z";
const EARLIER = "2026-07-01T00:00:00.000Z";
const LATER = "2026-08-20T00:00:00.000Z";
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`;

/* ---------- a realistic fixture ----------

   Sized from the measured account (CLAUDE.md): study cards and pages
   are ~85% of a semester, AI stubs ~525 bytes each, studyStats a
   42-day window. The realism FLOOR below is asserted, because a
   residue percentage measured against a toy bucket proves nothing. */

const lorem =
  "The lecturer worked the derivation on the board and tied it back to the assignment: ";
function realisticBucket() {
  const card = (i) => ({
    id: `card-${i}`,
    course: `COURSE${1 + (i % 4)}`,
    week: String(1 + (i % 12)),
    term: `Concept ${i} in its long form, the way a student types it`,
    content: (lorem + `card ${i}. `).repeat(4),
    srs: { due: "2026-09-01", interval: 6, ease: 2.5, reps: 3, lapses: 0 },
    updatedAt: EARLIER,
  });
  const inkStroke = (j) => ({
    color: "#1c1917",
    width: 3,
    erase: false,
    v: 2,
    o: [100 + j, 200 + j, 50],
    d: Array.from({ length: 60 }, (_, k) => [((k % 7) - 3) * 4, ((k % 5) - 2) * 4, 0]).flat(),
  });
  const page = (i) => ({
    id: `page-${i}`,
    title: `Lecture ${i} working notes`,
    body: "",
    html: "",
    strokes: [],
    blocks:
      i % 3 === 0
        ? [
            { id: `b-${i}-t`, type: "text", html: `<p>${(lorem + `page ${i}. `).repeat(10)}</p>`, body: (lorem + `page ${i}. `).repeat(10) },
            { id: `b-${i}-k`, type: "ink", h: 700, strokes: Array.from({ length: 12 }, (_, j) => inkStroke(j)) },
          ]
        : [{ id: `b-${i}-t`, type: "text", html: `<p>${(lorem + `page ${i}. `).repeat(14)}</p>`, body: (lorem + `page ${i}. `).repeat(14) }],
    style: "lined",
    kind: "text",
    font: "sans",
    folderId: i % 4 === 0 ? "folder-1" : null,
    updatedAt: EARLIER,
  });
  const stub = (i) => ({
    id: `stub-${i}`,
    title: `COURSE${1 + (i % 4)} — Week ${1 + (i % 12)} lecture`,
    body: "",
    html: "",
    strokes: [],
    style: "lined",
    kind: "text",
    font: "sans",
    folderId: null,
    updatedAt: EARLIER,
    aiMeta: {
      course: `COURSE${1 + (i % 4)}`,
      week: String(1 + (i % 12)),
      generatedAt: EARLIER,
      activeLanguage: "en",
      remote: true,
      previews: {
        en: "The lecture covered the second derivation in depth, with the worked example from the board and the reasons it is examinable.",
        es: "La clase cubrió la segunda derivación en profundidad, con el ejemplo resuelto de la pizarra.",
      },
    },
  });
  return {
    courses: Array.from({ length: 4 }, (_, i) => ({ id: `course-${i}`, name: `COURSE${i + 1}`, updatedAt: EARLIER })),
    todos: Array.from({ length: 30 }, (_, i) => ({ id: `todo-${i}`, text: `${lorem}todo ${i}`, done: i % 3 === 0, updatedAt: EARLIER })),
    textbook: Array.from({ length: 40 }, (_, i) => ({ id: `read-${i}`, course: `COURSE${1 + (i % 4)}`, week: String(1 + (i % 12)), pages: `pp. ${i * 10}–${i * 10 + 22}`, notes: lorem, read: i % 2 ? "done" : "", updatedAt: EARLIER })),
    assignments: Array.from({ length: 16 }, (_, i) => ({
      id: `assign-${i}`,
      course: `COURSE${1 + (i % 4)}`,
      title: `Assignment ${i}: ${lorem.slice(0, 40)}`,
      due: "2026-10-01",
      rubric: Array.from({ length: 6 }, (_, j) => ({ id: `r-${i}-${j}`, label: `Criterion ${j} ${lorem.slice(0, 60)}`, note: lorem.slice(0, 80), done: false })),
      updatedAt: EARLIER,
    })),
    notes: Array.from({ length: 240 }, (_, i) => card(i)),
    events: Array.from({ length: 24 }, (_, i) => ({ id: `event-${i}`, title: `Tutorial ${i}`, course: `COURSE${1 + (i % 4)}`, day: "Mon", time: "10:00", place: "Building 12", updatedAt: EARLIER })),
    pages: [
      ...Array.from({ length: 24 }, (_, i) => page(i)),
      ...Array.from({ length: 24 }, (_, i) => stub(i)),
      // A note the student deleted before archiving: a FULL tombstone.
      { id: "deleted-page", title: "Old note", body: lorem.repeat(3), html: "", strokes: [], deletedAt: EARLIER, updatedAt: EARLIER },
      // A lecture the student deleted whose row delete is still pending
      // reconciliation on another device.
      { ...stub(900), id: "deleted-stub", deletedAt: EARLIER, updatedAt: EARLIER },
    ],
    folders: [{ id: "folder-1", name: "COURSE1 lectures", updatedAt: EARLIER }],
    assessments: Array.from({ length: 16 }, (_, i) => ({
      id: `assess-${i}`,
      course: `COURSE${1 + (i % 4)}`,
      title: `Assessment ${i}`,
      w: 25,
      mark: i % 2 ? 74 : 81,
      updatedAt: EARLIER,
    })),
    settings: [{ id: "settings-1", start: "2026-07-28", breaks: [{ from: "2026-09-22", to: "2026-09-28" }], rounding: "half-up", updatedAt: EARLIER }],
    studyStats: [
      { id: "t", cur: 6, max: 21, last: "2026-08-15", mins: { COURSE1: 640, COURSE2: 312 }, updatedAt: EARLIER },
      ...Array.from({ length: 42 }, (_, i) => ({ id: `d:2026-07-${String(1 + (i % 28)).padStart(2, "0")}x${i}`, m: { COURSE1: 30 }, c: 12, updatedAt: EARLIER })),
    ],
    practiceAttempts: Array.from({ length: 30 }, (_, i) => ({ id: `attempt-${i}`, at: EARLIER, cardIds: [`card-${i}`], correctIds: i % 2 ? [`card-${i}`] : [], updatedAt: EARLIER })),
  };
}

/* A Supabase stand-in that records what was asked of it, in order. */
function fakeClient({ rows = new Map(), failInsert, failDelete, failSelect, listRows } = {}) {
  const calls = [];
  const table = (name) => ({
    insert(row) {
      calls.push(`insert:${name}:${row.id}`);
      if (failInsert) return Promise.resolve({ error: { message: "boom" } });
      rows.set(row.id, row);
      return Promise.resolve({ error: null });
    },
    delete() {
      return {
        eq(col, val) {
          calls.push(`delete:${name}:${col}=${val}`);
          if (failDelete) return Promise.resolve({ error: { message: "boom" } });
          rows.delete(val);
          return Promise.resolve({ error: null });
        },
      };
    },
    select(cols) {
      calls.push(`select:${name}:${cols}`);
      const q = {
        eq(col, val) {
          calls.push(`eq:${col}=${val}`);
          q._eq = [col, val];
          return q;
        },
        maybeSingle() {
          if (failSelect) return Promise.resolve({ data: null, error: { message: "boom" } });
          const hit = [...rows.values()].find((r) => r[q._eq[0]] === q._eq[1]) || null;
          return Promise.resolve({ data: hit, error: null });
        },
        order() {
          if (failSelect) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: listRows || [...rows.values()], error: null });
        },
      };
      return q;
    },
  });
  return { calls, rows, from: (nme) => table(nme) };
}

const memoryPending = () => {
  let held = null;
  return {
    get: (sem) => (held && held.sem === sem ? held.id : null),
    set: (sem, id) => {
      held = { sem, id };
    },
    clear: () => {
      held = null;
    },
    peek: () => held,
  };
};

async function run() {
  /* ================================================================
     THE ABSOLUTE RULE: archiving and the ai_notes reconciliation
     ================================================================ */

  await test("archiving writes deletedAt on ZERO AI-note stubs — reconcilePlan deletes nothing", () => {
    const bucket = realisticBucket();
    const out = archiveTransform(bucket, { archiveId: "arch-1", label: "2026 · Semester 1", at: AT, uid });
    const aiTombstoned = out.pages.filter((p) => p.aiMeta && p.deletedAt && p.id !== "deleted-stub");
    assert.equal(aiTombstoned.length, 0, "archiving tombstoned an AI stub — an old build's reconciliation will delete the row");
    const stubs = out.pages.filter((p) => p.id.startsWith("stub-"));
    assert.equal(stubs.length, 24, "a stub went missing entirely, which merge resurrects and reconciliation miscounts");
    for (const s of stubs) {
      assert.equal(s.archivedIn, "arch-1");
      assert.ok(!s.deletedAt);
    }
    // The proof at the mechanism itself: the shipped reconciliation over
    // an archived blob must plan zero deletions beyond what the student
    // deleted themselves.
    const remoteIds = stubs.map((s) => s.id).concat(["deleted-stub"]);
    const plan = reconcilePlan({ remoteIds, pages: out.pages });
    assert.deepEqual(plan.toDelete, ["deleted-stub"], "reconciliation would delete an archived lecture's content");
  });

  await test("a tombstoned AI stub is left ENTIRELY untouched, so its pending row delete still happens", () => {
    const bucket = realisticBucket();
    const before = bucket.pages.find((p) => p.id === "deleted-stub");
    const out = archiveTransform(bucket, { archiveId: "arch-1", label: "L", at: AT, uid });
    const after = out.pages.find((p) => p.id === "deleted-stub");
    assert.deepEqual(after, before, "stripping an AI tombstone erases its aiMeta and the row it points at leaks forever");
  });

  await test("a stub already flagged by an earlier archive keeps its original flag", () => {
    const bucket = realisticBucket();
    bucket.pages.push({ ...bucket.pages.find((p) => p.id === "stub-1"), id: "old-stub", archivedIn: "arch-0" });
    const out = archiveTransform(bucket, { archiveId: "arch-1", label: "L", at: AT, uid });
    assert.equal(out.pages.find((p) => p.id === "old-stub").archivedIn, "arch-0");
  });

  await test("restore a two-month-old backup AFTER archiving: reconciliation still deletes nothing", () => {
    /* The two most fragile mechanisms pointed at each other. The backup
       predates the archive, so restoring it (replace mode) brings back
       the pre-archive blob: every stub live and unflagged, every
       archived item live again. From reconciliation's point of view
       nothing is tombstoned, so nothing may be deleted — and the
       archive row is untouched by any of it. */
    const preArchive = realisticBucket();
    const archived = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const remoteIds = archived.pages.filter((p) => p.aiMeta && !p.deletedAt).map((p) => p.id);
    for (const pages of [archived.pages, preArchive.pages]) {
      const plan = reconcilePlan({ remoteIds, pages });
      assert.equal(plan.toDelete.length, 0, "a restore around an archive planned row deletions");
    }
  });

  /* ================================================================
     the transform
     ================================================================ */

  await test("a live item strips to a bare tombstone; an existing tombstone keeps its original stamps", () => {
    assert.deepEqual(stripTombstone({ id: "a", text: "x".repeat(500), updatedAt: EARLIER }, AT), {
      id: "a",
      deletedAt: AT,
      updatedAt: AT,
    });
    // Restamping a dead item would extend its purge life for nothing.
    assert.deepEqual(stripTombstone({ id: "b", text: "y", deletedAt: EARLIER, updatedAt: EARLIER }, AT), {
      id: "b",
      deletedAt: EARLIER,
      updatedAt: EARLIER,
    });
  });

  await test("the marker keeps the rounding rule and drops the calendar", () => {
    const out = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "2026 · Semester 1", at: AT, uid });
    const row = out.settings.find((s) => !s.deletedAt);
    assert.equal(row.rounding, "half-up", "inheritedRounding reads the convention across semesters; archiving lost it");
    assert.equal(row.start, undefined, "a new term has new dates — the old calendar must not survive");
    assert.deepEqual(row.archive, { id: "arch-1", label: "2026 · Semester 1", at: AT, items: buildSummary(realisticBucket()).items });
    assert.equal(archiveMarkerOf(out).id, "arch-1");
  });

  await test("the streak carries and the minutes reset", () => {
    const out = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const totals = out.studyStats.find((it) => it.id === "t" && !it.deletedAt);
    assert.equal(totals.cur, 6, "a streak is about the student, not the semester");
    assert.equal(totals.max, 21);
    assert.equal(totals.last, "2026-08-15");
    assert.deepEqual(totals.mins, {}, "minutes are about the courses, and the courses just left");
    const dayRows = out.studyStats.filter((it) => it.id !== "t");
    assert.ok(dayRows.every((r) => r.deletedAt && !r.m), "day rows should be stripped tombstones");
  });

  await test("flagged stubs lose their previews; the archive row keeps the full copy", () => {
    const bucket = realisticBucket();
    const out = archiveTransform(bucket, { archiveId: "arch-1", label: "L", at: AT, uid });
    for (const s of out.pages.filter((p) => p.archivedIn === "arch-1")) {
      assert.deepEqual(s.aiMeta.previews, {}, "a hidden stub renders no preview; carrying two translations forever is pure residue");
      assert.equal(s.aiMeta.remote, true, "everything else on the stub must survive");
    }
    // The verbatim copy in the row is what restore brings back.
    assert.ok(bucket.pages.find((p) => p.id === "stub-1").aiMeta.previews.en.length > 0);
  });

  /* ================================================================
     merge: the archive has to survive other devices
     ================================================================ */

  const blobOf = (bucket, at) => ({ meta: { updatedAt: at }, semesters: { "Semester 1": bucket } });

  await test("a stale device syncing after an archive ends up archived, not restored", () => {
    const stale = blobOf(realisticBucket(), EARLIER);
    const archived = blobOf(archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid }), AT);
    for (const merged of [mergeData(stale, archived), mergeData(archived, stale)]) {
      const sem = merged.semesters["Semester 1"];
      assert.equal(archiveMarkerOf(sem).id, "arch-1", "the marker lost the merge");
      const liveCards = (sem.notes || []).filter((it) => !it.deletedAt);
      assert.equal(liveCards.length, 0, "archived items came back from the stale device");
      assert.equal(lateEdits(sem).length, 0);
    }
  });

  await test("an edit made on a not-yet-synced device SURVIVES the archive and is surfaced, never swept", () => {
    const offline = realisticBucket();
    offline.notes = offline.notes.map((c) => (c.id === "card-3" ? { ...c, content: "edited on the train", updatedAt: LATER } : c));
    offline.todos = [...offline.todos, { id: "todo-new", text: "added on the train", updatedAt: LATER }];
    const archived = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const merged = mergeData(blobOf(offline, LATER), blobOf(archived, AT));
    const sem = merged.semesters["Semester 1"];
    const late = lateEdits(sem);
    assert.deepEqual(late.map((l) => l.item.id).sort(), ["card-3", "todo-new"], "the late edits were lost or miscounted");
    assert.equal(archiveMarkerOf(sem).id, "arch-1", "surfacing must not cost the marker");
  });

  await test("late edits never include archived lecture stubs or bookkeeping", () => {
    const out = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    assert.equal(lateEdits(out).length, 0, "the archive's own residue read as late edits");
    assert.equal(bucketOccupied(out), false, "residue must not read as an occupied bucket");
  });

  await test("a stripped tombstone merges, ties and purges exactly like a full one", () => {
    const full = { id: "x", text: "payload", deletedAt: AT, updatedAt: AT };
    const stripped = stripTombstone({ id: "x", text: "payload", updatedAt: EARLIER }, AT);
    const liveItem = { id: "x", text: "live", updatedAt: EARLIER };
    // Both beat an older live copy.
    assert.ok(mergeList([liveItem], [stripped])[0].deletedAt);
    assert.ok(mergeList([liveItem], [full])[0].deletedAt);
    // A tie keeps the existing side — same both ways, so devices don't fight.
    assert.equal(mergeList([full], [stripped])[0], full);
    assert.equal(mergeList([stripped], [full])[0], stripped);
    // And purge treats them identically.
    const purged = purgeOldTombstones({ semesters: { S: { courses: [full, { ...stripped, id: "y" }] } } }, 0);
    assert.equal(purged.semesters.S.courses.length, 0);
  });

  /* ================================================================
     the marker's lifecycle on the device
     ================================================================ */

  await test("creating content in an archived bucket clears the marker; bookkeeping writes don't", () => {
    const archived = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const afterAdd = markerClearedOnCreate({ ...archived, courses: [{ id: "c", name: "NEW1001" }] }, "courses", LATER);
    assert.equal(archiveMarkerOf(afterAdd), null, "the student's first course of the new term read as a late edit");
    const afterStats = markerClearedOnCreate(archived, "studyStats", LATER);
    assert.equal(archiveMarkerOf(afterStats).id, "arch-1", "logging study minutes is not a decision about the term");
    // No marker, no change — and no crash.
    assert.equal(archiveMarkerOf(markerClearedOnCreate(realisticBucket(), "courses", LATER)), null);
  });

  await test("the late-edit copy is device-neutral", () => {
    /* On the device that made the edits, "another device" would be
       false — the archive happened elsewhere, the edits happened here. */
    assert.doesNotMatch(ARCHIVE_COPY.lateEdits(3), /device/i);
    assert.match(ARCHIVE_COPY.lateEdits(1), /1 item was/);
    assert.match(ARCHIVE_COPY.lateEdits(2), /2 items were/);
  });

  /* ================================================================
     restore
     ================================================================ */

  await test("restore restamps live items, leaves pre-archive deletions dead, and clears the marker", () => {
    const original = realisticBucket();
    const archived = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const out = restoreTransform(archived, original, { at: LATER });
    assert.equal(archiveMarkerOf(out), null, "the marker survived the restore");
    const card = out.notes.find((it) => it.id === "card-3");
    assert.ok(card && !card.deletedAt && card.updatedAt === LATER, "a restored item must beat its own archive-time tombstone everywhere");
    const dead = out.pages.find((p) => p.id === "deleted-page");
    assert.ok(dead.deletedAt, "restore resurrected something the student deleted BEFORE archiving");
    assert.equal(dead.updatedAt, EARLIER, "a dead item must keep its stamps or it outlives its purge window");
    const stub = out.pages.find((p) => p.id === "stub-1");
    assert.ok(!stub.archivedIn, "the un-archive must take the flag off");
    assert.ok(stub.aiMeta.previews.en.length > 0, "the row's verbatim copy should bring the previews back");
  });

  await test("a restored semester beats the archive tombstones on OTHER devices too", () => {
    const archived = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const restored = restoreTransform(archived, realisticBucket(), { at: LATER });
    const merged = mergeData(blobOf(archived, AT), blobOf(restored, LATER));
    const sem = merged.semesters["Semester 1"];
    assert.ok(sem.notes.filter((it) => !it.deletedAt).length >= 240, "the restore lost the merge to the archive tombstones");
    assert.equal(archiveMarkerOf(sem), null);
  });

  await test("restore is a UNION: newer tombstones in the bucket survive it", () => {
    // Deleted after archiving (on the restored copy elsewhere, say) —
    // a wholesale replace would resurrect it; the union must not.
    const archived = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    const laterStill = "2026-08-30T00:00:00.000Z";
    archived.todos = archived.todos.map((t) => (t.id === "todo-1" ? { id: "todo-1", deletedAt: laterStill, updatedAt: laterStill } : t));
    const out = restoreTransform(archived, realisticBucket(), { at: LATER });
    assert.ok(out.todos.find((t) => t.id === "todo-1").deletedAt, "a deletion newer than the restore was resurrected");
  });

  await test("an occupied bucket refuses a restore; archive residue doesn't count as occupied", () => {
    assert.equal(bucketOccupied(realisticBucket()), true);
    const archived = archiveTransform(realisticBucket(), { archiveId: "a", label: "L", at: AT, uid });
    assert.equal(bucketOccupied(archived), false);
    assert.equal(bucketOccupied({ ...archived, todos: [...archived.todos, { id: "new", text: "hi", updatedAt: LATER }] }), true);
  });

  /* ================================================================
     the server operations: ordering, and three distinct outcomes
     ================================================================ */

  await test("the row lands BEFORE the blob shrinks, and an insert failure keeps the parked id", async () => {
    const pending = memoryPending();
    const client = fakeClient({ failInsert: true });
    const res = await archiveSemester({
      supabaseClient: client,
      userId: "u1",
      semesterName: "Semester 1",
      bucket: realisticBucket(),
      label: "L",
      uid,
      now: AT,
      pendingStore: pending,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "failed");
    assert.equal(res.bucket, undefined, "a failed insert must never hand back a stripped bucket");
    assert.ok(pending.peek(), "the parked id was dropped, so a retry forks a second archive");
  });

  await test("a retry reuses the parked id and replaces any half-landed row (delete before insert)", async () => {
    const pending = memoryPending();
    pending.set("Semester 1", "parked-id");
    const client = fakeClient({});
    const res = await archiveSemester({
      supabaseClient: client,
      userId: "u1",
      semesterName: "Semester 1",
      bucket: realisticBucket(),
      label: "L",
      uid,
      now: AT,
      pendingStore: pending,
    });
    assert.equal(res.ok, true);
    assert.equal(res.archiveId, "parked-id");
    const del = client.calls.findIndex((c) => c.startsWith("delete:semester_archives:id=parked-id"));
    const ins = client.calls.findIndex((c) => c.startsWith("insert:semester_archives:parked-id"));
    assert.ok(del > -1 && ins > -1 && del < ins, "an older half-landed snapshot must be replaced, not kept");
    assert.equal(pending.peek(), null, "success must clear the park");
  });

  await test("a park scoped to one bucket never leaks into archiving the other", async () => {
    const pending = memoryPending();
    pending.set("Semester 1", "parked-id");
    const client = fakeClient({});
    const res = await archiveSemester({
      supabaseClient: client,
      userId: "u1",
      semesterName: "Semester 2",
      bucket: realisticBucket(),
      label: "L2",
      uid,
      now: AT,
      pendingStore: pending,
    });
    assert.notEqual(res.archiveId, "parked-id", "Semester 2 archived under Semester 1's parked id — its content was never stored");
  });

  await test("the bucket changing mid-insert refuses the strip and keeps the park", async () => {
    const pending = memoryPending();
    const client = fakeClient({});
    const res = await archiveSemester({
      supabaseClient: client,
      userId: "u1",
      semesterName: "Semester 1",
      bucket: realisticBucket(),
      label: "L",
      uid,
      now: AT,
      stillCurrent: () => false,
      pendingStore: pending,
    });
    assert.equal(res.reason, "changed");
    assert.equal(res.bucket, undefined, "stripping a bucket the snapshot no longer matches loses the difference from both places");
    assert.ok(pending.peek(), "the retry must reuse the id so the stale row is replaced");
  });

  await test("signed out, the archive refuses at the boundary — not just in the UI", async () => {
    const res = await archiveSemester({ supabaseClient: null, userId: null, semesterName: "S", bucket: realisticBucket(), label: "L", uid, now: AT, pendingStore: memoryPending() });
    assert.equal(res.reason, "unauthenticated");
    const list = await listArchives({ supabaseClient: null, userId: null });
    assert.equal(list.failed, true, "a signed-out list must read as unknown, never as empty");
  });

  await test("a failed list is UNKNOWN, never an empty list", async () => {
    const res = await listArchives({ supabaseClient: fakeClient({ failSelect: true }), userId: "u1" });
    assert.equal(res.failed, true);
    assert.equal(res.archives, undefined, "rendering 'nothing archived yet' off a dropped connection tells a student their archives are gone");
  });

  await test("fetchArchive keeps its three outcomes distinct", async () => {
    const rows = new Map([["a1", { id: "a1", label: "L", data: { courses: [] } }]]);
    const got = await fetchArchive({ supabaseClient: fakeClient({ rows }), id: "a1" });
    assert.ok(got.data, "the row was there");
    const missing = await fetchArchive({ supabaseClient: fakeClient({}), id: "gone" });
    assert.equal(missing.missing, true);
    const failed = await fetchArchive({ supabaseClient: fakeClient({ failSelect: true }), id: "a1" });
    assert.equal(failed.failed, true);
    assert.ok(!failed.missing, "an error read as absence — the exact confusion this shape exists to prevent");
  });

  await test("deleting an archive that is already gone is a success (the retry case)", async () => {
    const res = await deleteArchive({ supabaseClient: fakeClient({}), id: "never-there" });
    assert.equal(res.ok, true);
    const failed = await deleteArchive({ supabaseClient: fakeClient({ failDelete: true }), id: "x" });
    assert.equal(failed.ok, false, "a failed delete must report itself or the content outlives the intent");
  });

  await test("folding late edits merges ONLY the late items — the archive's originals all survive", async () => {
    const archivedRowData = realisticBucket();
    const rows = new Map([["arch-1", { id: "arch-1", label: "L", data: archivedRowData }]]);
    const client = fakeClient({ rows });
    const bucket = archiveTransform(realisticBucket(), { archiveId: "arch-1", label: "L", at: AT, uid });
    bucket.todos = [...bucket.todos, { id: "todo-late", text: "from the train", updatedAt: LATER }];
    const res = await foldLateEditsIntoArchive({ supabaseClient: client, userId: "u1", bucket, uid, now: LATER });
    assert.equal(res.ok, true);
    const newRow = rows.get(res.archiveId);
    assert.ok(newRow, "the merged archive row is missing");
    assert.ok(!rows.has("arch-1"), "the superseded row should be gone");
    assert.ok(newRow.data.todos.find((t) => t.id === "todo-late"), "the late item never reached the archive");
    const liveNotes = newRow.data.notes.filter((it) => !it.deletedAt);
    assert.equal(liveNotes.length, 240, "the bucket's stripped tombstones reached the merge and killed the archived originals");
    // And the blob side is re-archived under the new id.
    assert.equal(archiveMarkerOf(res.bucket).id, res.archiveId);
    assert.equal(lateEdits(res.bucket).length, 0);
    const ins = client.calls.findIndex((c) => c.startsWith(`insert:semester_archives:${res.archiveId}`));
    const del = client.calls.findIndex((c) => c === "delete:semester_archives:id=arch-1");
    assert.ok(ins > -1 && del > -1 && ins < del, "insert-new must precede delete-old, or an interruption loses the archive");
  });

  await test("folding into a deleted archive says so and moves nothing", async () => {
    const bucket = archiveTransform(realisticBucket(), { archiveId: "arch-gone", label: "L", at: AT, uid });
    bucket.todos = [...bucket.todos, { id: "todo-late", text: "x", updatedAt: LATER }];
    const res = await foldLateEditsIntoArchive({ supabaseClient: fakeClient({}), userId: "u1", bucket, uid, now: LATER });
    assert.equal(res.reason, "missing");
    const failed = await foldLateEditsIntoArchive({ supabaseClient: fakeClient({ failSelect: true }), userId: "u1", bucket, uid, now: LATER });
    assert.equal(failed.reason, "failed", "a dropped connection must not read as a deleted archive");
  });

  /* ================================================================
     the residue, derived — never typed from a model
     ================================================================ */

  const fixture = realisticBucket();
  const fixtureBytes = bytes(fixture);

  await test("the fixture stays realistic, or the residue percentages prove nothing", () => {
    assert.ok(
      fixtureBytes > 250 * 1024,
      `the fixture is ${(fixtureBytes / 1024).toFixed(0)} KB; the measured semester is ~290 KB, and shrinking the fixture quietly flatters every figure below`
    );
  });

  await test("transitional residue (tombstones still inside their 60 days) fits its ceiling", () => {
    const archived = archiveTransform(fixture, { archiveId: "arch-1", label: "2026 · Semester 1", at: AT, uid });
    const residue = bytes(archived);
    assert.ok(
      residue <= ARCHIVE_TRANSITIONAL_RESIDUE_BYTES,
      `measured ${(residue / 1024).toFixed(1)} KB against a ceiling of ${(ARCHIVE_TRANSITIONAL_RESIDUE_BYTES / 1024).toFixed(0)} KB — re-measure before touching the constant`
    );
    assert.ok(residue < fixtureBytes * 0.35, "archiving should shed at least two thirds of the bucket immediately");
  });

  await test("steady residue (after the purge window) fits its ceiling", () => {
    const archived = archiveTransform(fixture, { archiveId: "arch-1", label: "2026 · Semester 1", at: AT, uid });
    const settled = purgeOldTombstones({ semesters: { S: archived } }, 0).semesters.S;
    const residue = bytes(settled);
    assert.ok(
      residue <= ARCHIVE_STEADY_RESIDUE_BYTES,
      `measured ${(residue / 1024).toFixed(1)} KB against a ceiling of ${(ARCHIVE_STEADY_RESIDUE_BYTES / 1024).toFixed(0)} KB`
    );
  });

  await test("a whole degree fits the budget: the live year plus six archived buckets", () => {
    /* The arithmetic the feature exists to make true. The live year is
       the MEASURED post-Batch 3 account; three archived years are six
       buckets of steady residue; one bucket is freshly archived and
       still carries its transitional tombstones. Uses the ceilings, not
       the (smaller) measured figures, so the guarantee holds even at
       the constants' edge. */
    const degree =
      MEASURED_POST_BATCH3_BYTES + 6 * ARCHIVE_STEADY_RESIDUE_BYTES + ARCHIVE_TRANSITIONAL_RESIDUE_BYTES;
    assert.ok(
      degree <= BLOB_BUDGET_BYTES,
      `a degree costs ${(degree / 1024).toFixed(0)} KB against the ${(BLOB_BUDGET_BYTES / 1024).toFixed(0)} KB budget`
    );
  });

  /* ================================================================
     summaries and labels
     ================================================================ */

  await test("the summary counts the student's items and reports each course's marked average", () => {
    const s = buildSummary(realisticBucket());
    assert.ok(s.items > 300, `only ${s.items} items counted`);
    assert.equal(s.courses.length, 4);
    for (const c of s.courses) {
      assert.ok(c.average > 70 && c.average < 85, `${c.name} average ${c.average}`);
      assert.equal(c.complete, true);
    }
    // A course with nothing marked reads as null, never as zero.
    const empty = buildSummary({ courses: [{ id: "c", name: "NEW1" }], assessments: [] });
    assert.equal(empty.courses[0].average, null);
  });

  await test("the default label is the year and the bucket, and the student can change it", () => {
    assert.equal(defaultArchiveLabel("Semester 1", new Date("2026-08-16T00:00:00Z")), "2026 · Semester 1");
  });

  /* ================================================================
     the wiring: what the app actually does with all of this
     ================================================================ */

  const appSrc = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");

  await test("the Account tab renders the ArchivePanel with every handler wired", () => {
    assert.match(appSrc, /<ArchivePanel/, "the panel is never rendered");
    for (const prop of ["onArchive", "onRestore", "onDeleteArchive", "onFoldLate", "onKeepLate", "onOpenNote"]) {
      assert.match(appSrc, new RegExp(`${prop}=`), `ArchivePanel is missing ${prop}`);
    }
  });

  await test("addItem clears the marker, so the student's own new term never reads as late edits", () => {
    const body = appSrc.slice(appSrc.indexOf("const addItem ="), appSrc.indexOf("const patchItem ="));
    assert.match(body, /markerClearedOnCreate/, "addItem no longer clears the marker on creation");
  });

  await test("archiving clears the parked study timer for that semester", () => {
    const body = appSrc.slice(appSrc.indexOf("const archiveCurrentSemester"), appSrc.indexOf("const restoreArchive"));
    assert.match(body, /writeTimer\(name, null\)/, "year one's parked timer would commit its minutes to year two");
  });

  await test("archived lecture stubs stay off the Notes list and out of the folder counts", () => {
    assert.match(appSrc, /const visiblePages = pages\.filter\(\(p\) => !p\.archivedIn \|\| p\.id === expandedId\)/, "the Notes list no longer filters archived stubs (or lost the open-note escape hatch)");
    assert.match(appSrc, /pages=\{sem\.pages\.filter\(\(p\) => !p\.archivedIn\)\}/, "the Folders tab counts archived stubs again");
  });

  await test("migration 0007 has exactly three policies, no update, and account deletion covers the table", () => {
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0007_semester_archives.sql"), "utf8");
    for (const verb of ["select", "insert", "delete"]) {
      assert.match(sql, new RegExp(`semester_archives_${verb}_own`), `the ${verb} policy is missing`);
    }
    assert.doesNotMatch(sql, /for update/i, "an update policy appeared — the late-edit fold is insert-new-then-delete-old precisely so this never exists");
    assert.match(sql, /grant select, insert, delete on public\.semester_archives/, "the explicit grant is gone, or grew a verb");
    assert.match(sql, /delete from public\.semester_archives where user_id = uid/, "delete_my_account_data no longer empties the archives");
  });

  await test("npm test runs this file", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-archive\.mjs/, "the archive tests were dropped from `npm test`");
  });

  /* ================================================================
     nothing reads a tombstone's content — demonstrated, not asserted
     ================================================================

     The strip depends on tombstone payloads being write-only. That was
     an accident of how readers filter; this differential mount is what
     makes it a contract: the same planner, once with full-payload
     tombstones and once with stripped ones, must render byte-identical
     HTML on every tab. A reader that renders any part of a dead item's
     payload shows up as a diff. */

  await test("full and stripped tombstones render byte-identical HTML on every tab", async () => {
    const tmp = path.join(rootDir, ".archive-test-tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const demoConfig = path.join(tmp, "config-demo.js");
    fs.writeFileSync(
      demoConfig,
      'export const SUPABASE_URL = "PASTE_YOUR_URL";\nexport const SUPABASE_ANON_KEY = "PASTE_YOUR_KEY";\nexport const isConfigured = false;\n'
    );
    const bundle = await build({
      entryPoints: [path.join(rootDir, "src/main.jsx")],
      bundle: true,
      format: "iife",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [
        {
          name: "force-demo-config",
          setup(b) {
            b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
          },
        },
      ],
    });

    const liveItems = {
      courses: [{ id: "lc", name: "LIVE1001", updatedAt: EARLIER }],
      todos: [{ id: "lt", text: "a live todo so the page is not empty", updatedAt: EARLIER }],
      pages: [{ id: "lp", title: "A live note", body: "Body text.", html: "<p>Body text.</p>", strokes: [], style: "lined", kind: "text", font: "sans", folderId: null, updatedAt: EARLIER }],
    };
    const fullTombs = {
      todos: [{ id: "dt", text: "deleted todo payload", done: true, deletedAt: EARLIER, updatedAt: EARLIER }],
      notes: [{ id: "dn", course: "LIVE1001", term: "dead card", content: "dead card content", srs: { due: "2026-01-01" }, deletedAt: EARLIER, updatedAt: EARLIER }],
      pages: [{ id: "dp", title: "Deleted drawing", body: "", html: "", strokes: [{ color: "#000", width: 3, points: [[1, 2, 0.5], [3, 4, 0.5]] }], kind: "drawing", deletedAt: EARLIER, updatedAt: EARLIER }],
      assignments: [{ id: "da", course: "LIVE1001", title: "Dead assignment", due: "2026-09-01", rubric: [{ id: "dr", label: "dead criterion" }], deletedAt: EARLIER, updatedAt: EARLIER }],
    };
    const seed = (tombs) =>
      JSON.stringify({
        semester: "Semester 1",
        semesters: {
          "Semester 1": {
            ...liveItems,
            todos: [...liveItems.todos, ...(tombs.todos || [])],
            pages: [...liveItems.pages, ...(tombs.pages || [])],
            notes: tombs.notes || [],
            assignments: tombs.assignments || [],
          },
        },
        meta: { updatedAt: EARLIER },
      });
    const strippedTombs = Object.fromEntries(
      Object.entries(fullTombs).map(([k, list]) => [k, list.map((it) => stripTombstone(it, AT))])
    );

    const mount = async (seedJson) => {
      const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        runScripts: "outside-only",
        url: "https://example.test/",
        pretendToBeVisual: true,
      });
      const w = dom.window;
      // Frozen clock AND frozen randomness, so nothing time- or
      // id-derived can diff the two mounts — the same arrangement as
      // test-blocks-neutral.mjs, for the same reason.
      const FIXED = new Date("2026-08-16T02:00:00Z").getTime();
      const RealDate = w.Date;
      w.Date = class extends RealDate {
        constructor(...a) {
          if (a.length) super(...a);
          else super(FIXED);
        }
        static now() {
          return FIXED;
        }
      };
      let seed = 42;
      w.Math.random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      w.localStorage.setItem("uni-planner-v1", seedJson);
      const errors = [];
      w.console.error = (...a) => errors.push(a.join(" "));
      w.eval(bundle.outputFiles[0].text);
      await new Promise((r) => setTimeout(r, 250));
      const doc = w.document;
      const snapshots = {};
      const tabs = [...doc.querySelectorAll("button")].filter((b) => ["Planner", "Study", "Notes", "Folders", "Account"].includes((b.textContent || "").trim()));
      /* The header's save indicator is TIMING, not content: the bigger
         full-tombstone blob serialises slower, so one mount can still
         say "Saving…" when the other says "Saved". Waiting for the
         save to settle keeps the comparison about what is RENDERED
         from the data, which is the claim under test. */
      const settled = async () => {
        for (let i = 0; i < 60; i++) {
          if (!(doc.body.textContent || "").includes("Saving")) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await settled();
      // Captured on the first tab (Courses), where the live marker shows.
      const text = doc.body.textContent || "";
      snapshots.initial = doc.body.innerHTML;
      for (const t of tabs) {
        t.click();
        await new Promise((r) => setTimeout(r, 120));
        await settled();
        snapshots[(t.textContent || "").trim()] = doc.body.innerHTML;
      }
      return { snapshots, errors, text };
    };

    const a = await mount(seed(fullTombs));
    const b = await mount(seed(strippedTombs));
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.equal(a.errors.length, 0, `full-tombstone mount logged errors: ${a.errors[0] || ""}`);
    assert.equal(b.errors.length, 0, `stripped-tombstone mount logged errors: ${b.errors[0] || ""}`);
    assert.ok(a.text.includes("LIVE1001"), "the comparison is empty-vs-empty, which proves nothing");
    const tabsSeen = Object.keys(a.snapshots);
    assert.ok(tabsSeen.length > 2, "the walk never left the first tab");
    /* THE ONE PERMITTED CONSUMER, masked by name: the Backup panel's
       size line measures the whole serialised blob, and a stripped
       tombstone really is smaller — that is the feature. Masking the
       rendered byte-figure keeps the comparison honest about payload
       READS while allowing the one legitimate whole-blob MEASURE.
       Everything else on every tab must be identical. */
    const norm = (html) => html.replace(/\d+(?:\.\d+)?\s?(?:B|KB|MB)\b/g, "•SIZE•");
    for (const tab of tabsSeen) {
      assert.equal(
        norm(a.snapshots[tab]) === norm(b.snapshots[tab]),
        true,
        `"${tab}" renders differently with stripped tombstones — something reads a dead item's payload`
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
