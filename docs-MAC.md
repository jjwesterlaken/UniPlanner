# Building the Mac desktop app

This turns the planner into a real Mac program: its own icon in Applications,
opens in its own window, no browser involved.

**You need:** a Mac, and Node.js installed (free — get the "LTS" version from
<https://nodejs.org>, run the installer, then restart Terminal).

Everything below happens in the **Terminal** app (find it with Spotlight:
press `Cmd + Space`, type "Terminal").

---

## Step 1 — Go to the desktop folder

Type `cd ` (with a space), then **drag the `desktop` folder into the Terminal
window** — it fills in the path for you. Press Enter.

```bash
cd /path/to/desktop
```

## Step 2 — Install the build tools (one time, ~2 minutes)

```bash
npm install
```

This downloads Electron. It's a few hundred MB and only happens once.

## Step 3 — Try it before building

```bash
npm start
```

The planner should open in its own window. Have a click around. Close the
window when you're happy. If something looks wrong, stop here and tell me.

## Step 4 — Build the installer

```bash
npm run build
```

After a few minutes you'll find your installer here:

```
desktop/dist/University Planner-1.0.0-arm64.dmg
```

(`arm64` for Apple Silicon Macs — M1/M2/M3/M4. Older Intel Macs produce
`x64` instead.)

## Step 5 — Install it

Double-click the `.dmg`, then drag **University Planner** into Applications.
Done — it's now a normal Mac app you can launch from Launchpad or Spotlight.

---

## The one warning you'll hit

The first time you open it, macOS will say the app "cannot be opened because
it is from an unidentified developer". This is expected — it means the app
isn't signed with a paid Apple certificate, **not** that anything is wrong.

To open it anyway:

- **Right-click** (or Ctrl-click) the app icon → choose **Open** → click **Open**
  in the dialog.

You only do this once. After that it opens normally forever.

If you ever want to get rid of that warning entirely (e.g. to give the app to
other people), you'd need the Apple Developer Program at 99 USD/year, which
lets the app be signed and notarised.

---

## Want a Windows version too?

This same folder builds it — see **3-WINDOWS-GUIDE.md**. You run the steps on
a Windows PC and get both an installer and a portable `.exe`.

Building the Windows version *from* a Mac isn't recommended: it needs a
compatibility layer called Wine, and the installer step depends on 32-bit Wine
support that's fiddly and breaks easily.

---

## When the app gets updated

When I send you a new version, just replace the `www` folder inside `desktop`
with the new one, then run `npm run build` again.
