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
   deficiency to fill the schema. */
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
 * TWO CODES WERE NOT IN THE PROPOSAL AND ARE NOT DECIDED HERE:
 * `evidence-without-claim` and `off-criterion`. They are `unrated`
 * rather than quietly assigned, because "approved as proposed" covered
 * nine codes and a tenth and eleventh slipped into the approval would
 * be a decision nobody made. The read prints `unrated` as its own
 * column, so nothing is folded in where it would move a finding.
 * The recommendation, for the ruling: `evidence-without-claim` is
 * fundamental (evidence that argues nothing is an essay that has not
 * argued), and `off-criterion` is not a fault at all by its own
 * definition, so it belongs outside the count rather than in either
 * column.
 * --------------------------------------------------------------- */
export const SEVERITY = Object.freeze({
  "claim-without-evidence": "fundamental",
  "unsupported-generalisation": "fundamental",
  contradiction: "fundamental",
  "unclear-relevance": "fundamental",
  "missing-counterargument": "fundamental",
  "unattributed-source": "fundamental",
  repetition: "minor",
  "structure-unsignposted": "minor",
  "undefined-term": "minor",
  "evidence-without-claim": "unrated",
  "off-criterion": "unrated",
});

export const SEVERITY_LEVELS = Object.freeze(["fundamental", "minor", "unrated"]);

/** A code's severity, or `unknown` for a code outside the closed set. */
export const severityOf = (code) => (Object.prototype.hasOwnProperty.call(SEVERITY, code) ? SEVERITY[code] : "unknown");

/* ---------------------------------------------------------------
 * THE STRICT SCHEMA.
 *
 * OpenAI's strict mode requires every property to be REQUIRED and
 * `additionalProperties: false` on every object, and does not support
 * `minItems` (CLAUDE.md records that one). `enum` IS supported, which
 * is the whole point. The enum is `DEFICIENCIES` BY REFERENCE, so it
 * cannot drift from the list above.
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
      },
      required: ["points"],
      additionalProperties: false,
    },
  };
}
