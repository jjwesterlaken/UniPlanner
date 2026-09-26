-- ---------------------------------------------------------------------
-- 0023: assessment_feedback — how we learn whether essay feedback is
-- any good (ESSAY-FEEDBACK.md, "THE MARK COMPARISON").
--
-- We have no way to compare our feedback with a real marker, so the
-- students are the comparison. Three occasions, one row each:
--
--   delivered  a run succeeded           the deficiency codes we raised
--   rated      the student rated a run   yes / partly / no, reasons,
--                                        and free text only if they
--                                        chose to send it
--   on_mark    a mark came back          the same rating, and the mark
--                                        and band ONLY with the tick
--
-- THE DELIVERED ROW IS THE DENOMINATOR. A table of answers alone can
-- say "essays we flagged averaged 62" and cannot say how many we
-- flagged and never heard about.
--
-- ONE CHANGE FROM THE DESIGN ON #138, and it is a correction: that
-- design made (user, assessment, occasion) unique, which refuses the
-- SECOND delivered row when a student runs feedback on a redraft of
-- the same assessment. The denominator would undercount exactly the
-- students using the feature most, and a per-result rating would have
-- nowhere to go. So a run has its own client-minted id: delivered and
-- rated are once per RUN, on_mark is once per ASSESSMENT.
--
-- THE CLIENT WRITES EVERY ROW, and it has to be the client: ai-text's
-- source-level invariant is that no .from(...) names any table but
-- profiles and ai_usage. A client that dies between the response and
-- the insert records no delivered row, so the denominator undercounts,
-- which under-reports our coverage rather than over-reporting our
-- accuracy.
--
-- INSERT-ONLY, THREE POLICIES, the ai_notes shape: select, insert,
-- delete. No update policy, so there is no client update path to get
-- wrong, and once-ness is a database fact: a double tap is refused with
-- 23505, which the client reads as already answered.
--
-- EVERY ID IS text. They are the planner's own uid(), base36, and a
-- uuid column here is 0009 again: every insert rejected with 22P02,
-- PostgREST answering 400, and the table empty on every account.
--
-- IT WIDENS, so it is applied BEFORE the client that writes it. A
-- client deployed first would have every insert refused with "relation
-- does not exist"; the panel swallows that (a capture is never allowed
-- to take down a result the student paid for), so nothing would look
-- wrong and nothing would be recorded.
-- ---------------------------------------------------------------------

create table if not exists public.assessment_feedback (
  id text primary key check (char_length(id) between 1 and 64),
  user_id uuid not null references auth.users (id) on delete cascade,
  assessment_id text not null check (char_length(assessment_id) between 1 and 64),
  -- The run this row is about. Null only on on_mark, which is about the
  -- assessment rather than any one run.
  run_id text check (char_length(run_id) <= 64),
  occasion text not null check (occasion in ('delivered', 'rated', 'on_mark')),
  rating text check (rating in ('yes', 'partly', 'no')),
  reasons text[] not null default '{}' check (cardinality(reasons) <= 12),
  -- Only what the student chose to send, and bounded: it may contain
  -- their own essay wording, which is why it is opt-in per submission.
  comment text check (char_length(comment) <= 500),
  deficiency_codes text[] not null default '{}' check (cardinality(deficiency_codes) <= 40),
  rewrite_requested boolean not null default false,
  tier text check (char_length(tier) <= 16),
  credits integer check (credits between 0 and 1000),
  -- ONLY WITH THE TICK. Unticked, both stay null and the rating stands.
  mark numeric check (mark between 0 and 100),
  band text check (char_length(band) <= 32),
  created_at timestamptz not null default now(),
  -- The shape of each occasion, enforced rather than hoped for.
  constraint assessment_feedback_run_shape check (
    (occasion = 'on_mark' and run_id is null)
    or (occasion <> 'on_mark' and run_id is not null)
  ),
  constraint assessment_feedback_rating_shape check (
    (occasion = 'delivered' and rating is null and comment is null)
    or (occasion <> 'delivered' and rating is not null)
  ),
  constraint assessment_feedback_mark_shape check (
    (occasion = 'on_mark') or (mark is null and band is null)
  )
);

create unique index if not exists assessment_feedback_once_per_run
  on public.assessment_feedback (user_id, run_id, occasion)
  where occasion in ('delivered', 'rated');
create unique index if not exists assessment_feedback_once_per_mark
  on public.assessment_feedback (user_id, assessment_id)
  where occasion = 'on_mark';

alter table public.assessment_feedback enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='assessment_feedback' and policyname='assessment_feedback_select_own') then
    execute 'create policy "assessment_feedback_select_own" on public.assessment_feedback for select to authenticated using (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='assessment_feedback' and policyname='assessment_feedback_insert_own') then
    execute 'create policy "assessment_feedback_insert_own" on public.assessment_feedback for insert to authenticated with check (auth.uid() = user_id)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='assessment_feedback' and policyname='assessment_feedback_delete_own') then
    execute 'create policy "assessment_feedback_delete_own" on public.assessment_feedback for delete to authenticated using (auth.uid() = user_id)';
  end if;
end;
$$;

-- EXACTLY the three verbs with policies, and nothing to anon (0008:
-- the platform grants ALL to both roles on every table the SQL editor
-- creates, and a granted verb with no policy is a privilege sitting
-- open unnoticed).
revoke all on public.assessment_feedback from anon, authenticated;
grant select, insert, delete on public.assessment_feedback to authenticated;

comment on table public.assessment_feedback is
  'One row per occasion on which a student told us how essay feedback did: delivered (the codes we raised on a run), rated (their verdict on it), on_mark (their verdict when a mark came back, and the mark and band only if they ticked to share them). Insert-only, written by the client under RLS. See 0023''s header.';

-- ---------------------------------------------------------------------
-- Account deletion covers the new table. The body is 0020's, the
-- latest migration that defines this function, with one line added —
-- never an older copy, which has been done once and dropped a table.
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
-- preserves the ACL, and 0002's revoke is the fingerprint that dates
-- whether 0002 ever ran on a project.

-- ---------------------------------------------------------------------
-- The self-check. An apply must not be able to report success while the
-- end state is wrong (0016). A DO block is one statement, so a failure
-- anywhere below rolls the whole thing back, probes included.
-- ---------------------------------------------------------------------
do $$
declare
  checked int := 0;
  a uuid := '00000000-0000-4000-8000-0000000023a1';
  n int;
begin
  if pg_catalog.to_regclass('public.assessment_feedback') is null then
    raise exception '0023 FAILED: public.assessment_feedback does not exist.';
  end if;
  checked := checked + 1;

  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.assessment_feedback'::regclass and relrowsecurity) then
    raise exception '0023 FAILED: row level security is not enabled on assessment_feedback.';
  end if;
  checked := checked + 1;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'assessment_feedback';
  if n <> 3 or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'assessment_feedback' and cmd not in ('SELECT', 'INSERT', 'DELETE')) then
    raise exception '0023 FAILED: expected exactly the select, insert and delete policies, found %.', n;
  end if;
  checked := checked + 1;

  if has_table_privilege('authenticated', 'public.assessment_feedback', 'update') then
    raise exception '0023 FAILED: authenticated can update assessment_feedback, so the rows are not immutable.';
  end if;
  checked := checked + 1;

  if has_table_privilege('anon', 'public.assessment_feedback', 'select')
     or has_table_privilege('anon', 'public.assessment_feedback', 'insert') then
    raise exception '0023 FAILED: anon can read or write assessment_feedback.';
  end if;
  checked := checked + 1;

  if position('assessment_feedback' in pg_catalog.pg_get_functiondef('public.delete_my_account_data()'::regprocedure)) = 0 then
    raise exception '0023 FAILED: delete_my_account_data() does not delete from assessment_feedback.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: a base36 id is accepted, a second run on the same
  -- assessment is accepted, a second rating of one run is refused, a
  -- second on_mark is refused, and a mark on a non-mark row is refused.
  insert into auth.users (id) values (a);
  insert into public.assessment_feedback (id, user_id, assessment_id, run_id, occasion, deficiency_codes)
    values ('mz0probe-a1', a, 'mz0asmt-1', 'mz0run-1', 'delivered', '{thesis-unclear}');
  insert into public.assessment_feedback (id, user_id, assessment_id, run_id, occasion)
    values ('mz0probe-a2', a, 'mz0asmt-1', 'mz0run-2', 'delivered');
  select count(*) into n from public.assessment_feedback where user_id = a and occasion = 'delivered';
  if n <> 2 then
    raise exception '0023 FAILED: two runs on one assessment did not both record (found %), so redrafts would be undercounted.', n;
  end if;
  checked := checked + 1;

  insert into public.assessment_feedback (id, user_id, assessment_id, run_id, occasion, rating)
    values ('mz0probe-r1', a, 'mz0asmt-1', 'mz0run-1', 'rated', 'partly');
  begin
    insert into public.assessment_feedback (id, user_id, assessment_id, run_id, occasion, rating)
      values ('mz0probe-r2', a, 'mz0asmt-1', 'mz0run-1', 'rated', 'yes');
    raise exception '0023 FAILED: one run was rated twice.';
  exception when unique_violation then null;
  end;
  checked := checked + 1;

  insert into public.assessment_feedback (id, user_id, assessment_id, occasion, rating, mark, band)
    values ('mz0probe-m1', a, 'mz0asmt-1', 'on_mark', 'yes', 72, 'Distinction');
  begin
    insert into public.assessment_feedback (id, user_id, assessment_id, occasion, rating)
      values ('mz0probe-m2', a, 'mz0asmt-1', 'on_mark', 'no');
    raise exception '0023 FAILED: one assessment was asked about its mark twice.';
  exception when unique_violation then null;
  end;
  checked := checked + 1;

  begin
    insert into public.assessment_feedback (id, user_id, assessment_id, run_id, occasion, rating, mark)
      values ('mz0probe-x1', a, 'mz0asmt-1', 'mz0run-3', 'rated', 'yes', 50);
    raise exception '0023 FAILED: a mark was stored on a row that is not on_mark.';
  exception when check_violation then null;
  end;
  checked := checked + 1;

  -- The cascade: deleting the auth user removes every probe row.
  delete from auth.users where id = a;
  select count(*) into n from public.assessment_feedback where user_id = a;
  if n <> 0 then
    raise exception '0023 FAILED: % rows survived their account.', n;
  end if;
  checked := checked + 1;

  if checked <> 11 then
    raise exception '0023 FAILED: only % of 11 properties were checked.', checked;
  end if;

  raise notice '0023 applied and verified: % properties checked.', checked;
end;
$$;
