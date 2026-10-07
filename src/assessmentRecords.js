/* ==================================================================
   assessmentRecords.js — one piece of work, shown in both places
   (1.3.1 item 9, RELEASE A: readers only)

   Plan → Assignments and Courses → Grades hold the same kind of thing in
   two collections. Release A changes what each screen READS and nothing
   that is stored: Plan also lists the Grades records that have a date,
   Grades also lists the Plan assignments that have no grade record, and
   the Calendar shows Grades' dates. No item is converted, merged, moved
   or re-stamped, so an older build on another device sees exactly what
   it saw before. Converting on first edit is Release B (RELEASE-1.3.2.md).

   THE ONE LINK THAT EXISTS: `assessment.assignmentId`. Nothing in the
   app has ever set it, but the workload forecast honours it and so does
   this: a linked pair is ONE record — the assignment in Plan, carrying
   the assessment's weight and mark; the assessment in Grades.

   AN UNLINKED LOOK-ALIKE IS NOT MERGED. An assignment and an assessment
   with the same course, title and date may well be the same essay, and
   that is still a guess about a student's records. Both screens show
   both rows, each labelled with where it lives. Combining them is a
   Release B decision the student makes, never this module.
   ================================================================== */

const live = (x) => x && !x.deletedAt;

/** The live assessment linked to each live assignment, by assignment id. */
export function linkedAssessments(assignments = [], assessments = []) {
  const ids = new Set((assignments || []).filter(live).map((a) => a.id));
  const out = new Map();
  for (const s of assessments || []) {
    if (live(s) && s.assignmentId && ids.has(s.assignmentId) && !out.has(s.assignmentId)) out.set(s.assignmentId, s);
  }
  return out;
}

/** Grades records Plan should list beside its assignments: dated, not an
    essay-draft placeholder, and not already shown as a linked pair. */
export function gradesRecordsForPlan(assignments = [], assessments = []) {
  const linked = new Set([...linkedAssessments(assignments, assessments).values()].map((s) => s.id));
  return (assessments || []).filter((s) => live(s) && s.due && !s.essayPlaceholder && !linked.has(s.id));
}

/** Plan assignments Grades should list, by course name ("" for none):
    every live assignment no live assessment is linked to. */
export function planRecordsForGrades(assignments = [], assessments = []) {
  const linked = linkedAssessments(assignments, assessments);
  const out = new Map();
  for (const a of assignments || []) {
    if (!live(a) || linked.has(a.id)) continue;
    const key = a.course || "";
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(a);
  }
  return out;
}

/** Grades' dated records for the Calendar, on the day they fall. */
export function gradesDatesOn(assessments = [], iso) {
  return (assessments || []).filter((s) => live(s) && s.due === iso && !s.essayPlaceholder);
}

/* The inline pointer on the calendar's add form. A HINT, never a block:
   an event has no type, so "this is an exam" can only be guessed from
   its title, and a guess must not stop a student saving "Exam review
   session". Whole words only. */
export const EXAM_LIKE = /\b(exams?|quiz(zes)?|tests?|mid-?sems?|mid-?semester|finals?)\b/i;
export const looksLikeAssessment = (title) => EXAM_LIKE.test(String(title || ""));

/* The words, in one place for Grace. */
export const RECORDS_COPY = {
  inGrades: (w) => (Number(w) > 0 ? `In Grades · ${w}%` : "In Grades"),
  marked: (m) => `marked ${m}`,
  openGrades: "Open in Grades →",
  planSection: "Also in Plan, no weight yet",
  openPlan: "Open in Plan →",
  fromGrades: "From Grades",
  calendarLine: "Exams and assessments go in Courses → Grades. Their dates show here on their own.",
  examPointer: "If this is an exam or an assessment, add it in Courses → Grades instead: its date shows here, and its weight counts towards your mark.",
  goToGrades: "Go to Grades",
};
