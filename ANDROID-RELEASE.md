# The Android release: what the build needs, and what the forms want

Written when iOS 1.0.0 (3494152) was already on TestFlight. The
fourteen-day closed-test clock starts when the release goes live and
cannot be compressed, so everything here is ordered by what blocks that
date.

---

## 1. What `npx cap add android` picks up, and what it does not

`mobile/android/` is generated and gitignored, so every setting that
lives inside it is re-applied by a script. Run `npm run settings` from
`mobile/` immediately after `cap add android` — it is
`permissions && signing && stamp`, all three idempotent, and all three
have been skipping their Android half all week because the folder did
not exist.

**Applied for you, no action needed:**

| What | By | Why it cannot just be committed |
|---|---|---|
| `RECORD_AUDIO` **and** `MODIFY_AUDIO_SETTINGS` | `mobile/scripts/native-permissions.mjs` | the manifest is regenerated; and the second permission is the one that cost a hardware round — without it the WebView exposes no audio device however many times the student taps Allow |
| release signing block in `app/build.gradle` | `mobile/scripts/native-signing.mjs` | reads `mobile/key.properties`; inert when that file is absent, so a debug build still works on a machine that has no keystore |
| `versionName`, `versionCode` | `scripts/stamp-native.mjs` | `versionCode` is minutes since 2020-01-01 UTC — monotonic with no stored state, so a rejected build can be re-uploaded without inventing a number |
| `minSdkVersion` 26 | `scripts/stamp-native.mjs` | Capacitor defaults to 24 |
| display name in `strings.xml` | `scripts/stamp-native.mjs` | |

**Checked but NOT set — read the warning:** `targetSdkVersion` comes
from Capacitor's template and Play requires **36** for new apps. The
stamp script reads the *generated* `variables.gradle` and prints a
warning if it is lower. It passed on the 16 August build; check the
output rather than assuming, because that is the number that blocks
submission outright.

**Your keystore, and the doc that disagreed with it.** The alias is
whatever `mobile/key.properties` says — `native-signing.mjs` reads
`keyAlias` from that file and hardcodes nothing, so `uniplanner` works
exactly as well as `upload`. `MOBILE-BUILD.md`'s `-alias upload` is an
example keytool line, not a requirement; it has been corrected to say
so. `storeFile` should be the absolute path
(`C:/Users/jjwes/uniplanner-upload.jks` — forward slashes are fine in a
properties file on Windows).

### What `npm run settings` prints, so you can tell noise from a problem

Three scripts run in sequence. On a tree where **only** Android has
been added, every iOS line saying "skipped" is correct and expected —
that is the noise.

```
ios: skipped (no ios/App/App/Info.plist — run "npx cap add ios" first)
android: audio permissions added 2 in android/app/src/main/AndroidManifest.xml
native-signing: release signing config added in app/build.gradle
native-signing: key.properties found — release builds will be SIGNED
version 1.0.0, build 3494152
  skipped  iOS version, build, deployment target and device family (platform not added yet)
  skipped  iOS privacy manifest (platform not added yet)
  skipped  iOS display name (platform not added yet)
  stamped  Android versionName and versionCode
  stamped  Android minSdkVersion
  stamped  Android display name
  target SDK 36 meets the Play requirement (36)
```

**The four lines that must be there, and what it means if they are
not:**

| Line | If missing or different |
|---|---|
| `android: audio permissions added 2` | **2 is the number.** "added 1" means only one of `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` landed, and without the second the WebView exposes no audio device however many times a student taps Allow. "already present" on a re-run is correct |
| `native-signing: key.properties found — release builds will be SIGNED` | the other branch is `no key.properties — debug builds unaffected, release would be unsigned`. A release AAB built in that state uploads and is rejected by Play, after the upload |
| `stamped Android versionName and versionCode` | a `skipped` here means the Android project was not found — `cap add android` did not complete |
| `target SDK 36 meets the Play requirement (36)` | see below. **This is the most time-critical line in the run** |

On Windows: run these from a shell where `node` is on PATH; the
scripts spawn `process.execPath` rather than `npx` precisely because
the `.bin` shim is a `.cmd` that modern Node refuses to execute. Paths
with forward slashes in `key.properties` are fine.

### The targetSdkVersion warning, verbatim, and what to do

When it fires it is a `console.error`, so it goes to stderr and reads:

```
WARNING: targetSdkVersion is 35. Google Play requires 36 for new apps
from 31 August 2026 — a lower value is rejected at submission.
```

**Play's requirement, confirmed rather than recalled: new apps and
updates must target API 36 from 31 August 2026.** Existing apps must
target 35 to stay available. An extension to 1 November 2026 can be
requested.

**That date is seven days away and the closed test takes fourteen.**
So this is not a "deal with it later" line — a build that targets 35
cannot start the clock.

The good news, checked against the package rather than remembered:
**`@capacitor/android` 8.5.0 defaults `targetSdkVersion` and
`compileSdk` to 36.** The generated `variables.gradle` normally sets
them explicitly to the same, and it passed on the 16 August build.

**If the warning does fire**, it is one line in a generated file:

```
mobile/android/variables.gradle
  targetSdkVersion = 36
  compileSdkVersion = 36
```

Edit both, re-run `npm run settings`, confirm the line flips to
`target SDK 36 meets the Play requirement`. It is not stamped
automatically because the value is Capacitor's to set and silently
overriding a build-system default is how you end up compiling against
something the toolchain on that machine does not have — if 36 is
missing, Android Studio's SDK Manager needs it before the edit will
build.

### What the last fortnight changed that is iOS-only

Most of it was shared. Listed so nothing is looked for twice:

| Change | Android |
|---|---|
| root element background (`html, body`) | **shared** — CSS. This is the fix that matters most cross-platform |
| safe-area top/left/right insets | **shared** — CSS. Android gesture-navigation insets come through the same `env()` variables, so check the header under a punch-hole camera and the nav bar in landscape |
| upload ceiling 86 MB, measured bitrate | **shared** — but the 51 kbps floor is an *iOS* encoder property. Chrome's Opus honours 32 kbps, so Android files stay ~3× smaller and the ceiling is pure headroom there |
| client-side size validation | **shared** |
| extension travels with the mime type | **shared** |
| the WebAudio graph at 16 kHz mono | **shared**, and worth more on Android — it was 6× the samples through a filter on every platform |
| `ITSAppUsesNonExemptEncryption` | iOS-only. **No Android equivalent** — Play asks nothing at build level |
| `PrivacyInfo.xcprivacy` | iOS-only. **The Android equivalent is the Data safety form**, section 3 below |
| `TARGETED_DEVICE_FAMILY = "1"` (iPhone-only) | iOS-only. Play handles form factors in the Console's device catalogue, not in the build — leave all form factors on unless you want to exclude tablets deliberately |
| `capacitor.config.json`: iOS background removed | **Android keeps `android.backgroundColor: "#f5f5f4"`**, and it cannot follow the theme. Android's WebView has no `UIColor.systemBackground` equivalent, and its overscroll is a stretch/glow rather than a rubber band that reveals background — so the iOS symptom does not arise. What remains is a light flash at launch for a dark-mode student. Cosmetic, post-launch |

### The thing that was in the iOS bundle and should not have been

`prepare-native` copied **everything** in `dist-web/` into the shells,
including `site/` — the marketing page, carrying **prices** and
**external GitHub download links** — and `measure-audio.html`, which
asks for the microphone. Nothing in the app can reach either, but both
were inside build 3494152.

Fixed: `NATIVE_EXCLUDED` in `prepare-native.mjs` keeps them out, the
diagnostic is opt-in behind `INCLUDE_TOOLS=1`, and a guard enumerates
`dist-web`'s top level so a new asset fails the build until somebody
classifies it. **Cut the AAB from a tree that has this fix** — verify
with `ls mobile/www` and expect no `site` and no `measure-audio.html`.

Worth telling Apple nothing about: it is not a functional defect and
the next build fixes it. Worth not repeating on Play, where an external
download link in the bundle is a worse look.

---

## 2. Data safety, in the form's own terms

Derived from the code, not from intent. The exposure sweep behind each
answer is named so it can be re-checked.

### The two global answers

- **Does your app collect or share any of the required user data
  types?** — **Yes.**
- **Is all of the user data collected by your app encrypted in
  transit?** — **Yes.** Every request is HTTPS; the app makes no plain
  HTTP call and `scripts/test-local-only.mjs` proves a signed-out
  session makes no outbound call at all.
- **Do you provide a way for users to request that their data be
  deleted?** — **Yes**, in-app (Account → typed confirmation) and via
  `https://www.uniplannerapp.com/delete-account`.

### Is any of it "shared"?

**No — everything is "collected", nothing is "shared".** Google's
definition of sharing excludes transfer to a **service provider
processing on the developer's behalf**, and every third party here is
one: Supabase (hosting and database), Groq (transcription), OpenAI
(summarising), Resend (account email), Cloudflare (static hosting).
None receives data for its own purposes, none is an advertising or
analytics network, and the app contains no third-party SDK at all.

**This is the one judgement call in the form.** It is well-supported —
the app ships zero third-party code, which is asserted by a test — but
the service-provider exception is Google's wording and worth reading
once in the current help text before you submit rather than taking
mine for it.

### The table

| Data type | Collected | Purposes | Linked to identity | Used for tracking | Required / optional | Ephemeral |
|---|---|---|---|---|---|---|
| **Personal info → Email address** | Yes | Account management | **Yes** | No | Optional — the planner works fully signed out | No |
| **Personal info → User IDs** | Yes | Account management, App functionality | **Yes** | No | Optional | No |
| **App activity → Other user-generated content** (courses, assignments, readings, notes, study cards, reference sheets) | Yes | App functionality | **Yes** when signed in | No | Optional — stored only on the device until an account exists | No |
| **Audio → Voice or sound recordings** (lecture recordings) | Yes | App functionality | **Yes** | No | **Optional** — recording is a feature the student chooses | **No** — the file is stored in Supabase Storage and deleted as soon as it is transcribed; the transcript is kept 7 days, or 30 for a failed summary |
| **Photos and videos → Photos** (photographed reading pages) | Yes | App functionality | **Yes** | No | **Optional** | **YES** — `ai-text` has no storage client at all (zero `.storage` references, pinned by a test); photos ride the request body, are relayed to the model, and are never written anywhere |
| **App info and performance → Crash logs** | Yes | App functionality (diagnostics) | **Yes** when signed in, **no** when signed out | No | Optional | No |
| **App info and performance → Diagnostics** | Yes | App functionality | as above | No | Optional | No |

### The `client_errors` detail, since you asked specifically

Six fields, pinned by name in migration 0010: `message`, `stack`,
`build_id`, `url`, `user_agent`, `user_id`. Three things worth knowing
for the form:

- **`url` is the PATH only** — never the query string and never the
  hash, deliberately, because the hash is where password-recovery
  tokens ride.
- **No user content is ever included.** The reporter sends the six
  fields and nothing else.
- **`user_id` is null for a signed-out crash**, forced by the RLS
  policy rather than by the client. So the honest answer to "linked to
  identity" is *yes when signed in* — Play has no partial option, so
  answer **yes**, which is the conservative direction.
- Nobody has `select` on the table. It is write-only by construction;
  Jared reads it from the dashboard.

### What is NOT collected, and can be answered flatly

No location, no financial info, no health data, no contacts, no
calendar (the planner's dates are typed by the student, not read from
the device), no messages, no files or docs, no web-browsing history,
no device or advertising IDs, **no data used for tracking, and no
advertising or marketing purpose anywhere in the app.**

---

## 2b. The rest of the Play Console flow — what the code bears on

You are answering the content rating and target audience from your own
knowledge, which is right. These are the places where something in the
repository either contradicts that or adds a step.

### The one that blocks review and is easy to miss: App access

**Play asks whether any functionality is behind a login, and if so
demands working test credentials.** Ours is: every AI feature is gated
on a real account (`AiNotesPanel` returns "needs a real signed-in
account" without one), and reviewers cannot see any of it otherwise.

Go to **App content → App access → All or some functionality is
restricted**, and supply the e2e test account's email and password —
the one already in the repo secrets as `TEST_ACCOUNT_EMAIL` /
`TEST_ACCOUNT_PASSWORD`. Add a note saying the planner itself works
signed out and the account is only needed for the AI features.

**Use the e2e account rather than a personal one**, and know the
consequence: the e2e suite resets that account's data in `beforeAll`.
A reviewer opening it mid-CI-run sees an empty planner. That is
survivable — it is a planner with nothing in it, not a broken app —
but seed it with a course and an assignment before you submit so it
does not look empty on purpose.

### Content rating (IARC)

Nothing in the code raises the rating. The answers the repository
supports:

- **No violence, sexual content, profanity, gambling, or drug
  references** — none of it is in the app or generatable by it in any
  targeted way.
- **Do users interact or share content with each other? NO.** There is
  no user-to-user anything: no comments, no sharing, no profiles, no
  chat. The blob is one student's and the RLS policies are all
  `auth.uid() = user_id`. This is the answer that keeps the rating
  low, and it is provable.
- **Does the app share the user's location? NO.**
- **Does the app allow purchases? NO** — there is no billing in the
  app at all yet; tiers are flipped by hand in the dashboard.
- **AI-generated content.** The questionnaire has begun asking about
  this and it is the one place to answer carefully rather than
  reflexively: the app **does** display model-generated text (lecture
  summaries, practice questions, reading summaries). It is generated
  from material the student supplied, shown only to them, and never
  shared with another user. Answer honestly that generated content is
  present; it does not raise the rating on its own, and being found to
  have said otherwise would.

### Target audience and content

**Select 18 and over.** The app is for university students, and this
matters more than it looks:

- Any age band that **includes under-13** pulls the app into the
  Families programme, which brings requirements this app does not meet
  and does not want to (and would make the AI features a compliance
  question rather than a product one).
- Selecting **13–17** as well is defensible for sixth-formers, but it
  triggers additional obligations around content and data. Given the
  app collects an email address, records audio and sends supplied text
  to third-party models, the clean answer is 18+.
- **Do not** tick "appeal to children" — a study planner does not, and
  the store listing has no child-directed imagery.

### Ads

**"Does your app contain ads?" — NO.** Provable rather than asserted:
the bundle contains no third-party code at all, and
`scripts/test-local-only.mjs` verifies a signed-out session makes zero
outbound requests through `fetch`, `XMLHttpRequest`, `sendBeacon`,
`WebSocket` or `EventSource`.

### Permissions

`RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` are what we declare, plus
`INTERNET` from Capacitor's template. **None of these is on Play's
sensitive-permissions list** — that list is SMS, Call Log,
`MANAGE_EXTERNAL_STORAGE` and `AccessibilityService` — so **no
permissions declaration form is required**. Check the generated
manifest after `cap add android` rather than trusting this paragraph:

```
findstr uses-permission mobile\android\app\src\main\AndroidManifest.xml
```

Anything beyond those three arrived from a plugin, and we have no
plugins — so it would be worth understanding before it ships.

### Not applicable, so you can answer them flatly

No financial features, no health data, no news, no COVID-19 contact
tracing, no government affiliation, no VPN, no blockchain, no loans.
The **data deletion URL** is
`https://www.uniplannerapp.com/delete-account` and it is already live
and reachable, which Play does check.

## 3. The store listing

Lives in `site/store-listing.js` so the marketing page, the two store
listings and the wording rule cannot drift apart — and so the character
limits are counted by a test rather than by the Play Console refusing
to save a draft you have already typed.

- **Name** — `UniPlanner` (10 / 30), matching the App Store record.
- **Short description** — 76 / 80.
- **Full description** — 1,893 / 4,000, drawn from the marketing page's
  four feature headings in the same order.

**The in-app display name is a separate string and stays "University
Planner" for now.** `DISPLAY_NAME` in `stamp-native.mjs` is already
"UniPlanner" for the home screen, because iOS truncates around twelve
characters. Reconciling the app's own title with the store name is a
real change to a screen and does not belong in front of the first AAB.

`scripts/test-readings.mjs` sweeps the listing with the same
substitution ban as the in-app copy — store copy is the most likely
place to reach for "skip the reading", because that is what sells, and
it is the copy nobody reviews.

---

## 4. The order that protects the clock

1. Merge #55 (see the preconditions in `CLAUDE.md`).
2. `npx cap add android` → `npm run settings` → **read the
   targetSdkVersion warning**.
3. `ls mobile/www` — no `site`, no `measure-audio.html`.
4. Build the AAB, upload, fill Data safety and the listing.
5. **Recruit more than twelve.** The fourteen days are a *streak*: if
   the opted-in count drops below twelve at any point it resets. That
   is the only part of this with no engineering remedy.
