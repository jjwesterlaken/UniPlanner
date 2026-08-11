-- Two things the privacy and account-deletion pages have to be able to
-- claim truthfully.
--
-- ---------------------------------------------------------------------
-- 1. Let a user delete their own staged audio.
--
-- 0001 gave the lecture-audio bucket insert, select and update policies
-- scoped to the caller's own folder, and deliberately NO delete policy:
-- the rule there was "deletion only ever happens server-side via the
-- service-role client".
--
-- That rule has one case it gets wrong. delete_my_account_data() cannot
-- remove storage objects at all -- a SQL delete on storage.objects drops
-- the index row and leaves the file in the backing store, which is why
-- 0002 explicitly does not try. So the only thing that ever removed a
-- deleted user's audio was the hourly orphan sweep, which meant the
-- deletion page could only promise "within an hour" for the single most
-- sensitive artifact in the system.
--
-- A folder-scoped delete policy closes that: the account-deletion flow
-- removes the caller's own objects through the Storage API (which does
-- delete the file) before calling the RPC, so "everything is deleted
-- immediately" is true rather than nearly true. The policy is scoped by
-- auth.uid() exactly like the other three, so it cannot reach another
-- user's folder, and the service-role sweep still runs as a backstop for
-- anything a client abandons.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'lecture_audio_own_folder_delete'
  ) then
    execute $p$
      create policy "lecture_audio_own_folder_delete"
        on storage.objects for delete to authenticated
        using (
          bucket_id = 'lecture-audio'
          and (storage.foldername(name))[1] = auth.uid()::text
        )
    $p$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Make the retention sweep actually happen on a schedule.
--
-- scheduleCleanup() in the Edge Function runs opportunistically, AFTER a
-- request completes. So "transcripts are deleted after 7 days" was only
-- true if somebody happened to record a lecture after those 7 days. With
-- a quiet month, nothing swept and the retention promise was false --
-- which is not an acceptable state for a published privacy policy.
--
-- The sweep has to invoke the Edge Function rather than run as pure SQL,
-- because deleting the audio objects needs the Storage API. So this is
-- pg_cron calling pg_net, calling the function.
--
-- Guarded on both extensions existing, for two reasons: they are enabled
-- per-project in the dashboard rather than by SQL, and the migration
-- tests run against a plain postgres container that has neither. A
-- project without them still gets a migration that applies cleanly --
-- and the notice says what is missing rather than leaving it silent.
-- ---------------------------------------------------------------------

do $$
declare
  fn_url text;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not enabled — the retention sweep will NOT run on a schedule. Enable pg_cron and pg_net in the Supabase dashboard (Database → Extensions), then re-run this migration.';
    return;
  end if;
  if to_regproc('net.http_post') is null then
    raise notice 'pg_net is not enabled — the retention sweep cannot call the Edge Function. Enable pg_net in the Supabase dashboard, then re-run this migration.';
    return;
  end if;

  -- Read from Vault at schedule time so no secret is written into a
  -- tracked migration. The job body reads the OTHER secret at execution
  -- time, so the credential is never stored in cron.job's command text
  -- either -- only the lookup that fetches it.
  select decrypted_secret into fn_url
  from vault.decrypted_secrets where name = 'ai_notes_function_url';

  if fn_url is null then
    raise notice 'Vault secret ai_notes_function_url is missing — skipping the cron schedule. See SUPABASE-SETUP.md.';
    return;
  end if;

  perform cron.unschedule('ai-notes-retention-sweep')
  where exists (select 1 from cron.job where jobname = 'ai-notes-retention-sweep');

  -- Hourly, on the hour. The sweep is idempotent and cheap: two deletes
  -- by age plus a storage listing.
  perform cron.schedule(
    'ai-notes-retention-sweep',
    '0 * * * *',
    format(
      $job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ai_notes_sweep_secret')
        ),
        body := jsonb_build_object('sweepOnly', true)
      );
      $job$,
      fn_url
    )
  );
end;
$$;
