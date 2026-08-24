-- ---------------------------------------------------------------------
-- 0015 — one device at a time, for the tiers whose allowance is a trial
--
-- WIDENS. Two columns and a function the client will call, so this goes
-- BEFORE the code that needs it (the 0003/0004 direction, not 0008's).
-- Applying it early is inert: nothing reads the columns until the client
-- ships, and an unclaimed account reads as "no device claimed", which is
-- the state every existing account is already in.
--
-- WHAT THIS IS FOR. A trial tier's 60 credits are once ever. Sharing one
-- account across a household multiplies that by however many devices
-- sign in, and the allowance is the only thing standing between a free
-- account and unbounded provider spend. Paid tiers are unaffected:
-- they buy a monthly allowance, and where they use it is their business.
--
-- WHAT THIS IS NOT. It is friction, not device binding. The identifier
-- is minted by the client and kept in localStorage, so clearing site
-- data mints a new one, and two browsers on one machine are two
-- devices. Anything stronger would mean fingerprinting, which this app
-- does not do and whose privacy policy says so. The goal is that
-- casually sharing one login stops working, not that a determined
-- person cannot.
-- ---------------------------------------------------------------------

alter table public.profiles
  add column if not exists active_device_id text,
  add column if not exists active_device_at timestamptz;

comment on column public.profiles.active_device_id is
  'The device that most recently claimed this account, for the one-device-at-a-time rule on trial tiers. Client-minted and therefore any format — see 0009 for why an id that crosses into a typed column must not be assumed to be a UUID. Null means no device has claimed it, which is what every account created before 0015 reads as.';

comment on column public.profiles.active_device_at is
  'When the current device claimed the account. Not read by the rule — kept so a support question ("when did I get signed out?") has an answer.';

-- ---------------------------------------------------------------------
-- claim_device — the ONLY write the client may make to profiles.
--
-- SECURITY DEFINER, and the reason is the opposite of add_trial_credits'.
-- That one is INVOKER because the caller names the user, so a leaked
-- execute grant would mean "spend anybody's trial". Here the caller
-- names NOTHING: the row is chosen by auth.uid() inside the function,
-- so the grant cannot be pointed at another account no matter who holds
-- it. Definer is what lets an authenticated client write these two
-- columns while `profiles` stays read-only to that role.
--
-- THAT READ-ONLINESS IS LOAD-BEARING AND MUST NOT BE RELAXED. `tier`
-- lives on this table. Granting `update on public.profiles` to
-- `authenticated` so the client could write a device id would also let
-- any student set their own tier to 'ai_max' — the whole allowance
-- system, in one grant. A function that writes exactly two named
-- columns is the narrow version of the same capability.
--
-- Returns the row it wrote, so the caller confirms the claim landed
-- rather than assuming it did.
-- ---------------------------------------------------------------------
create or replace function public.claim_device(p_device_id text)
returns table (active_device_id text, active_device_at timestamptz)
language sql
security definer
set search_path = public, pg_catalog
as $$
  update public.profiles
     set active_device_id = nullif(p_device_id, ''),
         active_device_at = now()
   where profiles.user_id = auth.uid()
  returning profiles.active_device_id, profiles.active_device_at;
$$;

comment on function public.claim_device(text) is
  'Records this device as the account''s active one and returns what was written. Scoped to auth.uid() inside the function, so it can only ever affect the caller''s own row. Unconditional by tier on purpose: the enforcement branch lives in exactly one place on the client, and keeping the column accurate for every account means a tier change takes effect at once rather than at the next sign-in.';

-- anon has no business here: a signed-out caller has no auth.uid(), so
-- the update would match nothing and return empty — the silent "no"
-- that 0008 exists to eliminate. Refusing outright makes it an error.
revoke all on function public.claim_device(text) from public;
revoke all on function public.claim_device(text) from anon;
grant execute on function public.claim_device(text) to authenticated;
