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
 * AND THE WRITE PATH RUNS AGAINST A REAL POSTGRES (section 7), which is
 * the correction this file exists in the shape it does because of.
 *
 * Everything above ran against a hand-written fake, and the fake
 * modelled `billing_events`'s PRIMARY KEY — so "a redelivery writes one
 * row" was a real claim — and did NOT model its FOREIGN KEY to
 * auth.users. The first real delivery was a dashboard TEST event naming
 * an id we hold no account for. The handler put that id in `user_id`
 * anyway, Postgres refused with 23503, and the function answered 500 to
 * a provider that retries every non-2xx. Thirty-three green tests, and
 * the constraint that decided the outcome existed nowhere in them.
 *
 * The remedy is not a fake that knows about this one foreign key —
 * that is the restatement pattern with extra steps, and the next
 * constraint would be missing in exactly the same way. It is that the
 * claims about what the database ACCEPTS are made against the database:
 * scripts/lib/pg-harness.mjs applies the real migrations, and a small
 * PostgREST-shaped adapter turns the four calls the handler makes into
 * SQL. The schema's constraints are the test's constraints, and nobody
 * has to remember to copy one across.
 *
 * WHAT THE FAKE STILL EARNS ITS PLACE FOR: the ORDER of operations, the
 * absence of a fetch before authentication, the log lines, and the
 * failure injection (a 500 from RevenueCat, a dropped connection). None
 * of those is a claim about the database, and each is far cheaper to
 * assert against a recorder than a real one.
 *
 * WHAT NEITHER CAN SEE, said here rather than implied by a pass: a real
 * RevenueCat delivery, a real signature from their signing secret, a
 * real subscriber record, PostgREST itself (the adapter speaks SQL, not
 * HTTP, so a PostgREST-level refusal such as the upsert-needs-UPDATE
 * rule 0008 found is out of reach), and whether the function is
 * deployed with JWT verification off. The first three are Jared's
 * dashboard test event (BILLING-PLAN.md Phase 1); the last is a wiring
 * test over deploy-functions.yml in test-ai-notes.mjs.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createPgHarness } from "./lib/pg-harness.mjs";

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


/* ==================================================================
   A REAL DATABASE, for the claims that are about the database.

   `pgWorld` is the same recorder as `makeWorld` — same trace, same
   writes list, same fetch stub — with the one difference that matters:
   `from(...)` speaks SQL to a database with every migration applied,
   so a constraint the schema has is a constraint this test has.
   ================================================================== */

const migrationsDir = path.join(rootDir, "supabase", "migrations");
const pg = createPgHarness({ migrationsDir, label: "the billing write-path tests" });

/** A database with every migration applied, and no rows. */
function migratedDb() {
  const db = pg.freshDb();
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    pg.applyMigration(db, file);
  }
  return db;
}

const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const jsonLit = (obj) => `'${JSON.stringify(obj).replace(/'/g, "''")}'::jsonb`;

/**
 * PostgREST's builder shape, over psql.
 *
 * Deliberately tiny: it implements the four calls the handler makes and
 * nothing else, and an unimplemented call throws rather than resolving
 * to an empty answer — a fake that returns nothing makes everything
 * downstream of it agree, which is how the canvas stub in
 * test-blocks-neutral made half that suite decorative.
 *
 * The row values go through `jsonb_populate_record`, so the columns are
 * typed by the TABLE rather than by this file: a bad uuid raises 22P02
 * here exactly as it does in production (the 0009 boundary), and a
 * column that does not exist raises 42703 instead of being quietly
 * dropped the way an object-assign fake drops it.
 */
function pgClient(db, { trace, writes }) {
  const run = (sql) => {
    const r = pg.psqlCode(db, sql);
    if (r.ok) return { data: null, error: null, out: r.out };
    return { data: null, error: { code: r.code, message: r.message }, out: "" };
  };
  return {
    from(name) {
      const filters = [];
      let op = null;
      let cols = null;
      let values = null;
      const where = () => (filters.length ? filters.map(([c, v]) => `${c} = ${lit(v)}`).join(" and ") : "true");
      const chain = {
        select(c) {
          op = "select";
          cols = c;
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
          const keys = Object.keys(row);
          const r = run(
            `insert into public.${name} (${keys.join(", ")})
             select ${keys.map((k) => `r.${k}`).join(", ")}
               from jsonb_populate_record(null::public.${name}, ${jsonLit(row)}) r;`
          );
          return Promise.resolve({ data: null, error: r.error });
        },
        eq(col, val) {
          filters.push([col, val]);
          return chain;
        },
        maybeSingle() {
          trace.push(`db:${name}.select`);
          const r = run(
            `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text
               from (select ${cols} from public.${name} where ${where()} limit 2) t;`
          );
          if (r.error) return Promise.resolve({ data: null, error: r.error });
          const rows = JSON.parse(r.out || "[]");
          if (rows.length > 1) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "more than one row" } });
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve, reject) {
          if (op !== "update") throw new Error(`pgClient: awaited a ${op ?? "bare"} builder on ${name}, which this adapter does not implement`);
          trace.push(`db:${name}.update`);
          writes.push({ table: name, op: "update", values, filters: [...filters] });
          const keys = Object.keys(values);
          const r = run(
            `update public.${name} set (${keys.join(", ")}) =
               (select ${keys.map((k) => `r.${k}`).join(", ")}
                  from jsonb_populate_record(null::public.${name}, ${jsonLit(values)}) r)
             where ${where()};`
          );
          return Promise.resolve({ data: null, error: r.error }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

/** The same world as `makeWorld`, with a real database behind `from`. */
function pgWorld(db, { subscribers = {} } = {}) {
  const trace = [];
  const writes = [];
  const fetches = [];
  const logs = [];

  globalThis.__FAKE_CLIENT__ = pgClient(db, { trace, writes });
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: () => {} };
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    trace.push("fetch:subscriber");
    const id = String(url).split("/").pop();
    const sub = subscribers[id];
    if (!sub) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ subscriber: sub }) };
  };

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));

  return {
    trace,
    writes,
    fetches,
    logs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
    /** Every row of a table, as objects. Read from the database, not from a mirror. */
    rows: (table) => JSON.parse(pg.one(db, `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from public.${table} t;`) || "[]"),
  };
}

/** An account that really exists: the signup trigger gives it a profile. */
function seedAccount(db, id, { tier = "free", source = null } = {}) {
  pg.psqlOrThrow(db, `insert into auth.users (id) values (${lit(id)});`);
  if (tier !== "free" || source) {
    pg.psqlOrThrow(
      db,
      `update public.profiles set tier = ${lit(tier)}${source ? `, tier_source = ${lit(source)}` : ""} where user_id = ${lit(id)};`
    );
  }
}

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

  await test("an unknown account is ACKNOWLEDGED, not retried at us forever", async () => {
    /* RevenueCat retries every non-2xx. The first real delivery was a
       dashboard TEST event naming an id we hold no profile for; the
       handler answered 500, and the same event would have come back
       until its retry window expired. Nothing about it is different on
       the fourth attempt. */
    const w = makeWorld({ profiles: {}, subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p") }) } });
    const res = await deliver(w, EVENT());
    w.restore();
    assert.equal(res.status, 200, "a permanently unknown user answered non-2xx is redelivered until the window expires");
    assert.equal(res.body.outcome, "no_such_user", "the response says 'applied' for an event that applied to nobody");
    assert.equal(res.body.matched, 0);
  });

  await test("the log never reports a tier that was not written", async () => {
    /* `"after":"free"` on no_such_user was a tier reported for a row
       nobody has. applyEntitlement already leaves `after` undefined
       exactly when nothing was written; the handler was substituting
       the computed tier for it. The computation is still worth seeing,
       under a name that says what it is. */
    const w = makeWorld({ profiles: {}, subscribers: { [USER_A]: subscriberWith({ ai_max: activeEnt("p") }) } });
    await deliver(w, EVENT());
    w.restore();
    const apply = w.logs.find((l) => l.includes('"stage":"apply"'));
    assert.ok(apply, "no apply line was logged at all, so this proves nothing");
    assert.match(apply, /"outcome":"no_such_user"/);
    assert.match(apply, /"after":null/, `the apply line still reports a tier for an account that does not exist: ${apply}`);
    assert.match(apply, /"computed":"ai_max"/, "the tier RevenueCat implies is worth seeing — under a name that is not 'after'");
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
    assert.equal(row.app_user_id, USER_A, "the id the store sent is kept beside the account we matched");
    const allowed = new Set(["id", "user_id", "app_user_id", "event_type", "store", "tier_before", "tier_after"]);
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

  await test("an anonymous app_user_id touches no account, and is still recorded", async () => {
    const w = makeWorld({ profiles: { [USER_A]: profile("free") }, subscribers: {} });
    const res = await deliver(w, EVENT({ app_user_id: "$RCAnonymousID:9f2", original_app_user_id: "$RCAnonymousID:9f2" }));
    w.restore();
    assert.equal(res.status, 200, "retrying will not turn an anonymous id into one of our accounts");
    assert.deepEqual(w.writes.filter((x) => x.table === "profiles"), []);
    assert.deepEqual(w.fetches, [], "an id that is not ours is not worth a RevenueCat request");
    assert.ok(w.logs.some((l) => l.includes("no_account")), "a run of these means the client configures RevenueCat before sign-in");
    /* RECORDED, because a run of these is the thing to notice, and one
       row per accepted event is the rule that stopped the three paths
       ending in three different places — the one that recorded being
       the one that wrote the wrong column. */
    const row = w.writes.find((x) => x.table === "billing_events").values;
    assert.equal(row.user_id, null, "an id that is not one of our accounts reached user_id");
    assert.equal(row.app_user_id, "$RCAnonymousID:9f2", "the id the store sent was not kept");
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

  /* ---------- 7. the write path, against the real schema ----------
     Everything above this line runs against a recorder. Everything
     below runs against a database with every migration applied,
     because the claims below are about what the database ACCEPTS —
     and that is the exact question the fake answered wrongly. */

  if (!pg.available) {
    /* Not silent, and not free: REQUIRE_POSTGRES (which CI sets) turns
       this into a hard failure rather than a skip, the same
       arrangement test-migrations.mjs has. A write-path suite that
       quietly stops running is how the fake came to be the only thing
       checking these. */
    pg.skipOrFail(false);
    console.log("  --  section 7 (the write path against the real schema) did not run");
  } else {
    pg.start();

    await test("THE FOREIGN KEY REALLY BITES HERE — without this, section 7 proves nothing", async () => {
      /* NON-VACUITY FIRST. Every test below is of the form "the handler
         does not fall foul of a constraint", and all of them pass
         against a schema with no constraints at all. So the constraint
         is demonstrated biting before anything is claimed about the
         handler avoiding it — and it is demonstrated through the SAME
         adapter the handler uses, not by a bare psql, because a fault
         in the adapter would otherwise look like a schema that permits
         everything. */
      const db = migratedDb();
      const w = pgWorld(db);
      w.restore();
      const stray = "33333333-3333-4333-8333-333333333333";
      const res = await globalThis.__FAKE_CLIENT__
        .from("billing_events")
        .insert({ id: "evt-fk-probe", user_id: stray, event_type: "TEST" });
      assert.ok(res.error, "billing_events accepted a user_id that is not an account — the FK this suite exists for is absent");
      assert.equal(res.error.code, "23503", `expected a foreign key violation, got ${res.error.code}: ${res.error.message}`);
      assert.equal(w.rows("billing_events").length, 0, "the refused row landed anyway");
    });

    await test("THE PRODUCTION FAILURE: an event for an account we do not have is recorded, and answered 200", async () => {
      /* The delivery that broke it: correct header, correct signature,
         a UUID-shaped app_user_id with no profiles row. Before the fix
         this was a 23503 and a 500, and RevenueCat would have
         redelivered it until the retry window expired. */
      const db = migratedDb();
      const w = pgWorld(db, { subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p1") }) } });
      const res = await deliver(w, EVENT({ id: "5AC2B472-66A2-4969-8630-033F5A6B2ED0", type: "TEST" }));
      w.restore();

      assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.outcome, "no_such_user");
      const rows = w.rows("billing_events");
      assert.equal(rows.length, 1, "the event was not recorded, so nobody can see that it arrived");
      assert.equal(rows[0].user_id, null, "an id that is not one of our accounts reached a column that means 'one of our accounts'");
      assert.equal(rows[0].app_user_id, USER_A, "the id the store sent was thrown away, which is the whole forensic value");
      assert.equal(rows[0].tier_before, null, "a tier was recorded for a row nobody has");
      assert.equal(rows[0].tier_after, null, "a tier was recorded as written when nothing was written");
      assert.equal(w.rows("profiles").length, 0, "a webhook resurrected an account that does not exist");
    });

    await test("...and its redelivery is still ONE row", async () => {
      /* Idempotency has never depended on user_id — the primary key is
         the event id — but "never depended on" is a reading of the
         schema, and this is the run of it. */
      const db = migratedDb();
      const subscribers = { [USER_A]: subscriberWith({ ai: activeEnt("p1") }) };
      const first = pgWorld(db, { subscribers });
      await deliver(first, EVENT({ id: "evt-unknown-twice" }));
      first.restore();

      const second = pgWorld(db, { subscribers });
      const res = await deliver(second, EVENT({ id: "evt-unknown-twice" }));
      second.restore();
      assert.equal(res.status, 200);
      assert.equal(res.body.outcome, "duplicate");
      assert.equal(second.rows("billing_events").length, 1, "a redelivered unknown event wrote a second row");
      assert.deepEqual(second.fetches, [], "a redelivery cost a RevenueCat request");
    });

    await test("AN EVENT FOR A REAL USER: the existing path, unchanged", async () => {
      /* The other direction of the mutation check. A fix for the
         unknown case that quietly stopped writing user_id for a known
         one would pass every test above. */
      const db = migratedDb();
      seedAccount(db, USER_A);
      const w = pgWorld(db, {
        subscribers: { [USER_A]: subscriberWith({ ai_max: activeEnt("p1") }, { p1: { store: "play_store" } }) },
      });
      const res = await deliver(w, EVENT({ id: "evt-real", type: "INITIAL_PURCHASE" }));
      w.restore();

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.outcome, "applied");
      assert.equal(res.body.matched, 1);

      const profiles = w.rows("profiles");
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].tier, "ai_max", "the tier did not move for an account we do hold");
      assert.equal(profiles[0].tier_source, "revenuecat");
      assert.equal(profiles[0].store, "play_store");
      assert.ok(profiles[0].tier_updated_at, "the write happened but left no timestamp");

      const rows = w.rows("billing_events");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].user_id, USER_A, "a real account's event was recorded against nobody");
      assert.equal(rows[0].app_user_id, USER_A);
      assert.equal(rows[0].tier_before, "free");
      assert.equal(rows[0].tier_after, "ai_max");
      assert.equal(rows[0].store, "app_store", "the event's own store is recorded lowercased");

      const order = w.trace.filter((t) => t === "fetch:subscriber" || t === "db:profiles.update" || t === "db:billing_events.insert");
      assert.deepEqual(order, ["fetch:subscriber", "db:profiles.update", "db:billing_events.insert"], `re-read, apply, record — in that order: ${w.trace.join(" -> ")}`);
    });

    await test("a store profiles.store cannot hold is written as null, not as the nearest match", async () => {
      /* profiles_store_check is a constraint the fake never modelled
         either, and normaliseStore is the only thing between it and a
         23514 on a legitimate purchase. Amazon is a store RevenueCat
         really reports and profiles.store really refuses. */
      const db = migratedDb();
      seedAccount(db, USER_A);

      const direct = pg.psqlCode(db, `update public.profiles set store = 'amazon' where user_id = ${lit(USER_A)};`);
      assert.equal(direct.code, "23514", "profiles_store_check is not enforcing, so this test could not fail");

      const w = pgWorld(db, {
        subscribers: { [USER_A]: subscriberWith({ ai: activeEnt("p1") }, { p1: { store: "amazon" } }) },
      });
      const res = await deliver(w, EVENT({ id: "evt-amazon" }));
      w.restore();
      assert.equal(res.status, 200, `a purchase from a store we do not model failed the write: ${JSON.stringify(res.body)}`);
      assert.equal(w.rows("profiles")[0].tier, "ai", "the entitlement was lost because of where it was bought");
      assert.equal(w.rows("profiles")[0].store, null);
    });

    await test("a manual tier survives a real EXPIRATION, and the event still says so", async () => {
      const db = migratedDb();
      seedAccount(db, USER_A, { tier: "ai_max", source: "manual" });
      const w = pgWorld(db, { subscribers: { [USER_A]: subscriberWith({}) } });
      const res = await deliver(w, EVENT({ id: "evt-manual", type: "EXPIRATION" }));
      w.restore();
      assert.equal(res.status, 200);
      assert.equal(w.rows("profiles")[0].tier, "ai_max", "a webhook took away a hand-granted tier");
      assert.equal(w.rows("profiles")[0].tier_source, "manual");
      const row = w.rows("billing_events")[0];
      assert.equal(row.user_id, USER_A, "the event is about an account we hold, whatever we declined to write");
      assert.equal(row.tier_before, "ai_max");
      assert.equal(row.tier_after, "ai_max", "an untouched row must record what it still holds, not what RevenueCat implied");
    });

    await test("an anonymous id is recorded against no account, against the real FK", async () => {
      const db = migratedDb();
      const w = pgWorld(db);
      const res = await deliver(w, EVENT({ id: "evt-anon", app_user_id: "$RCAnonymousID:9f2" }));
      w.restore();
      assert.equal(res.status, 200);
      assert.equal(res.body.outcome, "no_account");
      const rows = w.rows("billing_events");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].user_id, null);
      assert.equal(rows[0].app_user_id, "$RCAnonymousID:9f2", "a non-UUID id must survive into a column that has no constraint on it");
      assert.deepEqual(w.fetches, []);
    });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

await run();
