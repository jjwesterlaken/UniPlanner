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

/* ---------- what the providers charge, and how much they are asked for ----

   THESE ARE HERE SO THE FLOOR IS DERIVED RATHER THAN REMEMBERED.

   The derivation below used to be prose, with the resulting figure
   ($0.0018 per summary) typed into scripts/test-ai-notes.mjs as a
   literal. That made the test blind to the one change it was supposed
   to notice: raising SUMMARY_MAX_TOKENS from 8,000 to 15,000 — nearly
   doubling the ceiling — left it green, because the number it checked
   had not moved and could not. Eighth instance of the restatement
   pattern, and the first where the restated value was a PRICE.

   Now the test computes the summary cost from these and asserts the
   floor covers it, so a deeper prompt, a pricier model or a raised
   ceiling all force the arithmetic to be re-run instead of skipping it.

   TYPICAL_SUMMARY_OUTPUT_TOKENS is a MODELLED figure, not a measured
   one, and it is the one to replace first: run
   scripts/measure-summary-depth.mjs against a real transcript and put
   the observed number here. Everything else is a published price. */
export const USD_PER_TRANSCRIBED_MINUTE = 0.04 / 60; // Groq whisper-large-v3-turbo, ~$0.04/hour
export const USD_PER_1M_SUMMARY_INPUT = 0.15; // gpt-4o-mini
export const USD_PER_1M_SUMMARY_OUTPUT = 0.6; // gpt-4o-mini

/* A SHORT recording's summary, which is what the floor exists to cover:
   a one-minute clip and a fifty-minute lecture cost nearly the same to
   summarise, so the floor is priced against the short one.

   2,800 was the figure before the depth change (a terse note plus a
   translation). The deeper prompt asks for the lecturer's specifics
   rather than more sections, and explicitly forbids padding, so a
   one-minute clip grows far less than a lecture does — modelled at
   ~1.3x. UNMEASURED. See the note above. */
export const TYPICAL_SUMMARY_OUTPUT_TOKENS = 3600;
export const TYPICAL_SUMMARY_INPUT_TOKENS = 1000;

/* ---------- the minimum a recording can cost ----------

   THE HOLE THIS CLOSES: transcription is charged per minute, but
   summarising is charged per REQUEST — the summariser's output is driven
   by the note schema (overview, key points, 8-15 terms, assessable, open
   questions), not by how long the recording was. A one-minute clip
   produces very nearly the same summary cost as a fifty-minute lecture.
   So "300 minutes" priced as 300 minutes of transcription is wrong by
   roughly the number of recordings, not the number of minutes.

   The arithmetic is now COMPUTED from the constants above rather than
   restated here. At today's values:

     transcription                                    $0.000667 / minute
     summarising, typical  3,600 out + 1,000 in       ≈ $0.00231
     summarising, ceiling 12,000 out (SUMMARY_MAX_TOKENS) ≈ $0.00735

   $0.00231 / $0.000667 = 3.46 minutes of transcription buys what one
   typical summary costs. Rounded UP to 4, because rounding down would
   under-cover the case that includes a translation -- which is the case
   a student who needs one always hits.

   IT WAS 3, AND THE DEPTH CHANGE IS WHY IT MOVED. The deeper prompt
   asks for the lecturer's actual specifics, which costs output tokens
   on every request including a short one. The test derives the required
   floor and fails if this constant is below it, so that decision could
   not be skipped -- which is the whole point of the change above.

   BOTH THE FLOOR AND THE CEILING NOW REST ON A MODELLED FIGURE
   (TYPICAL_SUMMARY_OUTPUT_TOKENS). Re-derive them from a real run
   before treating either as settled; the instrument is
   scripts/measure-summary-depth.mjs.

   What it does to the pathological month (as many one-minute clips as
   the allowance permits) against a real timetable:

                                 transcription  summarising   total
     no floor, 300 clips            $0.20         $0.69       $0.89
     floor of 4, 75 clips           $0.050        $0.173      $0.223
     a real timetable
     (6 x 50-minute lectures)       $0.20         $0.014      $0.214

   4.2x over the intended cost becomes 1.04x. Against the summariser's
   CEILING rather than a typical response the residual is larger, and
   that is left deliberately: covering it needs a floor around 11
   minutes, which would charge a student recording a ten-minute tutorial
   segment for more than they used. The ceiling is also the case that
   FAILS rather than returning notes (see openai.ts), so it is not a
   mode anyone can usefully sit in.

   Every figure above is computed by scripts/test-ai-notes.mjs from the
   constants, so this table is a description of the arithmetic and not
   the arithmetic itself. */
export const MINIMUM_BILLED_MINUTES = 4;
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

   RAISED FROM 8,000 TO 12,000 BY THE DEPTH CHANGE, and this is the
   direction to err in. A 3-hour lecture summarised into two languages
   landed around 6k under the terse prompt; a prompt that asks for the
   lecturer's specifics roughly doubles that, which would have put the
   worst case OVER 8,000.

   Hitting the cap is not a truncated note -- it is a hard failure, on a
   request whose transcription has already succeeded and already been
   billed, with no retry endpoint and the audio already deleted (see
   "there is no way to retry a summary" in CLAUDE.md). So an
   under-set ceiling costs a student a lecture they paid for, while an
   over-set one only costs money in a case that fails today anyway.
   12,000 is still well under the model's 16,384 default.

   Hitting it is treated as a failure rather than silently returning
   truncated notes; see openai.ts. */
export const SUMMARY_MAX_TOKENS = 12000;
