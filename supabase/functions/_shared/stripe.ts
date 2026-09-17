/* ==================================================================
   stripe.ts — the Stripe half of billing, in one place

   THE ROUTE THIS TAKES, and it is a decision worth reading before
   changing anything here. BILLING-PLAN §6 mapped TWO ways for a Stripe
   subscription to become a tier:

     A. RevenueCat ingests it — Stripe's webhooks point at RevenueCat,
        the subscription is registered by POSTing to their receipts
        endpoint with `X-Platform: stripe`, and from then on it arrives
        as the same RevenueCat webhook the stores produce.
     B. Stripe's OWN webhook, HMAC-signed, feeding the same
        `applyEntitlement()`. Two sources, one writer.

   **B is what is built.** Every step of A is marked `[confirm every
   step]` in the plan because it rests on RevenueCat documentation this
   container cannot reach, and a build machine cannot close that gap —
   whereas B is verifiable end to end against Stripe test mode with the
   Stripe CLI and nothing else. The plan names B as the fallback for
   exactly this case. What B gives up is one dashboard showing every
   subscriber: a Stripe subscription will not appear in RevenueCat.
   That is the cost, and it is recoverable later — the receipts POST
   can be added beside this without moving the writer.

   NO SDK. Raw `fetch` against api.stripe.com with form encoding is
   about thirty lines and every one of them is inspectable and
   injectable; an SDK would be a dependency whose behaviour this
   container also cannot verify, wrapped around the same HTTP calls.
   The AI providers are called the same way, for the same reason.

   WHAT CANNOT BE VERIFIED FROM HERE, said plainly rather than implied
   by a green suite: Stripe's real event shapes, its real signature
   header, and whether a Checkout session created with these parameters
   is accepted. The signature scheme implemented below is the one
   RevenueCat's is modelled on and the two are byte-identical in shape
   — which is a reason to expect it to be right and NOT evidence that
   it is. BILLING-PLAN.md Phase 6 has the
   test-mode checklist.
   ================================================================== */

import { TIER_RANK, type BillingTier } from "./entitlement.ts";

const STRIPE_API = "https://api.stripe.com/v1";

/* PINNED, because an API version is exactly the kind of thing that
   changes underneath you and reshapes a response. Stripe defaults an
   unpinned request to whatever the account's dashboard is set to —
   a value nobody in this repository can see. Declared here rather than
   beside its use, because this project has a temporal-dead-zone bug in
   its history and a const read above its declaration reads wrong even
   where it is legal.

   IT MUST MATCH THE VERSION THE ENDPOINT DELIVERS, and that is a
   second reason on top of the first. The pin decides the shape of the
   subscription we RE-READ; the endpoint's own version decides the
   shape of the event we were SENT. Nothing here trusts the delivered
   body for anything but an id, so a mismatch is not immediately
   fatal — which is exactly why it would sit unnoticed until a field
   moved between versions and the re-read stopped carrying it.

   2026-04-22.dahlia, set to match the endpoint Jared's first real
   deliveries came from. **This pin is not verifiable from this
   repository**: no test here can reach Stripe to ask what the endpoint
   is set to, so the two are kept in step by whoever changes either
   one. If the dashboard endpoint is moved, move this in the same
   commit.

   WHERE A COMPLETED CHECKOUT RETURNS TO. Derived from nothing at
   runtime: taking it from the request's Origin header would be an open
   redirect with a signed-in session attached. It MIRRORS
   src/legalLinks.js's APP_URL — a browser bundle and a Deno function
   cannot share a module — and a test asserts the two are equal.

   IT IS `APP_URL` SINCE THE PATH SPLIT, and the change is one path
   segment with a real consequence. `/` is the marketing page now: it
   has no session, no Plans panel and nothing to tell somebody who has
   just paid, so a return URL left at the root lands a student on an
   advertisement for the product they have that moment bought.

   THE ORIGIN DID NOT MOVE, which is why this is a smaller change than
   it looks — same host, same cookies, same everything a browser keys
   on. Only the path is deeper.

   A SESSION ALREADY CREATED KEEPS THE URL IT WAS CREATED WITH: Stripe
   stores these on the session, so this reaches new checkouts only. The
   marketing page forwards `?checkout=` on the root to the app for the
   ones in flight across the deploy (public/site/site.js). */
export const STRIPE_API_VERSION = "2026-04-22.dahlia";
export const APP_URL = "https://www.uniplannerapp.com/app";
export const CHECKOUT_SUCCESS_URL = `${APP_URL}/?checkout=done`;
export const CHECKOUT_CANCEL_URL = `${APP_URL}/?checkout=cancelled`;

/* THE SIX PRICES, keyed by a `lookup_key` WE choose on the Stripe Price.

   WHY NOT THE PRICE ID: `price_1A2b3C…` is generated by Stripe, so a
   table of them here would be a restatement of a dashboard with no
   source of truth in this repository — and the id differs between test
   mode and live mode, so the table would have to be right twice. A
   lookup key is a value we pick, identical in both modes, and it is
   the same shape as the RevenueCat package identifiers in
   src/purchasePlans.js — which a test asserts these agree with, so a
   tier or a duration renamed in one place goes red.

   AND THE CLIENT NEVER SENDS A PRICE. It asks for a tier and a
   duration; the server resolves which Price that is. A client that
   named the price could name a cheaper one — the same reasoning that
   makes the uid come from the JWT rather than the request body. */
export const STRIPE_LOOKUP_KEYS: Record<string, { tier: BillingTier; duration: string }> = {
  uniplanner_studyai_monthly: { tier: "ai", duration: "monthly" },
  uniplanner_studyai_sixmonth: { tier: "ai", duration: "sixmonth" },
  uniplanner_studyai_annual: { tier: "ai", duration: "annual" },
  uniplanner_studyaimax_monthly: { tier: "ai_max", duration: "monthly" },
  uniplanner_studyaimax_sixmonth: { tier: "ai_max", duration: "sixmonth" },
  uniplanner_studyaimax_annual: { tier: "ai_max", duration: "annual" },
};

/** The lookup key for a (tier, duration) pair, or null if it is not one we sell. */
export function lookupKeyFor(tier: string, duration: string): string | null {
  for (const [key, plan] of Object.entries(STRIPE_LOOKUP_KEYS)) {
    if (plan.tier === tier && plan.duration === duration) return key;
  }
  return null;
}

/* WHICH SUBSCRIPTION STATUSES COUNT AS ENTITLED, and the two awkward
   ones are the point of writing this down.

   `past_due` IS ENTITLED. Stripe is retrying the card; the App Store's
   billing grace period behaves the same way, and BILLING-PLAN already
   says the re-read design keeps a tier through it without any code
   knowing grace periods exist. Cutting somebody off on the first failed
   retry is a support ticket from a student whose bank declined once.

   `unpaid` IS NOT. That is Stripe having finished retrying.

   `trialing` IS, obviously, and `canceled` is not — but note that a
   subscription cancelled AT PERIOD END stays `active` until the period
   ends, so "they cancelled" does not remove access early. That matches
   what both stores do and what the refund section of BILLING-PLAN
   says. */
export const ENTITLED_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

/* Every status Stripe documents today. It exists so that an UNKNOWN
   status — one added after this was written — is told apart from a
   known-and-not-entitled one. Reading a new status as "not entitled"
   would end the plan of everybody who happened to be in it. */
export const ALL_KNOWN_STATUSES: readonly string[] = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
];

/**
 * The tier a Stripe SUBSCRIPTION implies — the whole decision, pure, so
 * the awkward cases are a table in a test rather than something only a
 * real Stripe account can answer.
 *
 * Takes a subscription object RE-READ from Stripe, never one lifted out
 * of a delivered webhook body. Same rule as `tierFromSubscriber`: the
 * payload is a trigger, the record is the truth.
 *
 * Returns `free` for anything not entitled, which is the right answer
 * for cancelled, unpaid, incomplete and never-subscribed alike — and is
 * what a `customer.subscription.deleted` event resolves to without any
 * code knowing what deletion means.
 *
 * **AND `recognised` IS THE ONE THAT MATTERS.** A subscription in an
 * entitled status whose items match NO lookup key we know is not a
 * student entitled to nothing — it is a question this function cannot
 * answer, and the two are catastrophically different in one direction:
 * a `lookup_key` missing from a response, or a price created in the
 * dashboard without one, would silently DOWNGRADE every paying Stripe
 * subscriber to free. That is the `fetchNote` rule pointed at money,
 * and the caller is required to refuse rather than write when this is
 * false.
 */
export function tierFromStripeSubscription(
  subscription: Record<string, unknown> | null | undefined
): { tier: BillingTier; expiresAt: string | null; lookupKey: string | null; recognised: boolean; periodSource?: string; periodType?: string } {
  const none = { tier: "free" as BillingTier, expiresAt: null, lookupKey: null, recognised: true };
  /* NOT recognised: there is nothing here to read at all. */
  if (!subscription || typeof subscription !== "object") return { ...none, recognised: false };

  const status = String((subscription as { status?: unknown }).status ?? "");
  /* A status we know and that is not entitled is a DEFINITIVE answer.
     A status we have never heard of is not — Stripe adding one would
     otherwise cancel everybody holding it. */
  if (!ENTITLED_STATUSES.includes(status)) {
    return { ...none, recognised: ALL_KNOWN_STATUSES.includes(status) };
  }

  const items = ((subscription as { items?: { data?: unknown[] } }).items?.data ?? []) as Array<Record<string, unknown>>;

  /* HIGHEST WINS, the same rule the store side uses. A subscription
     with two items is not something we create, but a Portal plan change
     can leave one mid-flight, and answering with whichever item sorted
     first would be a coin toss over somebody's plan. */
  let best: { rank: number; key: string; item: Record<string, unknown> } | null = null;
  for (const item of items) {
    const price = (item?.price ?? {}) as { lookup_key?: unknown };
    const key = typeof price.lookup_key === "string" ? price.lookup_key : "";
    const plan = STRIPE_LOOKUP_KEYS[key];
    if (!plan) continue;
    const rank = TIER_RANK.indexOf(plan.tier);
    if (!best || rank > best.rank) best = { rank, key, item };
  }
  /* Entitled, and nothing matched. See the note above: this is the
     downgrade-everybody case, so it is reported as unanswerable. */
  if (!best) return { ...none, recognised: false };

  const period = periodEndOf(subscription, best.item);

  return {
    tier: TIER_RANK[best.rank],
    expiresAt: period.expiresAt,
    lookupKey: best.key,
    recognised: true,
    /* Which shape carried it, for the log. See periodEndOf. */
    periodSource: period.source,
    periodType: period.type,
  };
}

/**
 * When this subscription's paid period ends — read from EITHER place
 * Stripe puts it, because which one depends on the API version.
 *
 * WHICH ONE THE LIVE API SENDS IS NOW ANSWERED: the ITEM. Confirmed on
 * a real purchase, 17 September 2026, `2026-04-22.dahlia` — two events,
 * both logging `"periodSource":"item","periodType":"number"`, and the
 * entitlement row carrying a correct expiry. This paragraph replaces
 * one saying the question was not answerable from this repository,
 * which was true and is exactly why `periodSource` is logged on EVERY
 * apply rather than only on failure: the answer had to come back from
 * a delivery, and it did.
 *
 * SO THE ITEM READ IS THE PRODUCTION PATH, not a defensive extra, and
 * it must not be removed as unused. `test-stripe.mjs` makes that
 * structural rather than a request: its default fixture is this shape,
 * so deleting the item read reddens most of that file rather than
 * three cases named for it.
 *
 * AND THE SUBSCRIPTION-LEVEL FALLBACK STAYS. What is confirmed is what
 * this pinned version sends TODAY; a pin is a thing somebody changes,
 * and the older shape is still correct when it is the only one
 * present. Deleting the fallback because production does not exercise
 * it would be the same mistake as the original null, pointing the
 * other way — one shape observed, the other assumed absent.
 *
 * THE BUG THIS EXISTS FOR. A live subscription wrote an `entitlements`
 * row with `expires_at` NULL while `current_period_end: 1791547235` was
 * plainly there in the payload. The read was
 * `subscription.current_period_end` and nothing else, so a version that
 * moved the field onto the ITEMS produced a null with no error
 * anywhere — and the pin moved to `2026-04-22.dahlia` the same morning,
 * which was offered as the coherent (not confirmed) explanation for why
 * it appeared exactly then. THE LIVE READ ABOVE CONFIRMS IT: that
 * version really does carry the period on the item, so the timing was
 * the pin and not a coincidence.
 *
 * A NULL EXPIRY IS NOT MERELY MISSING DATA HERE, and that is why this
 * is worth its own function. `tierFromProviders` reads a null
 * `expires_at` as NON-EXPIRING — correct for a lifetime grant, and for
 * a Stripe subscription it is the opposite of the truth. It disables
 * the one backstop that catches a provider going quiet, in the silent
 * and permanent direction `isActive` names.
 *
 * SO IT READS BOTH, and reports WHICH. The item comes first because on
 * a version that carries it there it is the per-line answer, and a
 * subscription mid-plan-change can hold two items with different
 * periods — the one granting the tier is the one that decides. The
 * subscription's own field is the fallback, which is the older shape
 * and still correct when it is the only one present.
 *
 * ONLY THE WINNING ITEM IS CONSULTED, never a sibling: taking another
 * line's period would answer a question about a plan the student is
 * not on.
 *
 * A UNIX SECONDS INTEGER, and it is the one field here that would
 * silently be WRONG rather than absent: read as milliseconds it lands
 * in 1970 and every entitlement reads expired. Nothing is coerced —
 * a value that is not a finite number is reported with its TYPE rather
 * than parsed, so the next delivery says what actually arrived instead
 * of being guessed at now.
 */
export function periodEndOf(
  subscription: Record<string, unknown> | null | undefined,
  item: Record<string, unknown> | null | undefined
): { expiresAt: string | null; source: "item" | "subscription" | "absent"; type: string } {
  const fromItem = (item ?? {})["current_period_end"];
  const fromSub = (subscription ?? {})["current_period_end"];

  const usable = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const picked = usable(fromItem) ? { v: fromItem, source: "item" as const } : usable(fromSub) ? { v: fromSub, source: "subscription" as const } : null;

  if (!picked) {
    /* Named so a log line distinguishes "the field was absent" from
       "the field was there and was not a number", which are different
       failures with different fixes. */
    const type = fromItem !== undefined ? `item:${typeof fromItem}` : fromSub !== undefined ? `subscription:${typeof fromSub}` : "absent";
    return { expiresAt: null, source: "absent", type };
  }
  return { expiresAt: new Date((picked.v as number) * 1000).toISOString(), source: picked.source, type: "number" };
}

/**
 * WHICH SUBSCRIPTION AN INVOICE IS FOR — read from EITHER place Stripe
 * puts it, for exactly the reason `periodEndOf` above exists.
 *
 * Stripe moved `invoice.subscription` under
 * `invoice.parent.subscription_details.subscription` in the 2025
 * versions, the same kind of move that made `current_period_end`
 * produce a silent NULL. **This is that lesson applied rather than
 * re-learned:** reading only the classic field would make every refund
 * look like a non-subscription charge on a version that carries it
 * under `parent`, and the failure would be a refunded student keeping
 * a month of credits — silent, and in the direction that costs us
 * money rather than erroring.
 *
 * IT WAS NOT ANSWERABLE FROM THIS REPOSITORY, so `source` is logged on
 * every refund — the arrangement that answered the period question from
 * a live delivery. **AND IT CAME BACK: `parent`.** Confirmed on the
 * first real refund, 18 September 2026, which logged
 * `"invoice_source":"parent"`. So on this pinned version the classic
 * `invoice.subscription` never answers, exactly as `charge.invoice`
 * never answers one hop earlier — and `test-stripe.mjs`'s default
 * invoice fixture is the `parent` shape for that reason.
 *
 * The classic field is still preferred when present: it is the one
 * Stripe has always meant, and a version that stops sending the nested
 * form leaves it to answer. An observation tells you which branch is
 * live, never that the other one is dead.
 */
export function invoiceSubscriptionOf(
  invoice: Record<string, unknown> | null | undefined
): { subscriptionId: string; source: "invoice" | "parent" | "absent" } {
  const classic = (invoice ?? {})["subscription"];
  if (typeof classic === "string" && classic) return { subscriptionId: classic, source: "invoice" };

  const parent = (invoice ?? {})["parent"] as { subscription_details?: { subscription?: unknown } } | undefined;
  const nested = parent?.subscription_details?.subscription;
  if (typeof nested === "string" && nested) return { subscriptionId: nested, source: "parent" };

  return { subscriptionId: "", source: "absent" };
}

/**
 * Does this refund end a subscription?
 *
 * THE COPY PROMISED IT AND NOTHING DID IT. `plansCopy.js` tells a
 * student that "if a subscription is refunded, the plan ends straight
 * away and goes back to Free" — and `charge.refunded` was not among
 * the subscribed events, so on the web a refund did nothing to the
 * tier at all. A refunded student kept a month of credits. Copy and
 * behaviour disagreed, and the copy is the promise, so the behaviour
 * moved.
 *
 * TWO CONDITIONS, AND BOTH ARE LOAD-BEARING:
 *
 * - **The refund must be FULL.** `charge.refunded` fires on every
 *   refund including partial ones, so a goodwill $2 back would
 *   otherwise cancel a plan somebody is still paying for. Stripe sets
 *   `refunded: true` only when the whole charge is returned; the
 *   amounts are NOT compared here, because that arithmetic is Stripe's
 *   and a rounding disagreement would silently end a subscription.
 * - **The charge must be for a subscription invoice.** A one-off
 *   payment carries no invoice, and an invoice can exist without a
 *   subscription. Neither is a reason to touch anybody's plan.
 *
 * The reasons are NAMED rather than collapsed into a boolean, because
 * a log saying "ignored" over a real refund that we misread is
 * indistinguishable from one over a partial refund of a hardware
 * invoice — and those need different fixes.
 */
/**
 * WHICH INVOICE A CHARGE PAID — and `charge.invoice` is not the answer
 * on the version we pin.
 *
 * **THE BUG THIS EXISTS FOR, live on 18 September 2026.** Every real
 * subscription refund ended at `not_an_invoice`, answered 200, and
 * changed nothing: the tier stayed paid on a refunded subscription.
 * `refundEndsSubscription` read `charge.invoice`, and from
 * **2025-03-31.basil** a Charge no longer carries one — the link from a
 * payment to its invoice moved to the **InvoicePayment** object. We pin
 * `2026-04-22.dahlia`, so that field has been absent on every delivery
 * since the endpoint was created, and the confirmed live payload has no
 * `invoice` key at all.
 *
 * SO THIS IS THE FIELD-MOVE LESSON FOR THE THIRD TIME, and the third
 * one arrived inside the commit that cited the second. #107 added
 * `invoiceSubscriptionOf` to read `invoice.subscription` from both
 * places, with a comment calling it "the field-move lesson applied
 * rather than re-learned" — while the field one level UP, the one that
 * gets you to the invoice in the first place, had already moved and the
 * fixture invented it. **The lesson was applied to the field being
 * thought about, not to the field being read.**
 *
 * THE LEGACY FIELD IS STILL READ FIRST, for the reason `periodEndOf`
 * keeps its fallback: what is confirmed is what this PINNED version
 * sends today, and a pin is a thing somebody changes. An observation
 * tells you which branch is live, never that the other one is dead.
 */
export function invoiceIdForCharge(
  charge: Record<string, unknown> | null | undefined,
  invoicePayments: Record<string, unknown> | null | undefined
): { invoiceId: string; source: "charge" | "invoice_payments" | "absent" } {
  const legacy = (charge ?? {})["invoice"];
  if (typeof legacy === "string" && legacy) return { invoiceId: legacy, source: "charge" };

  /* The list endpoint's shape: `{ data: [ { invoice, payment, status } ] }`.
     ONLY THE FIRST is taken — the query is filtered to one payment
     intent and limited to one row, so a second would be a different
     payment and answering with it would cancel a subscription the
     refund was not about. */
  const rows = ((invoicePayments ?? {})["data"] ?? []) as Array<Record<string, unknown>>;
  const first = Array.isArray(rows) ? rows[0] : undefined;
  const fromPayment = (first ?? {})["invoice"];
  if (typeof fromPayment === "string" && fromPayment) return { invoiceId: fromPayment, source: "invoice_payments" };

  return { invoiceId: "", source: "absent" };
}

export function refundEndsSubscription(
  charge: Record<string, unknown> | null | undefined,
  invoiceId: string,
  invoice: Record<string, unknown> | null | undefined
): {
  subscriptionId: string;
  reason: "ends_subscription" | "partial_refund" | "not_an_invoice" | "not_a_subscription";
  invoiceSource: "invoice" | "parent" | "absent";
} {
  const none = { subscriptionId: "", invoiceSource: "absent" as const };

  /* PARTIAL FIRST, because it is the condition that protects a paying
     student, and it is true of a charge that never reached an invoice
     lookup at all. */
  if ((charge ?? {})["refunded"] !== true) return { ...none, reason: "partial_refund" };

  /* THE INVOICE ID IS NOW AN ARGUMENT rather than a field of the
     charge, because getting it takes a second request on this API
     version. `invoiceIdForCharge` is what answers it. */
  if (!invoiceId) return { ...none, reason: "not_an_invoice" };

  const { subscriptionId, source } = invoiceSubscriptionOf(invoice);
  if (!subscriptionId) return { ...none, reason: "not_a_subscription", invoiceSource: source };

  return { subscriptionId, reason: "ends_subscription", invoiceSource: source };
}

/** The list query that finds an invoice from the payment intent that paid it. */
export const invoicePaymentsQuery = (paymentIntentId: string) =>
  `/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(paymentIntentId)}&limit=1`;

/**
 * The code a caller should answer with when a Stripe call failed.
 *
 * A PERMISSION ERROR IS NOT AN OUTAGE and must not read as one. Both
 * still return 5xx — for the webhook because the event must not be
 * lost, and a retry after somebody fixes the key is exactly the right
 * behaviour — but the CODE says which, so "students pay and nothing
 * happens" is distinguishable in a log from "Stripe was briefly
 * unreachable" without reading the message.
 */
export const stripeFailureCode = (res: { forbidden?: boolean }) =>
  res.forbidden ? "stripe_permission_denied" : "upstream_unavailable";

/* ---------- talking to Stripe ---------- */

/** Stripe takes form-encoded bodies, including for nested fields (`a[b]=c`). */
export function formEncode(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out.set(k, String(v));
  }
  return out.toString();
}

/**
 * One request to Stripe.
 *
 * THREE OUTCOMES, KEPT DISTINCT — the `fetchNote` rule, which by now is
 * the house style: `{ok, data}`, `{ok:false, missing:true}` for a
 * definitive 404, and `{ok:false}` for everything else. A caller that
 * cannot tell "Stripe says there is no such subscription" from "we
 * could not reach Stripe" would strip a paying student's tier because a
 * request timed out.
 *
 * `idempotencyKey` is passed on WRITES so a retried checkout creates one
 * session rather than two. Stripe's own mechanism; free to use.
 */
export async function stripeRequest(
  path: string,
  {
    secretKey,
    method = "GET",
    body,
    idempotencyKey,
    fetchImpl = fetch,
  }: {
    secretKey: string;
    method?: "GET" | "POST" | "DELETE";
    body?: Record<string, string | number | undefined | null>;
    idempotencyKey?: string;
    fetchImpl?: typeof fetch;
  }
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; missing?: true; forbidden?: boolean; status?: number; error: unknown }
> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
    };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const res = await fetchImpl(`${STRIPE_API}${path}`, {
      method,
      headers,
      body: method === "POST" ? formEncode(body || {}) : undefined,
    });
    if (res.status === 404) return { ok: false, missing: true, status: 404, error: new Error("Stripe: not found") };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* STRIPE'S OWN MESSAGE, CARRIED RATHER THAN DISCARDED. This line
         used to throw the body away and substitute `Stripe returned
         403`, and the body is where the remedy lives: a permission
         error names the grant to enable, in as many words
         ("Enabling Charges and Refunds Read ('charge_read')
         permissions on this key would allow this request to
         continue"). That sentence was already parsed and already in
         memory, and dropping it cost a live diagnosis that needed the
         dashboard instead.
         It goes into the Error rather than a new field so every
         existing `logFailure` picks it up with no caller change. */
      const detail = (((data as { error?: { message?: unknown } }).error || {}).message) ?? "";
      const suffix = typeof detail === "string" && detail ? `: ${detail}` : "";
      return {
        ok: false,
        status: res.status,
        /* 401 and 402/403 are OUR CONFIGURATION, not an outage, and a
           retry cannot fix either — so they are told apart here rather
           than collapsed into the same shape as a timeout. Same
           three-outcomes discipline this function already applies to
           404. */
        forbidden: res.status === 401 || res.status === 403,
        error: new Error(`Stripe returned ${res.status}${suffix}`),
      };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error };
  }
}

/* ---------- the webhook signature ---------- */

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time compare. Same reasoning as billing-webhook's: a `===` on a secret leaks how much of it was guessed. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Parse `t=<ts>,v1=<hex>[,v1=<hex>]` — Stripe's `Stripe-Signature`.
 *
 * MULTIPLE `v1` VALUES ARE REAL and this is the detail a naive parser
 * gets wrong: during a signing-secret rotation Stripe sends one `v1`
 * per active secret, so a parser that keeps the last one it saw rejects
 * half the deliveries for the length of the rotation. They are all
 * collected and any match is accepted.
 */
export function parseStripeSignature(header: string | null): { t: string; v1: string[] } | null {
  if (!header) return null;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const value = rest.join("=").trim();
    if (k.trim() === "t") t = value;
    if (k.trim() === "v1" && value) v1.push(value);
  }
  if (!t || v1.length === 0) return null;
  return { t, v1 };
}

/** HMAC-SHA256 of `${t}.${rawBody}`, hex. THE RAW BODY — never a re-serialised one. */
export async function signStripePayload(secret: string, t: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
}

/** How stale a delivery may be. A signature proves the body was signed, not that it was signed recently. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** Stripe's timestamp is UNIX SECONDS. Read as milliseconds every delivery looks 56,000 years old and is refused. */
export function stripeTimestampFresh(t: string, now = Date.now(), maxAgeMs = MAX_SIGNATURE_AGE_MS): boolean {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return false;
  return Math.abs(now - n * 1000) <= maxAgeMs;
}
