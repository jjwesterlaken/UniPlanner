/* ==================================================================
   noWriting.js — the constraint that separates "points at a problem"
   from "hands you something to paste"

   ESSAY-FEEDBACK.md §3 layer 3: the verifiable layer. Layers 1 and 2
   (a schema with nowhere for a rewrite to live, a per-field length
   cap) are about SIZE. This one is about KIND, and it is decidable
   with no extra provider call:

     locating a problem requires quoting THEIR text   -> always passes
     offering replacement wording produces prose that
     is not in the input                              -> always fails

   The two are separated by whether the text already exists, which is
   a substring question.

   WHAT IT CANNOT DO, said here rather than discovered later: it
   cannot stop a student pasting a suggestion in and calling it their
   own. Nothing can. What it buys is that the app never HANDS them the
   text to paste, which is the difference between a study tool and a
   ghostwriter — and the difference an academic-integrity office would
   ask about.

   ------------------------------------------------------------------
   THE TWO PARAMETERS ARE REQUIRED, AND THAT IS THE POINT

   `matchUnit` and `window` have NO DEFAULTS. Every function here
   throws without them.

   ESSAY-FEEDBACK.md proposes 12 words for the window and says, in as
   many words, that 12 is "a starting point, not a measurement, and it
   must be measured before it ships — the distribution lesson from the
   ink work: a threshold sized to an anecdote is sized to the wrong
   thing." This project has paid for that lesson twice: a pressure
   floor that would have clamped 63% of a real stylus page, and
   TYPICAL_SUMMARY_OUTPUT_TOKENS sitting at 5.9x reality while setting
   the price of the product.

   A default here would be that mistake with an academic-integrity
   claim attached, and a default is worse than a marker because it
   works. So there is none: `scripts/measure-no-writing.mjs` produces
   the distribution, a person reads where the two populations separate,
   and the numbers are written down WITH the measurement that produced
   them. Until then nothing can call this and get an answer.
   ================================================================== */

const required = (name, value) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `noWriting: ${name} must be a positive integer and has no default. ` +
        "Size it with scripts/measure-no-writing.mjs on real output first — " +
        "ESSAY-FEEDBACK.md §3 is explicit that a guessed threshold is sized to the wrong thing."
    );
  }
  return value;
};

/* Curly quotes, dashes and the rest are normalised away because a model
   and a student's word processor disagree about them constantly, and a
   quotation that differs from the essay only by an apostrophe is the
   student's own words. An intra-word apostrophe or hyphen is KEPT —
   "student's" and "well-argued" are one word each, and splitting them
   would invent boundaries the source does not have. */
export function normaliseWords(text) {
  return String(text || "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9'\-\s]/g, " ")
    .replace(/(^|\s)[-']+|[-']+(?=\s|$)/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
}

/** Every k-gram of the source, as joined strings, for O(1) lookup. */
export function gramSet(words, k) {
  required("matchUnit", k);
  const out = new Set();
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(" "));
  return out;
}

/**
 * Which candidate positions are COVERED by the source.
 *
 * A position is covered when it takes part in at least one run of
 * `matchUnit` consecutive words that appears verbatim in the source.
 *
 * WHY NOT "IS THIS n-GRAM ABSENT". The obvious formulation — refuse if
 * any window-sized n-gram is missing from the source — is monotone the
 * WRONG WAY: an absent n-gram can always be extended into an absent
 * (n+1)-gram, so a larger window would catch strictly more rather than
 * less, and the threshold would mean the opposite of what anybody
 * reading it expects. Coverage does not have that defect: connective
 * tissue between quotations leaves short uncovered runs, a rewritten
 * sentence leaves one long one, and the length of the longest
 * uncovered run is a number whose scale means something.
 */
export function coverage(candidateWords, sourceGrams, matchUnit) {
  required("matchUnit", matchUnit);
  const covered = new Array(candidateWords.length).fill(false);
  for (let i = 0; i + matchUnit <= candidateWords.length; i++) {
    if (sourceGrams.has(candidateWords.slice(i, i + matchUnit).join(" "))) {
      for (let j = i; j < i + matchUnit; j++) covered[j] = true;
    }
  }
  return covered;
}

/** The maximal stretches of candidate text the source does not account for. */
export function novelRuns(candidate, source, { matchUnit } = {}) {
  required("matchUnit", matchUnit);
  const words = normaliseWords(candidate);
  const grams = gramSet(normaliseWords(source), matchUnit);
  const covered = coverage(words, grams, matchUnit);

  const runs = [];
  let start = -1;
  for (let i = 0; i <= words.length; i++) {
    const isNovel = i < words.length && !covered[i];
    if (isNovel && start < 0) start = i;
    if (!isNovel && start >= 0) {
      runs.push({ start, length: i - start, text: words.slice(start, i).join(" ") });
      start = -1;
    }
  }
  return runs;
}

/** The single number a threshold is compared against. */
export const longestNovelRun = (candidate, source, opts) =>
  novelRuns(candidate, source, opts).reduce((max, r) => Math.max(max, r.length), 0);

/* Every way a model marks a quotation.
 *
 * THE FIRST VERSION SAW DOUBLE QUOTES ONLY, and reported "0 quoted
 * spans" over a real run -- a number that reads as "the model never
 * quoted" and could equally have meant "the model quoted in a form
 * this could not see". Two different findings with two different
 * remedies, told apart by nothing. Single quotes, curly singles,
 * markdown emphasis and backticks were all invisible.
 *
 * Single quotes are the awkward one: an apostrophe is the same
 * character, so `don't` must not open a span. The pattern requires a
 * non-letter before the opening mark and after the closing one, which
 * is what separates 'a quoted phrase' from the possessive in "the
 * student's point".
 *
 * It is deliberately GENEROUS. A false positive costs one span checked
 * against the essay, which either matches or is reported; a false
 * negative is the failure that already happened -- a measurement
 * reporting that a mechanism was never exercised when it may have
 * been.
 */
const QUOTE_PATTERNS = [
  /"([^"]{2,}?)"/g,
  /“([^”]{2,}?)”/g,
  /«([^»]{2,}?)»/g,
  /`{1,3}([^`]{2,}?)`{1,3}/g,
  /\*\*([^*]{2,}?)\*\*/g,
  /(?<![A-Za-z0-9])'([^']{2,}?)'(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])‘([^’]{2,}?)’(?![A-Za-z0-9])/g,
];

export function quotedSpans(text) {
  const s = String(text || "");
  const out = [];
  const seen = new Set();
  for (const re of QUOTE_PATTERNS) {
    for (const m of s.matchAll(re)) {
      const span = m[1].trim();
      if (span && !seen.has(span)) {
        seen.add(span);
        out.push(span);
      }
    }
  }
  return out;
}

/**
 * The check itself.
 *
 * `fields` is whatever the endpoint would return as prose — the
 * suggestion text, per criterion. `essay` and `criteria` are the two
 * things the student supplied; a span drawn from either is theirs, and
 * the rubric's own language is how the feedback is allowed to name a
 * band.
 *
 * TWO VIOLATIONS, KEPT DISTINCT, because they mean different things to
 * whoever is reading a refusal:
 *
 *   unquoted-novelty  a run of new prose written FOR the essay
 *   quote-not-found   a quotation that is not in what was submitted,
 *                     which is the sharper one: it asserts the student
 *                     wrote something they did not
 */
export function checkNoWriting({ fields = [], essay = "", criteria = "", matchUnit, window } = {}) {
  required("matchUnit", matchUnit);
  required("window", window);

  const source = `${essay}\n${criteria}`;
  const sourceWords = normaliseWords(source);
  const violations = [];

  for (const [index, field] of fields.entries()) {
    const text = String(field == null ? "" : field);

    for (const quote of quotedSpans(text)) {
      const qWords = normaliseWords(quote);
      if (qWords.length < window) continue;
      const grams = gramSet(sourceWords, qWords.length);
      if (!grams.has(qWords.join(" "))) {
        violations.push({ kind: "quote-not-found", index, words: qWords.length, text: quote });
      }
    }

    for (const run of novelRuns(text, source, { matchUnit })) {
      if (run.length >= window) {
        violations.push({ kind: "unquoted-novelty", index, words: run.length, text: run.text });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
