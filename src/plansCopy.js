/* ==================================================================
   plansCopy.js — every word the Plans panel says

   SEPARATE FROM THE PANEL for the reason all the copy modules in this
   project are: Grace reworks wording without touching logic, and a
   sentence that can be rendered can be asserted. scripts/test-purchases.mjs
   renders every one of these for every tier and checks them against
   what `allowanceForTier` actually says.

   THREE RULES IT IS WRITTEN UNDER, all of them older than this file:

   1. **No internal weight reaches a screen.** "Credits" is sayable —
      one credit is one minute of recorded lecture — and "units" is
      not. A test forbids the word.
   2. **A period is claimed only when it is true.** A trial tier's 60
      credits are ONCE EVER, so the reset sentence is a branch on
      `perMonth` rather than a constant. Telling a free student their
      allowance comes back in November is a support ticket and an angry
      one, and this module is in the all-of-src month sweep in
      test-help.mjs for exactly that reason.
   3. **Nothing here decides anything.** These are sentences about a
      tier that has already been decided by the server.

   AND ONE THAT IS APPLE'S RATHER THAN OURS: a subscription screen has
   required elements — the price, the period, that it auto-renews, how
   to cancel, a Restore control, and links to the terms and the privacy
   policy. A reviewer checks those by looking, not by running a test,
   so they are all here and named as what they are.
   ================================================================== */

import { allowanceForTier } from "./aiTextLimits.js";
import { PRIVACY_URL, APPLE_EULA_URL } from "./legalLinks.js";

/** What each tier is called on screen. `free` is a state, not a product. */
export const TIER_NAMES = {
  free: "Free",
  ai: "Study AI",
  ai_max: "Study AI Max",
};

/** How long a package lasts, in the words a student would use. */
export const DURATION_LABELS = {
  monthly: "1 month",
  sixmonth: "6 months",
  annual: "12 months",
};

/** The heading and the one line under it. */
export const PANEL_TITLE = "Your plan";

/**
 * What the student is on now, from `profiles.tier` — the server's
 * answer, never the store SDK's.
 *
 * THE UNKNOWN CASE IS NOT "FREE". A failed read means we could not ask,
 * and showing somebody the free plan because their train went into a
 * tunnel is the same mistake as showing them a paywall. It says so.
 */
export function currentPlanLine(tier) {
  if (!tier) return "We couldn't check your plan just now. Nothing has changed — try again when you're back online.";
  const { credits, perMonth } = allowanceForTier(tier);
  const name = TIER_NAMES[tier] || TIER_NAMES.free;
  return perMonth
    ? `You're on ${name}: ${credits} AI credits a month.`
    : `You're on ${name}: ${credits} AI credits to try the AI features.`;
}

/**
 * The reset rule, which is the sentence that BRANCHES.
 *
 * A paid tier resets on the 1st of the calendar month, in UTC, whatever
 * day the subscription was bought on — so a student who buys on the
 * 28th gets the rest of that month and then a full one. Saying that out
 * loud is better than letting somebody work it out on the 1st.
 *
 * A trial tier does not reset at all, and the sentence says the words
 * rather than leaving it to be inferred from an absence.
 */
export function resetLine(tier) {
  return allowanceForTier(tier).perMonth
    ? "Credits reset on the 1st of each calendar month (UTC), whichever day you subscribed."
    : "These credits are a one-off — they don't reset.";
}

/** The disclosures, in the order they are shown. */
export const DISCLOSURES = {
  autoRenew:
    "Subscriptions renew automatically at the end of each period until you cancel. " +
    "You can cancel any time from your store account, and you keep access until the period you have paid for ends.",
  noRollover: "Unused credits don't roll over. Each period starts fresh at the full amount.",
  refund:
    "If a subscription is refunded, the plan ends straight away and goes back to Free. " +
    "Credits you have already spent stay spent — a refund returns money, not credits.",
  managedByStore: "Payment is taken by the App Store or Google Play, not by us. We never see your card details.",
};

/** The three controls, named once so the tests and the panel agree. */
export const ACTIONS = {
  restore: "Restore Purchases",
  restoreHint: "Already subscribed on another device, or reinstalled? This brings your plan back.",
  manage: "Manage subscription",
  terms: "Terms of Use (EULA)",
  privacy: "Privacy Policy",
};

export const LINKS = { terms: APPLE_EULA_URL, privacy: PRIVACY_URL };

/** The buy button for one package. Price and period come from the STORE. */
export const buyLabel = (tier, duration, priceString) =>
  `${TIER_NAMES[tier] || tier} · ${DURATION_LABELS[duration] || duration}${priceString ? ` · ${priceString}` : ""}`;

/**
 * What to say after a purchase or restore, by outcome.
 *
 * A CANCELLATION SAYS NOTHING AT ALL. The student pressed Cancel; they
 * know what happened, and an error banner about it reads as a fault in
 * the app. Everything else gets a sentence, including the one nobody
 * likes: a purchase that went through while our side has not caught up
 * yet is "activating", not "failed", because it usually is.
 */
export function outcomeMessage(kind, reason) {
  if (reason === "cancelled") return null;
  if (kind === "purchase") {
    if (!reason) return "Thanks — your plan is being activated. This usually takes a few seconds.";
    return "That purchase didn't go through, and you haven't been charged. If your card was charged, tell us and we'll sort it out.";
  }
  if (kind === "restore") {
    if (!reason) return "Checked with the store. If there's a subscription on this account, your plan will update in a moment.";
    return "We couldn't reach the store to check. Nothing has changed — try again in a minute.";
  }
  return null;
}

/** Shown while the ladder in ENTITLEMENT_POLL_DELAYS_MS is still running. */
export const ACTIVATING_NOTICE = "Waiting for the store to confirm — you can keep using the app.";

/**
 * Why there are no purchase controls here.
 *
 * NOT A "COMING SOON" (Jared's ruling). On web and desktop the panel
 * shows the plan and stops; promising a feature on a surface that is
 * never going to have it is a worse sentence than saying where it is.
 * "no-key" is deliberately a DIFFERENT sentence from "web": one is a
 * correct permanent state and the other is a store build that forgot an
 * environment variable, and a screen that cannot tell them apart sends
 * whoever is debugging to the wrong place.
 */
export function unavailableLine(reason) {
  if (reason === "web") return "Plans are bought in the UniPlanner app on iPhone or Android. Your plan is the same everywhere you sign in.";
  if (reason === "no-key") return "In-app purchases aren't set up in this build.";
  if (reason === "unknown-platform") return "This device can't take payments.";
  return null;
}
