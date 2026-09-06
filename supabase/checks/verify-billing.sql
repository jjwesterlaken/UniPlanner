-- VERIFY THE BILLING SCHEMA AGAINST THE LIVE DATABASE.
--
-- Paste into the Supabase SQL editor and run. It returns one row per
-- property and a final VERDICT row; nothing here writes, and nothing
-- here deletes.
--
-- WHY THIS FILE EXISTS. scripts/test-migrations.mjs applies the
-- migration FILES to a throwaway local cluster — its own header says
-- "Nothing here touches your Supabase project". It proves 0017 WOULD
-- work; it cannot observe whether 0017 WAS applied. That gap is not
-- hypothetical: production held delete_my_account_data and no
-- delete_my_account for months through a green suite, and 0005 created
-- ai_notes weeks before a single insert into it succeeded. The
-- migration file is a claim. This is the artifact.
--
-- WHAT IT COSTS TO SKIP. Deploying billing-webhook against a database
-- without 0017 does not fail loudly: the insert into billing_events
-- errors, PostgREST returns 400, the function logs it — and the student
-- who just paid gets no tier. Same shape as 0015, on the screen that
-- sells the paid tier.
--
-- An empty result is impossible by construction: the CTE emits a fixed
-- set of rows whatever the catalogue holds, so "no rows returned" means
-- the query did not run, not that everything passed.
--
-- RUN IT ONCE BEFORE APPLYING 0017 and watch it FAIL. A check nobody
-- has seen fail is a check nobody should trust.
--
-- to_regclass / to_regprocedure are used throughout rather than the
-- text forms of has_*_privilege, which RAISE when the object does not
-- exist — which is exactly the state this file is written to report.

with props as (
  -- ---- the tier constraint: the writer cannot invent a tier ----
  select 'profiles_tier_check exists' as property,
         exists (select 1 from pg_constraint
                  where conrelid = to_regclass('public.profiles')
                    and conname = 'profiles_tier_check') as ok,
         'without it the webhook could write any string; allowanceForTier would read it as the trial and nobody would know' as why
  union all
  select 'profiles_tier_check names exactly free, ai, ai_max',
         coalesce((select pg_get_constraintdef(oid) ~ 'free' and pg_get_constraintdef(oid) ~ '''ai'''
                     and pg_get_constraintdef(oid) ~ 'ai_max' and pg_get_constraintdef(oid) !~ 'plus'
                     from pg_constraint
                    where conrelid = to_regclass('public.profiles') and conname = 'profiles_tier_check'), false),
         'plus was dropped in Phase 0; a constraint still naming it means an older 0017 is applied'
  union all
  select 'no profiles row holds a tier outside the three',
         coalesce((select count(*) = 0 from public.profiles
                    where tier not in ('free', 'ai', 'ai_max')), false),
         'the constraint cannot be trusted if rows predate it — this is the same question 0017''s pre-flight asks'

  -- ---- the columns the webhook writes ----
  union all
  select 'profiles.tier_source exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'tier_source'),
         'the webhook reads this before every write; without it every event errors and no tier is ever granted'
  union all
  select 'profiles.tier_updated_at exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'tier_updated_at'),
         'written on every tier change'
  union all
  select 'profiles.entitlement_expires_at exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'entitlement_expires_at'),
         'informational; the tier is never derived from it'
  union all
  select 'profiles.store exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'store'),
         'decides which "manage your subscription" link a student is shown'
  union all
  -- READ BY NAME, NOT AS A COLUMN, and this is not a stylistic choice.
  -- `where tier_source = 'signup'` fails to PARSE on a database without
  -- the column, so the whole file errors instead of reporting the FAIL
  -- it exists to report — found by running it against a pre-0017
  -- database, which is the only way this class is ever found. It is the
  -- same trap has_function_privilege(text,text,text) sprang on
  -- verify-account-deletion.sql: a guard that raises in the broken state
  -- reports nothing about the broken state. to_jsonb(p.*) ->> 'name' is
  -- a key lookup at runtime, so a missing column reads as NULL.
  select 'no row carries a tier a human set without saying so',
         coalesce((select count(*) = 0 from public.profiles p
                    where p.tier <> 'free'
                      and coalesce(to_jsonb(p.*) ->> 'tier_source', 'signup') = 'signup'), false),
         'a hand-flipped tier left at signup will be overwritten by that account''s next webhook — set tier_source = ''manual'' with the flip'

  -- ---- billing_events ----
  union all
  select 'billing_events exists',
         to_regclass('public.billing_events') is not null,
         'the webhook records every accepted event here, and its primary key is what makes a redelivery a no-op'
  union all
  select 'billing_events.id is text, not uuid',
         coalesce((select data_type = 'text' from information_schema.columns
                    where table_schema = 'public' and table_name = 'billing_events' and column_name = 'id'), false),
         '0009: a provider-minted id crossing into a typed column rejected every insert with 22P02 for four migrations'
  union all
  select 'billing_events has RLS enabled',
         coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.billing_events')), false),
         'service_role bypasses it; RLS is what makes a future accidental grant inert rather than open'
  union all
  select 'no client role can read or write billing_events',
         coalesce((select bool_and(not has_table_privilege(r.role, to_regclass('public.billing_events'), v.verb))
                     from unnest(array['anon', 'authenticated']) as r(role),
                          unnest(array['select', 'insert', 'update', 'delete']) as v(verb)), false),
         'Supabase''s default privileges grant ALL to both roles on every table created in the SQL editor (0008)'
  union all
  select 'service_role can insert into billing_events',
         coalesce(has_table_privilege('service_role', to_regclass('public.billing_events'), 'insert'), false),
         'without it every accepted event is lost and idempotency has nothing to record'

  -- ---- the stray grants 0017 cleared ----
  union all
  select 'no stray trigger/truncate/references grants on any public table',
         coalesce((select count(*) = 0
                     from pg_class c
                     join pg_namespace n on n.oid = c.relnamespace,
                          unnest(array['anon', 'authenticated']) as r(role),
                          unnest(array['trigger', 'truncate', 'references']) as v(verb)
                    where n.nspname = 'public' and c.relkind = 'r'
                      and has_table_privilege(r.role, c.oid, v.verb)), false),
         '0008 tightened the four data verbs and left these; PostgREST exposes none of them, so this is tidying, not a hole'

  -- ---- account deletion still covers everything ----
  union all
  select 'delete_my_account_data() empties billing_events',
         coalesce((select prosrc like '%billing_events%' from pg_proc
                    where oid = to_regprocedure('public.delete_my_account_data()')::oid), false),
         'a table added without a line in the function survives an account deletion'
  union all
  select 'delete_my_account_data() names every user_id table ('
         || (select string_agg(c.table_name, ', ' order by c.table_name)
               from information_schema.columns c
              where c.table_schema = 'public' and c.column_name = 'user_id') || ')',
         coalesce((select bool_and(p.prosrc like '%' || c.table_name || '%')
                     from information_schema.columns c, pg_proc p
                    where c.table_schema = 'public' and c.column_name = 'user_id'
                      and p.oid = to_regprocedure('public.delete_my_account_data()')::oid), false),
         'derived from the catalogue, so the next table shows up here instead of being silently missed'
)
select property,
       case when ok then 'PASS' else 'FAIL' end as result,
       why
from props
union all
select '=== VERDICT ===',
       case when bool_and(ok) then 'ALL PASS' else 'FAILED — see the FAIL rows above' end,
       count(*)::text || ' properties checked'
from props
order by result desc, property;
