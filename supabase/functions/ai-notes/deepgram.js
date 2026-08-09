/* Deepgram adapter. Plain JS (not TypeScript) so the exact same file runs
   unmodified under both Deno (the Edge Function) and Node
   (scripts/test-ai-notes.mjs) — the request/response shape is what
   billing and provider-swapping depend on, so it needs direct test
   coverage, not just documentation.

   URL-based transcription by default (see index.ts) -- Deepgram fetches
   the audio itself from a short-lived signed Storage URL, so this
   function never allocates the audio in memory. A buffer path is also
   kept so a provider without URL-fetch support could still be plugged in
   behind the same interface. */
export const deepgramAdapter = {
  name: "deepgram",

  /**
   * @param {object} args
   * @param {string} [args.audioUrl]
   * @param {ArrayBuffer} [args.audioBuffer]
   * @param {string} [args.mimeType]
   * @param {string} args.apiKey
   * @param {string[]} [args.keywords] - vocabulary hint (e.g. words from
   *   the course name), boosted via Deepgram's `keywords` query param.
   *   nova-2's mechanism for this is a list of words (optionally
   *   "word:intensifier"), not a free-text prompt like Whisper/Groq --
   *   see developers.deepgram.com/docs/keywords. Capped at 100 keywords
   *   per Deepgram's own limit.
   * @param {typeof fetch} [args.fetchImpl] - injectable for tests.
   * @returns {Promise<{transcript: string, durationSeconds: number}>}
   */
  async transcribe({ audioUrl, audioBuffer, mimeType, apiKey, keywords, fetchImpl = fetch }) {
    const params = new URLSearchParams({ model: "nova-2", smart_format: "true" });
    for (const kw of (keywords || []).slice(0, 100)) params.append("keywords", kw);
    const endpoint = `https://api.deepgram.com/v1/listen?${params.toString()}`;

    let res;
    if (audioUrl) {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: audioUrl }),
      });
    } else if (audioBuffer) {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": mimeType || "application/octet-stream" },
        body: audioBuffer,
      });
    } else {
      throw new Error("deepgramAdapter.transcribe needs either audioUrl or audioBuffer");
    }

    if (!res.ok) {
      throw new Error(`Deepgram request failed (${res.status})`);
    }
    const json = await res.json();
    const transcript = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    const durationSeconds = json?.metadata?.duration || 0;
    if (!transcript.trim()) {
      throw new Error("Deepgram returned an empty transcript");
    }
    return { transcript, durationSeconds };
  },
};
