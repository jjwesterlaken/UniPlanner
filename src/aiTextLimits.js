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
  /* On gpt-5.6-luna at a 4,000-token ceiling: ruled 25 September 2026. */
  essay: 9,
  /* One example rewrite of one passage, on the same model. */
  rewrite: 3,
  /* Marking criteria from up to four photos: priced as a photo batch
     (PHOTO_BATCH_CREDITS below), by ruling. */
  criteria: 18,
};

/* MAX_INPUT_CHARS.essay in ai-text/config.ts: the draft and the
   criteria together. Mirrored so the panel refuses a paste the server
   would answer with a 413; test-ai-text-function.mjs compares the two. */
export const ESSAY_MAX_CHARS = 24_000;

/* A MIRROR, and the mirror is the allowed form here: this is a browser
   module and the figure is derived in Deno, from the vision model's own
   rates and a MEASURED token count, in ai-text/config.ts. What is never
   allowed is a mirror with a comment instead of an assertion, so
   test-readings.mjs compares the two.

   IT USED TO BE HELD at one text chunk, because the honest weight on
   gpt-4o-mini was ~34 credits and at that price a 16-page reading is
   most of a month. Both gates in COST-MODEL.md 12.7 ran on 16 September
   2026; the photo path is gpt-5.4-mini and the MEASURED bill for a
   batch is 18 (12.9 and 12.11).

   The number a student meets: four photographed pages cost 18 credits,
   about as much as an 18-minute lecture, and a 16-page reading is 72.
   THAT IS THE EXPENSIVE PATH AND THE SCREEN SAYS SO -- the same reading
   PASTED is 9, so the comparison is put in front of the student before
   they choose rather than discovered afterwards. photoVsPasteLine()
   below is the one place that sentence is built.

   IT NO LONGER FITS INSIDE THE 60-CREDIT TRIAL, and that is a rule
   change rather than a regression: credits.ts used to say the trial
   must demonstrate a whole photographed READING, which only the model
   that fabricates could afford. A trial demonstrates ONE BATCH, which
   18 of 60 credits buys with room for the lecture recording that is
   the other half of what is being sold. */
export const PHOTO_BATCH_CREDITS = 18;

/* THE TIERS, mirrored from _shared/credits.ts.

     free             60 credits, ONCE EVER
     ai              900 credits per month     (Study AI)
     ai_max        3,000 credits per month     (Study AI Max)

   PLUS WAS DROPPED BEFORE IT WAS EVER SOLD (Jared, Phase 0) — it
   would have charged for sync, which is gated on a session rather
   than a tier and is promised free in the submitted 1.0.0 store
   listing. The reasoning lives with the numbers, in credits.ts.

   TWO SHAPES, NOT THREE NUMBERS. `perMonth: false` means the number is a
   LIFETIME total, held on the account rather than on a month — a
   different counter, not a smaller limit. Every screen that says "this
   month" has to branch on it, because telling a trial student their
   allowance resets in November is a support ticket and an angry one. */
export const TIERS = ["free", "ai", "ai_max"];
export const TRIAL_TIERS = ["free"];
export const isTrialTier = (tier) => TRIAL_TIERS.includes(tier);
export const TRIAL_CREDITS = 60;

/* MIRRORS _shared/credits.ts's MAX_FREE_PHOTO_PAGES, asserted equal by
   test-readings.mjs. Photographed pages a trial account may ever send:
   two batches, so the demonstration is a demonstration and ends.

   THE CLIENT COPY EXISTS SO THE REFUSAL ARRIVES BEFORE THE WORK, the
   same courtesy as canAfford — a student who has added twelve photos
   and pressed the button has already done the work of photographing
   twelve pages. The SERVER is what enforces it; this only says so
   earlier. */
export const MAX_FREE_PHOTO_PAGES = 8;

/**
 * Pages this account may still photograph, or null when uncapped.
 *
 * `null` MEANS UNCAPPED AND IS NOT ZERO, which is the distinction the
 * caller has to keep: a paid tier and a trial account with nothing left
 * are opposite states, and a helper that answered 0 for both would
 * refuse every paid student. An UNKNOWN allowance is also null — a
 * failed read must not read as a cap, the fetchNote rule again.
 */
export const freePhotoPagesLeft = (state) => {
  /* `allowanceForTier(...).perMonth`, NOT `isTrialTier`: the two
     disagree on an unknown tier, which the allowance deliberately
     treats as the trial. The server decides the same way. */
  if (!state || state.unavailable || allowanceForTier(state.tier).perMonth) return null;
  return Math.max(0, MAX_FREE_PHOTO_PAGES - (Number(state.photoPagesUsed) || 0));
};

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

/* ---------- the two paths ----------

   PHOTOGRAPHING IS THE EXPENSIVE PATH AND THE STUDENT HAS TO KNOW
   BEFORE THEY CHOOSE. The sentence that says so is `photoVsPasteLine`
   in readingChunks.js, NOT here, and the reason is a real constraint
   rather than taste: it needs PHOTOS_PER_CHUNK and CHUNK_MAX_CHARS,
   which live there, and that module already imports the two prices
   from this one. Putting it here would make the cycle. */
export const photoUnitCredits = () => PHOTO_BATCH_CREDITS;
export const pasteUnitCredits = () => TASK_CREDITS.summarise || 0;
