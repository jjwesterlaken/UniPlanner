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
  return !!(a && isMarked(a) && a.essayFeedbackAt && !a.markCompareAsked && !editing);
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
