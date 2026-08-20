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

The corollary used to be that the planner had **no semester lifecycle
at all** — a student in second year reused "Semester 1" with first
year's content still in it, so the blob grew without bound inside two
fixed buckets. The semester archive (its own section below) is the
lifecycle now: deliberate, account-only, and built entirely out of
stripped tombstones and one marker so that neither of the two
functions above changed. Archiving adds no semester key — the trap in
this paragraph is sidestepped, not resolved.

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

**A long lecture WITH a translation is the case that reaches the cap
first, and the diagnosis is counter-intuitive.** The deeper prompt took
a measured note from 2,251 to 6,135 bytes, so a translated 50-minute
lecture now approaches 20 KB where it used not to. What the cap gives up
is the copy the student did **not** ask for — so a student reading
Spanish loses the **English**, and keeps what they wanted. If someone
reports "my translation vanished on a long lecture", that is *not* this
mechanism and something else is wrong; if they report the English
missing from a note they asked to have translated, it is working as
designed. `summaryForStorage` drops the terms before storing, so the
stored figure is smaller than anything the measurement script reports.

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

### Never treat a failed request as evidence of absence

**Absence is proven by a definitive not-found and by nothing else.** A
dropped connection, a 500, an expired token and a rate limit all look
like "no data" to a caller that only checks whether something came back
— and this code runs precisely when the network is misbehaving.

It has now happened twice, in the two places where guessing costs the
most:

- **`fetchNote`** (`aiNotesStore.js`) returns `{content}`,
  `{missing:true}` and `{failed:true}`, and only `missing` may tombstone
  a stub. That one was designed correctly from the start.
- **`RecoveryGate.recover`** was not. It caught *every* error, told the
  student their recording had expired, and called `forget()` — deleting
  the idempotency key, which is the only handle on a summary they have
  **already been billed for**, while the server holds it for another
  seven days. A student tapping retry on a train lost a paid lecture and
  was told it expired when it hadn't.

`recoveryFailureKind` now names the two definitive codes
(`recording_missing`, `bad_idempotency_key`) and reads everything else —
including an error carrying no code at all — as `failed`, keeping the
key. **Fail towards keeping.** A key whose result is really gone costs a
card the student can dismiss; a discarded live one costs a lecture.

Two details worth keeping. The definitive codes are checked against the
Edge Function's source by a test, so a renamed code can't quietly stop
being definitive. And the card renders on `pending`, so dropping the key
used to unmount the card *in the same tick* as the explanation was set —
the student tapped the button, everything vanished, and they were told
nothing. A separate `gone` flag now outlives the key it explains.

The next place this will appear is anything that reads a row and treats
"no row" as "deleted". Ask what a 500 looks like to that code before
writing the branch.

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

### "Text the student supplies" is the governing category

Consent v4 said "writing you have already done". That was too narrow,
and — this is the part worth keeping — **it was already too narrow
before readings existed.** A lecture recording captures a lecturer's
copyrighted delivery, so the app has always worked on material the
student did not write. Lecture audio was an *example* of the category,
never a separate thing beside it.

v5 names the category instead: **text and audio the student supplies, of
whatever origin, relayed to do what they asked and — for text — not
stored at all.** The next feature that takes supplied text needs no
bump.

**v6 widened the category to images**, when the reading summariser took
photographed pages. A photo is an *image* of text, and reading "text
you supply" to cover it is the wordsmithing the category naming exists
to prevent. The bump test passed in both directions: a new kind of
material leaves the country (a photo can capture more than the words),
and the same promise is made about it. Photos ride the request body and
are relayed — `ai-text` has **no storage client at all**, and a test
pins that, because the day someone adds `.storage` there the policy and
the consent both become false. Photos are priced as *parts of the
reading* (a batch of 4 pages = one text chunk), so the parts language,
the pre-flight estimate and the keep-what-was-charged rule are the
existing ones. Blur is handled by **model refusal** (`pages_unreadable`,
naming the pages), never a client heuristic — and the refusal is
billed, under its own code, with copy carrying both halves: this
attempt charged, the resubmit charges again as its own smaller batch. Consent bumped here because *what happens to the content* changed
twice over: a new kind of material leaves the country, and a new promise
is made about it. That is the test, and it is why the storage move
didn't bump — a row moving tables is not a change a student can
meaningfully accept or refuse.

`scripts/test-legal.mjs` used to require the literal phrase "your own
writing", so **correcting the policy failed the test that existed to
keep the policy true.** That is the seventh instance of the restatement
pattern and the first one inside a test. It now asserts the category and
checks the two documents against each other.

The distinction that has to survive rewording: a lecture keeps a
server-side transcript for 7 or 30 days; supplied text has **no
server-side copy at any point**, because `ai-text` writes only
`ai_usage`. If both read the same, the stronger promise isn't being
made, it is being blurred.

### Summarising a reading, and the wording rule that holds it up

Paste only. No PDF parsing, no upload, no OCR, no stored library — and
that is **the shape, not a missing feature.** What makes this defensible
is that a student supplies a piece at a time, of material they already
have, which is relayed and never stored. A bulk upload with a library is
a different product with a different answer, and there is no cheap
version of it that keeps this shape.

**Every piece of user-facing wording describes study, never
substitution.** "Summarise a reading to revise it" is the product; "skip
the reading" is not — not in the feature copy, not in an empty state,
not in the consent text, not in a store listing. This is a legal
position as much as a tonal one: copy offering to replace the material
undermines the private-study framing the whole thing rests on. A blunt
grep in `scripts/test-readings.mjs` enforces it, and it caught its own
documentation on the first run — so it strips comments first, the same
way the device-store guard does and for the same reason.

**Chunking.** Over `MAX_INPUT_CHARS.summarise` (20k) the reading is
split on paragraph boundaries with ~200 characters of overlap, capped at
`MAX_READING_CHUNKS` (4), and the parts combined by a `merge` task. The
overlap is why the merge prompt is *told* the sections overlap —
otherwise the model reports the repetition as emphasis. Packing is to
`cap − overlap`, since packing to the cap and then prepending the
overlap produces a chunk the server answers with a 413 after the earlier
parts have already been charged.

`merge` is weighted **1, not 3**: `summarise` is priced for 20,000
characters and a merge takes four short summaries. A whole reading costs
3 / 7 / 10 / 13 units by chunk count.

**A failed merge must not waste the chunks.** Every section was
summarised and every one of those calls was charged; discarding them
because the last, cheapest step failed takes the allowance and returns
nothing. So the parts are combined locally — no provider call, nothing
further charged — terms deduplicated because the overlap really does
repeat them, and the note records `partsMerged: false` so it still says
what it is next month. The two failures get different sentences: a merge
that failed outright cost nothing, a merge that returned unusable output
was charged.

**It lives on the reading row**, collapsed to one line, opening inline —
the same shape as `RubricPanel` on an assignment, deliberately, because
this app has one way of attaching a paste-and-do-something panel to a
row and a second one would be a second thing to learn. The student is
looking at "pp. 89–112" when the thought occurs, which is where the
action belongs. The result is filed into the per-course folder exactly
as a recording is, inside its own `try` for the same reason: a folder is
a convenience and must never take down work just paid for.

**The pre-flight estimate is mandatory**, because the cost is variable
and nothing else on screen hints that a long reading costs four times a
short one. A refusal states the *specific* situation — how many parts
the reading is, how many are left, and whether a shorter paste still
fits, which is the one thing the student can act on.

**Both numbers are in parts, and that is what keeps rule 1 intact.**
"This needs 13 and you have 7" would be the first time an internal unit
count reached a screen, and it would mean nothing to anyone; parts are
the currency the feature already shows. `sectionsAffordable` in
`aiTextLimits.js` is `canAfford` extended to a variable-cost action
rather than a second scheme beside it.

**There is no attempt to identify what the pasted text is.** No
heuristic for "this looks published" — there isn't a reliable one, and a
false positive blocks a student summarising their own handout, which
reads as the app being broken. The posture rests on the design facts
(student-initiated, paste-only, never stored, no library) and on the
wording rule, not on content identification this cannot do.

**Consent is enforced at the point of use, by showing the gate rather
than hiding the action.** A feature nobody can see is not consent, it is
absence — the student never learns it exists. Note the other four text
features are *not* gated; that gap predates this and closing it changes
four existing screens.

`sourceReadingId` on the stub is **decorative**. Deleting the reading
leaves the summary note exactly where it is — it is the student's work
and must not vanish with a row of metadata about which pages they were
on. It is read in one direction only: the reading row uses it to show
"Summarised" and link to the note, and nothing cascades the other way.

### Recording: the failure that costs money is silence, not an error

`src/audioSources.js` decides what a platform can record from and what
to ask for. It is pure and takes the environment as an argument, so the
whole matrix is a table in `scripts/test-audio-sources.mjs` rather than
something only a real browser can answer.

**The trap is that a silent capture looks exactly like a good one.**
`getDisplayMedia({audio:true})` resolves happily with a stream that has
**no audio track** when the student picked a screen or a window on macOS
Chrome — where only a browser *tab* carries audio — or anywhere if they
did not tick the share-audio box. `MediaRecorder` will record an hour of
that, the upload succeeds, transcription runs on silence, the
three-minute minimum applies, and the student has paid for nothing.

So `checkCapturedAudio` runs **before the recorder is constructed**, and
a failure aborts having recorded and billed nothing. The message names
what to pick instead per platform, because "no audio was captured" is a
dead end for exactly the student who needed the instruction. The same
guard covers the desktop build, where the OS may decline loopback for
its own reasons — which is why `desktop/main.js` promises nothing and
`describeCapabilities` only says the option exists.

The same failure arrives late when the student clicks "Stop sharing"
mid-lecture: the track ends, `MediaRecorder` does not notice, and the
billed duration keeps climbing on silence. Both audio and video tracks
of a display stream get an `ended` listener; the video one is watched
precisely because it is never recorded, so nothing else would have seen
it go.

**Two constraint sets, not one with a flag.** The microphone path turns
echo cancellation, noise suppression and AGC *off* — all three are tuned
for a phone call, and noise suppression in particular treats a quiet
steady voice eight metres away much the way it treats a hum. System
audio is already a clean digital signal with no room in it, so there is
nothing to disable; sharing one object is how the two silently become
one. The ~80 Hz high-pass is a `BiquadFilterNode`, not a constraint, so
the microphone path now runs through a WebAudio graph — **with a
fallback to the raw stream if the graph can't be built**, which keeps
exactly the robustness the feature had before. "Both" is the one case
where a graph failure is fatal, because mixing is the whole point.

`deviceId` is requested as **`ideal`, never `exact`**: exact throws
`OverconstrainedError` on a headset that has been unplugged, so a
student who took their earphones out would be told recording failed
instead of falling back to the laptop microphone. The saved preference
lives in `uni-planner-audio-input`, **outside the synced blob** — a
deviceId means nothing on another machine, so syncing it is at best a
no-op and at worst two devices fighting through last-write-wins. It
matches by id, then by label (Safari rotates ids every session), then
falls back to the default *silently*.

**System audio is the first genuine reason to install the desktop
build**, and worth remembering when the marketing site is written:
browsers only ever offer loopback alongside a screen or tab share, and
macOS Chrome only alongside a tab. Electron asks the OS directly.

### Android needs TWO audio permissions, and the second one is invisible

`RECORD_AUDIO` alone looks sufficient: the runtime prompt appears, the
student taps Allow — and the WebView still refuses, logging

```
Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO.
No audio device will be available for recording
```

so the app reports "microphone access was denied" to someone who has
just granted it. Android's WebView needs the **app** to declare
`MODIFY_AUDIO_SETTINGS` before it will expose an audio device at all;
a user's runtime grant does not substitute for it. It is a *normal*
permission — install-time, no second prompt.

**Nothing but hardware could have caught this.** Desktop browsers have
no manifest, so every environment the suite runs in is happy without it.
It took a real device, a granted permission and a Logcat line.

**VERIFIED ON HARDWARE: Android recording works, moto g05, 14 August
2026.** The whole recording chain passed — the permission prompt leads
to an actual microphone, a lecture records end to end and files itself
into its course folder, the timer survives a tab switch and stops from
the indicator, and backgrounding warns without stopping. That is
`MOBILE-BUILD.md` items 9, 9a, 9b and 9c.

It is worth being precise about what that does *not* cover, because
"verified on hardware" reads much broader than it is. **Nothing about
offline storage, sync between devices, or the no-service-worker rule has
been run on a device**, and the service-worker check is the one with a
live risk behind it: `http://localhost` is a secure context, so Android
is excluded only by the protocol test in `index.html`, and a worker
there would shadow an app-store update. **iOS has never been compiled at
all.** The list and its current state live in `MOBILE-BUILD.md`.

**The platforms are not symmetric, and looking for the mirror is the
habit worth keeping.** iOS needs no routing permission — WKWebView
manages its own `AVAudioSession` under the usage string — but it has a
version floor instead: `getUserMedia` only *exists* in WKWebView from
**iOS 14.3**, and below that the recorder is silently absent with no
error anywhere. We deploy at 15.0, and a test now guards the number
rather than the comment.

### A recording outlives the tab it was started on

The AI Notes tab renders as `{tab === "ai-notes" && ...}`. Switching
tabs unmounts the subtree, and the recorder's unmount effect ran
`cleanupStream()` — every track stopped, the `AudioContext` closed,
`chunksRef` garbage-collected — **without ever calling
`recorder.stop()`.** No `Blob` was assembled, no recovery key had been
parked yet (that happens in `runUpload`, after a successful stop), and
nothing was said. A two-hour lecture vanished on one stray tap.

`useRecordingSession` is called once in `PlannerApp`, above the switch,
so a tab change is now a re-render of something else.

**It had to be the whole session, not just the stream.** `runUpload`
reads `course`, `week` and `translateTo` out of that closure at the
moment recording stops, so hoisting the stream alone would leave a
stopped recording with nothing to drive it and the form fields still
dying with the panel. The end-to-end test is named for that path —
*"the course/week/translation survived the tab switch"* — and it goes
red if any of them moves back down.

**Saving moved up too, and that is the part worth keeping.** `addItem`,
`setData`, `folders` and `session` already live in `PlannerApp`, so the
save has no reason to be anywhere else — which **deletes the prop-relay
chain** that `folders` travelled (`PlannerApp → AiNotesPanel →
RecoveryGate → Recorder`) and that produced the `ReferenceError` which
white-screened Android. There is nothing left to relay, so there is
nothing left to drop. A test asserts the panel and the recorder no
longer take props they only pass on.

**Processing was already survivable and only the UI pretended
otherwise.** `runUpload` parks the idempotency key before the upload,
and `callAiNotes` is one long request rather than a poll, so an unmount
discards the `dispatch` and nothing else. The recovery card picked it up
on return. What was missing was any indication it was still happening.

The indicator is rendered **outside** the tab conditional — inside it,
it would only be visible on the tab you already had to be on, which is
nothing. A test walks the JSX block to assert that. **Stop is on the
indicator**, because "I can't stop the recording" is a privacy problem
before it is a usability one.

### Two ways a recording quietly becomes billed silence

`checkCapturedAudio` runs once, before the recorder is constructed, and
the `ended` listener catches a track that *stops*. Neither sees a track
that goes **muted**, and that is exactly what Android does:

**API 30+ refuses microphone capture to an app without a foreground
service of type `microphone`.** Our `minSdk` is 26 and target 36, so it
applies to every device. Lock the screen mid-lecture and the track does
not end — it mutes, everything downstream keeps recording, and the
duration keeps billing. A `mute`/`unmute` listener on the microphone
track now catches it, and a `visibilitychange` listener catches the
backgrounding itself (**only on the phone shells** — a desktop browser
keeps `getUserMedia` alive in a background tab, and warning there would
teach people to ignore the warning that matters).

**Neither stops the recording, deliberately.** A mute can be momentary —
an incoming call, a permission toast — and killing an hour of lecture
over three seconds of it is the worse failure. They warn, and the
warning persists to the review screen so the student knows part of it
may be silent before they save.

**Recording while the app itself is backgrounded is out of scope**, and
this finding is why: a recording that "continues but degrades
unpredictably" is worse than one that visibly requires the app to stay
open. What it would take, if it is ever revisited: a Capacitor plugin
exposing an Android foreground service with
`foregroundServiceType="microphone"`, the `FOREGROUND_SERVICE_MICROPHONE`
permission, a persistent notification and a Play Console declaration;
on iOS the `audio` background mode and an App Store review that asks why
a study app records in the background. Different product, different
submission risk.

### Handwriting was REMOVED — feature and data, 16 August 2026

Grace and Jared's decision, and it was explicitly both halves: not a
hidden feature over dormant data, **a full removal**. The drawing
tools, `src/ink.js`, the compression chain, the canvas renderers and
the stored strokes are all gone. What remains is the strip that keeps
old data honest, in `src/noteBlocks.js`:

- **`removeHandwriting` runs at the end of `normalizeData`**, so every
  load AND every backup restore is covered by the same line. It is
  flag-guarded (`meta.inkRemoved`) and bumps `updatedAt` only on pages
  that really carried ink — the removal is a real edit and must WIN
  merges, or a stale device brings the strokes back for good.
- **The flag is best-effort, convergence is the guarantee.**
  `mergeData` spreads `{...local.meta, ...newerSide.meta}`, so a flag
  living only on a non-newer remote is dropped — and that is fine,
  because re-running the pass on already-stripped data returns every
  page BY REFERENCE with no bumps. Nothing propagates, nothing fights.
  Do not "fix" the flag loss in `mergeData`; the test named "the flag
  is best-effort across merges" pins both halves.
- **Archive restore is the second resurrection door.** Archive rows
  hold the bucket VERBATIM, so a semester archived before the removal
  carries every stroke — Jared has a live one. `restoreTransform`
  strips pages on the way back in, and `test-archive.mjs` proves it
  over both stored shapes (raw `strokes`, and ink blocks inside
  `blocks`).
- **Remove ink, never remove notes.** An ink-only note becomes an
  empty text note KEEPING ITS TITLE and its folder; its list row reads
  "Empty note" rather than a blank or a stroke count (asserted in a
  real mount by `test-blocks-neutral.mjs`). Deleting whole notes would
  be a bigger destructive act than the one that was ordered; the
  affected users can delete the husks themselves.
- **Tombstones and AI stubs are untouched** — the same absolute rule
  the archive established. A `LEGACY_INK` block from a pre-removal
  device renders as nothing, crashes nothing, and is stripped by
  `noteFields` on that note's next save.

Cancelled with the feature, so nobody resurrects the plans: the
**annotation layer** (nothing left to annotate with) and **pen
detection starting an ink block** (never built). The compression
work — capture rounding, simplification, delta encoding, and the
measurement discipline around Grace's stylus sample — shipped, worked,
and went down with the feature; the lesson that outlives it
("re-derive a constant before building on it; a synthetic benchmark is
not a promise") is recorded in the measurement and remedy sections
below, which are kept as history.

One consequence worth naming: the storage problem this section used to
describe (a dense stylus page at ~113 KB) no longer exists, which
removes the biggest uncapped growth inside a semester. The semester
archive bounds the years; this removed the heaviest thing a year could
hold.

### The semester archive: the lifecycle that bounds time

`src/semesterArchive.js`, migration 0007, `scripts/test-archive.mjs`.
The caps bound features; this bounds years. A student reusing
"Semester 1" across years breached the 1 MB budget on reuse alone
(583 KB × 2), which `test-reference.mjs` still asserts — archiving is
deliberate, never automatic, so the fact stands and is what justifies
the nudge on the Backup panel's size warning.

**The shape.** Archiving stores the bucket VERBATIM in its own row
(`semester_archives` — jsonb, ~600 KB a semester, two rows a year;
the server is where growth is cheap). In the blob, every live item is
stripped to a bare tombstone `{id, deletedAt, updatedAt}` — the shape
`pruneStats` already writes — and the settings row stays live carrying
the marker (label, item count, the rounding rule kept, the calendar
dropped). Stripped tombstones are the only representation that both
PROPAGATES (per-item last-write-wins carries the deletion to every
device, old builds included, with zero merge changes) and actually
SHRINKS the blob — a full-payload tombstone keeps the 583 KB for the
whole 60-day purge window, and hard removal is the one thing union-
by-id merge resurrects forever. `SEMESTER_NAMES`, `COLLECTIONS`,
`mergeSemester` and `mergeData` are all untouched; no third semester
key ever exists, so the normalizeData/mergeData disagreement recorded
above is never approached.

**THE ABSOLUTE RULE: archiving never writes `deletedAt` on an AI-note
stub, and never removes one.** `reconcilePlan` deletes the `ai_notes`
row for any tombstoned stub, that behaviour is already shipped, and no
flag a new build adds will stop an OLD build on a second device from
syncing the tombstones and destroying every archived lecture's content
permanently. Live stubs instead gain `archivedIn` (an ordinary field
riding the per-item merge; previews emptied — the row keeps the full
copy), which new builds filter from the term's lists and old builds
harmlessly show. A stub that is already a tombstone — a delete still
pending reconciliation — is left ENTIRELY untouched: stripping it
would erase the `aiMeta` that reconciliation recognises it by, and the
row it points at would leak on the server forever. The bonus falls out
free: archived lectures stay readable (their content was never in the
blob), listed in the archive panel and opened through the ordinary
notes deep link.

**Ordering is the aiNotesStore table, extended.** Archiving: row
FIRST, then strip — an interruption leaves the semester in both
places, resolved by retry. The archive id is parked on the device
(`uni-planner-archive-pending`, scoped to the bucket) so a retry lands
on the SAME id, and the retry deletes any half-landed row before
re-inserting — so a row can never hold an older snapshot than the blob
that was stripped. `stillCurrent` re-checks the bucket CONTENT after
the insert (serialized snapshot, reference equality as the fast path),
because a recording can save itself mid-flight and stripping a bucket
the snapshot no longer matches loses the difference from both places.
Content and not reference, because every completed sync rebuilds the
semester objects without changing them — a reference check refused
with "changed" over an unchanged semester whenever a focus-triggered
sync landed mid-archive, which journey 3 caught in CI (the e2e
suite's first real app bug). Restoring: blob first, and the archive row is NOT
deleted — it stays until the student deletes it, so a crash
mid-restore leaves content in two places, never zero.

**Late edits are surfaced, never swept.** An edit from a
not-yet-synced device survives the archive tombstones by its newer
`updatedAt` and shows up live in a marked bucket. Two buttons, no
default: "Add to the archive" folds it in as insert-new-row-then-
delete-old (the table has no update policy — the ai_notes shape, so
there is no client update path to get wrong), "Keep here" clears the
marker. The copy is device-neutral by test, because on the device that
made the edits "another device" would be false. The student's own
first item of the new term never reads as a late edit: `addItem`
clears the marker on creation, and merge-arrived items don't pass
through `addItem`, which is exactly what keeps real late edits
surfaced.

**Restore is a union with re-stamping rules.** Live items are
restamped (so they beat their own archive-time tombstones on every
device); items that were tombstones AT archive time keep their old
stamps and stay dead — restore must not resurrect what the student
deleted before archiving. Newer tombstones in the bucket survive the
union. An occupied bucket refuses the restore ("archive the current
semester first"); archive residue and flagged stubs don't count as
occupied. The streak carries (`cur`/`max`/`last` seeded into the fresh
totals row) and the minutes reset — a streak is about the student,
minutes are about the courses.

**The residue constants are ceilings proved by measurement.**
`ARCHIVE_TRANSITIONAL_RESIDUE_BYTES` (120 KB, the stripped tombstones'
60 days) and `ARCHIVE_STEADY_RESIDUE_BYTES` (16 KB forever: marker +
preview-stripped stubs) are asserted by running the real transform
over a ~290 KB fixture whose realism is itself asserted. The budget
sentence the feature exists to make true: measured post-Batch-3
account + six archived buckets + one transitional ≤ 1 MB. The old
tripwire in `test-reference.mjs` did not invert — reuse without
archiving still breaches — it split, and its other half lives beside
the transform it measures.

**"Nothing reads a tombstone's content" is a differential mount, not
an assertion.** The same planner with full and stripped tombstones
must render byte-identical HTML on every tab (frozen clock, frozen
`Math.random`, save-state settled). The ONE permitted consumer is
masked by name: the Backup panel's size line measures the whole
serialised blob, and a stripped tombstone really being smaller is the
feature. Breaking `live()`'s filter goes red through this test —
checked by mutation.

**Account-only, gated visible.** The gate names the tool to a
signed-out student (a feature nobody can see is absence, not a gate),
and the boundary refuses on its own — `archiveSemester` returns
`unauthenticated` with no client, so the UI gate is not the only
thing between a signed-out student and a strip with no row behind it.
A failed archive list renders as UNKNOWN ("couldn't load"), never as
"nothing archived yet" — a dropped connection must not read as gone.

### Depth is bought with instructions, and the billing did NOT move

Real output was "helpful and great, but shallower than I'd like", and
the cause was visible in the prompt: it named the five sections and said
nothing about what belonged in them, so the model wrote headings. The
schema cannot help — OpenAI's strict structured-output mode does not
support `minItems` — so depth is a prompt property or it is nothing.

**Depth went into the sections, not beside them.** The five are
unchanged; a sixth would touch every screen that renders a note and
every note already saved. Each now says what belongs in it: the
reasoning as well as the claim, the lecturer's own names, dates, figures
and worked examples, terms explained *as the lecturer explained them*,
and the examinable signal quoted so a student can see why a line is
listed. Every rule is either *include what was actually said* or *do not
invent* — told to go deeper with nothing to be deep about, a model
inflates, and the student pays for the tokens.

**Measured, on a real 4,772-character recording with a translation:**

| | before | after | |
|---|---|---|---|
| key points | 5 | 6 | +20% |
| **words per key point** | **9** | **26** | **+189%** |
| terms | 3 | 8 | +167% |
| overview words | 22 | 58 | +164% |
| open questions | 2 | **0** | −100% |

Entries barely moved and their contents nearly tripled, which is the
distinction the instrument was built to report: *more per entry*, not
*more entries*. The open questions going to zero is the anti-padding
rule working — the old prompt invented two for a narrated story that has
none.

**THE BILLING DID NOT MOVE, AND THAT IS THE FINDING.** Both increases
that had been proposed — `MINIMUM_BILLED_MINUTES` 3 → 4 and
`SUMMARY_MAX_TOKENS` 8,000 → 12,000 — were arithmetic on
`TYPICAL_SUMMARY_OUTPUT_TOKENS`, which was **modelled at 2,800 and
measured at 475: the guess was 5.9× reality.** A constant nobody had
measured was quietly setting the price of the product. Re-derived, one
summary costs $0.00096, the floor needs 1.44 minutes, and the 3 that was
already there covers it 2.08× — so a deeper prompt ships without
changing what any student is charged.

The general form, and it is the same lesson as the ink measurement gate:
**re-derive a constant before building on it, especially when the thing
you are about to build is a price.** Two user-visible increases were
one measurement away from being unnecessary.

`SUMMARY_MAX_TOKENS` moves **only on a measured long lecture**, never on
an extrapolation from a short one — a 5-minute sample cannot say what a
3-hour recording produces, and that constant only matters for long ones.

**A marker a machine greps for is not vocabulary.** The deploy refuses
while `config.ts` carries the unmeasured flag. Writing that word in a
sentence — even to say something is *not* it — blocks the deploy. That
happened while writing the comment explaining the flag. Prose says
"unverified"; the marker is reserved for the thing it marks.

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

### Invisible rewrites may be bulk. Shape changes must be lazy.

Two migrations, two answers, and the difference is worth stating as a
rule because it will come up again.

**The ink rounding ran on every load, over everything.** (The feature
is gone; the example stands.) That was safe precisely because it was
*invisible*: no reader could tell a rounded stroke from an unrounded
one, it was idempotent, and it returned the same array reference when
nothing changed, so a load that altered nothing wrote nothing. Bulk
costs nothing when the result is indistinguishable.

There is now a third answer between the two: `removeHandwriting` is a
**bulk-ONCE** pass — visible (so it must not run on every load) but
flag-guarded, with convergence as the backstop when the flag loses a
merge. See the handwriting-removal section for why that combination
holds.

**A change to the shape readers branch on must convert lazily**, on
first edit, one note at a time. Doing it in bulk on load rewrites the
entire collection on the first launch after deploy — a full blob write,
a full sync — and if the conversion has a bug it has already touched
everything before anyone notices. Lazy means a bug reaches one note
instead of all of them.

The test for which you are doing: *could a reader tell?* If no, bulk is
free. If yes, it is a shape change, and shape changes convert on first
edit with readers handling both forms indefinitely.

### The unified note: `blocks`, and how "neutral" was demonstrated

**Post-removal status:** blocks are now a stack of `{type:"text"}`
only. `LEGACY_INK` survives as a recognition constant so pre-removal
data renders (as nothing) and strips on save; `inkOf` and the canvas
renderers are gone, and `test-blocks-neutral.mjs` was rewritten around
the removal — it now proves a pre-removal note renders identically in
both shapes *as the same stripped note*, and that no reader mounts a
canvas. The history below is kept because its lessons are load-bearing
elsewhere.

`src/noteBlocks.js` is the block view of a note — originally a stack of
`{type:"text", html, body}` and `{type:"ink", strokes}` — and step 3
introduced it as **readers only**. Nothing in that file wrote, nothing
converted, and no screen changed. A note is `blocks` if it has them and
is *derived* into blocks if it doesn't, which is the lazy half of the
rule above: the editor (step 4) is what starts writing them, one note at
a time on first edit.

The claim that had to be established is that pointing every reader at
`blocksOf` changed nothing anyone can see. It rests on an inverse
theorem — `fieldsFromBlocks(blocksOf(P))` is exactly `P`'s
`html`/`body`/`strokes` — so derivation is lossless and a reader that
goes through it sees the identical bytes.

**But a theorem is about the function, and the risk is a reader you
forgot to think about.** So `scripts/test-blocks-neutral.mjs` builds the
bundle from *the previous commit*, mounts both in jsdom over identical
seeded data with the clock and `Math.random` frozen, and compares the
rendered HTML byte for byte. The baseline is derived — the parent of
whichever commit added `noteBlocks.js` — rather than a pinned sha, for
the usual reason. It skips without git history and `REQUIRE_BASELINE=1`
in CI turns that skip into a failure, the same arrangement the migration
tests use; CI checks out with `fetch-depth: 0` so it really runs.

**Step 4b dropped the legacy fields, and the keys are EMPTIED rather
than omitted.** For one release a converted note stored its content
twice — `blocks` plus `html`/`body`/`strokes` — so an older build on
another device could still read it. Measured on a 200-stroke stylus
page that was **250 KB against 125 KB**, exactly the 2× predicted, and
it landed hardest on the notes that were already the storage problem.

The subtlety is in how you stop. `patchItem` spreads the patch over the
existing item, so a key left OUT of the patch keeps its old value —
omitting the legacy fields would have left every already-converted note
carrying both copies forever, which is the cost the change exists to
remove, silently not removed. They are written as `""` and `[]`.

Conversion happens on the first **save**, not on load, and the same
write that adds the blocks empties the legacy fields — so the content is
in exactly one place afterwards. A test asserts the round trip loses
nothing (`fieldsFromBlocks(saved.blocks)` is what the note had).

A second comparison renders **the same note in both shapes** through the
current bundle — legacy fields against `blocks` with the legacy fields
emptied. That one does not expire when the editor lands, and it is the
claim step 4 rests on.

**Three things that only came out of trying to make the test fail:**

- **A stub that swallows the calls makes a test blind.** The canvas
  context was a no-op proxy, so a canvas with six strokes and a canvas
  with none produced identical HTML — and reverting the note viewer to
  `page.strokes`, the exact "reader left behind" the file exists to
  catch, passed. Handwriting is half of what step 3 touched, so half the
  test was decorative. The context now *records* every call, and the log
  is part of the snapshot; it resets on `clearRect`, which both redraw
  paths start with, so the comparison sees the last complete picture and
  is insensitive to how many times it was drawn. **The general form: a
  fake that returns nothing makes everything downstream of it agree.**
- **Reference identity was part of `inkOf`'s contract** (gone with the
  feature, kept as the general form): an accessor feeding a
  `useEffect(..., [value])` that builds a fresh value on every render
  re-fires the effect on every render, invisibly to any DOM diff — one
  unit test is the only kind of thing that can assert it.
- **Block order is not observable today.** Reversing `blocksOf` to emit
  text-first always leaves every screen byte-identical, because readers
  concatenate by type. It becomes observable in step 4. Recorded in the
  test's header as a named hole, because a guard that says what it
  cannot see is worth more than one that looks thorough.

## Light and dark: an axis, and the paper that does not flip

`src/input.css` (the ground tokens), `themeVarsFor` in PlannerApp.jsx
(the derived dark accents), the pre-paint script in `index.html`, and
`scripts/test-dark-mode.mjs`.

**The mode is an AXIS crossed with the palette, not a ninth theme.**
The old theme mechanism set four accent variables and nothing else —
every ground colour was a hardcoded Tailwind class, 557 of them. The
sweep happened at the THEME LAYER: Tailwind's `stone` ramp now resolves
to `--tone-*` variables, so `text-stone-500` still means "muted text"
in the source and only the value behind it moves. The one source
substitution was `bg-white` → `bg-surface` (surfaces flip) with
`bg-paper` for note paper (which does not). The differential in
`test-dark-mode.mjs` proves light mode is BYTE-IDENTICAL to the
pre-token build, with the permitted substitutions enumerated in the
test rather than waved at — that enumeration is what turned a 557-class
sweep into a checked refactor.

**The byte-identical differential has since RETIRED**, and the reason
belongs with the rule rather than with the test: it compared against a
MOVING baseline (origin/main), so the first intended UI change on top
of it — the `?` help control — broke it, and the only ways to keep it
green were to enumerate a new control as a "substitution" (which it is
not; that list is for the same pixels through a variable) or to pin a
sha. **A guard that has to be suppressed to let intended changes
through is not a guard**, so it was deleted rather than weakened,
exactly as `test-blocks-neutral`'s git baseline was when step 4 changed
the editor on purpose. What it proved is recorded in the file: on 20
August 2026 light mode was byte-for-byte identical to the pre-token
build under two enumerated substitutions. Everything else in that
suite compares the current build with itself and does not expire.

**Dark accents are DERIVED from each palette, never hand-picked**: the
accent lifts toward white, `soft` becomes a low-alpha wash, `deepText`
lightens further. Eight palettes × two modes hand-written would be 64
values to keep in step. Plain rgb()/rgba(), because iOS 15 — the
deployment floor — has no `color-mix()`.

**THE PAPER DOES NOT FLIP — and the reason has since changed, which
matters.** The original constraint was handwriting: strokes carried
their own stored colour, so a dark sheet meant rewriting a student's
work or lying about it at render time. **Handwriting was removed on 16
August 2026, so that constraint is gone.** Dark note paper is now a
pure look-and-feel decision, which makes it Grace's — it is on her
agenda below, and until she rules, the paper stays light and the test
pins `--paper` equal in both modes so flipping it arrives as a choice
(update the test in the same commit), never as an accident.

**The mode is device-local and unsynced** (`uni-planner-mode`), like
the last tab and the audio input: a phone in bed and a laptop in a
library want different answers. "System" is the default, stored as an
absence, and stays live via `prefers-color-scheme`.

**First paint is handled by an inline script in `index.html`**, before
the stylesheet, because React effects run after paint and the service
worker makes the flash worse (a cached shell paints immediately). It
reads the SAME key the app writes; the equality is a test, since an
inline script cannot import from the bundle — the billing-hint
arrangement again. `index.html` now carries TWO marked blocks: the
sw-register block (stripped by prepare-native) and the prepaint block
(kept by every shell). They are independent by construction, and a
test runs the real prepare-native and asserts the worker goes while
the pre-paint survives — dark mode must not be a casualty of
packaging, or vice versa.

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

### Without an account, nothing leaves the device — and that is now evidence

The privacy policy says *"Nothing reaches us. Everything you type is
stored in your own browser or device and never leaves it."* Apple's
questionnaire asks the same question. It is now answerable from a test
rather than from design intent.

`scripts/test-local-only.mjs` mounts the real app in **both** states
above, with `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` and
`EventSource` all replaced by spies, walks every tab, makes an edit and
waits past the 4-second push debounce — the moment a signed-out planner
would actually go up. Zero outbound calls, and the planner is verified
to be saved locally, because "local only" must not be satisfied by
saving nothing at all.

**Spy on every channel, not just `fetch`.** A spy on one and a leak
through another is how this kind of check ends up decorative.

**The gate belongs at the boundary, not only on the screen.** Every AI
feature is hidden behind `session &&` in the UI, which is right — and
was, until this audit, the *only* thing between a signed-out student's
typing and the wire. `callAiText`, `callAiNotes` and `uploadAudio` now
refuse on their own, reusing the server's own `unauthenticated` code so
the student sees wording that already exists rather than a new sentence
nobody has read. A UI-only gate is one refactor from leaking, and the
refactor need not touch the client at all.

Nothing third-party is in the bundle: no analytics, no error reporting,
no tag manager. The check derives "our hosts" from `config.js` and
`legalLinks.js` rather than restating them, and excuses `w3.org` and
`reactjs.org` **by name with a reason** — they are namespace and
message strings, never fetched.

## A refusal is information. Silence is not.

Migration 0008, and the finding is worth more than the fix.

Supabase's default privileges grant ALL verbs to **both `anon` and
`authenticated`** on every table the SQL editor creates. Our migrations
only ever ran `grant`, which adds and never subtracts, so those
defaults stood. Every policy here is `auth.uid() = user_id`, and
0001's carry no role clause at all — so they apply to `public`, which
includes `anon`.

Follow that through for a request that arrives without a session: it
passes the grant, reaches the policy, evaluates `auth.uid()` to NULL,
matches nothing, and returns **HTTP 200 with an empty array and no
error**. Byte-identical to "you have no data".

That is the same confusion `fetchNote`, `fetchArchive` and
`recoveryFailureKind` are each built to avoid at the client — and it
**cannot be avoided at the client if the server cannot tell the two
apart either.** The archive list shipped saying "Nothing archived yet"
over a real archive for exactly this reason, and no client-side care
would have prevented it; the response carried no evidence to be
careful with.

So `anon` now has nothing on any table holding a student's data, which
turns that silence into a permission error — and every reader already
treats an error as *unknown, keep what we have*. Nothing signed out
legitimately reads any of these tables; `test-local-only.mjs` proves
the signed-out planner makes no outbound calls at all.

The general rule, and it applies well beyond Postgres: **when you
design a boundary, make sure "no" and "nothing" are different
answers.** A layer that answers both with silence pushes an
undecidable question onto every caller.

**And it broke AI notes on the way in, which is the other half of the
lesson.** `migrateNote` upserted (`on_conflict=id`), and **PostgREST
requires INSERT *and UPDATE* for any upsert — either flavour, whether
or not a row conflicts.** Revoking update turned every AI-note write
into a 400, looping once per sync. Nothing was billed (this path calls
no Edge Function and writes no `ai_usage`) and nothing was duplicated
(a rejected insert writes nothing, and the stub is only written on
success, so the note stayed whole in the blob — the ordering rule
holding exactly as designed).

The fix was to stop upserting rather than to restore the privilege:
a plain `insert`, with **23505 read as already-migrated**. That is the
missing-vs-failed split again — a definitive code may be acted on,
silence may not — and it keeps the row immutable with no fourth
policy. Worth knowing before reaching for an upsert here again: at the
SQL level `ON CONFLICT DO NOTHING` needs no update privilege at all,
so the requirement is PostgREST's, one layer above anything the
migration tests can reach. That limit is stated in the test rather
than papered over.

**AND THE STORAGE MOVE HAD NEVER RUN, WHICH THE 400s WERE SAYING ALL
ALONG.** `migrateNote` sends `id: page.id`, a page id comes from the
planner's own `uid()` ("msn0duf5-hk684", base36), and `ai_notes.id`
was typed `uuid` — so Postgres rejected EVERY insert with 22P02 and
PostgREST returned 400, once per sync, since 0005 shipped. The table
is empty on every account for that reason alone, independent of any
summary failing.

`aiNotesLogic.js` documents this exact trap for
`ai_notes_requests.idempotency_key` — which is why
`newIdempotencyKey()` exists, and its comment says why: ids in the
blob may be any shape, ids crossing into a typed column may not. The
page id crossed the same boundary one table over and kept the blob's
format. **A rule written down next to one caller is not a guard.**
0009 moves the column to `text` rather than the client to UUIDs,
because real devices already hold base36 page ids and those ids are
the join between stub and row — minting UUIDs for new notes would
strand every existing one. The guard now generates ids with the app's
own `uid()`, lifted out of the source, so a change of format follows
rather than pins.

**THE ORDERING RULE THIS ESTABLISHES, because it is the mirror of the
one already written down:** migrations that WIDEN what the code may do
(a new table, a new column) go *before* the code that needs them — 0003
and 0004 taught that. Migrations that NARROW it go *after* the code
that stopped needing it. 0008 narrowed, and was applied while a client
that still needed the privilege was live. Same discipline, opposite
direction, and the direction is decided by which side would break if
the two arrived out of order.

**What would have caught it, and why my own check didn't.** The audit
shipped with a test named "the app's own queries still work" that ran
four live queries — and I enumerated them BY HAND from reading the
client. That is a restatement of the client, and it drifted at exactly
the point that mattered: I wrote `planner_data`'s upsert into it
because I had just read `sync.js`, and left `ai_notes` out entirely.
A hand-written list of "what the app does" is not evidence about what
the app does. The guard now DERIVES it: every `.from(X)…upsert(` in
`src/` must have UPDATE granted on X, and a merge upsert must also
have an UPDATE policy. Run against the post-0008 database it goes red
naming the table and the reason — checked by running it before the
client was fixed. Tenth instance of the restatement rule, and the
first one where I wrote the restatement *into the test that was
checking my own change*.

`authenticated` was tightened the same way, to exactly the verbs each
table has a policy for. A granted verb with no policy is never useful
— RLS gives it zero rows — and it is how `update` sat open on
`ai_notes` from 0005 until it was checked by hand. Both properties are
tests that **derive from the catalogue on both sides**: the grants and
the policies are read from the database and compared, so the day
someone adds a table with the platform's defaults still on it, it goes
red. A typed list of tables and verbs would have gone on passing.

## The re-summarise retry, and why it is a different threat model

`ai-text` was built to touch no stored user content, which is what let
it skip the "exists but isn't yours" question entirely. The retry
cannot: it reads `ai_notes_requests` BY ID, and that row holds a whole
lecture. So it carries every obligation that comes with reading one,
and each is a rule already paid for elsewhere — scoped by hand on the
service-role client, byte-identical rejection for malformed and
not-yours (told apart in the logs, never in the response), the
allowance read before the provider call, and a failed call billing
nothing.

**It exists because the failure path finally ran.** Transcription
succeeds and is billed, summarising fails, the audio was deleted at
step 10 — so a student had paid for a lecture they could not get. The
gap was parked on "the success path has never run"; it has now failed
in production and cost a real one.

**What it charges is derived, not chosen.** The transcription minutes
were really spent and are not repeated, so the retry charges one
summariser request: `RESUMMARISE_BILLED_MINUTES` is
`ceil(USD_PER_SUMMARY_REQUEST / USD_PER_TRANSCRIBED_MINUTE)` from the
measured constants, which is 2 against a fresh recording's floor of 3.
The copy states both halves — what it charges and what it does not —
because this lecture has been paid for once already, and the client
mirrors the figure with an equality test, since a screen promising one
number while the server charges another is the drift that pattern
exists to stop.

**Three outcomes, kept distinct, as everywhere else.** A summariser
that fails bills nothing and says the transcript is still there; a row
whose transcript the sweep has taken is `transcript_expired` — a
definitive answer, not a guess — and also bills nothing. The retry is
offered ON the failure screen, because a student sitting on a failed
summary should not have to go looking for the remedy.

## One currency: a credit is a minute of recorded lecture

`supabase/functions/_shared/credits.ts`, migrations 0012 and 0013,
`src/aiTextLimits.js`.

There used to be two — minutes for audio, weighted units for text — and
the split is what hid the photographed-reading mispricing for months.
A photo batch was billed in the currency the expensive thing it
resembled did not use, so **there was nowhere for the comparison to
happen**: "3 units" and "50 minutes" cannot be put beside each other by
any screen or any test. One currency makes the comparison unavoidable
rather than impossible.

**A LECTURE MINUTE IS THE UNIT because it is the only quantity in this
app a student already has an intuition for.** "This reading costs about
as much as a 25-minute lecture" is a sentence somebody can act on. That
is also why the old rule survives in an altered form: `aiTextCopy.js`
existed to keep the word "units" off every screen, and the test still
forbids it — but credits ARE sayable, so help may quote them. What is
banned is the internal weight that meant nothing.

**EVERY WEIGHT IS DERIVED FROM A PRICE.** `TASK_CREDITS` is computed
from each task's own input and output ceilings at the published rates,
divided by what a credit costs, so a raised `MAX_TOKENS` re-prices its
task instead of leaving a number nobody re-derived. That is the exact
failure `TYPICAL_SUMMARY_OUTPUT_TOKENS` produced at 5.9x reality while
setting the price of the product. Two tests hold it: one asserts no
literal weight exists in the config, the other re-runs `usdForTask` and
compares. Only `merge` moved, 1 -> 2, because output is four times the
price of input and its output ceiling equals `summarise`'s — the old
reasoning about its smaller input was true and stopped deciding
anything.

**`round`, not `ceil`, with a floor of 1.** Every text action lands
near a boundary, so ceiling would charge 2 for something costing 1.04 —
a 92% surcharge for a rounding hair. The floor is what stops any action
being free, because a free provider call is one a loop can make.

**THE ALLOWANCE IS UNCHANGED BY THE COLLAPSE, deliberately.** 450 is
300 audio minutes plus 150 text units, and a text unit was already
worth about a credit. This pass changed the CURRENCY, not the
entitlement; the per-tier table is its own piece of work, because an
entitlement change hidden inside a currency change is one nobody can
review.

**THE PHOTO BATCH PRICE IS HELD, and the hold is tested.** Derived
honestly it is ~34 credits on the model we call and ~6 on the one
recommended; setting either before the model decision lands is a
visible lie or an invisible subsidy. `PHOTO_BATCH_CREDITS` sits beside
the reasoning in three places (server config, client mirror,
`estimatePhotos`), and a test goes red if it moves — so lifting it
sends whoever did it to COST-MODEL.md 12.7's two gates.

**Two model strings, not one.** `_shared/model.ts` holds
`SUMMARY_MODEL` and `VISION_MODEL`, both `gpt-4o-mini` today, chosen
per MEDIUM at the adapter (`hasImages`). One string would drag text and
lectures wherever the photo path goes, which section 12.5 prices at
6.6x and 6.3x worse. Twelfth restatement-ledger entry closed.

**0012 WIDENS, 0013 NARROWS, and the order is apply-deploy-verify-
apply.** 0012 adds `credits_used`, backfills it as the sum of the two
old counters, and adds `add_ai_credits`; the old columns and
`add_ai_usage` stay so a function deployed either side of it works.
0013 drops them and must not be applied until the deploy has landed —
0008's lesson, in the direction that bites. **0012's backfill is
guarded on the old columns still existing**, because 0013 removes what
it reads and "re-runnable exactly once" is not re-runnable; a test
applies the whole folder twice to prove it.

## Three product plans, and the correction inside each

`PRODUCT-PLANS.md`. Plans, not builds. Sequencing: reading depth and
output language before the AAB; file upload during the closed test.

**Reading depth: the ceiling is the suspect and the PROMPT is the
cause.** `ai-text`'s summarise prompt is a schema and one sentence —
exactly the state `ai-notes` was in when its output read "helpful but
shallower than I'd like". That was fixed by telling the model what
belongs IN each section, measured at **+189% words per key point with
the entry count barely moving and the ceiling untouched**. Raising
`MAX_TOKENS` without fixing the prompt buys permission to be verbose,
and we pay for the tokens. Do the prompt first, measure, and raise the
ceiling only if the output is really hitting it. 2,000 -> 4,000 takes a
16-page reading from 14 to 24 credits — nothing on a 900-credit month,
**40% of the 60-credit trial**, which is the number that decides it.

Two things that are easy to get wrong there: a chunk does not know it is
one of four, so depth scaling is per CHUNK and the MERGE is what must
not flatten four deep summaries into one thin one — its prompt has no
depth instruction at all today. And subheadings are a RENDERING
decision, not a schema one: `keyPoints` is already the bullets, and a
sixth field touches every screen and every saved note.

**Output language: the cost moves the wrong way from what you'd
expect.** CJK output is ~1 token per character against English's ~4.2
chars/token, so at a fixed token ceiling CJK gets ~72% as much TEXT for
the same price — the cost does not rise, the output shrinks. Credits are
derived from the ceiling, so a Chinese summary costs exactly what an
English one costs, which is the right answer and comes free from
ceiling-derived weights. The interaction worth knowing: CJK plus the
depth work is the case most likely to hit the ceiling, and hitting it
is a hard failure that is still billed.

Explain-it-back is the exception: it must answer in the language the
STUDENT wrote in, ignoring the setting, because marking someone's
Spanish explanation in Korean is worse than useless. A prompt clause,
not a setting.

**File upload: 41x on input tokens, ~10x in CREDITS, and the difference
matters.** Extracted text is 905 tokens a page against 36,835 as an
image — but a whole reading is 138 credits photographed and 14
extracted, because the OUTPUT ceiling is identical either way and output
is four times the price of input. **Assuming input dominates is the same
error that made the photo model look 5x better than it is.** Ten times
is still the largest saving available anywhere in this app, and it
routes students off the most expensive path for the most common case.

Client-side extraction is not a performance choice: `ai-text` has no
storage client at all and a test pins that, because the day someone adds
one the privacy policy and the consent both become false. The fallback
threshold is per PAGE (~100 chars), never per document, and it is never
automatic — falling from extraction to the vision path without saying so
spends 40x what the student expected.

## The tiers, and why the trial is a SHAPE rather than a number

`supabase/functions/_shared/credits.ts` holds the table, migration 0014
holds the counter it needs, `_shared/allowance.ts` holds the branch.

| Tier | Allowance |
|---|---|
| Free | 60 credits, **once ever** |
| Plus | 60 credits, the same trial — Plus buys sync, not AI |
| Study AI | 900 credits a month |
| Study AI Max | 3,000 credits a month |

**A PER-MONTH FREE ALLOWANCE IS THE ONE COST LINE THAT GROWS WITHOUT
BOUND AS SIGNUPS DO.** Ten thousand signed-up-and-forgot accounts is ten
thousand allowances every month, forever, for people not using the app.
A lifetime trial costs those same accounts exactly once. That is the
whole reason `perMonth` exists beside the number instead of a fourth
row in a table of monthly figures.

**The counter is a column on `profiles`, not a row in `ai_usage`.**
`ai_usage` is keyed `(user_id, month)` and a lifetime allowance has no
month; a sentinel month would be invisible to every query filtering on
the current one, which reports the trial as unspent forever — the
friendly-looking direction and the wrong one. `profiles` is already
read at the tier lookup, so a trial tier costs no extra query: its
counter rides along on the row that was fetched anyway.

**THE BRANCH LIVES IN ONE PLACE** (`_shared/allowance.ts`). Two copies
of "which counter does this tier use" is two chances to write a trial
spend into `ai_usage`, which leaves `trial_credits_used` at zero so the
once-ever allowance quietly refills on the first of every month and
nothing anywhere looks wrong. A test asserts a trial tier calls
`add_trial_credits` and never `add_ai_credits`.

**An unknown tier gets the TRIAL.** A typo in the dashboard costs sixty
credits; defaulting the other way costs three thousand a month per
mistyped account.

**RECORDING IS NO LONGER GATED ON A PAID TIER, and that is the diff to
look at twice.** It used to refuse anything but `ai`. Every tier now has
an allowance and the ALLOWANCE is the gate, because a trial that cannot
produce one set of lecture notes cannot sell lecture notes. What still
refuses is an account with no `profiles` row — an anomaly, not a tier.

**NO ROLLOVER, and it is true by construction rather than by a rule.**
A new month has no `ai_usage` row, the limit is re-read from the tier
per request, and unused credits are stored nowhere, so there is nothing
to carry. The way that stops being true is somebody adding "carry over
what you didn't use", which is about three lines and would convert a
semester's prepayment into a single month's spending power against
revenue already collected and inside the store's refund window. A test
asserts a fresh month starts at nothing.

**THE HOLE, ACCEPTED DELIBERATELY: `delete_my_account_data()` empties
`profiles`, so delete-and-resignup resets the trial.** There is no clean
fix that keeps both promises — retaining a per-email counter after a
deletion request is retaining personal data after a deletion request.
It costs ~4 cents an abuse and needs a fresh confirmed email each time.
A test asserts the deletion, so nobody later "fixes" it by keeping
something behind.

**The allowance line says "this month" only when it is true.** A trial
tier's badge drops those two words and adds one sentence saying the
credits do not reset — because letting a student infer that from an
absence is how somebody waits until November for a reset that is not
coming. A test forbids "a month" in any free-trial cost line.

## What the AI features cost, and the two numbers that were wrong

`COST-MODEL.md` is the document; `scripts/measure-cost-model.mjs` prints
every figure in it from the real prompt strings and a real tokenizer, so
a prompt change can be re-costed rather than re-argued. It needs
`npm i --no-save gpt-tokenizer` and is deliberately outside `npm test`.

Three things worth carrying without opening it:

**A photographed reading is the most expensive action in the app, and
the code believes the opposite.** `ai-text/config.ts` justifies pricing a
batch of four photos the same as a 20,000-character text chunk by
quoting gpt-4o's image tokenisation — 85 base + 170 a tile. We call
**gpt-4o-mini**, which bills images at **2,833 + 5,667** because its text
tokens are so cheap that OpenAI charges images at a token multiple; an
image on the mini model costs about twice what it costs on gpt-4o. So a
batch costs ~12x a text chunk, not slightly less, and a 16-page reading
costs **2.2x an entire hour of recorded, transcribed, summarised and
translated lecture** while billing 8.7% of a month's text units.
**CONFIRMED from OpenAI's vision guide, 20 August 2026** — it was
written as the one figure the build container could not reach.

**Sending smaller photos is not a lever, and that is settled.** The
tiler scales the *shortest* side to 768px in BOTH directions, so a
portrait page is 6 tiles whatever it was downscaled to. `maxEdge`
changes the picture quality and not the bill.

**THE LEVER IS THE MODEL, and it plausibly inverts the finding.** The
newer mini and nano models do not tile: they cover the image in 32x32
patches, cap it at a patch budget (1,536 on the mini tier) and apply a
per-model multiplier. Our page comes out around **2,385 tokens instead
of 36,835 — fifteen times fewer** — so even at three times the
per-token price photos land ~5x cheaper than today, which would make
them cheaper than lectures rather than 2.2x dearer. **Do not re-weight
the photo batch against the current model:** re-weighting to 12 and
then moving would tell students a batch costs 12 when it costs 1, which
is a worse error than the one being fixed because it is visible and it
is ours. Model and weight are ONE decision.

**The re-summarise retry had no failure precondition — FIXED.** Step 4b
checked that the row exists, is yours, and holds a transcript, never
that the summary failed, so a successful three-hour lecture could be
re-summarised for the whole retention window at a flat 2 billed minutes
against a real $0.0072 — $0.0036 a billed minute where every real
recording costs $0.0007, and $10 of provider spend from one recording
at a 3,000-minute cap. **The fix was the precondition, not the price:**
`RESUMMARISE_BILLED_MINUTES` is derived correctly, but for a *typical
short* summary, and a three-hour transcript is 21x that input.

It requires `summary_failed = true`, checked BEFORE the transcript —
a successful note has nothing to retry whether or not the sweep has
since taken its transcript, and answering "expired" there is a true
sentence about the wrong question. It returns its own code
(`already_summarised`), which does not breach the identical-rejection
rule: that rule is about not-found versus not-yours, and this branch is
only reachable once ownership is proven. The bonus falls out free —
the success path writes `summary_failed = false`, so it is **one retry
per failure** rather than an open door.

**THE ALLOWANCE INCREMENT IS ATOMIC — migration 0011.** Both functions
did `select minutes_used` then `upsert { minutes_used: read + cost }`,
so two overlapping requests both read N and both wrote N + cost and one
of them was free. `add_ai_usage` does the `+` under the row lock that
`ON CONFLICT DO UPDATE` takes, and returns the post-increment totals so
the fraction a student is shown is the database's rather than one
computed here from a stale read.

**What deliberately did NOT move is the READ.** It still precedes the
provider call, which is what makes a missing column (0006) and an
exhausted allowance both fail having spent nothing. Folding the check
into the increment — "add it and tell me if I went over" — would move
the refusal to after the money was spent. So the bounded race remains
and is named: two requests can both pass the check at N and both be
billed, exceeding the cap by one request's cost. Same class as the
estimated-duration overshoot, which is also left alone. What is fixed
is the strictly worse bug, where the second request was never billed.

The test worth knowing by name is **"THE LOST UPDATE, demonstrated"**:
it runs the OLD read-modify-write in two concurrent psql sessions and
asserts the total is 3 rather than 6. Without it, "two concurrent calls
add up" could pass because the two calls never overlapped — a green
test proving nothing, which is how every concurrency test fails.

**THE PHOTO MODEL IS PRICED (section 12), and the recommendation is
conditional.** Move the photo path — and only the photo path — to
`gpt-5.4-nano` at `detail: "original"` and `maxEdge` 1024, weight a
batch at 6 credits, and keep text and lectures on `gpt-4o-mini`.

Three things in that sentence are load-bearing:

- **The output price, not the image price, is what decides it.**
  `gpt-5.4-mini` is only 1.4-1.8x better overall because its output is
  $4.50/1M against $0.60 — on a 2,000-token ceiling the summary costs
  more than the four photographed pages it is about. The 5x prize is
  on nano.
- **`maxEdge` is a lever again.** Under tiling the shortest side is
  normalised to 768 in both directions, so it does nothing. Under
  patches the budget is a CAP, not a target, so cost falls linearly
  with what we send: 1536 -> 1024 halves the image tokens. Free to
  change, worth nothing on the model we run today, which is why it
  belongs in the same decision.
- **Per MEDIUM, not per task.** Photos and pasted text are the same
  `summarise` task, and moving the task would make a text chunk 6.6x
  worse and a lecture 6.3x worse on mini. So there are two model
  strings, which raises rather than lowers the priority of the
  `_shared/` move: `SUMMARY_MODEL` and `VISION_MODEL`.

**Priced honestly on the model we run TODAY, the feature is unusable:**
four photographed pages cost eleven text chunks, so a 16-page reading
is ~133 credits of a 150-unit month. Weight 3 is not a mispricing to
correct — the model move is what makes the feature exist at a price
anyone can say out loud. **Do not re-weight against a model we are
about to leave.**

**And it waits on one measurement**, because two published rates and
one behaviour are third-hand: there is an unresolved report of a
1920x1080 PNG billing ~66,000 prompt tokens on `gpt-5.4-mini` where the
documented arithmetic says ~2,400, and we send exactly that shape — a
base64 data URL from a canvas. Section 12.7 has the three-call test and
what each outcome means. That is *verify the evidence before endorsing
the remedy*, pointed at a remedy of my own.

**And the brief that commissioned it had three things wrong**, which is
the part to carry. It authorised switching Groq to Turbo (already
Turbo) and raising `MONTHLY_MINUTES_LIMIT` from 30 to 200 (it is
**300**, so that would have cut the closed test's allowance by a
third) — neither change was made. And it stated that `gpt-4o-mini`
carries a published sunset; it does not appear on OpenAI's
deprecations page at all, upcoming or past, and the tracker the brief
came from had conflated it with the audio and realtime variants.

All three came from remembered or third-hand figures. Enter a constant
against the code, and a provider's rate against the provider.

**THE DEPRECATION TRAP TO REMEMBER, since it is the one that is real:
`gpt-4.1-nano` and `o4-mini` shut down 23 October 2026.** They are the
two names that come up first when someone goes looking for something
smaller and cheaper than what we run, and both have a date on them.

## Rotating a credential means auditing where it is configured

Grace had a screenshotted OpenAI key revoked — correctly. What nobody
checked was **where else that key was configured**, and the Edge
Function's `OPENAI_API_KEY` secret was one of those places. The
signature is worth memorising because it reads like a code bug:
transcription succeeded and was billed, summarising failed and was
not. Two stages, two providers, two secrets — `GROQ_API_KEY` for the
transcript, `OPENAI_API_KEY` for the summary — so a dead OpenAI key
looks exactly like "the summariser is broken".

**Function secrets are configured outside the repository and no test
can see them.** Nothing in `npm test`, CI, or a deploy will tell you a
secret is dead; the only evidence is the function's own logs. So the
rule is procedural rather than technical: before revoking any
credential, enumerate every place it is configured — Supabase function
secrets, the deploy workflow, any local `.env`, any dashboard — and
rotate rather than revoke where something depends on it.

The places a secret lives, as of now: Supabase → Edge Functions →
Secrets holds `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPGRAM_API_KEY`,
`AI_NOTES_SWEEP_SECRET` and the service role key. None of them appear
in this repository, which is why the list has to be written down.

## A client-minted id crossing into a typed column

`ai_notes.id` was `uuid`; page ids come from the planner's own `uid()`
("msn0duf5-hk684"). Every insert was rejected with 22P02, PostgREST
returned 400, and the client retried on the next sync — so **the AI
notes storage move never ran in production at all, on any account,
from 0005 until 0009 moved the column to `text`.**

The general shape: a value minted in the browser and kept in the blob
may be any format; the same value crossing into a typed column may
not. Neither side can see the boundary — the client sees a string it
made up, the column sees a string that arrives.

`aiNotesLogic.js` had already learned this for
`ai_notes_requests.idempotency_key`, which is why `newIdempotencyKey()`
exists, and its comment says exactly why. That rule sat next to one
caller and did not generalise. **A rule written beside one caller is
not a guard.**

The guard now enumerates every id column from the database and
requires each to be either mapped to a named client generator — whose
REAL output is then inserted into the REAL column — or excused with a
written reason. A new id column fails until somebody decides which it
is.

**And the same rule seen from the side where it WORKED, which is the
half worth keeping.** `ai_notes_requests.idempotency_key` is also
`uuid`, also client-minted, and never broke — for two independent
reasons: `newIdempotencyKey()` produces a real UUID, and the Edge
Function validates the shape and rejects a bad one as a malformed
request before it ever reaches Postgres. What saved it was a NAMED
GENERATOR and a check, not the comment explaining why they exist —
and that comment sat a few lines from the code that ignored it. A
rule becomes a guard when something executes it.

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
`demoBackend` and everything works locally. A null-dereference has
shipped in it before, precisely because it's the path nobody runs while
developing. `scripts/test-app-smoke.mjs` mounts the real app with
`isConfigured === false` and fails on any `console.error`; keep it
passing.

**This section used to say "a brand-new user is in this mode." That was
wrong, and the error is worth keeping because it is the kind that hides
a whole category of bug.** `config.js` has had real project details
since long before launch, so `isConfigured` is `true` in every shipped
build. A brand-new user is not in demo mode; they are **signed out on
the real backend**, with `backend === supabaseBackend` and
`backend.isDemo === false`.

| | `isConfigured` | `isDemo` | who is really here |
|---|---|---|---|
| demo mode | false | true | the smoke test, and a developer with an unfilled `config.js` |
| **signed out** | true | **false** | **every user before they make an account** |

The consequence is that `isDemo` is the wrong thing to check for
anything about *a user without an account*, and a test that exercises
only demo mode is testing the state nobody is in. That was demonstrated
rather than argued: defaulting the session away in `runSync` — the shape
a careless refactor takes — pushes the whole planner to the server for a
signed-out user, and **the demo-mode walk stays green throughout**.
`scripts/test-local-only.mjs` walks both, and scenario B is the one that
matters.

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

**The fifth one got to real hardware, and the reason is worth more than
the bug.** `folders` was threaded from `PlannerApp` → `AiNotesPanel` →
`Recorder` for the auto-folder feature, and the component in the middle
that merely *relays* it was skipped. `RecoveryGate` rendered
`<Recorder folders={folders}>` with nothing in scope defining it, so the
whole AI Notes panel threw `ReferenceError` on every render.

It was not conditional on platform. It crashed for **every signed-in
user everywhere** — it reached a phone first only because that was the
next signed-in session anyone opened. What made it invisible is that
`AiNotesPanel` returns early with "needs a real signed-in account" when
`backend.isDemo`, and demo mode is the only mode the walk runs in. So
the panel had never been rendered by anything automated at all.

**A demo-mode walk cannot cover a screen that refuses to render without
an account.** Those screens are mounted directly instead, with a fake
session — `AiNotesPanel`, `AudioSourcePicker` and `SummariseReading` all
have probes at the end of `test-app-smoke.mjs` for exactly this reason.
Adding a signed-in-only screen means adding a probe; there is no third
option that isn't "nothing renders it".

The relay case is the one to watch for: a prop a component does not use
and only passes on is the one nobody notices is missing, because the
component that needs it has a default (`folders = []`) that never gets
the chance to apply.

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

### The native build, and the two mechanisms that keep a worker out of it

`npm run build` was **broken on `main` for a fortnight** and nothing said
so. `prepare-native.mjs` stripped the registration script with a regex
that restated the shape of the script it was removing; the service-worker
work rewrote that script, the regex matched nothing, and the check below
it threw. All three desktop platforms exited 1 in ~36 seconds, before
electron-builder was reached.

It survived because **`npm test` builds only the web bundle** and
`build-apps.yml` is `workflow_dispatch`, so nothing ever ran
`prepare:native`. The sixth instance of the restatement pattern, in a new
flavour: a regex restating the *shape of code* rather than a value.

The strip now works from **markers** — `<!-- sw-register:start -->` and
`<!-- sw-register:end -->` in `index.html` — which is a contract the file
can keep while its contents change freely. And a test in
`scripts/test-service-worker.mjs` runs the real `prepare-native` and
checks both shells come out with no `serviceWorker` and no `sw.js`,
**and** still have a body and still load `app.js`, so "stripped the whole
page" cannot pass. That test runs in `npm test`, which CI runs on every
push and pull request.

**The two halves of the strip are not equally load-bearing**, and this is
recorded so nobody deletes the wrong one. Registration is gated on
`https:` with a non-localhost host, which already excludes all three
shells — so removing the *script* is belt-and-braces. Removing `sw.js`
from the bundle is not: it means there is nothing to register even if
that gate is relaxed later, and Android is the live case, since
`http://localhost` is a secure context and is excluded only by the
protocol check.

## The mobile shells, and what has to be decided before the first submission

**`mobile/ios` and `mobile/android` do not exist in the repository.** They
are generated per machine by `cap add` and git-ignored, which is why
every setting that lives inside them is applied by a script instead:
`mobile/scripts/native-permissions.mjs` for the microphone declarations,
`scripts/stamp-native.mjs` for the display name, the minimum OS versions
and the two version numbers. Both re-run after every `cap add` and
`cap sync`. Nothing is lost by deleting those folders and regenerating.

That is also why the bundle identifier rename was two text files. It is
`com.uniplannerapp.planner` — derived from the domain, and **permanent
once published**, since changing it later means a new store listing
rather than an update. A test derives it from `SITE_URL` rather than
restating it.

**Two version numbers, and only one of them matters to a store.** The
marketing version (`1.0.0`, from the root `package.json`) is cosmetic.
Android's `versionCode` and iOS's `CFBundleVersion` are enforced: they
must strictly increase on every upload, and a store rejects a build that
reuses one — after the upload, when you are already trying to ship a fix.
So the build number is **derived, not remembered**: minutes since
2020-01-01 UTC. It is monotonic by construction, needs no stored state,
is independent of the marketing version (so a rejected build can be
re-uploaded without inventing a new version), gives the same commit a
higher number tomorrow, and has ~4,000 years of headroom before Android's
signed 32-bit `versionCode` overflows.

**API 36 is a SATISFIED requirement, not a live deadline.** Google
Play requires new apps to target API 36 from 31 August 2026;
`stamp-native.mjs` verifies the *generated* `variables.gradle` (the
template is not the thing that ships) and it **passed on Jared's real
build, 16 August 2026**. The date only matters again if the target
regresses, and the check catches that. Do not re-panic about it: the
clock that actually binds is the closed test below — 12 testers, 14
continuous days, then up to a week for production access — which
starts the day the first AAB is uploaded and cannot be compressed.
Our minimum is 26 (Capacitor defaults to 24); iOS deploys at 15
(default 14).

**The longest lead item is the Play account, and it is RECRUITMENT, not
code.** Personal developer accounts have needed a closed test before
production access is granted, and the shape of it is what makes it work
rather than a checkbox:

- **12 real Google accounts on real devices**, not 12 email addresses.
- **Opted in continuously for 14 days.** The clock is a streak, not a
  total: if the count drops below 12 at any point it resets, so recruit
  more than 12 and expect attrition.
- It can start the moment a debug APK exists, which is why the Android
  compile is worth doing before the iOS one.

Treat finding those people as a task with a two-week floor on it, owned
by someone, running in parallel with everything else. It is the item that
decides when Android can ship. Confirm the current rule in the Play
Console — it changes.

**Email delivery was the other prerequisite, and it is DONE** (Resend,
verified against real inboxes on 20 August 2026 — see the email section
below). A closed tester who cannot confirm their account wastes the
fortnight they are spending on you, so this had to land before
recruitment, not before launch.

`MOBILE-BUILD.md` has the two first-time compile guides and the
hardware verification list. The item that decides whether offline notes
work at all is the aeroplane-mode test: open a note online, kill the
connection, force-quit, reopen it.

## Build scripts

`scripts/build-web.mjs` and `prepare-native.mjs` run on Windows, macOS and
CI, which rules out things that look fine locally:

- **Spawn `process.execPath`, never `npx`, never `node_modules/.bin/*`.**
  On Windows the `.bin` shim is a `.cmd` and modern Node refuses to
  execute it (`EINVAL`); `npx` is unreliable on build servers.
- Don't "tidy" the deprecation warnings these scripts emit. That has
  broken the build twice.

### Never tidy a warning. Always READ one.

Those are two different instructions and the second was being skipped
because of the first.

`aiTextClient.js` built its endpoint URL from `import.meta.env` — a Vite
idiom — inside an esbuild IIFE bundle, where `import.meta` resolves to
**empty**. Every call in the four text features went to a relative path
and 404'd. esbuild said so, on every build:

```
▲ [WARNING] "import.meta" is not available with the "iife" output format
  and will be empty [empty-import-meta]
```

It shipped to production. Nobody was using those screens yet, so nothing
surfaced it, and it was found only because a later build was run with the
warning count in view.

The rule the two halves make together: **a warning is not noise to be
silenced, and it is not noise to be ignored either.** Read it, decide
whether it describes a real defect, and then either fix the defect or
leave the warning exactly where it is. What is never right is skipping
the reading step — which is what "don't tidy warnings" quietly licensed.

The tell for this class: a warning that names a *value being empty or
missing* rather than a style preference. `empty-import-meta` is the
build telling you a variable is empty at runtime, which is a bug report,
not a lint.

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
`www.uniplannerapp.com` from the **`release`** branch — the
promote-on-release arrangement below. `main` builds previews only.

| Setting | Value |
|---|---|
| Build command | `npm run build:web` |
| Output directory | `dist-web` |
| Root directory | `/` |
| Production branch | **`release`** |
| Node version | `NODE_VERSION` = `22`, and `.nvmrc` |

`.nvmrc` exists so the Node version is reviewable in the repo rather than
living only in a dashboard — the same reasoning as the generated cache
name. Keep them in step.

### Promote-on-release: the gate between merging and users

The cheap version of a dev/prod split, adapted to this stack: one
Cloudflare Pages setting instead of a duplicated backend. Merging to
`main` no longer touches production at all — production only moves
when `main` is deliberately promoted into `release`.

**The dashboard change is DONE** (Cloudflare → Workers & Pages →
`uniplanner` → Settings → Builds & deployments → Production branch →
`release`, 20 August 2026), and the first promote has run: both
branches sat at `950f068` with production's build id reading
`2bb6d4f442a5`, matching. Recorded because the same clicks are what a
future project would need, and because "the flip happened" is the fact
that makes every sentence below true.

**The merge ritual from then on:**

1. PRs merge to `main` exactly as before. Each merge builds a
   PREVIEW (the `main` branch preview URL), never production.
2. To ship: verify the preview, then promote —

   ```
   git fetch origin && git push origin origin/main:release
   ```

   A fast-forward push of the exact commits that were verified.
   **Never squash-merge main into release** — a squash mints new
   commits, the branches diverge, and every later promote conflicts.
   The ff push keeps `release` a strict prefix of `main` forever.
3. Verify production the usual way (below) — the build id follows
   the same bytes, so the preview's id and production's id match for
   the same commit.

**The build-id check now has TWO targets:**

```
# production — moves only on promote
curl -s https://www.uniplannerapp.com/sw.js | grep 'const CACHE'
# the main preview — moves on every merge to main
curl -s https://main.uniplanner.pages.dev/sw.js | grep 'const CACHE'
```

After a merge to `main`, the *preview* id must match the Account tab
of the preview URL; production is EXPECTED to lag until the promote.
"Production is behind main" is now a state the process produces on
purpose, not a broken deploy — the broken-deploy signal is production
not moving *after a promote*.

**THE LIMITATION, stated plainly: the database is still shared.** A
migration applied so a preview can be exercised applies to the same
Postgres production runs against — there is no second Supabase
project (see the not-built list), so the apply-verify-merge migration
ritual stays EXACTLY as it is, and the widening/narrowing ordering
rules bind the same as before. What the gate protects is the
app-bundle half of a release: a bad client no longer reaches users
just because it merged. It protects nothing about the data layer.

One second-order effect worth knowing: preview deployments run on
`*.uniplanner.pages.dev`, a different origin from production, so a
preview's localStorage is its own — signing into a preview and
syncing writes to the REAL backend (shared database), but its local
planner never mixes with production's.

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

**A deploy ships what it enumerates, and the enumeration is a
restatement.** The function-deploy workflow named `ai-notes` and nothing
else, so every `ai-text` change since Batch 4 reached production only by
hand-deploys no checklist mentioned — found one step before a PR's own
instructions told someone to run a workflow that would not have touched
the server half being shipped. Both functions are now enumerated and a
wiring test pins the list, because a deploy's list of targets drifts
exactly the way any other restatement does: the repo grows a function,
the workflow doesn't, and nothing goes red. The completed rule:
**merging isn't deploying, and deploying isn't deploying *everything* —
verify what the deploy actually names.**

**Merging to `main` does not mean the change is live.** This has already
been wrong for an unknown number of merges: Netlify paused production
deploys when the account ran out of credits, and PR #6 — the fix that
makes deploys reach users at all — sat merged and unshipped. Nothing in
GitHub said so.

So after any deploy that matters, verify rather than assume — and
under promote-on-release the verification has two targets (see the
Promote-on-release section): after a merge to `main`, check the main
PREVIEW's build id; after a promote, check production:

```
curl -s https://www.uniplannerapp.com/sw.js | grep 'const CACHE'
```

That build id must match the one on the Account tab. If it doesn't, the
deploy didn't happen, whatever the merge said. Remember that a docs-only
commit legitimately leaves the build id unchanged — and that production
LAGGING main is now the designed state between promotes, not a failure.

Netlify remains configured and is deliberately not deleted, so there are
two working options rather than zero. It is no longer the origin of
record.

### Pending, in order, once someone is at a desk

**One item is BLOCKING and must happen before the next function
deploy**, then two minor post-launch leftovers.

0. **The currency deploy, in this order and no other.** 0011 has been
   superseded by 0012 but both still apply cleanly, so run them in
   sequence.

   1. **Apply 0011 and 0012.** Both WIDEN — each creates a function
      the new code calls — so they go before the deploy, the 0003/0004
      direction rather than 0008's. If the code ships first, every
      bill fails: `supabaseAdmin.rpc` returns "function does not
      exist", logged loudly at the billing stage without failing the
      request, so the student gets their work and we charge nothing.
      Safe for them, expensive for us, and invisible unless somebody
      reads the logs.
   2. **Deploy both Edge Functions.**
   3. **Verify** a real action bills `credits_used`:
      `select * from ai_usage order by updated_at desc limit 5;`
   4. **Apply 0013**, which NARROWS: it drops `minutes_used`,
      `text_units_used` and `add_ai_usage`. Not before step 3.

   **0014 goes with 0012**, in step 1: it WIDENS too (a column and a
   function the new code calls), and the code that reads
   `profiles.trial_credits_used` ships in the same deploy.

   Privilege check after 0012:
   `select has_function_privilege('service_role',
   'public.add_ai_credits(uuid, text, numeric)', 'execute');` returning
   true, and the same for `authenticated` returning false.
Everything else on this list has been applied and verified; the record
of what each migration did is kept below the line because the ordering
lessons are load-bearing, not because the work is outstanding.

1. **pg_cron and pg_net**, enabled in `Database → Extensions`, plus the
   Vault secrets migration 0004 reads. Until then the retention sweep
   only runs opportunistically and the periods the privacy policy states
   are aspirational rather than enforced. 0004 raises a notice saying so
   rather than failing. The error-report digest email waits on this same
   wiring.
2. **Bump `actions/checkout` and `actions/setup-node` to `@v5`**, in
   every workflow. Both currently target Node 20, which GitHub has
   deprecated; the runners force them onto Node 24 and they work, so this
   is a warning today and not a failure. It becomes a failure on
   **GitHub's timetable, not ours**, and when the fallback is removed
   every workflow in the repo stops at once — tests, the e2e journeys,
   the desktop build and the function deploy together. Scheduled here
   rather than remembered.

**Applied and verified — kept for the lessons, not as work:**

- **0004** (folder-scoped storage delete policy) — merged before it was
  applied, the ordering mistake 0003 had already taught. Migrations are
  applied by hand in the SQL editor; nothing in CI or the deploy applies
  them, so the ordering is a habit, not a mechanism. That habit is the
  reason the widening/narrowing rule is written down at all.
- **0005** (`ai_notes` and its three policies) — and note what it cost:
  the table existed for weeks while EVERY insert was rejected, because
  the id column was `uuid` and page ids are base36. "Applied" was never
  the same as "working", which is what 0009 and its verification exist
  to prove.
- **0007** (`semester_archives`) — applied 16 August 2026, verified by
  hand: three policies, no update, `update_granted = false` on both
  three-verb tables. Its by-hand privilege check is what found the
  default-grant trap.
- **0008** (the grant audit) — applied, verification clean. It also
  broke AI-note writes on the way in (PostgREST needs UPDATE for any
  upsert), which is why the client now plain-inserts and reads 23505 as
  already-migrated.
- **0009** (`ai_notes.id` → `text`) — applied and **VERIFIED 20 August
  2026**: `data_type = text` confirmed, three notes migrated carrying
  base36 ids, and the six-step first-migration check in
  `MOBILE-BUILD.md` passed end to end. This is the one that made the
  storage move actually run for the first time since 0005.
- **0010** (`client_errors`) — applied, `select count(*)` returns 0 as
  expected on a table nothing has written to yet.

**The scheduled sweep authenticates with a dedicated secret, never the
service role key.** pg_net stores each outbound request — headers
included — in `net.http_request_queue` until its TTL expires, so
whatever authenticates that job sits at rest in a database table for
hours at a time. `AI_NOTES_SWEEP_SECRET` only lets its holder trigger a
retention sweep, which the system does hourly anyway; the service role
key there would be a full-database credential in a queue table. Don't
"simplify" it back.

### Password reset: a feature with no ends

Fixed, and the *diagnosis* is the part worth keeping.

Two causes were recorded here from reading the code: `sync.js` created
the client with `detectSessionInUrl: false`, and the Supabase Site URL
pointed at the old host. Both were real. Both were the **third and fourth
links in a chain whose first two did not exist**:

- `supabaseBackend.resetPassword` had been there all along and **nothing
  called it.** There was no "Forgot password?" anywhere in the app, so a
  user could not even request the email.
- There was no `updateUser` call anywhere in `src/`, so even holding a
  valid recovery session there was nothing to set a new password with.

Anyone who had flipped the two recorded causes would have tested it, seen
the app load, and found no way to proceed. **This was never a broken
feature; it was an unbuilt one with a plausible-looking middle.** A
diagnosis assembled from reading code found two faults and missed that
the thing had no ends — trying to use it would have taken a minute.

The four pieces now in place:

1. A "Forgot password?" link on the sign-in form, which says the same
   thing whether or not the address has an account — otherwise the box
   enumerates the user list.
2. `PasswordRecovery`, a blocking overlay shown on Supabase's
   `PASSWORD_RECOVERY` event. Blocking rather than a panel on the Account
   tab, because a recovery session is a strange state to leave someone
   in: signed in, having not signed in, with one thing to do. Burying it
   behind a tab is how someone clicks a reset link, sees their planner,
   changes nothing, and reports that the link is broken.
3. `updatePassword` on **both** backends. `demoBackend` had no
   `resetPassword` either, so the link alone would have thrown on the
   path a brand-new user is most likely to take.
4. `detectSessionInUrl` gated on `location.protocol` being `http:` or
   `https:`. **The original reasoning was correct and is kept** — the app
   is not served from a normal web address in the desktop and phone
   builds, and stripping the hash afterwards uses `history.replaceState`,
   which is not reliable on `file://`. What was wrong was applying that
   to the hosted build, where the reset link *is* such a URL. Same shape
   as the service-worker rule in `index.html`. Capacitor Android
   (`http://localhost`) is now included and it is a harmless no-op, since
   no token ever appears there.

`redirectTo` is passed explicitly, derived from `SITE_URL`, rather than
relying on the project's Site URL setting — that setting was wrong for an
unknown period and nothing in the repo could have said so. **It must also
be on the Redirect URLs allowlist in Supabase Auth settings**, or
Supabase ignores it and silently falls back to the Site URL, which is the
failure that looks like the code is wrong when the configuration is.

**None of this is verified until someone reads a real inbox.** That is
how it stayed broken: it reads plausibly and no test can cover a flow
that requires an email client.

### Signup confirmation is NOT affected, and that is worth knowing

The same Site URL and the same session-detection path are involved, so
the assumption is that it broke too. It didn't. Supabase's confirmation
link points at `/auth/v1/verify`, which confirms the address
**server-side** and only then redirects to the app — so the account is
confirmed before the browser reaches any of our code, whatever
`detectSessionInUrl` is set to.

The only loss was auto-sign-in: the user lands signed out and signs in
with the password they just chose. Clunky, never blocking, and it
improves for free now the protocol gate is in.

### Email delivery — DONE, and verified against real inboxes

**Resend is configured in Supabase Auth → SMTP Settings, verified 20
August 2026**: signup confirmation and password reset both tested with
real inboxes, and Grace re-signed up successfully after her account was
deleted (which exercises the confirm path from scratch, not just the
resend path). It does NOT block the closed test any more.

Why it was a launch requirement, kept because the reasoning outlives
the task: **Supabase's built-in sender is rate-limited to a handful of
messages an hour and lands in spam routinely.** Password reset does not
survive real users on it — a student who cannot sign in and whose reset
email never arrives has no route back into their account and no way to
tell whether the app or their inbox is at fault. The symptom, "the
email never arrived", is indistinguishable from a code bug to everyone
except whoever checks the SMTP configuration, which is exactly why it
could not be left to be noticed later.

`EMAIL-SETUP.md` is the step-by-step, and **the SPF conflict is the part
to read before touching DNS.** The domain already carries an SPF record
for Google Workspace, and a domain may have exactly one: publishing a
second does not add to the first, it invalidates both, and Jared's actual
mail stops. Verifying a *subdomain* at Resend (`send.uniplannerapp.com`)
avoids the conflict entirely and is the route to prefer; if the root is
used instead, the include must be merged into the existing record.

Nothing on the code side needs to change for this. The sending domain and
the redirect allowlist are independent — one decides who mail is from,
the other where a link may land — so `https://www.uniplannerapp.com` must
still be on **Authentication → URL Configuration → Redirect URLs**, for
the same reason as before: the app passes `redirectTo` explicitly, and
Supabase silently falls back to the Site URL if it is not allowlisted.

**It would have blocked the closed test, not just launch** — a tester
who cannot confirm their account wastes the fortnight they are giving
you. That risk is now retired.

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

## Verify the evidence before endorsing the remedy

A finding that arrives with a fix already attached is the easiest kind
to act on and the easiest kind to get wrong. The analysis has been done,
the cause named, the remedy proposed — everything invites you to skip
straight to building it.

Grace's iPad export came with exactly that: two ink bugs, diagnosed,
with fixes proposed. Re-measuring the raw strokes rather than the
summary produced **three corrections**, one of which mattered enormously:

- A page identified as palm contamination — "3 strokes, pressure locked
  at 0.5, the touch signature" — was a **finger drawing**. The touch
  signature was right; the palm inference was not. The geometry says so:
  whole-page sweeps with a median step of 34–50 canvas units, against
  0.9–5.5 for deliberate contact elsewhere in the same file, and **no pen
  strokes anywhere on that page**. The proposed remedy was "reject touch
  once a pen has been seen". It would have deleted the page.
- Twelve zero-pressure points offered as evidence of vanishing writing
  were all inside two **eraser** strokes. The genuine light-touch
  evidence was four points, on a different page.
- The two bugs were **the same three objects**. The palm marks and the
  invisible single-point strokes are one set, which means the
  invisibility is currently *hiding* the palm dots — so fixing the
  visible symptom first would make three stray marks appear in a
  student's note. An ordering constraint that only shows up if you look
  at the strokes themselves.

The root cause neither analysis named came out of the same pass:
`penSeen` is a `useRef`, reset on unmount, so **every editing session
starts unprotected**. That is the recurring-bite mechanism, and no
amount of reasoning about the proposed fix would have found it.

The discipline is the outward-facing form of *check the mutation
actually applied*: **do not accept a result you have not reproduced,
including one that agrees with you.** Examine the individual objects,
not the summary statistics — the summary said "3 strokes at 0.5
pressure" and was true, and the conclusion drawn from it was false.

**And get the DISTRIBUTION before sizing a fix to it.** The faint-writing
bug was diagnosed as light touches failing to register, and the obvious
remedy was a floor on rendered pressure. Measuring first showed that
**989 of 1,579 pen points — 63% — sat below the proposed floor**: it
would have clamped two-thirds of a real page to a single width and
thrown away the thick-and-thin that makes handwriting look handwritten.
The fix became a monotonic remap, which lifts the faint end by ~48% at
the observed mode and keeps every distinction the writer made.

That is the same lesson as the ink measurement gate, in a different
costume: a remedy sized to an anecdote is sized to the wrong thing.
A floor, a cap and a threshold all need the shape of the data, not the
existence of the problem.

## Commit or stash before you mutate a file to check a guard

The mutation rule — break the thing on purpose and watch the test go
red — is the only way to know a guard is real, and it has a sharp edge
that has now cost work: **`git checkout <file>` reverts to the last
COMMIT, not to what was in the working tree a second ago.** Used to undo
a deliberate mutation on a file that also carried an hour of uncommitted
change, it silently throws the change away and restores something that
builds, which is the worst combination — no error, no conflict, and a
file that looks plausible.

That is what happened to `src/aiTextLimits.js` during the currency
collapse: mutated to check the mirror test, reverted with
`git checkout`, and the whole rewrite went with it. Caught by the next
`npm test` build failure, which is luck rather than process — the same
edit in a file the bundler does not touch would have reached a commit.

The rule, and it costs nothing: **before mutating a file, either commit
the real work or copy the file aside**, and revert from the copy. This
codebase already does the copy-aside version for migrations and
configs (`cp x /tmp/... && ... && cp /tmp/... x`); the failure was
reaching for `git checkout` on the one file whose work was not yet
committed. Never revert a mutation with a command that reads from git
unless the file's real state is already IN git.

## Branch from `main`, verified — and a mirror test cannot see a decision

Two failures from one mistake, both worth keeping.

**`git checkout -b` starts from wherever you are standing.** A branch
meant for a documentation change was cut while still on a feature
branch, so the squash merge carried that feature's commit too. A pull
request titled *"documentation only — no code, so the build id does not
move"* shipped a **billing change** — `MINIMUM_BILLED_MINUTES` 3 → 4,
`SUMMARY_MAX_TOKENS` 8,000 → 12,000, and a rewritten summariser prompt —
that had been explicitly parked pending a measurement. It reached
`main`, and the client half of it reached production, because the web
app deploys from `main`.

This is *check the mutation actually applied*, pointed at git. The fix
is the same shape: `git fetch origin main && git checkout -b <name>
origin/main`, and read `git log --oneline -1` before committing rather
than trusting where you think you are. What made it invisible was that
every check passed — the tests were green, the diff of the branch
looked right, and the PR body described the change accurately for the
commit it was *about*.

**A test comparing two copies to each other cannot notice both moving.**
`MINIMUM_BILLED_MINUTES_HINT` mirrors the server constant and a test
asserts they are equal. That test was green throughout, correctly: both
copies moved together. Mirror equality guards *drift*; it cannot guard a
*decision*.

So a guard on a decision has to anchor to the decision's precondition.
Here the precondition is "has anyone measured the number the floor is
derived from", and it is now enforced where it bites:
`deploy-functions.yml` refuses while `config.ts` carries the
`UNMEASURED` marker. Same move as the allowance read preceding the
provider call in `ai-text` — make the bad interleaving unreachable
rather than documented.

The residue worth remembering: for a while the screen said one number
and the server charged another, in the under-charging direction, and
nothing could have told us. The Edge Function is `workflow_dispatch`
only, so what stood between a parked decision and real charges was
nobody clicking a button.

## A guard that restates its subject will drift

Ten separate times now, a check has been weaker than it looked, always
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

- The documents' **"AI works on your own writing" assertion** was typed
  into `test-legal.mjs` as a literal phrase. The policy was wrong — the
  app has always worked on material the student did not write, since a
  lecture recording captures the lecturer — so **correcting it failed
  the test that existed to keep it true.** First instance inside a test
  rather than in code, and the tell is the same: a guard that pins the
  wording cannot survive the wording being wrong.

- **`SUMMARISE_PER_REQUEST`** was typed into the billing test as
  `0.0018`. It is the number that decides `MINIMUM_BILLED_MINUTES`, and
  it could not move — so raising `SUMMARY_MAX_TOKENS` from 8,000 to
  15,000 left the test green, demonstrated rather than assumed. First
  instance where the restated value was a **price**. Worse, the figure
  it restated was itself a guess: re-measured, the underlying token
  count was **5.9× reality**, and two proposed user-visible increases
  evaporated with it.

- The migration tests' **Supabase stand-in** restated the platform
  minus its default privileges — real projects grant ALL verbs to
  `anon` and `authenticated` on every table the SQL editor creates. So
  a test asserting "update is not granted" passed locally and **failed
  on the real project**, caught only because Jared ran the check by
  hand rather than trusting the green suite. First instance where the
  restated thing was an *environment*: a stand-in that is weaker than
  production makes every check that runs inside it weaker too. The
  shim now models the defaults, 0007 revokes update on both
  three-verb tables, and a test re-opens the grant to demonstrate RLS
  updates zero rows without it — the state production was actually in,
  shown to be defence-in-depth and not a hole.

- **The same stand-in, running the other way: it had no `service_role`
  at all.** Every migration up to 0010 happened not to name the role,
  so nothing noticed. 0011 grants execute on `add_ai_usage` to it, and
  the whole suite went red with `role "service_role" does not exist` —
  a *correct* migration failing against a shim that was missing a
  piece of the platform. Fourteenth instance, and worth keeping beside
  the default-privileges one because they are the same fault pointing
  in opposite directions: there the shim let a bad migration pass,
  here it would have failed a good one. A stand-in that restates the
  environment is wrong in whichever direction it happens to differ.

- The grant audit's own **"the app's own queries still work" test**
  enumerated those queries by hand, from reading the client. It
  included `planner_data`'s upsert and omitted `ai_notes`, so 0008
  shipped revoking a privilege the AI-notes path needed and the test
  that existed to catch exactly that passed. The restatement was
  written *into the test checking the change*, which is as close to
  the blind spot as this pattern has got. Now derived: the upserts are
  matched out of `src/` and checked against the catalogue.

- The **help text's worked example** quotes the marks a student needs
  — figures that come out of `grades.js`. Typing them into the copy
  would have let the help disagree with the screen it explains, which
  is worse than no help. They are re-derived by running the real
  `requiredForBand` in the test, so a change to the bands or the
  rounding targets goes red naming the figure that moved.

- The **image-token comment** in `ai-text/config.ts` restated a
  published rate — for **the wrong model**. It shows its arithmetic,
  which is what makes it look like a derivation, and every step is
  right except the two constants at the top: they are gpt-4o's, and we
  call gpt-4o-mini. Thirteenth instance, and the first where the
  restated value belonged to something we do not use. A guard would
  have had nothing to read: the rate lives at the provider, not in this
  repository. What is available instead is the *consequence* — the
  document's section 11 predicts a token count so far from the
  alternative that one dashboard reading settles it.

- The **model string** `gpt-4o-mini` appears in both Edge Function
  adapters and in a measurement script. Twelfth instance, and unlike
  the browser/Deno mirrors this one is avoidable: both functions are
  Deno, in the same repository, and `ai-notes/_shared/` already exists.

One is an anecdote. Fourteen is a rule: **derive a guard from its source
of truth, don't restate it.** The cache name is hashed from the built bytes,
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

## A byte-identical differential is a one-shot proof, not a standing guard

Twice now — `test-blocks-neutral` when step 4 changed the editor on
purpose, `test-dark-mode` when the `?` help control landed — a
differential that compared the app against a previous build has been
RETIRED rather than repaired. Same reasoning both times, which makes
it a rule rather than two decisions.

**What they are for.** A differential proves that one NAMED change
did not alter output: the block conversion changed nothing a student
can see; tokenising 557 ground classes changed nothing in light mode.
That is a claim about a migration, and it is enormously valuable while
the migration is landing — it is what turns a sweep into a checked
refactor instead of a hope.

**Why the proof expires the moment it is delivered.** The baseline is
another commit, so it MOVES. Every legitimate later change to the same
surface fails the comparison, and there are only two ways to get green
again: enumerate the new thing as a permitted difference (which
corrodes the enumeration — that list is for *the same pixels through a
variable*, not for new markup), or pin the baseline to a sha (which
this project refuses for the reason every restatement is refused).
Both make the guard weaker while making it look alive.

**So: write them with an expiry in mind.** Deliver the proof, keep it
while the migration is in flight, and retire it DELIBERATELY when the
surface it guards changes on purpose — recording in the file what it
proved, when, and under which enumerated exceptions. What remains is
the non-expiring assertions alongside it: those compare the current
build with ITSELF (light against dark, legacy shape against block
shape, a stripped note against its own husk) or check values rather
than bytes, and none of them care what last month's build looked like.

The tell that you are past the expiry: you are reaching for the
exception list to describe something the user asked for.

## A source grep must strip comments first

Five separate times, a grep-based guard has tripped on the comment
explaining the very code it checks — because good comments name the
forbidden thing while saying why it is forbidden:

- the readings wording rule caught **its own documentation** on its
  first run;
- the device-store guard hit the comment excusing a store, and strips
  comments for that reason;
- the UNMEASURED deploy marker blocked a deploy from **the comment
  explaining the marker** (resolved differently: prose says
  "unverified", the marker stays reserved for the thing it marks);
- the color-mix guard in `test-dark-mode.mjs` tripped on the comment
  explaining why color-mix is banned;
- the husk's no-stroke-count check matched the two comments recording
  why the husk copy exists;
- and the sixth, in a new costume: a strip pattern ate CODE rather
  than prose. `accept="image/*"` contains a literal `/*`, so stripping
  `/*…*/` ran from that attribute to the next comment terminator and
  removed the very line being asserted. The fix was to stop stripping
  and match the one `<input>` element instead — **narrower beats
  cleverer**, and a guard that reads exactly the thing it is about
  cannot be confused by what surrounds it.

The rule: **a guard that greps source must strip comments before
matching, or reserve a marker that never appears in prose.** The
failure mode is not a false alarm once — it is that the fix under time
pressure is to weaken the pattern or delete the explanation, and both
make the codebase worse. Strip first (`/\*…\*/` and `//…`, the way
`test-readings.mjs` and `test-note-blocks.mjs` do), and the comment
and the guard stop competing.

## Pre-market hardening: the shape of it, and what was deliberately not built

Built ahead of the closed test, in sequence, each its own PR. What
exists and why it looks the way it does:

**The three e2e journeys** (`e2e/`, the `e2e journeys` CI job) put a
real Chromium in front of the built bundle and the live Supabase
project with a dedicated test account — the only automation on the
class of failure every shipped production bug belonged to. Three
rules keep them trustworthy: runs SERIALIZE on a concurrency group
(one shared account; the twin push/pull_request runs corrupted each
other's data before it existed), the account resets in `beforeAll`
(a serial retry restarts the suite in a fresh worker, and the data
must restart with it), and journey 2 asserts inside
`data-ai-note-body` (the stub's preview can render without the fetch,
so an assertion that can match the preview proves nothing). For the
ledger: the suite's first week found two real concurrency bugs in its
own harness — not wasted motion, since a harness that races is a
harness whose failures can't be believed — and then its first real
app bug: `stillCurrent`'s reference check refusing an archive over an
unchanged semester whenever a sync landed mid-flight (now a content
comparison; see the archive section). The one-time setup (test
account + two repo secrets) is in PR #48.

**The coverage gate** (`.c8rc.json`, `npm run test:coverage` in CI) is
today's measured branch figure rounded down — 82 — ratcheted up-only
by a test that reads origin/main's copy of the threshold. The figure
covers what Node can attribute: the pure `src/**/*.js` modules. The
JSX layer runs only as a bundle inside jsdom and is covered by the
differential mounts, the smoke walks and the journeys, which no
percentage represents. Local `npm test` stays ungated (no postgres =
fewer branches, and a gate that fails for that reason gets ignored).

**Error reports go into our own `client_errors` table** (migration
0010, `src/errorReport.js`) — never a third party. Write-only by
construction: insert is the only verb, nobody has select, Jared reads
from the dashboard. A row is six fields pinned by name — message,
stack, build id, page PATH (never query or hash: the hash is where
recovery tokens ride), browser, user_id — and never user content. The
reporter is bounded the migration-backoff way: capped per session,
deduped, one attempt, no retry, cannot throw. The ANON EXCEPTION is
written down where 0008 lives: anon may insert with user_id forced
null (signed-out crashes matter, and signed-out IS anon), and the
grant-audit guard asserts exactly that shape. `test-local-only.mjs`
was updated DELIBERATELY: the quiet walk still proves zero outbound,
then throws an error on purpose and proves the report goes only to
our own `client_errors` endpoint — and in demo mode goes nowhere.
Account deletion clears the account's reports; anonymous rows stay
(they belong to nobody, and sweeping them would delete other
signed-out users' diagnostics). **The daily digest email is ruled YES
but deferred**: build it when the closed test starts generating
reports worth waking up to. Resend is done; the remaining dependency
is the pg_cron/pg_net wiring, and with two users the dashboard query
is enough. One email a day via a dedicated secret (the sweep-secret
rule), never one per error.

**Promote-on-release** (the Hosting section has the full ritual) is
the cheap dev/prod split: `release` is the Pages production branch,
`main` builds previews, and production moves only on a deliberate
fast-forward promote. What it buys is a gate between merging and
users for the app bundle; what it does NOT buy is a second database —
migrations stay shared, and the apply-verify-merge ritual is
unchanged.

**The cheap security items** (PR 5): `npm run promote` is the
promote ritual as a script rather than folklore. CI gates
dependencies with `npm audit --audit-level=high` — high and critical
block, moderate and low deliberately don't (a gate that cries wolf
gets disabled; policy reasoning in the workflow). `public/_headers`
ships frame-denial, nosniff, no-referrer, a minimal
Permissions-Policy and — Jared's ruling, 20 August 2026 — **an ACTIVE
CSP whose `'unsafe-inline'` is a deliberate concession, not an
oversight**: weaker than the hashed version, far stronger than
nothing, and it still blocks external script injection, framing and
objects. The hash path is named in the file so the concession stays
visibly temporary — the build already holds the two inline blocks'
bytes (it substitutes `__BUILD_ID__` into one), so it can emit
`sha256-` hashes for script-src; style-src cannot follow, because
React writes style attributes at runtime. **The policy was verified
in a real browser before activation** — pre-paint stamping, mount,
dark ground, inline styles, the derived accent, every tab, and an
injected external script and object both refused — and that check is
re-run whenever the policy changes. **Confirmed in PRODUCTION on 20
August 2026**: Pages really serves `_headers`, and the inline
pre-paint script survives the policy (no white flash into dark mode,
accents and folder colours correct, no console violations). That last
link could not be tested from a dev container, because the network
policy there blocks both the production host and `*.pages.dev` — a
local check against the exact header is the closest a build machine
gets, and it is not the same thing.

**Rate limiting on the AI endpoints: there is none beyond allowance
metering, stated plainly.** The allowance is a monthly SPEND ceiling
per account — it bounds what any account can cost, and
unauthenticated calls are refused before any provider call, so
hammering burns only the attacker's own allowance plus cheap function
invocations. That is acceptable at closed-test scale and is NOT abuse
prevention. **THE TRIGGER TO BUILD IT IS THE FIRST PAYING CUSTOMER**,
not a vague "if abuse appears": today an attacker burns their own
free allowance, which costs them something nobody will ask us about;
the moment allowance is *purchased*, the same act becomes a refund
and a support conversation. The cheap fix then is a per-user request
counter beside `ai_usage`, not a WAF — the functions don't sit behind
Cloudflare.

**Deliberately NOT built, each with the condition that would change
the answer** — deferred decisions, not forgotten ones:

- **A second Supabase project (dev/prod split).** At two users the
  cost is a duplicated backend and a doubled migration ritual; the
  cheap version is the promote-on-release branch instead. Revisit
  when a migration mistake would cost real users' data — around the
  closed test's end.
- **PostHog, Sentry, or any third-party telemetry.** The app proved
  zero third-party requests, says so in the privacy policy, and pins
  it with a test; a US processor would undo all three and cost a
  consent bump. Revisit only if error volume outgrows the dashboard —
  and then the answer is a bigger own-backend pipeline, not a
  processor.
- **A 95% coverage gate.** Unachievable gates get disabled, and a
  disabled gate is worse than none. The ratchet may reach 95 honestly
  one day; the condition is the JSX layer becoming attributable, not
  a decision to demand the number.
- **A full OWASP audit now.** A broad audit proposing broad changes
  without end-to-end coverage is how business logic gets mangled.
  Condition: after launch, with the journeys in place to catch what
  the audit's changes break.

## Read what the READER renders, not what the writer writes

Twice now, mounting the app and inspecting the output of the
*read-only* path has found something no test could — and both times
the bug was invisible from the editor, where everything looked right.

- The **differential mount** (handwriting removal) proved a canvas
  with six strokes and a canvas with none produced identical HTML, so
  half that test was decorative until the context recorded its calls.
- The **note viewer rendered `body`** — plain text — so bold, colour,
  highlight and font were all stripped the moment a student pressed
  Done. **Every note anyone had formatted was being silently
  flattened on save.** The editor showed the formatting the whole
  time, because the editor renders `innerHTML`; nothing compared the
  two. Found by seeding a formatted note, opening the view, and
  reading what came out.

The technique: seed the shape you care about, mount the real app, and
assert on the *reader's* DOM. It is the only thing that catches a
writer and a reader disagreeing, which is a class of bug that unit
tests structurally cannot see — each half is correct on its own.

The corollary, learned the same day: **rendering stored HTML makes the
sanitiser load-bearing rather than precautionary.** A note's html is
not something only this editor writes — the blob syncs and restores —
so the same mount asserts a stored `<script>` and a stored `onerror`
are stripped before reaching the DOM, and that a note whose only
content is plain text is escaped rather than injected.

## The ? help, and the two rules its copy is written under

`src/helpText.js`, `HelpButton`/`HelpPanel` in PlannerApp.jsx,
`scripts/test-help.mjs`.

**A worked example, never an explanation.** Grace bounced off Grades
not because the feature is wrong but because its payoff arrives weeks
after its setup cost, and an abstract description of weighted averages
does not survive contact with someone deciding whether to bother. Each
Section already has a subtitle doing a one-line job, so help must
answer what the subtitle cannot. A `?` that opens a thin restatement
of the subtitle teaches people to stop tapping `?`. **If a topic
cannot be written with a concrete example, that is a signal about the
feature rather than about the writing** — say so instead of shipping
something vague.

**Say what it costs.** Grades needs every assessment and weight
entered before it can say anything; a recording spends minutes and a
short one still costs three; the archive needs an account and clears
the semester off the device. Naming the cost up front is what stops
someone discovering it three screens in.

**The Grades figures are computed, not typed.** The example quotes the
exam marks needed for a Distinction and a Credit, and the test
re-derives them from `grades.js`. Writing that example also found
something worth keeping: under the app's DEFAULT rounding the answers
are 80% and 60%, but rounded down they are 81% and 61% — and that
half-mark gap is the clearest available explanation of why the
rounding setting exists, so the copy carries both.

**Coverage is partial ON PURPOSE and enumerated.** Eleven topics
ship — the original four (semester setup, grades, AI notes, archive)
plus the whole Study tab; the remaining nine Sections are listed in
the test as not-yet-covered. A Section added later lands in neither
list and goes red — the device-store guard's shape, because silent
partial coverage is the thing to avoid, not partial coverage.

**THE STUDY TAB'S FIGURES ARE RE-DERIVED TOO, and writing them
corrected the brief twice.** The scheduler's ladder is quoted from
`srs.js` by running `schedule()`: **Again returns in the SAME
session** (interval 0 — a card you just missed is not one to leave
overnight), not "tomorrow" as the draft had it, and Good is 1 → 3 → 8
days rather than "a few". The timer's floor is **a few seconds**
(`MIN_RECORDABLE_MINUTES` is 0.1), not the minute the draft assumed.
Both are the grades correction again: a plausible number in a brief
is still a restatement, and the only cure is running the real code.

**The AI costs in help are stated in the currency the SCREENS use.**
A test forbids the word "units" anywhere in a topic — that word is an
internal weight and `aiTextCopy.js` exists to keep it off screens, so
help quoting it would be the first place it leaked. What the copy may
say is what a plan BUYS (ten explanations a month on free, five
question sets), derived from `TASK_UNITS` and `limitForTier`.

**Three topics needed their reason-to-exist stated, not their
behaviour.** Interleaving feels wrong to students, so the copy says
it feels harder and why that is the point; practice mode's whole
purpose is the night before an exam when nothing is due, and its cost
statement is inverted — the reassurance is that it changes no
schedule; the exam plan's missing review day (five topics, two days)
is deliberate and reads as a bug unless said out loud.

**Inline panel, not a tooltip**: a tooltip needs a hover, and half the
people this is for are on a phone. Pinned by a test, because "make it
a tooltip" is the obvious tidy-up for someone who has not thought
about touch.

**The tutorial was DROPPED, not deferred** (Jared, 20 August 2026), and
the reasoning is worth keeping: a closed test exists to discover what
confuses people, and a tutorial pre-empts the finding by walking
testers past the rough edges before they hit them. Orientation comes
from the written guide sent with the install link. If real testers
turn out to need in-app onboarding, that is a decision made later with
evidence.

**Grades and semester setup were nearly deleted and were not.** The
proposal was to remove both; the dependency list showed courses are
load-bearing for AI-note folders, the reading planner, study cards,
the exam countdown, the workload forecast, the archive summary and
every "Week 9" label — 61 references. The problem was never that the
features are wrong, it is that they were unexplained. That is what
this section exists to fix.

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
- `scripts/test-note-blocks.mjs` — the block view post-removal: the
  text inverse theorem, and the strip's contract (remove ink, never
  remove notes; tombstones and stubs untouched; flag best-effort with
  convergence as the guarantee)
- `scripts/test-blocks-neutral.mjs` — the differential render: a
  pre-removal note against the same note stored as blocks, through the
  current bundle, plus the no-canvas guard and the husk's "Empty note"
  row asserted in a real mount. (The git baseline now belongs to
  `test-dark-mode.mjs`, which is why CI sets `REQUIRE_BASELINE=1` and
  `fetch-depth: 0`)
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

Flagged for her next sitting, so decisions don't wait on a meeting nobody
scheduled:

- The navigation restructure **shipped** (#45) from her mockup with
  rulings 1–4 folded in; she vetoes in parts, on the live app now.
- **Dark note paper is POST-LAUNCH, not for her next sitting.** The
  handwriting removal took away the only technical reason the paper
  stays light in dark mode, so it is a pure look-and-feel call and it
  is hers — but feature work is stopped until the closed test is
  running, and it stays parked with Grace's palette until after
  launch. When she does rule, the test pinning `--paper` equal in
  both modes changes in the same commit.
- **The consent-gating decision on the four text features.** Practice
  questions, explain-it-back, weak spots and summarise-a-note are not
  consent-gated at the point of use; summarise-a-reading is. The gap
  predates the readings work and closing it changes four existing
  screens, so it is a Jared-and-Grace call — parked for weeks, and her
  sitting is the natural place to close it.

**Say when something can't be done as asked.** The `studyStats` collection
exists because the original instruction ("a semester gets a stats object,
don't touch the merge logic") was not possible as written. Finding that
and saying so was worth more than a working-looking implementation that
lost data on the second device.
