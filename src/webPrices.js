/* ==================================================================
   webPrices.js — what the web panel puts on a buy button

   DERIVED FROM `site/pricing.js`, which is the ONE place the figures
   live and which `scripts/test-site.mjs` already guards (real numbers,
   one currency, longer periods cheaper than the shorter ones they
   replace, and a flag that cannot disagree with them). A second copy in
   `src/` would be a restatement of a PRICE — the worst entry in that
   ledger, because the screen would promise one figure while Stripe
   charged another and nothing would notice.

   THE ONE MAPPING IT HAS TO DO: the site says `sixMonth`, the purchase
   tables say `sixmonth`. Two spellings of one period, in modules
   written months apart, and a silent mismatch here shows a blank price
   rather than a wrong one — which is why the mapping is a table with a
   test over it rather than a `.toLowerCase()` that happens to work.

   WHAT THIS CANNOT PROMISE, said here rather than implied: that the
   Stripe Price actually charges this. Stripe holds its own amounts, set
   in its dashboard, and no test in this repository can read them.
   Creating the six Prices AT THESE FIGURES is a precondition in
   `src/billingFlags.js` and in BILLING-PLAN Phase 6, and confirming it
   is a step in Stripe test mode — not something a green suite says.
   ================================================================== */

import { TIERS, priceLabel } from "../site/pricing.js";

/** The purchase tables' duration ids, to the site's period ids. */
export const PERIOD_FOR_DURATION = {
  monthly: "monthly",
  sixmonth: "sixMonth",
  annual: "annual",
};

/**
 * "$8.99 AUD" for a (tier, duration), or null when there is no figure.
 *
 * Null rather than a guess, and the caller renders the button without a
 * price rather than inventing one — the same rule the site's own
 * placeholder path follows.
 */
export function webPriceLabel(tier, duration) {
  const period = PERIOD_FOR_DURATION[duration];
  if (!period) return null;
  const entry = TIERS.find((t) => t.id === tier);
  if (!entry) return null;
  return priceLabel(entry, period);
}
