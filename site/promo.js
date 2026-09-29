/* ==================================================================
   promo.js — the launch promotion, in ONE place

   Read by the marketing page's banner (public/site/site.js) and by the
   web app's plan panel (src/plans.jsx), so
   the code, the end date and the words cannot disagree between the two.

   THE CODE IS STRIPE'S. `UNI50` is a live Stripe promotion code:
   first-time customers, first payment only, expiring 30 November 2026.
   Checkout already accepts codes (`allow_promotion_codes` in
   billing-checkout), so nothing server-side changes for this — the
   banner and the line only tell somebody the code exists. What it
   discounts, and whether it still works, is Stripe's to decide at the
   moment of payment; a banner that outlived the code would be
   promising something Stripe then refuses.

   WEB ONLY. Neither surface mentions the apps or the App Store: a
   store purchase cannot take this code, and pointing a student inside
   a store build at a cheaper web price is exactly what App Review
   refuses. The app half renders only in the plan panel's WEB branch,
   which a native shell never reaches.

   IT COMES DOWN ON ITS OWN. Both surfaces ask `promoActive(now)` on
   every render, so the banner and the line stop appearing at
   PROMO_ENDS_AT with no redeploy — and scripts/test-promo.mjs mounts
   the built page on either side of it.

   THE END IS THE START OF 30 NOVEMBER IN SYDNEY, not the end of it.
   A banner that runs a day past the code is a student typing a code
   Stripe refuses; a banner that comes down a few hours early costs
   nothing. If Stripe's expiry is later than this, the code still
   works at checkout for anyone who already has it.

   Plain JS with no browser globals, so Node imports it directly.
   ================================================================== */

/** The Stripe promotion code, exactly as a student types it. */
export const PROMO_CODE = "UNI50";

/** When both surfaces stop showing it. AEDT is UTC+11 in November. */
export const PROMO_ENDS_AT = "2026-11-30T00:00:00+11:00";

/* The device-local key that remembers a dismissed banner, per code.
   A literal, not a template: the device-store guard in test-legal.mjs
   finds stores by their quoted "uni-planner-*" name, and a template
   would walk past it. The code is in the name so a future promotion
   is not hidden by an old dismissal; test-promo.mjs holds the two
   equal. */
export const PROMO_DISMISS_KEY = "uni-planner-promo-dismissed-UNI50";

/* THE WORDS, for Grace to rework. `{code}` is filled in from
   PROMO_CODE, so rewording can never leave a stale code on screen. */
export const PROMO_COPY = {
  /** The slim bar at the top of the marketing page. */
  banner: "To celebrate our launch, use the code {code} for 50% off your first payment.",
  /** The dismiss control's accessible name. */
  dismiss: "Dismiss",
  /** One line under the web app's plan buttons, where the code is typed. */
  planLine: "Launch offer: enter {code} at checkout for 50% off your first payment.",
};

const fill = (s) => s.replace(/\{code\}/g, PROMO_CODE);

/** Is the promotion still running at `now` (a Date or a millisecond count)? */
export function promoActive(now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return false;
  return t < Date.parse(PROMO_ENDS_AT);
}

/** The banner sentence, or null once the promotion has ended. */
export const promoBanner = (now) => (promoActive(now) ? fill(PROMO_COPY.banner) : null);

/** The plan-panel sentence, or null once the promotion has ended. */
export const promoPlanLine = (now) => (promoActive(now) ? fill(PROMO_COPY.planLine) : null);
