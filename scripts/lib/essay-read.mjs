/* What one essay's feedback MEASURES, as a pure function of the model's
   reply. Extracted from read-asap.mjs so every number on the sheet can
   be tested against a hand-built reply, with no corpus, no key and no
   network. Anything printed here as a count is computed the same way
   for every essay, so nobody reading the sheet has to count by hand
   or can miscount.

   THE CHECKS ARE MADE AGAINST THE MODEL'S OWN STATEMENT where there is
   one. "This code does not fit the genre" is measured against the
   genre the model itself said the criteria describe, so a violation is
   the model contradicting itself and needs no judgement to count. The
   genre it said is then compared, separately, against what the ASAP
   set really asks for. Those are two different failures, and they are
   kept as two numbers. */

import { SEVERITY_LEVELS, severityOf, orderBySeverity, fitsGenre, GENRES, predictionFraming } from "../../src/essayPoints.js";
import { SET_GENRES } from "./asap-corpus.mjs";

/**
 * @param {{ content: string, set: number }} args  the raw message content and the ASAP set
 * @returns {{ failure: string|null, genre?: string, expectedGenre?: string|null, genreMatches?: boolean|null,
 *            overall?: {band:string, sentence:string}, ordered?: object[], count: number,
 *            sev: Record<string, number>, offGenre: object[], predictionHits: string[] }}
 */
export function measureReply({ content, set }) {
  const empty = () => ({ ...Object.fromEntries(SEVERITY_LEVELS.map((l) => [l, 0])), unknown: 0 });
  const nothing = (failure) => ({ failure, count: 0, sev: empty(), offGenre: [], predictionHits: [] });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return nothing(`the output did not parse (${e.message})`);
  }
  /* EVERY FIELD THE SCHEMA REQUIRES, checked, not assumed. A reply that
     parses but is missing the overall reading is not a reply this sheet
     can put its opening line on, and saying so beats rendering a blank. */
  if (!parsed || !Array.isArray(parsed.points)) return nothing("no points array");
  if (!GENRES.includes(parsed.genre)) return nothing(`no recognised genre (${JSON.stringify(parsed.genre)})`);
  const o = parsed.overall;
  if (!o || typeof o.band !== "string" || typeof o.sentence !== "string") return nothing("no overall reading");

  const points = parsed.points;
  const sev = empty();
  for (const p of points) sev[severityOf(p && p.deficiency)] += 1;

  const expectedGenre = Object.prototype.hasOwnProperty.call(SET_GENRES, set) ? SET_GENRES[set] : null;
  return {
    failure: null,
    genre: parsed.genre,
    expectedGenre,
    /* null, not false, when the set's genre is not on record: "we do
       not know" must not read as "it got it wrong". */
    genreMatches: expectedGenre === null ? null : parsed.genre === expectedGenre,
    overall: { band: o.band, sentence: o.sentence },
    ordered: orderBySeverity(points),
    count: points.length,
    sev,
    /* A code outside the closed set is already counted as `unknown`;
       it is not ALSO counted here, so one fault is one number. */
    offGenre: points.filter((p) => severityOf(p && p.deficiency) !== "unknown" && !fitsGenre(p.deficiency, parsed.genre)),
    predictionHits: predictionFraming(o.sentence),
  };
}
