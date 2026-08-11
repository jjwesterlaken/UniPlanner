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

**There are exactly two semesters, and adding a third is not free.**
`SEMESTER_NAMES` is `["Semester 1", "Semester 2"]`, and `normalizeData`
rebuilds `data.semesters` by iterating *that list only* — any other key
is dropped on load. But `mergeData` merges over the **union** of semester
keys in local and remote. So a blob containing "Semester 3" merges
cleanly, syncs, and then silently vanishes the next time it is loaded.
Nothing produces one today. It matters because "just allow more
semesters" looks like a one-line change to `SEMESTER_NAMES` and isn't:
the two functions disagree about what a semester is, and only one of them
is on the path that loses data.

The corollary is that the planner has **no semester lifecycle at all** —
nothing archives, prunes or clears. A student in second year is reusing
"Semester 1" with first year's content still in it, so the blob grows
without bound inside two fixed buckets rather than by accumulating new
ones. See the budget section below.

## What the blob costs, and the ceiling that actually binds

Everything syncs as one JSON document, so size is a correctness concern,
not a performance nicety. Measured rather than estimated:

- A realistic populated two-semester account is **583 KB**. Study cards
  (131 KB) and notebook pages (117 KB) per semester are 85% of it, and
  both are uncapped.
- **The binding ceiling is localStorage (~5 MB per origin), not Postgres
  (256 MB for `jsonb`) or anything on the Supabase side.** In demo mode
  it is really ~2.5 MB, because signing into a demo account writes the
  blob twice — `uni-planner-v1` and `uni-planner-demo-cloud`.
- `JSON.stringify` runs on every debounced save. 1 MB is imperceptible;
  2 MB is ~45–75 ms per save on a mid-range phone.

**The working budget is 1 MB**, with a user-visible warning above 1.5 MB.
Any feature that stores user-typed text should have caps whose *sum*
still fits inside that, and the arithmetic belongs in a test so raising a
cap can't quietly skip it.

`store.set` used to swallow every `localStorage` failure, which made the
quota ceiling invisible: saving simply stopped. It now returns a result,
every write goes through one `persist()` helper, and a failure raises a
banner (`src/storageHealth.js`). Signed-in and signed-out get different
wording on purpose — sync rescues the first and nothing rescues the
second. Don't reintroduce a bare `catch {}` on a write path; three tests
in `scripts/test-storage.mjs` exist to stop exactly that.

### Pending decision: AI notes need their own row, before launch

`aiNotesLogic.js` has always said that splitting AI notes out is the
escape hatch "if sync ever gets noticeably slower". Measurement says it
is now due, and this is recorded here so it can't slip past launch.

One AI lecture note cost ~12.9 KB (18.1 KB with a translation) because
the summary was stored **twice** — rendered into `page.body` and
verbatim in `page.aiMeta.translations.en` — and the terms twice as well,
once as `notes` items and once inside `aiMeta`. Both duplicates are now
gone (`summaryForStorage`, and `body: ""` on AI pages), which takes a
realistic note to ~6 KB. Readers fall back to `body` so notes saved
before the change still render.

`MAX_AI_NOTE_BYTES` (20 KB) then bounds one runaway note, since
`SUMMARY_MAX_TOKENS` bounds what the model returns and not what gets
written. **The drop order is not "translation first."** A student who
asked for a translation is reading the translation; the language they
*requested* is kept and the other one goes. Dropping the translation
would only ever hurt the user who most needed it.

None of that makes sixty lectures fit. At ~6 KB a note it is still
~360 KB a semester, and the cap is a guard, not a budget. Only moving
this data out of the blob solves it.

**The trigger is the two-hour lecture test.** Every number above is
modelled from a feature that has never successfully transcribed a real
lecture, and rebuilding storage around estimates is how you rebuild it
twice. When that test runs, measure the actual stored size of one real
lecture note and size the work against it. It must happen **before
launch**: the cheapest moment to move this data is while no user has any,
and afterwards it needs a migration for precisely the data that is
hardest to migrate.

### Known gap: there is no way to retry a summary

When summarising fails, transcription has already succeeded and **has
already been billed** — the audio is deleted at step 10, before
summarising is attempted, and step 12 bills the transcription duration
regardless. The user has paid and has no summary.

They cannot retry. `ai-notes` only accepts an audio object path, and the
audio is gone. Nothing dropped by a failure or by the size cap is
**regenerable**, and user-facing copy must not use that word — it is
*recoverable* from `ai_notes_requests` for the retention window, which is
a different and weaker promise. `src/aiNotesCopy.js` holds the wording
and a test greps it for the banned word.

The proper fix is a **text-only re-summarise endpoint**: the transcript
is already stored server-side and scoped to its owner, so a retry needs
no audio, no transcription call and no new minutes. It is deliberately
not built yet — the success path of this feature has never run once, and
building a fix for the failure path of an unproven pipeline is how you
build it twice. Revisit alongside the two-hour lecture test above.

Already done, and independent of that decision: a failed summary no
longer stores the whole transcript (~88 KB for a two-hour lecture) in the
blob — see `TRANSCRIPT_EXCERPT_CHARS`. The Edge Function returns
`transcript` on the success path too, so a test asserts it reaches
neither the page nor the notes items.

## Two notions of "week", deliberately not reconciled

The app has two independent ideas of what week something is in, and they
can disagree with nothing to warn you. This is known and intended.

**User-typed labels.** Weekly readings (`textbook`) and study cards
(`notes`) each carry a `week` field the user types in — a plain number
with no date attached. Nothing anchors them to the calendar, so a reading
filed under week 3 and a card under week 4 can describe the same lecture,
and the app has never noticed.

**Calendar-derived numbers.** The workload forecast labels deadlines by
teaching week, computed from `settings.start` and any break ranges
(`teachingWeek` in `workload.js`).

They are not connected, and **the calendar must not be used to correct
the typed ones.** Those numbers are the user's own record of how their
unit is organised; a semester start date entered later — or entered
wrongly — would silently rewrite them. Deriving a label for a date the
app already knows is safe. Overwriting data someone typed is not.

If the two ever need to agree, the honest fix is showing both and letting
the user resolve it, not picking a winner.

The same reasoning is why the calendar is optional: with no start date,
labels fall back to dates rather than a guessed number, and a break range
is subtracted rather than counted through, because "Week 10" that is
really week 9 is worse than a plain date — it looks authoritative.

## The service-role client bypasses RLS — you are the ownership check

**Any query made with the service-role client must explicitly scope to the
requesting user's id. The database policy will not save you.** That client
exists precisely to bypass Row Level Security, so every `.eq("user_id",
userId)` that RLS would have applied has to be written by hand, on every
query, including the ones that look like internal bookkeeping.

The concrete failure: `ai-notes` looked up an in-flight request by its
idempotency key alone.

```js
.from("ai_notes_requests").select("*").eq("idempotency_key", key)  // no user_id
if (existing?.status === "done") return { result: existing.result }
```

`result` holds the full transcript and summary, so anyone presenting a key
that already had a completed row received another user's lecture. The
policy `ai_notes_requests_select_own` was correct the whole time and never
ran. The key was being treated as an internal coordination token, and it
is really a shared identifier — it's also the audio's filename.

Three things follow:

- **Scope every service-role query**, not just the obvious reads. The
  writes matter too: a mis-scoped update is a takeover rather than a
  disclosure, and it is harder to notice because nothing is returned.
- **Reject "exists but isn't yours" identically to "malformed."** Same
  status, same code, same body. If the two differ, the endpoint answers
  "does this key exist?" for any key someone cares to try. Tell them apart
  in the logs, never in the response.
- **Test it at the function level.** `scripts/test-ai-notes-function.mjs`
  runs the real handler against a fake database that models ownership.
  Note that once the first lookup is scoped, a non-owner never reaches the
  later queries, so those scopes can't be caught by behaviour alone —
  hence the source-level invariant in that file asserting no query filters
  on `idempotency_key` without `user_id`.

This applies to anything server-side that comes later. The Stripe webhook
will run service-role against `profiles`; the same mistake there flips the
wrong user's tier.

## Demo mode is a real mode

With no Supabase key in `src/config.js`, `backend` falls through to
`demoBackend` and everything works locally. A brand-new user is in this
mode. A null-dereference has shipped in it before, precisely because it's
the path nobody runs while developing. `scripts/test-app-smoke.mjs` mounts
the real app with `isConfigured === false` and fails on any
`console.error`; keep it passing.

**It exists because unit tests and a green build can both miss a crash
that makes every render throw.** It has now caught two the rest of the
suite could not:

- a null-dereference in the stats panel reading an empty semester
- a temporal dead zone — a `useMemo` placed above the `const` it read,
  so the app threw on every render while the pure functions it called
  were all perfectly fine, and `npm run build:web` was perfectly happy

Both are the same shape: correct logic, wrong wiring. Nothing that tests
functions in isolation can see it, because the fault is in how the
component is assembled. If you add a screen, add it to the smoke test's
tab walk — the whole value is that it renders the real thing from an
empty semester.

## How users actually receive an update

**The service worker's cache name is generated from the built bytes.
Any change to caching or asset naming must keep that derivation
intact.** `scripts/build-web.mjs` hashes `app.js` + `app.css` and
substitutes `__BUILD_ID__` in both `public/sw.js` and
`public/index.html`; the build fails if either placeholder is missing
from the line that needs it.

What it cost to find: the cache name used to be a hand-edited constant
(`"uni-planner-v6"`) with **one commit in the entire repository history**
and no cache-busting on `app.js` or `app.css`. The fetch handler was
cache-first for everything, so a browser that had opened the app once
served that build forever — the worker never changed, so no new worker
installed, so `install` never re-ran, so nothing was re-fetched. Weeks of
deploys reached nobody who already had the app cached, and a security fix
would have reached them just as little. Nothing errored; deploys simply
didn't arrive.

Two independent mechanisms now stop that, on purpose:

1. the cache name changes whenever the build changes, and
2. the app shell is network-first regardless, so even a broken (1) still
   serves the current build to anyone online.

`scripts/test-service-worker.mjs` asserts both, plus that the build
refuses a hardcoded name. Don't "simplify" either one into the other.

**Only the hosted web build registers a worker.** Electron loads over
`file://` (workers aren't allowed there at all), but Capacitor serves
Android from `http://localhost`, which *is* a secure context — so a
worker registers and caches the bundled assets, and an app-store update
that replaced those files on disk would still be shadowed by the cache.
`index.html` registers only on `https:` and a non-localhost host, and
unregisters anything it finds otherwise.

The build id is shown in the app (Account tab). It is the only way to
answer "which build is this user on", which is the first question after
any caching bug.

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

**A failed Netlify deploy is not always your diff.** Netlify can fail at
the *configuration* stage, before the build script runs at all, with its
own extensions API returning a 502:

```
Configuration error
Failed retrieving extensions for site f95d2107-…: Unexpected status code
502 from fetching extensions.
Build failed due to a user error: Build script returned non-zero exit code: 2
```

"User error" is Netlify misclassifying its own outage. The tells are a
deploy that fails in **under ten seconds** and a log that never reaches
the build script — no `npm install`, no build output. It is transient and
unrelated to the code. Retry it, or ignore it on a preview; a failed
preview affects nothing, and a failed production deploy leaves the last
successful build serving rather than breaking the live site. **Don't go
hunting for a break in the code.** The check that actually gates a merge
is `npm test`; the three `… - uniplannergdog` checks are Netlify's own
and read `neutral` when a deploy is fine, not `success`.

## Testing

`npm test` builds the web bundle, then runs the app tests, the demo-mode
smoke test, and the migration tests. All of it is plain Node and `assert`,
no framework, matching the style of the build scripts.

- `scripts/test-ai-notes.mjs` — AI notes, the scheduler, stats, merge behaviour
- `scripts/test-storage.mjs` — save failures are reported, transcripts
  aren't stored whole; both cover things that used to fail invisibly
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
