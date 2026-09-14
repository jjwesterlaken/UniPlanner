# Shipping the marketing site: what it collides with

Written before the page exists, because the answer changes what gets
built. Two questions were asked and both have definite answers.

---

## The split, as built — three origins, two Pages projects

**Superseded, and the supersession is the point.** This document used
to answer "site at `/`, app at `/app`, same origin so `localStorage`
survives", and CLAUDE.md recorded `app.` as ruled out twice for exactly
that reason. Jared's order of 14 September 2026 overrides it: the site
takes `uniplannerapp.com` AND `www.uniplannerapp.com`, and the app
moves to `app.uniplannerapp.com`.

| Origin | Serves | Pages project | Output |
|---|---|---|---|
| `uniplannerapp.com` | marketing page, the four legal documents, `/handover` | `uniplanner-site` | `dist-site` |
| `www.uniplannerapp.com` | the same bundle | `uniplanner-site` | `dist-site` |
| `app.uniplannerapp.com` | the planner, plus its own copies of the documents | `uniplanner` | `dist-web` |

**The documents did NOT move.** `SITE_URL` is still
`https://www.uniplannerapp.com` and `PRIVACY_URL`, `TERMS_URL`,
`SUPPORT_URL` and `DELETE_ACCOUNT_URL` still derive from it, because
those four strings are in two app-store listings and a Stripe dashboard
field. The site build copies the documents in so those URLs keep
resolving; the app build keeps its copies so they resolve on the new
origin too.

**Everything else that was on `www` 301s to the app**, path and query
preserved — a Pages middleware generated from the build output, not a
`_redirects` file, for the reason in `site/redirects.js`. A fragment
needs no preserving: it never reaches a server, and a browser
re-applies it when the `Location` carries none. That is what gets a
Supabase recovery token through a 301 intact.

---

## What the split costs, stated plainly

### 1. THE PER-ORIGIN STORAGE PROBLEM IS REAL, AND IT IS PARTLY SOLVED

`localStorage` is keyed by origin. Every planner belonging to somebody
**without an account** exists only on the device, under the old origin,
and is invisible from the new one. A 301 cannot help: it is served by
the edge before any script runs.

**What is built:** `/handover` on the marketing origins is excluded
from the redirects. The app frames it once, on a first visit with an
empty planner; the bridge reads its own `localStorage` and posts the
planner to the app origin and nowhere else. `src/originHandover.js` has
the whole design.

**Why it can work at all:** `www.` and `app.` are different ORIGINS but
the same SITE. Storage partitioning is keyed on the registrable domain,
so a same-site iframe still reaches unpartitioned storage. A
genuinely cross-site handover would be blocked outright.

**What it cannot reach, and none of this is fixable:**

- a browser that never opens the new origin
- an **installed PWA**, whose `start_url` was resolved at install time
- a different browser, profile or device
- the **Supabase session**, deliberately — **everybody signs in again**

**And it is unverified on Safari.** The reasoning is specification, not
observation; this container cannot run WebKit. The check is on
DEPLOY-CHECKLIST §7f.

### 2. The service worker already installed at `/` on `www`

A returning visitor has a worker scoped to `/` on the OLD origin.
Moving the app to another origin does not unregister it — a
registration belongs to the origin it was made on. `site.js`
unregisters anything scoped to the marketing origin's root, and it must
stay in the first version of the page, because the window it covers is
the transition itself.

### 3. Password reset

`PASSWORD_RESET_REDIRECT` is `APP_URL` now. Builds already in the
stores carry the old value and send links to `www`, so the marketing
page forwards a recovery fragment to the app. **Both halves are
required**, and the new URL must be on the Supabase allowlist or
Supabase silently falls back to the Site URL.

### 4. A checkout in flight across the deploy

Stripe stores the return URLs on the session when it is created, so a
checkout started before the deploy returns to `www/?checkout=done`. The
marketing page forwards that to the app as well. New sessions carry the
app origin.

### 5. Things that do NOT break, checked

- **The legal documents** resolve on both origins.
- **The CSP** — the marketing build now ships its own `_headers`, which
  it never had; `frame-ancestors` permits exactly one framer, the app.
- **The e2e journeys** serve `dist-web` locally and follow the build.
- **The build-id check** moves to the app origin. The marketing site
  ships no service worker, deliberately, so the old command returns
  nothing and reads exactly like a failed deploy.

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
