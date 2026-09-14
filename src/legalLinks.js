/* ==================================================================
   legalLinks.js — where the published documents live

   Absolute URLs on purpose. These are linked from inside the app, from
   the consent screen, and from two app-store listings, and a store
   listing cannot be edited as easily as a deploy. Relative links would
   also break in the Electron build, which loads over file://, and in
   the Capacitor builds, which load from capacitor://localhost and
   http://localhost — none of which can resolve /privacy.html locally.

   Kept as constants rather than typed inline so the app, the consent
   text and the pages themselves can never drift to different URLs.

   The pages are served as plain static files from public/, and the
   service worker treats both these paths as network-only so a stale
   copy of a legal document can never be served from a cache.
   ================================================================== */

/* ==================================================================
   ONE ORIGIN, TWO HOSTNAMES, TWO PATHS — and the "one origin" half is
   the whole design rather than a detail.

   After the path split:

     uniplannerapp.com/          the marketing site
     www.uniplannerapp.com/      the same bundle, same content
     www.uniplannerapp.com/app   the planner

   `app.uniplannerapp.com` WAS PROPOSED AND RULED OUT, twice — most
   recently on 21 August 2026 and again on 14 September after a working
   subdomain branch was built and held. A subdomain is a different
   ORIGIN; `localStorage` is scoped per origin; and every planner
   belonging to somebody without an account lives only there. The
   subdomain branch carried a same-site iframe bridge to rescue those
   planners, and the two reasons it was refused are worth keeping
   because they are the reasons this file looks the way it does:

     - the bridge could not reach a browser that never opened the new
       origin, an installed PWA, or any other device — so the rescue
       had holes that read to a student as "the app lost my notes"
     - and it rested on same-site iframe storage behaviour that no
       build machine here can verify, Safari least of all

   A PATH change on the SAME origin needs no rescue, because nothing
   moves: `localStorage` is not scoped by path. That is the entire
   argument, and it is why `APP_URL` below is a path and not a host.
   ================================================================== */
export const SITE_URL = "https://www.uniplannerapp.com";

/* The apex, which serves the same bundle as `www`. Named because the
   deploy and the tests are written over both, and a hostname typed in
   three places is the restatement this file exists to avoid. */
export const SITE_APEX_URL = "https://uniplannerapp.com";

/** Every hostname the site answers on. Both serve everything. */
export const SITE_ORIGINS = [SITE_APEX_URL, SITE_URL];

/* WHERE THE PLANNER LIVES — a path on SITE_URL, so it is the same
   origin as the marketing site and the same origin the app has been
   served from since 12 August 2026. Nothing in any browser's storage
   moves when this ships. */
export const APP_URL = `${SITE_URL}/app`;

/* Extensionless, because that is what Cloudflare Pages actually serves:
   the files are public/privacy.html and public/delete-account.html, but
   Pages 301-redirects /privacy.html -> /privacy. Linking the .html form
   works, via that redirect, but these are the canonical URLs and the
   ones in both app-store listings, so the app links to the same strings
   a reviewer will see. */
/* THE DOCUMENTS ARE ONE LIST, AND THE CONSTANTS DERIVE FROM IT — which
   is a restructure the path split forced rather than a tidy-up.

   Three separate derivations (the site build, test-legal.mjs and
   test-service-worker.mjs) each found the published documents by
   matching every `*_URL` that sits under SITE_URL. That was exact
   while every such constant WAS a document. `APP_URL` is now
   `${SITE_URL}/app`, so all three began reporting the planner as a
   published legal document and demanding a `public/app.html` to serve
   at it.

   Subtracting APP_URL in each of the three places would be the
   restatement pattern with the sign flipped — a list of what is NOT a
   document, maintained in triplicate. So the documents are data here,
   the individual constants are built from that data, and a consumer
   asks for `DOCUMENT_PATHS` instead of inferring it from a shape.
   Adding a fifth document is one entry plus its constant, and the test
   that every under-SITE_URL constant except APP_URL appears in this
   list is what catches doing only half of that. */
const DOCUMENTS = {
  privacy: "/privacy",
  deleteAccount: "/delete-account",
  terms: "/terms",
  support: "/support",
};

/** Every published document's path, and its URL. Never the app. */
export const DOCUMENT_PATHS = Object.freeze(Object.values(DOCUMENTS));
export const DOCUMENT_URLS = Object.freeze(DOCUMENT_PATHS.map((p) => `${SITE_URL}${p}`));

export const PRIVACY_URL = `${SITE_URL}${DOCUMENTS.privacy}`;
export const DELETE_ACCOUNT_URL = `${SITE_URL}${DOCUMENTS.deleteAccount}`;
export const TERMS_URL = `${SITE_URL}${DOCUMENTS.terms}`;
/* THE SUPPORT URL IS IN APP STORE CONNECT, which is why it is here
   rather than typed into the site footer. A store listing cannot be
   edited as easily as a deploy, and Apple rejects a Support URL that
   does not resolve — so this path is load-bearing in a way the others
   are only after somebody clicks. */
export const SUPPORT_URL = `${SITE_URL}${DOCUMENTS.support}`;

/* Where a password-reset email sends someone back to.

   Derived from SITE_URL rather than left to the Supabase project's Site
   URL setting, because that setting pointed at the old host for an
   unknown period and nothing in the repo could have told us. Deriving it
   means the app and the email cannot disagree, and a host change is one
   edit here rather than a dashboard field somebody has to remember.

   IT MUST ALSO BE ON THE REDIRECT URLS ALLOWLIST in Supabase Auth
   settings. Supabase ignores an unlisted redirectTo and silently falls
   back to the Site URL, which is the failure that looks like the code is
   wrong when the configuration is. This has bitten this project before.

   THE ALLOWLIST NEEDS NO NEW ENTRY FOR THE SPLIT, and that is a
   consequence of choosing a path rather than a host:
   `https://www.uniplannerapp.com/**` already covers `/app`. The Site
   URL setting should still move, because that is where Supabase falls
   back to when a `redirectTo` is rejected — and a fallback landing on
   the marketing page is the same silent failure one layer down.

   IT IS `APP_URL` NOW, NOT `SITE_URL`, and the reason is sharp.
   Supabase puts the recovery token in the URL FRAGMENT. Sent to
   SITE_URL after the split it lands on the marketing page, which has
   no `PasswordRecovery` overlay and no `detectSessionInUrl` — so the
   token is consumed by a page that cannot use it. Tokens are
   single-use: the reset does not fail loudly, it just never works.

   Builds already in the stores carry the OLD value, so the marketing
   page forwards a recovery fragment to `/app/`. That forwarder is
   required, not a courtesy. */
export const PASSWORD_RESET_REDIRECT = APP_URL;

export const PRIVACY_EMAIL = "privacy@uniplannerapp.com";
export const SUPPORT_EMAIL = "support@uniplannerapp.com";

/* APPLE'S STANDARD EULA. It WAS the Terms of Use outright (Jared, Phase
   0: a UniPlanner Terms document is a Phase 6 prerequisite, not a 1.1.0
   one). Phase 6 has arrived, `TERMS_URL` now exists, and the division
   between them is this:

   - OUR terms govern the service, and a purchase made on the WEB, where
     Apple has nothing to do with it and its licence would be a document
     about the wrong transaction.
   - APPLE'S licence governs a purchase made inside the iOS app, in
     addition to ours. Section 10 of our document says so and links
     here, which is what lets the native panel keep offering this link —
     Apple's review expects it, and removing it to look tidy is the
     wrong trade.

   So `termsLink` in plansCopy.js picks by platform rather than one of
   these winning outright.

   IT IS APPLE'S URL AND NOT OURS, which is the single exception to
   everything else in this file. It is here rather than typed into the
   Plans panel for the same reason as the rest: the app, the store
   listing metadata and the document must not drift to different
   strings, and a store listing cannot be edited as easily as a deploy. */
export const APPLE_EULA_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
