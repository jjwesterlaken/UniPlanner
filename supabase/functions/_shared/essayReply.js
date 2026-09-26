/* essayReply.js — what the endpoint does to the model's reply before a
   student sees any of it.

   Every rule here was a finding of the Gate A reads, and each was moved
   out of the prompt because the prompt did not hold it:

     - a copied span that is not in the essay is text the model WROTE,
       in a field the student would read as their own words;
     - the thesis coded unsupported while the model's own support list
       was not empty (7 times in one 18-essay read, under a prompt rule
       saying not to);
     - the band picked by best-fit rating, in code, never by the model's
       own naming;
     - a band the criteria do not name is a scale we invented (§4).

   PLAIN JS, imports only its siblings in _shared, so the Edge Function
   runs it and the Node tests import it unmodified.

   TWO OUTCOMES THAT ARE NOT SUCCESS, and they bill differently in the
   handler, which is why they are told apart here:
     - a reply that is not the schema's shape throws a plain Error, and
       is `ai_failed_charged`;
     - a reply that HANDS THE STUDENT WRITING throws with
       `essayRefusal: "writing"`. It is billed too, because the tokens
       were generated, but under its own code, because what happened is
       a different fact (ESSAY-FEEDBACK.md §3).

   WHAT IS DROPPED RATHER THAN REFUSED, and why the line is there. A
   point whose quote is not in the essay, or is too short to locate
   anything, or whose code does not fit the genre, is removed and
   counted: the rest of the reply is still true, and refusing a whole
   paid reply over one paraphrased quote takes the money and returns
   nothing. A NOTE or the opening sentence that offers wording, or runs
   past its length, is a refusal of the whole reply: that is the
   ghostwriting signal itself, and a reply containing it is the product
   this feature must not be. */

import {
  GENRES,
  codesFor,
  severityOf,
  orderBySeverity,
  applyThesisRule,
  bestFit,
  BAND_RATING_MIN,
  BAND_RATING_MAX,
  predictionFraming,
} from "./essaySchema.js";
import { checkNoWriting, normaliseWords, quotedSpans, gramSet } from "./noWriting.js";

const phrase = (t) => ` ${normaliseWords(t).join(" ")} `;
/** Is `span` a verbatim run of `text`, after the quote normalisation? */
export const inText = (span, text) => {
  const s = phrase(span);
  return s.trim().length > 0 && phrase(text).includes(s);
};

const REQUIRED = ["window", "matchUnit", "minQuoteWords", "maxNoteWords", "maxSentenceWords"];

/**
 * @param {{ raw: string, essay: string, criteria: string,
 *           thresholds: { window: number, matchUnit: number, minQuoteWords: number, maxNoteWords: number, maxSentenceWords: number } }} args
 */
export function finishEssayReply({ raw, essay, criteria, thresholds }) {
  /* NO THRESHOLDS, NO ANSWER. They have no defaults anywhere in this
     codebase on purpose (noWriting.js says why), and the handler refuses
     the task before any spend while they are unset. Reaching here
     without them is a bug, and it fails rather than guessing. */
  for (const k of REQUIRED) {
    if (!thresholds || !Number.isInteger(thresholds[k]) || thresholds[k] < 1) {
      throw new Error(`essay: no-writing threshold ${k} is not set`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("essay: response was not JSON");
  }
  const r = parsed && parsed.reading;
  const o = parsed && parsed.overall;
  if (!r || !GENRES.includes(r.genre) || !Array.isArray(r.points) || !Array.isArray(r.support) || typeof r.mainIdea !== "string") {
    throw new Error("essay: no usable reading");
  }
  if (!o || !Array.isArray(o.bandsConsidered) || typeof o.band !== "string" || typeof o.sentence !== "string") {
    throw new Error("essay: no usable overall reading");
  }

  /* 1. SPANS THE MODEL SAYS IT COPIED, kept only if they are copies. A
     made-up support span would otherwise shield a real point from
     nothing and let the thesis rule drop it. These are scaffolding and
     are NOT returned to the client, so an invented one can never reach
     a student as "your words". */
  const mainIdea = r.mainIdea && inText(r.mainIdea, essay) ? r.mainIdea : "";
  const support = r.support.filter((s) => typeof s === "string" && inText(s, essay));

  /* 2. POINTS THAT DO NOT LOCATE ANYTHING, dropped and counted. */
  const allowed = codesFor(r.genre);
  const dropped = { quoteNotFound: 0, quoteTooShort: 0, offGenre: 0, thesis: 0, fabricatedSpans: 0 };
  dropped.fabricatedSpans = (r.mainIdea && !mainIdea ? 1 : 0) + (r.support.length - support.length);
  const located = [];
  for (const p of r.points) {
    const quote = typeof p?.quote === "string" ? p.quote : "";
    const note = typeof p?.note === "string" ? p.note : "";
    if (!allowed.includes(p?.deficiency)) {
      dropped.offGenre += 1;
      continue;
    }
    if (!inText(quote, essay)) {
      dropped.quoteNotFound += 1;
      continue;
    }
    if (normaliseWords(quote).length < thresholds.minQuoteWords) {
      dropped.quoteTooShort += 1;
      continue;
    }
    located.push({ quote, deficiency: p.deficiency, note });
  }

  /* 3. THE THESIS RULE, over the VERIFIED support only. */
  const { kept, dropped: thesis } = applyThesisRule({ mainIdea, support, points: located });
  dropped.thesis = thesis.length;

  /* 4. NO WRITING. Any violation refuses the reply.
     THE WINDOW APPLIES TO NOTES ONLY. The opening sentence is the
     model's own summary of the essay, so it is new prose by
     construction: on Luna its longest novel run was 29-42 words (p50
     33) at match unit 4, and a 25-word window over it refused 65% of
     the constrained arm's replies. It gets its length cap and nothing
     else. */
  const violations = [];
  for (const [i, p] of kept.entries()) {
    if (normaliseWords(p.note).length > thresholds.maxNoteWords) violations.push({ kind: "note-too-long", index: i });
    /* Quoted material inside a note that is not from the essay or the
       criteria is offered wording, the ghostwriter's hiding place once
       the quote field is locked down. */
    const source = normaliseWords(`${essay}\n${criteria}`);
    for (const span of quotedSpans(p.note)) {
      const w = normaliseWords(span);
      if (w.length >= 3 && !gramSet(source, w.length).has(w.join(" "))) violations.push({ kind: "wording-offered", index: i });
    }
  }
  /* The opening sentence has its own length cap: it is one sentence of
     judgement, and a paragraph there is the same signal a long note is. */
  if (normaliseWords(o.sentence).length > thresholds.maxSentenceWords) violations.push({ kind: "sentence-too-long", index: kept.length });
  const prose = checkNoWriting({
    fields: kept.map((p) => p.note),
    essay,
    criteria,
    matchUnit: thresholds.matchUnit,
    window: thresholds.window,
  });
  violations.push(...prose.violations.map((v) => ({ kind: v.kind, index: v.index })));
  if (violations.length) {
    const err = new Error(`essay: the reply offered writing (${[...new Set(violations.map((v) => v.kind))].join(", ")})`);
    err.essayRefusal = "writing";
    err.violations = violations;
    throw err;
  }

  /* 5. THE BAND: best fit over in-range ratings, and only a band the
     criteria themselves name. A label the criteria do not contain is a
     scale we made up, which §4 forbids outright. */
  const rated = o.bandsConsidered.filter(
    (b) => b && typeof b.band === "string" && Number.isInteger(b.rating) && b.rating >= BAND_RATING_MIN && b.rating <= BAND_RATING_MAX
  );
  const fit = bestFit(rated, o.band);
  const band = fit.band && inText(fit.band, criteria) ? fit.band : "";

  /* 6. THE OPENING SENTENCE, never a prediction (§4). Blanked rather
     than refused: nothing in it is the student's writing, and the
     points are still true. */
  const sentence = predictionFraming(o.sentence).length ? "" : o.sentence;

  return {
    genre: r.genre,
    band,
    bandTied: band && fit.tied.length > 1 ? fit.tied : [],
    sentence,
    points: orderBySeverity(kept).map((p) => ({ ...p, severity: severityOf(p.deficiency) })),
    dropped: { ...dropped, sentence: sentence ? 0 : o.sentence ? 1 : 0 },
  };
}
