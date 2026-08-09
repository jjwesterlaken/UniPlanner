// Deepgram adapter. Default path is URL-based transcription (Deepgram
// fetches the audio itself from a short-lived signed Storage URL, so
// this function never allocates the audio in memory). A buffer path is
// also kept so a future provider without URL-fetch support could be
// plugged in behind the same interface — the default config never
// takes that branch, since index.ts always signs a URL first.
export const deepgramAdapter = {
  name: "deepgram",

  async transcribe({
    audioUrl,
    audioBuffer,
    mimeType,
    apiKey,
  }: {
    audioUrl?: string;
    audioBuffer?: ArrayBuffer;
    mimeType?: string;
    apiKey: string;
  }): Promise<{ transcript: string; durationSeconds: number }> {
    const endpoint = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true";
    let res: Response;
    if (audioUrl) {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: audioUrl }),
      });
    } else if (audioBuffer) {
      res = await fetch(endpoint, {
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
