-- Grant audit: make an unauthorised read FAIL rather than come back empty.
--
-- WHY, and it is worth reading before touching any grant here:
--
-- Supabase configures default privileges so every table created in the
-- SQL editor arrives with ALL verbs granted to BOTH `anon` and
-- `authenticated`. Our migrations only ever ran `grant`, which adds and
-- never subtracts, so those defaults stood on every table. 0007 closed
-- `update` on the two three-verb tables. This closes the rest.
--
-- The failure it prevents is SILENT. Every policy in this project is
-- `auth.uid() = user_id`, and 0001's policies carry no role clause at
-- all, so they apply to `public` — which includes `anon`. An
-- unauthenticated request therefore does not get "permission denied":
-- it passes the grant, reaches the policy, evaluates `auth.uid()` to
-- NULL, matches no rows, and comes back as HTTP 200 with an empty
-- array. That is byte-identical to "you have no data", which is
-- exactly the confusion `fetchNote`, `fetchArchive` and the recovery
-- gate are all built to avoid at the client. It cannot be avoided at
-- the client if the SERVER cannot tell the two apart either.
--
-- Revoking anon turns that silence into a 401/permission error, which
-- every one of those readers already handles as "unknown, keep what we
-- have" rather than "gone".
--
-- NOTHING SIGNED OUT LEGITIMATELY READS ANY OF THESE TABLES. The
-- signed-out planner is local-only and proven so by
-- scripts/test-local-only.mjs, which spies every outbound channel.
-- `service_role` is untouched throughout — the Edge Functions rely on
-- it, and it bypasses RLS by design.

-- ---------------------------------------------------------------------
-- 1. anon has no business with any of it.
-- ---------------------------------------------------------------------
revoke all on public.profiles from anon;
revoke all on public.ai_usage from anon;
revoke all on public.ai_notes_requests from anon;
revoke all on public.ai_notes from anon;
revoke all on public.semester_archives from anon;

-- planner_data is created in SUPABASE-SETUP.md rather than by a
-- migration, so it may not exist on a fresh project. Guarded rather
-- than assumed, the same way delete_my_account_data() guards it.
do $$
begin
  if pg_catalog.to_regclass('public.planner_data') is not null then
    execute 'revoke all on public.planner_data from anon';
    -- No delete policy exists: account deletion runs through
    -- delete_my_account_data(), which is security definer and therefore
    -- unaffected by this. A granted delete with no policy is a silent
    -- zero-row no-op, which is the same trap one verb along.
    execute 'revoke delete on public.planner_data from authenticated';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. `authenticated` keeps exactly the verbs its policies name.
--
-- profiles, ai_usage and ai_notes_requests are READ-ONLY to the client:
-- 0001 says so in a comment on profiles ("tier changes only ever happen
-- via the dashboard (service role), never from the client") and the
-- other two are written only by the Edge Functions. The write grants
-- were never used and never intended.
--
-- A test derives this from the database rather than restating it: every
-- verb granted to `authenticated` must be a verb that table has a
-- policy for. That is the guard; this block is only what it enforces.
-- ---------------------------------------------------------------------
revoke insert, update, delete on public.profiles from authenticated;
revoke insert, update, delete on public.ai_usage from authenticated;
revoke insert, update, delete on public.ai_notes_requests from authenticated;
revoke update on public.ai_notes from authenticated;
revoke update on public.semester_archives from authenticated;

comment on table public.ai_notes_requests is
  'Service-role bookkeeping for in-flight AI notes requests. The client may read its own rows for support; every write is service-role.';
