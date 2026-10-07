# 1.3.1 — the list

Started 27 September 2026 (Sydney), the day iOS 1.3.0 went live
(IOS-RELEASE.md, submission record). This is a record of what is on the
list and what state each item is in. It is not evidence of what has
shipped: check the store listing, `main` and the open pull requests
for that.

| # | Item | State |
|---|---|---|
| 1 | Weekly essay-feedback quality queries | **Built.** `supabase/checks/essay-quality-weekly.sql`, pinned by `scripts/test-essay-quality.mjs` |
| 2 | Cost against credits, per task | **Ruled GO, 27 September 2026.** The ceiling half is measured below. The real-spend half (0024, `ai_task_costs`, no user id and no content) is **live and verified, 30 September 2026** (#165). The first row after the deploy was explain / text / gpt-4o-mini, 181 in and 93 out, $0.0000829, 1 credit, delivered; the table had been empty only because no AI action ran between the deploy and the first check. Run `supabase/checks/ai-cost-weekly.sql` weekly |
| 3 | Placeholder linking | Shipped in 1.3.0 (#161), with the plain control. **Grace restyles it.** Listed so it stays visible |
| 4 | Auth email failure detection | **Built, 27 September 2026.** A canary every four hours (`auth-email-canary`, migration 0025), plus app-side reports of signup and reset email failures, which the digest now reads. Setup is SUPABASE-SETUP.md §3e |
| 5 | Bounded recurring events | **Live on the web, 1 October 2026** (#170, promoted). In the iOS and Android 1.3.1 builds. `src/recurrence.js`, a teaching-weeks field on Semester setup, pinned by `scripts/test-recurrence.mjs`. See section 5 |
| 6 | Tailwind 4 migration | **Not started.** A separate item, not part of any other change. It is the only fix npm offers for GHSA-vfj7-8cjw-p6xm (`braces`, reached only through Tailwind 3's build tooling); CI audits shipped dependencies only until then (#173). Breaking for the CSS and config, so it **needs Grace's visual check of the app and the site** before it merges |
| 7 | Fewer sections, no overlaps (Jared, 6 October 2026) | **Built**, web first. Six changes, pinned by `scripts/test-fold.mjs`. See section 6 |
| 8 | Lecture-notes feedback (Jared, 7 October 2026) | **Built.** The essay rating control under every AI notes result. Migration **0026**, `lecture_notes_feedback`, must be applied **before** the promote. Weekly query `supabase/checks/notes-quality-weekly.sql`, pinned by `scripts/test-notes-quality.mjs`. See section 7 |
| 9 | One assessment record (Jared, 7 October 2026) | **Release A built** (plan approved 7 October 2026): Plan and Grades read one merged view of assignments and assessments, read-only across, nothing converted or written, older builds unaffected. `src/assessmentRecords.js`, pinned by `scripts/test-merged-view.mjs`. **Release B (convert on first edit, late edits) is 1.3.2**, gated in RELEASE-1.3.2.md. The approved plan is section 8 |
| 10 | Courses list folds into Grades | **Built** (#181). Each Grades card is the course: add, rename (everywhere the name is written, `src/courseRename.js`) and remove on the card; Semester setup stays |
| 11 | Two features called "Practice" | **Built** (#180). The study-cards mode is "Drill"; "Practice questions" keeps its name |
| 12 | "Break into steps" tasks say where they came from | **Built** (#180). "From <assignment> →" on each step in To-do, opening it with its steps shown |
| 13 | Calendar "important dates" | **Built**, Jared's pick (option A, 7 October 2026): Grades' dates on the Calendar read-only, labelled "From Grades"; the add form says where exams go; an exam-like title gets a pointer, never a block |

**Later**

- Weak spots as a filter on Study cards rather than its own section.
- Summarise a reading only on the reading row, not also on the AI tab.
- A one-line explanation on "Hurdle minimum" in Grades.
- Block disposable-email domains at signup: a small server-side blocklist, refused with a plain message, so one person can't farm trial credits with throwaway addresses. (Confirm email is on and anonymous sign-ins are off, checked in the dashboard on 5 October 2026, so the trial already needs a confirmed address.)

---

## 1. The weekly essay-feedback queries

**How to run them.** Open Supabase → SQL editor, paste
`supabase/checks/essay-quality-weekly.sql`, and run it. There are eight
blocks, each headed `-- @query <name>`, and each one is a single SELECT.
You can run the whole file and read the result tabs in order, or select
one block. Nothing writes and nothing is created. The windows are
computed from `now()` in Sydney weeks (Monday start), so there is
nothing to edit before a run.

| Query | What it answers | Read first |
|---|---|---|
| `volume` | Runs, students, and how many runs were rated, per week for the last 8 weeks | `runs`. A rate on 5 runs is noise |
| `rating_split` | The "Was this useful?" split, all time and then per week. `rewrite_n` counts ratings given after an example rewrite | `n` |
| `reasons` | Why a result was only partly useful, or not useful. The denominator is the unhappy ratings, and one rating can carry several reasons | `unhappy_total` |
| `by_code` | Per deficiency code: how often we raise it, and the yes-rate on results that raise it **beside the yes-rate on results that don't** | `rated_with`, `rated_without` |
| `mark_gap` | **The mark comparison.** The average mark of essays we flagged for a code against essays we didn't. A positive `gap` is the claim the feature makes | `n_flagged`, `n_clear` |
| `mark_answers` | Mark answers after deduplication, and how many shared the mark | `rows` against `answers` |
| `before_after` | How the student rated the result when they read it, against how they rated it once the mark was back | `n` |
| `comments` | The comments students chose to send, newest 50 | — |

**Two traps are handled, and the old doc's query fell into both.**
ESSAY-FEEDBACK.md's `essay_marks` join paired a mark with every run on
its assessment. So a redraft counted one mark once per run, and a linked
draft counted it again, because `markAnswerIds` writes one `on_mark` row
for each id the answer covers. On the test fixture that join returns 4
rows for 2 shared marks.

The checks file does two things differently:
- It uses the **latest** run's codes, meaning the draft closest to what
  was submitted.
- It collapses one student's identical `on_mark` rows written within
  60 seconds into one answer.

The test seeds both shapes and asserts exact figures. Three mutations
(breaking the dedupe, reading the first run instead of the latest, and
joining ratings by student instead of by run) each turn it red.

**The old doc also said to `create view essay_marks`. Do not.** A
view made in the SQL editor lands in `public`, where the platform grants
it to `anon`, and it runs with its owner's rights. It would serve every
student's ratings and marks through PostgREST, and RLS would never be
consulted. **Checked 27 September 2026: it was never created in production.** The check, should it ever be needed again:

```sql
select schemaname, viewname from pg_views where viewname = 'essay_marks';
drop view if exists public.essay_marks;
```

**Reading rules:**
- **n before percentage, always.** Every query prints the count beside
  the rate.
- **`mark_gap` is the only query that compares us with a marker.** The
  others are the students' opinion of us, which matters but is a
  different claim.
- **Early weeks will be almost empty.** A mark only arrives weeks after
  a run.
- **Comments may quote the student's essay.** Read them in the editor
  and don't paste them anywhere.

**What it cannot show:**
- Anything a client failed to write. The denominator undercounts when a
  client dies between a result and its `delivered` insert, which errs in
  the safe direction.
- Whether a student who never answers is happy or has left.

---

## 2. Cost against credits, per task

### What is already guaranteed

The photo-billing gap was a price that was derived and never charged.
That class is now closed for every task, by one chain of tests:

1. **Every task's credits are derived from its own ceilings.**
   `TASK_CREDITS = creditsFor(usdForTask(task))`, and a test re-runs the
   derivation. No literal weight is allowed.
2. **The screen and the server hold one table.** A test asserts the
   client's `TASK_CREDITS` deep-equals the server's.
3. **The handler charges the table, on the real handler.** This is
   checked for explain, weakspots, practice, summarise and merge against
   the table, for photo batches against `estimatePhotos`, for criteria
   against its own derived price, and for essay (9) and rewrite (3)
   against the ruled figures.

### The ceiling half: measured today, from `ai-text/config.ts`

`cover` is the credits charged, valued at `USD_PER_CREDIT` (what a
lecture minute costs us), divided by the **worst case** the task can
cost: full input at the character cap and full output at the token
ceiling.

| Task | Worst-case cost | Credits | Cover |
|---|---|---|---|
| explain | $0.00050 | 1 | 1.36 |
| weakspots | $0.00069 | 1 | 0.99 |
| practice | $0.00119 | 2 | 1.16 |
| summarise (text) | $0.00191 | 3 | 1.08 |
| **merge** | **$0.00163** | **2** | **0.84** |
| essay | $0.00594 | 9 | 1.04 |
| rewrite | $0.00190 | 3 | 1.09 |
| criteria (photos) | $0.01220 | 18 | 1.01 |
| summarise (photos) | ~$0.0122 | 18 | ~1.01 |

**`merge` is the one below 1, and it is working as designed.** Weights
use `round`, not `ceil`, so that a 1.04-credit action is not charged 2.
The floor of 1 is what stops any action being free. At a worst-case
2.37 credits, merge rounds to 2. It only occurs inside a reading of two
or more parts. The every-tier margin test in `test-readings.mjs` is run
against the dearest path, 100% photo usage, and passes; a 16% shortfall
on one cheap step is inside those margins. That is an inference, not
something that test measures.

**Cover measures a credit's COST value, not what a student pays for
it.** Revenue per credit depends on the tier, and whether each tier
pays for itself is asserted separately. So below 1 means "less than
the worst case costs us", never "loss-making".

### The real-spend half: nobody knows what a task actually costs

`ai-text/openai.ts` reads `choices[0]` and **discards `usage`**, so the
provider's own token count for each request goes nowhere. The ceiling
table is therefore a bound, and nothing tells us where under it real
requests land. That matters in both directions:
- **Wasted headroom.** If a task typically lands at 20% of its ceiling,
  its price is set by a case that never happens.
- **Nearing the ceiling.** If essay (a reasoning model, whose reasoning
  tokens bill as output) is typically near its ceiling, the margin is
  thinner than the table suggests.

This is the `TYPICAL_SUMMARY_OUTPUT_TOKENS` lesson: that one was
modelled at 2,800 and measured at 475. **A price set from an unmeasured
number is a guess, however carefully it was derived.**

**Built for 1.3.1, as proposed** (ruled go 27 September 2026):
- **Migration 0024, `ai_task_costs`. It widens, so it goes before the
  deploy.** One row per provider call: `day` (date, not timestamp),
  `task`, `medium` (text or photos), `model`, `prompt_tokens`,
  `completion_tokens`, `credits_charged` and `outcome`. **No `user_id`
  and no content**, which is the reasoning 0022 gives for having no user
  column. It is service-role only, has no policies, and nothing is
  granted to `anon` or `authenticated`.
- **It is written through an RPC, `record_ai_task_cost`, not `.from()`.**
  `ai-text`'s source-level invariant is that no `.from` names a table
  other than `profiles` and `ai_usage`, so the endpoint cannot read
  stored user content. An RPC keeps that invariant literally true.
- **The write is AFTER the provider call and can never fail the
  request.** It gets its own `try`, and a failed insert is logged and
  swallowed. A diagnostic must never cost a student a result they paid
  for.
- **A weekly query** reports, per task: requests, median and p95 cost
  from real tokens, credits charged valued the same way, and the share
  of requests above 80% of the output ceiling. It goes beside the essay
  queries as `supabase/checks/ai-cost-weekly.sql`, with a fixture test.
- **The documents.** The legal table sweep requires a phrase for every
  new table. The honest phrase is that it holds counts and no content,
  so it is a declared excuse rather than new policy text. **No consent
  bump**, because no student content is involved.
- **Not covered by this:** `ai-notes` (lectures), which bills by minute
  and has its own measured constants. Transcription is priced per
  audio minute, so token counts are the wrong instrument there.

**What differs from the proposal:**
- **Every exit after the provider records a row, including free
  refusals.** A free refusal still spent money, and that is exactly
  what the weekly query needs to see.
- **Rows store the cost in dollars and the value of a credit at write
  time.** The weekly query then needs no constants, and a later price
  change does not rewrite history.
- **Retention is 90 days**, purged by the error digest's daily run.

**The deploy order.** 0024 widens, so:
1. **Apply `0024_ai_task_costs.sql`** in the SQL editor. It must end
   with `0024 applied and verified: 8 properties checked`. If it raises
   instead, nothing was changed.
2. **Deploy the functions:** `ai-text` writes the rows and
   `error-digest` purges them.
3. **Verify** with one real AI action, then:
   ```sql
   select day, task, medium, model, prompt_tokens, completion_tokens, usd, credits_charged, outcome
     from public.ai_task_costs order by id desc limit 5;
   ```
   Expect `usd` to be non-null and `credits_charged` to equal what the
   action cost on screen.

Deploying the functions first is safe but blind. Every record would
fail with "function does not exist", which is logged and swallowed by
design, so no row would be written and nothing would look wrong.

**Weekly:** `supabase/checks/ai-cost-weekly.sql` runs the same way as
the essay queries. It has three blocks:
- `by_task`: requests, outcomes, median, p95 and max real cost,
  median and worst cover on delivered requests, and the share of
  requests near the output ceiling.
- `totals`: spent against charged credit value, over the last 7 and
  28 days.
- `free_outcomes`: what the free refusals cost us.

**Read `requests` before any cover.**

---

## 5. Bounded recurring events

From user feedback: a weekly class repeated forever, and the only way
to stop it was to delete the whole series. Ruled go 30 September 2026:
teaching weeks go on Semester setup (blank by default), the default
count is 12, count mode skips the break, and "this and all following"
is included.

**What a weekly event can say now.** It has three optional fields, and
each one rides the ordinary per-item merge:
- `repeatEnd`, one of:
  - `{kind:"semester"}` ends on the Sunday of teaching week N and has no
    class in the break week.
  - `{kind:"count", n}` gives n classes. Break weeks are skipped and not
    counted.
  - absent or null means no end, which is **exactly** the old behaviour.
- `until` is written by "this and all following". It caps any series
  and keeps its break skipping.
- `skip` is written by "this event only".

**Nothing changes under anyone.** An event saved before this has no
`repeatEnd`, so it is left completely alone: no end, and no break
skipping either. A test runs the old predicate beside the new one for
every day of a year. Opening an old event to fix its room does not give
it an end. Only ticking "repeats weekly" on an event that isn't weekly
yet does that.

**The default.** If the semester start and teaching weeks are set, a new
series runs until the end of semester. If they aren't, it runs 12 times.
A semester series whose dates are later cleared, or which starts after
the semester has ended, falls back to 12 times. It never becomes endless
and never shows nothing.

**Sync.** There is no merge change, no new collection and no migration.
Deleting one class, or this-and-following, is a patch with a bumped
`updatedAt`. Only "all events in the series" tombstones the item, and
that was the only delete there was before. A fully used series (every
class skipped, plus an `until`) measures under 1 KB.

**For Grace.** The wording is in `src/calendarCopy.js`. The teaching
weeks field is on her Semester setup screen. The end choice is radio
buttons under the weekly checkbox, and the delete choices are a row of
three buttons under the event. Both are plain controls, waiting for
her pass.

---

## 6. Fewer sections, no overlaps

Six changes from Jared's 6 October brief. The goal across all of them:
fewer sections, nothing said twice, nothing confusing.

1. **"Essay feedback" is the name.** The per-assessment link and the AI
   tab's card both say it, where they said "Get feedback on a draft" and
   "Feedback on a draft". Both entry points stay.
2. **Grades is one card per course.** The separate add form and its
   Course dropdown are gone. Each course's card has its assessment rows,
   the mark field, the bands and "what you need" as before, plus an
   **Add assessment** row at the foot (name, worth, type, due date,
   hurdle). A course with nothing in it yet still gets a card, because
   that is where its first assessment goes. Assessments with no course,
   the AI tab's "Essay draft, <date>" placeholders included, are one
   **No course** card at the bottom, and linking a placeholder works
   from there. No data shape change.
3. **"What's coming" is "Upcoming", and the exam countdown is folded
   into it.** An exam is a row in its week with the days left, and its
   study plan opens from that row. The separate Exams section on the
   Study tab is gone; the plan logic is unchanged and nothing is
   stored. Exams show however far off they are, as the countdown did,
   even though deadlines look six weeks ahead. The help topic moved
   with it.
4. **Other non-teaching weeks.** Semester setup takes any number of
   extra ranges beside the mid-semester break, in a new
   `settings.extraBreaks` field. A separate field, not more entries in
   `breaks`: the 1.3.0 build rewrites `breaks` as a single entry
   whenever its mid-semester break is edited, so extra entries there
   would be dropped by any older device. An older build ignores the new
   field and keeps it. Week numbering, Upcoming's labels and bounded
   recurrence all skip them through one function (`breaksOf`). Crunch
   detection has never read the calendar, so it treats them exactly as
   it treats the break.
5. **Saved essay feedback is its own Notes section.** One note per
   result, titled "<assessment name> — <date>", read-only, filed in the
   course folder when there is one. Saving is free and the note holds
   the feedback's own quoted phrases and nothing else of the essay.
   Notes saved before 1.3.1 carry no marker, so they stay ordinary
   notes.
6. **The site** drops the Exam countdown tile and says Upcoming.

**For Grace.** Every new string is plain and waiting for her pass:
`ESSAY_COPY.notesSection` and `notesSectionSubtitle`, the Upcoming
subtitle, "Other non-teaching weeks" and its hint, "No assessments yet",
and the "Add assessment" row.

## 7. Lecture-notes feedback

After every AI notes result, the same control the essay feature uses:
"Were these notes useful?" Yes / Partly / No, and on anything but Yes,
six reasons (too long, too short, missed something that will be
assessed, got terms wrong, organised the wrong way, something else),
and a comment only if the student ticks to send one. Free; it calls no
provider and spends no credits.

**Stored like `assessment_feedback`, and narrower.** Migration 0026,
`lecture_notes_feedback`: one `delivered` row per result (the
denominator) and one `rated` row if answered. Insert-only, three
policies, nothing to anon, cleared by account deletion, self-checking
(11 properties). A row holds the student's id, a run id, the course
label, the rating, the reasons and the opt-in comment, and **nothing
from the lecture**. The run id is minted fresh per result and is NOT
the idempotency key, so a rating cannot be joined to a transcript in
`ai_notes_requests`. The reasons are a closed set in the database's
CHECK too, so a stale client cannot invent one; a test holds the
migration, the client, the copy and the weekly query to one list.

**It outlives the save.** A student who taps Save first is offered the
rating again on the "Saved" screen; one who already sent it is not
asked twice. A failed summary has no notes, so it writes no row and
shows no control.

**Order: apply 0026, then promote.** It widens. A client promoted first
has every insert refused, and the control swallows that (a rating must
never take down notes the student paid for), so nothing would look
wrong and nothing would be recorded. No function deploy is needed.

1. Apply `0026_lecture_notes_feedback.sql` in the SQL editor. It must
   end `0026 applied and verified: 11 properties checked.`
2. Promote.
3. Verify after one real rating:
   `select occasion, rating, reasons, course from lecture_notes_feedback order by created_at desc limit 5;`

**Weekly:** `supabase/checks/notes-quality-weekly.sql`. Five blocks:
volume, rating split, reasons (every reason listed, at zero if unused),
by course (course labels lowercased and trimmed; the row count is the
course count), and comments last, on their own.

**Known gap, recorded rather than fixed here.** A result picked up from
the recovery card ("Get it back") is rated with no course, because the
recorder's course field is empty on that path, and the note it saves is
filed with no course for the same reason. That predates this item.

**For Grace.** The question, the six reason labels and the comment note
in `AI_NOTES_COPY.rating`.

## 8. One assessment record (approved 7 October 2026)

Plan → Assignments and Courses → Grades held the same piece of work
twice. The approved plan makes **`assessments` the one record**, shown by
week in Plan and by mark in Grades, in two releases.

**What the code said before any of it:** `assessment.assignmentId` is read
by the workload forecast and **set by nothing** (its only history is
Batch 2), so linked pairs essentially do not exist in real data.
Essay-feedback rows on the server and saved essay notes point at
**assessment** ids, which must therefore never change. Steps point at
the **assignment** id through `todos.parentId`. Recurring events carry
neither.

**Release A — 1.3.1, built.** Readers only. Plan's Assignments list also
shows Grades' dated records (read-only, "In Grades · 40%", Open in
Grades); each Grades card also lists its course's Plan assignments with
no grade record (read-only, "Also in Plan, no weight yet", never
counted); a linked pair shows once on each. An unlinked look-alike pair
is two rows on both screens, never merged. Nothing is written, so a
1.3.0 device sees exactly what it saw — a test round-trips a 1.3.0-shaped
planner and proves, with a control, that it would see a write.

**Release B — 1.3.2.** Convert on first edit; the gate and the rest are
in RELEASE-1.3.2.md.

**Data shape (Release B, recorded here because the plan was approved
whole):** `assessments` gain optional `requirements`, `notes`, `rubric`;
a converted assignment becomes an assessment with **the same id** (so its
steps' `parentId` resolves unchanged) and the assignment is tombstoned;
a linked pair's assessment absorbs it and carries `formerAssignmentId`;
`assignments` stays in COLLECTIONS for ever, written by no new build.
No migration, no server change, no growth.

**Sequencing.** Grace's iOS list, the device checklist and the store
screenshots are redone **after** items 9–13 merge, not before. No iOS
1.3.1 build has been made.

