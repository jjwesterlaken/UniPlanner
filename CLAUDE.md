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
bump. Consent bumped here because *what happens to the content* changed
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

### Handwriting is a live storage problem, and compression probably solves it

A stroke serialises to **~1,420 bytes** today, so a 200-stroke page is
**~278 KB — a quarter of the entire 1 MB budget in one note.** That is
not a consequence of the planned unified note; it is true right now, and
anyone taking handwritten notes on an iPad is heading toward breaking
their own sync with nothing warning them.

The cause is visible in one line of `PlannerApp.jsx`: a point is
`[((e.clientX - rect.left) / rect.width) * CANVAS_W, ...]` — an unrounded
division, serialised at full float precision (`123.45678901234567`) for a
coordinate on a 1000-unit canvas where nothing past the decimal point can
be seen.

`scripts/measure-ink.mjs` prices three transformations. On synthetic
strokes, a 200-stroke page goes 278 KB → **20 KB, a 93% reduction**:

| | page | note |
|---|---|---|
| now | 278 KB | |
| rounded to whole canvas units | 79 KB | **−72%, and shape-independent** |
| + drop near-collinear points | 28 KB | −90%, depends on real handwriting |
| + delta-encode along the stroke | 20 KB | −93% |

**The first step is the one to trust without a real sample.** Rounding
removes float digits, which is pure waste regardless of how anyone
writes; the figure is a floor, not an estimate. The other two depend on
stroke shape and sampling rate, so they need a real export before anyone
promises them.

**Round to a TENTH of a canvas unit, not to whole units.** The obvious
choice is wrong: the canvas backing store is sized
`CANVAS_W * devicePixelRatio` with the ratio capped at 3, so on a 3x
display one canvas unit is **three physical pixels** — and the drawing
code's own comment promises strokes "stay sharp at any zoom". Whole-unit
quantisation would be visible on exactly the hardware the feature exists
for, and worst on small handwriting. A tenth of a unit is below one
physical pixel at the largest ratio the app ever uses, so it cannot
produce a step. It costs one digit per coordinate: 66% instead of 72%
for rounding alone, 92% instead of 93% for the whole chain. There is no
zoom control and no image export today, but neither is what makes whole
units unsafe — the device pixel ratio already does.

**Pressure quantises safely, and it is worth saying why rather than
assuming.** It feeds exactly one thing:
`lineWidth = max(0.5, width * (0.4 + pressure * 1.6))`. At a typical
width of 3 the whole pressure range spans 1.2px to 6px, so 100 levels
move the line by 0.048px per step. Two decimal places is invisible; a
single byte would be too.

**The migration must NOT bump `updatedAt`.** A lossless representation
change is not an edit, and if it looked like one, two devices each
loading the app would rewrite the same notes and fight through
last-write-wins forever. `mergeList` breaks a tie with `t2 > t1`, strictly
greater, so equal timestamps keep the existing item and the merge is
stable — which is what makes a silent rewrite safe. There is a test for
that stability, because the migration depends on it and nothing else
asserts it.

If that holds on real handwriting, ink does **not** need the `ai_notes`
treatment — a table of its own, fetched on open — and the unified
typing-and-ink note becomes a much smaller decision. Migration is
correspondingly cheap: rounding is idempotent and lossless at display
resolution, so it can run in `normalizeData` on load with no schema
change, no server involvement, and no migration ordering to get wrong.

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

**DEADLINE: 31 August 2026 — Google Play requires new apps to target
API 36 from that date, and nothing has been submitted yet.**
Being below it blocks submission outright rather than failing the build.
Capacitor's template already sets 36, but `stamp-native.mjs` checks the
*generated* `variables.gradle` and warns, because the template is not the
thing that ships. Our minimum is 26 (Capacitor defaults to 24); iOS
deploys at 15 (default 14).

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

**Email delivery blocks the testers too.** A closed tester who cannot
confirm their account wastes the fortnight they are spending on you, so
Resend (below) is a prerequisite for the test, not just for launch.

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
3. **Bump `actions/checkout` and `actions/setup-node` to `@v5`**, in
   every workflow. Both currently target Node 20, which GitHub has
   deprecated; the runners force them onto Node 24 and they work, so this
   is a warning today and not a failure. It becomes a failure on
   **GitHub's timetable, not ours**, and when the fallback is removed
   every workflow in the repo stops at once — tests, the desktop build
   and the function deploy together. Scheduled here rather than
   remembered, and deliberately kept out of the native-build fix so a
   packaging change and a runner change can be told apart if either
   misbehaves.
4. **Resend (or another real SMTP provider)** configured in Supabase
   Auth → SMTP Settings. The built-in sender is rate-limited and lands in
   spam, so password reset does not work for real users without it. See
   the section above.
5. **pg_cron and pg_net**, enabled in `Database → Extensions`, plus the
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

### Email delivery is a launch requirement, not a nice-to-have

**Supabase's built-in email sender is rate-limited to a handful of
messages an hour and lands in spam routinely.** Password reset does not
survive real users on it: a student who cannot sign in and whose reset
email never arrives has no route back into their account and no way to
tell whether the app or their inbox is at fault.

Configure **Resend** (or another real SMTP provider) in Supabase Auth →
SMTP Settings before launch. This is on the pending list below rather
than in it as a footnote because the symptom — "the email never arrived"
— is indistinguishable from a code bug to everyone except whoever checks
the SMTP configuration.

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

**It blocks the closed test, not just launch.** A tester who cannot
confirm their account wastes the fortnight they are giving you.

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

- The documents' **"AI works on your own writing" assertion** was typed
  into `test-legal.mjs` as a literal phrase. The policy was wrong — the
  app has always worked on material the student did not write, since a
  lecture recording captures the lecturer — so **correcting it failed
  the test that existed to keep it true.** First instance inside a test
  rather than in code, and the tell is the same: a guard that pins the
  wording cannot survive the wording being wrong.

One is an anecdote. Seven is a rule: **derive a guard from its source of
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
