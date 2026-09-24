/* ==================================================================
   site.js — the only script on the marketing page

   IT MAKES NO REQUESTS. Every download is an <a href>, resolved by
   GitHub server-side at click time; the pricing table is a local
   module; the platform check reads `navigator` and nothing else. The
   privacy policy's zero-third-party claim is about this origin, and
   this file is the only thing on the page that could break it.

   The markup is Grace and Jared's approved mockup. This fills the four
   slots it leaves — the hero button, the store badges, the pricing
   cards and the download cards — because all four depend on facts that
   live in code and must not be typed into HTML twice.
   ================================================================== */

import { repoSlug, assetName, detectPlatform, downloadsFor } from "./downloads.js";
import { TIERS, PERIODS, allowanceLine, priceLabel } from "./pricing.js";
import { FLAGS } from "./flags.js";
import { storeUrl } from "./store-listing.js";
import { REPOSITORY_URL, PRODUCT_NAME, ARTIFACT_NAMES, APP_URL } from "./build-facts.js";

/* ---------- the service worker that used to own this path ----------

   THE ONE PIECE OF LOGIC HERE THAT IS NOT ABOUT RENDERING, and it has
   to be in the first version of this page rather than added later,
   because the window it covers is exactly the transition.

   Before the path split the app was served from `/` and registered a
   worker scoped to `/`. Moving the app to /app/ does not unregister
   it: a registration is keyed by scope, and nothing about the app
   appearing one level down touches a worker that already claimed the
   root. That worker keeps controlling `/`, which is now this page. It is
   network-first for the app shell, so an ONLINE visitor sees this page
   — and then it caches this page as the app shell. OFFLINE, that
   install opens the marketing site instead of the planner.

   So: unregister anything scoped to the origin root, and leave the
   app's own registration alone. Precise, safe, self-healing on the
   first online visit, and a no-op for everybody who never had one. */
function releaseTheOldWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .getRegistrations()
    .then((rs) => {
      for (const r of rs) {
        const scope = new URL(r.scope);
        if (scope.origin === location.origin && scope.pathname === "/") r.unregister();
      }
    })
    .catch(() => {});
}

/* ---------- a recovery link that landed on the wrong page ----------

   THIS IS REQUIRED BY BUILDS THAT ARE ALREADY IN THE STORES, and that
   is why it is not optional.

   `PASSWORD_RESET_REDIRECT` is baked into a bundle at build time. The
   iOS build on TestFlight and the Android AAB already uploaded both
   carry the BARE ORIGIN, because that is what it was when they were
   cut. After the split the bare origin is this page — so a student who
   taps "forgot password" in either of those builds gets an email whose
   link lands here, with the recovery token in the hash, on a page that
   cannot consume it. Supabase tokens are single-use: opening the link
   burns it. The reset does not fail loudly, it just never works.

   So the marketing page forwards it, hash intact, to the app. New
   builds point at /app directly and never touch this path; this exists
   for every copy of the app that was cut before the split and for any
   bookmark or installed PWA that predates it.

   IT GOES TO THE ABSOLUTE `APP_URL`, NOT TO `/app/`, AND THAT IS A
   STORAGE DECISION RATHER THAN A STYLE ONE.

   This page is served on TWO hostnames — `uniplannerapp.com` and
   `www.uniplannerapp.com` — and those are two ORIGINS. A relative
   `/app/` keeps the visitor on whichever one they arrived at, so a
   student who reached the apex would land on `uniplannerapp.com/app`:
   a different origin, a different `localStorage`, no session, and an
   empty planner sitting beside the real one they cannot see. That is
   precisely the failure the whole path split exists to avoid, arriving
   through the back door because a link was one character shorter.

   So THE APP HAS EXACTLY ONE ORIGIN, `SITE_URL`, which is the one it
   has been served from since 12 August 2026 — and every route into it
   from this page is absolute. `APP_URL` is written into
   build-facts.js by the build from `src/legalLinks.js`, the same
   constant `PASSWORD_RESET_REDIRECT` derives from, so the page a token
   is forwarded TO and the page new emails are sent TO cannot drift.

   A FRAGMENT SURVIVES the navigation either way: it never leaves the
   browser.

   IT MUST NOT FIRE ON AN ORDINARY VISIT. Supabase puts recovery
   parameters in the FRAGMENT, so it checks for both an access token and
   the recovery type before doing anything, and it uses `replace` so the
   marketing page does not sit in the back stack behind a password form. */
function forwardRecoveryToTheApp() {
  const hash = location.hash || "";
  if (hash.length < 2) return;
  const params = new URLSearchParams(hash.slice(1));
  const isRecovery = params.get("type") === "recovery" && params.get("access_token");
  /* An error coming back from Supabase (an expired link) rides the same
     fragment and belongs in the app too, where there is wording for it. */
  const isAuthError = params.get("error") || params.get("error_description");
  if (!isRecovery && !isAuthError) return;
  location.replace(APP_URL + "/" + hash);
}

/* ---------- a checkout that was started before the split ----------

   `CHECKOUT_SUCCESS_URL` and `CHECKOUT_CANCEL_URL` point at `/app`
   now, but Stripe stores the return URLs ON THE SESSION when it is
   created — so a checkout begun before this deploy comes back to the
   root, which is a marketing page with no session and nothing to say
   about a payment that just succeeded.

   Narrow on purpose: only `?checkout=`, only on the root, carrying the
   whole query so the app sees exactly what Stripe sent. It exists for
   the sessions in flight across the deploy and for nothing else. */
function forwardCheckoutReturnToTheApp() {
  if (location.pathname !== "/" && location.pathname !== "/index.html") return;
  if (!new URLSearchParams(location.search || "").get("checkout")) return;
  location.replace(APP_URL + "/" + location.search + (location.hash || ""));
}

/* ---------- an installed PWA whose start_url is the old root ----------

   A shortcut installed before the split resolved `start_url` to the
   ORIGIN ROOT at install time, and there is no way to change that from
   here: a manifest only describes new installs. So every existing
   installed planner now opens the marketing page, full-screen, with no
   browser chrome to navigate away with — which is a worse dead end
   than a tab, because there is no address bar to fix it in.

   The display-mode query is what tells an installed launch from an
   ordinary visit, and it is the ONLY thing that does; `navigator
   .standalone` covers iOS, which implements the property and not the
   media feature. An ordinary browser tab matches neither, so a reader
   of the marketing page is never bounced.

   NEW INSTALLS NEED NONE OF THIS. `manifest.webmanifest` has
   `start_url` and `scope` of `"."`, so a manifest served from
   `/app/` describes an app scoped to `/app/` with no edit at all —
   which is why this function is a transitional measure rather than
   the mechanism. */
function forwardInstalledShortcutToTheApp() {
  if (location.pathname !== "/" && location.pathname !== "/index.html") return;
  const standalone =
    (window.matchMedia &&
      ["standalone", "minimal-ui", "fullscreen"].some((m) => window.matchMedia("(display-mode: " + m + ")").matches)) ||
    navigator.standalone === true;
  if (!standalone) return;
  location.replace(APP_URL + "/");
}

/* ---------- fill the slots ---------- */

const slug = repoSlug(REPOSITORY_URL);
const assets = {
  windowsInstaller: assetName(ARTIFACT_NAMES.nsis, { productName: PRODUCT_NAME, ext: "exe" }),
  windowsPortable: assetName(ARTIFACT_NAMES.portable, { productName: PRODUCT_NAME, ext: "exe" }),
  linuxAppImage: assetName(ARTIFACT_NAMES.linux, { productName: PRODUCT_NAME, ext: "AppImage" }),
  macDmg: assetName(ARTIFACT_NAMES.dmg, { productName: PRODUCT_NAME, ext: "dmg" }),
};

const platform = detectPlatform({
  userAgent: navigator.userAgent,
  platformHint: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
  maxTouchPoints: navigator.maxTouchPoints || 0,
});

const el = (tag, className, html) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* The hero button follows the visitor, and its LABEL says which build
   it is offering. "Download" alone on a platform where there is nothing
   to download is the version of this that wastes somebody's click.

   IT READS THE CARD RATHER THAN A TABLE OF PLATFORMS, and that is the
   whole change. The table said `mac: "Open the web app"` — written
   when there was no Mac build — so a signed, notarised .dmg sat in the
   download box while the hero button above it sent Mac visitors to the
   web app. The same defect as the dead "null" button and the stale
   note under the box: a sentence about a flag, in a place the flag is
   not read. Asking `downloadsFor` makes it impossible for the hero and
   the card to disagree about whether a build exists. */
function fillHeroCta() {
  const a = document.querySelector("[data-hero-cta]");
  if (!a) return;
  const { cards } = downloadsFor(platform, { slug, assets });
  /* A phone visitor has no desktop card of their own — `lead` falls
     back to Windows for them, which is right for ORDERING the box and
     wrong for a button that says what THIS machine can run. */
  const mine = platform === "windows" || platform === "mac" || platform === "linux" ? platform : null;
  const card = mine ? cards.find((c) => c.id === mine) : null;
  if (card && card.available) {
    a.textContent = `Download for ${card.label}`;
    a.setAttribute("href", "#download");
    return;
  }
  /* No build for this machine — send them to the app rather than to a
     downloads section that has nothing in it for them. */
  a.textContent = platform === "other" ? "Get UniPlanner" : "Open the web app";
  if (platform !== "other") a.setAttribute("href", APP_URL);
}

function fillStoreBadges() {
  const box = document.querySelector("[data-store-badges]");
  if (!box) return;
  const badges = [
    { id: "android", flag: FLAGS.playBadge, name: "Google Play" },
    { id: "ios", flag: FLAGS.appStoreBadge, name: "App Store" },
  ].map((b) => {
    const href = storeUrl(b.id);
    /* THE FLAG AND THE LINK CANNOT DISAGREE, and the direction is
       fail-closed. A flag turned on before the URL exists produces
       "Coming soon" — which is merely early — where the alternative is
       a badge reading "Get it now" over nothing, which is the state
       site/flags.js spent a release describing as worse than being
       off. Both halves are required, so neither can be the whole
       decision. */
    return { ...b, href, live: Boolean(b.flag && href) };
  });
  /* ORDERED BY THE VISITOR'S PLATFORM, NOT FILTERED BY IT — the same
     rule `downloadsFor` states for the cards, and for the same reason:
     the person choosing is often not on the machine they are choosing
     for, and a student on a laptop looking for the phone app is the
     ordinary case. So an iPhone sees the App Store first and Google
     Play second, rather than seeing one store and being told nothing
     about the other. */
  const mine = platform === "ios" ? "ios" : platform === "android" ? "android" : null;
  if (mine) badges.sort((a, b) => (a.id === mine ? -1 : b.id === mine ? 1 : 0));
  for (const b of badges) {
    /* THE SLOT EXISTS AND IS HIDDEN, rather than being absent. Turning
       a listing on is then a boolean in site/flags.js, on the day it
       goes live, instead of a layout change under time pressure. */
    /* AN ANCHOR WHEN IT LEADS SOMEWHERE, A SPAN WHEN IT DOES NOT.
       A badge that looks clickable and is not is the complaint people
       report as the site being broken, so the element type carries the
       difference rather than a class name that only looks different. */
    const node = el(b.live ? "a" : "span", b.live ? "badge" : "badge soon");
    if (b.live) {
      node.setAttribute("href", b.href);
      /* It leaves this origin, so it opens away from the page rather
         than replacing it — and `noopener` because a named target
         hands the opened page a handle on this one. */
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener");
    }
    node.innerHTML = `<b>${esc(b.name)}</b>${b.live ? "Get it now" : "Coming soon"}`;
    box.appendChild(node);
  }
}

function fillPricing() {
  const box = document.querySelector("[data-pricing]");
  if (!box) return;
  const monthly = PERIODS[0].id;
  for (const tier of TIERS) {
    const card = el("div", tier.highlight ? "price hi" : "price");
    const price = priceLabel(tier, monthly);
    card.appendChild(el("p", "pt", esc(tier.name)));
    card.appendChild(
      el(
        "p",
        "amt",
        price === null
          ? `&mdash;<small> / month</small>`
          : price === "Free"
            ? "$0"
            : `${esc(price.split(" ")[0])}<small> / month</small>`
      )
    );
    card.appendChild(el("span", "allow", esc(allowanceLine(tier))));
    const ul = el("ul");
    for (const f of tier.features) ul.appendChild(el("li", null, esc(f)));
    card.appendChild(ul);
    /* Never a number nobody decided. An unset price renders as a dash
       and says why — on a pricing page a placeholder figure is not a
       stale value, it is an offer. */
    if (price === null) card.appendChild(el("p", "tbd", "Price to be set before launch"));
    box.appendChild(card);
  }
}

function fillDownloads() {
  const box = document.querySelector("[data-downloads]");
  if (!box) return;
  const { lead, cards, unavailable } = downloadsFor(platform, { slug, assets });

  const make = ({ id, title, blurb, href, label, soon, note, alt }) => {
    const d = el("div", `d${soon ? " soon" : ""}${id === lead ? " lead" : ""}`);
    d.appendChild(el("h4", null, esc(title)));
    d.appendChild(el("p", null, esc(blurb)));
    const a = el("a", "dbtn", esc(label));
    a.setAttribute("href", href || "#");
    if (!href) a.setAttribute("aria-disabled", "true");
    d.appendChild(a);
    if (alt) {
      const s = el("a", "dalt", esc(alt.label));
      s.setAttribute("href", alt.href);
      d.appendChild(s);
    }
    if (note) d.appendChild(el("p", "dnote", esc(note)));
    return d;
  };

  /* THE DESIGN HALF, AND ONLY THE DESIGN HALF. Heading, one-line blurb
     and the words on the button are Grace's; everything that says
     whether there is a download and what goes under it comes off the
     card, which is where the flags are already read.

     IT USED TO BE THREE HAND-WRITTEN BRANCHES, and the macOS one was
     left behind when the flag was turned on: it passed `href: null` and
     `label: c.soon` unconditionally, so with `FLAGS.macDownload` true —
     which it has been since signing landed — `c.soon` is null and the
     card rendered a DEAD `#` BUTTON LABELLED "null", live, on the one
     platform the whole Developer ID pipeline exists to serve. Every
     guard was green: `downloads.js` had the right href all along and
     the suite tested `downloads.js`. Nothing read the rendered card.

     A per-id branch is what let one platform stop following its own
     data, so there is no longer one to leave behind. */
  /* THE HEADING IS NOT IN HERE. It is the card's own `label`, so the
     platform has ONE name across the data layer, the heading and the
     hero button — three copies of "macOS" is three chances for one of
     them to still say it after somebody renames the platform, which is
     exactly what item 2 was. Blurb and button wording stay Grace's. */
  const LOOK = {
    windows: { blurb: "Desktop app, auto-updating", label: "Download .exe" },
    mac: { blurb: "Desktop app", label: "Download .dmg" },
    linux: { blurb: "AppImage, no install needed", label: "Download AppImage" },
  };
  for (const c of cards) {
    const look = LOOK[c.id];
    if (!look) continue;
    box.appendChild(
      make({
        id: c.id,
        title: c.label,
        blurb: look.blurb,
        href: c.href,
        /* `c.soon` is the sentence a card carries INSTEAD of a
           download, so it is the label exactly when there is no href. */
        label: c.available ? look.label : c.soon,
        soon: !c.available,
        alt: c.alt,
        note: c.note,
      })
    );
  }
  /* The web card is not a release asset, so it is not in downloadsFor —
     it is always available and always last-but-two. */
  box.appendChild(make({ id: "web", title: "Web", blurb: "Nothing to install", href: APP_URL, label: "Open the app" }));
  box.appendChild(
    make({ id: "android", title: "Android", blurb: "Google Play", href: null, label: "Coming soon", soon: !FLAGS.playBadge })
  );
  box.appendChild(
    make({ id: "ios", title: "iPhone and iPad", blurb: "App Store", href: null, label: "Coming soon", soon: !FLAGS.appStoreBadge })
  );

  /* THE NOTE UNDER THE BOX, and it is rendered from the cards rather
     than written into index.html. The hand-written one outlived the
     thing it described — "not signed by Apple yet" sat under a signed
     build for as long as nobody re-read the page — so there is no
     longer a place to write a sentence about a platform that is not
     beside that platform's own availability. An empty list renders
     nothing at all. */
  const after = document.querySelector("[data-downloads-note]");
  if (after) {
    after.textContent = "";
    after.hidden = unavailable.length === 0;
    for (const u of unavailable) {
      const p = el("p", "note", `<b>${esc(u.label)}:</b> ${esc(u.instead)}`);
      p.style.textAlign = "left";
      after.appendChild(p);
    }
  }
}

releaseTheOldWorker();
/* Order matters only in that each one `replace`s and the first to
   match wins: a recovery link opened inside an installed shortcut
   is a recovery link first. */
forwardRecoveryToTheApp();
forwardCheckoutReturnToTheApp();
forwardInstalledShortcutToTheApp();
fillHeroCta();
fillStoreBadges();
fillPricing();
fillDownloads();
