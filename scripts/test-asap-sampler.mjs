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
import { docxToText, zipEntries } from "./lib/docx-text.mjs";

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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asap-fix-"));
  fs.mkdirSync(path.join(dir, "Essay_Set_Descriptions"));
  const SMART = String.fromCharCode(0x92);
  const rows = [["essay_id", "essay_set", "essay", "domain1_score"].join("\t")];
  let id = 1;
  for (const set of [1, 2, 3, 7, 8]) {
    for (let i = 0; i < 8; i++) {
      rows.push([id++, set, `Dear @CAPS1 my friend @PERSON${i} from @LOCATION1 said it${SMART}s good for @NUM1 reasons and I agree with that.`, i % 4].join("\t"));
    }
  }
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
  const src = strip(read("scripts/sample-asap.mjs"));
  assert.match(src, /execFileSync\(\s*process\.execPath/);
  assert.doesNotMatch(src, /npx |node_modules[\\/]\.bin/);
});

test("every path is joined rather than concatenated with a separator", () => {
  const src = strip(read("scripts/sample-asap.mjs"));
  assert.doesNotMatch(src, /["'`][^"'`]*\/scripts\//, "a hardcoded posix path will not resolve on Windows");
});

test("the TSV is read as latin1 — it is Windows-1252 and reading it as UTF-8 corrupts words", () => {
  const src = strip(read("scripts/sample-asap.mjs"));
  assert.match(src, /readFileSync\(tsvPath, "latin1"\)/);
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
