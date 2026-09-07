-- ---------------------------------------------------------------------
-- 0020 — one row per provider, so a tier is a MAX and not a race
--
-- WIDENS. A new table and a re-created deletion helper, so this goes
-- BEFORE the functions that write it — the 0003/0004/0015/0018/0019
-- direction. Applying it early is inert: nothing reads or writes the
-- table until the Edge Functions carrying the new applyEntitlement are
-- deployed, and until then profiles.tier keeps being written exactly as
-- it is today.
--
-- THE BUG THIS EXISTS TO CLOSE, and it was DOCUMENTED AS ACCEPTED in
-- _shared/entitlement.ts rather than handled — which is this project's
-- own "a rule written beside one caller is not a guard", one more time.
--
-- Each webhook re-reads only ITS OWN provider and then writes
-- profiles.tier outright. So for a student paying through Stripe who
-- ALSO has a lapsing App Store subscription from last year:
--
--   1. Stripe renews          -> profiles.tier = 'ai'    (correct)
--   2. Apple EXPIRATION lands -> RevenueCat is re-read, holds nothing
--                                active, tierFromSubscriber returns
--                                'free', and 'free' is WRITTEN OVER a
--                                live, paid Stripe entitlement.
--
-- The student is being charged and has lost the thing they are paying
-- for, and nothing errors. The old comment pointed at billing-checkout's
-- store_subscription_active refusal as closing "the door we control" —
-- but that refusal only stops a NEW Stripe checkout while a store
-- subscription is live. It does nothing about the reverse order (Stripe
-- first, then Apple), and nothing at all about an OLD store
-- subscription expiring months later. A refusal on one door is not a
-- guard on the other.
--
-- THE SHAPE: record the FACT per provider, DERIVE the answer.
-- profiles.tier stops being a thing each webhook writes and becomes a
-- projection of these rows — the highest tier any provider currently
-- grants. Two consequences worth stating, because they are the whole
-- design:
--
--   * A provider can only ever speak for ITSELF. An expiry writes
--     ('revenuecat', 'free') and cannot touch the stripe row, so it can
--     no longer demote across a boundary it knows nothing about.
--   * A DEMOTION IS STILL POSSIBLE, which is the half a max gets wrong
--     if nobody checks. The last live row going to 'free' takes the
--     account to 'free', because the max is over rows that are STILL
--     LIVE at write time. A test named for that runs alongside the two
--     orderings, because "never goes down" is what a careless max buys.
--
-- WHY A TABLE RATHER THAN TWO MORE COLUMNS ON profiles. A third
-- provider is a row, not a migration; the PK is what makes a redelivery
-- idempotent; and "which providers does this account have" is a query
-- rather than a set of nullable column pairs that can disagree.
--
-- NO CLIENT ACCESS AT ALL. RLS is on and there are no policies, and no
-- grants to anon or authenticated — the 0008 rule, which is that a
-- granted verb with no policy is never useful and is how `update` sat
-- open on ai_notes for months. The service role bypasses RLS and is the
-- only writer, exactly as it is for the tier columns it feeds. A
-- student sees their plan through profiles.tier, which is what every
-- screen already reads.
-- ---------------------------------------------------------------------

create table if not exists public.entitlements (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  -- The provider that asserted this. Same two strings as
  -- ENTITLEMENT_SOURCES in _shared/entitlement.ts and the same two
  -- 0017's tier_source CHECK accepts for an automated writer.
  source     text        not null check (source in ('revenuecat', 'stripe')),
  tier       text        not null check (tier in ('free', 'ai', 'ai_max')),
  -- Which store this provider says the subscription lives in, so the
  -- WINNING row decides the "manage your subscription" link. Nullable
  -- for the same reason profiles.store is: an unrecognised store is
  -- null rather than coerced to the nearest match.
  store      text,
  -- NULL means non-expiring, matching isActive()'s reading of a null
  -- expires_date. A row whose expiry has passed does not count toward
  -- the max, which is the backstop for a provider that stops sending
  -- events entirely.
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.entitlements enable row level security;

comment on table public.entitlements is
  'What each payment provider currently says this account is entitled to. profiles.tier is the MAX over the live rows here, so a provider can only ever speak for itself: an App Store expiry writes (revenuecat, free) and cannot demote a live Stripe subscription. Written only by applyEntitlement() under the service role. No RLS policies and no grants: nothing client-side reads this, and a student sees their plan through profiles.tier.';

revoke all on public.entitlements from anon, authenticated;
grant select, insert, update, delete on public.entitlements to service_role;

-- ---------------------------------------------------------------------
-- The deletion helper has to empty it too
-- ---------------------------------------------------------------------
--
-- Re-created rather than altered, the way 0005, 0007, 0010 and 0017 each
-- did as tables arrived. That is a restatement and restatements drift —
-- AND THIS ONE DID, WHILE BEING WRITTEN: the first draft copied 0010's
-- body, which predates billing_events, so it silently dropped a table
-- 0017 had added. Two independent guards caught it in the same run (the
-- migration suite's derived sweep, and 0017's own self-check), which is
-- the whole argument for both being behavioural: they enumerate every
-- public table with a user_id column FROM THE DATABASE rather than
-- comparing this file to a list. **Copy the body from the LATEST
-- migration that defines it, never from the one you happen to have
-- open.**
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

  -- Ordered most-sensitive first, so a mid-statement failure leaves the
  -- least sensitive data behind rather than the most. An archive holds
  -- an entire semester of the student's work, so it sits with ai_notes
  -- at the top; error reports hold no student content, so they go last.
  delete from public.ai_notes where user_id = uid;
  delete from public.semester_archives where user_id = uid;
  delete from public.ai_notes_requests where user_id = uid;
  delete from public.ai_usage where user_id = uid;
  delete from public.entitlements where user_id = uid;
  delete from public.profiles where user_id = uid;

  if pg_catalog.to_regclass('public.planner_data') is not null then
    execute 'delete from public.planner_data where user_id = $1' using uid;
  end if;

  delete from public.client_errors where user_id = uid;
  delete from public.billing_events where user_id = uid;

  -- Staged lecture audio is removed by the client through the Storage
  -- API before this runs (see src/accountDeletion.js), because a SQL
  -- delete on storage.objects leaves the file in the backing store.
end;
$$;

-- NO revoke/grant HERE, AND THAT IS DELIBERATE. `create or replace`
-- PRESERVES the existing ACL, so re-asserting it would change nothing
-- functionally — and it would destroy a diagnostic. 0002 is the ONLY
-- migration that revokes PUBLIC's execute on this function, which is
-- what lets a database be asked "did 0002 ever run here?": a data
-- function created by a later migration on a project that skipped 0002
-- still carries PostgreSQL's default EXECUTE-to-PUBLIC. That
-- fingerprint is how the missing delete_my_account() was dated, and a
-- test in test-migrations.mjs depends on it. 0005, 0007 and 0010 each
-- re-created this function without re-granting, for the same reason.

-- ---------------------------------------------------------------------
-- The self-check
-- ---------------------------------------------------------------------
--
-- 0016's lesson: an apply must not be able to report success while the
-- end state is wrong. The last three are BEHAVIOURAL — they perform the
-- two-provider write, the redelivery that must not duplicate it, and
-- the cascade — then remove the probes. A DO block is one statement, so
-- a failure anywhere below rolls the whole thing back, probes included.
do $$
declare
  checked int := 0;
  a uuid := '00000000-0000-4000-8000-0000000020a1';
  n int;
begin
  if pg_catalog.to_regclass('public.entitlements') is null then
    raise exception '0020 FAILED: public.entitlements does not exist.';
  end if;
  checked := checked + 1;

  -- THE PRIMARY KEY IS THE IDEMPOTENCY. A redelivered event writes the
  -- same (user, source) and must update rather than accumulate, or the
  -- max would be taken over a growing pile of stale assertions.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.entitlements'::regclass and contype = 'p'
      and (select array_agg(att.attname order by att.attname)
             from pg_catalog.pg_attribute att
            where att.attrelid = conrelid and att.attnum = any(conkey)) = array['source', 'user_id']::name[]
  ) then
    raise exception '0020 FAILED: entitlements is not keyed on (user_id, source), so a redelivery would add a row.';
  end if;
  checked := checked + 1;

  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.entitlements'::regclass and relrowsecurity
  ) then
    raise exception '0020 FAILED: row level security is not enabled on entitlements.';
  end if;
  checked := checked + 1;

  -- NOTHING CLIENT-SIDE MAY READ IT. RLS with no policies would already
  -- return nothing, but a grant with no policy is how a privilege sits
  -- open unnoticed (0008), so the grant is checked as well.
  if has_table_privilege('anon', 'public.entitlements', 'select')
     or has_table_privilege('authenticated', 'public.entitlements', 'select') then
    raise exception '0020 FAILED: anon or authenticated can select from entitlements.';
  end if;
  checked := checked + 1;

  -- The deletion helper must name it, checked against the SOURCE of the
  -- function that is really installed rather than against this file.
  if position('public.entitlements' in
              pg_catalog.pg_get_functiondef('public.delete_my_account_data()'::regprocedure)) = 0 then
    raise exception '0020 FAILED: delete_my_account_data() does not delete from entitlements.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: two providers coexist on one account, and a
  -- redelivery of either updates its own row rather than adding one.
  insert into auth.users (id) values (a);
  insert into public.entitlements (user_id, source, tier) values (a, 'revenuecat', 'free');
  insert into public.entitlements (user_id, source, tier) values (a, 'stripe', 'ai');
  insert into public.entitlements (user_id, source, tier) values (a, 'revenuecat', 'ai_max')
    on conflict (user_id, source) do update set tier = excluded.tier;
  select count(*) into n from public.entitlements where user_id = a;
  if n <> 2 then
    raise exception '0020 FAILED: expected 2 provider rows after a redelivery, found %.', n;
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: deleting the account takes the rows with it, so a
  -- delete-and-resignup cannot inherit a stranger's entitlement.
  delete from auth.users where id = a;
  select count(*) into n from public.entitlements where user_id = a;
  if n <> 0 then
    raise exception '0020 FAILED: % entitlement rows survived the account being deleted.', n;
  end if;
  checked := checked + 1;

  if checked <> 7 then
    raise exception '0020 FAILED: only % of 7 properties were checked.', checked;
  end if;

  raise notice '0020 applied and verified: % properties checked.', checked;
end;
$$;
