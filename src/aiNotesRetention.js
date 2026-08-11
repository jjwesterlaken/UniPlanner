/* ==================================================================
   aiNotesRetention.js — how long a result stays on the server

   These numbers appear in user-facing copy, so they are a promise. They
   are ALSO enforced server-side, in
   supabase/functions/ai-notes/config.ts, which the browser bundle can't
   import (Deno module, different runtime).

   Duplicating a promise is exactly how the promise and the behaviour
   drift apart, so a test in scripts/test-storage.mjs reads both files
   and fails if they disagree. Change one, change the other.
   ================================================================== */

/* A successful result is a convenience copy: the user already has the
   notes in their planner, so this only needs to outlive a bad network
   moment. */
export const RESULT_RETENTION_DAYS = 7;

/* A failed summary is different. Transcription succeeded and was
   BILLED, the audio is already deleted, and the only copy of what the
   user paid for is this row. Keeping it four times as long costs almost
   nothing and is the difference between "recoverable" and "gone". */
export const FAILED_RESULT_RETENTION_DAYS = 30;
