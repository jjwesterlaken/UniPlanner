-- One currency: credits. One credit is one minute of recorded lecture.
--
-- ---------------------------------------------------------------------
-- WHY. `ai_usage` carried two counters — `minutes_used` for audio and
-- `text_units_used` for the text features — and the split is what hid
-- the photographed-reading mispricing for months: a photo batch was
-- billed in the currency the expensive thing it resembled did not use,
-- so no screen and no test could put the two beside each other. See
-- COST-MODEL.md sections 4 and 12 for what that cost.
--
-- ---------------------------------------------------------------------
-- THIS MIGRATION ONLY WIDENS. It adds `credits_used`, backfills it, and
-- adds `add_ai_credits`. The old columns and `add_ai_usage` stay, so a
-- function deployed BEFORE this is applied keeps working, and a
-- function deployed AFTER finds everything it needs. 0013 is the one
-- that narrows, and its header says when it may be applied.
--
-- That is the 0003/0004 direction, and it is deliberate: 0008 narrowed
-- while a client that still needed the privilege was live, and turned
-- every AI-note write into a 400 once per sync.
--
-- ---------------------------------------------------------------------
-- THE BACKFILL IS A SUM, AND IT IS VERY NEARLY EXACT. A text unit was
-- already priced close to a credit — the old weighting was roughly
-- cost-proportional for text, which is why `TASK_CREDITS` comes out
-- {explain 1, weakspots 1, practice 2, summarise 3} against the old
-- {1, 1, 2, 3}. Only `merge` moves, 1 -> 2. So adding the two counters
-- carries each account's real spend across to within a credit or two.
--
-- There are three accounts: two developers and the e2e test account.
-- Nobody is being billed money. If the arithmetic were wrong by more
-- than it is, the honest answer would still be to zero it.
-- ---------------------------------------------------------------------

alter table public.ai_usage
  add column if not exists credits_used numeric not null default 0;

-- Guarded on the old columns still existing, because 0013 drops them
-- and every migration here has to survive being re-applied. Without the
-- guard this file is re-runnable exactly once.
do $$
begin
  if to_regclass('public.ai_usage') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_usage' and column_name = 'minutes_used'
     )
  then
    execute $sql$
      update public.ai_usage
         set credits_used = coalesce(minutes_used, 0) + coalesce(text_units_used, 0)
       where credits_used = 0
         and (coalesce(minutes_used, 0) + coalesce(text_units_used, 0)) > 0
    $sql$;
  end if;
end;
$$;

comment on column public.ai_usage.credits_used is
  'The single allowance counter. One credit is one minute of recorded lecture; every action is priced against that (supabase/functions/_shared/credits.ts). Replaces minutes_used and text_units_used, which 0013 drops once the functions using them are no longer deployed.';

-- ---------------------------------------------------------------------
-- The atomic increment, in the new currency.
--
-- Same shape and same reasoning as 0011's add_ai_usage, which it
-- replaces: the `+` happens under the row lock ON CONFLICT DO UPDATE
-- takes, because a read-modify-write in the function's memory loses one
-- of any two overlapping requests. It returns the post-increment total
-- so a caller reports the database's figure rather than one it computed
-- from a read taken before the provider call.
--
-- The allowance READ still precedes the provider CALL in both
-- functions. Only the write lives here. Folding the check into the
-- increment would move the refusal to after the money was spent.
-- ---------------------------------------------------------------------
create or replace function public.add_ai_credits(
  p_user_id uuid,
  p_month text,
  p_credits numeric default 0
)
-- The OUT name is deliberately not the column name: in a `language sql`
-- function an output parameter shadows a column of the same name, and
-- `returning credits_used` would then be ambiguous.
returns table (new_credits numeric)
language sql
-- SECURITY INVOKER (the default, stated by omission and by this note).
-- The Edge Functions call it with the service-role client, which
-- bypasses RLS anyway, so definer buys nothing — and it would turn a
-- leaked execute grant into "add usage to any user_id you like", since
-- the caller names the user.
set search_path = public, pg_catalog
as $$
  insert into public.ai_usage (user_id, month, credits_used, updated_at)
  values (p_user_id, p_month, coalesce(p_credits, 0), now())
  on conflict (user_id, month) do update
    set credits_used = ai_usage.credits_used + coalesce(excluded.credits_used, 0),
        updated_at   = now()
  returning ai_usage.credits_used;
$$;

comment on function public.add_ai_credits(uuid, text, numeric) is
  'Adds to a month''s credit allowance atomically and returns the new total. Service-role only: the caller names the user_id, so an execute grant to authenticated would read "spend anybody''s allowance".';

-- A function's platform default is EXECUTE TO PUBLIC — the same
-- default-grant trap 0008 found on the tables one layer down. Revoked
-- by name as well as from public, because that is what the audit reads.
revoke all on function public.add_ai_credits(uuid, text, numeric) from public;
revoke all on function public.add_ai_credits(uuid, text, numeric) from anon;
revoke all on function public.add_ai_credits(uuid, text, numeric) from authenticated;
grant execute on function public.add_ai_credits(uuid, text, numeric) to service_role;

-- No new table and no new user_id column, so delete_my_account_data()
-- needs nothing: it already empties public.ai_usage wholesale, and the
-- migration test enumerates tables with a user_id column FROM THE
-- DATABASE to prove it.
