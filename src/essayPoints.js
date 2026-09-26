/* ==================================================================
   essayPoints.js — the structured feedback point, and what makes one
   invalid

   WHY THIS EXISTS, in one paragraph. The first real measurement
   disproved §3's premise: it assumed "locating a problem requires
   quoting their text", and the model located problems without
   quoting anything at all. Description and replacement wording are
   both novel prose, so no threshold over novelty separates them.
   Novelty was never the discriminator; it only looked like one
   because the two populations were assumed rather than generated.

   SO THE DEFENCE MOVED FROM DETECTION TO STRUCTURE. A point has
   exactly three channels and each one is bounded by something other
   than a guess about prose:

     quote        must appear VERBATIM in the essay, so it cannot be
                  new writing at all -- this is the whole trick
     deficiency   a value from a CLOSED SET, so it carries no prose
     note         free text, and therefore the ONLY place ghostwriting
                  can live -- which is why its length is the one
                  parameter worth measuring

   §3 layer 1 said "the schema gives a rewrite nowhere to live" and
   was then never used. This is that, done.

   THE PARAMETERS HAVE NO DEFAULTS, the same rule and for the same
   reason as `noWriting.js`: `scripts/measure-two-arm.mjs` prints the
   operating characteristic — refusal rate per arm at every candidate
   value — and a person reads where the arms separate. A default here
   would be worse than a marker, because a default works.
   ================================================================== */

import { normaliseWords, gramSet, quotedSpans, longestNovelRun } from "./noWriting.js";

/**
 * The closed set. A point says WHICH KIND of problem it found; the
 * note says where it bites, in a sentence.
 *
 * It is deliberately about the WRITING rather than about the subject:
 * nothing here requires knowing whether a claim is true, which is a
 * thing this feature does not do and must not appear to do.
 *
 * `off-criterion` exists so a model with nothing to say against a
 * criterion has somewhere honest to put that, rather than inventing a
 * deficiency to fill the schema.
 */
/* MOVED to `supabase/functions/_shared/essaySchema.js` and re-exported
   here, so the essay endpoint (Deno) and this module (browser, Node)
   read one list. The re-export keeps every existing import working. */
export {
  DEFICIENCIES,
  SEVERITY,
  SEVERITY_LEVELS,
  severityOf,
  orderBySeverity,
  GENRES,
  APPLIES_TO,
  fitsGenre,
  codesFor,
  PREDICTION_PATTERNS,
  predictionFraming,
  BAND_RATING_MIN,
  BAND_RATING_MAX,
  bestFit,
  CODE_DEFINITIONS,
  applyThesisRule,
  onMainIdea,
  wordsForMatch,
  essayFeedbackSchema,
} from "../supabase/functions/_shared/essaySchema.js";
import { DEFICIENCIES } from "../supabase/functions/_shared/essaySchema.js";

const isFinitePositive = (v) => Number.isInteger(v) && v > 0;

/** The match units the harness measures new-prose runs at. */
export const MATCH_UNITS = Object.freeze([3, 4, 5, 6]);

const required = (name, value) => {
  if (!isFinitePositive(value)) {
    throw new Error(
      `essayPoints: ${name} must be a positive integer and has no default. ` +
        "Read it off the operating characteristic printed by scripts/measure-two-arm.mjs — " +
        "the first attempt at this feature shipped a threshold nobody had sized, and the run disproved it."
    );
  }
  return value;
};

/**
 * Everything measurable about one point, WITHOUT applying a threshold.
 *
 * Kept separate from the refusal so the harness can compute once and
 * then sweep candidate thresholds over the same data — which is what
 * makes an operating characteristic possible at all. Mixing the two
 * would mean re-calling the provider for every candidate value.
 */
export function measurePoint({ point = {}, essay = "", criteria = "" } = {}) {
  const quote = typeof point.quote === "string" ? point.quote : "";
  const note = typeof point.note === "string" ? point.note : "";
  const deficiency = typeof point.deficiency === "string" ? point.deficiency : "";

  const essayWords = normaliseWords(essay);
  const quoteWords = normaliseWords(quote);
  const essayJoined = essayWords.join(" ");

  const verbatim = quoteWords.length > 0 && essayJoined.includes(quoteWords.join(" "));

  /* Where in the essay the quote sits, 0 at the start and 1 at the
     end. A model that quotes the opening sentence every time is
     satisfying the rule without locating anything, and a spread of
     positions is what tells that apart from real locating. */
  let position = null;
  if (verbatim) {
    const at = essayJoined.indexOf(quoteWords.join(" "));
    position = essayJoined.length > 0 ? at / essayJoined.length : 0;
  }

  /* Quoted material INSIDE the note that is not from the essay is
     offered wording — the ghostwriter's natural hiding place once the
     quote field is locked down. Checked with the same detector, which
     now sees every form a model marks a quotation with. */
  const sourceWords = normaliseWords(`${essay}\n${criteria}`);
  const offered = [];
  for (const span of quotedSpans(note)) {
    const w = normaliseWords(span);
    if (w.length < 3) continue;
    if (!gramSet(sourceWords, w.length).has(w.join(" "))) offered.push(w.length);
  }

  /* HOW MANY TIMES the quote occurs in the essay. A quote that occurs
     once locates one place; one that occurs twice locates nothing in
     particular. This is what "the shortest quote that still locates
     uniquely" is read from. Counted over the normalised essay, the same
     text the verbatim check reads. */
  let quoteOccurrences = 0;
  if (verbatim) {
    const needle = ` ${quoteWords.join(" ")} `;
    const hay = ` ${essayJoined} `;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) quoteOccurrences += 1;
  }

  /* THE LONGEST RUN OF NEW PROSE in the note, at each candidate match
     unit: the number `window` is read from. A note is the model's own
     analysis, so it always has SOME new prose; the question is how long
     a run legitimate feedback needs, which only the constrained arm's
     distribution can say. Numbers only, never the text. */
  const noteNovel = Object.fromEntries(
    MATCH_UNITS.map((k) => [k, longestNovelRun(note, `${essay}\n${criteria}`, { matchUnit: k })])
  );

  return {
    quoteWords: quoteWords.length,
    quoteVerbatim: verbatim,
    quoteOccurrences,
    noteNovel,
    quotePosition: position,
    quoteNormalised: quoteWords.join(" "),
    noteWords: normaliseWords(note).length,
    deficiency,
    deficiencyKnown: DEFICIENCIES.includes(deficiency),
    offeredSpans: offered,
  };
}

/**
 * Whether a measured point is refused, at these thresholds.
 *
 * THE CODES ARE DISTINCT because they mean different things to a
 * student and to whoever is reading a log. `quote-not-found` is the
 * sharp one: it asserts the student wrote something they did not.
 */
export function refusePoint(m, { minQuoteWords, maxNoteWords } = {}) {
  required("minQuoteWords", minQuoteWords);
  required("maxNoteWords", maxNoteWords);
  const reasons = [];
  if (!m.quoteVerbatim) reasons.push("quote-not-found");
  else if (m.quoteWords < minQuoteWords) reasons.push("quote-too-short");
  if (!m.deficiencyKnown) reasons.push("deficiency-unknown");
  if (m.noteWords > maxNoteWords) reasons.push("note-too-long");
  if (m.offeredSpans.length > 0) reasons.push("wording-offered");
  return { ok: reasons.length === 0, reasons };
}

/**
 * How varied an essay's quotes are.
 *
 * A model quoting the same opening sentence for every point passes
 * "there is a verbatim quote" and locates nothing. This is the number
 * that tells the two apart, and it is REPORTED rather than enforced:
 * a legitimately repeated quote (two different problems in one
 * sentence) is not a violation, so refusing on it would be wrong.
 */
export function quoteVariety(measured = []) {
  const withQuotes = measured.filter((m) => m.quoteVerbatim);
  if (withQuotes.length === 0) return { distinct: 0, total: 0, ratio: null, spread: null };
  const distinct = new Set(withQuotes.map((m) => m.quoteNormalised)).size;
  const positions = withQuotes.map((m) => m.quotePosition).filter((p) => p !== null);
  const spread = positions.length > 1 ? Math.max(...positions) - Math.min(...positions) : 0;
  return { distinct, total: withQuotes.length, ratio: distinct / withQuotes.length, spread };
}
