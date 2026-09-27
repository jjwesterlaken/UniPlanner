/* ==================================================================
   auth-email-canary — once an hour, can Supabase Auth send email?

   The decisions are in canary.js; the header there says why this
   exists. This file does the four things with side effects: make sure
   the canary account exists, ask Auth to send it a reset, record what
   happened, and alert on a change.

   ------------------------------------------------------------------
   THE SECRET IS ITS OWN, like error-digest's and the retention sweep's.
   pg_net keeps each request, headers included, in a queue table for
   hours, so whatever authenticates the cron job sits at rest in the
   database. `AUTH_CANARY_SECRET` only lets its holder trigger one reset
   email to an account we own. It is compared whole, and a wrong secret
   is answered exactly like a missing one.

   ------------------------------------------------------------------
   THE CANARY ACCOUNT IS SELF-PROVISIONING. Each run asks the admin API
   to create it with the email already confirmed; "already exists" is
   the normal answer and means it is there. Without that, a deleted or
   never-created account would make /recover answer 200 WITHOUT
   sending anything (Auth does not reveal whether an address has an
   account), and the canary would report healthy over a broken mailer.
   Any other answer from the admin API is UNKNOWN, never OK.

   It holds nothing: no planner, no password, and it is only ever sent
   reset links. Whoever reads the canary inbox can sign in to an empty
   account, which is the whole of its exposure.

   ------------------------------------------------------------------
   IT NEVER STOPS OVER THE ALERT. A failed probe is recorded for the
   digest BEFORE the alert is attempted, so a Resend outage still leaves
   the failure visible the next morning. The state moves only once the
   alert is sent (canary.js).
   ================================================================== */

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { stageLine } from "../ai-notes/diagnostics.js";
import { recordFailure } from "../_shared/failureLog.ts";
import { AUTH_EMAIL_FAILED, PROBE, alertEmail, classifyProbe, decide } from "./canary.js";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "auth-email-canary"));

/** The one row that holds the state. */
export const STATE_ID = 1;

// deno-lint-ignore no-explicit-any
export async function handle(req: Request, deps: Record<string, any> = {}): Promise<Response> {
  const env = deps.env || ((n: string) => Deno.env.get(n));
  const fetchImpl: typeof fetch = deps.fetch || fetch;
  const now: () => Date = deps.now || (() => new Date());
  // deno-lint-ignore no-explicit-any
  const logFailure = deps.logFailure || ((stage: string, err: any, extra: Record<string, unknown> = {}) => recordFailure("auth-email-canary", stage, err, extra));

  let stage = "env_check";
  try {
    const secret = env("AUTH_CANARY_SECRET") || "";
    const email = (env("AUTH_CANARY_EMAIL") || "").trim();
    const url = (env("SUPABASE_URL") || "").replace(/\/+$/, "");
    const anon = env("SUPABASE_ANON_KEY") || "";
    const resendKey = env("RESEND_API_KEY") || "";
    const to = env("ERROR_DIGEST_TO") || "";
    const from = env("ERROR_DIGEST_FROM") || "";

    /* OFF until configured, and refusing rather than half-running: with
       no secret nothing authenticates the caller, and with no canary
       address there is nothing to probe. */
    if (!secret.trim() || !email || !url || !anon) {
      logStage("disabled", { hasSecret: !!secret.trim(), hasEmail: !!email, hasUrl: !!url, hasAnon: !!anon });
      return jsonResponse({ ok: false, code: "canary_disabled" }, 503);
    }

    stage = "auth";
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!bearer || bearer !== secret) {
      logStage("unauthorized");
      return jsonResponse({ ok: false, code: "unauthenticated" }, 401);
    }

    const admin = deps.supabaseAdmin || getSupabaseAdmin();

    /* ---- the canary account exists, or we know nothing ---- */
    stage = "ensure_account";
    let probe: string = PROBE.UNKNOWN;
    let status: number | null = null;
    let detail = "";
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    const exists = !createErr || createErr.code === "email_exists" || /already (been )?registered/i.test(String(createErr.message || ""));
    if (!exists) {
      detail = String(createErr.message || createErr.code || "createUser failed").slice(0, 300);
      logFailure(stage, createErr, { code: "canary_unknown" });
    } else {
      /* ---- the probe: exactly what the app sends ---- */
      stage = "recover";
      try {
        const res = await fetchImpl(`${url}/auth/v1/recover`, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: anon, authorization: `Bearer ${anon}` },
          body: JSON.stringify({ email }),
        });
        status = res.status;
        if (!res.ok) detail = (await res.text().catch(() => "")).slice(0, 300);
      } catch (err) {
        detail = String((err as Error)?.message || err).slice(0, 300);
      }
      probe = classifyProbe(status);
      if (probe === PROBE.FAILED) {
        /* RECORDED FIRST, for the digest, whatever happens to the alert. */
        logFailure(stage, new Error(`Auth /recover answered ${status}`), { code: AUTH_EMAIL_FAILED, status, body: detail });
      } else if (probe === PROBE.UNKNOWN) {
        logFailure(stage, new Error(status === null ? `Auth /recover unreachable: ${detail}` : `Auth /recover answered ${status}`), { code: "canary_unknown", status });
      }
    }

    /* ---- the state, and a change of it ---- */
    stage = "state_read";
    const { data: prev, error: readErr } = await admin.from("auth_email_canary").select("status, since").eq("id", STATE_ID).maybeSingle();
    if (readErr) {
      /* A FAILED READ IS NOT "HEALTHY BEFORE". Deciding from it would
         send a "failing" alert every hour of an outage, or a "recovered"
         one that never happened. The probe is already recorded above. */
      logFailure(stage, readErr);
      return jsonResponse({ ok: false, code: "state_unavailable", probe, status }, 500);
    }
    const decision = decide(prev, probe);
    const stamp = now().toISOString();

    let alerted = false;
    if (decision.alert) {
      stage = "alert";
      const mail = alertEmail(decision.alert, { status, since: prev?.since ?? null, now: stamp, detail });
      if (!resendKey.trim() || !to.trim() || !from.trim()) {
        logFailure(stage, new Error("the canary has no mail configuration"), { alert: decision.alert });
      } else {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
          body: JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text }),
        });
        if (res.ok) alerted = true;
        else logFailure(stage, new Error(`Resend answered ${res.status}`), { status: res.status, alert: decision.alert, body: (await res.text().catch(() => "")).slice(0, 300) });
      }
    }

    stage = "state_write";
    /* The status moves only with a sent alert; the check time always.
       A change whose alert failed keeps the OLD status, so the next hour
       sees the same change and tries the alert again. */
    const moved = decision.changed && alerted;
    const keptStatus = prev?.status === "failing" ? "failing" : "healthy";
    const row = {
      id: STATE_ID,
      status: decision.changed ? (moved ? decision.status : keptStatus) : decision.status,
      since: moved ? stamp : prev?.since ?? stamp,
      checked_at: stamp,
      last_probe: probe,
      last_http_status: status,
    };
    const { error: writeErr } = await admin.from("auth_email_canary").upsert(row, { onConflict: "id" });
    if (writeErr) logFailure(stage, writeErr);

    logStage("done", { probe, status, alert: decision.alert, alerted, stored: row.status });
    return jsonResponse({ ok: true, probe, status, alert: decision.alert, alerted, state: row.status });
  } catch (err) {
    logFailure(stage, err);
    return jsonResponse({ ok: false, code: "server_error" }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") return jsonResponse({ ok: true, fn: "auth-email-canary" });
  if (req.method !== "POST") return jsonResponse({ ok: false, code: "bad_request" }, 405);
  return await handle(req);
});
