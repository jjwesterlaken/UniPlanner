/* ==================================================================
   stripeClient.js — the two calls the web makes to buy or manage

   Both are one-line wrappers around an Edge Function, and both exist
   rather than being inlined for the same reason `aiTextClient.js` does:
   **the gate belongs at the boundary, not only on the screen.**

   Every purchase control is behind `STRIPE_ENABLED && session` in the
   UI, which is right and is also one refactor away from being wrong.
   These refuse on their own, reusing the server's own codes so a
   student sees wording that already exists.

   NOTHING HERE NAMES A PRICE. The request carries a tier and a
   duration; the server resolves which Stripe Price that is. A client
   that could name the price could name a cheaper one — the same rule
   that makes the uid come from the JWT rather than the request body.
   ================================================================== */

import { SUPABASE_URL } from "./config.js";
import { STRIPE_ENABLED } from "./billingFlags.js";

async function callBilling(fn, { token, body = {}, fetchImpl = fetch, enabled = STRIPE_ENABLED }) {
  if (!enabled) {
    const err = new Error("Web purchases aren't switched on.");
    err.code = "stripe_disabled";
    throw err;
  }
  if (!token) {
    const err = new Error("You need to be signed in.");
    err.code = "unauthenticated";
    throw err;
  }
  const res = await fetchImpl(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* a non-JSON body is a gateway problem, handled below */
  }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error("Something went wrong.");
    err.code = (json && json.code) || "server_error";
    /* Carried through because the panel says something SPECIFIC for
       one of them: an account that already holds a store subscription
       is told where to manage it rather than that something failed. */
    err.store = json && json.store;
    throw err;
  }
  return json;
}

/** Start a Checkout session. Returns the URL to send the student to. */
export const startCheckout = ({ token, tier, duration, ...rest }) =>
  callBilling("billing-checkout", { token, body: { tier, duration }, ...rest });

/** Open Stripe's Customer Portal for this account's stored customer. */
export const openPortal = ({ token, ...rest }) => callBilling("billing-portal", { token, ...rest });
