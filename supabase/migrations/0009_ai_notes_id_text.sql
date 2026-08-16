-- ai_notes.id becomes text, because the planner's page ids are not UUIDs
-- and never were.
--
-- THE BUG THIS FIXES, and it means the storage move has never once run
-- in production:
--
-- `migrateNote` sends `id: page.id`. A page id comes from the planner's
-- own `uid()` helper — "msn0duf5-hk684", base36, short. This column was
-- typed `uuid`, so Postgres rejected every single insert with 22P02
-- (invalid input syntax), PostgREST returned 400, and the client retried
-- on the next sync. Forever. `ai_notes` has been empty since 0005 for
-- this reason, on every account, regardless of anything else.
--
-- The irony worth recording: aiNotesLogic.js documents exactly this trap
-- for `ai_notes_requests.idempotency_key`, which is why
-- `newIdempotencyKey()` exists — "Those are stored in the user's own
-- JSON blob where the format doesn't matter; this one crosses into a
-- typed database column where it does." The page id crossed the same
-- boundary one table over and kept the blob's format.
--
-- WHY THE COLUMN MOVES RATHER THAN THE CLIENT: real devices already
-- hold notes whose page ids are base36, and those ids are the join
-- between the blob's stub and this row. Minting UUIDs for new notes
-- would leave every existing note permanently unmigratable, so the
-- column is what gives. Nothing depends on the uuid TYPE here — RLS
-- scopes on user_id, and the id is an opaque key the client already
-- owns. `semester_archives.id` is unaffected: it is minted by
-- newIdempotencyKey() and really is a UUID.
--
-- Safe to apply with rows present: every existing uuid casts to text
-- unchanged, and the primary key is preserved.

alter table public.ai_notes
  alter column id type text using id::text;

comment on column public.ai_notes.id is
  'The planner page id verbatim. TEXT, not uuid: page ids come from the planner blob''s own short-id helper, and a uuid column rejected every insert with 22P02 from 0005 until 0009.';
