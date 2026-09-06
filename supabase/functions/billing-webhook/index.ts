// billing-webhook — the ONLY thing in this project that writes
// profiles.tier.
//
// Until 1.1.0 nothing wrote it at all: no policy, no grant, no
// function, no client path. Tiers were flipped by hand in the
// dashboard, which is why ANDROID-RELEASE.md could answer Play's "does
// the app allow purchases?" with NO. This is the writer, and everything
// about its shape is an answer to "what happens when someone sends this
// endpoint a lie".
//
// THE STAGE SEQUENCE, and two orderings are load-bearing:
//
//   env_check -> authorize -> verify_signature -> parse
//     -> already_handled?          <- a cheap read, so a retry is free
//     -> subscriber_read           <- ASKS RevenueCat what is true
//     -> apply                     <- WRITES profiles
//     -> record                    <- WRITES billing_events
//
// 1. VERIFY BEFORE PARSE. The signature covers the RAW REQUEST BYTES.
//    Parsing first and re-serialising to verify changes those bytes —
//    key order, whitespace, number formatting, unicode escapes — and
//    every valid delivery fails. So the body is read as text ONCE, the
//    signature is checked against that exact string, and only then is
//    it parsed. This is the whole reason `req.json()` appears nowhere
//    in this file.
//
// 2. RE-READ BEFORE WRITE. The payload is a trigger, never evidence:
//    the tier is computed from the subscriber record fetched back from
//    RevenueCat, so a forged event can at worst make us ask about a
//    user and write what RevenueCat already believes. See
//    _shared/entitlement.ts for why that also fixes out-of-order and
//    duplicate delivery, which authentication does not touch.
//
// 3. APPLY BEFORE RECORD. A crash between them means a retry re-applies
//    (harmless — the apply is a re-read and a write of the same value)
//    and then records. The reverse marks an event handled that was
//    never applied, and the retry that would have fixed it is refused
//    as a duplicate. Same rule as aiNotesStore's two orderings: never
//    claim done for work that is not done.
//
// AND THE SERVICE-ROLE RULE, in full. Every query here runs on the
// client that bypasses RLS, so every `.eq("user_id", …)` a policy would
// have applied is written by hand — and the id is always one RevenueCat
// returned for a subscriber, never one lifted out of the request body.
// CLAUDE.md named the Stripe webhook as the next place this mistake
// would flip the wrong user's tier. This is that place, one integration
// earlier.

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { failureLine, stageLine } from "../ai-notes/diagnostics.js";
import {
  tierFromSubscriber,
  affectedUserIds,
  applyEntitlement,
  isOurUserId,
  type BillingTier,
} from "../_shared/entitlement.ts";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "billing-webhook"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  console.error(failureLine(stage, err, extra, "billing-webhook"));

/* ALL FIVE ARE REQUIRED, and a missing one refuses the request rather
   than degrading. An auth check that can be skipped by not configuring
   it is not an auth check — and the failure it would hide is "anyone
   can set anyone's tier". The two SUPABASE_ vars are injected by the
   platform; the three RevenueCat ones are set by hand in
   Edge Functions -> Secrets and no test can see them. */
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REVENUECAT_WEBHOOK_SECRET",
  "REVENUECAT_WEBHOOK_SIGNING_SECRET",
  "REVENUECAT_SECRET_KEY",
];

/* How far out of date a delivery may be. Without this, a signature is
   valid forever and a captured request can be replayed indefinitely —
   the signature proves the body was signed, not that it was signed
   recently. Five minutes covers RevenueCat's own retry latency and
   any clock skew between two hosted services. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

const REVENUECAT_API = "https://api.revenuecat.com/v1";

/**
 * Compare two strings without leaking where they diverge.
 *
 * A plain `===` on a secret returns as soon as two bytes differ, so the
 * time it takes is a measurement of how much of the secret the caller
 * guessed. Both operands are hex or opaque tokens here, so comparing
 * every byte regardless costs nothing.
 *
 * The length is folded into the result rather than returned early, for
 * the same reason.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Parse `t=<timestamp>,v1=<hex>` — RevenueCat's signature header.
 *
 * Tolerant of order and of extra elements, because a provider adding
 * `v2=` later must not break `v1=` verification. Anything it cannot
 * find is a refusal, never a skip.
 */
export function parseSignatureHeader(header: string | null): { t: string; v1: string } | null {
  if (!header) return null;
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim().split("="))
      .filter((kv) => kv.length >= 2)
      .map(([k, ...v]) => [k.trim(), v.join("=").trim()])
  );
  if (!parts.t || !parts.v1) return null;
  return { t: parts.t, v1: parts.v1 };
}

/**
 * Is `t` recent enough?
 *
 * RevenueCat's timestamp is milliseconds since the epoch. Seconds are
 * accepted too — normalised by magnitude rather than by trusting a
 * documented unit, because getting this wrong in the lenient direction
 * (treating ms as seconds) makes every delivery look 50,000 years old
 * and rejects all of them, and getting it wrong in the strict direction
 * makes the window meaningless. A value that is neither is a refusal.
 */
export function timestampFresh(t: string, now = Date.now(), maxAgeMs = MAX_SIGNATURE_AGE_MS): boolean {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return false;
  const ms = n < 1e12 ? n * 1000 : n;
  return Math.abs(now - ms) <= maxAgeMs;
}

/** HMAC-SHA256 of `${t}.${rawBody}`, hex. The raw body, not a re-serialised one. */
export async function signPayload(secret: string, t: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
}

/**
 * Ask RevenueCat what is actually true about this subscriber.
 *
 * THE THREE OUTCOMES ARE KEPT DISTINCT, the `fetchNote` rule applied to
 * money. A 404 is DEFINITIVE — RevenueCat has never heard of this id,
 * which for our purposes means no entitlement — and may be acted on. A
 * 500, a timeout, a rate limit or an expired key is `failed`, and the
 * caller returns 5xx so RevenueCat retries. Reading those as "no
 * entitlement" would strip the tier off a paying student because a
 * request happened to fail, which is the exact confusion
 * RecoveryGate.recover shipped and the exact direction that costs the
 * most.
 */
async function fetchSubscriber(
  userId: string,
  secretKey: string
): Promise<{ ok: true; subscriber: Record<string, unknown> | null } | { ok: false; status?: number; error: unknown }> {
  try {
    const res = await fetch(`${REVENUECAT_API}/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json" },
    });
    if (res.status === 404) return { ok: true, subscriber: null };
    if (!res.ok) return { ok: false, status: res.status, error: new Error(`RevenueCat returned ${res.status}`) };
    const body = await res.json();
    return { ok: true, subscriber: (body?.subscriber ?? null) as Record<string, unknown> | null };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function handle(req: Request): Promise<Response> {
  let stage = "env_check";
  try {
    const env = (name: string) => Deno.env.get(name) ?? "";
    const missing = REQUIRED_ENV.filter((n) => !env(n).trim());
    if (missing.length) {
      logFailure(stage, new Error(`missing env: ${missing.join(", ")}`));
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }

    /* ---- authorize: the shared header, in constant time ---- */
    stage = "authorize";
    if (!timingSafeEqual(req.headers.get("authorization") ?? "", env("REVENUECAT_WEBHOOK_SECRET"))) {
      /* The refusal says WHICH check failed in the log and NOTHING in
         the response. A caller learning "the header was right but the
         signature was wrong" learns that they hold a valid header. */
      logFailure(stage, new Error("authorization header did not match"), { present: req.headers.has("authorization") });
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }

    /* ---- verify_signature: over the RAW BYTES, before any parse ---- */
    stage = "verify_signature";
    const raw = await req.text();
    const sig = parseSignatureHeader(req.headers.get("x-revenuecat-webhook-signature"));
    if (!sig) {
      logFailure(stage, new Error("signature header absent or unparseable"));
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }
    if (!timestampFresh(sig.t)) {
      logFailure(stage, new Error("signature timestamp outside the freshness window"), { t: sig.t });
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }
    const expected = await signPayload(env("REVENUECAT_WEBHOOK_SIGNING_SECRET"), sig.t, raw);
    if (!timingSafeEqual(sig.v1, expected)) {
      logFailure(stage, new Error("signature did not verify over the raw body"));
      return jsonResponse({ ok: false, code: "unauthorized" }, 401);
    }

    /* ---- parse: only now, and only for routing ---- */
    stage = "parse";
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      logFailure(stage, err);
      return jsonResponse({ ok: false, code: "bad_request" }, 400);
    }
    const event = (payload?.event ?? {}) as Record<string, unknown>;
    const eventId = typeof event.id === "string" ? event.id : "";
    const eventType = typeof event.type === "string" ? event.type : "UNKNOWN";
    if (!eventId) {
      logFailure(stage, new Error("event carries no id, so it cannot be recorded or deduplicated"), { type: eventType });
      return jsonResponse({ ok: false, code: "bad_request" }, 400);
    }
    logStage("parse", { event: eventType, id: eventId });

    const admin = getSupabaseAdmin();

    /* ---- already handled? a retry must cost nothing ---- */
    stage = "already_handled";
    const { data: seen, error: seenErr } = await admin
      .from("billing_events")
      .select("id")
      .eq("id", eventId)
      .maybeSingle();
    if (seenErr) {
      logFailure(stage, seenErr, { id: eventId });
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }
    if (seen) {
      logStage("already_handled", { id: eventId, outcome: "duplicate" });
      return jsonResponse({ ok: true, outcome: "duplicate" });
    }

    /* ---- who is this about? ---- */
    const userIds = affectedUserIds(event);
    if (userIds.length === 0) {
      /* An anonymous RevenueCat id, or one that is not UUID-shaped, is
         not one of our accounts. 200, because retrying will not change
         it — but logged, because a run of these means the client is
         configuring RevenueCat before sign-in, which is the thing
         _shared/entitlement.ts and the Phase 2 client rule exist to
         prevent. */
      logStage("no_account", { id: eventId, event: eventType, app_user_id: String(event.app_user_id ?? "").slice(0, 48) });
      return jsonResponse({ ok: true, outcome: "no_account" });
    }

    /* ---- re-read, then apply, per affected account ---- */
    const results: Array<{ userId: string; tier: BillingTier; outcome: string; before?: string | null }> = [];
    for (const userId of userIds) {
      stage = "subscriber_read";
      const fetched = await fetchSubscriber(userId, env("REVENUECAT_SECRET_KEY"));
      if (!fetched.ok) {
        /* NOT "no entitlement". A failed read is unknown, and 5xx is
           what makes RevenueCat deliver this event again rather than
           us stripping a tier off somebody whose request timed out. */
        logFailure(stage, fetched.error, { id: eventId, status: fetched.status });
        return jsonResponse({ ok: false, code: "upstream_unavailable" }, 503);
      }

      const { tier, store, expiresAt } = tierFromSubscriber(fetched.subscriber);

      stage = "apply";
      const applied = await applyEntitlement(admin, { userId, tier, store, expiresAt });
      if (!applied.ok) {
        logFailure(stage, applied.error, { id: eventId, outcome: applied.outcome });
        return jsonResponse({ ok: false, code: "server_error" }, 500);
      }
      logStage("apply", { id: eventId, event: eventType, outcome: applied.outcome, before: applied.before ?? null, after: tier });
      results.push({ userId, tier, outcome: applied.outcome, before: applied.before ?? null });
    }

    /* ---- record, AFTER applying ---- */
    stage = "record";
    const primary = results[0];
    const { error: recordErr } = await admin.from("billing_events").insert({
      id: eventId,
      user_id: primary.userId,
      event_type: eventType,
      store: typeof event.store === "string" ? event.store.toLowerCase() : null,
      tier_before: primary.before ?? null,
      tier_after: primary.tier,
    });
    if (recordErr) {
      /* 23505 is a CONCURRENT duplicate — two deliveries of the same
         event racing. Definitive, and it means the work is done, so it
         is read as success rather than retried. Every other code is a
         real write failure: the tier IS applied at this point, so a
         retry re-applies it harmlessly and records it, which is the
         direction the apply-before-record ordering was chosen for. */
      if ((recordErr as { code?: string }).code === "23505") {
        logStage("record", { id: eventId, outcome: "duplicate_race" });
        return jsonResponse({ ok: true, outcome: "duplicate" });
      }
      logFailure(stage, recordErr, { id: eventId });
      return jsonResponse({ ok: false, code: "server_error" }, 500);
    }

    return jsonResponse({ ok: true, outcome: "applied", accounts: results.length });
  } catch (err) {
    logFailure(stage, err);
    return jsonResponse({ ok: false, code: "server_error" }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  /* GET is answered so a human can confirm the function is deployed and
     reachable without sending a signed body. It says nothing about
     configuration — a 200 here with a dead signing secret still 401s
     every real delivery, which is why the first real proof is a test
     event from the dashboard, not this. */
  if (req.method === "GET") return jsonResponse({ ok: true, fn: "billing-webhook" });
  if (req.method !== "POST") return jsonResponse({ ok: false, code: "bad_request" }, 405);
  return await handle(req);
});

/* WHY THERE IS NO `verify_jwt` HERE, and why that is safe.
   RevenueCat cannot mint a Supabase JWT, so this function must be
   deployed with --no-verify-jwt. That removes the platform's check and
   replaces it with two of our own (a shared header and an HMAC over the
   raw body), plus the property that makes the whole thing hold: even a
   caller who defeats both can only cause a re-read. The deploy step
   that passes --no-verify-jwt is enumerated in deploy-functions.yml,
   and a wiring test asserts it stays there — a function silently
   redeployed WITH jwt verification 401s every delivery and the symptom
   is "subscriptions never activate". */
