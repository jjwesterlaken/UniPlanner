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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveEssayMessages } from "./lib/essay-prompt.mjs";
import { productionModel } from "./lib/production-model.mjs";
import { ESSAY_COPY } from "../src/essayCopy.js";
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

/* ---------- the harness measures the model the FEATURE will use ----------

   THE FAILURE THIS EXISTS FOR was a single expression:

     model = (src.match(/SUMMARY_MODEL\s*=\s*"([^"]+)"/) || [])[1]
             || "gpt-4o-mini";

   a regex RESTATING the constant, with a SILENT FALLBACK to a
   hardcoded id. Add a type annotation to the constant and the regex
   stops matching; the harness then prints `model gpt-4o-mini` on its
   own header line, which is indistinguishable from having read it.
   Harmless only while the fallback equals the truth — the
   colour-coincidence class, where the stand-in and the real thing
   agree until the day the real thing moves.

   Everything below is about the harness spending real money on the
   real configuration. */

const resolvedText = await productionModel({ hasImages: false });
const resolvedImages = await productionModel({ hasImages: true });

/* The adapter, RUN rather than read, so the comparison is against what
   a request would really be sent to. A source pattern would pass on a
   ternary that picks the wrong branch — test-ai-text-function makes
   the same point about the same file. */
const adapterModels = await (async () => {
  const { build } = await import("esbuild");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-model-"));
  try {
    const out = await build({
      entryPoints: [path.join(rootDir, "supabase/functions/ai-text/openai.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
    });
    const file = path.join(tmp, "adapter.mjs");
    fs.writeFileSync(file, out.outputFiles[0].text);
    const { openaiTextAdapter } = await import(pathToFileURL(file).href);
    const sentFor = async (hasImages) => {
      let sent = null;
      await openaiTextAdapter.complete({
        messages: [{ role: "user", content: "x" }],
        maxTokens: 16,
        apiKey: "sk-test",
        hasImages,
        fetchImpl: async (_u, init) => {
          sent = JSON.parse(init.body);
          return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }) };
        },
      });
      return sent.model;
    };
    return { text: await sentFor(false), images: await sentFor(true) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

/* The refusal probe, run here because the runner below refuses a
   promise. A module holding BOTH constants and no selector is exactly
   the state the old regex read as success. */
const selectorProbe = await (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-selector-"));
  try {
    const broken = path.join(tmp, "model.ts");
    fs.writeFileSync(broken, 'export const SUMMARY_MODEL = "gpt-4o-mini";\nexport const VISION_MODEL = "gpt-5.4-mini";\n');
    let threw = null;
    try {
      await productionModel({ hasImages: false, modelSource: broken });
    } catch (err) {
      threw = err;
    }

    const whole = path.join(tmp, "whole.ts");
    fs.writeFileSync(
      whole,
      'export const SUMMARY_MODEL = "fixture-text";\nexport const VISION_MODEL = "fixture-vision";\n' +
        "export function modelFor({ hasImages = false } = {}) { return hasImages ? VISION_MODEL : SUMMARY_MODEL; }\n"
    );
    let resolved = null;
    try {
      resolved = await productionModel({ hasImages: false, modelSource: whole });
    } catch {
      resolved = null;
    }
    return { threw, whole: resolved };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

test("THE HARNESS RESOLVES WHAT THE ADAPTER WOULD REALLY SEND", () => {
  /* Essay feedback is text-only and paste-only, so the model it will
     use is the one the adapter picks with no images. Compared against
     the RUNNING adapter rather than against SUMMARY_MODEL: reading a
     constant by name and asking which constant applies are different
     questions, and they coincide here only because the feature has no
     images — which is a fact about the feature, not about the code
     that reads it. */
  assert.equal(resolvedText, adapterModels.text, "the harness would call a different model from the one ai-text sends text to");
});

test("AND IT IS REALLY ASKING ABOUT THE MEDIUM, not returning a constant", () => {
  /* NON-VACUITY. A helper that ignored its argument and returned one
     string would satisfy the test above completely. The two media must
     resolve differently, which is also the property COST-MODEL 12.5
     prices: one model string would drag text wherever the photo path
     goes. */
  assert.equal(resolvedImages, adapterModels.images, "the image path disagrees with the adapter");
  assert.notEqual(
    resolvedText,
    resolvedImages,
    "text and images resolve to the same model, so this cannot tell a medium-aware helper from a constant"
  );
});

test("NO MEASUREMENT SCRIPT CARRIES A MODEL ID OF ITS OWN", () => {
  /* The fallback is the whole defect: a script that HOLDS a model id
     can print it while having read nothing. So the ids are not there
     to be printed.

     Comments stripped first — production-model.mjs quotes the old
     expression in its header to explain it, which is the guard
     meeting its own subject for the sixth time in this repository. */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  /* EVERY MEASUREMENT SCRIPT, derived from the folder — a list of the
     three files this change happened to touch would be the same
     restatement one level up, and it would have missed
     measure-summary-depth.mjs, which held the literal and is the
     script EXAM-PREP-PACK.md §4b sends people to for measuring a
     ceiling.

     Three are DECLARED WITH A REASON rather than swept, the
     device-store shape: their job IS naming models to set against each
     other, so a literal there is the subject rather than a stand-in.
     An undeclared script holding one fails until somebody decides
     which it is. */
  const NAMES_MODELS_ON_PURPOSE = {
    "measure-cost-model.mjs": "prices named models against each other; the names are what it compares",
    "measure-photo-gates.mjs": "the three-model A/B that chose the vision model; naming them is the experiment",
    "measure-photo-prompt.mjs": "runs a prompt pair and keeps COST-MODEL 12.9's named fallback as an arm — and it already derives VISION_MODEL through a read that THROWS rather than falling back",
  };
  const measured = fs.readdirSync(path.join(rootDir, "scripts")).filter((f) => /^measure-.*\.mjs$/.test(f));
  assert.ok(measured.length >= 5, `only ${measured.length} measurement scripts found — this sweep is reading the wrong directory`);
  const files = [
    ...measured.filter((f) => !NAMES_MODELS_ON_PURPOSE[f]).map((f) => `scripts/${f}`),
    "scripts/lib/production-model.mjs",
  ];
  /* Non-vacuity in both directions: something must be swept, and a
     declaration must name a script that exists rather than
     accumulating entries for files somebody deleted. */
  assert.ok(files.length >= 3, `only ${files.length} scripts are swept`);
  for (const declared of Object.keys(NAMES_MODELS_ON_PURPOSE)) {
    assert.ok(measured.includes(declared), `${declared} is declared as naming models on purpose but no longer exists`);
  }
  for (const f of files) {
    const code = strip(read(f));
    const ids = [...code.matchAll(/["'`](gpt-[\w.\-]+)["'`]/g)].map((m) => m[1]);
    assert.deepEqual(ids, [], `${f} holds the model id(s) ${ids.join(", ")} — it can print one without having read anything`);
  }
  /* AND THE SWEEP IS NOT VACUOUS: it must be reading real files with
     real content, or an empty read would satisfy it. */
  for (const f of files) assert.ok(read(f).length > 500, `${f} read as ${read(f).length} bytes`);
});

test("BOTH SCRIPTS ASK THE SAME QUESTION, and neither reads a constant by name", () => {
  for (const f of ["scripts/measure-two-arm.mjs", "scripts/measure-no-writing.mjs"]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    /* The ESSAY task's model: essay is chosen by task (model.ts), so a
       harness asking only about the medium would measure summarise's. */
    assert.match(code, /productionModel\(\{\s*hasImages:\s*false,\s*task:\s*"essay"\s*\}\)/, `${f} does not resolve the essay model through the shared helper`);
    assert.doesNotMatch(code, /SUMMARY_MODEL/, `${f} reads a constant by name again — which constant applies is the question`);
    /* The override stays: naming a model deliberately is how you A/B
       one. What may not exist is a DEFAULT nobody chose. */
    assert.match(code, /opt\("--model"\)/, `${f} lost its --model override, so a deliberate comparison is no longer possible`);
  }
});

test("IT REFUSES rather than falling back when the selector is gone", () => {
  /* The behavioural half, and the one the old code failed. Pointed at
     a module that has lost `modelFor`, this must THROW — the previous
     expression returned "gpt-4o-mini" and printed it as fact.

     Driven at the top of the file rather than in here, because this
     runner refuses a promise (line 50) and would otherwise report a
     pass before the probe settled. */
  assert.ok(selectorProbe.threw, "a module with both constants but no selector resolved anyway — that is the silent stand-in, restored");
  assert.match(selectorProbe.threw.message, /modelFor/, `the refusal does not name what is missing: ${selectorProbe.threw.message}`);

  /* AND THE FIXTURE IS NOT REFUSED FOR AN UNRELATED REASON: the same
     shape WITH a selector must resolve, or the assertion above passes
     because the fixture was unreadable rather than because the
     selector was absent. The fixture's ids are deliberately not real
     model names, so a helper that ignored the file could not produce
     them. */
  assert.equal(
    selectorProbe.whole,
    "fixture-text",
    "the helper could not read a well-formed module, so the refusal above proves nothing"
  );
});

/* ================================================================
   THE WORDING RULE — armed before the copy exists

   ESSAY-FEEDBACK.md §3's last subsection asks for the readings guard
   pointed at this feature: no user-facing wording may offer to write,
   rewrite or fix a student's essay. The whole no-writing constraint is
   a legal and product position before it is a technical one, and a
   sentence offering to "polish your draft" undoes it whatever
   `checkNoWriting` does.

   NOW, BEFORE STEP 5 WRITES ANY COPY, because that is the only moment
   arming it is free — the leak-gate lesson. A guard added after the
   copy exists has to be reconciled with whatever got written; one
   added before is a constraint the copy is written under.
   ================================================================ */

/* §3 SKETCHED A BLUNT `/rewrite/i` AND IT WOULD HAVE FAILED ON THE
   FEATURE'S OWN PROMISE. The thing this feature most needs to say is
   that it does NOT rewrite your essay — so the banned word appears in
   the sentence that makes the ban true, which is the guard-meets-its-
   own-subject shape for the seventh time, and the first where the
   collision is with USER-FACING copy rather than with a comment.

   Stripping comments does not help here: the collision is in the
   product's own words. So an occurrence is permitted only when it is
   DECLARED below with a reason, the device-store guard's arrangement.
   A promise gets written down once; an offer cannot be written at
   all. */
const SUBSTITUTION_PATTERNS = [
  /write (it|this|that|your essay|your draft) for you/i,
  /\brewrit(e|es|ing|ten)\b/i,
  /fix (your|the) (essay|draft|writing)/i,
  /improve[sd]? your writing for you/i,
  /\b(polish|polishes|polishing|edit|edits|editing) your (essay|draft)\b/i,
  /(better|stronger) version of (your|the|it)/i,
  /\bghost-?writ/i,
];

/* Lines that may contain a banned phrase, each with the reason it is
   not an offer. EMPTY TODAY, on purpose: no essay copy exists yet, so
   anything the sweep finds is something somebody just wrote and should
   look at. Adding an entry is a decision, which is the point. */
const DECLARED_SUBSTITUTION_LINES = {
  /* `src/essayScope.js` is the module that DETECTS a rewrite leaving
     its span, so the word is unavoidable in its own vocabulary. These
     are a violation CODE and its diagnostic detail — the convention
     this project uses everywhere: the code travels, and the sentence a
     student reads lives in a copy module. Neither reaches a screen. */
  "empty-rewrite": "a violation code in essayScope.js, not copy — the student-facing sentence lives in the panel's copy module",
  "the rewrite has no words": "the diagnostic detail beside that code, read by a log and a test rather than by a student",
  /* A REASON A STUDENT CAN GIVE, not an offer. The feedback form's list
     (Jared, 18 September 2026) includes a complaint about an example
     rewrite, and it is only offered on a result where one was asked
     for (reasonsFor in essayFeedback.js). The id is stored, so it is a
     stable string rather than copy; the label is the complaint. */
  "rewrite-changed-meaning": "a stored reason id in essayFeedback.js and essayCopy.js, naming a complaint the student makes, never an offer",
  "The example rewrite changed my meaning": "the feedback form's complaint about an example rewrite, in the student's voice; it reports a problem with our output and offers nothing",

  /* THE EXAMPLE REWRITE, RULED IN (Jared, 18 September 2026): one
     passage the feedback pointed at, on request, side by side, never
     inserted. So this guard's claim NARROWED rather than went away: no
     copy may offer to write, rewrite or fix THE ESSAY, and every
     mention of the scoped example is declared here by its exact phrase,
     so a new sentence using the word still has to be read and argued
     for. The test below it asserts the example's copy carries its two
     limits. */
  "Show an example rewrite": "the per-point button: one passage the feedback located, on request",
  "it can show an example rewrite of one sentence or paragraph it pointed at": "the opt-in's description of the scoped example, which goes on to say nothing is put into the essay",
  "asked for an example rewrite of one passage": "a line of the student's own AI-use record, for disclosing what was done; it describes a past request",
  "Example rewrites aren't available yet.": "the refusal while the feature is switched off; it offers nothing",
  "example-rewrite": "a stored kind id in the AI-use record (essayFeedback.js), not copy",
  "ai-text:rewrite": "a route id in MATERIAL_ROUTES, not copy",
  '"rewrite"': "the task id passed to the endpoint, quotes included so the declaration covers the bare id and no sentence",
};

test("NO USER-FACING COPY OFFERS TO WRITE, REWRITE OR FIX AN ESSAY", () => {
  /* Scoped to the CLAIM and not to a file. The readings version of
     this rule reads `READING_COPY` plus two named modules, which
     CLAUDE.md's ledger already records as one of four guards whose
     claim is broader than what they read. Written fresh, there is no
     reason to inherit that: user-facing wording lives all over `src/`,
     and a sentence offering to polish a draft is exactly as damaging
     in a help topic as in the panel. */
  const dir = path.join(rootDir, "src");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(e.name)) files.push(full);
    }
  };
  walk(dir);
  assert.ok(files.length > 20, `the sweep found ${files.length} source files, so it is reading almost nothing`);

  /* THE CONTROL, and without it an empty offender list says only that
     the patterns never match anything. Run them over a sentence that
     IS an offer and require every pattern family to be reachable. */
  const offers = [
    "We will write it for you.",
    "UniPlanner rewrites your essay.",
    "We fix your essay before you hand it in.",
    "It improves your writing for you.",
    "We polish your draft.",
    "Get a better version of your essay.",
    "A ghostwriter for your assignments.",
  ];
  for (const [i, pattern] of SUBSTITUTION_PATTERNS.entries()) {
    assert.ok(
      offers.some((o) => pattern.test(o)),
      `pattern ${i} (${pattern}) matches none of the control offers, so it guards nothing`
    );
  }

  /* AND THE EXTRACTION IS ITSELF A CONTROL, because scoping to strings
     is exactly how this guard could quietly stop reading anything. An
     offer IN A STRING must still be seen; the same words as an
     identifier must not. */
  const extract = (text) => (text.match(/"[^"]*"|'[^']*'|`[^`]*`/g) || []).join(" ");
  assert.ok(
    SUBSTITUTION_PATTERNS.some((p) => p.test(extract('const BLURB = "We polish your draft.";'))),
    "the string extraction drops copy, so this guard now reads nothing"
  );
  assert.ok(
    !SUBSTITUTION_PATTERNS.some((p) => p.test(extract('function checkScope({ rewrite }) {}'))),
    "an identifier named rewrite still reads as an offer"
  );

  const offenders = [];
  for (const file of files) {
    /* Comments stripped first — six instances in the ledger, and this
       file will carry prose explaining the rule. */
    /* STRING LITERALS ONLY, and this is a correction made within hours
       of the guard landing. The claim is about user-facing COPY; the
       first version swept every line of `src/`, so it fired on
       `src/essayScope.js`'s PARAMETER NAMED `rewrite` — in the module
       whose entire job is detecting rewrites. An identifier is not
       something a student reads.

       Eighth instance of the guard meeting its own subject, and the
       fix is the ledger's usual one: scope it to the claim. Copy is
       quoted; code is not. Comments still go first, because a comment
       can contain a quoted example. */
    const stripped = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    const src = stripped
      .split("\n")
      .map((line) => (line.match(/"[^"]*"|'[^']*'|`[^`]*`/g) || []).join(" "))
      .join("\n");
    src.split("\n").forEach((line, n) => {
      for (const pattern of SUBSTITUTION_PATTERNS) {
        if (!pattern.test(line)) continue;
        const declared = Object.keys(DECLARED_SUBSTITUTION_LINES).some((phrase) =>
          line.toLowerCase().includes(phrase.toLowerCase())
        );
        if (declared) continue;
        offenders.push(`${path.relative(rootDir, file)}:${n + 1}: ${line.trim().slice(0, 100)}`);
        return;
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "copy offers to write or rewrite a student's essay, which is the position the whole no-writing " +
      "constraint rests on:\n" + offenders.join("\n") +
      "\nIf a line SAYS WE DO NOT do it, declare it in DECLARED_SUBSTITUTION_LINES with that reason."
  );
});

test("THE EXAMPLE'S COPY CARRIES ITS LIMITS: one passage, nothing put into the essay, and the unit's rules", () => {
  const said = [ESSAY_COPY.rewrite.note, ...ESSAY_COPY.optIn.bullets].join(" ");
  assert.match(said, /isn't put into your essay|Nothing is put into your essay/);
  assert.match(said, /unit's rules/);
  assert.match(ESSAY_COPY.optIn.bullets.join(" "), /one sentence or paragraph/);
});

test("A DECLARED LINE IS CHECKED, not rubber-stamped", () => {
  /* An excuse mechanism nobody verifies is a place to put anything.
     A declaration must name a phrase that a banned pattern actually
     matches — otherwise it is a line in a file that permits nothing
     and looks like it permits something. */
  for (const [phrase, reason] of Object.entries(DECLARED_SUBSTITUTION_LINES)) {
    assert.ok(
      SUBSTITUTION_PATTERNS.some((p) => p.test(phrase)),
      `"${phrase}" is declared but no pattern matches it, so the declaration does nothing`
    );
    assert.ok(
      typeof reason === "string" && reason.trim().length > 15,
      `"${phrase}" is declared without a reason worth reading`
    );
  }
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
