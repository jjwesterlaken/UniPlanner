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
 * PROPOSED, NOT YET RULED: which codes are argument-only is a
 * judgement, and this is the first draft of it.
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
 * THE STRICT SCHEMA.
 *
 * OpenAI's strict mode requires every property to be REQUIRED and
 * `additionalProperties: false` on every object, and does not support
 * `minItems` (CLAUDE.md records that one). `enum` IS supported, which
 * is the whole point. The enums are `DEFICIENCIES` and `GENRES` BY
 * REFERENCE, so they cannot drift from the lists above.
 *
 * PROPERTY ORDER IS GENERATION ORDER, and it is chosen: genre first
 * (everything after depends on it), then the points, then the overall
 * reading. The overall reading is DISPLAYED first and GENERATED last,
 * so the model summarises the points it has actually made rather than
 * committing to a verdict and then finding points to fit it.
 *
 * WHETHER THE PROVIDER HONOURS IT is a question for the output, not
 * for this file: the read prints its `deficiency-unknown` count on
 * every run, and under a schema that is really enforced it is zero by
 * construction. A non-zero there means the schema is not reaching the
 * decoder, whatever this object says.
 * --------------------------------------------------------------- */
export function essayFeedbackSchema() {
  return {
    name: "essay_feedback",
    strict: true,
    schema: {
      type: "object",
      properties: {
        genre: { type: "string", enum: [...GENRES] },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              quote: { type: "string" },
              deficiency: { type: "string", enum: [...DEFICIENCIES] },
              note: { type: "string" },
            },
            required: ["quote", "deficiency", "note"],
            additionalProperties: false,
          },
        },
        overall: {
          type: "object",
          properties: {
            band: { type: "string" },
            sentence: { type: "string" },
          },
          required: ["band", "sentence"],
          additionalProperties: false,
        },
      },
      required: ["genre", "points", "overall"],
      additionalProperties: false,
    },
  };
}
