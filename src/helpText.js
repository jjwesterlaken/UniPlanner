/* ==================================================================
   helpText.js — what each feature is for, shown behind a ? icon.

   THE RULE THIS FILE IS WRITTEN UNDER, and the reason it exists at
   all: **every topic carries a worked example, not an explanation.**
   Grace bounced off Grades not because the feature is wrong but
   because its payoff arrives weeks after its setup cost, and an
   abstract description of weighted averages does not survive contact
   with someone deciding whether to bother. A specific case with real
   numbers does.

   Each Section already has a subtitle doing a one-line job, so help
   must answer what the subtitle cannot: how do I operate this, and
   why would I. A ? that opens a thin restatement of the subtitle
   teaches people to stop tapping ?.

   SECOND RULE: SAY WHAT IT COSTS. Grades needs every assessment and
   weight entered before it can tell you anything; the AI features
   spend a real allowance; the archive needs an account and clears the
   semester off the device. Naming the cost up front is what stops
   someone discovering it three screens in and giving up.

   IF A TOPIC CANNOT BE WRITTEN WITH A CONCRETE EXAMPLE, that is a
   signal about the feature rather than about the writing — say so
   rather than shipping something vague.

   Costs nothing against the 1 MB budget: this is static copy in the
   bundle, never user data, and nothing here is stored per account.

   THE GRADES NUMBERS ARE COMPUTED, NOT ESTIMATED. They were produced
   by running the real `requiredForBand` over the example assessments
   (see test-help.mjs, which re-derives them from grades.js so the
   help can never drift from what the screen shows). The 80/60 pair
   is what the app says under its DEFAULT rounding; the 81/61 pair is
   the same course rounded down. That half-mark gap is not a detail —
   it is the clearest available explanation of why the rounding
   setting exists, which is why both appear.
   ================================================================== */

export const HELP_TOPICS = {
  semesterSetup: {
    title: "Semester setup",
    what:
      "Two settings that tell the app when your teaching weeks run, and how your university turns a raw mark into the one it records.",
    example:
      "Set the start date to the Monday of week 1, and a deadline on 15 September stops reading “due 15 September” and starts reading “due Week 9” — in the workload forecast and anywhere else the app talks about weeks. Add your mid-semester break and the numbering steps over it, so the week you come back to is the week you actually come back to.",
    cost:
      "The start date is optional and nothing breaks without it — deadlines are simply labelled by date instead of by week, which is better than a confident “Week 10” that is really week 9. The rounding rule only affects Grades: it decides whether 74.5 counts as a 75.",
  },

  grades: {
    title: "Grades",
    what:
      "Tracks what you have already earned across a course's assessments, and works out what you need on the ones you have left.",
    example:
      "Say a course is an essay worth 30%, a quiz worth 20% and an exam worth 50%. You get 75 on the essay and 60 on the quiz, so you have banked 34.5 marks out of the 50 that were available so far. Grades then tells you what the exam has to be: 80% for a Distinction, 60% for a Credit.",
    detail:
      "Those two figures assume your university rounds to the nearest whole number, so 74.5 becomes a 75. If yours rounds down instead, the same course needs 81% and 61% — half a mark of difference, and exactly what the rounding setting in Semester setup is for.",
    cost:
      "It can only do this once every assessment and its weight is entered, including the ones you have not sat yet. Until the weights add up, it is doing arithmetic on part of the picture — which is the up-front cost, and why the payoff arrives a few weeks later.",
  },

  aiNotes: {
    title: "AI lecture notes",
    what:
      "Records a lecture, has it transcribed, and turns the transcript into an overview, key points, the terms the lecturer defined, and study cards.",
    example:
      "Record a 50-minute lecture and it comes back as a summary written from what was actually said — the worked examples, the dates and figures, the lines the lecturer flagged as examinable — plus a set of study cards you tick before anything is saved. The note files itself into that course's folder.",
    cost:
      "Every recording spends minutes from a monthly allowance, and a recording shorter than three minutes still costs three. The app has to stay open while it records. Your audio is sent for transcription and deleted as soon as it has been transcribed.",
  },

  archive: {
    title: "Semester archive",
    what:
      "Boxes up a finished semester and stores it in your account, so the new one starts empty without you losing anything.",
    example:
      "Archive “2026 · Semester 1” and everything in it — notes, study cards, readings, grades — moves into a single record in your account. The semester on your device starts fresh. Your study streak carries over, your study minutes reset, and the archived semester's grades and AI lecture notes stay readable. You can restore the whole thing later.",
    cost:
      "It needs an account, because the archive is stored there rather than on the device. Nothing is removed from your device until the archive has been stored safely. Restoring needs the current semester to be empty first, so archive it before you bring an old one back.",
  },
};

/** The ids a screen may ask for. Used by the tests, not by the UI. */
export const HELP_TOPIC_IDS = Object.keys(HELP_TOPICS);
