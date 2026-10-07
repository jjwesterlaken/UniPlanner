/* test-course-rename.mjs — renaming a course rewrites every place the
   name is written down, and nothing else (src/courseRename.js). */

import assert from "node:assert/strict";
import { renameCourse, renameRefusal, removalPlan, COURSE_FIELD_COLLECTIONS } from "../src/courseRename.js";
import { COLLECTIONS } from "../src/sync.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous; an async test would pass before it asserted");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-10-07T12:00:00.000Z";
const sem = () => ({
  courses: [
    { id: "c1", name: "PSYC1001", updatedAt: OLD },
    { id: "c2", name: "HIST1001", updatedAt: OLD },
    { id: "c0", name: "PSYC1001", deletedAt: OLD, updatedAt: OLD },
  ],
  todos: [{ id: "t1", text: "x", course: "PSYC1001", updatedAt: OLD }],
  textbook: [{ id: "r1", course: "PSYC1001", week: "2", updatedAt: OLD }],
  assignments: [
    { id: "a1", title: "Essay", course: "PSYC1001", updatedAt: OLD },
    { id: "a2", title: "Other", course: "HIST1001", updatedAt: OLD },
  ],
  notes: [{ id: "n1", term: "t", course: "PSYC1001", updatedAt: OLD }],
  events: [{ id: "e1", title: "Lecture", course: "PSYC1001", updatedAt: OLD }],
  assessments: [
    { id: "s1", title: "Exam", course: "PSYC1001", w: 50, updatedAt: OLD },
    { id: "s2", title: "Gone", course: "PSYC1001", w: 10, deletedAt: OLD, updatedAt: OLD },
  ],
  pages: [
    { id: "p1", title: "Lecture 3", aiMeta: { course: "PSYC1001", week: "3", previews: {} }, updatedAt: OLD },
    { id: "p2", title: "Deleted lecture", aiMeta: { course: "PSYC1001" }, deletedAt: OLD, updatedAt: OLD },
    { id: "p3", title: "Plain", updatedAt: OLD },
  ],
  folders: [
    { id: "f1", name: "PSYC1001 recordings", updatedAt: OLD },
    { id: "f2", name: "My PSYC1001 stuff", updatedAt: OLD },
  ],
  studyStats: [
    { id: "d:2026-10-06", m: { PSYC1001: 20, HIST1001: 5 }, c: 3, updatedAt: OLD },
    { id: "totals", mins: { PSYC1001: 120, "PSYCH 1001": 4 }, cur: 2, max: 5, last: "2026-10-06", updatedAt: OLD },
    { id: "d:2026-10-01", m: { HIST1001: 9 }, c: 0, updatedAt: OLD },
  ],
});

test("every live item carrying the old name gets the new one, and a fresh stamp", () => {
  const { semester: s, changed } = renameCourse(sem(), { from: "PSYC1001", to: "PSYCH 1001", now: NOW });
  const c1 = s.courses.find((c) => c.id === "c1");
  assert.equal(c1.name, "PSYCH 1001");
  assert.equal(c1.updatedAt, NOW);
  for (const key of COURSE_FIELD_COLLECTIONS) {
    for (const it of s[key].filter((x) => !x.deletedAt && x.id !== "a2")) {
      assert.equal(it.course, "PSYCH 1001", `${key}/${it.id} kept the old name`);
      assert.equal(it.updatedAt, NOW, `${key}/${it.id} changed without a new stamp, so it would not propagate`);
    }
  }
  assert.equal(s.pages.find((p) => p.id === "p1").aiMeta.course, "PSYCH 1001");
  assert.equal(s.pages.find((p) => p.id === "p1").aiMeta.week, "3", "the stub lost its other fields");
  /* courses c1, todo, reading, a1, note, event, s1, stub p1, folder f1, two stats rows */
  assert.equal(changed, 11);
});

test("an untouched item is returned BY REFERENCE, so a rename writes only what it changed", () => {
  const before = sem();
  const { semester: s } = renameCourse(before, { from: "PSYC1001", to: "PSYCH 1001", now: NOW });
  assert.equal(s.assignments.find((a) => a.id === "a2"), before.assignments[1]);
  assert.equal(s.courses.find((c) => c.id === "c2"), before.courses[1]);
  assert.equal(s.pages.find((p) => p.id === "p3"), before.pages[2]);
  assert.equal(s.studyStats[2], before.studyStats[2], "a day row with no minutes for the course was rewritten");
});

test("TOMBSTONES ARE NEVER TOUCHED — a deleted course, assessment or AI-note stub keeps the name it died with", () => {
  const before = sem();
  const { semester: s } = renameCourse(before, { from: "PSYC1001", to: "PSYCH 1001", now: NOW });
  assert.equal(s.courses.find((c) => c.id === "c0"), before.courses[2]);
  assert.equal(s.assessments.find((a) => a.id === "s2"), before.assessments[1]);
  assert.equal(s.pages.find((p) => p.id === "p2"), before.pages[1], "a tombstoned AI stub was rewritten — reconciliation reads its aiMeta");
});

test("study minutes move to the new key, summing into minutes already there", () => {
  const { semester: s } = renameCourse(sem(), { from: "PSYC1001", to: "PSYCH 1001", now: NOW });
  assert.deepEqual(s.studyStats[0].m, { HIST1001: 5, "PSYCH 1001": 20 });
  assert.deepEqual(s.studyStats[1].mins, { "PSYCH 1001": 124 });
  assert.equal(s.studyStats[1].cur, 2, "the streak was lost in the rename");
});

test("the auto-made recordings folder follows the course; a folder the student named does not", () => {
  const { semester: s } = renameCourse(sem(), { from: "PSYC1001", to: "PSYCH 1001", now: NOW });
  assert.equal(s.folders[0].name, "PSYCH 1001 recordings");
  assert.equal(s.folders[1].name, "My PSYC1001 stuff");
  /* And not onto a folder that already has the new name. */
  const base = sem();
  base.folders.push({ id: "f3", name: "PSYCH 1001 recordings", updatedAt: OLD });
  const { semester: t } = renameCourse(base, { from: "PSYC1001", to: "PSYCH 1001", now: NOW });
  assert.equal(t.folders[0].name, "PSYC1001 recordings", "two folders would now share one name");
});

test("REFUSED, with nothing changed: empty, unchanged, or another live course's name in any case", () => {
  assert.equal(renameRefusal(sem(), "PSYC1001", "  "), "empty");
  assert.equal(renameRefusal(sem(), "PSYC1001", "PSYC1001"), "unchanged");
  assert.equal(renameRefusal(sem(), "PSYC1001", "hist1001"), "exists");
  assert.deepEqual(renameCourse(sem(), { from: "PSYC1001", to: "HIST1001", now: NOW }), { refused: "exists" });
  /* A change of case on the same course is a rename, and a deleted course's name is free. */
  assert.equal(renameRefusal(sem(), "PSYC1001", "psyc1001"), null);
  const s = sem();
  s.courses.push({ id: "c9", name: "BIOL1001", deletedAt: OLD, updatedAt: OLD });
  assert.equal(renameRefusal(s, "PSYC1001", "BIOL1001"), null);
});

test("every collection that can carry a course name is covered — derived from COLLECTIONS, not listed", () => {
  /* The collections with a `course` field, plus the four handled by
     name (courses, pages, folders, studyStats). Anything else in
     COLLECTIONS must be one that never holds a course name; a new
     collection fails here until somebody decides which it is. */
  const handled = new Set([...COURSE_FIELD_COLLECTIONS, "courses", "pages", "folders", "studyStats"]);
  const neverHoldsACourse = new Set(["settings", "practiceAttempts"]);
  const unclaimed = COLLECTIONS.filter((k) => !handled.has(k) && !neverHoldsACourse.has(k));
  assert.ok(COLLECTIONS.length >= 10, "COLLECTIONS read as nearly empty");
  assert.deepEqual(unclaimed, [], `collections nobody decided about: ${unclaimed.join(", ")}`);
});

test("REMOVE: an empty course goes alone; one with assessments names them so the confirmation can say so", () => {
  assert.deepEqual(removalPlan(sem(), "PSYC1001").assessmentIds, ["s1"], "a tombstoned assessment was counted");
  assert.equal(removalPlan(sem(), "PSYC1001").course.id, "c1");
  assert.deepEqual(removalPlan(sem(), "HIST1001").assessmentIds, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed === 0) process.exit(1);
