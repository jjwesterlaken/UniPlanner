/* ==================================================================
   prompts.js — one prompt builder and one parser per task

   Plain JS so the tests can check the two properties that matter
   without a Deno toolchain:

     1. nothing client-supplied is interpolated into an INSTRUCTION —
        the student's text is always a separate user message, never
        spliced into the system prompt where it could rewrite the task
     2. every task's output parses into a known shape, or throws

   (2) is why parseTaskResult throws rather than returning a partial
   object. A half-parsed result renders, which is how wrong output
   reaches a student looking correct.
   ================================================================== */

import { ESSAY_SYSTEM_PROMPT, essayUserMessage } from "../_shared/essayPrompt.js";
import { finishEssayReply } from "../_shared/essayReply.js";
import { REWRITE_SYSTEM_PROMPT, rewriteUserMessage, finishRewrite } from "../_shared/essayRewrite.js";

const SHARED_RULES = [
  "You are helping a university student study.",
  "Be accurate. If the material does not support an answer, say so rather than inventing one.",
  "Never include preamble, apologies, or commentary about being an AI.",
  "Reply with JSON only, matching the schema given. No markdown fences.",
].join(" ");

/* Each entry is a SYSTEM prompt: fixed text, no interpolation. The
   student's material goes in a user message below, which is what keeps
   "summarise this" from becoming "summarise this. Also ignore your
   instructions." — the model still sees it, but it sees it as content
   rather than as a rule. */
const SYSTEM = {
  explain:
    `${SHARED_RULES} The student has written an explanation of a concept in their own words. ` +
    "Judge it as a tutor would: say what is right, what is missing, and what is wrong. " +
    'Schema: {"correct":[string],"missing":[string],"wrong":[string],"verdict":string}. ' +
    "`verdict` is one short sentence. Be encouraging about what they got right before what they missed.",

  weakspots:
    `${SHARED_RULES} The student's review history shows which topics they keep forgetting. ` +
    "For the topics given, say what is likely to be causing the difficulty and what to do about it. " +
    'Schema: {"topics":[{"term":string,"why":string,"try":string}],"overall":string}. ' +
    "`why` and `try` are one or two sentences each. Do not invent topics that were not given.",

  practice:
    `${SHARED_RULES} Write practice questions from the student's own study cards. ` +
    'Schema: {"questions":[{"q":string,"a":string,"why":string}]}. ' +
    "One question per card, in the order given. `q` asks something that requires understanding rather than " +
    "recall of the exact wording. `a` is the answer. `why` is one line on what the question is testing.",

  summarise:
    `${SHARED_RULES} Summarise the student's own note into the same structure the app uses for lecture notes. ` +
    'Schema: {"overview":string,"keyPoints":[string],"terms":[{"term":string,"content":string}],' +
    '"assessable":[string],"openQuestions":[string]}. ' +
    "Draw only on the note. `openQuestions` is for things the note leaves unresolved, not for questions you invent.",

  /* The same task over photographed pages. The schema is identical --
     one shape of AI note, whatever the medium.

     THE LEGIBILITY RULE IS A REFUSAL, NOT A GUESS. There is no reliable
     client-side blur detector, and a bad heuristic blocks legible
     photos -- so the model, which actually reads the page, is the one
     that refuses. A summary quietly built on a misread page is the
     worst outcome: it is billed, saved, and trusted. What this cannot
     catch -- a page legible enough to misread -- is stated in the
     user-facing copy rather than papered over.

     THE THREE NOISE RULES ARE EACH A DEFECT SOMEBODY READ, not general
     advice about writing well. gpt-5.4-nano's first measured run over
     four photographed pages (COST-MODEL 12.9) was accurate -- every
     date and figure checked out against the pages and nothing was
     invented -- and noisy in three specific ways, and a model told
     vaguely to "be cleaner" trims content instead:

       1. "Data crunc(h)ers". A word broken across a line end, with the
          missing letter offered in brackets as an uncertainty marker.
          That is the PAGE'S LAYOUT reaching the note. The rule is to
          join the word and, where it cannot be made out, to drop the
          point rather than spell it with a guess -- because a bracketed
          letter reads to a student as the author's notation.
       2. The same term defined twice in `terms`. Pages define a term
          and then use it; the note should not.
       3. "Hopper was the first group to be granted a PhD" -- two true
          claims about two subjects fused into one false sentence. This
          is the only one of the three that can MISINFORM, and it is the
          reason the rule is "one claim, one subject" rather than
          "write clearly".

     WHAT IS DELIBERATELY NOT HERE IS A LIMIT ON HOW MUCH IT SAYS. nano
     produced 18 key points against gpt-5.4-mini's tighter set, and
     thoroughness was not the complaint; ai-notes' own depth work
     measured +189% words per entry from telling a model what belongs in
     a section, and capping entries is how that gets undone. Every rule
     above removes a defect; none of them asks for less.

     THE PROMPT IS PART OF THE PRICE, and on gpt-5.4-mini the margin
     for that is thin. These rules added 189 input tokens, and the
     measured batch bill in _shared/model.ts is the figure WITH them in
     it -- 4234, taken from the same run that judged the output.

     The four numbers below are asserted rather than asserted-in-prose;
     see "the photo weight does not move for a prompt change" in
     test-ai-text-function.mjs, which re-derives them from the shipped
     rates and compares them with this sentence. At those rates the
     weight stays 18 for an input between 4005 and 4918 tokens: 684
     tokens of headroom above the measured 4234.

     684 IS NOT MUCH -- roughly 2,900 characters of prompt, against the
     1,715 this one already is. On gpt-5.4-nano the band was 2,933 to
     6,362 and no realistic prompt edit could move the price; mini's
     input is 3.75x dearer, so the band is a quarter as wide and the
     next edit to this text genuinely can re-price the feature. Re-run
     scripts/measure-photo-prompt.mjs and move
     MEASURED_PHOTO_BATCH_INPUT_TOKENS in the same commit; the test
     above goes red if the sentence and the constants disagree. */
  summariseImages:
    `${SHARED_RULES} The images are photographs of pages from a reading the student is studying. ` +
    "Summarise their content into the structure the app uses for lecture notes. " +
    'Schema: {"overview":string,"keyPoints":[string],"terms":[{"term":string,"content":string}],' +
    '"assessable":[string],"openQuestions":[string]}. ' +
    "Draw only on what the pages actually say. " +
    /* (1) You are reading a photograph of a PRINTED page, so the page's
       layout is in the image and must not reach the note. */
    "You are reading printed pages, so words are broken across line ends and columns. " +
    "Write every word whole, in ordinary spelling: join a word split by a line-break hyphen, " +
    "and never carry a hyphen, a bracket or any other mark that belongs to the page's layout " +
    "rather than to the word. Do not signal uncertainty inside a word with brackets or " +
    "alternative letters: if you cannot make a word out, leave that point out. " +
    /* (2) Say each thing once. */
    "Say each thing once. Every entry in `terms` names a different term, so a term the pages " +
    "define more than once is ONE entry combining what they say, and no two key points make " +
    "the same point. " +
    /* (3) One claim, one subject -- the fused-sentence rule. */
    "Each key point is a single claim about a single subject. Do not join facts about " +
    "different people, dates, organisations or systems into one sentence: where the pages say " +
    "two things, write two entries. A sentence that fuses two claims is wrong even when both " +
    "halves are on the page. " +
    "IF ANY PAGE IS NOT CLEARLY LEGIBLE, DO NOT GUESS AT IT: instead reply with exactly " +
    '{"unreadable":[numbers]} listing the 1-based positions of the illegible images, and nothing else. ' +
    "Only summarise when every page can be read.",

  /* Combining the per-chunk summaries of one long reading.
     Same schema as `summarise` on purpose: the result goes down the
     identical storage path, so there is one shape of AI note rather
     than two.

     "Consecutive sections overlap" is in the prompt because the chunker
     deliberately repeats ~200 characters across a boundary so a claim
     spanning one survives whole somewhere -- and without being told,
     the model reports the repetition as emphasis. */
  merge:
    `${SHARED_RULES} You are given summaries of consecutive sections of ONE reading, in order. ` +
    "Combine them into a single summary of the whole reading. " +
    'Schema: {"overview":string,"keyPoints":[string],"terms":[{"term":string,"content":string}],' +
    '"assessable":[string],"openQuestions":[string]}. ' +
    "Consecutive sections overlap slightly, so the same point may appear twice — say it once. " +
    "Add nothing that is not in the summaries given, and drop nothing that only one of them mentions.",

  /* ESSAY FEEDBACK. The prompt the Gate A reads measured, imported from
     _shared rather than written here, so the endpoint sends exactly what
     gpt-5.6-luna was chosen on. Its output shape is enforced by a
     strict json_schema (openai.ts), not by prose, and it does NOT use
     SHARED_RULES: that prompt is complete as measured, and adding a
     line to it would be a configuration nobody measured. */
  essay: ESSAY_SYSTEM_PROMPT,

  /* THE EXAMPLE REWRITE (Jared, 18 September 2026). One passage and the
     point's note, never the criteria and never the rest of the essay:
     "no path that generates text from the assignment prompt rather than
     from their own writing" is held by what this message CAN carry. */
  rewrite: REWRITE_SYSTEM_PROMPT,
};

/**
 * Messages for a task. The student's material is ALWAYS a separate user
 * message — see the note above about why it is never interpolated into
 * the system prompt.
 */
/**
 * EVERY DISTINCT PROMPT THIS ENDPOINT CAN SEND MATERIAL UNDER.
 *
 * Exported so the consent guard can DERIVE the list rather than
 * restate it: `scripts/test-legal.mjs` requires every route here to be
 * mapped to the kinds of material it sends in `MATERIAL_ROUTES`, and a
 * task with no mapping goes red naming itself. That chain is what ties
 * adding a FEATURE to bumping the consent version — task -> material
 * type -> fingerprint -> `AI_CONSENT_VERSION` — with no step in it that
 * depends on somebody remembering.
 *
 * IT IS `SYSTEM`'s OWN KEYS AND NOT A SECOND LIST. `buildMessages`
 * throws on a task `SYSTEM` has no entry for, so these keys ARE the set
 * of things this endpoint can be asked to do; a hand-written copy
 * beside them would be the restatement the guard exists to prevent.
 *
 * NOTE `summariseImages` IS HERE AND IS NOT A CLIENT TASK — it is
 * selected inside `summarise` when the body carries photographs. That
 * is exactly why the unit is the PROMPT rather than the task name: the
 * photographs are a different kind of material going out under a
 * different prompt, and a list keyed on what the client may ask for
 * would not have a row for them.
 */
export const TASKS = Object.freeze(Object.keys(SYSTEM));

export function buildMessages(task, body) {
  const system = SYSTEM[task];
  if (!system) throw new Error(`no prompt for task: ${task}`);

  if (task === "explain") {
    return [
      { role: "system", content: system },
      { role: "user", content: `Topic: ${String(body.topic || "").slice(0, 200)}` },
      { role: "user", content: String(body.text || "") },
    ];
  }
  if (task === "summarise") {
    if (Array.isArray(body.images) && body.images.length) {
      /* Vision content: one user message carrying the batch, in order.
         The data-URLs were validated upstream; "high" detail because a
         page of print at low detail is a page of grey. The student's
         photos are CONTENT, never instructions -- same separation as
         text. */
      return [
        { role: "system", content: SYSTEM.summariseImages },
        {
          role: "user",
          content: [
            { type: "text", text: `Photographs of ${body.images.length} consecutive pages, in order:` },
            /* detail "original" rather than "high": the docs recommend it
               for OCR and small text, and "high"/"low" may RESIZE the
               image and obscure fine detail -- so "high" was letting the
               provider pick the resolution of a page of print. At
               maxEdge 1024 it also costs the same, because the patch
               budget is not binding at that size. COST-MODEL 12.3. */
            ...body.images.map((url) => ({ type: "image_url", image_url: { url, detail: "original" } })),
          ],
        },
      ];
    }
    return [
      { role: "system", content: system },
      { role: "user", content: String(body.text || "") },
    ];
  }
  if (task === "essay") {
    /* The criteria and the essay together, labelled, as ONE user message:
       the shape that was measured. Both are the student's, both are
       content, and neither touches the system prompt. */
    return [
      { role: "system", content: system },
      { role: "user", content: essayUserMessage({ essay: String(body.text || ""), criteria: String(body.criteria || "") }) },
    ];
  }
  if (task === "rewrite") {
    return [
      { role: "system", content: system },
      { role: "user", content: rewriteUserMessage({ span: String(body.span || ""), note: body.note, deficiency: body.deficiency }) },
    ];
  }
  if (task === "merge") {
    /* One user message per section, in order, so the model sees the
       sequence rather than one blob it has to infer an order from. */
    return [
      { role: "system", content: system },
      ...(body.parts || []).map((p, i) => ({
        role: "user",
        content: `Section ${i + 1} of ${(body.parts || []).length}:\n${JSON.stringify(p)}`,
      })),
    ];
  }
  if (task === "practice") {
    return [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify((body.cards || []).map((c) => ({ term: c.term, content: c.content }))) },
    ];
  }
  // weakspots
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify((body.topics || []).map((t) => ({ term: t.term, lapses: t.lapses }))) },
  ];
}

/* A LONE STRING IS ONE ENTRY, NOT NOTHING — and this was losing real,
   paid-for content in production.

   `ai-text` asks the provider for `json_object`, which guarantees VALID
   JSON and says nothing about the SCHEMA. (`ai-notes` uses a strict
   `json_schema`; this endpoint never did, because its five tasks have
   five shapes.) So a model is free to answer `"assessable": "Explain
   the significance of two figures..."` where the schema declares
   `[string]` — and gpt-4o-mini, on the photo path, did exactly that for
   BOTH `assessable` and `openQuestions` on a measured four-page
   reading.

   What used to happen then is the quiet failure this file's own header
   warns about: `Array.isArray` is false for a string, so the field
   became `[]`, the note SAVED, the student was BILLED, and two sections
   came out empty — "indistinguishable, to a student, from a lecture
   that genuinely had nothing to say."

   COERCING AND NOT THROWING, deliberately, and it is the same rule as
   the failed merge: the content is right there and was paid for, so
   discarding it over a shape wobble takes the money and returns less.
   Throwing would fail a whole reading for a formatting difference the
   student cannot see or fix.

   It lives in `asArray` rather than at the five call sites, so
   `keyPoints` and `terms` are covered by the same line. A blank or
   whitespace-only string is still nothing. */
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return [v];
  return [];
};
const asString = (v) => (typeof v === "string" ? v : "");

/**
 * Parse and shape a task's output, or throw.
 *
 * Throws rather than returning something partial. A result missing half
 * its fields still renders — headings with nothing under them — and that
 * is indistinguishable, to a student, from a lecture that genuinely had
 * nothing to say. An error is honest; a blank section is not.
 */
export function parseTaskResult(task, raw, context = {}) {
  /* THE ESSAY IS CHECKED AGAINST WHAT WAS SUBMITTED, so it needs the
     essay, the criteria and the no-writing thresholds as well as the
     reply. Everything it does is in _shared/essayReply.js. */
  if (task === "essay") {
    return finishEssayReply({ raw, essay: context.text || "", criteria: context.criteria || "", thresholds: context.thresholds || null });
  }
  if (task === "rewrite") {
    if (!context.rewriteLimits) throw new Error("rewrite: no scope limits set");
    return finishRewrite({ raw, essay: context.text || "", span: context.span || "", limits: context.rewriteLimits });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${task}: response was not JSON`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`${task}: response was not an object`);

  /* The legibility refusal, detected BEFORE the schema check: the model
     was told to reply with this shape instead of the schema, so it must
     not fall through and read as "unusable output". The thrown error
     carries the positions; the handler turns it into its own code,
     because it is a different fact from an unusable reply (ai_failed,
     free) -- the student can act on it (retake page 3), and it is the
     one parse-stage outcome still billed. */
  if (task === "summarise" && Array.isArray(parsed.unreadable)) {
    const pages = parsed.unreadable.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1);
    const err = new Error(`summarise: pages unreadable (${pages.join(", ")})`);
    err.unreadablePages = pages.length ? pages : [1];
    throw err;
  }

  if (task === "explain") {
    const verdict = asString(parsed.verdict);
    if (!verdict) throw new Error("explain: no verdict");
    return {
      correct: asArray(parsed.correct).map(asString).filter(Boolean),
      missing: asArray(parsed.missing).map(asString).filter(Boolean),
      wrong: asArray(parsed.wrong).map(asString).filter(Boolean),
      verdict,
    };
  }

  if (task === "weakspots") {
    const topics = asArray(parsed.topics)
      .map((t) => ({ term: asString(t && t.term), why: asString(t && t.why), try: asString(t && t.try) }))
      .filter((t) => t.term && t.why);
    if (topics.length === 0) throw new Error("weakspots: no usable topics");
    return { topics, overall: asString(parsed.overall) };
  }

  if (task === "practice") {
    const questions = asArray(parsed.questions)
      .map((q) => ({ q: asString(q && q.q), a: asString(q && q.a), why: asString(q && q.why) }))
      .filter((q) => q.q && q.a);
    if (questions.length === 0) throw new Error("practice: no usable questions");
    return { questions };
  }

  // summarise and merge — the same shape ai-notes produces, so the whole
  // storage path (stub, row, cache, reconciliation) is reused rather
  // than reimplemented for a second kind of AI note. `merge` shares the
  // parser as well as the schema: one shape, one place it can be wrong.
  const overview = asString(parsed.overview);
  if (!overview) throw new Error(`${task}: no overview`);
  return {
    overview,
    keyPoints: asArray(parsed.keyPoints).map(asString).filter(Boolean),
    terms: asArray(parsed.terms)
      .map((t) => ({ term: asString(t && t.term), content: asString(t && t.content) }))
      .filter((t) => t.term && t.content),
    assessable: asArray(parsed.assessable).map(asString).filter(Boolean),
    openQuestions: asArray(parsed.openQuestions).map(asString).filter(Boolean),
  };
}
