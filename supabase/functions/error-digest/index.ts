/* ==================================================================
   error-digest — one email a day, to support@, about what broke.

   `function_errors` (migration 0022) holds one row per failed Edge
   Function request. This reads a day of them, sends one grouped email,
   and purges anything older than the retention period.

   ------------------------------------------------------------------
   ONE EMAIL A DAY, NEVER ONE PER ERROR.

   A message per failure is a message nobody reads, and a loop inside a
   function would send thousands of them in an afternoon — which is
   both a cost and the fastest way to have the address blocked. The
   grouping is by (function, stage, error name), which is the same
   thing a person greps for, with a count and the most recent message
   per group.

   AND NOTHING IS SENT ON A QUIET DAY. An email saying "0 errors" every
   morning is an email that gets filtered, and a filtered digest is a
   digest that is not read on the morning it matters. Silence is the
   healthy signal, which is only safe because the SCHEDULE is visible
   elsewhere: `cron.job_run_details` says whether the job ran, and the
   `--digest` path reports what it did on demand.

   ------------------------------------------------------------------
   THE SECRET IS ITS OWN, NOT THE SERVICE ROLE KEY.

   pg_net stores each outbound request — headers included — in
   net.http_request_queue until its TTL expires, so whatever
   authenticates the cron job sits at rest in a database table for
   hours at a time. `ERROR_DIGEST_SECRET` only lets its holder trigger a
   digest to an address this function reads from its OWN environment,
   which is the same reasoning as `AI_NOTES_SWEEP_SECRET` and the same
   reason not to "simplify" it back.

   ------------------------------------------------------------------
   THE PURGE IS THIS FUNCTION'S JOB, because nothing else would do it.

   CLAUDE.md's rule: anything that prunes on a schedule of its own has
   to clean up after itself or it grows forever. The digest runs daily
   and is the only thing that reads this table, so the purge rides with
   it — and it runs even on a quiet day, when no email is sent, because
   "nothing to report" and "nothing to tidy" are different facts.

   ------------------------------------------------------------------
   IT NEVER FAILS THE REQUEST OVER THE EMAIL.

   The rows are read, the digest is built, the purge runs, and only then
   is the email attempted. A Resend outage must not stop the purge or
   lose the reading — and the response says which parts happened, so a
   cron run that "succeeded" cannot hide a mail failure. Same shape as
   every other three-outcomes decision here: sent, nothing to send, and
   tried and failed are three answers, not two.
   ================================================================== */

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { stageLine } from "../ai-notes/diagnostics.js";
import { FUNCTION_ERROR_RETENTION_DAYS, recordFailure } from "../_shared/failureLog.ts";
import { buildDigest, digestSubject, digestText } from "./digest.js";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "error-digest"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  recordFailure("error-digest", stage, err, extra);

/** How far back a digest looks. One day, matching the schedule. */
export const DIGEST_WINDOW_HOURS = 24;

export async function handle(req: Request): Promise<Response> {
  let stage = "env_check";
  try {
    const secret = Deno.env.get("ERROR_DIGEST_SECRET") || "";
    const resendKey = Deno.env.get("RESEND_API_KEY") || "";
    const to = Deno.env.get("ERROR_DIGEST_TO") || "";
    const from = Deno.env.get("ERROR_DIGEST_FROM") || "";

    /* THE OFF STATE, and it refuses rather than half-running. Without
       the shared secret there is nothing to authenticate the caller
       with, so every request would be anonymous — and this endpoint
       reads a table no client may read. */
    if (!secret.trim()) {
      logStage("disabled", { hasSecret: false, hasResendKey: !!resendKey.trim(), hasTo: !!to.trim(), hasFrom: !!from.trim() });
      return jsonResponse({ ok: false, code: "digest_disabled" }, 503);
    }

    stage = "auth";
    /* A SHARED SECRET, compared whole. This is not a user JWT: the
       caller is a cron job, there is no account, and the only thing
       being proved is possession of a value only the database holds. */
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!bearer || bearer !== secret) {
      /* NOT LOGGED AS A FAILURE, and not told apart from a missing
         header: an endpoint that answers "that secret exists but is
         wrong" differently from "you sent none" is one that can be
         probed. */
      logStage("unauthorized");
      return jsonResponse({ ok: false, code: "unauthenticated" }, 401);
    }

    const admin = getSupabaseAdmin();

    stage = "read";
    const since = new Date(Date.now() - DIGEST_WINDOW_HOURS * 3600_000).toISOString();
    const { data: rows, error: readErr } = await admin
      .from("function_errors")
      .select("fn, stage, name, message, detail, occurred_at")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      /* BOUNDED. A loop in one function could write tens of thousands
         of rows in a day, and a digest that tries to read all of them
         runs out of memory instead of reporting the loop — which is
         the one thing it most needs to report. The count comes from a
         separate COUNT, so the email still says how many there really
         were. */
      .limit(500);
    if (readErr) {
      /* A FAILED READ IS NOT A QUIET DAY. Returning ok here would make
         a broken digest indistinguishable from a healthy morning, which
         is the `fetchNote` rule with a week of unnoticed failures
         behind it. 500 so the cron run is visibly failed in
         cron.job_run_details. */
      logFailure(stage, readErr);
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }

    stage = "count";
    const { count: total, error: countErr } = await admin
      .from("function_errors")
      .select("id", { count: "exact", head: true })
      .gte("occurred_at", since);
    if (countErr) {
      /* NOT FATAL: the digest is still worth sending, and the count is
         a headline rather than the content. Reported so "truncated"
         cannot quietly become "that was all of them". */
      logFailure(stage, countErr);
    }

    const digest = buildDigest(rows ?? [], { total: typeof total === "number" ? total : (rows ?? []).length, since, windowHours: DIGEST_WINDOW_HOURS });

    /* THE PURGE RUNS WHATEVER THE DIGEST SAYS, including on a quiet
       day when no email is sent. Nothing else reads this table, so
       nothing else would ever tidy it. */
    stage = "purge";
    const purgeBefore = new Date(Date.now() - FUNCTION_ERROR_RETENTION_DAYS * 86400_000).toISOString();
    const { error: purgeErr } = await admin.from("function_errors").delete().lt("occurred_at", purgeBefore);
    if (purgeErr) logFailure(stage, purgeErr);

    if (digest.groups.length === 0) {
      /* SILENCE IS THE HEALTHY SIGNAL. See the header: a daily "0
         errors" email is one that gets filtered, and a filtered digest
         is not read on the morning it matters. */
      logStage("quiet", { since, purged: !purgeErr });
      return jsonResponse({ ok: true, outcome: "nothing_to_report", total: digest.total });
    }

    stage = "send";
    if (!resendKey.trim() || !to.trim() || !from.trim()) {
      /* THE DIGEST WAS BUILT AND CANNOT BE DELIVERED. Reported as its
         own outcome rather than as success: a cron run that says ok
         over an unconfigured mailer is how a digest is believed to be
         arriving for a month. */
      logFailure(stage, new Error("the digest has no mail configuration"), {
        hasResendKey: !!resendKey.trim(),
        hasTo: !!to.trim(),
        hasFrom: !!from.trim(),
      });
      return jsonResponse({ ok: false, code: "mail_not_configured", total: digest.total, groups: digest.groups.length }, 503);
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from, to: [to], subject: digestSubject(digest), text: digestText(digest) }),
    });
    if (!res.ok) {
      /* THE BODY IS READ AND LOGGED, because Resend says WHY in it —
         an unverified sending domain and a bad key are the same status
         with different messages, and guessing between them costs a
         morning. Truncated, because a provider body is not a place to
         store. */
      const body = (await res.text().catch(() => "")).slice(0, 400);
      logFailure(stage, new Error(`Resend answered ${res.status}`), { status: res.status, body });
      return jsonResponse({ ok: false, code: "mail_failed", status: res.status, total: digest.total }, 502);
    }

    logStage("sent", { total: digest.total, groups: digest.groups.length, truncated: digest.truncated });
    return jsonResponse({ ok: true, outcome: "sent", total: digest.total, groups: digest.groups.length });
  } catch (err) {
    logFailure(stage, err);
    return jsonResponse({ ok: false, code: "server_error" }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") return jsonResponse({ ok: true, fn: "error-digest" });
  if (req.method !== "POST") return jsonResponse({ ok: false, code: "bad_request" }, 405);
  return await handle(req);
});
