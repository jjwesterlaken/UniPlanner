/* ==================================================================
   model.ts — the provider model strings, in ONE place each

   THE RESTATEMENT THIS CLOSES: `gpt-4o-mini` was written out in
   ai-notes/openai.ts, in ai-text/openai.ts, and in a measurement
   script. Twelfth entry in the ledger, and the one with no excuse —
   the browser/Deno mirrors are unavoidable, but both of these are Deno
   functions in the same repository with a `_shared/` directory already
   deployed alongside them.

   TWO STRINGS, NOT ONE, AND THAT IS THE FINDING. Photographs and
   pasted text are the same `summarise` task, so the obvious move —
   one MODEL constant — would drag text and lectures wherever the photo
   path goes. COST-MODEL.md section 12.5 prices that: moving the task
   to gpt-5.4-mini makes a 20,000-character text chunk 6.6x worse and a
   60-minute lecture summary 6.3x worse, because that model's OUTPUT is
   $4.50/1M against $0.60 and every one of these tasks is
   output-dominated.

   So the model is chosen per MEDIUM. Text and audio transcript
   summaries go one way; images go another.

   BOTH ARE gpt-4o-mini TODAY, and VISION_MODEL is the one expected to
   move: section 12.7 recommends gpt-5.4-nano at detail "original" and
   maxEdge 1024, subject to a cost gate (an unresolved report of 27x the
   documented image tokenisation on exactly the shape we send) and a
   quality gate (whether nano can read a photographed page of print at
   all). Until both land this file has two identical strings, which is
   the point: when the gate clears, the change is one line here rather
   than three greps across two functions.
   ================================================================== */

/** Lecture transcripts, pasted text, and merges. */
export const SUMMARY_MODEL = "gpt-4o-mini";

/** Photographed pages. Expected to move — see the note above. */
export const VISION_MODEL = "gpt-4o-mini";
