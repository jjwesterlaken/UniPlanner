-- Account deletion, made explicit and version-controlled.
--
-- 0001 relies on `ON DELETE CASCADE` from auth.users, which is correct but
-- only fires if something actually deletes the auth.users row. Until now
-- the function that's supposed to do that (`delete_my_account()`) lived
-- only in the dashboard, untracked -- so there was no way to tell from
-- this repo whether a deleted account really took ai_notes_requests.result
-- (a full copy of the user's lecture content) with it.
--
-- This migration is safe to run on a project that already has a
-- `delete_my_account()`: it never overwrites one. See the DO block at the
-- bottom.

-- ---------------------------------------------------------------------
-- delete_my_account_data(): removes every row this repo knows about for
-- the calling user, without touching auth.users.
--
-- Split out from delete_my_account() so a project that already has its
-- own deletion function can adopt the AI-notes cleanup with a one-line
-- addition (`perform public.delete_my_account_data();`) instead of
-- hand-merging a SQL snippet.
--
-- SECURITY DEFINER because `profiles`, `ai_usage` and `ai_notes_requests`
-- deliberately expose no client-side delete policy (0001) -- the whole
-- point is that the only delete path is this reviewed, auth.uid()-scoped
-- one, never an arbitrary client DELETE.
--
-- `search_path = ''` forces every reference below to be schema-qualified,
-- so a table planted in a schema earlier on the caller's search_path
-- can't hijack what a definer-rights function deletes.
-- ---------------------------------------------------------------------
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
  -- least sensitive data behind rather than the most. (They're in one
  -- transaction regardless -- this only matters for the error a caller
  -- ends up reporting.)
  delete from public.ai_notes_requests where user_id = uid;
  delete from public.ai_usage where user_id = uid;
  delete from public.profiles where user_id = uid;

  -- planner_data predates this repo's migrations (it's documented in
  -- SUPABASE-SETUP.md §1 rather than created by one), so it may not exist
  -- on every project. Guarded + dynamic so a project without it gets a
  -- working deletion function instead of one that throws at the last
  -- step, after the AI rows are already gone.
  if pg_catalog.to_regclass('public.planner_data') is not null then
    execute 'delete from public.planner_data where user_id = $1' using uid;
  end if;

  -- Staged lecture audio is deliberately NOT deleted here. Deleting a
  -- storage.objects row over SQL removes the index entry but leaves the
  -- actual file in the bucket's backing store -- that's what the Storage
  -- API's remove() is for, and only the Edge Function has it. Audio is
  -- transient by design anyway: it's deleted as soon as transcription
  -- succeeds, and anything left by a failed run is swept hourly by
  -- scheduleCleanup() in supabase/functions/ai-notes/index.ts, which
  -- sweeps by age and doesn't care whether the owner still exists.
end;
$$;

revoke all on function public.delete_my_account_data() from public;
grant execute on function public.delete_my_account_data() to authenticated;

comment on function public.delete_my_account_data() is
  'Deletes the calling user''s planner and AI-notes rows. Does not touch auth.users -- see delete_my_account().';

-- ---------------------------------------------------------------------
-- delete_my_account(): the full self-service deletion.
--
-- Created only when the project doesn't already have one. An existing
-- function is left untouched: it isn't tracked here, so it can't be read
-- and merged safely, and blindly replacing it could drop deletion steps
-- for tables this repo has never heard of. The NOTICE says what to add.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'delete_my_account'
      and p.pronargs = 0
  ) then
    raise notice
      'public.delete_my_account() already exists and was left unchanged. Add this line to it so AI-notes data is deleted too: perform public.delete_my_account_data();';
  else
    execute $fn$
      create function public.delete_my_account()
      returns void
      language plpgsql
      security definer
      set search_path = ''
      as $body$
      declare
        uid uuid := auth.uid();
      begin
        if uid is null then
          raise exception 'delete_my_account() must be called by a signed-in user';
        end if;

        perform public.delete_my_account_data();

        -- Belt and braces: every user_id foreign key in 0001 cascades from
        -- here, so this alone would clear the rows above. Both run so that
        -- neither half silently becomes the only thing standing between a
        -- deleted account and its lecture transcripts.
        delete from auth.users where id = uid;
      end;
      $body$;
    $fn$;

    execute 'revoke all on function public.delete_my_account() from public';
    execute 'grant execute on function public.delete_my_account() to authenticated';
    execute $c$comment on function public.delete_my_account() is
      'Self-service account deletion: removes the caller''s app data and their auth.users row.'$c$;
  end if;
end;
$$;
