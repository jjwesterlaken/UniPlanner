/* ==================================================================
   purchases.js — the ONE place the store SDK is spoken to

   THE RULE THIS FILE EXISTS TO HOLD: **no call reaches the plugin
   unless the app is running in a native shell, with a real key, for a
   signed-in account.** Every exported action asks the capability first
   and returns a refusal WITHOUT touching the plugin when the answer is
   no. That is structural rather than conventional — it is the first
   statement of every function — and scripts/test-purchases.mjs drives
   all of them against a TRACED fake on a web-shaped environment and
   asserts the trace is empty.

   WHY IT MATTERS ON WEB SPECIFICALLY. The web build promises that
   nothing third-party is contacted (public/privacy.html, pinned by
   scripts/test-local-only.mjs). The plugin's own web implementation
   REJECTS rather than calling out — verified in the package: its web
   fallback throws "Web not supported in this plugin." — so the promise
   survives either way. But an unhandled rejection on a screen somebody
   is looking at is its own defect, and "the SDK is in the bundle and
   never spoken to" is a far easier sentence to keep true than "the SDK
   is spoken to and always says no".

   NEVER ANONYMOUS (Jared, Phase 2). `configure` is called with the
   Supabase user id as the app user id, and only after sign-in. An
   anonymous RevenueCat id produces exactly the delivery the webhook
   answers `no_account` to — a purchase attached to an account we do not
   have — and would then need aliasing when the student signed in.
   Signing out logs the SDK out, so the next account on a shared handset
   does not inherit the last one's identity.

   THE SERVER REMAINS THE TRUTH about entitlement. Nothing here reads
   `customerInfo.entitlements` to decide a tier: the webhook writes
   `profiles.tier` and the client reads that. This file starts a
   purchase and reports what happened; it grants nothing. The one thing
   taken off `customerInfo` is `managementURL`, and that is a LINK.

   IT CANNOT BE IMPORTED BY A PLAIN-NODE TEST. The RevenueCat package
   ships extensionless relative imports (`./definitions`), which esbuild
   resolves and Node's ESM loader refuses. That is why every decidable
   thing lives in purchasePlans.js and why this file's own tests go
   through an esbuild bundle — the artifact, rather than the source.
   ================================================================== */

import { Capacitor } from "@capacitor/core";
import { Purchases } from "@revenuecat/purchases-capacitor";
import { IOS_PUBLIC_KEY, ANDROID_PUBLIC_KEY } from "./purchaseKeys.js";
import { capabilityFrom } from "./purchasePlans.js";

/** The live answer for this shell, with the pure rule doing the deciding. */
export const purchaseCapability = ({
  isNative = Capacitor.isNativePlatform(),
  platform = Capacitor.getPlatform(),
  iosKey = IOS_PUBLIC_KEY,
  androidKey = ANDROID_PUBLIC_KEY,
} = {}) => capabilityFrom({ isNative, platform, iosKey, androidKey });

/* Every action funnels through this, so "the plugin is not touched off a
   native shell" is one expression rather than five copies of it. */
const refuse = (cap) => ({ ok: false, reason: cap.reason });

/**
 * Identify this device to RevenueCat as this account, and no other.
 *
 * Idempotent by design: called on sign-in and again whenever the signed
 * -in id changes. Failure is REPORTED, never thrown — a student whose
 * planner works must not lose it because a store SDK is having a bad
 * day, and all that is lost is the ability to buy.
 */
export async function configurePurchases({ session, plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  const userId = session && session.user && session.user.id;
  if (!userId) return { ok: false, reason: "signed-out" };
  try {
    await plugin.configure({ apiKey: capability.apiKey, appUserID: userId });
    return { ok: true, appUserId: userId, store: capability.store };
  } catch (error) {
    return { ok: false, reason: "sdk-error", error };
  }
}

/**
 * Forget the account on sign-out.
 *
 * The SDK falls back to an anonymous id of its own afterwards, which is
 * fine — nothing is bought while signed out, and the next sign-in
 * configures again. What must not happen is the next student on a
 * shared handset inheriting the last one's app user id.
 */
export async function logOutPurchases({ plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  try {
    await plugin.logOut();
    return { ok: true };
  } catch (error) {
    /* Logging out an SDK that was never configured rejects, and that is
       an ordinary state rather than a fault worth showing anybody. */
    return { ok: false, reason: "sdk-error", error };
  }
}

/**
 * The packages a student can buy, or a reason there are none.
 *
 * THREE OUTCOMES, KEPT DISTINCT — the `fetchNote` rule again: packages,
 * a definitive EMPTY offering (nothing configured in the dashboard
 * yet), and a FAILED read. The panel must never say "no plans
 * available" when it means "we could not ask": that is a paywall caused
 * by a tunnel, on the screen that sells the paid tier.
 */
export async function loadPackages({ plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  try {
    const offerings = await plugin.getOfferings();
    const current = offerings && offerings.current;
    return { ok: true, packages: (current && current.availablePackages) || [], offering: (current && current.identifier) || null };
  } catch (error) {
    return { ok: false, reason: "sdk-error", error };
  }
}

/**
 * Buy one package.
 *
 * A CANCELLATION IS NOT A FAILURE. Telling somebody "something went
 * wrong" because they pressed Cancel is how a support ticket gets
 * written about a purchase flow that worked perfectly. The SDK reports
 * it on the rejection rather than as a result, so it is unpicked here
 * and returned as its own outcome.
 */
export async function purchasePackage(pkg, { plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  if (!pkg) return { ok: false, reason: "no-package" };
  try {
    const result = await plugin.purchasePackage({ aPackage: pkg });
    return { ok: true, customerInfo: result && result.customerInfo };
  } catch (error) {
    if (error && (error.userCancelled === true || /cancel/i.test(String(error.message || "")))) {
      return { ok: false, reason: "cancelled" };
    }
    return { ok: false, reason: "sdk-error", error };
  }
}

/**
 * Restore Purchases.
 *
 * APPLE REQUIRES A VISIBLE CONTROL FOR THIS, which is why the panel has
 * a button rather than doing it quietly at launch: a student who
 * reinstalls, or signs in on a second handset, has to be able to say "I
 * already paid" and be believed. It re-reads the store receipt and
 * re-attaches it to the configured app user id, which is what makes
 * RevenueCat send the webhook that writes the tier.
 */
export async function restorePurchases({ plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  try {
    const info = await plugin.restorePurchases();
    return { ok: true, customerInfo: info && info.customerInfo };
  } catch (error) {
    return { ok: false, reason: "sdk-error", error };
  }
}
