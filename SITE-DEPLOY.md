# Shipping the marketing site: what it collides with

Written before the page exists, because the answer changes what gets
built. Two questions were asked and both have definite answers.

---

## Can the site and the origin split ship independently?

**As specified — site at `/`, app at `/app` — no. They are the same
deploy.** The site cannot go to `/` without the app leaving it, because
`/` is the app today.

**There is exactly one way to ship them independently, and it is the
apex domain.** `uniplannerapp.com` currently forwards to `www` at
Squarespace. Point it at a second Cloudflare Pages project instead and
the site is live at `https://uniplannerapp.com` with the app untouched
at `https://www.uniplannerapp.com`.

| | Site at `/` (the split) | Site at the apex |
|---|---|---|
| Ships independently | **no** | **yes** |
| Risk to the app | real, see below | none |
| Existing PWA installs | break, need re-installing | untouched |
| Password reset | breaks, see below | untouched |
| Cost | one deploy, several fixes | a second Pages project |
| Ends up where it should | yes | **no — still has to move later** |

**Recommendation: do the split, and do it in one deploy.** The apex
route is genuinely safe, but it defers the same work to a day when there
are more than two users to break — and the split is cheap precisely
because there are two. Doing it now costs a re-install for Jared and
Grace; doing it in November costs it for everybody.

---

## What breaks if the split has not landed

### 1. Nothing about the *files* — the app is already portable

Checked rather than assumed, and this is the good news:

| Thing | Why it survives |
|---|---|
| `manifest.webmanifest` | `start_url` and `scope` are both `"."` — relative, so they resolve against wherever the manifest sits |
| `sw.js` | derives its shell list from `new URL("./", self.location)`, so a worker at `/app/sw.js` scopes to `/app/` |
| the registration in `index.html` | `register("sw.js")` is relative; at `/app/index.html` it registers `/app/sw.js` |
| every asset reference | relative already |
| the legal documents | stay at `/privacy` and `/delete-account`; `NETWORK_ONLY` lists them absolutely and a `/app/`-scoped worker never sees those requests at all |
| `localStorage` | same ORIGIN, and paths do not scope it — no planner data moves or is lost |

### 2. THE SERVICE WORKER ALREADY INSTALLED AT `/` — the real one

A returning visitor has a worker registered with **scope `/`**, from the
current deployment. Moving the app to `/app/` does not unregister it.
That worker keeps controlling `/`, which is now the marketing page.

It is network-first for the app shell, so an **online** visitor gets the
real marketing page — and the worker then caches it as the app shell.
**Offline, that install opens the marketing page instead of the
planner.**

**The fix belongs in the marketing page and is small:** on load,
`getRegistrations()` and unregister any whose `scope` is the origin
root, leaving `/app/` alone. Precise, safe, and it heals itself on the
first online visit. **It must be in the first version of the page**, not
added later, because the window it covers is exactly the transition.

### 3. PASSWORD RESET — silent, and the worst of the three

`PASSWORD_RESET_REDIRECT` is `SITE_URL`, the bare origin. Supabase sends
the recovery token in the URL fragment, so after the split a reset link
lands on **the marketing page**, which has no `PasswordRecovery` overlay
and no `detectSessionInUrl`. The student sees a marketing page and their
one-time token is consumed.

Two changes, and both are required:

- `PASSWORD_RESET_REDIRECT` becomes `${SITE_URL}/app` — derived, not a
  second literal.
- **The new URL must be added to Supabase → Authentication → URL
  Configuration → Redirect URLs.** Supabase silently ignores an
  unlisted `redirectTo` and falls back to the Site URL, which is the
  failure that looks like a code bug when it is configuration. This has
  bitten this project before.

Nothing in the repository can verify the second one. It goes on the
deploy checklist or it does not happen.

### 4. Installed PWAs need re-installing

An installed app resolved `start_url` to `https://www.uniplannerapp.com/`
at install time. After the split that opens the marketing page. There is
no way to migrate an installed shortcut.

Two users today. Worth saying out loud rather than discovering.

### 5. Things that do NOT break, checked

- **The CSP.** `public/_headers` applies origin-wide and permits
  `'unsafe-inline'`, so an inline-styled static page satisfies it
  unchanged. No external host is needed — see below.
- **The e2e journeys.** They serve `dist-web` locally and navigate to
  the built app; they follow whatever path the build produces.
- **`test-legal.mjs`.** It compares `SITE_URL` and the documents on host
  AND path; adding an index at `/` changes neither.
- **The build-id check.** `curl .../sw.js` still finds the app's worker
  as long as the marketing site does not ship one of its own — **and it
  must not.** A second worker at `/` is the collision in (2) recreated
  deliberately.

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

### macOS: a build exists, and that is not the problem

A signed one does not. `University.Planner-1.0.1-universal.dmg` is
published and 216 MB of it. Unsigned and un-notarised, macOS does not
warn the way Windows does — it refuses, with a dialogue saying the app
is damaged, and the workaround is a terminal command no student should
be asked to run. **"Coming soon" is accurate**: what is missing is a
$99/year Apple Developer account and a notarisation step, not a build.
