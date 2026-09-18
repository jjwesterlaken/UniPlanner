/* "Clear everything" must survive a sync.

   THE CLAIM: clear, then sync, and the planner is STILL EMPTY — on
   this device and on a second one that still holds the full planner.

   The test performs the action rather than reading a flag. It runs the
   REAL `mergeData` and `purgeOldTombstones` from src/sync.js against a
   fake backend that holds one row — that row IS the server — because
   the merge is the exact step that used to resurrect the data. A test
   that asserted "reset writes deletedAt" would pass without ever
   showing that the deletion survives the round trip, which is the only
   thing anybody cares about.

   Section 2 is the one to read first: it runs the OLD behaviour and
   requires the data to COME BACK. Without it, "the planner is empty
   after a sync" could pass for any number of reasons that have nothing
   to do with this fix — an empty fixture, a merge that never ran, a
   backend that returned nothing. Same shape as the migration suite's
   "THE LOST UPDATE, demonstrated".

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeData, purgeOldTombstones, COLLECTIONS } from "../src/sync.js";
import { clearTransform, clearedData, liveItemCount } from "../src/clearEverything.js";
import { reconcilePlan, isAiNote } from "../src/aiNotesStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

/* ---------- the fixture, and the fake server ---------- */

const T0 = "2026-09-01T00:00:00.000Z";
const AT = "2026-09-18T04:00:00.000Z";

const item = (id, extra = {}) => ({ id, updatedAt: T0, ...extra });

const populated = () => ({
  semester: "Semester 1",
  theme: "teal",
  meta: { updatedAt: T0, lastSyncedAt: T0 },
  semesters: {
    "Semester 1": {
      courses: [item("c1", { name: "BIOL120" }), item("c2", { name: "HIST210" })],
      assignments: [item("a1", { title: "Essay" })],
      notes: [item("n1", { term: "mitosis" })],
      pages: [
        item("p1", { title: "A typed note", body: "words" }),
        item("p2", { title: "Week 3 lecture", aiMeta: { previews: { en: "an overview…" } } }),
      ],
      settings: [item("s1", { rounding: "half-up", start: "2026-07-21" })],
      studyStats: [item("totals", { cur: 3, max: 7 })],
    },
    "Semester 2": { courses: [item("c3", { name: "STAT150" })] },
  },
});

/* The server: one row, exactly like `planner_data`. `push` upserts and
   `pull` selects, which is all supabaseBackend does. */
const makeServer = (initial = null) => {
  let row = initial;
  return {
    pull: () => (row ? JSON.parse(JSON.stringify(row)) : null),
    push: (data) => { row = JSON.parse(JSON.stringify(data)); },
    raw: () => row,
  };
};

/* THE REAL SYNC STEP, lifted out of PlannerApp.runSync: pull, merge,
   purge, push. Nothing here is a model of the merge — it is the merge. */
const sync = (local, server) => {
  const merged = purgeOldTombstones(mergeData(local, server.pull()));
  server.push(merged);
  return merged;
};

/* ---------- 1. non-vacuity: the fixture is really populated ---------- */

test("THE FIXTURE IS POPULATED AND REALLY REACHES THE SERVER", () => {
  /* Every assertion below is "and then it is empty". All of them pass
     trivially over a planner that was never filled, so this runs
     first and the rest depend on it. */
  const server = makeServer();
  const synced = sync(populated(), server);
  assert.ok(liveItemCount(synced) >= 8, `only ${liveItemCount(synced)} live items in the fixture`);
  assert.ok(liveItemCount(server.raw()) >= 8, "the server row did not receive the planner");
  assert.ok(
    (server.raw().semesters["Semester 1"].pages || []).some(isAiNote),
    "the fixture has no AI note, so the stub rules below would assert nothing"
  );
});

/* ---------- 2. the bug, demonstrated ---------- */

test("THE OLD BEHAVIOUR RESURRECTS EVERYTHING — the bug, run rather than described", () => {
  /* Exactly what PlannerApp's `reset` did before this fix: replace the
     blob with empty semesters and touch nothing else. */
  const server = makeServer();
  sync(populated(), server);

  const wiped = {
    semester: "Semester 1",
    theme: "teal",
    meta: { updatedAt: T0, lastSyncedAt: T0 },
    semesters: { "Semester 1": {}, "Semester 2": {} },
  };
  assert.equal(liveItemCount(wiped), 0, "the wipe itself did not empty the planner");

  const after = sync(wiped, server);
  assert.ok(
    liveItemCount(after) >= 8,
    `the old behaviour was supposed to bring the data back and did not (${liveItemCount(after)} live) — ` +
      "if this test fails, the resurrection mechanism changed and the rest of this file is measuring something else"
  );
});

/* ---------- 3. the fix ---------- */

test("CLEAR, THEN SYNC, AND IT IS STILL EMPTY", () => {
  const server = makeServer();
  sync(populated(), server);

  const cleared = clearedData(populated(), { at: AT });
  assert.equal(liveItemCount(cleared), 0, "clearing did not empty the planner locally");

  const after = sync(cleared, server);
  assert.equal(liveItemCount(after), 0, `${liveItemCount(after)} items came back through the merge`);
  assert.equal(liveItemCount(server.raw()), 0, "the server row still holds live items");
});

test("A SECOND DEVICE STILL HOLDING THE FULL PLANNER IS EMPTIED BY THE SYNC", () => {
  /* The half a server-side delete could never do: the other phone has
     the whole planner in localStorage and pushes it back up. Only a
     tombstone that BEATS it on updatedAt can settle that. */
  const server = makeServer();
  sync(populated(), server);
  sync(clearedData(populated(), { at: AT }), server);

  const other = sync(populated(), server);
  assert.equal(liveItemCount(other), 0, `the second device kept ${liveItemCount(other)} live items`);
});

test("clearing wins however many times the two devices sync", () => {
  const server = makeServer();
  sync(populated(), server);
  sync(clearedData(populated(), { at: AT }), server);
  let d = populated();
  for (let i = 0; i < 4; i++) d = sync(d, server);
  assert.equal(liveItemCount(d), 0, "it came back on a later round");
});

/* ---------- 4. the AI-note rule, which is the archive's inverted ---------- */

test("A CLEARED AI STUB IS TOMBSTONED, so reconciliation deletes its row", () => {
  const cleared = clearTransform(populated().semesters["Semester 1"], { at: AT });
  const stub = cleared.pages.find((p) => p.id === "p2");
  assert.ok(stub.deletedAt, "the AI stub was not tombstoned — the lecture would stay on the server");
  const { toDelete } = reconcilePlan({ remoteIds: ["p2"], pages: cleared.pages });
  assert.deepEqual(toDelete, ["p2"], "reconciliation would not delete the row");
});

test("AND IT KEEPS `aiMeta`, or reconciliation cannot see it at all", () => {
  /* `isAiNote` is `!!page.aiMeta`. Strip the stub bare and the row is
     orphaned on the server FOR EVER with nothing pointing at it —
     the failure is silent and permanent, so it is asserted directly
     rather than left to the reconcile test above. */
  const cleared = clearTransform(populated().semesters["Semester 1"], { at: AT });
  const stub = cleared.pages.find((p) => p.id === "p2");
  assert.ok(isAiNote(stub), "a cleared stub stopped being recognisable as an AI note");
  assert.deepEqual(stub.aiMeta, {}, "the previews should go; only recognisability stays");
});

test("an AI stub that was ALREADY a tombstone is left entirely alone", () => {
  const bucket = populated().semesters["Semester 1"];
  bucket.pages.push({ id: "p3", deletedAt: T0, updatedAt: T0, aiMeta: { previews: {} } });
  const cleared = clearTransform(bucket, { at: AT });
  const old = cleared.pages.find((p) => p.id === "p3");
  assert.equal(old.deletedAt, T0, "restamping extends its purge life for nothing");
  assert.ok(isAiNote(old), "it must stay recognisable to reconciliation");
});

test("an ordinary page is stripped bare — no payload survives a clear", () => {
  const cleared = clearTransform(populated().semesters["Semester 1"], { at: AT });
  const page = cleared.pages.find((p) => p.id === "p1");
  assert.deepEqual(Object.keys(page).sort(), ["deletedAt", "id", "updatedAt"]);
});

/* ---------- 5. everything means everything ---------- */

test("the calendar, the rounding rule and the streak go too", () => {
  /* The archive KEEPS all three, deliberately. Clearing is the other
     decision and the asymmetry is the whole point of the module. */
  const cleared = clearTransform(populated().semesters["Semester 1"], { at: AT });
  assert.ok(cleared.settings.every((s) => s.deletedAt), "a settings row survived");
  assert.ok(cleared.studyStats.every((s) => s.deletedAt), "the streak survived");
  assert.equal(cleared.settings[0].rounding, undefined, "the rounding rule was kept");
});

test("every collection is covered — derived from COLLECTIONS, not listed here", () => {
  const cleared = clearTransform(populated().semesters["Semester 1"], { at: AT });
  assert.ok(COLLECTIONS.length > 5, `only ${COLLECTIONS.length} collections — the import is wrong`);
  for (const key of COLLECTIONS) {
    assert.ok(Array.isArray(cleared[key]), `${key} is missing from a cleared bucket`);
    for (const it of cleared[key]) assert.ok(it.deletedAt, `a live ${key} item survived the clear`);
  }
});

test("both semesters are cleared, not just the selected one", () => {
  const cleared = clearedData(populated(), { at: AT });
  assert.equal(liveItemCount(cleared), 0);
  assert.ok((cleared.semesters["Semester 2"].courses || []).every((c) => c.deletedAt));
});

test("meta.updatedAt is stamped NOW, which is what makes the push fire", () => {
  const cleared = clearedData(populated(), { at: AT });
  assert.equal(cleared.meta.updatedAt, AT);
});

/* ---------- 6. the control: single-item deletion still works ---------- */

test("CONTROL: deleting ONE item still survives a sync, exactly as before", () => {
  /* This path was never broken and the fix must not disturb it. If
     this reddens, the change reached further than it should have. */
  const server = makeServer();
  sync(populated(), server);
  const local = populated();
  local.semesters["Semester 1"].courses = local.semesters["Semester 1"].courses.map((c) =>
    c.id === "c1" ? { ...c, deletedAt: AT, updatedAt: AT } : c
  );
  const after = sync(local, server);
  const c1 = after.semesters["Semester 1"].courses.find((c) => c.id === "c1");
  assert.ok(c1.deletedAt, "a single deleted course came back");
  assert.ok(
    after.semesters["Semester 1"].courses.some((c) => c.id === "c2" && !c.deletedAt),
    "the other course was deleted too — the clear reached further than one item"
  );
});

/* ---------- 7. the wiring ---------- */

test("PlannerApp's reset uses the transform rather than wiping", () => {
  const src = read("src/PlannerApp.jsx");
  assert.match(src, /clearedData\(/, "reset no longer goes through clearedData");
  assert.ok(
    !/const reset = \(\) => \{\s*setData\(\{ \.\.\.DEFAULT/.test(src),
    "the old hard-wipe reset is back"
  );
});

test("the confirm copy says what it now really does", () => {
  /* SCOPED TO THE CONFIRM BLOCK, not to the file. The first version of
     this greped all 6,000 lines of PlannerApp.jsx and passed before a
     word of the copy had changed — /archived/i matched the archive
     feature and "every device" matched a comment. A guard scoped to a
     file rather than to the claim is the ledger's sixteenth entry, and
     this is it happening inside the test written for the fix. */
  const src = read("src/PlannerApp.jsx");
  const at = src.indexOf("Clear everything?");
  assert.ok(at > 0, "the confirm copy is gone — this guard is reading nothing");
  const block = src.slice(at, at + 700);
  assert.match(block, /can't be undone/i);
  assert.match(block, /every device|all your devices/i, "it must say the clear reaches other devices");
  assert.match(block, /archived/i, "archives are the thing a student least expects to lose");
});

test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-clear-everything\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
