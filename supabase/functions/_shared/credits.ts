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

/* WHAT ANYBODY GETS TODAY, unchanged by the collapse and deliberately
   so: this pass changes the CURRENCY, not the entitlement.
   300 audio minutes + 150 text units was the old pair, and a text unit
   was already worth about a credit, so 450 is the same spending power
   with the walls between the two pools removed.

   The per-tier table — Free/Plus 60 once ever, Study AI 900, Max 3,000,
   per calendar month with no rollover — is the NEXT piece of work and
   replaces both constants here. Do not fold it in early: an entitlement
   change hidden inside a currency change is a change nobody can review. */
export const MONTHLY_CREDITS_LIMIT = 450;

/* What a free account gets. Text only today, because ai-notes keeps its
   own `tier === "ai"` gate — the lifetime trial that lets a free
   account actually record something is the next piece of work. */
export const FREE_CREDITS_LIMIT = 10;

/** The monthly allowance for a tier. */
export const creditsForTier = (tier: string) =>
  tier === "ai" ? MONTHLY_CREDITS_LIMIT : FREE_CREDITS_LIMIT;
