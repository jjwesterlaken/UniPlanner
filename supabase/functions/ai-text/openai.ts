// OpenAI adapter for the text tasks.
//
// Deliberately thinner than ai-notes/openai.ts: that one owns a fixed
// schema because it produces exactly one shape, whereas this produces
// four. The schema lives per task in prompts.js, and this adapter's only
// jobs are the call, the ceiling, and turning a truncated response into
// an error rather than into unparseable JSON.

import { SUMMARY_MODEL, VISION_MODEL } from "../_shared/model.ts";

export const openaiTextAdapter = {
  name: "openai",

  async complete({
    messages,
    maxTokens,
    apiKey,
    hasImages = false,
    fetchImpl = fetch,
  }: {
    messages: { role: string; content: unknown }[];
    maxTokens: number;
    apiKey: string;
    hasImages?: boolean;
    fetchImpl?: typeof fetch;
  }): Promise<string> {
    /* THE MODEL IS CHOSEN PER MEDIUM, not per task. Photographs and
       pasted text are the same `summarise` task, so a single model
       string here would drag text and lecture summaries wherever the
       photo path goes — and COST-MODEL.md section 12.5 prices that at
       6.6x worse for a text chunk and 6.3x worse for a lecture, because
       every one of these tasks is output-dominated and the models with
       cheap images have expensive output.

       Both constants are the same string today. VISION_MODEL is the one
       expected to move. */
    const model = hasImages ? VISION_MODEL : SUMMARY_MODEL;
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        // json_object rather than a strict json_schema: the four tasks
        // have four shapes, and prompts.js validates each one on the way
        // back. Asking for JSON here still stops the model wrapping its
        // answer in prose, which is the failure this actually prevents.
        response_format: { type: "json_object" },
        /* Never absent. Without it the model may emit its full
           16,384-token output on every call, which is what would set the
           price of the product -- see MAX_TOKENS in config.ts, where each
           task's number is justified against the shape of its output. */
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI request failed (${res.status})`);

    const json = await res.json();
    const choice = json?.choices?.[0];
    /* Hitting the ceiling truncates the JSON mid-structure, so the parse
       downstream would fail with something unrelated-looking. Named here
       so the logs say "the cap was too low for this task" rather than
       "the model misbehaved" -- the same distinction ai-notes draws, and
       for the same debugging reason. */
    if (choice?.finish_reason === "length") {
      throw new Error(`OpenAI hit the ${maxTokens}-token output cap and returned a truncated response`);
    }
    const content = choice?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");
    return content;
  },
};
