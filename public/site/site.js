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
import { REPOSITORY_URL, PRODUCT_NAME, ARTIFACT_NAMES, APP_PATH } from "./build-facts.js";

/* ---------- the service worker that used to own this path ----------

   THE ONE PIECE OF LOGIC HERE THAT IS NOT ABOUT RENDERING, and it has
   to be in the first version of this page rather than added later,
   because the window it covers is exactly the transition.

   Before the origin split the app was served from `/` and registered a
   worker scoped to `/`. Moving the app to /app/ does not unregister
   it: that worker keeps controlling `/`, which is now this page. It is
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
  location.replace("/app/" + hash);
}

/* ---------- fill the slots ---------- */

const slug = repoSlug(REPOSITORY_URL);
const assets = {
  windowsInstaller: assetName(ARTIFACT_NAMES.nsis, { productName: PRODUCT_NAME, ext: "exe" }),
  windowsPortable: assetName(ARTIFACT_NAMES.portable, { productName: PRODUCT_NAME, ext: "exe" }),
  linuxAppImage: assetName(ARTIFACT_NAMES.linux, { productName: PRODUCT_NAME, ext: "AppImage" }),
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
   it is offering. "Download" alone on a Mac, where there is nothing to
   download, is the version of this that wastes somebody's click. */
function fillHeroCta() {
  const a = document.querySelector("[data-hero-cta]");
  if (!a) return;
  const label = {
    windows: "Download for Windows",
    linux: "Download for Linux",
    mac: "Open the web app",
    ios: "Open the web app",
    android: "Open the web app",
    other: "Get UniPlanner",
  }[platform];
  a.textContent = label;
  /* On a platform with no desktop build, the hero button goes to the
     app rather than to a downloads section that has nothing for them. */
  if (platform === "mac" || platform === "ios" || platform === "android") a.setAttribute("href", APP_PATH);
}

function fillStoreBadges() {
  const box = document.querySelector("[data-store-badges]");
  if (!box) return;
  const badges = [
    { flag: FLAGS.playBadge, name: "Google Play", href: null },
    { flag: FLAGS.appStoreBadge, name: "App Store", href: null },
  ];
  for (const b of badges) {
    /* THE SLOT EXISTS AND IS HIDDEN, rather than being absent. Turning
       a listing on is then a boolean in site/flags.js, on the day it
       goes live, instead of a layout change under time pressure. */
    const span = el("span", b.flag ? "badge" : "badge soon");
    span.innerHTML = `<b>${esc(b.name)}</b>${b.flag ? "Get it now" : "Coming soon"}`;
    box.appendChild(span);
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
  const { lead, cards } = downloadsFor(platform, { slug, assets });

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

  for (const c of cards) {
    if (c.id === "windows") {
      box.appendChild(
        make({
          id: "windows",
          title: "Windows",
          blurb: "Desktop app, auto-updating",
          href: c.href,
          label: "Download .exe",
          alt: c.alt,
          /* By instruction, and it belongs with the button rather than
             in the page: a student who hits SmartScreen with no warning
             that it was coming assumes the download is malware, which is
             the correct instinct and the wrong conclusion. */
          note: FLAGS.windowsUnsignedNote ? c.note : null,
        })
      );
    } else if (c.id === "linux") {
      box.appendChild(
        make({ id: "linux", title: "Linux", blurb: "AppImage, no install needed", href: c.href, label: "Download AppImage", note: c.note })
      );
    } else if (c.id === "mac") {
      box.appendChild(
        make({ id: "mac", title: "macOS", blurb: "Desktop app", href: null, label: c.soon, soon: !FLAGS.macDownload })
      );
    }
  }
  /* The web card is not a release asset, so it is not in downloadsFor —
     it is always available and always last-but-two. */
  box.appendChild(make({ id: "web", title: "Web", blurb: "Nothing to install", href: APP_PATH, label: "Open the app" }));
  box.appendChild(
    make({ id: "android", title: "Android", blurb: "Google Play", href: null, label: "Coming soon", soon: !FLAGS.playBadge })
  );
  box.appendChild(
    make({ id: "ios", title: "iPhone and iPad", blurb: "App Store", href: null, label: "Coming soon", soon: !FLAGS.appStoreBadge })
  );
}

releaseTheOldWorker();
forwardRecoveryToTheApp();
fillHeroCta();
fillStoreBadges();
fillPricing();
fillDownloads();
