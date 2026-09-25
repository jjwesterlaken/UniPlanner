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

   VISION_MODEL IS gpt-5.4-mini, AND IT WAS gpt-5.4-nano FOR ONE DAY.
   Both gates in COST-MODEL.md 12.7 ran on 16 September 2026 against
   four phone photographs of printed pages; 12.9 and 12.11 record what
   came back. Gate 1 held — every reported count came in BELOW
   prediction, so the 66,000-token report did not reproduce on the
   shape we send. Gate 2 is what moved, and it took a second run to
   settle, because nano's first output was accurate and the defects
   read as presentation.

   NANO FABRICATES AND FUSES, AND A PROMPT DID NOT FIX IT. Told in as
   many words to write one claim about one subject, it still produced
   "a screen resembling desktop-sized programmable calculator" — two
   devices welded into one phrase — and its earlier run had invented an
   "ARPANET / Internet" term for a page that says Ethernet. mini, on
   the same photographs under the same prompt, is atomic, and it ALONE
   read three things nano missed entirely: the Programma 101, the Z1's
   weight, and that ENIAC was built at the University of Pennsylvania.
   Jared's ruling, 16 September 2026.

   AND THE ARGUMENT THAT HAD SETTLED IT FOR NANO WAS A RULE NOBODY HAD
   RE-EXAMINED. 12.9 chose nano because `credits.ts` said the trial must
   demonstrate a whole photographed READING, and at 18 credits a batch
   that is 72 of 60 credits — impossible, so nano won by default. The
   rule was the problem: a trial demonstrates ONE BATCH. See
   TRIAL_CREDITS' own comment. **A constraint nobody has re-derived can
   decide a quality question on its own; check the rule before letting
   it choose the product.**

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
export const VISION_MODEL = "gpt-5.4-mini";

/** Essay feedback. Chosen on measured agreement with human raters, not
    on price; see the essay-model note below and ESSAY-FEEDBACK.md. */
export const ESSAY_MODEL = "gpt-5.6-luna";

/**
 * WHICH MODEL A REQUEST GETS, and the rule lives here rather than at
 * the adapter because it is this file's whole subject.
 *
 * It was one inline ternary in `ai-text/openai.ts`, which was fine for
 * as long as the adapter was the only thing that had to answer the
 * question. It is not: a measurement harness has to send its calls to
 * the model the FEATURE will use, or it measures a stand-in and reports
 * a number about a configuration nobody ships. Reading a constant by
 * name is not the same as asking which one applies — the two coincide
 * today only because the feature being measured is text-only, and a
 * coincidence is not a derivation.
 *
 * PER MEDIUM WITHIN A TASK. Photographs and pasted text are the same
 * `summarise` task, and moving that task rather than the medium would
 * make every text chunk and lecture dearer (COST-MODEL.md 12.5), so a
 * medium still decides between SUMMARY_MODEL and VISION_MODEL.
 *
 * ESSAY IS ITS OWN TASK, and the one exception by task, because it was
 * chosen by task. Gate A compared four models on the same 18 ASAP
 * essays, scored for best-fit agreement with the human rater's band:
 * gpt-4o-mini 6/18, gpt-5.4-mini 5/18, gpt-5.4 9/18, gpt-5.6-luna 11/18
 * (and 9/18 on a second seed, 20/36 across both). Only Luna stopped
 * reading every high-band essay one band low. No other task has been
 * measured on it, and no other task moves.
 */
export function modelFor({ hasImages = false, task = null }: { hasImages?: boolean; task?: string | null } = {}): string {
  if (task === "essay") return ESSAY_MODEL;
  return hasImages ? VISION_MODEL : SUMMARY_MODEL;
}

/* Published rates for VISION_MODEL, reproduced independently on
   15 September 2026 (COST-MODEL 12.1 and 12.12). MOVE THESE IN THE
   SAME COMMIT AS THE STRING -- the day they lag it, PHOTO_BATCH_CREDITS
   is derived from another model's prices and is wrong by 3.75x on the
   input side alone, which is the exact drift this file exists to stop. */
export const VISION_USD_PER_1M_INPUT = 0.75;
export const VISION_USD_PER_1M_OUTPUT = 4.5;

/* Published rates for ESSAY_MODEL, per 1M tokens. NOT REPRODUCED FROM
   THIS REPOSITORY: the build container cannot reach OpenAI's pricing
   page. The figures are Jared's, read off that page on 25 September
   2026 (openai.com/api/pricing). The vision rates above were
   reproduced independently and these were not, and the difference is
   recorded rather than smoothed over. MOVE THEM WITH THE STRING, for
   the reason given above: an essay's credits are derived from these. */
export const ESSAY_USD_PER_1M_INPUT = 0.2;
export const ESSAY_USD_PER_1M_OUTPUT = 1.2;

/* WHAT WE ACTUALLY GET BILLED for one batch of PHOTOS_PER_CHUNK pages
   at maxEdge 1024 and detail "original" — MEASURED, not modelled, on
   the prompt that ships.

   The documented patch arithmetic predicted 8,082 for nano and 5,394
   for gpt-5.4-mini. Both reported EXACTLY 4,045 on the shorter prompt
   and EXACTLY 4,234 on this one, which is two findings at once: the
   published per-model multipliers are not what is applied, and the two
   models bill an image IDENTICALLY — so the choice between them was
   never a tokenisation question, only price against output quality.

   BECAUSE THE MECHANISM IS NOT UNDERSTOOD, THIS NUMBER DOES NOT
   EXTRAPOLATE. It is the bill for THIS configuration — four pages,
   771x1024, detail "original", and THIS PROMPT — and changing maxEdge,
   the page count, the detail setting or the system prompt invalidates
   it. scripts/measure-photo-prompt.mjs prints the new count beside
   this one on every run, which is how the +189 from the noise rules
   was caught.

   THE HEADROOM IS NARROW NOW AND THAT IS A REAL CHANGE. On nano the
   weight held for anything from 2,933 to 6,362 input tokens, so a
   prompt edit could never move the price. mini's input is 3.75x
   dearer, so the band is 4,005 to 4,918 — 684 tokens above the
   measured figure, or roughly 2,900 characters of prompt. A prompt
   change of any size now needs this re-measured; a test asserts the
   band rather than leaving it in this sentence. */
export const MEASURED_PHOTO_BATCH_INPUT_TOKENS = 4234;
