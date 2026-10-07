/* ==================================================================
   notesFeedback.js — the pure half of the lecture-notes rating

   The essay feature's capture (essayFeedback.js), one feature over:
   yes / partly / no, reasons when it was not a yes, and a comment only
   when ticked. The rows are 0026's shape, and the migration's checks
   are the real guard — a reason outside the set, a rating on a
   delivered row, or a second rating of one result is refused there.
   These builders exist so the client never tries.

   WHAT A ROW NEVER CARRIES: anything from the lecture. No summary, no
   terms, no title, no idempotency key. `runId` is minted fresh per
   result and joins to nothing, so a rating cannot be walked back to a
   transcript in `ai_notes_requests`.
   ================================================================== */

import { RATINGS, MAX_COMMENT_CHARS } from "./essayFeedback.js";

export { RATINGS, MAX_COMMENT_CHARS };

/* Reason ids, stable because they are stored AND because 0026 checks
   them against a closed set; a test reads the migration and compares.
   Their words live in aiNotesCopy.js. */
export const NOTES_REASONS = Object.freeze([
  "too-long",
  "too-short",
  "missed-assessable",
  "wrong-terms",
  "wrong-structure",
  "other",
]);

export const MAX_COURSE_CHARS = 64;

const cleanCourse = (course) => {
  const s = String(course || "").trim();
  return s ? s.slice(0, MAX_COURSE_CHARS) : null;
};

const cleanReasons = (reasons) => [...new Set((reasons || []).filter((r) => NOTES_REASONS.includes(r)))];

const cleanComment = (comment) => {
  const s = String(comment || "").trim();
  return s ? s.slice(0, MAX_COMMENT_CHARS) : null;
};

/** Is there anything here to rate? A failed summary has no notes. */
export const ratable = (result) => !!(result && !result.summaryFailed && result.original);

/** The denominator: one row per set of notes that came back. */
export function notesDeliveredRow({ id, userId, runId, course }) {
  return { id, user_id: userId, run_id: runId, course: cleanCourse(course), occasion: "delivered" };
}

/**
 * The student's verdict on one result. The comment travels ONLY when
 * they ticked to send it: an unticked box is never read.
 */
export function notesRatedRow({ id, userId, runId, course, rating, reasons, comment, sendComment }) {
  if (!RATINGS.includes(rating)) throw new Error(`not a rating: ${rating}`);
  return {
    id,
    user_id: userId,
    run_id: runId,
    course: cleanCourse(course),
    occasion: "rated",
    rating,
    reasons: rating === "yes" ? [] : cleanReasons(reasons),
    comment: sendComment ? cleanComment(comment) : null,
  };
}
