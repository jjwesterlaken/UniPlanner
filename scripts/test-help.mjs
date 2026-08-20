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
    const concrete = /\d/.test(t.example) || /“[^”]+”/.test(t.example);
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
    "Folders", "Your studying", "Study timer", "Class notes",
    "Study cards", "Weak spots", "Practice questions", "Exams", "Account"
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
