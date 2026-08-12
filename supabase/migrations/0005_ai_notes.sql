-- AI lecture notes get their own row, out of the synced planner blob.
--
-- WHY, measured rather than assumed: a realistic populated account is
-- 672KB against a 1MB working budget, and an AI note cost 7.6KB. At two
-- lectures a week the blob breached the budget inside one semester. See
-- CLAUDE.md.
--
-- The blob keeps a ~525 byte stub -- title, course, week, the language
-- being read, and a short preview per language -- and the content lives
-- here. Study cards stay in the blob: their `srs` state changes on every
-- review and reviews must work offline, so moving them would mean either
-- a remote write per review or a second sync problem.
--
-- ---------------------------------------------------------------------
-- THREE policies, not four. The row is written once, read many, and
-- deleted -- never updated.
--
-- `activeLanguage` is the one thing a reader changes, and it lives in
-- the blob stub instead, because it is a reading preference that changes
-- often and has to work offline. That leaves this row immutable, so
-- there is no client update path to get wrong. If the planned
-- re-summarise endpoint ever rewrites a note it will run service-role
-- and bypass RLS anyway.
--
-- Unlike ai_notes_requests (service-role only, select-own for support),
-- this table is written BY THE CLIENT under RLS. That is why it needs
-- insert and delete policies where the other one deliberately has none.
-- ---------------------------------------------------------------------

create table if not exists public.ai_notes (
  -- The page id from the planner blob, so migrating the same note twice
  -- is a no-op rather than a duplicate.
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course text,
  week text,
  -- The aiMeta payload: translations, and whatever the size cap dropped.
  content jsonb not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.ai_notes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_notes' and policyname='ai_notes_select_own') then
    execute 'create policy "ai_notes_select_own" on public.ai_notes for select to authenticated using (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_notes' and policyname='ai_notes_insert_own') then
    execute 'create policy "ai_notes_insert_own" on public.ai_notes for insert to authenticated with check (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_notes' and policyname='ai_notes_delete_own') then
    execute 'create policy "ai_notes_delete_own" on public.ai_notes for delete to authenticated using (auth.uid() = user_id)';
  end if;
end;
$$;

-- Granted explicitly rather than left to Supabase's default privileges.
-- Those are configured for tables created by the `postgres` role, which is
-- what the SQL editor uses -- so this would very likely work anyway. It is
-- written out because the failure if it didn't is the whole feature dead on
-- arrival with a permission error, and because granting exactly the three
-- verbs that have policies means `update` is refused twice over: no grant,
-- and no policy.
grant select, insert, delete on public.ai_notes to authenticated;

-- Reconciliation lists this user's ids on every sync.
create index if not exists ai_notes_user_idx on public.ai_notes (user_id);

comment on table public.ai_notes is
  'AI lecture note content, moved out of the planner blob. Written once by the client, read many, deleted. No update policy: activeLanguage lives in the blob stub so the row is immutable.';

-- ---------------------------------------------------------------------
-- Account deletion. ON DELETE CASCADE from auth.users already covers
-- this, but delete_my_account_data() deletes explicitly for the same
-- belt-and-braces reason 0002 gives: neither half should silently become
-- the only thing standing between a deleted account and its lecture
-- content.
--
-- NOTE, because this is a restatement and restatements drift: replacing
-- the function means copying 0002's body, so an edit to 0002 made later
-- would be silently reverted by this file. The guard is behavioural
-- rather than a text comparison -- test-migrations.mjs applies every
-- migration in order and asserts the resulting function empties EVERY
-- public table with a user_id column, enumerated from the database. Add
-- a table and forget the function, or drop a delete while copying, and
-- that test goes red.
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
  -- least sensitive data behind rather than the most.
  delete from public.ai_notes where user_id = uid;
  delete from public.ai_notes_requests where user_id = uid;
  delete from public.ai_usage where user_id = uid;
  delete from public.profiles where user_id = uid;

  if pg_catalog.to_regclass('public.planner_data') is not null then
    execute 'delete from public.planner_data where user_id = $1' using uid;
  end if;

  -- Staged lecture audio is removed by the client through the Storage
  -- API before this runs (see src/accountDeletion.js), because a SQL
  -- delete on storage.objects leaves the file in the backing store.
end;
$$;
