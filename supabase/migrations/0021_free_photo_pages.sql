-- ---------------------------------------------------------------------
-- 0021 — the trial's photographed-page cap
--
-- WIDENS. One column and one function the new code calls, so this goes
-- BEFORE the deploy that needs it — the 0003/0004 direction, not 0008's.
-- Applying it early is inert: nothing reads the column until the Edge
-- Function ships, and every existing account reads as 0 pages used,
-- which is the state they are all already in.
--
-- APPLYING IT LATE IS NOT INERT, which is the half worth stating.
-- ai-text selects this column in its tier lookup, and PostgREST answers
-- an unknown column with a 400 — which the handler reports as
-- server_error, so EVERY text AI feature stops for everybody. That is
-- 0015's lesson (a quiet regression on the screens that sell the paid
-- tier) with a louder failure mode.
--
-- WHAT IT IS FOR. A photo batch is 18 credits and the trial is 60, so a
-- free account can spend three batches — 54 of its 60 credits — on
-- photographs and never record the lecture that is the other half of
-- what is being sold. credits.ts now says a trial DEMONSTRATES one
-- batch; this is what makes that true rather than aspirational. Two
-- batches, so a student who wants a second opinion gets one.
--
-- PAGES RATHER THAN BATCHES, because pages are what a student picks and
-- what a refusal has to count in: a partial batch of three is still
-- three pages of somebody's reading, and a cap counted in batches would
-- let 3 + 3 + 3 through as "two batches".
--
-- PAID TIERS ARE NOT CAPPED. Credits meter them, and a cap on top of a
-- meter is a second limit to explain and a second one to get wrong.
-- ---------------------------------------------------------------------

alter table public.profiles
  add column if not exists trial_photo_pages_used integer not null default 0;

comment on column public.profiles.trial_photo_pages_used is
  'Photographed pages this account has ever sent to ai-text, for the trial cap in _shared/credits.ts (MAX_FREE_PHOTO_PAGES). A LIFETIME counter with no month in it, for the same reason trial_credits_used is a column here rather than a row in ai_usage: a sentinel month is invisible to every query that filters on the current one, which would report the cap as unspent for ever. Paid tiers are not capped and this column is simply never read for them.';

-- ---------------------------------------------------------------------
-- add_trial_photo_pages — atomic, like every other counter here.
--
-- A SEPARATE FUNCTION rather than a parameter on add_trial_credits, and
-- the reason is mechanical: adding a parameter creates an OVERLOAD
-- rather than replacing the function (create or replace matches on the
-- argument list), and two overloads is an ambiguity waiting for a
-- caller that omits the default. One more function is cheaper than one
-- ambiguous one.
--
-- THE COST OF THAT: credits and pages are two writes, so a crash
-- between them leaves an account billed for a batch whose pages were
-- not counted. Bounded at one batch, in the student's favour, and the
-- alternative — pages first — would count pages for work that was never
-- billed, which is the same size of error in the direction that annoys
-- somebody. Stated rather than hidden; it is the aiNotesStore ordering
-- rule applied to two counters instead of two stores.
-- ---------------------------------------------------------------------

create or replace function public.add_trial_photo_pages(
  p_user_id uuid,
  p_pages integer default 0
)
-- Not the column name: an output parameter shadows a column of the same
-- name in a `language sql` function, and `returning
-- trial_photo_pages_used` would then be ambiguous. Same trap 0014 hit.
returns table (new_trial_photo_pages integer)
language sql
-- SECURITY INVOKER by default, as add_trial_credits is, and for the
-- same reason: the caller names the user, so definer would turn a
-- leaked execute grant into "spend anybody's cap".
set search_path = public, pg_catalog
as $$
  update public.profiles
     set trial_photo_pages_used = profiles.trial_photo_pages_used + coalesce(p_pages, 0)
   where profiles.user_id = p_user_id
  returning profiles.trial_photo_pages_used;
$$;

comment on function public.add_trial_photo_pages(uuid, integer) is
  'Adds to an account''s LIFETIME photographed-page count atomically and returns the new total. Service-role only. Like add_trial_credits this can only ever go up and is never reset by a month rolling over.';

revoke all on function public.add_trial_photo_pages(uuid, integer) from public;
revoke all on function public.add_trial_photo_pages(uuid, integer) from anon;
revoke all on function public.add_trial_photo_pages(uuid, integer) from authenticated;
grant execute on function public.add_trial_photo_pages(uuid, integer) to service_role;

-- ---------------------------------------------------------------------
-- THE MIGRATION VERIFIES ITSELF AND RAISES.
--
-- 0016's lesson: an apply that reports success having done nothing is
-- unobservable, and a NOTICE in a SQL editor nobody reads afterwards is
-- not a report. The count is asserted too, so the block cannot pass
-- having checked nothing.
--
-- `revoke ... from public` DOES NOT REMOVE A ROLE-SPECIFIC GRANT, which
-- is why anon is revoked by name above and checked by name here:
-- Supabase's default privileges grant execute on new functions directly
-- to anon, and revoking from PUBLIC leaves that entry standing.
-- ---------------------------------------------------------------------

do $$
declare
  checks int := 0;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name = 'trial_photo_pages_used'
  ) then
    raise exception '0021: profiles.trial_photo_pages_used was not created';
  end if;
  checks := checks + 1;

  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name = 'trial_photo_pages_used') <> 'NO' then
    raise exception '0021: trial_photo_pages_used is nullable; a null counter reads as unspent for ever';
  end if;
  checks := checks + 1;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'add_trial_photo_pages'
  ) then
    raise exception '0021: add_trial_photo_pages() was not created';
  end if;
  checks := checks + 1;

  if not has_function_privilege('service_role',
        'public.add_trial_photo_pages(uuid, integer)'::regprocedure, 'execute') then
    raise exception '0021: service_role cannot execute add_trial_photo_pages(); the cap would never be counted';
  end if;
  checks := checks + 1;

  if has_function_privilege('anon',
        'public.add_trial_photo_pages(uuid, integer)'::regprocedure, 'execute') then
    raise exception '0021: anon can execute add_trial_photo_pages(); the revoke did not take';
  end if;
  checks := checks + 1;

  if has_function_privilege('authenticated',
        'public.add_trial_photo_pages(uuid, integer)'::regprocedure, 'execute') then
    raise exception '0021: authenticated can execute add_trial_photo_pages(); the revoke did not take';
  end if;
  checks := checks + 1;

  if checks < 6 then
    raise exception '0021: only % checks ran — the verification is not checking what it claims', checks;
  end if;
  raise notice '0021 verified: % checks passed', checks;
end $$;

-- ---------------------------------------------------------------------
-- NO NEW TABLE, so delete_my_account_data() needs no change: it already
-- empties public.profiles, and a migration test enumerates every table
-- with a user_id column FROM THE DATABASE to prove nothing was missed.
--
-- AND THAT REOPENS THE SAME HOLE THE TRIAL ALREADY HAS, deliberately:
-- deleting the account clears the page count along with everything
-- else, so delete-and-resignup resets the cap. There is no clean fix
-- that keeps both promises — retaining a per-email counter after a
-- deletion request is retaining personal data after a deletion request
-- — and it costs about two cents an abuse and a fresh confirmed email
-- each time. Recorded here so nobody later "fixes" it by keeping
-- something behind.
-- ---------------------------------------------------------------------
