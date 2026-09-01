# The Mac rebuild: from a wiped machine to an uploaded build

Assumes NOTHING survives except the phone's Developer Mode and the App
Store Connect record. Every step carries the check that proves it
landed — do not proceed on "it probably worked", because half the
failures below are silent and the other half surface forty minutes
later inside Xcode.

DEPLOY-CHECKLIST style: command, then check, in order.

---

## 0. Xcode — start the download FIRST

It is tens of gigabytes and everything else fits inside its download
time.

1. App Store → **Xcode** → install. When done, open it once (it
   installs its tools on first launch and asks for a password), then:

   ```
   sudo xcode-select -s /Applications/Xcode.app
   xcodebuild -version
   ```

   **Check:** prints an Xcode version, not an error about command-line
   tools. The CLT alone is NOT enough to archive an app — it must be
   the full Xcode path.

2. Xcode → Settings → Accounts → add the Apple ID that owns the
   developer account.
   **Check:** the team is listed under the account.

## 1. Homebrew and the toolchain

```
brew --version || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22 cocoapods
brew link --overwrite node@22
node -v && pod --version && git --version
```

**Check:** `node -v` prints **v22.x** — the repo's `.nvmrc` and the
Pages config both say 22, and a stray v20 from an old install is the
kind of thing that works until it doesn't. `pod --version` prints a
number; Capacitor 8 still scaffolds the iOS project with CocoaPods.

## 2. Clone and install

```
git clone https://github.com/jjwesterlaken/UniPlanner.git && cd UniPlanner
git log --oneline -1
npm install
cd mobile && npm install && cd ..
```

**Check:** the clone's HEAD is the commit you expect to ship — read
the line, don't assume; a wrong branch here is four rebuilds later
(that exact failure is in the ledger). Both installs end without
`ERR!`.

## 3. Build the web bundle — the leak gate is INSIDE this step

```
npm run build
```

**Check:** it ends `web build OK -> dist-web/ ...` and then completes
`prepare:native` without throwing. **The classification gate is
unconditional and in the build itself**: `scripts/prepare-native.mjs`
throws, naming the file, if `dist-web` contains any entry not declared
shipped or excluded — so the marketing-page leak that reached build
3494152 cannot recur by forgetting a manual check. If you want the
confirmation anyway:

```
ls mobile/www
```

**Check:** no `site`, no `measure-audio.html`, no `sw.js`, no
`_headers`.

## 4. Run the suite once

```
npm test
```

**Check:** every suite ends `0 failed`. Chromium-dependent suites
print `skip — no Chromium` locally; that is expected here (CI forces
them). Anything else red: stop, this machine's build is not the build
you verified.

## 5. Generate the iOS project

```
cd mobile
npm run add:ios
```

(`add:ios` runs `cap add ios` and then `npm run settings`, which
applies the four plist declarations, writes the privacy manifest,
stamps versions, the 15.0 deployment target and iPhone-only.)

**Check the output, line by line:**

- `ios: microphone, camera, photo-library and encryption declarations added in ios/App/App/Info.plist`
- `stamped  iOS version, build and deployment target and device family`
- `stamped  iOS privacy manifest (created — ADD IT TO THE TARGET IN XCODE)`
- a `WARNING:` about `PrivacyInfo.xcprivacy` not being referenced by
  the Xcode project — **expected at this point**; step 7 clears it.

Then:

```
npx cap sync ios
```

**Check:** ends `Sync finished`, and the pod install inside it
succeeded (no red `[error]`). If pods fail on an Apple Silicon
first-run, `cd ios/App && pod install --repo-update` and re-run.

## 6. Open the workspace

```
npm run open:ios
```

**Check:** Xcode opens `App.xcworkspace` — the WORKSPACE, white icon,
not the blue `.xcodeproj`. Building the project file directly skips
the pods and fails with missing-module errors that look like our code.

## 7. The two human steps — once per `cap add ios`

1. **Signing.** Project navigator → App target → Signing &
   Capabilities → tick "Automatically manage signing", pick the team.
   **Check:** "Provisioning profile: Xcode Managed Profile" with no
   yellow warnings.
2. **The privacy manifest.** Drag
   `mobile/ios/App/App/PrivacyInfo.xcprivacy` from Finder into the
   **App** group in Xcode's navigator; in the dialog, tick the **App**
   target. Then, back in the terminal:

   ```
   npm run stamp
   ```

   **Check: the WARNING is gone.** That silence is the check — the
   stamp reads the pbxproj and warns while the manifest is not in the
   target, which is the half-done state that otherwise surfaces as an
   App Store Connect email after the upload.

## 8. Smoke on the phone before archiving

Plug the phone in, select it as the run destination, ⌘R.

**Check, in this order** (it is the order in which failures are
expensive): the app opens dark/light matching the phone; **sign in
works** (the one failure that breaks everything else — a
custom-scheme origin talking to Supabase); the planner loads; the AI
tab shows the allowance badge with a number. Thirty seconds of
overscroll and safe-area eyeballing while you are there.

## 9. Archive and upload

Xcode: set the destination to **Any iOS Device (arm64)** — Archive is
greyed out while a simulator is selected. Then Product → **Archive**.

**Check:** the Organizer opens with the new archive, version 1.0.0,
build = a fresh minutes-since-2020 number (it is derived, so it is
strictly greater than 3494152 by construction — no number to
remember).

Organizer → **Distribute App** → App Store Connect → Upload → accept
the managed-signing defaults.

**Check:** upload completes with **no export-compliance question** —
`ITSAppUsesNonExemptEncryption` answers it in the plist. Then App
Store Connect → TestFlight: the build appears within ~15 minutes, and
its status moves past "Processing" **without a Missing Compliance or
privacy-manifest email**. That silence is the last check: it is the
channel Apple uses when the manifest did not make it into the bundle.

---

## If something fails

| Symptom | It is | Fix |
|---|---|---|
| `cap add ios` fails on pods | CocoaPods first-run | `cd ios/App && pod install --repo-update` |
| Missing-module errors building | opened the project, not the workspace | step 6 |
| Archive greyed out | simulator selected | Any iOS Device (arm64) |
| Upload asks the encryption question | plist keys didn't land — `npm run settings` was skipped after `cap add` | re-run it, rebuild |
| Post-upload privacy-manifest email | the drag (step 7.2) was missed or the project was regenerated after it | drag again, `npm run stamp` silent, re-archive |
| Sign-in fails on the phone | nothing to do with this machine — check Supabase status and the phone's network before touching the build | |
