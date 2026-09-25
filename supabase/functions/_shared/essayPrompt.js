/* essayPrompt.js — THE essay-feedback prompt, as the endpoint sends it.

   ONE PROMPT, TWO READERS. The Gate A reads measured this exact text on
   four models and chose gpt-5.6-luna on it, so the endpoint must send
   what was measured and not a second copy that could drift from it.
   It lives in `_shared/`, deployed with the Edge Functions, and the
   harness (`scripts/lib/essay-arms.mjs`) imports it; a test asserts the
   harness's constrained arm IS this string.

   PLAIN JS, and it imports only `essaySchema.js`, for the reason that
   file gives: Node tests import it directly, and Deno deploys it.

   NOT A ROUTE YET. The route guard in `test-legal.mjs` derives routes
   from `ai-text`'s SYSTEM keys, and this file is not one of them. The
   route appears when the `essay` task is added there, and that is the
   point at which the material-type and consent question has to be
   answered (ESSAY-FEEDBACK.md §1).

   The template takes the NOTE line and the RULES block as arguments
   because the harness's adversarial arm fills the same schema with a
   different note. The adversarial wording itself stays in the harness
   and never ships. */

import { GENRES, codesFor, DEFICIENCIES, CODE_DEFINITIONS, BAND_RATING_MIN, BAND_RATING_MAX } from "./essaySchema.js";

/* THE CODE LIST PER GENRE IS DERIVED from APPLIES_TO, so the prompt
   and the count on the read sheet cannot disagree about which codes a
   genre allows. A list typed here would be the restatement the enum
   exists to prevent. */
const codesByGenre = GENRES.map((g) => `                ${g.padEnd(12)}${codesFor(g).join(", ")}`).join("\n");

/* Every code's meaning, from CODE_DEFINITIONS. Derived for the same
   reason as the per-genre lists: the prompt and the module that
   defines the codes cannot disagree. */
const codeMeanings = DEFICIENCIES.map((c) => `                ${c.padEnd(27)}${CODE_DEFINITIONS[c]}`).join("\n");

const TEMPLATE = `You are reading a university student's own draft essay against the marking criteria they were given.

Return JSON in exactly the order below, and do the work in that order: each step depends on the one before it.

{ "reading": { "genre", "mainIdea", "support", "points": [ { "quote", "deficiency", "note" } ] },
  "overall": { "bandCount", "bandsConsidered": [ { "band", "descriptor", "rating" } ], "band", "sentence" } }

WHAT COUNTS AS SUPPORT is whatever the criteria say counts. If they ask for reasons, examples or
details, then reasons, examples and details ARE support. If they ask for sources or citations, sources
are. A claim that is followed, anywhere in the essay, by a reason or an example bearing on it is
supported by the criteria's standard, even when that reason or example is in a later paragraph.

reading
  genre       The kind of writing THE CRITERIA ask for: one of ${GENRES.join(", ")}. Take it from the
              criteria, not from the essay. Use "other" only if the criteria do not say. The genre
              decides which deficiency codes are available:
${codesByGenre}
  mainIdea    The essay's main claim (an argument or informative piece) or central idea (a narrative),
              copied VERBATIM from the essay. An empty string only if the essay has none.
  support     Every span, copied VERBATIM, that supports the main idea by the criteria's standard of
              support above. An empty list only if there is genuinely none.
  points      Problems that matter against the criteria, judged at the level of the WHOLE ESSAY.
              - A claim is unsupported only if NOTHING anywhere in the essay supports it by the
                criteria's standard. A claim followed by a reason or example is not
                claim-without-evidence.
              - Problems of EVERY kind count. Conventions, unsignposted structure, undefined terms and
                repetition are real problems, and they are usually what a strong essay has left: raise
                them on a strong essay as readily as on a weak one. Minor does not mean optional.
              - There is NO expected number of points. A strong essay may warrant one or two, or none;
                a weak one may warrant many. Do not raise a point for each criterion, and do not raise
                one to say that a criterion is met or has nothing to report.
    quote       A span copied VERBATIM from the student's essay, word for word, locating exactly where
                the problem is. Copy it exactly as written; do not paraphrase, correct or shorten it.
    deficiency  EXACTLY ONE code from the genre's list above. What each code means:
${codeMeanings}
    note        ${"{{NOTE}}"}

overall
  bandCount        How many bands or score points the criteria define. 0 if they define none.
  bandsConsidered  ALL of them: exactly bandCount entries, LOWEST FIRST, none skipped. For each:
    band             its name, exactly as the criteria name it;
    descriptor       a short phrase copied VERBATIM from the criteria's description of that band;
    rating           ${BAND_RATING_MIN} to ${BAND_RATING_MAX}: how well that band's descriptor DESCRIBES this essay as a
                     whole. A descriptor describes a typical essay at that level, not a flawless one, so
                     rate RESEMBLANCE: an essay with a few problems can still be described very well by
                     a high band's descriptor. Read every descriptor before rating any, and rate each
                     band against the essay, not against the other bands.
  band        The band whose descriptor describes the essay BEST, that is the highest rating, named
              exactly as the criteria name it. An empty string if the criteria define no bands. Never
              a scale, mark or percentage of your own.
  sentence    One sentence, in the criteria's own terms, saying whether the essay broadly meets the
              criteria and naming its most serious problem. If the problems are fundamental, say so
              plainly; if they are small, say that. It describes the essay against the criteria;
              it never predicts what a marker will give.{{RULES}}`;

/** The system prompt with a given note line and rules block. */
export const essaySystemPrompt = ({ note, rules }) => TEMPLATE.replace("{{NOTE}}", note).replace("{{RULES}}", rules);

/** What the note must say in the shipped prompt. */
export const ESSAY_NOTE = "One short sentence saying WHAT IS WRONG at that spot, in your own words, as analysis.";

/** The rules, the first absolute. */
export const ESSAY_RULES = `

RULES, and the first is absolute:
  1. NEVER WRITE ANY PART OF THE ESSAY. No replacement wording, no suggested phrasing, no example
     sentences, nothing the student could paste in.
  2. The note DESCRIBES the problem. It does not demonstrate the fix.
  3. Keep the note to one sentence.
  4. The overall sentence DESCRIBES the essay too. Rule 1 applies to it exactly as to a note.
  5. mainIdea, support and each descriptor are COPIED, never written or tidied: mainIdea and support
     from the essay, the descriptor from the criteria.`;

/** THE prompt. */
export const ESSAY_SYSTEM_PROMPT = essaySystemPrompt({ note: ESSAY_NOTE, rules: ESSAY_RULES });

/** The user message: the criteria, then the essay, each labelled. */
export const essayUserMessage = ({ essay, criteria }) => `MARKING CRITERIA:\n${criteria}\n\nTHE STUDENT'S ESSAY:\n${essay}`;
