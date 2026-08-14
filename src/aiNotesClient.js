/* ==================================================================
   aiNotesClient.js — network/Supabase calls for AI lecture notes

   Kept separate from aiNotes.jsx so it's easy to mock in tests, and
   separate from aiNotesLogic.js because everything here does real
   network/Storage I/O (aiNotesLogic.js stays pure).
   ================================================================== */

import { supabase, backend } from "./sync.js";
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
    return { minutesUsed: 0, unavailable: true };
  }
  const { data, error } = await supabaseClient
    .from("ai_usage")
    .select("minutes_used")
    .eq("user_id", session.user.id)
    .eq("month", currentMonthKey())
    .maybeSingle();
  if (error) return { minutesUsed: 0, unavailable: true };
  return { minutesUsed: (data && data.minutes_used) || 0, unavailable: false };
}

const EXTENSION_FOR_MIME = { "audio/webm;codecs=opus": "webm", "audio/webm": "webm", "audio/mp4": "m4a", "audio/aac": "aac" };

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
export async function uploadAudio({ session, audioBlob, mimeType, idempotencyKey, supabaseClient = supabase }) {
  /* The session check is not redundant with the client check. `supabase`
     is non-null for every user of the real build, signed in or not --
     `isConfigured` is about whether the project is set up, not about
     who is using it. Without this, a signed-out upload would fail on
     `session.user.id` being undefined, which is a crash rather than a
     refusal and would have put the audio on the wire first if the path
     had ever been built differently. */
  if (!supabaseClient || !session || !session.user) throw new Error("AI notes needs a real signed-in account.");
  const extension = EXTENSION_FOR_MIME[mimeType] || "webm";
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
