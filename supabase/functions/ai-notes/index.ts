// ai-notes — record a lecture, get an AI-generated summary and study
// cards. This is the only network entrypoint; the client never talks
// to Deepgram or OpenAI directly, and neither of those API keys ever
// reaches the browser (they only exist as Edge Function secrets).
//
// Request body is small JSON — the audio itself is uploaded straight
// from the browser to a private Storage bucket beforehand (see
// src/aiNotesClient.js uploadAudio), and this function is handed only
// the resulting storage path.

import { corsHeaders, jsonResponse } from "./_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { checkRequestGuards } from "./guards.js";
import { deepgramAdapter } from "./deepgram.ts";
import { openaiAdapter } from "./openai.ts";
import {
  MONTHLY_MINUTES_LIMIT,
  MAX_REQUEST_SECONDS,
  MAX_BODY_BYTES,
  PROCESSING_STALE_MINUTES,
  LECTURE_AUDIO_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  REQUEST_RETENTION_DAYS,
  ORPHAN_SWEEP_HOURS,
} from "./config.ts";

const TRANSCRIBERS: Record<string, typeof deepgramAdapter> = { deepgram: deepgramAdapter };
const SUMMARIZERS: Record<string, typeof openaiAdapter> = { openai: openaiAdapter };

function currentMonthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function markFailed(idempotencyKey: string) {
  await supabaseAdmin.from("ai_notes_requests").update({ status: "failed" }).eq("idempotency_key", idempotencyKey);
}

// Best-effort housekeeping that shouldn't add latency to the response.
function scheduleCleanup() {
  const run = async () => {
    const requestCutoff = new Date(Date.now() - REQUEST_RETENTION_DAYS * 86400_000).toISOString();
    await supabaseAdmin.from("ai_notes_requests").delete().lt("created_at", requestCutoff);

    const orphanCutoff = Date.now() - ORPHAN_SWEEP_HOURS * 3600_000;
    const { data: users } = await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).list("");
    for (const folder of users || []) {
      const { data: files } = await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).list(folder.name);
      const stale = (files || [])
        .filter((f) => f.created_at && new Date(f.created_at).getTime() < orphanCutoff)
        .map((f) => `${folder.name}/${f.name}`);
      if (stale.length) await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).remove(stale);
    }
  };
  // @ts-ignore -- EdgeRuntime is injected by the Supabase Edge Runtime;
  // fall back to a plain non-awaited call if it's not available.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(run().catch(() => {}));
  } else {
    run().catch(() => {});
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1-2. Verify the caller
    const authHeader = req.headers.get("authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ ok: false, code: "unauthenticated", error: "Please sign in again to use AI notes." }, 401);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ ok: false, code: "unauthenticated", error: "Please sign in again to use AI notes." }, 401);
    }
    const userId = userData.user.id;

    // 3. Tier check. A missing row is an anomaly (the signup trigger should
    // always create one) — still 403 no_access either way, no user-facing
    // difference, but worth a log line since it means the trigger didn't run.
    const { data: profile } = await supabaseAdmin.from("profiles").select("tier").eq("user_id", userId).maybeSingle();
    if (!profile) console.error(`ai-notes: no profiles row for user ${userId} — signup trigger may have failed`);
    if (!profile || profile.tier !== "ai") {
      return jsonResponse({ ok: false, code: "no_access", error: "AI notes isn't enabled for your account yet." }, 403);
    }

    // 4. Parse the (small, JSON-only) request body.
    const body = await req.json();
    const { path, mimeType, course, week, translateTo, estimatedDurationSeconds, idempotencyKey } = body || {};
    if (!path || !idempotencyKey) {
      return jsonResponse({ ok: false, code: "bad_request", error: "Missing recording details." }, 400);
    }

    // 5. Race-safe idempotency claim.
    const { error: insertErr } = await supabaseAdmin
      .from("ai_notes_requests")
      .insert({ idempotency_key: idempotencyKey, user_id: userId, status: "processing" });

    if (insertErr) {
      // 23505 = unique_violation: someone already holds this key.
      if (insertErr.code !== "23505") {
        return jsonResponse({ ok: false, code: "server_error", error: "Something went wrong. Please try again." }, 500);
      }
      const { data: existing } = await supabaseAdmin
        .from("ai_notes_requests")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .single();

      if (existing?.status === "done") {
        return jsonResponse({ ok: true, result: existing.result });
      }
      if (existing?.status === "processing") {
        const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MINUTES * 60_000).toISOString();
        const { data: reclaimed } = await supabaseAdmin
          .from("ai_notes_requests")
          .update({ status: "processing", created_at: new Date().toISOString() })
          .eq("idempotency_key", idempotencyKey)
          .eq("status", "processing")
          .lt("created_at", staleCutoff)
          .select();
        if (!reclaimed || reclaimed.length === 0) {
          return jsonResponse({ ok: false, code: "already_processing", error: "This recording is already being processed — try again shortly." }, 409);
        }
        // else: reclaimed the abandoned row, fall through and proceed.
      } else if (existing?.status === "failed") {
        const { data: reclaimed } = await supabaseAdmin
          .from("ai_notes_requests")
          .update({ status: "processing" })
          .eq("idempotency_key", idempotencyKey)
          .eq("status", "failed")
          .select();
        if (!reclaimed || reclaimed.length === 0) {
          return jsonResponse({ ok: false, code: "already_processing", error: "This recording is already being processed — try again shortly." }, 409);
        }
      }
    }

    // 6. Real, server-measured size of the uploaded object.
    const lastSlash = path.lastIndexOf("/");
    const folder = path.slice(0, lastSlash);
    const filename = path.slice(lastSlash + 1);
    const { data: listing } = await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).list(folder, { search: filename });
    const objectMeta = (listing || []).find((f) => f.name === filename);
    if (!objectMeta) {
      await markFailed(idempotencyKey);
      return jsonResponse({ ok: false, code: "recording_missing", error: "We couldn't find that recording — please record it again." }, 404);
    }
    const receivedBytes = objectMeta.metadata?.size || 0;

    // 7. Duration/allowance guard — the logic that decides whether we pay
    // money, exercised directly by scripts/test-ai-notes.mjs.
    const month = currentMonthKey();
    const { data: usageRow } = await supabaseAdmin
      .from("ai_usage")
      .select("minutes_used")
      .eq("user_id", userId)
      .eq("month", month)
      .maybeSingle();
    const minutesUsedThisMonth = usageRow?.minutes_used || 0;

    const guard = checkRequestGuards({
      estimatedDurationSeconds: estimatedDurationSeconds || 0,
      receivedBytes,
      minutesUsedThisMonth,
      monthlyLimitMinutes: MONTHLY_MINUTES_LIMIT,
      maxRequestSeconds: MAX_REQUEST_SECONDS,
      maxBodyBytes: MAX_BODY_BYTES,
    });
    if (!guard.ok) {
      // Left in place deliberately (not deleted) — a permanent-not-transient
      // failure, cleaned up later by the orphan sweep (step 14b).
      await markFailed(idempotencyKey);
      return jsonResponse({ ok: false, code: guard.code, error: guard.error }, guard.code === "usage_exceeded" ? 403 : 413);
    }

    // 8. Sign a short-lived URL rather than downloading — the function
    // never allocates the audio in memory at all.
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(LECTURE_AUDIO_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      await markFailed(idempotencyKey);
      return jsonResponse({ ok: false, code: "recording_missing", error: "We couldn't find that recording — please record it again." }, 404);
    }

    // 9. Transcribe. Object is left in place on failure so a retry can
    // reuse it (no re-upload needed).
    const transcriber = TRANSCRIBERS[Deno.env.get("AI_NOTES_TRANSCRIPTION_PROVIDER") || "deepgram"] || deepgramAdapter;
    let transcript = "";
    let durationSeconds = 0;
    try {
      const result = await transcriber.transcribe({ audioUrl: signed.signedUrl, apiKey: Deno.env.get("DEEPGRAM_API_KEY")! });
      transcript = result.transcript;
      durationSeconds = result.durationSeconds || estimatedDurationSeconds || 0;
    } catch (err) {
      await markFailed(idempotencyKey);
      return jsonResponse({ ok: false, code: "transcription_failed", error: "We couldn't transcribe that recording. Please try again." }, 502);
    }

    // 10. Transcription succeeded — delete the object now. This is the one
    // and only success-path delete, and what fulfills "audio isn't retained".
    const { error: removeErr } = await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).remove([path]);
    if (removeErr) console.error(`ai-notes: failed to delete ${path} after successful transcription`, removeErr);

    // 11. Summarize. On failure, don't discard the transcript — Deepgram
    // already succeeded and is about to be billed regardless.
    const summarizer = SUMMARIZERS[Deno.env.get("AI_NOTES_SUMMARY_PROVIDER") || "openai"] || openaiAdapter;
    let result: Record<string, unknown>;
    try {
      const summary = await summarizer.summarize({ transcript, translateTo, apiKey: Deno.env.get("OPENAI_API_KEY")! });
      result = { ok: true, transcript, summaryFailed: false, original: summary.original, translated: summary.translated };
    } catch (err) {
      result = { ok: true, transcript, summaryFailed: true, original: null, translated: null };
    }

    // 12. Bill usage using the server-reported Deepgram duration.
    const minutesBilled = durationSeconds / 60;
    await supabaseAdmin.from("ai_usage").upsert(
      { user_id: userId, month, minutes_used: minutesUsedThisMonth + minutesBilled, updated_at: new Date().toISOString() },
      { onConflict: "user_id,month" }
    );

    // 13. Mark the request done.
    await supabaseAdmin
      .from("ai_notes_requests")
      .update({ status: "done", result, minutes_billed: minutesBilled })
      .eq("idempotency_key", idempotencyKey);

    // 14. Best-effort housekeeping, doesn't block the response.
    scheduleCleanup();

    // 15. Done.
    return jsonResponse({ ok: true, result });
  } catch (err) {
    console.error("ai-notes: unhandled error", err);
    return jsonResponse({ ok: false, code: "server_error", error: "Something went wrong. Please try again." }, 500);
  }
});
