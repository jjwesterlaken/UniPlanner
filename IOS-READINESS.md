# iOS readiness: what is already wrong, in severity order

Written against the repository at `1a6f732`, before the first
`cap add ios` on any machine — so every claim here came from source,
and the things that could only be answered by a device were listed as
such rather than guessed at.

**Updated 22 August 2026 with three items closed.** Item 1a was
measured and the constants stand; items 3a and 3b are built; item 4 is
built. What each now says is marked **CLOSED** in place, with the
original reasoning kept — the reasoning is why the next person will
trust the next answer.

**The headline: nothing blocks the compile.** There are no Capacitor
plugins, no native source, no Podfile customisation and no
platform-specific code path that does not already exist for Android.
The two items that were expected to be worst — audio format and
account deletion — are both already done. What is actually missing is
three Info.plist keys, the top and side safe-area insets, and one
decision about iPad.

---

## First, the thing you asked for so you can do it in one pass

### Supabase → Authentication → URL Configuration

**Site URL**

```
https://www.uniplannerapp.com
```

**Redirect URLs — add these three:**

```
https://www.uniplannerapp.com
https://www.uniplannerapp.com/**
https://main.uniplanner.pages.dev/**
```

Optionally a fourth, only if you want password reset testable on an
arbitrary per-deployment preview rather than just the `main` one:

```
https://*.uniplanner.pages.dev/**
```

**Why each:**

| Entry | What it is for |
|---|---|
| the bare origin | exactly what `PASSWORD_RESET_REDIRECT` sends today (`legalLinks.js:42` — it is `SITE_URL`, no path). Listed separately because Supabase's matcher is exact without wildcards, and `…/**` is not guaranteed to match an origin with no trailing path |
| `…/**` | covers **`/app`**, which is what `PASSWORD_RESET_REDIRECT` becomes after the origin split. `**` matches across path segments; `*` matches only within one. This entry means **the allowlist never needs touching again when the split lands** |
| `main.uniplanner.pages.dev/**` | the `main` preview. Under promote-on-release, a reset flow verified on the preview before the promote is the only way to check it without shipping it |

**Two things NOT to add, and the second is a premise correction.**

- **There is no app subdomain, and there must not be one.** `app.uniplannerapp.com` would be a different origin, and `localStorage` is scoped per origin — every local planner on every device is keyed to the hostname that stored it. A subdomain strands all of it, silently, and it is the copy that cannot be migrated because it lives on devices. The app moves to **`/app` on the same origin**; the `…/**` entry above already covers it.
- **Not `capacitor://localhost` and not `http://localhost`.** `sync.js:349` gates `detectSessionInUrl` on `/^https?:$/`, so on the iOS shell it is `false`. A recovery token delivered to that origin could never be consumed. Allowlisting a destination the app cannot read converts a working reset into a dead end — see item 5.

**The reset path, stated plainly:** it is the bare origin today and
becomes `${SITE_URL}/app` after the split — one derived edit in
`legalLinks.js`, not a second literal.

---

## Severity table

| | Item | Severity |
|---|---|---|
| 1 | Audio format | **Not an issue** — already iOS-ready end to end |
| 1a | Recorded **bitrate** | **CLOSED — measured.** WebKit returns 32000; both ceilings stand. Desktop WebKit; re-check in the shell |
| 1b | `lecture-audio` bucket MIME restriction | **Would block every iOS upload.** Almost certainly fine; one dashboard click confirms |
| 2 | In-app account deletion | **Not an issue** — exists and satisfies 5.1.1(v) |
| 3a | `ITSAppUsesNonExemptEncryption` | **CLOSED — built.** Declared `<false/>` by `native-permissions.mjs` |
| 3b | `NSPhotoLibraryUsageDescription` | **CLOSED — built.** Declared, on the fail-towards-declaring argument |
| 3c | `PrivacyInfo.xcprivacy` | **Possible automated rejection.** Still unverified — needs the generated folder |
| 4 | Safe area — top and sides | **CLOSED — built.** Top, left and right added; sizing still needs a device |
| 5 | `capacitor://localhost` | Understood, no work; one consequence to communicate |
| 6 | Capacitor plugins | **None, and that is correct.** Do not add any |
| 7 | iPad | A decision, not a defect |

---

## A. What blocks the compile

**Nothing.** Checked rather than assumed:

- `mobile/package.json` declares `@capacitor/ios ^8.4.2` and the
  lockfile is committed.
- `mobile/capacitor.config.json` is complete: `appId`
  `com.uniplannerapp.planner`, `webDir` `www`, an `ios` block with
  `contentInset` and a background colour.
- `npm run add:ios` runs `cap add ios && npm run settings`, and
  `settings` is `permissions && signing && stamp-native`. All three
  are idempotent and skip a platform that is not present, so the
  sequence is safe on a machine that only has iOS.
- `scripts/stamp-native.mjs` already handles the iOS half:
  `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` (derived, monotonic),
  `IPHONEOS_DEPLOYMENT_TARGET = 15.0` and `CFBundleDisplayName`.
- `mobile/scripts/native-permissions.mjs` already patches
  `NSMicrophoneUsageDescription` **and** `NSCameraUsageDescription`
  into the plist's root dict, anchored on `</dict></plist>` so it
  cannot land inside a nested dict.

**Three things you supply, none of them in the repo:** Xcode with
CocoaPods, an Apple Developer Team selected in Signing &
Capabilities, and a device or simulator.

**One friction note on signing.** Android has
`mobile/scripts/native-signing.mjs`, which re-applies the release
signing config after every `cap add` because `mobile/android/` is
regenerated. **There is no iOS equivalent**, so the Team you pick in
Xcode lives inside `project.pbxproj`, which `cap add ios` regenerates
— you will pick it again every time. If that becomes annoying, a
`DEVELOPMENT_TEAM = …;` substitution in `stamp-native.mjs` alongside
the deployment target is a five-line change, and a Team ID is not a
secret so it can live in the script.

---

## B. What blocks or risks review

### 3a. `ITSAppUsesNonExemptEncryption` — **CLOSED, BUILT**

Declared `<false/>` in `mobile/scripts/native-permissions.mjs`, which
re-applies after every `cap add` and `cap sync`. One detail worth
knowing: **a plist boolean is an empty element**, and written as
`<string>false</string>` iOS reads a non-empty string as TRUE — so the
declaration would say the opposite of what was meant, silently. The
test asserts the value element's tag name, not its text.

The original reasoning:

Not a rejection. What it does is stop **every** TestFlight and App
Store Connect upload to ask the export-compliance question by hand.
The app uses HTTPS and nothing else, which is the exempt case, so the
answer is always the same. One boolean key, set once, in
`native-permissions.mjs` beside the two usage strings — that is where
plist edits live and it re-runs after every `cap add`.

### 3b. `NSPhotoLibraryUsageDescription` — **CLOSED, BUILT**

Declared, on the fail-towards-declaring argument below. It can be
removed later if the iOS build proves PHPicker is always used — but
removing it needs the evidence, not the reasoning.

The original reasoning, which is the argument for why:

`native-permissions.mjs`'s own comment reasons that the reading
summariser's photo input needs only the **camera** string, because
Photo Library and Files go through PHPicker, which hands back only
what the user picked and therefore needs no declaration. That
reasoning is correct **for the modern picker**.

What I could not verify from here is which picker WKWebView presents
on **iOS 15.0** — our deployment floor — for
`<input type="file" accept="image/*">`. If any route on any supported
version reaches the legacy `UIImagePickerController`, a missing
`NSPhotoLibraryUsageDescription` **terminates the app**, exactly the
way the camera string does, and on one of the three routes a student
is told to take.

**The cheap correct answer is to add the string.** An unused usage
string costs nothing — it is never shown if never triggered. A
missing one that turns out to be needed crashes the app on a route a
reviewer will try. This is the `MODIFY_AUDIO_SETTINGS` lesson in its
third costume: a permission that looks unnecessary from a desktop
browser, where there is no plist at all.

### 3c. `PrivacyInfo.xcprivacy`

Apple has required privacy manifests since May 2024: third-party SDKs
on the list must ship their own, and an app must declare any
"required reason" API it uses. **I could not check whether Capacitor
8's `cap add ios` scaffolds an app-level manifest** — the folder does
not exist on any machine yet.

Our app-level answer is simple whatever the scaffold does: no
tracking, no data linked to identity collected by the app binary, and
no required-reason API called from native code (everything is a web
API inside the WebView). If the scaffold has no manifest, adding one
saying exactly that is a small file. **This is the item most likely
to produce an automated App Store Connect email** rather than a human
rejection, which is worse only in that it arrives after the upload.

### 3d. `UIBackgroundModes` is absent, and must stay absent

Background recording is explicitly out of scope. Declaring `audio`
without implementing it invites a review question that can only be
answered with "we do not actually record in the background", which is
a worse conversation than not declaring it.

### Two review items that are already satisfied

- **5.1.1(v), in-app account deletion.** `src/accountDeletion.js`
  deletes the account's own audio objects, then calls
  `rpc("delete_my_account")`, which is `delete from auth.users where
  id = auth.uid()` (migration 0002). It is reachable on the Account
  tab (`PlannerApp.jsx:5263`) behind a typed confirmation phrase.
  Nothing to build. The store listing's Account Deletion URL is
  `https://www.uniplannerapp.com/delete-account`, which exists and is
  served network-only.
- **4.8, Sign in with Apple.** Only required if the app offers
  third-party or social login. We offer email and password only, so
  it is not required. Worth knowing before someone adds a Google
  button: doing so makes Sign in with Apple mandatory in the same
  release.

---

## C. What works but is broken at runtime — the band that actually matters

### 1. Audio format: the expectation was wrong, the path is already right

This was flagged as the most severe item and it is a non-issue. The
whole chain already handles iOS, and every link was checked:

| Link | What it does |
|---|---|
| `aiNotesLogic.js:187` `CANDIDATE_MIME_TYPES` | falls back `audio/webm;codecs=opus` → `audio/webm` → **`audio/mp4`** → **`audio/aac`**, picking the first `MediaRecorder.isTypeSupported` accepts. Safari supports `audio/mp4`, so iOS lands on m4a |
| `aiNotesClient.js:108` `EXTENSION_FOR_MIME` | maps all four, including both iOS ones |
| `aiNotesClient.js:131` the upload | the object path uses the **mapped** extension and `contentType` is the **real** mime type, not a hardcoded one |
| `ai-notes/config.ts:199` `AUDIO_EXTENSIONS` | `["webm", "m4a", "aac"]` — a server-side allowlist, and the comment names iOS as the reason it cannot be hardcoded |
| `ai-notes/index.ts` | **discovers** the real extension by listing the caller's own folder rather than trusting the request body |
| `groq.js` | receives `form.set("url", signedUrl)`, so no mime type is sent at all and the provider sniffs the container |

Nothing to build. Two adjacent risks, though, and the first is real.

#### 1a. The recorded bitrate — **CLOSED, MEASURED 22 August 2026**

**WebKit honours `audioBitsPerSecond`.** Desktop Safari on macOS, real
origin, `recorder.audioBitsPerSecond` read back after construction:
**32000**. Not ignored, not clamped. `MAX_BODY_BYTES` and the 50 MB
bucket ceiling stand exactly as derived — no re-derivation, no shorter
maximum recording, no segmentation at the recorder.

Two things to carry from it. **It is desktop WebKit**, so the same
thirty-second readback is worth repeating inside the shell on the
first iOS run; if iOS differs from macOS that is its own finding, and
the fallback ladder below is what it would trigger. And **the check
was a property readback rather than a recording** — construct the
object, read what it actually applied, and the question is answered
before any audio exists. That is the cheaper move to reach for first.

The original reasoning is kept below, because it is what made the
measurement worth taking.

#### 1a (as written before the measurement)

`aiNotes.jsx:304` passes `audioBitsPerSecond: 32000`. **Two separate
ceilings are derived from that number and nothing else:**

- `MAX_BODY_BYTES = 46_000_000` in `ai-notes/config.ts`, whose comment
  says so explicitly and says the two constants must move together;
- the `lecture-audio` bucket's **50 MB per-file limit**, set by hand
  per `SUPABASE-SETUP.md` and justified in the same sentence.

Chrome honours `audioBitsPerSecond`. **Safari's MediaRecorder is not
obliged to, and I have no evidence either way.** If it encodes AAC at
its own default:

| Actual bitrate | 3-hour lecture | Against the 50 MB bucket limit |
|---|---|---|
| 32 kbps (assumed) | ~43 MB | fits, as designed |
| 64 kbps | ~86 MB | **rejected at Storage** |
| 128 kbps | ~173 MB | **rejected at Storage** |

The failure is at the Storage upload, which happens **before** the
Edge Function is called — so nothing is billed and no allowance is
spent. It fails towards keeping the money and losing the lecture,
which is the right direction, but a student who records a two-hour
lecture and is told the upload failed has still lost it.

**This is a measurement, not a fix.** Record five minutes on the
device and read `blob.size`. At 32 kbps that is ~1.2 MB. If it is
materially larger, `RECORDER_AUDIO_BITS_PER_SECOND`, `MAX_BODY_BYTES`
and the bucket's file-size limit all move together — and the honest
answer may be that iOS needs a lower explicit bitrate or that the cap
needs raising, which is a decision, not a constant to nudge. It is
the single highest-value thing to learn from the first device
session, and it takes five minutes.

#### 1b. The bucket's MIME restriction — invisible from the repository

`SUPABASE-SETUP.md` never instructs anyone to set
`allowed_mime_types` on `lecture-audio`, and Supabase's default is
unrestricted, so this is very probably fine. It is named because if
that field was ever set to webm by hand, **every iOS upload 400s** and
nothing in the repository could tell you. One dashboard click:
Storage → `lecture-audio` → Configuration → Allowed MIME types should
be empty.

### 5. `capacitor://localhost` — understood, and one thing to communicate

Everything that keys off the origin was checked:

| Concern | State |
|---|---|
| `localStorage` | per-origin, so an iOS install starts empty and never mixes with the web app's planner. Expected; same as Android |
| service worker | excluded **twice over** (not `https:`, host is `localhost`) — and `prepare-native` strips `sw.js` from the bundle entirely, so there is nothing to register even if the gate were relaxed |
| `detectSessionInUrl` | `false`, correctly — `sync.js:349` requires `^https?:$` and `capacitor:` is neither |
| Supabase requests | plain outbound HTTPS from a custom-scheme origin. Supabase's CORS is permissive so this should work — **it is the one thing here I cannot verify without a device, and it is the thing whose failure would break everything.** Make it the first smoke test |
| `public/_headers` (CSP) | **does not apply.** Those headers are served by Cloudflare Pages for the web origin only; inside the shell the assets come from Capacitor's scheme handler, so **there is no CSP on iOS at all** |

On that last row: the CSP was defence in depth for an app that loads
no remote scripts, so its absence in the shell is not a hole that
needs plugging. A `<meta http-equiv>` policy would apply inside the
shell but would then also apply to the web build, where it would sit
alongside and potentially conflict with `_headers`. **Not
recommended.** Worth recording so nobody later assumes the shell is
covered.

**The one consequence to communicate rather than fix: a password-reset
link on an iPhone opens Safari, not the app.** The student resets on
the web app and then signs in inside the app with the new password.
That works; it just reads as a bug if nobody says so. Making the link
open the app needs Universal Links — an associated-domains
entitlement plus an `apple-app-site-association` file on the Pages
origin. A build item, not a launch requirement, and explicitly *not*
solved by allowlisting `capacitor://localhost` (see the top of this
document).

### 6. Capacitor plugins: there are none, and that is the right answer

`mobile/package.json` has exactly `@capacitor/core`, `@capacitor/ios`,
`@capacitor/android`, plus `@capacitor/cli` and `@capacitor/assets` as
dev dependencies. Everything the app does is a web API: recording is
`MediaRecorder`, the offline note cache is IndexedDB, photos are
`<input type="file">`, the planner is `localStorage`.

What that buys: nothing to audit for plugin permissions, nothing
extra in the privacy manifest, no Pod that can fail to build, and no
third-party SDK that needs its own `PrivacyInfo.xcprivacy`.

**Do not add one for launch.** The two that would be tempting:

- a **filesystem** plugin — not needed; the note cache is IndexedDB
  and is designed to be allowed to fail;
- a **background-audio** plugin — this is the one that would look
  attractive after the first backgrounding warning fires on a device.
  It is explicitly out of scope (CLAUDE.md), and on iOS it means the
  `audio` background mode plus an App Store review asking why a study
  app records in the background. Different product, different
  submission risk.

`src/audioSources.js` already handles iOS without a plugin: it
detects the platform (line 48), reports `system: {available: false,
reason: "mobile-platform"}` so the system-audio option is never
offered, and disables the device picker on iOS (line 120) because
WKWebView returns unlabelled devices that cannot be selected. All of
that is covered by the table-driven test.

---

## D. Cosmetic

### 4. Safe areas — **CLOSED, BUILT** (the bottom was done; the top and sides were not)

Added: `safe-area-inset-top` on the sticky header (padding on the
header, not its inner row, so the background fills the inset and only
the content moves down), and `safe-area-inset-left`/`-right` on the
header, `<main>` and the phone nav for landscape on a notched device.
The recording indicator's bottom inset is now unconditional — it used
to apply only when lifted over the tab bar, so on a layout without
that bar the pill sat in the home-indicator strip.

Where a Tailwind gutter already existed (`px-4` on `<main>`, `px-3` on
the indicator) the inset had to **add** to it rather than replace it,
so those moved into the inline style as `calc(1rem + env(...))`. A
plain `padding-left` in a later rule silently takes the gutter away.

A guard in `test-dark-mode.mjs` now **finds** every viewport-pinned
element in `src/*.jsx` rather than checking a list of three, and
requires the inset for whichever edge it pins to; the two centred
modals and the editor's in-panel toolbar are declared with reasons
that are themselves checked. **What it cannot see: layout.** Whether
the padding is the right size, whether `contentInset: "always"`
double-insets on top of it, and whether the pill clears the home
indicator all still need a device — see below and `MOBILE-BUILD.md`.

The original reasoning:

`viewport-fit=cover` is in `public/index.html:5`, which is the
prerequisite and is present. The **bottom** is handled in all three
places that need it:

- the fixed bottom nav (`PlannerApp.jsx:6137`)
- `<main>`'s padding, so the last card clears the nav
  (`PlannerApp.jsx:5898`)
- the floating recording indicator (`aiNotes.jsx:1111`)

**`safe-area-inset-top` does not appear anywhere in the repository**,
and `safe-area-inset-left` / `-right` do not either.

The header is `sticky top-0` (`PlannerApp.jsx:5796`) in the normal
flow, so on a notched iPhone its painted background runs under the
status bar and Dynamic Island. `contentInset: "always"` in
`capacitor.config.json` insets the *scroll view*, which partly covers
this — but it insets scrolled content, not a `position: sticky`
element's own background, and `contentInset: "always"` combined with
`viewport-fit=cover` is the classic double-inset pairing. **One of
`"always"` and `"never"` is right here and I cannot tell which from
source.** It is a two-minute A/B on the device.

The sides matter in **landscape** on a notched device: the shell is
`mx-auto max-w-2xl px-4`, so with the notch on the left the first
4 units of padding are all that stands between text and the cutout.

None of this breaks anything. It is listed as cosmetic and then
qualified: **the store listing is eight screenshots, and this is what
they show.** `SITE-ASSETS.md` specifies the Android set on the moto
g05; the iOS set would be taken on whatever device compiles first,
and a header tucked under the Dynamic Island is the first thing a
reviewer's eye lands on.

Not built, but the shape is one line each: `paddingTop:
env(safe-area-inset-top, 0px)` on the sticky header, and
`env(safe-area-inset-left/right)` on the shell container.

### 7. iPad — a decision, not a defect

The facts: the whole app is a single `mx-auto max-w-2xl px-4` column
(672px), with the fixed bottom bar spanning the full width but its
inner row also capped at `max-w-2xl`. On a 1024–1366px iPad that is a
phone-shaped app centred in a large window. **Nothing breaks and
nothing overflows** — there are only four `max-w-` constraints in the
whole app and they are all this pattern.

Capacitor's template targets both device families, so the default is
universal, which means the reviewer runs it on an iPad and the
listing needs iPad screenshots as well as iPhone ones.

**Recommendation: iPhone-only for the first submission.** Not because
iPad is broken — it isn't — but because "what should this look like
on a 1366px screen" is a design question and Grace has not ruled on
it, and the thing that actually binds the calendar is the closed-test
clock. Going universal later is a target-family setting plus a
screenshot set. Going iPhone-only later is a *removal of platform
support*, which is the direction that annoys people who already
installed it.

If universal is wanted anyway, two consequences follow:
`orientation: "portrait"` in `manifest.webmanifest` governs the PWA
only and does nothing for the native shell — Info.plist's
`UISupportedInterfaceOrientations~ipad` decides, and Capacitor's
template enables all four. That makes item 4's landscape case live,
and it brings iPadOS Split View resizing into scope. The layout is a
single centred column with a reflowing bottom bar, so the resize risk
is low; the safe-area risk is not.

---

## What I could not determine from here, and how each is settled

Listed rather than guessed at, because a plausible answer to any of
these would be a restatement of nothing.

| Unknown | How it is settled |
|---|---|
| ~~Does Safari's `MediaRecorder` honour `audioBitsPerSecond`?~~ | **Answered: yes, 32000, desktop WebKit.** Repeat the readback in the shell |
| Does `lecture-audio` carry a MIME restriction? | One dashboard click |
| Does Capacitor 8's `cap add ios` scaffold `PrivacyInfo.xcprivacy`? | Look in `mobile/ios/App/` after the first `cap add` |
| Is the safe-area padding the right SIZE, and does `contentInset` double-inset? | Look at it on the device; the insets are applied, the sizing is not provable from source |
| Which file picker does WKWebView present on iOS 15 for `accept="image/*"`? | Tap all three photo routes on a device. Or add the usage string and stop caring |
| Does `contentInset: "always"` double-inset with `viewport-fit=cover`? | A/B on the device |
| Does `localStorage` on `capacitor://localhost` survive an app update and storage pressure? | The aeroplane-mode item already on `MOBILE-BUILD.md`, never run on any platform |

---

## Recommended order

**Compile first.** The audit found no compile blocker, and a real
Xcode error is worth more than another hour of reading source. Then,
in this order:

1. **Smoke: does it load, and does a Supabase sign-in work from
   `capacitor://localhost`.** If that fails nothing else on this list
   matters.
2. **Read back `recorder.audioBitsPerSecond` in the shell.** Thirty
   seconds. Desktop WebKit says 32000; this confirms iOS agrees, and a
   disagreement is its own finding rather than a surprise later.
3. **Check for `PrivacyInfo.xcprivacy`** in the generated
   `mobile/ios/App/` — the one plist-adjacent item that could not be
   settled without the folder. The other three keys are already
   applied by `npm run settings`.
4. **Look at the safe areas on the device**, and settle
   `contentInset: "always"` versus `"never"` — one of the two is right
   and source cannot say which. The insets themselves are in.
5. **Decide iPhone-only vs universal**, before screenshots are taken
   rather than after.

Steps 2 through 4 are now checks rather than code: the plist keys and
the safe-area insets are built and mutation-checked, so what is left
on this list is confirming them against real hardware and one Xcode
folder that does not exist yet.
