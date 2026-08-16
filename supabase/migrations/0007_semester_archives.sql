-- Semester archives: the semester lifecycle's server half.
--
-- WHY: nothing ever cleared a semester, so a student reusing
-- "Semester 1" across years grows the planner blob without bound --
-- reuse alone breaches the 1 MB working budget (see reference.js and
-- CLAUDE.md). Archiving stores the whole bucket here, verbatim, and
-- the blob keeps stripped tombstones plus a small marker. The server
-- is where growth is cheap; the device is where it is not.
--
-- One row per archive event: ~600 KB of jsonb for a heavy semester,
-- two rows a year. The `summary` column (label, item count, courses
-- with marks) is separate from `data` so listing archives never pulls
-- megabytes.
--
-- ---------------------------------------------------------------------
-- THREE policies, not four -- the ai_notes shape, for the same reason.
-- The row is written once, read, and deleted; folding late edits into
-- an archive is insert-new-then-delete-old rather than an update, so
-- there is no client update path to get wrong. `update` is refused
-- twice over: no grant, and no policy.
-- ---------------------------------------------------------------------

create table if not exists public.semester_archives (
  -- Minted client-side and parked on the device before the insert, so
  -- a retried archive lands under the same id instead of forking.
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  summary jsonb not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.semester_archives enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='semester_archives' and policyname='semester_archives_select_own') then
    execute 'create policy "semester_archives_select_own" on public.semester_archives for select to authenticated using (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='semester_archives' and policyname='semester_archives_insert_own') then
    execute 'create policy "semester_archives_insert_own" on public.semester_archives for insert to authenticated with check (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='semester_archives' and policyname='semester_archives_delete_own') then
    execute 'create policy "semester_archives_delete_own" on public.semester_archives for delete to authenticated using (auth.uid() = user_id)';
  end if;
end;
$$;

-- Granted explicitly rather than left to default privileges, for the
-- reason 0005 gives: the failure if defaults didn't apply is the whole
-- feature dead on arrival, and granting exactly the three verbs that
-- have policies means `update` is refused twice over.
grant select, insert, delete on public.semester_archives to authenticated;

-- The archive list is one query per visit to the panel.
create index if not exists semester_archives_user_idx on public.semester_archives (user_id);

comment on table public.semester_archives is
  'Archived semesters, one row per archive event, holding the planner bucket verbatim. Written once by the client under RLS, read for restore, deleted by the student. No update policy: late edits fold in as insert-new-then-delete-old.';

-- ---------------------------------------------------------------------
-- Account deletion. ON DELETE CASCADE already covers this; the explicit
-- delete keeps 0002's belt-and-braces stance. Same restatement warning
-- as 0005: this REPLACES the function by copying the previous body, so
-- an edit made to an earlier copy later would be silently reverted by
-- this file. The guard is behavioural -- test-migrations.mjs enumerates
-- every public table with a user_id column FROM THE DATABASE and
-- asserts this function empties all of them.
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
  -- least sensitive data behind rather than the most. An archive holds
  -- an entire semester of the student's work, so it sits with ai_notes
  -- at the top.
  delete from public.ai_notes where user_id = uid;
  delete from public.semester_archives where user_id = uid;
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
