-- ---------------------------------------------------------------------
-- 0025: auth_email_canary — the state of the four-hourly Auth email check.
--
-- On 27 September 2026 every signup and password-reset email failed for
-- hours (Resend `550 domain is not verified`: the Auth SMTP key came
-- from the wrong Resend account, EMAIL-SETUP.md) and nothing of ours
-- noticed, because the error digest reads what Edge Functions record
-- and Auth's SMTP send is done by Supabase Auth itself.
--
-- The auth-email-canary function now asks Auth, every four hours, to send
-- a reset to a canary account we own, and alerts ONCE when that starts
-- failing and ONCE when it recovers. This table is where it remembers
-- which of the two it last told somebody: ONE ROW, id = 1.
--
-- IT HOLDS NOTHING ABOUT ANYONE. A status, two timestamps, what the
-- last probe returned and its HTTP status. Not the canary address (that
-- is a function secret), no user id, no email. It is operational state
-- in the same sense as a cron job's schedule, which is why the
-- published documents do not enumerate it (test-legal.mjs names it in
-- its not-student-data list, with the reason, and checks the reason
-- against the columns).
--
-- Every failed probe ALSO writes a function_errors row, so the daily
-- digest counts every failing run even after the one alert was sent.
--
-- THE SCHEDULE is the 0022 arrangement: pg_cron calling pg_net calling
-- the function, with a DEDICATED secret read from Vault at execution
-- time — pg_net stores each request, headers included, in a queue
-- table for hours, so the service role key must never be the thing
-- that authenticates it. Without pg_cron, pg_net or the two Vault
-- secrets, the migration applies cleanly and raises a NOTICE naming
-- what is missing, rather than failing.
--
-- IT WIDENS, so it is applied BEFORE the function is deployed. A
-- function deployed first would fail every run at "state_read" (500,
-- visible in cron.job_run_details and in the digest), which is loud
-- rather than silent — but it would also record every run's probe
-- with no alert, so apply first.
-- ---------------------------------------------------------------------

create table if not exists public.auth_email_canary (
  id smallint primary key check (id = 1),
  status text not null check (status in ('healthy', 'failing')),
  -- When the current status began: the start of an outage, or of the
  -- recovery. Moves only when the alert for the change was sent.
  since timestamptz not null,
  checked_at timestamptz not null,
  last_probe text not null check (last_probe in ('ok', 'failed', 'unknown')),
  last_http_status integer check (last_http_status between 100 and 599)
);

alter table public.auth_email_canary enable row level security;

-- No policies and no client grants: only the service role touches it.
revoke all on public.auth_email_canary from anon, authenticated;

comment on table public.auth_email_canary is
  'One row (id = 1): whether the four-hourly Auth email canary last found Supabase Auth able to send email, and since when. Written by the auth-email-canary function under the service role. Holds nothing about any user — see 0025''s header.';

-- ---------------------------------------------------------------------
-- The schedule: every four hours (Jared, 29 September 2026).
-- ---------------------------------------------------------------------
do $$
declare
  fn_url text;
begin
  if pg_catalog.to_regclass('cron.job') is null then
    raise notice 'pg_cron is not enabled — the Auth email canary will NOT run. Enable pg_cron and pg_net in the Supabase dashboard (Database → Extensions), then re-run this migration.';
    return;
  end if;
  if pg_catalog.to_regproc('net.http_post') is null then
    raise notice 'pg_net is not enabled — the canary cannot call its Edge Function. Enable pg_net, then re-run this migration.';
    return;
  end if;

  select decrypted_secret into fn_url
  from vault.decrypted_secrets where name = 'auth_canary_function_url';

  if fn_url is null then
    raise notice 'Vault secret auth_canary_function_url is missing — skipping the canary schedule. See SUPABASE-SETUP.md.';
    return;
  end if;

  perform cron.unschedule('auth-email-canary')
  where exists (select 1 from cron.job where jobname = 'auth-email-canary');

  -- EVERY FOUR HOURS, at :17 past (00:17, 04:17, ... UTC): six probes a
  -- day, so an outage is noticed within four hours and costs six Resend
  -- sends a day rather than twenty-four. Off the hour, where scheduled
  -- traffic piles up; the digest's 21:00 is never shared.
  perform cron.schedule(
    'auth-email-canary',
    '17 */4 * * *',
    format(
      $job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'auth_canary_secret')
        ),
        body := jsonb_build_object('probe', true)
      );
      $job$,
      fn_url
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- The self-check (0016). One DO block, so a failure rolls it all back.
-- ---------------------------------------------------------------------
do $$
declare
  checked int := 0;
begin
  if pg_catalog.to_regclass('public.auth_email_canary') is null then
    raise exception '0025 FAILED: public.auth_email_canary does not exist.';
  end if;
  checked := checked + 1;

  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.auth_email_canary'::regclass and relrowsecurity) then
    raise exception '0025 FAILED: row level security is not enabled on auth_email_canary.';
  end if;
  checked := checked + 1;

  if has_table_privilege('anon', 'public.auth_email_canary', 'select')
     or has_table_privilege('authenticated', 'public.auth_email_canary', 'select')
     or has_table_privilege('anon', 'public.auth_email_canary', 'insert')
     or has_table_privilege('authenticated', 'public.auth_email_canary', 'insert')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'auth_email_canary') then
    raise exception '0025 FAILED: a client role can reach auth_email_canary.';
  end if;
  checked := checked + 1;

  -- NOTHING ABOUT ANYONE: the documents do not list this table on the
  -- strength of that, so it is asserted where it would break.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'auth_email_canary'
       and column_name not in ('id', 'status', 'since', 'checked_at', 'last_probe', 'last_http_status')
  ) then
    raise exception '0025 FAILED: auth_email_canary has a column beyond its six. If it is about a person, the published documents must describe this table — see this migration''s header.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: one row, and only one.
  insert into public.auth_email_canary (id, status, since, checked_at, last_probe)
    values (1, 'healthy', now(), now(), 'ok')
    on conflict (id) do nothing;
  begin
    insert into public.auth_email_canary (id, status, since, checked_at, last_probe)
      values (2, 'healthy', now(), now(), 'ok');
    raise exception '0025 FAILED: a second state row was accepted.';
  exception when check_violation then null;
  end;
  checked := checked + 1;

  if checked <> 5 then
    raise exception '0025 FAILED: only % of 5 properties were checked.', checked;
  end if;

  raise notice '0025 applied and verified: % properties checked.', checked;
end;
$$;
