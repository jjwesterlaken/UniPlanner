/* ==================================================================
   ai-text — one endpoint, five tasks

   THE DESIGN DECISION THAT SHAPES EVERYTHING ELSE: this function reads
   no user content from the database. The client sends the text -- it
   already has it, in the planner blob or the offline note cache -- and
   the server touches exactly one user table, `ai_usage`, and only its
   own row.

   That is not a simplification, it is the security posture. `ai-notes`
   shipped a cross-user disclosure because it looked up a row by an
   identifier the caller supplied and the service-role client bypasses
   RLS. Here there is no lookup by a caller-supplied identifier at all,
   so there is no "exists but isn't yours" to answer differently from
   "malformed" -- the requirement is met by removing the class of bug
   rather than by matching two error strings.

   A source-level invariant in scripts/test-ai-text-function.mjs asserts
   no `.from(...)` in index.ts names any table other than `profiles` and
   `ai_usage`. That fails the day someone adds a convenience read of
   `ai_notes`, which is exactly when the scoping would start mattering
   again.
   ================================================================== */

import {
  CHARS_PER_TOKEN,
  USD_PER_1M_INPUT,
  USD_PER_1M_OUTPUT,
  creditsFor,
} from "../_shared/credits.ts";

export const SUMMARY_PROVIDER = "openai";

export const TASKS = ["practice", "explain", "weakspots", "summarise", "merge"] as const;
export type Task = (typeof TASKS)[number];

/* ---------- output ceilings, one justification each ----------

   Every one of these is a FAILURE when hit, not a silent truncation --
   same rule as ai-notes/openai.ts. Truncated structured JSON is worse
   than an error: it parses, it renders, and it is wrong.

   The numbers are sized to the shape of the output, not picked round.
   `ai-notes` uses 8000 because a three-hour lecture summarised into two
   languages lands around 6k; none of these tasks is that shape. */
export const MAX_TOKENS: Record<Task, number> = {
  /* Feedback on what an explanation missed: two or three short
     paragraphs. 600 tokens is ~450 words, already more than anyone
     reads about one study card. */
  explain: 600,

  /* Guidance across the ~5 topics the digest carries, a few sentences
     each, plus a short opening. */
  weakspots: 800,

  /* PRACTICE_MAX_CARDS questions with an answer and a one-line
     rationale each. At ~120 tokens per question that is 1440; 1500
     leaves room for the wrapper without leaving room for a second set. */
  practice: 1500,

  /* The same structured note shape ai-notes produces, but from a
     student's own note rather than a lecture transcript -- shorter
     source, no translation, so a quarter of ai-notes' ceiling. */
  summarise: 2000,

  /* One summary out of several. Same output shape as `summarise`, so
     the same ceiling -- the input is bigger and the output is not. */
  merge: 2000,
};

/* ---------- input caps ----------

   `max_tokens` bounds output; these bound the other half of the bill.
   Refused at submit with a specific message naming the overage, never
   silently trimmed -- the same rule Batch 3 established for pasted
   rubrics, and for the same reason: quietly dropping half of what
   someone wrote is worse than telling them. */
export const MAX_INPUT_CHARS: Record<Task, number> = {
  explain: 4_000, // an explanation of one concept; ~700 words
  weakspots: 6_000, // the derived digest, not free text
  practice: 8_000, // PRACTICE_MAX_CARDS cards of term + content
  summarise: 20_000, // a long typed note, or one chunk of a reading; ~3,500 words
  /* MAX_READING_CHUNKS summaries, serialised. A summary of one chunk
     lands around 1,500 characters of JSON, so four is ~6,000; 12,000
     leaves room for a verbose one without leaving room for a second
     reading's worth. */
  merge: 12_000,
};

/* ---------- photographed pages ----------

   A reading arrives as pasted text OR as photos of the pages -- one
   medium per run, because a mixed run has no honest ordering (which
   photo goes between which paragraphs?) and no student asked for one.

   PHOTOS ARE PRICED AS PARTS OF THE READING, NOT AS A SECOND SCHEME.
   The client batches photos the same way it chunks long text: each
   batch of up to PHOTOS_PER_CHUNK pages is one `summarise` request,
   further batches are further chunks, and the merge is one more. So
   the whole pipeline -- pre-flight estimate in parts, the
   keep-what-was-charged partial-failure rule, the merge -- is the
   EXISTING one, and there is no image-specific billing arithmetic to
   drift.

   WHY ONE BATCH IS PRICED LIKE ONE TEXT CHUNK IS NO LONGER TRUE, and
   the comment that used to stand here is the reason this file now
   carries a warning instead of a derivation.

   It showed its arithmetic — "gpt-4o-mini bills an image as input
   tokens, ~85 base + ~170 per 512px tile" — and every step after those
   two numbers was right. The numbers were gpt-4o's. gpt-4o-mini bills
   an image at 2,833 base + 5,667 a tile, because its text tokens are so
   cheap that OpenAI charges images at a token multiple; an image costs
   about TWICE on the mini model what it costs on the big one. So a
   6-tile A4 page is 36,835 input tokens, not 1,105, and a batch of four
   costs about 12x a full 20,000-character text chunk rather than
   slightly less. Confirmed against OpenAI's vision guide, 20 August
   2026. Thirteenth entry in the restatement ledger and the first where
   the restated value belonged to a model we do not use.

   PHOTOS ARE STILL PRICED AS PARTS OF THE READING, and that part was
   never in doubt: the client batches photos the same way it chunks long
   text, so the pre-flight estimate in parts, the
   keep-what-was-charged partial-failure rule and the merge are all the
   EXISTING pipeline. What is wrong is only the weight, and
   PHOTO_BATCH_CREDITS below says what is being done about it.

   IMAGE_BASE_TOKENS and IMAGE_TILE_TOKENS are corrected below so the
   test that reads them computes the true comparison rather than a
   flattering one. */
export const PHOTOS_PER_CHUNK = 4;
export const MAX_READING_PHOTOS = 16; // mirrors MAX_READING_CHUNKS * PHOTOS_PER_CHUNK

/* Base64 length cap per photo, server-enforced. ~500KB of JPEG is a
   1536px-long-edge page at quality 0.8 with headroom; anything larger
   is an un-downscaled original, which the client never sends. */
export const MAX_IMAGE_BASE64_CHARS = 700_000;

/* The provider's image-token model for the model we actually call.
   Published figures, not measurements — gpt-4o-mini, confirmed against
   OpenAI's vision guide on 20 August 2026. gpt-4o's 85/170 is what used
   to be here, and it is 33x lower.

   These MOVE WITH VISION_MODEL. The newer mini and nano models do not
   tile at all: they cover the image in 32x32 patches, cap it at a patch
   budget and apply a per-model multiplier, which takes the same page
   from 36,835 tokens to about 1,800. When _shared/model.ts moves,
   these constants and PHOTO_BATCH_CREDITS move in the same commit. */
export const IMAGE_BASE_TOKENS = 2833;
export const IMAGE_TILE_TOKENS = 5667;

/* A 1536px long edge at high detail. The tiler scales the SHORTEST side
   to 768px in both directions, so a portrait A4 page is 2 x 3 tiles
   whatever it was downscaled to — sending a smaller photo saves nothing
   under tiling, and that is settled rather than suspected. Under patch
   tokenisation it becomes a real lever again, which is why maxEdge and
   the model are one decision. */
export const IMAGE_MAX_TILES = 6;

/* ---------- readings ----------

   A reading longer than MAX_INPUT_CHARS.summarise is split client-side
   (src/readingChunks.js), each chunk summarised on its own, and the
   summaries combined by the `merge` task. This constant is the CEILING
   ON THE SPLIT, mirrored there and asserted equal by a test.

   Four, because a fifth call buys less than it costs: by then the merge
   is working from so much material that it is summarising summaries of
   summaries, and the honest answer to a longer reading is to do it in
   two halves rather than to pretend one pass handles it. */
export const MAX_READING_CHUNKS = 4;

/** Cards a practice request may carry. Bounds the input and the output together. */
export const PRACTICE_MAX_CARDS = 30;

/** Topics the weak-spot digest may carry. */
export const WEAKSPOTS_MAX_TOPICS = 40;

/* ---------- metering ----------

   ONE CURRENCY. A credit is a minute of recorded lecture, and every
   task's price is DERIVED from what it costs at its own ceilings — the
   input cap it already declares and the output cap it already declares,
   at the published rates in _shared/credits.ts.

   Nothing here is chosen. The previous version of this block was a
   hand-written table justified by a paragraph of reasoning about output
   ceilings, and the reasoning was sound; the problem is that it stayed
   frozen while the thing it reasoned about moved. A raised
   MAX_INPUT_CHARS or MAX_TOKENS now re-prices its task automatically,
   which is the only arrangement that survives somebody changing a
   ceiling and not thinking about the bill.

   Priced at the CEILINGS, not at a typical case, so the number is an
   upper bound on what any single call can cost us. `merge` moves from 1
   to 2 under this: it was weighted down for its smaller input, which
   was true and no longer decides anything, because output is four times
   the price of input and merge's output ceiling equals summarise's.

   STUDENTS DO SEE THE WORD "CREDITS", and that is the change. They
   never saw "units" — aiTextCopy.js existed to keep an internal weight
   off every screen — because a unit meant nothing to anybody. A credit
   means one minute of recorded lecture, which is a quantity a student
   already has an intuition for, so it can be said out loud. */

/** What one call of `task` costs us, at its own input and output caps. */
export const usdForTask = (task: Task) =>
  (MAX_INPUT_CHARS[task] / CHARS_PER_TOKEN) * (USD_PER_1M_INPUT / 1_000_000) +
  MAX_TOKENS[task] * (USD_PER_1M_OUTPUT / 1_000_000);

export const TASK_CREDITS: Record<Task, number> = Object.fromEntries(
  TASKS.map((task) => [task, creditsFor(usdForTask(task))])
) as Record<Task, number>;

/* ---------- the photo batch price is HELD, not derived ----------

   Every other price in this file falls out of the arithmetic above. This
   one cannot, and pretending otherwise would be worse than saying so.

   Derived honestly against the model we call TODAY, a batch of four
   photographed pages is about 33 credits — gpt-4o-mini bills an image at
   2,833 base + 5,667 a tile, which is 36,835 tokens for an A4 page, 12x
   what a full 20,000-character text chunk costs. At that price a
   16-page reading is most of a month and the feature does not exist.

   Derived against the model it is RECOMMENDED to move to — gpt-5.4-nano
   at detail "original" and maxEdge 1024 — it is about 6.

   Setting 33 against a model we are about to leave would tell students a
   reading costs a third of their month when it is about to cost a
   fortieth, and a visibly wrong number is worse than an invisible one.
   Setting 6 against a model we have not measured would undercharge for
   the app's most expensive action on the strength of two third-hand
   published rates.

   So it stays where it has always been — the same as one text chunk —
   and this comment is the record that it is known to be wrong in a
   known direction. IT MOVES WHEN COST-MODEL.md SECTION 12.7'S TWO GATES
   LAND: the three-call cost test that resolves the 66,000-token report,
   and the side-by-side quality comparison on real page photographs.
   A test asserts the hold, so lifting it is deliberate. */
export const PHOTO_BATCH_CREDITS = TASK_CREDITS.summarise;

/* ---------- who gets these features ----------

   A PRODUCT DECISION, and it has been taken: both tiers.

   `profiles.tier` defaults to 'free' at signup and is flipped by hand in
   the dashboard, so this is the gate almost every account meets.

   The reasoning, recorded because a later reader will wonder why the
   cheapest features are the ungated ones: ten units is roughly five
   practice sets or ten explanations, costs about a cent per free user,
   and is enough to understand why the AI tier is worth paying for.
   These are the best advertisement for the expensive feature, and
   gating them entirely means nobody ever experiences the thing they
   would be buying.

   LECTURE RECORDING IS NOT AFFECTED. That stays ai-only, in
   ai-notes/index.ts, which has its own tier check and its own reasons --
   a recording costs real transcription minutes where these cost
   fractions of a cent.

   Nothing in the four screens branches on tier, so this array and the
   limits below are the whole decision. */
export const TEXT_TIERS = ["ai", "free"];

/* THE ALLOWANCE MOVED TO _shared/credits.ts, because it is no longer a
   property of the text features: audio and text draw on the same pool.
   Re-exported here so the four screens that ask this file what an
   action costs also get to ask it what the month holds.

   THE TWO HALVES STILL MOVE TOGETHER. Adding a tier to TEXT_TIERS
   without giving it a smaller limit hands it the paid allowance, which
   is the mistake that looks like generosity until the bill arrives — so
   a test asserts the COMBINATION, not each constant on its own. */
export { MONTHLY_CREDITS_LIMIT, FREE_CREDITS_LIMIT, creditsForTier } from "../_shared/credits.ts";
