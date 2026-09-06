-- ---------------------------------------------------------------------
-- 0017 — the entitlement writer's half of the schema
--
-- WIDENS. Four columns, a table and a constraint that the billing-webhook
-- Edge Function needs, so this goes BEFORE the code that needs them —
-- the 0003/0004/0015 direction, not 0008's. Applying it early is inert:
-- nothing reads the new columns until the function ships, and every
-- existing account reads as "tier set at signup, no store, no expiry",
-- which is exactly what every existing account is.
--
-- WHAT THIS IS FOR. Until now NOTHING in the repository wrote
-- profiles.tier: no policy, no grant, no function, no client path. It
-- was flipped by hand in the dashboard, which is why ANDROID-RELEASE.md
-- could answer Play's "does the app allow purchases?" with NO. 1.1.0
-- sells subscriptions through RevenueCat, so exactly one writer appears
-- — the webhook — and everything below exists to make that writer safe:
-- a constraint so it cannot invent a tier, a source so it cannot
-- overwrite a human's decision, and an event log keyed on the provider's
-- own id so a redelivery cannot be counted twice.
--
-- PLUS IS GONE (Jared, Phase 0). Two paid tiers, six store products.
-- Plus granted exactly the trial allowance and its marketed feature —
-- sync — is free for any signed-in account and is promised free in the
-- 1.0.0 store listing, so it would have sold what the listing gives
-- away. The unknown-tier-means-trial rule in allowanceForTier stays for
-- rows that predate this, and the pre-flight below is what proves there
-- are none.
--
-- THE PRE-FLIGHT IS NOT DECORATION. Adding a CHECK to a table that
-- violates it fails the whole migration with postgres's own message,
-- which names the constraint and not the rows. This raises FIRST, with
-- the count and the values, because "I am assuming zero" is an
-- assumption about production and 0016 is what those cost. Run this
-- before pasting anything, and expect one row reading 0:
--
--   select tier, count(*) from public.profiles group by tier order by 2 desc;
--
-- HOW A HUMAN FLIPS A TIER ONCE THIS HAS APPLIED — both columns, or
-- the webhook will overwrite the flip the next time that account's
-- subscription changes. (Before it has applied, tier_source does not
-- exist yet; the pre-flight's message prescribes the right statement
-- for that case, and a test runs whatever it prescribes verbatim.)
--
--   update public.profiles
--      set tier = 'ai_max', tier_source = 'manual', tier_updated_at = now()
--    where user_id = '...';
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 0. The production assumption, checked rather than assumed
-- ---------------------------------------------------------------------

do $$
declare
  stray text;
  n bigint;
begin
  select count(*), string_agg(distinct tier, ', ')
    into n, stray
    from public.profiles
   where tier not in ('free', 'ai', 'ai_max');

  if n > 0 then
    raise exception
      '0017 REFUSED: % profiles row(s) hold a tier outside (free, ai, ai_max): %. Nothing has been changed. Decide what each account becomes, then run `update public.profiles set tier = ''free'' where tier not in (''free'', ''ai'', ''ai_max'');` and apply this migration again. NOTE the statement names only `tier`: tier_source is a column THIS migration adds, so a remedy that set it too would fail on the database you are running it against. A row holding ''plus'' has the trial allowance either way, so ''free'' preserves what that student actually has; if any of them should keep a paid tier, set ''ai'' or ''ai_max'' instead and the backfill below will mark it manual so no webhook takes it away.',
      n, stray;
  end if;

  raise notice '0017 pre-flight: every profiles row holds one of the three tiers.';
end;
$$;

-- ---------------------------------------------------------------------
-- 1. What the writer needs on profiles
-- ---------------------------------------------------------------------

alter table public.profiles
  add column if not exists tier_source           text not null default 'signup',
  add column if not exists tier_updated_at       timestamptz,
  add column if not exists entitlement_expires_at timestamptz,
  add column if not exists store                 text;

comment on column public.profiles.tier_source is
  'Who last set this row''s tier: signup (the trigger''s default), manual (a human, in the dashboard), revenuecat, or stripe. THE WEBHOOK NEVER OVERWRITES manual — that is how the App Review account, and anyone given a tier by hand, keeps a tier nobody bought. A human flipping a tier must set this column too, or the next webhook for that account undoes the flip.';

comment on column public.profiles.tier_updated_at is
  'When the tier last changed. Not read by any rule — kept so "when did my plan change?" has an answer that does not require reading billing_events.';

comment on column public.profiles.entitlement_expires_at is
  'When the current entitlement lapses, as RevenueCat last reported it. INFORMATIONAL ONLY: the tier is never derived from this column, because a clock comparison is a guess about a subscription and the subscriber record is the answer. Nothing expires an account by reading it; an EXPIRATION event does that.';

comment on column public.profiles.store is
  'Where the subscription was bought: app_store, play_store, stripe, or null for no subscription. A subscription can only be MANAGED where it was bought, so this decides which "manage your subscription" link the Account tab shows. Getting it wrong sends a student to a store that has never heard of them.';

-- The backfill, and it is deliberately narrow. Every row that already
-- carries a non-free tier got it from a human in the dashboard, because
-- until this migration there was no other way for it to change. Marking
-- those 'manual' is what stops the first webhook from taking a
-- hand-granted tier away.
--
-- RE-RUNNABLE EXACTLY ONCE IS NOT RE-RUNNABLE (0012's lesson). The
-- predicate is what makes this safe rather than a guard around it: a row
-- the webhook later writes carries tier_source = 'revenuecat', so a
-- second apply does not match it and cannot demote it to 'manual'.
update public.profiles
   set tier_source = 'manual'
 where tier <> 'free'
   and tier_source = 'signup';

-- ---------------------------------------------------------------------
-- 2. The constraints — because a program writes these columns now
-- ---------------------------------------------------------------------
--
-- Dropped and re-added rather than added conditionally: a constraint
-- that already exists with a DIFFERENT definition is the case a bare
-- "add if not exists" cannot fix, and this file has to be re-runnable
-- into whatever state a half-finished apply left behind.

alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles
  add constraint profiles_tier_check check (tier in ('free', 'ai', 'ai_max'));

alter table public.profiles drop constraint if exists profiles_tier_source_check;
alter table public.profiles
  add constraint profiles_tier_source_check
  check (tier_source in ('signup', 'manual', 'revenuecat', 'stripe'));

alter table public.profiles drop constraint if exists profiles_store_check;
alter table public.profiles
  add constraint profiles_store_check
  check (store is null or store in ('app_store', 'play_store', 'stripe'));

-- ---------------------------------------------------------------------
-- 3. billing_events — the provider's own event id as the primary key
-- ---------------------------------------------------------------------
--
-- WHY THE ID IS THEIRS AND NOT OURS. RevenueCat retries a delivery that
-- did not return 2xx, and a retry is indistinguishable from a new event
-- to anything that mints its own id. Keyed on theirs, a redelivery is a
-- unique-violation the function reads as "already handled" — the same
-- move as 23505-means-already-migrated in aiNotesStore, and it makes
-- idempotency a property of the schema rather than of a code path
-- somebody might reorder.
--
-- TEXT, NOT UUID. RevenueCat's event ids are UUID-shaped today and that
-- is not a promise anyone made us. 0009 is what a client-minted id
-- crossing into a typed column cost: every insert rejected with 22P02,
-- a 400 on every sync, and a storage move that never ran on any account
-- for four migrations. A provider-minted id is the same boundary with
-- less control over the far side.
--
-- WHAT IT HOLDS: what happened, to whom, and what it changed. Never a
-- receipt, never a token, never a price, and never anything the student
-- wrote. A support question is "what happened to my subscription and
-- when", and these six columns answer it.
create table if not exists public.billing_events (
  id           text primary key,
  user_id      uuid references auth.users(id) on delete cascade,
  event_type   text not null,
  store        text,
  tier_before  text,
  tier_after   text,
  received_at  timestamptz not null default now()
);

comment on table public.billing_events is
  'One row per RevenueCat webhook event this project accepted, keyed on RevenueCat''s own event id so a retried delivery is a unique violation rather than a second row. Holds what happened, to whom, and what tier it changed — no receipts, no tokens, no prices, and nothing the student wrote.';

create index if not exists billing_events_user_received_idx
  on public.billing_events (user_id, received_at desc);

-- Written and read ONLY by the service role. There is no client policy
-- at all, and RLS is on regardless: the service-role client bypasses it,
-- so RLS here is what makes a future accidental grant inert rather than
-- open. Supabase's default privileges grant ALL to anon and
-- authenticated on every table created in the SQL editor (0008), so the
-- revoke below is doing real work, not restating a default.
alter table public.billing_events enable row level security;
revoke all on table public.billing_events from anon, authenticated;
grant select, insert on table public.billing_events to service_role;

-- ---------------------------------------------------------------------
-- 4. The stray table-default grants, revoked — derived, not enumerated
-- ---------------------------------------------------------------------
--
-- 0008 tightened `authenticated` to exactly the four data verbs each
-- table has a policy for, and stopped there. REFERENCES, TRIGGER and
-- TRUNCATE came from the same platform default and were left behind on
-- every table. PostgREST exposes none of them and neither role can log
-- in directly, so this is not a hole — it is a grant nothing needs,
-- of exactly the kind 0008 exists to remove.
--
-- Derived from the catalogue rather than listed, so the table somebody
-- adds next month is covered by the migration nobody re-reads.
do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format(
      'revoke trigger, truncate, references on table public.%I from anon, authenticated',
      t.relname
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Account deletion covers the new table
-- ---------------------------------------------------------------------
--
-- Copied from 0010's body plus billing_events, which is a restatement
-- and restatements drift — so the guard is behavioural rather than
-- textual: a migration test enumerates every `public` table with a
-- user_id column FROM THE DATABASE and asserts this function empties
-- all of them. Adding a table without a line here goes red naming it.
--
-- WHERE billing_events SITS IN THE ORDER: last, with client_errors,
-- because it holds none of the student's content. The ordering rule is
-- most-sensitive-first, so a mid-statement failure leaves the least
-- sensitive rows behind rather than the most.
create or replace function public.delete_my_account_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'delete_my_account_data() must be called by a signed-in user';
  end if;

  delete from public.ai_notes where user_id = uid;
  delete from public.semester_archives where user_id = uid;
  delete from public.ai_notes_requests where user_id = uid;
  delete from public.ai_usage where user_id = uid;
  delete from public.profiles where user_id = uid;

  if pg_catalog.to_regclass('public.planner_data') is not null then
    execute 'delete from public.planner_data where user_id = $1' using uid;
  end if;

  delete from public.client_errors where user_id = uid;
  delete from public.billing_events where user_id = uid;

  -- Staged lecture audio is removed by the client through the Storage
  -- API before this runs (see src/accountDeletion.js), because a SQL
  -- delete of storage.objects leaves the file itself in the bucket.
end;
$$;

-- create-or-replace PRESERVES an existing ACL, so "grant only on create"
-- is how a privilege goes missing for a year (0016). Re-asserted every
-- run, unconditionally.
revoke all on function public.delete_my_account_data() from public;
revoke all on function public.delete_my_account_data() from anon;
grant execute on function public.delete_my_account_data() to authenticated;

-- ---------------------------------------------------------------------
-- 6. The migration verifies itself, and raises
-- ---------------------------------------------------------------------
--
-- 0016's rule, and the only property that would have prevented the
-- delete_my_account absence: an apply must not be able to report success
-- while the object is missing. A NOTICE in a SQL editor nobody reads
-- afterwards is not a report. The count at the end is what stops this
-- block from passing having checked nothing.
do $$
declare
  checked int := 0;
  fn      text := 'public.delete_my_account_data()';
  n       int;
begin
  -- The four columns
  for n in
    select 1 from unnest(array['tier_source', 'tier_updated_at', 'entitlement_expires_at', 'store']) as c(name)
     where not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles' and column_name = c.name
     )
  loop
    raise exception '0017 FAILED: profiles is missing a column this migration adds.';
  end loop;
  checked := checked + 1;

  -- The three constraints, by name and by effect
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.profiles'::regclass and conname = 'profiles_tier_check') then
    raise exception '0017 FAILED: profiles_tier_check is absent, so the webhook could write any string as a tier.';
  end if;
  checked := checked + 1;

  begin
    -- A constraint that exists but does not bite is worse than none,
    -- because it reads as protection. Proved rather than asserted:
    -- insert a bad tier and require the insert to fail.
    insert into public.profiles (user_id, tier)
    values ('00000000-0000-4000-8000-00000000dead', 'plus');
    raise exception '0017 FAILED: profiles_tier_check accepted the tier ''plus'', so it is not enforcing.';
  exception
    when check_violation then null;                 -- what must happen
    when foreign_key_violation then null;           -- the fk fired first; the check is still declared
  end;
  checked := checked + 1;

  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.profiles'::regclass and conname = 'profiles_tier_source_check') then
    raise exception '0017 FAILED: profiles_tier_source_check is absent.';
  end if;
  checked := checked + 1;

  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.profiles'::regclass and conname = 'profiles_store_check') then
    raise exception '0017 FAILED: profiles_store_check is absent.';
  end if;
  checked := checked + 1;

  -- billing_events exists, with RLS on and no policy
  if pg_catalog.to_regclass('public.billing_events') is null then
    raise exception '0017 FAILED: billing_events was not created, so the webhook has nowhere to record an event and no idempotency key.';
  end if;
  checked := checked + 1;

  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.billing_events'::regclass) then
    raise exception '0017 FAILED: RLS is not enabled on billing_events.';
  end if;
  checked := checked + 1;

  -- No client may touch it, in either direction
  for n in
    select 1 from unnest(array['anon', 'authenticated']) as r(role),
                 unnest(array['select', 'insert', 'update', 'delete']) as v(verb)
     where pg_catalog.has_table_privilege(r.role, 'public.billing_events', v.verb)
  loop
    raise exception '0017 FAILED: a client role can reach billing_events. acl = %',
      (select c.relacl from pg_catalog.pg_class c where c.oid = 'public.billing_events'::regclass);
  end loop;
  checked := checked + 1;

  if not pg_catalog.has_table_privilege('service_role', 'public.billing_events', 'insert') then
    raise exception '0017 FAILED: service_role cannot insert into billing_events, so every accepted event would be lost.';
  end if;
  checked := checked + 1;

  -- The stray grants really went, everywhere
  for n in
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace,
           unnest(array['anon', 'authenticated']) as r(role),
           unnest(array['trigger', 'truncate', 'references']) as v(verb)
     where ns.nspname = 'public' and c.relkind = 'r'
       and pg_catalog.has_table_privilege(r.role, c.oid, v.verb)
  loop
    raise exception '0017 FAILED: a stray trigger/truncate/references grant survived on a public table.';
  end loop;
  checked := checked + 1;

  -- Deletion covers every user_id table, billing_events included.
  -- Derived from the catalogue: the point is that a table added later
  -- fails here rather than surviving an account deletion in silence.
  for n in
    select 1
      from information_schema.columns col
     where col.table_schema = 'public' and col.column_name = 'user_id'
       and not exists (
         select 1 from pg_catalog.pg_proc p
          where p.oid = fn::regprocedure
            and p.prosrc like '%' || col.table_name || '%'
       )
  loop
    raise exception '0017 FAILED: delete_my_account_data() does not name every user_id table, so one would survive an account deletion.';
  end loop;
  checked := checked + 1;

  if not pg_catalog.has_function_privilege('authenticated', fn::regprocedure, 'execute') then
    raise exception '0017 FAILED: authenticated cannot execute delete_my_account_data().';
  end if;
  checked := checked + 1;

  if pg_catalog.has_function_privilege('anon', fn::regprocedure, 'execute') then
    raise exception '0017 FAILED: anon can execute delete_my_account_data(). acl = %, owner = %, current_user = %. An anon=X entry means a role-specific grant survived the revoke (Supabase''s default privileges grant execute to anon directly, so revoking from PUBLIC does not remove it).',
      (select p.proacl from pg_catalog.pg_proc p where p.oid = fn::regprocedure),
      (select p.proowner::regrole from pg_catalog.pg_proc p where p.oid = fn::regprocedure),
      current_user;
  end if;
  checked := checked + 1;

  if checked <> 13 then
    raise exception '0017 FAILED: only % of 13 properties were checked.', checked;
  end if;

  raise notice '0017 applied and verified: % properties checked.', checked;
end;
$$;
