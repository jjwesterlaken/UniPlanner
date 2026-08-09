-- AI lecture notes: tier gating, usage metering, idempotent request
-- tracking, and the storage policies for transiently-staged audio.
--
-- Run with `supabase db push`, or paste into the SQL editor. After this
-- runs, see SUPABASE-SETUP.md for the remaining manual steps (creating
-- the lecture-audio bucket, setting secrets, deploying the function,
-- and flipping your own account to tier='ai').

-- ---------------------------------------------------------------------
-- profiles: minimal tier gate. No billing UI — tier is flipped by hand
-- in the dashboard until real billing exists.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'free',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = user_id);
-- Deliberately no insert/update/delete policy for the authenticated role:
-- tier changes only ever happen via the dashboard (service role), never
-- from the client.

-- Every new signup gets a 'free' row automatically. SECURITY DEFINER is
-- required: without it this trigger runs as supabase_auth_admin, which
-- has no write access to public.profiles, and since it fires inside the
-- signup transaction, that failure would roll back the signup itself.
create function public.handle_new_profile()
returns trigger language plpgsql
security definer set search_path = public
as $$ begin
  insert into public.profiles (user_id, tier) values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_profile();

-- Backfill for anyone who signed up before this migration ran.
insert into public.profiles (user_id, tier)
select id, 'free' from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- ai_usage: server-metered monthly minutes, one row per user per month.
-- All writes happen via the Edge Function's service-role client, which
-- bypasses RLS by design — never from the client directly.
-- ---------------------------------------------------------------------
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,                 -- 'YYYY-MM', UTC
  minutes_used numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);
alter table public.ai_usage enable row level security;

create policy "ai_usage_select_own"
  on public.ai_usage for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- ai_notes_requests: idempotency ledger, keyed by a client-generated key
-- per recording, so a retry after a timeout doesn't get double-billed.
-- `result` is a full duplicate of the user's lecture content, so this
-- table gets a 7-day retention sweep (run opportunistically by the Edge
-- Function itself, see supabase/functions/ai-notes/index.ts
-- scheduleCleanup) rather than being kept forever.
-- ---------------------------------------------------------------------
create table if not exists public.ai_notes_requests (
  idempotency_key uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'processing', -- 'processing' | 'done' | 'failed'
  result jsonb,
  minutes_billed numeric,
  created_at timestamptz not null default now()
);
alter table public.ai_notes_requests enable row level security;

create policy "ai_notes_requests_select_own"
  on public.ai_notes_requests for select
  using (auth.uid() = user_id);

create index if not exists ai_notes_requests_created_at_idx
  on public.ai_notes_requests (created_at);

-- ON DELETE CASCADE on every user_id foreign key above means deleting the
-- auth.users row (however that happens) always removes all three tables'
-- data too — including ai_notes_requests.result, which is just as
-- privacy-sensitive as the note itself. See SUPABASE-SETUP.md for the
-- extra snippet to add to your existing delete_my_account() function as
-- a belt-and-braces measure (that function isn't tracked in this repo).

-- ---------------------------------------------------------------------
-- Storage: private bucket + RLS-style policies scoped to the caller's
-- own folder ("<user_id>/<idempotency_key>.<ext>"). The bucket itself
-- isn't created by SQL — see SUPABASE-SETUP.md.
-- ---------------------------------------------------------------------
create policy "lecture_audio_own_folder_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'lecture-audio' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "lecture_audio_own_folder_select"
  on storage.objects for select to authenticated
  using (bucket_id = 'lecture-audio' and (storage.foldername(name))[1] = auth.uid()::text);

-- Lets a client retry (`upsert: true`) re-create an object at the same
-- key if the Edge Function ever reports recording_missing — without
-- this, that recording would be permanently unprocessable.
create policy "lecture_audio_own_folder_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'lecture-audio' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'lecture-audio' and (storage.foldername(name))[1] = auth.uid()::text);

-- No client-side delete policy — deletion only ever happens server-side
-- via the service-role client (Edge Function step 10, and the orphan
-- sweep in scheduleCleanup), matching the "writes are service-role-only"
-- pattern used for ai_usage/ai_notes_requests above.
