/* ==================================================================
   sample-asap.mjs — thirty ASAP essays through the no-writing
   harness, one command, one summary, no essay text

   ONE COMMAND, ON WINDOWS:

     set OPENAI_API_KEY=sk-...
     node scripts\sample-asap.mjs --dir "C:\path\to\asap-aes"

   `--dir` is the folder holding `training_set_rel3.tsv` and
   `Essay_Set_Descriptions`. Everything else has a default.

   ------------------------------------------------------------------
   IT NEVER PRINTS ESSAY TEXT, AND THAT IS ENFORCED RATHER THAN
   PROMISED

   The ASAP competition rules forbid redistributing the essays, so
   every child run is spawned with `--redact` and the summary here is
   numbers only. That is not a nicety bolted on: the harness's
   per-field section prints every quoted span, and a span the model
   quoted VERBATIM is the student's own words — so an unredacted run
   over this corpus would put essay text on screen. A test seeds a
   sentinel sentence into a fake essay and asserts it reaches neither
   the summary nor the JSON.

   The per-essay working files are written to a temp directory and
   DELETED at the end, for the same reason.

   ------------------------------------------------------------------
   WHICH SETS, AND WHY NOT THE OTHERS

   Sets 1, 2, 7 and 8 only. Sets 3-6 are SOURCE-DEPENDENT: the student
   responds to a supplied passage, so a quotation of that passage is
   the student quoting their source rather than the model quoting the
   student — and unless the passage is fed in as part of the criteria
   it reads as novelty. That is a different measurement, not a bigger
   one.

   ------------------------------------------------------------------
   THE ANONYMISATION IS STRIPPED, AND IT BIASES THE RESULT

   ASAP replaces names with `@CAPS1`, `@PERSON2`, `@LOCATION1`,
   `@NUM1` and friends. Those tokens are frequent and IDENTICAL across
   essays, so left in they inflate coverage and push the measured
   novel runs DOWN — the measurement would flatter the constraint.
   They are removed from the essay before anything is sent.

   Two biases remain and they point in OPPOSITE directions, which is
   worth knowing before reading the numbers as precise: these are
   school essays of 150-650 words, so there is less for the model to
   quote (novel runs UP), while the prompts are narrower than a
   university assignment (novel runs DOWN). The sampler prints the
   word-count distribution so the reader can see which corpus they
   actually got.

   ------------------------------------------------------------------
   THE SAMPLE IS DETERMINISTIC AND STRATIFIED

   `--seed` (default 1) drives a small PRNG, so re-running gives the
   SAME thirty essays — a measurement nobody can reproduce is an
   anecdote with a bigger n. Within each set the essays are stratified
   across the human score range rather than taken from the top of the
   file, because the file is ordered and the top of it is not a
   sample.
   ================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDocxText } from "./lib/docx-text.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- arguments ---------- */

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const dir = opt("--dir");
const perSet = Number(opt("--per-set", "8"));
const runs = opt("--runs", "3");
const seed = Number(opt("--seed", "1"));
/* A FLOOR ON LENGTH, because the first real run admitted a 4-word
   essay. A stub that short gives the model nothing to quote and
   nothing to be wrong about, so its fields are novel by construction
   and it drags the distribution the whole measurement is reading.
   ASAP has blanks and near-blanks in it; they are rows in a corpus,
   not essays. */
const minWords = Number(opt("--min-words", "50"));
const dryRun = argv.includes("--dry-run");
/* `two-arm` is the mode that answers the question now: does the
   STRUCTURE separate description from ghostwriting, and where does the
   note cap go. `novelty` is the original single-arm instrument, kept
   because it is still the right tool for a question about overlap —
   it is just not the one that decides this. */
const mode = opt("--mode", "two-arm");
if (!["two-arm", "novelty"].includes(mode)) {
  console.error(`--mode must be two-arm or novelty, not "${mode}"`);
  process.exit(1);
}
const SETS = (opt("--sets", "1,2,7,8")).split(",").map((s) => Number(s.trim()));

if (!dir) {
  console.error(
    "usage: node scripts/sample-asap.mjs --dir <folder containing training_set_rel3.tsv>\n\n" +
      "Options: --per-set 8   --runs 3   --seed 1   --sets 1,2,7,8   --dry-run"
  );
  process.exit(1);
}
if (!dryRun && !process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Add --dry-run to check the files without calling anything.");
  process.exit(1);
}

/* ---------- the corpus ---------- */

const tsvPath = path.join(dir, "training_set_rel3.tsv");
if (!fs.existsSync(tsvPath)) {
  console.error(`not found: ${tsvPath}\n\nPoint --dir at the folder you extracted the Kaggle download into.`);
  process.exit(1);
}

/* LATIN-1, NOT UTF-8. training_set_rel3.tsv is Windows-1252 and
   contains smart quotes; reading it as UTF-8 produces replacement
   characters mid-word, which would read as novel text later. */
const tsv = fs.readFileSync(tsvPath, "latin1");
const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
const header = lines[0].split("\t").map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`the TSV has no "${name}" column; found: ${header.slice(0, 8).join(", ")}`);
  return i;
};
const iSet = col("essay_set");
const iId = col("essay_id");
const iEssay = col("essay");
const iScore = col("domain1_score");

/* @CAPS1, @PERSON2, @LOCATION1, @NUM1, @ORGANIZATION1, @DATE1 … the
   whole family, including the bare forms. One pattern rather than a
   list, because a list is a restatement of somebody else's scheme. */
const ANON = /@[A-Z]+\d*/g;
const stripAnon = (s) => s.replace(ANON, " ").replace(/\s{2,}/g, " ").trim();

const rows = [];
let tooShort = 0;
for (const line of lines.slice(1)) {
  const f = line.split("\t");
  const set = Number(f[iSet]);
  if (!SETS.includes(set)) continue;
  const essay = stripAnon(f[iEssay] || "");
  if (!essay) continue;
  const words = essay.split(/\s+/).filter(Boolean).length;
  if (words < minWords) {
    tooShort++;
    continue;
  }
  rows.push({ id: f[iId], set, score: Number(f[iScore]), essay, words });
}
if (rows.length === 0) {
  console.error("no rows matched the requested sets — is this the right TSV?");
  process.exit(1);
}

/* ---------- the rubrics ---------- */

const descDir = fs.readdirSync(dir).find((d) => /essay[_ ]?set[_ ]?descriptions?/i.test(d));
const rubricFor = new Map();
const rubricNote = [];
for (const set of SETS) {
  if (!descDir) break;
  const full = path.join(dir, descDir);
  /* Matched by set NUMBER rather than by a filename anybody typed —
     the download has been repackaged more than once and the names
     differ between copies. A .txt of the same set wins, so an
     operator whose .docx cannot be read has a way through. */
  const files = fs.readdirSync(full).filter((f) => new RegExp(`(^|[^0-9])${set}([^0-9]|$)`).test(f));
  const txt = files.find((f) => f.toLowerCase().endsWith(".txt"));
  const docx = files.find((f) => f.toLowerCase().endsWith(".docx"));
  try {
    if (txt) {
      rubricFor.set(set, fs.readFileSync(path.join(full, txt), "utf8"));
      rubricNote.push(`set ${set}: ${txt}`);
    } else if (docx) {
      rubricFor.set(set, readDocxText(path.join(full, docx)));
      rubricNote.push(`set ${set}: ${docx}`);
    }
  } catch (e) {
    rubricNote.push(`set ${set}: COULD NOT READ (${e.message})`);
  }
}

const missing = SETS.filter((s) => !(rubricFor.get(s) || "").trim());
if (missing.length) {
  console.error(`\nNo rubric for set(s) ${missing.join(", ")}.\n`);
  console.error(
    "WHAT TO SAVE AS .txt, if the .docx will not read:\n" +
      `  In ${path.join(dir, descDir || "Essay_Set_Descriptions")}, open each set's description\n` +
      "  and save it as plain text next to the .docx, named so the SET NUMBER is in the\n" +
      `  filename — e.g. "set8.txt". Save the PROMPT and the RUBRIC / scoring guide\n` +
      "  (the trait descriptions and what each score point means). Leave out the sample\n" +
      "  essays if the file has any: they are other students' text and are not criteria.\n"
  );
  process.exit(1);
}

/* ---------- a deterministic, stratified sample ---------- */

let s = seed >>> 0;
const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

const chosen = [];
for (const set of SETS) {
  const inSet = rows.filter((r) => r.set === set);
  /* Stratify across the score range: the file is ordered, so taking
     the first n is the top of a list rather than a sample. */
  const byScore = new Map();
  for (const r of inSet) {
    if (!byScore.has(r.score)) byScore.set(r.score, []);
    byScore.get(r.score).push(r);
  }
  const buckets = [...byScore.keys()].sort((a, b) => a - b);
  const want = Math.min(perSet, inSet.length);
  for (let i = 0; i < want; i++) {
    const bucket = byScore.get(buckets[i % buckets.length]);
    chosen.push(bucket[Math.floor(rand() * bucket.length)]);
  }
}

const wordCounts = chosen.map((c) => c.words).sort((a, b) => a - b);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

console.log("=".repeat(72));
console.log("ASAP SAMPLE — no-writing threshold");
console.log("=".repeat(72));
console.log(`corpus       ${tsvPath}`);
console.log(`sets         ${SETS.join(", ")}  (source-dependent sets excluded)`);
console.log(`sampled      ${chosen.length} essays, ${perSet} per set, seed ${seed}`);
console.log(`words        min ${wordCounts[0]} | p50 ${pct(wordCounts, 50)} | max ${wordCounts[wordCounts.length - 1]}   (floor ${minWords}, ${tooShort} rows below it skipped)`);
/* The floor is ASSERTED rather than assumed: a sample that violated it
   would quietly reintroduce the defect the floor exists to remove. */
if (wordCounts[0] < minWords) {
  console.error(`\nthe floor did not hold: shortest sampled essay is ${wordCounts[0]} words`);
  process.exit(1);
}
console.log(`anonymisation stripped (@CAPS/@PERSON/@LOCATION/@NUM and the rest)`);
console.log(`rubrics      ${rubricNote.join(" | ")}`);
console.log(`mode         ${mode}`);
console.log(`runs each    ${runs}${mode === "two-arm" ? " per arm" : ""}   (${chosen.length * Number(runs) * (mode === "two-arm" ? 2 : 1)} provider calls in total)`);
console.log(`redaction    ON — no essay text is printed or written, by --redact`);
/* THE IDS, so a run is reproducible and auditable. An essay_id is an
   index into a public dataset, not content — and without it "same
   seed, same sample" is a claim nobody can check, including the test
   that asserts it. */
console.log(`essay ids    ${chosen.map((c) => `${c.set}:${c.id}`).join(" ")}`);

if (dryRun) {
  console.log("\n--dry-run: nothing was called and nothing was spent.");
  process.exit(0);
}

/* ---------- run the harness over each pair ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asap-"));
const results = [];
try {
  for (const [n, row] of chosen.entries()) {
    const base = `s${row.set}-${row.id}`;
    const eFile = path.join(tmp, `${base}.essay.txt`);
    const rFile = path.join(tmp, `${base}.rubric.txt`);
    const jFile = path.join(tmp, `${base}.json`);
    fs.writeFileSync(eFile, row.essay, "utf8");
    fs.writeFileSync(rFile, rubricFor.get(row.set), "utf8");

    process.stderr.write(`[${n + 1}/${chosen.length}] set ${row.set} essay ${row.id}…\n`);
    try {
      /* process.execPath, never npx and never a .bin shim: on Windows
         the shim is a .cmd and modern Node refuses to execute it. */
      /* NEITHER CHILD IS EVER ASKED TO SHOW TEXT. measure-no-writing
         needs --redact because its default prints quotes;
         measure-two-arm withholds by default because every quote it
         collects is the student's own words by construction. Two
         scripts, two defaults, one rule. */
      const child =
        mode === "two-arm"
          ? [path.join(ROOT, "scripts", "measure-two-arm.mjs"), "--essay", eFile, "--rubric", rFile, "--runs", String(runs), "--json", jFile]
          : [path.join(ROOT, "scripts", "measure-no-writing.mjs"), "--essay", eFile, "--rubric", rFile, "--runs", String(runs), "--redact", "--json", jFile];
      execFileSync(process.execPath, child, { stdio: ["ignore", "ignore", "inherit"], env: process.env });
      const parsed = JSON.parse(fs.readFileSync(jFile, "utf8"));
      if (mode === "two-arm") {
        for (const arm of ["constrained", "adversarial"]) {
          for (const m of parsed.measured[arm] || []) results.push({ ...m, arm, set: row.set, essayId: row.id });
        }
      } else {
        for (const m of parsed.measurements) results.push({ ...m, set: row.set, essayId: row.id });
      }
    } catch (e) {
      console.error(`  set ${row.set} essay ${row.id}: FAILED (${e.message.split("\n")[0]})`);
    }
  }
} finally {
  /* The working files hold essay text. They go, whatever happened. */
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (results.length === 0) {
  console.error("\nno measurements were taken — every essay failed.");
  process.exit(1);
}

/* ---------- ONE combined summary ---------- */

if (mode === "two-arm") {
  const { summariseTwoArm } = await import(pathToFileURL(path.join(ROOT, "scripts", "lib", "two-arm-summary.mjs")).href);
  summariseTwoArm(results, { sets: SETS, essays: chosen.length });
  process.exit(0);
}

const MATCH_UNITS = [3, 4, 5, 6];
const K = 5;
const table = (label, pick) => {
  console.log(`\n${label}\n`);
  console.log("  matchUnit   n      min   p50   p90   p99   max");
  for (const k of MATCH_UNITS) {
    const xs = results.map((r) => pick(r)[k]).sort((a, b) => a - b);
    console.log(
      `  ${String(k).padEnd(11)} ${String(xs.length).padEnd(6)} ${String(xs[0]).padEnd(5)} ` +
        `${String(pct(xs, 50)).padEnd(5)} ${String(pct(xs, 90)).padEnd(5)} ${String(pct(xs, 99)).padEnd(5)} ${xs[xs.length - 1]}`
    );
  }
};

console.log(`\n${"=".repeat(72)}`);
console.log(`COMBINED — ${results.length} fields from ${chosen.length} essays`);
console.log("=".repeat(72));
table("AGAINST THE REAL ESSAY (what the app would see):", (r) => r.real);
table("AGAINST AN UNRELATED SOURCE (the control — 'definitely novel'):", (r) => r.control);

console.log(`\nPER SET (matchUnit ${K}, against the real essay):\n`);
console.log("  set   fields   p50   p90   max");
for (const set of SETS) {
  const xs = results.filter((r) => r.set === set).map((r) => r.real[K]).sort((a, b) => a - b);
  if (!xs.length) continue;
  console.log(
    `  ${String(set).padEnd(5)} ${String(xs.length).padEnd(8)} ${String(pct(xs, 50)).padEnd(5)} ` +
      `${String(pct(xs, 90)).padEnd(5)} ${xs[xs.length - 1]}`
  );
}

/* THE HISTOGRAM IS THE POINT. A percentile table can hide a bimodal
   distribution completely, and bimodal is exactly what a working
   constraint looks like: a hump of short runs from pointing at a
   problem, a gap, and a tail from writing one. If there is no gap,
   there is no threshold. */
console.log(`\nHISTOGRAM of the longest novel run per field (matchUnit ${K}):\n`);
const hist = new Map();
for (const r of results) hist.set(r.real[K], (hist.get(r.real[K]) || 0) + 1);
const maxCount = Math.max(...hist.values());
for (const len of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(len);
  console.log(`  ${String(len).padStart(3)}w  ${String(n).padStart(4)}  ${"#".repeat(Math.ceil((n / maxCount) * 50))}`);
}

const quotes = results.flatMap((r) => r.quotes || []);
const bad = quotes.filter((q) => !q.verbatim);
console.log(`\nQUOTED SPANS: ${quotes.length} checked, ${bad.length} NOT found in the essay`);
if (bad.length) {
  console.log(`  word counts of the unfound ones: ${bad.map((q) => q.words).sort((a, b) => a - b).join(", ")}`);
  console.log("  (text withheld — a quotation is the student's own words)");
}

console.log(`\n${"=".repeat(72)}`);
console.log("HOW TO READ THIS");
console.log("=".repeat(72));
console.log(`
  Look at the HISTOGRAM for a gap. A working constraint is bimodal:
  short runs where the model quoted the essay and described a problem,
  a gap, then a tail where it wrote prose of its own. The threshold
  goes in the gap.

  If the histogram is one smooth hump with no gap, the answer is NOT a
  number further along it. It is that this layer does not separate the
  two cases on real output, and ESSAY-FEEDBACK.md §3 needs rethinking
  before anything is built on it. That is a finding worth having now
  rather than after the endpoint exists.

  Compare the real table against the control: the control is the top
  of the scale for these exact words. A p90 close to the control means
  most fields are novel prose.

  NOTHING HERE SAYS WHETHER THE FEEDBACK IS ANY GOOD. That needs a
  person reading output beside a mark the essay actually got, on an
  essay whose text may be shared — not this corpus.
`);
