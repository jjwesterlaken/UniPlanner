/* ==================================================================
   ai-text — one endpoint, four tasks

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

export const TASKS = ["practice", "explain", "weakspots", "summarise"] as const;
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
  summarise: 20_000, // a long typed note; ~3,500 words
};

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
};

export const MONTHLY_TEXT_UNITS_LIMIT = 150;

/* ---------- who gets these features ----------

   A PRODUCT DECISION, parked in one constant rather than inherited.

   Today: `["ai"]`, the same gate lecture notes use. `profiles.tier`
   defaults to 'free' at signup and is flipped by hand in the dashboard,
   so every account is free until someone changes it.

   The case for opening these up: practice questions and explain-it-back
   are the two features most likely to make a free user want the paid
   tier, and they are the cheapest things here -- 1 or 2 units against a
   lecture's hundred-plus minutes. A small free text allowance is a
   plausible way to sell the AI tier.

   The case against: free users cost money and don't pay.

   Not for this code to decide. Adding "free" to this array is the whole
   change -- FREE_TEXT_UNITS_LIMIT below is the other half, and nothing
   in the four screens branches on tier, so opening the gate does not
   mean touching any of them. */
export const TEXT_TIERS = ["ai"];

/* What a free account would get if it were added to TEXT_TIERS. Unused
   while the gate is ai-only; here so that opening it is one decision
   about a number rather than a second design conversation. Sized as
   roughly a fortnight of light use: enough to feel the feature, not
   enough to replace the tier. */
export const FREE_TEXT_UNITS_LIMIT = 10;

/** The monthly allowance for a tier. */
export const limitForTier = (tier: string) =>
  tier === "ai" ? MONTHLY_TEXT_UNITS_LIMIT : FREE_TEXT_UNITS_LIMIT;
