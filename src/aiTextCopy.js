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
      could not print a unit even if someone wanted to.

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

  usage_exceeded: {
    title: "You've used all of this month's AI study help.",
    detail: "It resets at the start of next month. Everything else in the planner keeps working as normal.",
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

/** The wording for a failure code, falling back rather than rendering blank. */
export const describeTextFailure = (code) => AI_TEXT_FAILURES[code] || AI_TEXT_FAILURES.server_error;

/* ---------- the allowance, in words ----------

   The endpoint returns a fraction. These are the words for it. Bands
   rather than a percentage because "you have used 38% of your AI study
   help" invites arithmetic nobody wants to do about a thing they cannot
   see the units of -- and because a band is honest about a number whose
   precision is meaningless to the reader. */
export function describeAllowance(fraction) {
  const f = Math.min(1, Math.max(0, fraction || 0));
  if (f >= 1) return "You've used all of this month's AI study help.";
  if (f >= 0.9) return "You've nearly used up this month's AI study help.";
  if (f >= 0.75) return "You've used about three quarters of this month's AI study help.";
  if (f >= 0.5) return "You've used about half of this month's AI study help.";
  if (f >= 0.25) return "You've used about a quarter of this month's AI study help.";
  if (f > 0) return "You've used a little of this month's AI study help.";
  return "You haven't used any of this month's AI study help yet.";
}

/* ---------- before the work, not after ----------

   The paywall-after-the-work behaviour was inherited from AI notes
   rather than chosen, and it is the wrong default. Someone who types out
   a full explanation and only then discovers they are out has done the
   work for nothing: annoying rather than persuasive, and a worse
   advertisement for the paid tier than simply saying so up front. All of
   this is shown BEFORE the input. */

/** Shown next to an action that would take the last of the allowance. */
export const LAST_ACTION_WARNING = "This would use the last of this month's AI study help.";

/**
 * What to say when there isn't enough left to do the thing.
 *
 * A free student is told what the plan ADDS. "You can't do that" sells
 * nothing and helps nobody; the point of a small free allowance is that
 * running out is the moment the upgrade makes sense, and that moment is
 * wasted on a dead end. A paying student is told when it resets and
 * nothing else -- selling someone the plan they already have is the
 * fastest way to make an app feel like it isn't listening.
 */
export function describeExhausted(state) {
  if (state && state.isFree) {
    return {
      title: "You've used this month's free AI study help.",
      detail:
        "The AI plan gives you a lot more of it, plus recording and writing up your lectures. Your free allowance comes back at the start of next month either way.",
      action: "See what the AI plan includes",
    };
  }
  return {
    title: "You've used all of this month's AI study help.",
    detail: "It comes back at the start of next month. Everything else in the planner keeps working as normal.",
    action: null,
  };
}

/** The allowance line shown above each feature, before anything is typed. */
export const allowanceLine = (state) => describeAllowance(state ? state.fraction : 0);

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

  /* Says what it is for and what it assumes, in that order. */
  intro:
    "Paste a section of a reading you're working through and get an overview, the key points and the terms worth knowing — something to revise from once you've read it, and to check yourself against.",

  pasteLabel: "Paste the reading",
  placeholder: "Paste the section you're studying…",

  /* Where the text goes and, just as importantly, where it doesn't. */
  privacy:
    "The text is sent to the AI to do this and isn't stored anywhere — not in your planner and not on our server. Only the summary is saved.",

  /* THE PRE-FLIGHT ESTIMATE. Mandatory before any call: the cost of a
     reading is variable, and nothing else on screen would hint that a
     long one costs four times what a short one does. */
  estimate: ({ chars, chunks }) =>
    chunks > 1
      ? `That's about ${chars.toLocaleString()} characters, so it'll be done in ${chunks} parts and then combined.`
      : `That's about ${chars.toLocaleString()} characters, so it'll be done in one go.`,

  /* Refused rather than trimmed. Names the overage, because "too long"
     without a number leaves someone guessing how much to cut. */
  tooLong: ({ chars, limit }) =>
    `That's ${chars.toLocaleString()} characters and the most this can take at once is ${limit.toLocaleString()}. Do it in two halves — each one gets its own summary.`,

  /* Not enough allowance. The free-tier message NAMES THE NUMBER OF
     PARTS, because the interaction is otherwise baffling: a free
     allowance covers one short reading, and a student who has done
     nothing all month and is refused a long one will read the counter
     as broken rather than as spent. */
  cantAfford: ({ chunks, isFree }) => {
    const size = chunks > 1 ? `This reading needs ${chunks} parts.` : "This reading needs one pass.";
    if (isFree) {
      return {
        title: size,
        detail:
          "The free monthly allowance covers about one shorter reading. The AI plan covers readings this size, along with recording and writing up your lectures — and your free allowance comes back at the start of next month either way.",
        action: "See what the AI plan includes",
      };
    }
    return {
      title: size,
      detail: "There isn't enough of this month's AI study help left for it. It comes back at the start of next month.",
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
