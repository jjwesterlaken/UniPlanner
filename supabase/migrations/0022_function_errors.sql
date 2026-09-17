-- ---------------------------------------------------------------------
-- 0022: function_errors — the server's own breakages, where a daily
-- digest can read them.
--
-- 0010 gave the CLIENT a place to report a crash, and said in its own
-- header why: "it broke on my phone" has to arrive as a message and a
-- stack rather than as a support conversation. The server half was
-- never built. Every Edge Function already writes one structured
-- FAILURE line per failed request (ai-notes/diagnostics.js), and those
-- lines go to the platform log viewer — which nothing can query on a
-- schedule, which no email can be built from, and which is only ever
-- read by somebody who already suspects something is wrong.
--
-- That is how the revoked OpenAI key stayed unexplained: the signature
-- was two stages failing for two different reasons, plainly visible in
-- the logs, and invisible to anybody not reading them.
--
-- SAME DECISION AS 0010, AND IT IS THE LOAD-BEARING ONE: rows land in
-- OUR OWN project. No Sentry, no third-party processor. The privacy
-- policy says nothing third-party is in the bundle, test-local-only
-- pins it, and a US processor would undo both and cost a consent bump.
--
-- WRITTEN AND READ ONLY BY THE SERVICE ROLE, and this is the mirror
-- image of 0010 rather than a copy of it. A client has no business
-- writing here at all: every row comes from an Edge Function's own
-- failure path through the service-role client, so anon and
-- authenticated get NOTHING — not insert, not select, and no policy of
-- any kind. RLS is on regardless, which is what makes a future
-- accidental grant inert rather than open (0008).
--
-- ---------------------------------------------------------------------
-- THERE IS DELIBERATELY NO user_id COLUMN, and that is the decision in
-- this migration most worth reading.
--
-- The obvious shape is `client_errors`': a nullable user_id, covered by
-- the cascade and by delete_my_account_data(). It was written that way
-- first and then taken out, because of what NULL would have meant.
--
-- Most failures happen before an account is resolved — an env check, a
-- signature, an event for a user we do not hold — so a null has to mean
-- "no account was known". But not one of the ~87 logFailure call sites
-- in this repository passes a user id today, so a null would ALSO mean
-- "this call site does not supply one". Two readings of one null, which
-- is the confusion `fetchNote`'s three outcomes exist to refuse, in a
-- data column where nothing downstream could tell them apart.
--
-- So attribution is not half-built. What makes that cost nothing is
-- that the one account-shaped field the failure lines carry —
-- `app_user_id`, the id a webhook could not match — is ALREADY recorded
-- in billing_events, which IS covered by account deletion. The
-- recorder drops it here rather than storing an account identifier in a
-- table no deletion reaches, and a test pins the field list the way the
-- client reporter's six fields are pinned.
--
-- If attribution is ever wanted, it arrives as a migration AND the call
-- site edits that make the null unambiguous, in one change.
-- ---------------------------------------------------------------------
--
-- IT HOLDS NO STUDENT CONTENT, AND THAT IS ENFORCED AT TWO LAYERS.
-- `describeError`/`redact` already strip query strings, JWTs, provider
-- keys and long tokens out of every message and stack before they are
-- printed, and the stored values are those same strings. The column
-- checks below are the backstop: a runaway provider error cannot store
-- megabytes per row.
--
-- IT WIDENS, so it goes BEFORE the deploy of the functions that write
-- it. A function deployed first would have every insert rejected with
-- "relation does not exist" — logged, harmless to the request, and the
-- digest would report nothing for a week while looking healthy. That is
-- 0003/0004's direction, not 0008's.
-- ---------------------------------------------------------------------

create table if not exists public.function_errors (
  id uuid primary key default gen_random_uuid(),
  -- Which function, so a digest line points at a file. Never derived
  -- from a request: each function passes its own name.
  fn text not null check (char_length(fn) <= 64),
  -- The stage label that already travels into the logs and into the
  -- error response, so the digest groups by the same thing a person
  -- greps for.
  stage text not null check (char_length(stage) <= 64),
  -- The error's name or the provider's code. Redacted like everything
  -- else, because a provider sometimes puts a key fragment in one.
  name text check (char_length(name) <= 200),
  message text check (char_length(message) <= 2000),
  stack text check (char_length(stack) <= 8000),
  -- Whatever the failure line carried beside those: event ids,
  -- booleans, HTTP statuses. Never the student's text, and never an
  -- account identifier — see the header.
  detail jsonb,
  occurred_at timestamptz not null default now()
);

alter table public.function_errors enable row level security;

-- No policies at all, for either client role: the service-role client
-- bypasses RLS and everything that writes here uses it. The revoke
-- clears the platform default (0008) — Supabase grants ALL to anon and
-- authenticated on every table the SQL editor creates, and a granted
-- verb with no policy is how a privilege sits open unnoticed.
revoke all on public.function_errors from anon, authenticated;

-- The digest reads a day at a time and purges by age.
create index if not exists function_errors_occurred_idx
  on public.function_errors (occurred_at desc);

comment on table public.function_errors is
  'One row per failed Edge Function request, written by the service role from the function''s own failure path. Holds which function, which stage, the redacted error, and the ids the failure line carried — never a transcript, never a note, never anything a student typed, and deliberately no account identifier: see 0022''s header for why a nullable user_id was refused. Purged after 30 days by the error-digest function.';

-- ---------------------------------------------------------------------
-- The daily digest's schedule.
--
-- pg_cron calling pg_net calling the function, the 0004 arrangement,
-- and every reason it is shaped this way is 0004's: both extensions are
-- enabled per project in the dashboard rather than by SQL, and the
-- migration tests run against a plain postgres container that has
-- neither — so a project without them gets a migration that applies
-- cleanly and a NOTICE naming what is missing, rather than a failure.
--
-- THE JOB AUTHENTICATES WITH A DEDICATED SECRET, never the service role
-- key, for the reason written down beside the retention sweep: pg_net
-- stores each outbound request — headers included — in
-- net.http_request_queue until its TTL expires, so whatever
-- authenticates this job sits at rest in a database table for hours at
-- a time. `error_digest_secret` only lets its holder trigger a digest
-- to an address the function reads from its own environment. The
-- service role key there would be a full-database credential in a
-- queue table.
--
-- ONE EMAIL A DAY, never one per error. A message per failure is a
-- message nobody reads, and a loop inside a function would send
-- thousands of them.
-- ---------------------------------------------------------------------

do $$
declare
  fn_url text;
begin
  if pg_catalog.to_regclass('cron.job') is null then
    raise notice 'pg_cron is not enabled — the error digest will NOT be sent. Enable pg_cron and pg_net in the Supabase dashboard (Database → Extensions), then re-run this migration.';
    return;
  end if;
  if pg_catalog.to_regproc('net.http_post') is null then
    raise notice 'pg_net is not enabled — the digest cannot call the Edge Function. Enable pg_net in the Supabase dashboard, then re-run this migration.';
    return;
  end if;

  -- Read from Vault at schedule time so no secret is written into a
  -- tracked migration. The job body reads the OTHER secret at execution
  -- time, so the credential is never stored in cron.job's command text
  -- either — only the lookup that fetches it.
  select decrypted_secret into fn_url
  from vault.decrypted_secrets where name = 'error_digest_function_url';

  if fn_url is null then
    raise notice 'Vault secret error_digest_function_url is missing — skipping the cron schedule. See SUPABASE-SETUP.md.';
    return;
  end if;

  perform cron.unschedule('error-digest')
  where exists (select 1 from cron.job where jobname = 'error-digest');

  -- 21:00 UTC is 07:00 the next morning in Sydney, which is when
  -- somebody can act on it. Deliberately NOT midnight UTC: that is
  -- mid-morning here, and a digest read in the middle of the day is one
  -- that arrives hours after the thing it is about started.
  perform cron.schedule(
    'error-digest',
    '0 21 * * *',
    format(
      $job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'error_digest_secret')
        ),
        body := jsonb_build_object('digest', true)
      );
      $job$,
      fn_url
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- The self-check. A MIGRATION THAT REPORTS SUCCESS HAVING DONE NOTHING
-- is the failure 0016 was written for: delete_my_account() did not exist
-- in production for a year because 0002 skipped silently, and "the
-- migration exists" and "the object exists" are different claims.
--
-- A DO block is one statement, so a failure anywhere below rolls the
-- whole thing back, probes included.
-- ---------------------------------------------------------------------
do $$
declare
  checked int := 0;
  n int;
begin
  if pg_catalog.to_regclass('public.function_errors') is null then
    raise exception '0022 FAILED: public.function_errors does not exist.';
  end if;
  checked := checked + 1;

  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.function_errors'::regclass and relrowsecurity
  ) then
    raise exception '0022 FAILED: row level security is not enabled on function_errors.';
  end if;
  checked := checked + 1;

  -- NOTHING CLIENT-SIDE MAY TOUCH IT, IN EITHER DIRECTION. RLS with no
  -- policies already returns nothing, but a grant with no policy is how
  -- a privilege sits open unnoticed — and unlike client_errors, INSERT
  -- is refused as well, because no client has any business writing here.
  if has_table_privilege('anon', 'public.function_errors', 'select')
     or has_table_privilege('authenticated', 'public.function_errors', 'select')
     or has_table_privilege('anon', 'public.function_errors', 'insert')
     or has_table_privilege('authenticated', 'public.function_errors', 'insert') then
    raise exception '0022 FAILED: anon or authenticated can read or write function_errors.';
  end if;
  checked := checked + 1;

  if exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'function_errors'
  ) then
    raise exception '0022 FAILED: function_errors has a policy, so some client role is expected to reach it.';
  end if;
  checked := checked + 1;

  -- NO ACCOUNT COLUMN, asserted rather than left to the header. This is
  -- the property the whole no-attribution decision rests on: the day
  -- somebody adds one, account deletion has to cover it and both
  -- published documents have to change, and this is where they find out.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'function_errors' and column_name = 'user_id'
  ) then
    raise exception '0022 FAILED: function_errors has a user_id column. Adding one means covering it in delete_my_account_data() and changing both published documents — see this migration''s header.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: the service role can really write a row, and the
  -- column bounds really refuse an unbounded one. A table nothing can
  -- insert into would satisfy every assertion above.
  insert into public.function_errors (fn, stage, name, message, stack, detail)
    values ('ai-notes', 'summarise', 'Error', 'probe', 'probe', '{"id":"evt_probe"}'::jsonb);
  select count(*) into n from public.function_errors where message = 'probe';
  if n <> 1 then
    raise exception '0022 FAILED: the service role could not write a row.';
  end if;
  checked := checked + 1;

  begin
    insert into public.function_errors (fn, stage, message)
      values (repeat('x', 65), 'summarise', 'too long');
    raise exception '0022 FAILED: an over-long fn was accepted, so the column bounds are not enforced.';
  exception
    when check_violation then null;
  end;
  checked := checked + 1;

  delete from public.function_errors where message = 'probe';

  if checked <> 7 then
    raise exception '0022 FAILED: only % of 7 properties were checked.', checked;
  end if;

  raise notice '0022 applied and verified: % properties checked.', checked;
end;
$$;
