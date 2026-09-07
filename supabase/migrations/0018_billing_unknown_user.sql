-- ---------------------------------------------------------------------
-- 0018 — an event for an account we do not have
--
-- WIDENS. One nullable column and one partial index, so this goes
-- BEFORE the billing-webhook deploy that writes it — the 0003/0004/0015
-- direction, not 0008's. Applying it early is inert: the column is null
-- on every row until the new function ships.
--
-- WHAT WENT WRONG, because the column only makes sense with it. The
-- first real delivery was a TEST event from the RevenueCat dashboard,
-- correctly signed, naming a UUID-shaped app_user_id that has no
-- profiles row. The handler read the profile (`no_such_user`), wrote
-- nothing — correct — and then recorded the event with that id in
-- `billing_events.user_id`, which is a foreign key to auth.users. 23503.
-- The function returned 500, and RevenueCat retries a non-2xx, so the
-- same event would have been redelivered until its retry window expired.
--
-- `user_id` was ALREADY nullable, so the fault was never a NOT NULL
-- violation: it was writing a real id into a column whose whole job is
-- to name one of OUR accounts. The fix is that `user_id` holds an
-- account we matched and nothing else, and the id the store actually
-- sent lives beside it in its own column with no constraint on it.
--
-- WHY KEEP THE ROW AT ALL rather than skipping it. A paid event for a
-- user we do not have is exactly the thing to notice: it means an
-- account was deleted with a live subscription, or the client is
-- configuring RevenueCat before sign-in, or the webhook is pointed at
-- the wrong project. Dropping it on the floor makes all three silent.
-- Keeping it also keeps the idempotency guarantee uniform — the primary
-- key is the EVENT id and has never depended on user_id, so a
-- redelivered unknown event is still one row, exactly as a redelivered
-- known one is.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. The id the store sent, verbatim
-- ---------------------------------------------------------------------
--
-- TEXT AND UNCONSTRAINED, deliberately. A RevenueCat app_user_id is
-- whatever the client set it to: ours are Supabase UUIDs, an
-- unauthenticated client's is "$RCAnonymousID:…", and a future
-- integration's could be anything. This is the 0009 boundary seen from
-- the safe side — an id minted elsewhere is stored in a column that
-- accepts any string, instead of a typed one that rejects it after the
-- work is done.
alter table public.billing_events
  add column if not exists app_user_id text;

comment on column public.billing_events.app_user_id is
  'The app_user_id RevenueCat sent, verbatim and unvalidated. user_id is the account we MATCHED (null when we hold none); this is what the store named. Retention follows user_id: a row carrying a live account''s id is deleted with that account, by the cascade and by delete_my_account_data(). A row whose user_id is null names an account that did not exist when the event arrived, so the id resolves to nothing and belongs to nobody.';

-- The forensic query this exists for — "which events arrived for
-- accounts we do not have" — is the one read that cannot use the
-- existing (user_id, received_at) index, because it is looking for the
-- rows where user_id is null.
create index if not exists billing_events_unmatched_idx
  on public.billing_events (received_at desc)
  where user_id is null;

-- ---------------------------------------------------------------------
-- 2. The self-check
-- ---------------------------------------------------------------------
--
-- 0016's lesson, applied to a migration nobody will re-read: an apply
-- must not be able to report success while the end state is wrong. The
-- last two checks are BEHAVIOURAL rather than catalogue reads — they
-- perform the exact insert that failed in production and the exact
-- redelivery it has to stay idempotent under, then remove the probe
-- rows. A DO block is one statement, so a failure anywhere below rolls
-- the whole thing back, probes included.
do $$
declare
  checked   int := 0;
  probe     text := '0018-self-check-probe';
  orphan_id text := '00000000-0000-4000-8000-00000000dead';
  n         int;
begin
  -- The column exists, and is text rather than anything that could
  -- reject an id shape we have not seen.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_events'
      and column_name = 'app_user_id' and data_type = 'text'
  ) then
    raise exception '0018 FAILED: billing_events.app_user_id is absent or is not text.';
  end if;
  checked := checked + 1;

  -- user_id must stay NULLABLE. This is the property the whole fix
  -- rests on, and it was already true — which is why it is asserted
  -- rather than altered. A future migration adding NOT NULL here would
  -- reintroduce the 500 with no other symptom.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_events'
      and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception '0018 FAILED: billing_events.user_id is NOT NULL, so an event for an account we do not have cannot be recorded.';
  end if;
  checked := checked + 1;

  -- And the foreign key must stay. Dropping it would also "fix" the
  -- 23503, by letting the column hold ids that are not accounts —
  -- which is the failure this migration exists to make impossible.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.billing_events'::regclass and contype = 'f'
      and conname = 'billing_events_user_id_fkey'
  ) then
    raise exception '0018 FAILED: the user_id foreign key is gone, so user_id no longer means "one of our accounts".';
  end if;
  checked := checked + 1;

  -- The primary key is the EVENT id. Idempotency has never depended on
  -- user_id, and that is what makes an unknown event idempotent too.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.billing_events'::regclass and contype = 'p'
      and (select array_agg(a.attname order by a.attname)
             from pg_catalog.pg_attribute a
            where a.attrelid = conrelid and a.attnum = any(conkey)) = array['id']::name[]
  ) then
    raise exception '0018 FAILED: billing_events'' primary key is not (id) alone, so a redelivery is no longer refused by the schema.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: the insert that returned 500 in production must now
  -- succeed, with the store's id kept.
  insert into public.billing_events (id, user_id, app_user_id, event_type, tier_before, tier_after)
  values (probe, null, orphan_id, 'TEST', null, null);
  select count(*) into n from public.billing_events
   where id = probe and user_id is null and app_user_id = orphan_id;
  if n <> 1 then
    raise exception '0018 FAILED: an event for an account we do not have still cannot be recorded.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: and a redelivery of it is still one row.
  begin
    insert into public.billing_events (id, user_id, app_user_id, event_type)
    values (probe, null, orphan_id, 'TEST');
    raise exception '0018 FAILED: the same event id was accepted twice, so an unknown event is not idempotent.';
  exception
    when unique_violation then null;                 -- what must happen
  end;
  select count(*) into n from public.billing_events where id = probe;
  if n <> 1 then
    raise exception '0018 FAILED: a redelivered unknown event left % rows.', n;
  end if;
  checked := checked + 1;

  delete from public.billing_events where id = probe;

  -- The count, so the block cannot pass having checked nothing.
  if checked <> 6 then
    raise exception '0018 FAILED: only % of 6 properties were checked.', checked;
  end if;

  raise notice '0018 applied and verified: % properties checked.', checked;
end;
$$;
