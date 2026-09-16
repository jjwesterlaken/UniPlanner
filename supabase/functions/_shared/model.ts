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

   VISION_MODEL HAS MOVED. Both gates in COST-MODEL.md 12.7 were run on
   16 September 2026 against four phone photographs of printed pages,
   and section 12.9 records what came back. The short form: the
   documented tokenisation was CONSERVATIVE rather than wrong — every
   reported count came in BELOW prediction, so the 66,000-token report
   did not reproduce on the shape we send — and gpt-5.4-nano read the
   pages, getting every date and figure right and inventing nothing.

   THE RATES LIVE HERE, BESIDE THE MODEL THEY BELONG TO, and that is the
   point of putting them in this file rather than in credits.ts: a model
   swap that left its prices behind is precisely the restatement that
   made a photo batch cost eleven text chunks while being billed as one.
   `PHOTO_BATCH_CREDITS` is derived from these, so changing the string
   without changing the numbers re-prices the feature wrongly and
   loudly rather than quietly. */

/** Lecture transcripts, pasted text, and merges. */
export const SUMMARY_MODEL = "gpt-4o-mini";

/** Photographed pages. */
export const VISION_MODEL = "gpt-5.4-nano";

/* Published rates for VISION_MODEL, reproduced independently on
   16 September 2026. MOVE THESE IN THE SAME COMMIT AS THE STRING. */
export const VISION_USD_PER_1M_INPUT = 0.2;
export const VISION_USD_PER_1M_OUTPUT = 1.25;

/* WHAT WE ACTUALLY GET BILLED for one batch of PHOTOS_PER_CHUNK pages
   at maxEdge 1024 and detail "original" — MEASURED, not modelled.

   The documented patch arithmetic predicted 8,082 for nano and 5,394
   for gpt-5.4-mini. Both reported EXACTLY 4,045, which is two findings
   at once: the published per-model multipliers are not what is applied,
   and the two models bill an image IDENTICALLY — so the choice between
   them was a pure price-per-token decision rather than a tokenisation
   one.

   BECAUSE THE MECHANISM IS NOT UNDERSTOOD, THIS NUMBER DOES NOT
   EXTRAPOLATE. It is the bill for THIS configuration — four pages,
   771x1024, detail "original" — and changing maxEdge, the page count or
   the detail setting invalidates it. That is acceptable only because
   1024 and "original" are exactly what ships; re-measure before moving
   either. scripts/measure-photo-gates.mjs is the instrument. */
export const MEASURED_PHOTO_BATCH_INPUT_TOKENS = 4045;
