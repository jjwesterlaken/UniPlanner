/* ==================================================================
   ai-text — one endpoint, six tasks

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
/* The vision model's own rates and the MEASURED bill for one batch,
   imported from the file that owns the model string so a swap cannot
   leave its prices behind. */
import {
  VISION_USD_PER_1M_INPUT,
  VISION_USD_PER_1M_OUTPUT,
  MEASURED_PHOTO_BATCH_INPUT_TOKENS,
  SUMMARY_MODEL,
  ESSAY_MODEL,
  ESSAY_USD_PER_1M_INPUT,
  ESSAY_USD_PER_1M_OUTPUT,
  modelFor,
} from "../_shared/model.ts";

export const SUMMARY_PROVIDER = "openai";

export const TASKS = ["practice", "explain", "weakspots", "summarise", "merge", "essay", "rewrite", "criteria"] as const;
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

  /* Essay feedback, on a REASONING model: gpt-5.6-luna's reasoning
     tokens count against this ceiling, so it is set from measurement,
     not from the shape of the JSON. 36 ASAP runs cost at most $0.00455,
     which at the smallest input any run could have had bounds the
     output at ~3,460 tokens; 4,000 is that plus ~16%. RULED, Jared, 25
     September 2026, with the price it implies (TASK_CREDITS.essay = 9).
     ESSAY-FEEDBACK.md §2 has the derivation and the options not taken.
     Measured on essays of 350-650 words where a university essay runs
     to 3,000, so a truncation here is the first thing to look at when
     the real traffic starts. */
  essay: 4000,

  /* One example rewrite of ONE passage (a sentence or a paragraph,
     capped at ESSAY_REWRITE.maxSpanWords). The reply itself is ~200
     tokens at most; the rest is headroom for the reasoning tokens the
     essay model spends first. NOT MEASURED: a guess about reasoning
     use, priced by the same rule as every task. measure-rewrite.mjs
     prints the real completion tokens, and the ceiling moves on that. */
  rewrite: 1500,

  /* MARKING CRITERIA FROM A PHOTO (Jared, 27 September 2026): a
     rubric transcribed verbatim so the essay's band check can read the
     criteria's own band names. A dense four-band, six-criterion rubric
     is ~900 words, ~1,200 tokens; four photographs of one is the most a
     batch can carry. The SAME ceiling as a photographed reading on
     purpose: the ruling is "priced the same, 18 per batch", and this
     ceiling is what makes the derivation land there (TASK_CREDITS
     below). NOT MEASURED — scripts/measure-criteria-photos.mjs prints
     the real completion tokens, and this moves on that. */
  criteria: 2000,
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
  /* The essay AND the criteria, together, because the model reads both
     and the bill is for both. 3,000 words (~18,300 characters) plus
     ~5,700 of criteria. Never chunked: a marker reads the whole essay,
     and feedback on four quarters cannot say whether the argument holds
     together. Over it, refuse naming the overage. ESSAY-FEEDBACK.md §2. */
  essay: 24_000,
  /* What the MODEL reads for a rewrite: the passage (at most
     ESSAY_REWRITE.maxSpanWords, ~800 characters), the reviewer's note
     (500) and the code's definition. The essay travels in the request
     too, but only so the server can check scope, and is capped by
     MAX_INPUT_CHARS.essay; it is never sent on, so it is not priced. */
  rewrite: 2_000,
  /* PHOTOGRAPHS ONLY, never text, so its input is bounded by the image
     limits below (PHOTOS_PER_CHUNK of MAX_IMAGE_BASE64_CHARS each) and
     this cap is never compared with anything. Set to that product so
     the "every task has an input cap" test says something true. */
  criteria: 4 * 700_000,
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

/* AT THE RATES OF THE MODEL THE TASK REALLY USES. Every task used to be
   priced at SUMMARY_MODEL's rates because every text task ran on it.
   Essay runs on ESSAY_MODEL, so the rate is looked up from `modelFor`,
   the same function the adapter asks. A task that moves model re-prices
   itself; a model with no rate here refuses to load rather than being
   priced as something it is not. */
const RATES: Record<string, { in: number; out: number }> = {
  [SUMMARY_MODEL]: { in: USD_PER_1M_INPUT, out: USD_PER_1M_OUTPUT },
  [ESSAY_MODEL]: { in: ESSAY_USD_PER_1M_INPUT, out: ESSAY_USD_PER_1M_OUTPUT },
};
export const ratesForTask = (task: Task) => {
  const model = modelFor({ hasImages: false, task });
  const rates = RATES[model];
  if (!rates) throw new Error(`no published rate for ${model}, which ${task} would run on`);
  return rates;
};

/* THE PHOTO-ONLY TASKS, priced by the photo-batch formula: the MEASURED
   input of one batch at the vision model's rates, plus the task's own
   output ceiling. Text caps mean nothing for a request that carries no
   text. The handler charges PHOTO_BATCH_CREDITS for any request with
   photographs (guards.js), and a test holds this weight equal to it. */
export const PHOTO_ONLY_TASKS: readonly Task[] = ["criteria"];

/** What one call of `task` costs us, at its own input and output caps. */
export const usdForTask = (task: Task) =>
  PHOTO_ONLY_TASKS.includes(task)
    ? MEASURED_PHOTO_BATCH_INPUT_TOKENS * (VISION_USD_PER_1M_INPUT / 1_000_000) +
      MAX_TOKENS[task] * (VISION_USD_PER_1M_OUTPUT / 1_000_000)
    : (MAX_INPUT_CHARS[task] / CHARS_PER_TOKEN) * (ratesForTask(task).in / 1_000_000) +
      MAX_TOKENS[task] * (ratesForTask(task).out / 1_000_000);

export const TASK_CREDITS: Record<Task, number> = Object.fromEntries(
  TASKS.map((task) => [task, creditsFor(usdForTask(task))])
) as Record<Task, number>;

/* ---------- essay feedback: the two things that must be true first ----------

   THE NO-WRITING THRESHOLDS, read off the two-arm harness on the model
   that ships (ASAP sets 1, 2 and 8, 25 September 2026), each from the
   constrained arm's own distribution. ESSAY-FEEDBACK.md has the table
   and the rule they are read by. Setting these is what turns the
   feature on; null turns it off again, refusing before any spend.

     maxNoteWords      30  constrained max 27, p99 23 (adversarial p99 71)
     minQuoteWords      3  every 3-word quote located one place; 2-word 80%
     window / unit  30/4   no constrained note can reach it (max 27 words);
                           at 25 it refused 2 of 72 constrained replies
     maxSentenceWords  50  constrained max 47

   THE ARMS DO NOT SEPARATE on length or window, as on the previous
   model: these guard size and protect legitimate feedback. The
   ghostwriting control is the offered-wording refusal in
   _shared/essayReply.js. */
export const ESSAY_NO_WRITING: {
  window: number;
  matchUnit: number;
  minQuoteWords: number;
  maxNoteWords: number;
  maxSentenceWords: number;
} | null = { window: 30, matchUnit: 4, minQuoteWords: 3, maxNoteWords: 30, maxSentenceWords: 50 };

/* ---------- the example rewrite: its limits, MEASURED ----------

   Jared's ruling, 18 September 2026 (_shared/essayRewrite.js has it in
   full). maxSpanWords and maxSpanShare are PRODUCT RULES — one sentence
   or one paragraph, never a section — chosen, not measured. escapeRun
   and exceedsRatio are #142's scope-check parameters, READ OFF
   measure-rewrite.mjs on the essay model (12 ASAP essays, 36 rewrites,
   26 September 2026):

     no passage refused by the span rules; none cut off at 1,500 tokens
     (completion p50 89, max 380); at most $0.00052 a rewrite
     escapes-span  0 at every escape run >= 4
     exceeds-span  4/36 at ratio 1.5, 0 at 2.5
     fabricated    1/36, whatever the settings

   So escape run 4 and ratio 2.5, which leave only the fabricated one:
   1/36 = 2.8%, ruled acceptable if it is a genuine invention. Two
   misreadings of the student's own words were then found and fixed in
   essayScope.js (a word the essay has in lower case, a number it spells
   out), which can only lower that count. ESSAY-FEEDBACK.md has the
   rest. null switches the task off again, refusing before any spend. */
export const ESSAY_REWRITE: {
  maxSpanWords: number;
  maxSpanShare: number;
  escapeRun: number;
  exceedsRatio: number;
} | null = { maxSpanWords: 120, maxSpanShare: 0.25, escapeRun: 4, exceedsRatio: 2.5 };

/* The first consent version that disclosed essay drafts. The server
   checks it for the essay task only, because the essay is the only
   material v8 added: a client that accepted v7 has not agreed to send
   one. Other tasks do not look at it, so no older build is refused for
   anything it could already do. A test derives this from the material
   ledger rather than trusting the number. */
export const ESSAY_MIN_CONSENT_VERSION = 8;

/* ---------- the photo batch price, DERIVED FROM A MEASUREMENT ----------

   IT WAS HELD, AND THE HOLD IS OVER. For as long as the photo path ran
   on gpt-4o-mini this number could not be derived honestly: the true
   weight was about 34 credits, at which a 16-page reading is most of a
   month and the feature does not exist, and setting 34 against a model
   we were about to leave would have told students a reading cost a
   third of their month when it was about to cost a fortieth. So it sat
   at one text chunk with a comment saying it was known to be wrong.

   BOTH GATES RAN ON 16 SEPTEMBER 2026; COST-MODEL.md 12.9 records the
   first pass and 12.11 the reversal. The tokenisation was CONSERVATIVE
   rather than wrong -- every count came back below prediction, so the
   66,000-token report did not reproduce -- and the model is
   gpt-5.4-mini, because gpt-5.4-nano fabricated a term and fused two
   claims into a false one on pages it had otherwise read correctly,
   and a prompt written against those exact defects did not stop it.

   SO THIS IS DERIVED AGAIN, and from the place that cannot drift: the
   MEASURED input tokens for one batch at the shipped configuration,
   priced at VISION_MODEL's own published rates, plus this task's output
   ceiling. Raise MAX_TOKENS.summarise and the photo batch re-prices
   itself, exactly as every other weight in this file does.

   THE INPUT IS MEASURED AND THE OUTPUT IS A CEILING, deliberately: the
   measured run produced 1,591 output tokens, but a price built on one
   observation of a variable quantity is the TYPICAL_SUMMARY_OUTPUT_TOKENS
   mistake again. The ceiling is what any single call CAN cost us.

   WORTH KNOWING BEFORE RAISING THE CEILING: mini produced 1,314 output
   tokens of 2,000 on the measured run -- 66%, against nano's 80% -- so
   the truncation headroom improved with the model change as well. A
   denser four pages could still reach the cap, which the adapter turns
   into a hard error; that is a headroom risk on the output ceiling
   rather than a pricing one, and it is measured rather than feared.
   Raising the ceiling re-prices the batch automatically, and on mini's
   output rate that is expensive: every 1,000 tokens of ceiling is 6.6
   credits. */
export const PHOTO_BATCH_CREDITS = creditsFor(
  MEASURED_PHOTO_BATCH_INPUT_TOKENS * (VISION_USD_PER_1M_INPUT / 1_000_000) +
    MAX_TOKENS.summarise * (VISION_USD_PER_1M_OUTPUT / 1_000_000)
);

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
/* EVERY TIER GETS THE TEXT FEATURES. It was ["ai", "free"] when there
   were two; the tier table has three and none of them is excluded, so
   this is now the same list as TIERS and exists only because the
   endpoint's validation reads a name it owns.

   The reasoning is unchanged from when it was written: ten credits is
   roughly five practice sets or ten explanations, it costs about a cent
   per free account, and it is the best advertisement for the paid tier.
   Gating the cheapest features means nobody ever experiences the thing
   they would be buying. */
export const TEXT_TIERS = ["free", "ai", "ai_max"];

/* THE ALLOWANCE MOVED TO _shared/credits.ts, because it is no longer a
   property of the text features: audio and text draw on the same pool.
   Re-exported here so the four screens that ask this file what an
   action costs also get to ask it what the month holds.

   THE TWO HALVES STILL MOVE TOGETHER. Adding a tier to TEXT_TIERS
   without giving it a smaller limit hands it the paid allowance, which
   is the mistake that looks like generosity until the bill arrives — so
   a test asserts the COMBINATION, not each constant on its own. */
export {
  MONTHLY_CREDITS_LIMIT,
  FREE_CREDITS_LIMIT,
  TRIAL_CREDITS,
  TIERS,
  TRIAL_TIERS,
  isTrialTier,
  allowanceForTier,
  creditsForTier,
} from "../_shared/credits.ts";
