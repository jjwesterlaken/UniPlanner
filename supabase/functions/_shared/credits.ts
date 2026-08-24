/* ==================================================================
   credits.ts — ONE currency, and where every price in it comes from

   THE UNIT: one credit is one minute of recorded lecture.

   Before this there were two — minutes for audio, weighted units for
   text — and the split was defensible right up until it hid a real
   error for months. Photographed pages were billed in the currency that
   the expensive thing they resembled did not use, so there was nowhere
   for the comparison to happen: a photo batch priced at "3 units" and a
   lecture priced at "50 minutes" could not be put beside each other by
   anybody, in any screen or any test. COST-MODEL.md sections 4 and 12
   are what that cost.

   One currency means every action is priced against the same thing, so
   the comparison is unavoidable rather than impossible.

   WHY A LECTURE MINUTE IS THE UNIT, and not a cent or an abstract
   token: it is the only quantity in this app a student already has an
   intuition for. "This reading costs about as much as a 25-minute
   lecture" is a sentence somebody can act on. "This costs 13 units" is
   not, and keeping that sentence sayable is why the rule that students
   never see an internal weight survives the collapse — the weights just
   stopped being internal, because a credit means something.

   EVERY WEIGHT BELOW IS DERIVED FROM A PRICE, NOT CHOSEN. That is the
   whole point of the file: `TASK_CREDITS` in ai-text/config.ts is
   computed from the input and output ceilings each task already
   declares, at the rates below, divided by what a credit costs. A
   raised ceiling re-prices the action automatically instead of leaving
   a number nobody re-derived — which is exactly how
   TYPICAL_SUMMARY_OUTPUT_TOKENS came to be 5.9x reality while setting
   the price of the product.
   ================================================================== */

/* ---------- published provider rates, verified 20 August 2026 ---------- */

/** Groq whisper-large-v3-turbo, ~$0.040 per hour of audio. */
export const USD_PER_TRANSCRIBED_MINUTE = 0.04 / 60;

/** gpt-4o-mini text rates. Images are NOT these — see _shared/model.ts. */
export const USD_PER_1M_INPUT = 0.15;
export const USD_PER_1M_OUTPUT = 0.6;

/* ---------- measured inputs ---------- */

/* Characters per token for English prose. MEASURED, on two real corpora
   — the app's own help copy runs 4.61 chars/token and CLAUDE.md 4.20 —
   with the conservative (densest) end taken, because fewest characters
   per token means the most tokens for a given paste and therefore the
   highest bill. Academic prose, which is what a pasted reading is, sits
   between the two. scripts/measure-cost-model.mjs re-measures both and
   shouts if this has drifted more than 5%. */
export const CHARS_PER_TOKEN = 4.2;

/* A SHORT recording's summary, which is what the floor and the retry
   price are built on: a one-minute clip and a fifty-minute lecture cost
   nearly the same to summarise.

   MEASURED, not guessed — scripts/measure-summary-depth.mjs on a real
   4,772-character recording with a translation, 15 August 2026. The
   output figure was 2,800 when it was a guess, against 1,203 measured,
   and two user-visible billing increases were derived from the guess
   before anyone checked. That is why this file exists at all. */
export const TYPICAL_SUMMARY_OUTPUT_TOKENS = 1203;
export const TYPICAL_SUMMARY_INPUT_TOKENS = 1600;

export const USD_PER_SUMMARY_REQUEST =
  (TYPICAL_SUMMARY_INPUT_TOKENS / 1_000_000) * USD_PER_1M_INPUT +
  (TYPICAL_SUMMARY_OUTPUT_TOKENS / 1_000_000) * USD_PER_1M_OUTPUT;

/* The length the credit is defined against. A recorded lecture costs a
   per-minute transcription charge plus ONE summary however long it is,
   so the per-minute cost depends on the length you pick. Fifty minutes
   is the ordinary case in a real timetable, and it is the length every
   figure in COST-MODEL.md's scenarios uses. */
export const TYPICAL_LECTURE_MINUTES = 50;

/* ---------- what a credit is worth ---------- */

/** One minute of recorded lecture: transcription, plus that minute's
    share of the one summary the whole recording pays for. */
export const USD_PER_CREDIT =
  USD_PER_TRANSCRIBED_MINUTE + USD_PER_SUMMARY_REQUEST / TYPICAL_LECTURE_MINUTES;

/**
 * A USD cost, in credits.
 *
 * ROUNDS rather than ceils, with a floor of 1. Ceiling would make an
 * action that costs 1.04 credits charge 2 — a 92% surcharge for being
 * a rounding hair over — and every text action in the app lands near a
 * boundary. The floor of 1 is what stops any action being free: a
 * provider call that costs nothing to the student is a call an
 * unbounded loop can make.
 */
export const creditsFor = (usd: number) => Math.max(1, Math.round(usd / USD_PER_CREDIT));

/* ---------- the allowance ---------- */

/* THE TIERS, and the only place these numbers are written.

     free        60 credits, ONCE EVER
     plus        60 credits, ONCE EVER   (Plus buys sync, not AI)
     ai         900 credits per month     (Study AI)
     ai_max   3,000 credits per month     (Study AI Max)

   TWO SHAPES, NOT FOUR NUMBERS, and the distinction is the design.
   A per-month free allowance is the one cost line that grows without
   bound as signups grow: ten thousand signed-up-and-forgot accounts is
   ten thousand allowances a month, forever, for people who are not
   using the app. A lifetime trial costs the same ten thousand accounts
   exactly once. That is why `trialTier` exists rather than a fourth
   entry in a table of monthly numbers.

   WHAT A TRIAL IS FOR, and it decides the size: 60 credits has to be
   enough to DEMONSTRATE the thing being sold, or the trial cannot sell
   it. A student must be able to record a lecture and get notes back,
   and — once the photo model lands — complete one photographed reading.
   At today's held photo weight a 16-page reading is ~138 credits and a
   free account cannot finish one, which is a real argument for the
   model move and is recorded in COST-MODEL.md 12.6 rather than fixed
   by making the trial bigger. */
export const TIERS = ["free", "plus", "ai", "ai_max"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers whose allowance is once-ever rather than per month. */
export const TRIAL_TIERS: readonly string[] = ["free", "plus"];
export const isTrialTier = (tier: string) => TRIAL_TIERS.includes(tier);

/** The lifetime trial, for `free` and `plus`. */
export const TRIAL_CREDITS = 60;

const MONTHLY: Record<string, number> = {
  ai: 900,
  ai_max: 3000,
};

/**
 * The allowance for a tier, and the SHAPE of it.
 *
 * `perMonth: false` means the number is a lifetime total held on
 * `profiles.trial_credits_used`, not a monthly one held in `ai_usage` —
 * a different counter, not a different limit. Callers must branch on it
 * rather than assuming, which is why it is returned beside the number
 * instead of being something the caller has to know.
 *
 * An unknown tier gets the trial. That is the safe direction: a typo in
 * the dashboard costs somebody sixty credits, where defaulting to a
 * paid allowance costs three thousand a month per mistyped account.
 */
export function allowanceForTier(tier: string): { credits: number; perMonth: boolean } {
  if (isTrialTier(tier) || !(tier in MONTHLY)) return { credits: TRIAL_CREDITS, perMonth: false };
  return { credits: MONTHLY[tier], perMonth: true };
}

/**
 * The number alone, for the places that only need it.
 *
 * KEPT because five call sites want a limit and not a shape, and
 * because a helper that returns an object forces every one of them to
 * destructure something they do not use. Anything that BILLS must use
 * `allowanceForTier` — the shape is what decides which counter moves.
 */
export const creditsForTier = (tier: string) => allowanceForTier(tier).credits;

/* WHAT NOBODY GETS: rollover. The monthly allowance does not carry, and
   a prepaid term does not pool — six months of Max is 3,000 credits
   each month, not 18,000 on day one.

   IT IS TRUE BY CONSTRUCTION rather than by a rule written anywhere:
   `ai_usage` is keyed (user_id, month), a new month simply has no row,
   and the limit is re-read from the tier on every request. Unused
   credits are not stored, so there is nothing to carry.

   That construction is also why it is fragile in one specific way. A
   "carry over what you didn't use" feature is about three lines — read
   last month's row, subtract — and it would quietly convert a
   semester's prepayment into a single month's spending power, against
   revenue already collected and inside the store's refund window. A
   test asserts a fresh month starts at zero, so that change cannot
   arrive silently. */

/* Superseded names, kept so nothing has to move in the same pass.
   MONTHLY_CREDITS_LIMIT was the single figure before tiers existed. */
export const MONTHLY_CREDITS_LIMIT = MONTHLY.ai;
export const FREE_CREDITS_LIMIT = TRIAL_CREDITS;
