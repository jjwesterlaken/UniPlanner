/* ==================================================================
   redirects.js — which old URLs move to the app, and which stay

   THE SPLIT LEAVES ONE HOST DOING TWO JOBS. After it,
   `www.uniplannerapp.com` serves the marketing site and the four legal
   documents, and everything else that used to be there is the app,
   which now lives on `app.uniplannerapp.com`. So the rule is not "the
   site moved" or "the app moved" — it is a per-path decision on one
   origin, and it has to be written down somewhere a test can read it.

   WHY THIS IS NOT `_redirects`, which is the obvious answer and the
   wrong one. Expressing "everything except these paths" in a
   `_redirects` file needs either a 200 rewrite for every path that
   stays — which Cloudflare Pages does not support, it takes 301/302/
   303/307/308 only — or a reliance on static assets taking precedence
   over a catch-all, which is behaviour this container cannot verify
   and which would fail SILENTLY in the direction that 301s the privacy
   policy to an app that does not serve it. Pages middleware is
   documented to run before asset serving with `next()` as the
   fall-through, and the decision is a pure function, so it can be
   tested against the real generated artifact instead of hoped about.

   THE OWNED SET IS DERIVED FROM THE BUILD OUTPUT, not typed here. A
   list would be the restatement pattern in its most expensive form: a
   marketing asset added next month would not be on it, would fall to
   the catch-all, and would 301 to an app origin that has no such file
   — a broken image or a dead stylesheet on the launch page, caused by
   adding a file.
   ================================================================== */

/**
 * Every path the marketing origin serves itself, from the files the
 * build actually wrote.
 *
 * THE EXTENSIONLESS FORMS ARE PART OF THE SET, and this is the detail
 * that would have cost the most. Cloudflare Pages serves
 * `privacy.html` at `/privacy` and that is the CANONICAL url — it is
 * in two app-store listings. A set built from filenames alone holds
 * `/privacy.html` and not `/privacy`, so the canonical URL falls to
 * the catch-all and a store reviewer clicking the privacy policy is
 * 301'd to an origin that was never given it.
 */
export function ownedPaths(files) {
  const owned = new Set(["/"]);
  for (const f of files) {
    const p = "/" + f.replace(/^\/+/, "");
    owned.add(p);
    if (p.endsWith("/index.html")) owned.add(p.slice(0, -"index.html".length));
    if (p.endsWith(".html")) owned.add(p.slice(0, -".html".length));
  }
  return [...owned].sort();
}

/**
 * Where a request on the marketing origin should go, or null to serve
 * it from here.
 *
 * `null` means "this origin owns it". A string is an absolute URL to
 * 301 to, with the path and query preserved.
 *
 * THE FRAGMENT IS NOT HANDLED HERE AND DOES NOT NEED TO BE. A fragment
 * is never sent to a server, so it cannot be read, rewritten or lost;
 * when a redirect's `Location` carries no fragment of its own the
 * browser re-applies the one the user had. That is what carries a
 * Supabase recovery token through a 301 intact — and it is also why
 * `/` must NOT be a redirect: `/` is the marketing page now, so a
 * recovery fragment landing there is forwarded by a script instead
 * (public/site/site.js), which is a different mechanism for the same
 * problem and the reason both exist.
 */
export function redirectFor(pathname, owned, appOrigin, search = "") {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  /* Trailing slashes: `/privacy/` and `/privacy` are the same document
     to a person, and only one of them is in the owned set. */
  const bare = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
  if (owned.includes(pathname) || owned.includes(bare)) return null;
  /* Directories the site owns wholesale. Derived from the owned set
     rather than listed: any path whose parent directory is represented
     in the set belongs to this origin. */
  for (const p of owned) {
    if (p.endsWith("/") && p.length > 1 && pathname.startsWith(p)) return null;
  }
  return `${appOrigin}${pathname}${search || ""}`;
}
