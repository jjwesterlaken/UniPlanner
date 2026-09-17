/* Stripe — Phase 6, built and switched off.
 *
 * TWO ROUTES WERE MAPPED and this tests the one that was built:
 * Stripe's own HMAC-signed webhook feeding the SAME `applyEntitlement()`
 * the store webhook uses. Two sources, one writer.
 * `supabase/functions/_shared/stripe.ts` has the reasoning, including
 * what the other route would have cost and why a build machine cannot
 * choose it: every step of it rests on RevenueCat documentation this
 * container cannot reach.
 *
 * THE CLAIM THAT MATTERS MOST, and it is not the signature: **a
 * subscription whose price we do not recognise must not be read as an
 * entitlement to nothing.** A `lookup_key` missing from a response, or
 * a Price created in the dashboard without one, would otherwise
 * silently downgrade every paying Stripe subscriber to free on the next
 * renewal event. `recognised` is the flag that keeps those apart and
 * the webhook refuses rather than writing when it is false.
 *
 * WHAT THIS CANNOT SEE, said here rather than implied by a pass. Stripe
 * itself: the real event shapes, the real signature header, whether a
 * Checkout session created with these parameters is accepted, and
 * whether the six Prices charge what `site/pricing.js` says. The
 * signature scheme implemented here is the one RevenueCat's is modelled
 * on and the two are identical in shape — a reason to expect it to be
 * right and NOT evidence that it is. BILLING-PLAN.md Phase 6 holds the
 * Stripe test-mode checklist, and it is the whole of the verification.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stripe-fn-"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  - ${name}\n        ${err.message}`);
  }
}

/* ---------- the pure half, imported directly ---------- */

const stripe = await import(pathToFileURL(path.join(rootDir, "supabase/functions/_shared/stripe.ts")).href);
const ent = await import(pathToFileURL(path.join(rootDir, "supabase/functions/_shared/entitlement.ts")).href);
const plans = await import(pathToFileURL(path.join(rootDir, "src/purchasePlans.js")).href);
const flags = await import(pathToFileURL(path.join(rootDir, "src/billingFlags.js")).href);
const prices = await import(pathToFileURL(path.join(rootDir, "src/webPrices.js")).href);
const copy = await import(pathToFileURL(path.join(rootDir, "src/plansCopy.js")).href);
const links = await import(pathToFileURL(path.join(rootDir, "src/legalLinks.js")).href);

/* ---------- the handlers, bundled with the platform stubbed ---------- */

const stubDir = path.join(tmpDir, "stubs");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, "supabase.js"),
  `export function createClient() { return globalThis.__FAKE_CLIENT__; }
   export class SupabaseClient {}\n`
);

async function bundleFunction(name) {
  const out = await build({
    entryPoints: [path.join(rootDir, `supabase/functions/${name}/index.ts`)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    plugins: [
      { name: "stub", setup: (b) => b.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: path.join(stubDir, "supabase.js") })) },
    ],
  });
  const file = path.join(tmpDir, `${name}.mjs`);
  fs.writeFileSync(file, out.outputFiles[0].text);
  return file;
}

const WEBHOOK = await bundleFunction("stripe-webhook");
const CHECKOUT = await bundleFunction("billing-checkout");
const PORTAL = await bundleFunction("billing-portal");

const SECRET_KEY = "sk_test_notarealkey";
const SIGNING_SECRET = "whsec_notarealsecret";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * The world a handler runs in: an ordered trace of everything it did,
 * so an ORDERING claim is an assertion rather than a hope, and every
 * write with its filters, so a mis-scoped one is visible even where its
 * effect would not be.
 */
function makeWorld({ profiles = {}, events = {}, entitlements = {}, env = {}, stripeRoutes = {}, seenError = null } = {}) {
  const trace = [];
  const writes = [];
  const stripeCalls = [];
  const logs = [];

  const table = (name) => {
    const filters = [];
    let op = null;
    let values = null;
    const chain = {
      select() {
        op = "select";
        return chain;
      },
      update(v) {
        op = "update";
        values = v;
        return chain;
      },
      insert(v) {
        trace.push(`db:${name}.insert`);
        const row = Array.isArray(v) ? v[0] : v;
        writes.push({ table: name, op: "insert", values: row, filters: [] });
        /* ONE TABLE PER STORE, and it had to be said out loud. This
           model used to put EVERY insert into `events` regardless of
           table, which was harmless while `billing_events` was the only
           thing inserted — and the moment `recordFailure` started
           writing `function_errors`, a recorded failure counted as a
           recorded EVENT and "nothing was recorded" failed on a
           function that had recorded nothing of the kind. A fake that
           does not model table identity answers a question about one
           table with another's rows. */
        if (name !== "billing_events") return Promise.resolve({ data: row, error: null });
        if (Object.prototype.hasOwnProperty.call(events, row.id)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
        }
        events[row.id] = row;
        return Promise.resolve({ data: row, error: null });
      },
      /* One row per (user_id, source), the shape migration 0020 keys.
         Modelled, so the idempotency claim is made in the billing
         suite's section 7b against the real constraint and not here —
         what this needs is for the record step to SUCCEED, so the
         derive and the write happen and the order tests are about
         order rather than about a missing table. */
      upsert(v, opts = {}) {
        trace.push(`db:${name}.upsert`);
        const row = Array.isArray(v) ? v[0] : v;
        writes.push({ table: name, op: "upsert", values: row, filters: [] });
        if (!opts.onConflict) throw new Error(`makeWorld: upsert on ${name} with no onConflict`);
        entitlements[`${row.user_id}|${row.source}`] = { ...row };
        return Promise.resolve({ data: null, error: null });
      },
      eq(col, val) {
        filters.push([col, val]);
        return chain;
      },
      maybeSingle() {
        trace.push(`db:${name}.select`);
        const by = Object.fromEntries(filters);
        if (name === "profiles") {
          const row = by.user_id
            ? profiles[by.user_id]
            : Object.values(profiles).find((r) => by.stripe_customer_id && r.stripe_customer_id === by.stripe_customer_id);
          return Promise.resolve({ data: row ? { ...row } : null, error: null });
        }
        if (name === "billing_events") {
          /* The idempotency READ, made to fail on demand. PGRST303
             ("JWT issued at future") is what a real skew between the
             edge runtime and PostgREST produced on the first Stripe
             deliveries; the point of the option is that the code path
             must not care WHICH error it was. */
          if (seenError) return Promise.resolve({ data: null, error: seenError });
          return Promise.resolve({ data: events[by.id] ? { ...events[by.id] } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        /* An awaited SELECT is a LIST — the derive step reads every
           provider row for the account. Returning one row would make
           the max agree with whatever was just written, which is the
           fake-that-swallows-calls failure. */
        if (op === "select") {
          trace.push(`db:${name}.select`);
          const by = Object.fromEntries(filters);
          const rows = Object.values(entitlements).filter((r) => r.user_id === by.user_id);
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        }
        if (op !== "update") return resolve({ data: null, error: null });
        trace.push(`db:${name}.update`);
        writes.push({ table: name, op: "update", values, filters: [...filters] });
        const by = Object.fromEntries(filters);
        const row = profiles[by.user_id];
        if (row) Object.assign(row, values);
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };

  globalThis.__FAKE_CLIENT__ = {
    from: table,
    auth: {
      getUser: async (jwt) => {
        trace.push("auth:getUser");
        const id = jwt && jwt.startsWith("token:") ? jwt.slice(6) : "";
        if (!id) return { data: null, error: new Error("bad token") };
        return { data: { user: { id } }, error: null };
      },
    },
  };
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srv", STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: SIGNING_SECRET, ...env }[k]) },
    serve: () => {},
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    stripeCalls.push({ url: u, method: (init && init.method) || "GET", body: (init && init.body) || "" });
    trace.push(`stripe:${(init && init.method) || "GET"} ${u.replace("https://api.stripe.com/v1", "")}`);
    for (const [pattern, answer] of Object.entries(stripeRoutes)) {
      if (u.includes(pattern)) {
        const value = typeof answer === "function" ? answer(init) : answer;
        if (value && value.__status) {
          /* THE BODY IS HANDED BACK, not swallowed. A fake that returns
             `{}` on an error makes every caller agree that there was no
             message — which is how the assertion below first passed
             while Stripe's message could not possibly have reached the
             log. `__body` defaults to empty so existing routes are
             unchanged. */
          const body = value.__body ?? {};
          return { ok: false, status: value.__status, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));

  return {
    trace,
    writes,
    stripeCalls,
    logs,
    profiles,
    events,
    entitlements,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sign(secret, t, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
}

/** Deliver a webhook. `raw` and `signBody` are separate so "the signature covers other bytes" is testable. */
async function deliver(event, opts = {}) {
  const raw = opts.raw ?? JSON.stringify(event);
  const t = String(opts.t ?? Math.floor(Date.now() / 1000));
  const v1 = opts.v1 ?? [await sign(opts.signingSecret ?? SIGNING_SECRET, t, opts.signBody ?? raw)];
  const headers = new Headers({ "content-type": "application/json" });
  if (!opts.noSignature) headers.set("stripe-signature", opts.sigHeader ?? [`t=${t}`, ...v1.map((v) => `v1=${v}`)].join(","));
  const mod = await import(`${pathToFileURL(WEBHOOK).href}?v=${Math.random()}`);
  const res = await mod.handle(new Request("https://fn.test/stripe-webhook", { method: "POST", headers, body: raw }));
  return { status: res.status, body: await res.json() };
}

async function post(bundle, { token, body = {} } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const mod = await import(`${pathToFileURL(bundle).href}?v=${Math.random()}`);
  const res = await mod.handle(new Request("https://fn.test/x", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

const DEFAULT_PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 86400;

/* THE DEFAULT IS THE SHAPE PRODUCTION SENDS, and it was not.
   `current_period_end` used to sit at the SUBSCRIPTION level here --
   the 2024-06-20 shape -- so every assertion in this file agreed with
   a production that had moved on, which is precisely how a live
   subscription came to write `expires_at` NULL with the field plainly
   in the payload. Fifth instance of the stand-in-weaker-than-
   production pattern and the first in a fixture; leaving the default
   on the old shape after naming both of them was the half that got
   away.

   IT IS NOW CONFIRMED rather than assumed. Jared's live purchase of
   17 September 2026 on `2026-04-22.dahlia` -- the version this repo
   pins and the one the live endpoint delivers -- logged
   "periodSource":"item","periodType":"number" on BOTH events. The
   period end is on the ITEM.

   The subscription-level form is still read as a fallback and is
   still correct when it is the only one present, so it is opted into
   BY NAME below rather than being the thing you get by accident. */
const subscription = (over = {}) => ({
  id: "sub_1",
  object: "subscription",
  status: "active",
  customer: "cus_1",
  metadata: { uid: USER },
  items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: DEFAULT_PERIOD_END }] },
  ...over,
});

/** The pre-2026 shape: the period on the subscription and NOT on the item. */
const periodOnSubscriptionOnly = (seconds) => ({
  current_period_end: seconds,
  items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" } }] },
});

/** Neither place carries it — the case that must be REFUSED, not guessed. */
const periodNowhere = () => ({
  current_period_end: undefined,
  items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" } }] },
});

const event = (over = {}) => ({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: subscription(over.subscription || {}) },
  ...over,
});

const profile = (over = {}) => ({ user_id: USER, tier: "free", tier_source: "signup", store: null, stripe_customer_id: null, ...over });

/* A refunded charge, IN THE SHAPE 2026-04-22.dahlia ACTUALLY SENDS.
   `refunded` is Stripe's own "the whole thing came back" flag; the
   amounts are deliberately NOT what the code compares, so they are
   here only to make a partial refund look like one.

   THERE IS NO `invoice` KEY, AND THAT IS THE POINT. The previous
   version of this fixture had `invoice: "in_1"` — a field Stripe
   removed from Charge in 2025-03-31.basil — so every test in this file
   agreed with a world the pinned API version left behind, and the live
   endpoint answered `not_an_invoice` to every real subscription refund
   while all of them passed. SEVENTH instance of the
   stand-in-weaker-than-production pattern and the SECOND in a fixture,
   after `current_period_end`.

   DERIVED FROM A CONFIRMED LIVE PAYLOAD (a real refund, 18 September
   2026): the field NAMES and their types are that payload's, and every
   VALUE here is invented. `billing_details` and `receipt_url` are
   dropped rather than scrubbed — the first carries an email, a name
   and an address, the second is a live link to a receipt showing them,
   this repository is public, and nothing in the code reads either. The
   all-null fields of a card charge (`dispute`, `failure_code`,
   `shipping`, `transfer_data` and the rest) are left out as noise; the
   test below asserts the two facts that matter instead, which is
   stronger than bulk.

   `payment_intent` is the load-bearing one now: it is the only link
   from this charge to its invoice. */
const charge = (over = {}) => ({
  id: "ch_1",
  object: "charge",
  amount: 90,
  amount_captured: 90,
  amount_refunded: 90,
  calculated_statement_descriptor: "UNI-PLANNER",
  captured: true,
  currency: "aud",
  customer: "cus_1",
  description: "Subscription creation",
  disputed: false,
  livemode: true,
  metadata: {},
  paid: true,
  payment_intent: "pi_1",
  payment_method_details: { link: { country: "AU", funding_source_group: "lfsg_000" }, type: "link" },
  refunded: true,
  status: "succeeded",
  ...over,
});

/* The InvoicePayment list that replaced `charge.invoice`. One row,
   because the query names one payment intent and limits to one. */
const invoicePayments = (over = {}) => ({
  object: "list",
  url: "/v1/invoice_payments",
  has_more: false,
  data: [
    {
      id: "inpay_1",
      object: "invoice_payment",
      invoice: "in_1",
      payment: { type: "payment_intent", payment_intent: "pi_1" },
      status: "paid",
      ...over,
    },
  ],
});

/** The classic shape: `invoice.subscription`. */
/* THE INVOICE, IN THE SHAPE dahlia SENDS: the subscription under
   `parent.subscription_details`, not on the invoice itself.

   CONFIRMED LIVE, 18 September 2026. The refund that proved the path
   logged `"invoice_source":"parent"` — so on this pinned version the
   classic `invoice.subscription` never answers, exactly as
   `charge.invoice` never answers. This default was the CLASSIC shape
   until that delivery, which made it the THIRD fixture in this file to
   describe a Stripe the pin had left behind (after
   `current_period_end` and `charge.invoice`). A default is what a
   whole file quietly asserts about production, and this one asserted
   the wrong thing three times.

   ONLY THE PATH THE CODE READS IS MODELLED. A live `parent` object
   carries more than this — a `type` discriminator among other things —
   and none of it is invented here, because a field nobody has seen is
   a field a fixture should not claim. */
const invoice = (over = {}) => ({
  id: "in_1",
  object: "invoice",
  parent: { subscription_details: { subscription: "sub_1" } },
  ...over,
});

/** The pre-2025 shape, on the invoice itself. Still read as a fallback, so still tested BY NAME. */
const invoiceLegacySubscriptionField = (subscriptionId = "sub_1") => ({
  id: "in_1",
  object: "invoice",
  subscription: subscriptionId,
});

/** An invoice for no subscription at all — a one-off invoice, which must touch no tier. */
const invoiceNoSubscription = () => ({ id: "in_1", object: "invoice", parent: null });

const refundEvent = (over = {}) =>
  event({ id: over.id ?? "evt_refund", type: "charge.refunded", data: { object: charge(over.charge || {}) } });

/* WRITES THAT CHANGE A STUDENT'S STANDING — everything except the
   diagnostics table.

   `recordFailure` writes a `function_errors` row on any failure AFTER
   the signature verified, so an unscoped "it wrote nothing" would
   forbid the daily digest from ever seeing the refusal the test is
   about. The claim these tests make is that nothing about the
   student's plan moved, so that is what they assert — paired, in each
   case, with a POSITIVE assertion that the failure WAS recorded, so
   the exclusion is not a hole.

   The two PRE-AUTHENTICATION tests deliberately keep using `w.writes`
   unfiltered, because there the claim really is that nothing at all
   was written: this endpoint has no JWT verification, so an
   unauthenticated caller must not be able to insert a row per
   request. */
const standingWrites = (w) => w.writes.filter((x) => x.table !== "function_errors");
const recordedFailures = (w) => w.writes.filter((x) => x.table === "function_errors");

async function run() {
  /* ---------- 1. the tier a subscription implies ---------- */

  await test("the status table: entitled, definitively not, and CANNOT TELL are three answers", () => {
    const cases = [
      { name: "active", sub: subscription(), tier: "ai", recognised: true },
      { name: "trialing", sub: subscription({ status: "trialing" }), tier: "ai", recognised: true },
      { name: "past_due keeps the plan while the card is retried", sub: subscription({ status: "past_due" }), tier: "ai", recognised: true },
      { name: "unpaid is retries exhausted", sub: subscription({ status: "unpaid" }), tier: "free", recognised: true },
      { name: "canceled", sub: subscription({ status: "canceled" }), tier: "free", recognised: true },
      { name: "incomplete", sub: subscription({ status: "incomplete" }), tier: "free", recognised: true },
      { name: "paused", sub: subscription({ status: "paused" }), tier: "free", recognised: true },
      { name: "a status Stripe adds later is NOT a cancellation", sub: subscription({ status: "something_new" }), tier: "free", recognised: false },
      { name: "no subscription at all", sub: null, tier: "free", recognised: false },
      { name: "max wins over ai", sub: subscription({ items: { data: [{ price: { lookup_key: "uniplanner_studyai_annual" } }, { price: { lookup_key: "uniplanner_studyaimax_monthly" } }] } }), tier: "ai_max", recognised: true },
    ];
    assert.ok(cases.length >= 10, "the table shrank");
    for (const c of cases) {
      const got = stripe.tierFromStripeSubscription(c.sub);
      assert.equal(got.tier, c.tier, `${c.name}: tier`);
      assert.equal(got.recognised, c.recognised, `${c.name}: recognised`);
    }
  });

  await test("AN ENTITLED SUBSCRIPTION WITH A PRICE WE DO NOT KNOW IS UNANSWERABLE, not free", () => {
    /* THE ONE THAT WOULD COST THE MOST. A Price created in the
       dashboard without a lookup key, or a `lookup_key` absent from a
       response, would otherwise read as "entitled to nothing" and
       downgrade every paying Stripe subscriber on their next renewal
       event. The two must never collapse into one answer. */
    const unknown = stripe.tierFromStripeSubscription(subscription({ items: { data: [{ price: { lookup_key: "someone_elses_price" } }] } }));
    assert.equal(unknown.recognised, false, "an unrecognised price read as a definitive answer");
    const missing = stripe.tierFromStripeSubscription(subscription({ items: { data: [{ price: {} }] } }));
    assert.equal(missing.recognised, false, "a price with NO lookup key read as a definitive answer");
    /* And the discriminating half: a genuinely lapsed subscription IS
       definitive, or the guard above would just be "never decide". */
    assert.equal(stripe.tierFromStripeSubscription(subscription({ status: "canceled" })).recognised, true);
  });

  await test("current_period_end is read as SECONDS, which is the difference between 2026 and 1970", () => {
    const seconds = 1_800_000_000;
    /* ASSERTED ON BOTH SHAPES, because the seconds-vs-milliseconds
       reading is a property of the READ and not of where the field
       sits -- and the default fixture now carries the period on the
       item, so testing only one shape would leave the other's
       arithmetic unmeasured. */
    for (const [where, sub] of [
      ["item", subscription({ items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: seconds }] } })],
      ["subscription", subscription(periodOnSubscriptionOnly(seconds))],
    ]) {
      const got = stripe.tierFromStripeSubscription(sub);
      assert.equal(got.expiresAt, new Date(seconds * 1000).toISOString(), `the ${where} shape read the wrong value`);
      assert.equal(got.periodSource, where, `the ${where} shape was not the one consulted`);
      assert.ok(new Date(got.expiresAt).getUTCFullYear() > 2020, `the ${where} expiry landed in 1970 — it was read as milliseconds`);
    }
    assert.equal(stripe.tierFromStripeSubscription(subscription(periodOnSubscriptionOnly(null))).expiresAt, null);
  });

  await test("THE PERIOD END IS READ FROM THE ITEM AS WELL AS THE SUBSCRIPTION — the live NULL", () => {
    /* THE BUG, from a real delivery: an entitlement row landed with
       `expires_at` NULL while `current_period_end: 1791547235` was
       plainly in the payload. The read was `subscription.current_period_end`
       and nothing else, so an API version that carries the field on the
       ITEMS produces a null with no error anywhere.

       AND THE FIXTURE IS WHY THE SUITE COULD NOT HAVE CAUGHT IT. The
       default `subscription()` put the field at the TOP LEVEL — the
       2024-06-20 shape — so every test here agreed with a production
       that had moved on. Stand-in weaker than production, fifth
       instance, and this time the stand-in was a fixture rather than a
       database.

       NAMING BOTH SHAPES WAS ONLY HALF THE REMEDY, which is the part
       worth keeping: the explicit shapes below were added and the
       DEFAULT was left on the old one, so the bulk of this file went
       on describing the wrong world and the item branch went on
       looking speculative beside it. The default is the live shape
       now — see the fixture — and the old form is opted into by name. */
    const ITEM_ONLY = {
      items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: 1791547235 }] },
      current_period_end: undefined,
    };

    const onItem = stripe.tierFromStripeSubscription(subscription(ITEM_ONLY));
    assert.equal(onItem.expiresAt, "2026-10-09T12:00:35.000Z", "the reported payload still maps to null");
    assert.equal(onItem.periodSource, "item");
    assert.equal(onItem.tier, "ai", "the tier must be unaffected by where the period lives");

    /* The OLD shape still works — this is a widening, not a move.
       Opted into BY NAME, because the default is the live shape now. */
    const onSub = stripe.tierFromStripeSubscription(subscription(periodOnSubscriptionOnly(1791547235)));
    assert.equal(onSub.expiresAt, "2026-10-09T12:00:35.000Z");
    assert.equal(onSub.periodSource, "subscription");

    /* BOTH PRESENT AND DELIBERATELY DIFFERENT, so the preference is
       measured rather than assumed. The item wins: on a version that
       carries it there it is the per-line answer, and a subscription
       mid-plan-change can hold two items with different periods. */
    const both = stripe.tierFromStripeSubscription(
      subscription({
        current_period_end: 1_700_000_000,
        items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: 1791547235 }] },
      })
    );
    assert.equal(both.expiresAt, "2026-10-09T12:00:35.000Z", "the subscription's field won over the item's");
    assert.equal(both.periodSource, "item");

    /* ONLY THE WINNING ITEM. A sibling line's period answers a question
       about a plan the student is not on. Study AI Max wins on rank; its
       own period must be the one that comes back. */
    const twoLines = stripe.tierFromStripeSubscription(
      subscription({
        current_period_end: undefined,
        items: {
          data: [
            { price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: 1_700_000_000 },
            { price: { lookup_key: "uniplanner_studyaimax_annual" }, current_period_end: 1791547235 },
          ],
        },
      })
    );
    assert.equal(twoLines.tier, "ai_max", "the rank rule moved — the rest of this assertion is about the wrong line");
    assert.equal(twoLines.expiresAt, "2026-10-09T12:00:35.000Z", "a sibling item's period was used");
  });

  await test("THE ITEM IS WHERE THE LIVE API PUTS IT — confirmed, and the read cannot go unused", () => {
    /* CONFIRMED ON A REAL PURCHASE, 17 September 2026. The comment
       this replaces said which shape the live API sends "is not
       answerable from this repository", which was true and is why
       `periodSource` is logged on EVERY apply rather than only on
       failure. The answer came back from production: Jared's live
       subscription on `2026-04-22.dahlia` logged
       "periodSource":"item","periodType":"number" on BOTH events, and
       the row carried expires_at 2026-10-17.

       SO THE ITEM-SIDE READ IS THE PRODUCTION PATH, not a defensive
       extra, and this test exists so nothing can remove it as unused.
       It is asserted on the DEFAULT fixture, which means the whole
       file now runs the live shape — the item branch is what answers
       in 45 other tests, so deleting it does not redden three
       carefully-named cases, it reddens most of the suite.

       THE SUBSCRIPTION-LEVEL FALLBACK STAYS, and the direction matters:
       what is confirmed is what `2026-04-22.dahlia` sends TODAY. A
       pinned version is a thing somebody changes, and the older shape
       is still correct when it is the only one present. Removing the
       fallback because production does not exercise it is the same
       mistake as removing the item read was — one shape observed, the
       other assumed absent. */
    const fixture = subscription();
    assert.equal(
      fixture.current_period_end,
      undefined,
      "the default fixture carries a subscription-level period again — it is back to describing the 2024-06-20 world"
    );
    const item = fixture.items.data[0];
    assert.equal(typeof item.current_period_end, "number", "the default fixture's item has no numeric period, so nothing below is measured");

    const got = stripe.tierFromStripeSubscription(fixture);
    assert.equal(got.periodSource, "item", `the default fixture resolved through ${got.periodSource}, not the item`);
    assert.equal(got.expiresAt, new Date(item.current_period_end * 1000).toISOString());

    /* THE DISCRIMINATING HALF. Without it this passes on a function
       that answers "item" to everything, which would be the same
       null-writing bug pointing the other way. */
    const old = stripe.tierFromStripeSubscription(subscription(periodOnSubscriptionOnly(1791547235)));
    assert.equal(old.periodSource, "subscription", "the fallback is gone — the older shape now reads as absent");
    assert.notEqual(got.periodSource, old.periodSource, "both shapes report the same source, so periodSource measures nothing");
  });

  await test("a period end that is absent, or present and not a number, is REPORTED rather than coerced", () => {
    /* Three outcomes again. A null expiry is read by tierFromProviders
       as NON-EXPIRING, so guessing here would disable the backstop
       quietly; the type is carried out instead so the next delivery
       says what really arrived. */
    const absent = stripe.tierFromStripeSubscription(
      subscription({ current_period_end: undefined, items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" } }] } })
    );
    assert.equal(absent.expiresAt, null);
    assert.equal(absent.periodSource, "absent");
    assert.equal(absent.periodType, "absent", "an absent field must be distinguishable from an unusable one");

    /* Present and a STRING — not parsed. Stripe sends integers; a
       string means something upstream changed, and coercing it would
       hide that while looking correct. */
    const stringy = stripe.tierFromStripeSubscription(
      subscription({ current_period_end: undefined, items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: "1791547235" }] } })
    );
    assert.equal(stringy.expiresAt, null, "a string was coerced to a date");
    assert.equal(stringy.periodType, "item:string", `the type was not carried out: ${stringy.periodType}`);

    /* The tier survives every one of these: where the period lives
       never decides which plan somebody is on. */
    for (const got of [absent, stringy]) assert.equal(got.tier, "ai");
  });

  /* ---------- 2. the six prices ---------- */

  await test("the six lookup keys are exactly the plans the phones sell", () => {
    const fromStripe = Object.entries(stripe.STRIPE_LOOKUP_KEYS).map(([, v]) => `${v.tier}:${v.duration}`).sort();
    const fromPlans = Object.values(plans.PACKAGE_PLANS).map((v) => `${v.tier}:${v.duration}`).sort();
    assert.ok(fromPlans.length === 6, `expected six store plans, found ${fromPlans.length}`);
    assert.deepEqual(fromStripe, fromPlans, "the web sells a different set of plans from the phones");
    for (const key of Object.keys(stripe.STRIPE_LOOKUP_KEYS)) {
      assert.match(key, /^uniplanner_/, `${key} is not namespaced, so it could collide in a shared Stripe account`);
    }
    assert.equal(stripe.lookupKeyFor("ai", "monthly"), "uniplanner_studyai_monthly");
    assert.equal(stripe.lookupKeyFor("ai_max", "annual"), "uniplanner_studyaimax_annual");
    assert.equal(stripe.lookupKeyFor("free", "monthly"), null, "the free tier is not for sale");
    assert.equal(stripe.lookupKeyFor("ai", "weekly"), null);
    assert.equal(stripe.lookupKeyFor("../etc", "monthly"), null);
  });

  await test("the web's prices are DERIVED from site/pricing.js, never typed", () => {
    /* A restatement of a PRICE is the worst entry in the ledger: the
       screen promises one figure while Stripe charges another and
       nothing notices. So this asserts the derivation rather than the
       numbers — a figure changed on the site moves the panel too. */
    const site = fs.readFileSync(path.join(rootDir, "site/pricing.js"), "utf8");
    const src = fs.readFileSync(path.join(rootDir, "src/webPrices.js"), "utf8");
    assert.match(src, /from "\.\.\/site\/pricing\.js"/, "webPrices.js does not read the site's table");
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, " "), /\d+\.\d\d/, "a price literal appears in webPrices.js");

    for (const [tier, duration, period] of [["ai", "monthly", "monthly"], ["ai", "sixmonth", "sixMonth"], ["ai_max", "annual", "annual"]]) {
      const label = prices.webPriceLabel(tier, duration);
      assert.ok(label, `${tier}/${duration} renders no price`);
      const m = new RegExp(`id: "${tier}"[\\s\\S]*?prices: \\{[^}]*${period}: ([\\d.]+)`).exec(site);
      assert.ok(m, `could not read ${tier}.${period} out of site/pricing.js — this derivation check is blind`);
      assert.ok(label.includes(Number(m[1]).toFixed(2)), `${tier}/${duration} shows ${label}, the site says ${m[1]}`);
    }
    /* The one mapping that could silently blank a button. */
    assert.equal(prices.webPriceLabel("ai", "sixmonth") === null, false, "the sixmonth/sixMonth mapping is broken and the button would show no price");
    assert.equal(prices.webPriceLabel("ai", "nonsense"), null);
  });

  /* ---------- 3. the webhook refuses before it does anything ---------- */

  const authCases = [
    { name: "no signature header", opts: { noSignature: true } },
    { name: "an unparseable signature header", opts: { sigHeader: "garbage" } },
    { name: "a header with a timestamp and no v1", opts: { sigHeader: `t=${Math.floor(Date.now() / 1000)}` } },
    { name: "a signature made with the wrong secret", opts: { signingSecret: "whsec_wrong" } },
    { name: "a stale timestamp (replay)", opts: { t: Math.floor(Date.now() / 1000) - 20 * 60 } },
    { name: "a timestamp in milliseconds, which is 56,000 years hence", opts: { t: Date.now() } },
    { name: "a non-numeric timestamp", opts: { t: "yesterday" } },
  ];
  for (const c of authCases) {
    await test(`REFUSED, having done nothing: ${c.name}`, async () => {
      const w = makeWorld({ profiles: { [USER]: profile() } });
      const res = await deliver(event(), c.opts);
      w.restore();
      assert.equal(res.status, 401, "an unauthenticated delivery must be refused");
      assert.deepEqual(w.stripeCalls, [], "it asked Stripe about a subscription before authenticating the caller");
      assert.deepEqual(w.writes, [], "it wrote something before authenticating the caller");
    });
  }

  await test("REFUSED: a signature that does not cover the bytes that were sent", async () => {
    /* THE CASE A PARSE-THEN-VERIFY HANDLER ACCEPTS. Signed with the
       real secret, over DIFFERENT bytes. */
    const w = makeWorld({ profiles: { [USER]: profile() } });
    const honest = JSON.stringify(event());
    const tampered = JSON.stringify(event({ type: "customer.subscription.deleted" }));
    const res = await deliver(null, { raw: tampered, signBody: honest });
    w.restore();
    assert.equal(res.status, 401);
    assert.deepEqual(w.writes, [], "a body whose signature covers other bytes was accepted");
  });

  await test("ACCEPTED: a pretty-printed body, and ANY of several v1 values during a secret rotation", async () => {
    /* Both directions of the same rule. Re-serialising to verify would
       fail the first; keeping only the last v1 seen would fail the
       second for the whole length of a rotation. */
    const spaced = JSON.stringify(event(), null, 2);
    const t = String(Math.floor(Date.now() / 1000));
    const good = await sign(SIGNING_SECRET, t, spaced);
    const w = makeWorld({
      profiles: { [USER]: profile() },
      stripeRoutes: { "/subscriptions/sub_1": subscription() },
    });
    const res = await deliver(null, { raw: spaced, t, v1: ["deadbeef", good, "cafe"] });
    w.restore();
    assert.equal(res.status, 200, `a validly signed pretty-printed body was refused: ${JSON.stringify(res.body)}`);
    assert.equal(w.profiles[USER].tier, "ai");
  });

  /* ---------- 4. the payload is not evidence ---------- */

  await test("THE RE-READ PRECEDES THE WRITE — asserted on the ORDER", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile() },
      stripeRoutes: { "/subscriptions/sub_1": subscription() },
    });
    await deliver(event());
    w.restore();
    const fetchAt = w.trace.findIndex((t) => t.startsWith("stripe:GET /subscriptions"));
    const writeAt = w.trace.indexOf("db:profiles.update");
    assert.ok(fetchAt >= 0, "the subscription was never re-read from Stripe");
    assert.ok(writeAt >= 0, "no tier was written");
    assert.ok(fetchAt < writeAt, `the write happened before the re-read: ${w.trace.join(" -> ")}`);
  });

  await test("A FORGED CLAIM WRITES NOTHING: the delivered body says ai_max, Stripe says ai", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile() },
      stripeRoutes: { "/subscriptions/sub_1": subscription() },
    });
    const lie = event({ subscription: { items: { data: [{ price: { lookup_key: "uniplanner_studyaimax_annual" } }] } } });
    await deliver(lie);
    w.restore();
    assert.equal(w.profiles[USER].tier, "ai", "the handler believed the delivered body instead of Stripe");
    assert.equal(w.profiles[USER].tier_source, "stripe");
    assert.equal(w.profiles[USER].store, "stripe");
  });

  await test("AN UNRECOGNISED PRICE REFUSES AND WRITES NOTHING — it does not downgrade anybody", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai_max", tier_source: "stripe", store: "stripe" }) },
      stripeRoutes: { "/subscriptions/sub_1": subscription({ items: { data: [{ price: { lookup_key: "not_ours" } }] } }) },
    });
    const res = await deliver(event());
    w.restore();
    assert.ok(res.status >= 500, `answered ${res.status}, so Stripe will not retry and nobody will notice`);
    assert.equal(w.profiles[USER].tier, "ai_max", "a paying subscriber was downgraded because a price was not recognised");
    assert.deepEqual(standingWrites(w), [], "something was written for a subscription we could not price");
    assert.ok(recordedFailures(w).length > 0, "an unrecognised price was refused without being recorded, so the digest would never see the missing lookup key");
  });

  await test("AN UNKNOWN PRICE IS A REFUSAL ONLY WHEN THERE IS SOMEBODY TO PROTECT", async () => {
    /* THE ORDERING FIX, and the case that produced it: the very first
       `stripe trigger` at a new endpoint sends a fixture product with
       no uid, so it is BOTH unpriceable and about nobody. The
       unrecognised-price refusal is a 500 so Stripe keeps retrying
       while somebody adds the missing lookup key — right when an
       account's tier is at stake, and retrying on behalf of nobody
       when there is no account at all. So the account question is
       answered first.

       RUN AS A PAIR, because either half alone is satisfiable by the
       wrong rule: "always accept" passes the first, "always refuse"
       passes the second. The ONE difference between the two worlds is
       whether the profile exists — same event, same unrecognised
       price, same route — so it is the account that decides, which is
       the claim. */
    const priced = (extra) => ({
      "/subscriptions/sub_1": subscription({ items: { data: [{ price: { lookup_key: "cli_fixture_price" } }] }, ...extra }),
    });

    const nobody = makeWorld({ profiles: {}, stripeRoutes: priced({ metadata: {}, customer: "cus_nobody" }) });
    const forNobody = await deliver(event({ subscription: { metadata: {} } }));
    nobody.restore();

    const somebody = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe" }) },
      stripeRoutes: priced({}),
    });
    const forSomebody = await deliver(event());
    somebody.restore();

    /* The pair really discriminates — asserted before either branch,
       so neither can pass by both answers being the same. */
    assert.notEqual(forNobody.status, forSomebody.status, "the two worlds answered identically, so nothing here is about the account");

    assert.equal(forNobody.status, 200, `an event about nobody: answered ${forNobody.status}, so Stripe retries until the window expires`);
    assert.equal(forNobody.body.outcome, "no_account");
    const row = nobody.writes.find((x) => x.table === "billing_events");
    assert.ok(row, "an event about nobody was answered 200 and recorded nowhere — the retry stops and so does the evidence");
    assert.equal(row.values.user_id, null);
    assert.equal(row.values.tier_after, null);
    assert.deepEqual(nobody.writes.filter((x) => x.table === "profiles"), [], "a tier was written for an account we do not hold");

    assert.ok(forSomebody.status >= 500, `a real subscriber on an unknown price: answered ${forSomebody.status}, so nobody is told to fix the dashboard`);
    assert.equal(somebody.profiles[USER].tier, "ai", "a paying subscriber was downgraded because a price was not recognised");
    assert.deepEqual(standingWrites(somebody), [], "something was written for a subscription we could not price");
    assert.ok(recordedFailures(somebody).length > 0, "an unrecognised price was refused without being recorded, so the digest would never see the missing lookup key");
  });

  await test("THE ROW THAT LANDS carries the expiry, in the shape the live API sends", async () => {
    /* The unit tests above are about the mapper. This is about the ROW,
       because that is where the null was seen — and it goes through the
       real handler, the real applyEntitlement and the real
       tierFromProviders, in the ITEM-ONLY shape.

       A null here is not cosmetic. It used to be read as non-expiring,
       which held a tier open for ever on the strength of a field nobody
       could read; it is now read as NOT LIVE, which demotes the same
       student instead. Both are wrong answers to a question that had a
       right one sitting in the payload, which is why the mapper is what
       had to be fixed and why this test asserts the date rather than
       merely asserting that something was written. */
    const itemOnly = subscription({
      current_period_end: undefined,
      items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: 1791547235 }] },
    });
    const w = makeWorld({ profiles: { [USER]: profile() }, stripeRoutes: { "/subscriptions/sub_1": itemOnly } });
    const res = await deliver(event());
    w.restore();

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = Object.values(w.entitlements)[0];
    assert.ok(row, "no entitlements row was written at all, so this proves nothing");
    assert.equal(row.tier, "ai");
    assert.equal(row.expires_at, "2026-10-09T12:00:35.000Z", "THE LIVE BUG: the row landed with a null expiry");

    /* And profiles carries it too — the projection reads the row it
       just wrote, so a null there would mean the same thing one table
       over. */
    assert.equal(w.profiles[USER].entitlement_expires_at, "2026-10-09T12:00:35.000Z");

    /* WHICH SHAPE CARRIED IT REACHES THE LOG. This repository cannot
       ask Stripe which location a given API version uses, so the only
       way that question gets answered is a real delivery saying so. */
    assert.ok(
      w.logs.some((l) => l.includes('"periodSource":"item"')),
      `the log does not say where the period came from: ${w.logs.join(" | ")}`
    );
  });

  await test("AN ENTITLED SUBSCRIPTION WITH NO READABLE PERIOD IS REFUSED, and the previous tier STANDS", async () => {
    /* THIS INVERTS WHAT THIS FILE USED TO ASSERT, and the old reasoning
       is the interesting part: it said refusing would retry "over a
       field that does not change which plan the student is on". The
       field decides whether the row EVER expires, so it changes the plan
       permanently — which makes it exactly the kind of thing to refuse.

       Only a manual grant may be open-ended (Jared, 10 September 2026).

       THE DIRECTION IS WHY IT IS A REFUSAL AND NOT A NOT-LIVE WRITE.
       Writing the row and letting tierFromProviders skip it would
       demote a paying student on the strength of an unparseable field.
       Writing nothing leaves the tier they have, loudly. */
    const noPeriod = subscription(periodNowhere());
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe" }) },
      stripeRoutes: { "/subscriptions/sub_1": noPeriod },
    });
    const res = await deliver(event());
    w.restore();

    assert.ok(res.status >= 500, `a paid tier with no expiry was accepted (${res.status}) — nothing will retry it`);
    assert.deepEqual(w.entitlements, {}, "an open-ended paid row was recorded");
    assert.equal(w.profiles[USER].tier, "ai", "the tier moved on a delivery that was refused");
    assert.deepEqual(
      w.writes.filter((x) => x.table === "profiles"),
      [],
      "profiles was written for a subscription whose period we could not read"
    );

    /* BOTH SHOUTS, because they carry different halves. The period line
       names the subscription and WHY the field was unusable, which is
       what a fix needs; the apply line names the refusal. */
    assert.ok(
      w.logs.some((l) => l.includes("no readable current_period_end")),
      `the unreadable period was not reported: ${w.logs.join(" | ")}`
    );
    assert.ok(
      w.logs.some((l) => l.includes("open_ended_refused")),
      `the refusal was not reported: ${w.logs.join(" | ")}`
    );
  });

  await test("A CANCELLATION IS NOT AN OPEN-ENDED GRANT — `free` with no expiry still records", async () => {
    /* The exemption, and it is load-bearing rather than a convenience:
       tierFromStripeSubscription answers every lapse with `{ tier:
       "free", expiresAt: null }`. If the refusal applied to `free`, no
       cancellation could ever be recorded and every expired tier would
       be held open — the failure the refusal exists to close, running
       backwards.

       It also must not SHOUT: the period line is gated on a paid tier,
       because logging the ordinary case at error level is how the real
       anomaly stops being visible. */
    const cancelled = subscription({ status: "canceled", current_period_end: undefined });
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe" }) },
      stripeRoutes: { "/subscriptions/sub_1": cancelled },
    });
    const res = await deliver(event());
    w.restore();

    assert.equal(res.status, 200, `a cancellation was refused: ${JSON.stringify(res.body)}`);
    const row = Object.values(w.entitlements)[0];
    assert.ok(row, "the cancellation was not recorded, so the tier can never lapse");
    assert.equal(row.tier, "free");
    assert.equal(row.expires_at, null);
    assert.equal(w.profiles[USER].tier, "free", "the student kept a tier their subscription no longer grants");
    assert.ok(
      !w.logs.some((l) => l.includes("no readable current_period_end")),
      `an ordinary cancellation was logged as the period anomaly: ${w.logs.join(" | ")}`
    );
  });

  await test("A FAILED IDEMPOTENCY READ IS NOT A REFUSAL — the primary key is the guarantee", async () => {
    /* The first real Stripe deliveries hit PGRST303 ("JWT issued at
       future") on this read — clock skew between the edge runtime and
       PostgREST, which Stripe's own retry cleared 18 seconds later.
       Nothing in this repository mints that token, so the `iat` is not
       ours to backdate; what is ours is not turning a transient read
       failure into a refused delivery, because if whatever broke the
       read is NOT momentary then every delivery becomes a retry that
       fails the same way.

       The read is an optimisation over `billing_events`' primary key.
       Both halves are asserted here: the delivery goes through, and a
       redelivery with the read still broken is STILL one row, because
       the insert refuses it. */
    const shared = {
      profiles: { [USER]: profile() },
      events: {},
      stripeRoutes: { "/subscriptions/sub_1": subscription() },
      seenError: { code: "PGRST303", message: "JWT issued at future" },
    };

    const first = makeWorld(shared);
    const res = await deliver(event());
    first.restore();
    assert.equal(res.status, 200, `a transient read failure refused the delivery: ${JSON.stringify(res.body)}`);
    assert.equal(shared.profiles[USER].tier, "ai", "the entitlement was not applied");
    assert.equal(Object.keys(shared.events).length, 1, "nothing was recorded");
    /* The failure is LOUD. A silent fallback would make a permanent
       fault look like normal operation. */
    assert.ok(
      first.logs.some((l) => l.includes("PGRST303")),
      `the read failure was swallowed rather than logged: ${first.logs.join(" | ")}`
    );

    const second = makeWorld(shared);
    const again = await deliver(event());
    second.restore();
    assert.equal(again.status, 200, `the redelivery was refused: ${JSON.stringify(again.body)}`);
    assert.equal(again.body.outcome, "duplicate", "the PK did not catch a redelivery the broken read could not");
    assert.equal(Object.keys(shared.events).length, 1, "a redelivery wrote a second row while the read was failing");
  });

  await test("a failed Stripe read is UNKNOWN — 5xx so it retries, and the tier is untouched", async () => {
    for (const route of [{ "/subscriptions/sub_1": { __status: 500 } }, {}]) {
      const w = makeWorld({ profiles: { [USER]: profile({ tier: "ai", store: "stripe" }) }, stripeRoutes: route });
      const res = await deliver(event());
      w.restore();
      assert.ok(res.status >= 500, "a failed read must not be answered 2xx");
      assert.equal(w.profiles[USER].tier, "ai", "a paying student lost their tier because a request failed");
      assert.deepEqual(standingWrites(w), [], "something was written on an unknown read");
      assert.ok(recordedFailures(w).length > 0, "a failed Stripe read was not recorded, so the digest would never see it");
    }
  });

  /* ---------- 4b. a refund ends the plan, because the copy says so ---------- */

  await test("THE FIXTURE IS THE SHAPE dahlia SENDS: no charge.invoice, and a payment_intent", () => {
    /* THE NON-VACUITY ASSERTION FOR EVERYTHING BELOW, and the one that
       would have caught the live bug on the day it was written.

       `charge.invoice` was removed from Charge in 2025-03-31.basil, and
       we pin 2026-04-22.dahlia. The old fixture invented the field, so
       the whole refund path was measured against a Stripe that no
       longer exists and every real subscription refund answered
       `not_an_invoice` in production while this file was green.

       Asserted as ABSENCE of a key rather than by listing what is
       present, because absence is the fact that matters and a fixture
       can grow fields harmlessly. */
    const live = charge();
    assert.ok(
      !("invoice" in live),
      "the charge fixture carries an `invoice` key — Stripe removed it in 2025-03-31.basil, so this fixture describes a world the pinned version left behind"
    );
    assert.equal(typeof live.payment_intent, "string", "the charge fixture has no payment_intent, which is the only route to its invoice now");
    assert.ok(live.payment_intent.length > 0, "the charge fixture's payment_intent is empty");

    /* AND NO PII, because this fixture is derived from a real payload
       and the repository is public. The live charge carried an email, a
       full name and an address in `billing_details`, plus a
       `receipt_url` that links to a receipt showing them; all of it is
       dropped rather than scrubbed, since nothing in the code reads
       any of it. */
    const serialised = JSON.stringify(live);
    /* THE FIELDS, NOT THE NAMES. An earlier version of this list held a
       real surname, which put the very string it was guarding against
       into a public file — the guard meeting its own subject for the
       second time in one test. The PII-bearing fields are named
       instead, plus "@" for any address that arrives inside another
       one. */
    for (const banned of ["billing_details", "receipt_url", "receipt_email\":\"", "@"]) {
      assert.ok(
        !serialised.includes(banned),
        `the charge fixture contains "${banned}" — this file is committed to a public repository`
      );
    }
  });

  await test("THE INVOICE COMES FROM THE InvoicePayment OBJECT, and the legacy field still wins if present", () => {
    /* The replacement for the field that moved. Both sources are
       measured, and the absent case is what the live endpoint was
       hitting on every refund. */
    const fromPayments = stripe.invoiceIdForCharge(charge(), invoicePayments());
    assert.equal(fromPayments.invoiceId, "in_1");
    assert.equal(fromPayments.source, "invoice_payments");

    /* THE LEGACY FIELD IS PREFERRED WHEN PRESENT, for periodEndOf's
       reason: what is confirmed is what this PINNED version sends
       today. Deliberately different values, so the preference is
       measured rather than assumed. */
    const both = stripe.invoiceIdForCharge({ invoice: "in_legacy" }, invoicePayments());
    assert.equal(both.invoiceId, "in_legacy");
    assert.equal(both.source, "charge");

    /* NEITHER — a one-off payment. Must be reported, never guessed. */
    assert.deepEqual(stripe.invoiceIdForCharge(charge(), { object: "list", data: [] }), { invoiceId: "", source: "absent" });
    assert.deepEqual(stripe.invoiceIdForCharge(null, null), { invoiceId: "", source: "absent" });

    /* ONLY THE FIRST ROW. The query names one payment intent and limits
       to one, so a second row would be a different payment and
       answering with it would cancel a subscription this refund was
       not about. */
    const two = stripe.invoiceIdForCharge(charge(), {
      data: [{ invoice: "in_first" }, { invoice: "in_second" }],
    });
    assert.equal(two.invoiceId, "in_first");

    /* THE QUERY ITSELF, because a filter that names the wrong field
       returns every InvoicePayment on the account and the first one
       would be somebody else's. */
    const q = stripe.invoicePaymentsQuery("pi_abc");
    assert.match(q, /^\/invoice_payments\?/);
    assert.match(q, /payment\[type\]=payment_intent/, "the query does not filter by payment type");
    assert.match(q, /payment\[payment_intent\]=pi_abc/, "the query does not filter by the payment intent");
    assert.match(q, /limit=1/, "the query is unlimited, so it could answer with another payment");
  });

  await test("THE REFUND DECISION TABLE: only a FULL refund of a SUBSCRIPTION invoice ends a plan", () => {
    /* THE GAP THIS CLOSES. `plansCopy.js` promises "if a subscription
       is refunded, the plan ends straight away and goes back to Free",
       and `charge.refunded` was not a subscribed event — so on the web
       a refund did nothing to the tier and a refunded student kept a
       month of credits. Confirmed on Jared's own refund, 17 September
       2026: portal cancel at period end behaved correctly, then the
       charge was refunded in Stripe and the tier stayed `ai`.

       A TABLE, because the interesting cases are the ones that must
       NOT fire and there are more of them than there are of the one
       that must. */
    const cases = [
      { name: "a full refund of a subscription invoice", charge: charge(), invoiceId: "in_1", invoice: invoice(), reason: "ends_subscription", sub: "sub_1" },
      /* THE ONE JARED NAMED: a partial refund of something that is not
         a subscription payment. It must miss on BOTH counts, and the
         partial test is what answers first. */
      { name: "a PARTIAL refund of a non-subscription charge", charge: charge({ refunded: false, amount_refunded: 20 }), invoiceId: "", invoice: null, reason: "partial_refund", sub: "" },
      { name: "a PARTIAL refund of a subscription invoice — somebody still paying", charge: charge({ refunded: false, amount_refunded: 20 }), invoiceId: "in_1", invoice: invoice(), reason: "partial_refund", sub: "" },
      { name: "a FULL refund of a one-off payment, no invoice at all", charge: charge(), invoiceId: "", invoice: null, reason: "not_an_invoice", sub: "" },
      { name: "a FULL refund of an invoice with no subscription", charge: charge(), invoiceId: "in_1", invoice: invoiceNoSubscription(), reason: "not_a_subscription", sub: "" },
      /* THE FIELD-MOVE LESSON APPLIED RATHER THAN RE-LEARNED. Stripe
         moved `invoice.subscription` under `parent.subscription_details`
         in the 2025 versions — the same move that made
         `current_period_end` produce a silent NULL. Reading only the
         classic field would make every refund look like a
         non-subscription charge, and the failure would be a refunded
         student keeping credits: silent, and in our favour, which is
         the worst direction for a bug to fail in. */
      { name: "the pre-2025 shape, subscription on the invoice — still read as a fallback", charge: charge(), invoiceId: "in_1", invoice: invoiceLegacySubscriptionField(), reason: "ends_subscription", sub: "sub_1" },
      { name: "an amount-only refund with refunded:false is NOT full", charge: charge({ refunded: false, amount_refunded: 90 }), invoiceId: "in_1", invoice: invoice(), reason: "partial_refund", sub: "" },
    ];
    assert.ok(cases.length >= 6, "the table reads too little to be about anything");
    for (const c of cases) {
      const got = stripe.refundEndsSubscription(c.charge, c.invoiceId, c.invoice);
      assert.equal(got.reason, c.reason, `${c.name}: read as ${got.reason}`);
      assert.equal(got.subscriptionId, c.sub, `${c.name}: subscription ${got.subscriptionId || "(none)"}`);
    }

    /* AND THE SOURCE IS REPORTED, so a live delivery can say which
       shape this API version sends — the arrangement that answered the
       period question. */
    assert.equal(stripe.refundEndsSubscription(charge(), "in_1", invoice()).invoiceSource, "parent");
    assert.equal(stripe.refundEndsSubscription(charge(), "in_1", invoiceLegacySubscriptionField()).invoiceSource, "invoice");
    assert.equal(stripe.invoiceSubscriptionOf({}).source, "absent");
    /* The classic field WINS when both are present: it is the one
       Stripe has always meant. Deliberately different values, so the
       preference is measured rather than assumed. */
    const both = stripe.invoiceSubscriptionOf({ subscription: "sub_classic", parent: { subscription_details: { subscription: "sub_nested" } } });
    assert.equal(both.subscriptionId, "sub_classic");
    assert.equal(both.source, "invoice");
  });

  await test("A FULL REFUND CANCELS IN STRIPE AND DROPS THE TIER, in that order", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      entitlements: { [`${USER}|stripe`]: { user_id: USER, source: "stripe", tier: "ai", expires_at: "2026-10-17T00:00:00.000Z" } },
      stripeRoutes: {
        "/charges/ch_1": charge(),
        "/invoice_payments": invoicePayments(),
        "/invoices/in_1": invoice(),
        /* The GET answers live, the DELETE answers cancelled — which is
           what makes this a test of the ORDER and not just of the
           calls: the tier can only come out `free` if it was derived
           AFTER the cancellation. */
        "/subscriptions/sub_1": (init) =>
          init && init.method === "DELETE" ? subscription({ status: "canceled" }) : subscription(),
      },
    });
    const res = await deliver(refundEvent());
    w.restore();

    assert.equal(res.status, 200, `a refund was not accepted: ${JSON.stringify(res.body)}`);

    const cancel = w.stripeCalls.filter((c) => c.method === "DELETE");
    assert.equal(cancel.length, 1, `the subscription was not cancelled in Stripe: ${w.stripeCalls.map((c) => `${c.method} ${c.url}`).join(" | ")}`);
    assert.match(cancel[0].url, /\/subscriptions\/sub_1$/, `the wrong thing was cancelled: ${cancel[0].url}`);

    /* THE ORDER, asserted on the trace rather than assumed from the
       outcome: cancel in Stripe FIRST, then write. The reverse leaves a
       student at `free` with a LIVE subscription that renews, and
       nothing repairs that. */
    const cancelAt = w.trace.findIndex((t) => t.startsWith("stripe:DELETE"));
    const writeAt = w.trace.findIndex((t) => t === "db:entitlements.upsert");
    assert.ok(cancelAt >= 0 && writeAt >= 0, `the trace is missing a step: ${w.trace.join(" | ")}`);
    assert.ok(cancelAt < writeAt, `the tier was written before the cancellation: ${w.trace.join(" | ")}`);

    assert.equal(w.profiles[USER].tier, "free", "a refunded student kept their tier");
    const row = w.entitlements[`${USER}|stripe`];
    assert.equal(row.tier, "free", "the entitlement row still grants a paid tier");
    assert.equal(row.expires_at, null, "a lapse must record {free, null} — the one shape exempt from the open-ended refusal");
    assert.ok(w.events["evt_refund"], "the refund was not recorded");
  });

  await test("THE LIVE PATH REALLY CALLS invoice_payments, IN ORDER, and cannot work without it", async () => {
    /* THE END-TO-END CLAIM the live failure needed: on the shape dahlia
       sends, the handler gets from a charge to a subscription. The pure
       tests above prove the decision; this proves the REQUESTS, in
       order, through the real handler.

       It is also the mutation target. Remove the InvoicePayment lookup
       and this reddens, because there is no other route from the
       charge to the invoice on this API version. */
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: {
        "/charges/ch_1": charge(),
        "/invoice_payments": invoicePayments(),
        "/invoices/in_1": invoice(),
        "/subscriptions/sub_1": (init) =>
          init && init.method === "DELETE" ? subscription({ status: "canceled" }) : subscription(),
      },
    });
    const res = await deliver(refundEvent({ id: "evt_refund_live_shape" }));
    w.restore();

    assert.equal(res.status, 200, `the live shape was not handled: ${JSON.stringify(res.body)}`);
    assert.equal(w.profiles[USER].tier, "free", "the tier did not drop on the shape production actually sends");

    /* THE ORDER OF THE FOUR CALLS, asserted on the trace. Each is a
       different endpoint and each needs its own restricted-key grant,
       so the sequence is what somebody adding permissions reads. */
    const calls = w.stripeCalls.map((c) => `${c.method} ${c.url.replace("https://api.stripe.com/v1", "")}`);
    const charged = calls.findIndex((c) => c.startsWith("GET /charges/"));
    const payments = calls.findIndex((c) => c.startsWith("GET /invoice_payments"));
    const invoiced = calls.findIndex((c) => c.startsWith("GET /invoices/"));
    const cancelled = calls.findIndex((c) => c.startsWith("DELETE /subscriptions/"));
    for (const [name, at] of [["charge", charged], ["invoice_payments", payments], ["invoice", invoiced], ["cancel", cancelled]]) {
      assert.ok(at >= 0, `the ${name} call was never made: ${calls.join(" | ")}`);
    }
    assert.ok(charged < payments, `invoice_payments was queried before the charge was read: ${calls.join(" | ")}`);
    assert.ok(payments < invoiced, `the invoice was read before it was located: ${calls.join(" | ")}`);
    assert.ok(invoiced < cancelled, `the subscription was cancelled before the invoice named it: ${calls.join(" | ")}`);

    /* AND THE QUERY CARRIED THE CHARGE'S OWN PAYMENT INTENT, not some
       other filter that would have matched the first InvoicePayment on
       the account. */
    assert.match(
      calls[payments],
      /payment%5Bpayment_intent%5D=pi_1|payment\[payment_intent\]=pi_1/,
      `the InvoicePayment query did not filter on this charge's payment intent: ${calls[payments]}`
    );

    /* WHICH SOURCE FOUND THE INVOICE, logged for the reason
       periodSource is: the next live delivery says whether the legacy
       field or the lookup answered. */
    assert.ok(
      w.logs.some((l) => l.includes('"invoice_id_source":"invoice_payments"')),
      `the invoice source was not logged: ${w.logs.join(" | ")}`
    );
  });

  await test("not_an_invoice IS LOUD, and a partial refund is not", async () => {
    /* `not_an_invoice` is the outcome that hid the field move for a
       day: it answered 200, recorded a row, changed nothing, and read
       as routine. We sell nothing but subscriptions, so a refunded
       charge we cannot tie to an invoice is either a payment we did not
       make or a lookup that has broken again — it stays a 200, because
       a retry cannot fix either, and it is logged as a FAILURE so it is
       visible anyway.

       THE DISCRIMINATING HALF: a partial refund really is routine and
       must stay quiet, or the loud line means nothing. */
    const oneOff = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: { "/charges/ch_1": charge(), "/invoice_payments": { object: "list", data: [] } },
    });
    const a = await deliver(refundEvent({ id: "evt_loud_oneoff" }));
    oneOff.restore();
    assert.equal(a.body.outcome, "not_an_invoice");
    assert.ok(
      oneOff.logs.some((l) => l.includes("FAILURE") && l.includes("not_an_invoice")),
      `not_an_invoice was not reported loudly: ${oneOff.logs.join(" | ")}`
    );
    /* The charge and the payment intent are in it, or the loud line
       names a problem nobody can then go and look at. */
    assert.ok(
      oneOff.logs.some((l) => l.includes("ch_1") && l.includes("pi_1")),
      `the loud line does not identify the charge and payment intent: ${oneOff.logs.join(" | ")}`
    );

    const partial = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: { "/charges/ch_1": charge({ refunded: false, amount_refunded: 20 }) },
    });
    const b = await deliver(refundEvent({ id: "evt_quiet_partial", charge: { refunded: false, amount_refunded: 20 } }));
    partial.restore();
    assert.equal(b.body.outcome, "partial_refund");
    assert.ok(
      !partial.logs.some((l) => l.includes("FAILURE")),
      `a partial refund was reported as a failure: ${partial.logs.join(" | ")}`
    );
    /* AND IT COSTS ONE REQUEST. A partial refund is refused on the
       charge alone, so it must not pay for the two lookups. */
    assert.ok(
      !partial.stripeCalls.some((c) => c.url.includes("/invoice_payments") || c.url.includes("/invoices/")),
      `a partial refund paid for an invoice lookup: ${partial.stripeCalls.map((c) => c.url).join(" | ")}`
    );
  });

  await test("A PERMISSION ERROR IS NOT AN OUTAGE: its own code, and Stripe's own message in the log", async () => {
    /* THE LIVE DIAGNOSIS THIS COST. A restricted key without
       `charge_read` answered 403, `stripeRequest` discarded Stripe's
       body and substituted "Stripe returned 403", and the handler
       reported `upstream_unavailable` — indistinguishable from a
       timeout. Stripe's body named the exact grant to enable, and it
       had already been parsed.

       Both halves are asserted: the CODE tells a configuration error
       from an outage, and the MESSAGE carries the remedy. */
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: {
        "/charges/ch_1": {
          __status: 403,
          __body: { error: { code: "more_permissions_required", message: "Enabling Charges and Refunds Read ('charge_read') permissions on this key would allow this request to continue." } },
        },
      },
    });
    const res = await deliver(refundEvent({ id: "evt_forbidden" }));
    w.restore();

    assert.ok(res.status >= 500, `a permission error was accepted (${res.status}) — the event would be lost`);
    assert.equal(
      res.body.code,
      "stripe_permission_denied",
      `a 403 still reads as an outage: ${JSON.stringify(res.body)}`
    );
    /* MATCHED ON A PHRASE FROM STRIPE'S SENTENCE, not on the grant
       name: `charge_read` is a SUBSTRING of the stage label
       `refund_charge_read`, so the first version of this assertion was
       satisfied by the stage it sits beside and passed while the fake
       was swallowing the body entirely. The guard met its own subject,
       which is the oldest entry in this project's ledger. */
    assert.ok(
      w.logs.some((l) => l.includes("would allow this request to continue")),
      `Stripe's own message was discarded, which is what cost the diagnosis: ${w.logs.join(" | ")}`
    );
    /* THE STAGE NAMES THE ENDPOINT. It used to say `subscription_read`
       for a charge retrieve, on a key that had subscription read, which
       sent the diagnosis at the wrong permission. */
    assert.ok(
      w.logs.some((l) => l.includes("refund_charge_read")),
      `the failing stage does not name the charge read: ${w.logs.join(" | ")}`
    );
    assert.ok(
      !w.logs.some((l) => l.includes("FAILURE") && l.includes('"stage":"subscription_read"')),
      `a charge retrieve is still logged as a subscription read: ${w.logs.join(" | ")}`
    );
    /* AND A 500 IS STILL AN OUTAGE, or the code above is not
       discriminating. */
    const t = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: { "/charges/ch_1": { __status: 500 } },
    });
    const outage = await deliver(refundEvent({ id: "evt_outage" }));
    t.restore();
    assert.equal(outage.body.code, "upstream_unavailable", `a 500 does not read as an outage: ${JSON.stringify(outage.body)}`);
  });

  await test("A PARTIAL REFUND OF A NON-SUBSCRIPTION CHARGE TOUCHES NOTHING", async () => {
    /* Jared's requirement, and the reason it is its own test rather
       than a row in the table above: the table proves the DECISION, and
       this proves that nothing downstream of it runs — no cancellation,
       no tier write, and not even the invoice lookup, since a partial
       refund is refused before a second Stripe request is worth
       making. */
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      entitlements: { [`${USER}|stripe`]: { user_id: USER, source: "stripe", tier: "ai", expires_at: "2026-10-17T00:00:00.000Z" } },
      stripeRoutes: {
        "/charges/ch_1": charge({ refunded: false, amount_refunded: 20 }),
        "/invoices/in_1": invoice(),
        "/subscriptions/sub_1": subscription(),
      },
    });
    const res = await deliver(refundEvent({ charge: { refunded: false, amount_refunded: 20 } }));
    w.restore();

    assert.equal(res.status, 200, `a partial refund was not accepted: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.outcome, "partial_refund", `the reason was not carried out: ${JSON.stringify(res.body)}`);
    assert.deepEqual(w.stripeCalls.filter((c) => c.method === "DELETE"), [], "a partial refund cancelled a subscription");
    assert.ok(
      !w.stripeCalls.some((c) => c.url.includes("/invoices/")),
      `a partial refund cost an invoice lookup: ${w.stripeCalls.map((c) => c.url).join(" | ")}`
    );
    assert.equal(w.profiles[USER].tier, "ai", "a partial refund moved the tier");
    assert.equal(w.entitlements[`${USER}|stripe`].tier, "ai", "a partial refund rewrote the entitlement row");
    assert.deepEqual(
      w.writes.filter((x) => x.table === "profiles"),
      [],
      "profiles was written for a partial refund"
    );
    assert.ok(w.events["evt_refund"], "the partial refund was not recorded — it must be, or a redelivery repeats the work");
  });

  await test("A FULL REFUND OF A ONE-OFF PAYMENT TOUCHES NOTHING", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      entitlements: { [`${USER}|stripe`]: { user_id: USER, source: "stripe", tier: "ai", expires_at: "2026-10-17T00:00:00.000Z" } },
      /* A one-off payment: no invoice anywhere, so the InvoicePayment
         list comes back empty rather than being absent. */
      stripeRoutes: {
        "/charges/ch_1": charge(),
        "/invoice_payments": { object: "list", data: [], has_more: false },
        "/subscriptions/sub_1": subscription(),
      },
    });
    const res = await deliver(refundEvent());
    w.restore();

    assert.equal(res.body.outcome, "not_an_invoice", `a one-off refund read as ${JSON.stringify(res.body)}`);
    assert.deepEqual(w.stripeCalls.filter((c) => c.method === "DELETE"), [], "a one-off refund cancelled a subscription");
    assert.equal(w.profiles[USER].tier, "ai", "a one-off refund moved the tier");
  });

  await test("THE PAYLOAD IS NOT EVIDENCE ON A REFUND EITHER — a forged full refund is re-read", async () => {
    /* A delivered charge claiming `refunded: true` must not be able to
       cancel anybody's subscription. The body says fully refunded and
       Stripe says partial; Stripe wins, and nothing happens. The
       signature makes this a narrow attack, and "the signature is the
       only thing standing between a body and a cancellation" is exactly
       the shape this project re-reads to avoid. */
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      entitlements: { [`${USER}|stripe`]: { user_id: USER, source: "stripe", tier: "ai", expires_at: "2026-10-17T00:00:00.000Z" } },
      stripeRoutes: {
        "/charges/ch_1": charge({ refunded: false, amount_refunded: 10 }),
        "/invoices/in_1": invoice(),
        "/subscriptions/sub_1": subscription(),
      },
    });
    const res = await deliver(refundEvent({ charge: { refunded: true } }));
    w.restore();

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "partial_refund", "the delivered claim was believed over Stripe's own record");
    assert.deepEqual(w.stripeCalls.filter((c) => c.method === "DELETE"), [], "a forged refund flag cancelled a subscription");
    assert.equal(w.profiles[USER].tier, "ai");
  });

  await test("AN ALREADY-CANCELLED SUBSCRIPTION IS NOT CANCELLED TWICE, and the tier still lands", async () => {
    /* A redelivery can reach the cancel: the idempotency SELECT is an
       optimisation that may fail, with the primary key as the real
       guarantee. Stripe refuses to cancel a cancelled subscription, so
       re-entering this path must skip the call and still write. */
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: {
        "/charges/ch_1": charge(),
        "/invoice_payments": invoicePayments(),
        "/invoices/in_1": invoice(),
        "/subscriptions/sub_1": subscription({ status: "canceled" }),
      },
    });
    const res = await deliver(refundEvent({ id: "evt_refund_again" }));
    w.restore();

    assert.equal(res.status, 200, `a redelivered refund failed: ${JSON.stringify(res.body)}`);
    assert.deepEqual(w.stripeCalls.filter((c) => c.method === "DELETE"), [], "a cancelled subscription was cancelled again");
    assert.equal(w.profiles[USER].tier, "free", "the tier did not land on the re-entered path");
    assert.ok(w.logs.some((l) => l.includes("refund_already_cancelled")), `the skip was not reported: ${w.logs.join(" | ")}`);
  });

  await test("A FAILED CANCELLATION WRITES NOTHING AND RETRIES — the tier stays until Stripe agrees", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      entitlements: { [`${USER}|stripe`]: { user_id: USER, source: "stripe", tier: "ai", expires_at: "2026-10-17T00:00:00.000Z" } },
      stripeRoutes: {
        "/charges/ch_1": charge(),
        "/invoice_payments": invoicePayments(),
        "/invoices/in_1": invoice(),
        "/subscriptions/sub_1": (init) => (init && init.method === "DELETE" ? { __status: 500 } : subscription()),
      },
    });
    const res = await deliver(refundEvent());
    w.restore();

    assert.ok(res.status >= 500, `a failed cancellation was accepted (${res.status}) — nothing will retry it`);
    assert.equal(w.profiles[USER].tier, "ai", "the tier was taken away while Stripe still holds a live subscription");
    assert.equal(w.entitlements[`${USER}|stripe`].tier, "ai", "the entitlement row moved on a failed cancellation");
    assert.ok(!w.events["evt_refund"], "a failed cancellation was recorded as handled, so the retry will be refused as a duplicate");
  });

  await test("THE PRE-2025 INVOICE SHAPE STILL CANCELS — the fallback nothing exercises any more", async () => {
    /* THIS TEST CHANGED SIDES, and the reason is worth keeping. It was
       written as "the 2025+ shape, pre-empted" — a control for a future
       Stripe might send — and the live refund of 18 September logged
       `"invoice_source":"parent"`, which made that shape the PRESENT
       and left the classic `invoice.subscription` as the branch nothing
       in production touches.

       So it guards the fallback now, and that is exactly when a
       fallback needs a named test: the default fixture stopped covering
       it the moment production moved, and an unexercised branch is one
       somebody deletes as dead. The parent shape is covered by every
       other end-to-end test in this section, through the default. */
    const w = makeWorld({
      profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe", stripe_customer_id: "cus_1" }) },
      stripeRoutes: {
        "/charges/ch_1": charge(),
        "/invoice_payments": invoicePayments(),
        "/invoices/in_1": invoiceLegacySubscriptionField(),
        "/subscriptions/sub_1": (init) =>
          init && init.method === "DELETE" ? subscription({ status: "canceled" }) : subscription(),
      },
    });
    const res = await deliver(refundEvent({ id: "evt_refund_parent" }));
    w.restore();

    assert.equal(res.status, 200);
    assert.equal(w.stripeCalls.filter((c) => c.method === "DELETE").length, 1, "the legacy invoice shape did not resolve a subscription");
    assert.equal(w.profiles[USER].tier, "free");
    assert.ok(
      w.logs.some((l) => l.includes('"invoice_source":"invoice"')),
      `the legacy shape did not report itself as the source: ${w.logs.join(" | ")}`
    );
  });

  /* ---------- 5. who it is about ---------- */

  await test("the uid comes from the SUBSCRIPTION's metadata, which every renewal carries", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile() },
      /* The delivered event names nobody; the re-read subscription does. */
      stripeRoutes: { "/subscriptions/sub_1": subscription({ metadata: { uid: USER } }) },
    });
    await deliver(event({ subscription: { metadata: {} } }));
    w.restore();
    assert.equal(w.profiles[USER].tier, "ai");
  });

  await test("with no uid anywhere it falls back to the STORED customer id, never to an email", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile({ stripe_customer_id: "cus_1" }) },
      stripeRoutes: { "/subscriptions/sub_1": subscription({ metadata: {}, customer: "cus_1" }) },
    });
    await deliver(event({ subscription: { metadata: {} } }));
    w.restore();
    assert.equal(w.profiles[USER].tier, "ai", "the owner was not found by their stored customer id");
    for (const write of w.writes.filter((x) => x.table === "profiles" && x.op === "update")) {
      assert.ok(write.filters.some(([c, v]) => c === "user_id" && v === USER), `an unscoped write: ${JSON.stringify(write.filters)}`);
    }
  });

  await test("AN EVENT FOR AN ACCOUNT WE DO NOT HAVE is recorded and answered 200", async () => {
    /* 0018's lesson, one integration over: Stripe retries every non-2xx
       exactly as RevenueCat does, so a permanently unknown user
       answered 5xx comes back until the window expires. */
    const w = makeWorld({ profiles: {}, stripeRoutes: { "/subscriptions/sub_1": subscription({ metadata: { uid: OTHER }, customer: "cus_nobody" }) } });
    const res = await deliver(event());
    w.restore();
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`);
    const row = w.writes.find((x) => x.table === "billing_events").values;
    assert.equal(row.user_id, null, "an id that is not one of our accounts reached user_id");
    assert.equal(row.store, "stripe");
    assert.equal(row.tier_after, null, "a tier was recorded as written when nothing was written");
  });

  await test("a redelivery is one row, and costs no Stripe request", async () => {
    const shared = { profiles: { [USER]: profile() }, events: {}, stripeRoutes: { "/subscriptions/sub_1": subscription() } };
    const first = makeWorld(shared);
    await deliver(event());
    first.restore();
    assert.equal(Object.keys(shared.events).length, 1, "the first delivery recorded nothing");

    const second = makeWorld(shared);
    const res = await deliver(event());
    second.restore();
    assert.equal(res.body.outcome, "duplicate");
    assert.equal(Object.keys(shared.events).length, 1, "a redelivery wrote a second row");
    assert.deepEqual(second.stripeCalls, [], "a redelivery cost a Stripe request");
  });

  await test("an event type we do not act on is recorded and ignored, never guessed at", async () => {
    const w = makeWorld({ profiles: { [USER]: profile() }, stripeRoutes: { "/subscriptions/sub_1": subscription() } });
    const res = await deliver(event({ id: "evt_invoice", type: "invoice.payment_succeeded" }));
    w.restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "ignored");
    assert.deepEqual(w.stripeCalls, [], "an event we do not act on still cost a Stripe request");
    assert.deepEqual(w.writes.filter((x) => x.table === "profiles"), [], "an event we do not act on wrote a tier");
  });

  await test("a cancellation ends the plan, and MANUAL still wins", async () => {
    const lapsed = { "/subscriptions/sub_1": subscription({ status: "canceled" }) };
    const w = makeWorld({ profiles: { [USER]: profile({ tier: "ai", tier_source: "stripe", store: "stripe" }) }, stripeRoutes: lapsed });
    await deliver(event({ id: "evt_cancel", type: "customer.subscription.deleted" }));
    w.restore();
    assert.equal(w.profiles[USER].tier, "free", "a cancelled subscription kept its tier");

    const manual = makeWorld({ profiles: { [USER]: profile({ tier: "ai_max", tier_source: "manual" }) }, stripeRoutes: lapsed });
    await deliver(event({ id: "evt_cancel2", type: "customer.subscription.deleted" }));
    manual.restore();
    assert.equal(manual.profiles[USER].tier, "ai_max", "a webhook took away a hand-granted tier");
  });

  /* ---------- 6. checkout: identity and amount are never the client's ---------- */

  await test("checkout takes the uid from the JWT and the PRICE from the server, ignoring both in the body", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile(), [OTHER]: profile({ user_id: OTHER }) },
      stripeRoutes: {
        "/prices?": { data: [{ id: "price_1" }] },
        "/customers": { id: "cus_new" },
        "/checkout/sessions": { url: "https://checkout.stripe.com/c/pay/x" },
      },
    });
    const res = await post(CHECKOUT, { token: `token:${USER}`, body: { tier: "ai", duration: "monthly", uid: OTHER, user_id: OTHER, price: "price_cheap" } });
    w.restore();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = w.stripeCalls.find((c) => c.url.includes("/checkout/sessions"));
    assert.ok(session, "no checkout session was created");
    assert.ok(session.body.includes(encodeURIComponent(USER)), "the session does not carry the signed-in uid");
    assert.ok(!session.body.includes(encodeURIComponent(OTHER)), "a uid from the REQUEST BODY reached Stripe");
    assert.ok(!session.body.includes("price_cheap"), "a price from the request body reached Stripe");
    assert.ok(session.body.includes("price_1"), "the price the server resolved was not used");
    /* Three places, each read by something different — the dashboard,
       the session event, and every later subscription event. */
    for (const field of ["client_reference_id", "metadata%5Buid%5D", "subscription_data%5Bmetadata%5D%5Buid%5D"]) {
      assert.ok(session.body.includes(field), `the session does not set ${field}`);
    }
  });

  await test("the session offers promotion codes, as the STRING the form API reads", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile() },
      stripeRoutes: {
        "/prices?": { data: [{ id: "price_1" }] },
        "/customers": { id: "cus_new" },
        "/checkout/sessions": { url: "https://checkout.stripe.com/c/pay/x" },
      },
    });
    const res = await post(CHECKOUT, { token: `token:${USER}`, body: { tier: "ai", duration: "monthly" } });
    w.restore();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = w.stripeCalls.find((c) => c.url.includes("/checkout/sessions"));
    assert.ok(session, "no checkout session was created");
    assert.match(
      session.body,
      /(^|&)allow_promotion_codes=true(&|$)/,
      `the promo-code field is absent or not the string "true": ${session.body}`
    );

    /* STRIPE REFUSES A SESSION THAT SETS BOTH. Recorded as a test
       rather than only as a comment, because the day somebody adds a
       server-side discount this is the line that says why the two
       cannot both be here. */
    assert.ok(!session.body.includes("discounts"), "a session cannot set allow_promotion_codes AND discounts");
  });

  await test("A DISCOUNT NEVER CHANGES WHICH PLAN SOMEBODY IS ON — behaviour", () => {
    /* Turning promo codes on means discounted subscriptions start
       arriving at the webhook. The tier must be identical to the
       undiscounted one, because a coupon changes what is CHARGED for a
       Price and does not replace the Price on the line item.

       BOTH DISCOUNT SHAPES, named rather than assumed. Stripe has
       carried this as a singular `discount` and as a `discounts` array
       across versions, and #68 was this repository being wrong about
       exactly that kind of move — so neither shape is the fixture's
       default and both are here by name. A 100%-off coupon is included
       because that is the case where an amount-reading mapper would
       most obviously break. */
    const plain = subscription();
    const base = stripe.tierFromStripeSubscription(plain);
    assert.equal(base.tier, "ai", "the undiscounted fixture does not resolve, so the comparison below is meaningless");
    assert.equal(base.recognised, true);

    const discounted = [
      ["singular `discount`", { ...plain, discount: { coupon: { id: "SAVE20", percent_off: 20 } } }],
      ["`discounts` array", { ...plain, discounts: [{ coupon: { id: "SAVE20", percent_off: 20 } }] }],
      ["100% off", { ...plain, discounts: [{ coupon: { id: "FREEYEAR", percent_off: 100 } }] }],
      ["a fixed amount off", { ...plain, discounts: [{ coupon: { id: "TENOFF", amount_off: 1000, currency: "aud" } }] }],
    ];
    assert.ok(discounted.length >= 4, "the discount table shrank");

    for (const [name, sub] of discounted) {
      /* Non-vacuity: the fixture really carries a discount, so an
         assertion of "unchanged" is about something. */
      assert.ok(
        JSON.stringify(sub).includes("coupon"),
        `${name}: the fixture carries no discount, so this row proves nothing`
      );
      const got = stripe.tierFromStripeSubscription(sub);
      assert.deepEqual(got, base, `${name}: a discount changed what the mapper returned`);
    }
  });

  await test("A DISCOUNT NEVER CHANGES WHICH PLAN SOMEBODY IS ON — the invariant that outlives the fixture", () => {
    /* THE TEST ABOVE IS ONLY AS GOOD AS MY MODEL OF STRIPE'S SHAPE, and
       this repository has already been wrong about one (#68: the period
       end moved onto the subscription ITEMS and every fixture still
       described the old place). So the load-bearing guard is not "these
       four shapes are ignored" but "no amount-shaped field is read at
       ALL" — which holds however Stripe represents a discount,
       including in a shape nobody here has seen.

       Scoped to the two functions that decide a tier, read from source
       with comments stripped so the prose above does not match itself
       — the grep rule this codebase has six instances of. */
    const src = fs
      .readFileSync(path.join(rootDir, "supabase/functions/_shared/stripe.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    const from = src.indexOf("export function tierFromStripeSubscription");
    assert.ok(from > 0, "tierFromStripeSubscription was not found — this guard would pass over nothing");
    const body = src.slice(from);
    assert.ok(body.length > 400, "the mapper body looks empty, so nothing below is being checked");

    /* What the tier MAY depend on, and it is a short list. */
    assert.ok(body.includes("lookup_key"), "the mapper no longer reads lookup_key, so what is deciding the tier?");

    const FORBIDDEN = [
      "discount",
      "coupon",
      "promotion_code",
      "amount_off",
      "percent_off",
      "unit_amount",
      "amount_total",
      "amount_due",
      "currency",
    ];
    for (const field of FORBIDDEN) {
      assert.ok(
        !body.includes(field),
        `the tier mapper reads \`${field}\` — a discount can now change which plan somebody is on`
      );
    }
  });

  await test("checkout refuses without a session, and refuses a plan that is not ours", async () => {
    const w = makeWorld({ profiles: { [USER]: profile() } });
    assert.equal((await post(CHECKOUT, { body: { tier: "ai", duration: "monthly" } })).status, 401);
    assert.deepEqual(w.stripeCalls, [], "an unauthenticated checkout reached Stripe");
    const bad = await post(CHECKOUT, { token: `token:${USER}`, body: { tier: "ai_max", duration: "weekly" } });
    w.restore();
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "bad_request");
  });

  await test("AN ACCOUNT WITH A STORE SUBSCRIPTION CANNOT BUY AGAIN HERE, and is told which store", async () => {
    /* Two providers each re-reading only their own would flap the tier
       between them, and the student would be paying twice. This closes
       the door we control. */
    const w = makeWorld({ profiles: { [USER]: profile({ tier: "ai", tier_source: "revenuecat", store: "app_store" }) } });
    const res = await post(CHECKOUT, { token: `token:${USER}`, body: { tier: "ai_max", duration: "monthly" } });
    w.restore();
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "store_subscription_active");
    assert.equal(res.body.store, "app_store");
    assert.deepEqual(w.stripeCalls, [], "a refused checkout still created something at Stripe");
    assert.match(copy.webFailureMessage(res.body.code, res.body.store), /App Store/i, "the student is not told where their subscription is");
    assert.match(copy.webFailureMessage(res.body.code, "play_store"), /Google Play/i);
  });

  await test("the customer is STORED before the session is created", async () => {
    /* The aiNotesStore ordering rule, one integration over: never leave
       something at Stripe this side has no record of, or the next
       checkout makes a second customer and the Portal opens the wrong
       one. */
    const w = makeWorld({
      profiles: { [USER]: profile() },
      stripeRoutes: {
        "/prices?": { data: [{ id: "price_1" }] },
        "/customers": { id: "cus_new" },
        "/checkout/sessions": { url: "https://checkout.stripe.com/c/pay/x" },
      },
    });
    await post(CHECKOUT, { token: `token:${USER}`, body: { tier: "ai", duration: "monthly" } });
    w.restore();
    const storedAt = w.trace.indexOf("db:profiles.update");
    const sessionAt = w.trace.findIndex((t) => t.includes("/checkout/sessions"));
    assert.ok(storedAt >= 0 && sessionAt >= 0, `both must happen: ${w.trace.join(" -> ")}`);
    assert.ok(storedAt < sessionAt, "the checkout session was created before the customer id was stored");
    assert.equal(w.profiles[USER].stripe_customer_id, "cus_new");
  });

  await test("no active price is its OWN answer, not a failure to reach Stripe", async () => {
    const w = makeWorld({ profiles: { [USER]: profile() }, stripeRoutes: { "/prices?": { data: [] } } });
    const res = await post(CHECKOUT, { token: `token:${USER}`, body: { tier: "ai", duration: "monthly" } });
    w.restore();
    assert.equal(res.body.code, "plan_unavailable", "a dashboard with no price reads as an unreachable Stripe");
    assert.match(copy.webFailureMessage("plan_unavailable"), /isn't available/i);
  });

  /* ---------- 7. the portal ---------- */

  await test("the portal opens the customer stored on THIS account, and refuses when there is none", async () => {
    const w = makeWorld({
      profiles: { [USER]: profile({ stripe_customer_id: "cus_mine" }), [OTHER]: profile({ user_id: OTHER, stripe_customer_id: "cus_theirs" }) },
      stripeRoutes: { "/billing_portal/sessions": { url: "https://billing.stripe.com/p/session/x" } },
    });
    const res = await post(PORTAL, { token: `token:${USER}`, body: { customer: "cus_theirs" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const call = w.stripeCalls.find((c) => c.url.includes("billing_portal"));
    assert.ok(call.body.includes("cus_mine"), "the portal did not open this account's customer");
    assert.ok(!call.body.includes("cus_theirs"), "a customer id from the REQUEST BODY reached Stripe — that is somebody else's billing");

    const none = await post(PORTAL, { token: `token:${OTHER.replace("2", "3")}` });
    w.restore();
    assert.equal(none.body.code, "no_stripe_customer", "an account with no Stripe customer is reported as a failure");
    assert.match(copy.webFailureMessage("no_stripe_customer"), /no card subscription/i);
  });

  /* ---------- 8. the flag ---------- */

  await test("ALL THREE FUNCTIONS REFUSE WITHOUT THEIR SECRETS — the flag IS the configuration", async () => {
    for (const [name, bundle] of [["checkout", CHECKOUT], ["portal", PORTAL]]) {
      const w = makeWorld({ profiles: { [USER]: profile() }, env: { STRIPE_SECRET_KEY: "" } });
      const res = await post(bundle, { token: `token:${USER}`, body: { tier: "ai", duration: "monthly" } });
      w.restore();
      assert.equal(res.body.code, "stripe_disabled", `${name} did not refuse without a Stripe key`);
      assert.deepEqual(w.stripeCalls, [], `${name} reached Stripe with no key configured`);
    }
    for (const missing of [{ STRIPE_SECRET_KEY: "" }, { STRIPE_WEBHOOK_SECRET: "" }]) {
      const w = makeWorld({ profiles: { [USER]: profile() }, env: missing });
      const res = await deliver(event());
      w.restore();
      assert.equal(res.body.code, "stripe_disabled", `the webhook ran with ${Object.keys(missing)[0]} unset`);
      assert.deepEqual(w.writes, [], "a disabled webhook recorded an event as handled");
    }
  });

  await test("THE FLAG IS ON, AND THAT IS A RECORDED DECISION — 17 September 2026", async () => {
    /* THIS TRIPWIRE HAS NOW FIRED FOR ITS INTENDED REASON. It read
       `assert.equal(flags.STRIPE_ENABLED, false, "web purchases are
       switched on — that is a decision, not a default")`, which is a
       guard whose whole job is to make somebody stop and write down
       why. So:

       The switch-on order STRIPE-SWITCH-ON.md insists on was followed
       and each step was observed rather than assumed — 0019 applied
       with its UNIQUE constraint confirmed by name, the six live
       prices created with their lookup keys, the Customer Portal
       configured, the Terms URL present (account-wide, not per mode —
       found by Stripe refusing the test-mode save), the live endpoint
       created on Snapshot payload style at the API version this repo
       pins, a restricted live key scoped to the five calls the code
       actually makes, and a SIGNED delivery watched landing in
       billing_events before anything was flipped.

       That last one is the point of the ordering: a boolean saying
       "on" beside an unset key is a button that fails after the
       click, which is the worst of the three states. */
    assert.equal(flags.STRIPE_ENABLED, true, "web purchases are switched off again — if that is intended, this test records the reversal");
  });

  await test("the client refuses before the network when DISABLED, whatever the flag currently says", async () => {
    /* `enabled` is now passed EXPLICITLY. It used to come from the
       module default, so this claim silently became a claim about the
       flag's current value rather than about the client's behaviour —
       and it broke when the flag flipped, which is the wrong reason
       for a test about refusing to change. The behaviour is timeless;
       the flag is not. */
    const client = await import(pathToFileURL(path.join(rootDir, "src/stripeClient.js")).href);
    let reached = false;
    const spy = async () => {
      reached = true;
      return {};
    };
    for (const call of [client.startCheckout, client.openPortal]) {
      await assert.rejects(
        () => call({ token: "t", tier: "ai", duration: "monthly", enabled: false, fetchImpl: spy }),
        (err) => err.code === "stripe_disabled"
      );
    }
    assert.equal(reached, false, "a disabled client still made a request");

    /* And the gate is not ONLY the flag: signed out refuses too, with
       the flag on. */
    await assert.rejects(
      () => client.startCheckout({ token: "", tier: "ai", duration: "monthly", enabled: true, fetchImpl: spy }),
      (err) => err.code === "unauthenticated"
    );
    assert.equal(reached, false, "a signed-out client still made a request");

    /* THE CONTROL. Every assertion above is an absence, and "the
       client never calls fetch" is satisfied by a client that can
       never call it at all. Enabled AND signed in must reach the
       network, or the three refusals prove nothing. */
    await client
      .startCheckout({ token: "t", tier: "ai", duration: "monthly", enabled: true, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, url: "https://checkout.stripe.com/x" }) }) })
      .catch(() => {});
    assert.equal(reached, false, "the control used the spy rather than its own fetch");
  });

  /* ---------- 8b. the dashboard list is not a restatement ---------- */

  await test("STRIPE-SWITCH-ON.md's EVENT LIST EQUALS `ACTIONABLE` — the list a person types in", () => {
    /* THIS GUARD IS THE BUG IT GUARDS AGAINST, one layer up.
       `charge.refunded` exists because the panel promised "if a
       subscription is refunded, the plan ends straight away and goes
       back to Free" and no code did it. Adding the event to ACTIONABLE
       and NOT to the document would leave somebody configuring six
       events at two endpoints — and the handler would be ready to act
       on a refund that never arrives. Same silence, same promise, one
       layer further out.

       DERIVED ON BOTH SIDES. The document's fenced block is parsed and
       the function's `ACTIONABLE` set is read out of its source, then
       compared — rather than a count, or a check that the newest name
       appears somewhere, either of which passes while the two lists
       disagree about everything else. */
    const doc = fs.readFileSync(path.join(rootDir, "STRIPE-SWITCH-ON.md"), "utf8");
    const fn = fs.readFileSync(path.join(rootDir, "supabase/functions/stripe-webhook/index.ts"), "utf8");

    const set = fn.split("const ACTIONABLE = new Set([")[1];
    assert.ok(set, "ACTIONABLE was not found in the function — this guard is reading the wrong file");
    const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const inCode = [...stripComments(set.split("]);")[0]).matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g)].map((m) => m[1]).sort();

    /* The fenced block that FOLLOWS the sentence naming ACTIONABLE, so
       a later fence elsewhere in the document cannot be picked up by
       accident. */
    const after = doc.split("which are the `ACTIONABLE` set in")[1];
    assert.ok(after, "the document no longer says its list is the ACTIONABLE set — the anchor moved");
    const fence = after.split("```")[1];
    assert.ok(fence, "no fenced event list follows that sentence");
    const inDoc = fence.split("\n").map((l) => l.trim()).filter(Boolean).sort();

    assert.ok(inCode.length >= 6, `only ${inCode.length} events parsed out of ACTIONABLE — the parse is wrong, not the lists`);
    assert.ok(inDoc.length >= 6, `only ${inDoc.length} events parsed out of the document`);
    assert.deepEqual(
      inDoc,
      inCode,
      `STRIPE-SWITCH-ON.md and ACTIONABLE disagree, so whoever follows the document configures the wrong endpoint.\n` +
        `        document: ${inDoc.join(", ")}\n        function: ${inCode.join(", ")}`
    );

    /* AND THE COUNT IN THE PROSE, because "these seven" beside a list
       of eight is the same drift in a word. */
    const words = { 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
    const expected = words[inCode.length];
    assert.ok(expected, `no word is known for ${inCode.length} events — extend the table`);
    assert.ok(
      doc.includes(`exactly these ${expected}`),
      `the document says a count other than "${expected}", which is what somebody reads before counting the list`
    );
  });

  /* ---------- 9. source-level invariants ---------- */

  const stripSrc = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  await test("the webhook never parses the body before verifying it", () => {
    const code = stripSrc(fs.readFileSync(path.join(rootDir, "supabase/functions/stripe-webhook/index.ts"), "utf8"));
    assert.ok(!/req\.json\s*\(/.test(code), "stripe-webhook calls req.json(); the signature covers the raw bytes");
    const body = code.slice(code.indexOf("export async function handle"));
    assert.ok(body.length > 500, "the handler body was not found — this guard would pass over nothing");
    const textAt = body.indexOf("req.text()");
    const verifyAt = body.search(/await\s+signStripePayload\(/);
    const parseAt = body.indexOf("JSON.parse");
    assert.ok(textAt >= 0 && verifyAt >= 0 && parseAt >= 0, "one of read/verify/parse is missing");
    assert.ok(textAt < verifyAt, "the signature is computed before the body has been read");
    assert.ok(verifyAt < parseAt, "the body is parsed before its signature is verified");
  });

  await test("NOTHING IN THE STRIPE PATH EVER MATCHES A CUSTOMER BY EMAIL", () => {
    /* The account takeover CLAUDE.md's service-role section is about,
       in the one integration where it would be easiest: Stripe's API
       has a customer search by email and using it would attach one
       student's subscription to another's account. Every profiles query
       here must be scoped by user_id or by the stored customer id. */
    const files = ["stripe-webhook", "billing-checkout", "billing-portal"].map((f) => `supabase/functions/${f}/index.ts`);
    let froms = 0;
    let scoped = 0;
    for (const rel of files) {
      const code = stripSrc(fs.readFileSync(path.join(rootDir, rel), "utf8"));
      assert.ok(!/email/i.test(code), `${rel} mentions an email address — a customer must never be matched by one`);
      /* `[, , tail]` and NOT `[, tail]`: group 1 is the table name and
         group 2 is the query that follows it. The first version of this
         matched the pattern against `"billing_events"`, which contains
         no `.eq(`, so every query "failed" — and because assert throws
         on the first one, the report named one file and looked like a
         real finding about the code. A selector's failure mode is
         naming the WRONG thing, not naming nothing, which is why the
         count below is not enough on its own. */
      for (const [, , tail] of code.matchAll(/\.from\(\s*["'](\w+)["']\s*\)([\s\S]{0,300})/g)) {
        /* READS AND UPDATES MUST BE SCOPED; AN INSERT HAS NOTHING TO
           SCOPE. A select or an update with no filter reads or
           overwrites somebody else's row — that is the whole
           service-role rule. An insert carries its own user_id in the
           row and can only ever add; there is no filter that would
           make it safer, and demanding one would have this guard
           report a fault that does not exist. */
        if (/^\s*\.insert\(/.test(tail)) continue;
        froms += 1;
        assert.match(tail, /\.eq\(\s*["'](user_id|id|stripe_customer_id)["']/, `${rel}: a read or update is scoped by nothing that identifies an account`);
        scoped += 1;
      }
    }
    assert.ok(froms >= 4, `expected the profiles and billing_events reads, found ${froms}`);
    assert.ok(scoped >= 4, `only ${scoped} of ${froms} queries were positively matched as scoped — the pattern is reading the wrong group`);
  });

  await test("the Stripe functions read no table they have no business in", () => {
    const allowed = new Set(["profiles", "billing_events"]);
    for (const f of ["stripe-webhook", "billing-checkout", "billing-portal"]) {
      const code = stripSrc(fs.readFileSync(path.join(rootDir, `supabase/functions/${f}/index.ts`), "utf8"));
      for (const [, table] of code.matchAll(/\.from\(\s*["'](\w+)["']\s*\)/g)) {
        assert.ok(allowed.has(table), `${f} touches ${table}`);
      }
    }
  });

  await test("the return URL and the pinned API version are not left to a request or a dashboard", () => {
    /* Taking the return URL from the request's Origin would be an open
       redirect with a signed-in session attached; leaving the API
       version unpinned means Stripe answers with whatever the account's
       dashboard is set to, which nobody in this repository can see. */
    /* IT MIRRORS `APP_URL`, NOT `SITE_URL`, SINCE THE PATH SPLIT. `/`
       is the marketing page now — no session, no Plans panel, nothing
       to confirm a payment with — so a return URL still equal to
       SITE_URL lands a student who has just paid on an advertisement
       for the thing they bought. The mirror is unavoidable (a Deno
       function cannot import a browser module) so the EQUALITY is the
       guard, as everywhere else this pattern is allowed. */
    assert.equal(stripe.APP_URL, links.APP_URL, "the checkout return URL and the app's own location have drifted");
    assert.notEqual(stripe.APP_URL, links.SITE_URL, "the checkout returns to the marketing page, which cannot tell anybody their payment worked");
    /* SAME ORIGIN, DEEPER PATH — the split's whole shape, asserted
       where a careless "fix" would reach for a subdomain. */
    assert.equal(new URL(stripe.APP_URL).origin, new URL(links.SITE_URL).origin, "the return URL left the app's origin");
    assert.ok(stripe.CHECKOUT_SUCCESS_URL.startsWith(links.APP_URL), "the success URL is not under the app");
    assert.ok(stripe.CHECKOUT_CANCEL_URL.startsWith(links.APP_URL), "the cancel URL is not under the app");
    /* A DATE, WITH STRIPE'S OPTIONAL RELEASE NAME. Versions used to be
       a bare date; they now carry a channel suffix
       ("2026-04-22.dahlia"), and the first version of this assertion
       allowed only the old shape — so pinning to the version the
       endpoint actually delivers failed the test that exists to
       require a pin. The date half stays strict, because that is the
       part that orders two versions; the suffix is Stripe's to name. */
    assert.match(
      stripe.STRIPE_API_VERSION,
      /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/,
      "the Stripe API version is not pinned to a date (optionally with Stripe's release name)"
    );
    /* AND IT IS SENT. A pinned constant that reaches no header is a
       comment: Stripe would answer every request at the account
       default and nothing here would look wrong. */
    const shared = fs.readFileSync(path.join(rootDir, "supabase/functions/_shared/stripe.ts"), "utf8");
    assert.match(shared, /"Stripe-Version":\s*STRIPE_API_VERSION/, "STRIPE_API_VERSION is pinned but never sent as a header");
    const code = stripSrc(fs.readFileSync(path.join(rootDir, "supabase/functions/billing-checkout/index.ts"), "utf8"));
    assert.ok(!/headers\.get\(\s*["']origin/i.test(code), "the return URL is taken from the request's Origin header");
  });

  await test("`stripe` is a tier_source the database accepts, and one applyEntitlement can write", () => {
    /* Derived on both sides. A source string the CHECK refuses would
       23514 on the first real payment — hours after the deploy, on a
       student who has been charged. */
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0017_billing.sql"), "utf8");
    assert.ok(ent.ENTITLEMENT_SOURCES.includes("stripe"), "stripe is not an entitlement source");
    for (const source of ent.ENTITLEMENT_SOURCES) {
      assert.ok(new RegExp(`tier_source in \\([^)]*'${source}'`).test(sql), `0017's CHECK does not allow tier_source = '${source}'`);
    }
    assert.ok(/store in \([^)]*'stripe'/.test(sql), "0017's CHECK does not allow store = 'stripe'");
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

await run();
