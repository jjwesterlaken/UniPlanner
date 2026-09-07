/* ==================================================================
   billing-portal — send a Stripe subscriber to Stripe's own page to
   cancel or change their plan

   ONE FUNCTION, ONE JOB, and the reason it is a function at all rather
   than a link: a Customer Portal session must be created server-side
   from a customer id, and that id is the one thing a client must never
   be able to name. Given a customer id, Stripe hands back a URL that
   grants access to that customer's billing — so a client-supplied id
   would be somebody else's invoices.

   THE ID COMES FROM `profiles`, SCOPED BY THE UID IN THE VERIFIED JWT.
   Nothing else in the request is read at all.

   BEHIND THE SAME FLAG as billing-checkout, and refusing distinctly
   when the account simply has no Stripe customer — that is the ordinary
   state of every student who bought on a phone, and it is not an error.
   ================================================================== */

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { failureLine, stageLine } from "../ai-notes/diagnostics.js";
import { SITE_URL, stripeRequest } from "../_shared/stripe.ts";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "billing-portal"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  console.error(failureLine(stage, err, extra, "billing-portal"));

export async function handle(req: Request): Promise<Response> {
  let stage = "env_check";
  try {
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    if (!secretKey.trim()) {
      logStage("disabled", { reason: "STRIPE_SECRET_KEY is not set" });
      return jsonResponse({ ok: false, code: "stripe_disabled" }, 503);
    }

    stage = "auth_user";
    const admin = getSupabaseAdmin();
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ ok: false, code: "unauthenticated" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      logFailure(stage, userErr || new Error("no user on a token that verified"));
      return jsonResponse({ ok: false, code: "unauthenticated" }, 401);
    }
    const userId = userData.user.id;

    stage = "profile_lookup";
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (profileErr) {
      logFailure(stage, profileErr);
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }
    const customerId = (profile && profile.stripe_customer_id) || "";
    if (!customerId) {
      /* Not a failure. Every student who bought on a phone is in this
         state, and the panel sends them to the STORE's page instead. */
      return jsonResponse({ ok: false, code: "no_stripe_customer" }, 404);
    }

    stage = "session";
    const session = await stripeRequest("/billing_portal/sessions", {
      secretKey,
      method: "POST",
      body: { customer: customerId, return_url: SITE_URL },
    });
    if (!session.ok) {
      logFailure(stage, session.error);
      return jsonResponse({ ok: false, code: "upstream_unavailable" }, 503);
    }
    const url = String(session.data.url || "");
    if (!url.startsWith("https://")) {
      logFailure(stage, new Error("Stripe returned a portal session with no https url"));
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }

    logStage("session", { userId });
    return jsonResponse({ ok: true, url });
  } catch (err) {
    logFailure(stage, err);
    return jsonResponse({ ok: false, code: "server_error" }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, code: "bad_request" }, 405);
  return await handle(req);
});
