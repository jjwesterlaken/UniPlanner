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

/* ---------- the minimum a recording can cost ----------

   THE HOLE THIS CLOSES: transcription is charged per minute, but
   summarising is charged per REQUEST — the summariser's output is driven
   by the note schema (overview, key points, 8-15 terms, assessable, open
   questions), not by how long the recording was. A one-minute clip
   produces very nearly the same summary cost as a fifty-minute lecture.
   So "300 minutes" priced as 300 minutes of transcription is wrong by
   roughly the number of recordings, not the number of minutes.

   The arithmetic, at Groq whisper-large-v3-turbo (~$0.04/hour) and
   gpt-4o-mini ($0.15/1M in, $0.60/1M out):

     transcription        $0.04 / 60          = $0.000667 per minute
     summarising, typical ~2,800 output tokens (a short note plus a
                          translation) + ~1,000 input               ≈ $0.0018
     summarising, ceiling  8,000 output tokens (SUMMARY_MAX_TOKENS)  ≈ $0.005

   $0.0018 / $0.000667 = 2.7 minutes of transcription buys what one
   typical summary costs. Rounded UP to 3, because rounding down would
   under-cover the case that includes a translation -- which is the case
   a student who needs one always hits.

   What it does to the pathological month (300 one-minute recordings,
   which the allowance permits today):

                             transcription   summarising     total
     before, 300 recordings     $0.20          $0.54         $0.74
     after, 100 recordings      $0.067         $0.18         $0.247
     a real timetable
     (6 x 50-minute lectures)   $0.20          $0.024        $0.224

   3.3x over the intended cost becomes 1.1x. Against the summariser's
   ceiling rather than a typical response the residual is ~2.5x, and that
   is left deliberately: covering it needs a 7.5-minute floor, which
   would charge a student recording a ten-minute tutorial segment for
   most of a lecture. The ceiling is also the case that FAILS rather than
   returning notes (see openai.ts), so it is not a mode anyone can
   usefully sit in.

   Recalculate this if MONTHLY_MINUTES_LIMIT, SUMMARY_MAX_TOKENS or
   either provider's price changes. scripts/test-ai-notes.mjs holds the
   arithmetic so raising a limit can't quietly skip it. */
export const MINIMUM_BILLED_MINUTES = 3;
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

/* A summary failure is retained four times as long. Transcription
   succeeded and was billed, the audio is already deleted, and this row
   holds the only copy of what the user paid for -- so it is the one
   row worth keeping. Mirrored in src/aiNotesRetention.js, which is what
   the user-facing copy reads; a test fails if the two disagree. */
export const FAILED_REQUEST_RETENTION_DAYS = 30;
export const ORPHAN_SWEEP_HOURS = 1;

/* Audio file extensions the recorder can actually produce, mirroring
   EXTENSION_FOR_MIME in src/aiNotesClient.js — which is itself driven by
   CANDIDATE_MIME_TYPES in src/aiNotesLogic.js. iOS Safari does not record
   webm, so this genuinely varies and the extension cannot be hardcoded.

   This is a server-side allowlist, not a hint: the object's real
   extension is discovered by listing the caller's own folder, and only a
   name matching one of these is accepted. Nothing about the stored path
   comes from the request body. If the recorder ever gains a format, this
   list and EXTENSION_FOR_MIME have to change together. */
export const AUDIO_EXTENSIONS = ["webm", "m4a", "aac"];


/* Languages the app offers translation into. Mirrors TRANSLATION_LANGUAGES
   in src/aiNotesLogic.js — duplicated rather than imported because an Edge
   Function can't reach into src/, and a test asserts the two agree.

   This is an allowlist, not a hint: translateTo is interpolated into the
   summariser's system prompt, so an arbitrary string is both an unbounded
   output cost and free text in a prompt. Anything not on this list is
   treated as "no translation". */
export const TRANSLATION_CODES = ["zh", "hi", "ne", "vi", "bn", "id", "ko", "th", "es", "ar"];

/* The course name becomes a vocabulary hint for the transcription
   provider. It is short by nature ("BIOL1010 Cell Biology"), so 80
   characters is generous, and capping it keeps an unbounded string out of
   a paid API call. */
export const MAX_COURSE_LENGTH = 80;

/* Ceiling on summariser output tokens.

   gpt-4o-mini defaults to its full 16,384-token output, which is the
   quiet cost risk: transcription is ~$0.04/hour, but 300 short recordings
   in a month (the allowance is 300 MINUTES, so that is reachable) at 16k
   output tokens each is several dollars of summarising against twenty
   cents of transcription — the summariser, not Whisper, would set the
   price of the product.

   8000 sits above what the structured notes actually need — a 3-hour
   lecture summarised into two languages lands around 6k — while halving
   the theoretical worst case. Hitting it is treated as a failure rather
   than silently returning truncated notes; see openai.ts. */
export const SUMMARY_MAX_TOKENS = 8000;
