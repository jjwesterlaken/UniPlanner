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

/* THE ALLOWANCE IS ONE POOL NOW, and it lives in _shared/credits.ts
   because it is no longer a property of the audio feature: a credit is
   a minute of recorded lecture, and every text action is priced in the
   same currency. Re-exported here so this file still answers "what does
   a month hold" for the code that asks it.

   ai-notes keeps its own `tier === "ai"` gate, so a free account never
   reaches the recording path whatever its credit balance says. The
   lifetime trial that changes that is the next piece of work. */
export {
  MONTHLY_CREDITS_LIMIT,
  FREE_CREDITS_LIMIT,
  creditsForTier,
  USD_PER_CREDIT,
} from "../_shared/credits.ts";

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

   TYPICAL_SUMMARY_OUTPUT_TOKENS was the figure to replace first, and it
   has been: it is now measured (see below) rather than assumed, which is
   what let the floor be re-derived instead of guessed at. Everything
   else here is a published price. */
/* THE RATES AND THE MEASURED SUMMARY FIGURES MOVED TO
   _shared/credits.ts, where the currency is defined, because ai-text
   needs exactly the same numbers to price a text action and a browser
   bundle is not the only thing that can end up with two copies. Two
   Deno functions in one repository sharing a directory is the case
   with no excuse.

   Re-exported rather than restated: same bindings, one definition, and
   every existing importer keeps working. */
export {
  USD_PER_TRANSCRIBED_MINUTE,
  USD_PER_1M_INPUT as USD_PER_1M_SUMMARY_INPUT,
  USD_PER_1M_OUTPUT as USD_PER_1M_SUMMARY_OUTPUT,
  TYPICAL_SUMMARY_OUTPUT_TOKENS,
  TYPICAL_SUMMARY_INPUT_TOKENS,
  USD_PER_SUMMARY_REQUEST,
} from "../_shared/credits.ts";

import { USD_PER_CREDIT as CREDIT, USD_PER_SUMMARY_REQUEST as SUMMARY_REQ } from "../_shared/credits.ts";

/* ---------- the minimum a recording can cost ----------

   THE HOLE THIS CLOSES: transcription is charged per minute, but
   summarising is charged per REQUEST — the summariser's output is driven
   by the note schema (overview, key points, 8-15 terms, assessable, open
   questions), not by how long the recording was. A one-minute clip
   produces very nearly the same summary cost as a fifty-minute lecture.
   So an allowance priced purely as minutes of transcription is wrong by
   roughly the number of recordings, not the number of minutes.

   At the measured values in _shared/credits.ts:

     one credit (a minute of recorded lecture)       ~ $0.000686
     summarising, typical  1,203 out + 1,600 in      ~ $0.00096
     summarising, ceiling  8,000 out (SUMMARY_MAX_TOKENS) ~ $0.0050

   One typical summary costs about 1.4 credits, so the floor needs to
   be 2.

   IT STAYS AT 3, and the currency collapse did not move it. Three
   credits buy about $0.0021 against a $0.00096 summary — a bit over 2x
   cover. Even a short LECTURE clip running twice as dense as the
   measured sample stays under it.

   The proposal to raise it to 4 came from a 2,800-token guess at the
   summariser's output that turned out to be 5.9x reality. Re-derived
   from the measurement there was no billing change to make, and there
   still is not.

   What it does to the pathological month (as many one-minute clips as
   the allowance permits) against a real timetable:

                                 transcription  summarising   total
     no floor, 300 clips            $0.20         $0.69       $0.89
     floor of 3, 100 clips          $0.067        $0.096      $0.163
     a real timetable
     (6 x 50-minute lectures)       $0.20         $0.014      $0.214

   Against the summariser's CEILING rather than a typical response the
   residual is larger, and that is left deliberately: covering it needs
   a floor around 11, which would charge a student recording a
   ten-minute tutorial segment for more than they used. The ceiling is
   also the case that FAILS rather than returning notes (see openai.ts),
   so it is not a mode anyone can usefully sit in.

   Every figure above is computed by scripts/test-ai-notes.mjs from the
   constants, so this table is a description of the arithmetic and not
   the arithmetic itself.

   NOTE FOR WHOEVER EDITS THIS FILE: the word the deploy greps for is a
   MACHINE MARKER, not vocabulary. Writing it in a sentence -- even to
   say something is not it -- blocks the function deploy. That happened
   once, while writing a comment explaining the marker. Say "unverified"
   or "estimated" in prose and keep the marker for the thing it marks. */
export const MINIMUM_BILLED_CREDITS = 3;

/* What a RE-SUMMARISE costs, in the one currency everything is billed
   in now.

   The student has already paid for the transcription — those credits
   were spent on the transcription provider and billed at the time, and
   the retry does not repeat them: no audio, no transcription call, no
   new provider minutes. What a retry really spends is one summariser
   request, so that is what it charges.

   DERIVED, not chosen. A typed number here would be the price of the
   product set by somebody's guess, which is precisely the mistake
   TYPICAL_SUMMARY_OUTPUT_TOKENS made at 5.9x reality. Rounded UP,
   unlike the text weights, because this is the one action a student
   takes when they have already been charged once for the same lecture
   and rounding that one down is the wrong direction to be generous in.

   IT IS DERIVED FOR A TYPICAL SHORT SUMMARY, and that is worth knowing
   before anyone reuses the figure: a three-hour transcript is 21x that
   input, so a retry of one really costs about 10 credits rather than 2.
   The answer to that was the failure precondition in index.ts — one
   retry per failure, and only after a failure — not a bigger number
   that would overcharge every ordinary retry. */
export const RESUMMARISE_BILLED_CREDITS = Math.max(1, Math.ceil(SUMMARY_REQ / CREDIT));

export const MAX_REQUEST_SECONDS = 3 * 3600;
export const PROCESSING_STALE_MINUTES = 10;

/* ---------- the upload ceiling, DERIVED FROM A MEASUREMENT ----------

   IT WAS DERIVED FROM AN ASSUMPTION AND THE ASSUMPTION WAS WRONG. The
   old figure came from "the client asks for 32 kbps, so 3h is 43.2MB,
   round up for container overhead". The client does ask for 32 kbps and
   Chrome delivers it — but iOS's Opus encoder FLOORS at about 51 kbps
   whatever it is asked for, measured on device with
   tools/measure-audio.html (row 1: 51 kbps; row 4, no bitrate
   requested, 202 kbps — so the option is honoured, just not below a
   floor).

   At 51 kbps a two-hour lecture is 45.9MB against a 46MB ceiling: a
   margin of 0.22%, which is no margin. Two hours is the stated use
   case, so the ceiling has to be re-derived rather than nudged. */

/* Measured, not assumed. One device, one iOS version — four samples
   agreeing to 1.0%, which is what makes an extrapolation from a short
   recording legitimate at all. Re-measure with tools/measure-audio.html
   if the recorder's format or constraints change. */
export const MEASURED_IOS_OPUS_BITS_PER_SECOND = 51_000;

/* WHY 25% AND NOT 5%. The 1.0% spread is WITHIN one device: it says the
   encoder is near-constant for a given platform, and nothing at all
   about a different iPhone, a different iOS version, or content that
   encodes harder. We have one measurement, so the headroom is covering
   the unmeasured axes rather than the measured one. 25% absorbs a
   meaningfully different encoder default without making the ceiling
   meaningless — and the asymmetry decides it: too tight loses a
   lecture, too loose costs a larger upload. */
export const UPLOAD_HEADROOM = 1.25;

/* WHAT THE DASHBOARD IS SET TO, as a constant rather than as folklore.

   Storage enforces its own per-file limit and it is the LOWER of two
   settings: a project-global limit and the bucket's own, which cannot
   exceed the global. Free projects cap at 50MB; Pro allows far more.
   BOTH have to be raised, in the dashboard, BEFORE this constant moves
   — the same widening-goes-first rule the migrations follow. Raising
   only the bucket does nothing, because the global still binds.

   Keeping the number here is what lets MAX_BODY_BYTES stay correct at
   every stage of that deployment instead of only at the end. */
/* 100 MB, set in BOTH places and read back after a reload — Jared,
   22 August 2026.

   100_000_000 rather than 104_857_600 because "100 MB" in a dashboard
   may mean either, and understating is the safe direction: a constant
   below the real limit refuses a little early with a clear message,
   while one above it waves uploads through to a slow, unexplained
   rejection from Storage. It makes no practical difference here — the
   derived figure binds well below both readings — which is exactly why
   the conservative one costs nothing.

   Verify with scripts/check-storage-limit.mjs. Reading the setting back
   confirms what was SAVED; only an upload confirms what is ENFORCED,
   and this is the setting whose whole reputation is appearing to have
   changed when it has not. */
export const LECTURE_AUDIO_FILE_LIMIT_BYTES = 100_000_000;

/* Our refusal must land BEFORE Storage's, or the student waits through
   the whole upload for an error that explains nothing. This is the
   room that buys. */
const STORAGE_REFUSAL_MARGIN_BYTES = 2_000_000;

/* Groq's documented file-size caps are stated for the `file` (direct
   upload) parameter; its docs point at the `url` parameter — which is
   what this app always uses, see groq.js — as the way to handle larger
   files, with no separate ceiling stated. If a real long recording is
   ever rejected by Groq, this is the constant to revisit alongside
   whether chunking is needed instead. */
export const MAX_BODY_BYTES = Math.min(
  Math.ceil((MEASURED_IOS_OPUS_BITS_PER_SECOND * MAX_REQUEST_SECONDS * UPLOAD_HEADROOM) / 8),
  LECTURE_AUDIO_FILE_LIMIT_BYTES - STORAGE_REFUSAL_MARGIN_BYTES
);

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
   in a month (the allowance is 450 CREDITS, so that is reachable) at 16k
   output tokens each is several dollars of summarising against twenty
   cents of transcription -- the summariser, not Whisper, would set the
   price of the product.

   8,000 STAYS, and the depth change did not move it. It was proposed at
   12,000 on the reasoning that a 3-hour lecture with a translation
   "lands around 6k" -- but that figure came from the same 2,800-token
   guess that turned out to be 5.9x reality, so raising the ceiling would
   have been swapping one extrapolation for another.

   THE RULE FOR WHEN IT MAY MOVE: on a MEASURED long lecture, not on an
   extrapolation from a short one. A 5-minute sample cannot say what a
   3-hour recording produces, and this constant only matters for long
   ones. Hitting it is a hard failure on a request whose transcription
   has already been billed, with no retry endpoint and the audio deleted
   -- so if a real long lecture ever does hit it, that measurement is the
   thing to act on, immediately and without further modelling.

   Hitting it is treated as a failure rather than silently returning
   truncated notes; see openai.ts. */
export const SUMMARY_MAX_TOKENS = 8000;

/* The two sentences the retry can end on, kept beside the constants
   they describe. Both name what was and was not charged, because a
   student who has already paid once for this lecture is owed the
   arithmetic — the same register as the failure screen's billing line.
   The client mirrors these in src/aiNotesCopy.js for the states it can
   describe without asking the server. */
export const RESUMMARISE_EXPIRED_MESSAGE =
  "We no longer have the transcript for this lecture, so it can't be summarised again. Nothing has been charged for this attempt.";
/* The retry's third ending, and it is a REFUSAL rather than a failure.

   Reachable two ways. A stale screen: the student has the failure
   screen open, the retry succeeded on another device, they tap again.
   And a client that asks for a retry on a lecture that never failed,
   which is what the precondition in index.ts exists to refuse — see the
   long note there for what it used to cost.

   It says the summary is there, because that is the good news, and it
   says nothing was charged, because a refusal never charges and a
   student who has already paid for this lecture once is owed the
   arithmetic every time it is mentioned. */
export const RESUMMARISE_NOT_FAILED_MESSAGE =
  "This lecture already has its summary, so there's nothing to write again. Nothing has been charged.";

export const RESUMMARISE_FAILED_MESSAGE =
  "We couldn't write the summary this time. Nothing has been charged for this attempt, and your transcript is still here — you can try again.";
