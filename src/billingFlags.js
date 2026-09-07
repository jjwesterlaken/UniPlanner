/* ==================================================================
   billingFlags.js — the one switch that turns web purchases on

   PHASE 6 IS BUILT AND OFF (Jared: "built behind a flag, tested against
   Stripe test mode, switched on with 1.1.0"). Everything works and
   nothing is reachable, so the diff can land, be reviewed and be tested
   against Stripe test mode without a student ever seeing a control that
   is not ready.

   TWO HALVES, AND THEY ARE DELIBERATELY NOT THE SAME SWITCH:

   1. **THE SERVER'S FLAG IS ITS CONFIGURATION.** billing-checkout,
      billing-portal and stripe-webhook each refuse with
      `stripe_disabled` unless their Stripe secrets are set. That cannot
      drift out of step with reality the way a boolean can — a boolean
      saying "on" beside an unset key is a button that fails after the
      click, which is the worst of the three states.
   2. **THE CLIENT'S FLAG IS THIS CONSTANT**, and it decides only
      whether the controls are DRAWN. Flipping it without configuring
      the server shows a button that comes back with `stripe_disabled`;
      configuring the server without flipping it changes nothing anyone
      can see. The order to do them in is therefore: configure, test
      against test mode, then flip this — which is exactly the order the
      instruction names.

   WHY A CONSTANT RATHER THAN AN ENVIRONMENT VALUE. `site/flags.js` does
   the same thing for the marketing prices, for the same reason: a
   switch that ships in a reviewable commit is a switch somebody
   approved. An environment variable flipped in a dashboard is a change
   with no diff, and this one decides whether the app takes money.

   THE PRECONDITIONS, so flipping it is a decision rather than a guess.
   BILLING-PLAN.md Phase 6 has the full list; the ones with no
   workaround are: migration 0019 applied, the three functions deployed
   (stripe-webhook with --no-verify-jwt), STRIPE_SECRET_KEY and
   STRIPE_WEBHOOK_SECRET set, the six Prices created with the
   `lookup_key`s in `_shared/stripe.ts`, and the Customer Portal
   configured — Stripe refuses to create a portal session until it has
   been set up once in the dashboard, which is a failure that only
   appears when a real student taps Manage.
   ================================================================== */

/** Draw the web purchase controls. See the preconditions above before flipping. */
export const STRIPE_ENABLED = false;

/* The tier/duration pairs the web can sell. DERIVED from the same table
   the phones use, so a plan added for the stores is not silently absent
   from the web — and so the two can never disagree about what exists,
   which is the drift a second hand-written list would guarantee. */
export { PACKAGE_PLANS as WEB_PLANS } from "./purchasePlans.js";
