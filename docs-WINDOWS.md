# Building the Windows program (.exe)

This turns the planner into a normal Windows program — its own icon, its own
window, launched from the Start Menu or desktop like anything else.

**Do this on a Windows PC.** (See the note at the bottom about why building it
from a Mac isn't worth the trouble.)

**You need:** Node.js installed — free, from <https://nodejs.org>. Download the
**LTS** version, run the installer, click Next through it, then restart your PC.

---

## Step 1 — Open a terminal in the desktop folder

1. Open **File Explorer** and go to the `desktop` folder from this kit.
2. Click the address bar at the top (where the folder path is shown).
3. Type `powershell` over it and press **Enter**.

A blue PowerShell window opens, already pointed at the right folder.

## Step 2 — Install the build tools (one time, ~2 minutes)

```powershell
npm install
```

This downloads Electron. It's a few hundred MB and only happens once.

## Step 3 — Try it before building

```powershell
npm start
```

The planner should open in its own window. Click around and check it works,
then close the window.

## Step 4 — Build it

```powershell
npm run build:win
```

Give it a few minutes. When it finishes, open the new `dist` folder and you'll
find **two** files:

| File | What it is |
|---|---|
| `University Planner Setup 1.0.0.exe` | **Installer.** Double-click, choose where to install, and it adds desktop and Start Menu shortcuts. |
| `University Planner Portable 1.0.0.exe` | **Portable.** No installing at all — double-click and the app just opens. Good for a USB stick. |

Use whichever suits you. The installer is the more "normal program" experience;
the portable one is handy if you don't want to install anything.

---

## The warning you'll see (this is expected)

The first time you run it, Windows shows a blue box:

> **Windows protected your PC**

This appears because the app isn't signed with a paid certificate — **not**
because anything is wrong with it. To continue:

1. Click **More info**
2. Click **Run anyway**

You only do this once per file. Getting rid of the warning permanently requires
a Windows code-signing certificate, which typically runs a few hundred dollars
a year — not worth it for personal use.

---

## Can I build the Windows version on my Mac?

Technically yes, but I'd advise against it. It needs a compatibility layer
called Wine, and the final installer step depends on 32-bit Wine support that's
awkward to set up and frequently breaks. I tried exactly this while preparing
your kit: the app itself built fine, then the installer step failed on that
32-bit requirement.

Building on an actual Windows PC takes about five minutes and just works. If
you don't have one, the **portable** build is the easier target to aim for, or
your partner could run the steps on their PC.

---

## When the app gets updated

Replace the `www` folder inside `desktop` with the new one, then run
`npm run build:win` again.
