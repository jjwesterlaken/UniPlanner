# 1.3.1 — the list

Started 27 September 2026 (Sydney), the day iOS 1.3.0 went live
(IOS-RELEASE.md, submission record). This is a record of what is on the
list and what state each item is in. It is not evidence of what has
shipped: check the store listing, `main` and the open pull requests
for that.

| # | Item | State |
|---|---|---|
| 1 | Weekly essay-feedback quality queries | **Built.** `supabase/checks/essay-quality-weekly.sql`, pinned by `scripts/test-essay-quality.mjs` |
| 2 | Cost against credits, per task | **Ruled GO, 27 September 2026.** The ceiling half is measured below. The real-spend half (0024, `ai_task_costs`, no user id and no content) is **live, 27 September 2026**: 0024 applied, functions deployed, policy promoted (#165). Run `supabase/checks/ai-cost-weekly.sql` weekly |
| 3 | Placeholder linking | Shipped in 1.3.0 (#161), with the plain control. **Grace restyles it.** Listed so it stays visible |
| 4 | Auth email failure detection | **Built, 27 September 2026.** A canary every four hours (`auth-email-canary`, migration 0025), plus app-side reports of signup and reset email failures, which the digest now reads. Setup is SUPABASE-SETUP.md §3e |

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
