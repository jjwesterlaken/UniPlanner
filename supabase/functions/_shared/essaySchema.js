/* essaySchema.js — the deficiency vocabulary, its severity, and the
 * strict response schema, in ONE place.
 *
 * PLAIN JS, NO IMPORTS, NO DENO, NO BROWSER: the `aiProviders.js` and
 * `photoCap.js` arrangement. `_shared/` is deployed with the Edge
 * Functions, so the essay endpoint (step 4) imports this directly;
 * `src/essayPoints.js` re-exports it for the browser and the Node
 * tests; and the measurement harness reads it through that re-export.
 * One list, three readers. A second copy would be the restatement the
 * enum exists to prevent — the day step 4 wrote its own prompt it would
 * put the list back in the prose.
 *
 * ---------------------------------------------------------------
 * WHY A SCHEMA AT ALL, which is the finding that made this file.
 *
 * The first version of the essay prompt described the output in
 * PROSE — `"deficiency": string`, followed by "EXACTLY ONE of: ..." —
 * and called the provider with `response_format: { type:
 * "json_object" }`. JSON mode guarantees well-formed JSON and enforces
 * NO SCHEMA. So the allowed codes were a request, not a constraint,
 * and the model paraphrased: 84 of 318 constrained points on 24
 * September came back with a code outside the list, and Jared's read
 * found "spelling/grammar", "style" and "conventions" in the output.
 *
 * A prompt says what was asked for. Only a schema the decoder enforces
 * says what can come back. That is the readback rule — a readback
 * measures what was ACCEPTED — arriving as a response format.
 *
 * `ai-notes` already sends a strict `json_schema` in production, so
 * this is not new territory; `ai-text` sends `json_object` on purpose,
 * because its four tasks have four shapes validated on the way back.
 * The essay task has a reason the other four do not: an enum that must
 * hold. Step 4 therefore adds a per-task schema to that adapter.
 * --------------------------------------------------------------- */

/* The closed set. Deliberately about the WRITING rather than about the
   subject: nothing here requires knowing whether a claim is true, which
   is a thing this feature does not do and must not appear to do.

   `off-criterion` exists so a model with nothing to say against a
   criterion has somewhere honest to put that, rather than inventing a
   deficiency to fill the schema.

   `conventions` (spelling, grammar, punctuation) was added on 25
   September 2026, Jared's ruling. Once the schema enforced the enum,
   mechanics points had nowhere to go and were being forced into the
   nearest wrong code. The 24 September read had found "spelling/
   grammar" and "conventions" in the output before the schema existed,
   so the demand was measured, not guessed. */
export const DEFICIENCIES = Object.freeze([
  "claim-without-evidence",
  "evidence-without-claim",
  "undefined-term",
  "unclear-relevance",
  "unsupported-generalisation",
  "contradiction",
  "missing-counterargument",
  "unattributed-source",
  "repetition",
  "structure-unsignposted",
  "conventions",
  "off-criterion",
]);

/* WHAT EACH CODE MEANS, one line each, and the prompt is built from
   these. The prompt used to list the codes and define none, so the
   rules it did spell out (all about argument) became the de-facto
   definition of "a problem", and on the second calibration read minor
   codes vanished from the high band altogether (0 minor points across
   four strong essays). A code with no definition is a code the model
   has to guess at. A test asserts every code has one. */
export const CODE_DEFINITIONS = Object.freeze({
  "claim-without-evidence": "a claim that nothing anywhere in the essay supports, by the criteria's own idea of support",
  "evidence-without-claim": "evidence, an example or a quotation that is not tied to any point the essay makes",
  "undefined-term": "a key term the reader needs explained that the essay never explains",
  "unclear-relevance": "a passage whose bearing on the essay's main idea or the task is not made clear",
  "unsupported-generalisation": "a sweeping statement (all, always, everyone) that goes further than the essay's support",
  contradiction: "two parts of the essay that say incompatible things",
  "missing-counterargument": "an obvious objection the criteria expect the essay to address, left unaddressed",
  "unattributed-source": "a fact, figure or idea taken from somewhere else with no indication of where",
  repetition: "the same point, phrase or word repeated without adding anything",
  "structure-unsignposted": "a move between ideas or paragraphs the reader is not guided through",
  conventions: "spelling, grammar, punctuation or sentence construction that gets in the way of the reader",
  "off-criterion": "a criterion the essay does not engage with at all",
});

/* ---------------------------------------------------------------
 * SEVERITY — a FIXED MAP OF OURS, never assigned by the model.
 *
 * If the model rated its own points, the thing being evaluated would
 * be grading itself, and "the score-5 essay's points were all minor"
 * would be a claim the model made about its own output. A map from
 * code to severity is written once, reviewed, and applied the same way
 * to every point — so the severity mix is a property of the codes the
 * model chose, which is a fact, rather than of a label it attached,
 * which is an opinion.
 *
 * APPROVED, Jared, 24 September 2026: the split as proposed, with
 * `missing-counterargument` and `unattributed-source` under
 * fundamental.
 *
 * THE TWO CODES LEFT OUT OF THAT APPROVAL, ruled 25 September 2026:
 * `evidence-without-claim` is FUNDAMENTAL (evidence that argues
 * nothing is an essay that has not argued), and `off-criterion` is
 * OUTSIDE the count. By its own definition it is not a fault, only
 * the model saying it had nothing against a criterion, so counting it
 * in either column would move the severity mix with a point that
 * found nothing. `conventions` is MINOR.
 *
 * `outside` is its own level rather than a missing entry, so the map
 * stays TOTAL over the closed set (a test pins that) and "not
 * counted" is a decision that can be read, not an absence.
 * --------------------------------------------------------------- */
export const SEVERITY = Object.freeze({
  "claim-without-evidence": "fundamental",
  "evidence-without-claim": "fundamental",
  "unsupported-generalisation": "fundamental",
  contradiction: "fundamental",
  "unclear-relevance": "fundamental",
  "missing-counterargument": "fundamental",
  "unattributed-source": "fundamental",
  repetition: "minor",
  "structure-unsignposted": "minor",
  "undefined-term": "minor",
  conventions: "minor",
  "off-criterion": "outside",
});

/* In display order. `orderBySeverity` sorts by this list, so the order
   the student reads is ours rather than the model's. */
export const SEVERITY_LEVELS = Object.freeze(["fundamental", "minor", "outside"]);

/** A code's severity, or `unknown` for a code outside the closed set. */
export const severityOf = (code) => (Object.prototype.hasOwnProperty.call(SEVERITY, code) ? SEVERITY[code] : "unknown");

/**
 * The points, fundamental first, then minor, then outside the count,
 * then anything with an unknown code. STABLE: inside a level the
 * model's own order is kept, because that order usually follows the
 * essay and re-sorting within a level would scramble it for nothing.
 * A new array; the input is not touched.
 */
export function orderBySeverity(points = []) {
  const rank = (p) => {
    const i = SEVERITY_LEVELS.indexOf(severityOf(p && p.deficiency));
    return i < 0 ? SEVERITY_LEVELS.length : i;
  };
  return points.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/* ---------------------------------------------------------------
 * GENRE — READ FROM THE CRITERIA, and it decides which codes apply.
 *
 * The 24 September read found `claim-without-evidence` on the closing
 * line of a STORY (ASAP set 7), counted as fundamental. The prompt
 * never said an essay has a genre, so every essay was read as an
 * argument. The model now states the genre the CRITERIA describe (not
 * one it guesses from the essay, because the criteria are what the
 * student is marked against), and is told which codes fit it.
 *
 * `APPLIES_TO` is the map from code to genre. It is OURS, like the
 * severity map, and the read counts every point whose code does not
 * fit the genre the model itself declared. So a violation is measured
 * against the model's own statement and needs no judgement to count.
 * `other` accepts every code: when the criteria do not say, nothing
 * can be ruled out.
 *
 * RULED, Jared, 25 September 2026: approved as proposed. A narrative
 * may not be given claim-without-evidence, evidence-without-claim,
 * unsupported-generalisation, missing-counterargument or
 * unattributed-source, and an informative piece may not be given
 * missing-counterargument. A test pins the narrative half.
 * --------------------------------------------------------------- */
export const GENRES = Object.freeze(["argument", "informative", "narrative", "other"]);

const ALL = Object.freeze([...GENRES]);
const EXPOSITORY = Object.freeze(["argument", "informative", "other"]);
export const APPLIES_TO = Object.freeze({
  "claim-without-evidence": EXPOSITORY,
  "evidence-without-claim": EXPOSITORY,
  "unsupported-generalisation": EXPOSITORY,
  "unattributed-source": EXPOSITORY,
  "missing-counterargument": Object.freeze(["argument", "other"]),
  "undefined-term": ALL,
  "unclear-relevance": ALL,
  contradiction: ALL,
  repetition: ALL,
  "structure-unsignposted": ALL,
  conventions: ALL,
  "off-criterion": ALL,
});

/** Does this code fit this genre? An unknown code or genre fits nothing. */
export const fitsGenre = (code, genre) =>
  Object.prototype.hasOwnProperty.call(APPLIES_TO, code) && APPLIES_TO[code].includes(genre);

/** The codes a genre allows, in the closed set's order. For the prompt. */
export const codesFor = (genre) => DEFICIENCIES.filter((c) => fitsGenre(c, genre));

/* ---------------------------------------------------------------
 * THE OPENING SENTENCE, and §4 of ESSAY-FEEDBACK.md is its contract.
 *
 * A near-incoherent essay came back with one polite comment, and
 * nothing on the page said the comment was the least of its problems.
 * So the output opens with an overall reading: a band IN THE
 * CRITERIA'S OWN TERMS, or none if the criteria define none, and one
 * sentence saying whether the essay broadly meets them and naming the
 * most serious problem.
 *
 * Never a prediction. The sentence is checked against the §4 ban
 * below, and the read prints how many sentences tripped it. The band
 * is a reading ("reads like"), and the screen that shows it must
 * carry §4's disclaimer beside it. That is step 5's job and a mount
 * test's, not this file's.
 * --------------------------------------------------------------- */
export const PREDICTION_PATTERNS = Object.freeze([
  /you'?ll get/i,
  /your mark will/i,
  /predicted (mark|grade)/i,
  /guarantee/i,
  /what you'?ll score/i,
]);

/** The §4 patterns a piece of text trips, as their sources. Empty is clean. */
export const predictionFraming = (text = "") =>
  PREDICTION_PATTERNS.filter((re) => re.test(String(text))).map((re) => re.source);

/* ---------------------------------------------------------------
 * THE THESIS RULE, ENFORCED IN CODE, because the prose rule did not
 * hold: three of twelve essays on the second read still had their main
 * idea coded `claim-without-evidence` or `unsupported-generalisation`
 * while the model's OWN support list was not empty. A thesis is
 * supported by the essay that follows it, so such a point is removed
 * after the reply arrives, and the removal is returned rather than
 * hidden, so the read can count it and step 4 can log it.
 *
 * "On the main idea" means the point's quote and the main idea contain
 * one another once normalised: narrow on purpose, so only a point that
 * is really about the thesis sentence is removed.
 *
 * `wordsForMatch` MIRRORS `normaliseWords` in src/noWriting.js. This
 * file is deployed with the Edge Functions and cannot import from
 * src/, so the mirror is allowed and a test asserts the two agree on a
 * battery, the equality-as-guard rule.
 * --------------------------------------------------------------- */
export function wordsForMatch(text) {
  return String(text || "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9'\-\s]/g, " ")
    .replace(/(^|\s)[-']+|[-']+(?=\s|$)/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
}

const phrase = (text) => wordsForMatch(text).join(" ");
const UNSUPPORTED_CODES = Object.freeze(["claim-without-evidence", "unsupported-generalisation"]);

/** Is this point a "not supported" point about the main idea itself? */
export function onMainIdea(point, mainIdea) {
  const q = phrase(point && point.quote);
  const m = phrase(mainIdea);
  return q.length > 0 && m.length > 0 && (m.includes(q) || q.includes(m));
}

/**
 * Remove every unsupported-claim point on the main idea when the
 * support list is not empty. Returns both halves; never mutates.
 */
export function applyThesisRule({ mainIdea = "", support = [], points = [] }) {
  if (!Array.isArray(support) || support.length === 0) return { kept: [...points], dropped: [] };
  const kept = [];
  const dropped = [];
  for (const p of points) {
    (UNSUPPORTED_CODES.includes(p && p.deficiency) && onMainIdea(p, mainIdea) ? dropped : kept).push(p);
  }
  return { kept, dropped };
}

/* BEST FIT, NOT A THRESHOLD. Two rounds of threshold wording failed at
   the top. "Fits" read every strong essay one band low, and "meets"
   engaged on 3 of 18 essays, because the model read "meets" as
   "flawless" and so marked almost nothing met. So each band's
   descriptor is RATED for how well it describes the essay, and the
   band is the one it describes best: resemblance, not a pass mark.
   The pick is made HERE, in code, from the model's ratings. The model
   still names a band, and the read counts when the two differ.

   The range is not enforced by the schema (strict mode's numeric
   bounds are not relied on here), so a rating outside it is counted
   by the read rather than trusted. */
export const BAND_RATING_MIN = 1;
export const BAND_RATING_MAX = 10;

/**
 * The best-fitting band from a lowest-first list of rated bands.
 * TIES are returned, not broken silently: `tied` lists every band that
 * shares the top rating. The pick among a tie is the model's own named
 * band when it is one of them (its tie-break, not ours), otherwise the
 * middle of the tie, which leans neither up nor down.
 * @returns {{ band: string, rating: number|null, tied: string[] }}
 */
export function bestFit(bandsConsidered = [], named = "") {
  const rated = bandsConsidered.filter((b) => b && Number.isFinite(b.rating));
  if (!rated.length) return { band: "", rating: null, tied: [] };
  const top = Math.max(...rated.map((b) => b.rating));
  const tied = rated.filter((b) => b.rating === top).map((b) => b.band);
  const band = tied.includes(named) ? named : tied[Math.floor((tied.length - 1) / 2)];
  return { band, rating: top, tied };
}

/* ---------------------------------------------------------------
 * THE STRICT SCHEMA.
 *
 * OpenAI's strict mode requires every property to be REQUIRED and
 * `additionalProperties: false` on every object, and does not support
 * `minItems` (CLAUDE.md records that one). `enum` and a NESTED `anyOf`
 * are supported; the root may not itself be an `anyOf`, which is why
 * the per-genre branches sit under `reading`.
 *
 * THE GENRE EXCLUSION IS IN THE SCHEMA, NOT THE PROSE. `reading` is one
 * branch per genre, and each branch's deficiency enum is `codesFor`
 * that genre. Once the model writes `"genre": "narrative"`, only the
 * narrative branch still matches, so the decoder cannot produce
 * `unsupported-generalisation` after it. The 25 September read found
 * exactly two off-genre points, both that code on a set-8 story, with
 * the exclusion stated only in the prompt. This is the enum lesson
 * again: a prompt says what was asked for, and only the schema says
 * what can come back.
 *
 * PROPERTY ORDER IS GENERATION ORDER, and every step here is placed on
 * purpose:
 *   1. genre, because it decides which codes exist;
 *   2. mainIdea and support, VERBATIM spans, so the model has found the
 *      argument before it judges any sentence of it. The same read
 *      coded an 11/12 essay's THESIS `claim-without-evidence` when the
 *      whole essay was its evidence: sentence-level reading of an
 *      argument-level property;
 *   3. the points;
 *   4. bandsConsidered, EVERY band the criteria define, lowest first,
 *      each RATED for how well its descriptor describes the essay,
 *      before the one band is named. The best fit is picked in code. The read's
 *      opening reading said "Score Point 2" for 10 of 12 essays,
 *      including three the human raters scored 9, 10 and 11 of 12;
 *   5. band and sentence, last, summarising what came before.
 *
 * mainIdea and support are free text the model writes, so they carry
 * the no-writing risk a note does. They must be VERBATIM, and the read
 * counts every span that is not; the endpoint (step 4) must refuse
 * them on the same verbatim check as a quote.
 * --------------------------------------------------------------- */
const closed = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const readingFor = (genre) =>
  closed({
    genre: { type: "string", enum: [genre] },
    mainIdea: { type: "string" },
    support: { type: "array", items: { type: "string" } },
    points: {
      type: "array",
      items: closed({
        quote: { type: "string" },
        deficiency: { type: "string", enum: codesFor(genre) },
        note: { type: "string" },
      }),
    },
  });

export function essayFeedbackSchema() {
  return {
    name: "essay_feedback",
    strict: true,
    schema: closed({
      reading: { anyOf: GENRES.map(readingFor) },
      overall: closed({
        /* STRICT MODE CANNOT REQUIRE A LENGTH (no minItems), so
           "one entry per band" is made checkable instead: the model
           states how many bands the criteria define BEFORE listing them,
           and each entry quotes its descriptor from the criteria. The
           read counts lists shorter than the stated count, lists shorter
           than a set's known count, and descriptors not found in the
           criteria. */
        bandCount: { type: "integer" },
        bandsConsidered: {
          type: "array",
          items: closed({
            band: { type: "string" },
            descriptor: { type: "string" },
            rating: { type: "integer" },
          }),
        },
        band: { type: "string" },
        sentence: { type: "string" },
      }),
    }),
  };
}
