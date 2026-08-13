# Compiling University Planner to a phone or tablet

Nothing has ever been compiled to a device. These are the two first-time
guides — **Android for Jared on Windows**, **iOS for Grace on a Mac** —
and a verification list at the end that matters more than the build
itself.

Neither guide assumes you have built a mobile app before.

You do not need both. Android is the one to do first: it needs no paid
account to produce an installable file, and the Play Console's testing
requirement (below) is the longest lead item on the project.

---

## Before either platform

Both start from the repo root.

```bash
npm install
npm run build          # builds the web app AND copies it into mobile/www
```

`npm run build` must end with `native copies ready`. If it errors, stop —
the mobile projects would be built from a stale or missing copy.

Then install the mobile toolchain, once:

```bash
cd mobile
npm install
```

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
the microphone properly and has no stylus**, so the verification list
below needs a real device.

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

### Failures most likely to come first

| What you see | What it means |
|---|---|
| `SDK location not found` | Android Studio has not finished its first-run wizard, or `ANDROID_HOME` is unset. Open Android Studio once and let it finish. |
| Gradle sync fails on a download | Usually a proxy or a flaky network. Retry the sync before investigating. |
| `Installation failed: INSTALL_FAILED_UPDATE_INCOMPATIBLE` | An older build with the same identifier is installed. Uninstall the app from the phone and run again. |
| The app opens to a white screen | `mobile/www` is empty or stale. Run `npm run build` from the repo root, then `npx cap sync android`. |
| Recording does nothing, no permission prompt | `RECORD_AUDIO` is missing from the manifest — `npm run settings` was not run after `cap add`. |

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
| `No such module 'Capacitor'` | You opened `.xcodeproj` instead of `.xcworkspace`. |
| `Signing for "App" requires a development team` | Step 3 above was skipped. |
| `Command PhaseScriptExecution failed` | Usually CocoaPods. `cd mobile/ios/App && pod install`, then reopen the workspace. |
| The app opens to a white screen | `mobile/www` is empty or stale. `npm run build` from the root, then `npx cap sync ios`. |
| Recording is refused with no prompt | `NSMicrophoneUsageDescription` is missing — `npm run settings` was not run after `cap add`. **This is also an instant App Store rejection**, so fix it before submitting anything. |

---

## The verification list — do this on real hardware

The build succeeding proves almost nothing. These are the behaviours that
have never run outside a desktop browser, and each has a specific reason
to doubt it.

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

### Handwriting — for Grace on the iPad

10. **Apple Pencil pressure works**: pressing harder gives a thicker
    line. A finger should draw a constant width.
11. **Please send one page of real handwriting**, then export a backup
    from the Account tab and send the file. It is needed to finish the
    ink-compression work, and synthetic strokes cannot answer the
    question.

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
