/* ==================================================================
   entitlementRefresh.js — one signal, so every tier read moves at once

   THE PROBLEM IT SOLVES, in one sentence: a purchase happens on the
   Account tab and the allowance badge lives on the AI tab, so without
   a shared signal the badge shows the old plan until somebody happens
   to remount it — which is exactly the "not on next AI-tab mount"
   Jared ruled out.

   Three readers of `profiles.tier` exist (the AI allowance badge, the
   text-features allowance, and the Plans panel itself) and they are in
   three different places in the tree. A React context would work and
   would mean threading a provider through PlannerApp; a module-level
   version counter that components subscribe to costs three lines at
   each reader and nothing anywhere else. `useSyncExternalStore` is what
   consumes it.

   NOTHING HERE HOLDS AN ENTITLEMENT. It holds a NUMBER that changes
   when the entitlement might have. Every reader still asks the server;
   this only tells them when to ask again. That distinction is the whole
   reason it is safe: a bug here shows somebody a stale number for a few
   seconds, never a tier they have not got.
   ================================================================== */

import { ENTITLEMENT_POLL_DELAYS_MS } from "./purchasePlans.js";

let version = 0;
const listeners = new Set();

/** The current version. Stable between bumps, which is what useSyncExternalStore needs. */
export const entitlementVersion = () => version;

/** Subscribe; returns the unsubscribe, in the shape useSyncExternalStore wants. */
export function subscribeEntitlement(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Something may have changed the tier — every reader, ask again. */
export function bumpEntitlement() {
  version += 1;
  /* A copy, because a listener that unsubscribes itself while being
     notified would otherwise mutate the set mid-iteration. */
  for (const listener of [...listeners]) listener();
  return version;
}

/**
 * Re-read after a purchase, on a bounded ladder.
 *
 * WHY A LADDER AND NOT ONE READ. The purchase completes on the device,
 * RevenueCat then delivers a webhook, the webhook writes
 * `profiles.tier`, and only then does a re-read see the new plan. One
 * immediate read almost always lands before the webhook does, so the
 * panel would say Free to somebody who has just paid.
 *
 * WHY BOUNDED. A webhook that never arrives — a dead secret, a
 * misconfigured URL — would otherwise leave a client polling a database
 * forever, on every device that ever tried to buy. Four attempts over
 * ten seconds covers the ordinary case; past that the copy says the
 * plan is still activating, which is true, rather than that it failed,
 * which usually is not.
 *
 * Returns a cancel function, because the panel can unmount (a tab
 * change) between the first read and the last, and a timer that fires
 * into a dead component is how a React warning becomes a habit.
 */
export function refreshEntitlementSoon({ delays = ENTITLEMENT_POLL_DELAYS_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const handles = [];
  for (const ms of delays) {
    if (ms === 0) {
      bumpEntitlement();
      continue;
    }
    handles.push(setTimer(bumpEntitlement, ms));
  }
  return () => {
    for (const h of handles) clearTimer(h);
    handles.length = 0;
  };
}
