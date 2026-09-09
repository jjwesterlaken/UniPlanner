/* ==================================================================
   stripe-webhook — the SECOND source, and the same writer

   BILLING-PLAN §6 mapped two routes for a Stripe subscription to become
   a tier and this is the second: Stripe's own HMAC-signed webhook,
   feeding the SAME `applyEntitlement()` the store webhook uses. **Two
   sources, one writer.** The alternative — having RevenueCat ingest
   Stripe — rests on documentation this container cannot reach, and every
   step of it is marked `[confirm]` in the plan; this route is verifiable
   end to end against Stripe test mode with the Stripe CLI and nothing
   else. `_shared/stripe.ts`'s header has the full reasoning and the cost.

   EVERY RULE billing-webhook ESTABLISHED APPLIES HERE UNCHANGED, and
   they are the reason this file looks so much like that one:

   1. VERIFY BEFORE PARSE. The HMAC covers the RAW REQUEST BYTES, so the
      body is read once as text, checked against that exact string, and
      only then parsed. `req.json()` appears nowhere; a test asserts its
      absence and the order inside the handler body.
   2. RE-READ BEFORE WRITE. The delivered event is a TRIGGER. The
      subscription is fetched back from Stripe by id and the tier is
      computed from THAT, so a forged delivery can at worst make us ask
      Stripe about a subscription and write what Stripe already believes.
      It also makes out-of-order delivery stop mattering, which Stripe's
      documentation warns about in as many words as RevenueCat's.
   3. APPLY BEFORE RECORD, so a crash between them retries into a fix
      rather than a lie.
   4. `user_id` MEANS AN ACCOUNT WE MATCHED. An event for an id we hold
      no profile for is recorded with a null `user_id` and the raw id in
      `app_user_id`, and answered 200 — Stripe retries non-2xx exactly
      as RevenueCat does. That is migration 0018's lesson, and it cost a
      production 500 the first time it was learned.

   ONE DIFFERENCE FROM billing-webhook, worth naming rather than
   letting somebody notice it as an omission: there is no shared
   authorization HEADER here. RevenueCat sends a dashboard-configured
   value AND an HMAC; Stripe sends only the HMAC. So the signature is
   the whole of the authentication, which is why the freshness window
   and the constant-time compare are not optional decoration.

   AND ONE REFUSAL THAT LOOKS LIKE A FAILURE AND IS A FEATURE: a
   subscription in an entitled status whose price carries no lookup key
   we know is answered 500 so Stripe retries, and NOTHING is written.
   Writing `free` there — which is what a naive "no match, no
   entitlement" would do — would downgrade every paying Stripe
   subscriber the moment a price was created without a lookup key.
   ================================================================== */

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { failureLine, stageLine } from "../ai-notes/diagnostics.js";
import { applyEntitlement, isOurUserId } from "../_shared/entitlement.ts";
import {
  parseStripeSignature,
  signStripePayload,
  stripeRequest,
  stripeTimestampFresh,
  tierFromStripeSubscription,
  timingSafeEqual,
} from "../_shared/stripe.ts";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "stripe-webhook"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  console.error(failureLine(stage, err, extra, "stripe-webhook"));

/* THE EVENTS THAT MEAN "GO AND LOOK". Everything else is recorded and
   answered 200 without action — a list of types to ACT on is far safer
   than a list to ignore, because a type nobody enumerated then does
   nothing rather than something unintended. */
const ACTIONABLE = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

export async function handle(req: Request): Promise<Response> {
  let stage = "env_check";
  try {
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    const signingSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
    if (!secretKey.trim() || !signingSecret.trim()) {
      /* THE OFF STATE. Both are required: a signing secret with no API
         key would verify deliveries it could not then act on, which is
         worse than refusing, because it would record events as handled. */
      logStage("disabled", { hasSecretKey: !!secretKey.trim(), hasSigningSecret: !!signingSecret.trim() });
      return jsonResponse({ ok: false, code: "stripe_disabled" }, 503);
    }

    /* ---- verify_signature: over the RAW BYTES, before any parse ---- */
    stage = "verify_signature";
    const raw = await req.text();
    const sig = parseStripeSignature(req.headers.get("stripe-signature"));
    if (!sig) {
      logFailure(stage, new Error("signature header absent or unparseable"));
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }
    if (!stripeTimestampFresh(sig.t)) {
      logFailure(stage, new Error("signature timestamp outside the freshness window"), { t: sig.t });
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }
    const expected = await signStripePayload(signingSecret, sig.t, raw);
    /* ANY of the v1 values may match — Stripe sends one per active
       signing secret during a rotation, and accepting only one would
       refuse half the deliveries for the length of it. */
    if (!sig.v1.some((candidate) => timingSafeEqual(candidate, expected))) {
      logFailure(stage, new Error("signature did not verify over the raw body"));
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }

    /* ---- parse: only now, and only for routing ---- */
    stage = "parse";
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      logFailure(stage, err);
      return jsonResponse({ ok: false, code: "bad_request" }, 400);
    }
    const eventId = typeof event.id === "string" ? event.id : "";
    const eventType = typeof event.type === "string" ? event.type : "UNKNOWN";
    if (!eventId) {
      logFailure(stage, new Error("event carries no id, so it cannot be recorded or deduplicated"), { type: eventType });
      return jsonResponse({ ok: false, code: "bad_request" }, 400);
    }
    logStage("parse", { event: eventType, id: eventId });

    const admin = getSupabaseAdmin();

    /* ---- already handled? a retry must cost nothing ----

       THE PRIMARY KEY IS THE GUARANTEE. THIS READ IS AN OPTIMISATION.
       So a failure here is LOGGED AND IGNORED rather than answered
       5xx, and that distinction is the whole of this block.

       What the read buys is skipping a provider round-trip on a
       redelivery. What actually stops a duplicate being applied twice
       is `billing_events`' primary key on the event id, which the
       record stage below already reads as 23505 -> duplicate. Proceed
       without the read and the worst case is one wasted provider call
       before that insert refuses.

       Returning 500 instead costs strictly more: the provider retries,
       and if whatever broke the read is not momentary it breaks the
       next read too, so every delivery becomes a retry that fails the
       same way. The first real Stripe deliveries produced exactly the
       momentary version — PGRST303 "JWT issued at future", clock skew
       between the edge runtime and PostgREST, which the provider's own
       retry cleared 18 seconds later. Nothing in this repository mints
       that token or can backdate its `iat`; what is in our control is
       not turning a transient read failure into a refused delivery.

       This is NOT the fetchNote rule being broken. That rule forbids
       reading a failed request as evidence of ABSENCE, and nothing
       here does: the failure is not read as "not yet handled", it is
       read as "unknown", and the unknown is resolved by the insert
       rather than guessed at. A guessed answer would be acting on it;
       deferring to the constraint is refusing to. */
    stage = "already_handled";
    const { data: seen, error: seenErr } = await admin.from("billing_events").select("id").eq("id", eventId).maybeSingle();
    if (seenErr) {
      /* Logged loudly and NOT failed: see above. `duplicate_skipped`
         names the consequence rather than the error, so a run of these
         in the logs reads as "the optimisation is off" rather than as
         a fault nobody can place. */
      logFailure(stage, seenErr, { id: eventId, outcome: "duplicate_skipped" });
    }
    if (seen) {
      logStage("already_handled", { id: eventId, outcome: "duplicate" });
      return jsonResponse({ ok: true, outcome: "duplicate" });
    }

    const object = ((event.data as { object?: unknown })?.object ?? {}) as Record<string, unknown>;
    const rawAppUserId = typeof (object.metadata as { uid?: unknown } | undefined)?.uid === "string"
      ? String((object.metadata as { uid?: string }).uid).slice(0, 255)
      : typeof object.client_reference_id === "string"
        ? String(object.client_reference_id).slice(0, 255)
        : null;

    /* ---- record: one row per accepted event, whoever it was about ---- */
    const recordEvent = async (matched: { userId: string | null; before: string | null; after: string | null }) => {
      stage = "record";
      const { error: recordErr } = await admin.from("billing_events").insert({
        id: eventId,
        user_id: matched.userId,
        app_user_id: rawAppUserId,
        event_type: eventType,
        store: "stripe",
        tier_before: matched.before,
        tier_after: matched.after,
      });
      if (!recordErr) return null;
      if ((recordErr as { code?: string }).code === "23505") {
        logStage("record", { id: eventId, outcome: "duplicate_race" });
        return jsonResponse({ ok: true, outcome: "duplicate" });
      }
      logFailure(stage, recordErr, { id: eventId });
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    };

    if (!ACTIONABLE.has(eventType)) {
      logStage("ignored", { id: eventId, event: eventType });
      const halted = await recordEvent({ userId: null, before: null, after: null });
      return halted ?? jsonResponse({ ok: true, outcome: "ignored" });
    }

    /* ---- which subscription, and whose ---- */
    stage = "subscription_read";
    const subscriptionId =
      typeof object.subscription === "string"
        ? object.subscription
        : eventType.startsWith("customer.subscription") && typeof object.id === "string"
          ? object.id
          : "";
    if (!subscriptionId) {
      /* A completed checkout in a mode we do not use (a one-off
         payment) carries no subscription. Nothing to do, and nothing
         wrong — 200, recorded. */
      logStage("no_subscription", { id: eventId, event: eventType });
      const halted = await recordEvent({ userId: null, before: null, after: null });
      return halted ?? jsonResponse({ ok: true, outcome: "no_subscription" });
    }

    const fetched = await stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { secretKey });
    if (!fetched.ok) {
      /* A DEFINITIVE 404 and a failed read are told apart, and neither
         is acted on: even "Stripe has never heard of this subscription"
         is not a reason to strip a tier, because the id came out of a
         delivery rather than out of our own records. 5xx so Stripe
         retries. */
      logFailure(stage, fetched.error, { id: eventId, missing: !!fetched.missing, status: fetched.status });
      return jsonResponse({ ok: false, code: "upstream_unavailable" }, 503);
    }
    const subscription = fetched.data;

    /* The uid, from the SUBSCRIPTION we just re-read where possible —
       every later renewal carries it, which is why billing-checkout
       writes it into `subscription_data[metadata]`. */
    const subMeta = (subscription.metadata ?? {}) as { uid?: unknown };
    let userId = isOurUserId(subMeta.uid) ? String(subMeta.uid) : isOurUserId(rawAppUserId) ? String(rawAppUserId) : "";

    if (!userId) {
      /* THE FALLBACK, and it is by STORED CUSTOMER ID — never by
         email. A subscription created outside our checkout (a Payment
         Link, a dashboard invoice) carries no uid, and matching on an
         email address is the account takeover CLAUDE.md's service-role
         section is about. */
      stage = "customer_lookup";
      const customerId = typeof subscription.customer === "string" ? subscription.customer : "";
      if (customerId) {
        const { data: owner, error: ownerErr } = await admin
          .from("profiles")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (ownerErr) {
          logFailure(stage, ownerErr, { id: eventId });
          return jsonResponse({ ok: false, code: "server_error" }, 500);
        }
        if (owner && isOurUserId(owner.user_id)) userId = String(owner.user_id);
      }
    }

    /* ---- WHOSE, BEFORE WHAT — and the order is the fix ----

       The unrecognised-price refusal below is a 500 so that Stripe
       keeps retrying while somebody adds the missing lookup key. That
       is right when there is an account whose tier is at stake, and
       WRONG when there is not: a subscription for a customer we do not
       hold, on a price we do not know, would retry until the delivery
       window expired, and the thing being protected does not exist.

       The Stripe CLI produces exactly that pair on its first
       `stripe trigger` — a fixture product and no uid — so the very
       first delivery anyone sends at a new endpoint is the case that
       retried forever.

       So the account question is answered FIRST. An event about
       nobody is accepted and recorded, the same as `no_such_user` on
       the RevenueCat side and for the same reason: a paid event for an
       account we do not have is the thing to notice, and dropping it
       makes a deleted account with a live subscription, a client that
       configured before sign-in, and an endpoint pointed at the wrong
       project all silent. */
    if (!userId) {
      logStage("no_account", { id: eventId, event: eventType, app_user_id: (rawAppUserId ?? "").slice(0, 48) });
      const halted = await recordEvent({ userId: null, before: null, after: null });
      return halted ?? jsonResponse({ ok: true, outcome: "no_account" });
    }

    stage = "tier";
    const { tier, expiresAt, lookupKey, recognised } = tierFromStripeSubscription(subscription);
    if (!recognised) {
      /* NOT "entitled to nothing" — unanswerable. Writing `free` here
         would downgrade every paying subscriber the day a price was
         created without a lookup key. 500 so Stripe retries while
         somebody fixes the dashboard, and nothing is recorded, so the
         retry is not refused as a duplicate.

         Reachable only with a real account in hand, by the block
         above. The retry is on behalf of somebody. */
      logFailure(stage, new Error("subscription is entitled but matches no known price"), {
        id: eventId,
        subscriptionId,
        status: subscription.status,
      });
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }

    stage = "apply";
    const applied = await applyEntitlement(admin, { userId, tier, store: "stripe", expiresAt, source: "stripe" });
    if (!applied.ok) {
      logFailure(stage, applied.error, { id: eventId, outcome: applied.outcome });
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }
    logStage("apply", {
      id: eventId,
      event: eventType,
      outcome: applied.outcome,
      before: applied.before ?? null,
      after: applied.after ?? null,
      computed: tier,
      lookupKey,
    });

    const matched = applied.after !== undefined;
    const halted = await recordEvent({
      userId: matched ? userId : null,
      before: applied.before ?? null,
      after: applied.after ?? null,
    });
    if (halted) return halted;

    return jsonResponse({ ok: true, outcome: matched ? "applied" : "no_such_user" });
  } catch (err) {
    logFailure(stage, err);
    return jsonResponse({ ok: false, code: "server_error" }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") return jsonResponse({ ok: true, fn: "stripe-webhook" });
  if (req.method !== "POST") return jsonResponse({ ok: false, code: "bad_request" }, 405);
  return await handle(req);
});

/* WHY THERE IS NO `verify_jwt` HERE. Stripe cannot mint a Supabase JWT,
   so this must be deployed with --no-verify-jwt, exactly as
   billing-webhook is: with verification on, every delivery is refused
   by the platform before our code runs, nothing is logged, and the
   symptom is "students pay on the web and their plan never changes".
   deploy-functions.yml carries the flag and a wiring test pins it. */
