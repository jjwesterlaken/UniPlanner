/* ==================================================================
   appReview.js — the plugin half, and nothing that can be decided
   without a handset

   THE SPLIT IS THE purchases.js ARRANGEMENT and it is forced rather
   than chosen: a module that imports a Capacitor plugin cannot be
   loaded by a plain-Node test, so everything decidable — when to ask,
   how often, what a failure means — lives in `reviewPrompt.js`, which
   imports nothing. This file is the part that genuinely needs the
   bridge, kept as small as it can be so there is nothing in it worth
   testing that isn't tested there.

   WHAT THE PLATFORM API ACTUALLY IS, because the name oversells it:
   `requestReview` is a REQUEST. iOS shows the prompt at most three
   times a year per app and may show nothing at all; Android's is
   quota-limited in ways Google does not publish. Nothing it returns
   says whether a human saw anything. So there is no success to report,
   no retry to schedule, and `reviewPrompt.js` records that WE ASKED
   rather than that a prompt appeared — the readback rule, one API
   over: a resolved promise is a receipt for the request, not evidence
   of the result.
   ================================================================== */

import { Capacitor } from "@capacitor/core";
import { InAppReview } from "@capacitor-community/in-app-review";
import { askForReviewOnce } from "./reviewPrompt.js";

/* `typeof localStorage` cannot throw, but READING it can — a sandboxed
   iframe raises a SecurityError on the property access itself, not on
   getItem. So the resolution is inside a try of its own, and a failure
   means no storage, which the caller turns into no ask. */
function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (e) {
    return null;
  }
}

/**
 * Ask for a review, if this device has never been asked.
 *
 * Every argument is injectable so the browser test can drive the real
 * bundled function with a faked bridge — the arrangement
 * `test-purchases.mjs` uses to prove the store SDK is never spoken to
 * off a native shell, which is a claim about behaviour and cannot be
 * made by reading the source.
 *
 * It is `void`-safe by construction: `askForReviewOnce` catches the
 * plugin's own failure, and the caller is a save path that must not
 * care. There is deliberately nothing here for a caller to await on
 * for correctness.
 */
export async function maybeAskForReview({
  isNative = Capacitor.isNativePlatform(),
  platform = Capacitor.getPlatform(),
  storage = defaultStorage(),
  plugin = InAppReview,
} = {}) {
  /* No storage means no way to record that we asked, and the ordering
     rule says an unrecordable ask must not happen — so refuse here
     rather than handing `askForReviewOnce` a null it would have to
     defend against. */
  if (!storage) return { asked: false, reason: "no-storage" };
  return askForReviewOnce({
    isNative,
    platform,
    storage,
    request: () => plugin.requestReview(),
  });
}
