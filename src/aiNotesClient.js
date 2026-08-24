/* ==================================================================
   aiNotesClient.js — network/Supabase calls for AI lecture notes

   Kept separate from aiNotes.jsx so it's easy to mock in tests, and
   separate from aiNotesLogic.js because everything here does real
   network/Storage I/O (aiNotesLogic.js stays pure).
   ================================================================== */

import { supabase, backend } from "./sync.js";
import { allowanceForTier } from "./aiTextLimits.js";
import { MINIMUM_BILLED_CREDITS_HINT, uploadRefusal } from "./aiNotesLogic.js";
import { deviceStanding } from "./deviceIdentity.js";
import { getDeviceId } from "./sync.js";
import { AI_NOTES_COPY } from "./aiNotesCopy.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const BUCKET = "lecture-audio";

/** "YYYY-MM" in UTC, matching how the Edge Function keys ai_usage rows. */
export function currentMonthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Reads the signed-in user's own ai_usage row for the current month.
 * Deliberately can't crash: sync.js only creates a real Supabase client
 * when src/config.js has real project details (`isConfigured`), so
 * other deployments of this app template can still be running in demo
 * mode, where `supabase` is `null`. `supabaseClient`/`isDemo` are
 * injectable so this is testable without a real client.
 */
export async function fetchUsage(session, { supabaseClient = supabase, isDemo = backend.isDemo } = {}) {
  if (!session || isDemo || !supabaseClient) {
    return { creditsUsed: 0, tier: null, unavailable: true };
  }
  /* THE TIER DECIDES WHICH COUNTER TO READ, so it is read first rather
     than assumed. A trial tier's spend is a column on `profiles` with
     no month in it; a monthly tier's is a row in `ai_usage`. Reading
     ai_usage for a trial account would report 0 used forever, which is
     the friendly-looking direction and the wrong one. */
  const { data: profile, error: profileErr } = await supabaseClient
    .from("profiles")
    /* The device columns ride along on a read that already happens, so
       the one-device rule costs no extra query — the same argument that
       put the trial counter on `profiles` rather than in `ai_usage`.
       It also puts the check exactly where the allowance is SPENT,
       which is the thing the rule exists to protect. */
    .select("tier, trial_credits_used, active_device_id, active_device_at")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (profileErr || !profile) return { creditsUsed: 0, tier: null, unavailable: true };

  /* Reported, never acted on here. A client module that signed someone
     out as a side effect of reading a counter would be impossible to
     reason about; the caller decides, and the four outcomes survive
     intact all the way up. */
  const standing = deviceStanding({ tier: profile.tier, localId: getDeviceId(), profile });

  if (!allowanceForTier(profile.tier).perMonth) {
    return {
      creditsUsed: Number(profile.trial_credits_used) || 0,
      tier: profile.tier,
      unavailable: false,
      standing,
    };
  }

  const { data, error } = await supabaseClient
    .from("ai_usage")
    .select("credits_used")
    .eq("user_id", session.user.id)
    .eq("month", currentMonthKey())
    .maybeSingle();
  /* A FAILED READ IS "UNKNOWN", NEVER "NONE LEFT". Same rule as
     fetchNote and the archive list: the badge disappears rather than
     telling a student on a train that they are out of credits. */
  if (error) return { creditsUsed: 0, tier: profile.tier, unavailable: true, standing };
  return { creditsUsed: (data && data.credits_used) || 0, tier: profile.tier, unavailable: false, standing };
}

/**
 * Whether this account can record lectures at all. Three answers, and
 * the third is the one that must not collapse into the second:
 *
 *   { canRecord: true }               there is allowance left
 *   { canRecord: false }              the read RAN and there is none
 *   { unknown: true }                 offline / demo / read failed
 *
 * IT IS NO LONGER A TIER CHECK. Every tier can record now — a free
 * account gets the 60-credit lifetime trial, which is what lets the
 * trial demonstrate the thing being sold — so what this asks is whether
 * the ALLOWANCE covers one recording, not which plan somebody is on.
 *
 * UNKNOWN MUST NEVER GATE. A student in a lecture theatre with no
 * signal must not be shown a paywall because the read timed out -- that
 * is the same rule as the text allowance ("a failed read degrades to
 * unknown, never to none left"). The server re-checks anyway, BEFORE
 * the paid transcription call; this read only exists so a refusal
 * arrives before an hour of recording rather than after it.
 */
export async function fetchRecordingAccess(session, { supabaseClient = supabase, isDemo = backend.isDemo } = {}) {
  if (!session || isDemo || !supabaseClient) return { unknown: true };
  try {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("tier, trial_credits_used")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (error || !data) return { unknown: true };
    const { credits: limit, perMonth } = allowanceForTier(data.tier);
    if (!perMonth) {
      const used = Number(data.trial_credits_used) || 0;
      return { canRecord: used + MINIMUM_BILLED_CREDITS_HINT <= limit, tier: data.tier };
    }
    /* A monthly tier's spend needs the usage row, and a failed read of
       THAT is unknown too rather than a refusal. */
    const usage = await fetchUsage(session, { supabaseClient, isDemo });
    if (usage.unavailable) return { unknown: true };
    return { canRecord: usage.creditsUsed + MINIMUM_BILLED_CREDITS_HINT <= limit, tier: data.tier };
  } catch (e) {
    return { unknown: true };
  }
}

/* EXTENSION_FOR_MIME IS GONE, and it was the isFree/perMonth shape
   again: a second name for a fact CANDIDATE_MIME_TYPES already holds.

   pickSupportedMimeType() returns `{ mimeType, extension }` — the pair
   the recorder chose — and the extension half was thrown away, then
   re-derived here from a map keyed by exact mime string with
   `|| "webm"` behind it. Two consequences, and the second is the one
   that would have bitten: the map had to be edited in step with a list
   in another file, and a mime string that did not match a key EXACTLY
   stored the object as .webm whatever it really contained. Adding
   "audio/mp4; codecs=mp4a.40.2" — the string the iOS comparison wants —
   would have written AAC bytes to a .webm path, which the server
   allowlists and Groq sniffs, so nothing would have failed and the
   stored path would simply have been a lie.

   The extension now travels with the mime type it belongs to, so a
   per-platform preference is a reorder of ONE array and nothing else
   has to follow it. */

/**
 * Uploads the recorded audio straight to a private Storage bucket
 * (authenticated as the user, RLS-scoped to their own folder — see
 * supabase/migrations/0001_ai_notes.sql). The audio never passes
 * through the Edge Function's request body at all.
 *
 * `upsert: true` (backed by the bucket's `update` RLS policy) is what
 * lets a retry re-create the object at the same key if the Edge
 * Function ever reports `recording_missing`.
 */
export async function uploadAudio({ session, audioBlob, mimeType, extension, idempotencyKey, supabaseClient = supabase }) {
  /* The session check is not redundant with the client check. `supabase`
     is non-null for every user of the real build, signed in or not --
     `isConfigured` is about whether the project is set up, not about
     who is using it. Without this, a signed-out upload would fail on
     `session.user.id` being undefined, which is a crash rather than a
     refusal and would have put the audio on the wire first if the path
     had ever been built differently. */
  if (!supabaseClient || !session || !session.user) throw new Error("AI notes needs a real signed-in account.");
  /* THE SIZE GATE AT THE BOUNDARY, not only on the screen. The caller
     checks too, so this never fires in the normal flow — which is
     exactly the arrangement the signed-out AI gates use, and for the
     same reason: a UI-only check is one refactor away from leaking,
     and the refactor need not touch this file. */
  const refusal = uploadRefusal(audioBlob && audioBlob.size);
  if (refusal) {
    const err = new Error(AI_NOTES_COPY.tooLarge(refusal).title);
    err.code = refusal.code;
    throw err;
  }
  /* No fallback, deliberately. A missing extension means the caller
     did not carry the recorder's own choice through, and guessing
     "webm" is how the object comes to disagree with its contents. */
  if (!extension) throw new Error("The recording's file type is missing — please try recording again.");
  const path = `${session.user.id}/${idempotencyKey}.${extension}`;
  const { error } = await supabaseClient.storage.from(BUCKET).upload(path, audioBlob, { contentType: mimeType, upsert: true });
  if (error) throw new Error(error.message || "Couldn't upload the recording.");
  return path;
}

/**
 * Calls the ai-notes Edge Function with just metadata (never the audio)
 * and returns its parsed JSON result. `fetchImpl` is injectable so this
 * is testable with a mocked fetch.
 *
 * The storage path is deliberately NOT sent. The function derives it from
 * the verified user id and the idempotency key, so a path in the request
 * would be an attacker-controlled input pointing at the service-role
 * storage client. Uploading still needs the path locally -- see
 * uploadAudio -- it just isn't part of this contract.
 *
 * `mimeType` and `week` are gone for a duller reason: the function never
 * read either. A field that is parsed but unused invites someone to start
 * trusting it later, which is how the path became a vulnerability. `week`
 * can come back if it earns its place, validated.
 */
export async function callAiNotes(
  { token, course, translateTo, idempotencyKey, estimatedDurationSeconds },
  fetchImpl = fetch
) {
  // Same reasoning as callAiText: the gate belongs at the boundary, not
  // only on the panel. AiNotesPanel already refuses without a session --
  // this is what makes that refusal a property of the code rather than
  // of one component's early return.
  if (!token) {
    const err = new Error("Please sign in again to use AI notes.");
    err.code = "unauthenticated";
    throw err;
  }
  const res = await fetchImpl(`${SUPABASE_URL}/functions/v1/ai-notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ course, translateTo, idempotencyKey, estimatedDurationSeconds }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* non-JSON error body */
  }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && json.error) || `Request failed (${res.status})`);
    err.code = json && json.code;
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json.result;
}

/**
 * Re-summarise a lecture whose transcription succeeded and whose
 * summary failed.
 *
 * Sends nothing but the key: the transcript is already on the server,
 * scoped to its owner, so a retry needs no audio, no upload and no
 * transcription. The server charges only the summarising cost.
 *
 * The gate is at the boundary for the same reason as `callAiNotes` —
 * a UI-only check is one refactor from leaking.
 */
export async function callResummarise({ token, idempotencyKey, translateTo }, fetchImpl = fetch) {
  if (!token) {
    const err = new Error("Please sign in again to use AI notes.");
    err.code = "unauthenticated";
    throw err;
  }
  const res = await fetchImpl(`${SUPABASE_URL}/functions/v1/ai-notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ mode: "resummarise", idempotencyKey, translateTo }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* non-JSON error body */
  }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && json.error) || `Request failed (${res.status})`);
    err.code = json && json.code;
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { result: json.result, minutesBilled: json.minutesBilled };
}
