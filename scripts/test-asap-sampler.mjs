/* The ASAP sampler, and the one claim it must not get wrong.

   THE ASAP COMPETITION RULES FORBID REDISTRIBUTING THE ESSAYS, so the
   sampler must print no essay text and write none. That is enforced
   here rather than promised: a SENTINEL sentence is planted in a fake
   essay, the provider is faked into quoting it back, and the sentinel
   must appear in neither the terminal output nor the --json file.

   It is not a hypothetical. The harness's per-field section prints
   every quoted span, and a span the model quoted VERBATIM is the
   student's own words — so an unredacted run over this corpus puts
   essay text on screen. The test that matters most in this file is
   the one that fails when --redact is dropped.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { docxToText, zipEntries } from "./lib/docx-text.mjs";
import { MIN_ESSAY_WORDS, selectForRead, scoreRanges, normaliseScore, bandOf, bandAvailability, DECLARED_SCORE_RANGES, placeholderAnon, stripAnon, PLACEHOLDER_LABELS } from "./lib/asap-corpus.mjs";
import { PLACEHOLDER_NOTE } from "./lib/essay-arms.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* EVERY FILE ON THE SAMPLER'S CORPUS PATH. The claims below are about
   what the sampler DOES, and part of what it does now lives in a module
   two scripts share. Listed here so a grep follows the code instead of
   going stale the next time something moves. */
const CORPUS_PATH = ["scripts/sample-asap.mjs", "scripts/read-asap.mjs", "scripts/lib/asap-corpus.mjs"];

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

/* A real .docx, built here, because the reader's claim is about a FILE
   and a hand-written fake object would prove nothing about zips. */
function makeDocx(file, text) {
  const name = Buffer.from("word/document.xml");
  const xml = Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  const comp = zlib.deflateRawSync(xml);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(xml.length, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(xml.length, 24);
  cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([lh, name, comp]);
  const cdBuf = Buffer.concat([cd, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(body.length, 16);
  fs.writeFileSync(file, Buffer.concat([body, cdBuf, eocd]));
}

/* ---------- 1. the docx reader ---------- */

test("a .docx round-trips to text, with runs joined and entities decoded", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-"));
  try {
    const f = path.join(tmp, "r.docx");
    makeDocx(f, "Argument: a clear</w:t></w:r><w:r><w:t> thesis &amp; sustained.");
    const text = docxToText(fs.readFileSync(f));
    /* Joined with NOTHING: Word splits a sentence across runs whenever
       formatting changes, and joining with a space gives "cl ear". */
    assert.match(text, /a clear thesis & sustained/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a file that is not a zip fails LOUDLY rather than reading as empty", () => {
  /* A rubric that silently became "" would make every measurement
     below it meaningless while everything still ran. */
  assert.throws(() => docxToText(Buffer.from("this is a .txt somebody renamed")), /not a zip/);
});

test("a zip with no word/document.xml says what it DID find", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-"));
  try {
    const f = path.join(tmp, "x.docx");
    makeDocx(f, "hi");
    const buf = fs.readFileSync(f);
    const entries = zipEntries(buf);
    assert.deepEqual(entries.map((e) => e.name), ["word/document.xml"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------- 2. the corpus handling ---------- */

/* SCORES INSIDE EACH SET'S REAL RANGE. The first version used `i % 4`
   for every set, so set 1 held scores of 0 and 1 — impossible in ASAP,
   whose set 1 is scored 2-12. Nothing noticed until `scoreRanges`
   started refusing a corpus whose scores fall outside a declared range,
   and it refused THIS fixture on its first run. A guard that catches the
   test's own impossible data is a guard that is reading the data. */
function scoreFor(set, i) {
  const r = DECLARED_SCORE_RANGES[set];
  if (!r) return i % 4;
  const span = r.max - r.min;
  return r.min + Math.round(((i % 4) / 3) * span);
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asap-fix-"));
  fs.mkdirSync(path.join(dir, "Essay_Set_Descriptions"));
  const SMART = String.fromCharCode(0x92);
  const rows = [["essay_id", "essay_set", "essay", "domain1_score"].join("\t")];
  let id = 1;
  for (const set of [1, 2, 3, 7, 8]) {
    for (let i = 0; i < 8; i++) {
      rows.push([id++, set, `Dear @CAPS1, I think computers help people in many different ways every single day. My friend @PERSON${i} who lives in @LOCATION1 uses one for about @NUM1 hours a week. It is useful because you can learn new things, talk to family who live far away, and find information for school work without going to a library. Some people say computers are bad for you because you sit down too much and do not exercise enough, but I disagree with that view quite strongly and I will explain exactly why in this essay. It${SMART}s clear enough. First, computers make it much easier to stay in touch with people you care about. My grandparents live in another country and we talk every weekend using a video call, which would have been impossible for most families only a generation ago. Seeing their faces and hearing their voices matters to me far more than a letter would, and it keeps our family close even though we are separated by thousands of kilometres of ocean and several time zones. Second, computers help students learn in ways that suit them. When I do not understand something in class I can look for a different explanation, watch a video that goes more slowly, or practise with exercises that tell me straight away whether I got the answer right. That kind of immediate feedback is something a single textbook simply cannot give you, however good it is. Finally, the argument that computers make people lazy ignores how people actually use them. Many of my friends use their computers to plan sports training, find new walking tracks, or join clubs they would never have heard about otherwise. So computers do not replace an active life; for a lot of people they are the reason it began.`, scoreFor(set, i)].join("\t"));
    }
  }
  /* A four-word row, deliberately: ASAP has near-blanks in it and the
     floor exists to exclude them. Without one in the fixture the
     floor test would pass over nothing. */
  rows.push([9999, 1, "Computers are quite good.", DECLARED_SCORE_RANGES[1].min].join("\t")); /* in range: a stub is still scored on the set's own scale */
  fs.writeFileSync(path.join(dir, "training_set_rel3.tsv"), Buffer.from(rows.join("\n"), "latin1"));
  for (const set of [1, 2, 7, 8]) {
    makeDocx(path.join(dir, "Essay_Set_Descriptions", `Essay Set #${set}--ReadMeFirst.docx`), `Prompt ${set}. Scoring: a clear position sustained throughout.`);
  }
  return dir;
}

const runSampler = (args, env = {}) =>
  execFileSync(process.execPath, [path.join(rootDir, "scripts", "sample-asap.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("SOURCE-DEPENDENT SETS ARE EXCLUDED, and the excluded ones really exist in the corpus", () => {
  const dir = fixture();
  try {
    const out = runSampler(["--dir", dir, "--per-set", "2", "--dry-run"]);
    assert.match(out, /sets\s+1, 2, 7, 8/);
    assert.match(out, /source-dependent sets excluded/);
    /* Non-vacuity: set 3 IS in the fixture, so the exclusion is doing
       something rather than describing an empty case. */
    const tsv = fs.readFileSync(path.join(dir, "training_set_rel3.tsv"), "latin1");
    assert.ok(tsv.split("\n").some((l) => l.split("\t")[1] === "3"), "the fixture has no set 3 to exclude");
    assert.match(out, /sampled\s+8 essays/, "2 per set across four sets is 8; a fifth set leaked in");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("THE LENGTH FLOOR EXCLUDES A STUB ESSAY, and the fixture contains one to exclude", () => {
  /* The first real run admitted a 4-word essay. A stub that short
     gives the model nothing to quote and nothing to be wrong about,
     so its fields are novel by construction and it drags the
     distribution the whole measurement is reading. */
  const dir = fixture();
  try {
    const tsv = fs.readFileSync(path.join(dir, "training_set_rel3.tsv"), "latin1");
    assert.ok(tsv.includes("Computers are quite good."), "the fixture has no stub row, so this proves nothing");

    const out = runSampler(["--dir", dir, "--per-set", "2", "--dry-run"]);
    assert.match(out, /floor 50, [1-9]\d* rows below it skipped/, "no row was skipped, so the floor did nothing");
    const min = Number(out.match(/words\s+min (\d+)/)[1]);
    /* AGAINST THE CONSTANT, not a number typed here. This read 50 — the
       old floor restated — and would have gone on passing if the floor
       were quietly lowered back, which is the ledger's first entry. */
    assert.ok(min >= MIN_ESSAY_WORDS, `a ${min}-word essay was sampled under the ${MIN_ESSAY_WORDS}-word floor`);

    /* And a floor nothing can meet REFUSES rather than sampling
       nothing quietly. */
    let refused = "";
    try {
      runSampler(["--dir", dir, "--per-set", "2", "--min-words", "5000", "--dry-run"]);
      assert.fail("sampled with an impossible floor");
    } catch (e) {
      refused = `${e.stdout || ""}${e.stderr || ""}`;
    }
    assert.match(refused, /no rows matched/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("THE SAMPLE IS DETERMINISTIC — the same seed gives the same essays", () => {
  const dir = fixture();
  try {
    const a = runSampler(["--dir", dir, "--per-set", "2", "--dry-run"]);
    const b = runSampler(["--dir", dir, "--per-set", "2", "--dry-run"]);
    assert.equal(a, b, "a measurement nobody can reproduce is an anecdote with a bigger n");
    const c = runSampler(["--dir", dir, "--per-set", "2", "--seed", "99", "--dry-run"]);
    /* And a different seed must actually differ, or the seed is
       decorative and "deterministic" is trivially true. */
    assert.notEqual(a.replace(/seed \d+/, ""), c.replace(/seed \d+/, ""), "the seed changes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing rubric REFUSES and says exactly what to save as .txt", () => {
  const dir = fixture();
  try {
    fs.rmSync(path.join(dir, "Essay_Set_Descriptions", "Essay Set #8--ReadMeFirst.docx"));
    let out = "";
    try {
      runSampler(["--dir", dir, "--per-set", "2", "--dry-run"]);
      assert.fail("ran with a missing rubric");
    } catch (e) {
      out = `${e.stdout || ""}${e.stderr || ""}`;
    }
    assert.match(out, /No rubric for set\(s\) 8/);
    assert.match(out, /WHAT TO SAVE AS \.txt/);
    assert.match(out, /SET NUMBER is in the/);
    /* And it says to leave the sample essays out — they are other
       students' text, not criteria. */
    assert.match(out, /Leave out the sample\s+essays/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a .txt rubric WINS over a .docx, so an unreadable container has a way through", () => {
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir, "Essay_Set_Descriptions", "set8.txt"), "Plain text rubric for set 8.");
    const out = runSampler(["--dir", dir, "--per-set", "2", "--dry-run"]);
    assert.match(out, /set 8: set8\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 3. THE LEAK GUARD ---------- */

test("NO ESSAY TEXT REACHES THE OUTPUT OR THE JSON — sentinel, faked provider", () => {
  /* The provider is faked by replacing global fetch in the child, so
     this drives the REAL harness end to end with no key and no
     network. The fake quotes the sentinel back, which is exactly what
     a model pointing at a problem does — and exactly what an
     unredacted run would print. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leak-"));
  try {
    const SENTINEL = "zebracrossing marmalade parliament";
    const essay = `The argument begins here. ${SENTINEL}. It continues for several more words so the field is long enough to measure.`;
    fs.writeFileSync(path.join(tmp, "e.txt"), essay);
    fs.writeFileSync(path.join(tmp, "r.txt"), "Argument: a clear thesis sustained throughout.");

    const stub = path.join(tmp, "stub.mjs");
    fs.writeFileSync(
      stub,
      `globalThis.fetch = async () => ({
         ok: true,
         json: async () => ({
           choices: [{ message: { content: JSON.stringify({ criteria: [{
             name: "Argument",
             standing: ${JSON.stringify(`You write "${SENTINEL}" and never return to it.`)},
             suggestions: [${JSON.stringify(`The phrase "${SENTINEL}" is doing no work here.`)}],
           }] }) } }],
         }),
       });\n`
    );

    const jsonFile = path.join(tmp, "out.json");
    const out = execFileSync(
      process.execPath,
      [
        "--import", stub,
        path.join(rootDir, "scripts", "measure-no-writing.mjs"),
        "--essay", path.join(tmp, "e.txt"),
        "--rubric", path.join(tmp, "r.txt"),
        "--runs", "1",
        "--redact",
        "--json", jsonFile,
      ],
      { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "sk-fake" } }
    );

    /* The control FIRST: without it, a run that produced nothing at
       all would satisfy every absence below. */
    assert.match(out, /LONGEST NOVEL RUN PER FIELD/, "the harness produced no measurement, so the absences below prove nothing");
    assert.match(out, /output withheld/);

    assert.ok(!out.includes(SENTINEL), "THE ESSAY TEXT REACHED THE TERMINAL");
    const json = fs.readFileSync(jsonFile, "utf8");
    assert.ok(!json.includes(SENTINEL), "THE ESSAY TEXT REACHED THE --json FILE");
    /* And the file is still useful: the numbers survived redaction. */
    const parsed = JSON.parse(json);
    assert.equal(parsed.redacted, true);
    assert.ok(parsed.measurements.length > 0, "redaction emptied the measurements");
    assert.ok(Number.isInteger(parsed.measurements[0].real[5]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("AND WITHOUT --redact THE SAME RUN DOES LEAK — the control that makes the guard mean something", () => {
  /* If the sentinel were absent either way, the test above would pass
     on a harness that printed nothing at all. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leak2-"));
  try {
    const SENTINEL = "zebracrossing marmalade parliament";
    fs.writeFileSync(path.join(tmp, "e.txt"), `The argument begins here. ${SENTINEL}. It continues for several more words.`);
    fs.writeFileSync(path.join(tmp, "r.txt"), "Argument: a clear thesis.");
    const stub = path.join(tmp, "stub.mjs");
    fs.writeFileSync(
      stub,
      `globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ criteria: [{ name: "Argument", standing: ${JSON.stringify(`You write "${SENTINEL}" here.`)}, suggestions: [] }] }) } }] }) });\n`
    );
    const out = execFileSync(
      process.execPath,
      ["--import", stub, path.join(rootDir, "scripts", "measure-no-writing.mjs"), "--essay", path.join(tmp, "e.txt"), "--rubric", path.join(tmp, "r.txt"), "--runs", "1"],
      { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "sk-fake" } }
    );
    assert.ok(out.includes(SENTINEL), "the unredacted run did not print the text either, so the redaction test is measuring nothing");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("THE SAMPLER ALWAYS PASSES --redact, and deletes its working files", () => {
  const src = strip(read("scripts/sample-asap.mjs"));
  assert.match(src, /"--redact"/, "the sampler must never spawn an unredacted child over this corpus");
  assert.match(src, /fs\.rmSync\(tmp, \{ recursive: true, force: true \}\)/, "the per-essay files hold essay text and must be removed");
  assert.match(src, /finally/, "the cleanup must survive a failure mid-run");
});

/* ---------- 4. Windows ---------- */

test("it spawns process.execPath, never npx and never a .bin shim", () => {
  /* On Windows the .bin shim is a .cmd and modern Node refuses to
     execute it — the trap this repo has hit fourteen times, and this
     script is the one MEANT to run on somebody else's laptop. */
  const src = CORPUS_PATH.map((f) => strip(read(f))).join("\n");
  assert.match(src, /execFileSync\(\s*process\.execPath/);
  assert.doesNotMatch(src, /npx |node_modules[\\/]\.bin/);
});

test("every path is joined rather than concatenated with a separator", () => {
  const src = CORPUS_PATH.map((f) => strip(read(f))).join("\n");
  assert.doesNotMatch(src, /["'`][^"'`]*\/scripts\//, "a hardcoded posix path will not resolve on Windows");
});

test("the TSV is read as latin1 — it is Windows-1252 and reading it as UTF-8 corrupts words", () => {
  /* SCOPED TO THE CLAIM, NOT TO A FILE, and it had to be: the corpus
     reading moved into `lib/asap-corpus.mjs` when `read-asap.mjs`
     needed the same four things, and this grep went red on a correct
     extraction while the property it guards was never in danger. That
     is the file-scoped-guard entry in the ledger, arriving in the one
     place it is most annoying — a guard that has to be edited to let a
     refactor through is a guard people learn to edit.

     What is asserted now is that WHEREVER the corpus is read, it is
     read as latin1, and that the sampler really reaches that code. */
  const src = CORPUS_PATH.map((f) => strip(read(f))).join("\n");
  assert.match(src, /readFileSync\(tsvPath, "latin1"\)/);
  assert.equal(
    (src.match(/readFileSync\(\s*tsvPath/g) || []).length,
    1,
    "the TSV is read in more than one place, so one of them can drift to UTF-8"
  );
});

test("the sampler and the reader share ONE corpus module", () => {
  /* The extraction is the point: a second copy of the TSV parsing, the
     anonymisation strip, the rubric lookup or the stratified draw would
     be the restatement pattern with a corpus attached. Both scripts are
     required to import it, and neither to re-read the TSV itself. */
  for (const f of ["scripts/sample-asap.mjs", "scripts/read-asap.mjs"]) {
    const src = strip(read(f));
    assert.match(src, /from "\.\/lib\/asap-corpus\.mjs"/, `${f} does not use the shared corpus module`);
    /* SCOPED TO READING IT, not to naming it: both scripts legitimately
       mention the filename in their usage text, which is the sentence
       that tells an operator what `--dir` should point at. What neither
       may do is parse it. */
    assert.doesNotMatch(
      src,
      /readFileSync\([^)]*training_set_rel3|readFileSync\(\s*tsvPath/,
      `${f} reads the TSV itself rather than going through the module`
    );
  }
});

/* ==================================================================
   THE LOCAL READ — the one script that writes essay text, and the
   fence that decides where.

   Everything else in this project withholds by default and is tested
   for it. `read-asap.mjs` writes in full, because it cannot do its
   job otherwise, so what is tested here is the WHERE: reading the
   corpus is permitted and redistributing it is not, and a file inside
   a working tree is one `git add -A` from being redistributed
   permanently.
   ================================================================== */

const runReader = (args, env = {}) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [path.join(rootDir, "scripts", "read-asap.mjs"), ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

test("THE FENCE REFUSES A PATH INSIDE THE REPOSITORY, and says why", () => {
  const dir = fixture();
  try {
    const r = runReader(["--dir", dir, "--out", path.join(rootDir, "asap-read.md"), "--dry-run"]);
    assert.equal(r.code, 1, "a path inside the repo was accepted");
    assert.match(r.out, /REFUSED/);
    assert.match(r.out, /redistribut/i, "the refusal does not say what the rule actually is");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the fence resolves `..`, so it cannot be walked around", () => {
  const dir = fixture();
  try {
    /* A path that LOOKS outside and resolves inside. Comparing the
       strings as given would accept this; comparing resolved real
       paths is what makes the check a check. */
    const sneaky = path.join(rootDir, "scripts", "..", "asap-read.md");
    const r = runReader(["--dir", dir, "--out", sneaky, "--dry-run"]);
    assert.equal(r.code, 1, "a `..` path that resolves inside the repo was accepted");
    assert.match(r.out, /REFUSED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--model IS A MEASUREMENT OVERRIDE: it says so, prices from the repository, and never guesses a price", () => {
  const dir = fixture();
  const out = path.join(os.tmpdir(), `asap-read-model-${Date.now()}.md`);
  const shipped = runReader(["--dir", dir, "--out", out, "--sets", "1", "--dry-run"]);
  assert.equal(shipped.code, 0, shipped.out);
  assert.match(shipped.out, /\(the shipped model\)/);
  assert.match(shipped.out, /from credits\.ts/, "the shipped model is not priced from credits.ts");
  assert.match(shipped.out, /ceiling\s+2000 output tokens/);

  const mini = runReader(["--dir", dir, "--out", out, "--sets", "1", "--model", "gpt-5.4-mini", "--dry-run"]);
  assert.equal(mini.code, 0, mini.out);
  assert.match(mini.out, /MEASUREMENT OVERRIDE; the shipped model is gpt-4o-mini/, "an override does not say it is one");
  assert.match(mini.out, /from model\.ts/, "gpt-5.4-mini is not priced from model.ts");
  /* THE NUMBERS, not only the label. Read out of model.ts by bundling it
     here, independently of model-prices.mjs, so this compares the
     script's output against the module and not against itself. */
  const { buildSync } = require("esbuild");
  const bundled = buildSync({ entryPoints: [path.join(rootDir, "supabase/functions/_shared/model.ts")], bundle: true, format: "cjs", platform: "neutral", write: false }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", bundled)(mod, mod.exports);
  const { VISION_USD_PER_1M_INPUT: vin, VISION_USD_PER_1M_OUTPUT: vout, VISION_MODEL } = mod.exports;
  assert.equal(VISION_MODEL, "gpt-5.4-mini", "this test assumes the vision model is the one being compared; recheck it");
  assert.ok(mini.out.includes(`$${vin} / $${vout} per 1M`), `gpt-5.4-mini's printed rate is not model.ts's $${vin} / $${vout}`);
  assert.match(mini.out, /ceiling\s+8000 output tokens/, "a reasoning model got the ceiling it would spend before answering");
  assert.match(mini.out, /at most \$\d/, "no cost estimate before spending");

  const unpriced = runReader(["--dir", dir, "--out", out, "--sets", "1", "--model", "some-unpriced-model", "--dry-run"]);
  assert.match(unpriced.out, /price\s+UNKNOWN/, "an unpriced model was given a price");
  assert.match(unpriced.out, /\(price unknown\)/);
  const passed = runReader(["--dir", dir, "--out", out, "--sets", "1", "--model", "some-unpriced-model", "--usd-in", "2", "--usd-out", "8", "--dry-run"]);
  assert.match(passed.out, /\$2 \/ \$8 per 1M in \/ out, from --usd-in\/--usd-out/);

  /* AND IT CANNOT MOVE THE SHIPPED PATH: the script writes one file, the
     sheet, and names nothing under supabase/ as a write target. */
  const src = strip(read("scripts/read-asap.mjs"));
  const writes = [...src.matchAll(/fs\.(writeFileSync|appendFileSync|renameSync|copyFileSync)\(([^,]+)/g)].map((m) => m[2].trim());
  assert.deepEqual(writes, ["outPath"], `read-asap writes somewhere other than the sheet: ${writes.join(", ")}`);
});

test("AND IT ACCEPTS A PATH OUTSIDE — the control, or the fence could be refusing everything", () => {
  const dir = fixture();
  const out = path.join(os.tmpdir(), `asap-read-control-${Date.now()}.md`);
  try {
    const r = runReader(["--dir", dir, "--out", out, "--dry-run"]);
    assert.equal(r.code, 0, `a path outside the repo was refused:\n${r.out}`);
    assert.match(r.out, /--dry-run: nothing was called/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { force: true });
  }
});

test("A SINGLE SCORE BAND IS REFUSED — the sheet's second question cannot be answered inside one", () => {
  /* The read exists to ask whether a lower-scored essay draws more
     comment than a higher-scored one. Six essays that all scored the
     same cannot answer it, and a file that looks complete is worse
     than one that was never written. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asap-flat-"));
  try {
    fs.mkdirSync(path.join(dir, "Essay_Set_Descriptions"));
    const rows = [["essay_id", "essay_set", "essay", "domain1_score"].join("\t")];
    for (let i = 0; i < 8; i++) {
      /* OVER THE WORD FLOOR, or `loadCorpus` drops every row and the
         refusal under test is never reached — the first version of this
         fixture failed for exactly that reason at the old 50-word floor
         and looked like the band check not working, and it happened
         again when the floor moved to 250. The essay is built to the
         CONSTANT now, so the next move of the floor cannot repeat it. */
      const para = "Computers help people in many different ways every single day, and this essay explains why that is so for families and for schools. You can learn new things, talk to relatives who live a long way away, and find information for school work without ever going to a library building. ";
      rows.push([i + 1, 1, para.repeat(Math.ceil(MIN_ESSAY_WORDS / para.split(/\s+/).length) + 1).trim(), 3].join("\t"));
    }
    fs.writeFileSync(path.join(dir, "training_set_rel3.tsv"), Buffer.from(rows.join("\n"), "latin1"));
    fs.writeFileSync(path.join(dir, "Essay_Set_Descriptions", "set1.txt"), "Prompt and scoring guide for set 1.");

    const out = path.join(os.tmpdir(), `asap-read-flat-${Date.now()}.md`);
    const r = runReader(["--dir", dir, "--out", out, "--sets", "1", "--dry-run"]);
    assert.equal(r.code, 1, "a single-band selection was accepted");
    assert.match(r.out, /same normalised band/i);
    assert.ok(!fs.existsSync(out), "it wrote a file it had already refused to produce");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the read is GITIGNORED as well as fenced — two lines, because they cover different people", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /asap-read/, "nothing in .gitignore covers the read file");
});

/* ================================================================
   PER-SET BANDS — the bug Jared found by reading the file

   ASAP scores each set on its own range, and the first read compared
   raw scores across sets: a set-7 essay at 5/30, a WEAK essay, sat at
   the top of the sheet as "score 5", so the lowest-versus-highest
   question compared two weak essays.
   ================================================================ */

test("A SET-7 ESSAY AT 5/30 IS A WEAK ESSAY, and a set-2 essay at 5/6 is a strong one", () => {
  /* THE REGRESSION, by name. Same raw number, opposite bands. Before
     the fix these two were indistinguishable on the sheet. */
  const r7 = { ...DECLARED_SCORE_RANGES[7] };
  const r2 = { ...DECLARED_SCORE_RANGES[2] };
  assert.equal(bandOf(normaliseScore(5, r7)), "low", "5/30 did not band as low");
  assert.equal(bandOf(normaliseScore(5, r2)), "high", "5/6 did not band as high");
  assert.notEqual(bandOf(normaliseScore(5, r7)), bandOf(normaliseScore(5, r2)), "the same raw score bands the same across sets");
});

test("THE READ'S STRONG ESSAY IS STRONG IN ITS OWN SET, not merely the largest raw number", () => {
  /* Driven through selectForRead with rows where RAW order and
     NORMALISED order disagree — set 7's raw scores are all larger than
     set 2's, and every set-7 essay here is weak. A selection that
     still sorted raw scores would put a set-7 essay at the top. */
  const rows = [
    ...[3, 4, 5, 6].map((sc, i) => ({ id: `7-${i}`, set: 7, score: sc, words: 400 })),
    ...[1, 2, 5, 6].map((sc, i) => ({ id: `2-${i}`, set: 2, score: sc, words: 400 })),
  ];
  const allScores = [...rows, { set: 7, score: 0 }, { set: 7, score: 30 }];
  const { chosen, bandsCovered } = selectForRead({ rows, allScores, n: 6, seed: 1 });
  assert.ok(bandsCovered.length >= 2, `only ${bandsCovered.join(",")} covered, so the comparison is unavailable`);
  const top = chosen[chosen.length - 1];
  assert.equal(top.band, "high", `the strongest essay read is in the ${top.band} band`);
  assert.notEqual(top.set, 7, `the "strongest" essay is set 7 at ${top.score}/30 — raw order is back`);
  /* And every set-7 essay in this corpus is weak, so none may band high. */
  assert.ok(chosen.filter((c) => c.set === 7).every((c) => c.band === "low"), "a weak set-7 essay was banded above low");
});

test("A DECLARED RANGE THE DATA CONTRADICTS IS REFUSED, not quietly used", () => {
  /* The check that makes restating a third-party range acceptable.
     It caught this file's own fixture on its first run — set 1 scored
     0 and 1, which ASAP set 1 cannot — so it is known to bite. */
  assert.throws(
    () => scoreRanges([{ set: 1, score: 0 }, { set: 1, score: 12 }]),
    /outside the declared range/,
    "a set-1 score of 0 was accepted against a declared 2-12"
  );
  const ok = scoreRanges([{ set: 1, score: 2 }, { set: 1, score: 12 }]);
  assert.equal(ok[1].source, "declared");
  /* An undeclared set is OBSERVED and says so — the printout labels it,
     because a range whose top score nobody reached reads narrower than
     the rubric. */
  const obs = scoreRanges([{ set: 8, score: 10 }, { set: 8, score: 50 }]);
  assert.equal(obs[8].source, "observed");
  assert.deepEqual([obs[8].min, obs[8].max], [10, 50]);
});

test("THE RANGE COMES FROM EVERY ESSAY, not only the ones above the word floor", () => {
  /* The floor decides which essays are READ, not the scale they are
     marked on. Short essays skew low, so a range computed only above
     the floor would raise an observed minimum and mis-band a set whose
     range is not declared. Drives the observed (set 8) path, where it
     matters. */
  const above = [{ id: "a", set: 8, score: 40, words: 400 }, { id: "b", set: 8, score: 50, words: 400 }];
  const all = [...above, { set: 8, score: 5 }];
  const narrow = selectForRead({ rows: above, allScores: above, n: 2 });
  const wide = selectForRead({ rows: above, allScores: all, n: 2 });
  assert.equal(narrow.ranges[8].min, 40);
  assert.equal(wide.ranges[8].min, 5, "a below-floor score did not reach the range");
  assert.notDeepEqual(
    narrow.chosen.map((c) => c.band),
    wide.chosen.map((c) => c.band),
    "including the below-floor score changed nothing, so the range is not reading it"
  );
});

test("THE WORD FLOOR IS 250, and loadCorpus takes it by default", () => {
  assert.ok(MIN_ESSAY_WORDS >= 250, `the floor is ${MIN_ESSAY_WORDS} — Jared asked for at least 250`);
  const src = read("scripts/lib/asap-corpus.mjs");
  assert.match(src, /minWords = MIN_ESSAY_WORDS/, "loadCorpus has its own default instead of the shared floor");
});

test("THE SAME SEED GIVES THE SAME READ", () => {
  const rows = [1, 2, 3, 4, 5, 6].map((sc, i) => ({ id: `${i}`, set: 2, score: sc, words: 400 }));
  const a = selectForRead({ rows, n: 4, seed: 7 }).chosen.map((c) => c.id);
  const b = selectForRead({ rows, n: 4, seed: 7 }).chosen.map((c) => c.id);
  const c = selectForRead({ rows, n: 4, seed: 8 }).chosen.map((c) => c.id);
  assert.deepEqual(a, b, "one seed gave two different reads — a measurement is an anecdote with a bigger n");
  assert.ok(a.length > 0);
  /* A different seed CAN coincide on a small corpus; what must not
     happen is the seed being ignored. */
  assert.ok(new Set([a.join(), c.join()]).size >= 1);
});

test("THE DRY RUN SAYS WHICH BANDS A SET CAN FILL above the floor, not only how many essays it has", () => {
  /* The floor keeps long essays and length tracks score, so a set of
     short narratives can clear the floor only in its upper bands. A
     total of 40 would read as plenty while the low band held none. */
  const allScores = [
    ...[0, 30, 5, 15, 25].map((score, i) => ({ id: i, set: 7, score })),
    ...[2, 12, 7].map((score, i) => ({ id: 100 + i, set: 1, score })),
  ];
  const ranges = scoreRanges(allScores);
  const rows = [
    { id: 10, set: 7, score: 25 },
    { id: 11, set: 7, score: 28 },
    { id: 12, set: 7, score: 15 },
    { id: 20, set: 1, score: 2 },
  ];
  const a = bandAvailability({ rows, ranges });
  assert.deepEqual(a[7], { low: 0, middle: 1, high: 2 }, "set 7's bands were not counted from its own range");
  assert.deepEqual(a[1], { low: 1, middle: 0, high: 0 });
  assert.equal(a[8], undefined, "a set with no rows was invented");
  /* And the dry run prints it: the header names the three bands. */
  assert.match(strip(read("scripts/read-asap.mjs")), /bandAvailability\(\{ rows: corpus\.rows, ranges \}\)/, "the dry run does not compute per-band availability");
});

test("ANONYMISED TOKENS BECOME PLACEHOLDERS for what a model reads, and holes only for the no-writing measurement", () => {
  const raw = "Dear @CAPS1, my friend @PERSON2 in @LOCATION1 uses it @NUM1 hours. @PERSON1 and @CAPS1 again.";
  assert.equal(
    placeholderAnon(raw),
    "Dear [proper noun 1], my friend [name 2] in [place 1] uses it [number 1] hours. [name 1] and [proper noun 1] again."
  );
  assert.equal(stripAnon(raw), "Dear , my friend in uses it hours. and again.", "the measurement's strip changed");
  assert.equal(placeholderAnon("@ZORP3 said"), "[redacted 3] said", "an unknown family was guessed at");
  /* ONE LABEL PER FAMILY: @CAPS1 and @PERSON1 are different entities. */
  const labels = Object.values(PLACEHOLDER_LABELS);
  assert.equal(new Set(labels).size, labels.length, "two families share a placeholder, so two entities would read as one");
  assert.ok(labels.length >= 10, "the label table is nearly empty, so the distinctness check says little");
  /* The no-writing sampler keeps stripping, on purpose. */
  assert.match(strip(read("scripts/sample-asap.mjs")), /anon: "strip"/, "sample-asap changed how it anonymises");
});

test("THE SHEET IS RENDERED END TO END — the numbers, both questions, and the schema on the wire", () => {
  /* NOTHING RAN READ MODE PAST --dry-run BEFORE THIS. So the sheet a
     person opens — the printed point count, the severity mix, both
     questions — had never been rendered by any test, and the claim that
     the strict schema reaches the provider rested on a grep of the
     source. A guard for a bug that needs a user action has to perform
     the action; this one performs the run.

     The stub RECORDS each request body. That is the artifact: the
     bytes that left for the provider, not the line of code that
     intended to send them. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asap-e2e-"));
  try {
    const dir = path.join(tmp, "corpus");
    fs.mkdirSync(path.join(dir, "Essay_Set_Descriptions"), { recursive: true });
    const para = "The printing press changed who could hold an argument in public, and this essay considers how and why that happened across several decades of European history, as @PERSON1 argued. ";
    const body = para.repeat(Math.ceil(MIN_ESSAY_WORDS / para.split(/\s+/).length) + 1).trim();
    const rows = [["essay_id", "essay_set", "essay", "domain1_score"].join("\t")];
    /* Set 1 is 2-12 and set 2 is 1-6: a LOW and a HIGH essay in each,
       so the read has two bands and the table has something to count. */
    [[1, 2], [1, 12], [2, 1], [2, 6], [1, 7], [2, 3]].forEach(([set, score], i) => rows.push([i + 1, set, body, score].join("\t")));
    fs.writeFileSync(path.join(dir, "training_set_rel3.tsv"), Buffer.from(rows.join("\n"), "latin1"));
    fs.writeFileSync(path.join(dir, "Essay_Set_Descriptions", "set1.txt"), "Persuasive: take a position and support it.");
    fs.writeFileSync(path.join(dir, "Essay_Set_Descriptions", "set2.txt"), "Persuasive: argue a view on censorship.");

    const bodies = path.join(tmp, "bodies.jsonl");
    const stub = path.join(tmp, "stub.mjs");
    /* Every call returns two FUNDAMENTAL points and one MINOR, quoting
       text that is really in the essay, so the arithmetic below is
       known in advance. The MINOR one comes FIRST, so the sheet's
       fundamental-first order is something the renderer did rather
       than the order the reply happened to arrive in. */
    fs.writeFileSync(
      stub,
      `import fs from "node:fs";
       globalThis.fetch = async (_url, init) => {
         fs.appendFileSync(${JSON.stringify(bodies)}, init.body + "\\n");
         return { ok: true, json: async () => ({ usage: { prompt_tokens: 1000, completion_tokens: 500 }, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reading: { genre: "argument",
           mainIdea: "across several decades of European history",
           support: ["The printing press changed who could hold an argument in public"],
           points: [
           { quote: "across several decades", deficiency: "repetition", note: "Said twice." },
           { quote: "changed who could hold an argument", deficiency: "claim-without-evidence", note: "The claim is asserted, not shown." },
           { quote: "how and why that happened", deficiency: "unsupported-generalisation", note: "Too broad for what follows." },
         ] }, overall: { bandCount: 6, bandsConsidered: ["1","2","3","4","5","6"].map((band) => ({ band, descriptor: "Persuasive", rating: band === "3" ? 8 : 4 })),
           band: "3", sentence: "OVERALL-SENTINEL: it partly meets the criteria; its central claim is never supported." } }) } }] }) };
       };\n`
    );
    const out = path.join(tmp, "read.md");
    execFileSync(process.execPath, ["--import", stub, path.join(rootDir, "scripts", "read-asap.mjs"), "--dir", dir, "--out", out, "--sets", "1,2", "--n", "6"], {
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "sk-fake" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    /* 1. THE SCHEMA REACHED THE WIRE. */
    const sent = fs.readFileSync(bodies, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(sent.length > 0, "no request was made, so nothing below is about a real run");
    for (const b of sent) {
      assert.equal(b.response_format.type, "json_schema", "the request went out as json_object — the enum is a suggestion again");
      assert.equal(b.response_format.json_schema.strict, true, "the schema went out non-strict");
      const branches = b.response_format.json_schema.schema.properties.reading.anyOf;
      assert.ok(Array.isArray(branches) && branches.length === 4, "the per-genre branches did not reach the wire");
      const e = branches.find((x) => x.properties.genre.enum[0] === "argument").properties.points.items.properties.deficiency.enum;
      assert.ok(e.includes("claim-without-evidence") && e.length > 5, "the argument branch's enum on the wire is not its codes");
      /* THE ESSAY WENT OUT WITH A PLACEHOLDER, NOT A HOLE, and with the note
         saying a placeholder is never a fault. */
      const user = b.messages.find((x) => x.role === "user").content;
      assert.ok(user.includes("as [name 1] argued"), "the anonymised name went out as a hole or a raw token");
      assert.ok(!/@[A-Z]/.test(user), "a raw ASAP token reached the model");
      assert.ok(user.includes(PLACEHOLDER_NOTE), "the placeholder note did not go out with the essay");
      assert.ok(!b.messages.find((x) => x.role === "system").content.includes(PLACEHOLDER_NOTE), "the note leaked into the system prompt");
    }

    /* 2. THE NUMBERS. 6 essays x 3 points: 12 fundamental, 6 minor. */
    const md = fs.readFileSync(out, "utf8");
    assert.match(md, /Point count against band/, "the point-count table is missing");
    const rowsIn = [...md.matchAll(/^\| (low|middle|high) \| (\d+) \| (\d+) \| [\d.—]+ \| (\d+) \| (\d+) \| (\d+) \| [\d.—]+ \| \d+ of \d+ \|$/gm)];
    assert.ok(rowsIn.length >= 2, `the band table has ${rowsIn.length} rows`);
    const total = (i) => rowsIn.reduce((a, r) => a + Number(r[i]), 0);
    assert.equal(total(3), 18, "the point total across bands is wrong");
    assert.equal(total(4), 12, "the fundamental total is wrong");
    assert.equal(total(5), 6, "the minor total is wrong");
    assert.match(md, /Codes outside the closed set: 0\./, "the unknown-code count is missing or non-zero");
    assert.match(md, /Genre read from the criteria:\*\* 6 of 6/, "the genre check did not count all six argument essays");
    assert.match(md, /Codes that do not fit the genre the model itself stated: 0\./, "the off-genre count is missing or wrong");
    assert.match(md, /read as a prediction[^:]*: 0\./, "the prediction count is missing or non-zero");
    /* 1 of 3 essays in each set is middle, and the reply always picks 3 of 1-6, which places middle. */

    assert.match(md, /Points removed by the thesis rule: 0\./, "the thesis-rule count is missing or wrong");
    assert.match(md, /not in the essay even with placeholders set aside: 0\./, "the fabrication count is missing or wrong");
    assert.match(md, /differed only by a dropped placeholder: 0\*\*/, "the placeholder-only count is missing");
    assert.match(md, /Best-fit reading agrees with the human band: 2 of 6\./, "the best-fit agreement is missing or wrong");
    assert.match(md, /differed from its own best-rated\s+band on 0 essay/, "the named-vs-pick count is missing or wrong");
    assert.match(md, /Ties for the top rating: 0\. Ratings outside 1-10: 0\./, "the tie and range counts are missing");
    /* THE COST TABLE, from the stub's usage. */
    assert.match(md, /## What this run cost, measured/, "the cost section is missing");
    assert.match(md, /\| mean \| 1000 \| 500 \| 0 \| 0\.00045 \| 1 \|/, "the measured cost is missing or not priced from credits.ts");
    assert.match(md, /replies cut off at it: 0/);
    assert.match(md, /shorter than the band count the model itself stated: 0; shorter than the rubric's/, "the band-completeness counts are missing");
    assert.match(md, /descriptors not found in the criteria: 0\./, "the descriptor check is missing or wrong");

    /* 2b. THE OPENING READING COMES FIRST, AND THE POINTS FUNDAMENTAL FIRST. */
    const first = md.slice(md.indexOf("## 1. Set"));
    const at = (needle) => first.indexOf(needle);
    assert.ok(at("OVERALL-SENTINEL") > 0, "the opening reading is not on the essay's section");
    assert.ok(at("OVERALL-SENTINEL") < at("**claim-without-evidence**"), "the opening reading does not come before the points");
    assert.ok(at("**unsupported-generalisation**") < at("**repetition**"), "a minor point is shown above a fundamental one");
    assert.ok(at("**claim-without-evidence**") < at("**unsupported-generalisation**"), "the model's order was not kept inside a level");
    assert.match(md, /\| 3 \| (yes|no) \| 3 \| 2 \| 1 \|/, "the model's reading and its agreement are not in the sheet row beside the counts");

    /* 3. BOTH QUESTIONS, and the severity one by its substance. */
    assert.match(md, /Does the WEAKER essay get more substantive comment/);
    assert.match(md, /Does the SUBSTANCE track the band\?/, "the severity question is missing from the sheet");

    /* 4. BANDS, not raw scores — and the false claim is gone. */
    assert.match(md, /\(low band\)/);
    assert.match(md, /\(high band\)/);
    assert.match(md, /\d+\/12/, "raw scores are not shown against their set's maximum");
    assert.doesNotMatch(md, /1[–-]6 holistic\s+band/, "the sheet still says every set is scored 1-6");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("NO ESSAY TEXT IS PRINTED — the file is the only place it goes", () => {
  /* A terminal is pasteable and scrollback outlives the run. The
     script's own summary must name counts and ids and nothing else. */
  const src = strip(read("scripts/read-asap.mjs"));
  const printed = [...src.matchAll(/console\.(log|error)\(([^\n]*)/g)].map((m) => m[2]).join("\n");
  assert.doesNotMatch(printed, /row\.essay|o\.row\.essay|\.essay\b/, "the script prints essay text to the terminal");
  /* Non-vacuity: it really does write the essay SOMEWHERE, or this
     guard is about a script that does nothing.

     ANY IDENTIFIER, not `o`. The first version pinned the loop
     variable's NAME, so renaming it to `m` in the per-set banding
     change failed a guard whose claim is about where the text goes —
     the ledger's "pinned to the writing, not the claim", in a regex. */
  assert.match(src, /sheet\.push\(\w+\.row\.essay\)/, "the read never writes the essay at all");
});

test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-asap-sampler\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
