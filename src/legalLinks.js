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
   TWO ORIGINS, AND WHICH IS WHICH IS THE WHOLE POINT OF THIS BLOCK.

   The origin split (see SITE-DEPLOY.md) puts the marketing site on
   `uniplannerapp.com` AND `www.uniplannerapp.com`, and moves the app
   to `app.uniplannerapp.com`.

   `SITE_URL` DID NOT MOVE, deliberately. It is where the published
   LEGAL DOCUMENTS live, and those URLs are in two app-store listings
   and in a Stripe dashboard field — a store listing cannot be edited
   as easily as a deploy, and Apple rejects a Support URL that does not
   resolve. So the documents keep the URLs they were published under,
   the site build serves them there, and nothing a reviewer has already
   been given stops working.

   `APP_URL` is new and is where the PLANNER lives. Anything that sends
   a person to the app — a password-reset email, a Stripe return, the
   marketing page's buttons — points here and not at SITE_URL.

   THE CONSEQUENCE THAT IS NOT OBVIOUS: these are different ORIGINS, so
   `localStorage`, IndexedDB and the Supabase session do not cross
   between them. See src/originHandover.js for what is done about the
   planner, and for what could not be.
   ================================================================== */
export const SITE_URL = "https://www.uniplannerapp.com";

/* The apex, which serves the same marketing bundle as `www`. Named
   because the redirect rules and the frame-ancestors allowance are
   written over both, and a list of origins typed in three places is
   the restatement this file exists to avoid. */
export const SITE_APEX_URL = "https://uniplannerapp.com";

/** Every origin the marketing site answers on. */
export const SITE_ORIGINS = [SITE_APEX_URL, SITE_URL];

/* WHERE THE PLANNER LIVES. A separate origin, which is the thing to
   keep in mind before adding anything that assumes one storage area:
   a value written on SITE_URL cannot be read here and vice versa. */
export const APP_URL = "https://app.uniplannerapp.com";

/* Extensionless, because that is what Cloudflare Pages actually serves:
   the files are public/privacy.html and public/delete-account.html, but
   Pages 301-redirects /privacy.html -> /privacy. Linking the .html form
   works, via that redirect, but these are the canonical URLs and the
   ones in both app-store listings, so the app links to the same strings
   a reviewer will see. */
export const PRIVACY_URL = `${SITE_URL}/privacy`;
export const DELETE_ACCOUNT_URL = `${SITE_URL}/delete-account`;
export const TERMS_URL = `${SITE_URL}/terms`;
/* THE SUPPORT URL IS IN APP STORE CONNECT, which is why it is here
   rather than typed into the site footer. A store listing cannot be
   edited as easily as a deploy, and Apple rejects a Support URL that
   does not resolve — so this path is load-bearing in a way the others
   are only after somebody clicks. */
export const SUPPORT_URL = `${SITE_URL}/support`;

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

   IT IS `APP_URL` NOW, NOT `SITE_URL`, and that is the origin split's
   sharpest edge. Supabase puts the recovery token in the URL FRAGMENT.
   Sent to SITE_URL after the split it lands on the marketing page,
   which has no `PasswordRecovery` overlay and no `detectSessionInUrl` —
   so the token is consumed by a page that cannot use it and the reset
   never works, silently, once, per link.

   Builds already in the stores have the OLD value baked in, so the
   marketing page forwards a recovery fragment to the app (see
   public/site/site.js). That forwarder is required, not a courtesy. */
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
