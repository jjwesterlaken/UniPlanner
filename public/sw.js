/* Service worker for the web build.

   ⚠️  THE CACHE NAME IS GENERATED. Do not write a literal here.

   `__BUILD_ID__` is replaced by scripts/build-web.mjs with a hash of the
   built app.js + app.css. That is not a tidiness preference -- it is the
   whole mechanism by which users receive updates.

   What went wrong before, so nobody reintroduces it: the cache name was
   a hand-edited constant ("uni-planner-v6") that was committed once and
   never changed again. Nothing bumped it, and index.html referenced
   `app.js` and `app.css` by bare filename with no content hash. The
   fetch handler was cache-first for everything. The result was that any
   browser which had opened the app once served that build forever: the
   worker script never changed, so no new worker installed, so `install`
   never re-ran, so nothing was ever re-fetched. Weeks of deploys reached
   nobody who already had the app cached -- and a security fix would have
   reached them just as little.

   Two independent things now prevent that, deliberately, because this
   failure is invisible when it happens:

     1. The cache name changes whenever the build changes, so a new build
        always produces a new worker and a fresh cache.
     2. The app shell is network-first anyway, so even if (1) were ever
        broken again, a user with a working connection still gets the
        current build.
*/

const CACHE = "uni-planner-__BUILD_ID__";

/* Never served from a cache, and never replaced by the app shell.
   Absolute on purpose: these are site-level documents whose URLs are in
   two app-store listings, so they stay at the root even if the app
   itself moves to a subpath.
   These are legal documents; a stale copy is worse than an error page,
   and rendering the planner in place of a privacy policy would be a
   plain misrepresentation. Matched by pathname so a query string or a
   trailing slash can't slip past. */
const NETWORK_ONLY = ["/privacy.html", "/delete-account.html", "/privacy", "/delete-account"];

/* The app shell: fetched fresh when the network allows, with the cache
   as the offline fallback.

   Derived from where this worker is served rather than hardcoded to "/",
   because the app is NOT guaranteed to own the site root forever. The
   plan is for a marketing site to take "/" and the app to move to
   "/app", on the same origin so localStorage survives (see CLAUDE.md).
   Everything else here is already origin- and path-relative; this list
   was the one place that assumed otherwise. */
const BASE = new URL("./", self.location).pathname;
const SHELL = [BASE, BASE + "index.html", BASE + "app.js", BASE + "app.css"];

/* Genuinely immutable: fonts and icons whose bytes never change under a
   given name. Cache-first is right for these -- and a new build gets a
   new cache anyway, so even a replaced icon comes through. */
const PRECACHE = [
  "./",
  "./index.html",
  "./app.js",
  "./app.css",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

const pathOf = (url) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch (e) {
    return "";
  }
};

const isNetworkOnly = (url) => NETWORK_ONLY.includes(pathOf(url));
const isShell = (url) => SHELL.includes(pathOf(url));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // Take over immediately rather than waiting for every tab to close.
      // Paired with clients.claim() below, this is what makes an update
      // land on the next navigation instead of "eventually".
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  // Legal documents: straight to the network, no cache read, no cache
  // write, and no app-shell fallback if it fails.
  if (isNetworkOnly(request.url)) {
    event.respondWith(fetch(request));
    return;
  }

  const navigation = request.mode === "navigate";

  // App shell: network-first, cache as the offline fallback.
  if (navigation || isShell(request.url)) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(request)
            // A navigation to an unknown path while offline still gets the
            // app rather than a browser error -- but only a navigation,
            // and never for the paths above.
            .then((cached) => cached || (navigation ? caches.match("./index.html") : undefined))
        )
    );
    return;
  }

  // Everything else (fonts, icons, manifest): cache-first.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
    )
  );
});
