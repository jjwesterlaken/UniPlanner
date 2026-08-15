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
   batch of up to PHOTOS_PER_CHUNK pages is one `summarise` request (3
   units), further batches are further chunks, merge is 1 as today. So
   the whole pipeline -- pre-flight estimate in parts, the
   keep-what-was-charged partial-failure rule, the merge -- is the
   EXISTING one, and there is no image-specific billing arithmetic to
   drift.

   Why one batch prices like one text chunk, shown rather than asserted:
   gpt-4o-mini bills an image as input tokens, ~85 base + ~170 per
   512px tile at high detail. A page photo downscaled client-side to
   ~1536px on the long edge is 4-6 tiles, so:

     one photo        ~765-1,105 input tokens   ~$0.00012-0.00017
     a batch of 4     ~3,100-4,400              ~$0.0005-0.0007
     one text chunk   20,000 chars ~ 5,000      ~$0.00075

   A full batch of photos costs slightly LESS input than a full text
   chunk, and the output is the same summary either way -- so weight 3
   per batch is conservative in the right direction. The derived
   billing test covers these constants; if the provider's image pricing
   model changes, change IMAGE_BASE_TOKENS/IMAGE_TILE_TOKENS and the
   test re-runs the comparison. */
export const PHOTOS_PER_CHUNK = 4;
export const MAX_READING_PHOTOS = 16; // mirrors MAX_READING_CHUNKS * PHOTOS_PER_CHUNK

/* Base64 length cap per photo, server-enforced. ~500KB of JPEG is a
   1536px-long-edge page at quality 0.8 with headroom; anything larger
   is an un-downscaled original, which the client never sends. */
export const MAX_IMAGE_BASE64_CHARS = 700_000;

/* The provider's image-token model, mirrored for the derivation above
   and its test. Published figures, not measurements. */
export const IMAGE_BASE_TOKENS = 85;
export const IMAGE_TILE_TOKENS = 170;
export const IMAGE_MAX_TILES = 6; // a 1536px long edge at high detail

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

   Weighted by output ceiling, because that is what dominates cost:
   gpt-4o-mini charges 4x more for output than input, and the input caps
   above are already tight.

     explain    600 tokens -> 1
     weakspots  800        -> 1
     practice  1500        -> 2
     summarise 2000        -> 3   (largest input as well as largest output)

   150 a month is roughly a text feature used five times a day, every
   day, which is well past what a student doing this earnestly would
   reach and comfortably inside what it costs us: at the ceilings above,
   150 units of the most expensive mix is under $0.20.

   STUDENTS NEVER SEE THE WORD "UNITS". The weighting is internal; the
   app shows a proportion in plain language and a specific warning when
   the remaining allowance won't cover the action about to be taken.
   See src/aiTextCopy.js. */
export const TASK_UNITS: Record<Task, number> = {
  explain: 1,
  weakspots: 1,
  practice: 2,
  summarise: 3,

  /* 1, not 3, even though the output ceiling matches `summarise`.
     `summarise` is priced for 20,000 characters of input; a merge takes
     four summaries -- around 6,000 characters -- and returns one. It is
     under a third of the input at the same output, so charging it as a
     summarise would be overcharging for the step the student did not
     ask for and only needs because their reading was long.

     What that makes a whole reading cost:

       <= 20k chars   1 chunk            3 units
       <= 40k         2 chunks + merge   7
       <= 60k         3 chunks + merge  10
       <= 80k         4 chunks + merge  13    (the ceiling)  */
  merge: 1,
};

export const MONTHLY_TEXT_UNITS_LIMIT = 150;

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

/* What a free account gets. Deliberately small: enough to feel the
   feature, not enough to replace the tier.

   THE TWO HALVES MUST MOVE TOGETHER. Adding a tier here without giving
   it a smaller limit hands it the paid allowance, which is the mistake
   that looks like generosity until the bill arrives -- so a test asserts
   the COMBINATION, not each constant on its own. */
export const FREE_TEXT_UNITS_LIMIT = 10;

/** The monthly allowance for a tier. */
export const limitForTier = (tier: string) =>
  tier === "ai" ? MONTHLY_TEXT_UNITS_LIMIT : FREE_TEXT_UNITS_LIMIT;
