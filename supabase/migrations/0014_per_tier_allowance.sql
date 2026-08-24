-- Per-tier allowances, and the lifetime trial that is a different SHAPE
-- rather than a different number.
--
-- ---------------------------------------------------------------------
-- THE TABLE THIS SERVES
--
--   Free       60 credits, ONCE EVER      (lifetime trial)
--   Plus       60 credits, ONCE EVER      (the same trial; Plus buys
--                                          sync, not AI)
--   Study AI      900 credits per month
--   Study AI Max 3,000 credits per month
--
-- The numbers live in supabase/functions/_shared/credits.ts, which is
-- the only place they are written. Nothing here restates them: this
-- migration is about the SHAPE the trial needs, which the code cannot
-- provide on its own.
--
-- ---------------------------------------------------------------------
-- WHY THE TRIAL NEEDS A COLUMN AND NOT A ROW
--
-- `ai_usage` is keyed (user_id, month). A lifetime allowance has no
-- month. Faking one — a sentinel like '0000-00' or 'lifetime' — would
-- make every query that filters on currentMonthKey() silently wrong in
-- ways nothing would catch, because those queries would simply not see
-- the row and would report the trial as unspent.
--
-- `profiles` is already a per-account row, it is already read at the
-- tier lookup in both functions, and it has no month in it. Adding a
-- column there costs no extra query: `select tier` becomes
-- `select tier, trial_credits_used`.
--
-- IT MUST NEVER BE RESET BY ANYTHING. Not by a tier change, not by the
-- retention sweep, not by a "fresh start" feature nobody has proposed
-- yet. The only legitimate reset is a human in the dashboard, and the
-- reason to be strict is that this is the one counter standing between
-- us and a free allowance that grows without bound as signups do.
--
-- THE HOLE, NAMED RATHER THAN PAPERED OVER: delete_my_account_data()
-- empties profiles, so delete-and-resignup resets the trial. There is
-- no clean fix that keeps both promises — retaining a per-email counter
-- after a deletion request is retaining personal data after a deletion
-- request. The hole costs about four cents per abuse (60 credits of
-- provider spend) and requires confirming a new email address each
-- time. Accepted deliberately; see CLAUDE.md.
-- ---------------------------------------------------------------------

alter table public.profiles
  add column if not exists trial_credits_used numeric not null default 0;

comment on column public.profiles.trial_credits_used is
  'The LIFETIME trial counter, for tiers whose allowance is once-ever rather than monthly. Has no month by design: ai_usage is keyed (user_id, month) and a lifetime allowance has no month, so a sentinel there would be invisible to every query that filters on the current one. Never reset by anything but a human.';

-- ---------------------------------------------------------------------
-- The atomic increment, in the trial's shape.
--
-- Same reasoning as add_ai_credits: a read-modify-write loses one of any
-- two overlapping requests. It matters MORE here than on a monthly
-- counter, because a lost increment on a lifetime allowance is permanent
-- rather than expiring at the end of the month.
--
-- Returns the post-increment total so the caller reports the database's
-- figure rather than one computed from a read taken before the provider
-- call.
-- ---------------------------------------------------------------------
create or replace function public.add_trial_credits(
  p_user_id uuid,
  p_credits numeric default 0
)
-- Not the column name: an output parameter shadows a column of the same
-- name in a `language sql` function, and `returning trial_credits_used`
-- would then be ambiguous.
returns table (new_trial_credits numeric)
language sql
-- SECURITY INVOKER by default. The Edge Functions call it with the
-- service-role client, which bypasses RLS anyway; definer would turn a
-- leaked execute grant into "spend anybody's trial", since the caller
-- names the user.
set search_path = public, pg_catalog
as $$
  update public.profiles
     set trial_credits_used = profiles.trial_credits_used + coalesce(p_credits, 0)
   where profiles.user_id = p_user_id
  returning profiles.trial_credits_used;
$$;

comment on function public.add_trial_credits(uuid, numeric) is
  'Adds to an account''s LIFETIME trial allowance atomically and returns the new total. Service-role only. Unlike add_ai_credits this can only ever go up and is never reset by a month rolling over — that is the whole point of it.';

revoke all on function public.add_trial_credits(uuid, numeric) from public;
revoke all on function public.add_trial_credits(uuid, numeric) from anon;
revoke all on function public.add_trial_credits(uuid, numeric) from authenticated;
grant execute on function public.add_trial_credits(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------
-- NO NEW TABLE, so delete_my_account_data() needs no change: it already
-- empties public.profiles, and a migration test enumerates every table
-- with a user_id column FROM THE DATABASE to prove nothing was missed.
-- That is also exactly what opens the hole named at the top.
--
-- AND NO ROLLOVER RULE IS WRITTEN HERE, because there is nothing to
-- write. The monthly allowance does not roll over BY CONSTRUCTION:
-- ai_usage is keyed by month, a new month has no row, and the limit is
-- re-read per request from the tier. Unused credits are not stored
-- anywhere, so they cannot be carried. A test asserts the property
-- rather than trusting the construction, because the way this breaks
-- is somebody later adding a "carry over what you didn't use" feature
-- and discovering it is three lines.
-- ---------------------------------------------------------------------
