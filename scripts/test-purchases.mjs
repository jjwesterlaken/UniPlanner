/* Subscriptions, client side.
 *
 * THE ONE CLAIM THIS FILE EXISTS FOR: **the store SDK is never spoken
 * to off a native shell.** Everything else here is ordinary coverage;
 * that one is a promise in a published privacy policy and a rejection
 * waiting to happen on a screen a student is looking at.
 *
 * It is asserted with a TRACED fake rather than by reading the source,
 * because "every function starts with a capability check" is a claim
 * about behaviour and a grep for it would pass on a function that
 * checked and then called anyway. Every exported action is driven on a
 * web-shaped environment and the trace must be empty.
 *
 * TWO HALVES, and the split is forced rather than chosen. The
 * RevenueCat package ships extensionless relative imports (`./web`),
 * which esbuild resolves and Node's ESM loader refuses — so
 * src/purchases.js CANNOT be imported by a plain-Node test at all.
 * Everything decidable without a handset therefore lives in
 * src/purchasePlans.js and is imported directly here; the thin SDK
 * layer is exercised through an esbuild bundle, which is the artifact
 * rule getting what it wants for free.
 *
 * WHAT THIS CANNOT SEE, said here rather than implied by a pass: a real
 * offering, a real price, a real purchase, the customer-info listener
 * firing, and whether Apple's reviewer accepts the panel. Those need
 * Grace's iPhone in the sandbox and the moto g05 on an internal-testing
 * track — MOBILE-BUILD.md §14 is the list.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "purchases-"));

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

/* ---------- the pure halves, imported directly ---------- */

const plans = await import(pathToFileURL(path.join(rootDir, "src/purchasePlans.js")).href);
const copy = await import(pathToFileURL(path.join(rootDir, "src/plansCopy.js")).href);
const refresh = await import(pathToFileURL(path.join(rootDir, "src/entitlementRefresh.js")).href);
const limits = await import(pathToFileURL(path.join(rootDir, "src/aiTextLimits.js")).href);
const keys = await import(pathToFileURL(path.join(rootDir, "src/purchaseKeys.js")).href);
const links = await import(pathToFileURL(path.join(rootDir, "src/legalLinks.js")).href);

/* ---------- the SDK layer, through a bundle with the plugin faked ---------- */

/** Records every call the module makes, so "it never touched the plugin" is a trace and not a hope. */
function tracedPlugin(behaviour = {}) {
  const trace = [];
  const wrap = (name, impl) => async (...args) => {
    trace.push({ name, args });
    if (behaviour[name]) return behaviour[name](...args);
    return impl ? impl(...args) : undefined;
  };
  return {
    trace,
    plugin: {
      configure: wrap("configure"),
      logOut: wrap("logOut"),
      getOfferings: wrap("getOfferings", () => ({ current: { identifier: "default", availablePackages: [] } })),
      purchasePackage: wrap("purchasePackage", () => ({ customerInfo: {} })),
      restorePurchases: wrap("restorePurchases", () => ({ customerInfo: {} })),
      /* THE FAKE HAS TO CARRY EVERY METHOD THE MODULE MAY CALL, or an
         absent one throws a TypeError that the module's own catch
         swallows — and the test then measures a degraded path while
         looking like it measured the real one. That is the
         stand-in-weaker-than-production entry, in a plugin stub: the
         first version of the eligibility test below reported "it never
         asked the plugin" when the module had asked and the fake had
         no answer. Default UNKNOWN so a case that does not care gets
         the conservative one. */
      checkTrialOrIntroductoryPriceEligibility: wrap("checkTrialOrIntroductoryPriceEligibility", () => ({})),
    },
  };
}

const stubDir = path.join(tmpDir, "stubs");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, "capacitor.js"),
  `export const Capacitor = {
     isNativePlatform: () => !!(globalThis.__FAKE_NATIVE__),
     getPlatform: () => globalThis.__FAKE_PLATFORM__ || "web",
   };\n`
);
fs.writeFileSync(
  path.join(stubDir, "purchases.js"),
  `export const Purchases = new Proxy({}, {
     get(_t, name) {
       return async (...args) => {
         (globalThis.__DEFAULT_PLUGIN_CALLS__ ||= []).push(String(name));
         throw new Error("the default plugin export was called — a test meant to inject one did not");
       };
     },
   });\n`
);

const bundle = await build({
  entryPoints: [path.join(rootDir, "src/purchases.js")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  plugins: [
    {
      name: "stub-native",
      setup(b) {
        b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: path.join(stubDir, "capacitor.js") }));
        b.onResolve({ filter: /^@revenuecat\/purchases-capacitor$/ }, () => ({ path: path.join(stubDir, "purchases.js") }));
      },
    },
  ],
});
const sdkPath = path.join(tmpDir, "purchases.mjs");
fs.writeFileSync(sdkPath, bundle.outputFiles[0].text);
const sdk = await import(pathToFileURL(sdkPath).href);

const SESSION = { user: { id: "11111111-1111-4111-8111-111111111111" } };
const NATIVE_IOS = { isNative: true, platform: "ios", iosKey: "appl_test", androidKey: "" };

async function run() {
  /* ---------- 1. can this build sell anything ---------- */

  await test("the capability matrix: web sells nothing, a missing key is its OWN answer", () => {
    const cases = [
      { name: "web", env: { isNative: false, platform: "web", iosKey: "appl_x", androidKey: "goog_x" }, want: { available: false, reason: "web" } },
      { name: "electron reports web too", env: { isNative: false, platform: "electron", iosKey: "appl_x" }, want: { available: false, reason: "web" } },
      { name: "ios with a key", env: NATIVE_IOS, want: { available: true, reason: null, store: "app_store" } },
      { name: "android with a key", env: { isNative: true, platform: "android", androidKey: "goog_x" }, want: { available: true, reason: null, store: "play_store" } },
      { name: "ios with NO key", env: { isNative: true, platform: "ios", iosKey: "" }, want: { available: false, reason: "no-key", store: "app_store" } },
      { name: "android with NO key", env: { isNative: true, platform: "android", androidKey: "" }, want: { available: false, reason: "no-key", store: "play_store" } },
      { name: "a native platform we do not know", env: { isNative: true, platform: "tizen", iosKey: "appl_x" }, want: { available: false, reason: "unknown-platform" } },
      { name: "the ios key never unlocks android", env: { isNative: true, platform: "android", iosKey: "appl_x", androidKey: "" }, want: { available: false, reason: "no-key" } },
    ];
    assert.ok(cases.length >= 8, "the matrix shrank");
    for (const c of cases) {
      const got = plans.capabilityFrom(c.env);
      assert.equal(got.available, c.want.available, `${c.name}: available`);
      assert.equal(got.reason, c.want.reason, `${c.name}: reason`);
      if (c.want.store) assert.equal(got.store, c.want.store, `${c.name}: store`);
      if (!got.available) assert.equal(got.apiKey, "", `${c.name}: a refused capability must carry no key`);
    }
  });

  await test("the store a purchase produces is one profiles.store accepts", () => {
    /* Derived from the migration rather than restated: 0017's CHECK is
       what a wrong value here would be rejected by, hours later, on a
       student's real purchase. */
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0017_billing.sql"), "utf8");
    const values = Object.values(plans.STORE_FOR_PLATFORM);
    assert.ok(values.length >= 2, "the platform-to-store map is empty");
    for (const store of values) {
      assert.ok(sql.includes(`'${store}'`), `0017 does not allow the store value ${store} that a purchase would write`);
    }
    for (const store of Object.keys(plans.STORE_MANAGEMENT_URL)) {
      assert.ok(values.includes(store), `${store} has a management URL and is not a store any platform produces`);
    }
  });

  /* ---------- 2. the six packages ---------- */

  await test("the six package ids are exactly the tier/duration pairs BILLING-PLAN names", () => {
    /* THE DASHBOARD IS THE SOURCE and it is not in this repository, so
       this is a restatement by construction — which the ledger says
       must at least be checked against the ONE written record there is.
       A tier or a duration renamed in the plan and not here goes red. */
    const doc = fs.readFileSync(path.join(rootDir, "BILLING-PLAN.md"), "utf8");
    const fromDoc = new Set();
    for (const m of doc.matchAll(/uniplanner\.(studyai|studyaimax)\.(monthly|sixmonth|annual)/g)) fromDoc.add(`${m[1]}_${m[2]}`);
    assert.ok(fromDoc.size >= 6, `expected six product ids in BILLING-PLAN.md, found ${fromDoc.size}`);
    assert.deepEqual([...Object.keys(plans.PACKAGE_PLANS)].sort(), [...fromDoc].sort());

    /* And each one maps to a tier the server actually sells. */
    for (const [id, plan] of Object.entries(plans.PACKAGE_PLANS)) {
      assert.ok(limits.TIERS.includes(plan.tier), `${id} maps to ${plan.tier}, which is not a tier`);
      assert.ok(plans.DURATION_ORDER.includes(plan.duration), `${id} maps to an unknown duration`);
      assert.ok(limits.allowanceForTier(plan.tier).perMonth, `${id} sells ${plan.tier}, whose allowance is not per month — a trial tier cannot be bought`);
    }
    assert.deepEqual(plans.SELLABLE_TIERS, limits.TIERS.filter((t) => !limits.isTrialTier(t)), "the sellable tiers are not the paid tiers");
  });

  await test("an UNRECOGNISED package is surfaced, never silently dropped", () => {
    /* Hiding a plan a student is entitled to buy, because a dashboard
       id was mistyped, is the worse of the two failures — the panel
       renders it plainly instead. */
    const pkg = (identifier) => ({ identifier, product: { priceString: "$1.00" } });
    const grouped = plans.groupPackages([pkg("studyai_annual"), pkg("studyai_monthly"), pkg("mystery_plan"), pkg("studyaimax_monthly")]);
    assert.deepEqual(grouped.tiers.map((g) => g.tier), ["ai", "ai_max"]);
    assert.deepEqual(grouped.tiers[0].packages.map((p) => p.duration), ["monthly", "annual"], "durations are not shortest-first");
    assert.deepEqual(grouped.unrecognised.map((p) => p.identifier), ["mystery_plan"]);
    assert.deepEqual(plans.groupPackages([]).tiers, [], "an empty offering must produce no tier groups");
    assert.deepEqual(plans.groupPackages().unrecognised, [], "no packages at all must not throw");
  });

  await test("manage-subscription prefers the account's own URL and never leaves the app anywhere unexpected", () => {
    assert.equal(
      plans.manageSubscriptionUrl({ customerInfo: { managementURL: "https://apps.apple.com/account/subscriptions?x=1" }, store: "app_store" }),
      "https://apps.apple.com/account/subscriptions?x=1"
    );
    assert.equal(plans.manageSubscriptionUrl({ customerInfo: null, store: "app_store" }), plans.STORE_MANAGEMENT_URL.app_store);
    assert.equal(plans.manageSubscriptionUrl({ customerInfo: { managementURL: null }, store: "play_store" }), plans.STORE_MANAGEMENT_URL.play_store);
    /* A non-https value is IGNORED rather than rendered. This link is
       the one thing on the panel that leaves the app. */
    for (const bad of ["javascript:alert(1)", "http://example.test", 42, {}]) {
      assert.equal(plans.manageSubscriptionUrl({ customerInfo: { managementURL: bad }, store: "app_store" }), plans.STORE_MANAGEMENT_URL.app_store, `a managementURL of ${JSON.stringify(bad)} was used`);
    }
    assert.equal(plans.manageSubscriptionUrl({ customerInfo: null, store: null }), null, "with no store there is nowhere to send anybody");
  });

  /* ---------- 3. THE CLAIM: nothing reaches the plugin off a native shell ---------- */

  await test("NO ACTION TOUCHES THE PLUGIN ON WEB — every one of them, traced", async () => {
    const web = plans.capabilityFrom({ isNative: false, platform: "web", iosKey: "appl_x", androidKey: "goog_x" });
    const calls = [
      ["configurePurchases", (o) => sdk.configurePurchases({ session: SESSION, ...o }), "configure"],
      ["logOutPurchases", (o) => sdk.logOutPurchases(o), "logOut"],
      ["loadPackages", (o) => sdk.loadPackages({ session: SESSION, ...o }), "getOfferings"],
      ["purchasePackage", (o) => sdk.purchasePackage({ identifier: "studyai_monthly" }, { session: SESSION, ...o }), "purchasePackage"],
      ["restorePurchases", (o) => sdk.restorePurchases({ session: SESSION, ...o }), "restorePurchases"],
    ];
    /* NON-VACUITY FIRST: the same five calls on a NATIVE capability must
       reach the plugin. Without this, a module that had been gutted
       would pass every assertion below.

       BY METHOD RATHER THAN BY COUNT, since the configure gate landed.
       Counting assumed one plugin call per action, and that stopped
       being true in both directions: an action that arrives before
       configure now makes TWO calls, and one that arrives after an
       action that already configured makes one. The claim was never
       about the arithmetic — it is that every action really reaches the
       plugin — so it is asserted as that, per action, and a fresh
       session id per case keeps the gate from remembering the last one. */
    for (const [name, call, method] of calls) {
      const native = tracedPlugin();
      const fresh = { user: { id: `${name}-${SESSION.user.id}` } };
      await call({ plugin: native.plugin, capability: plans.capabilityFrom(NATIVE_IOS), session: fresh });
      assert.ok(
        native.trace.some((c) => c.name === method),
        `${name} did not reach the plugin on a NATIVE capability — this test cannot discriminate. Trace: ${native.trace.map((c) => c.name).join(", ") || "(empty)"}`
      );
    }

    globalThis.__DEFAULT_PLUGIN_CALLS__ = [];
    for (const [name, call] of calls) {
      const traced = tracedPlugin();
      const result = await call({ plugin: traced.plugin, capability: web, session: SESSION });
      assert.deepEqual(traced.trace, [], `${name} called the store SDK on web: ${traced.trace.map((c) => c.name).join(", ")}`);
      assert.equal(result.ok, false, `${name} reported success on web`);
      assert.equal(result.reason, "web", `${name} refused for the wrong reason: ${result.reason}`);
    }
    assert.deepEqual(globalThis.__DEFAULT_PLUGIN_CALLS__, [], "something reached the real plugin export rather than the injected one");
  });

  await test("ELIGIBILITY NEVER TOUCHES THE PLUGIN ON WEB, and answers UNKNOWN when it cannot ask", async () => {
    /* RULE 1 for the sixth action. It is not in the table above because
       it does not return `{ok, reason}` — it returns a MAP, since the
       caller needs an answer per product and every failure has to land
       on the same side. So its refusal is asserted as the VALUES it
       hands back, which is what the panel reads. */
    const ids = ["uniplanner.studyai.monthly", "uniplanner.studyaimax.annual"];
    const web = plans.capabilityFrom({ isNative: false, platform: "web", iosKey: "appl_x", androidKey: "goog_x" });

    const traced = tracedPlugin();
    const offWeb = await sdk.introEligibility({ productIds: ids, session: SESSION, plugin: traced.plugin, capability: web });
    assert.deepEqual(traced.trace, [], `it called the store SDK on web: ${traced.trace.map((c) => c.name).join(", ")}`);
    for (const id of ids) assert.equal(offWeb[id], plans.INTRO_UNKNOWN, `${id} did not answer UNKNOWN on web`);

    /* NON-VACUITY: on a native capability it really does ask, or the
       assertion above is about a function that never asks anybody. */
    const native = tracedPlugin({
      checkTrialOrIntroductoryPriceEligibility: async () => ({ [ids[0]]: { status: 2 }, [ids[1]]: { status: 1 } }),
    });
    const onNative = await sdk.introEligibility({
      productIds: ids,
      session: { user: { id: "intro-native" } },
      plugin: native.plugin,
      capability: plans.capabilityFrom(NATIVE_IOS),
    });
    assert.ok(
      native.trace.some((c) => c.name === "checkTrialOrIntroductoryPriceEligibility"),
      `it never asked the plugin on a native capability. Trace: ${native.trace.map((c) => c.name).join(", ") || "(empty)"}`
    );
    assert.equal(onNative[ids[0]], plans.INTRO_ELIGIBLE);
    assert.equal(onNative[ids[1]], plans.INTRO_INELIGIBLE);

    /* A PLUGIN THAT THROWS IS UNKNOWN, NOT AN ERROR. This read decides
       whether to PRINT A PRICE; its failure must cost the full price
       and nothing else. */
    const angry = tracedPlugin({
      checkTrialOrIntroductoryPriceEligibility: async () => {
        throw new Error("the SDK fell over");
      },
    });
    const thrown = await sdk.introEligibility({
      productIds: ids,
      session: { user: { id: "intro-throw" } },
      plugin: angry.plugin,
      capability: plans.capabilityFrom(NATIVE_IOS),
    });
    for (const id of ids) assert.equal(thrown[id], plans.INTRO_UNKNOWN, `${id} did not degrade to UNKNOWN on a throw`);
  });

  await test("THE PLAN LINE HAS THREE ANSWERS, and no two of them read the same", () => {
    /* `fetchNote`'s rule as a sentence. "We couldn't check" is a report
       of a failure, so it must not be what a signed-out student sees —
       there is no account, nothing was checked, and nothing failed. */
    const signedOut = copy.currentPlanLine(null, { signedOut: true });
    const unknown = copy.currentPlanLine(null);
    const known = copy.currentPlanLine("ai");
    const three = new Set([signedOut, unknown, known]);
    assert.equal(three.size, 3, `the three plan states do not produce three sentences: ${[...three].join(" / ")}`);
    assert.doesNotMatch(signedOut, /couldn't check|could not check/i, "a signed-out student is told a read failed");
    assert.match(signedOut, /account/i, "the signed-out line does not say what to do about it");
    assert.match(unknown, /couldn't check|could not check/i, "the unknown case stopped saying it is unknown");
    /* AND IT IS NOT "FREE", which is the older half of the same rule. */
    for (const line of [signedOut, unknown]) {
      assert.doesNotMatch(line, new RegExp(`You're on ${copy.TIER_NAMES.free}`), "an unknown plan is being rendered as the free plan");
    }
  });

  await test("THE STORE HAS THREE OUTCOMES TOO — unreachable is not the same as empty", () => {
    /* `loadPackages` returns three for the reason its own comment
       gives, and the panel used to collapse the last two into an empty
       array — so an SDK that could not be reached rendered exactly like
       a dashboard with no products in it. */
    const failed = copy.storeStatusLine("failed");
    const empty = copy.storeStatusLine("empty");
    assert.ok(failed && empty, "one of the two store sentences is missing");
    assert.notEqual(failed, empty, "an unreachable store and an empty offering say the same thing");
    assert.equal(copy.storeStatusLine("ok"), null, "a working store is being explained at");
    assert.equal(copy.storeStatusLine(null), null, "a store that has not answered yet is being explained at");
    /* NEITHER MAY CAST DOUBT ON THE PLAN, because the plan comes from
       `profiles` and is not in question — and "is my subscription gone"
       is the first thing somebody asks when buying stops working. */
    for (const line of [failed, empty]) {
      assert.match(line, /plan is unchanged/i, `a store sentence does not say the plan is unaffected: ${line}`);
    }
  });

  await test("a build with no key refuses in the same way, and says so differently", async () => {
    const noKey = plans.capabilityFrom({ isNative: true, platform: "ios", iosKey: "" });
    const traced = tracedPlugin();
    const result = await sdk.configurePurchases({ session: SESSION, plugin: traced.plugin, capability: noKey });
    assert.deepEqual(traced.trace, [], "a keyless build still called configure");
    assert.equal(result.reason, "no-key", "a keyless store build must not be indistinguishable from web");
  });

  /* ---------- 4. identity: never anonymous ---------- */

  await test("configure names the SUPABASE user id, and refuses without a session", async () => {
    const traced = tracedPlugin();
    const cap = plans.capabilityFrom(NATIVE_IOS);
    const ok = await sdk.configurePurchases({ session: SESSION, plugin: traced.plugin, capability: cap });
    assert.equal(ok.ok, true);
    assert.deepEqual(traced.trace.map((c) => c.name), ["configure"]);
    assert.deepEqual(traced.trace[0].args[0], { apiKey: "appl_test", appUserID: SESSION.user.id },
      "configure must pass the signed-in account id as the app user id — an anonymous id produces exactly the delivery the webhook answers no_account to");

    for (const session of [null, undefined, {}, { user: null }, { user: {} }]) {
      const t = tracedPlugin();
      const r = await sdk.configurePurchases({ session, plugin: t.plugin, capability: cap });
      assert.equal(r.ok, false, `configure ran for session ${JSON.stringify(session)}`);
      assert.equal(r.reason, "signed-out");
      assert.deepEqual(t.trace, [], "configure reached the SDK without a signed-in account");
    }
  });

  await test("AN ACTION THAT ARRIVES BEFORE configure CONFIGURES FIRST, rather than failing", async () => {
    /* THE DEVICE BUG, at the boundary. getOfferings reached the plugin
       before configure did — not because either call site was wrong,
       but because `loadPackages` runs from a CHILD component's effect
       and React runs child effects first. Fixing the call sites would
       fix this launch and not the rule.

       So the ordering is a property of the module: an action that gets
       there first performs the configure itself. */
    const cap = plans.capabilityFrom(NATIVE_IOS);
    const session = { user: { id: "arrives-first" } };
    const traced = tracedPlugin();
    const r = await sdk.loadPackages({ session, plugin: traced.plugin, capability: cap });
    assert.equal(r.ok, true, `loadPackages failed although nothing was wrong: ${r.reason}`);
    assert.deepEqual(
      traced.trace.map((c) => c.name),
      ["configure", "getOfferings"],
      "the offering was requested before the SDK was told who this is"
    );
    assert.deepEqual(traced.trace[0].args[0], { apiKey: "appl_test", appUserID: session.user.id });
  });

  await test("TWO ACTIONS RACING PRODUCE ONE configure, and both wait on it", async () => {
    /* Not tidiness: two configures for one account is two identities
       being asserted, and which one the SDK ends on is a coin toss. */
    const cap = plans.capabilityFrom(NATIVE_IOS);
    const session = { user: { id: "racing" } };
    const traced = tracedPlugin();
    const [a, b] = await Promise.all([
      sdk.loadPackages({ session, plugin: traced.plugin, capability: cap }),
      sdk.restorePurchases({ session, plugin: traced.plugin, capability: cap }),
    ]);
    assert.equal(a.ok, true, `loadPackages failed: ${a.reason}`);
    assert.equal(b.ok, true, `restorePurchases failed: ${b.reason}`);
    const configures = traced.trace.filter((c) => c.name === "configure").length;
    assert.equal(configures, 1, `two racing actions produced ${configures} configure calls`);
    assert.equal(traced.trace[0].name, "configure", `the first call was ${traced.trace[0].name}`);
  });

  await test("A FAILED configure IS THE ANSWER, rather than a confusing provider error one call later", async () => {
    /* Letting getOfferings run anyway is what produced "Purchases must
       be configured before calling this function" — a true sentence
       about our bug, shown to a student, on the screen that sells the
       paid tier. */
    const cap = plans.capabilityFrom(NATIVE_IOS);
    const traced = tracedPlugin({ configure: () => { throw new Error("StoreKit is unavailable"); } });
    const r = await sdk.loadPackages({ session: { user: { id: "cannot-configure" } }, plugin: traced.plugin, capability: cap });
    assert.equal(r.ok, false, "loadPackages reported success although the SDK was never configured");
    assert.equal(r.reason, "sdk-error");
    assert.ok(
      !traced.trace.some((c) => c.name === "getOfferings"),
      `the offering was requested although configuring failed: ${traced.trace.map((c) => c.name).join(", ")}`
    );
  });

  await test("RESTORE REFUSES WITHOUT A SESSION — a receipt must never land on an anonymous id", async () => {
    /* Restore re-attaches a real store receipt to whatever app user id
       the SDK currently holds. Without a session that is an anonymous
       one, which is precisely the delivery the webhook answers
       `no_account` to — a paid subscription attached to an account we
       do not have. `configurePurchases` has always refused without a
       session; this one did not, and the panel's own signed-out state
       was the only thing between them. A UI-only gate is one refactor
       from leaking, and the refactor need not touch this file. */
    const cap = plans.capabilityFrom(NATIVE_IOS);
    const ok = tracedPlugin();
    /* Its own session id, and the trace is asserted by CONTAINMENT: the
       configure gate is module-level, so whether this call also has to
       configure depends on what ran before it, and that is not what
       this test is about. */
    const allowed = await sdk.restorePurchases({ session: { user: { id: "restore-allowed" } }, plugin: ok.plugin, capability: cap });
    assert.equal(allowed.ok, true, "restore refused a signed-in account — this test cannot discriminate");
    assert.ok(ok.trace.some((c) => c.name === "restorePurchases"), `restore never reached the plugin: ${ok.trace.map((c) => c.name).join(", ")}`);

    for (const session of [null, undefined, {}, { user: null }, { user: {} }]) {
      const t = tracedPlugin();
      const r = await sdk.restorePurchases({ session, plugin: t.plugin, capability: cap });
      assert.equal(r.ok, false, `restore ran for session ${JSON.stringify(session)}`);
      assert.equal(r.reason, "signed-out", `restore refused for the wrong reason: ${r.reason}`);
      assert.deepEqual(t.trace, [], "restore reached the SDK without a signed-in account");
    }
  });

  await test("signing out logs the SDK out, so a shared handset does not inherit an identity", async () => {
    const traced = tracedPlugin();
    const r = await sdk.logOutPurchases({ plugin: traced.plugin, capability: plans.capabilityFrom(NATIVE_IOS) });
    assert.equal(r.ok, true);
    assert.deepEqual(traced.trace.map((c) => c.name), ["logOut"]);
  });

  await test("an SDK that throws is REPORTED, never thrown — a planner does not break because a store is down", async () => {
    const boom = () => {
      throw new Error("store unavailable");
    };
    const cap = plans.capabilityFrom(NATIVE_IOS);
    for (const [name, call] of [
      ["configure", (o) => sdk.configurePurchases(o)],
      ["logOut", async (o) => {
        /* logOut has nothing to forget until something configured, so
           the throwing case needs an SDK that was configured first —
           which is also the only state in which a real logOut runs. */
        await sdk.configurePurchases(o);
        return sdk.logOutPurchases(o);
      }],
      ["getOfferings", (o) => sdk.loadPackages(o)],
      ["restorePurchases", (o) => sdk.restorePurchases(o)],
    ]) {
      /* A FRESH SESSION ID PER CASE. The configure gate is module-level,
         as the SDK's own identity is, so a case that reused the last
         one's id would find the SDK already configured and never reach
         the call it is about. */
      const session = { user: { id: `throws-${name}` } };
      const traced = tracedPlugin({ [name]: boom });
      const r = await call({ session, plugin: traced.plugin, capability: cap });
      assert.equal(r.ok, false, `${name} reported success after throwing`);
      assert.equal(r.reason, "sdk-error", `${name} reported ${r.reason}`);
    }
  });

  await test("A CANCELLATION IS NOT A FAILURE, and an empty offering is not a failed read", async () => {
    const cap = plans.capabilityFrom(NATIVE_IOS);
    /* A FRESH SESSION ID PER CASE, for the reason the sweep above gives:
       the configure gate is module-level and remembers the last id. */
    const sess = (n) => ({ user: { id: `outcomes-${n}` } });

    const cancelled = tracedPlugin({
      purchasePackage: () => {
        const err = new Error("Purchase was cancelled.");
        err.userCancelled = true;
        throw err;
      },
    });
    const r = await sdk.purchasePackage({ identifier: "studyai_monthly" }, { session: sess("cancel"), plugin: cancelled.plugin, capability: cap });
    assert.equal(r.reason, "cancelled", "pressing Cancel must not be reported as something going wrong");
    assert.equal(copy.outcomeMessage("purchase", "cancelled"), null, "a cancellation must say nothing at all");

    /* THREE OUTCOMES, KEPT DISTINCT — the fetchNote rule. An offering
       with no packages is a definitive empty; a read that threw is
       unknown. A panel that showed "no plans available" for the second
       would be a paywall caused by a tunnel. */
    const empty = tracedPlugin({ getOfferings: () => ({ current: { identifier: "default", availablePackages: [] } }) });
    const emptyResult = await sdk.loadPackages({ session: sess("empty"), plugin: empty.plugin, capability: cap });
    assert.deepEqual({ ok: emptyResult.ok, n: emptyResult.packages.length }, { ok: true, n: 0 });

    const failed = tracedPlugin({ getOfferings: () => { throw new Error("offline"); } });
    const failedResult = await sdk.loadPackages({ session: sess("failed"), plugin: failed.plugin, capability: cap });
    assert.equal(failedResult.ok, false, "a failed offerings read must not read as an empty offering");

    const noOffering = tracedPlugin({ getOfferings: () => ({ current: null }) });
    const noneResult = await sdk.loadPackages({ session: sess("none"), plugin: noOffering.plugin, capability: cap });
    assert.deepEqual({ ok: noneResult.ok, n: noneResult.packages.length }, { ok: true, n: 0 }, "a dashboard with no current offering must not read as a failure");

    assert.equal((await sdk.purchasePackage(null, { session: sess("nopkg"), plugin: tracedPlugin().plugin, capability: cap })).reason, "no-package");
  });

  /* ---------- 5. the copy ---------- */

  await test("every plan sentence agrees with what allowanceForTier says, for every tier", () => {
    assert.ok(limits.TIERS.length >= 3, "the tier list is empty — this check would pass over nothing");
    for (const tier of limits.TIERS) {
      const { credits, perMonth } = limits.allowanceForTier(tier);
      const line = copy.currentPlanLine(tier);
      assert.ok(line.includes(String(credits)), `${tier}: the plan line does not name its ${credits} credits`);
      assert.ok(copy.TIER_NAMES[tier], `${tier} has no display name`);
      assert.ok(line.includes(copy.TIER_NAMES[tier]), `${tier}: the plan line does not name the plan`);
      const reset = copy.resetLine(tier);
      if (perMonth) {
        assert.match(reset, /calendar month/i, `${tier} resets monthly and the copy does not say when`);
      } else {
        assert.doesNotMatch(reset, /\ba month\b|monthly/i, `${tier} is a once-ever allowance and the copy implies a reset`);
        assert.match(reset, /don't reset|do not reset/i, `${tier} must SAY it does not reset rather than leave it to be inferred`);
      }
      assert.doesNotMatch(`${line} ${reset}`, /\bunits?\b/i, `${tier}: "units" reached a screen`);
    }
  });

  await test("an unknown tier is not quietly the free plan", () => {
    /* The failed-read rule, in a sentence: a student on a train must
       not be told they are on the free plan because the read timed
       out. */
    const line = copy.currentPlanLine(null);
    assert.match(line, /couldn't check|could not check/i);
    assert.doesNotMatch(line, /\bFree\b/, "an unknown plan renders as the free plan");
    for (const tier of limits.TIERS) assert.notEqual(copy.currentPlanLine(tier), line);
  });

  await test("Apple's required elements are all present, and none of them says 'units'", () => {
    /* A reviewer checks a subscription screen by LOOKING: the price and
       period (per package, from the store), that it renews
       automatically, how to cancel, a Restore control, and links to the
       terms and the privacy policy. A missing one is a rejection, not a
       bug report. */
    const all = [
      copy.DISCLOSURES.autoRenew,
      copy.DISCLOSURES.noRollover,
      copy.refundLine("web"),
      copy.managedByStoreLine("web", null),
      copy.managedByStoreLine("unknown-platform", "app_store"),
      copy.ACTIONS.restore,
      copy.ACTIONS.manage,
      copy.termsLink("web").label,
      copy.termsLink("unknown-platform").label,
      copy.ACTIONS.privacy,
      copy.ACTIVATING_NOTICE,
      copy.buyLabel("ai", "monthly", "$8.99"),
    ].join(" ");
    assert.match(copy.DISCLOSURES.autoRenew, /renew/i);
    assert.match(copy.DISCLOSURES.autoRenew, /cancel/i);
    assert.match(copy.DISCLOSURES.noRollover, /roll over|rollover/i);
    assert.match(copy.refundLine("web"), /refund/i);

    /* THE REFUND LINE IS PER PLATFORM, and the three answers must
       DIFFER — a helper ignoring its argument would satisfy every
       assertion that only reads one of them, which is the hole the
       managedByStoreLine test names. */
    const webRefund = copy.refundLine("web");
    const storeRefund = copy.refundLine("native");
    assert.notEqual(webRefund, storeRefund, "refundLine returns the same sentence on web and on a store, so it is not platform-aware");
    /* WEB PROMISES IMMEDIACY, because #107 made it mechanically true:
       a full refund cancels the subscription in Stripe and writes the
       tier back on the same delivery. */
    assert.match(webRefund, /straight away/i, "the web line no longer promises what the refund path actually does");
    /* AND A STORE PROMISES NO TIMING, because the timing is Apple's or
       Google's. `isActive` reads expires_date, so a refund that leaves
       that date alone leaves the plan running — which is exactly the
       thing "straight away" would have been wrong about. */
    assert.doesNotMatch(storeRefund, /straight away|immediately|at once/i, "the store line promises a timing we do not control");
    assert.match(storeRefund, /once the store tells us|when the store tells us/i, "the store line does not say what the plan actually waits for");
    /* THE CREDITS HALF IS UNCONDITIONAL, because it is true
       everywhere: the AI work has been done and cannot be returned. */
    for (const line of [webRefund, storeRefund]) {
      assert.match(line, /stay spent/i, "a refund line dropped the credits half, which is true on every platform");
    }
    /* Apple's reviewer is looking at a NATIVE screen, so the element
       they require is the native sentence — naming the store, not
       Stripe. The web variant is checked in test-legal.mjs against the
       Terms; here the claim is that the native screen still carries
       what review looks for. */
    assert.match(copy.managedByStoreLine("unknown-platform", "app_store"), /App Store/, "the native panel no longer names the store that charges");
    assert.match(copy.ACTIONS.restore, /restore/i);
    assert.match(copy.buyLabel("ai", "monthly", "$8.99"), /\$8\.99/, "the buy button does not show the store's price");
    assert.match(copy.buyLabel("ai_max", "annual", "$169.99"), /12 months/, "the buy button does not show the period");
    assert.doesNotMatch(all, /\bunits?\b/i, '"units" is an internal weight and never reaches a screen');
    assert.equal(copy.LINKS.privacy, links.PRIVACY_URL);

    /* THE TERMS LINK IS PLATFORM-DEPENDENT, and both branches are
       asserted because either one alone would pass on a function that
       ignored its argument.

       Native keeps Apple's standard licence: it really does govern an
       App Store purchase, and Apple's review looks for it on the
       subscription screen. Web and desktop get OURS, because a purchase
       there goes through Stripe and Apple's licence would be a document
       about a transaction that did not happen. */
    const native = copy.termsLink("unknown-platform");
    const web = copy.termsLink("web");
    assert.notEqual(native.href, web.href, "termsLink ignores its argument, so neither branch below is about anything");

    assert.equal(native.href, links.APPLE_EULA_URL);
    assert.match(native.href, /^https:\/\/www\.apple\.com\//, "the native Terms link is not Apple's standard EULA");
    assert.match(native.label, /EULA/, "the native link does not say it is Apple's licence");

    assert.equal(web.href, links.TERMS_URL);
    assert.doesNotMatch(web.label, /EULA/, "our own Terms are labelled as Apple's licence");

    /* THE LABEL AND THE HREF TRAVEL TOGETHER so they cannot disagree
       about which agreement somebody is being shown — the one thing a
       legal link must not get wrong. */
    for (const [name, got] of [["native", native], ["web", web]]) {
      assert.ok(got.href && got.label, `termsLink("${name}") is missing half of the pair`);
    }
  });

  await test("MOBILE-BUILD's button example is the label buyLabel really renders", () => {
    /* The hardware list tells somebody what a CORRECTLY resolved package
       looks like, so they can tell it from an unrecognised one at a
       glance — and it quotes the label to do it. That is a restatement
       of buyLabel + TIER_NAMES + DURATION_LABELS, and this file already
       has a ledger entry about restating a dashboard, so the quoted
       string is re-derived rather than trusted.

       It matters more than a typo would: the whole check is "does this
       button read like THIS or like a product title", and a stale
       example turns the one cheap pre-purchase check into a false
       alarm on a correct build. */
    const doc = fs.readFileSync(path.join(rootDir, "MOBILE-BUILD.md"), "utf8");
    const quoted = [...doc.matchAll(/`(Study AI[^`]*·[^`]*)`/g)].map((m) => m[1]);
    assert.ok(quoted.length >= 1, "no example label is quoted in MOBILE-BUILD.md — this guard would pass over nothing");

    for (const example of quoted) {
      /* Take the price off the end and re-derive the rest, so the
         illustrative figure stays free to change and the STRUCTURE
         cannot. */
      const parts = example.split(" · ");
      assert.equal(parts.length, 3, `"${example}" is not tier · period · price`);
      const price = parts[2];
      const match = Object.entries(plans.PACKAGE_PLANS).find(
        ([, plan]) => copy.buyLabel(plan.tier, plan.duration, price) === example
      );
      assert.ok(
        match,
        `MOBILE-BUILD quotes "${example}", which buyLabel renders for no package we sell — ` +
          `it renders e.g. "${copy.buyLabel("ai", "monthly", price)}"`
      );
    }
  });

  await test("the refund sentence says credits are not returned, because they are not", () => {
    /* BILLING-PLAN's refund rule, in the words a student reads: the
       entitlement ends, the tier goes back to free, and credits already
       spent are not clawed back or handed back. Copy that implied a
       credit refund would be a promise the server does not keep. */
    /* ASSERTED ON BOTH PLATFORMS, because the sentence became
       platform-aware and a claim about "the refund sentence" is now a
       claim about two of them. Both must say what happens to credits
       and what the plan becomes; only the TIMING differs. */
    for (const reason of ["web", "native"]) {
      const line = copy.refundLine(reason);
      assert.match(line, /already spent stay spent|not.*returned/i, `the ${reason} refund sentence drops the credits half`);
      assert.match(line, /Free/, `the ${reason} refund sentence does not say what the plan becomes`);
    }
  });

  await test("web is told where plans are bought, and it is not a 'coming soon'", () => {
    const web = copy.unavailableLine("web");
    assert.match(web, /iPhone|Android/i, "web is not told where a plan can be bought");
    assert.doesNotMatch(web, /coming soon|soon/i, "a surface that will never sell must not promise that it will");
    assert.notEqual(copy.unavailableLine("no-key"), web, "a keyless build must not be indistinguishable from web");
    assert.equal(copy.unavailableLine(null), null, "an available capability has no unavailable sentence");
  });

  /* ---------- 6. the shared refresh signal ---------- */

  await test("NOTHING BUT A LINK IS TAKEN OFF customerInfo, anywhere in src/", () => {
    /* THE SOURCE-LEVEL HALF of the browser test in
       test-rendered-tabs.mjs, and it exists because the behavioural one
       can only reach the panel. The rule is that `profiles.tier` is the
       truth and `customerInfo` is the store's opinion — so the ONE
       thing taken off it is `managementURL`, which is a LINK and not an
       entitlement.

       Swept over all of src/ rather than over plans.jsx, because that
       is the claim's scope and not the file that happens to hold it
       today — the file-scoped-guard entry in CLAUDE.md's ledger is
       exactly this mistake. Comments are stripped first: the modules
       below all STATE the rule they follow, and a grep that trips on
       its own explanation gets weakened under time pressure.

       WHAT IT CANNOT SEE, said rather than implied: a property reached
       through a variable (`const c = customerInfo; c.entitlements`) or
       through a destructure two lines away. The browser test is what
       covers the panel behaviourally; between them the hole is small
       and named. */
    const ALLOWED = new Set(["managementURL"]);
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : /\.(js|jsx)$/.test(e.name) ? [full] : [];
      });

    let readsSeen = 0;
    const offences = [];
    for (const abs of walk(path.join(rootDir, "src"))) {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      const code = strip(fs.readFileSync(abs, "utf8"));
      for (const [, prop] of code.matchAll(/\bcustomerInfo\s*(?:\?\.|\.)\s*(\w+)/g)) {
        readsSeen += 1;
        if (!ALLOWED.has(prop)) offences.push(`${rel} reads customerInfo.${prop}`);
      }
      /* A destructure is the same read wearing a different hat. */
      for (const [, inner] of code.matchAll(/\{([^{}]*)\}\s*=\s*customerInfo\b/g)) {
        for (const name of inner.split(",").map((x) => x.split(":")[0].trim()).filter(Boolean)) {
          readsSeen += 1;
          if (!ALLOWED.has(name)) offences.push(`${rel} destructures ${name} out of customerInfo`);
        }
      }
    }

    /* NON-VACUITY FIRST: if nothing anywhere reads customerInfo, the
       loop above is a universal claim about an empty set, which every
       assertion satisfies. `managementURL` really is read — that is
       what the manage-subscription link is built from. */
    assert.ok(readsSeen >= 1, "no read of customerInfo was found in src/ at all — this guard is checking nothing");
    assert.deepEqual(
      offences,
      [],
      "profiles.tier is the truth and customerInfo is the store's opinion; the only thing that may come off it is a management LINK"
    );
  });

  await test("one bump moves every reader, and the poll ladder is bounded", () => {
    const seen = [];
    const off1 = refresh.subscribeEntitlement(() => seen.push("a"));
    const off2 = refresh.subscribeEntitlement(() => seen.push("b"));
    const before = refresh.entitlementVersion();
    refresh.bumpEntitlement();
    assert.deepEqual(seen, ["a", "b"], "a bump did not reach every reader");
    assert.equal(refresh.entitlementVersion(), before + 1);
    off1();
    off2();
    refresh.bumpEntitlement();
    assert.deepEqual(seen, ["a", "b"], "an unsubscribed reader was still notified");

    const scheduled = [];
    const cleared = [];
    const cancel = refresh.refreshEntitlementSoon({
      setTimer: (fn, ms) => {
        scheduled.push(ms);
        return ms;
      },
      clearTimer: (h) => cleared.push(h),
    });
    assert.ok(scheduled.length >= 1, "the ladder scheduled nothing");
    assert.ok(scheduled.every((ms) => ms > 0 && ms <= 60_000), `a poll delay is unbounded: ${scheduled.join(", ")}`);
    assert.ok(plans.ENTITLEMENT_POLL_DELAYS_MS.length <= 6, "the ladder grew — an unbounded poll after a webhook that never arrives is a client hammering a database forever");
    assert.equal(plans.ENTITLEMENT_POLL_DELAYS_MS[0], 0, "the first re-read must be immediate");
    cancel();
    assert.deepEqual(cleared, scheduled, "cancelling the ladder left a timer to fire into an unmounted panel");
  });

  /* ---------- 7. the keys, and the build that carries them ---------- */

  await test("the build defines BOTH keys, so a bundle can never carry an undeclared identifier", () => {
    /* THE FAILURE THIS PREVENTS is import.meta.env in a new costume:
       esbuild substitutes exactly the expression named in `define`, and
       a bundle that missed one would ship an app whose purchase
       controls never appear — or, with a less careful source form,
       throw on an undefined `process`. Both names are derived from the
       module that reads them rather than typed here. */
    const buildSrc = fs.readFileSync(path.join(rootDir, "scripts/build-web.mjs"), "utf8");
    const names = Object.values(keys.KEY_DEFINE_NAMES);
    const envNames = Object.values(keys.KEY_ENV_NAMES);
    assert.ok(names.length === 2 && envNames.length === 2, "the key name tables are not what this guard reads");
    for (const define of names) assert.ok(buildSrc.includes(define), `the web build does not define ${define}, so it is an undeclared identifier in the bundle`);
    for (const env of envNames) assert.ok(buildSrc.includes(env), `the web build never reads ${env} from the environment`);

    /* And the source side must be the form that cannot throw. */
    const src = fs.readFileSync(path.join(rootDir, "src/purchaseKeys.js"), "utf8");
    for (const define of names) {
      assert.match(src, new RegExp(`typeof ${define} === "string"`), `${define} is read without a typeof guard — a missing define becomes a ReferenceError`);
    }
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, " "), /process\.env|import\.meta/, "the keys are read through process.env or import.meta, which are empty in an iife bundle");
  });

  await test("the built bundle really carries the substitution, and no secret key", () => {
    /* THE ARTIFACT, not the source. An empty key is the correct state
       for a web build; what must never happen is a `sk_`-shaped secret
       reaching it, which the leak gate in test-ai-notes.mjs owns — this
       asserts the other half, that the substitution actually happened. */
    const built = fs.readFileSync(path.join(rootDir, "dist-web/app.js"), "utf8");
    for (const define of Object.values(keys.KEY_DEFINE_NAMES)) {
      assert.ok(!built.includes(define), `${define} survived into the bundle unsubstituted — it is an undeclared global at runtime`);
    }
    assert.ok(built.includes("purchaseCapability") || built.includes("capabilityFrom") || built.includes("app_store"), "the purchase code is not in the bundle at all, so this check reads nothing");
  });

  /* ================================================================
     INTRODUCTORY OFFERS — the two wrong fixes, each asserted.

     The panel rendered `product.priceString` and nothing else, so a
     50% intro offer configured in App Store Connect was applied at the
     till and advertised nowhere. Both obvious remedies are wrong in
     opposite directions, which is why both are here rather than one
     happy-path test.
     ================================================================ */

  const IOS = "app_store";
  const PLAY = "play_store";
  const product = (over = {}) => ({
    identifier: "uniplanner.studyai.monthly",
    priceString: "A$8.99",
    /* `periodNumberOfUnits` IS IN THE DEFAULT because RevenueCat's type
       declares it non-optional, and a fixture that omits a field
       production always sends is the whole file quietly asserting it is
       absent. On this monthly product it is 1, which is exactly why
       reading `cycles` alone looked right for as long as the fixtures
       were monthly. */
    introPrice: {
      priceString: "A$4.49",
      cycles: 3,
      period: "P1M",
      periodUnit: "MONTH",
      periodNumberOfUnits: 1,
    },
    ...over,
  });

  await test("AN INELIGIBLE STUDENT IS SHOWN THE FULL PRICE — the offer exists on the product, not for them", () => {
    /* THE FIRST WRONG FIX. `introPrice` is what was CONFIGURED, never
       what this person will be charged: somebody who has subscribed
       before is ineligible and Apple bills them full price at the
       sheet. A discount on our screen that the store does not honour is
       a false price on a screen Apple checks. */
    const r = plans.displayPriceFor({ product: product(), store: IOS, eligibility: plans.INTRO_INELIGIBLE });
    assert.equal(r.price, "A$8.99");
    assert.equal(r.intro, null);
    assert.equal(r.reason, "not-eligible");
  });

  await test("UNKNOWN SHOWS THE FULL PRICE — not-known is not yes, and the safe direction is understating", () => {
    /* RevenueCat's own advice: "the best course of action on unknown
       status is to display the non-intro pricing, to not create a
       misleading situation." A student quietly charged less than we
       said is delighted; the reverse is a refund. */
    for (const e of [plans.INTRO_UNKNOWN, undefined, null, "something-else"]) {
      const r = plans.displayPriceFor({ product: product(), store: IOS, eligibility: e });
      assert.equal(r.price, "A$8.99", `eligibility ${String(e)} showed a discount`);
      assert.equal(r.intro, null);
    }
  });

  await test("AND AN ELIGIBLE ONE SEES IT — the control, or every rule above is satisfied by never showing an offer", () => {
    const r = plans.displayPriceFor({ product: product(), store: IOS, eligibility: plans.INTRO_ELIGIBLE });
    assert.equal(r.price, "A$4.49");
    assert.equal(r.intro.then, "A$8.99", "the price AFTER the offer is the half students are surprised by");
    assert.equal(r.intro.cycles, 3);
  });

  await test("PLAY PRICES ITS OWN OFFERS, so eligibility must not gate Android into never showing one", () => {
    /* THE SECOND WRONG FIX, and it is silent. RevenueCat documents that
       "Android always returns INTRO_ELIGIBILITY_STATUS_UNKNOWN", so an
       eligibility gate would mean Play never shows an offer at all.
       Play bakes the applicable offer into `defaultOption`, whose
       formatted price IS `priceString` — so the store has already
       answered and overriding it would be us disagreeing with it. */
    const r = plans.displayPriceFor({
      product: product({ priceString: "A$4.49" }),
      store: PLAY,
      eligibility: plans.INTRO_UNKNOWN,
    });
    assert.equal(r.price, "A$4.49", "Android is not showing the price Play says it will charge");
    assert.equal(r.reason, "store-prices-it");
  });

  await test("a product with no offer is unchanged on either store", () => {
    for (const store of [IOS, PLAY]) {
      const r = plans.displayPriceFor({ product: product({ introPrice: null }), store, eligibility: plans.INTRO_ELIGIBLE });
      assert.equal(r.price, "A$8.99");
      assert.equal(r.intro, null);
    }
  });

  await test("RevenueCat's numeric enum maps to the three names, and anything else is UNKNOWN", () => {
    assert.equal(plans.introStatusFrom({ status: 2 }), plans.INTRO_ELIGIBLE);
    assert.equal(plans.introStatusFrom({ status: 1 }), plans.INTRO_INELIGIBLE);
    assert.equal(plans.introStatusFrom({ status: 0 }), plans.INTRO_UNKNOWN);
    /* The conservative direction for everything unrecognised: a future
       status we have not seen must not read as a discount. */
    for (const raw of [undefined, null, {}, { status: 99 }, "eligible-ish", 3]) {
      assert.equal(plans.introStatusFrom(raw), plans.INTRO_UNKNOWN, `${JSON.stringify(raw)} was not read as unknown`);
    }
  });

  await test("the after-line names the period when it can, and always names the price after", () => {
    const m = (over) => ({ then: "A$8.99", periodUnit: "MONTH", periodNumberOfUnits: 1, ...over });
    assert.equal(copy.introLine(m({ cycles: 3 })), "for 3 months, then A$8.99");
    assert.equal(copy.introLine(m({ cycles: 1 })), "for 1 month, then A$8.99");
    /* An unreadable period still says THEN WHAT — the price after is
       the part somebody is surprised by, and dropping the whole line
       because we could not name the duration drops the important
       half. */
    assert.equal(copy.introLine({ then: "A$8.99", cycles: null, periodUnit: "AEON" }), "then A$8.99");
    assert.equal(copy.introLine(null), "");
    assert.equal(copy.introLine({ then: "" }), "");
  });

  await test("ONE INTRODUCTORY PERIOD ON THE SIX-MONTH PLAN IS SIX MONTHS, NOT ONE", () => {
    /* THE BUG THIS TEST EXISTS FOR, found by Jared asking whether the
       wording derives from App Store Connect: it does, and it was
       reading ONE of the two fields that decide the duration.

       `cycles` counts discounted billing PERIODS. `periodNumberOfUnits`
       is how long one period is. On a MONTHLY product they agree — one
       period is one month — so every fixture and every screenshot of
       the monthly plan looked correct while the six-month plan was
       five months short. A price sentence, on the screen somebody pays
       from, understated in the direction that becomes a refund.

       App Store Connect's "1 period" on the six-month product arrives
       as cycles 1, MONTH, 6. */
    const sixMonth = {
      identifier: "uniplanner.studyai.sixmonth",
      priceString: "A$44.99",
      introPrice: {
        priceString: "A$22.49",
        cycles: 1,
        period: "P6M",
        periodUnit: "MONTH",
        periodNumberOfUnits: 6,
      },
    };
    const r = plans.displayPriceFor({ product: sixMonth, store: IOS, eligibility: plans.INTRO_ELIGIBLE });
    assert.equal(r.price, "A$22.49");
    assert.equal(r.intro.periodNumberOfUnits, 6, "the second factor never reached the copy");
    assert.equal(
      copy.introLine(r.intro),
      "for 6 months, then A$44.99",
      "one introductory period on a six-month plan was not rendered as six months"
    );
  });

  await test("and one period on the annual plan is a year — the whole path, not just the copy helper", () => {
    /* END TO END on purpose: `displayPriceFor` drops fields it does not
       name, so a helper that multiplies correctly over a hand-built
       object proves nothing about what the panel receives. */
    const annual = {
      identifier: "uniplanner.studyai.annual",
      priceString: "A$79.99",
      introPrice: {
        priceString: "A$39.99",
        cycles: 1,
        period: "P1Y",
        periodUnit: "YEAR",
        periodNumberOfUnits: 1,
      },
    };
    const r = plans.displayPriceFor({ product: annual, store: IOS, eligibility: plans.INTRO_ELIGIBLE });
    assert.equal(copy.introLine(r.intro), "for 1 year, then A$79.99");
  });

  await test("A FACTOR WE CANNOT READ DROPS THE DURATION RATHER THAN GUESSING AT IT", () => {
    /* The `fetchNote` rule in a sentence. If `periodNumberOfUnits` ever
       stops arriving, "for 1 month" is a claim with no evidence behind
       it and is wrong by five months on the plan it matters for, while
       "then A$8.99" is true with or without the duration. Understate
       the promise, never the price. */
    const missing = { then: "A$8.99", cycles: 1, periodUnit: "MONTH" };
    assert.equal(copy.introLine(missing), "then A$8.99");
    assert.equal(copy.introLine({ ...missing, periodNumberOfUnits: 0 }), "then A$8.99");
    assert.equal(copy.introLine({ ...missing, periodNumberOfUnits: null }), "then A$8.99");
    /* AND THE CONTROL: with both factors present it names the duration,
       or every assertion above is satisfied by a line that never
       names one. */
    assert.equal(
      copy.introLine({ ...missing, periodNumberOfUnits: 1 }),
      "for 1 month, then A$8.99"
    );
  });

  await test("NOTHING OUTSIDE sync.js READS THE PROVIDER'S SESSION FIELD NAMES", async () => {
    /* THE BUG, live on production build 9d11767cb604: `plans.jsx` read
       `session.access_token`. The app's session is SHAPED by
       `shapeSession` to `{ user, token }`, so that read was undefined
       on every signed-in account and every web purchase refused with
       "Please sign in again." before any request left the browser.
       `billing-checkout` had no invocation at all.

       The click-through test in test-rendered-tabs.mjs is what catches
       the BEHAVIOUR. This catches the CLASS, and it is derived on both
       sides rather than restated: the provider's field names are read
       out of `shapeSession`'s own body, and so is the app's key set, so
       renaming either follows instead of going stale. A guard naming
       "access_token" as a literal would be the restatement pattern
       inside the test meant to stop it. */
    const syncSrc = fs.readFileSync(path.join(rootDir, "src/sync.js"), "utf8");
    const body = (syncSrc.split("export const shapeSession")[1] || "").split("export const supabaseBackend")[0];
    assert.ok(body.trim(), "shapeSession was not found in sync.js — this guard is reading the wrong thing");

    /* What the app's session HAS: the keys of the object literal. */
    const appKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    /* What it reads FROM: every `session.<name>` inside that body. */
    const providerNames = [...new Set([...body.matchAll(/session\.(\w+)/g)].map((m) => m[1]))];

    assert.ok(appKeys.includes("token"), `shapeSession does not produce a token key: ${appKeys.join(", ") || "(none)"}`);
    assert.ok(providerNames.length > 0, "no provider field names derived from shapeSession, so the sweep below forbids nothing");

    /* THE NAMES THAT MAY NOT LEAK are the provider's own, minus any
       the app happens to keep under the same spelling — `user` is read
       from the session AND kept as `user`, so forbidding it would
       forbid every correct reader in the app. That subtraction is what
       makes this about the RENAMED fields, which are the ones a caller
       can get wrong. */
    const forbidden = providerNames.filter((n) => !appKeys.includes(n));
    assert.ok(
      forbidden.length > 0,
      `shapeSession renames nothing (${providerNames.join(", ")} vs ${appKeys.join(", ")}), so there is no leak for this guard to be about`
    );

    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return /\.(js|jsx)$/.test(e.name) ? [full] : [];
      });
    const files = walk(path.join(rootDir, "src")).filter((f) => path.basename(f) !== "sync.js");
    assert.ok(files.length > 10, `only ${files.length} source files swept — this guard is reading the wrong directory`);

    /* NON-VACUITY, and it is the half that matters: the sweep must
       find the CORRECT reader. If `session.token` appears nowhere then
       either the shape changed or the pattern is wrong, and an empty
       offender list would mean nothing either way. */
    const readers = [];
    const offenders = [];
    for (const file of files) {
      const text = strip(fs.readFileSync(file, "utf8"));
      const rel = path.relative(rootDir, file);
      if (new RegExp(`session\\s*\\.\\s*token\\b`).test(text)) readers.push(rel);
      for (const name of forbidden) {
        if (new RegExp(`session\\s*\\.\\s*${name}\\b`).test(text)) offenders.push(`${rel} reads session.${name}`);
      }
    }
    assert.ok(
      readers.length > 0,
      `no file in src/ reads session.token, so an empty offender list says nothing about the session shape`
    );
    assert.deepEqual(
      offenders,
      [],
      `the provider's session field names escaped sync.js — undefined on a shaped session, so the caller ` +
        `refuses a signed-in student before the network:\n        ${offenders.join("\n        ")}`
    );
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
