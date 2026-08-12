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

export const SITE_URL = "https://www.uniplannerapp.com";

/* Extensionless, because that is what Cloudflare Pages actually serves:
   the files are public/privacy.html and public/delete-account.html, but
   Pages 301-redirects /privacy.html -> /privacy. Linking the .html form
   works, via that redirect, but these are the canonical URLs and the
   ones in both app-store listings, so the app links to the same strings
   a reviewer will see. */
export const PRIVACY_URL = `${SITE_URL}/privacy`;
export const DELETE_ACCOUNT_URL = `${SITE_URL}/delete-account`;

/* Where a password-reset email sends someone back to.

   Derived from SITE_URL rather than left to the Supabase project's Site
   URL setting, because that setting pointed at the old host for an
   unknown period and nothing in the repo could have told us. Deriving it
   means the app and the email cannot disagree, and a host change is one
   edit here rather than a dashboard field somebody has to remember.

   IT MUST ALSO BE ON THE REDIRECT URLS ALLOWLIST in Supabase Auth
   settings. Supabase ignores an unlisted redirectTo and silently falls
   back to the Site URL, which is the failure that looks like the code is
   wrong when the configuration is. */
export const PASSWORD_RESET_REDIRECT = SITE_URL;

export const PRIVACY_EMAIL = "privacy@uniplannerapp.com";
export const SUPPORT_EMAIL = "support@uniplannerapp.com";
