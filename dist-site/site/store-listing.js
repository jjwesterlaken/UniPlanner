/* The store listing, as data.

   IT LIVES HERE SO THREE THINGS CANNOT DRIFT: the marketing page, the
   two store listings, and the wording rule the whole reading feature
   rests on. Copy typed straight into a Play Console text box is
   reviewed by nobody and greped by nothing — and this is the copy most
   likely to reach for "skip the reading", because that is what sells.

   scripts/test-site.mjs checks the character limits Google enforces
   (30 / 80 / 4000) and scripts/test-readings.mjs sweeps this file with
   the same substitution ban it applies to the in-app copy.

   THE NAME. "UniPlanner" everywhere a store shows it, matching the App
   Store record. The in-app display name is still "University Planner"
   (DISPLAY_NAME in scripts/stamp-native.mjs is "UniPlanner" for the
   home screen, because iOS truncates at ~12 characters). Reconciling
   the two is a real task and deliberately not one to do before the
   first AAB. */

export const STORE_NAME = "UniPlanner";

/* Under 80. Says what it is and who it is for, in that order — a
   student scanning search results decides on the noun, not the verb. */
export const SHORT_DESCRIPTION =
  "Plan your semester, record lectures, and revise the things you keep missing.";

/* Under 4000. Drawn from the marketing page's four feature headings so
   the page and the listing say the same thing in the same order. */
export const FULL_DESCRIPTION = `UniPlanner is a planner built for one semester at a time: your courses, your assignments, your readings, and the study cards you make from them.

RECORD THE LECTURE. GET THE NOTES.
Record a lecture and UniPlanner writes it up — an overview, the key points with the reasoning behind them, the terms your lecturer actually defined, and what sounds examinable. It files itself into the right course. You can have it translated as it goes.

WHAT DO I NEED ON THE FINAL?
Enter your assessments and their weights once, and every mark you add answers the question students actually ask. It tells you the mark you need on what is left, and it is honest about the half-mark cases where rounding decides it.

REVISE THE TWELVE YOU KEEP MISSING
Study cards on a spaced schedule, so the ones you know go quiet and the ones you do not come back. Practise explaining an answer in your own words and get told where you were vague. Before an exam, it builds a plan from the topics you are weakest on.

DEADLINES BY WEEK, NOT BY DATE
Set your semester dates and your teaching breaks, and the workload forecast shows what is due in week nine rather than on the 14th. Readings, assignments and exams in one place, with the countdown that matters.

AND THE REST OF IT
Notes with real formatting, folders per course, a reference sheet for the formulas you keep looking up, and a semester archive so next year starts clean without losing last year.

WORKS WITHOUT AN ACCOUNT
Everything works signed out, stored on your own device and sent nowhere. Make an account and it syncs across your devices — you choose when.

ABOUT THE AI FEATURES
Recording lectures, summarising a reading you supply, and the study help are optional and use a credit allowance. Every plan includes credits to try them. Your recordings are deleted as soon as they have been transcribed, and nothing you type is used to train anybody's model.`;

/* Play asks for these separately and both must be reachable. */
export const PRIVACY_POLICY_PATH = "/privacy";
export const ACCOUNT_DELETION_PATH = "/delete-account";

export const LIMITS = { name: 30, short: 80, full: 4000 };
