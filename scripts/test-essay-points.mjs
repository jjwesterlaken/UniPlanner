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

import {
  DEFICIENCIES, measurePoint, refusePoint, quoteVariety, SEVERITY, SEVERITY_LEVELS, severityOf, essayFeedbackSchema,
  orderBySeverity, GENRES, APPLIES_TO, fitsGenre, codesFor, predictionFraming, BAND_RATING_MIN, BAND_RATING_MAX,
  bestFit, CODE_DEFINITIONS, applyThesisRule, wordsForMatch,
} from "../src/essayPoints.js";
import { normaliseWords } from "../src/noWriting.js";
import { measureReply, placeBand, isVerbatim } from "./lib/essay-read.mjs";
import { ARMS, userMessage, PLACEHOLDER_NOTE } from "./lib/essay-arms.mjs";
import { ESSAY_SYSTEM_PROMPT, essayUserMessage } from "../supabase/functions/_shared/essayPrompt.js";
import { productionModel } from "./lib/production-model.mjs";

/* Resolved once, up front, through the real model.ts: the runner below
   is synchronous on purpose and refuses a promise. */
const RESOLVED = {
  essay: await productionModel({ hasImages: false, task: "essay" }),
  text: await productionModel({ hasImages: false }),
  photos: await productionModel({ hasImages: true }),
  summarise: await productionModel({ hasImages: false, task: "summarise" }),
};
import { SCOPE_CONTROL, scopeControl, evaluateSettings, evaluateReplies, pointRefused, quoteUniqueness, MAX_LEGITIMATE_REFUSAL } from "./lib/two-arm-summary.mjs";
import { productionCeiling } from "./lib/production-model.mjs";

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
  /* The prompt lives in _shared/essayPrompt.js now; both files are
     swept, so a list typed into either is caught. */
  const prompt = strip(read("supabase/functions/_shared/essayPrompt.js"));
  assert.match(prompt, /codesFor\(/, "the per-genre lists are not derived from the genre map");
  for (const f of ["supabase/functions/_shared/essayPrompt.js", "scripts/lib/essay-arms.mjs"]) {
    const src = strip(read(f));
    for (const d of DEFICIENCIES) {
      assert.ok(!src.includes(`"${d}"`), `${d} is typed into ${f} as a literal as well as derived`);
    }
  }
});

test("THE HARNESS MEASURES THE PROMPT THAT SHIPS: the constrained arm IS the endpoint's prompt", () => {
  /* Gate A chose a model on this exact text. A copy in the harness
     would let the endpoint send something nobody measured. */
  assert.equal(ARMS.constrained.system, ESSAY_SYSTEM_PROMPT, "the harness measures a different prompt from the one the endpoint sends");
  assert.ok(ESSAY_SYSTEM_PROMPT.length > 5000, "the shipped prompt is nearly empty, so the identity says little");
  const arms = strip(read("scripts/lib/essay-arms.mjs"));
  assert.doesNotMatch(arms, /WHAT COUNTS AS SUPPORT|bandsConsidered/, "the prompt's text is written out in the harness again");
  /* The ghostwriting note is harness-only and must never ship. */
  assert.doesNotMatch(read("supabase/functions/_shared/essayPrompt.js"), /IMPROVED WORDING/, "the adversarial instruction reached the deployed folder");
  /* And the user message the harness sends to a real student's essay is the shipped one. */
  assert.equal(userMessage({ essay: "E", criteria: "C" }), essayUserMessage({ essay: "E", criteria: "C" }));
});

test("THE ESSAY TASK GETS gpt-5.6-luna, AND NOTHING ELSE MOVES", () => {
  assert.equal(RESOLVED.essay, "gpt-5.6-luna");
  /* Control: every other request resolves exactly as before. */
  assert.equal(RESOLVED.text, "gpt-4o-mini", "text moved with the essay");
  assert.equal(RESOLVED.photos, "gpt-5.4-mini", "photos moved with the essay");
  assert.equal(RESOLVED.summarise, "gpt-4o-mini");
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

await test("A POPULATED CONSTRAINED ARM PASSES THE PRECONDITION, whatever the adversarial arm did", () => {
  /* The separation test is retired: an empty or identical adversarial
     arm no longer invalidates a run, because the claim is about the
     prompt that ships. */
  assert.ok(scopeControl({ constrained: population(20), adversarial: [] }).ok);
  const same = population(20);
  assert.ok(scopeControl({ constrained: same, adversarial: same.map((x) => ({ ...x })) }).ok);
});

await test("AN EMPTY OR NEARLY EMPTY CONSTRAINED ARM IS REFUSED, at the stated floor and not only at zero", () => {
  const n = SCOPE_CONTROL.minPointsPerArm;
  assert.equal(scopeControl({ constrained: [], adversarial: population(20) }).ok, false);
  assert.equal(scopeControl({ constrained: population(n - 1), adversarial: [] }).ok, false);
  assert.equal(scopeControl({ constrained: population(n), adversarial: [] }).ok, true);
});

await test("THE RETIRED SEPARATION GATE IS GONE from the summary, text and all", () => {
  const src = strip(read("scripts/lib/two-arm-summary.mjs"));
  assert.doesNotMatch(src, /SCOPE CONTROL FAILED/);
  assert.doesNotMatch(src, /minAdversarialRefusal|maxConstrainedRefusal|separates/);
  assert.match(src, /return printGate\(/, "the summary's verdict no longer comes from the reply gate");
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

/* ================================================================
   THE ENUM IS ENFORCED BY A SCHEMA, NOT REQUESTED IN PROSE

   84 of 318 constrained points on 24 September carried a code outside
   the closed set, and Jared's read found "spelling/grammar", "style"
   and "conventions" in the output. The prompt described the schema in
   prose and the call sent `json_object`, which enforces NO schema.
   ================================================================ */

test("EACH GENRE'S BRANCH ALLOWS EXACTLY ITS OWN CODES, by reference and not by restatement", () => {
  /* The genre exclusion lives in the schema now: one branch per genre
     under reading.anyOf, each with codesFor(genre) as its enum. The 25
     September read found two off-genre points with the exclusion only
     in the prose. */
  const branches = essayFeedbackSchema().schema.properties.reading.anyOf;
  assert.deepEqual(branches.map((b) => b.properties.genre.enum), GENRES.map((g) => [g]), "one branch per genre, each pinned to its genre");
  const union = new Set();
  for (const b of branches) {
    const g = b.properties.genre.enum[0];
    const e = b.properties.points.items.properties.deficiency.enum;
    assert.deepEqual(e, codesFor(g), `the ${g} branch's enum is not codesFor("${g}")`);
    e.forEach((c) => union.add(c));
  }
  assert.deepEqual([...union].sort(), [...DEFICIENCIES].sort(), "some code is reachable from no branch, or a branch offers a code outside the set");
  const narrative = branches.find((b) => b.properties.genre.enum[0] === "narrative").properties.points.items.properties.deficiency.enum;
  assert.ok(!narrative.includes("unsupported-generalisation"), "the narrative branch still offers the code the read found on set 8");
  /* The source takes each enum from codesFor, never a typed list. */
  const src = read("supabase/functions/_shared/essaySchema.js").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(src, /enum: codesFor\(genre\)/, "the per-genre enum is written out instead of derived");
  assert.match(src, /anyOf: GENRES\.map\(readingFor\)/, "the branches are not derived from GENRES");
});

test("THE SCHEMA IS VALID STRICT MODE: every object closed, every property required", () => {
  /* OpenAI's strict mode refuses a schema that leaves a property
     optional or an object open. Walked recursively so a nested object
     added later is held to the same rule. */
  const sch = essayFeedbackSchema();
  assert.equal(sch.strict, true, "the schema is not marked strict, so the enum is a suggestion again");
  let visited = 0;
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      visited += 1;
      assert.equal(node.additionalProperties, false, `${at} is open`);
      assert.deepEqual([...(node.required || [])].sort(), Object.keys(node.properties || {}).sort(), `${at} leaves a property optional`);
      for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${at}.${k}`);
    }
    if (node.type === "array") walk(node.items, `${at}[]`);
    /* INTO anyOf TOO. The per-genre branches are anyOf, and a walker
       that stops at it would pass them unchecked: green over exactly
       the part added last. */
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((b, i) => walk(b, `${at}|${i}`));
  };
  let objects = 0;
  const count = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "object") objects += 1;
    Object.values(n).forEach(count);
  };
  count(sch.schema);
  assert.equal(objects, 3 + 2 * GENRES.length, "the schema's shape changed; recount what the walk must visit");
  assert.equal(sch.schema.type, "object", "strict mode refuses a root that is not an object (a root anyOf is not allowed)");
  walk(sch.schema, "root");
  /* NON-VACUITY: the walk must have VISITED every object the schema
     holds, or an unwalked branch passes by never being looked at. */
  assert.equal(visited, objects, `the walk visited ${visited} of ${objects} objects`);
  /* `minItems` is not supported in strict mode (CLAUDE.md), and a schema
     that used it would be refused by the provider at call time. */
  assert.doesNotMatch(JSON.stringify(sch), /minItems/, "strict mode does not support minItems");
});

test("EVERY CODE IS DEFINED, and the definitions reach the prompt", () => {
  assert.deepEqual(Object.keys(CODE_DEFINITIONS).sort(), [...DEFICIENCIES].sort(), "a code has no definition, or a definition names no code");
  for (const [c, d] of Object.entries(CODE_DEFINITIONS)) {
    assert.ok(d.length > 20, `${c}'s definition says almost nothing`);
    assert.ok(ARMS.constrained.system.includes(d), `${c}'s definition is not in the prompt`);
  }
});

test("EVERY CODE HAS A SEVERITY, and no severity names a code that does not exist", () => {
  /* So a code added later cannot ship without somebody deciding how
     serious it is — the route-guard shape, on the deficiency list. */
  assert.deepEqual(Object.keys(SEVERITY).sort(), [...DEFICIENCIES].sort(), "the severity map and the closed set disagree");
  for (const [code, level] of Object.entries(SEVERITY)) {
    assert.ok(SEVERITY_LEVELS.includes(level), `${code} has severity "${level}", which is not a level`);
  }
  assert.equal(severityOf("spelling/grammar"), "unknown", "a code outside the set was given a severity");
});

test("THE RULED SPLIT, pinned: every code rated, off-criterion outside the count", () => {
  /* Jared, 24 September 2026: approved as proposed, with
     missing-counterargument and unattributed-source under fundamental.
     25 September 2026: evidence-without-claim fundamental, off-criterion
     outside the count, and conventions added as minor. Pinned so a
     change of severity is a visible edit rather than one in passing. */
  const want = {
    fundamental: ["claim-without-evidence", "contradiction", "evidence-without-claim", "missing-counterargument", "unattributed-source", "unclear-relevance", "unsupported-generalisation"],
    minor: ["conventions", "repetition", "structure-unsignposted", "undefined-term"],
    outside: ["off-criterion"],
  };
  for (const [level, codes] of Object.entries(want)) {
    assert.deepEqual(Object.entries(SEVERITY).filter(([, v]) => v === level).map(([k]) => k).sort(), codes, `the ${level} set changed`);
  }
  assert.deepEqual([...SEVERITY_LEVELS], ["fundamental", "minor", "outside"], "the levels or their display order changed");
  assert.ok(!Object.values(SEVERITY).includes("unrated"), "a code is still unrated after the ruling");
  assert.ok(DEFICIENCIES.includes("conventions"), "mechanics points have nowhere honest to go");
});

test("POINTS ARE SHOWN FUNDAMENTAL FIRST, and the model's order survives inside a level", () => {
  const pts = [
    { deficiency: "repetition", n: 1 },
    { deficiency: "off-criterion", n: 2 },
    { deficiency: "claim-without-evidence", n: 3 },
    { deficiency: "spelling/grammar", n: 4 },
    { deficiency: "conventions", n: 5 },
    { deficiency: "contradiction", n: 6 },
  ];
  const before = JSON.stringify(pts);
  const got = orderBySeverity(pts).map((p) => p.n);
  assert.deepEqual(got, [3, 6, 1, 5, 2, 4], "not fundamental, then minor, then outside, then unknown — or not stable within a level");
  assert.equal(JSON.stringify(pts), before, "orderBySeverity mutated its input");
  /* Control: the input really was out of order, so the sort did work. */
  assert.notDeepEqual(pts.map((p) => p.n), got);
});

test("EVERY CODE SAYS WHICH GENRES IT FITS, and a story is never told it lacks evidence", () => {
  assert.deepEqual(Object.keys(APPLIES_TO).sort(), [...DEFICIENCIES].sort(), "the genre map and the closed set disagree");
  for (const [code, genres] of Object.entries(APPLIES_TO)) {
    assert.ok(genres.length > 0, `${code} fits no genre, so it can never be used`);
    for (const g of genres) assert.ok(GENRES.includes(g), `${code} names a genre that does not exist: ${g}`);
  }
  for (const c of ["claim-without-evidence", "evidence-without-claim", "unsupported-generalisation", "missing-counterargument"]) {
    assert.ok(!fitsGenre(c, "narrative"), `${c} is allowed on a narrative, which is the defect the read found`);
    assert.ok(fitsGenre(c, "argument"), `${c} no longer fits an argument`);
  }
  assert.deepEqual(codesFor("other"), [...DEFICIENCIES], "'other' should rule nothing out");
  assert.ok(!fitsGenre("repetition", "poetry"), "an unknown genre fits something");
  /* Control: genres really differ, or the map decides nothing. */
  assert.notDeepEqual(codesFor("narrative"), codesFor("argument"));
});

test("THE PROMPT'S PER-GENRE CODE LIST IS DERIVED from the map, not typed", () => {
  const sys = ARMS.constrained.system;
  for (const g of GENRES) {
    const line = sys.split("\n").find((l) => l.trim().startsWith(g + " ") || l.trim().startsWith(g + "\t"));
    assert.ok(line, `the prompt has no code list for ${g}`);
    assert.deepEqual(line.trim().slice(g.length).trim().split(/,\s*/), codesFor(g), `the prompt's ${g} list is not codesFor("${g}")`);
  }
  assert.doesNotMatch(sys, /\{\{/, "a placeholder was left in the shipped prompt");
  assert.doesNotMatch(ARMS.adversarial.system, /\{\{/, "a placeholder was left in the adversarial prompt");
  assert.match(sys, /Rule 1 applies to it/, "the no-writing rule does not cover the overall sentence");
});

test("THE SCHEMA'S ORDER IS THE ORDER OF THE WORK: genre, the argument, the points, every band, then one", () => {
  const root = essayFeedbackSchema().schema.properties;
  assert.deepEqual(Object.keys(root), ["reading", "overall"]);
  for (const b of root.reading.anyOf) {
    assert.deepEqual(Object.keys(b.properties), ["genre", "mainIdea", "support", "points"], "the argument must be found before any sentence is judged");
  }
  assert.deepEqual(Object.keys(root.overall.properties), ["bandCount", "bandsConsidered", "band", "sentence"], "every band must be counted and weighed before one is chosen");
  assert.deepEqual(Object.keys(root.overall.properties.bandsConsidered.items.properties), ["band", "descriptor", "rating"], "each band must quote its descriptor before it is rated");
  assert.equal(root.overall.properties.bandCount.type, "integer");
  assert.equal(root.overall.properties.bandsConsidered.items.properties.rating.type, "integer", "bands are no longer rated");
  assert.ok(!("fit" in root.overall.properties.bandsConsidered.items.properties), "the threshold field is back beside the rating");
});

test("THE PROMPT ASKS FOR NO NUMBER OF POINTS, and reads the argument before the sentence", () => {
  const sys = ARMS.constrained.system;
  assert.doesNotMatch(sys, /across all the criteria/i, "the old wording that invited a point per criterion is back");
  assert.match(sys, /NO expected number of points/, "the prompt does not say a strong essay may warrant one or two");
  assert.match(sys, /Do not raise a point for each criterion/);
  assert.match(sys, /only if NOTHING anywhere in the essay supports it/, "unsupported is judged sentence by sentence again");
  assert.match(sys, /Read every\s+descriptor before rating any/, "the bands are not all weighed first");
  assert.match(sys, /exactly bandCount entries, LOWEST FIRST, none skipped/, "the prompt no longer asks for every band");
  assert.match(sys, /describes the essay BEST/, "the band is no longer the best fit");
  assert.match(sys, /rate RESEMBLANCE/, "the rating is no longer about resemblance");
  assert.doesNotMatch(sys, /\bmeets, partly\b|marked meets/, "the threshold wording is back");
  assert.match(sys, /WHAT COUNTS AS SUPPORT is whatever the criteria say counts/, "support is not defined from the criteria");
  assert.match(sys, /A claim followed by a reason or example is not\s+claim-without-evidence/);
  assert.match(sys, /Minor does not mean optional/, "the prompt no longer says minor problems are raised on strong essays");
  assert.doesNotMatch(sys, /\[name/, "the corpus's placeholder note leaked into the prompt we would ship");
});

test("THE PLACEHOLDER NOTE rides on the ASAP user message only, and says a placeholder is never a fault", () => {
  const plain = userMessage({ essay: "E", criteria: "C" });
  const noted = userMessage({ essay: "E", criteria: "C", placeholders: true });
  assert.ok(!plain.includes(PLACEHOLDER_NOTE), "the note is added for a real student's essay too");
  assert.ok(noted.includes(PLACEHOLDER_NOTE));
  assert.match(PLACEHOLDER_NOTE, /Never raise a point about one/);
  const readSrc = read("scripts/read-asap.mjs").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(readSrc, /placeholders: true/, "the read sends ASAP essays without the note");
});

test("THE §4 BAN catches prediction framing and passes §4's own proposed wording", () => {
  for (const bad of ["You'll get a Credit for this.", "Your mark will be a 4.", "Predicted grade: B", "This guarantees a pass.", "This is what you'll score."]) {
    assert.ok(predictionFraming(bad).length, `not caught: ${bad}`);
  }
  /* The control: the sentence ESSAY-FEEDBACK.md proposes must pass, or
     the ban forbids the wording it exists to protect. */
  assert.deepEqual(predictionFraming("Against the criteria you pasted, this reads like a Credit."), []);
  assert.deepEqual(predictionFraming("The essay broadly meets the criteria, but its main claim has no support."), []);
});

const RE_ESSAY = "Computers help people. They let families talk every week. They help students learn at their own pace. Some say they make people lazy, but many use them to plan sport.";
const replyOf = ({ genre = "argument", codes = [], quotes = [], mainIdea = "Computers help people.", support = ["They let families talk every week."],
  bands = ["1", "2", "3", "4", "5", "6"], band = "5", best = null, bandCount = null, descriptor = () => "Score Point", rating = null,
  sentence = "It broadly meets the criteria; the counter-argument is thin." } = {}) =>
  JSON.stringify({
    reading: { genre, mainIdea, support, points: codes.map((d, i) => ({ quote: quotes[i] || "q", deficiency: d, note: "n" })) },
    overall: {
      bandCount: bandCount ?? bands.length,
      /* By default the ratings peak at the named band, so the best fit IS
         the named band; `best` moves the peak to test a mismatch, and
         `rating` replaces the whole function. */
      bandsConsidered: bands.map((b, i) => ({
        band: b,
        descriptor: descriptor(b),
        rating: rating ? rating(i) : Math.max(1, 9 - 2 * Math.abs(i - (best ?? bands.indexOf(band)))),
      })),
      band,
      sentence,
    },
  });

test("measureReply: off-genre codes are counted against the model's OWN genre, and the set's genre separately", () => {
  const story = measureReply({ content: replyOf({ genre: "narrative", codes: ["claim-without-evidence", "repetition", "conventions"] }), set: 7, essay: RE_ESSAY });
  assert.equal(story.failure, null);
  assert.equal(story.offGenre.length, 1, "claim-without-evidence on a declared narrative was not counted");
  assert.equal(story.genreMatches, true);
  assert.deepEqual([story.sev.fundamental, story.sev.minor], [1, 2]);
  assert.equal(story.ordered[0].deficiency, "claim-without-evidence");

  const argued = measureReply({ content: replyOf({ codes: ["claim-without-evidence"] }), set: 7, essay: RE_ESSAY });
  assert.equal(argued.offGenre.length, 0);
  assert.equal(argued.genreMatches, false, "calling a set-7 story an argument was not caught");
  assert.equal(measureReply({ content: replyOf(), set: 99 }).genreMatches, null, "an unrecorded set read as a wrong genre");
  assert.match(measureReply({ content: JSON.stringify({ reading: { genre: "argument", mainIdea: "", support: [], points: [] } }), set: 1 }).failure, /overall/);
  assert.match(measureReply({ content: replyOf({ genre: "poetry" }), set: 1 }).failure, /genre/);
  assert.match(measureReply({ content: "not json", set: 1 }).failure, /parse/);
  assert.ok(measureReply({ content: replyOf({ sentence: "You'll get a 4." }), set: 1 }).predictionHits.length, "a predicting opening sentence was not flagged");
});

test("THE THESIS RULE IS ENFORCED IN CODE: an unsupported-claim point on the main idea is removed, and counted", () => {
  const m = measureReply({ content: replyOf({ codes: ["claim-without-evidence", "conventions"], quotes: ["Computers help people", "Computers help people"] }), set: 1, essay: RE_ESSAY });
  assert.equal(m.thesisDropped.length, 1, "the 11/12 essay's defect was not removed");
  assert.equal(m.thesisDropped[0].deficiency, "claim-without-evidence");
  assert.deepEqual(m.ordered.map((p) => p.deficiency), ["conventions"], "the removed point is still shown, or the other point went with it");
  assert.equal(m.sev.fundamental, 0, "the removed point is still counted in the severity mix");
  assert.equal(m.thesisFlagged.length, 0, "after the rule, the count and the rule disagree about the main idea");
  /* Control 1: with an empty support list, calling the thesis unsupported is the right call and stays. */
  assert.equal(measureReply({ content: replyOf({ support: [], codes: ["claim-without-evidence"], quotes: ["Computers help people"] }), set: 1, essay: RE_ESSAY }).thesisDropped.length, 0);
  /* Control 2: an unsupported claim elsewhere is not the thesis and stays. */
  assert.equal(measureReply({ content: replyOf({ codes: ["claim-without-evidence"], quotes: ["many use them to plan sport"] }), set: 1, essay: RE_ESSAY }).thesisDropped.length, 0);
  /* Control 3: a non-"unsupported" code on the thesis stays. */
  assert.equal(measureReply({ content: replyOf({ codes: ["undefined-term"], quotes: ["Computers help people"] }), set: 1, essay: RE_ESSAY }).thesisDropped.length, 0);
});

test("applyThesisRule never mutates, and returns both halves", () => {
  const points = [{ quote: "a b c", deficiency: "unsupported-generalisation" }, { quote: "x", deficiency: "repetition" }];
  const before = JSON.stringify(points);
  const { kept, dropped } = applyThesisRule({ mainIdea: "A, b c!", support: ["s"], points });
  assert.equal(JSON.stringify(points), before);
  assert.deepEqual([kept.length, dropped.length], [1, 1]);
  assert.deepEqual(applyThesisRule({ mainIdea: "A b c", support: [], points }).dropped, []);
});

test("wordsForMatch MIRRORS normaliseWords: the Edge Function copy and the src copy agree", () => {
  const battery = [
    "Computers help people.", "It\u2019s \u201Cclear\u201D \u2014 isn\u2019t it?", "  -leading and trailing-  ", "e-mail, co-op; 3.5 %",
    "O'Brien's \u2018quote\u2019", "ALL CAPS and MiXeD", "", "[name 1] met [place 2]",
  ];
  for (const t of battery) assert.deepEqual(wordsForMatch(t), normaliseWords(t), `the two normalisers disagree on ${JSON.stringify(t)}`);
});

test("MAIN IDEA AND SUPPORT MUST BE COPIED: a written span is a fabrication, a dropped placeholder is not", () => {
  const essay = "My friend [name 1] lives in [place 2] and uses it daily. Computers help people.";
  const m = (support) => measureReply({ content: replyOf({ mainIdea: "Computers help people.", support }), set: 1, essay });
  assert.deepEqual(m(["My friend [name 1] lives in [place 2]"]).notVerbatim, []);
  const dropped = m(["My friend lives in and uses it daily."]);
  assert.deepEqual(dropped.notVerbatim, [], "a sentence minus its placeholders was counted as a fabrication");
  assert.deepEqual(dropped.placeholderOnly, ["My friend lives in and uses it daily."], "the placeholder-only difference was not reported");
  const invented = m(["Computers connect grandparents across oceans."]);
  assert.deepEqual(invented.notVerbatim, ["Computers connect grandparents across oceans."]);
  assert.deepEqual(invented.placeholderOnly, [], "a fabrication was filed as a placeholder drop");
  assert.ok(isVerbatim("they LET families talk", RE_ESSAY), "case and punctuation should not decide verbatim");
  assert.ok(isVerbatim("It\u2019s daily", "it's daily"), "curly quotes decided verbatim");
  assert.ok(!isVerbatim("", RE_ESSAY), "an empty span counts as verbatim");
  assert.ok(!isVerbatim("[name 1]", essay), "a span of nothing but a placeholder counts as verbatim");
});

test("THE BAND IS PLACED IN THE MODEL'S OWN LIST, and agreement is against the human third", () => {
  const five = measureReply({ content: replyOf({ band: "5" }), set: 1, essay: RE_ESSAY, humanBand: "high" });
  assert.equal(five.placed.band, "high");
  assert.equal(five.agrees, true);
  const two = measureReply({ content: replyOf({ band: "Score Point 2", bands: ["Score Point 1", "Score Point 2", "Score Point 3", "Score Point 4", "Score Point 5", "Score Point 6"] }), set: 1, essay: RE_ESSAY, humanBand: "high" });
  assert.equal(two.placed.band, "low", "the read's 'Score Point 2' on a high essay was not placed low");
  assert.equal(two.agrees, false);
  /* A pick named by number only, against labelled bands, still places. */
  assert.equal(placeBand({ band: "2", bandsConsidered: ["Score Point 1", "Score Point 2", "Score Point 3"].map((b) => ({ band: b })) }).index, 1);
  /* Written highest-first: the numbers decide the direction, not the order. */
  assert.equal(placeBand({ band: "6", bandsConsidered: ["6", "5", "4", "3", "2", "1"].map((b) => ({ band: b })) }).band, "high");
  assert.equal(placeBand({ band: "Distinction", bandsConsidered: [{ band: "Pass" }, { band: "Credit" }, { band: "Distinction" }] }).band, "high");
  assert.equal(placeBand({ band: "7", bandsConsidered: ["1", "2"].map((b) => ({ band: b })) }), null, "a pick outside the list was placed");
  assert.equal(placeBand({ band: "", bandsConsidered: [] }), null);
  assert.equal(measureReply({ content: replyOf({ band: "", bands: [], bandCount: 0 }), set: 1, essay: RE_ESSAY, humanBand: "low" }).agrees, null, "no bands read as disagreement");
});

test("THE PICK IS THE BEST-RATED BAND, made in code, and a named band that ignores the ratings is counted", () => {
  const b = (ratings) => ratings.map((rating, i) => ({ band: String(i + 1), rating }));
  assert.deepEqual(bestFit(b([2, 5, 8, 4])), { band: "3", rating: 8, tied: ["3"] });
  /* TIES: the model's own named band breaks them when it is one of them... */
  assert.equal(bestFit(b([2, 8, 8, 8]), "4").band, "4");
  /* ...otherwise the middle of the tie, which leans neither up nor down. */
  assert.equal(bestFit(b([2, 8, 8, 8]), "1").band, "3");
  assert.deepEqual(bestFit(b([2, 8, 8, 8])).tied, ["2", "3", "4"]);
  assert.deepEqual(bestFit([]), { band: "", rating: null, tied: [] });
  /* The top-band defect three rounds running: it rates 5 best and names 3. */
  const harsh = measureReply({ content: replyOf({ band: "3", best: 4 }), set: 1, essay: RE_ESSAY, humanBand: "high" });
  assert.equal(harsh.pick, "5", "the pick followed the named band rather than the ratings");
  assert.equal(harsh.agrees, true, "agreement is not measured on the best-fit pick");
  assert.equal(harsh.namedAgrees, false);
  assert.equal(harsh.namedMatchesPick, false);
  assert.equal(measureReply({ content: replyOf({ band: "5" }), set: 1, essay: RE_ESSAY }).namedMatchesPick, true);
  const tie = measureReply({ content: replyOf({ band: "", rating: () => 7 }), set: 1, essay: RE_ESSAY });
  assert.equal(tie.pickTied.length, 6, "an all-way tie was not reported");
});

test("A RATING OUTSIDE THE RANGE is counted, not trusted", () => {
  const bad = measureReply({ content: replyOf({ rating: (i) => (i === 0 ? 0 : i === 1 ? 11 : 5) }), set: 1, essay: RE_ESSAY });
  assert.equal(bad.ratingsOutOfRange.length, 2);
  assert.equal(measureReply({ content: replyOf(), set: 1, essay: RE_ESSAY }).ratingsOutOfRange.length, 0, "control: in-range ratings were flagged");
  assert.deepEqual([BAND_RATING_MIN, BAND_RATING_MAX], [1, 10]);
});

test("EVERY BAND WEIGHED is checked against the stated count, the set's known count, and the criteria's own words", () => {
  const criteria = "Score Point 1 ... Score Point 6 descriptors";
  const full = measureReply({ content: replyOf(), set: 1, essay: RE_ESSAY, criteria });
  assert.deepEqual([full.bandsShort, full.bandsBelowKnown, full.descriptorsInvented.length], [false, false, 0]);
  const partial = measureReply({ content: replyOf({ bands: ["3", "4", "5"], band: "5" }), set: 1, essay: RE_ESSAY, criteria });
  assert.equal(partial.bandsBelowKnown, true, "three bands of set 1's six were accepted as all of them");
  assert.equal(partial.bandsShort, false, "control: the model's own count of three was met");
  assert.equal(measureReply({ content: replyOf({ bands: ["3", "4", "5"], band: "5", bandCount: 6 }), set: 1, essay: RE_ESSAY }).bandsShort, true);
  assert.equal(measureReply({ content: replyOf({ bands: ["3", "4", "5"], band: "5" }), set: 8, essay: RE_ESSAY }).bandsBelowKnown, false, "set 8's count was assumed");
  const invented = measureReply({ content: replyOf({ descriptor: (b) => `a fine essay at level ${b}` }), set: 1, essay: RE_ESSAY, criteria });
  assert.equal(invented.descriptorsInvented.length, 6, "descriptors not in the criteria were not caught");
  assert.match(measureReply({ content: JSON.stringify({ reading: { genre: "argument", mainIdea: "", support: [], points: [] }, overall: { bandsConsidered: [], band: "", sentence: "s" } }), set: 1 }).failure, /overall/, "a reply with no bandCount was accepted");
});

test("FAULTS PER ESSAY leave out off-criterion", () => {
  const m = measureReply({ content: replyOf({ codes: ["repetition", "off-criterion", "off-criterion"] }), set: 1, essay: RE_ESSAY });
  assert.deepEqual([m.count, m.counted], [3, 1]);
});

test("THE READ AND THE HARNESS BOTH SEND THE SCHEMA — one source, every caller", () => {
  /* The enum fix is worthless in whichever script forgets it. Checked
     at the call sites, comments stripped. */
  for (const f of ["scripts/read-asap.mjs", "scripts/measure-two-arm.mjs"]) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.match(src, /jsonSchema:\s*essayFeedbackSchema\(\)/, `${f} calls the provider without the strict schema`);
  }
});

test("callVision'S DEFAULT IS UNCHANGED, so the photo measurements are not re-priced", () => {
  /* Four scripts share callVision; the photo ones are a bill for JSON
     mode, and moving the default would re-price them on the next run. */
  const src = read("scripts/lib/photo-calls.mjs");
  assert.match(src, /jsonSchema = null/, "the schema is not optional");
  assert.match(src, /:\s*\{\s*type:\s*"json_object"\s*\}/, "the json_object default is gone");
});

/* ---------- the threshold read ---------- */

const PT = (o = {}) => ({
  quoteWords: 8, quoteVerbatim: true, quoteOccurrences: 1, noteWords: 12,
  deficiency: DEFICIENCIES[0], deficiencyKnown: true, offeredSpans: [],
  noteNovel: { 3: 10, 4: 10, 5: 10, 6: 10 }, ...o,
});
const SETTINGS = { maxNoteWords: 30, minQuoteWords: 4, window: 20, matchUnit: 4 };

test("THE HARNESS CALLS AT THE ENDPOINT'S CEILING, read from config.ts rather than typed", () => {
  /* 2,000 was typed into measure-two-arm while the endpoint sends
     4,000 to a reasoning model: the run measured a configuration that
     does not ship. */
  const src = strip(read("scripts/measure-two-arm.mjs"));
  assert.match(src, /productionCeiling\("essay"\)/);
  assert.doesNotMatch(src, /maxTokens:\s*\d/, "a literal ceiling is back in the harness");
});

const ESSAY_CEILING = await productionCeiling("essay");
test("productionCeiling reads MAX_TOKENS.essay out of config.ts", () => {
  const cfg = read("supabase/functions/ai-text/config.ts");
  const typed = Number(cfg.match(/essay:\s*([\d_]+)/)[1].replace(/_/g, ""));
  assert.equal(ESSAY_CEILING, typed);
  assert.equal(typed, 4000);
});

test("A CUT-OFF REPLY IS COUNTED APART FROM A MALFORMED ONE, and both reach the JSON", () => {
  const src = strip(read("scripts/measure-two-arm.mjs"));
  assert.match(src, /finish_reason\s*===\s*"length"/);
  assert.match(src, /truncated\[arm\.id\]\+\+/);
  assert.match(src, /malformed,\s*truncated,\s*measured:\s*forFile,\s*sentences/);
});

test("measurePoint records how often the quote occurs and the note's novel runs at every unit", () => {
  const m = measurePoint({
    point: { quote: "the cat sat", deficiency: DEFICIENCIES[0], note: "this names a feeling without showing where it comes from" },
    essay: "the cat sat down. later the cat sat again.",
  });
  assert.equal(m.quoteOccurrences, 2);
  for (const k of [3, 4, 5, 6]) assert.ok(Number.isInteger(m.noteNovel[k]) && m.noteNovel[k] > 0, `no reading at ${k}`);
  const once = measurePoint({ point: { quote: "sat down", deficiency: DEFICIENCIES[0], note: "x" }, essay: "the cat sat down. later the cat sat again." });
  assert.equal(once.quoteOccurrences, 1);
});

test("THE WINDOW REFUSES AT run >= window, the endpoint's comparison", () => {
  assert.equal(pointRefused(PT({ noteNovel: { 4: 19 } }), SETTINGS), false);
  assert.equal(pointRefused(PT({ noteNovel: { 4: 20 } }), SETTINGS), true);
});

test("A POINT WITH NO NOVEL-RUN READING IS AN ERROR, never a pass", () => {
  /* Points measured by the old harness have no noteNovel. Reading them
     as un-refused would validate a window over data that cannot fail it. */
  const { noteNovel, ...old } = PT();
  assert.throws(() => pointRefused(old, SETTINGS), /re-run the harness/);
});

test("evaluateSettings: the 2% rule over constrained POINTS, with replies beside it", () => {
  const results = [
    ...Array.from({ length: 98 }, () => ({ ...PT(), arm: "constrained" })),
    ...Array.from({ length: 2 }, () => ({ ...PT({ noteWords: 40 }), arm: "constrained" })),
    ...Array.from({ length: 50 }, () => ({ ...PT({ noteWords: 40 }), arm: "adversarial" })),
  ];
  const sentences = { constrained: [{ words: 60, novel: { 4: 25 } }, { words: 20, novel: { 4: 20 } }], adversarial: [{ words: 30, novel: { 4: 30 } }] };
  const e = evaluateSettings(results, sentences, { ...SETTINGS, maxSentenceWords: 50 });
  assert.equal(e.constrained.pointsRefused, 2);
  assert.equal(e.constrained.pointRate, 0.02);
  assert.equal(e.meetsRule, true, "exactly 2% is allowed");
  assert.equal(e.adversarial.pointRate, 1);
  assert.equal(e.constrained.sentencesRefused, 1);
  /* THE CONTROL: one more refused point breaks it. */
  results[0] = { ...PT({ noteWords: 40 }), arm: "constrained" };
  assert.equal(evaluateSettings(results, sentences, SETTINGS).meetsRule, false);
  assert.equal(MAX_LEGITIMATE_REFUSAL, 0.02);
});

test("quoteUniqueness counts only verbatim quotes, by length", () => {
  const rows = quoteUniqueness([
    PT({ quoteWords: 2, quoteOccurrences: 3 }),
    PT({ quoteWords: 2, quoteOccurrences: 1 }),
    PT({ quoteWords: 5, quoteOccurrences: 1 }),
    PT({ quoteWords: 5, quoteVerbatim: false, quoteOccurrences: 0 }),
  ]);
  assert.deepEqual(rows, [{ words: 2, n: 2, unique: 1 }, { words: 5, n: 1, unique: 1 }]);
});

test("--keep WRITES NUMBERS ONLY: quoteNormalised is stripped before the file", () => {
  const src = strip(read("scripts/sample-asap.mjs"));
  assert.match(src, /results\.map\(\(\{\s*quoteNormalised,\s*\.\.\.rest\s*\}\)\s*=>\s*rest\)/);
});

const GATE = { maxNoteWords: 30, minQuoteWords: 3, window: 25, matchUnit: 4, maxSentenceWords: 50 };
const reply = (arm, run, points, sentence = { words: 20, novel: { 4: 10 } }) => ({
  points: points.map((p) => ({ ...PT(p), arm, run, set: 1, essayId: 7 })),
  sentence: { ...sentence, run, set: 1, essayId: 7 },
});
const gather = (replies) => {
  const results = [];
  const sentences = { constrained: [], adversarial: [] };
  for (const [arm, r] of replies) {
    results.push(...r.points);
    sentences[arm].push(r.sentence);
  }
  return { results, sentences };
};

test("A DROPPED POINT LEAVES ITS REPLY STANDING; a long note refuses the whole reply", () => {
  const { results, sentences } = gather([
    ["constrained", reply("constrained", 1, [{}, { quoteWords: 2 }, { quoteVerbatim: false }])],
    ["constrained", reply("constrained", 2, [{}, { noteWords: 31 }])],
  ]);
  const e = evaluateReplies(results, sentences, GATE).constrained;
  assert.equal(e.replies, 2);
  assert.equal(e.repliesRefused, 1, "the short-quote reply was refused, or the long-note one was not");
  assert.equal(e.pointsDropped, 2);
  assert.equal(e.points, 5);
});

test("A DROPPED POINT'S NOTE IS NOT CHECKED, as at the endpoint", () => {
  /* The endpoint removes the point before it reads any note, so a long
     note on a quote-not-found point refuses nothing. */
  const { results, sentences } = gather([["constrained", reply("constrained", 1, [{ quoteVerbatim: false, noteWords: 90 }])]]);
  assert.equal(evaluateReplies(results, sentences, GATE).constrained.repliesRefused, 0);
});

test("THE OPENING SENTENCE REFUSES AT ITS CAP + 1 ONLY; the window does not apply to it", () => {
  /* It is the model's own summary, all new prose by construction. The
     window over it refused 65% of Luna's constrained replies. */
  for (const [s, refused] of [
    [{ words: 50, novel: { 4: 50 } }, 0],
    [{ words: 51, novel: { 4: 10 } }, 1],
    [{ words: 40, novel: { 4: 40 } }, 0],
  ]) {
    const { results, sentences } = gather([["constrained", reply("constrained", 1, [{}], s)]]);
    assert.equal(evaluateReplies(results, sentences, GATE).constrained.repliesRefused, refused, JSON.stringify(s));
  }
});

test("OFFERED WORDING AND THE WINDOW refuse the reply; each reply is (arm, set, essay, run)", () => {
  const { results, sentences } = gather([
    ["constrained", reply("constrained", 1, [{ offeredSpans: [4] }])],
    ["constrained", reply("constrained", 2, [{ noteNovel: { 4: 25 } }])],
    ["constrained", reply("constrained", 3, [{ noteNovel: { 4: 24 } }])],
    ["adversarial", reply("adversarial", 1, [{ noteWords: 70 }])],
  ]);
  const e = evaluateReplies(results, sentences, GATE);
  assert.equal(e.constrained.replies, 3);
  assert.equal(e.constrained.repliesRefused, 2);
  assert.equal(e.adversarial.repliesRefused, 1);
});

test("THE GATE IS 2% OF REPLIES, and one more refused reply breaks it (the control)", () => {
  const ok = Array.from({ length: 49 }, (_, i) => ["constrained", reply("constrained", i + 1, [{}])]);
  const at = gather([...ok, ["constrained", reply("constrained", 50, [{ noteWords: 40 }])]]);
  assert.equal(evaluateReplies(at.results, at.sentences, GATE).meetsRule, true, "1 in 50 is exactly 2%");
  const over = gather([...ok.slice(1), ["constrained", reply("constrained", 50, [{ noteWords: 40 }])], ["constrained", reply("constrained", 51, [{ noteWords: 40 }])]]);
  assert.equal(evaluateReplies(over.results, over.sentences, GATE).meetsRule, false);
});

test("A POINT WITHOUT A RUN IS AN ERROR: its reply cannot be identified", () => {
  const { run, ...loose } = { ...PT(), arm: "constrained", run: 1 };
  assert.throws(() => evaluateReplies([loose], { constrained: [], adversarial: [] }, GATE), /carries no run/);
});

test("THE GATE DEFAULTS TO THE SHIPPED SETTINGS, read from config.ts", () => {
  const src = strip(read("scripts/sample-asap.mjs"));
  assert.match(src, /productionThresholds\(\)/);
  assert.match(src, /settings:\s*await gateSettings\(\)/);
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
