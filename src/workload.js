/* ==================================================================
   workload.js — deadlines, sub-task breakdowns and exam study plans

   Pure functions over dates the app already stores. Nothing here is
   persisted except the sub-tasks buildBreakdown proposes; the workload
   forecast, the exam countdown and the study plan are all recomputed on
   render, which is what keeps three of Batch 2's four features free of
   any regeneration problem at all.

   Dates are local YYYY-MM-DD throughout, reusing srs.js's helpers rather
   than writing a second set of date maths — those are already tested
   across DST boundaries and year ends.
   ================================================================== */

import { localDay, addDays, daysBetween } from "./srs.js";

/* ---------- weeks ----------

   Crunch points are grouped by calendar week, labelled by their Monday.

   Not by semester week number: that would need a stored semester start
   date, which is new data this batch is meant to avoid, and a wrong
   start date would mislabel every deadline in the app. "The week of
   8 Sep" is unambiguous without it.
   ---------------------------------------------------------------- */

/** The Monday of the week containing `day`, as YYYY-MM-DD. */
export function weekStart(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0); // noon: DST can't shift the date
  const dow = (dt.getDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

/** Items due in the same week as `day`, inclusive of both ends. */
export const sameWeek = (a, b) => weekStart(a) === weekStart(b);

/* ---------- workload forecast ---------- */

export const CRUNCH_ITEM_COUNT = 3; // three things in one week is the point of the feature
export const CRUNCH_WEIGHT = 40; // ...or a lot of the grade landing at once

/**
 * Deadlines grouped into weeks, with the busy ones flagged.
 *
 * Takes assignments and assessments together: an assessment may have a
 * due date without a matching assignment (the final exam, typically),
 * and an assignment may exist without a weight. Both count as things
 * due.
 *
 * `weeks` limits how far ahead to look. Past-due items are kept and
 * marked rather than hidden — an overdue assignment is the most
 * important thing on the page.
 */
export function forecastWorkload({ assignments = [], assessments = [], today = localDay(), weeks = 6 } = {}) {
  const horizon = addDays(weekStart(today), weeks * 7 - 1);
  const items = [];

  for (const a of assignments) {
    if (!a || a.deletedAt || !a.due) continue;
    items.push({
      id: a.id,
      kind: "assignment",
      title: a.title || "Untitled",
      course: a.course || "",
      due: a.due,
      weight: null,
    });
  }
  for (const a of assessments) {
    if (!a || a.deletedAt || !a.due) continue;
    // An assessment linked to an assignment is the same real-world thing;
    // counting both would double every deadline the student tracks properly.
    if (a.assignmentId && assignments.some((x) => x && x.id === a.assignmentId && !x.deletedAt)) {
      const existing = items.find((i) => i.id === a.assignmentId);
      if (existing) existing.weight = Number(a.w) || null;
      continue;
    }
    items.push({
      id: a.id,
      kind: a.kind === "exam" ? "exam" : "assessment",
      title: a.title || "Untitled",
      course: a.course || "",
      due: a.due,
      weight: Number(a.w) || null,
    });
  }

  const byWeek = new Map();
  for (const item of items) {
    if (item.due > horizon) continue;
    const start = weekStart(item.due);
    if (!byWeek.has(start)) byWeek.set(start, []);
    byWeek.get(start).push({ ...item, overdue: item.due < today });
  }

  const out = [];
  for (const [start, weekItems] of [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const totalWeight = weekItems.reduce((sum, i) => sum + (i.weight || 0), 0);
    out.push({
      weekStart: start,
      items: weekItems.sort((a, b) => (a.due < b.due ? -1 : 1)),
      totalWeight,
      // Either measure alone misses a real crunch: three small things in
      // one week hurts, and so does one 50% exam next to a 20% report.
      crunch: weekItems.length >= CRUNCH_ITEM_COUNT || totalWeight >= CRUNCH_WEIGHT,
      isPast: start < weekStart(today),
    });
  }
  return out;
}

/* ---------- assignment breakdown ---------- */

/* Shapes offered for breaking an assignment down. `offset` is a
   fraction of the time between starting and the due date, so the same
   template compresses sensibly whether there are three weeks or three
   days. */
export const BREAKDOWN_TEMPLATES = [
  {
    id: "essay",
    label: "Essay or report",
    steps: [
      { text: "Research and gather sources", at: 0.0 },
      { text: "Write first draft", at: 0.45 },
      { text: "Revise and edit", at: 0.75 },
      { text: "Final check and submit", at: 1.0 },
    ],
  },
  {
    id: "project",
    label: "Project or prac",
    steps: [
      { text: "Plan and scope", at: 0.0 },
      { text: "Build the main work", at: 0.35 },
      { text: "Test and refine", at: 0.7 },
      { text: "Write up and submit", at: 1.0 },
    ],
  },
  {
    id: "presentation",
    label: "Presentation",
    steps: [
      { text: "Research and outline", at: 0.0 },
      { text: "Make slides", at: 0.4 },
      { text: "Rehearse", at: 0.75 },
      { text: "Present", at: 1.0 },
    ],
  },
];

export const templateById = (id) => BREAKDOWN_TEMPLATES.find((t) => t.id === id) || BREAKDOWN_TEMPLATES[0];

/**
 * Sub-task slots for an assignment: what the generated todos should say
 * and when they should fall.
 *
 * Every date lands between today and the due date inclusive, so a
 * breakdown created the night before produces four things due today
 * rather than four dates in the past. Nothing is written here — this
 * returns the shape, and reconcileBreakdown decides what to do with it.
 */
export function buildBreakdown({ assignment, templateId = "essay", today = localDay() } = {}) {
  if (!assignment || !assignment.due) return [];
  const template = templateById(templateId);
  const due = assignment.due;
  // A due date in the past still gets a plan: the work isn't done, and
  // dating it today is more useful than refusing.
  const start = due < today ? due : today;
  const span = Math.max(0, daysBetween(start, due));

  return template.steps.map((step, index) => ({
    slot: index,
    gen: template.id,
    parentId: assignment.id,
    course: assignment.course || "",
    text: `${assignment.title || "Assignment"}: ${step.text}`,
    due: addDays(start, Math.round(span * step.at)),
  }));
}

/**
 * Decides what to create, update, leave and tombstone when a breakdown
 * is (re)generated.
 *
 * The rule that earns trust: anything the user has touched is never
 * rewritten. A generated todo carries `gen`, `parentId` and `slot`; once
 * the user edits or completes it, `edited` is set and this function only
 * ever reports it, never changes it. Todos the user made themselves have
 * no `gen` and are invisible here.
 *
 * Returns plans rather than performing writes so the caller does the
 * updateSem work and the decision stays testable.
 */
export function reconcileBreakdown({ slots = [], existing = [], parentId } = {}) {
  const mine = (existing || []).filter((t) => t && t.parentId === parentId && t.gen && !t.deletedAt);
  const create = [];
  const update = [];
  const keep = [];
  const tombstone = [];

  const bySlot = new Map();
  for (const t of mine) bySlot.set(t.slot, t);

  for (const slot of slots) {
    const current = bySlot.get(slot.slot);
    if (!current) {
      create.push(slot);
      continue;
    }
    if (current.edited || current.done) {
      // Touched by the user. Left exactly as it is -- including a
      // completed one, which must never be resurrected as unfinished.
      keep.push({ todo: current, slot });
      continue;
    }
    update.push({ id: current.id, patch: { text: slot.text, due: slot.due, course: slot.course } });
  }

  const slotNumbers = new Set(slots.map((s) => s.slot));
  for (const t of mine) {
    if (slotNumbers.has(t.slot)) continue;
    // Dropped from the new shape. Tombstoned only if untouched; an
    // edited one stays, because the user put something there.
    if (t.edited || t.done) keep.push({ todo: t, slot: null });
    else tombstone.push(t.id);
  }

  return { create, update, keep, tombstone };
}

/**
 * Sub-tasks that have drifted outside the assignment's window.
 *
 * Moving an assignment's due date earlier can strand an edited sub-task
 * after it. Rewriting it would break the promise that edits are
 * respected, so this only reports the problem; the UI offers a reset to
 * the template date and the user chooses.
 */
export function strandedSubTasks({ assignment, todos = [], today = localDay() } = {}) {
  if (!assignment || !assignment.due) return [];
  return (todos || [])
    .filter((t) => t && !t.deletedAt && t.parentId === assignment.id && t.due)
    .filter((t) => t.due > assignment.due)
    .map((t) => ({
      id: t.id,
      text: t.text,
      due: t.due,
      dueBy: assignment.due,
      daysLate: daysBetween(assignment.due, t.due),
      // Only edited ones are a dilemma; an untouched one is simply stale
      // and regenerating fixes it.
      edited: Boolean(t.edited || t.done),
    }));
}

/* ---------- exams ---------- */

/** Days until an exam, negative once it's past. Local dates, so it flips at local midnight. */
export const daysUntil = (day, today = localDay()) => daysBetween(today, day);

/** Assessments that are exams, soonest first, with their countdown. */
export function examCountdowns(assessments = [], today = localDay()) {
  return (assessments || [])
    .filter((a) => a && !a.deletedAt && a.kind === "exam" && a.due)
    .map((a) => ({
      id: a.id,
      title: a.title || "Exam",
      course: a.course || "",
      due: a.due,
      w: Number(a.w) || null,
      days: daysUntil(a.due, today),
      past: a.due < today,
      today: a.due === today,
    }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
}

/**
 * A study plan: topics spread across the days before an exam.
 *
 * Derived, never stored. It's a function of the exam date, today and
 * the course's topics — all of which are already saved — so persisting
 * it would only create something to go stale. The UI can push the
 * sessions into the calendar as ordinary events if the user wants them
 * there, and those are then the user's own.
 *
 * Deterministic: same inputs, same plan, no AI and no randomness.
 * Topics are dealt round-robin so every topic gets a turn before any
 * gets a second, and the last day before the exam is left for review.
 */
export function buildStudyPlan({ exam, topics = [], today = localDay(), maxSessions = 14 } = {}) {
  if (!exam || !exam.due) return [];
  const days = daysUntil(exam.due, today);
  if (days <= 0) return []; // exam today or past: nothing left to plan
  const clean = [...new Set((topics || []).map((t) => String(t || "").trim()).filter(Boolean))];
  if (clean.length === 0) return [];

  // One session per day, capped, and never on the exam day itself.
  const slots = Math.min(days, maxSessions);
  /* The last day goes to review only when there was time to reach every
     topic at least once. With five topics and two days, spending one of
     them "reviewing" what was never studied is worse than covering a
     second topic. */
  const reserveReview = slots > clean.length;
  const plan = [];
  for (let i = 0; i < slots; i++) {
    const day = addDays(today, i);
    const isLastDay = i === slots - 1 && reserveReview;
    plan.push({
      day,
      daysBefore: daysUntil(exam.due, day),
      topic: isLastDay ? "Review everything" : clean[i % clean.length],
      review: isLastDay,
    });
  }
  return plan;
}

/**
 * Topics for a course, taken from the study cards already saved.
 *
 * No new data: a card's `term` is the topic and `week` orders them.
 */
export function topicsForCourse(notes = [], course = "") {
  const wanted = (notes || []).filter((n) => n && !n.deletedAt && (n.course || "") === course && n.term);
  const seen = new Set();
  const out = [];
  for (const n of wanted.sort((a, b) => (Number(a.week) || 0) - (Number(b.week) || 0))) {
    const term = String(n.term).trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}
