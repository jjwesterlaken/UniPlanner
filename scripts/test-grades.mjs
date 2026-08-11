/* Tests for Batch 2: src/grades.js and src/workload.js.

   Plain Node and `assert`, same style as the other suites. These cover
   the arithmetic a student plans their semester around — the required
   mark especially, where being confidently wrong by one point is worse
   than showing nothing at all.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GRADE_BANDS,
  bandFor,
  bandByCode,
  targetFor,
  roundFinalMark,
  isMarked,
  hurdleOf,
  summarise,
  hurdleStatus,
  requiredForBand,
  bestReachableBand,
  displayMark,
  describeRequirement,
  ROUNDING_RULES,
  DEFAULT_ROUNDING,
} from "../src/grades.js";

import {
  weekStart,
  forecastWorkload,
  buildBreakdown,
  reconcileBreakdown,
  strandedSubTasks,
  daysUntil,
  examCountdowns,
  buildStudyPlan,
  topicsForCourse,
  teachingWeek,
  weekLabel,
  inBreak,
  BREAKDOWN_TEMPLATES,
  CRUNCH_ITEM_COUNT,
} from "../src/workload.js";

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

const A = (over = {}) => ({ id: over.id || `a${Math.random().toString(36).slice(2, 7)}`, course: "BIOL1010", ...over });
const HD = bandByCode("HD").min;
const D = bandByCode("D").min;
const P = bandByCode("P").min;

async function run() {
  /* ---------- the rounding rule ---------- */

  await test("the final mark rounds half-up, so 84.5 is a High Distinction", () => {
    assert.equal(roundFinalMark(84.5), 85);
    assert.equal(roundFinalMark(84.49), 84);
    assert.equal(bandFor(84.5).code, "HD");
    assert.equal(bandFor(84.4).code, "D");
    assert.equal(bandFor(74.5).code, "D");
    assert.equal(bandFor(64.5).code, "C");
    assert.equal(bandFor(49.5).code, "P");
    assert.equal(bandFor(49.4).code, "F");
  });

  await test("the calculator targets half a mark below the band, not the band", () => {
    // Targeting 85 instead of 84.5 tells a student they need 16.7% when
    // they need 15% -- the exact failure this feature must not make.
    assert.equal(targetFor(85), 84.5);
    const marks = [A({ w: 70, mark: 80 }), A({ w: 30 })];
    const r = requiredForBand(marks, HD);
    assert.equal(r.status, "needed");
    // earned = 56; (84.5 - 56) / 30 * 100 = 95
    assert.equal(r.required, 95);
  });

  await test("displayed requirements round up, never down", () => {
    // Showing 67 when 67.3 is needed is the one error that matters.
    assert.equal(displayMark(67.3), "67.3");
    assert.equal(displayMark(67.01), "67.1");
    assert.equal(displayMark(68), "68");
    assert.equal(displayMark(0), "0");
    assert.equal(displayMark(NaN), "");
  });

  await test("band boundaries land on the right side under rounding", () => {
    for (const band of GRADE_BANDS) {
      assert.equal(bandFor(band.min).code, band.code, `${band.min} should be ${band.code}`);
      assert.equal(bandFor(band.min - 0.5).code, band.code, `${band.min - 0.5} rounds up into ${band.code}`);
      assert.notEqual(bandFor(band.min - 0.51).code, band.code, `${band.min - 0.51} should fall short`);
    }
  });

  /* ---------- the rounding rule is a setting, not an assumption ---------- */

  await test("the default rounding rule is half-up", () => {
    assert.equal(DEFAULT_ROUNDING, "half-up");
    assert.ok(ROUNDING_RULES.some((r) => r.id === "half-up"));
    assert.ok(ROUNDING_RULES.some((r) => r.id === "truncate"));
  });

  await test("switching to truncation changes what a student needs", () => {
    /* The asymmetry that makes this a setting: understating means a
       student hits exactly the number shown and misses the band. */
    const marks = [A({ w: 70, mark: 80 }), A({ w: 30 })];
    const halfUp = requiredForBand(marks, HD, "half-up");
    const truncated = requiredForBand(marks, HD, "truncate");
    assert.equal(halfUp.required, 95);
    assert.ok(truncated.required > halfUp.required, "truncation always demands at least as much");
    assert.equal(truncated.target, 85);
    assert.equal(halfUp.target, 84.5);
  });

  await test("the band boundary moves with the rule", () => {
    assert.equal(bandFor(84.5, "half-up").code, "HD");
    assert.equal(bandFor(84.5, "truncate").code, "D", "truncation keeps 84.5 as 84");
    assert.equal(bandFor(84.9, "truncate").code, "D");
    assert.equal(bandFor(85, "truncate").code, "HD");
    assert.equal(roundFinalMark(84.9, "truncate"), 84);
    assert.equal(roundFinalMark(84.9, "half-up"), 85);
  });

  await test("an unknown or missing rule falls back to the default rather than misreporting", () => {
    const marks = [A({ w: 70, mark: 80 }), A({ w: 30 })];
    assert.equal(requiredForBand(marks, HD).required, requiredForBand(marks, HD, "half-up").required);
    assert.equal(requiredForBand(marks, HD, "nonsense").required, requiredForBand(marks, HD, "half-up").required);
  });

  await test("a settled course is judged under the chosen rule too", () => {
    const marks = [A({ w: 100, mark: 84.6 })];
    assert.equal(requiredForBand(marks, HD, "half-up").achieved, true);
    assert.equal(requiredForBand(marks, HD, "truncate").achieved, false);
  });

  /* ---------- teaching weeks ---------- */

  const CAL = { start: "2026-07-27", breaks: [{ from: "2026-09-21", to: "2026-09-27" }] };

  await test("teaching weeks count from the semester start", () => {
    assert.equal(teachingWeek("2026-07-27", CAL), 1);
    assert.equal(teachingWeek("2026-08-02", CAL), 1, "the Sunday of week 1 is still week 1");
    assert.equal(teachingWeek("2026-08-03", CAL), 2);
    assert.equal(teachingWeek("2026-09-14", CAL), 8);
  });

  await test("the mid-semester break is skipped, not counted", () => {
    // Counting straight through puts everything after it a week late,
    // which is worse than a date because it looks authoritative.
    assert.equal(teachingWeek("2026-09-28", CAL), 9);
    assert.equal(teachingWeek("2026-09-28", { start: "2026-07-27" }), 10, "without the break it would be 10");
    assert.equal(teachingWeek("2026-10-05", CAL), 10);
  });

  await test("a date inside the break has no teaching week", () => {
    assert.equal(inBreak("2026-09-23", CAL.breaks), true);
    assert.equal(teachingWeek("2026-09-23", CAL), null);
    assert.equal(weekLabel("2026-09-23", CAL), "Mid-semester break");
  });

  await test("no calendar means dates, never a guessed week number", () => {
    for (const cal of [null, undefined, {}, { breaks: [] }, { start: "" }]) {
      assert.equal(teachingWeek("2026-09-14", cal), null);
      assert.match(weekLabel("2026-09-14", cal), /^Week of /);
    }
  });

  await test("a date before the semester starts has no teaching week", () => {
    assert.equal(teachingWeek("2026-07-20", CAL), null);
    assert.match(weekLabel("2026-07-20", CAL), /^Week of /);
  });

  await test("teaching weeks survive a DST change", () => {
    // AU DST starts 4 Oct 2026, inside the semester.
    assert.equal(teachingWeek("2026-10-05", CAL), 10);
    assert.equal(teachingWeek("2026-10-12", CAL), 11);
  });

  /* ---------- marked, unmarked and zero ---------- */

  await test("an unmarked assessment and one marked zero are not the same thing", () => {
    assert.equal(isMarked(A({ w: 20 })), false);
    assert.equal(isMarked(A({ w: 20, mark: 0 })), true);
    assert.equal(isMarked(A({ w: 20, mark: null })), false);
    assert.equal(isMarked(A({ w: 20, mark: "" })), false);

    const unmarked = summarise([A({ w: 50, mark: 80 }), A({ w: 50 })]);
    const zeroed = summarise([A({ w: 50, mark: 80 }), A({ w: 50, mark: 0 })]);
    assert.equal(unmarked.average, 80, "an unmarked item must not drag the average down");
    assert.equal(zeroed.average, 40, "a zero is a real mark and must count");
    assert.equal(unmarked.remainingWeight, 50);
    assert.equal(zeroed.remainingWeight, 0);
  });

  await test("nothing marked yet reads as no average rather than zero", () => {
    const s = summarise([A({ w: 40 }), A({ w: 60 })]);
    assert.equal(s.average, null, "0 would read as failing; null reads as 'not yet'");
    assert.equal(s.floor, 0);
    assert.equal(s.ceiling, 100);
  });

  /* ---------- weights that don't sum to 100 ---------- */

  await test("weights are reported, never silently normalised", () => {
    const s = summarise([A({ w: 30, mark: 90 }), A({ w: 60 })]);
    assert.equal(s.weightSum, 90, "the real sum is surfaced so the UI can say so");
    assert.equal(s.earned, 27);
    assert.equal(s.ceiling, 87, "90% of weight means 87 is the ceiling, not 100");
  });

  await test("over-weighted outlines still produce sane arithmetic", () => {
    const s = summarise([A({ w: 60, mark: 100 }), A({ w: 60 })]);
    assert.equal(s.weightSum, 120);
    assert.equal(s.earned, 60);
    assert.equal(s.ceiling, 120);
  });

  await test("zero and negative weights are ignored rather than dividing by zero", () => {
    const s = summarise([A({ w: 0, mark: 90 }), A({ w: -10, mark: 50 }), A({ w: 50, mark: 60 })]);
    assert.equal(s.count, 1);
    assert.equal(s.weightSum, 50);
    assert.equal(s.average, 60);
  });

  /* ---------- impossible and already achieved ---------- */

  await test("an unreachable grade says so, with the best still possible", () => {
    const r = requiredForBand([A({ w: 70, mark: 40 }), A({ w: 30 })], HD);
    assert.equal(r.status, "impossible");
    assert.equal(r.ceiling, 58);
    assert.equal(r.bestBand.code, "P");
    assert.match(describeRequirement(r, "High Distinction"), /isn't reachable/);
    assert.ok(!/\d{3,}%/.test(describeRequirement(r, "High Distinction")), "must not print an absurd percentage");
  });

  await test("an already secured grade says so rather than showing a negative", () => {
    const r = requiredForBand([A({ w: 80, mark: 95 }), A({ w: 20 })], P);
    assert.equal(r.status, "achieved");
    assert.match(describeRequirement(r, "Pass"), /already secured/);
    assert.ok(!/-/.test(describeRequirement(r, "Pass")), "no negative percentage");
  });

  await test("with everything marked the answer is the final mark, not a requirement", () => {
    const r = requiredForBand([A({ w: 50, mark: 70 }), A({ w: 50, mark: 80 })], HD);
    assert.equal(r.status, "settled");
    assert.equal(r.required, null);
    assert.equal(r.finalMark, 75);
    assert.equal(r.achieved, false);
    assert.match(describeRequirement(r, "High Distinction"), /Everything is marked/);

    const passed_ = requiredForBand([A({ w: 100, mark: 76 })], D);
    assert.equal(passed_.achieved, true);
  });

  /* ---------- one assessment left versus several ---------- */

  await test("one assessment left names it; several report a required average", () => {
    const single = requiredForBand([A({ w: 60, mark: 70 }), A({ w: 40, title: "Final exam" })], D);
    assert.equal(single.remainingCount, 1);
    assert.equal(single.single.title, "Final exam");
    // earned 42; (74.5 - 42) / 40 * 100 = 81.25
    assert.equal(single.required, 81.25);
    assert.match(describeRequirement(single, "Distinction"), /You need 81\.3% on Final exam/);

    const many = requiredForBand([A({ w: 40, mark: 70 }), A({ w: 30 }), A({ w: 30 })], D);
    assert.equal(many.remainingCount, 2);
    assert.equal(many.single, null, "with several left there is no single assessment to name");
    // earned 28; (74.5 - 28) / 60 * 100 = 77.5
    assert.equal(many.required, 77.5);
    const sentence = describeRequirement(many, "Distinction");
    assert.match(sentence, /average 77\.5% across your 2 remaining assessments/);
  });

  await test("a course with no assessments at all doesn't throw", () => {
    for (const input of [[], null, undefined]) {
      const s = summarise(input);
      assert.equal(s.count, 0);
      assert.equal(s.average, null);
      const r = requiredForBand(input, HD);
      assert.equal(r.status, "settled");
      assert.equal(typeof describeRequirement(r, "High Distinction"), "string");
    }
  });

  /* ---------- hurdles ---------- */

  await test("a hurdle is a threshold, not a flag, so 40 and 45 both work", () => {
    assert.equal(hurdleOf(A({ hurdle: 45 })), 45);
    assert.equal(hurdleOf(A({ hurdle: 40 })), 40);
    assert.equal(hurdleOf(A({})), null);
    assert.equal(hurdleOf(A({ hurdle: 0 })), null);
    assert.equal(hurdleOf(A({ hurdle: true })), null, "a boolean is not a threshold");
  });

  await test("a failed hurdle is reported even when the weighted mark is fine", () => {
    const status = hurdleStatus([A({ w: 50, mark: 90 }), A({ w: 50, mark: 42, hurdle: 45, title: "Final exam" })]);
    assert.equal(status.anyFailed, true);
    assert.equal(status.failed[0].title, "Final exam");
    assert.equal(status.failed[0].min, 45);
  });

  await test("a hurdle that demands more than the grade sets the headline number", () => {
    // Needs only 20% for a Pass, but the exam hurdle is 45%.
    const r = requiredForBand([A({ w: 60, mark: 65 }), A({ w: 40, title: "Final exam", hurdle: 45 })], P);
    assert.equal(r.status, "needed");
    assert.ok(r.required < 45, `grade alone needs ${r.required}%`);
    assert.equal(r.effectiveRequired, 45);
    assert.equal(r.hurdleBinds, true);
    assert.match(describeRequirement(r, "Pass"), /45% on Final exam.*hurdle, rather than the grade/);
  });

  await test("a pending hurdle across several remaining assessments doesn't distort the average", () => {
    // With more than one left, the required average says nothing about
    // whether any individual hurdle is met -- so it must not be raised.
    const r = requiredForBand([A({ w: 40, mark: 70 }), A({ w: 30, hurdle: 45 }), A({ w: 30 })], P);
    assert.equal(r.hurdleBinds, false, "a hurdle can't bind an average spread across several assessments");
    assert.equal(r.effectiveRequired, r.required);
    assert.equal(r.hurdles.pending.length, 1, "but it is still reported as pending");
  });

  await test("bestReachableBand accounts for weight already lost", () => {
    assert.equal(bestReachableBand([A({ w: 50, mark: 100 }), A({ w: 50 })]).code, "HD");
    assert.equal(bestReachableBand([A({ w: 50, mark: 30 }), A({ w: 50 })]).code, "C");
  });

  /* ---------- deleted assessments ---------- */

  await test("a tombstoned assessment is excluded from every calculation", () => {
    const live = [A({ w: 50, mark: 80 }), A({ w: 50, mark: 40, deletedAt: "2026-08-01T00:00:00.000Z" })];
    const s = summarise(live);
    assert.equal(s.count, 1);
    assert.equal(s.average, 80);
    assert.equal(hurdleStatus([A({ w: 50, mark: 10, hurdle: 50, deletedAt: "x" })]).anyFailed, false);
  });

  /* ---------- workload forecast ---------- */

  await test("a week with three deadlines is flagged as a crunch", () => {
    const weeks = forecastWorkload({
      assignments: [
        { id: "1", title: "Essay", due: "2026-09-09" },
        { id: "2", title: "Quiz", due: "2026-09-10" },
        { id: "3", title: "Prac", due: "2026-09-11" },
        { id: "4", title: "Later", due: "2026-09-25" },
      ],
      today: "2026-09-01",
    });
    const crunch = weeks.filter((w) => w.crunch);
    assert.equal(crunch.length, 1);
    assert.equal(crunch[0].items.length, CRUNCH_ITEM_COUNT);
    assert.equal(crunch[0].weekStart, "2026-09-07", "grouped by the Monday of that week");
  });

  await test("one heavy assessment counts as a crunch even alone", () => {
    const weeks = forecastWorkload({
      assessments: [{ id: "e", kind: "exam", title: "Final", w: 50, due: "2026-11-12" }],
      today: "2026-11-01",
      weeks: 4,
    });
    assert.equal(weeks.find((w) => w.items.length === 1).crunch, true);
  });

  await test("an assessment linked to an assignment is one deadline, not two", () => {
    const weeks = forecastWorkload({
      assignments: [{ id: "as1", title: "Essay", due: "2026-09-09" }],
      assessments: [{ id: "x1", title: "Essay", w: 30, due: "2026-09-09", assignmentId: "as1" }],
      today: "2026-09-01",
    });
    const all = weeks.flatMap((w) => w.items);
    assert.equal(all.length, 1, "the linked pair is the same real deadline");
    assert.equal(all[0].weight, 30, "and the weight comes across onto it");
  });

  await test("overdue deadlines are kept and marked, not hidden", () => {
    const weeks = forecastWorkload({
      assignments: [{ id: "1", title: "Late essay", due: "2026-08-20" }],
      today: "2026-09-01",
    });
    const item = weeks.flatMap((w) => w.items).find((i) => i.id === "1");
    assert.ok(item, "an overdue assignment is the most important thing on the page");
    assert.equal(item.overdue, true);
  });

  await test("the forecast is empty, not broken, with nothing to forecast", () => {
    assert.deepEqual(forecastWorkload({ today: "2026-09-01" }), []);
    assert.deepEqual(forecastWorkload({ assignments: [{ id: "1", title: "No date" }], today: "2026-09-01" }), []);
  });

  await test("weekStart is stable across a DST change and a year end", () => {
    assert.equal(weekStart("2026-04-05"), "2026-03-30"); // AU DST ends 5 Apr 2026
    assert.equal(weekStart("2026-10-04"), "2026-09-28"); // AU DST starts 4 Oct 2026
    assert.equal(weekStart("2027-01-01"), "2026-12-28");
    assert.equal(weekStart("2026-09-07"), "2026-09-07", "a Monday is its own week start");
    assert.equal(weekStart("2026-09-13"), "2026-09-07", "a Sunday belongs to the week before");
  });

  /* ---------- assignment breakdown ---------- */

  await test("a breakdown lands every step between today and the due date", () => {
    const slots = buildBreakdown({
      assignment: { id: "as1", title: "Essay", course: "BIOL1010", due: "2026-09-30" },
      today: "2026-09-01",
    });
    assert.equal(slots.length, 4);
    for (const s of slots) {
      assert.ok(s.due >= "2026-09-01", `${s.due} is before today`);
      assert.ok(s.due <= "2026-09-30", `${s.due} is after the due date`);
    }
    assert.equal(slots[0].due, "2026-09-01");
    assert.equal(slots[3].due, "2026-09-30");
    assert.equal(slots[0].parentId, "as1");
    assert.equal(slots[0].course, "BIOL1010");
  });

  await test("a breakdown made the night before compresses instead of dating things in the past", () => {
    const slots = buildBreakdown({
      assignment: { id: "as1", title: "Essay", due: "2026-09-02" },
      today: "2026-09-01",
    });
    assert.equal(slots.length, 4);
    for (const s of slots) assert.ok(s.due >= "2026-09-01" && s.due <= "2026-09-02", `${s.due} out of range`);
  });

  await test("a breakdown for an already-overdue assignment still produces a plan", () => {
    const slots = buildBreakdown({ assignment: { id: "as1", title: "Essay", due: "2026-08-01" }, today: "2026-09-01" });
    assert.equal(slots.length, 4);
    for (const s of slots) assert.equal(s.due, "2026-08-01", "everything collapses onto the due date");
  });

  await test("every breakdown template produces ordered, in-range dates", () => {
    for (const t of BREAKDOWN_TEMPLATES) {
      const slots = buildBreakdown({
        assignment: { id: "a", title: "X", due: "2026-10-01" },
        templateId: t.id,
        today: "2026-09-01",
      });
      assert.equal(slots.length, t.steps.length, `${t.id} lost a step`);
      for (let i = 1; i < slots.length; i++) {
        assert.ok(slots[i].due >= slots[i - 1].due, `${t.id} step ${i} goes backwards`);
      }
    }
  });

  await test("an assignment with no due date produces no breakdown", () => {
    assert.deepEqual(buildBreakdown({ assignment: { id: "a", title: "X" }, today: "2026-09-01" }), []);
    assert.deepEqual(buildBreakdown({ today: "2026-09-01" }), []);
  });

  /* ---------- regeneration ---------- */

  const slotsFor = (due = "2026-09-30") =>
    buildBreakdown({ assignment: { id: "as1", title: "Essay", due }, today: "2026-09-01" });

  await test("regenerating updates untouched sub-tasks in place", () => {
    const existing = [{ id: "t0", parentId: "as1", gen: "essay", slot: 0, text: "old", due: "2026-09-05" }];
    const plan = reconcileBreakdown({ slots: slotsFor(), existing, parentId: "as1" });
    assert.equal(plan.create.length, 3, "the missing slots are created");
    assert.equal(plan.update.length, 1);
    assert.equal(plan.update[0].id, "t0");
    assert.equal(plan.update[0].patch.due, "2026-09-01");
  });

  await test("regenerating never rewrites a sub-task the user edited", () => {
    const existing = [
      { id: "t0", parentId: "as1", gen: "essay", slot: 0, text: "my own wording", due: "2026-09-20", edited: true },
    ];
    const plan = reconcileBreakdown({ slots: slotsFor(), existing, parentId: "as1" });
    assert.equal(plan.update.length, 0, "an edited sub-task must not be updated");
    assert.equal(plan.keep.length, 1);
    assert.equal(plan.keep[0].todo.id, "t0");
  });

  await test("regenerating never resurrects a completed sub-task as unfinished", () => {
    const existing = [{ id: "t0", parentId: "as1", gen: "essay", slot: 0, text: "done thing", due: "2026-09-02", done: true }];
    const plan = reconcileBreakdown({ slots: slotsFor(), existing, parentId: "as1" });
    assert.equal(plan.update.length, 0);
    assert.equal(plan.keep[0].todo.done, true);
  });

  await test("a slot dropped from the new shape is tombstoned, never hard deleted", () => {
    const existing = [
      { id: "t9", parentId: "as1", gen: "essay", slot: 9, text: "orphan", due: "2026-09-10" },
      { id: "t8", parentId: "as1", gen: "essay", slot: 8, text: "edited orphan", due: "2026-09-10", edited: true },
    ];
    const plan = reconcileBreakdown({ slots: slotsFor(), existing, parentId: "as1" });
    assert.deepEqual(plan.tombstone, ["t9"], "untouched orphans go");
    assert.ok(plan.keep.some((k) => k.todo.id === "t8"), "edited orphans stay");
  });

  await test("todos the user made themselves are invisible to regeneration", () => {
    const existing = [
      { id: "mine", parentId: "as1", text: "my own todo", due: "2026-09-15" }, // no `gen`
      { id: "other", parentId: "as2", gen: "essay", slot: 0, text: "another assignment's" },
    ];
    const plan = reconcileBreakdown({ slots: slotsFor(), existing, parentId: "as1" });
    assert.equal(plan.tombstone.length, 0);
    assert.ok(!plan.update.some((u) => u.id === "mine"));
    assert.ok(!plan.keep.some((k) => k.todo.id === "other"), "another assignment's sub-tasks are not ours");
  });

  /* ---------- stranded sub-tasks ---------- */

  await test("moving a due date earlier strands a sub-task, and it is reported not rewritten", () => {
    const assignment = { id: "as1", title: "Essay", due: "2026-09-10" };
    const todos = [
      { id: "t1", parentId: "as1", text: "Revise", due: "2026-09-25", edited: true },
      { id: "t2", parentId: "as1", text: "Draft", due: "2026-09-05" },
    ];
    const stranded = strandedSubTasks({ assignment, todos, today: "2026-09-01" });
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].id, "t1");
    assert.equal(stranded[0].daysLate, 15);
    assert.equal(stranded[0].edited, true, "the UI offers a reset; it must not act on its own");
    // The function reports only -- the todo is untouched.
    assert.equal(todos[0].due, "2026-09-25");
  });

  await test("nothing is stranded when every sub-task sits before the due date", () => {
    const stranded = strandedSubTasks({
      assignment: { id: "as1", due: "2026-09-30" },
      todos: [{ id: "t1", parentId: "as1", due: "2026-09-20" }],
      today: "2026-09-01",
    });
    assert.deepEqual(stranded, []);
  });

  /* ---------- exams ---------- */

  await test("countdowns are local dates, so they flip at local midnight", () => {
    assert.equal(daysUntil("2026-11-12", "2026-11-01"), 11);
    assert.equal(daysUntil("2026-11-12", "2026-11-12"), 0);
    assert.equal(daysUntil("2026-11-12", "2026-11-13"), -1);
    // Across the AU DST change, a day is still a day.
    assert.equal(daysUntil("2026-10-05", "2026-10-03"), 2);
    assert.equal(daysUntil("2026-04-06", "2026-04-04"), 2);
  });

  await test("a past exam reads as past rather than a negative countdown", () => {
    const [past, today_, future] = examCountdowns(
      [
        { id: "1", kind: "exam", title: "Mid", due: "2026-08-01" },
        { id: "2", kind: "exam", title: "Today", due: "2026-09-01" },
        { id: "3", kind: "exam", title: "Final", due: "2026-11-12" },
      ],
      "2026-09-01"
    );
    assert.equal(past.past, true);
    assert.equal(past.days, -31);
    assert.equal(today_.today, true);
    assert.equal(today_.days, 0);
    assert.equal(future.past, false);
    assert.equal(future.days, 72);
  });

  await test("only exams appear in the countdown", () => {
    const list = examCountdowns(
      [
        { id: "1", kind: "exam", title: "Final", due: "2026-11-12" },
        { id: "2", kind: "assignment", title: "Essay", due: "2026-09-10" },
        { id: "3", kind: "exam", title: "Deleted", due: "2026-11-13", deletedAt: "x" },
      ],
      "2026-09-01"
    );
    assert.deepEqual(list.map((e) => e.title), ["Final"]);
  });

  /* ---------- study plan ---------- */

  await test("a study plan deals topics round-robin and reserves the last day for review", () => {
    const plan = buildStudyPlan({
      exam: { due: "2026-09-08" },
      topics: ["Osmosis", "Mitosis", "Enzymes"],
      today: "2026-09-01",
    });
    assert.equal(plan.length, 7, "one session per day up to the exam, never on the day itself");
    assert.deepEqual(plan.slice(0, 3).map((p) => p.topic), ["Osmosis", "Mitosis", "Enzymes"]);
    assert.equal(plan[plan.length - 1].topic, "Review everything");
    assert.equal(plan[plan.length - 1].day, "2026-09-07");
  });

  await test("the same inputs always produce the same plan", () => {
    const args = { exam: { due: "2026-09-20" }, topics: ["A", "B", "C"], today: "2026-09-01" };
    assert.deepEqual(buildStudyPlan(args), buildStudyPlan(args), "deterministic: no AI, no randomness");
  });

  await test("an exam today or in the past has nothing left to plan", () => {
    assert.deepEqual(buildStudyPlan({ exam: { due: "2026-09-01" }, topics: ["A"], today: "2026-09-01" }), []);
    assert.deepEqual(buildStudyPlan({ exam: { due: "2026-08-01" }, topics: ["A"], today: "2026-09-01" }), []);
  });

  await test("a course with no topics produces no plan rather than empty sessions", () => {
    assert.deepEqual(buildStudyPlan({ exam: { due: "2026-09-20" }, topics: [], today: "2026-09-01" }), []);
    assert.deepEqual(buildStudyPlan({ exam: { due: "2026-09-20" }, topics: ["  ", ""], today: "2026-09-01" }), []);
  });

  await test("more topics than days still covers as many as fit", () => {
    const plan = buildStudyPlan({
      exam: { due: "2026-09-03" },
      topics: ["A", "B", "C", "D", "E"],
      today: "2026-09-01",
    });
    assert.equal(plan.length, 2);
    assert.deepEqual(plan.map((p) => p.topic), ["A", "B"]);
  });

  await test("topics come from existing study cards, in week order and deduplicated", () => {
    const notes = [
      { id: "1", course: "BIOL1010", week: "3", term: "Enzymes" },
      { id: "2", course: "BIOL1010", week: "1", term: "Osmosis" },
      { id: "3", course: "BIOL1010", week: "2", term: "Osmosis" },
      { id: "4", course: "CHEM1010", week: "1", term: "Bonding" },
      { id: "5", course: "BIOL1010", week: "4", term: "Deleted", deletedAt: "x" },
    ];
    assert.deepEqual(topicsForCourse(notes, "BIOL1010"), ["Osmosis", "Enzymes"]);
    assert.deepEqual(topicsForCourse(notes, "NOPE"), []);
    assert.deepEqual(topicsForCourse(null, "BIOL1010"), []);
  });

  /* ---------- storage and sync ---------- */

  await test("assessments sync like any other collection", () => {
    assert.ok(COLLECTIONS.includes("assessments"), "a collection missing from COLLECTIONS is dropped on every sync");
    const sem = (assessments) => {
      const s = {};
      for (const k of COLLECTIONS) s[k] = [];
      return { ...s, assessments };
    };
    const mine = [{ id: "x1", course: "BIOL1010", w: 30, mark: 72, updatedAt: "2026-08-11T09:00:00.000Z" }];
    const merged = mergeData(
      { semesters: { "Semester 1": sem(mine) }, meta: { updatedAt: "2026-08-11T09:00:00.000Z" } },
      { semesters: { "Semester 1": sem([]) }, meta: { updatedAt: "2026-08-10T00:00:00.000Z" } }
    );
    assert.equal(merged.semesters["Semester 1"].assessments.length, 1);
    assert.equal(merged.semesters["Semester 1"].assessments[0].mark, 72);
  });

  await test("two devices editing different assessments both survive a merge", () => {
    const sem = (assessments) => {
      const s = {};
      for (const k of COLLECTIONS) s[k] = [];
      return { ...s, assessments };
    };
    const a = [{ id: "x1", w: 30, mark: 70, updatedAt: "2026-08-11T09:00:00.000Z" }];
    const b = [{ id: "x2", w: 70, mark: 80, updatedAt: "2026-08-11T10:00:00.000Z" }];
    const merged = mergeData(
      { semesters: { "Semester 1": sem(a) }, meta: { updatedAt: "2026-08-11T09:00:00.000Z" } },
      { semesters: { "Semester 1": sem(b) }, meta: { updatedAt: "2026-08-11T10:00:00.000Z" } }
    );
    assert.equal(merged.semesters["Semester 1"].assessments.length, 2);
  });

  await test("assessments count as the user's own items in the backup total", () => {
    // Unlike studyStats, the student typed these weights -- they are
    // content, not bookkeeping, so the backup panel must count them.
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const countable = src.match(/const COUNTABLE = COLLECTIONS\.filter\(\(k\) => [^)]*\)/);
    assert.ok(countable, "could not find the COUNTABLE list");
    assert.ok(!/assessments/.test(countable[0]), "assessments must not be excluded from the item count");
    assert.match(countable[0], /studyStats/, "studyStats should still be excluded");
  });

  await test("the settings row is bookkeeping, not content, in the backup count", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const countable = src.match(/const COUNTABLE = COLLECTIONS\.filter\([^;]*\);/)[0];
    assert.match(countable, /settings/, "a semester's own config is not one of the user's items");
    assert.ok(COLLECTIONS.includes("settings"), "but it still has to sync");
  });

  await test("a new semester starts with an empty assessments list", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const maker = src.match(/const makeSemester = \(\) => \(\{[^}]*\}\);/s);
    assert.ok(maker, "could not find makeSemester");
    assert.match(maker[0], /assessments: \[\]/, "a missing default leaves the UI reading undefined");
  });

  await test("every Batch 2 write goes through updateSem, so updatedAt is always bumped", () => {
    /* A source-level invariant: the sync tests above pass whether or not
       the UI stamps updatedAt, because they construct items by hand. An
       item saved without a bumped updatedAt syncs as stale and silently
       loses to an older copy on another device. */
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    for (const call of src.matchAll(/(addItem|patchItem|removeItem)\("assessments"/g)) {
      assert.ok(call, "unreachable");
    }
    // addItem/patchItem/removeItem all stamp updatedAt themselves; what
    // must never appear is a direct splice into the collection.
    assert.ok(
      !/semesters\[[^\]]*\]\.assessments\s*=/.test(src),
      "assessments must only be written through updateSem's helpers"
    );
    assert.ok(
      !/\bsem\.assessments\.push\(/.test(src),
      "a direct push bypasses updatedAt and the item would sync as stale"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
