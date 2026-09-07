/* ==================================================================
   purchaseKeys.js — the two PUBLIC RevenueCat SDK keys

   WHERE THEY COME FROM: the environment, at BUILD time.

     REVENUECAT_IOS_KEY        an `appl_…` public SDK key
     REVENUECAT_ANDROID_KEY    a  `goog_…` public SDK key

   scripts/build-web.mjs reads those two environment variables and
   substitutes them into the bundle as `__REVENUECAT_IOS_KEY__` and
   `__REVENUECAT_ANDROID_KEY__`. Unset, they become "" — which this
   module reports as "purchases are not available", never as a crash.

   BUILD TIME AND NOT RUNTIME because a phone has no environment to
   read. The key that ships in an IPA or an AAB is the one that was in
   the environment when THAT bundle was built, so the store-build steps
   in MOBILE-BUILD.md name both variables. A web build with neither set
   is correct and complete: web sells nothing.

   THESE ARE MEANT TO BE PUBLIC. RevenueCat's SDK keys identify the app
   to RevenueCat and authorise nothing but the calls this app already
   makes on the student's behalf; the SECRET key (`sk_…`) lives only in
   the Edge Function's secrets and the leak gate in test-ai-notes.mjs
   forbids it from the bundle. `appl_`/`goog_` are deliberately NOT in
   that gate, because they are supposed to ship.

   WHY `typeof X === "string" ? X : ""` AND NOT `process.env.X`. esbuild
   substitutes exactly the expression named in `define`, and nothing
   else. `process.env.REVENUECAT_IOS_KEY` works only while somebody
   remembers to define that exact string — write it as
   `process.env["REVENUECAT_IOS_KEY"]` one day and the substitution
   stops, `process` is undefined in a browser, and the app throws. That
   is `import.meta.env` in a new costume, and it shipped once already.
   `typeof` on an UNDECLARED identifier is the one expression in
   JavaScript that cannot throw, so this module imports cleanly in Node
   (where the tests read it) and in a browser build that forgot the
   define — in both cases reporting no key rather than exploding.
   ================================================================== */

/* eslint-disable no-undef */
export const IOS_PUBLIC_KEY = typeof __REVENUECAT_IOS_KEY__ === "string" ? __REVENUECAT_IOS_KEY__ : "";
export const ANDROID_PUBLIC_KEY = typeof __REVENUECAT_ANDROID_KEY__ === "string" ? __REVENUECAT_ANDROID_KEY__ : "";

/** The environment variable each key is read from, named once. */
export const KEY_ENV_NAMES = {
  ios: "REVENUECAT_IOS_KEY",
  android: "REVENUECAT_ANDROID_KEY",
};

/** The build-time identifiers those variables are substituted into. */
export const KEY_DEFINE_NAMES = {
  ios: "__REVENUECAT_IOS_KEY__",
  android: "__REVENUECAT_ANDROID_KEY__",
};
