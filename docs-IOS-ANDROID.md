# Building the iPhone and Android apps

This turns the planner into real phone apps using **Capacitor**, which wraps
the app in a native shell.

Good news: a Mac can build **both** iPhone and Android. (A Windows PC can only
do Android — Apple requires a Mac for iPhone builds.)

---

## First: set-up common to both (do this once)

**You need:** Node.js installed (free, from <https://nodejs.org> — get "LTS").

In Terminal, type `cd ` then drag the `mobile` folder in, and press Enter:

```bash
cd /path/to/mobile
npm install
```

---

# Part A — Android

**You also need:** Android Studio (free) from
<https://developer.android.com/studio>. Install it and open it once so it can
download the Android SDK it needs.

### 1. Create the Android project

```bash
npm run add:android
```

(Use the `npm run` commands rather than `npx cap ...` directly — they also
add the microphone permission the AI lecture recorder needs. Without it the
mic prompt never appears and recording can't start.)

### 2. Generate all the app icons and splash screens

```bash
npm run assets
```

This takes the images in `assets/` and produces every size Android wants.

### 3. Copy the app in and open it

```bash
npm run sync
npx cap open android
```

Android Studio will open. The first time, it spends a few minutes "syncing" —
let it finish.

### 4. Put it on a phone

- On the phone: enable **Developer options** (Settings → About phone → tap
  "Build number" 7 times), then turn on **USB debugging**.
- Plug the phone into the Mac.
- In Android Studio, pick your phone from the device dropdown at the top and
  press the green **Run ▶** button.

The app installs and launches on the phone, with its own icon. That's it —
no Play Store, no fees.

### 5. (Optional) Make a shareable APK file

In Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

You'll get an `.apk` file you can send to your partner. They'll need to allow
"install from unknown sources" when opening it.

> **Play Store note:** publishing publicly needs a developer account (25 USD
> one-off) *and* a closed test with 12 testers for 14 straight days. For a
> two-person app, the free **Limited Distribution** account (up to 20 devices,
> no fee, no ID) is the far better fit — check its current status on Google's
> developer site.

---

# Part B — iPhone / iPad

**You also need:** Xcode (free, large — several GB) from the Mac App Store.
Open it once and accept the licence agreement.

### 1. Create the iOS project

```bash
npm run add:ios
```

### 2. Generate icons and splash screens

```bash
npm run assets
```

(Skip if you already ran it for Android — it does both at once.)

### 3. Copy the app in and open it

```bash
npm run sync
npx cap open ios
```

Xcode opens the project.

### 4. Set up signing

1. In the left sidebar, click the blue **App** project at the top.
2. Choose the **Signing & Capabilities** tab.
3. Tick **Automatically manage signing**.
4. For **Team**, choose your Apple ID. If none is listed: Xcode menu →
   **Settings → Accounts → +** → sign in with your normal Apple ID (free).

If it complains the bundle identifier is taken, change it to something unique
like `com.yourname.uniplanner`.

### 5. Put it on your iPhone

- Plug the iPhone into the Mac, unlock it, and tap **Trust** if asked.
- At the top of Xcode, pick your iPhone from the device dropdown.
- Press the **Run ▶** button.
- On the iPhone the first time: **Settings → General → VPN & Device
  Management** → tap your Apple ID → **Trust**.

The app appears on the home screen with its own icon.

### ⚠️ The important iPhone catch

With a **free** Apple ID, apps you install this way **stop working after 7
days** and must be re-installed from Xcode. That's Apple's rule, not a bug.

To avoid that, you need the **Apple Developer Program (99 USD/year)**, which
gives you:

- apps that last a full year on your devices, and
- **TestFlight**, which lets you send the app to your partner over the
  internet — no cable, no Xcode on their end. This is by far the nicest way
  for two people to share an app.

If you don't want to pay, the **"Add to Home Screen" web version** we already
built has no expiry at all — worth considering for iPhone.

---

## When the app gets updated

When I send you a new version, replace the `www` folder inside `mobile`, then:

```bash
npm run sync
```

Then press Run again in Xcode / Android Studio.
