/* ==================================================================
   guards.js — the logic that decides whether we pay money

   Plain JS, no Deno or Node-only APIs, so this one file is imported
   unmodified by both the Edge Function (Deno) and the Node test
   script (scripts/test-ai-notes.mjs) — no TypeScript toolchain needed
   on the Node side just for this.
   ================================================================== */

/**
 * @param {object} args
 * @param {number} args.estimatedDurationSeconds - client-supplied, can be
 *   faked; used only as a cheap early exit, never trusted for billing.
 * @param {number} args.receivedBytes - server-measured (the Storage
 *   object's real size); this is the authoritative check.
 * @param {number} args.minutesUsedThisMonth
 * @param {number} args.monthlyLimitMinutes
 * @param {number} args.maxRequestSeconds
 * @param {number} args.maxBodyBytes
 * @returns {{ok: true} | {ok: false, code: string, error: string}}
 */
export function checkRequestGuards({
  estimatedDurationSeconds,
  receivedBytes,
  minutesUsedThisMonth,
  monthlyLimitMinutes,
  maxRequestSeconds,
  maxBodyBytes,
  minimumBilledMinutes = 0,
}) {
  if (typeof receivedBytes === "number" && receivedBytes > maxBodyBytes) {
    return { ok: false, code: "recording_too_long", error: "Recordings are limited to about 3 hours." };
  }
  if (typeof estimatedDurationSeconds === "number" && estimatedDurationSeconds > maxRequestSeconds) {
    return { ok: false, code: "recording_too_long", error: "Recordings are limited to about 3 hours." };
  }
  /* Projected with the SAME floor billing uses. Checking the raw length
     here and charging the floor later would let a student at 299 minutes
     start a recording the allowance can't actually pay for -- a small
     overrun, but the kind that makes the number on screen untrue. */
  const projectedMinutes =
    (minutesUsedThisMonth || 0) + billedMinutes(estimatedDurationSeconds, minimumBilledMinutes);
  if (projectedMinutes > monthlyLimitMinutes) {
    return { ok: false, code: "usage_exceeded", error: "You've used all your AI minutes for this month." };
  }
  return { ok: true };
}

/**
 * Which transcription adapter a request should use. Pulled out as a pure
 * lookup (not inlined in index.ts) so "switching provider in config
 * actually changes which adapter gets called" is a directly-tested
 * property, not just something asserted by reading the code. Falls back
 * to `defaultProvider` if `requestedProvider` is missing or unknown.
 */
export function selectTranscriber(providers, requestedProvider, defaultProvider) {
  return providers[requestedProvider] || providers[defaultProvider];
}

/**
 * Seconds -> minutes billed. The one calculation between "how long was
 * this recording" (whatever a provider reports) and "how much of the
 * user's allowance did it use." Pulled out so a provider's reported
 * duration is proven to flow through to the usage number correctly,
 * rather than just assumed by reading index.ts.
 */
export function minutesFromSeconds(durationSeconds) {
  return (durationSeconds || 0) / 60;
}

/**
 * What a recording actually costs the allowance.
 *
 * `minutesFromSeconds` answers "how long was this"; this answers "how
 * much of the month did it use", and they are deliberately different
 * functions. Summarising is charged per request and its cost barely
 * depends on length, so a one-minute recording that billed one minute
 * would be sold at roughly an eighth of what it costs — see
 * MINIMUM_BILLED_MINUTES in config.ts for the arithmetic.
 *
 * A zero or missing duration bills ZERO, not the floor. That case means
 * the provider's response changed shape, and inventing three minutes for
 * it would paper over a fault the logs are meant to surface. It is a
 * revenue hole and it is the right one to leave open, because it is
 * bounded by how often a provider breaks rather than by how often a user
 * chooses something.
 */
export function billedMinutes(durationSeconds, minimumMinutes) {
  const actual = minutesFromSeconds(durationSeconds);
  if (!(actual > 0)) return 0;
  return Math.max(actual, minimumMinutes || 0);
}

/* Idempotency keys go into `ai_notes_requests.idempotency_key`, which is
   typed `uuid`. Postgres rejects anything else with 22P02 — an error that
   surfaces as a failed insert rather than as a validation message, so it
   reads like a server fault when it is a malformed request. Checking the
   shape first turns that into a clean 400.

   Accepts any RFC 4122 version, not just v4: the client mints v4, but a
   well-formed v1 or v7 from some future client is still a perfectly valid
   key and the column would accept it. The point is to catch "not a UUID
   at all", which is the actual failure. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a well-formed UUID string. */
export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}


/* Course names reach the transcription provider as a vocabulary hint, so
   they are capped and stripped of anything that isn't ordinary text.
   Newlines and control characters go because the hint is a single line;
   the cap is there so an unbounded string can't be posted into a paid
   API call. */
export function sanitizeCourse(course, maxLength) {
  if (typeof course !== "string") return "";
  return course
    .replace(/[\u0000-\u001F\u007F]/g, " ") // control characters, incl. newlines and tabs
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * The requested translation language, or null.
 *
 * Anything not on the allowlist becomes null — no translation — rather
 * than an error: the app's own UI can only produce valid codes, so an
 * invalid one means a hand-built request, and failing the whole recording
 * over it would be a worse outcome than simply not translating.
 */
export function normalizeTranslateTo(value, allowed) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  return (allowed || []).includes(code) ? code : null;
}
