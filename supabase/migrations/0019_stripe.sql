-- ---------------------------------------------------------------------
-- 0019 — the Stripe customer, and only that
--
-- WIDENS. One nullable column, so this goes BEFORE the functions that
-- write it — the 0003/0004/0015/0018 direction. Applying it early is
-- inert: nothing reads or writes it until billing-checkout is deployed
-- AND configured with a Stripe key, which is the flag Phase 6 is built
-- behind.
--
-- WHAT IT IS FOR. Stripe's Customer Portal — the only place a student
-- can cancel or change a Stripe plan — is opened from a CUSTOMER ID,
-- and a session created for a customer id grants access to that
-- customer's billing. So the id is the one value a client must never be
-- able to name, and it lives here, scoped to a user_id, read only by a
-- function that has already verified the caller's JWT.
--
-- **UNIQUE, AND THAT IS THE POINT.** Two accounts sharing one Stripe
-- customer would mean either could open the other's Portal and see the
-- other's invoices. The constraint is what makes that unreachable
-- rather than merely unintended — the same reasoning as the "never
-- match a customer by email" rule in billing-checkout, which is the
-- account-takeover shape CLAUDE.md's service-role section is about.
--
-- NO POLICY IS ADDED. `profiles` is read-only to `authenticated` and
-- the tier columns are written only by the service role (0017); this
-- column is the same. A student never needs to see it.
-- ---------------------------------------------------------------------

alter table public.profiles
  add column if not exists stripe_customer_id text;

do $$ begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_stripe_customer_id_key'
  ) then
    alter table public.profiles add constraint profiles_stripe_customer_id_key unique (stripe_customer_id);
  end if;
end $$;

comment on column public.profiles.stripe_customer_id is
  'The Stripe customer this account is, once it has bought anything through Stripe. Written only by billing-checkout, under the service role, for the uid in a verified JWT — never matched by email. UNIQUE because a Customer Portal session created for a customer id grants access to that customer''s billing, so two accounts sharing one would each be able to open the other''s.';

-- ---------------------------------------------------------------------
-- The self-check
-- ---------------------------------------------------------------------
--
-- 0016's lesson: an apply must not be able to report success while the
-- end state is wrong. The last two are BEHAVIOURAL — they perform the
-- write the functions will perform and the collision that must be
-- refused — and then remove the probes. A DO block is one statement, so
-- a failure anywhere below rolls the whole thing back, probes included.
do $$
declare
  checked int := 0;
  a uuid := '00000000-0000-4000-8000-0000000019a1';
  b uuid := '00000000-0000-4000-8000-0000000019b2';
  n int;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'stripe_customer_id' and data_type = 'text'
  ) then
    raise exception '0019 FAILED: profiles.stripe_customer_id is absent or is not text.';
  end if;
  checked := checked + 1;

  -- NULLABLE. Every account that has never touched Stripe — which is
  -- every account today and every account that buys on a phone — sits
  -- here forever, and a NOT NULL would make the signup trigger fail.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'stripe_customer_id' and is_nullable = 'NO'
  ) then
    raise exception '0019 FAILED: stripe_customer_id is NOT NULL, so no account could be created without a Stripe customer.';
  end if;
  checked := checked + 1;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'u'
      and conname = 'profiles_stripe_customer_id_key'
  ) then
    raise exception '0019 FAILED: stripe_customer_id is not unique, so two accounts could share one Stripe customer.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: two accounts, one gets a customer, the other cannot
  -- take the same one.
  insert into auth.users (id) values (a), (b);
  update public.profiles set stripe_customer_id = 'cus_0019probe' where user_id = a;
  select count(*) into n from public.profiles where user_id = a and stripe_customer_id = 'cus_0019probe';
  if n <> 1 then
    raise exception '0019 FAILED: a Stripe customer id could not be stored on a profile.';
  end if;
  checked := checked + 1;

  begin
    update public.profiles set stripe_customer_id = 'cus_0019probe' where user_id = b;
    raise exception '0019 FAILED: two accounts were allowed to share one Stripe customer.';
  exception
    when unique_violation then null;                 -- what must happen
  end;
  checked := checked + 1;

  -- NULL IS NOT A COLLISION. Postgres treats nulls as distinct in a
  -- unique index, which is exactly what is wanted here — asserted
  -- rather than assumed, because a UNIQUE that refused a second null
  -- would let exactly one account exist.
  select count(*) into n from public.profiles where stripe_customer_id is null;
  if n < 1 then
    raise exception '0019 FAILED: no profile can hold a null stripe_customer_id.';
  end if;
  checked := checked + 1;

  delete from auth.users where id in (a, b);

  if checked <> 6 then
    raise exception '0019 FAILED: only % of 6 properties were checked.', checked;
  end if;

  raise notice '0019 applied and verified: % properties checked.', checked;
end;
$$;
