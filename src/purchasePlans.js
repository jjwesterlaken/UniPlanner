/* ==================================================================
   purchasePlans.js — everything about selling that is PURE

   The store SDK lives one module over, in purchases.js, and this file
   imports nothing from it. That split is not tidiness: the RevenueCat
   package ships extensionless relative imports, which esbuild resolves
   and Node's ESM loader refuses, so a module that touches the SDK
   cannot be imported by a plain-Node test at all. Everything decidable
   without a handset therefore lives here, where the awkward cases are a
   table in scripts/test-purchases.mjs rather than something only a real
   phone in a sandbox can answer.

   What is here: which store a platform is, whether this build can sell
   anything, which tier and duration a package is, where a student
   manages a subscription, and how long to wait for the server to catch
   up after a purchase. What is NOT here: any decision about what a
   student is entitled to. The webhook writes `profiles.tier` and the
   client reads it; nothing in the client grants anything.
   ================================================================== */

/* The two `profiles.store` values a purchase can produce — the same
   strings migration 0017's CHECK allows and the ones
   _shared/entitlement.ts maps RevenueCat's own names onto. */
export const STORE_FOR_PLATFORM = { ios: "app_store", android: "play_store" };

/* Where a student manages a subscription when the SDK has given us no
   account-specific `managementURL` — which is every case before there
   is an active subscription, and every case where the read failed.
   Neither Apple nor Google lets an app cancel a subscription, so this
   is a LINK OUT and there is no version of this screen that could do
   it in-app. */
export const STORE_MANAGEMENT_URL = {
  app_store: "https://apps.apple.com/account/subscriptions",
  play_store: "https://play.google.com/store/account/subscriptions",
};

/**
 * Can this build sell anything, on this platform, with these keys?
 *
 * THE REASONS ARE DISTINCT ON PURPOSE. "web" and "no-key" look
 * identical to a student — no purchase controls — and are completely
 * different to whoever is debugging: the first is correct and
 * permanent, the second is a store build that forgot an environment
 * variable and would ship a paid app that cannot take money.
 */
export function capabilityFrom({ isNative, platform, iosKey, androidKey } = {}) {
  if (!isNative) return { available: false, reason: "web", store: null, apiKey: "" };
  const store = STORE_FOR_PLATFORM[platform] || null;
  if (!store) return { available: false, reason: "unknown-platform", store: null, apiKey: "" };
  const apiKey = (platform === "ios" ? iosKey : androidKey) || "";
  if (!apiKey) return { available: false, reason: "no-key", store, apiKey: "" };
  return { available: true, reason: null, store, apiKey };
}

/* THE SIX PACKAGES OF THE `default` OFFERING, keyed by the package
   identifier entered in the RevenueCat dashboard (Phase 3).

   WHY THE PACKAGE ID AND NOT THE PRODUCT ID: the product identifier has
   a different SHAPE on each store — Apple's is one id per period
   (`uniplanner.studyai.monthly`), Play's is a subscription plus a base
   plan — so a client that keyed on it would need two rules and would be
   guessing at how RevenueCat reports the Play half. The package id is a
   value WE choose, once, and it is the same string on both stores.

   IT IS A RESTATEMENT OF A DASHBOARD, which this project has a ledger
   about, so two things guard it: a test asserts these six ids are
   exactly the tier/duration pairs BILLING-PLAN.md's product table
   names, and an UNRECOGNISED package is still SHOWN (see
   `groupPackages`) rather than hidden. Hiding something a student is
   entitled to buy because our table was mistyped is the worse
   failure of the two. */
export const PACKAGE_PLANS = {
  studyai_monthly: { tier: "ai", duration: "monthly" },
  studyai_sixmonth: { tier: "ai", duration: "sixmonth" },
  studyai_annual: { tier: "ai", duration: "annual" },
  studyaimax_monthly: { tier: "ai_max", duration: "monthly" },
  studyaimax_sixmonth: { tier: "ai_max", duration: "sixmonth" },
  studyaimax_annual: { tier: "ai_max", duration: "annual" },
};

/** Shortest first, so a row of buttons reads cheapest-commitment first. */
export const DURATION_ORDER = ["monthly", "sixmonth", "annual"];

/** The paid tiers, cheapest first. `free` is not sold. */
export const SELLABLE_TIERS = ["ai", "ai_max"];

/**
 * The offering's packages, grouped for rendering.
 *
 * Returns `{ tiers: [{ tier, packages: [...] }], unrecognised: [...] }`.
 * The second half is the point: a package whose identifier is not in
 * the table above still comes back, so the panel can render it plainly
 * instead of silently dropping a plan somebody could have bought.
 */
export function groupPackages(packages = []) {
  const byTier = new Map(SELLABLE_TIERS.map((t) => [t, []]));
  const unrecognised = [];
  for (const pkg of packages) {
    const plan = PACKAGE_PLANS[pkg && pkg.identifier];
    if (!plan || !byTier.has(plan.tier)) {
      unrecognised.push(pkg);
      continue;
    }
    byTier.get(plan.tier).push({ pkg, ...plan });
  }
  for (const list of byTier.values()) {
    list.sort((a, b) => DURATION_ORDER.indexOf(a.duration) - DURATION_ORDER.indexOf(b.duration));
  }
  return {
    tiers: SELLABLE_TIERS.map((tier) => ({ tier, packages: byTier.get(tier) })).filter((g) => g.packages.length > 0),
    unrecognised,
  };
}

/**
 * Where to send somebody who wants to cancel or change their plan.
 *
 * `managementURL` is the account-specific page the SDK hands back once
 * there is a subscription; the constant is the same store's generic
 * page otherwise. Anything that is not an https URL is ignored rather
 * than rendered — a link is the one thing on this panel that leaves the
 * app, and it must not be able to leave it anywhere unexpected.
 */
export function manageSubscriptionUrl({ customerInfo = null, store = null } = {}) {
  const fromSdk = customerInfo && customerInfo.managementURL;
  if (typeof fromSdk === "string" && /^https:\/\//.test(fromSdk)) return fromSdk;
  return STORE_MANAGEMENT_URL[store] || null;
}

/* HOW LONG TO KEEP RE-READING `profiles` AFTER A PURCHASE, and the gap
   it covers is real and unavoidable. The purchase completes on the
   device; RevenueCat then delivers a webhook; the webhook writes
   `profiles.tier`; and the client learns the new tier by re-reading OUR
   OWN SERVER rather than by trusting the SDK — which is the same
   "the subscriber record is the truth" rule, seen from the client end.
   Between those there is a second or two in which the panel would still
   say Free for somebody who has just paid, and that reads as a purchase
   that did not work.

   So it re-reads on a short ladder. BOUNDED, because an unbounded poll
   after a webhook that never arrives is a client hammering a database
   forever; and when the ladder runs out the copy says the plan is still
   activating rather than that anything failed, because it usually is. */
export const ENTITLEMENT_POLL_DELAYS_MS = [0, 2000, 5000, 10000];
