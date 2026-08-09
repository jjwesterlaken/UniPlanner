// Which provider each step uses. Swap by changing these strings — the
// lookup objects in index.ts mirror src/sync.js's `backend` pattern
// (plain object lookup, not a class hierarchy), and can also be
// overridden per-deployment without a redeploy via the
// AI_NOTES_TRANSCRIPTION_PROVIDER secret, for A/B testing on the same
// recording.
//
// Groq (whisper-large-v3-turbo) is the default: ~$0.04/hour vs Deepgram's
// ~$0.26/hour for broadly comparable quality on this use case — roughly
// 6x cheaper, which is what makes a generous monthly minutes allowance
// viable for a full timetable of lectures rather than ~14 hours/month.
export const TRANSCRIPTION_PROVIDER = "groq"; // "groq" | "deepgram"
export const SUMMARY_PROVIDER = "openai";

// Which secret holds each provider's API key.
export const PROVIDER_API_KEY_ENV = {
  deepgram: "DEEPGRAM_API_KEY",
  groq: "GROQ_API_KEY",
};

export const MONTHLY_MINUTES_LIMIT = 300;
export const MAX_REQUEST_SECONDS = 3 * 3600;
export const PROCESSING_STALE_MINUTES = 10;

// Client records at 32kbps (see src/aiNotesLogic.js
// RECORDER_AUDIO_BITS_PER_SECOND) — 3h of audio ≈ 43.2MB. Kept well
// below the Storage free-tier 50MB/file ceiling, with headroom for
// container/muxing overhead. If the client's recorded bitrate ever
// changes, this constant and RECORDER_AUDIO_BITS_PER_SECOND must
// change together.
//
// Verified this still holds for Groq specifically: Groq's documented
// file-size caps (25MB free tier / 100MB dev tier) are stated for the
// `file` (direct upload) parameter. Its own docs point to the `url`
// parameter — which is what this app always uses (see groq.js) — as the
// way to handle larger files, and don't list a separate ceiling for it.
// No evidence was found requiring this cap to move; if a real long
// recording is ever rejected by Groq in practice, this is the constant
// to revisit (alongside whether chunking is needed instead).
export const MAX_BODY_BYTES = 46_000_000;

export const LECTURE_AUDIO_BUCKET = "lecture-audio";
export const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes
export const REQUEST_RETENTION_DAYS = 7;
export const ORPHAN_SWEEP_HOURS = 1;
