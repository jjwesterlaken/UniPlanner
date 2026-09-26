/* ==================================================================
   essayFeedback.js — the pure half of the essay panel

   Everything here is decidable without a screen: which rows go to
   assessment_feedback and what they carry, when the mark comparison is
   asked, and what the saved note looks like. The panel (essayPanel.jsx)
   only renders and calls these, so each rule is a test rather than a
   hope about a component.

   THE ROWS ARE THE MIGRATION'S SHAPE (0023), and the constraints there
   are the real guard: a mark on anything but on_mark, a rating on a
   delivered row, or a second rating of one run is refused by Postgres.
   These builders exist so the client never tries.
   ================================================================== */

import { isMarked, bandFor } from "./grades.js";
import { orderBySeverity, severityOf } from "./essayPoints.js";

/* Mirrors the 0023 column checks; a test reads the migration and
   compares, so a change to one without the other goes red. */
export const MAX_COMMENT_CHARS = 500;
export const MAX_REASONS = 12;

export const RATINGS = Object.freeze(["yes", "partly", "no"]);

/* Reason ids, stable because they are stored. Their words live in
   essayCopy.js. `rewrite-changed-meaning` is offered only when the
   student asked for an example rewrite on that result. */
export const FEEDBACK_REASONS = Object.freeze([
  "wrong-about-essay",
  "too-vague",
  "missed-things",
  "not-my-rubric",
  "wrong-part",
  "repeated",
  "rewrite-changed-meaning",
  "something-else",
]);

export const reasonsFor = ({ rewriteRequested = false } = {}) =>
  FEEDBACK_REASONS.filter((r) => r !== "rewrite-changed-meaning" || rewriteRequested);

/* The opt-in is recorded on the account (meta, synced), once. The
   version lets a materially different opt-in be shown again without
   anybody remembering to clear a flag. */
export const ESSAY_OPT_IN_VERSION = 1;
export const optInNeeded = (meta) => {
  const o = meta && meta.essayOptIn;
  return !(o && Number.isInteger(o.version) && o.version >= ESSAY_OPT_IN_VERSION);
};

/**
 * Is the mark comparison asked on this assessment right now?
 *
 * A RENDER CONDITION, never an onChange hook (ESSAY-FEEDBACK.md). The
 * Grades mark field writes on every keystroke, so reading the committed
 * item alone would ask after the "8" on the way to "85": `editing` is
 * whether that field has focus, and the ask waits until it does not.
 */
export function showMarkCompare(a, { editing = false } = {}) {
  /* Feedback of its own, or a draft linked to it (linkPlaceholder
     below): either way there are runs for the mark to join. */
  const fed = !!(a && (a.essayFeedbackAt || (Array.isArray(a.linkedFrom) && a.linkedFrom.length > 0)));
  return !!(a && isMarked(a) && fed && !a.markCompareAsked && !editing);
}

const cleanReasons = (reasons, allowed = FEEDBACK_REASONS) =>
  [...new Set((reasons || []).filter((r) => allowed.includes(r)))].slice(0, MAX_REASONS);

const cleanComment = (comment) => {
  const s = String(comment || "").trim();
  return s ? s.slice(0, MAX_COMMENT_CHARS) : null;
};

export const codesOf = (result) =>
  [...new Set(((result && result.points) || []).map((p) => p && p.deficiency).filter(Boolean))];

/** The denominator: one row per successful run. */
export function deliveredRow({ id, userId, assessmentId, runId, result, tier = null, credits = null }) {
  return {
    id,
    user_id: userId,
    assessment_id: assessmentId,
    run_id: runId,
    occasion: "delivered",
    deficiency_codes: codesOf(result),
    rewrite_requested: false,
    tier,
    credits,
  };
}

/**
 * The student's verdict on one run. The comment travels ONLY when they
 * ticked to send it: an unticked box is never read, whatever is in it.
 */
export function ratedRow({ id, userId, assessmentId, runId, result, rating, reasons, comment, sendComment, rewriteRequested = false, tier = null, credits = null }) {
  if (!RATINGS.includes(rating)) throw new Error(`not a rating: ${rating}`);
  return {
    id,
    user_id: userId,
    assessment_id: assessmentId,
    run_id: runId,
    occasion: "rated",
    rating,
    reasons: rating === "yes" ? [] : cleanReasons(reasons, reasonsFor({ rewriteRequested })),
    comment: sendComment ? cleanComment(comment) : null,
    deficiency_codes: codesOf(result),
    rewrite_requested: !!rewriteRequested,
    tier,
    credits,
  };
}

/**
 * The verdict when a mark comes back. THE TICK IS THE ONLY THING THAT
 * MOVES A MARK: unticked, mark and band are null and the rating stands.
 * The band is bandFor() on this assessment's own mark under the
 * semester's rounding rule, never the unit's final band.
 */
export function onMarkRow({ id, userId, assessment, rating, reasons, shareMark, rule }) {
  if (!RATINGS.includes(rating)) throw new Error(`not a rating: ${rating}`);
  const share = !!shareMark && isMarked(assessment);
  const mark = share ? Number(assessment.mark) : null;
  return {
    id,
    user_id: userId,
    assessment_id: assessment.id,
    run_id: null,
    occasion: "on_mark",
    rating,
    reasons: rating === "yes" ? [] : cleanReasons(reasons),
    mark,
    band: share ? bandFor(mark, rule).label : null,
  };
}

/** The feedback's points, most important first, each with its severity. */
export const orderedPoints = (result) =>
  orderBySeverity(((result && result.points) || []).filter(Boolean)).map((p) => ({ ...p, severity: p.severity || severityOf(p.deficiency) }));

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The saved note. THE BAND NEVER TRAVELS WITHOUT THE DISCLAIMER (§4):
 * a note is read next month on another screen, which is exactly how the
 * claim escapes its caveat, so both are written together or neither.
 * `copy` is essayCopy.js, passed in so this module holds no wording.
 */
export function essayNoteFields({ result, assessment, copy, pageId }) {
  const points = orderedPoints(result);
  const title = copy.noteTitle(assessment && assessment.title);
  const html = [];
  const text = [];
  if (result && result.band) {
    html.push(`<p><b>${esc(copy.bandLine(result.band))}</b></p>`, `<p>${esc(copy.disclaimer)}</p>`);
    text.push(copy.bandLine(result.band), copy.disclaimer);
  }
  if (result && result.sentence) {
    html.push(`<p>${esc(result.sentence)}</p>`);
    text.push(result.sentence);
  }
  for (const level of ["fundamental", "minor", "outside"]) {
    const group = points.filter((p) => p.severity === level);
    if (!group.length) continue;
    html.push(`<p><b>${esc(copy.severityHeading[level])}</b></p>`, "<ul>");
    text.push(copy.severityHeading[level]);
    for (const p of group) {
      const label = copy.codeLabel(p.deficiency);
      html.push(`<li><b>${esc(label)}</b>: &ldquo;${esc(p.quote)}&rdquo; ${esc(p.note)}</li>`);
      text.push(`- ${label}: "${p.quote}" ${p.note}`);
    }
    html.push("</ul>");
  }
  return {
    title,
    html: "",
    body: "",
    strokes: [],
    blocks: [{ id: `${pageId}:t0`, type: "text", html: html.join(""), body: text.join("\n") }],
  };
}

/* ---------- the example rewrite, client side ---------- */

/* THE CLIENT HALF OF A TWO-FLAG SWITCH. The server refuses the rewrite
   until ESSAY_REWRITE is set in ai-text/config.ts; this decides only
   whether the button is DRAWN. The order is forced: measure, set the
   server's limits, deploy the functions, THEN let this reach students
   (the web promote, the app build). A button drawn over a server that
   refuses is a control that fails after the tap. ON since 26 September
   2026, with the server's limits in the same change. */
export const ESSAY_REWRITE_ENABLED = true;

/* ---------- the AI-use record (Jared, 18 September 2026) ----------

   "A per-assessment record of which parts were rewritten, exportable by
   the student, so they can disclose AI assistance accurately under their
   unit's rules."

   IT HOLDS NO ESSAY TEXT, deliberately. The privacy policy says text
   supplied to the AI features is not stored, "not in your planner and
   not on our server", and copying the rewritten sentences in here would
   make that false. What it records is what a disclosure asks for: when,
   what kind of help, which problem, and how much of the essay. The
   student has the essay; the record says what was done to it.

   BOUNDED: an assessment keeps its newest MAX_AI_USE_ENTRIES. Store
   state, not history, and this is about one assessment. */
export const MAX_AI_USE_ENTRIES = 50;

export function withAiUse(assessment, entry) {
  const prior = Array.isArray(assessment && assessment.aiUse) ? assessment.aiUse : [];
  return [...prior, entry].slice(-MAX_AI_USE_ENTRIES);
}

export const feedbackEntry = ({ at }) => ({ at, kind: "feedback" });
export const rewriteEntry = ({ at, deficiency, spanWords }) => ({
  at,
  kind: "example-rewrite",
  code: typeof deficiency === "string" ? deficiency.slice(0, 64) : null,
  words: Number.isInteger(spanWords) ? spanWords : null,
});

/** The record as plain text, for the student to copy into a disclosure. */
export function aiUseText({ assessment, copy, formatDate }) {
  const entries = (assessment && Array.isArray(assessment.aiUse) ? assessment.aiUse : []).filter(Boolean);
  const lines = [copy.recordHeading(assessment && assessment.title)];
  for (const e of entries) {
    const when = formatDate(e.at);
    if (e.kind === "feedback") lines.push(copy.recordFeedbackLine(when));
    else if (e.kind === "example-rewrite") lines.push(copy.recordRewriteLine(when, e.words, e.code ? copy.codeLabel(e.code) : null));
  }
  if (entries.length === 0) lines.push(copy.recordEmpty);
  return lines.join("\n");
}

/* ---------- the AI tab's draft card (Jared, 27 September 2026) ----------

   The AI tab takes a draft straight away: one optional course, then the
   same two boxes as the Grades panel, and the result on the AI tab.
   Picking or creating an assessment first was too many steps for the
   main use of the feature.

   THE RUN STILL LIVES ON AN ASSESSMENT, because the mark loop is a
   render condition on one: a delivered run creates a PLACEHOLDER under
   the chosen course, with no weight and no due date, and the ordinary
   Grades row for it then carries the mark question when a mark is
   entered. No weight means the grade maths skips it (weightOf() > 0 in
   grades.js), so a placeholder can never move a student's average.

   Created on DELIVERY, never on the tap: a failed or refused run must
   not leave a row behind. `date` is already formatted, so this module
   holds no locale and no wording. */
export const PLACEHOLDER_KIND = "assignment";

export function placeholderAssessment({ id, course = "", date, copy }) {
  return { id, course: course || "", title: copy.placeholderTitle(date), kind: PLACEHOLDER_KIND, essayPlaceholder: true };
}

/** Is this assessment weightless, so the grade maths skips it? */
export const hasWeight = (a) => Number.isFinite(Number(a && a.w)) && Number(a.w) > 0;

/* ---------- linking a draft to the real assessment (Jared, 27 September 2026) ----------

   A run from the AI tab is filed under a placeholder ("Essay draft,
   27 Sep"). When the student later adds the real assessment, the draft
   can be LINKED to it, so the mark loop joins the feedback to the mark
   that is actually entered.

   NO MIGRATION, AND NO REWRITE OF WHAT WAS RECORDED. assessment_feedback
   is insert-only and its rows name the placeholder's id. So the real
   assessment carries `linkedFrom`, the placeholder ids, and when its
   mark comes back the answer is recorded ONCE PER ID it covers: its own
   (if it had feedback of its own) and each linked draft's. The
   on_mark unique index is per assessment, so each is its own row and
   each joins to the runs that name it.

   What moves: the AI-use record (merged, oldest first, still bounded),
   and the fact that feedback was given, via linkedFrom. What does not:
   a draft whose mark question was already answered or dismissed has its
   on_mark row already, so it is not carried (it would be recorded
   twice, and the second would be refused by the index anyway). The
   placeholder is then tombstoned, like any deleted assessment. */
export const MAX_LINKED_DRAFTS = 20;

export const isPlaceholder = (a) => !!(a && a.essayPlaceholder);

/** The real assessments a placeholder can be linked to: same course, live, not themselves drafts. */
export const linkTargets = (placeholder, assessments = []) =>
  (assessments || []).filter(
    (a) => a && !a.deletedAt && !isPlaceholder(a) && a.id !== (placeholder && placeholder.id) && (a.course || "") === ((placeholder && placeholder.course) || "")
  );

/** The patch to write on the real assessment when a draft is linked to it, or null if it cannot be. */
export function linkPlaceholder(placeholder, target) {
  if (!isPlaceholder(placeholder) || !target || isPlaceholder(target) || target.deletedAt) return null;
  const carry = !!placeholder.essayFeedbackAt && !placeholder.markCompareAsked;
  const drafts = [...new Set([...(Array.isArray(target.linkedFrom) ? target.linkedFrom : []), ...(carry ? [placeholder.id] : [])])].slice(-MAX_LINKED_DRAFTS);
  const aiUse = [...(Array.isArray(target.aiUse) ? target.aiUse : []), ...(Array.isArray(placeholder.aiUse) ? placeholder.aiUse : [])]
    .filter(Boolean)
    .sort((x, y) => String(x.at).localeCompare(String(y.at)))
    .slice(-MAX_AI_USE_ENTRIES);
  return { linkedFrom: drafts, aiUse };
}

/** Did this assessment, or a draft linked to it, get feedback? The mark question's precondition. */
export const hadFeedback = (a) => !!(a && (a.essayFeedbackAt || (Array.isArray(a.linkedFrom) && a.linkedFrom.length > 0)));

/** The assessment ids a mark answer is recorded against: its own if it had feedback, and each linked draft. */
export const markAnswerIds = (a) => [...new Set([...(a && a.essayFeedbackAt ? [a.id] : []), ...(a && Array.isArray(a.linkedFrom) ? a.linkedFrom : [])])];
