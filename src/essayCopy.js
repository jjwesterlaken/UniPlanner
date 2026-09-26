/* ==================================================================
   essayCopy.js — every word the essay panel shows a student

   ALL OF IT IS GRACE'S. This is a working draft, written to the rulings
   so the feature can be built and tested, and it is expected to be
   reworded. Nothing here is load-bearing for logic: the panel and
   essayFeedback.js read these strings and never test them, so a round
   of notes is a round of editing this one file.

   THREE RULES THE WORDING IS HELD TO, each by a test:

   - NEVER A PREDICTION (ESSAY-FEEDBACK.md §4). "Reads like", against
     "the criteria you pasted", and the disclaimer names the three
     things it cannot see. PREDICTION_PATTERNS sweeps every string.
   - NEVER AN OFFER TO WRITE (§3's wording guard). The comments point at
     what to work on; they do not offer to do the work.
   - NOT "USE AT YOUR OWN RISK" (Jared, 18 September 2026). The opt-in
     says it can be wrong and whose judgement counts. It disclaims no
     responsibility: the Australian Consumer Law line governs.
   ================================================================== */

import { SEVERITY_LEVELS } from "./essayPoints.js";

/* One sentence, shown in the opt-in and under the ? help, so the two
   cannot say different things about it. The result lives in memory
   only (essayHold.js): a reload loses it, and saving is how to keep it. */
const RELOAD_LOSES = "A result you haven't saved is lost if the app reloads or closes, so tap Save to notes if you want to keep it.";

export const ESSAY_COPY = {
  reloadLoses: RELOAD_LOSES,
  rowAction: "Get feedback on a draft",

  /* The AI tab's draft card: one optional course, then the draft. */
  entry: {
    title: "Feedback on a draft",
    subtitle: "Paste an essay before you submit it and see what to work on",
    courseLabel: "Course (optional)",
    where: "The feedback is kept under this course in Courses → Grades, so if you enter your mark there later we can ask how we did.",
  },
  /* The assessment a run from the AI tab is filed under. */
  placeholderTitle: (date) => `Essay draft, ${date}`,
  rowNoWeight: "no weight",
  noWeightsCourse: "Nothing here has a weight yet, so there's nothing to work out. Add the unit's assessments with their weights above.",

  /* Marking criteria from a photo, on the criteria box. The essay stays
     paste-only; this fills the criteria box with editable text. */
  criteriaPhoto: {
    button: "Photograph your criteria",
    working: "Reading your criteria…",
    cost: (credits, photos) =>
      `Up to ${photos} photos cost ${credits} credits. A screenshot counts as a photo. Pasting the criteria costs nothing extra.`,
    done: "Check this against the original and fix anything it got wrong: the feedback is judged against exactly what's in the box.",
    tooMany: (photos) => `Up to ${photos} photos at a time. Send the rest as a second batch.`,
    unreadable: (pages) => {
      const list = [].concat(pages);
      const one = list.length === 1;
      return `${one ? "Photo" : "Photos"} ${list.join(", ")} couldn't be read clearly. That attempt used some of your AI study help. Retake ${one ? "it" : "them"} in better light, closer up, and try again.`;
    },
  },

  /* The ? on the panel. Three steps, in the order a student meets them. */
  help: {
    title: "essay feedback",
    steps: [
      "Paste your draft and the marking criteria before you submit.",
      "You get pointed at problems, most important first, and can ask for an example rewrite of one passage it pointed at.",
      "When your mark comes back, tell us how we did.",
    ],
    note: RELOAD_LOSES,
  },
  panelTitle: "Feedback on your draft",
  essayLabel: "Your draft",
  essayHint: "Paste the essay as it stands. It is sent exactly as written, so take out your name and student ID first if you would rather not send them.",
  criteriaLabel: "Marking criteria",
  criteriaHint: "Paste the rubric or marking criteria for this assessment. The feedback is only as good as these.",
  cost: (credits) => `One read costs ${credits} credits.`,
  go: "Read my draft",
  close: "Close",
  tooLong: (total, limit) => `Your draft and criteria come to ${total.toLocaleString()} characters, and the limit is ${limit.toLocaleString()}. Try a section at a time.`,
  needBoth: "Paste both your draft and the marking criteria.",

  optIn: {
    title: "Before you use essay feedback",
    bullets: [
      "This is new, and it can be wrong or miss things. Your marker's judgement is the one that counts.",
      "Your unit's rules on AI help apply, and they differ between units. Check yours before you use this on assessed work.",
      "It points at what to work on. If you ask, it can show an example rewrite of one sentence or paragraph it pointed at, next to yours. Nothing is put into your essay, and what you use is yours to disclose under your unit's rules.",
      "We're checking it against real marks. When a mark comes back for an essay you used it on, we'll ask once how we did, and you can skip that.",
      "After each read we'll ask whether it was useful. That's how we find out what to fix.",
      RELOAD_LOSES,
    ],
    accept: "Turn on essay feedback",
    decline: "Not now",
  },

  /* §4's proposed wording, verbatim. The band never renders without it. */
  bandLine: (band) => `Against the criteria you pasted, this reads like a ${band}.`,
  disclaimer:
    "This is the AI's reading of the criteria you gave it — not a prediction of your mark. It hasn't seen your unit's standards, your cohort, or how your marker weighs things, and it can be wrong about all three. Use it to find what to work on, not to decide whether you're done.",
  noBand: "Your criteria don't name bands, so there's no overall reading — just the points below.",
  noPoints: "It didn't find anything against these criteria worth raising.",

  severityHeading: {
    fundamental: "Worth working on first",
    minor: "Smaller things",
    outside: "Outside the criteria",
  },

  codeLabels: {
    "claim-without-evidence": "A claim without support",
    "evidence-without-claim": "Evidence without a point",
    "unsupported-generalisation": "A generalisation that goes too far",
    contradiction: "Two parts disagree",
    "unclear-relevance": "Unclear how this connects",
    "missing-counterargument": "An objection not dealt with",
    "unattributed-source": "A source not credited",
    repetition: "Said more than once",
    "structure-unsignposted": "Hard to follow where this is going",
    "undefined-term": "A term that needs defining",
    conventions: "Spelling, grammar or referencing",
    "off-criterion": "Not something these criteria ask for",
  },
  codeLabel: (code) => ESSAY_COPY.codeLabels[code] || "Something to look at",

  /* THE EXAMPLE REWRITE (Jared, 18 September 2026): one passage, on
     request, side by side, never inserted. The wording says what it is
     and whose rules govern using it, and never offers to write the
     essay. */
  rewrite: {
    button: "Show an example rewrite",
    working: "Writing an example…",
    cost: (credits) => `An example costs ${credits} credits.`,
    yours: "Your passage",
    example: "One way it could read",
    note: "An example only, in your words where possible. It isn't put into your essay, and if you use any of it, your unit's rules on AI help apply.",
    recorded: "Added to your AI-use record for this assessment.",
  },

  record: "Your AI-use record",
  recordCopy: "Copy",
  recordCopied: "Copied",
  recordHeading: (title) => `AI use on ${title || "this assessment"} (from UniPlanner)`,
  recordFeedbackLine: (when) => `${when}: asked for AI feedback on a draft against my marking criteria.`,
  recordRewriteLine: (when, words, problem) =>
    `${when}: asked for an example rewrite of one passage${words ? ` (${words} words)` : ""}${problem ? `, about: ${problem}` : ""}.`,
  recordEmpty: "No AI help recorded yet.",

  save: "Save to notes",
  saved: "Saved to your notes",
  noteTitle: (title) => (title ? `Essay feedback — ${title}` : "Essay feedback"),

  capture: {
    question: "Was this useful?",
    ratings: { yes: "Yes", partly: "Partly", no: "No" },
    reasonsLabel: "What was wrong with it?",
    reasons: {
      "wrong-about-essay": "It was wrong about my essay",
      "too-vague": "Too vague to act on",
      "missed-things": "It missed things that mattered",
      "not-my-rubric": "It didn't match my rubric",
      "wrong-part": "It pointed at the wrong part",
      repeated: "It repeated itself",
      "rewrite-changed-meaning": "The example rewrite changed my meaning",
      "something-else": "Something else",
    },
    commentTick: "Also send a comment",
    commentNote: (max) =>
      `Only sent if you tick the box. It's stored with your rating so we can read it, it trains nothing, and if you paste wording from your essay here, that is stored too. Up to ${max} characters.`,
    send: "Send",
    thanks: "Thanks. That goes straight to the people improving it.",
    failed: "That didn't send. Nothing else was affected.",
  },

  markAsk: {
    question: "Your mark is in. How did our feedback compare to your marker's?",
    shareTick: "Share this mark and its grade band with us, so we can check the feedback against it",
    shareNote: "Untick, and nothing about the mark leaves your planner.",
    send: "Send",
    dismiss: "Don't ask",
    thanks: "Thanks. This is how we find out whether the feedback points at the right things.",
  },
};

/* The one derived check the copy owns: every severity the schema can
   produce has a heading, and every code has a label. A test runs it. */
export function copyCovers({ levels = SEVERITY_LEVELS, codes = [] } = {}) {
  const missingLevels = levels.filter((l) => !ESSAY_COPY.severityHeading[l]);
  const missingCodes = codes.filter((c) => !ESSAY_COPY.codeLabels[c]);
  return { ok: !missingLevels.length && !missingCodes.length, missingLevels, missingCodes };
}
