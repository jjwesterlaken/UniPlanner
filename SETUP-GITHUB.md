# Setting up automatic builds (no commands, ever)

Once this is done, making a new version of the app for **Mac, Windows and
Linux** is: upload the changed files, click one button, wait ten minutes,
download the results. No terminal, no Node.js, no Xcode.

You only do this setup once. It's free.

---

## Step 1 — Make a GitHub account

Go to <https://github.com> and sign up. Free is fine.

## Step 2 — Make a repository

1. Click the **+** in the top-right → **New repository**.
2. **Repository name:** `university-planner`
3. Choose **Private** (nobody can see your code).
4. Leave everything else alone and click **Create repository**.

## Step 3 — Upload the files

On the empty repository page, click **uploading an existing file**.

Drag in **everything from this folder**. Then scroll down and click
**Commit changes**.

> ⚠️ **Check one thing.** GitHub's uploader sometimes skips the `.github`
> folder because its name starts with a dot. After uploading, look at your
> file list — if you don't see `.github`, do Step 3b.

### Step 3b — only if `.github` is missing

1. Click **Add file** → **Create new file**.
2. In the filename box, type exactly:
   `.github/workflows/build-apps.yml`
   (typing the slashes creates the folders automatically)
3. Open `WORKFLOW-FILE.txt` from this kit, copy everything in it, and paste
   it into the big box.
4. Click **Commit changes**.

## Step 4 — Build the apps

1. Click the **Actions** tab at the top of your repository.
2. If it asks, click the green **I understand my workflows, go ahead and
   enable them**.
3. On the left, click **Build apps**.
4. On the right, click **Run workflow** → then the green **Run workflow**
   button.

It now builds on a real Mac, a real Windows PC and a real Linux machine —
all rented free from GitHub. Takes about 10 minutes.

## Step 5 — Download the finished apps

Click into the run (it'll have a green tick when done) and scroll to the
bottom, to **Artifacts**:

| Artifact | Contains |
|---|---|
| `University-Planner-Mac` | `.dmg` — works on all Macs |
| `University-Planner-Windows` | `Setup .exe` (installer) and `Portable .exe` |
| `University-Planner-Linux` | `.AppImage` |

Download whichever you need.

---

## Making it a proper download page (recommended)

Artifacts arrive inside a zip, which is a bit clunky to hand to someone.
**Releases** give clean, direct download links instead — much nicer if you
ever sell this or share it.

1. On your repository's main page, click **Releases** (right-hand side) →
   **Create a new release**.
2. Click **Choose a tag**, type `v1.0.0`, and click **Create new tag**.
3. Give it a title and click **Publish release**.

The build starts automatically, and when it's done the installers are
attached to that release as direct downloads. Next version: repeat with
`v1.0.1`, and so on.

---

## Updating the app later

When I send you new files:

1. Go to your repository → open the file that changed (e.g. `src/PlannerApp.jsx`)
2. Click the **pencil** icon → select all → paste the new version →
   **Commit changes**

   *(Or use **Add file → Upload files** and drop the new ones in — it replaces
   matching files.)*
3. Actions tab → **Run workflow** (or publish a new release tag).

That's the whole update loop.

---

## About that security warning

This setup gets the app built without you touching a command line — but it
does **not** remove the warning users see on first open
(*"unidentified developer"* on Mac, *"Windows protected your PC"*).

That warning exists because the app isn't **code signed**, and signing costs
money:

| | Cost | What it fixes |
|---|---|---|
| Apple Developer Program | 99 USD/year | Removes the Mac warning entirely |
| Windows code signing certificate | ~200–500 USD/year | Removes the Windows warning |

The workflow is already set up for this. When you're ready, you add the
certificates as GitHub **Secrets** and uncomment the signing block in
`.github/workflows/build-apps.yml` — the commented lines show exactly which
secrets to create. Nothing else changes.

Until then, opening the app takes one extra click the very first time:

- **Mac:** right-click the app → **Open** → **Open**
- **Windows:** click **More info** → **Run anyway**
