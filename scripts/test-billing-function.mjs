/* billing-webhook — the real handler, against a traced fake.
 *
 * THIS IS THE ONLY THING IN THE PROJECT THAT WRITES profiles.tier, so
 * the claims worth making about it are not "does it work" but "what can
 * a hostile caller make it do". The handler is bundled by esbuild with
 * the supabase-js import stubbed and Deno's globals replaced, exactly
 * as test-ai-notes-function.mjs does it, and driven with real Requests.
 *
 * THE FOUR PROPERTIES, in the order they matter:
 *
 * 1. AUTHENTICATION REFUSES BEFORE ANYTHING HAPPENS. A wrong header, a
 *    missing signature, a signature over different bytes, or a stale
 *    timestamp each produce a 401 with NO outbound fetch and NO write.
 *    Asserting the 401 alone would pass on a handler that refused after
 *    doing the work, so every one of those tests asserts the trace is
 *    empty as well.
 *
 * 2. THE PAYLOAD IS NOT EVIDENCE. A perfectly signed event claiming
 *    ai_max, for a subscriber RevenueCat says has nothing, writes
 *    `free`. That is the property the whole design rests on, and it is
 *    the one a reader is most likely to "simplify" away by reading the
 *    tier out of the event.
 *
 * 3. THE RE-READ PRECEDES THE WRITE. Not implied by (2) — a handler
 *    could write from the payload and then fetch — so the trace is
 *    ordered and the assertion is on the ORDER, the same way ai-text's
 *    allowance-read-before-provider-call is pinned.
 *
 * 4. A HUMAN'S DECISION SURVIVES. tier_source = 'manual' is never
 *    written over, because that is how the App Review account keeps a
 *    tier nobody bought.
 *
 * WHAT THIS CANNOT SEE, said here rather than implied by a pass: a real
 * RevenueCat delivery, a real signature from their signing secret, a
 * real subscriber record, and whether the function is deployed with JWT
 * verification off. The first three are Jared's dashboard test event
 * (BILLING-PLAN.md Phase 1); the fourth is a wiring test over
 * deploy-functions.yml in test-ai-notes.mjs.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-fn-"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

/* ---------- build the function with its imports stubbed ---------- */

const stubPath = path.join(tmpDir, "supabase-stub.js");
fs.writeFileSync(
  stubPath,
  `export function createClient(url, key) {
     if (!url) throw new Error("supabaseUrl is required.");
     if (!key) throw new Error("supabaseKey is required.");
     return globalThis.__FAKE_CLIENT__;
   }
   export class SupabaseClient {}\n`
);

const bundle = await build({
  entryPoints: [path.join(rootDir, "supabase/functions/billing-webhook/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  plugins: [{ name: "stub-supabase", setup: (b) => b.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath })) }],
});
const fnPath = path.join(tmpDir, "fn.mjs");
fs.writeFileSync(fnPath, bundle.outputFiles[0].text);

/* The pure module is imported directly as well — its table of cases is
   the cheapest place to pin the entitlement rules, and importing it
   from source means a change there cannot be hidden by a bundle. */
const ent = await import(path.join(rootDir, "supabase/functions/_shared/entitlement.ts").replace(/\.ts$/, ".ts"));

/* ---------- the world the handler runs in ---------- */

const HEADER_SECRET = "test-authorization-value";
const SIGNING_SECRET = "test-signing-secret";
const API_KEY = "sk_test_revenuecat";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  REVENUECAT_WEBHOOK_SECRET: HEADER_SECRET,
  REVENUECAT_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET,
  REVENUECAT_SECRET_KEY: API_KEY,
};

/** An active entitlement, a year out. */
const activeEnt = (product) => ({
  expires_date: new Date(Date.now() + 365 * 864e5).toISOString(),
  product_identifier: product,
  purchase_date: new Date(Date.now() - 864e5).toISOString(),
});

const subscriberWith = (entitlements, subscriptions = {}) => ({ entitlements, subscriptions });

/**
 * A fake database that records the ORDER of everything, so an ordering
 * claim is an assertion rather than a hope, and records every filter,
 * so a mis-scoped write is visible even where its effect would not be.
 */
function makeWorld({ profiles = {}, events = {}, subscribers = {}, fetchStatus = 200, fetchThrows = false } = {}) {
  const trace = [];
  const writes = [];
  const fetches = [];
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
      eq(col, val) {
        filters.push([col, val]);
        return chain;
      },
      maybeSingle() {
        trace.push(`db:${name}.select`);
        const byId = Object.fromEntries(filters);
        if (name === "profiles") {
          const row = profiles[byId.user_id];
          return Promise.resolve({ data: row ? { ...row } : null, error: null });
        }
        if (name === "billing_events") {
          const row = events[byId.id];
          return Promise.resolve({ data: row ? { ...row } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      /* An update resolves when awaited; PostgREST returns a promise
         from the terminal builder, which is what the handler awaits. */
      then(resolve, reject) {
        if (op !== "update") return resolve({ data: null, error: null });
        trace.push(`db:${name}.update`);
        writes.push({ table: name, op: "update", values, filters: [...filters] });
        const byId = Object.fromEntries(filters);
        const row = profiles[byId.user_id];
        if (row) Object.assign(row, values);
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };

  globalThis.__FAKE_CLIENT__ = { from: table };
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: () => {} };
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    trace.push("fetch:subscriber");
    if (fetchThrows) throw new Error("network down");
    const id = String(url).split("/").pop();
    if (fetchStatus !== 200) return { ok: false, status: fetchStatus, json: async () => ({}) };
    const sub = subscribers[id];
    if (!sub) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ subscriber: sub }) };
  };

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  const restore = () => {
    console.log = origLog;
    console.error = origErr;
  };

  return { trace, writes, fetches, logs, profiles, events, restore };
}

async function sign(secret, t, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Drive the handler.
 *
 * `raw` is the exact bytes sent; `signBody` is what the signature is
 * computed over. They are separate parameters ON PURPOSE — passing
 * different values is how "the signature does not cover these bytes"
 * is tested, and it is the case a handler that parses before verifying
 * would silently accept.
 */
async function deliver(world, event, opts = {}) {
  const raw = opts.raw ?? JSON.stringify({ api_version: "1.0", event });
  const signBody = opts.signBody ?? raw;
  const t = String(opts.t ?? Date.now());
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("authorization", opts.authorization ?? HEADER_SECRET);
  if (!opts.noSignature) {
    const v1 = opts.v1 ?? (await sign(opts.signingSecret ?? SIGNING_SECRET, t, signBody));
    headers.set("x-revenuecat-webhook-signature", opts.sigHeader ?? `t=${t},v1=${v1}`);
  }
  const mod = await import(`${fnPath}?v=${Math.random()}`);
  const res = await mod.handle(new Request("https://fn.test/billing-webhook", { method: "POST", headers, body: raw }));
  return { status: res.status, body: await res.json() };
}

const profile = (tier, source = "signup") => ({ tier, tier_source: source });
const EVENT = (over = {}) => ({ id: "evt-1", type: "INITIAL_PURCHASE", app_user_id: USER_A, store: "APP_STORE", ...over });

async function run() {
  /* ---------- 1. the pure rules ---------- */

  await test("the entitlement ids ARE the paid tier strings — one list, not two", () => {
    /* Phase 0 chose the tier strings as the entitlement ids precisely
       so this mapping is the identity function. If it ever stops
       being, a table appears and drifts; the guard is that no table
       is allowed to appear. Derived from credits.ts on the other
       side, not restated here. */
    const credits = fs.readFileSync(path.join(rootDir, "supabase/functions/_shared/credits.ts"), "utf8");
    const m = /export const TIERS = \[([^\]]+)\]/.exec(credits);
    assert.ok(m, "TIERS is gone from credits.ts");
    const tiers = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    assert.ok(tiers.length >= 3, `expected the tier list, found ${tiers.length}`);
    assert.deepEqual([...ent.TIER_RANK], tiers, "the webhook's ranking is not the same list as the server's tiers");
    assert.deepEqual([...ent.PAID_ENTITLEMENTS], tiers.slice(1), "the paid entitlement ids are not the paid tiers");
    assert.ok(!tiers.includes("plus"), "plus is still a tier — Phase 0 dropped it");
  });

  await test("the highest ACTIVE entitlement decides the tier, and nothing active means free", () => {
    const cases = [
      { name: "nothing", ents: {}, want: "free" },
      { name: "ai only", ents: { ai: activeEnt("uniplanner.studyai.monthly") }, want: "ai" },
      { name: "max only", ents: { ai_max: activeEnt("uniplanner.studyaimax.annual") }, want: "ai_max" },
      { name: "both — the higher wins", ents: { ai: activeEnt("x"), ai_max: activeEnt("y") }, want: "ai_max" },
      { name: "expired max, live ai", ents: { ai: activeEnt("x"), ai_max: { expires_date: "2020-01-01T00:00:00Z" } }, want: "ai" },
      { name: "all expired", ents: { ai: { expires_date: "2020-01-01T00:00:00Z" } }, want: "free" },
      { name: "an entitlement we do not sell is ignored", ents: { plus: activeEnt("x"), legacy: activeEnt("y") }, want: "free" },
      { name: "no expiry means non-expiring", ents: { ai: { product_identifier: "x" } }, want: "ai" },
      { name: "an unparseable expiry is NOT active", ents: { ai: { expires_date: "soon" } }, want: "free" },
    ];
    assert.ok(cases.length >= 8, "the table shrank");
    for (const c of cases) {
      assert.equal(ent.tierFromSubscriber(subscriberWith(c.ents)).tier, c.want, `case: ${c.name}`);
    }
  });

  await test("the store comes from the winning subscription, and an unknown store is null rather than a guess", () => {
    const withStore = (store) =>
      ent.tierFromSubscriber(
        subscriberWith({ ai: activeEnt("p1") }, { p1: { store } })
      ).store;
    assert.equal(withStore("app_store"), "app_store");
    assert.equal(withStore("mac_app_store"), "app_store", "a Mac purchase is managed in the same place");
    assert.equal(withStore("play_store"), "play_store");
    assert.equal(withStore("stripe"), "stripe");
    assert.equal(withStore("amazon"), null, "a store profiles.store cannot hold must be null, not the nearest match");
    assert.equal(withStore("promotional"), null);
    assert.equal(withStore(undefined), null);
    /* And the column would refuse anything else anyway — the CHECK in
       0017 names exactly these three. Derived, so a widened column
       and a widened map move together. */
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0017_billing.sql"), "utf8");
    for (const s of ["app_store", "play_store", "stripe"]) {
      assert.ok(sql.includes(`'${s}'`), `0017 does not allow the store value ${s} that this map produces`);
    }
  });

  await test("a TRANSFER names both accounts, and only UUID-shaped ids are ever acted on", () => {
    const ids = ent.affectedUserIds({
      type: "TRANSFER",
      app_user_id: null,
      transferred_from: [USER_A, "$RCAnonymousID:abc"],
      transferred_to: [USER_B],
    });
    assert.deepEqual(ids.sort(), [USER_A, USER_B].sort(), "a transfer must re-read both sides or one keeps a tier it gave away");
    assert.deepEqual(ent.affectedUserIds({ app_user_id: "$RCAnonymousID:abc" }), [], "an anonymous id is not one of our accounts");
    assert.deepEqual(ent.affectedUserIds({ app_user_id: "not-a-uuid" }), []);
    assert.deepEqual(ent.affectedUserIds({}), []);
    assert.deepEqual(ent.affectedUserIds({ app_user_id: USER_A, original_app_user_id: USER_A }), [USER_A], "the same id twice is one account");
  });

  /* ---------- 2. authentication refuses before anything happens ---------- */

  const authCases = [
    { name: "a wrong authorization header", opts: { authorization: "wrong" } },
    { name: "no authorization header at all", opts: { authorization: "" } },
    { name: "no signature header", opts: { noSignature: true } },
    { name: "an unparseable signature header", opts: { sigHeader: "garbage" } },
    { name: "a signature header with no v1", opts: { sigHeader: `t=${Date.now()}` } },
    { name: "a signature made with the wrong secret", opts: { signingSecret: "not-the-secret" } },
    { name: "a stale timestamp (replay)", opts: { t: Date.now() - 20 * 60 * 1000 } },
    { name: "a timestamp from the far future", opts: { t: Date.now() + 20 * 60 * 1000 } },
    { name: "a non-numeric timestamp", opts: { t: "yesterday" } },
  ];
  for (const c of authCases) {
    await test(`REFUSED, having done nothing: ${c.name}`, async () => {
      const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai_max: activeEnt("p") }) } });
      const res = await deliver(w, EVENT(), c.opts);
      w.restore();
      assert.equal(res.status, 401, "an unauthenticated delivery must be refused");
      assert.deepEqual(w.fetches, [], "it asked RevenueCat about a user before authenticating the caller");
      assert.deepEqual(w.writes, [], "it wrote something before authenticating the caller");
      assert.equal(w.profiles[USER_A].tier, "free", "the tier moved on an unauthenticated request");
    });
  }

  await test("REFUSED: a signature that does not cover the bytes that were sent", async () => {
    /* THE CASE A PARSE-THEN-VERIFY HANDLER ACCEPTS. The body is signed
       with the real secret — but over DIFFERENT bytes. A handler that
       re-serialised the parsed object before verifying would compare
       against its own rendering and could pass this. */
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai_max: activeEnt("p") }) } });
    const honest = JSON.stringify({ api_version: "1.0", event: EVENT() });
    const tampered = JSON.stringify({ api_version: "1.0", event: EVENT({ type: "RENEWAL" }) });
    const res = await deliver(w, null, { raw: tampered, signBody: honest });
    w.restore();
    assert.equal(res.status, 401);
    assert.deepEqual(w.writes, [], "a body whose signature covers other bytes was accepted");
  });

  await test("ACCEPTED: whitespace the handler would have normalised away is signed and verified as sent", async () => {
    /* The other direction, and it is why the body is never
       re-serialised: this payload is semantically identical to the
       compact one and byte-different. Verifying over a re-render
       would fail it, and every real delivery is somebody else's
       formatting. */
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p1") }, { p1: { store: "app_store" } }) } });
    const spaced = JSON.stringify({ api_version: "1.0", event: EVENT() }, null, 2);
    const res = await deliver(w, null, { raw: spaced });
    w.restore();
    assert.equal(res.status, 200, `a validly signed pretty-printed body was refused: ${JSON.stringify(res.body)}`);
    assert.equal(w.profiles[USER_A].tier, "ai");
  });

  /* ---------- 3. the payload is not evidence ---------- */

  await test("A FORGED CLAIM WRITES NOTHING: a signed event claiming ai_max, for a subscriber with no entitlements", async () => {
    const w = makeWorld({
      profiles: { [USER_A]: profile("free") },
      subscribers: { [USER_A]: subscriberWith({}) },
    });
    const res = await deliver(w, EVENT({ type: "INITIAL_PURCHASE", entitlement_ids: ["ai_max"], entitlement_id: "ai_max", tier: "ai_max" }));
    w.restore();
    assert.equal(res.status, 200);
    assert.equal(w.profiles[USER_A].tier, "free", "the handler believed the event instead of RevenueCat");
    const update = w.writes.find((x) => x.table === "profiles");
    assert.equal(update.values.tier, "free", "the tier written came from the payload");
  });

  await test("THE RE-READ PRECEDES THE WRITE — asserted on the ORDER, not inferred from the result", async () => {
    const w = makeWorld({
      profiles: { [USER_A]: profile("free") },
      subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p1") }, { p1: { store: "play_store" } }) },
    });
    await deliver(w, EVENT());
    w.restore();
    const fetchAt = w.trace.indexOf("fetch:subscriber");
    const writeAt = w.trace.indexOf("db:profiles.update");
    assert.ok(fetchAt >= 0, "no subscriber read happened at all");
    assert.ok(writeAt >= 0, "no tier write happened at all");
    assert.ok(fetchAt < writeAt, `the write happened before the re-read: ${w.trace.join(" -> ")}`);
    assert.equal(w.profiles[USER_A].tier, "ai");
    assert.equal(w.profiles[USER_A].store, "play_store");
    assert.equal(w.profiles[USER_A].tier_source, "revenuecat");
  });

  await test("every write is scoped to the user_id RevenueCat returned — the service-role client applies no policy", async () => {
    const w = makeWorld({
      profiles: { [USER_A]: profile("free"), [USER_B]: profile("free") },
      subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p1") }) },
    });
    await deliver(w, EVENT());
    w.restore();
    for (const write of w.writes.filter((x) => x.table === "profiles")) {
      assert.ok(
        write.filters.some(([col, val]) => col === "user_id" && val === USER_A),
        `an unscoped ${write.op} on profiles: ${JSON.stringify(write.filters)}`
      );
    }
    assert.equal(w.profiles[USER_B].tier, "free", "another account's tier moved");
  });

  await test("a failed subscriber read is UNKNOWN, not 'no entitlement' — 5xx so RevenueCat retries, and the tier is untouched", async () => {
    for (const world of [
      { fetchStatus: 500, label: "a 500 from RevenueCat" },
      { fetchThrows: true, label: "a dropped connection" },
    ]) {
      const w = makeWorld({ profiles: { [USER_A]: profile("ai") }, subscribers: {}, ...world });
      const res = await deliver(w, EVENT({ type: "RENEWAL" }));
      w.restore();
      assert.ok(res.status >= 500, `${world.label}: answered ${res.status}, so RevenueCat will not retry`);
      assert.equal(w.profiles[USER_A].tier, "ai", `${world.label}: a paying student lost their tier because a request failed`);
      assert.deepEqual(w.writes, [], `${world.label}: something was written on an unknown read`);
    }
  });

  await test("a 404 from RevenueCat IS definitive — no such subscriber means no entitlement", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("ai") }, subscribers: {} });
    const res = await deliver(w, EVENT({ type: "EXPIRATION" }));
    w.restore();
    assert.equal(res.status, 200);
    assert.equal(w.profiles[USER_A].tier, "free", "a definitive not-found must be acted on, unlike a failure");
  });

  /* ---------- 4. a human's decision survives ---------- */

  await test("a manual tier is NEVER overwritten — the reviewer account keeps a tier nobody bought", async () => {
    const w = makeWorld({
      profiles: { [USER_A]: profile("ai_max", "manual") },
      subscribers: { [USER_A]: subscriberWith({}) },
    });
    const res = await deliver(w, EVENT({ type: "EXPIRATION" }));
    w.restore();
    assert.equal(res.status, 200);
    assert.equal(w.profiles[USER_A].tier, "ai_max", "a webhook took away a hand-granted tier");
    assert.equal(w.writes.filter((x) => x.table === "profiles" && x.op === "update").length, 0, "it wrote to a manual row at all");
    assert.ok(w.logs.some((l) => l.includes("manual_override")), "a skipped manual row must be identifiable in the log");
  });

  await test("an account we have no row for is a no-op, not an insert", async () => {
    /* profiles rows are made by the signup trigger, so an absent one
       means a deleted account or an id that was never ours.
       Inserting would resurrect a deleted account from a webhook. */
    const w = makeWorld({ profiles: {}, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p") }) } });
    const res = await deliver(w, EVENT());
    w.restore();
    assert.equal(res.status, 200);
    assert.deepEqual(w.writes.filter((x) => x.table === "profiles"), [], "it wrote a profiles row for an account that does not exist");
    assert.ok(w.logs.some((l) => l.includes("no_such_user")), "the outcome must be identifiable in the log");
  });

  /* ---------- 5. idempotency and ordering ---------- */

  await test("a redelivery changes nothing and records nothing — one row, whatever arrives twice", async () => {
    const shared = { profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p") }) }, events: {} };
    const first = makeWorld(shared);
    await deliver(first, EVENT());
    first.restore();
    assert.equal(Object.keys(shared.events).length, 1, "the first delivery did not record the event");

    const second = makeWorld(shared);
    const res = await deliver(second, EVENT());
    second.restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "duplicate");
    assert.equal(Object.keys(shared.events).length, 1, "a redelivery wrote a second row");
    assert.deepEqual(second.fetches, [], "a redelivery cost a RevenueCat request");
    assert.deepEqual(second.writes, [], "a redelivery wrote something");
  });

  await test("APPLY BEFORE RECORD, so a crash between them retries into a fix rather than a lie", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p") }) } });
    await deliver(w, EVENT());
    w.restore();
    const applyAt = w.trace.indexOf("db:profiles.update");
    const recordAt = w.trace.indexOf("db:billing_events.insert");
    assert.ok(applyAt >= 0 && recordAt >= 0, `both writes must happen: ${w.trace.join(" -> ")}`);
    assert.ok(applyAt < recordAt, "the event was recorded as handled before the tier was applied");
  });

  await test("the recorded row says what changed, and never what was paid", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai_max: activeEnt("p") }) }, events: {} });
    await deliver(w, EVENT({ type: "PRODUCT_CHANGE" }));
    w.restore();
    const row = w.writes.find((x) => x.table === "billing_events").values;
    assert.equal(row.id, "evt-1");
    assert.equal(row.user_id, USER_A);
    assert.equal(row.event_type, "PRODUCT_CHANGE");
    assert.equal(row.tier_before, "free");
    assert.equal(row.tier_after, "ai_max");
    const allowed = new Set(["id", "user_id", "event_type", "store", "tier_before", "tier_after"]);
    for (const k of Object.keys(row)) assert.ok(allowed.has(k), `billing_events row carries an undeclared field: ${k}`);
    const blob = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["price", "receipt", "token", "currency", "revenue"]) {
      assert.ok(!blob.includes(forbidden), `a billing_events row carries "${forbidden}"`);
    }
  });

  await test("a TRANSFER re-reads and writes BOTH accounts", async () => {
    const w = makeWorld({
      profiles: { [USER_A]: profile("ai"), [USER_B]: profile("free") },
      subscribers: { [USER_A]: subscriberWith({}), [USER_B]: subscriberWith({ ai: activeEnt("p") }) },
      events: {},
    });
    const res = await deliver(w, EVENT({ id: "evt-transfer", type: "TRANSFER", app_user_id: null, transferred_from: [USER_A], transferred_to: [USER_B] }));
    w.restore();
    assert.equal(res.status, 200);
    assert.equal(w.fetches.length, 2, "a transfer must ask about both accounts");
    assert.equal(w.profiles[USER_A].tier, "free", "the account that gave the entitlement away kept it");
    assert.equal(w.profiles[USER_B].tier, "ai", "the account that received it did not get it");
  });

  await test("an event with no id is refused — it could be neither recorded nor deduplicated", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p") }) } });
    const res = await deliver(w, EVENT({ id: undefined }));
    w.restore();
    assert.equal(res.status, 400);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(w.fetches, [], "it asked RevenueCat about a user before checking the event was usable");
  });

  await test("an anonymous app_user_id is answered 200 and written nowhere", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: {} });
    const res = await deliver(w, EVENT({ app_user_id: "$RCAnonymousID:9f2", original_app_user_id: "$RCAnonymousID:9f2" }));
    w.restore();
    assert.equal(res.status, 200, "retrying will not turn an anonymous id into one of our accounts");
    assert.deepEqual(w.writes, []);
    assert.deepEqual(w.fetches, []);
    assert.ok(w.logs.some((l) => l.includes("no_account")), "a run of these means the client configures RevenueCat before sign-in");
  });

  /* ---------- 6. source-level invariants ---------- */

  const SRC = fs.readFileSync(path.join(rootDir, "supabase/functions/billing-webhook/index.ts"), "utf8");
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  await test("the handler never parses the body before verifying it", () => {
    /* req.json() would consume the stream and hand back an object with
       no bytes attached, so verification could only be done over a
       re-serialisation — which is a different string. The absence of
       req.json() is what makes verify-before-parse structural rather
       than a comment. */
    assert.ok(!/req\.json\s*\(/.test(CODE), "billing-webhook calls req.json(); the signature covers the raw bytes and cannot survive a re-serialise");
    /* SCOPED TO THE HANDLER BODY, and the first version was not — it
       searched the whole file and found signPayload's DEFINITION, which
       sits above `handle` and so came before everything. The claim is
       about the order of operations INSIDE the handler; a file-wide
       index answers a different question, which is the same mistake as
       measuring the document when the claim was about the screen. */
    const body = CODE.slice(CODE.indexOf("export async function handle"));
    assert.ok(body.length > 500, "the handler body was not found — this guard would pass over nothing");
    const textAt = body.indexOf("req.text()");
    const verifyAt = body.search(/await\s+signPayload\(/);
    const parseAt = body.indexOf("JSON.parse");
    assert.ok(textAt >= 0, "the body is not read as text");
    assert.ok(verifyAt >= 0, "the handler never computes a signature");
    assert.ok(parseAt >= 0, "the handler never parses the body");
    assert.ok(textAt < verifyAt, "the signature is computed before the body has been read");
    assert.ok(verifyAt < parseAt, "the body is parsed before its signature is verified");
  });

  await test("every profiles query in the entitlement path is scoped by user_id", () => {
    /* The source-level half of the behavioural test above, and it
       exists for the same reason ai-notes has one: once the first
       lookup is scoped, a non-owner never reaches the later queries,
       so their scopes cannot be caught by behaviour alone. */
    const mod = fs
      .readFileSync(path.join(rootDir, "supabase/functions/_shared/entitlement.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const froms = [...mod.matchAll(/\.from\(\s*["'](\w+)["']\s*\)([\s\S]{0,240})/g)];
    assert.ok(froms.length >= 2, `expected the profiles queries, found ${froms.length}`);
    for (const [, tableName, tail] of froms) {
      assert.equal(tableName, "profiles", `entitlement.ts touches a table it has no business in: ${tableName}`);
      assert.match(tail, /\.eq\(\s*["']user_id["']/, "a profiles query is not scoped to a user_id");
    }
  });

  await test("the tier written is never read out of the request body", () => {
    /* The behavioural test proves it for the fields an attacker would
       obviously try. This forbids the shape: nothing in the handler
       may read an entitlement or tier field off `event`. */
    for (const field of ["event.entitlement", "event.tier", "event.entitlements", "event.product", "event.expiration"]) {
      assert.ok(!CODE.includes(field), `the handler reads ${field} from the payload — the payload is a trigger, not evidence`);
    }
    assert.ok(/tierFromSubscriber\(\s*fetched\.subscriber/.test(CODE), "the tier is not computed from the fetched subscriber record");
  });

  await test("the refusal says which check failed in the LOG and nothing in the RESPONSE", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: {} });
    const wrongHeader = await deliver(w, EVENT(), { authorization: "wrong" });
    const badSig = await deliver(w, EVENT(), { signingSecret: "nope" });
    w.restore();
    assert.deepEqual(wrongHeader.body, badSig.body, "the two refusals are distinguishable from outside, so the endpoint answers 'is my header right?'");
    assert.ok(w.logs.some((l) => l.includes("authorization header did not match")), "the log cannot tell them apart either");
    assert.ok(w.logs.some((l) => l.includes("signature did not verify")), "the log cannot tell them apart either");
  });

  await test("no secret ever reaches a log line", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p") }) } });
    await deliver(w, EVENT());
    await deliver(w, EVENT({ id: "evt-2" }), { authorization: "wrong" });
    w.restore();
    assert.ok(w.logs.length > 0, "nothing was logged at all, so this proves nothing");
    for (const secret of [HEADER_SECRET, SIGNING_SECRET, API_KEY, ENV.SUPABASE_SERVICE_ROLE_KEY]) {
      assert.ok(!w.logs.join("\n").includes(secret), `a log line leaked ${secret.slice(0, 8)}…`);
    }
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
