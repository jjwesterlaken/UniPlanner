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
import { fileURLToPath } from "node:url";
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

const stripe = await import(path.join(rootDir, "supabase/functions/_shared/stripe.ts"));
const ent = await import(path.join(rootDir, "supabase/functions/_shared/entitlement.ts"));
const plans = await import(path.join(rootDir, "src/purchasePlans.js"));
const flags = await import(path.join(rootDir, "src/billingFlags.js"));
const prices = await import(path.join(rootDir, "src/webPrices.js"));
const copy = await import(path.join(rootDir, "src/plansCopy.js"));
const links = await import(path.join(rootDir, "src/legalLinks.js"));

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
        if (value && value.__status) return { ok: false, status: value.__status, json: async () => ({}) };
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
  const mod = await import(`${WEBHOOK}?v=${Math.random()}`);
  const res = await mod.handle(new Request("https://fn.test/stripe-webhook", { method: "POST", headers, body: raw }));
  return { status: res.status, body: await res.json() };
}

async function post(bundle, { token, body = {} } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const mod = await import(`${bundle}?v=${Math.random()}`);
  const res = await mod.handle(new Request("https://fn.test/x", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

const subscription = (over = {}) => ({
  id: "sub_1",
  object: "subscription",
  status: "active",
  customer: "cus_1",
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
  metadata: { uid: USER },
  items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" } }] },
  ...over,
});

const event = (over = {}) => ({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: subscription(over.subscription || {}) },
  ...over,
});

const profile = (over = {}) => ({ user_id: USER, tier: "free", tier_source: "signup", store: null, stripe_customer_id: null, ...over });

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
    const got = stripe.tierFromStripeSubscription(subscription({ current_period_end: seconds }));
    assert.equal(got.expiresAt, new Date(seconds * 1000).toISOString());
    assert.ok(new Date(got.expiresAt).getUTCFullYear() > 2020, "the expiry landed in 1970 — it was read as milliseconds");
    assert.equal(stripe.tierFromStripeSubscription(subscription({ current_period_end: null })).expiresAt, null);
  });

  await test("THE PERIOD END IS READ FROM THE ITEM AS WELL AS THE SUBSCRIPTION — the live NULL", () => {
    /* THE BUG, from a real delivery: an entitlement row landed with
       `expires_at` NULL while `current_period_end: 1791547235` was
       plainly in the payload. The read was `subscription.current_period_end`
       and nothing else, so an API version that carries the field on the
       ITEMS produces a null with no error anywhere.

       AND THE FIXTURE IS WHY THE SUITE COULD NOT HAVE CAUGHT IT. The
       default `subscription()` above puts the field at the TOP LEVEL —
       the 2024-06-20 shape — so every test here agreed with a
       production that had moved on. Stand-in weaker than production,
       fifth instance, and this time the stand-in was a fixture rather
       than a database. Hence the explicit shapes below rather than a
       tweak to the default: naming both is what stops the next version
       move being invisible again. */
    const ITEM_ONLY = {
      items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" }, current_period_end: 1791547235 }] },
      current_period_end: undefined,
    };

    const onItem = stripe.tierFromStripeSubscription(subscription(ITEM_ONLY));
    assert.equal(onItem.expiresAt, "2026-10-09T12:00:35.000Z", "the reported payload still maps to null");
    assert.equal(onItem.periodSource, "item");
    assert.equal(onItem.tier, "ai", "the tier must be unaffected by where the period lives");

    /* The OLD shape still works — this is a widening, not a move. */
    const onSub = stripe.tierFromStripeSubscription(subscription({ current_period_end: 1791547235 }));
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
    assert.deepEqual(w.writes, [], "something was written for a subscription we could not price");
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
    assert.deepEqual(somebody.writes, [], "something was written for a subscription we could not price");
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
    const noPeriod = subscription({
      current_period_end: undefined,
      items: { data: [{ price: { lookup_key: "uniplanner_studyai_monthly" } }] },
    });
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
      assert.deepEqual(w.writes, [], "something was written on an unknown read");
    }
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

  await test("the client flag is OFF, and the client refuses before the network when it is", async () => {
    assert.equal(flags.STRIPE_ENABLED, false, "web purchases are switched on — that is a decision, not a default");
    const client = await import(path.join(rootDir, "src/stripeClient.js"));
    let reached = false;
    for (const call of [client.startCheckout, client.openPortal]) {
      await assert.rejects(
        () => call({ token: "t", tier: "ai", duration: "monthly", fetchImpl: async () => { reached = true; return {}; } }),
        (err) => err.code === "stripe_disabled"
      );
    }
    assert.equal(reached, false, "a disabled client still made a request");
    /* And the gate is not ONLY the flag: signed out refuses too. */
    await assert.rejects(
      () => client.startCheckout({ token: "", tier: "ai", duration: "monthly", enabled: true, fetchImpl: async () => ({}) }),
      (err) => err.code === "unauthenticated"
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
    assert.equal(stripe.SITE_URL, links.SITE_URL, "the checkout return URL and the app's own origin have drifted");
    assert.match(stripe.CHECKOUT_SUCCESS_URL, new RegExp(`^${links.SITE_URL}/`));
    assert.match(stripe.CHECKOUT_CANCEL_URL, new RegExp(`^${links.SITE_URL}/`));
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
