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
import { fileURLToPath } from "node:url";
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

const plans = await import(path.join(rootDir, "src/purchasePlans.js"));
const copy = await import(path.join(rootDir, "src/plansCopy.js"));
const refresh = await import(path.join(rootDir, "src/entitlementRefresh.js"));
const limits = await import(path.join(rootDir, "src/aiTextLimits.js"));
const keys = await import(path.join(rootDir, "src/purchaseKeys.js"));
const links = await import(path.join(rootDir, "src/legalLinks.js"));

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
const sdk = await import(sdkPath);

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
      ["configurePurchases", (o) => sdk.configurePurchases({ session: SESSION, ...o })],
      ["logOutPurchases", (o) => sdk.logOutPurchases(o)],
      ["loadPackages", (o) => sdk.loadPackages(o)],
      ["purchasePackage", (o) => sdk.purchasePackage({ identifier: "studyai_monthly" }, o)],
      ["restorePurchases", (o) => sdk.restorePurchases(o)],
    ];
    /* NON-VACUITY FIRST: the same five calls on a NATIVE capability must
       reach the plugin. Without this, a module that had been gutted
       would pass every assertion below. */
    const native = tracedPlugin();
    for (const [, call] of calls) await call({ plugin: native.plugin, capability: plans.capabilityFrom(NATIVE_IOS) });
    assert.equal(native.trace.length, calls.length, `a native capability reached the plugin ${native.trace.length} times, expected ${calls.length} — this test cannot discriminate`);

    globalThis.__DEFAULT_PLUGIN_CALLS__ = [];
    for (const [name, call] of calls) {
      const traced = tracedPlugin();
      const result = await call({ plugin: traced.plugin, capability: web });
      assert.deepEqual(traced.trace, [], `${name} called the store SDK on web: ${traced.trace.map((c) => c.name).join(", ")}`);
      assert.equal(result.ok, false, `${name} reported success on web`);
      assert.equal(result.reason, "web", `${name} refused for the wrong reason: ${result.reason}`);
    }
    assert.deepEqual(globalThis.__DEFAULT_PLUGIN_CALLS__, [], "something reached the real plugin export rather than the injected one");
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
      ["configure", (o) => sdk.configurePurchases({ session: SESSION, ...o })],
      ["logOut", (o) => sdk.logOutPurchases(o)],
      ["getOfferings", (o) => sdk.loadPackages(o)],
      ["restorePurchases", (o) => sdk.restorePurchases(o)],
    ]) {
      const traced = tracedPlugin({ [name]: boom });
      const r = await call({ plugin: traced.plugin, capability: cap });
      assert.equal(r.ok, false, `${name} reported success after throwing`);
      assert.equal(r.reason, "sdk-error", `${name} reported ${r.reason}`);
    }
  });

  await test("A CANCELLATION IS NOT A FAILURE, and an empty offering is not a failed read", async () => {
    const cap = plans.capabilityFrom(NATIVE_IOS);
    const cancelled = tracedPlugin({
      purchasePackage: () => {
        const err = new Error("Purchase was cancelled.");
        err.userCancelled = true;
        throw err;
      },
    });
    const r = await sdk.purchasePackage({ identifier: "studyai_monthly" }, { plugin: cancelled.plugin, capability: cap });
    assert.equal(r.reason, "cancelled", "pressing Cancel must not be reported as something going wrong");
    assert.equal(copy.outcomeMessage("purchase", "cancelled"), null, "a cancellation must say nothing at all");

    /* THREE OUTCOMES, KEPT DISTINCT — the fetchNote rule. An offering
       with no packages is a definitive empty; a read that threw is
       unknown. A panel that showed "no plans available" for the second
       would be a paywall caused by a tunnel. */
    const empty = tracedPlugin({ getOfferings: () => ({ current: { identifier: "default", availablePackages: [] } }) });
    const emptyResult = await sdk.loadPackages({ plugin: empty.plugin, capability: cap });
    assert.deepEqual({ ok: emptyResult.ok, n: emptyResult.packages.length }, { ok: true, n: 0 });

    const failed = tracedPlugin({ getOfferings: () => { throw new Error("offline"); } });
    const failedResult = await sdk.loadPackages({ plugin: failed.plugin, capability: cap });
    assert.equal(failedResult.ok, false, "a failed offerings read must not read as an empty offering");

    const noOffering = tracedPlugin({ getOfferings: () => ({ current: null }) });
    const noneResult = await sdk.loadPackages({ plugin: noOffering.plugin, capability: cap });
    assert.deepEqual({ ok: noneResult.ok, n: noneResult.packages.length }, { ok: true, n: 0 }, "a dashboard with no current offering must not read as a failure");

    assert.equal((await sdk.purchasePackage(null, { plugin: tracedPlugin().plugin, capability: cap })).reason, "no-package");
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
      copy.DISCLOSURES.refund,
      copy.DISCLOSURES.managedByStore,
      copy.ACTIONS.restore,
      copy.ACTIONS.manage,
      copy.ACTIONS.terms,
      copy.ACTIONS.privacy,
      copy.ACTIVATING_NOTICE,
      copy.buyLabel("ai", "monthly", "$8.99"),
    ].join(" ");
    assert.match(copy.DISCLOSURES.autoRenew, /renew/i);
    assert.match(copy.DISCLOSURES.autoRenew, /cancel/i);
    assert.match(copy.DISCLOSURES.noRollover, /roll over|rollover/i);
    assert.match(copy.DISCLOSURES.refund, /refund/i);
    assert.match(copy.ACTIONS.restore, /restore/i);
    assert.match(copy.buyLabel("ai", "monthly", "$8.99"), /\$8\.99/, "the buy button does not show the store's price");
    assert.match(copy.buyLabel("ai_max", "annual", "$169.99"), /12 months/, "the buy button does not show the period");
    assert.doesNotMatch(all, /\bunits?\b/i, '"units" is an internal weight and never reaches a screen');
    assert.equal(copy.LINKS.privacy, links.PRIVACY_URL);
    assert.equal(copy.LINKS.terms, links.APPLE_EULA_URL);
    assert.match(copy.LINKS.terms, /^https:\/\/www\.apple\.com\//, "the Terms link is not Apple's standard EULA");
  });

  await test("the refund sentence says credits are not returned, because they are not", () => {
    /* BILLING-PLAN's refund rule, in the words a student reads: the
       entitlement ends, the tier goes back to free, and credits already
       spent are not clawed back or handed back. Copy that implied a
       credit refund would be a promise the server does not keep. */
    assert.match(copy.DISCLOSURES.refund, /already spent stay spent|not.*returned/i);
    assert.match(copy.DISCLOSURES.refund, /Free/, "the refund sentence does not say what the plan becomes");
  });

  await test("web is told where plans are bought, and it is not a 'coming soon'", () => {
    const web = copy.unavailableLine("web");
    assert.match(web, /iPhone|Android/i, "web is not told where a plan can be bought");
    assert.doesNotMatch(web, /coming soon|soon/i, "a surface that will never sell must not promise that it will");
    assert.notEqual(copy.unavailableLine("no-key"), web, "a keyless build must not be indistinguishable from web");
    assert.equal(copy.unavailableLine(null), null, "an available capability has no unavailable sentence");
  });

  /* ---------- 6. the shared refresh signal ---------- */

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

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

await run();
