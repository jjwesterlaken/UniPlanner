// OpenAI adapter for the text tasks.
//
// Deliberately thinner than ai-notes/openai.ts: that one owns a fixed
// schema because it produces exactly one shape, whereas this produces
// four. The schema lives per task in prompts.js, and this adapter's only
// jobs are the call, the ceiling, and turning a truncated response into
// an error rather than into unparseable JSON.

export const openaiTextAdapter = {
  name: "openai",

  async complete({
    messages,
    maxTokens,
    apiKey,
    fetchImpl = fetch,
  }: {
    messages: { role: string; content: string }[];
    maxTokens: number;
    apiKey: string;
    fetchImpl?: typeof fetch;
  }): Promise<string> {
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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
