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

   AND NOTHING REACHES THE PLUGIN BEFORE `configure` DOES. Observed on
   the device, first three native calls on a cold launch:

       Purchases.logOut
       Purchases.getOfferings   <- "Purchases must be configured before
       Purchases.configure         calling this function"

   Two separate orderings, both of them consequences of where the calls
   sit rather than of anything in this file:

     - `session` starts null and is restored asynchronously, so the
       effect that identifies the device fires ONCE with no session and
       logs out an SDK that was never configured. Harmless, and it is
       the first line in the log.
     - `configurePurchases` is called from an effect in `PlannerApp`
       and `loadPackages` from an effect in `PlansPanel`, which is its
       CHILD — and React runs child effects before parent effects. So
       the offering was always going to be requested first, on every
       launch, whatever either component intended.

   MOVING THE CALLS AROUND WOULD FIX THE SYMPTOM AND NOT THE RULE. The
   next component that asks for an offering, or a refactor that moves an
   effect, puts it straight back — and the failure is a provider error
   message a student never sees, on the screen that sells the paid tier.

   So the ordering is enforced HERE, where the plugin is spoken to.
   Every action that needs a configured SDK calls `ensureConfigured`
   first, which either returns the in-flight configure, or performs one.
   Whoever arrives first configures; everybody else awaits the same
   promise. Order stops being something anybody has to get right.

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

/* ---------- the configure gate ----------

   `configuredFor` is the app user id the SDK currently holds, or null if
   it holds none. `configuring` is the in-flight promise, so two callers
   racing produce ONE configure call and both wait on it rather than two
   configures and a coin toss about which identity wins.

   MODULE-LEVEL BECAUSE THE SDK IS. There is one plugin per app, it
   carries one identity at a time, and that identity outlives every
   component that might ask about it. Component state could not model
   it without one component owning a fact about the whole process. */
let configuredFor = null;
let configuring = null;

/**
 * Make sure the SDK knows who this is, and only then hand back.
 *
 * IDEMPOTENT BY APP USER ID: already configured for this account and it
 * resolves without touching the plugin, which is what makes it safe to
 * put in front of every action rather than only the first one.
 *
 * A FAILED CONFIGURE IS RETURNED, NOT SWALLOWED. The caller reports it
 * as its own failure — `loadPackages` answering `sdk-error` because the
 * SDK could not be configured is TRUE, and it is a far better answer
 * than calling getOfferings anyway and relaying a provider message
 * about configuration to a student who has no idea what that means.
 */
export async function ensureConfigured({ session, plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  const userId = session && session.user && session.user.id;
  if (!userId) return { ok: false, reason: "signed-out" };
  if (configuredFor === userId) return { ok: true, appUserId: userId, store: capability.store };
  if (configuring) {
    const pending = await configuring;
    /* The in-flight one may have been for somebody else — a sign-in that
       overtook a sign-out. Falling through re-configures for this id
       rather than reporting somebody else's success as ours. */
    if (pending.ok && configuredFor === userId) return pending;
  }
  configuring = (async () => {
    try {
      await plugin.configure({ apiKey: capability.apiKey, appUserID: userId });
      configuredFor = userId;
      return { ok: true, appUserId: userId, store: capability.store };
    } catch (error) {
      configuredFor = null;
      return { ok: false, reason: "sdk-error", error };
    } finally {
      configuring = null;
    }
  })();
  return configuring;
}

/**
 * Identify this device to RevenueCat as this account, and no other.
 *
 * Idempotent by design: called on sign-in and again whenever the signed
 * -in id changes. Failure is REPORTED, never thrown — a student whose
 * planner works must not lose it because a store SDK is having a bad
 * day, and all that is lost is the ability to buy.
 */
export const configurePurchases = ensureConfigured;

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
  /* NOTHING WAS CONFIGURED, SO THERE IS NOTHING TO FORGET. This is the
     first line in the device log: `session` is restored asynchronously,
     so the effect fires once with no session and logs out an SDK that
     has never been told anything. It rejected, which was reported as an
     ordinary state and was — but it is also a call to the plugin on
     every cold launch that says nothing and can only confuse the log
     somebody reads when the ordering is wrong. */
  if (configuredFor === null && configuring === null) return { ok: false, reason: "not-configured" };
  try {
    await plugin.logOut();
    configuredFor = null;
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
export async function loadPackages({ session, plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  /* THIS IS THE CALL THE DEVICE LOG CAUGHT. It runs from an effect in
     PlansPanel, which is a CHILD of the component that configures — and
     React runs child effects first, so it was always going to arrive
     first. Awaiting the gate rather than relying on where the two
     effects happen to sit is what makes that stop mattering. */
  const ready = await ensureConfigured({ session, plugin, capability });
  if (!ready.ok) return ready;
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
export async function purchasePackage(pkg, { session, plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  if (!pkg) return { ok: false, reason: "no-package" };
  const ready = await ensureConfigured({ session, plugin, capability });
  if (!ready.ok) return ready;
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
export async function restorePurchases({ session, plugin = Purchases, capability = purchaseCapability() } = {}) {
  if (!capability.available) return refuse(capability);
  /* NEVER ANONYMOUS, and this is the action where it would cost the
     most. Restore re-attaches a store receipt to whatever app user id
     the SDK currently holds, and without a session that is an anonymous
     one — which is precisely the delivery the webhook answers
     `no_account` to, with a real paid subscription attached to an
     account we do not have. `configurePurchases` has always refused
     without a session; this one did not, and the panel's own
     signed-out state was the only thing between them. A UI-only gate is
     one refactor from leaking. */
  const ready = await ensureConfigured({ session, plugin, capability });
  if (!ready.ok) return ready;
  try {
    const info = await plugin.restorePurchases();
    return { ok: true, customerInfo: info && info.customerInfo };
  } catch (error) {
    return { ok: false, reason: "sdk-error", error };
  }
}
