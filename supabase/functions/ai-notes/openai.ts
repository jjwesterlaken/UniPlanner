// OpenAI adapter — one call does both structured summarizing and (if
// requested) translation, so translation costs an extra output length,
// not a second round trip.

import { SUMMARY_MAX_TOKENS } from "./config.ts";

const SUMMARY_SCHEMA_OBJECT = {
  type: "object",
  properties: {
    overview: { type: "string" },
    keyPoints: { type: "array", items: { type: "string" } },
    terms: {
      type: "array",
      items: {
        type: "object",
        properties: { term: { type: "string" }, content: { type: "string" } },
        required: ["term", "content"],
        additionalProperties: false,
      },
    },
    assessable: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["overview", "keyPoints", "terms", "assessable", "openQuestions"],
  additionalProperties: false,
};

// The object shape is duplicated under `original` and `translated`
// rather than using $ref — OpenAI's strict JSON Schema mode doesn't
// reliably support $ref, so duplication is the safer choice here.
const LECTURE_SUMMARY_SCHEMA = {
  name: "lecture_summary",
  strict: true,
  schema: {
    type: "object",
    properties: {
      original: SUMMARY_SCHEMA_OBJECT,
      translated: { anyOf: [SUMMARY_SCHEMA_OBJECT, { type: "null" }] },
    },
    required: ["original", "translated"],
    additionalProperties: false,
  },
};

export const openaiAdapter = {
  name: "openai",

  async summarize({
    transcript,
    translateTo,
    apiKey,
  }: {
    transcript: string;
    translateTo?: string | null;
    apiKey: string;
  }): Promise<{ original: any; translated: any | null }> {
    /* THE DEPTH RULES.

       The first version of this prompt named the sections and stopped,
       which is why real output came back accurate but thin: nothing
       told the model what belonged IN a key point, so it wrote
       headings. Depth is bought with instructions about specificity,
       not with more sections -- the structure below is exactly the
       structure that shipped.

       "Do not pad" is load-bearing rather than decorative. Told to go
       deeper and given nothing to be deep ABOUT, a model reliably
       inflates: restating the same claim in three registers, inventing
       open questions to fill the section, glossing terms from its own
       knowledge rather than from the lecture. That is longer output at
       the same information content, and the student pays for the
       tokens. Every rule below is either "include the specifics that
       were actually said" or "do not invent".

       The register is study, never substitution: these are revision
       notes made from a lecture the student attended. Nothing here
       asks for a replacement for attending or for the reading. */
    const depthRules = [
      `"overview": 3-5 sentences saying what the lecture argued and how it was organised, not what topic it was about.`,
      `"keyPoints": one entry per distinct idea the lecturer developed, in the order they were covered. Each entry is a complete sentence or two carrying the substance: the claim, the reasoning or evidence given for it, and any names, dates, figures, formulae or worked examples the lecturer used. A bare topic label is not a key point. A fifty-minute lecture usually yields 12-20; a short recording yields few, and that is correct.`,
      `"terms": 8-15 entries. Explain each one AS THE LECTURER DID -- the definition they gave, and why it matters in this course. A dictionary gloss from your own knowledge is not what is wanted.`,
      `"assessable": anything the lecturer signalled is examinable (e.g. "this will be on the exam", "remember this for the test"). Quote or closely paraphrase the signal so the student can see why it is listed.`,
      `"openQuestions": only things genuinely left unresolved in the lecture, or that the lecturer said would be covered later. If there were none, return an empty array.`,
      `Stay with what was actually said. Do not add material the lecturer did not cover, do not restate the same point in several entries, and do not lengthen an entry that is already complete. Depth comes from the lecture's specifics, never from padding.`,
    ].join(" ");

    const base = `You turn lecture transcripts into detailed structured study notes for a student to revise from. Produce "original" in the transcript's spoken language (expected English). ${depthRules}`;

    const systemPrompt = translateTo
      ? `${base} Also produce "translated": the same structure at the same depth, fully translated into the language with ISO code "${translateTo}".`
      : `${base} Set "translated" to null.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_schema", json_schema: LECTURE_SUMMARY_SCHEMA },
        // Without this the model may emit its full 16,384-token output.
        // See SUMMARY_MAX_TOKENS in config.ts for why that matters to the
        // price of the product rather than just to one request.
        max_tokens: SUMMARY_MAX_TOKENS,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI request failed (${res.status})`);
    }
    const json = await res.json();
    const choice = json?.choices?.[0];
    // Hitting the ceiling truncates the JSON mid-structure, so JSON.parse
    // would fail with something unrelated-looking. Named explicitly so the
    // logs say "the cap was too low" rather than "the model misbehaved".
    if (choice?.finish_reason === "length") {
      throw new Error(`OpenAI hit the ${SUMMARY_MAX_TOKENS}-token output cap and returned truncated notes`);
    }
    const content = choice?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");
    return JSON.parse(content);
  },
};
