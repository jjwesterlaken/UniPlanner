# University Planner

A study planner: courses, calendar, weekly reading planner, assignments,
to-do list, notes with folders, flashcard study game, colour themes, and
per-semester separation.

Runs as a website, an installable phone app, and a desktop program for
Mac, Windows and Linux — all from this one codebase.

## Getting started

**Just want the apps built?** Read `SETUP-GITHUB.md`. It needs no commands
at all — GitHub builds everything for you.

## Layout

| Folder | What's in it |
|---|---|
| `src/` | The app itself (`PlannerApp.jsx`) and the sync engine (`sync.js`) |
| `public/` | HTML shell, icons, manifest, service worker |
| `scripts/` | Build scripts (cross-platform Node) |
| `desktop/` | Electron shell — builds Mac, Windows and Linux programs |
| `mobile/` | Capacitor shell — builds iPhone and Android apps |
| `.github/workflows/` | The automatic build |

## Building by hand (optional)

```bash
npm install
npm run build          # builds the web app, then copies it into the shells
cd desktop && npm install && npx electron-builder --mac   # or --win / --linux
```

## Accounts and sync

Sign-in, syncing and conflict-merging are built. They currently run against
a simulated backend so the flow works with no server. See
`4-BACKEND-GUIDE.md` for exactly what to build server-side and the one line
to change when it's ready.

⚠️ The simulated backend is **not secure** and must not ship to paying
customers.
