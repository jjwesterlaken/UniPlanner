/* The structured feedback point — the defence that replaced the one
   the first measurement disproved.

   WHAT CHANGED AND WHY. §3 assumed "locating a problem requires
   quoting their text". The run showed the model locating problems
   without quoting anything, so description and replacement wording
   were both novel prose and no threshold over novelty separated them.
   The defence moved from DETECTION to STRUCTURE: a verbatim quote
   cannot be new writing, an enum carries no prose, and `note` is the
   only channel left — which is why its length is the one parameter
   worth measuring and the only one the operating characteristic is
   about.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFICIENCIES, measurePoint, refusePoint, quoteVariety } from "../src/essayPoints.js";
import { ARMS, userMessage } from "./lib/essay-arms.mjs";
import { SCOPE_CONTROL, scopeControl } from "./lib/two-arm-summary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const ESSAY = `The Industrial Revolution transformed British society between 1760 and 1840.
Factory production replaced cottage industry, and the urban population grew rapidly as
workers left the countryside. Living standards are the contested part of this story.`;
const CRITERIA = "Argument: a clear thesis sustained throughout. Evidence: specific examples with dates.";

const M = (point) => measurePoint({ point, essay: ESSAY, criteria: CRITERIA });
const AT = { minQuoteWords: 4, maxNoteWords: 25 };

/* ---------- the parameters ---------- */

test("IT REFUSES WITHOUT THRESHOLDS — the number nobody sized is what the last run disproved", () => {
  assert.throws(() => refusePoint(M({ quote: "x" }), {}), /has no default/);
  assert.throws(() => refusePoint(M({ quote: "x" }), { minQuoteWords: 4 }), /maxNoteWords/);
  assert.throws(() => refusePoint(M({ quote: "x" }), { minQuoteWords: 0, maxNoteWords: 25 }), /minQuoteWords/);
});

test("the error names the instrument that produces the numbers", () => {
  try {
    refusePoint(M({ quote: "x" }), {});
    assert.fail("did not throw");
  } catch (e) {
    assert.match(e.message, /measure-two-arm\.mjs/);
  }
});

test("MEASURING IS SEPARATE FROM REFUSING, which is what makes a sweep possible at all", () => {
  /* Mixing them would mean re-calling the provider for every
     candidate threshold, so there could be no operating
     characteristic — only a yes/no at one guess. */
  const m = M({ quote: "the urban population grew rapidly", deficiency: "claim-without-evidence", note: "Thin." });
  assert.equal(refusePoint(m, { minQuoteWords: 4, maxNoteWords: 25 }).ok, true);
  assert.equal(refusePoint(m, { minQuoteWords: 40, maxNoteWords: 25 }).ok, false, "the same measurement must answer differently at a different threshold");
});

/* ---------- the three channels ---------- */

test("A VERBATIM QUOTE CANNOT BE NEW WRITING — that is the whole trick", () => {
  const ok = M({ quote: "the urban population grew rapidly", deficiency: "claim-without-evidence", note: "No figure given." });
  assert.equal(ok.quoteVerbatim, true);
  assert.deepEqual(refusePoint(ok, AT).reasons, []);
});

test("a FABRICATED quote is refused, and it is the sharp violation", () => {
  /* It asserts the student wrote something they did not. */
  const bad = M({ quote: "the mills of Lancashire consumed American cotton", deficiency: "repetition", note: "Twice." });
  assert.equal(bad.quoteVerbatim, false);
  assert.ok(refusePoint(bad, AT).reasons.includes("quote-not-found"));
});

test("punctuation and case do not break a real quotation", () => {
  /* A model that recopies with different capitalisation or a curly
     apostrophe is still quoting the student, and refusing it would be
     the instrument's fault rather than the model's. */
  const m = M({ quote: "The Urban Population Grew, rapidly!", deficiency: "claim-without-evidence", note: "Thin." });
  assert.equal(m.quoteVerbatim, true);
});

test("a deficiency outside the CLOSED SET is refused — the enum carries no prose", () => {
  const m = M({ quote: "the urban population grew rapidly", deficiency: "vibes", note: "Hmm." });
  assert.ok(refusePoint(m, AT).reasons.includes("deficiency-unknown"));
  for (const d of DEFICIENCIES) {
    assert.equal(M({ quote: "the urban population grew rapidly", deficiency: d, note: "x" }).deficiencyKnown, true, d);
  }
});

test("THE NOTE IS THE ONLY CHANNEL GHOSTWRITING CAN USE, so its length is the parameter", () => {
  const long = M({
    quote: "the urban population grew rapidly",
    deficiency: "claim-without-evidence",
    note: "Replace it with the following sentence: the displacement of artisanal labour accelerated sharply after 1790, a shift this essay will trace through wage series and parish records.",
  });
  assert.ok(refusePoint(long, AT).reasons.includes("note-too-long"));
  assert.equal(refusePoint(long, { minQuoteWords: 4, maxNoteWords: 60 }).ok, true, "the cap must be what refused it, not something else");
});

test("QUOTED WORDING INSIDE THE NOTE is offered wording — the ghostwriter's hiding place", () => {
  const m = M({
    quote: "the urban population grew rapidly",
    deficiency: "claim-without-evidence",
    note: `Try: "a sharp rise in town dwellers followed the enclosure acts".`,
  });
  assert.ok(refusePoint(m, AT).reasons.includes("wording-offered"));
  /* And quoting the ESSAY back inside a note is NOT offered wording —
     it is the student's own text, which is the thing they are allowed
     to be shown. */
  const quoting = M({
    quote: "the urban population grew rapidly",
    deficiency: "repetition",
    note: `You say "the urban population grew rapidly" twice.`,
  });
  assert.ok(!refusePoint(quoting, AT).reasons.includes("wording-offered"));
});

/* ---------- the degenerate model ---------- */

test("QUOTE VARIETY CATCHES A MODEL QUOTING THE SAME SENTENCE EVERY TIME", () => {
  /* It passes "there is a verbatim quote" and locates nothing. */
  const same = Array.from({ length: 4 }, () =>
    M({ quote: "The Industrial Revolution transformed British society", deficiency: "unclear-relevance", note: "x" })
  );
  const varied = [
    M({ quote: "The Industrial Revolution transformed British society", deficiency: "unclear-relevance", note: "x" }),
    M({ quote: "the urban population grew rapidly", deficiency: "claim-without-evidence", note: "x" }),
    M({ quote: "Living standards are the contested part", deficiency: "undefined-term", note: "x" }),
  ];
  assert.equal(quoteVariety(same).ratio, 0.25);
  assert.equal(quoteVariety(varied).ratio, 1);
  assert.ok(quoteVariety(varied).spread > quoteVariety(same).spread, "position spread must tell them apart too");
  /* REPORTED, NEVER ENFORCED: two problems in one sentence is
     legitimate, so refusing on repetition would be wrong. */
  assert.deepEqual(refusePoint(same[0], AT).reasons, []);
});

test("quoteVariety over nothing returns nulls rather than a confident zero", () => {
  const v = quoteVariety([]);
  assert.equal(v.ratio, null);
  assert.equal(v.total, 0);
});

/* ---------- the two arms ---------- */

test("THE ARMS SHARE THE SCHEMA AND DIFFER ONLY IN THE NOTE INSTRUCTION", () => {
  /* The threat is a model that COMPLIES with the structure and
     ghostwrites inside it; an arm that ignored the schema would be a
     different and much easier case, and comparing the two would
     measure schema-following rather than ghostwriting. */
  const c = ARMS.constrained.system;
  const a = ARMS.adversarial.system;
  assert.notEqual(c, a);
  for (const shared of ['"points"', '"quote"', '"deficiency"', '"note"', "VERBATIM"]) {
    assert.ok(c.includes(shared) && a.includes(shared), `both arms must carry ${shared}`);
  }
  assert.match(c, /NEVER WRITE ANY PART OF THE ESSAY/);
  assert.match(a, /IMPROVED WORDING/);
  assert.ok(!a.includes("NEVER WRITE ANY PART OF THE ESSAY"), "the adversarial arm must not carry the rule it exists to violate");
});

test("THE ENUM IS DERIVED INTO BOTH PROMPTS, never retyped", () => {
  /* A prompt listing deficiencies the checker does not know would
     refuse every point the model returned, and a checker knowing
     values the prompt never offered would be dead code. */
  for (const arm of Object.values(ARMS)) {
    for (const d of DEFICIENCIES) {
      assert.ok(arm.system.includes(d), `${arm.id} does not offer ${d}`);
    }
  }
  const src = strip(read("scripts/lib/essay-arms.mjs"));
  assert.match(src, /DEFICIENCIES\.join/, "the list is interpolated rather than restated");
  for (const d of DEFICIENCIES) {
    assert.ok(!src.includes(`"${d}"`), `${d} is typed into the prompt as a literal as well as derived`);
  }
});

test("the user message carries the criteria AND the essay, labelled", () => {
  const msg = userMessage({ essay: "ESSAY BODY", criteria: "CRIT BODY" });
  assert.match(msg, /MARKING CRITERIA:/);
  assert.match(msg, /THE STUDENT'S ESSAY:/);
  assert.ok(msg.indexOf("CRIT BODY") < msg.indexOf("ESSAY BODY"));
});

/* ---------- the harness ---------- */

test("THE TWO-ARM HARNESS WITHHOLDS TEXT BY DEFAULT — the quote field IS the essay", () => {
  /* Opposite default from measure-no-writing, deliberately: every
     quote this one collects is the student's own words by
     construction, and the corpus it was built for forbids
     redistributing them. Showing text is the thing you opt into. */
  const src = strip(read("scripts/measure-two-arm.mjs"));
  assert.match(src, /const showText = has\("--show-text"\)/);
  assert.match(src, /redacted: !showText/);
  assert.ok(!/has\("--redact"\)/.test(src), "redaction must be the default, not a flag to remember");
});

test("the operating characteristic sweeps BOTH parameters, and names which rule refused", () => {
  const src = strip(read("scripts/measure-two-arm.mjs"));
  assert.match(src, /QUOTE_FLOORS/);
  assert.match(src, /NOTE_CAPS/);
  assert.match(src, /WHY POINTS WERE REFUSED/);
  /* And it says when one rule is carrying all the separation, so a
     cap that contributes nothing is not adopted as though it did. */
  assert.match(src, /THE NOTE CAP IS CONTRIBUTING NOTHING HERE/);
});

test("the quality control is printed beside the refusals", () => {
  /* A cap that refuses all the ghostwriting by making the feedback
     useless is the ai-notes depth regression, which was measured at
     +189% words per key point by REMOVING a limit. */
  const src = strip(read("scripts/measure-two-arm.mjs"));
  assert.match(src, /QUALITY CONTROL/);
  assert.match(src, /distinct deficiencies/);
  assert.match(src, /quote variety/);
});

test("THE SYNTHETIC PAIR IS A FIXTURE AND SAYS SO — a self-authored recall check flatters by construction", () => {
  /* The enum, the essay and the checker have one author. A number off
     that pair cannot say whether the enum covers the faults real
     essays have; the 32 ASAP essays can, because nobody who wrote
     them had heard of this schema. The README has to lead with that
     rather than bury it, or somebody quotes a recall figure from it. */
  const readme = read("fixtures/essay-feedback/README.md");
  assert.match(readme, /a fixture, not evidence/i);
  assert.match(readme, /closed loop/i);
  assert.match(readme, /ASAP essays are the measurement/i);
  /* And the planted ground truth is enumerated, or a run over it can
     only be read for vibes. */
  for (const d of ["contradiction", "undefined-term", "unattributed-source", "off-criterion"]) {
    assert.ok(readme.includes(d), `the planted-fault table does not name ${d}`);
  }
  /* The half that makes it worth having: faults the enum has NO value
     for, so the schema's own narrowness is testable. */
  assert.match(readme, /the enum has NO value for/i);
});

test("the fixture's essay and rubric exist and are long enough to measure", () => {
  const essay = read("fixtures/essay-feedback/essay.txt");
  const rubric = read("fixtures/essay-feedback/rubric.txt");
  const words = (s) => s.trim().split(/\s+/).length;
  assert.ok(words(essay) >= 400, `the fixture essay is ${words(essay)} words; too short to carry nine planted faults`);
  assert.ok(words(rubric) >= 60, "the rubric must be a real marking scheme, not a line");
  /* The planted Thompson borrowing, unmarked on purpose — if somebody
     "tidies" it into a quotation the unattributed-source fault
     disappears and the table above becomes wrong. */
  assert.match(essay, /present at its own making/);
  assert.ok(!/["\u201C]present at its own making/.test(essay), "the unattributed borrowing was turned into a quotation, removing the planted fault");
});

test("THE QUALITY JUDGEMENT HAS A ROUTE NOW, and its limits are stated with it", () => {
  /* THIS TEST USED TO PIN THE QUESTION AS OPEN, and it was right to
     until 23 September 2026. The exemplar search had failed and the
     document said so; what nobody had checked was that ASAP itself
     carries a human rater score per essay (`domain1_score`), and that
     the competition rules forbid REDISTRIBUTING the text rather than
     reading it. So the read was available the whole time.

     The pin moves with the fact rather than being deleted: what is
     required now is that the document names the route AND its limits,
     because a school essay on a 1-6 band is not a university rubric
     and a route recorded without that reads as more than it is. */
  const doc = read("ESSAY-FEEDBACK.md");
  assert.match(doc, /domain1_score/, "the document does not name the column the scores come from");
  assert.match(doc, /read-asap\.mjs/, "the document does not name the script that produces the read");
  assert.match(doc, /before it ships to students/i, "the deadline for the quality judgement is gone");

  /* THE LIMITS, each asserted, because this is the half that gets
     dropped when somebody summarises the good news. */
  assert.match(doc, /1\s*[-–—]\s*6/, "the 1-6 band is not stated as a limit");
  assert.match(doc, /not a university rubric|not a uni rubric/i, "the document does not say this is not a university rubric");
  assert.match(doc, /school/i, "the document does not say these are school essays");

  /* AND THE RULE IT RESTS ON, stated rather than assumed: reading is
     permitted and redistributing is not, which is what makes the
     output file local-only rather than a repo artefact. */
  assert.match(doc, /forbid[s]? (redistribut|shar)/i, "the document does not state what the corpus licence actually forbids");

  /* The two questions are still kept apart — different evidence,
     different deadlines. */
  assert.match(doc, /Does the structure stop ghostwriting/i);
  assert.match(doc, /before the endpoint is built/i);
});

/* ==================================================================
   THE SCOPE CONTROL — the gate on the whole two-arm measurement.

   Three ways a run says nothing while reporting success, and each is
   a shape this project has already been bitten by:

     - an EMPTY arm, which is the vacuous-pass class: every universal
       claim about an empty population is true, and the printed table
       shows "0 points" beside percentages computed from nothing;
     - IDENTICAL arms, which is the colour-coincidence class: a
       comparison between two things that are the same discriminates
       nothing while passing everything;
     - NO SEPARATION anywhere, which is the one a person is most
       likely to read as "try a different threshold".

   Driven over synthetic populations, so every branch runs with no
   key, no corpus and no provider — the photo-prompt refusal's
   arrangement, and for the same reason.
   ================================================================== */

const point = (overrides = {}) => ({
  quoteWords: 6,
  quoteVerbatim: true,
  quotePosition: 0.5,
  noteWords: 14,
  deficiency: "claim-without-evidence",
  deficiencyKnown: true,
  offeredSpans: [],
  ...overrides,
});
const population = (n, overrides = {}) =>
  Array.from({ length: n }, (_, i) => point({ quotePosition: i / n, ...overrides }));

await test("A HEALTHY RUN PASSES — without this, every refusal below is satisfied by refusing everything", () => {
  const by = {
    constrained: population(20),
    adversarial: population(20, { noteWords: 60, offeredSpans: [9] }),
  };
  const v = scopeControl(by, { separates: true });
  assert.ok(v.ok, `a healthy run was refused: ${v.failures.join(" | ")}`);
  assert.deepEqual(v.failures, []);
});

await test("AN EMPTY ADVERSARIAL ARM IS REFUSED — it reads exactly like a constraint that worked", () => {
  const v = scopeControl({ constrained: population(20), adversarial: [] }, { separates: true });
  assert.equal(v.ok, false, "a run with no ghostwriting population to separate from was accepted");
  assert.ok(
    v.failures.some((f) => /adversarial arm produced 0 points/.test(f)),
    `the refusal does not name the empty arm: ${v.failures.join(" | ")}`
  );
});

await test("an empty CONSTRAINED arm is refused too, so the check is not one-sided", () => {
  const v = scopeControl({ constrained: [], adversarial: population(20) }, { separates: true });
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /constrained arm produced 0 points/.test(f)));
});

await test("a nearly-empty arm is refused at the stated floor, not only at zero", () => {
  const n = SCOPE_CONTROL.minPointsPerArm;
  const under = scopeControl({ constrained: population(20), adversarial: population(n - 1) }, { separates: true });
  const at = scopeControl({ constrained: population(20), adversarial: population(n, { noteWords: 60 }) }, { separates: true });
  assert.equal(under.ok, false, `${n - 1} points was accepted, so the floor does not bite`);
  assert.equal(at.ok, true, `${n} points was refused, so the floor is not where it says it is`);
});

await test("IDENTICAL ARMS ARE REFUSED — two populations that are the same discriminate nothing", () => {
  const same = population(20);
  const v = scopeControl({ constrained: same, adversarial: same.map((x) => ({ ...x })) }, { separates: true });
  assert.equal(v.ok, false, "two identical populations were accepted as a comparison");
  assert.ok(
    v.failures.some((f) => /identical populations/.test(f)),
    `the refusal does not say the arms are identical: ${v.failures.join(" | ")}`
  );
});

await test("arms that differ ONLY in the measurements a threshold reads are told apart", () => {
  /* The comparison is over quote length, note length and whether the
     quote was found — the three things `refusePoint` acts on. A run
     whose arms differ in some field no threshold reads is a run whose
     arms are the same for every purpose this measurement has. */
  const a = population(20);
  const b = population(20).map((x) => ({ ...x, deficiency: "repetition" }));
  const v = scopeControl({ constrained: a, adversarial: b }, { separates: true });
  assert.equal(v.ok, false, "arms differing only in a field no threshold reads were accepted as distinct");
});

await test("NO SEPARATION IS A FINDING, and it is refused rather than printed", () => {
  const v = scopeControl(
    { constrained: population(20), adversarial: population(20, { noteWords: 60 }) },
    { separates: false }
  );
  assert.equal(v.ok, false, "a run where no threshold separates the arms was reported as usable");
  assert.ok(
    v.failures.some((f) => /no candidate threshold separates/.test(f)),
    `the refusal does not name the missing separation: ${v.failures.join(" | ")}`
  );
});

await test("the separation check is SKIPPED when the caller has not computed one", () => {
  /* The early call — before the table exists — passes no `separates`,
     and must not invent a failure it has no evidence for. That is the
     three-outcomes rule inside the gate itself: not-yet-known is not
     the same as no. */
  const v = scopeControl({ constrained: population(20), adversarial: population(20, { noteWords: 60 }) });
  assert.ok(v.ok, `the early check invented a separation failure: ${v.failures.join(" | ")}`);
});

await test("THE SAMPLER'S EXIT CODE IS THE GATE, not a line in its output", () => {
  /* A refusal nobody can act on programmatically is a warning, and
     the next step in the sequence is a person running the read mode
     on the same key. `summariseTwoArm` returns the verdict and the
     sampler exits on it. */
  const sampler = fs.readFileSync(path.join(rootDir, "scripts/sample-asap.mjs"), "utf8");
  const body = sampler.replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(
    body,
    /const\s+verdict\s*=\s*summariseTwoArm\(/,
    "the sampler discards summariseTwoArm's verdict, so a failed scope control cannot stop anything"
  );
  assert.match(body, /process\.exit\([^)]*verdict/, "the sampler's exit code does not depend on the verdict");
});

test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-essay-points\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
