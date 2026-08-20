/* The ? help: worked examples that cannot drift from the app.

   Two rules the copy is written under, and this file enforces both:

   1. EVERY TOPIC CARRIES A WORKED EXAMPLE, not an explanation. An
      abstract description of weighted averages is what people bounce
      off; a specific case with real numbers is what lands.
   2. EVERY TOPIC SAYS WHAT IT COSTS — the setup Grades demands before
      it tells you anything, the allowance a recording spends, the
      account the archive needs.

   The sharpest check here is the third one. The Grades example quotes
   the marks a student would need, and those figures are RE-DERIVED
   from grades.js rather than compared against a number typed into
   this file: help that quietly disagrees with the screen is worse
   than no help, and a restated constant is exactly how that happens
   (see the restatement ledger in CLAUDE.md).

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_TOPICS, HELP_TOPIC_IDS } from "../src/helpText.js";
import { requiredForBand, summarise } from "../src/grades.js";
import { schedule, MAX_SESSION_MINUTES, WINDOW_DAYS } from "../src/srs.js";
import { weakTopics } from "../src/practice.js";
import { TASK_CREDITS, creditsForTier } from "../src/aiTextLimits.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log("\nhelp topics");

test("every topic has a worked example and a cost, not just a description", () => {
  for (const [id, t] of Object.entries(HELP_TOPICS)) {
    assert.ok(t.title, `${id} has no title`);
    assert.ok(t.what && t.what.length > 40, `${id}'s "what" is missing or too thin to be useful`);
    assert.ok(t.example && t.example.length > 80, `${id} has no worked example — an explanation is what people bounce off`);
    assert.ok(t.cost && t.cost.length > 40, `${id} does not say what it costs`);
  }
});

test("a worked example is CONCRETE: it carries real numbers or a real before/after", () => {
  /* The distinction the whole brief rests on. "Tracks your marks
     across assessments" is an explanation; "you get 75 on the essay
     and 60 on the quiz, so you have banked 34.5" is an example. A
     digit is a crude proxy for concreteness, but a topic with no
     figure and no quoted before/after is almost certainly abstract. */
  for (const [id, t] of Object.entries(HELP_TOPICS)) {
    /* Digits, a quoted before/after, OR a spelled-out numeral. The
       study-cards ladder is written in words on purpose — the
       derivation test matches those word forms against what the
       scheduler computes — so a digits-only proxy would have pushed
       the copy to be worse to satisfy the check. */
    const NUMERALS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|forty-two)\b/i;
    const concrete = /\d/.test(t.example) || /“[^”]+”/.test(t.example) || NUMERALS.test(t.example);
    assert.ok(concrete, `${id}'s example has no numbers and no quoted before/after — it reads as an explanation`);
  }
});

test("THE GRADES EXAMPLE IS WHAT THE APP ACTUALLY COMPUTES, both rounding rules", () => {
  /* Derived, never restated. If someone changes the bands, the
     rounding targets or the arithmetic, this goes red naming the
     figure that moved rather than letting the help lie. */
  const assessments = [
    { id: "1", title: "Essay", w: 30, mark: 75 },
    { id: "2", title: "Quiz", w: 20, mark: 60 },
    { id: "3", title: "Exam", w: 50 },
  ];
  const s = summarise(assessments);
  const round1 = (n) => Math.round(n * 10) / 10;

  assert.equal(s.earned, 34.5, "the banked-marks figure moved");
  assert.equal(100 - s.remainingWeight, 50, "the available-so-far figure moved");

  const need = (min, rule) => round1(requiredForBand(assessments, min, rule).required);
  const halfUpD = need(75, "half-up");
  const halfUpC = need(65, "half-up");
  const truncD = need(75, "truncate");
  const truncC = need(65, "truncate");

  const ex = HELP_TOPICS.grades.example + " " + (HELP_TOPICS.grades.detail || "");
  for (const [label, value] of [
    ["banked marks", s.earned],
    ["marks available so far", 100 - s.remainingWeight],
    ["Distinction (default rounding)", halfUpD],
    ["Credit (default rounding)", halfUpC],
    ["Distinction (rounded down)", truncD],
    ["Credit (rounded down)", truncC],
  ]) {
    assert.ok(
      ex.includes(String(value)),
      `the Grades help no longer quotes the ${label} the app computes (${value}) — the help and the screen disagree`
    );
  }
});

test("the grades help names the up-front cost, because that is why people bounce off it", () => {
  const cost = HELP_TOPICS.grades.cost.toLowerCase();
  assert.ok(/weight/.test(cost), "it does not say the weights must be entered");
  assert.ok(/not sat|have not|haven't/.test(cost), "it does not say the unsat assessments are needed too");
});

test("the AI help says what a recording spends, including the minimum", () => {
  const cost = HELP_TOPICS.aiNotes.cost.toLowerCase();
  assert.ok(/allowance|minutes/.test(cost), "it does not say a recording spends an allowance");
  assert.ok(/three|3/.test(cost), "it does not mention the three-minute minimum, which is the surprising part");
});

test("the archive help says it needs an account and what happens to the device copy", () => {
  const cost = HELP_TOPICS.archive.cost.toLowerCase();
  assert.ok(/account/.test(cost), "it does not say an account is required");
  assert.ok(/device/.test(cost), "it does not say what happens to the copy on the device");
});

test("THE SRS LADDER IS WHAT THE SCHEDULER ACTUALLY DOES", () => {
  /* Re-derived from srs.js, the grades discipline applied to the
     hardest topic in the app. Writing this caught two things a draft
     had wrong: "Again" does NOT come back tomorrow — it returns in the
     SAME session (interval 0), because a card you just missed is not
     one to leave overnight; and the Good ladder is 1/3/8 days, not a
     vague "few days". Help that disagrees with the scheduler is worse
     than no help. */
  const today = "2026-08-20";
  const ladder = (rating, times) => {
    let card = {};
    const out = [];
    for (let i = 0; i < times; i++) {
      const srs = schedule(card, rating, today);
      card = { srs };
      out.push(srs.i);
    }
    return out;
  };
  const again = schedule({}, "again", today);
  assert.equal(again.i, 0, "Again no longer returns in the same session — the copy says it does");
  assert.equal(again.d, today, "Again is no longer due today");

  const good = ladder("good", 3);
  const easy = ladder("easy", 3);
  const ex = HELP_TOPICS.studyCards.example;
  for (const [label, value] of [
    ["Good step 1", good[0]], ["Good step 2", good[1]], ["Good step 3", good[2]],
    ["Easy step 1", easy[0]], ["Easy step 2", easy[1]], ["Easy step 3", easy[2]],
  ]) {
    const words = { 1: "tomorrow", 3: "three", 8: "eight", 11: "eleven", 42: "forty-two" }[value];
    assert.ok(words, `no word form for ${label} = ${value} days — the ladder moved and the copy needs rewriting`);
    assert.ok(
      ex.includes(words),
      `the study-cards help no longer quotes ${label} (${value} days, written "${words}") — the help and the scheduler disagree`
    );
  }
  assert.match(HELP_TOPICS.studyCards.example, /same session/i, "the Again behaviour is no longer stated");
});

test("the study-cards help justifies interleaving and explains practice mode's whole point", () => {
  const all = [HELP_TOPICS.studyCards.example, ...[].concat(HELP_TOPICS.studyCards.detail || [])].join(" ");
  assert.match(all, /mixes cards from all your courses|interleave/i, "interleaving is not justified — students think it is a bug");
  assert.match(all, /feels harder/i, "it does not acknowledge that interleaving feels worse, which is why it needs justifying");
  assert.match(all, /night before an exam/i, "practice mode's reason to exist is not stated");
  assert.match(all, /does NOT change when those cards next come up/i, "practice mode does not say it is free of consequence — that reassurance IS the point");
});

test("weak spots quotes the real miss threshold and list size", () => {
  /* Derived from practice.js's defaults rather than typed: "a few
     misses" is exactly two, and the list is capped at eight. */
  const src = fs.readFileSync(path.join(rootDir, "src/practice.js"), "utf8");
  const m = /weakTopics\(\{[^}]*limit = (\d+), minMisses = (\d+)/s.exec(src);
  assert.ok(m, "could not read weakTopics' defaults — this guard is blind");
  const [, limit, misses] = m;
  const words = { 2: "two", 8: "eight" };
  const text = HELP_TOPICS.weakSpots.example;
  assert.ok(text.includes(words[Number(misses)]), `the miss threshold is ${misses} and the copy does not say so`);
  assert.ok(text.includes(words[Number(limit)]), `the list shows ${limit} topics and the copy does not say so`);
  assert.equal(typeof weakTopics, "function");
});

test("the AI costs are in the currency the SCREENS use, never in units", () => {
  /* THE BOUNDARY RULE SURVIVED THE CURRENCY COLLAPSE, and it is worth
     saying why it did not simply become obsolete. Credits ARE sayable —
     one is a minute of recorded lecture — so help may quote them. What
     stays banned is "units", the internal weight that meant nothing to
     anybody and that this rule existed to keep off screens. A topic
     that says "units" is quoting a currency that no longer exists.

     THE BOUNDARY RULE: students never see the word "units" — the
     endpoint returns a fraction and aiTextCopy turns it into words.
     Help that leaked the internal unit count would be the first place
     it reached a screen. What it may say is how many actions a plan
     buys, which is derived from the same constants. */
  const free = creditsForTier("free");
  const perExplain = free / TASK_CREDITS.explain;
  const perPractice = free / TASK_CREDITS.practice;
  const words = { 5: "five", 10: "ten" };
  for (const id of ["studyCards", "weakSpots", "practiceQuestions"]) {
    const all = [HELP_TOPICS[id].what, HELP_TOPICS[id].example, HELP_TOPICS[id].cost, ...[].concat(HELP_TOPICS[id].detail || [])].join(" ");
    assert.ok(!/\bunits?\b/i.test(all), `${id}'s help says "units" — that word never reaches a student`);
  }
  assert.ok(
    HELP_TOPICS.practiceQuestions.cost.includes(words[perPractice]),
    `the free plan buys ${perPractice} question sets a month and the copy does not say so`
  );
  for (const id of ["studyCards", "weakSpots"]) {
    assert.ok(
      HELP_TOPICS[id].cost.includes(words[perExplain]),
      `the free plan buys ${perExplain} explanations a month and ${id}'s copy does not say so`
    );
  }
});

test("practice questions and weak spots both state their precondition", () => {
  assert.match(HELP_TOPICS.practiceQuestions.cost, /does nothing at all until you have study cards/i,
    "it does not say it is inert without cards, which reads as broken");
  assert.match(HELP_TOPICS.weakSpots.example, /One bad session does not/i,
    "it does not say why a single miss is not enough");
});

test("the timer help says a few seconds is not recorded, and names the runaway cap", () => {
  /* Silently discarding a session looks like a bug, which is exactly
     why srs.js keeps the timer's state and reports it instead. The cap
     is derived. */
  const hours = MAX_SESSION_MINUTES / 60;
  assert.equal(hours, 4, "the runaway cap moved; the copy says four hours");
  assert.match(HELP_TOPICS.studyTimer.example, /four hours/i, "the copy no longer names the runaway cap");
  assert.match(HELP_TOPICS.studyTimer.cost, /few seconds is not recorded/i, "it does not say short runs are dropped");
  assert.match(HELP_TOPICS.studyTimer.cost, /tells you|rather than silently/i,
    "it does not say the timer SAYS so — the whole reason this is worth documenting");
});

test("the streak help explains the archive reset, which otherwise reads as data loss", () => {
  const all = [HELP_TOPICS.yourStudying.example, ...[].concat(HELP_TOPICS.yourStudying.detail || []), HELP_TOPICS.yourStudying.cost].join(" ");
  assert.match(all, /archive/i, "it does not mention archiving at all");
  assert.match(all, /streak carries|STREAK carries/i, "it does not say the streak survives an archive");
  assert.match(all, /minutes and card counts reset|minutes.*reset/i, "it does not say what resets");
  // The six-week detail window is derived, not typed.
  assert.equal(WINDOW_DAYS, 42, "the daily-detail window moved; the copy says six weeks");
  assert.match(all, /six weeks/i, "the copy no longer names the detail window");
});

test("the exam help states its two preconditions and the no-review-day rule", () => {
  const all = [HELP_TOPICS.exams.example, HELP_TOPICS.exams.cost].join(" ");
  assert.match(all, /needs the exam entered with a date/i, "it does not say a date is required");
  assert.match(all, /study cards for that course/i, "it does not say the topics come from cards");
  assert.match(HELP_TOPICS.exams.example, /NO review day|no review day/i,
    "the deliberate no-review-day behaviour is unexplained, so it reads as a bug");
});

/* ---------- the wiring, derived from the app rather than typed ---------- */

const usedTopics = new Set([...appSrc.matchAll(/(?:help|topic)="([A-Za-z]+)"/g)].map((m) => m[1]));

test("every topic id the app asks for exists in helpText.js", () => {
  for (const id of usedTopics) {
    assert.ok(HELP_TOPICS[id], `the app asks for help topic "${id}" and there is no copy for it`);
  }
});

test("every topic in helpText.js is actually reachable from a screen", () => {
  for (const id of HELP_TOPIC_IDS) {
    assert.ok(usedTopics.has(id), `"${id}" has copy nobody can open — either wire it up or delete it`);
  }
});

test("a NEW screen without help fails here rather than passing silently", () => {
  /* The coverage ledger. Help is deliberately being added a few
     screens at a time, starting where confusion costs something —
     so the uncovered screens are ENUMERATED rather than ignored, and
     a Section added later lands in neither list and goes red. That
     is the device-store guard's shape: partial coverage is fine,
     silent partial coverage is not. */
  const NOT_YET_COVERED = [ "Courses", "Calendar", "What's coming",
    "Weekly reading planner", "Assignments", "To-do list", "Notes",
    "Folders", "Account"
  ];
  /* `\stitle="` and not `title="`: the string `subtitle="` CONTAINS
     `title="`, so an unanchored pattern captures subtitles instead of
     titles — which it duly did on the first run here, reporting that
     a screen with help had none. */
  const titles = [...appSrc.matchAll(/<Section\s+icon=\{[A-Za-z]+\}\s+title="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(titles.length >= 15, `only found ${titles.length} Sections — the pattern has drifted and this guard is blind`);

  const helped = [...appSrc.matchAll(/<Section[^>]*\stitle="([^"]+)"[^>]*\shelp="/g)].map((m) => m[1]);
  for (const title of titles) {
    const covered = helped.includes(title) || NOT_YET_COVERED.includes(title);
    assert.ok(
      covered,
      `the "${title}" screen has no help and is not on the not-yet-covered list. ` +
        "Decide which it is: write a topic for it, or add it to the list."
    );
  }
  // And the list cannot rot: an entry for a screen that no longer
  // exists, or that has since been given help, has to go.
  for (const title of NOT_YET_COVERED) {
    assert.ok(titles.includes(title), `"${title}" is on the not-yet-covered list but is not a Section any more`);
    assert.ok(!helped.includes(title), `"${title}" has help now — take it off the not-yet-covered list`);
  }
});

test("the ? opens an inline panel, not a tooltip", () => {
  /* Tooltips need a hover; half the people this is for are on a
     phone. Pinned because "make it a tooltip" is the obvious tidy-up
     for someone who has not thought about touch. */
  assert.match(appSrc, /aria-expanded=\{open\}/, "the help control no longer announces its state");
  assert.match(appSrc, /data-help-panel=\{topic\}/, "the help panel marker is gone — the smoke walk finds it by this");
  assert.ok(!/title=\{t\.what\}/.test(appSrc), "the help text moved into a hover title, which is unusable on touch");
});

test("npm test runs this file", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /test-help\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
