/* Groq adapter (OpenAI-compatible Whisper endpoint, whisper-large-v3-turbo).
   Default transcription provider — see config.ts for why (roughly 6x
   cheaper than Deepgram per hour, which is what makes a generous minutes
   allowance viable for a full timetable of lectures).

   Plain JS (not TypeScript), same reasoning as deepgram.js: this exact
   file runs unmodified under both Deno and Node so the request/response
   shape has direct test coverage.

   Verified before building, not assumed:
   - The endpoint accepts a `url` field alongside `file`, but ALWAYS as
     multipart/form-data (unlike Deepgram's /v1/listen, which takes a
     plain JSON body for the URL case) — confirmed from Groq's own curl
     examples. `url` and `file` are just alternate form fields; only one
     is sent.
   - `duration` is only present in the response when
     response_format=verbose_json is requested — the default `json`
     format returns text only. This adapter always requests
     verbose_json specifically so billing has a real duration to use.
   - Documented file-size caps (25MB free / 100MB dev tier) are stated
     for the `file` upload path; Groq's own docs point to `url` as the
     way to handle larger files and don't list a separate ceiling for
     it. No client-side cap change was made on this basis — see the
     comment on MAX_BODY_BYTES in config.ts. Whether the `url` path has
     its own, unstated ceiling is NOT confirmed — see the note in
     SUPABASE-SETUP.md about testing a ~2 hour recording before real
     users are let in.
   - Error shape, per console.groq.com/docs/errors: a 413 status is the
     documented code for an oversized request, and error bodies are
     `{ "error": { "message": "...", "type": "..." } }`. `isSizeError`
     below leans on the documented 413 as the primary signal and falls
     back to matching size/duration wording in the message for cases
     that might arrive as 400 instead (e.g. a duration-based rejection
     on a file that isn't large in bytes) — since Groq doesn't document
     a distinct error `type` for this specifically, that fallback is a
     best effort, not a guarantee. */

/**
 * Distinguishes "this recording is fundamentally too big/long for the
 * provider" from a generic/transient failure, so the caller doesn't
 * offer a retry that would just fail identically. Exported so it's
 * directly testable rather than only exercised through a live rejection.
 */
export function isSizeError(status, errorBody) {
  if (status === 413) return true;
  const message = ((errorBody && errorBody.error && errorBody.error.message) || "").toLowerCase();
  return /too large|file size|maximum size|too long|duration/.test(message);
}

export const groqAdapter = {
  name: "groq",

  /**
   * @param {object} args
   * @param {string} [args.audioUrl]
   * @param {ArrayBuffer} [args.audioBuffer]
   * @param {string} [args.mimeType]
   * @param {string} args.apiKey
   * @param {string} [args.prompt] - vocabulary hint (e.g. "Lecture for
   *   BIOL2011 Cell Biology"). Whisper's `prompt` param biases style/
   *   spelling toward expected words; capped at 224 tokens by Groq, so
   *   trimmed defensively here well under that.
   * @param {typeof fetch} [args.fetchImpl] - injectable for tests.
   * @returns {Promise<{transcript: string, durationSeconds: number}>}
   */
  async transcribe({ audioUrl, audioBuffer, mimeType, apiKey, prompt, fetchImpl = fetch }) {
    const endpoint = "https://api.groq.com/openai/v1/audio/transcriptions";
    const form = new FormData();
    form.set("model", "whisper-large-v3-turbo");
    form.set("response_format", "verbose_json");
    if (prompt) form.set("prompt", prompt.slice(0, 800));

    if (audioUrl) {
      form.set("url", audioUrl);
    } else if (audioBuffer) {
      form.set("file", new Blob([audioBuffer], { type: mimeType || "application/octet-stream" }), "audio");
    } else {
      throw new Error("groqAdapter.transcribe needs either audioUrl or audioBuffer");
    }

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      let errorBody = null;
      try {
        errorBody = await res.json();
      } catch (e) {
        /* not a JSON body — fall through with errorBody left null */
      }
      if (isSizeError(res.status, errorBody)) {
        const err = new Error("This recording is too long to process — try recording in shorter segments.");
        err.code = "too_large";
        throw err;
      }
      throw new Error(`Groq request failed (${res.status})`);
    }
    const json = await res.json();
    const transcript = json?.text || "";
    // Groq's verbose_json response reports `duration` in seconds — same
    // unit as Deepgram's metadata.duration, no conversion needed, just a
    // different field path.
    const durationSeconds = json?.duration || 0;
    if (!transcript.trim()) {
      throw new Error("Groq returned an empty transcript");
    }
    return { transcript, durationSeconds };
  },
};
