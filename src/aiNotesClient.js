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
  if (!supabaseClient) throw new Error("AI notes needs a real signed-in account.");
  const extension = EXTENSION_FOR_MIME[mimeType] || "webm";
  const path = `${session.user.id}/${idempotencyKey}.${extension}`;
  const { error } = await supabaseClient.storage.from(BUCKET).upload(path, audioBlob, { contentType: mimeType, upsert: true });
  if (error) throw new Error(error.message || "Couldn't upload the recording.");
  return path;
}

/**
 * Calls the ai-notes Edge Function with just metadata (the storage
 * path, not the audio itself) and returns its parsed JSON result.
 * `fetchImpl` is injectable so this is testable with a mocked fetch.
 */
export async function callAiNotes(
  { token, path, mimeType, course, week, translateTo, idempotencyKey, estimatedDurationSeconds },
  fetchImpl = fetch
) {
  const res = await fetchImpl(`${SUPABASE_URL}/functions/v1/ai-notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ path, mimeType, course, week, translateTo, idempotencyKey, estimatedDurationSeconds }),
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
