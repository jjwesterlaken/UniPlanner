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

/** Shown before an action when the allowance is nearly gone. */
export const ALMOST_OUT_WARNING = "This is one of the last few AI study actions you have left this month.";
