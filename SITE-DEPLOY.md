# Shipping the marketing site: what it collides with

Written before the page exists, because the answer changes what gets
built. Two questions were asked and both have definite answers.

---

## The split, as built — one origin, two hostnames, two paths

**Built and shipping.** The recommendation below was taken: the split
happened in one deploy rather than being deferred to the apex.

| URL | Serves |
|---|---|
| `uniplannerapp.com/` | the marketing page |
| `www.uniplannerapp.com/` | the same bundle |
| `www.uniplannerapp.com/app` | the planner |
| `.../privacy`, `/terms`, `/support`, `/delete-account` | unchanged, at the URLs two store listings already name |

**ONE Cloudflare Pages project, ONE output.** An origin can only be
served one directory, so `scripts/build-site.mjs` assembles `dist-site`
containing the marketing root AND `dist-site/app/`, which is the entire
web build copied in verbatim. `dist-web` is untouched and is still what
the desktop and phone shells package.

**A SUBDOMAIN WAS BUILT AND REFUSED, which is worth recording because
somebody will propose it again.** `claude/origin-split` is a complete,
green implementation of `app.uniplannerapp.com`, including a same-site
iframe bridge to carry signed-out planners across the origin boundary.
Jared held it on 14 September 2026 and the 21 August ruling stands. The
two reasons:

- **the bridge had holes that read as data loss.** It could not reach a
  browser that never opened the new origin, an installed PWA whose
  `start_url` was resolved at install time, or any other device or
  profile. Each of those is a student opening the app to an empty
  planner.
- **and it rested on unverifiable behaviour.** Same-site iframes get
  unpartitioned storage by specification, and no build machine here can
  run WebKit to confirm Safari agrees.

A path split needs no bridge at all, because `localStorage` is scoped
by ORIGIN and paths do not scope it. Nothing moves.

---

## What the split touched, and what it did not

### 1. THE APP NEEDED NO CHANGES TO MOVE — checked, not assumed

Everything in it was already path-relative: `manifest.webmanifest` has
`start_url` and `scope` of `"."`, icons and `app.js` are bare
filenames, the worker is `register("sw.js")`, and `sw.js` derives its
shell list from `new URL("./", self.location)`. So at `/app/` the
worker scopes to `/app/` and a new install gets `start_url: /app/`,
with no edit. `scripts/test-path-split.mjs` asserts each of those on
the BUILT artifact, since "it is relative" and "it resolves under
/app/" are different sentences.

### 2. THE WORKER THAT OWNED `/`, and the counter-intuitive half

A returning visitor holds a worker at scope `/` from `/sw.js`. Two
mechanisms release it, and only one of them is obvious:

- `site.js` unregisters anything scoped to the origin root on the first
  visit to `/`.
- **`/sw.js` 404s, deliberately.** A service worker script request may
  not be REDIRECTED — the Update algorithm fails on one, so a 301 there
  leaves the stale worker installed. A 404 unregisters the registration.
  The empty path is the active mechanism; the redirect would have been
  the inert one, and the derived redirect list excludes it by name.

### 3. EVERY ROUTE INTO THE APP IS ABSOLUTE

The marketing page is served on **two hostnames**, and those are two
ORIGINS. A relative `/app/` link would land an apex visitor on
`uniplannerapp.com/app` — a different origin, a different
`localStorage`, an empty planner beside the real one. That is the
refused subdomain arriving through the back door because a link was one
character shorter. The nav control, the hero, the download card and all
three forwarders use the absolute `APP_URL`, and a test asserts it.

### 4. Three forwarders, for three things in flight across the deploy

- **Password reset.** `PASSWORD_RESET_REDIRECT` is `APP_URL` now.
  Builds already in the stores carry the old value, so the marketing
  page forwards a recovery fragment to `/app/`. Both halves required.
- **Checkout.** Stripe stores return URLs on the session at creation,
  so a checkout begun before the deploy comes back to `/`.
- **An installed PWA.** A shortcut installed before the split opens the
  root full-screen with no address bar to escape from. The display-mode
  check bounces it; new installs need none of this.

### 5. Things that do NOT break, checked

- **`localStorage`, the session, and every signed-out planner.** Same
  origin. Nobody is signed out and nothing is migrated.
- **The Supabase allowlist.** `https://www.uniplannerapp.com/**`
  already covers `/app`; only the Site URL fallback moves.
- **The legal documents.** Same URLs, served from the root.
- **The e2e journeys.** They serve `dist-web` locally and follow the
  build.
- **The CSP.** One origin gets ONE policy — the app's, which is the
  permissive side. Two `_headers` rules matching a path produce two CSP
  headers and a browser enforces the intersection, so a second, tighter
  policy for the marketing pages would silently narrow the app's.

---

## Zero third-party requests, on the marketing site too

**Confirmed by construction, and by a test.**

- **No fonts from a CDN.** The app already self-hosts Comfortaa in
  `public/fonts`; the site uses the same files from the same origin.
- **No analytics, no tag manager, no error reporting.** The app ships
  none and the site ships none. The privacy policy's claim is about the
  whole origin and stays true.
- **No GitHub API call.** This is the one that took a decision. Deriving
  the download links from `api.github.com/releases/latest` would work
  and would be a third-party request from the visitor's browser.
  `https://github.com/<owner>/<repo>/releases/latest/download/<name>` is
  an `href` — **no request is made until somebody clicks a download
  button**, which is a request they asked for. `scripts/test-site.mjs`
  asserts `site/downloads.js` contains no `fetch`, no
  `XMLHttpRequest`, no `sendBeacon`, no `WebSocket` and no
  `EventSource`, and never names the API host.
- **No store-badge images from Google or Apple.** Both want their badge
  served from their CDN; both are also available as static files under
  their brand guidelines. **Serve local copies.** The slots are behind
  flags and empty until a listing exists, so nothing is fetched today
  either way.

---

## The download links 404 until a new release is cut

**Read this before the site goes live.**

`latest/download/<name>` needs the asset NAME to be stable across
releases. electron-builder's templates put `${version}` in it, so the
published v1.0.1 assets are named:

```
University.Planner.Setup.1.0.1.exe
University.Planner.Portable.1.0.1.exe
University.Planner-1.0.1.AppImage
```

The templates have been changed to drop the version, so the NEXT release
produces:

```
University.Planner.Setup.exe
University.Planner.Portable.exe
University.Planner.AppImage
```

**Until that release exists, every download button 404s.** Cut one — tag
`v1.0.2` and `build-apps.yml` does the rest — before the page is
public. There is no way to make this work against v1.0.1 without pinning
a version into the site, which is the thing the whole module exists to
avoid.

### And one bug found on the way in

**`desktop/package.json` says `1.0.0`; the published release is
`v1.0.1`.** The version was bumped to 1.0.1 for that release
(`eae2f0c`) and then reverted to 1.0.0 by `6dd7b69` ("Settle the five
mobile decisions"). Nothing noticed because the version only reaches
the filenames and the auto-update metadata.

So the next tagged release would publish a `latest.yml` advertising
**1.0.0 to installs already running 1.0.1** — auto-update would see a
lower version and do nothing, silently, for exactly the users who
already installed. **Set the desktop version deliberately before cutting
the release.** The filenames no longer care; auto-update does.

**RESOLVED BY THE 1.1.0 BUMP**, and it is worth saying which half fixed
it. The root `package.json` is now 1.1.0 and `stamp-native.mjs` writes
that into `desktop/package.json`, so the next release advertises 1.1.0
— above the published 1.0.1, and auto-update moves. What made it
possible to state as fixed rather than hoped is that the two are no
longer two numbers: a test derives the stamped files from the stamper
itself and asserts each equals the root, so a desktop version reverted
by a later commit goes red instead of going unnoticed for a release.

### macOS: a build exists, and that is not the problem

A signed one does not. `University.Planner-1.0.1-universal.dmg` is
published and 216 MB of it. Unsigned and un-notarised, macOS does not
warn the way Windows does — it refuses, with a dialogue saying the app
is damaged, and the workaround is a terminal command no student should
be asked to run. **"Coming soon" is accurate**: what is missing is a
$99/year Apple Developer account and a notarisation step, not a build.
