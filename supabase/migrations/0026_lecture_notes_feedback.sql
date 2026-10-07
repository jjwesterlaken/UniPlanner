-- ---------------------------------------------------------------------
-- 0026: lecture_notes_feedback — whether AI lecture notes are any good
-- (RELEASE-1.3.1.md item 8).
--
-- 0023's shape, one feature over, and deliberately narrower. Two
-- occasions, one row each, per RESULT:
--
--   delivered  a set of notes came back    the denominator
--   rated      the student rated it        yes / partly / no, reasons,
--                                          and free text only if they
--                                          chose to send it
--
-- THE DELIVERED ROW IS THE DENOMINATOR, for 0023's reason: a table of
-- answers alone cannot say how many results nobody rated.
--
-- WHAT IS NOT HERE, AND WHY. No lecture content of any kind — no
-- transcript, no summary, no term, no title. No idempotency key, which
-- would join a rating to `ai_notes_requests` and through it to a whole
-- transcript: `run_id` is a FRESH client uid minted per result, and it
-- points at nothing. No week, no duration, no language, no tier. The
-- one descriptive field is `course`, the label the student filed the
-- recording under, because the weekly check counts ratings per course
-- and a course is how a student would describe "the notes for X are
-- too long". It is the student's own label, bounded, and nullable.
-- The comment is opt-in per submission and may quote the lecture, so
-- the documents say so (test-legal.mjs).
--
-- THE REASONS ARE A CLOSED SET IN THE DATABASE, not only in the client
-- (`reasons <@ array[...]`): this table is read by a weekly query that
-- groups by reason, and a typo'd id from a stale client would be a
-- reason nobody knows how to read. A new reason is a migration.
--
-- INSERT-ONLY, THREE POLICIES, the ai_notes / 0023 shape. A double tap
-- is refused with 23505, which the client reads as already answered.
--
-- EVERY ID IS text (0009): they are the planner's own base36 uid().
--
-- IT WIDENS, so it is applied BEFORE the client that writes it. The
-- client swallows a refused insert (a rating is never allowed to take
-- down notes the student paid for), so a client deployed first records
-- nothing and nothing looks wrong.
-- ---------------------------------------------------------------------

create table if not exists public.lecture_notes_feedback (
  id text primary key check (char_length(id) between 1 and 64),
  user_id uuid not null references auth.users (id) on delete cascade,
  run_id text not null check (char_length(run_id) between 1 and 64),
  course text check (char_length(course) <= 64),
  occasion text not null check (occasion in ('delivered', 'rated')),
  rating text check (rating in ('yes', 'partly', 'no')),
  reasons text[] not null default '{}' check (
    cardinality(reasons) <= 6
    and reasons <@ array['too-long', 'too-short', 'missed-assessable', 'wrong-terms', 'wrong-structure', 'other']::text[]
  ),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  constraint lecture_notes_feedback_rating_shape check (
    (occasion = 'delivered' and rating is null and comment is null and cardinality(reasons) = 0)
    or (occasion = 'rated' and rating is not null)
  )
);

create unique index if not exists lecture_notes_feedback_once_per_run
  on public.lecture_notes_feedback (user_id, run_id, occasion);

alter table public.lecture_notes_feedback enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='lecture_notes_feedback' and policyname='lecture_notes_feedback_select_own') then
    execute 'create policy "lecture_notes_feedback_select_own" on public.lecture_notes_feedback for select to authenticated using (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='lecture_notes_feedback' and policyname='lecture_notes_feedback_insert_own') then
    execute 'create policy "lecture_notes_feedback_insert_own" on public.lecture_notes_feedback for insert to authenticated with check (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='lecture_notes_feedback' and policyname='lecture_notes_feedback_delete_own') then
    execute 'create policy "lecture_notes_feedback_delete_own" on public.lecture_notes_feedback for delete to authenticated using (auth.uid() = user_id)';
  end if;
end;
$$;

-- Exactly the three verbs with policies, and nothing to anon (0008).
revoke all on public.lecture_notes_feedback from anon, authenticated;
grant select, insert, delete on public.lecture_notes_feedback to authenticated;

comment on table public.lecture_notes_feedback is
  'One row per occasion on which a student told us how a set of AI lecture notes did: delivered (a result came back) and rated (yes / partly / no, reasons, and a comment only if they ticked to send it). No lecture content, and run_id joins to nothing. Insert-only, written by the client under RLS. See 0026''s header.';

-- ---------------------------------------------------------------------
-- Account deletion covers the new table. The body is 0023's, the latest
-- migration that defines this function, with one line added.
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
  -- A shared mark is academic record, and a comment may quote the essay.
  delete from public.assessment_feedback where user_id = uid;
  -- A comment may quote the lecture.
  delete from public.lecture_notes_feedback where user_id = uid;
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

-- No revoke/grant on the function, for 0020's reason: create or replace
-- preserves the ACL.

-- ---------------------------------------------------------------------
-- The self-check (0016). One DO block, so a failure anywhere rolls the
-- whole thing back, probes included.
-- ---------------------------------------------------------------------
do $$
declare
  checked int := 0;
  a uuid := '00000000-0000-4000-8000-0000000026a1';
  n int;
begin
  if pg_catalog.to_regclass('public.lecture_notes_feedback') is null then
    raise exception '0026 FAILED: public.lecture_notes_feedback does not exist.';
  end if;
  checked := checked + 1;

  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.lecture_notes_feedback'::regclass and relrowsecurity) then
    raise exception '0026 FAILED: row level security is not enabled on lecture_notes_feedback.';
  end if;
  checked := checked + 1;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'lecture_notes_feedback';
  if n <> 3 or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lecture_notes_feedback' and cmd not in ('SELECT', 'INSERT', 'DELETE')) then
    raise exception '0026 FAILED: expected exactly the select, insert and delete policies, found %.', n;
  end if;
  checked := checked + 1;

  if has_table_privilege('authenticated', 'public.lecture_notes_feedback', 'update') then
    raise exception '0026 FAILED: authenticated can update lecture_notes_feedback, so the rows are not immutable.';
  end if;
  checked := checked + 1;

  if has_table_privilege('anon', 'public.lecture_notes_feedback', 'select')
     or has_table_privilege('anon', 'public.lecture_notes_feedback', 'insert') then
    raise exception '0026 FAILED: anon can read or write lecture_notes_feedback.';
  end if;
  checked := checked + 1;

  if position('lecture_notes_feedback' in pg_catalog.pg_get_functiondef('public.delete_my_account_data()'::regprocedure)) = 0 then
    raise exception '0026 FAILED: delete_my_account_data() does not delete from lecture_notes_feedback.';
  end if;
  checked := checked + 1;

  if position('assessment_feedback' in pg_catalog.pg_get_functiondef('public.delete_my_account_data()'::regprocedure)) = 0 then
    raise exception '0026 FAILED: delete_my_account_data() lost assessment_feedback, so the body was copied from an older migration.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: base36 ids accepted, a delivered and a rated row per
  -- run, a second rating of one run refused, an unknown reason refused,
  -- and a rating on a delivered row refused.
  insert into auth.users (id) values (a);
  insert into public.lecture_notes_feedback (id, user_id, run_id, course, occasion)
    values ('mz0probe-n1', a, 'mz0run-1', 'PSYC1001', 'delivered');
  insert into public.lecture_notes_feedback (id, user_id, run_id, course, occasion, rating, reasons)
    values ('mz0probe-n2', a, 'mz0run-1', 'PSYC1001', 'rated', 'partly', '{too-long,wrong-terms}');
  begin
    insert into public.lecture_notes_feedback (id, user_id, run_id, occasion, rating)
      values ('mz0probe-n3', a, 'mz0run-1', 'rated', 'yes');
    raise exception '0026 FAILED: one result was rated twice.';
  exception when unique_violation then null;
  end;
  checked := checked + 1;

  begin
    insert into public.lecture_notes_feedback (id, user_id, run_id, occasion, rating, reasons)
      values ('mz0probe-n4', a, 'mz0run-2', 'rated', 'no', '{not-a-reason}');
    raise exception '0026 FAILED: a reason outside the closed set was stored.';
  exception when check_violation then null;
  end;
  checked := checked + 1;

  begin
    insert into public.lecture_notes_feedback (id, user_id, run_id, occasion, rating)
      values ('mz0probe-n5', a, 'mz0run-3', 'delivered', 'yes');
    raise exception '0026 FAILED: a rating was stored on a delivered row.';
  exception when check_violation then null;
  end;
  checked := checked + 1;

  delete from auth.users where id = a;
  select count(*) into n from public.lecture_notes_feedback where user_id = a;
  if n <> 0 then
    raise exception '0026 FAILED: % rows survived their account.', n;
  end if;
  checked := checked + 1;

  if checked <> 11 then
    raise exception '0026 FAILED: only % of 11 properties were checked.', checked;
  end if;

  raise notice '0026 applied and verified: % properties checked.', checked;
end;
$$;
