/* ==================================================================
   aiTextLimits.js — the client's copy of the CURRENCY

   ONE CREDIT IS ONE MINUTE OF RECORDED LECTURE, and every AI action in
   the app is priced against that. This file is the browser's copy of
   the arithmetic that lives in supabase/functions/_shared/credits.ts.

   A MIRROR, and mirrors drift — a browser bundle cannot import from a
   Deno function. So the EQUALITY is the guard, not a comment: a test in
   scripts/test-ai-text-function.mjs deep-equals these against the real
   config, and goes red the day one side moves.

   WHY THE CLIENT NEEDS THEM AT ALL: so a student learns what an action
   will cost BEFORE doing the work. Typing out a full explanation and
   only then being told the allowance is gone is a worse experience than
   being told up front, and a worse advertisement for the paid tier --
   it reads as a bait rather than as a limit.

   The server remains the authority. Nothing here is trusted by it: the
   allowance is re-read and re-checked inside the endpoint, so a
   tampered client buys nothing but a rejection.

   WHAT CHANGED WITH THE COLLAPSE, and why the old rule about the word
   "units" is gone rather than broken: there used to be two currencies,
   minutes for audio and weighted units for text, and a unit meant
   nothing to anybody -- which is why aiTextCopy.js existed to keep the
   number off every screen. A credit means a minute of recorded lecture.
   That is a quantity a student already has an intuition for, so it can
   be said out loud, and "this reading costs about as much as a
   25-minute lecture" is a sentence somebody can act on.
   ================================================================== */

/* DERIVED ON THE SERVER, MIRRORED HERE. Each of these is
   round(cost at the task's own ceilings / cost of one credit) -- see
   _shared/credits.ts. They are written out rather than recomputed
   because the input the derivation needs (the provider rates) has no
   business in a browser bundle. */
export const TASK_CREDITS = {
  explain: 1,
  weakspots: 1,
  practice: 2,
  summarise: 3,
  merge: 2,
};

/* HELD, not derived. A batch of four photographed pages really costs
   about 34 credits on the model we call today and about 6 on the one it
   is recommended to move to, and setting either number before that
   decision lands would be a visible lie in one direction or an
   invisible subsidy in the other. See COST-MODEL.md section 12.7 and
   PHOTO_BATCH_CREDITS in the Edge Function's config, where the same
   hold is recorded next to the same reasoning. */
export const PHOTO_BATCH_CREDITS = TASK_CREDITS.summarise;

/* THE TIERS, mirrored from _shared/credits.ts.

     free / plus      60 credits, ONCE EVER   (Plus buys sync, not AI)
     ai              900 credits per month     (Study AI)
     ai_max        3,000 credits per month     (Study AI Max)

   TWO SHAPES, NOT FOUR NUMBERS. `perMonth: false` means the number is a
   LIFETIME total, held on the account rather than on a month — a
   different counter, not a smaller limit. Every screen that says "this
   month" has to branch on it, because telling a trial student their
   allowance resets in November is a support ticket and an angry one. */
export const TIERS = ["free", "plus", "ai", "ai_max"];
export const TRIAL_TIERS = ["free", "plus"];
export const isTrialTier = (tier) => TRIAL_TIERS.includes(tier);
export const TRIAL_CREDITS = 60;

const MONTHLY = { ai: 900, ai_max: 3000 };

/** Mirrors allowanceForTier on the server, shape included. */
export function allowanceForTier(tier) {
  if (isTrialTier(tier) || !(tier in MONTHLY)) return { credits: TRIAL_CREDITS, perMonth: false };
  return { credits: MONTHLY[tier], perMonth: true };
}

export const creditsForTier = (tier) => allowanceForTier(tier).credits;

/* Superseded names, kept so nothing has to move in the same pass. */
export const MONTHLY_CREDITS_LIMIT = MONTHLY.ai;
export const FREE_CREDITS_LIMIT = TRIAL_CREDITS;
export const TEXT_TIERS = TIERS;

/**
 * What a student can be told before they start.
 *
 * `remaining` is in credits. aiTextCopy.js still turns the FRACTION
 * into words for the warnings, because a proportion is what survives a
 * tier whose limit the endpoint did not know had changed — but a credit
 * count is now a sayable thing, and the pre-flight estimate says it.
 */
export function allowanceState({ tier, creditsUsed }) {
  const { credits: limit, perMonth } = allowanceForTier(tier);
  const used = Math.max(0, creditsUsed || 0);
  return {
    tier,
    limit,
    perMonth,
    used,
    remaining: Math.max(0, limit - used),
    fraction: limit > 0 ? Math.min(1, used / limit) : 1,
    isFree: !perMonth,
  };
}

/** Whether this month's allowance covers `task`, without asking the server. */
export const canAfford = (state, task) => !!state && state.remaining >= (TASK_CREDITS[task] || 0);

/**
 * True when running `task` would take the last of the allowance.
 *
 * The pre-flight warning fires on this rather than on a fixed threshold,
 * so it means something specific -- "this one is the last" -- instead of
 * a vague "running low" that a student learns to ignore.
 */
export const isLastAction = (state, task) =>
  !!state && canAfford(state, task) && state.remaining - (TASK_CREDITS[task] || 0) < (TASK_CREDITS[task] || 1);

/* ---------- variable-cost actions ----------

   Everything above prices a task at a fixed weight. Summarising a
   reading doesn't have one: it costs 3, 8, 11 or 14 credits depending
   on how long the reading is. These two are the same `canAfford` /
   `isLastAction` idea extended to that, rather than a second scheme
   beside it.

   `sectionsAffordable` is the number that makes a refusal useful. A
   student told "not enough left" learns nothing; one told "you've got
   enough for one section" knows to paste a smaller piece, which is the
   thing they can actually do about it. It counts SINGLE-SECTION pastes,
   since that is what the advice is -- a one-part reading costs
   TASK_CREDITS.summarise with no merge on top. */
export const canAffordCredits = (state, credits) => !!state && state.remaining >= (credits || 0);

export const sectionsAffordable = (state) =>
  !state ? 0 : Math.floor(state.remaining / (TASK_CREDITS.summarise || 1));
