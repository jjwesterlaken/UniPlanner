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

/* WHAT EACH SET'S PROMPT ASKS FOR, as the ASAP set descriptions state
   it: sets 1 and 2 are persuasive (a letter about computers, an essay
   on library censorship) and 7 and 8 are narrative (a story about
   patience, a story about laughter). These are FACTS ABOUT THE CORPUS,
   and the read compares them against the genre the model says the
   criteria describe, so "did it read the genre from the rubric" is
   counted rather than judged. Keyed by set, so a set with no entry is
   reported as unknown rather than guessed. */
export const SET_GENRES = Object.freeze({ 1: "argument", 2: "argument", 7: "narrative", 8: "narrative" });

/* @CAPS1, @PERSON2, @LOCATION1, @NUM1, @ORGANIZATION1, @DATE1 … the
   whole family, including the bare forms. One pattern rather than a
   list, because a list is a restatement of somebody else's scheme.

   They are stripped because they are frequent and IDENTICAL across
   essays, so left in they inflate coverage and push measured novel
   runs DOWN — the measurement would flatter the constraint. */
const ANON = /@[A-Z]+\d*/g;
export const stripAnon = (s) => s.replace(ANON, " ").replace(/\s{2,}/g, " ").trim();

/* ---------------------------------------------------------------
 * THE WORD FLOOR — 250, raised from 50 on 24 September 2026.
 *
 * Jared's read found five of six chosen essays at 52-91 words. An
 * essay that short can support one or two points at most, so it cannot
 * tell you whether the feedback discriminates — a strong 60-word essay
 * and a weak one both get "one point", and the comparison the read
 * exists for is not available. 250 is the least a university-relevant
 * judgement can rest on.
 *
 * SHARED BY BOTH CALLERS ON PURPOSE. The two-arm harness takes this
 * default too, and for the same reason: a 60-word essay cannot carry
 * several points in either instrument. It MOVES THE HARNESS'S
 * POPULATION, so its numbers are not comparable with runs before this
 * change — which is correct, since the earlier population was the
 * fault.
 *
 * WHETHER ENOUGH ESSAYS CLEAR IT is a fact about the corpus, and the
 * corpus is not in this repository. So `loadCorpus` REPORTS how many
 * clear it per set rather than this comment asserting it; set 7 (short
 * narratives) is the one predicted to fall short, and that is a
 * prediction until a run prints the number.
 * --------------------------------------------------------------- */
export const MIN_ESSAY_WORDS = 250;

/* ---------------------------------------------------------------
 * PER-SET SCORE RANGES — because a raw score is not a band.
 *
 * ASAP scores each set on its OWN range. The first read treated
 * `domain1_score` as comparable across sets, so a set-7 essay at 5 —
 * five out of THIRTY, a weak essay — was the "score 5" at the top of
 * the sheet, and the lowest-versus-highest question compared two weak
 * essays. Found by Jared reading the file, 24 September 2026.
 *
 * DECLARED where the rubric range is known, OBSERVED otherwise, and
 * the difference is printed. The declared ranges are facts about a
 * third-party dataset, which is the one kind of restatement allowed —
 * provided something checks it: `scoreRanges` REFUSES a corpus whose
 * observed scores fall outside a declared range, so a wrong number here
 * goes red against the data rather than quietly mis-banding it.
 *
 * Set 8 is not declared. Its range was not given and is not guessed;
 * it is taken from the corpus and labelled `observed`, which is weaker
 * (a range whose top score no essay reached would read as narrower than
 * the rubric) and is said so on the printout.
 * --------------------------------------------------------------- */
export const DECLARED_SCORE_RANGES = Object.freeze({
  1: { min: 2, max: 12 },
  2: { min: 1, max: 6 },
  7: { min: 0, max: 30 },
});

/**
 * The range each set is normalised against: declared where known,
 * observed from `rows` otherwise. Throws if observed scores fall outside
 * a declared range — the check that stops a wrong declared number from
 * silently mis-banding every essay in its set.
 */
export function scoreRanges(rows) {
  const out = {};
  const sets = [...new Set(rows.map((r) => r.set))].sort((a, b) => a - b);
  for (const set of sets) {
    const scores = rows.filter((r) => r.set === set).map((r) => r.score).filter(Number.isFinite);
    if (scores.length === 0) continue;
    const observed = { min: Math.min(...scores), max: Math.max(...scores) };
    const declared = DECLARED_SCORE_RANGES[set];
    if (declared) {
      if (observed.min < declared.min || observed.max > declared.max) {
        throw new Error(
          `set ${set}: observed scores ${observed.min}-${observed.max} fall outside the declared ` +
            `range ${declared.min}-${declared.max}. The declared range is wrong, or the TSV is not ASAP ` +
            "training_set_rel3 — either way every band in this set would be wrong."
        );
      }
      out[set] = { ...declared, source: "declared", observed };
    } else {
      out[set] = { ...observed, source: "observed", observed };
    }
  }
  return out;
}

/** Position of a score within its set's range, 0..1. */
export function normaliseScore(score, range) {
  if (!range || range.max === range.min) return null;
  return (score - range.min) / (range.max - range.min);
}

/* Thirds, deliberately coarse. A read of six to twelve essays cannot
   support finer bands, and a fine band on a small sample is a number
   that looks more precise than the evidence behind it. */
export const BANDS = Object.freeze(["low", "middle", "high"]);
export function bandOf(position) {
  if (position === null || !Number.isFinite(position)) return null;
  if (position < 1 / 3) return "low";
  if (position < 2 / 3) return "middle";
  return "high";
}

/**
 * The essays a person reads, spread across NORMALISED bands.
 *
 * Replaces a selection that sorted RAW scores across sets. Returns
 * `{ chosen, ranges, bandsCovered }`; each chosen row carries
 * `position` and `band` beside its raw `score`.
 *
 * Round-robin over the bands, each band's rows in a seeded order, so
 * the result spans low / middle / high whenever the corpus allows, and
 * the same seed gives the same essays.
 */
/**
 * How many essays AT OR ABOVE THE FLOOR each set has in each band.
 *
 * The floor keeps the longer essays, and length tracks score, so a set
 * can clear the floor comfortably in total while having almost nothing
 * left in its LOW band. A total alone would hide exactly that, and the
 * read's whole question needs a weak essay beside a strong one. So the
 * dry run prints this per band before anything is spent.
 *
 * `rows` are the floor-filtered rows; `ranges` come from every score.
 */
export function bandAvailability({ rows, ranges }) {
  const out = {};
  for (const r of rows) {
    const band = bandOf(normaliseScore(r.score, ranges[r.set]));
    if (!band) continue;
    out[r.set] ??= Object.fromEntries(BANDS.map((b) => [b, 0]));
    out[r.set][band] += 1;
  }
  return out;
}

export function selectForRead({ rows, allScores = rows, n = 6, seed = 1 } = {}) {
  const ranges = scoreRanges(allScores);
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const banded = rows
    .map((r) => {
      const position = normaliseScore(r.score, ranges[r.set]);
      return { ...r, position, band: bandOf(position) };
    })
    .filter((r) => r.band !== null);

  const byBand = new Map(BANDS.map((b) => [b, banded.filter((r) => r.band === b)]));
  /* Seeded shuffle within each band, so the pick is a sample and not
     the top of an ordered file. */
  for (const list of byBand.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  const chosen = [];
  const used = new Set();
  let round = 0;
  while (chosen.length < n) {
    let took = false;
    for (const b of BANDS) {
      const list = byBand.get(b);
      if (round < list.length && chosen.length < n) {
        const r = list[round];
        const key = `${r.set}:${r.id}`;
        if (!used.has(key)) {
          chosen.push(r);
          used.add(key);
          took = true;
        }
      }
    }
    if (!took) break;
    round += 1;
  }
  chosen.sort((a, b) => a.position - b.position || a.set - b.set);
  const bandsCovered = BANDS.filter((b) => chosen.some((r) => r.band === b));
  return { chosen, ranges, bandsCovered };
}



/**
 * Every usable row, plus the rubric for each set.
 *
 * Throws with a message an operator can act on: a missing TSV, a set
 * with no readable rubric, or a corpus that matches nothing.
 */
export function loadCorpus({ dir, sets = DEFAULT_SETS, minWords = MIN_ESSAY_WORDS } = {}) {
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
  /* EVERY SCORE, BEFORE THE FLOOR. The floor decides which essays are
     READ; it does not decide the scale they are marked on. A set's
     range is a property of the whole set, and short essays skew low —
     so a range computed only over the essays that cleared 250 words
     would raise an observed minimum and mis-band every essay in a set
     whose range is not declared. */
  const allScores = [];
  const perSet = {};
  for (const line of lines.slice(1)) {
    const f = line.split("\t");
    const set = Number(f[iSet]);
    if (!sets.includes(set)) continue;
    const essay = stripAnon(f[iEssay] || "");
    if (!essay) continue;
    const words = essay.split(/\s+/).filter(Boolean).length;
    const score = Number(f[iScore]);
    allScores.push({ set, score });
    perSet[set] ||= { total: 0, clear: 0 };
    perSet[set].total += 1;
    if (words >= minWords) perSet[set].clear += 1;
    /* A FLOOR ON LENGTH, because the first real run admitted a 4-word
       essay. A stub that short gives the model nothing to quote and
       nothing to be wrong about. ASAP has blanks and near-blanks in
       it; they are rows in a corpus, not essays. */
    if (words < minWords) {
      tooShort++;
      continue;
    }
    rows.push({ id: f[iId], set, score, essay, words });
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

  return { rows, allScores, perSet, minWords, rubricFor, rubricNote, tsvPath, tooShort, descDir };
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
