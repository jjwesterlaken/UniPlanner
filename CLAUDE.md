# Working on University Planner

Notes for anyone — human or AI — picking this codebase up. These are the
things that have actually bitten, not general advice.

## Shape of the thing

A React app with no framework and no bundler config beyond a ~60-line
esbuild script. One big component file, a few pure modules beside it, and
three shells (web, desktop/Electron, mobile/Capacitor) that all serve the
same built `dist-web/`.

| | |
|---|---|
| `src/PlannerApp.jsx` | the entire UI, ~3000 lines, deliberately one file |
| `src/sync.js` | merge rules, tombstones, the backend interface |
| `src/srs.js` | spaced repetition + study stats, pure functions |
| `src/aiNotesLogic.js` | AI lecture notes logic, pure functions |
| `supabase/functions/ai-notes/` | the only server-side code |
| `scripts/` | build and tests, plain Node, no framework |

New code goes in `PlannerApp.jsx` unless it's genuinely pure logic, in
which case it goes in its own module *with tests*. That split is what
makes any of this testable from Node: `srs.js` and `aiNotesLogic.js` have
no React and no browser globals, so the awkward cases can be exercised
directly.

## The data model, and the trap in it

Everything a user owns is one JSON blob in `planner_data`, synced whole.
Two consequences that decide most design questions:

**Anything that grows without a ceiling eventually breaks sync.** Store
state, not history. `srs` on a card is one ~51-byte object, never a list
of past reviews; the daily study log is a rolling 42-day window, not a
journal. Before adding a field, work out its size after two years of use.

**A semester is exactly the collections listed in `COLLECTIONS`.** This is
the trap. `mergeSemester` in `sync.js` rebuilds each semester from that
whitelist:

```js
function mergeSemester(a = {}, b = {}) {
  const out = {};
  for (const key of COLLECTIONS) out[key] = mergeList(a[key], b[key]);
  return out;                    // anything not in COLLECTIONS is GONE
}
```

A new key on a semester that isn't in `COLLECTIONS` is **silently dropped
on every sync** — and only on sync. `normalizeData` spreads unknown keys
so it persists locally, and demo mode never merges at all, so it works
perfectly in testing and loses data only for signed-in users on a second
device. Adding to `COLLECTIONS` is the fix, but check what else iterates
it (`grep -n COLLECTIONS src/`) — the backup panel's item count and the
restore confirmation both do, and bookkeeping collections shouldn't be
counted there as if they were the user's notes.

**Merging is per item, last write wins, by `updatedAt`.** New fields ride
along on existing items for free — a card gaining `srs` needs no merge
change at all. Bump `updatedAt` whenever you change an item or the edit
won't propagate.

**Deletes are tombstones, not removals** (`deletedAt` set, item kept).
A hard delete gets re-added by the next sync, because merging is a union
by id. `purgeOldTombstones` clears them after 60 days — but note it only
runs on sync and restore, so anything that prunes on a schedule of its own
has to clean up after itself or it will grow forever in demo mode.

That 60 days is an assumption every collection makes, and restoring a
backup older than it brings back rows whose tombstones are long gone.
For `studyStats` this leaves ~5KB of stale day rows that are invisible
(readers filter to the 42-day window regardless) and are reclaimed by the
next two study writes — the first tombstones them, the second drops the
tombstones. Nothing to fix; worth knowing before someone re-measures the
blob after a restore and thinks the 9.8KB ceiling has been breached.

Treat `mergeData` as fragile. It is the most-tested function here and the
one most able to lose a user's data silently.

## Demo mode is a real mode

With no Supabase key in `src/config.js`, `backend` falls through to
`demoBackend` and everything works locally. A brand-new user is in this
mode. A null-dereference has shipped in it before, precisely because it's
the path nobody runs while developing. `scripts/test-app-smoke.mjs` mounts
the real app with `isConfigured === false` and fails on any
`console.error`; keep it passing.

## Build scripts

`scripts/build-web.mjs` and `prepare-native.mjs` run on Windows, macOS and
CI, which rules out things that look fine locally:

- **Spawn `process.execPath`, never `npx`, never `node_modules/.bin/*`.**
  On Windows the `.bin` shim is a `.cmd` and modern Node refuses to
  execute it (`EINVAL`); `npx` is unreliable on build servers.
- Don't "tidy" the deprecation warnings these scripts emit. That has
  broken the build twice.

## CI and packaging

- `.github/workflows/test.yml` runs `npm test` on every push with a
  postgres service container and `REQUIRE_POSTGRES=1`, so the migration
  tests can't silently skip.
- **Do not set `GITHUB_TOKEN` on the electron-builder step.** Its presence
  makes electron-builder try to publish and generate auto-update metadata,
  which fails the build. Artifacts are collected by a later upload step.
- electron-builder validates config for **all** platforms even when
  building one, so a broken mac block fails the Windows build.
- `desktop/package.json` must keep its `repository` field — electron-builder
  requires it.

## Testing

`npm test` builds the web bundle, then runs the app tests, the demo-mode
smoke test, and the migration tests. All of it is plain Node and `assert`,
no framework, matching the style of the build scripts.

- `scripts/test-ai-notes.mjs` — AI notes, the scheduler, stats, merge behaviour
- `scripts/test-app-smoke.mjs` — the app mounts and renders in demo mode
- `scripts/test-migrations.mjs` — SQL against a real postgres; **skips**
  without one locally, which is why CI forces it

Two tests assert the wiring itself (that `npm test` still runs the
migration tests, and that CI still forces them). They live in
`test-ai-notes.mjs` rather than beside what they protect, because a guard
inside a file that skips itself would skip in exactly the situation it
exists to catch.

One test greps the built bundle for leaked provider keys. Keep it passing;
it is the only thing standing between a refactor and a published API key.

When adding a test, write the name as the claim being made
("a streak that has lapsed reads as 0"), not the function being called.
And check a new test can actually fail — breaking the code on purpose and
watching it go red takes a minute and catches tests that assert nothing.

## Working style

**Plan before code for anything non-trivial.** Data shapes with real byte
counts, where it lives in the UI, what happens to existing users' data,
the edge cases, and the test list — agreed before implementation starts.
Several of the constraints above were only found because a plan forced the
question early.

**Grace drives UI and UX.** Flag anything that changes an existing screen
and expect a round of wording and layout notes; keep user-facing copy easy
to change.

**Say when something can't be done as asked.** The `studyStats` collection
exists because the original instruction ("a semester gets a stats object,
don't touch the merge logic") was not possible as written. Finding that
and saying so was worth more than a working-looking implementation that
lost data on the second device.
