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
      "Every recording spends credits from a monthly allowance — a credit is about a minute of recorded lecture, and a recording shorter than three minutes still costs three. The app has to stay open while it records. Your audio is sent for transcription and deleted as soon as it has been transcribed.",
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

  studyCards: {
    title: "Study cards",
    what:
      "Shows you a card, you try to recall the answer, and you say how it went. What you say decides when you see it again.",
    example:
      "Rate a card Again and it comes back in this same session — a card you just missed is not one to leave until tomorrow. Good sends it to tomorrow, then three days, then eight; Easy sends it three days out, then eleven, then forty-two. So a card you keep getting right disappears for weeks, and the twelve you keep missing are what fills your session.",
    detail: [
      "“Review what's due” deliberately mixes cards from all your courses together instead of doing one subject at a time. That feels harder, and that is the point — switching between topics is what makes recall stick. Drill a single course when you are cramming for one exam, and interleave the rest of the time.",
      "Practice mode exists for the night before an exam, when nothing is “due” because you reviewed it all yesterday. It ignores the schedule and runs every card for a course — and it does NOT change when those cards next come up, so using it costs you nothing.",
      "“Explain it back” during a review asks you to say the answer in your own words and marks it. It is the one part of the review that spends your monthly AI allowance.",
    ],
    cost:
      "Rating cards costs nothing and works offline. Only “Explain it back” spends anything: on the free plan its allowance covers about ten of them a month. A card rated Again also gets slightly harder to graduate, which is intended — it is the app noticing you find that one difficult.",
  },

  weakSpots: {
    title: "Weak spots",
    what:
      "Collects the cards you have missed more than once, so the pattern in what you are forgetting is visible rather than something you have to notice yourself.",
    example:
      "Miss “oxaloacetate” in two separate sessions and it appears here. One bad session does not put a card on the list — it takes at least two misses before there is a pattern rather than a bad night, and the list shows up to eight topics at a time.",
    detail: [
      "The AI explanation of WHY a group of topics keeps slipping is optional and separate: it reads the topics you are missing and looks for what connects them.",
    ],
    cost:
      "The list itself is free and needs nothing but a couple of review sessions. The AI explanation spends from your monthly allowance — the same as one “Explain it back”, so about ten a month on the free plan.",
  },

  practiceQuestions: {
    title: "Practice questions",
    what:
      "Writes short questions from the study cards you already have, so you are tested on your own material rather than something generic.",
    example:
      "With twenty cards saved for BIOL120, ask for a set and you get questions drawn from those twenty — then you answer them and they are marked. Your answers are kept so weak spots can see what you keep missing.",
    cost:
      "It does nothing at all until you have study cards: it writes questions FROM them, so an empty course produces nothing. A set costs about double an “Explain it back” — on the free plan that is roughly five sets a month.",
  },

  studyTimer: {
    title: "Study timer",
    what:
      "Times a study session against one course, so “Your studying” can show where the hours actually went.",
    example:
      "Pick BIOL120, start it before you sit down, and stop it when you get up. Forty minutes lands against BIOL120 for today. Leave it running by accident and it stops counting at four hours rather than logging fourteen.",
    cost:
      "A run of a few seconds is not recorded — the timer keeps its state and tells you there was nothing to log, rather than silently throwing the session away. Nothing else about it costs anything, and it works offline.",
  },

  yourStudying: {
    title: "Your studying",
    what:
      "Your streak, the minutes you have logged per course, and the cards you have reviewed — for the semester you are looking at.",
    example:
      "Study on Monday, Tuesday and Wednesday and the streak reads 3. Miss Thursday and it reads 0 again on Friday — a streak is consecutive days, so it lapses rather than pausing.",
    detail: [
      "These are per semester, which matters when you archive one: the minutes and card counts reset with the new semester, and your STREAK carries over. That is deliberate — minutes are about the courses you just finished, a streak is about you.",
    ],
    cost:
      "Nothing, and it works offline. Only the last six weeks of daily detail are kept, which is what stops the figures growing without limit; the totals and the streak are not trimmed.",
  },

  classNotes: {
    title: "Class notes",
    what:
      "Where study cards come from. A note here is a term and what it means, filed against a course and a week — and that pair is what the review session shows you.",
    example:
      "Add “Oxaloacetate — the four-carbon acceptor that starts each turn of the cycle” under BIOL120, week 3. It becomes a card you will be shown, it becomes a topic the exam plan can schedule, and it becomes material the practice questions can be written from.",
    cost:
      "Typing them is the cost, and it is the up-front one: nothing in the Study tab has anything to show until some exist. AI lecture notes can create them for you from a recording if you would rather not type.",
  },

  exams: {
    title: "Exams",
    what:
      "A countdown to each exam, and a day-by-day plan of which topic to study when.",
    example:
      "An exam in nine days with five topics gets a session a day: each topic once, then the rounds repeat, and the last day before the exam is left for reviewing everything. With only two days for those same five topics there is NO review day — spending one of two days revising what you never studied is worse than covering a second topic.",
    cost:
      "It needs the exam entered with a date, and it needs study cards for that course — the topics in the plan ARE your cards' terms, so a course with no cards gets a countdown and no plan. The plan is worked out fresh each time rather than saved, so changing the date or adding cards changes it immediately.",
  },
};

/** The ids a screen may ask for. Used by the tests, not by the UI. */
export const HELP_TOPIC_IDS = Object.keys(HELP_TOPICS);
