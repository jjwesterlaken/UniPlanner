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
     user-facing copy rather than papered over. */
  summariseImages:
    `${SHARED_RULES} The images are photographs of pages from a reading the student is studying. ` +
    "Summarise their content into the structure the app uses for lecture notes. " +
    'Schema: {"overview":string,"keyPoints":[string],"terms":[{"term":string,"content":string}],' +
    '"assessable":[string],"openQuestions":[string]}. ' +
    "Draw only on what the pages actually say. " +
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
};

/**
 * Messages for a task. The student's material is ALWAYS a separate user
 * message — see the note above about why it is never interpolated into
 * the system prompt.
 */
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
            ...body.images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
          ],
        },
      ];
    }
    return [
      { role: "system", content: system },
      { role: "user", content: String(body.text || "") },
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

const asArray = (v) => (Array.isArray(v) ? v : []);
const asString = (v) => (typeof v === "string" ? v : "");

/**
 * Parse and shape a task's output, or throw.
 *
 * Throws rather than returning something partial. A result missing half
 * its fields still renders — headings with nothing under them — and that
 * is indistinguishable, to a student, from a lecture that genuinely had
 * nothing to say. An error is honest; a blank section is not.
 */
export function parseTaskResult(task, raw) {
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
     because it is a different fact from ai_failed_charged -- the
     student can act on it (retake page 3), not just retry. */
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
