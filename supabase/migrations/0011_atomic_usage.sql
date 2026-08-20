-- The allowance increment becomes atomic.
--
-- ---------------------------------------------------------------------
-- THE HOLE. Both Edge Functions metered the same way:
--
--     select minutes_used  ...        -- read N
--     ... call the provider ...
--     upsert { minutes_used: N + cost }
--
-- Two requests that overlap both read N and both write N + cost, so one
-- of them is free. That is not a rounding error in a cap, it is the
-- difference between a cap and a suggestion: the read-modify-write is
-- the whole enforcement mechanism, and it is only correct when it does
-- not interleave. Twelve testers is exactly when we find out.
--
-- The fix is to do the addition IN THE DATABASE, where the row lock
-- during `on conflict do update` serialises it, rather than in the
-- function's memory where nothing does.
--
-- ---------------------------------------------------------------------
-- WHAT DOES NOT CHANGE, and it is the load-bearing half.
--
-- The allowance READ still precedes the provider CALL. That ordering is
-- what makes a missing column (0006) and an exhausted allowance both
-- fail having spent nothing, and it is pinned by a traced fake in
-- scripts/test-ai-text-function.mjs. This migration touches only the
-- WRITE. A version of this change that folded the check into the
-- increment -- "add it and tell me if you went over" -- would move the
-- refusal to AFTER the money was spent, which is the exact interleaving
-- 0006's header exists to make unreachable.
--
-- The race that remains is therefore bounded and known: two concurrent
-- requests can both pass the check at N and both be billed, so the cap
-- can be exceeded by one request's cost. That is the same class as the
-- estimated-duration overshoot already recorded in COST-MODEL.md
-- section 5(c) -- bounded, understood, and deliberately left. What is
-- fixed here is the strictly worse bug, where the SECOND request was
-- never billed at all.
--
-- ---------------------------------------------------------------------
-- ORDERING: this WIDENS what the code may do (a function that did not
-- exist), so it goes BEFORE the code that calls it. 0003 and 0004
-- taught that direction; 0008 taught the other one. Apply this, verify
-- it, then deploy the functions.
-- ---------------------------------------------------------------------

create or replace function public.add_ai_usage(
  p_user_id uuid,
  p_month text,
  p_minutes numeric default 0,
  p_units numeric default 0
)
-- The OUT names are deliberately not the column names: in a
-- `language sql` function an output parameter shadows a column of the
-- same name, and `returning minutes_used` would then be ambiguous.
returns table (new_minutes numeric, new_units numeric)
language sql
-- SECURITY INVOKER (the default, stated by omission and by this note).
-- The Edge Functions call it with the service-role client, which
-- bypasses RLS anyway, so definer buys nothing -- and it would turn a
-- leaked execute grant into "add usage to any user_id you like", since
-- the caller names the user. Invoker means RLS still applies to anyone
-- who is not service_role, which is the second lock below the grant.
set search_path = public, pg_catalog
as $$
  insert into public.ai_usage (user_id, month, minutes_used, text_units_used, updated_at)
  values (p_user_id, p_month, coalesce(p_minutes, 0), coalesce(p_units, 0), now())
  on conflict (user_id, month) do update
    set minutes_used    = ai_usage.minutes_used + coalesce(excluded.minutes_used, 0),
        text_units_used = ai_usage.text_units_used + coalesce(excluded.text_units_used, 0),
        updated_at      = now()
  returning ai_usage.minutes_used, ai_usage.text_units_used;
$$;

comment on function public.add_ai_usage(uuid, text, numeric, numeric) is
  'Adds to a month''s allowance atomically and returns the new totals. The addition happens under the row lock taken by ON CONFLICT DO UPDATE, which is the point: the read-modify-write it replaces lost one of any two overlapping requests. Returns the post-increment values so a caller can report a figure that is true rather than one it computed from a stale read. Service-role only.';

-- ---------------------------------------------------------------------
-- Nobody but the Edge Functions may call it.
--
-- The caller names the user_id, so an execute grant to `authenticated`
-- would be "spend someone else's allowance" -- and unlike the tables
-- around it, a function's default grant is EXECUTE TO PUBLIC, which is
-- the same platform-default trap 0008 found on the tables. Revoked
-- explicitly rather than assumed, and from the roles by name as well as
-- from public, because that is what the audit test reads.
-- ---------------------------------------------------------------------
revoke all on function public.add_ai_usage(uuid, text, numeric, numeric) from public;
revoke all on function public.add_ai_usage(uuid, text, numeric, numeric) from anon;
revoke all on function public.add_ai_usage(uuid, text, numeric, numeric) from authenticated;
grant execute on function public.add_ai_usage(uuid, text, numeric, numeric) to service_role;

-- No new table and no new column, so delete_my_account_data() needs
-- nothing: it already empties public.ai_usage wholesale, and the
-- migration test enumerates tables with a user_id column FROM THE
-- DATABASE to prove it.
