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
| **1a** | **Recorded bitrate on iOS** | **OPEN — BLOCKS SUBMISSION.** ~218 kbps against a 32 kbps assumption. A 2-hour lecture is ~196 MB and fails on upload |
| 1 | Audio format | **CLOSED — verified on device.** iOS records `audio/webm; codecs=opus`, the same container and codec as Android |
| 1b | `lecture-audio` bucket MIME restriction | **Would block every iOS upload.** Almost certainly fine; one dashboard click confirms |
| 2 | In-app account deletion | **Not an issue** — exists and satisfies 5.1.1(v) |
| 3a | `ITSAppUsesNonExemptEncryption` | **CLOSED — built.** Declared `<false/>` by `native-permissions.mjs` |
| 3b | `NSPhotoLibraryUsageDescription` | **CLOSED — built.** Declared, on the fail-towards-declaring argument |
| 3c | `PrivacyInfo.xcprivacy` | **Possible automated rejection.** Still unverified — needs the generated folder |
| 4 | Safe area — top and sides | **CLOSED — built.** Top, left and right added; sizing still needs a device |
| 4b | Overscroll gutter shows a light ground | **CLOSED — built.** `html` had no themed background; fixed at the root, so no `contentInset` A/B needed |
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

### 1. Audio format — **CLOSED, VERIFIED ON DEVICE**

**No divergence.** In WKWebView on a real iPhone,
`isTypeSupported("audio/webm;codecs=opus")` is **true**, and a real
recording produces `mimeType: "audio/webm; codecs=opus"` with data. iOS
records the same container and the same codec as Android, so the
fallback ladder never has to leave its first rung and the
format-handling concern is void.

Worth keeping: the ladder and the server's extension discovery were
built for a divergence that turned out not to exist. They cost nothing
and they are still correct — the point was never that iOS *would*
differ, but that the code could not know. What is now settled is that
`m4a` and `aac` are dead paths in practice rather than in principle.

The audit as originally written, kept because the chain it traces is
what made the answer cheap to confirm:

| Link | What it does |
|---|---|
| `aiNotesLogic.js:187` `CANDIDATE_MIME_TYPES` | falls back `audio/webm;codecs=opus` → `audio/webm` → **`audio/mp4`** → **`audio/aac`**, picking the first `MediaRecorder.isTypeSupported` accepts. Safari supports `audio/mp4`, so iOS lands on m4a |
| `aiNotesClient.js:108` `EXTENSION_FOR_MIME` | maps all four, including both iOS ones |
| `aiNotesClient.js:131` the upload | the object path uses the **mapped** extension and `contentType` is the **real** mime type, not a hardcoded one |
| `ai-notes/config.ts:199` `AUDIO_EXTENSIONS` | `["webm", "m4a", "aac"]` — a server-side allowlist, and the comment names iOS as the reason it cannot be hardcoded |
| `ai-notes/index.ts` | **discovers** the real extension by listing the caller's own folder rather than trusting the request body |
| `groq.js` | receives `form.set("url", signedUrl)`, so no mime type is sent at all and the provider sniffs the container |

Nothing to build. Two adjacent risks, though, and the first is real.

#### 1a. The recorded bitrate — **OPEN, AND THE HIGHEST-SEVERITY ITEM ON iOS**

**It blocks submission.** A 2-hour lecture — the use case — cannot be
uploaded from an iPhone today.

##### The correction: a readback measured the request, not the output

`recorder.audioBitsPerSecond` reads back as **32000** on iOS, exactly as
asked. Four 3-second recordings on a real iPhone produced:

| | bytes |
|---|---|
| | 81,457 |
| | 81,701 |
| | 82,228 |
| | 82,270 |

Mean **81,914 bytes over 3 s = 218 kbps**, which is **6.8× what was
requested**. Two details make that number trustworthier than a
three-second sample usually is: the spread across four runs is **1.0%**,
so the encoder is running at a near-constant rate rather than varying
with content, and treating a generous 2 KB of it as fixed container
header still leaves 213 kbps — the same order.

So WKWebView **accepts the constructor option, reports it faithfully,
and the encoder ignores it.** The property readback confirmed what was
accepted. Only the produced bytes confirm what was applied. That
correction is recorded in `CLAUDE.md` next to the technique it
qualifies, because the technique is still right — it is just answering
a different question than the one I claimed for it.

##### What it costs at the ceilings we have

| rate | 1 h | 2 h | 3 h |
|---|---|---|---|
| 32 kbps (assumed) | 14 MB | 29 MB | **43 MB** |
| **218 kbps (measured)** | **98 MB** | **196 MB** | **294 MB** |

Read the other way, the two ceilings encode an assumption about the
rate: `MAX_BODY_BYTES` (46 MB) is **34 kbps** over three hours, and the
bucket's 50 MB per-file limit is **37 kbps**. Both are ~6× below what
iOS produces.

**The failure today is late and uninformative**, which is its own
finding: nothing checks the blob size on the client, so the student
waits through as much of a 196 MB upload as their connection allows,
Storage rejects it, and they are told "Couldn't upload the recording"
with no reason. Nothing is billed — the ordering holds — but the
lecture is gone and the message explains nothing.

##### The hypothesis to test first, because it is ours, not Apple's

`micConstraints` asks for `channelCount: 1, sampleRate: 16000`. **The
recorder never sees that track.** `buildGraph` in `src/aiNotes.jsx`
does `new AudioCtx()` with no options and `createMediaStreamDestination()`
with no channel configuration — on iOS that is a **48 kHz context and a
stereo destination** — and *that* stream is what `MediaRecorder` is
constructed with.

48 kHz stereo against 16 kHz mono is 6× the input data, and the
discrepancy is 6.8×. Chrome's Opus encoder honours `audioBitsPerSecond`,
so on Android and every desktop the output is 32 kbps whatever the graph
feeds it — which is exactly why this has never shown up anywhere else.
Where the encoder ignores the bitrate, **the graph's shape becomes the
bitrate.**

That is a hypothesis, not a finding. `public/measure-audio.html` settles
it: six configurations, 20 seconds each, real bytes over real elapsed
time. Rows 1 vs 2 say whether our graph is the cause; 2 vs 3 whether a
mono 16 kHz graph fixes it; 1 vs 4 whether `audioBitsPerSecond` does
anything at all; 5 and 6 whether the AAC path honours it where Opus does
not.

##### The options, costed

| | work | what it fixes | what it leaves |
|---|---|---|---|
| **D. Fix the graph** (not on the original list) | ~2 lines + a fallback | the rate at source, on every platform | nothing, if it works — untested |
| **E. Prefer `audio/mp4` on iOS** | a per-platform reorder of `CANDIDATE_MIME_TYPES` | the rate, if AAC honours the bitrate | server already accepts `m4a`; costs nothing to try |
| **A. Raise both ceilings** | one constant + a dashboard setting + Pro | the rejection | a **294 MB single PUT with no resume** |
| **C. Recorder segmentation** | large, on the billing path | the rejection *and* the no-resume upload | boundary gaps, N transcriptions to stitch |
| **B. Re-encode client-side** | largest | the rate | a WASM dependency, a CSP change, minutes of phone CPU |

**Why A is not sufficient on its own**, even though Pro is happening
anyway: `supabase.storage.upload` is a single PUT with **no resumable
upload**, so a 294 MB body that drops at 90% restarts from zero. At a
realistic 5 Mbps up that is an 8-minute window with no fault tolerance,
and on cellular it is ~300 MB of someone's data plan spent without
being asked. It is also well past anything anyone has asked Groq to
fetch from a signed URL. Raising a ceiling so a legitimate recording is
never rejected by our own arithmetic is right; making 294 MB the normal
case is not.

**Why B is last.** A WASM Opus encoder is ~300 KB, needs a worker, needs
`wasm-unsafe-eval` added to a CSP that was deliberately tightened, needs
`test-local-only.mjs` revisited, and puts minutes of CPU between the
student and their notes — in a bundle whose whole shape is "no
framework, nothing third-party at runtime".

##### Recommendation

**Fix the input, not the ceiling. In order:**

1. **Run `public/measure-audio.html` on the phone.** Six rows, about
   two and a half minutes of talking.
2. **If row 3 lands near 32 kbps: take D.** Two lines in `buildGraph`
   — `new AudioCtx({ sampleRate: 16000 })` and a mono destination —
   with a fallback to the default context if Safari refuses the rate,
   since a graph that throws is fatal for "Both". Ship that.
3. **If row 3 does not but rows 5/6 do: take E** as well or instead,
   preferring `audio/mp4` where AAC honours the bitrate.
4. **Take A regardless, as the backstop**, sized to whatever D and E
   actually produce plus real headroom — because iOS gives us no direct
   control over the rate, so the ceiling must never be the thing that
   fails a legitimate two-hour lecture.
5. **Add the client-side size check in the same pass**, whatever wins:
   compare `blob.size` against the ceiling *before* the upload starts,
   and say what happened. A refusal in one second beats the same refusal
   after eight minutes of uploading.
6. **C only if 2 and 3 both fail.** It is the right answer to "the rate
   cannot be brought down", and the wrong first answer to "the rate is
   wrong because of something we do".

**Not on the list, by ruling: capping the maximum recording length.** A
two-hour lecture is the use case.

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

### 4b. The overscroll gutter — **REOPENED. The CSS is correct and the bars are not the document.**

**The root fix landed and did not fix it.** On device, dark mode, with
`98e4b71` present:

```
getComputedStyle(document.documentElement).backgroundColor → "rgba(0, 0, 0, 0)"
getComputedStyle(document.body).backgroundColor            → "rgb(24, 22, 20)"
```

Checked from this end, in order:

- the rule is in `src/input.css`;
- it survives minification — `dist-web/app.css` contains
  `body,html{height:100%;background-color:rgb(var(--page))}`;
- **nothing overrides it.** Tailwind's preflight sets `line-height`,
  `tab-size` and a font stack on `html` and no background at all;
- and in **real Chromium, loading the built page**, the root computes
  to `rgb(24, 22, 20)` in dark and `rgb(245, 245, 244)` in light. That
  is `scripts/test-computed-ground.mjs`, and it goes red if the rule
  stops reaching the root.

So the rule reaches `html` in a spec-compliant engine. Two things could
still explain the device reading, and **one line tells them apart** —
run this in the shell before anything else is built:

```js
[...document.styleSheets]
  .flatMap(s => { try { return [...s.cssRules]; } catch (e) { return []; } })
  .filter(r => /html/.test(r.selectorText || ""))
  .map(r => r.cssText)
```

**If the rule is absent, the shell is running an older bundle.** Worth
checking specifically because the stated evidence for the build being
current — "the clipping fix is visible" — is evidence for `dbab56b`,
the safe-area commit, which is the one *before* the root background.
`cap sync` copies from `mobile/www`, which `prepare-native` rebuilds
from `dist-web`, so a `build:web` that did not run leaves both stale
together.

**If the rule is present, the reading is correct and the bars are not
the document.** CSS Backgrounds §2.11.2: when the root element has a
background, it is propagated to the canvas and *"the root element does
not paint this background again, i.e. the used value of its background
is transparent."* Blink reports the computed value there; WebKit
reports the used one. On that reading `rgba(0, 0, 0, 0)` is what
success looks like — the ground went to the canvas — and `body`
showing the real colour is the corroboration, because body only paints
its own background once html has one to propagate.

Which would mean **the white bars are outside the canvas entirely**:
WKWebView's own scroll-view background in the rubber-band overhang,
and that is `capacitor.config.json`'s hardcoded `#f5f5f4` — the
unthemeable colour already recorded two sections down as a limitation.
No CSS can reach it. The remedies are all native:

| | what it takes | cost |
|---|---|---|
| set the web view's background from native | a few lines in the generated iOS project, applied by `mobile/scripts/` like the plist keys | has to be re-applied after every `cap add`, and it has to learn the theme — which means reading the same localStorage key from native, or a bridge call on mode change |
| `overscroll-behavior: none` on the document | already set for `y` on body; needs to reach the root, and WebKit support starts at **iOS 16** against our 15.0 floor | free where supported, nothing below it, and it removes the bounce rather than colouring it |
| accept it | nothing | white bars at both ends for dark-mode students on an overscroll |

**Nothing built until the one-liner comes back**, because the two
explanations have no remedy in common.

### 4b (as written when it was believed to be a root-element defect)

Reported off the first iOS build: white bars at the top and bottom,
visible only when overscrolling to either end, with the header and nav
correctly inset. Diagnosed and fixed at the root, so the
`contentInset` A/B is not needed for this.

**Was the root themed?** `body` was, `html` was not. In a normal
browser that is enough — with no background on the root element,
body's **propagates to the document canvas**, which is what fills the
overscroll gutter, so every desktop browser was already correct in
dark mode. WKWebView's rubber-band overhang reads the **root
element's own** background instead, found it transparent, and fell
through to the web view's background: a hardcoded `#f5f5f4` in
`mobile/capacitor.config.json`.

**Would it show in light mode?** No — and the reason is the finding.
`--page` in light mode is `245 245 244`, which is **exactly**
`#f5f5f4`. The unthemed native ground and the light theme's page
colour coincide to the byte, so the defect was real in both modes and
visible in only one. That coincidence is why it survived every
desktop check and every light-mode device.

**The fix** is one line: `html, body { background-color:
rgb(var(--page)); }`. Both are the same variable, so light mode is
byte-identical and body simply paints its own ground instead of
propagating it.

**Three static colours still cannot follow the theme**, and that is a
limitation rather than a bug: `capacitor.config.json`'s three
`backgroundColor` values, and the manifest's `background_color` and
`theme_color` with the matching `<meta name="theme-color">`. They are
static JSON and a meta tag read before any script runs. Light is the
only defensible value for each, so a test now asserts they **equal**
the light tokens, derived from `input.css` — turning the coincidence
that hid this into a checked relationship. Change the light ground and
the shell files go red by name.

What that leaves: the web view's colour is still what paints the very
first frame, so a dark-mode student gets a light flash at launch. That
is a launch-screen problem, not an overscroll one, and it is smaller
than what was fixed — recorded here rather than fixed, because the
only remedies are native.

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
