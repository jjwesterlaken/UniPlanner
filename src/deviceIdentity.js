/* ==================================================================
   deviceIdentity.js — one device at a time, on the trial tiers

   Pure, like srs.js and audioSources.js: nothing here reads a browser
   global, so the whole decision table is a Node test rather than
   something only two phones can answer.

   WHAT THE RULE IS FOR. A trial tier's 60 credits are once ever. One
   login shared across a household multiplies that by however many
   devices sign in, and the allowance is the only thing between a free
   account and unbounded provider spend. A monthly tier buys a monthly
   allowance and where it is spent is the student's business, so the
   rule does not apply to them — and that branch lives in exactly ONE
   place (`appliesTo` below), because two copies of "which tiers does
   this cover" is two chances to enforce it on somebody who paid.

   WHAT IT IS NOT. It is friction, not device binding. The id is minted
   here and kept in localStorage, so clearing site data mints a new one
   and two browsers on one machine are two devices. Anything stronger
   means fingerprinting, which this app does not do and whose privacy
   policy says it does not. The goal is that casually sharing a login
   stops working, not that a determined person cannot.
   ================================================================== */

import { isTrialTier } from "./aiTextLimits.js";

/* THE ID IS THE ONE THE APP ALREADY HAS. `getDeviceId()` in sync.js has
   minted a per-device id into `uni-planner-device-id` since long before
   this rule existed, for telling devices apart during a merge. Minting a
   second one here would be two names for one fact — the exact shape that
   let `isFree` and `perMonth` drift apart — so this module takes the id
   as an argument and stays pure, and `sync.js` remains the only place a
   device id is created.

   It also means there is no new device store to declare in the privacy
   documents: `uni-planner-device-id` is already enumerated there.

   ONE VALUE MUST NOT BE TREATED AS AN IDENTITY. `getDeviceId()` returns
   the literal "unknown-device" when localStorage refuses — Safari
   private browsing, a locked-down WebView. That string is the SAME on
   every device it happens to, so two of them would each read as holding
   the account and the rule would silently not apply; worse, treating it
   as absent would re-claim on every check and write in a loop. It is
   neither, so it reads as `unknown`: we cannot say which device this
   is, so we change nothing. */
export const UNIDENTIFIED = "unknown-device";

/** Whether the one-device rule covers this tier at all. The only branch. */
export const appliesTo = (tier) => isTrialTier(tier);

/**
 * Where this device stands, given what the account's profile says.
 *
 * FOUR OUTCOMES, and the fourth is the one that matters. `unknown` is
 * not a polite way of saying no — it means the profile could not be
 * read, and the only safe response to that is to change nothing. A
 * student on a train going through a tunnel must not be signed out of
 * their planner because a request failed; that is the fetchNote rule,
 * and it is why this takes a `profile` that may be null and reports the
 * difference rather than collapsing it.
 *
 *   "exempt"     the tier does not have this rule
 *   "unknown"    we could not read the profile — do nothing
 *   "unclaimed"  nobody holds the account yet, or we do not know who we
 *                are — claim it
 *   "ours"       this device holds it
 *   "displaced"  another device holds it, definitively
 */
export function deviceStanding({ tier, localId, profile }) {
  if (!appliesTo(tier)) return { status: "exempt" };
  if (localId === UNIDENTIFIED) return { status: "unknown" };
  if (!profile) return { status: "unknown" };
  const held = profile.active_device_id || null;
  if (!held) return { status: "unclaimed" };
  /* No local id and a claim on the server is still "unclaimed" rather
     than "displaced". A device whose storage was cleared cannot prove
     it is the holder, and refusing it would be indistinguishable from
     refusing a genuine second device — but signing someone out because
     their browser dropped localStorage is the worse of the two errors,
     and re-claiming is what a real second sign-in would do anyway. */
  if (!localId) return { status: "unclaimed" };
  return held === localId ? { status: "ours" } : { status: "displaced", since: profile.active_device_at || null };
}

/** Whether this standing means the session should end. Only one does. */
export const shouldSignOut = (standing) => !!standing && standing.status === "displaced";

/** Whether this standing means we should claim the account for this device. */
export const shouldClaim = (standing) => !!standing && standing.status === "unclaimed";
