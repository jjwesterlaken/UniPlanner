/* Batch 3: reading progress, rubric checklists, reference sheets.

   The claims worth pinning are about what happens to a user's typed
   text: it is never silently shortened, an overage is named rather than
   implied, and the sum of every cap still fits the blob allowance.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUBRIC_LABEL_MAX,
  RUBRIC_NOTE_MAX,
  RUBRIC_CRITERIA_MAX,
  RUBRICS_PER_SEMESTER_MAX,
  ENTRY_LABEL_MAX,
  ENTRY_BODY_MAX,
  SHEET_ENTRIES_MAX,
  SHEETS_PER_SEMESTER_MAX,
  BATCH3_ALLOWANCE_BYTES,
  worstCaseBytes,
  nextReadState,
  isRead,
  isStarted,
  readingProgress,
  checkLength,
  validateRubric,
  splitPastedRubric,
  rubricProgress,
  hasRubric,
  validateSheet,
  canAddSheet,
  canAddRubric,
  isReferenceSheet,
  sheetSummary,
  FORMULA_KIND,
} from "../src/reference.js";

import { mergeData, COLLECTIONS } from "../src/sync.js";

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

let n = 0;
const uid = () => `r${n++}`;
const S = (len) => "x".repeat(len);

async function run() {
  /* ---------- the budget, which gates every cap above ---------- */

  await test("the sum of every cap fits the allowance Batch 3 was given", () => {
    // The one test that has to be recomputed before any cap is raised.
    // It is deliberately about STORED BYTES across both semesters, not
    // character counts, because the blob is what runs out.
    const worst = worstCaseBytes({ semesters: 2 });
    assert.ok(
      worst <= BATCH3_ALLOWANCE_BYTES,
      `Batch 3's worst case is ${(worst / 1024).toFixed(0)} KB against an allowance of ` +
        `${(BATCH3_ALLOWANCE_BYTES / 1024).toFixed(0)} KB. Raising a cap means redoing this arithmetic, not this number.`
    );
  });

  await test("the allowance is a slice of the budget, not the whole of it", () => {
    // Study cards and notebook pages are uncapped, and semesters are
    // reused rather than archived, so Batch 3 must not spend the lot.
    assert.ok(BATCH3_ALLOWANCE_BYTES < 1024 * 1024, "the allowance is the entire working budget");
  });

  /* ---------- reading progress ---------- */

  await test("a reading with no read field counts as not started", () => {
    assert.equal(isStarted({ id: "a" }), false);
    assert.equal(isRead({ id: "a" }), false);
    assert.equal(isStarted(null), false);
  });

  await test("a reading marked part counts as started but not done", () => {
    assert.equal(isStarted({ read: "part" }), true);
    assert.equal(isRead({ read: "part" }), false);
    assert.equal(isRead({ read: "done" }), true);
  });

  await test("the tick cycles untouched, part, done, and back", () => {
    assert.equal(nextReadState(""), "part");
    assert.equal(nextReadState("part"), "done");
    assert.equal(nextReadState("done"), "");
    assert.equal(nextReadState(undefined), "part");
  });

  await test("a course with no readings reads as 0 of 0 rather than dividing by zero", () => {
    const p = readingProgress([]);
    assert.deepEqual(p, { total: 0, done: 0, started: 0, percent: 0 });
    assert.ok(Number.isFinite(p.percent));
  });

  await test("deleted readings count for nothing", () => {
    const p = readingProgress([
      { id: "1", read: "done" },
      { id: "2", read: "done", deletedAt: "2026-01-01" },
      { id: "3" },
    ]);
    assert.equal(p.total, 2);
    assert.equal(p.done, 1);
    assert.equal(p.percent, 50);
  });

  /* ---------- the enforcement rule ---------- */

  await test("text over the cap is returned intact, never shortened", () => {
    const pasted = S(2000);
    const r = checkLength(pasted, RUBRIC_LABEL_MAX, "Criterion 1");
    assert.equal(r.ok, false);
    assert.equal(r.value.length, 2000, "the value was truncated — it must be returned whole");
    assert.equal(r.value, pasted);
  });

  await test("the message names the overage, not the limit", () => {
    const r = checkLength(S(RUBRIC_LABEL_MAX + 312), RUBRIC_LABEL_MAX, "Criterion 1");
    assert.equal(r.over, 312);
    assert.match(r.message, /312 characters over/);
    // "limit 140" makes someone count; "312 over" tells them what to do.
    assert.doesNotMatch(r.message, new RegExp(`limit ${RUBRIC_LABEL_MAX}`));
  });

  await test("one character over reads as singular", () => {
    const r = checkLength(S(RUBRIC_LABEL_MAX + 1), RUBRIC_LABEL_MAX);
    assert.match(r.message, /1 character over/);
    assert.doesNotMatch(r.message, /1 characters/);
  });

  await test("whitespace is trimmed before the length check", () => {
    // A trailing newline from a paste must not cost a criterion its last
    // character, and must not push an exactly-full field over.
    const exact = S(RUBRIC_LABEL_MAX);
    assert.equal(checkLength(`  ${exact}\n`, RUBRIC_LABEL_MAX).ok, true);
    assert.equal(checkLength(exact, RUBRIC_LABEL_MAX).ok, true);
    assert.equal(checkLength(S(RUBRIC_LABEL_MAX + 1), RUBRIC_LABEL_MAX).ok, false);
  });

  await test("a non-string is handled rather than throwing", () => {
    for (const v of [null, undefined, 42, {}]) {
      assert.equal(checkLength(v, 10).ok, true);
    }
  });

  /* ---------- rubrics ---------- */

  await test("a criterion one character over its cap is rejected", () => {
    assert.equal(validateRubric([{ id: "a", label: S(RUBRIC_LABEL_MAX) }]).ok, true);
    const bad = validateRubric([{ id: "a", label: S(RUBRIC_LABEL_MAX + 1) }]);
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], /Criterion 1/);
  });

  await test("a note over its cap is rejected separately from the label", () => {
    const bad = validateRubric([{ id: "a", label: "fine", note: S(RUBRIC_NOTE_MAX + 5) }]);
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], /note on criterion 1/i);
  });

  await test("too many criteria is refused with the count and the limit", () => {
    const many = Array.from({ length: RUBRIC_CRITERIA_MAX + 3 }, (_, i) => ({ id: `c${i}`, label: "x" }));
    const bad = validateRubric(many);
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], new RegExp(`${RUBRIC_CRITERIA_MAX + 3} criteria`));
    assert.match(bad.problems[0], new RegExp(`holds ${RUBRIC_CRITERIA_MAX}`));
  });

  await test("splitting a pasted block keeps every line", () => {
    const r = splitPastedRubric("First thing\nSecond thing\n\n  Third thing  ", uid);
    assert.equal(r.ok, true);
    assert.deepEqual(r.criteria.map((c) => c.label), ["First thing", "Second thing", "Third thing"]);
  });

  await test("splitting strips list markers people actually paste", () => {
    const r = splitPastedRubric("- One\n* Two\n1. Three\n2) Four\n• Five", uid);
    assert.deepEqual(r.criteria.map((c) => c.label), ["One", "Two", "Three", "Four", "Five"]);
  });

  await test("a paste of more lines than the cap is refused, not trimmed", () => {
    // Silently dropping the tail of someone's marking criteria is the
    // exact failure the enforcement rule exists to prevent.
    const text = Array.from({ length: 40 }, (_, i) => `Criterion ${i}`).join("\n");
    const r = splitPastedRubric(text, uid);
    assert.equal(r.ok, false);
    assert.equal(r.criteria.length, 0, "it kept a truncated subset instead of refusing");
    assert.match(r.message, /40 lines/);
    assert.match(r.message, new RegExp(`${RUBRIC_CRITERIA_MAX} criteria`));
  });

  await test("splitting nothing says so rather than making an empty criterion", () => {
    assert.equal(splitPastedRubric("   \n  \n", uid).ok, false);
    assert.equal(splitPastedRubric("", uid).ok, false);
  });

  await test("a rubric with no criteria reads as 0 of 0, not as complete", () => {
    const p = rubricProgress([]);
    assert.deepEqual(p, { total: 0, done: 0, complete: false });
  });

  await test("a rubric with every criterion ticked reads as complete", () => {
    const p = rubricProgress([{ id: "a", done: true }, { id: "b", done: true }]);
    assert.equal(p.complete, true);
    assert.equal(p.done, 2);
  });

  await test("a tick on a deleted criterion doesn't count toward the total", () => {
    const p = rubricProgress([
      { id: "a", done: true },
      { id: "b", done: true, deletedAt: "2026-01-01" },
      { id: "c", done: false },
    ]);
    assert.equal(p.total, 2);
    assert.equal(p.done, 1);
    assert.equal(p.complete, false);
  });

  await test("an assignment with an empty rubric array doesn't count as having one", () => {
    assert.equal(hasRubric({ id: "a", rubric: [] }), false);
    assert.equal(hasRubric({ id: "a" }), false);
    assert.equal(hasRubric({ id: "a", rubric: [{ id: "c", label: "x" }] }), true);
  });

  await test("the rubric-per-semester cap counts assignments that actually have one", () => {
    const many = Array.from({ length: RUBRICS_PER_SEMESTER_MAX }, (_, i) => ({
      id: `a${i}`,
      rubric: [{ id: "c", label: "x" }],
    }));
    assert.equal(canAddRubric(many).ok, false);
    assert.equal(canAddRubric(many.slice(1)).ok, true);
    // An assignment with no rubric doesn't consume the allowance.
    assert.equal(canAddRubric([...many.slice(1), { id: "z" }]).ok, true);
  });

  /* ---------- reference sheets ---------- */

  await test("a reference sheet is a page, discriminated by kind", () => {
    assert.equal(isReferenceSheet({ kind: FORMULA_KIND }), true);
    assert.equal(isReferenceSheet({ kind: "text" }), false);
    assert.equal(isReferenceSheet({ kind: "drawing" }), false);
    assert.equal(isReferenceSheet(null), false);
  });

  await test("an entry body of exactly the cap is accepted and one more is not", () => {
    assert.equal(validateSheet([{ id: "e", label: "a", body: S(ENTRY_BODY_MAX) }]).ok, true);
    assert.equal(validateSheet([{ id: "e", label: "a", body: S(ENTRY_BODY_MAX + 1) }]).ok, false);
    assert.equal(validateSheet([{ id: "e", label: S(ENTRY_LABEL_MAX + 1), body: "b" }]).ok, false);
  });

  await test("a sheet at its entry cap refuses the next one with the limit named", () => {
    const many = Array.from({ length: SHEET_ENTRIES_MAX + 1 }, (_, i) => ({ id: `e${i}`, label: "a", body: "b" }));
    const bad = validateSheet(many);
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], new RegExp(`holds ${SHEET_ENTRIES_MAX}`));
  });

  await test("the sheets-per-semester cap ignores other kinds of page", () => {
    const sheets = Array.from({ length: SHEETS_PER_SEMESTER_MAX }, (_, i) => ({ id: `p${i}`, kind: FORMULA_KIND }));
    assert.equal(canAddSheet(sheets).ok, false);
    assert.equal(canAddSheet([...sheets.slice(1), { id: "n", kind: "text" }]).ok, true);
    // A tombstoned sheet frees its slot.
    assert.equal(canAddSheet([...sheets.slice(1), { id: "d", kind: FORMULA_KIND, deletedAt: "2026-01-01" }]).ok, true);
  });

  await test("an empty sheet says so rather than rendering nothing", () => {
    assert.equal(sheetSummary({ entries: [] }), "No entries yet");
    assert.equal(sheetSummary({}), "No entries yet");
    assert.equal(sheetSummary({ entries: [{ id: "a" }] }), "1 entry");
    assert.equal(sheetSummary({ entries: [{ id: "a" }, { id: "b" }] }), "2 entries");
  });

  /* ---------- none of this needs a merge change ---------- */

  await test("Batch 3 adds no collection, so mergeSemester's whitelist is untouched", () => {
    // Reading progress rides on textbook items, rubrics on assignments,
    // and reference sheets are pages. If this ever fails, something
    // grew a collection and the backup panel's count needs checking too.
    for (const key of ["reference", "rubrics", "readings", "sheets", "formulas"]) {
      assert.ok(!COLLECTIONS.includes(key), `${key} was added to COLLECTIONS without updating this test`);
    }
  });

  await test("a rubric survives a merge from a second device", () => {
    const at = (t) => `2026-08-1${t}T00:00:00.000Z`;
    const local = {
      meta: { updatedAt: at(1) },
      semesters: { "Semester 1": { assignments: [{ id: "a1", title: "Essay", updatedAt: at(1) }] } },
    };
    const remote = {
      meta: { updatedAt: at(2) },
      semesters: {
        "Semester 1": {
          assignments: [{ id: "a1", title: "Essay", rubric: [{ id: "c1", label: "Argument", done: true }], updatedAt: at(2) }],
        },
      },
    };
    const merged = mergeData(local, remote);
    const a = merged.semesters["Semester 1"].assignments.find((x) => x.id === "a1");
    assert.ok(a.rubric, "the rubric was dropped by the merge");
    assert.equal(rubricProgress(a.rubric).done, 1);
  });

  await test("a reference sheet survives a merge as an ordinary page", () => {
    const at = (t) => `2026-08-1${t}T00:00:00.000Z`;
    const merged = mergeData(
      { meta: { updatedAt: at(1) }, semesters: { "Semester 1": { pages: [] } } },
      {
        meta: { updatedAt: at(2) },
        semesters: {
          "Semester 1": {
            pages: [{ id: "p1", kind: FORMULA_KIND, title: "MATH2001", entries: [{ id: "e1", label: "Quadratic", body: "x = ..." }], updatedAt: at(2) }],
          },
        },
      }
    );
    const p = merged.semesters["Semester 1"].pages[0];
    assert.equal(isReferenceSheet(p), true);
    assert.equal(p.entries.length, 1);
  });

  await test("reading progress rides along on a textbook item", () => {
    const at = (t) => `2026-08-1${t}T00:00:00.000Z`;
    const merged = mergeData(
      { meta: { updatedAt: at(1) }, semesters: { "Semester 1": { textbook: [{ id: "t1", week: "3", updatedAt: at(1) }] } } },
      { meta: { updatedAt: at(2) }, semesters: { "Semester 1": { textbook: [{ id: "t1", week: "3", read: "done", readAt: "2026-08-12", updatedAt: at(2) }] } } }
    );
    const t = merged.semesters["Semester 1"].textbook[0];
    assert.equal(isRead(t), true);
    assert.equal(t.readAt, "2026-08-12");
  });

  await test("npm test still runs the Batch 3 tests", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-reference\.mjs/, "the Batch 3 tests were dropped from `npm test`");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
