/* ==================================================================
   aiTextLimits.js — the client's copy of the allowance arithmetic

   A MIRROR, and mirrors drift. This restates constants that live in
   supabase/functions/ai-text/config.ts because a browser bundle cannot
   import from a Deno function -- the same unavoidable duplication as
   MONTHLY_MINUTES_LIMIT_HINT, and, unlike that one for its first several
   months, it has an assertion rather than a comment: a test in
   scripts/test-ai-text-function.mjs deep-equals these against the real
   config.

   WHY THE CLIENT NEEDS THEM AT ALL: so a student learns what an action
   will cost BEFORE doing the work. Typing out a full explanation and
   only then being told the allowance is gone is a worse experience than
   being told up front, and a worse advertisement for the paid tier --
   it reads as a bait rather than as a limit. The numbers here are what
   makes the warning possible without a round trip.

   The server remains the authority. Nothing here is trusted by it: the
   allowance is re-read and re-checked inside the endpoint, so a tampered
   client buys nothing but a rejection.
   ================================================================== */

export const TASK_UNITS = {
  explain: 1,
  weakspots: 1,
  practice: 2,
  summarise: 3,
  merge: 1,
};

export const MONTHLY_TEXT_UNITS_LIMIT = 150;
export const FREE_TEXT_UNITS_LIMIT = 10;
export const TEXT_TIERS = ["ai", "free"];

/** The monthly allowance for a tier. Mirrors limitForTier on the server. */
export const limitForTier = (tier) => (tier === "ai" ? MONTHLY_TEXT_UNITS_LIMIT : FREE_TEXT_UNITS_LIMIT);

/**
 * What a student can be told before they start.
 *
 * `remaining` is in units, which is exactly why this is not the shape
 * anything renders: aiTextCopy.js turns it into words. Keeping the
 * number and the wording apart is what stops "3 units left" reaching a
 * screen by accident.
 */
export function allowanceState({ tier, unitsUsed }) {
  const limit = limitForTier(tier);
  const used = Math.max(0, unitsUsed || 0);
  return {
    tier,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    fraction: limit > 0 ? Math.min(1, used / limit) : 1,
    isFree: tier !== "ai",
  };
}

/** Whether this month's allowance covers `task`, without asking the server. */
export const canAfford = (state, task) => !!state && state.remaining >= (TASK_UNITS[task] || 0);

/**
 * True when running `task` would take the last of the allowance.
 *
 * The pre-flight warning fires on this rather than on a fixed threshold,
 * so it means something specific -- "this one is the last" -- instead of
 * a vague "running low" that a student learns to ignore.
 */
export const isLastAction = (state, task) =>
  !!state && canAfford(state, task) && state.remaining - (TASK_UNITS[task] || 0) < (TASK_UNITS[task] || 1);
