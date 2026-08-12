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

**The working budget is 1 MB**, with a user-visible warning above 1.5 MB
(`SIZE_WARN_BYTES`, shown in the Backup panel). Measured again after
Batch 3 landed: a realistic populated two-semester account is **672 KB**
(66% of budget), and one with every Batch 3 cap filled is **962 KB**
(94%). The caps hold.

What they do not hold is the growth they never covered. Study cards,
notebook pages and AI notes are uncapped, and with no semester lifecycle
a second year lands in the same two buckets: **583 KB × 2 = 1166 KB,
which breaches the budget on its own, before Batch 3 adds anything.**
That is why the Backup panel now shows the size on every visit rather
than only once it is a problem — a student whose planner is growing can
see it coming — and why the real answer is the semester-archive work
rather than another cap.
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

### AI notes live in their own row

`aiNotesLogic.js` always said that splitting AI notes out was the escape
hatch "if sync ever gets noticeably slower". It has been taken. The
history matters because each step removed a different kind of waste and
only the last one actually solved the problem.

One AI lecture note cost ~12.9 KB (18.1 KB with a translation) because
the summary was stored **twice** — rendered into `page.body` and
verbatim in `page.aiMeta.translations.en` — and the terms twice as well,
once as `notes` items and once inside `aiMeta`. Both duplicates are gone
(`summaryForStorage`, and `body: ""` on AI pages), which took a
realistic note to ~6 KB. Readers fall back to `body` so notes saved
before that change still render.

`MAX_AI_NOTE_BYTES` (20 KB) bounds one runaway note, since
`SUMMARY_MAX_TOKENS` bounds what the model returns and not what gets
written. **The drop order is not "translation first."** A student who
asked for a translation is reading the translation; the language they
*requested* is kept and the other one goes. Dropping the translation
would only ever hurt the user who most needed it.

None of that made sixty lectures fit. At ~6 KB a note it was still
~360 KB a semester, and a cap is a guard, not a budget.

**So the content moved.** `ai_notes` (migration 0005) holds it; the blob
keeps a stub — title, course, week, the language being read, and a short
preview *per language* — and `src/aiNotesStore.js` owns both halves.
Study cards stayed in the blob deliberately: `srs` state changes on every
review and reviews must work offline, so moving them would mean a remote
write per review or a second sync problem.

**Two ordering rules that point in opposite directions.** This is the
part to read before changing anything in `aiNotesStore.js`:

| | order | an interruption leaves | which is |
|---|---|---|---|
| migrating / saving | row **first**, then shrink the blob | the note in both places | resolved by the next run |
| deleting | row **first**, then tombstone the stub | a stub pointing at nothing | self-healing |

One invariant covers both: never leave content on the server the user
believes is gone, and never remove content from the blob that isn't
safely on the server. The reverse of either is silent: a tombstone-first
delete leaves a whole lecture on the server with nothing pointing at it,
which contradicts the privacy policy's "yours until you delete them".

**Reconciliation works from tombstones, never from absence.** A row whose
id merely doesn't appear in the blob is *counted*, never deleted. The
two look equivalent and are not: restore a two-month-old backup in
replace mode and the sync succeeds, so every guard passes, and every note
created since that backup now has a row and no stub — absence-based
reconciliation deletes all of them, permanently, while a test asserting
"a live note isn't deleted" passes throughout, because from the restored
blob's point of view those notes were never live. The cost of requiring
positive evidence is a row orphaned by a crash between the insert and the
stub write is never reclaimed. That is the better failure.
`scripts/test-ai-store.mjs` has the restore case by name.

**`fetchNote` has three outcomes and they must stay distinct.**
`{content}`, `{missing:true}` — the query ran and there is definitively
no row — and `{failed:true}` — we know nothing. Only `missing` may
tombstone a stub. Offline, a 500, an expired token and a rate limit all
look like "no data" to a caller that only checks for a row, and this
code runs precisely when the network is misbehaving. The demo-mode smoke
test covers the null-client branch specifically, because a signed-out
user holding stubs would otherwise have every note tombstoned on open.

The row has **three policies, not four**: select, insert, delete. It is
never updated, because `activeLanguage` — the one thing a reader changes
— lives in the blob stub where an ordinary per-item merge handles it and
where it works offline. That leaves no client update path to get wrong.
Grants are written out in 0005 rather than left to Supabase's default
privileges, and they name the same three verbs, so `update` is refused
twice over.

0005 replaces `delete_my_account_data()` by copying 0002's body, which is
a restatement and restatements drift. The guard is behavioural: a
migration test enumerates every `public` table with a `user_id` column
**from the database** and asserts the function empties all of them.

**Offline reading is bought back by `src/noteCache.js`**, an IndexedDB
cache outside the blob, so it costs nothing against the 1 MB budget.
The design rule is that *a cache is allowed to fail*: every method
resolves, none reject, and if IndexedDB is missing (Electron on
`file://`), blocked (Safari private browsing) or full, the note simply
isn't available offline — which is the state we'd be in with no cache.
That is why there is no error surface and no retry logic there. Bounds
are `MAX_CACHE_BYTES` (10 MB) and `MAX_CACHE_NOTES` (300), both derived
from "two heavy semesters is 120 notes at 20 KB = 2.3 MB"; LRU alone is a
slower leak, not a bound. It is purged on sign-out and on account
deletion.

**Study cards are now a choice, not an automatic consequence.** Every
term used to become a card. A lecture yields 8–15, and a student
attending 24 lectures was handed 240–360 cards nobody chose — the
largest single collection in the planner, built without a decision. The
save screen now ticks the first `DEFAULT_CARDS_SELECTED` (6) and lets
the student change it. There is no cap: unticking everything makes zero
cards, ticking everything makes fifteen. Note the edge that a test
guards by name — **an all-false selection is a decision**, and reading it
as "nothing supplied, use the default" silently overrules the user.

**The budget constants in `reference.js` were left alone.** The move and
the card default both reduce the blob, but `MEASURED_EXISTING_BYTES`
(583 KB) is a *measured* figure and this change has not been measured on
a real account — only modelled. Relaxing a guard on a model is exactly
backwards. `scripts/measure-ai-notes.mjs` is the instrument; re-derive
the constants when it has been run against a real export, and the caps
stay conservative until then.

### The text AI features have a different threat model

`ai-text` (Batch 4) runs four tasks — practice questions, explain-it-back,
weak-spot reasoning, and summarising a note the student wrote — and the
thing to understand before changing it is that **it reads no user content
from the database.** The client sends the text; the server touches
`profiles` and `ai_usage` and nothing else, only ever the caller's own
row. There is therefore no "exists but isn't yours" to answer differently
from "malformed" — the class of bug `ai-notes` shipped is absent rather
than handled. Two source-level invariants hold that: no `.from(...)` may
name another table, and every `ai_usage` statement must be scoped.

**One ordering is load-bearing.** The allowance READ precedes the
provider CALL, which is what makes migration 0006 fail free: a missing
`text_units_used` column fails the read, before anything is spent. The
reverse spends money and then errors, so the student pays for work they
are told failed. A traced fake asserts the sequence.

**Billing follows what was really spent.** A failed call bills nothing;
output that can't be parsed IS billed, because those tokens were
generated and charged — and the student is told so, under a different
code from the free failure. Charging quietly is how a support ticket
becomes a chargeback, which is the same rule the AI-notes failure screen
already follows.

**Two allowances, not one.** Minutes for audio, weighted units for text,
because they answer two questions a student asks separately. Students
never see the word "units": the endpoint returns a *fraction* and
`aiTextCopy.js` turns it into words, so the rule is a property of the
boundary rather than a convention across four screens. The client mirrors
the arithmetic in `aiTextLimits.js` so a feature can say what it will
cost before the work — reading `profiles` and `ai_usage` directly under
RLS, which costs nothing and calls no function. **A failed read degrades
to "unknown", never "none left"**: a paywall caused by going into a
tunnel is worse than a missing line.

**Still outstanding, and unchanged by this work:** the semester archive.
Two fixed buckets that nothing ever clears is still the growth that
matters most, and no amount of per-feature capping addresses it.

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

**Only the hosted web build registers a worker.** `index.html` registers
only on `https:` with a non-localhost host, and unregisters anything it
finds otherwise. That rule excludes all three non-web cases by
construction, and it is worth being explicit about which:

| Shell | Origin | Excluded because |
|---|---|---|
| Electron | `file://` | not `https:` — and workers aren't permitted on `file://` at all, so it never had one |
| Capacitor iOS | `capacitor://localhost` | not `https:`, *and* the host is `localhost` — excluded twice over |
| Capacitor Android | `http://localhost` | not `https:` — and this one **is** a secure context, so it really did register |

Android was the live risk: a worker there caches the bundled assets, so
an app-store update that replaced those files on disk would still be
shadowed by the cache — an update that passed review and reached nobody.

**On the checklist for the first real-hardware mobile test** (nothing has
been compiled to a device yet, so no affected install exists): an Android
install that already has a worker gets a *cached* `index.html`, so the
unregister code in the page never runs on first load. It should still
heal without help, because the browser checks `sw.js` for updates
independently of anything the page does, installs the new worker, and its
`activate` handler clears the old cache. Untested, and worth confirming
on the device rather than assuming.

Note also that a docs-only commit produces the *same* build id, since the
hash covers `app.js` and `app.css` only. That is correct — nothing
user-facing changed, so no new worker needs to install — but it means the
build id on the Account tab won't move for every commit on `main`.

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

## Hosting, and why merging is not deploying

**The web app is hosted on Cloudflare Pages**, serving
`www.uniplannerapp.com` from the `main` branch.

| Setting | Value |
|---|---|
| Build command | `npm run build:web` |
| Output directory | `dist-web` |
| Root directory | `/` |
| Production branch | `main` |
| Node version | `NODE_VERSION` = `22`, and `.nvmrc` |

`.nvmrc` exists so the Node version is reviewable in the repo rather than
living only in a dashboard — the same reasoning as the generated cache
name. Keep them in step.

### The app's origin is fixed, and it is not `/` forever

**`https://www.uniplannerapp.com` is the app's permanent origin**, live
since 12 August 2026. DNS stays at Squarespace: one CNAME, `www` →
`uniplanner.pages.dev`, with the bare domain forwarding to `www`. MX
records never moved, so Google Workspace mail was never at risk — which
is why the nameserver switch was cancelled rather than merely postponed.

**The origin must not change after launch.** `localStorage` is scoped per
origin, so every user's local planner — the copy that exists before they
make an account, and the offline copy afterwards — is keyed to the
hostname that stored it. Serving the app from a different host later
strands all of it, and it is exactly the data that is hardest to
migrate: it lives on devices, not on a server we can run a script
against. Today that would affect two people; after launch it is
everybody, silently, with the symptom being "the app lost my notes".

A marketing site is planned. It takes **`/` as a path change on the same
origin**, with the app moving to **`/app`** — not a subdomain. Same
origin means `localStorage` survives untouched.

What that restructure will involve, so nobody reaches for `app.` out of
habit:

- `manifest.webmanifest` already uses relative `start_url` and `scope`,
  so it follows the move for free.
- Every asset reference in `index.html` is relative. Also free.
- `public/sw.js` derives its shell list from `new URL("./",
  self.location)` rather than hardcoding `/`, so the worker's scope
  follows too. Its `NETWORK_ONLY` list stays absolute on purpose: the
  legal documents are site-level, their URLs are in two store listings,
  and they stay at the root even when the app doesn't.
- `src/legalLinks.js` is the single source for the app and consent text;
  the two HTML files are the only other place a URL is written. A test
  in `scripts/test-legal.mjs` fails if `SITE_URL` and the documents ever
  name different hosts.

**Cloudflare Pages serves the legal documents extensionless.** The files
are `public/privacy.html` and `public/delete-account.html`, but Pages
301-redirects `/privacy.html` → `/privacy`, so the canonical public URLs
— and the ones in both app-store listings — are:

```
https://www.uniplannerapp.com/privacy
https://www.uniplannerapp.com/delete-account
```

Both forms resolve, so nothing breaks either way, and the service
worker's `NETWORK_ONLY` list covers all four spellings deliberately: the
redirect was unknown when it was written, and listing both was cheaper
than guessing. A navigation to the `.html` form is fetched, redirected by
Pages, and re-enters the same network-only branch at the extensionless
path — so a legal document is never served from a cache under either
spelling.

`src/legalLinks.js` exports the extensionless form, so the app, the
consent screen and both documents all link to the same strings a store
reviewer will see. The drift test in `scripts/test-legal.mjs` compares
whole URLs against those exported constants, so a half-finished change
to either half fails.

**Do not turn on "Single Page Application" handling.** It rewrites 404s
to `index.html`, so a mistyped `/privacy` would render the planner
instead of a legal document. Real files still win, so the policy pages
would survive either way — but that is precisely the failure mode the
service worker's network-only list exists to prevent, and there is
nothing to gain by taking it.

**Merging to `main` does not mean the change is live.** This has already
been wrong for an unknown number of merges: Netlify paused production
deploys when the account ran out of credits, and PR #6 — the fix that
makes deploys reach users at all — sat merged and unshipped. Nothing in
GitHub said so.

So after any merge that matters, verify rather than assume:

```
curl -s https://www.uniplannerapp.com/sw.js | grep 'const CACHE'
```

That build id must match the one on the Account tab. If it doesn't, the
deploy didn't happen, whatever the merge said. Remember that a docs-only
commit legitimately leaves the build id unchanged.

Netlify remains configured and is deliberately not deleted, so there are
two working options rather than zero. It is no longer the origin of
record.

### Pending, in order, once someone is at a desk

1. **Migration 0004, applied before the code that needs it.** It adds the
   folder-scoped storage delete policy the in-app deletion depends on.
   Without it `removeOwnAudio` cannot delete anything, and the deletion
   page's "immediately" is false. **This was merged before the migration
   was applied — the ordering mistake 0003 already taught us not to
   make.** Migrations are applied by hand in the SQL editor; nothing in
   CI or the deploy applies them, so the ordering is a habit, not a
   mechanism.
2. **Migration 0005, applied before this code reaches users.** It creates
   `ai_notes` and its three policies. Until it is applied, every attempt
   to move a note fails — which is the *safe* direction by design
   (`migrateNote` returns the stub only on success, so the note stays
   whole and readable in the blob and the next sync retries), so nothing
   breaks and nothing is lost. But no note ever moves, so the whole
   change quietly does nothing, which is the failure that is hardest to
   notice. Verify by saving one AI note while signed in and checking a
   row appears in `ai_notes`.
3. **pg_cron and pg_net**, enabled in `Database → Extensions`, plus the
   Vault secrets migration 0004 reads. Until then the retention sweep
   only runs opportunistically and the periods the privacy policy states
   are aspirational rather than enforced. 0004 raises a notice saying so
   rather than failing.

**The scheduled sweep authenticates with a dedicated secret, never the
service role key.** pg_net stores each outbound request — headers
included — in `net.http_request_queue` until its TTL expires, so
whatever authenticates that job sits at rest in a database table for
hours at a time. `AI_NOTES_SWEEP_SECRET` only lets its holder trigger a
retention sweep, which the system does hourly anyway; the service role
key there would be a full-database credential in a queue table. Don't
"simplify" it back.

### Known broken: password reset, end to end

Two independent faults, either of which alone would break it:

1. The Supabase project's **Site URL** points at the old host, so the
   reset email links somewhere wrong.
2. `sync.js` creates the client with `detectSessionInUrl: false`, so even
   landing on the correct host, the app never processes the recovery
   token in the URL.

A user who forgets their password therefore has no route back into their
account, and nothing surfaces this until it happens to someone real.
**Launch blocker, deliberately not fixed during the hosting migration.**
When it is fixed it needs testing end to end with a real email — the code
reads plausibly, which is exactly why it was never noticed.

## When Netlify was the host

Kept because the lesson generalises to any provider that reports its own
outages as your fault.

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
is `npm test`; the three `… - uniplannergdog` checks were Netlify's own
and read `neutral` when a deploy was fine, not `success` — which is worth
knowing when reading the history of a PR from that era, since "not green"
on those did not mean broken.

## The published documents

`public/privacy.html` and `public/delete-account.html` are plain static
files, copied into `dist-web/` by the build like every other asset. No
JavaScript, no external requests, stable paths, and the service worker
treats both as network-only so a stale legal document can never be
served from a cache. Google Play requires a publicly reachable deletion
page; both stores require the policy URL.

**Every claim in them is checked against the code by
`scripts/test-legal.mjs`**, which is the point: a document is the one
artifact where being quietly wrong costs the most and shows the least.

**The documents enumerate where a student's data lives, so a new table
makes them wrong.** That list is now read from the migrations rather than
typed into the test: `create table public.X` is matched across
`supabase/migrations/`, and every table found must have a declared phrase
in each document. Adding a table fails the suite with "no document text
is declared for it" until someone decides what the documents say. A
hardcoded list would have gone on passing when `ai_notes` arrived and the
policy still described the planner as holding everything a student
writes — the same drift the cache name and the host allowlist had.

**A store on the user's device is the same class of change**, and the
IndexedDB note cache was exactly that: somewhere whole lectures live that
neither document covered. Guarded the same way, from the `uni-planner-*`
naming convention every store already follows — each name found in `src/`
or `public/` must be declared with a document phrase, or excused with a
written reason it holds nothing of the student's. That guard has a known
hole and says so: a store named off-convention slips past it, so a second
check counts IndexedDB databases, since that is the only device store big
enough to hold note text. A partial guard that names its hole is worth
more than a thorough-looking one that hides it.

The related trap in the wording: `ai_notes` and `ai_notes_requests` both
hold a lecture summary, and their promises are opposite — one is the
student's until they delete it, the other is ours for 7 or 30 days. A
test asserts the *distinction*, not just that both are mentioned, because
every phrase can be present while the section still reads as one thing.

**Consent was not bumped for the storage move, deliberately.** Each v4
bullet was checked against the change and none became untrue: the audio
is still deleted on transcription, the server copy still lasts 7/30 days,
saved notes are still the student's until deleted. Consent exists to
obtain agreement about *what happens to the content* — where it goes, who
sees it, how long it is kept — and none of that moved; the row sits in
the same database, in the same region, under the same policies, deleted
by the same account deletion. Re-prompting for a change a student cannot
meaningfully accept or refuse is not free: it trains people to click
through consent screens, which is paid back the next time a bump really
matters. Bump for a change in what happens to the data, not for a change
in which table holds it.
The retention test is worth understanding before loosening it — asserting
that "7 days" and "30 days" appear is not enough, because both already
appear twice, so one could drift while the other kept the test green. It
asserts instead that *every* day-count in the policy is one the server
enforces.

The wording lives where it can be reworked without touching logic:
`src/legalLinks.js` for URLs and addresses, `src/aiNotesCopy.js` for the
AI failure paths, `src/aiNotesRetention.js` for the periods, which the
consent text interpolates rather than repeating.

Neither document is legal advice, and both should be reviewed by someone
qualified before store submission.

**Both were deliberately written ahead of the features they describe.**
The policy and consent v4 cover AI features that work on text the student
already wrote — practice questions, explain-it-back, summarising your own
notes — before any of those shipped. Being slightly over-broad ahead of a
feature costs nothing; being under-broad after it ships is the failure
that matters, and it is the one that would have happened here. The old
wording promised nothing left the country *"unless you use the AI notes
feature"*, which the first text feature would have made untrue while the
URL sat in two store listings. Write for what the system will do, and
bump the consent version in the same pass.

### Known limitation: reference sheets store plain text

A reference sheet entry's `body` is exactly what the student typed —
there is no LaTeX, no MathML and no maths rendering of any kind, so a
formula is written with Unicode symbols (`x = (-b ± √(b²-4ac)) / 2a`) and
displayed in a monospace font.

That is a deliberate scope decision, not an oversight. It matters for
anyone adding KaTeX or MathJax later: **the stored `body` was never a
markup format**, so existing sheets cannot be reinterpreted as one. A
sheet containing `$x^2$` today means those literal characters. Rendering
would need either a new field, a per-entry flag, or a migration that
guesses — and guessing at someone's coursework is the wrong answer.

## A guard that restates its subject will drift

Five separate times now, a check has been weaker than it looked, always
the same way: it hardcoded the value it was supposed to be guarding.

- The service worker's **cache name** was a hand-edited constant. It was
  meant to change every build; nothing made it, so it never did, and
  deploys stopped reaching users with no error anywhere.
- The documents' **external-host allowlist** named `uniplannerapp.com` as
  a literal. Moving to `www` read as an off-site resource and failed a
  test that was supposed to be about third-party requests.
- The documents' **URL drift test** compared hosts but not paths, so
  `legalLinks.js` could point at `/privacy` while the documents still
  cross-linked `/privacy.html` and nothing would notice.
- The documents' **list of tables** was typed into the test. The
  published documents enumerate where a student's data lives, so adding
  `ai_notes` made them wrong — and the test went on passing, because it
  was checking a list that hadn't changed either.
- **`MONTHLY_MINUTES_LIMIT_HINT`** restated the Edge Function's
  `MONTHLY_MINUTES_LIMIT` in the browser bundle, which genuinely cannot
  import from `supabase/functions/`, with nothing comparing the two. The
  comment said a drift would be "cosmetic". It would not have been for
  `MINIMUM_BILLED_MINUTES_HINT`, added beside it: that is the number a
  student watches their allowance move by, so a drift makes the figure on
  screen disagree with the figure being charged.

One is an anecdote. Five is a rule: **derive a guard from its source of
truth, don't restate it.** The cache name is hashed from the built bytes,
the allowlist is read from `SITE_URL`, the drift test compares whole URLs
against the exported constants, the table list is matched out of the
migrations, and the mirrored constants are asserted equal to the ones
they mirror.

Where a restatement genuinely cannot be avoided — a browser bundle and a
Deno function cannot share a module — the mirror is allowed and the
*equality* becomes the guard. What is never allowed is a mirror with a
comment instead of an assertion.

The test for whether a guard is real is to break the thing it protects
and watch it go red — restating a value gives you two copies to keep in
step and a test that only checks one.

## Testing

`npm test` builds the web bundle, then runs the app tests, the demo-mode
smoke test, and the migration tests. All of it is plain Node and `assert`,
no framework, matching the style of the build scripts.

- `scripts/test-ai-notes.mjs` — AI notes, the scheduler, stats, merge behaviour
- `scripts/test-ai-text-function.mjs` — the text endpoint: the allowance
  read that must precede the provider call, the two source-level
  invariants, and that every returnable code has wording
- `scripts/test-practice.mjs` — practice attempts store state, not the
  questions, and prune their own tombstones
- `scripts/test-ai-store.mjs` — the storage move: both ordering rules, the
  three fetch outcomes, tombstones-only reconciliation, and the cache's
  bounds. The two tests worth knowing by name are the restore-an-old-
  backup case and "an error reads as failed, NOT as missing"
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
