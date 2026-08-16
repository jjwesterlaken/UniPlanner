/* ==================================================================
   reference.js — Batch 3: reading progress, rubrics, reference sheets

   Pure functions, no React and no browser globals, so
   scripts/test-reference.mjs can exercise the caps and the arithmetic
   directly. All three features store user-typed text in the one synced
   blob, which is why the caps are here and tested rather than being
   `maxLength` attributes scattered through the UI.

   THE ENFORCEMENT RULE, which is not negotiable:

   Nothing is ever silently truncated. `maxLength` on an input looks
   harmless and isn't — in most browsers it quietly cuts a paste, so a
   student who pastes a rubric from a unit outline loses the end of it
   and is never told. Instead the text is accepted in full, the counter
   goes red, and Save is blocked with a message naming the overage. The
   user decides what to cut, because it is their coursework.
   ================================================================== */

/* ---------- the caps ----------

   Chosen so the SUM of every maximum fits the allowance below. Raising
   one without redoing that arithmetic fails a test, on purpose. */

export const RUBRIC_LABEL_MAX = 140;
export const RUBRIC_NOTE_MAX = 200;
export const RUBRIC_CRITERIA_MAX = 12;
export const RUBRICS_PER_SEMESTER_MAX = 20;

export const ENTRY_LABEL_MAX = 80;
export const ENTRY_BODY_MAX = 300;
export const SHEET_ENTRIES_MAX = 30;
export const SHEETS_PER_SEMESTER_MAX = 6;

/* ---------- the budget arithmetic, written out ----------

   These constants exist so the allowance below is derived rather than
   asserted. A number someone picked and a number someone computed look
   identical in a diff; only one of them fails when the inputs change. */

/* The working budget (CLAUDE.md). Bounded by localStorage, not by
   Postgres or anything on the Supabase side. */
export const BLOB_BUDGET_BYTES = 1024 * 1024;

/* Measured, not estimated: a realistic populated two-semester account
   before Batch 3. */
export const MEASURED_EXISTING_BYTES = 583 * 1024;

/* The same account measured again after Batch 3 landed (CLAUDE.md,
   migration 0005's header). Used by the archive budget arithmetic in
   test-archive.mjs: the year a student is LIVING in costs this much,
   and archived years must fit in what remains. */
export const MEASURED_POST_BATCH3_BYTES = 672 * 1024;

/* The planner has no semester lifecycle — nothing archives, prunes or
   clears — so a student in second year fills the same two buckets again
   with first year's content still in them.

   This is the honest, uncomfortable part: at a reuse factor of 2 the
   budget is ALREADY breached before Batch 3 adds anything, which is why
   the allowance below is a share of the year-one headroom rather than
   all of it. The rest is left deliberately unspent as reuse margin.
   Fixing the underlying growth is the semester-archive work, not this. */
export const SEMESTER_REUSE_FACTOR = 2;

/** Headroom in the first year, before reuse. */
export const YEAR_ONE_HEADROOM_BYTES = BLOB_BUDGET_BYTES - MEASURED_EXISTING_BYTES;

/** What reuse does to the total, ignoring Batch 3 entirely. */
export const REUSE_PROJECTION_BYTES = MEASURED_EXISTING_BYTES * SEMESTER_REUSE_FACTOR;

/* What Batch 3 may add across BOTH semesters with every cap filled.
   Roughly four fifths of the year-one headroom, leaving the remainder
   as reuse margin. */
export const BATCH3_ALLOWANCE_BYTES = 350 * 1024;

/* JSON overhead per item, measured rather than guessed: the braces,
   quotes, field names and a short id. Used by the budget arithmetic so
   the test reflects stored size rather than character counts. */
const RUBRIC_ITEM_OVERHEAD = 44;
const ENTRY_ITEM_OVERHEAD = 32;

/** Worst-case bytes Batch 3 can add, across two semesters. */
export function worstCaseBytes({ semesters = 2 } = {}) {
  const rubric =
    RUBRICS_PER_SEMESTER_MAX *
    RUBRIC_CRITERIA_MAX *
    (RUBRIC_LABEL_MAX + RUBRIC_NOTE_MAX + RUBRIC_ITEM_OVERHEAD);
  const sheets =
    SHEETS_PER_SEMESTER_MAX *
    SHEET_ENTRIES_MAX *
    (ENTRY_LABEL_MAX + ENTRY_BODY_MAX + ENTRY_ITEM_OVERHEAD);
  // Reading progress adds two short fields to items that already exist,
  // bounded by weeks x courses rather than by anything a user can spam.
  const reading = 36 * 36;
  return (rubric + sheets + reading) * semesters;
}

/* ---------- reading progress ----------

   Two fields on an existing `textbook` item, so they ride along on the
   per-item merge for free: no COLLECTIONS change, no merge change.

   The week label stays the user's own typed number. Nothing here
   derives one from the calendar — see the two-notions-of-week rule in
   CLAUDE.md. */

export const READ_STATES = ["", "part", "done"];

/** Cycles untouched -> part -> done -> untouched. */
export function nextReadState(current) {
  const i = READ_STATES.indexOf(current || "");
  return READ_STATES[(i + 1) % READ_STATES.length];
}

export const isRead = (item) => !!item && item.read === "done";
export const isStarted = (item) => !!item && (item.read === "part" || item.read === "done");

/**
 * How far through a set of readings someone is.
 *
 * Returns zeros rather than NaN for an empty list — a course with no
 * readings should read "0 of 0", not divide by zero.
 */
export function readingProgress(items = []) {
  const live = items.filter((i) => i && !i.deletedAt);
  const done = live.filter(isRead).length;
  const started = live.filter(isStarted).length;
  return {
    total: live.length,
    done,
    started,
    percent: live.length === 0 ? 0 : Math.round((done / live.length) * 100),
  };
}

/* ---------- text caps, and how an overage is reported ---------- */

/**
 * Check one field against its cap.
 *
 * Returns the trimmed value and, when over, how far over — the message
 * names the overage rather than the limit, because "312 characters over"
 * tells someone what to do and "limit 140" makes them count.
 *
 * The value is returned intact either way. Callers must not use `value`
 * as a reason to shorten anything.
 */
export function checkLength(value, max, what = "This") {
  const text = typeof value === "string" ? value : "";
  // Trim before measuring, so a trailing newline from a paste doesn't
  // cost a criterion its last character.
  const trimmed = text.trim();
  const over = trimmed.length - max;
  if (over <= 0) return { ok: true, value: trimmed, length: trimmed.length, over: 0, message: "" };
  return {
    ok: false,
    value: trimmed,
    length: trimmed.length,
    over,
    message: `${what} is ${over.toLocaleString()} character${over === 1 ? "" : "s"} over. Trim it before saving.`,
  };
}

/* ---------- rubrics ---------- */

export const emptyCriterion = (uid) => ({ id: uid(), label: "", note: "", done: false });

/** Validate a whole rubric. `ok` is false if anything at all is over. */
export function validateRubric(criteria = []) {
  const live = criteria.filter((c) => c && !c.deletedAt);
  const problems = [];
  if (live.length > RUBRIC_CRITERIA_MAX) {
    problems.push(
      `That's ${live.length} criteria — a rubric holds ${RUBRIC_CRITERIA_MAX}. Keep the ones that matter.`
    );
  }
  live.forEach((c, i) => {
    const label = checkLength(c.label, RUBRIC_LABEL_MAX, `Criterion ${i + 1}`);
    if (!label.ok) problems.push(label.message);
    const note = checkLength(c.note, RUBRIC_NOTE_MAX, `The note on criterion ${i + 1}`);
    if (!note.ok) problems.push(note.message);
  });
  return { ok: problems.length === 0, problems };
}

/**
 * Split a pasted block into criteria, one per line.
 *
 * Every line is kept. If there are more than the cap allows, the split
 * is REFUSED rather than trimmed — silently dropping the tail of
 * somebody's marking criteria is exactly the failure the whole
 * enforcement rule exists to prevent.
 */
export function splitPastedRubric(text, uid) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { ok: false, criteria: [], message: "There's nothing to split." };
  if (lines.length > RUBRIC_CRITERIA_MAX) {
    return {
      ok: false,
      criteria: [],
      message: `That's ${lines.length} lines — a rubric holds ${RUBRIC_CRITERIA_MAX} criteria. Pick the ones that matter.`,
    };
  }
  return { ok: true, criteria: lines.map((label) => ({ id: uid(), label, note: "", done: false })), message: "" };
}

/** How much of a rubric is ticked. Deleted criteria count for nothing. */
export function rubricProgress(criteria = []) {
  const live = (criteria || []).filter((c) => c && !c.deletedAt);
  const done = live.filter((c) => c.done).length;
  return {
    total: live.length,
    done,
    // An empty rubric is not a complete one. Returning true here would
    // put a tick against work nobody has checked.
    complete: live.length > 0 && done === live.length,
  };
}

export const hasRubric = (assignment) =>
  !!assignment && Array.isArray(assignment.rubric) && rubricProgress(assignment.rubric).total > 0;

/* ---------- reference sheets ----------

   A `pages` item with kind "formula". `pages` is already a union of note
   types discriminated by `kind` ("text" / "drawing"), and AI notes
   already established the precedent of a subtype with extra fields and
   its own viewer. Using it means folders, tombstone deletion and the
   notes list all come free, with no COLLECTIONS change. */

export const FORMULA_KIND = "formula";

export const isReferenceSheet = (p) => !!p && p.kind === FORMULA_KIND;

export const emptyEntry = (uid) => ({ id: uid(), label: "", body: "" });

export function validateSheet(entries = []) {
  const live = entries.filter((e) => e && !e.deletedAt);
  const problems = [];
  if (live.length > SHEET_ENTRIES_MAX) {
    problems.push(`That's ${live.length} entries — a sheet holds ${SHEET_ENTRIES_MAX}.`);
  }
  live.forEach((e, i) => {
    const label = checkLength(e.label, ENTRY_LABEL_MAX, `Entry ${i + 1}`);
    if (!label.ok) problems.push(label.message);
    const body = checkLength(e.body, ENTRY_BODY_MAX, `Entry ${i + 1}`);
    if (!body.ok) problems.push(body.message);
  });
  return { ok: problems.length === 0, problems };
}

/** Whether another sheet may be created in this semester. */
export function canAddSheet(pages = []) {
  const sheets = (pages || []).filter((p) => p && !p.deletedAt && isReferenceSheet(p));
  return {
    ok: sheets.length < SHEETS_PER_SEMESTER_MAX,
    count: sheets.length,
    message:
      sheets.length < SHEETS_PER_SEMESTER_MAX
        ? ""
        : `You have ${sheets.length} reference sheets, which is the limit. Delete one to make another.`,
  };
}

/** Whether another rubric may be created in this semester. */
export function canAddRubric(assignments = []) {
  const withRubric = (assignments || []).filter((a) => a && !a.deletedAt && hasRubric(a));
  return {
    ok: withRubric.length < RUBRICS_PER_SEMESTER_MAX,
    count: withRubric.length,
    message:
      withRubric.length < RUBRICS_PER_SEMESTER_MAX
        ? ""
        : `You have rubrics on ${withRubric.length} assignments, which is the limit.`,
  };
}

/** A short preview for the notes list, the way a drawing shows its stroke count. */
export function sheetSummary(page) {
  const live = ((page && page.entries) || []).filter((e) => e && !e.deletedAt);
  if (live.length === 0) return "No entries yet";
  return `${live.length} entr${live.length === 1 ? "y" : "ies"}`;
}
