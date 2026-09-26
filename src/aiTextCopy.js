/* ==================================================================
   aiTextCopy.js — everything the text AI features say to a student

   Separate from the logic for the same reason aiNotesCopy.js is: this
   wording gets reworked, and it should never mean touching a handler to
   do it.

   TWO RULES THAT ARE NOT STYLE PREFERENCES:

   1. NEVER SAY "UNITS". The allowance is weighted internally -- a
      practice set costs twice what an explanation does -- and that
      weighting is ours to reason about, not a student's. They get a
      proportion in plain words. The endpoint enforces this at the
      boundary by returning a fraction and never a count, so this module
      could not print a raw count even if someone wanted to.

   2. IF WE CHARGED, SAY SO. A request that fails after the provider has
      run has already cost us the tokens, so it costs the student their
      allowance. Telling them only "that didn't work" while quietly
      taking the allowance is how a support ticket becomes a chargeback.
      This is the same rule the AI notes failure screen follows when
      transcription succeeds and summarising doesn't, and it exists here
      for exactly the same reason.
   ================================================================== */

/* Failures come back as a CODE, and the wording lives here. The two
   post-provider outcomes are deliberately different codes rather than
   one: "we called the AI and it broke" and "we called the AI, paid for
   it, and couldn't use what came back" are different facts, and only
   one of them costs the student anything. */
export const AI_TEXT_FAILURES = {
  /* The call itself failed -- nothing was generated, so nothing was
     charged. Saying so is worth a sentence: a student who has just been
     told something failed reasonably assumes it cost them. */
  ai_failed: {
    title: "The AI couldn't finish that.",
    detail: "Nothing was generated, so this hasn't used any of your AI study help. Please try again.",
  },

  /* The call ran, we were charged for the tokens, and what came back
     couldn't be used. The student loses allowance for a result they
     never saw, and that has to be said before they notice it. */
  ai_failed_charged: {
    title: "The AI answered, but the answer came back unusable.",
    detail:
      "We were charged for that attempt, so it has used some of your AI study help — we'd rather tell you than have you find out from the number. Trying again usually works.",
  },

  /* ESSAY FEEDBACK IS NOT SWITCHED ON YET: the server refuses it until
     the no-writing thresholds are measured. Nothing was sent to anyone
     and nothing was charged, and both are said. */
  essay_unavailable: {
    title: "Essay feedback isn't available yet.",
    detail: "Nothing was sent and nothing was charged.",
  },

  /* THE FEEDBACK OFFERED WRITING, which the COMMENTS must never do (an
     example rewrite is a separate request the student makes), so it
     was not shown. BOTH HALVES, the pages_unreadable rule: the attempt
     was charged, because the tokens were generated, and a retry charges
     again. And it is not the student's fault, which is said. */
  writing_refused: {
    title: "That feedback came back in a form we don't show.",
    detail:
      "It started suggesting wording for your essay rather than pointing at what to work on, so we stopped it. " +
      "That attempt was charged, and trying again will be charged again. Nothing you did caused this.",
  },

  /* THE EXAMPLE REWRITE IS OFF until its scope limits are measured, and
     the server refuses before anything is spent. */
  rewrite_unavailable: {
    title: "Example rewrites aren't available yet.",
    detail: "Nothing was sent and nothing was charged.",
  },

  /* ONE PASSAGE AT A TIME, refused before anything was spent. */
  span_too_long: {
    title: "That passage is too long for an example.",
    detail: "An example works on one sentence or one paragraph at a time. Nothing was sent and nothing was charged.",
  },

  /* THE EXAMPLE WENT OUTSIDE ITS PASSAGE, or added something that wasn't
     in the essay, so it was not shown. Both halves: charged, and a retry
     charges again. */
  rewrite_refused: {
    title: "That example went outside your passage, so we didn't show it.",
    detail:
      "It reworked more than the passage you picked, or added something that isn't in your essay. " +
      "That attempt was charged, and trying again will be charged again. Nothing you did caused this.",
  },

  /* The legibility refusal on photographed pages. BOTH HALVES, by
     ruling: this attempt used allowance (output was generated -- the
     refusal IS the output), and resubmitting the retaken pages will
     charge again, as its own smaller batch. A student retaking one page
     of eight must know the resubmit costs before they send it. The
     page numbers are interpolated by the panel, which is the only place
     that knows them. */
  pages_unreadable: {
    title: "Some pages couldn't be read clearly.",
    detail:
      "Rather than guess at a blurry page, the AI stopped. That attempt used some of your AI study help, " +
      "and summarising the retaken pages will use more — they'll go as their own smaller batch. " +
      "Retake the pages named above in better light, closer up, and try again.",
  },

  /* THE ONLY ENTRY HERE THAT IS A FUNCTION, because it is the only one
     whose wording depends on the tier: a trial account's credits do not
     come back, and this sentence used to promise they did. A function
     rather than a second map, so `describeTextFailure` has one branch
     and every other entry stays a plain object. */
  usage_exceeded: (state) => ({
    title: `You've used all of ${allowanceNoun(state)}.`,
    detail: [resetsSentence(state), "Everything else in the planner keeps working as normal."]
      .filter(Boolean)
      .join(" "),
  }),

  /* THE TRIAL'S PHOTO CAP, and it is deliberately not worded as a
     failure. Nothing went wrong and nothing was charged: the free plan
     covers a demonstration of photographed pages and the demonstration
     is over. So the sentence names the CHEAPER PATH THAT STILL WORKS
     rather than only the door that closed — pasting is not capped and
     costs a sixth as much, which is the thing the student can do in the
     next thirty seconds.

     The server's own message names how many pages are left, because it
     is the side that knows; this is the fallback for a client that has
     no number. */
  free_photo_limit: {
    title: "That's more photographed pages than the free plan covers.",
    detail:
      "Pasting the text works instead — it isn't capped and costs much less per page. " +
      "A paid plan photographs as many pages as your credits cover.",
  },

  no_access: {
    title: "AI study help isn't on your account.",
    detail: "These features are part of the AI plan.",
  },

  /* Found by the test that checks every code the endpoint can return has
     wording -- it had none, so a session that expired mid-request would
     have rendered the server_error fallback and told the student
     "nothing was charged" about a request that never ran. True by
     accident is not the same as true. */
  unauthenticated: {
    title: "You've been signed out.",
    detail: "Sign in again and try that once more. Nothing was charged.",
  },

  /* The boundary refusal from aiConsentState.js. It cannot be reached
     from a screen — every AI control is replaced by the consent notice
     while this is true — so a student who sees it has an app whose
     consent record and whose screens disagree, and a reload is what
     actually fixes that. No period word: consent has nothing to do with
     an allowance. */
  consent_required: {
    title: "You haven't agreed to the AI features yet.",
    detail: "Nothing was sent and nothing was charged. Open the AI tab to read what is sent and to who, then agree there.",
  },

  bad_request: {
    title: "That didn't look right.",
    detail: "Please try again.",
  },

  too_long: {
    title: "That's too long to send at once.",
    detail: "Shorten it, or pick fewer cards, and try again.",
  },

  server_error: {
    title: "Something went wrong.",
    detail: "Nothing was charged. Please try again in a moment.",
  },
};

/**
 * The wording for a failure code, falling back rather than rendering blank.
 *
 * `state` is optional and only `usage_exceeded` reads it. Passing none
 * costs the period sentence, never correctness -- see allowanceNoun.
 */
export const describeTextFailure = (code, state) => {
  const entry = AI_TEXT_FAILURES[code] || AI_TEXT_FAILURES.server_error;
  return typeof entry === "function" ? entry(state) : entry;
};

/* ---------- the allowance, in words ----------

   The endpoint returns a fraction. These are the words for it. Bands
   rather than a percentage because "you have used 38% of your AI study
   help" invites arithmetic nobody wants to do, and because a band is
   honest about a number whose precision is meaningless to the reader.

   THE CURRENCY COLLAPSE DID NOT MOVE THIS. Credits are sayable where
   units were not — a credit is a minute of recorded lecture — and the
   place a student meets the number is the PRE-FLIGHT ESTIMATE, which
   can say what an action will cost before they take it. A running
   total is a different job, and a band still does it better than a
   figure whose denominator depends on a tier this endpoint does not
   know has just changed.

   THE PERIOD IS PART OF THE CLAIM, not decoration, and this file got
   it wrong for a release. A trial tier's 60 credits are once ever
   (`perMonth: false` — see aiTextLimits.js), so "this month's" is
   false for Free and Plus, and false in the friendly-looking
   direction: a student who reads "comes back at the start of next
   month" waits for a reset that is not coming. aiNotes.jsx branched
   correctly from the day tiers landed; this module did not, and the
   guard that was supposed to catch it greped helpText.js.

   ONE HELPER, NOT A TERNARY PER SENTENCE. Eleven sentences in this
   file carry the period. Eleven independent branches is eleven
   chances to get one wrong, and the wrong one is the one nobody
   reads. `allowanceNoun` and the two RESET constants are the only
   things here that know what a period is; everything else
   interpolates them. */

/* THREE ANSWERS, NOT TWO, and the third is the one that matters.

   "Trial", "monthly" and DON'T KNOW are distinct — the failure copy
   below is rendered from a bare error code and may have no state at
   all. Reading an absent state as "monthly" is the fetchNote mistake
   in a sentence: treating no evidence as a definitive answer. So an
   unknown period says nothing about a period, which is a true
   sentence in every case. Fail towards not promising. */
const isTrial = (state) => !!state && state.perMonth === false;
const isMonthly = (state) => !!state && state.perMonth === true;

/** The allowance as a noun phrase: the ONE place "this month" is decided. */
const allowanceNoun = (state) =>
  isTrial(state) ? "your free AI study help" : isMonthly(state) ? "this month's AI study help" : "your AI study help";

/** What happens next, or nothing at all when we cannot know. */
const resetsSentence = (state) => (isTrial(state) ? TRIAL_DOES_NOT_RESET : isMonthly(state) ? MONTHLY_RESETS : "");

/* The two sentences about what happens next. Constants because each is
   said in two places (the exhausted notice and the readings refusal),
   and two copies of a sentence is two chances for one to stay wrong. */
const TRIAL_DOES_NOT_RESET =
  "Your free credits are a one-off trial rather than a monthly allowance, so they don't reset.";
const MONTHLY_RESETS = "It comes back at the start of next month.";

/**
 * The allowance line, in words. Takes the whole state rather than the
 * fraction, because the PERIOD is as much a part of the sentence as the
 * proportion and a bare number cannot carry it.
 */
export function describeAllowance(state) {
  const of = allowanceNoun(state);
  const f = Math.min(1, Math.max(0, (state && state.fraction) || 0));
  if (f >= 1) return `You've used all of ${of}.`;
  if (f >= 0.9) return `You've nearly used up ${of}.`;
  if (f >= 0.75) return `You've used about three quarters of ${of}.`;
  if (f >= 0.5) return `You've used about half of ${of}.`;
  if (f >= 0.25) return `You've used about a quarter of ${of}.`;
  if (f > 0) return `You've used a little of ${of}.`;
  return `You haven't used any of ${of} yet.`;
}

/* ---------- before the work, not after ----------

   The paywall-after-the-work behaviour was inherited from AI notes
   rather than chosen, and it is the wrong default. Someone who types out
   a full explanation and only then discovers they are out has done the
   work for nothing: annoying rather than persuasive, and a worse
   advertisement for the paid tier than simply saying so up front. All of
   this is shown BEFORE the input. */

/** Shown next to an action that would take the last of the allowance. */
export const lastActionWarning = (state) => `This would use the last of ${allowanceNoun(state)}.`;

/**
 * What to say when there isn't enough left to do the thing.
 *
 * A trial student is told what the plan ADDS. "You can't do that" sells
 * nothing and helps nobody; the point of a small free allowance is that
 * running out is the moment the upgrade makes sense, and that moment is
 * wasted on a dead end. A paying student is told when it resets and
 * nothing else -- selling someone the plan they already have is the
 * fastest way to make an app feel like it isn't listening.
 *
 * The trial branch says the credits do NOT come back, in as many words.
 * It used to say the opposite, which was the worst available answer:
 * the student has just run out, is being sold something, and is being
 * reassured about a refill that does not exist.
 */
export function describeExhausted(state) {
  if (isTrial(state)) {
    return {
      title: `You've used ${allowanceNoun(state)}.`,
      detail: `The AI plan gives you a lot more of it, plus recording and writing up your lectures. ${TRIAL_DOES_NOT_RESET}`,
      action: "See what the AI plan includes",
    };
  }
  return {
    title: `You've used all of ${allowanceNoun(state)}.`,
    detail: [resetsSentence(state), "Everything else in the planner keeps working as normal."].filter(Boolean).join(" "),
    action: null,
  };
}

/** The allowance line shown above each feature, before anything is typed. */
export const allowanceLine = (state) => describeAllowance(state);

/* ==================================================================
   Summarising a reading

   A THIRD RULE, and it is not a style preference either.

   EVERY SENTENCE HERE DESCRIBES STUDY, NEVER SUBSTITUTION. "Summarise a
   reading to revise it" is the product. "Skip the reading" is not --
   not here, not in an empty state, not in a store listing, not in the
   consent text.

   This is a legal position as much as a tonal one. What makes the
   feature defensible is that it is a private-study tool a student
   points at material they already have lawful access to; copy that
   suggests replacing the material undermines exactly that. So the
   wording assumes the student has done or will do the reading, and the
   output is framed as a companion to it.

   scripts/test-readings.mjs greps this module for the substitution
   framings. A blunt guard -- but so was "every code has wording", and
   that found a real gap within the hour.
   ================================================================== */

export const READING_COPY = {
  title: "Summarise a reading",

  /* The collapsed line on the reading row itself. Short, because it
     sits under "pp. 89-112" and must not compete with it. */
  rowAction: "Summarise this",
  summarisedLink: "Summarised — open the notes",

  /* Says what it is for and what it assumes, in that order. */
  intro:
    "Paste a section of a reading you're working through and get an overview, the key points and the terms worth knowing — something to revise from once you've read it, and to check yourself against.",

  pasteLabel: "Paste the reading",
  placeholder: "Paste the section you're studying…",

  /* Where the text goes and, just as importantly, where it doesn't. */
  privacy:
    "The text is sent to the AI to do this and isn't stored anywhere — not in your planner and not on our server. Only the summary is saved.",

  /* The same promise for photographed pages, made separately because it
     is a different kind of material -- a photo can capture more than
     the words -- and the student should read it with the photos in
     hand. The honest limit is stated up front: the notes are only as
     good as the photo. */
  photosLabel: "Or photograph the pages",
  photosPrivacy:
    "Photos are sent to the AI to read the pages and aren't stored anywhere — not in your planner and not on our server. Only the summary is saved.",
  photosQuality:
    "The notes can only be as good as the photos — good light, straight on, one page per photo works best.",
  /* THE ESTIMATE NAMES CREDITS NOW, AND THE REASON IS THAT PARTS HID
     THE PRICE. "Both numbers in parts, never units" was written when a
     photo batch and a text chunk cost the SAME, so parts really were
     the whole story. They are not: a batch is 18 credits and a chunk
     is 3, which means eight photographed pages and eight pages of
     pasted text are both "2 parts" and differ sixfold in what they
     cost. A currency that cannot express a sixfold difference is not
     hiding an internal weight any more, it is hiding a price.

     The banned word was always "units" — an internal weight that meant
     nothing to anybody — and credits are sayable, because a credit is
     a minute of recorded lecture. Parts stay: they say how the work
     will be done, which is a different question from what it costs. */
  photosEstimate: ({ count, chunks, credits }) =>
    chunks > 1
      ? `${count} page${count === 1 ? "" : "s"} — ${credits} credits, done in ${chunks} parts and then combined.`
      : `${count} page${count === 1 ? "" : "s"} — ${credits} credits, done in one go.`,
  /* THE TRIAL CAP, NAMING WHAT IS LEFT rather than only that there is
     a limit. Three shapes, because "you have 4 left" and "you have
     none left" are different things to do next, and a sentence that
     said "4" when the answer is 0 would send somebody back to
     photograph four more pages. It points at pasting every time:
     uncapped, a sixth the price, and available right now. */
  freePhotoCap: ({ left, cap, count }) =>
    left > 0
      ? `That's ${count} pages and your free plan has ${left} left of ${cap} photographed pages. ` +
        `Send ${left} or fewer, or paste the text instead — pasting isn't capped and costs much less.`
      : `Your free plan covers ${cap} photographed pages and you've used them. ` +
        `Pasting the text still works, isn't capped and costs much less per page.`,

  photosTooMany: ({ count, max }) =>
    `That's ${count} photos and the most this can take is ${max}. Do it in two goes — each gets its own summary.`,
  unreadablePages: (pages) =>
    `The AI couldn't clearly read photo${pages.length === 1 ? "" : "s"} ${pages.join(", ")}.`,

  /* THE PRE-FLIGHT ESTIMATE. Mandatory before any call: the cost of a
     reading is variable, and nothing else on screen would hint that a
     long one costs four times what a short one does. */
  estimate: ({ chars, chunks, credits }) =>
    chunks > 1
      ? `That's about ${chars.toLocaleString()} characters — ${credits} credits, done in ${chunks} parts and then combined.`
      : `That's about ${chars.toLocaleString()} characters — ${credits} credits, done in one go.`,

  /* Refused rather than trimmed. Names the overage, because "too long"
     without a number leaves someone guessing how much to cut. */
  tooLong: ({ chars, limit }) =>
    `That's ${chars.toLocaleString()} characters and the most this can take at once is ${limit.toLocaleString()}. Do it in two halves — each one gets its own summary.`,

  /* Not enough allowance. THE SPECIFIC SITUATION, not a generic
     refusal: how big this reading is, how much is left, and — the part
     that makes it useful — whether a smaller paste would still work.

     BOTH NUMBERS ARE IN PARTS. That is a deliberate reading of "say the
     real numbers": parts are the currency this feature already shows
     ("done in 3 parts"), a student can act on them, and stating the
     allowance the same way keeps rule 1 at the top of this file intact.
     Saying "this needs 14 credits and you have 7" is now sayable —
     a credit means a minute of recorded lecture — but it is still the
     wrong sentence here, because what a student can DO about a refusal
     is paste a shorter piece, and parts are what that advice is in.

     Without this a student who has spent nothing yet, pastes a long
     reading and is refused reads the counter as broken rather than as
     spent — the interaction is baffling precisely because ten credits
     is ONE shorter reading, not four of anything. */
  cantAfford: ({ chunks, sectionsLeft, perMonth }) => {
    const state = { perMonth };
    const size =
      chunks > 1
        ? `This reading is ${chunks} parts, and there's enough of ${allowanceNoun(state)} left for ${
            sectionsLeft === 0 ? "none of them" : sectionsLeft === 1 ? "one" : sectionsLeft
          }.`
        : `There isn't enough of ${allowanceNoun(state)} left for this reading.`;

    /* The actionable half. If a single section still fits, saying so is
       worth more than anything else on the screen: it turns a dead end
       into a smaller paste. */
    const smaller =
      sectionsLeft > 0
        ? "A section at a time still fits — paste a shorter piece and each one gets its own summary."
        : "";

    if (isTrial(state)) {
      return {
        title: size,
        detail: [
          smaller,
          `The AI plan covers readings this size in one go, along with recording and writing up your lectures. ${TRIAL_DOES_NOT_RESET}`,
        ]
          .filter(Boolean)
          .join(" "),
        action: "See what the AI plan includes",
      };
    }
    return {
      title: size,
      /* Nothing about the plan. Selling someone what they already have
         is the fastest way to make an app feel like it isn't listening. */
      detail: [smaller, resetsSentence(state)].filter(Boolean).join(" "),
      action: null,
    };
  },

  /* THE MERGE FAILED, and the sections did not.

     Each section was summarised and each of those calls was charged;
     the combining step is the only thing that failed and it is the only
     thing that wasn't. Saying exactly that is the same rule the AI
     notes failure screen follows -- if we charged, say so, and if we
     didn't, say that too. */
  mergeFailed: {
    title: "Your sections are here, but we couldn't combine them.",
    billing:
      "Each section was summarised and counted; combining them is the part that failed, and that part hasn't been counted. You have everything the AI produced.",
    detail: "They're saved in order, so they read as one set of notes. Summarising the reading again would start from scratch.",
  },

  /* The merge ran, was charged for, and came back unusable. Different
     fact, different sentence: the student paid for the combining step
     and did not get it. */
  mergeCharged: {
    title: "Your sections are here. Combining them came back unusable.",
    billing:
      "We were charged for that last step, so it has used a little of your AI study help — we'd rather tell you than have you find out from the number.",
    detail: "The sections themselves are fine and are saved in order.",
  },

  saveLabel: "Save to Notes",
  runLabel: "Summarise it",
};
