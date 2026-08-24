# Shipping #55: the sequence, and what proves each step landed

Every step has a check that fails loudly if the step did not work.
**Do not proceed on "the app still loads"** — the whole shape of the
0015 trap is that the app still loads.

Direction rules, so the order is derivable rather than memorised:
migrations that **WIDEN** (add a column or a function) go BEFORE the
code that needs them; migrations that **NARROW** (drop one) go AFTER
the code that stopped needing it.

---

## 0. Before anything

```bash
git fetch origin && git log --oneline -1 origin/claude/uni-planner-handoff-rw4yac
npm test
```

**Check:** the suite ends `0 failed`, and the migration tests really
ran — `grep -c "0015 is re-runnable"` in the output is 1, not 0. A
skipped migration suite is the state where none of this is verified.

---

## 1. Apply the WIDENING migrations — 0011, 0012, 0014, 0015

Supabase dashboard → SQL Editor. Paste each file's contents in this
order, one at a time. All four are re-runnable.

**0012 must run before 0013 ever does.** Its backfill is what carries
the two old counters into `credits_used`; 0013 drops the columns it
reads. That is the one ordering mistake in this whole sequence that
loses data rather than causing an outage.

**Check after each:**

```sql
-- 0011
select proname from pg_proc where proname = 'add_ai_usage';           -- 1 row
-- 0012
select column_name from information_schema.columns
 where table_schema='public' and table_name='ai_usage' and column_name='credits_used';   -- 1 row
select proname from pg_proc where proname = 'add_ai_credits';         -- 1 row
-- 0014
select column_name from information_schema.columns
 where table_schema='public' and table_name='profiles' and column_name='trial_credits_used';  -- 1 row
select proname from pg_proc where proname = 'add_trial_credits';      -- 1 row
```

### 1a. The 0015 check — this is the one that gets missed

```sql
select column_name from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'profiles'
   and column_name in ('active_device_id', 'active_device_at');
```

**Expect exactly 2 rows.** One row or zero means `fetchUsage`'s select
will 400, which the client reads as `unavailable` — the allowance badge
vanishes and the text features report an unknown allowance, with no
error anywhere and the app apparently working.

Then run the client's actual query, character for character, because a
column existing is not the same as that select succeeding:

```sql
select tier, trial_credits_used, active_device_id, active_device_at
  from public.profiles limit 1;
```

**Expect it to return** (0 rows is fine — an empty table still proves
the columns resolve). An error here is the failure, in the exact shape
the client will meet it.

```sql
select has_function_privilege('authenticated', 'public.claim_device(text)', 'execute');  -- true
select has_function_privilege('anon',          'public.claim_device(text)', 'execute');  -- false
```

---

## 2. Deploy both Edge Functions

GitHub → Actions → **Deploy functions** → Run workflow.

**Check:** the run is green AND its log names **both** `ai-notes` and
`ai-text`. The workflow used to name one while the repo had two, and a
deploy that ships half of what you think is the failure this check
exists for.

---

## 3. Verify a real action bills the NEW counter — before 0013

Sign in on the deployed web app, run one cheap AI action (an
explain-it-back is a single credit), then:

```sql
select user_id, month, credits_used, updated_at
  from public.ai_usage order by updated_at desc limit 5;
```

**Expect a row whose `credits_used` moved just now.** If it did not,
`add_ai_credits` is not being called — stop here. Do not apply 0013:
the old columns are the only working billing path until the functions
are right, and dropping them turns a visible problem into free AI.

---

## 4. Promote the web app

```bash
npm run promote
```

**Check** the build id really moved, which is the only evidence a
deploy arrived:

```bash
curl -s https://www.uniplannerapp.com/sw.js | grep 'const CACHE'
```

Compare against the Account tab in a hard-reloaded browser. They must
match. Production lagging `main` is the designed state *between*
promotes; production not moving *after* one is a broken deploy.

**Then re-check the badge**, because this is the first moment the new
client meets the new database: open the AI tab and confirm the
allowance line is present and shows a number. A missing badge here is
step 1a's failure surfacing late.

---

## 5. Apply 0013 — the NARROWING one — last

```sql
-- after promote, not before
select column_name from information_schema.columns
 where table_schema='public' and table_name='ai_usage'
   and column_name in ('minutes_used','text_units_used');   -- 0 rows
select proname from pg_proc where proname = 'add_ai_usage'; -- 0 rows
```

**Then repeat step 3's check.** Billing must still work after the drop;
if it stopped, something was still reading the old columns.

---

## 6. Cut the AAB

```bash
git checkout main && git pull
npm run build            # build:web && prepare:native
ls mobile/www
```

**Check:** no `site`, no `measure-audio.html`. Both were in the
submitted iOS build; this is the tree that fixes it.

```bash
cd mobile && npx cap add android && npm run settings
```

**Check the stamp output for the targetSdkVersion line** — it prints
either `target SDK 36 meets the Play requirement` or a WARNING. That
number is set by Capacitor's template, not by us, and being below it
blocks submission outright.

---

## If 0013 is applied too early

**Recover by rolling FORWARD, not back.** The dropped objects cannot be
restored, but nothing is lost as long as 0012 ran first — its backfill
already copied both counters into `credits_used`.

| What broke | Symptom | Fix |
|---|---|---|
| Functions not yet deployed | `add_ai_usage` gone → billing fails. **CLAUDE.md's note applies: it is logged at the billing stage and does NOT fail the request** — students get their work and we charge nothing. Expensive, and invisible unless someone reads the logs | deploy both functions (step 2) immediately |
| Web not yet promoted | the old client selects `minutes_used` → 400 → badge disappears | `npm run promote` (step 4) |

**The one unrecoverable case is 0013 before 0012**, because then the
counters are dropped without ever being backfilled and the usage
history is gone for good. There is no undo. If that happens, say so
rather than reconstructing figures — a wrong allowance is worse than a
reset one.

Both recoveries are minutes. The reason 0013 is last is not that it is
dangerous in itself; it is that every failure it causes is silent.
