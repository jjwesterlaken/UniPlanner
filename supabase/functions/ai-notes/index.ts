// ai-notes — record a lecture, get an AI-generated summary and study
// cards. This is the only network entrypoint; the client never talks
// to the transcription provider (Groq by default, Deepgram also
// supported) or OpenAI directly, and none of those API keys ever
// reach the browser (they only exist as Edge Function secrets).
//
// Request body is small JSON — the audio itself is uploaded straight
// from the browser to a private Storage bucket beforehand (see
// src/aiNotesClient.js uploadAudio), and this function is handed only
// the resulting storage path.

import { corsHeaders, jsonResponse } from "./_shared/cors.ts";
import { supabaseAdmin, getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { requiredEnvNames, missingEnv, envPresence, failureLine, stageLine } from "./diagnostics.js";
import { checkRequestGuards, selectTranscriber, minutesFromSeconds, isUuid } from "./guards.js";
import { deepgramAdapter } from "./deepgram.js";
import { groqAdapter } from "./groq.js";
import { openaiAdapter } from "./openai.ts";
import {
  TRANSCRIPTION_PROVIDER,
  PROVIDER_API_KEY_ENV,
  MONTHLY_MINUTES_LIMIT,
  MAX_REQUEST_SECONDS,
  MAX_BODY_BYTES,
  PROCESSING_STALE_MINUTES,
  LECTURE_AUDIO_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  REQUEST_RETENTION_DAYS,
  ORPHAN_SWEEP_HOURS,
} from "./config.ts";

// deno-lint-ignore no-explicit-any
const TRANSCRIBERS: Record<string, any> = { deepgram: deepgramAdapter, groq: groqAdapter };
const SUMMARIZERS: Record<string, typeof openaiAdapter> = { openai: openaiAdapter };

function currentMonthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* Diagnostics helpers. `stage` is threaded through the handler so a
   failure says how far the request got, in the logs and in the response.
   Nothing here prints a value from the environment, a JWT, the signed
   audio URL, or transcript text — see diagnostics.js. */

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra));

// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  console.error(failureLine(stage, err, extra));

/** Error response that also carries the stage, for debugging. The user-facing `error` string is untouched. */
const errorResponse = (stage: string, code: string, error: string, status: number) =>
  jsonResponse({ ok: false, code, stage, error }, status);

/* The one rejection used for BOTH a malformed idempotency key and a
   well-formed key that belongs to somebody else.

   Deliberately identical — same status, same code, same stage, same
   message. If the two differed in any observable way, the endpoint would
   answer "does this key exist?" for any key an attacker cared to try.
   The two cases are told apart in the logs, never in the response. */
const rejectIdempotencyKey = () =>
  errorResponse("idempotency_insert", "bad_idempotency_key", "Please reload the app and try recording again.", 400);

async function markFailed(idempotencyKey: string, userId: string) {
  // Its own catch: this runs on paths that are already failing, and an
  // exception here would replace the real error with a less useful one.
  // Scoped by user_id like every other service-role write: the key alone
  // is a shared token, not proof of ownership.
  try {
    await supabaseAdmin
      .from("ai_notes_requests")
      .update({ status: "failed" })
      .eq("idempotency_key", idempotencyKey)
      .eq("user_id", userId);
  } catch (err) {
    logFailure("mark_failed", err);
  }
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

  // Tracks how far we got. The outer catch reports it, so an unexpected
  // throw is attributable to a step instead of to the whole function.
  let stage = "env_check";

  try {
    // 0. Environment. Checked before anything touches the service-role
    // client, because a client built with a missing key throws during
    // module evaluation — outside this try/catch, where nothing can log
    // it. Names only, never values.
    const provider = Deno.env.get("AI_NOTES_TRANSCRIPTION_PROVIDER") || TRANSCRIPTION_PROVIDER;
    const required = requiredEnvNames(provider);
    const absent = missingEnv(required, (n: string) => Deno.env.get(n));
    logStage("env_check", { provider, present: envPresence(required, (n: string) => Deno.env.get(n)) });
    if (absent.length > 0) {
      logFailure("env_check", new Error(`missing environment variables: ${absent.join(", ")}`), { missing: absent });
      return errorResponse("env_check", "server_error", "Something went wrong. Please try again.", 500);
    }
    if (!LECTURE_AUDIO_BUCKET) {
      logFailure("env_check", new Error("LECTURE_AUDIO_BUCKET is empty in config.ts"));
      return errorResponse("env_check", "server_error", "Something went wrong. Please try again.", 500);
    }

    // 0b. Build the service-role client explicitly, so a failure here is
    // reported as client_init rather than surfacing later as whichever
    // query happened to touch it first.
    stage = "client_init";
    logStage(stage);
    try {
      getSupabaseAdmin();
    } catch (err) {
      logFailure("client_init", err);
      return errorResponse("client_init", "server_error", "Something went wrong. Please try again.", 500);
    }

    // 1-2. Verify the caller
    stage = "auth_user";
    logStage(stage);
    const authHeader = req.headers.get("authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return errorResponse("auth_user", "unauthenticated", "Please sign in again to use AI notes.", 401);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      // Logged because a service-role client that can't reach auth at all
      // looks identical, from the client, to a genuinely expired token.
      logFailure("auth_user", userErr || new Error("no user on a token that verified"));
      return errorResponse("auth_user", "unauthenticated", "Please sign in again to use AI notes.", 401);
    }
    const userId = userData.user.id;

    // 3. Tier check.
    stage = "tier_lookup";
    logStage(stage);
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("tier")
      .eq("user_id", userId)
      .maybeSingle();

    // A failed query and an absent row both leave `profile` null. Treating
    // them alike reports a broken database as "your account isn't
    // enabled", which sends everyone looking in the wrong place.
    if (profileErr) {
      logFailure("tier_lookup", profileErr);
      return errorResponse("tier_lookup", "server_error", "Something went wrong. Please try again.", 500);
    }
    if (!profile) {
      // An anomaly rather than a crash: maybeSingle() returns null instead
      // of throwing, and the signup trigger should always have made a row.
      logFailure("tier_lookup", new Error("no profiles row for this user — the signup trigger may not have run"));
      return errorResponse("tier_lookup", "no_access", "AI notes isn't enabled for your account yet.", 403);
    }
    if (profile.tier !== "ai") {
      logStage("tier_lookup", { outcome: "not_entitled" });
      return errorResponse("tier_lookup", "no_access", "AI notes isn't enabled for your account yet.", 403);
    }

    // 4. Parse the (small, JSON-only) request body.
    const body = await req.json();
    const { path, mimeType, course, week, translateTo, estimatedDurationSeconds, idempotencyKey } = body || {};
    if (!path || !idempotencyKey) {
      logFailure("idempotency_insert", new Error("request body missing path or idempotencyKey"), {
        hasPath: Boolean(path),
        hasKey: Boolean(idempotencyKey),
      });
      return errorResponse("idempotency_insert", "bad_request", "Missing recording details.", 400);
    }

    // idempotency_key is a `uuid` column. A non-UUID reaches Postgres as
    // 22P02 "invalid input syntax", which fails the insert and reads like
    // a server fault — so it is checked here and reported as what it is:
    // a malformed request. The key is logged because it is a
    // client-generated identifier, not a credential, and its shape is the
    // whole diagnosis.
    if (!isUuid(idempotencyKey)) {
      logFailure("idempotency_insert", new Error("idempotencyKey is not a UUID"), {
        received: String(idempotencyKey).slice(0, 64),
      });
      return rejectIdempotencyKey();
    }

    // 5. Race-safe idempotency claim.
    stage = "idempotency_insert";
    logStage(stage);
    const { error: insertErr } = await supabaseAdmin
      .from("ai_notes_requests")
      .insert({ idempotency_key: idempotencyKey, user_id: userId, status: "processing" });

    if (insertErr) {
      // 23505 = unique_violation: someone already holds this key.
      if (insertErr.code !== "23505") {
        // The insert uses the service-role client, so RLS is bypassed and
        // this is a genuine schema/connection failure, not a policy denial.
        logFailure("idempotency_insert", insertErr);
        return errorResponse("idempotency_insert", "server_error", "Something went wrong. Please try again.", 500);
      }
      /* Scoped to the caller. supabaseAdmin is the service-role client,
         so RLS is bypassed and the ownership check the policy would have
         applied has to be written here instead. Without the user_id
         filter this returned `result` -- a full transcript and summary --
         to anyone presenting a key that already had a completed row. */
      const { data: existing } = await supabaseAdmin
        .from("ai_notes_requests")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .eq("user_id", userId)
        .maybeSingle();

      if (!existing) {
        // The key is taken (23505) but not by this user. Rejected exactly
        // as a malformed key is, so the response reveals nothing about
        // whether the key exists or who holds it.
        logFailure("idempotency_insert", new Error("idempotency key is held by another user"), {
          outcome: "not_owner",
        });
        return rejectIdempotencyKey();
      }

      if (existing.status === "done") {
        return jsonResponse({ ok: true, result: existing.result });
      }
      if (existing.status === "processing") {
        const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MINUTES * 60_000).toISOString();
        const { data: reclaimed } = await supabaseAdmin
          .from("ai_notes_requests")
          .update({ status: "processing", created_at: new Date().toISOString() })
          .eq("idempotency_key", idempotencyKey)
          .eq("user_id", userId)
          .eq("status", "processing")
          .lt("created_at", staleCutoff)
          .select();
        if (!reclaimed || reclaimed.length === 0) {
          return errorResponse("idempotency_insert", "already_processing", "This recording is already being processed — try again shortly.", 409);
        }
        // else: reclaimed the abandoned row, fall through and proceed.
      } else if (existing.status === "failed") {
        const { data: reclaimed } = await supabaseAdmin
          .from("ai_notes_requests")
          .update({ status: "processing" })
          .eq("idempotency_key", idempotencyKey)
          .eq("user_id", userId)
          .eq("status", "failed")
          .select();
        if (!reclaimed || reclaimed.length === 0) {
          return errorResponse("idempotency_insert", "already_processing", "This recording is already being processed — try again shortly.", 409);
        }
      }
    }

    // 6. Real, server-measured size of the uploaded object.
    stage = "size_guard";
    logStage(stage);
    const lastSlash = path.lastIndexOf("/");
    const folder = path.slice(0, lastSlash);
    const filename = path.slice(lastSlash + 1);
    const { data: listing } = await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).list(folder, { search: filename });
    const objectMeta = (listing || []).find((f) => f.name === filename);
    if (!objectMeta) {
      // Path is logged: it is a storage key of the form "<user>/<uuid>.webm",
      // not audio and not a credential, and it is the one thing that makes
      // a missing upload diagnosable.
      logFailure("size_guard", new Error("uploaded object not found in the bucket"), { bucket: LECTURE_AUDIO_BUCKET });
      await markFailed(idempotencyKey, userId);
      return errorResponse("size_guard", "recording_missing", "We couldn't find that recording — please record it again.", 404);
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
      // Expected outcome, not a fault — logged at stage level so the logs
      // still show why a request stopped here.
      logStage("size_guard", { rejected: guard.code });
      await markFailed(idempotencyKey, userId);
      return errorResponse("size_guard", guard.code, guard.error, guard.code === "usage_exceeded" ? 403 : 413);
    }

    // 8. Sign a short-lived URL rather than downloading — the function
    // never allocates the audio in memory at all.
    stage = "signed_url";
    logStage(stage);
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(LECTURE_AUDIO_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      logFailure("signed_url", signErr || new Error("no signed URL returned for an object that was listed"));
      await markFailed(idempotencyKey, userId);
      return errorResponse("signed_url", "recording_missing", "We couldn't find that recording — please record it again.", 404);
    }

    // 9. Transcribe. Object is left in place on failure so a retry can
    // reuse it (no re-upload needed).
    //
    // Provider is a single switch (config.ts's TRANSCRIPTION_PROVIDER,
    // Groq by default), optionally overridden per-deployment via the
    // AI_NOTES_TRANSCRIPTION_PROVIDER secret for A/B testing without a
    // redeploy. The API key is looked up from the *resolved* adapter's
    // own name (not the raw override string), so an invalid/unset
    // override can't leave the wrong secret being read.
    const requestedProvider = Deno.env.get("AI_NOTES_TRANSCRIPTION_PROVIDER") || TRANSCRIPTION_PROVIDER;
    const transcriber = selectTranscriber(TRANSCRIBERS, requestedProvider, TRANSCRIPTION_PROVIDER);
    const transcriptionApiKey = Deno.env.get(PROVIDER_API_KEY_ENV[transcriber.name])!;

    // Vocabulary hint: the app already knows which course this recording
    // belongs to, so bias recognition toward it — this is the app's main
    // free mitigation against misheard technical terms becoming wrong
    // study cards. The two providers want different shapes (Whisper/Groq:
    // a free-text prompt; Deepgram nova-2: individual boosted keywords),
    // so both are built from the same `course` string and the unused one
    // is simply ignored by whichever adapter doesn't need it.
    const promptHint = course ? `Lecture for ${course}` : undefined;
    const keywordHint = course ? course.split(/\s+/).filter((w: string) => w.length > 1) : undefined;

    stage = "transcribe";
    logStage(stage, { provider: transcriber.name });
    let transcript = "";
    let durationSeconds = 0;
    try {
      const result = await transcriber.transcribe({
        audioUrl: signed.signedUrl,
        apiKey: transcriptionApiKey,
        prompt: promptHint,
        keywords: keywordHint,
      });
      transcript = result.transcript;
      durationSeconds = result.durationSeconds || estimatedDurationSeconds || 0;
    } catch (err) {
      logFailure("transcribe", err, { provider: transcriber.name });
      await markFailed(idempotencyKey, userId);
      // A size/duration rejection from the provider is permanent, not
      // transient — retrying with the same audio would fail identically,
      // so it gets its own code (client suppresses the "try again" option
      // for it) rather than the generic transcription_failed, which
      // otherwise strands the recording in an endless failed-retry loop.
      // deno-lint-ignore no-explicit-any
      if ((err as any)?.code === "too_large") {
        return errorResponse(
          "transcribe",
          "transcription_too_long",
          "This recording is too long to process — try recording in shorter segments.",
          413
        );
      }
      return errorResponse("transcribe", "transcription_failed", "We couldn't transcribe that recording. Please try again.", 502);
    }

    // 10. Transcription succeeded — delete the object now. This is the one
    // and only success-path delete, and what fulfills "audio isn't retained".
    const { error: removeErr } = await supabaseAdmin.storage.from(LECTURE_AUDIO_BUCKET).remove([path]);
    if (removeErr) console.error(`ai-notes: failed to delete ${path} after successful transcription`, removeErr);

    // 11. Summarize. On failure, don't discard the transcript — transcription
    // already succeeded and is about to be billed regardless.
    stage = "summarise";
    logStage(stage);
    const summarizer = SUMMARIZERS[Deno.env.get("AI_NOTES_SUMMARY_PROVIDER") || "openai"] || openaiAdapter;
    let result: Record<string, unknown>;
    try {
      const summary = await summarizer.summarize({ transcript, translateTo, apiKey: Deno.env.get("OPENAI_API_KEY")! });
      result = { ok: true, transcript, summaryFailed: false, original: summary.original, translated: summary.translated };
    } catch (err) {
      // Previously swallowed entirely: summarising could fail on every
      // request and the only evidence was summaryFailed in the payload.
      logFailure("summarise", err);
      result = { ok: true, transcript, summaryFailed: true, original: null, translated: null };
    }

    // 12. Bill usage using the server-reported duration (whichever provider
    // ran) — minutesFromSeconds is the one, directly-tested calculation
    // between "how long was this recording" and what gets billed.
    stage = "billing";
    logStage(stage, { minutes: minutesFromSeconds(durationSeconds) });
    const minutesBilled = minutesFromSeconds(durationSeconds);
    await supabaseAdmin.from("ai_usage").upsert(
      { user_id: userId, month, minutes_used: minutesUsedThisMonth + minutesBilled, updated_at: new Date().toISOString() },
      { onConflict: "user_id,month" }
    );

    // 13. Mark the request done.
    await supabaseAdmin
      .from("ai_notes_requests")
      .update({ status: "done", result, minutes_billed: minutesBilled })
      .eq("idempotency_key", idempotencyKey)
      .eq("user_id", userId);

    // 14. Best-effort housekeeping, doesn't block the response.
    scheduleCleanup();

    // 15. Done.
    return jsonResponse({ ok: true, result });
  } catch (err) {
    // The line that was missing. Structured, greppable, and carrying the
    // stage, so "it returns 500" is never again the whole evidence.
    logFailure(stage, err, { unhandled: true });
    return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
  }
});
