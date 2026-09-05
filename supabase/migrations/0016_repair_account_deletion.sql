-- Repair: public.delete_my_account() was never created in production.
--
-- WHAT HAPPENED, established by reproduction rather than inference.
-- 0002 creates TWO functions. `delete_my_account_data()` it creates
-- unconditionally with `create or replace`, and 0005, 0007 and 0010 each
-- `create or replace` it again as tables were added. `delete_my_account()`
-- it creates inside a DO block that SKIPS when a function of that name
-- already exists, and it is created nowhere else in this repository.
--
-- So a project where 0002 never ran ends up holding exactly one of the
-- two: the data function, created by 0005, and no account function at
-- all. That is precisely what production held on 2026-09-05 — one row,
-- `public.delete_my_account_data`. The client calls
-- `rpc("delete_my_account")`, so in-app deletion failed at step 2 with
-- PostgREST's "function does not exist" and nothing was deleted
-- server-side. Apple and Google both require working in-app deletion.
--
-- THE CONDITIONAL IS THE DEFECT, not an incidental detail. 0002's DO
-- block was written to protect a hand-written `delete_my_account()` that
-- an older project might have had, and its failure mode is a SILENT
-- SKIP: the migration reports success having created nothing, and the
-- NOTICE that explains it scrolls past in a SQL editor nobody reads
-- afterwards. A migration that can succeed while its most important
-- object is absent is not idempotent — it is unobservable.
--
-- SO THIS ONE REPAIRS RATHER THAN SKIPS, in three ways:
--
--   1. `create or replace`, unconditionally. Whatever is there is
--      brought to the definition this repository holds.
--   2. The privileges and comment are re-asserted every run, not only
--      when the function is new. `create or replace` PRESERVES an
--      existing ACL, so a function created by 0005 without 0002's
--      `revoke` has carried PostgreSQL's default EXECUTE-to-PUBLIC ever
--      since — see the revoke on the data function below, which is the
--      same omission one object over.
--   3. It VERIFIES ITSELF at the end and raises. An apply that leaves
--      any asserted property untrue fails loudly instead of returning
--      success, so "the migration was applied" and "the function works"
--      stop being two separate claims that can disagree.
--
-- ON REPLACING A PRE-EXISTING FUNCTION, since that is what 0002 refused
-- to do: the replacement is a SUPERSET of any sensible hand-written one.
-- It calls `delete_my_account_data()` (every table this repo knows) and
-- then deletes the `auth.users` row, and every `user_id` column in this
-- schema is a foreign key with `on delete cascade` — including tables
-- this repo has never heard of, provided they were declared that way.
-- Any prior definition's own deletes are therefore redundant rather than
-- lost. The old body is raised as a NOTICE first so it is not discarded
-- silently, which is the part 0002 was right to care about.

-- ---------------------------------------------------------------------
-- 0. The helper must exist. It is NOT redefined here on purpose: 0010
--    owns its body, and copying it would be the restatement pattern this
--    codebase has fifteen recorded instances of. Assert, don't restate.
-- ---------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regprocedure('public.delete_my_account_data()') is null then
    raise exception
      'public.delete_my_account_data() is missing, so migrations 0002/0005/0007/0010 have not been applied. Apply those first; this migration repairs delete_my_account(), it does not substitute for them.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. Record what is about to be replaced, if anything.
-- ---------------------------------------------------------------------
do $$
declare
  old_def text;
begin
  if pg_catalog.to_regprocedure('public.delete_my_account()') is not null then
    select pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.delete_my_account()')::oid)
      into old_def;
    raise notice 'Replacing an existing public.delete_my_account(). Previous definition follows so it is not lost silently: %', old_def;
  else
    raise notice 'public.delete_my_account() did not exist and is being created. This is the production repair case.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. The function itself.
--
--    SECURITY DEFINER because profiles, ai_usage, ai_notes_requests and
--    the rest deliberately expose no client-side delete policy — the
--    only delete path is this reviewed, auth.uid()-scoped one.
--
--    search_path = '' forces every reference to be schema-qualified, so
--    a table planted in a schema earlier on the caller's search_path
--    cannot hijack what a definer-rights function deletes.
--
--    Staged lecture audio is NOT touched here: a SQL delete on
--    storage.objects drops the index row and leaves the file in the
--    backing store. src/accountDeletion.js removes it through the
--    Storage API BEFORE calling this, because this function ends by
--    deleting the auth.users row and every authenticated request after
--    that fails.
-- ---------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'delete_my_account() must be called by a signed-in user';
  end if;

  perform public.delete_my_account_data();

  -- Belt and braces: every user_id foreign key cascades from here, so
  -- this alone would clear the rows above. Both run so that neither half
  -- silently becomes the only thing standing between a deleted account
  -- and its lecture transcripts.
  delete from auth.users where id = uid;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Privileges, re-asserted on EVERY run for both functions.
--
--    `create or replace` preserves an existing ACL, so a function that
--    was created without these carries PostgreSQL's default — EXECUTE to
--    PUBLIC, which includes anon. Neither function is exploitable that
--    way (both raise when auth.uid() is null, and anon has no uid), but
--    an execute grant nothing needs is one the grant audit in 0008 would
--    have removed had it covered functions as well as tables.
-- ---------------------------------------------------------------------
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

revoke all on function public.delete_my_account_data() from public;
grant execute on function public.delete_my_account_data() to authenticated;

comment on function public.delete_my_account() is
  'Self-service account deletion: removes the caller''s app data and their auth.users row. Repaired by 0016 after 0002''s conditional create skipped it.';
comment on function public.delete_my_account_data() is
  'Deletes the calling user''s planner and AI-notes rows. Does not touch auth.users -- see delete_my_account().';

-- ---------------------------------------------------------------------
-- 4. THE SELF-CHECK. This is what makes the migration observable.
--
--    Every property the deletion flow depends on, asserted against the
--    catalogue after the work rather than assumed from the statements
--    above. An empty result is a failure here, not a pass: each branch
--    raises on the absence it is looking for.
-- ---------------------------------------------------------------------
do $$
declare
  fn      regprocedure;
  secdef  boolean;
  cfg     text[];
  body    text;
  checked int := 0;
begin
  fn := pg_catalog.to_regprocedure('public.delete_my_account()');
  if fn is null then
    raise exception 'REPAIR FAILED: public.delete_my_account() does not exist after this migration ran.';
  end if;
  checked := checked + 1;

  select p.prosecdef, p.proconfig, p.prosrc
    into secdef, cfg, body
    from pg_catalog.pg_proc p
   where p.oid = fn::oid;

  if not secdef then
    raise exception 'REPAIR FAILED: delete_my_account() is not SECURITY DEFINER, so it cannot delete rows the caller has no policy for.';
  end if;
  checked := checked + 1;

  /* postgres stores `set search_path = ''` as the proconfig element
     `search_path=""` — with the empty string quoted — so a check for a
     bare `search_path=` is wrong in the direction that fails a correct
     function. Both spellings are accepted; anything ELSE (a real search
     path) is the hijackable case this rejects. */
  if cfg is null or not exists (
    select 1 from unnest(cfg) as c where c in ('search_path=', 'search_path=""')
  ) then
    raise exception 'REPAIR FAILED: delete_my_account() does not set search_path to empty (proconfig = %). A definer-rights function without it can be hijacked by a planted schema.', cfg;
  end if;
  checked := checked + 1;

  if body !~ 'delete_my_account_data' then
    raise exception 'REPAIR FAILED: delete_my_account() does not call delete_my_account_data(), so app rows would survive the deletion.';
  end if;
  checked := checked + 1;

  if body !~ 'auth\.users' then
    raise exception 'REPAIR FAILED: delete_my_account() does not delete from auth.users, so the account itself would survive.';
  end if;
  checked := checked + 1;

  if not pg_catalog.has_function_privilege('authenticated', fn, 'execute') then
    raise exception 'REPAIR FAILED: authenticated cannot execute delete_my_account(), so the in-app flow would still fail.';
  end if;
  checked := checked + 1;

  if pg_catalog.has_function_privilege('anon', fn, 'execute') then
    raise exception 'REPAIR FAILED: anon can execute delete_my_account(); the revoke did not take.';
  end if;
  checked := checked + 1;

  if pg_catalog.has_function_privilege('anon', 'public.delete_my_account_data()', 'execute') then
    raise exception 'REPAIR FAILED: anon can execute delete_my_account_data(); the revoke did not take.';
  end if;
  checked := checked + 1;

  if not pg_catalog.has_function_privilege('authenticated', 'public.delete_my_account_data()', 'execute') then
    raise exception 'REPAIR FAILED: authenticated cannot execute delete_my_account_data().';
  end if;
  checked := checked + 1;

  -- A count, so the block cannot pass by having asserted nothing.
  if checked <> 9 then
    raise exception 'REPAIR FAILED: only % of 9 properties were checked.', checked;
  end if;

  raise notice 'delete_my_account() repaired and verified: % properties checked.', checked;
end;
$$;
