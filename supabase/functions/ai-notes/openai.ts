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
    const systemPrompt = translateTo
      ? `You turn lecture transcripts into structured study notes. Produce "original" in the transcript's spoken language (expected English). Also produce "translated": the same structure, fully translated into the language with ISO code "${translateTo}". Flag anything the lecturer signals is examinable (e.g. "this will be on the exam") under "assessable". List anything genuinely unclear or left unresolved under "openQuestions".`
      : `You turn lecture transcripts into structured study notes. Produce "original" in the transcript's spoken language (expected English). Set "translated" to null. Flag anything the lecturer signals is examinable (e.g. "this will be on the exam") under "assessable". List anything genuinely unclear or left unresolved under "openQuestions".`;

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
