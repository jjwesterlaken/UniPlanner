/* ==================================================================
   billing-checkout — start a Stripe subscription for the signed-in
   student, and for nobody else

   BEHIND A FLAG. It refuses with `stripe_disabled` unless
   STRIPE_SECRET_KEY is set, so deploying it changes nothing until
   somebody deliberately configures it — the flag is the CONFIGURATION
   rather than a boolean beside it, because a boolean that says "on"
   while the key is missing is a button that fails after the click.

   THE IDENTITY RULE, which is the whole reason this is a server
   function rather than a client call to Stripe: **the student never
   supplies who they are.** The uid comes out of the verified JWT, is
   written into `client_reference_id`, into the session metadata AND
   into the subscription metadata, and the Stripe customer is matched by
   the id stored on `profiles` — **never by email**, which is the
   takeover CLAUDE.md warns about in the service-role section. Two
   accounts can share an email address at a store; nothing may let one
   of them inherit the other's subscription.

   AND THE AMOUNT IS NOT THE STUDENT'S EITHER. The request names a TIER
   and a DURATION; this resolves which Stripe Price that is by a lookup
   key it holds itself. A client that named a price id could name a
   cheaper one, which is the same class of mistake as trusting a uid
   from a request body.

   ONE REFUSAL WORTH KNOWING ABOUT: an account already holding a STORE
   subscription cannot start a Stripe one. Two sources that each re-read
   only their own provider would flap the tier between them, and the
   student would be paying twice. This closes the door we control; the
   other direction is not ours to refuse and is a support note in
   BILLING-PLAN rather than a guess here.
   ================================================================== */

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { failureLine, stageLine } from "../ai-notes/diagnostics.js";
import {
  CHECKOUT_CANCEL_URL,
  CHECKOUT_SUCCESS_URL,
  lookupKeyFor,
  stripeRequest,
} from "../_shared/stripe.ts";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "billing-checkout"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  console.error(failureLine(stage, err, extra, "billing-checkout"));

export async function handle(req: Request): Promise<Response> {
  let stage = "env_check";
  try {
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    if (!secretKey.trim()) {
      /* NOT an error condition — it is the OFF state, and it is what
         "built behind a flag" means here. Logged at stage level rather
         than as a failure so a log full of these does not look like a
         fault. */
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

    stage = "parse";
    let payload: Record<string, unknown> = {};
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ ok: false, code: "bad_request" }, 400);
    }
    const lookupKey = lookupKeyFor(String(payload.tier ?? ""), String(payload.duration ?? ""));
    if (!lookupKey) {
      logFailure(stage, new Error("no plan for that tier and duration"), { tier: payload.tier, duration: payload.duration });
      return jsonResponse({ ok: false, code: "bad_request" }, 400);
    }

    /* ---- the account, and whether it may buy here ---- */
    stage = "profile_lookup";
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("tier, tier_source, store, stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (profileErr) {
      logFailure(stage, profileErr);
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }
    if (!profile) {
      /* A signed-in account with no profiles row is an anomaly rather
         than a tier — the signup trigger makes one for everybody. */
      logFailure(stage, new Error("no profiles row for a signed-in user"));
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }
    if (profile.tier !== "free" && profile.store && profile.store !== "stripe") {
      logStage("refused", { reason: "store_subscription_active", store: profile.store });
      return jsonResponse({ ok: false, code: "store_subscription_active", store: profile.store }, 409);
    }

    /* ---- which price ---- */
    stage = "price_lookup";
    const prices = await stripeRequest(`/prices?lookup_keys[0]=${encodeURIComponent(lookupKey)}&active=true&limit=1`, { secretKey });
    if (!prices.ok) {
      logFailure(stage, prices.error, { lookupKey });
      return jsonResponse({ ok: false, code: "upstream_unavailable" }, 503);
    }
    const priceId = (((prices.data.data as Array<{ id?: string }>) || [])[0] || {}).id;
    if (!priceId) {
      /* A DEFINITIVE answer — Stripe replied and there is no such
         active price — which means the dashboard has not been set up,
         not that anything failed. Its own code, because "we could not
         reach Stripe" would send whoever is debugging somewhere else. */
      logFailure(stage, new Error("no active price for that lookup key"), { lookupKey });
      return jsonResponse({ ok: false, code: "plan_unavailable" }, 503);
    }

    /* ---- the customer: found by STORED ID, never by email ---- */
    stage = "customer";
    let customerId = profile.stripe_customer_id || "";
    if (!customerId) {
      const created = await stripeRequest("/customers", {
        secretKey,
        method: "POST",
        body: { "metadata[uid]": userId },
        /* One customer per account however many times this is tapped. */
        idempotencyKey: `customer:${userId}`,
      });
      if (!created.ok) {
        logFailure(stage, created.error);
        return jsonResponse({ ok: false, code: "upstream_unavailable" }, 503);
      }
      customerId = String(created.data.id || "");
      if (!customerId) {
        logFailure(stage, new Error("Stripe created a customer with no id"));
        return jsonResponse({ ok: false, code: "server_error" }, 500);
      }
      /* STORED BEFORE THE SESSION IS CREATED. The reverse leaves a
         student with a Stripe customer we have no record of, so the
         next checkout makes a second one and the Portal opens on the
         wrong one — the aiNotesStore ordering rule, one integration
         over: never leave something on the far side that this side
         does not know about. */
      const { error: linkErr } = await admin.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", userId);
      if (linkErr) {
        logFailure(stage, linkErr, { customerId });
        return jsonResponse({ ok: false, code: "server_error" }, 500);
      }
    }

    /* ---- the session ---- */
    stage = "session";
    const session = await stripeRequest("/checkout/sessions", {
      secretKey,
      method: "POST",
      body: {
        mode: "subscription",
        customer: customerId,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": 1,
        success_url: CHECKOUT_SUCCESS_URL,
        cancel_url: CHECKOUT_CANCEL_URL,
        /* THE UID, THREE TIMES, and each one is read by something
           different: `client_reference_id` is what a human sees in the
           Stripe dashboard, the session metadata is what a
           `checkout.session.completed` event carries, and the
           SUBSCRIPTION metadata is what every later
           `customer.subscription.*` event carries. Missing the third is
           how a renewal a year later arrives with no way to tell whose
           it is except a customer-id lookup. */
        client_reference_id: userId,
        "metadata[uid]": userId,
        "subscription_data[metadata][uid]": userId,
      },
    });
    if (!session.ok) {
      logFailure(stage, session.error);
      return jsonResponse({ ok: false, code: "upstream_unavailable" }, 503);
    }
    const url = String(session.data.url || "");
    if (!url.startsWith("https://")) {
      logFailure(stage, new Error("Stripe returned a session with no https url"));
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }

    logStage("session", { userId, lookupKey, customerId });
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
