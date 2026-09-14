/* ==================================================================
   The worker served at the ORIGIN ROOT, whose only job is to remove
   itself and the registration it replaces.

   WHY THIS FILE EXISTS AT ALL, since the path split deliberately left
   this path empty. The reasoning was that a 404 on a worker script
   makes the browser unregister it, so an absent file was the ACTIVE
   mechanism and a redirect the inert one. The first half is true. The
   second half assumed a 404, and production produced neither:

     - at the Pages origin, `/sw.js` answered 200 with the marketing
       page's HTML — an unmatched path falls back to index.html, so
       the script "updated" to a document. No 404, no unregister.
     - at the www edge, the zone cache was still serving the OLD
       worker (max-age 14400, cf-cache-status REVALIDATED), so the
       browser's update check never reached an origin at all.

   Either way the stale worker stays installed and keeps controlling
   `/`, which is now the marketing page — cache-first, over an app
   shell that no longer belongs there. THE LESSON IS THE ONE THIS
   REPOSITORY KEEPS RELEARNING: an absence is not a mechanism you can
   verify. A file is.

   WHAT IT DOES, in order, and each line is load-bearing:

     install   skipWaiting()  — do not sit in `waiting` behind the
               worker being replaced, which would postpone all of
               this until every root tab closed.
     activate  registration.unregister()  — removes the registration
               itself, so nothing is fetched here again.
               then navigate the windows it controls, so a page that
               is open RIGHT NOW stops being served the old app shell
               instead of waiting for the visitor to reload.

   THERE IS NO `fetch` HANDLER, DELIBERATELY. A worker with no fetch
   listener is transparent: for the moments between activation and
   the navigation below, every request goes to the network rather
   than through whatever the old worker had cached.

   AND IT MUST NEVER TOUCH `caches` — the trap in this file, worth
   more than the fix. Cache Storage is scoped to the ORIGIN, not to
   the worker's scope, so the obvious tidy-up — delete every cache
   named `uni-planner-*` — would delete the LIVE app's cache at
   /app/ along with the dead root one. They share the prefix because
   they are the same product. The orphaned caches are evicted by the
   browser under quota; the app's are not ours to take.

   It is idempotent and self-removing, so a copy that the edge or a
   browser holds for its full max-age is still correct: it runs, it
   unregisters, there is nothing left to be stale about. That is the
   other reason a stub beats an absence — a cached 404 does nothing,
   a cached stub does the job. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await self.registration.unregister();
      } catch (e) {
        /* Nothing to fall back to, and nothing to report to: the page
           this would matter to is the one being navigated below. */
      }
      try {
        const windows = await self.clients.matchAll({ type: "window" });
        for (const client of windows) client.navigate(client.url);
      } catch (e) {
        /* A client that refuses to be navigated is released on its
           next ordinary navigation anyway — the registration is
           already gone by this point. */
      }
    })()
  );
});
