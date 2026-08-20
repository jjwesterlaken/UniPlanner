# Compiling University Planner to a phone or tablet

**Android has been compiled and run on real hardware** (moto g05,
August 2026 — recording verified end to end, API 36 confirmed on the
generated project). **iOS has never been compiled at all.** These are
the two first-time guides — **Android for Jared on Windows**, **iOS
for Grace on a Mac** — and a verification list at the end that matters
more than the build itself.

Neither guide assumes you have built a mobile app before.

You do not need both. Android is the one to do first: it needs no paid
account to produce an installable file, and the Play Console's testing
requirement (below) is the longest lead item on the project.

---

## Before either platform

**THERE ARE TWO `package.json` FILES AND YOU MUST INSTALL BOTH.** The
root one builds the web app; `mobile/` has its own for Capacitor and the
CLI. A root `npm install` does not cover it, and skipping the second one
fails at `cap add` with `capacitor: not found` or `Cannot find module
@capacitor/cli` — which reads like a broken script rather than a missing
install. This step was previously listed as an aside and got skipped;
it is now the first thing on the page, and it is repeated inside each
platform's numbered steps so following one section alone works.

```bash
# from the repo root
npm install
npm run build          # builds the web app AND copies it into mobile/www

cd mobile
npm install            # SEPARATE, and required
```

`npm run build` must end with `native copies ready`. If it errors, stop —
the mobile projects would be built from a stale or missing copy.

**What the folders mean.** `mobile/ios` and `mobile/android` do not exist
in the repository and never will — they are generated per machine and
git-ignored. That is why settings live in scripts rather than in those
folders: `npm run settings` re-applies the microphone declarations, the
display name, the minimum OS versions and the version numbers after
every `cap add` or `cap sync`. **If you ever delete those folders and
regenerate, nothing is lost.**

---

## Android — on Windows

### 1. Install Android Studio

Download from `developer.android.com/studio` and install with the
defaults. On first launch it runs a setup wizard — accept the standard
installation, which fetches the SDK and an emulator image. This takes a
while and needs several GB.

You do **not** need to create an Android Studio project. It is here for
the SDK, the build tools and the device connection.

### 2. Generate the Android project

```bash
cd mobile
npm install            # if you have not already — see above, it is separate from the root install
npm run add:android
```

This scaffolds `mobile/android`, then applies our settings. Expect to see
`prepared`/`stamped` lines mentioning the microphone permission, the
display name and the version. **Read them** — a skipped line means
something did not apply.

### 3. Check the two numbers a store enforces

```bash
node ../scripts/stamp-native.mjs
```

The last line should say the target SDK meets the Play requirement. If it
prints a WARNING instead, tell Claude before going further — Google Play
requires new apps to target **API 36 from 31 August 2026**, and a lower
value is rejected at submission rather than at build time.

### 4. Open it and build

```bash
npm run open:android
```

Android Studio opens on the generated project. It will spend a few
minutes on "Gradle sync" the first time — this downloads the Android
Gradle plugin and dependencies. Wait for the status bar to go quiet.

**To run on a real phone:**

1. On the phone: Settings → About phone → tap "Build number" seven times.
   This enables Developer options.
2. Settings → Developer options → turn on **USB debugging**.
3. Plug the phone in. Accept the "Allow USB debugging?" prompt on the
   phone — it appears once per computer.
4. In Android Studio, the phone appears in the device dropdown at the
   top. Select it and press the green ▶ Run button.

**To run on the emulator instead:** pick any Pixel image from the same
dropdown. Good enough for a first look, but **the emulator cannot test
the microphone properly**, so the verification list below needs a real
device.

### What success looks like

The app installs, launches to the planner, and the home-screen icon reads
**UniPlanner**. The first launch shows the demo-mode banner unless you
sign in.

### To produce a file you can share

```bash
cd mobile/android
./gradlew assembleDebug          # Windows: .\gradlew.bat assembleDebug
```

The APK lands in `mobile/android/app/build/outputs/apk/debug/`. That file
can be sent to a tester and installed directly — **and it is what starts
the Play Console clock.**

### The release build — signed AAB for the Play Console

The debug APK above starts the tester clock; the Play Console upload
needs a **signed Android App Bundle**. Four steps, and the first one
carries the warning.

**1. Create the upload keystore — ONCE, and treat it like a passport.**

> ⚠️ **IF THIS FILE OR ITS PASSWORDS ARE LOST, YOU CANNOT UPDATE THE APP.**
> Recovering means a Play support request to reset the upload key, which
> takes days and is not guaranteed. If it is ever *committed or leaked*,
> anyone holding it can sign updates as you. So: create it **outside the
> repository**, back it up somewhere that is not this machine (a password
> manager attachment is fine), and never, ever put it in the repo — not
> even in `mobile/android/`, which is deleted and regenerated freely,
> which is exactly what must never happen to a keystore.

```bash
# From your home directory, NOT the repo:
mkdir -p ~/keystores
keytool -genkey -v -keystore ~/keystores/uniplanner-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

`keytool` ships with Android Studio's JDK. It will ask for a password
(pick one, store it with the backup) and some identity questions — the
answers are embedded in the certificate and never shown to users.

**2. Write `mobile/key.properties`** (beside, not inside, the generated
project, so regenerating `mobile/android/` does not destroy it — and
gitignored by name, with a test asserting the ignore entries exist):

```properties
storeFile=C:\\Users\\jjwes\\keystores\\uniplanner-upload.jks
storePassword=THE_STORE_PASSWORD
keyAlias=upload
keyPassword=THE_KEY_PASSWORD
```

**`keyAlias` must match whatever `-alias` you actually used in step 1.**
The two are `upload` above because that is what the command above
generates, and they have to agree or Gradle fails at signing time with an
error about a missing key rather than a mismatched one. If your keystore
came from different instructions — Jared's was made with
`-alias uniplanner` — then `keyAlias` is that name, and the step-1
command here is what a FRESH keystore should use rather than a
description of one you already have. Nothing in the repo can check this:
`key.properties` is gitignored and the keystore lives outside the repo
entirely, which is the whole point of both.

Use the absolute path to wherever step 1 put the keystore (forward
slashes work on Windows too: `C:/Users/jjwes/keystores/...`).

**3. Build.** The signing config is applied by
`mobile/scripts/native-signing.mjs`, which `npm run settings` already
runs — so the sequence from the repo root is:

```bash
npm run build                # web bundle + native prep
cd mobile
npx cap sync android         # re-applies permissions, signing, versions
cd android
./gradlew bundleRelease      # Windows: .\gradlew.bat bundleRelease
```

The signed bundle lands in
`mobile/android/app/build/outputs/bundle/release/app-release.aab`.

**4. Upload** that `.aab` in the Play Console (Testing → Closed testing
→ Create release), and enrol in **Play App Signing** when it offers —
Google then holds the app signing key and yours is only the upload key,
which is what makes a lost upload key recoverable *at all*.

Two things to know before tapping upload:

- The **versionCode is derived** (minutes since 2020) by
  `stamp-native.mjs`, so every build has a higher one automatically — a
  rejected build can be rebuilt and re-uploaded without editing
  anything.
- If the upload is rejected for a **target API level**, re-run
  `npm run settings` in `mobile/` and read its warning — it checks the
  generated project's targetSdk against Google's current floor.

**If `bundleRelease` produces an unsigned bundle**: `key.properties` was
not found. Check it is at `mobile/key.properties` (not inside
`mobile/android/`), then re-run `npx cap sync android` so the signing
script sees it.

### Failures most likely to come first

| What you see | What it means |
|---|---|
| `capacitor: not found`, or `Cannot find module @capacitor/cli` | `npm install` was not run **inside `mobile/`**. The root install does not cover it. |
| `SDK location not found` | Android Studio has not finished its first-run wizard, or `ANDROID_HOME` is unset. Open Android Studio once and let it finish. |
| Gradle sync fails on a download | Usually a proxy or a flaky network. Retry the sync before investigating. |
| `Installation failed: INSTALL_FAILED_UPDATE_INCOMPATIBLE` | An older build with the same identifier is installed. Uninstall the app from the phone and run again. |
| The app opens to a white screen | `mobile/www` is empty or stale. Run `npm run build` from the repo root, then `npx cap sync android`. |
| Recording does nothing, no permission prompt | `RECORD_AUDIO` is missing from the manifest — `npm run settings` was not run after `cap add`. |
| **"Microphone access was denied" AFTER you tapped Allow** | Look in Logcat for `Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO. No audio device will be available for recording`. That is the **manifest**, not the user: Android's WebView needs both permissions declared before it will expose an audio device at all, and a runtime grant does not substitute. Fixed in the script — re-run `npm run settings` and rebuild. |
| A red **"JWT issued at future"** banner | The **device clock is ahead of real time**, so the token looks like it was issued in the future and the server rejects it. Fix the phone's Date & time (turn on "Set automatically"). Nothing to do with the app. |

---

## iOS — on a Mac

### 1. Install Xcode

From the Mac App Store. It is large (~10 GB) and slow; start it before
you need it. Then open it once and accept the licence, or the command
line tools refuse to run.

Then, in a terminal:

```bash
sudo xcode-select --install       # command line tools, if not already there
sudo gem install cocoapods        # dependency manager Capacitor uses
```

If `gem install` fails on permissions, use `brew install cocoapods`
instead.

### 2. Generate the iOS project

```bash
cd mobile
npm install            # if you have not already — see above, it is separate from the root install
npm run add:ios
```

This scaffolds `mobile/ios` and applies our settings. **Read the output**
— you should see the microphone usage description, the display name and
the deployment target applied. A skipped line means something did not.

### 3. Open it and run

```bash
npm run open:ios
```

Xcode opens `App.xcworkspace`. **Always the workspace, never the
`.xcodeproj`** — the project alone does not include the CocoaPods
dependencies and will fail to build with confusing errors.

**Signing, the first-time step everyone hits:**

1. Click **App** in the left sidebar (the blue project icon at the top).
2. Select the **App** target → **Signing & Capabilities** tab.
3. Tick **Automatically manage signing**.
4. In **Team**, choose your Apple ID. If none is listed: Xcode →
   Settings → Accounts → **+** → Apple ID, and sign in. A free Apple ID
   works for running on your own device; the paid Developer Program is
   only needed for TestFlight and the App Store.

**To run on a real iPhone or iPad:**

1. Plug it in. Unlock it and tap **Trust This Computer**.
2. Select the device in the dropdown at the top of Xcode.
3. Press ▶.
4. The first run fails with *"Untrusted Developer"*. On the device:
   Settings → General → **VPN & Device Management** → tap your Apple ID →
   **Trust**. Press ▶ again.

**On a free Apple ID the app expires after 7 days** and must be rebuilt.
That is normal and not a fault.

### What success looks like

The app installs, launches to the planner, and the home-screen label
reads **UniPlanner**. Recording a lecture prompts once for microphone
access with our wording, not Apple's generic text.

### Failures most likely to come first

| What you see | What it means |
|---|---|
| `capacitor: not found`, or `Cannot find module @capacitor/cli` | `npm install` was not run **inside `mobile/`**. The root install does not cover it. |
| `No such module 'Capacitor'` | You opened `.xcodeproj` instead of `.xcworkspace`. |
| `Signing for "App" requires a development team` | Step 3 above was skipped. |
| `Command PhaseScriptExecution failed` | Usually CocoaPods. `cd mobile/ios/App && pod install`, then reopen the workspace. |
| The app opens to a white screen | `mobile/www` is empty or stale. `npm run build` from the root, then `npx cap sync ios`. |
| Recording is refused with no prompt | `NSMicrophoneUsageDescription` is missing — `npm run settings` was not run after `cap add`. **This is also an instant App Store rejection**, so fix it before submitting anything. |

---

## THE FIRST MIGRATION — DONE, 20 August 2026

**All six steps below passed end to end**, with 0009 applied
(`data_type = text` confirmed) and three notes migrated carrying
base36 ids. The AI-notes storage move has therefore run in production
for the first time since 0005 shipped. The checklist is kept verbatim
because it is the shape a future first-run check should take, and
because step 3's trap (below) is the kind of thing that gets
rediscovered the expensive way.

**What it was: six code paths that had never run in production.** `ai_notes.id` was
typed `uuid` while page ids come from the planner's own base36 helper,
so every insert was rejected with 22P02 from migration 0005 until 0009
moved the column. The feature failed *safely* every time — the note
stayed whole and readable in the blob — which is exactly why nobody
noticed for eleven days.

So the first successful migration fired five things at once, none of
which had any production evidence behind it. They were run in this
order, after 0009 was applied and both functions deployed. **Everything here works in
the web app** — the phone only matters where it says so.

Do them in order: each one leaves the state the next needs.

| # | Check | Where | What it exercises |
|---|---|---|---|
| 1 | Save an AI note while signed in, wait ~5s for a sync, then look for a row in `ai_notes` with a **base36 id** (`msn0duf5-hk684`, not a UUID) | web | the insert — 0009 itself |
| 2 | The note still renders, and the Backup panel's size drops. The stub is ~517 bytes where the note was several KB | web | `buildStub`, and the blob actually shrinking |
| 3 | Open the same note in a **private window or a second browser signed into the same account** | web | **`fetchNote`'s content branch** |
| 4 | Back in the original window: go offline (devtools → Network → Offline, or real aeroplane mode) and open the note | web, then phone | `noteCache` serving a note for the first time |
| 5 | Delete an AI note, then confirm the `ai_notes` row is gone | web | `deleteNote`'s remote half, and the row-first ordering |
| 6 | Archive a semester holding an AI note: it leaves the Notes list, stays listed under "Archived lectures", and still opens | web | `archivedIn`, and that archiving never tombstones a stub |

**Step 3 is the one that is easy to get wrong, and I nearly wrote it
wrongly.** "Close and reopen the app" does NOT exercise `fetchNote`:
the viewer is **cache-first**, and a successful migration writes the
cache on the way past — so on the device that migrated, the note comes
from IndexedDB and the network path never runs. It needs a profile
with the synced blob and an empty cache, which is what a private
window or a second browser gives you. A second device does too.

**Step 4 needs the opposite** — a WARM cache — so it belongs on the
device that did the migration, and it must come after step 1 rather
than after a fresh sign-in. On the phone it is also verification-list
item 1 (IndexedDB existing at all); doing it in a desktop browser
first tells you the code is right, and doing it on the phone tells you
the platform cooperates. Both are worth having, in that order.

**If a step fails, the failure is contained to its own path** rather
than being a mystery — which is the whole reason for running them
deliberately instead of waiting to notice. Note what failed and stop;
the paths below it depend on the ones above.

## The verification list — do this on real hardware

The build succeeding proves almost nothing. These are the behaviours that
have never run outside a desktop browser, and each has a specific reason
to doubt it.

### What has actually been run, and on what

**Android, moto g05, 14 August 2026 — the recording chain passes.**
Items **9, 9a, 9b and 9c** were all confirmed on the device, in that
order, which is the order they unblock each other in: without 9c there
is no microphone, and without a microphone nothing below it can be
tested at all.

Two bugs were found by that hardware and by nothing else, which is the
argument for the list:

- the `folders` `ReferenceError` that white-screened the AI Notes panel
  for **every signed-in user on every platform** — invisible to the
  suite because the panel refuses to render without an account, and
  demo mode is the only mode the smoke walk runs in;
- the missing `MODIFY_AUDIO_SETTINGS` declaration, which made the
  WebView report "microphone access was denied" to someone who had just
  granted it. No desktop browser has a manifest, so no environment the
  suite runs in could have been unhappy about it.

**Everything else on this list is still outstanding**, and the groups
worth naming because it is easy to read "hardware verified" as covering
them:

| Group | State |
|---|---|
| Storage and offline (1–4), including the aeroplane-mode test | **not run** |
| Sync across devices (5–6) | **not run** |
| No service worker on either platform (7) | **not run** — Android is the live risk |
| "Record from" wording and the Bluetooth-headset case (10–11) | **not run** |
| **iOS, all of it** | **not run** — nothing has been compiled to an Apple device |

The renderer-recovery hardening below is also still open: the crash that
triggered it is fixed, the *response* to the next one is not.

### The bottom tab bar — phone widths

**What the suite covers and what it cannot.** jsdom has no layout, so
`test-app-smoke.mjs` mounts the app twice — once with no `matchMedia`
(the top bar) and once with it stubbed to a phone width (the bottom
bar) — and asserts both offer the same six destinations, in the same
order, with exactly one nav in the DOM. That is the contract every
deep link and walk assertion rests on. **Placement is not covered at
all**, because nothing in jsdom has a position. These are the items
only a device can answer:

13. **The bar clears the home indicator (iOS) and the gesture bar
    (Android).** `env(safe-area-inset-bottom)` plus `viewport-fit=cover`
    should handle it; the failure looks like the labels sitting under
    the gesture pill, or a dead strip you have to tap twice.
13a. **The recording indicator sits ABOVE the bar, not under it.**
    Start a recording, leave the AI tab, and check both the timer and
    its Stop button are fully tappable. "I can't stop the recording" is
    a privacy problem before it is a usability one, and this is the one
    existing element that competes for the same space.
13b. **Rotating to landscape**, where a phone can cross the 640px
    breakpoint mid-session: the bar should move to the top and back
    without losing the current tab.
13c. **The last tab survives a force-quit** — reopen and land where you
    left off, not on Plan. On a first-ever install it lands on Plan.

The breakpoint is **viewport width, not shell detection** (640px,
Tailwind's `sm`): all three shells run the same React, so a Capacitor
phone and a narrow browser window are the same situation and behave
identically. A 380px desktop window therefore gets the phone bar, which
is intended.

### Storage and offline

1. **IndexedDB exists at all.** Open an AI lecture note, then check the
   note is still readable after force-quitting and reopening the app.
   iOS serves the app from `capacitor://localhost` and Android from
   `http://localhost`; neither origin has ever been exercised, and the
   offline note cache is the only thing that makes a note readable
   without a connection.

2. **THE AEROPLANE-MODE TEST — the one that actually matters.** Open a
   lecture note while online. Turn on aeroplane mode. Force-quit the app,
   reopen it, and open the same note.
   - **Pass:** the note reads normally.
   - **Fail:** "Couldn't load this note."
   
   A fail here means the cache is not working on that platform, and
   offline notes are the feature students will rely on in a lecture
   theatre with no signal.

3. **A failed cache must not look like a deleted note.** Still in
   aeroplane mode, open a note you have *never* opened before. It must
   say it couldn't load — **never** that it was deleted. If it reports
   deletion, stop and report it: that is the failure that would remove a
   student's notes.

4. **Cache survives a restart.** Open several notes, force-quit, reopen,
   and confirm they are all still readable offline.

### Sync

5. **Delete on the phone, gone on the laptop.** Sign in on both. Delete
   an AI note on the phone. Sync on the laptop. It should disappear —
   and it should *stay* gone after another sync, not come back.

6. **Notes made on the laptop appear on the phone**, and open correctly.

### The service worker rule

7. **No service worker on either platform.** In Chrome on Windows, with
   the Android phone connected: `chrome://inspect` → inspect the app's
   WebView → Application tab → Service Workers. The list must be
   **empty**. On iOS, Safari → Develop menu → the device → Application.

   This is the rule that has never been tested on real hardware. Android
   is the one to check carefully: `http://localhost` *is* a secure
   context, so it is excluded only by the protocol check in
   `index.html`, and a worker there would cache the bundled files and
   shadow a future app-store update.

### Recording

8. **Microphone prompt appears**, and its wording is ours — mentioning
   that the recording is deleted once transcribed.
9. **Record a short lecture end to end**, save it, and confirm it files
   itself into a `<COURSE> recordings` folder.
9a. **Switch tabs while recording.** The timer must appear at the bottom
    of every other tab, keep counting, and offer **Stop** without going
    back. Then stop from there and check the note saves with the right
    course and week. This used to lose the whole recording.
9b. **Background the app mid-recording**, then return. A warning should
    say part of it may be silent. Confirm the recording did NOT stop —
    and if the audio really is silent for that stretch, say so, because
    it decides whether the warning is strong enough.
9c. **Tapping Allow on the mic prompt actually gives you a microphone.**
    If the app says access was denied straight after you granted it, see
    the MODIFY_AUDIO_SETTINGS row in the Android table above — that is a
    manifest problem, not a permissions one, and everything below it is
    blocked until recording works.
10. **"Record from" offers Microphone only**, with "This computer's
    audio" greyed out and reading *"Phones and tablets can only record
    through the microphone."* An option that is simply missing is a
    fail — the student should be told, not left guessing.
11. **Unplug a Bluetooth headset mid-recording.** The recording must
    continue on the built-in microphone. If it stops or errors, the
    device constraint is being requested as `exact` somewhere.

### Photographed pages

12. **Photograph a page and summarise it**, on the phone: AI tab →
    Summarise a reading → Add photos → camera. This is the first time
    `downscalePhoto` (Image + canvas) runs anywhere real — jsdom cannot
    execute it — so the whole path is unproven until this passes. Check
    the photo thumbnail appears, the estimate reads in parts, and the
    saved note lands in the course folder.
12a. **The same via the desktop file picker** — same code, different
    entry, and the `capture="environment"` attribute must not have made
    file selection impossible on desktop.
12b. **A deliberately blurry photo.** Expect the "couldn't read photo N"
    message naming the page, not a garbage summary. This is the model
    following an instruction rather than code enforcing a rule, so it is
    exactly the behaviour that needs a real run.

### Handwriting — removed

The two iPad items that used to sit here (Apple Pencil pressure, and a
real handwriting sample) are void: **handwriting was removed entirely
on 16 August 2026** — the feature and the stored ink both. The sample
Grace sent on 15 August did its work before the decision; nothing on
this list tests ink any more, and a pre-removal note now opens as a
titled empty text note ("Empty note" in the list).

---

## Hardening, not yet done

**A dead WebView renderer white-screens forever.** When the Chromium
renderer process is killed — which is what a JavaScript crash escalated
to on the moto g05 — Android schedules a service restart, but the app
shows a permanent white screen and only a force-quit recovers it. The
crash that caused it is fixed, but the *response* to a future one is
still "the app is bricked until relaunched".

Capacitor exposes `onRenderProcessGone`. Handling it to reload the
WebView would turn a permanent white screen into a flicker. Deliberately
not done in the same change as the crash fix, so the fix can be verified
on hardware without a second variable in it.

---

## Still to decide, before the first submission

These are cheap now and awkward later.

- **Google Play developer account.** Personal accounts have needed a
  closed test with ~12 testers running the app for ~2 weeks before
  production access is granted. **Confirm the current requirement in the
  Play Console** — if it still applies, it is the longest lead item on
  the project, and it can start as soon as the debug APK from step 4
  exists.
- **Apple Developer Program** ($99/yr). Enrolment verification can take
  days and nothing on iOS ships without it.
- **Windows code signing.** A certificate is a few hundred dollars a
  year. Without one, SmartScreen warns every downloader of the desktop
  build. Not worth solving before there are downloaders — but decide it
  rather than discover it.
- **Mac notarisation** comes free with the Apple account once active.
