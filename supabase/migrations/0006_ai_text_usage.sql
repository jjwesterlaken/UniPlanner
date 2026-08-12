-- Text AI features get their own allowance, beside the audio one.
--
-- Two allowances rather than one unified unit, because they answer two
-- questions a student actually asks separately -- "how many lectures can
-- I still record" and "how much study help have I got left" -- and a
-- single number covering both would be explicable to nobody.
--
-- A COLUMN, not a table. It is the same question about the same month
-- for the same user, so a second table would need its own RLS policies,
-- its own line in delete_my_account_data(), its own entry in both
-- published documents, and its own scoping to get wrong. None of that
-- buys anything.
--
-- ---------------------------------------------------------------------
-- ORDERING, and why this one is worse than 0005 if it slips.
--
-- 0005 unapplied is a quiet no-op: notes stay whole and the sync retries.
-- This one is not so kind. If the code shipped first and the column were
-- missing, a naive endpoint would call the provider, spend money, and
-- THEN fail writing the bill -- so the student sees an error for work
-- that was really done and really paid for.
--
-- That interleaving is unreachable by construction rather than by
-- instruction: ai-text reads text_units_used at the allowance check,
-- which is BEFORE the provider call. A missing column fails that read,
-- so the request errors having spent nothing. A test asserts the read
-- precedes the call, because the ordering is only a guarantee for as
-- long as nobody reorders it.
--
-- Apply it first anyway. The structure is a backstop, not a licence.
-- ---------------------------------------------------------------------

alter table public.ai_usage
  add column if not exists text_units_used numeric not null default 0;

comment on column public.ai_usage.text_units_used is
  'Monthly allowance consumed by the text AI features, weighted per task (see supabase/functions/ai-text/config.ts). NOT NULL DEFAULT 0 so a row that predates this column reads as "none used" rather than null, which would make every comparison against the limit silently false.';

-- delete_my_account_data() already clears public.ai_usage wholesale, so
-- a new COLUMN needs nothing there -- unlike a new table, which does.
-- The migration test enumerates public tables with a user_id column from
-- the database and asserts the function empties all of them, so that
-- distinction is checked rather than assumed.
