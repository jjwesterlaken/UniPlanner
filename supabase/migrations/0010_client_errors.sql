-- ---------------------------------------------------------------------
-- 0010: client_errors — the app reports its own breakages.
--
-- Twelve closed testers are about to use this app, and "it broke on my
-- phone" needs to arrive as an error message and a stack, not as a
-- support conversation. The deliberate decision is that reports land in
-- OUR OWN project: no PostHog, no Sentry, no third-party processor —
-- the privacy policy says nothing third-party is in the bundle, a test
-- pins it, and a US processor would undo both and cost a consent bump.
--
-- WRITE-ONLY BY CONSTRUCTION. A client can report and can never read:
-- insert is the only verb granted, there is no select policy for
-- anyone, and Jared reads the table from the dashboard. This is the
-- inverse of the 0008 rule and deliberately so — "no vs nothing"
-- matters for READS (silence hides a refusal); an insert either lands
-- or errors, and the reporter treats both the same (fire and forget).
--
-- THE ANON EXCEPTION, written down because 0008 exists: anon gets
-- INSERT here, and nothing else, with a policy that forces user_id to
-- be null. This is not a table holding a student's data — no note
-- text, no transcript, no email ever enters it (the client sends only
-- message, stack, build id, page path and browser; test-error-report
-- pins the exact field list). A signed-out student's crash matters as
-- much as a signed-in one's, and signed-out IS anon on the real
-- backend. The 0008 guard in test-migrations excuses exactly this
-- shape and goes red on any widening.
--
-- BOUNDED AT THE COLUMN. Length checks cap every text field, so a
-- runaway loop or a hostile client cannot store megabytes per row. The
-- residual risk — anyone with the anon key can insert junk rows — is
-- accepted at this scale, stated in the PR, and reversible with one
-- REVOKE if it is ever abused; the table holds our diagnostics, so
-- junk costs disk, never a student's data.
-- ---------------------------------------------------------------------

create table if not exists public.client_errors (
  -- Server-minted: gen_random_uuid() default, the client never sends one.
  id uuid primary key default gen_random_uuid(),
  -- NULLABLE on purpose: signed-out errors matter too, and anon inserts
  -- are forced to null by policy below.
  user_id uuid references auth.users(id) on delete cascade,
  message text not null check (char_length(message) <= 2000),
  stack text check (char_length(stack) <= 8000),
  build_id text check (char_length(build_id) <= 64),
  url text check (char_length(url) <= 512),
  user_agent text check (char_length(user_agent) <= 512),
  created_at timestamptz not null default now()
);

alter table public.client_errors enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_errors' and policyname='client_errors_insert_own') then
    execute 'create policy "client_errors_insert_own" on public.client_errors for insert to authenticated with check (user_id = auth.uid())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_errors' and policyname='client_errors_insert_anon') then
    execute 'create policy "client_errors_insert_anon" on public.client_errors for insert to anon with check (user_id is null)';
  end if;
end;
$$;

-- Insert and nothing else, for both roles — no select policy exists, so
-- even a future select grant would return zero rows. The revoke first
-- clears any platform default, the 0008 discipline.
revoke all on public.client_errors from anon, authenticated;
grant insert on public.client_errors to anon, authenticated;

-- ---------------------------------------------------------------------
-- Account deletion covers the new table. Copied from 0007's body plus
-- the one new line; the behavioural test in test-migrations enumerates
-- user-owned tables FROM THE DATABASE and asserts this function empties
-- all of them, which is what makes the copy safe to make.
-- Anonymous reports (user_id null) belong to nobody and are Jared's
-- operational data; account deletion removes every row tied to the
-- account and leaves the null rows, which the deletion page states.
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
  -- at the top; error reports hold no student content, so they go last.
  delete from public.ai_notes where user_id = uid;
  delete from public.semester_archives where user_id = uid;
  delete from public.ai_notes_requests where user_id = uid;
  delete from public.ai_usage where user_id = uid;
  delete from public.profiles where user_id = uid;

  if pg_catalog.to_regclass('public.planner_data') is not null then
    execute 'delete from public.planner_data where user_id = $1' using uid;
  end if;

  delete from public.client_errors where user_id = uid;

  -- Staged lecture audio is removed by the client through the Storage
  -- API before this runs (see src/accountDeletion.js), because a SQL
  -- delete on storage.objects leaves the file in the backing store.
end;
$$;
