/* The no-writing constraint: can it tell "points at a problem" from
   "hands you something to paste"?

   ESSAY-FEEDBACK.md §3 layer 3. The mechanism is a substring question
   — locating a problem requires quoting the student, offering
   replacement wording produces prose that is not in the input — and
   the two are separated by whether the text already exists.

   THE THRESHOLD IS NOT TESTED HERE, BECAUSE IT DOES NOT EXIST YET.
   §3 proposes 12 words and says in the same breath that 12 is "a
   starting point, not a measurement, and it must be measured before
   it ships". So the module REFUSES without one, and the test that
   matters most in this file is the one asserting it refuses:
   `scripts/measure-no-writing.mjs` produces the distribution, a person
   reads where the populations separate, and only then is a number
   written down.

   What IS tested is the mechanism at a window the test supplies
   itself — which is a claim about the arithmetic, not about the
   threshold.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveEssayMessages } from "./lib/essay-prompt.mjs";
import {
  normaliseWords,
  gramSet,
  coverage,
  novelRuns,
  longestNovelRun,
  quotedSpans,
  checkNoWriting,
} from "../src/noWriting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous; a promise would report a pass before it settled");
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
workers left the countryside. Historians disagree about whether living standards rose or
fell during this period, and the debate turns on which price index is used.`;

const CRITERIA = `Argument: a clear thesis sustained throughout.
Evidence: specific examples with dates.
Structure: signposted paragraphs.`;

/* ---------- 1. the refusal ---------- */

test("IT REFUSES WITHOUT A MEASURED WINDOW — a default would be the mistake the document warns about", () => {
  /* A default is worse than an UNMEASURED marker here, because a
     default WORKS: the feature would ship on a number nobody sized,
     which is TYPICAL_SUMMARY_OUTPUT_TOKENS at 5.9x reality with an
     academic-integrity claim attached. */
  assert.throws(() => checkNoWriting({ fields: ["x"], essay: ESSAY }), /has no default/);
  assert.throws(() => checkNoWriting({ fields: ["x"], essay: ESSAY, matchUnit: 5 }), /window must be/);
  assert.throws(() => novelRuns("x", ESSAY, {}), /matchUnit must be/);
  assert.throws(() => gramSet(["a"], 0), /matchUnit must be/);
  /* And it refuses a non-integer rather than coercing, because
     `--window 12.5` silently flooring is how a measured number stops
     being the number that was measured. */
  assert.throws(() => novelRuns("x", ESSAY, { matchUnit: 2.5 }), /matchUnit must be/);
});

test("the error names the instrument, so somebody who hits it knows what to run", () => {
  try {
    checkNoWriting({ fields: ["x"] });
    assert.fail("did not throw");
  } catch (e) {
    assert.match(e.message, /measure-no-writing\.mjs/);
  }
});

/* ---------- 2. the arithmetic ---------- */

test("normalising keeps intra-word apostrophes and hyphens, and folds curly quotes", () => {
  assert.deepEqual(normaliseWords("The student’s well-argued point."), ["the", "student's", "well-argued", "point"]);
  /* A quotation differing from the essay only by an apostrophe style
     is the student's own words; treating it as novel would refuse a
     correct quotation. */
  assert.deepEqual(normaliseWords("“living standards”"), normaliseWords('"living standards"'));
  assert.deepEqual(normaliseWords("  "), []);
});

test("coverage marks every position of a matched run, not just its start", () => {
  const src = normaliseWords("the urban population grew rapidly as workers left");
  const cand = normaliseWords("the urban population grew rapidly");
  const cov = coverage(cand, gramSet(src, 3), 3);
  assert.deepEqual(cov, [true, true, true, true, true]);
});

test("a run shorter than matchUnit cannot be covered, which is why matchUnit is a floor and not a threshold", () => {
  const cov = coverage(normaliseWords("factory production"), gramSet(normaliseWords(ESSAY), 5), 5);
  assert.deepEqual(cov, [false, false], "two words cannot match a five-word unit");
});

test("A QUOTATION OF THE ESSAY HAS NO NOVEL RUN AT ALL", () => {
  const quoted = "Historians disagree about whether living standards rose or fell during this period";
  assert.equal(longestNovelRun(quoted, ESSAY, { matchUnit: 5 }), 0);
});

test("A SENTENCE THAT IS NOWHERE IN THE ESSAY IS NOVEL END TO END", () => {
  const written = "although mechanisation displaced artisanal labour the aggregate effect on real wages remained contested";
  const n = normaliseWords(written).length;
  assert.equal(longestNovelRun(written, ESSAY, { matchUnit: 5 }), n);
});

test("THE MECHANISM SEPARATES THE TWO CASES — and that is the claim, not a threshold", () => {
  /* Two hand-written examples are an ANECDOTE, and this test says so
     rather than concluding a number from them. What it asserts is only
     that the located case scores strictly lower than the written one,
     which is the property the measurement then sizes. */
  const located = `Your sentence "Historians disagree about whether living standards rose or fell during this period" states the debate but does not say which side you take.`;
  const written = `Consider opening with: although mechanisation displaced artisanal labour, the aggregate effect on real wages remained contested well into the nineteenth century.`;
  for (const k of [3, 4, 5, 6]) {
    const a = longestNovelRun(located, `${ESSAY}\n${CRITERIA}`, { matchUnit: k });
    const b = longestNovelRun(written, `${ESSAY}\n${CRITERIA}`, { matchUnit: k });
    assert.ok(b > a, `at matchUnit ${k} the written case (${b}) did not score above the located one (${a})`);
  }
});

/* ---------- 3. the two violations, kept distinct ---------- */

test("a quotation that is NOT in the essay is its own violation, sharper than novelty", () => {
  /* It asserts the student wrote something they did not, which is a
     different and worse failure than writing new prose openly. */
  const fields = [`You write "the mills of Lancashire consumed cotton from the American south" without a source.`];
  const { ok, violations } = checkNoWriting({ fields, essay: ESSAY, criteria: CRITERIA, matchUnit: 5, window: 8 });
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === "quote-not-found"), JSON.stringify(violations));
});

test("a real quotation passes, and carries no violation of either kind", () => {
  const fields = [`Your phrase "the urban population grew rapidly as workers left the countryside" is the strongest evidence here.`];
  const { ok, violations } = checkNoWriting({ fields, essay: ESSAY, criteria: CRITERIA, matchUnit: 4, window: 12 });
  assert.deepEqual(violations, []);
  assert.equal(ok, true);
});

test("EVERY WAY A MODEL MARKS A QUOTATION IS SEEN — the blind spot that misreported a real run", () => {
  /* The detector saw double quotes only, and reported "0 quoted
     spans" over a real ASAP run. That number reads as "the model
     never quoted" and could equally have meant "the model quoted in a
     form this could not see" — two findings, two remedies, told apart
     by nothing. */
  const phrase = "the urban population grew";
  const forms = {
    "straight double": `You write "${phrase}" and stop.`,
    "curly double": `You write \u201C${phrase}\u201D and stop.`,
    "single": `You write '${phrase}' and stop.`,
    "curly single": `You write \u2018${phrase}\u2019 and stop.`,
    "guillemets": `You write \u00AB${phrase}\u00BB and stop.`,
    "backticks": `You write \`${phrase}\` and stop.`,
    "markdown bold": `You write **${phrase}** and stop.`,
  };
  for (const [name, text] of Object.entries(forms)) {
    assert.deepEqual(quotedSpans(text), [phrase], `a ${name} quotation was invisible`);
  }
  /* AN APOSTROPHE IS THE SAME CHARACTER AS A SINGLE QUOTE, so the
     possessive must not open a span — otherwise ordinary prose reads
     as full of quotations and the count means nothing. */
  assert.deepEqual(quotedSpans("The student's point doesn't land and isn't developed."), []);
  /* And the same span found by two patterns is reported once. */
  assert.deepEqual(quotedSpans(`"${phrase}" and again **${phrase}**`), [phrase]);
});

test("a short quotation is not checked, because a common phrase is not a claim about authorship", () => {
  const fields = [`Your "clear thesis" is asserted rather than argued.`];
  const { violations } = checkNoWriting({ fields, essay: ESSAY, criteria: CRITERIA, matchUnit: 4, window: 12 });
  assert.ok(!violations.some((v) => v.kind === "quote-not-found"));
});

test("THE CRITERIA COUNT AS A SOURCE — a differential, because `.every` over an empty list proves nothing", () => {
  /* §4: use the criteria's own language, never invent a scale. Words
     taken from the rubric must not read as novelty.

     THE FIRST VERSION OF THIS TEST WAS VACUOUS and the suite's own
     vacuous-guard sweep caught it: it filtered the violations and
     asserted `.every(...)` over the result, which is TRUE of an empty
     list — so a checker that produced no violations at all would have
     satisfied it. Both sides are driven now, and they must differ. */
  const fields = ["Evidence: specific examples with dates are present in the second paragraph only."];
  const phrase = "specific examples with dates";

  const withCriteria = checkNoWriting({ fields, essay: ESSAY, criteria: CRITERIA, matchUnit: 4, window: 6 });
  const withoutCriteria = checkNoWriting({ fields, essay: ESSAY, criteria: "", matchUnit: 4, window: 6 });

  const mentions = (r) => r.violations.filter((v) => v.kind === "unquoted-novelty" && v.text.includes(phrase));

  /* The control: with the rubric absent, the rubric's own words ARE
     novel — so the mechanism is live and the assertion below is about
     the criteria rather than about nothing happening. */
  assert.ok(
    mentions(withoutCriteria).length > 0,
    "dropping the criteria did not make the rubric's language read as novel, so this test cannot see the thing it is about"
  );
  assert.equal(
    mentions(withCriteria).length,
    0,
    `the rubric's own language reads as novelty: ${JSON.stringify(mentions(withCriteria))}`
  );
});

test("every violation names HOW MANY WORDS, so a refusal can say what was wrong", () => {
  const fields = ["although mechanisation displaced artisanal labour the aggregate effect on real wages remained contested well into the nineteenth century"];
  const { violations } = checkNoWriting({ fields, essay: ESSAY, criteria: CRITERIA, matchUnit: 5, window: 12 });
  assert.ok(violations.length > 0);
  for (const v of violations) {
    assert.ok(Number.isInteger(v.words) && v.words > 0, JSON.stringify(v));
    assert.ok(typeof v.text === "string" && v.text.length > 0);
  }
});

test("an empty field set is OK rather than a violation, and an empty essay is not a licence", () => {
  assert.equal(checkNoWriting({ fields: [], essay: ESSAY, matchUnit: 5, window: 12 }).ok, true);
  /* No essay means nothing is covered, so ordinary prose reads as
     novel — which is the correct direction: with nothing submitted,
     everything the model says IS new. */
  const { ok } = checkNoWriting({ fields: ["a sentence of twelve words written here to cross the window cleanly"], essay: "", criteria: "", matchUnit: 5, window: 12 });
  assert.equal(ok, false);
});

/* ---------- 4. the harness ---------- */

test("THE HARNESS REFUSES WITHOUT AN ESSAY AND A RUBRIC, and says why", () => {
  /* A synthetic pair measures the example somebody invented, which is
     the anecdote the whole exercise exists to replace. */
  let out = "";
  try {
    execFileSync(process.execPath, [path.join(rootDir, "scripts/measure-no-writing.mjs")], { encoding: "utf8", stdio: "pipe" });
    assert.fail("the harness ran with no inputs");
  } catch (e) {
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  assert.match(out, /Both are required/);
  assert.match(out, /anecdote/);
});

test("--dry-run spends nothing and needs no key, so the refusals are checkable here", () => {
  /* The measure-photo-prompt arrangement: a dry run is what makes a
     script whose real mode needs a key, a network and a real essay
     testable at all. */
  const tmp = fs.mkdtempSync(path.join(rootDir, "node_modules", ".nw-"));
  try {
    fs.writeFileSync(path.join(tmp, "e.txt"), ESSAY);
    fs.writeFileSync(path.join(tmp, "r.txt"), CRITERIA);
    const out = execFileSync(
      process.execPath,
      [path.join(rootDir, "scripts/measure-no-writing.mjs"), "--essay", path.join(tmp, "e.txt"), "--rubric", path.join(tmp, "r.txt"), "--dry-run"],
      { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" } }
    );
    assert.match(out, /nothing was called and nothing was spent/);
    assert.match(out, /NO-WRITING THRESHOLD/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("THE HARNESS FOLLOWS buildMessages — DRIVEN with a fake, not greped", () => {
  /* A SOURCE GREP CANNOT MAKE THIS CLAIM, and the first version tried
     to: it asserted `prompts.buildMessages("essay"` appears in the
     script, which passes on a script that makes the call and IGNORES
     the result. Mutating the probe to null left it green. So the
     resolution moved into its own module and is driven here. */
  const candidate = () => [{ role: "system", content: "CANDIDATE" }];
  const args = { essay: ESSAY, criteria: CRITERIA, candidate };

  /* Before step 4: buildMessages throws for an unknown task. */
  const before = resolveEssayMessages({
    ...args,
    prompts: {
      buildMessages(task) {
        throw new Error(`no prompt for task: ${task}`);
      },
    },
  });
  assert.match(before.source, /CANDIDATE/);
  assert.deepEqual(before.build(), candidate());

  /* After step 4: it returns messages, and they are what gets sent. */
  const shipped = [{ role: "system", content: "SHIPPED" }];
  const after = resolveEssayMessages({ ...args, prompts: { buildMessages: () => shipped } });
  assert.match(after.source, /prompts\.js/);
  assert.deepEqual(after.build(), shipped, "the shipped prompt was resolved and then not used");

  /* THE TWO MUST DIFFER, or a resolver that always returned one of
     them would satisfy half of this on its own. */
  assert.notDeepEqual(before.build(), after.build());
  assert.notEqual(before.source, after.source);

  /* And the degenerate shapes fall back rather than sending nothing. */
  assert.match(resolveEssayMessages({ ...args, prompts: null }).source, /CANDIDATE/);
  assert.match(resolveEssayMessages({ ...args, prompts: {} }).source, /CANDIDATE/);
  assert.match(resolveEssayMessages({ ...args, prompts: { buildMessages: () => [] } }).source, /CANDIDATE/);
});

test("SYSTEM is still not exported, which is why the harness follows the FUNCTION", () => {
  const prompts = read("supabase/functions/ai-text/prompts.js");
  assert.doesNotMatch(prompts, /^export const SYSTEM/m, "SYSTEM became an export; the resolver's reasoning needs revisiting");
  assert.match(prompts, /^export function buildMessages/m, "buildMessages is what the resolver follows");
});

test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-no-writing\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
