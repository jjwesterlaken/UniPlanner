/* essayFeedbackStore.js — writing one row to assessment_feedback (0023).

   A PLAIN INSERT, never an upsert: the table has no update grant, and
   PostgREST needs UPDATE for any upsert (0008's lesson, migrateNote's
   comment). 23505 is DEFINITIVE — the row for this run or this mark is
   already there — so it reads as done, the same split migrateNote
   makes. Every other outcome is a failure and nothing is retried: a
   capture row is how we learn, and a queue of them is not worth the
   complexity or the risk of double-counting.

   IT CANNOT THROW and it never blocks: the result the student paid for
   is already on screen by the time this runs. No client (demo mode, or
   signed out) is a quiet no-op, because nothing may leave the device
   without an account. */

export const DUPLICATE_KEY = "23505";

/* `table` is one of the two capture tables, never anything a caller
   builds: assessment_feedback (0023) or lecture_notes_feedback (0026),
   which share this contract exactly. */
export const FEEDBACK_TABLES = Object.freeze(["assessment_feedback", "lecture_notes_feedback"]);

export async function recordFeedback({ supabaseClient, row, table = "assessment_feedback" }) {
  if (!supabaseClient || !row || !row.user_id || !FEEDBACK_TABLES.includes(table)) return { ok: false, skipped: true };
  try {
    const { error } = await supabaseClient.from(table).insert(row);
    if (!error) return { ok: true };
    if (error.code === DUPLICATE_KEY) return { ok: true, existed: true };
    return { ok: false };
  } catch (e) {
    return { ok: false };
  }
}
