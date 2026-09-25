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
   kept as two numbers. The same holds for the band: where the model's
   chosen band sits is read off the model's OWN list of the rubric's
   bands, so no scale is assumed here. */

import { SEVERITY_LEVELS, severityOf, orderBySeverity, fitsGenre, GENRES, predictionFraming } from "../../src/essayPoints.js";
import { normaliseWords } from "../../src/noWriting.js";
import { SET_GENRES, bandOf } from "./asap-corpus.mjs";

const joined = (text) => ` ${normaliseWords(text).join(" ")} `;

/** Is `span` a verbatim run of `essay`, after the same normalisation a quote gets? */
export const isVerbatim = (span, essay) => {
  const s = joined(span);
  return s.trim().length > 0 && joined(essay).includes(s);
};

const firstNumber = (text) => {
  const m = String(text).match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const sameLabel = (a, b) => String(a).toLowerCase().replace(/\s+/g, " ").trim() === String(b).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Where the chosen band sits in the model's own list of the rubric's
 * bands, as a position from 0 (lowest) to 1 (highest), and the third
 * that puts it in. null when it cannot be placed: fewer than two bands
 * listed, or a chosen band that is not in the list by name or number.
 *
 * "Lowest first" is what the prompt asks for. When every label carries
 * a number, the numbers decide the direction instead, so a list the
 * model wrote highest-first is not read upside down.
 */
export function placeBand({ band, bandsConsidered }) {
  const list = (bandsConsidered || []).map((b) => (b && b.band) || "");
  if (!band || list.length < 2) return null;
  let i = list.findIndex((b) => sameLabel(b, band));
  const want = firstNumber(band);
  if (i < 0 && want !== null) i = list.findIndex((b) => firstNumber(b) === want);
  if (i < 0) return null;
  let position = i / (list.length - 1);
  const nums = list.map(firstNumber);
  if (nums.every((n) => n !== null) && nums[0] > nums[nums.length - 1]) position = 1 - position;
  return { index: i, of: list.length, position, band: bandOf(position) };
}

/* A point on the main idea itself: its quote and the main idea contain
   one another once normalised. Loose on purpose, since the quote is
   usually a clause of the thesis sentence. */
const onMainIdea = (quote, mainIdea) => {
  const q = joined(quote).trim();
  const m = joined(mainIdea).trim();
  return q.length > 0 && m.length > 0 && (m.includes(q) || q.includes(m));
};
const UNSUPPORTED = new Set(["claim-without-evidence", "unsupported-generalisation"]);

/**
 * @param {{ content: string, set: number, essay?: string, humanBand?: string }} args
 */
export function measureReply({ content, set, essay = "", humanBand = null }) {
  const empty = () => ({ ...Object.fromEntries(SEVERITY_LEVELS.map((l) => [l, 0])), unknown: 0 });
  const nothing = (failure) => ({
    failure,
    count: 0,
    counted: 0,
    sev: empty(),
    offGenre: [],
    predictionHits: [],
    notVerbatim: [],
    thesisFlagged: [],
    placed: null,
    agrees: null,
  });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return nothing(`the output did not parse (${e.message})`);
  }
  /* EVERY FIELD THE SCHEMA REQUIRES, checked, not assumed. A reply that
     parses but is missing the overall reading is not a reply this sheet
     can put its opening line on, and saying so beats rendering a blank. */
  const r = parsed && parsed.reading;
  if (!r || !Array.isArray(r.points)) return nothing("no reading.points array");
  if (!GENRES.includes(r.genre)) return nothing(`no recognised genre (${JSON.stringify(r.genre)})`);
  if (typeof r.mainIdea !== "string" || !Array.isArray(r.support)) return nothing("no mainIdea or support");
  const o = parsed.overall;
  if (!o || typeof o.band !== "string" || typeof o.sentence !== "string" || !Array.isArray(o.bandsConsidered)) {
    return nothing("no overall reading");
  }

  const points = r.points;
  const sev = empty();
  for (const p of points) sev[severityOf(p && p.deficiency)] += 1;

  const expectedGenre = Object.prototype.hasOwnProperty.call(SET_GENRES, set) ? SET_GENRES[set] : null;
  /* Spans the model says it COPIED. Any that are not in the essay are
     text the model wrote, in a field the student would read as their
     own words, which is the no-writing risk in a new field. */
  const spans = [...(r.mainIdea ? [r.mainIdea] : []), ...r.support];
  const placed = placeBand({ band: o.band, bandsConsidered: o.bandsConsidered });

  return {
    failure: null,
    genre: r.genre,
    expectedGenre,
    /* null, not false, when the set's genre is not on record: "we do
       not know" must not read as "it got it wrong". */
    genreMatches: expectedGenre === null ? null : r.genre === expectedGenre,
    mainIdea: r.mainIdea,
    support: r.support,
    notVerbatim: essay ? spans.filter((x) => !isVerbatim(x, essay)) : [],
    /* The 11/12 essay's defect, counted: the main idea coded as
       unsupported while the model's own support list is not empty. */
    thesisFlagged:
      r.support.length > 0 ? points.filter((p) => UNSUPPORTED.has(p && p.deficiency) && onMainIdea(p.quote, r.mainIdea)) : [],
    overall: { band: o.band, sentence: o.sentence, bandsConsidered: o.bandsConsidered },
    placed,
    agrees: placed && humanBand ? placed.band === humanBand : null,
    ordered: orderBySeverity(points),
    count: points.length,
    /* What a student would read as faults: everything but `outside`. */
    counted: points.filter((p) => severityOf(p && p.deficiency) !== "outside").length,
    sev,
    /* A code outside the closed set is already counted as `unknown`;
       it is not ALSO counted here, so one fault is one number. */
    offGenre: points.filter((p) => severityOf(p && p.deficiency) !== "unknown" && !fitsGenre(p.deficiency, r.genre)),
    predictionHits: predictionFraming(o.sentence),
  };
}
