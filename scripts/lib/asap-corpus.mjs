/* The ASAP corpus: reading it, sampling it, and the rubrics beside it.

   EXTRACTED SO THERE IS ONE COPY, not two. `sample-asap.mjs` measures
   and `read-asap.mjs` reads, and both need the same four things — the
   TSV parsed as Windows-1252, the anonymisation stripped, the rubric
   found by SET NUMBER rather than by a filename, and a deterministic
   stratified sample. A second copy of any of those would be the
   restatement pattern with a corpus attached: the day the download is
   repackaged again, one script follows and the other does not.

   NOTHING HERE PRINTS OR WRITES. It returns rows; what a caller is
   allowed to do with the text is the caller's rule, and the two
   callers have opposite ones. */

import fs from "node:fs";
import path from "node:path";
import { readDocxText } from "./docx-text.mjs";

/* Sets 1, 2, 7 and 8 only. Sets 3-6 are SOURCE-DEPENDENT: the student
   responds to a supplied passage, so a quotation of that passage is
   the student quoting their source rather than the model quoting the
   student. That is a different measurement, not a bigger one. */
export const DEFAULT_SETS = [1, 2, 7, 8];

/* @CAPS1, @PERSON2, @LOCATION1, @NUM1, @ORGANIZATION1, @DATE1 … the
   whole family, including the bare forms. One pattern rather than a
   list, because a list is a restatement of somebody else's scheme.

   They are stripped because they are frequent and IDENTICAL across
   essays, so left in they inflate coverage and push measured novel
   runs DOWN — the measurement would flatter the constraint. */
const ANON = /@[A-Z]+\d*/g;
export const stripAnon = (s) => s.replace(ANON, " ").replace(/\s{2,}/g, " ").trim();

/**
 * Every usable row, plus the rubric for each set.
 *
 * Throws with a message an operator can act on: a missing TSV, a set
 * with no readable rubric, or a corpus that matches nothing.
 */
export function loadCorpus({ dir, sets = DEFAULT_SETS, minWords = 50 } = {}) {
  const tsvPath = path.join(dir, "training_set_rel3.tsv");
  if (!fs.existsSync(tsvPath)) {
    throw new Error(`not found: ${tsvPath}\n\nPoint --dir at the folder you extracted the Kaggle download into.`);
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
  /* THE HUMAN RATER SCORE. Read here since the sampler was written, to
     stratify across the score range — and it is also the answer to the
     quality question the design document spent a fortnight recording
     as unanswerable. See ESSAY-FEEDBACK.md. */
  const iScore = col("domain1_score");

  const rows = [];
  let tooShort = 0;
  for (const line of lines.slice(1)) {
    const f = line.split("\t");
    const set = Number(f[iSet]);
    if (!sets.includes(set)) continue;
    const essay = stripAnon(f[iEssay] || "");
    if (!essay) continue;
    const words = essay.split(/\s+/).filter(Boolean).length;
    /* A FLOOR ON LENGTH, because the first real run admitted a 4-word
       essay. A stub that short gives the model nothing to quote and
       nothing to be wrong about. ASAP has blanks and near-blanks in
       it; they are rows in a corpus, not essays. */
    if (words < minWords) {
      tooShort++;
      continue;
    }
    rows.push({ id: f[iId], set, score: Number(f[iScore]), essay, words });
  }
  if (rows.length === 0) throw new Error("no rows matched the requested sets — is this the right TSV?");

  const descDir = fs.readdirSync(dir).find((d) => /essay[_ ]?set[_ ]?descriptions?/i.test(d));
  const rubricFor = new Map();
  const rubricNote = [];
  for (const set of sets) {
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

  const missing = sets.filter((s) => !(rubricFor.get(s) || "").trim());
  if (missing.length) {
    throw new Error(
      `\nNo rubric for set(s) ${missing.join(", ")}.\n\n` +
        "WHAT TO SAVE AS .txt, if the .docx will not read:\n" +
        `  In ${path.join(dir, descDir || "Essay_Set_Descriptions")}, open each set's description\n` +
        "  and save it as plain text next to the .docx, named so the SET NUMBER is in the\n" +
        `  filename — e.g. "set8.txt". Save the PROMPT and the RUBRIC / scoring guide\n` +
        "  (the trait descriptions and what each score point means). Leave out the sample\n" +
        "  essays if the file has any: they are other students' text and are not criteria.\n"
    );
  }

  return { rows, rubricFor, rubricNote, tsvPath, tooShort, descDir };
}

/**
 * A deterministic, stratified sample: `perSet` essays from each set,
 * spread across the human score range.
 *
 * The file is ORDERED, so taking the first n is the top of a list
 * rather than a sample — and the same seed must give the same essays,
 * or a measurement is an anecdote with a bigger n.
 */
export function stratify({ rows, sets = DEFAULT_SETS, perSet = 8, seed = 1 } = {}) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const chosen = [];
  for (const set of sets) {
    const inSet = rows.filter((r) => r.set === set);
    const byScore = new Map();
    for (const r of inSet) {
      if (!byScore.has(r.score)) byScore.set(r.score, []);
      byScore.get(r.score).push(r);
    }
    const buckets = [...byScore.keys()].sort((a, b) => a - b);
    if (!buckets.length) continue;
    const want = Math.min(perSet, inSet.length);
    for (let i = 0; i < want; i++) {
      const bucket = byScore.get(buckets[i % buckets.length]);
      chosen.push(bucket[Math.floor(rand() * bucket.length)]);
    }
  }
  return chosen;
}
