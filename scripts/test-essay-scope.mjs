/* The span-rewrite scope control, over two SYNTHETIC populations.
 *
 * WHY SYNTHETIC IS THE POINT, and not a shortcut. The 24 September
 * two-arm run reported "no cell separates the arms" and concluded the
 * structure does not distinguish description from ghostwriting. It
 * could not have concluded that: the adversarial arm offered LESS
 * replacement wording than the constrained one (1% against 2%), so it
 * contained almost none of the thing being detected. A detector
 * evaluated on a population with no positives has not been evaluated.
 *
 * `scopeControl` in two-arm-summary.mjs guards three real failures —
 * an empty arm, identical arms, and no separating threshold — and none
 * of them is this one. Its emptiness check counts POINTS. An arm can
 * be full of points and empty of positives, and that reads exactly
 * like a constraint that worked, which is the sentence its own comment
 * uses about the case it does catch.
 *
 * So both populations are CONSTRUCTED here, and three things are
 * asserted that a model-driven run cannot promise:
 *
 *   - both populations are non-empty
 *   - every compliant rewrite passes
 *   - every violating rewrite fails, AND every violation kind is
 *     exercised by at least one fixture, so a check that can never
 *     fire is a failure rather than a clean run
 *
 * No provider, no corpus, no key. It runs in `npm test`.
 */

import assert from "node:assert/strict";
import { checkScope, wordsOf, grams, SCOPE_VIOLATIONS, ESCAPE_RUN_WORDS, EXCEEDS_SPAN_RATIO } from "../src/essayScope.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    /* A SYNCHRONOUS RUNNER HANDED AN ASYNC TEST reports green before
       the assertions have run — the vacuous-pass shape that five
       suites in this repository shipped, and which
       test-vacuous-guards.mjs now sweeps for. Nothing here needs to be
       async, so the answer is to refuse one rather than to await it:
       an await would make this file's every future test silently
       eligible for the same mistake. */
    if (r && typeof r.then === "function") {
      throw new Error("this runner is synchronous — an async test would report green before it asserted anything");
    }
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  - ${name}\n        ${err.message}`);
  }
}

/* One essay, used by every fixture. The span is the second sentence;
   everything else is "outside", which is what makes an escape
   detectable at all. */
const ESSAY = [
  "The rise of the printing press changed who could hold an argument in public.",
  "Print made an argument repeatable, and repetition is what let a claim be tested by people who had never met.",
  "Before that, a disputed point survived only as long as someone remembered it correctly.",
  "Eisenstein argued in 1979 that this shift was the precondition for a scientific culture, not its consequence.",
  "That claim has been contested, but the direction of the causation is what the debate is about.",
].join(" ");

const SPAN = "Print made an argument repeatable, and repetition is what let a claim be tested by people who had never met.";

/* ---------- POPULATION A: compliant rewrites ---------- */
const COMPLIANT = [
  { why: "tightened, same claim, same span", text: "Print made an argument repeatable, and that repetition let a claim be tested by people who never met." },
  { why: "reordered within the span", text: "Because print made an argument repeatable, strangers who had never met could test a claim." },
  { why: "shorter", text: "Print made arguments repeatable, so strangers could test a claim." },
  { why: "reuses a figure that is already in the span", text: "Print made an argument repeatable; repetition let a claim be tested by people who had never met." },
];

/* ---------- POPULATION B: violating rewrites ---------- */
const VIOLATING = [
  {
    why: "rewrote the next sentence too",
    kind: "escapes-span",
    text:
      "Print made an argument repeatable. Before that, a disputed point survived only as long as someone remembered it correctly.",
  },
  {
    why: "invented a figure",
    kind: "fabricated-fact",
    text: "Print made an argument repeatable, and within 40 years a claim could be tested by people who had never met.",
  },
  {
    why: "invented a citation",
    kind: "fabricated-fact",
    text: "Print made an argument repeatable (Johns, 1998), letting a claim be tested by people who had never met.",
  },
  {
    why: "invented a name",
    kind: "fabricated-fact",
    text: "Print made an argument repeatable, as Habermas showed, letting a claim be tested by people who had never met.",
  },
  {
    why: "returned three times the span",
    kind: "exceeds-span",
    text:
      "Print made an argument repeatable, and repetition is what let a claim be tested by people who had never met. " +
      "This mattered enormously for the development of a public sphere in which ideas could circulate freely among " +
      "readers who shared no personal acquaintance whatsoever, and it is difficult to overstate how much this changed " +
      "the character of intellectual life across the whole of the period under discussion here in this essay.",
  },
];

/* ================================================================ */

test("BOTH POPULATIONS ARE NON-EMPTY — the assertion the 24 September run could not make", () => {
  /* The failure this file exists for. A detector measured against a
     population with no positives has not been measured, and the run
     that discovered this reported a finding about the structure
     instead. Constructed populations make the count a fact rather
     than an outcome. */
  assert.ok(COMPLIANT.length >= 3, `only ${COMPLIANT.length} compliant fixtures`);
  assert.ok(VIOLATING.length >= 3, `only ${VIOLATING.length} violating fixtures`);
});

test("EVERY COMPLIANT REWRITE PASSES — or the control refuses honest work", () => {
  for (const f of COMPLIANT) {
    const r = checkScope({ essay: ESSAY, span: SPAN, rewrite: f.text });
    assert.ok(r.ok, `"${f.why}" was refused: ${r.violations.map((v) => `${v.kind} (${v.detail})`).join("; ")}`);
  }
});

test("EVERY VIOLATING REWRITE FAILS, for the reason it was built to fail for", () => {
  /* The KIND is asserted, not merely that something fired. A fixture
     built to test fabrication that trips the length check instead
     would leave fabrication unexercised while the suite stayed
     green — the guard-catches-the-wrong-thing shape. */
  for (const f of VIOLATING) {
    const r = checkScope({ essay: ESSAY, span: SPAN, rewrite: f.text });
    assert.ok(!r.ok, `"${f.why}" passed and should not have`);
    const kinds = r.violations.map((v) => v.kind);
    assert.ok(kinds.includes(f.kind), `"${f.why}" failed as ${kinds.join(", ")} rather than ${f.kind}`);
  }
});

test("EVERY CHECK FIRES ON SOMETHING — a check that cannot fire is a failure, not a clean run", () => {
  /* THE HALF #133's SCOPE CONTROL DOES NOT HAVE. Its emptiness check
     counts POINTS per arm; an arm can be full of points and empty of
     positives. This asserts the detector's own coverage: every kind
     it can report is reachable from the fixtures. */
  const fired = new Set();
  for (const f of [...COMPLIANT, ...VIOLATING]) {
    for (const v of checkScope({ essay: ESSAY, span: SPAN, rewrite: f.text }).violations) fired.add(v.kind);
  }
  for (const v of checkScope({ essay: ESSAY, span: SPAN, rewrite: "" }).violations) fired.add(v.kind);
  for (const v of checkScope({ essay: ESSAY, span: "", rewrite: "anything" }).violations) fired.add(v.kind);

  const never = SCOPE_VIOLATIONS.filter((k) => !fired.has(k));
  assert.deepEqual(never, [], `these checks are never exercised, so nothing proves they work: ${never.join(", ")}`);
});

test("A FACT THE STUDENT USED ELSEWHERE IN THE ESSAY IS NOT A FABRICATION", () => {
  /* The distinction that keeps two faults from collapsing into one
     code. 1979 and Eisenstein are in the essay but not in the span, so
     carrying them in is a SCOPE problem and not an invention — and
     saying "fabricated" about the student's own citation is the kind
     of wrong accusation that makes a guard untrustworthy. */
  const r = checkScope({ essay: ESSAY, span: SPAN, rewrite: "Print made an argument repeatable, as Eisenstein noted in 1979." });
  const kinds = r.violations.map((v) => v.kind);
  assert.ok(!kinds.includes("fabricated-fact"), `the student's own 1979 citation was called a fabrication: ${JSON.stringify(r.violations)}`);
});

test("A WORD THE STUDENT WROTE IN LOWER CASE IS NOT A NEW NAME WHEN THE REWRITE CAPITALISES IT (26 September)", () => {
  const essay = "Many people use the internet every day for school. Some rely on it too much.";
  const span = "Many people use the internet every day for school.";
  const r = checkScope({ essay, span, rewrite: "Many people use the Internet each day for school." });
  assert.ok(r.ok, `the student's own word read as invented: ${JSON.stringify(r.violations)}`);
  /* THE CONTROL: a name the essay never has, in any case, still fires. */
  const c = checkScope({ essay, span, rewrite: "Many people, as Turkle notes, use the internet for school." });
  assert.ok(c.violations.some((v) => v.kind === "fabricated-fact"), "an invented name no longer fires");
});

test("A NUMBER THE STUDENT SPELLED OUT IS NOT A NEW FIGURE WHEN THE REWRITE WRITES IT AS DIGITS", () => {
  const essay = "It took three days to get there. Nobody complained.";
  const span = "It took three days to get there.";
  assert.ok(checkScope({ essay, span, rewrite: "Getting there took 3 days." }).ok, "the student's own number read as invented");
  const c = checkScope({ essay, span, rewrite: "Getting there took 4 days." });
  assert.ok(c.violations.some((v) => v.kind === "fabricated-fact"), "a changed number no longer fires");
});

test("THE PARAMETERS ARE PARAMETERS, and the escape run is adjustable without editing the module", () => {
  /* Both constants are design choices of a synthetic test rather than
     measured thresholds, which is stated in the module. This pins that
     they are reachable and that the check really reads the argument —
     a parameter nothing consults is a comment. */
  const nearMiss = "Print made an argument repeatable, and repetition is what let a claim be";
  assert.equal(checkScope({ essay: ESSAY, span: SPAN, rewrite: nearMiss }).ok, true);
  assert.ok(ESCAPE_RUN_WORDS >= 4, "an escape run this short would fire on ordinary English");
  assert.ok(EXCEEDS_SPAN_RATIO > 1, "a ratio of 1 or less would refuse every rewrite that is not shorter");
  /* Driven rather than asserted about: at a run of 3, a fixture that
     passes at 6 must start escaping, or the argument is ignored. */
  const straddles = "Print made an argument repeatable, and a disputed point survived only as long as remembered.";
  const loose = checkScope({ essay: ESSAY, span: SPAN, rewrite: straddles, escapeRun: 3 });
  const strict = checkScope({ essay: ESSAY, span: SPAN, rewrite: straddles, escapeRun: 20 });
  assert.notDeepEqual(
    loose.violations.map((v) => v.kind),
    strict.violations.map((v) => v.kind),
    "changing escapeRun changed nothing, so the argument is not being read"
  );
});

test("wordsOf() and grams() are the plumbing the checks rest on", () => {
  assert.deepEqual(wordsOf("Don't — re-read THAT, please."), ["don't", "re-read", "that", "please"]);
  assert.deepEqual([...grams(["a", "b", "c"], 2)], ["a b", "b c"]);
  assert.deepEqual([...grams(["a"], 2)], [], "a run longer than the text yields nothing rather than a partial");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
