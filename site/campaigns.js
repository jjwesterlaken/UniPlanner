/* ==================================================================
   campaigns.js — one landing path per ad channel, counted server-side

   The site makes no third-party request and loads no tracking script,
   so there is no Google or Meta conversion tag and there will not be.
   What attribution is available without one is the REQUEST ITSELF:
   each channel's ads link to its own path, `/go/<channel>`, which
   Cloudflare answers with a redirect to `/`. The request for that path
   is counted by Cloudflare's own server-side analytics, the same as
   every request the site already serves: no script, no cookie, and
   nothing stored by us about anybody.

   A 302, NOT A 301. A browser caches a permanent redirect and never
   asks again, so the second click from the same browser would go
   straight to `/` and never be counted. A temporary redirect is asked
   for every time.

   WHAT IT COUNTS is clicks that reached the site, per channel. Not
   visitors (the same person clicking twice is two), not sign-ups, not
   purchases: nothing downstream of the landing can be tied back to it
   without the kind of tracking this site refuses. Stripe's own
   dashboard shows UNI50 redemptions, which is the nearest thing to a
   conversion count available.

   Adding a channel is adding a name here; the build writes the
   redirect and scripts/test-path-split.mjs checks it.
   ================================================================== */

/** Lower-case, URL-safe channel names. */
export const CAMPAIGN_CHANNELS = Object.freeze(["google", "reddit", "meta", "tiktok"]);

/** The path an ad for `channel` links to. */
export const campaignPath = (channel) => `/go/${channel}`;

/** Where every campaign path lands. */
export const CAMPAIGN_TARGET = "/";
