-- ---------------------------------------------------------------------
-- 0003: keep a failed summary's result longer than a successful one.
--
-- Why a column rather than reading result->>'summaryFailed': the sweep
-- runs from the Edge Function through PostgREST, and a JSON-path filter
-- can't cleanly express "older than 7 days AND not a failure" for rows
-- whose result is still null (a request that never finished). A real
-- boolean with NOT NULL DEFAULT false makes both sweeps trivial and
-- makes an in-flight row sweep at the short interval, which is right --
-- there is nothing in it to recover.
--
-- The retention difference exists because the two rows are not the same
-- thing. A successful result is a convenience copy of notes the user
-- already has in their planner. A failed one is the ONLY copy of a
-- transcript the user was billed for, taken after the audio was already
-- deleted. See src/aiNotesRetention.js, which carries the same numbers
-- for the user-facing wording.
--
-- Re-runnable, like 0002: `if not exists` throughout.
-- ---------------------------------------------------------------------

alter table public.ai_notes_requests
  add column if not exists summary_failed boolean not null default false;

-- The sweep filters on created_at AND summary_failed, so the existing
-- created_at index alone makes the short sweep scan every failed row.
create index if not exists ai_notes_requests_retention_idx
  on public.ai_notes_requests (summary_failed, created_at);

comment on column public.ai_notes_requests.summary_failed is
  'True when transcription succeeded but summarising did not. Such rows hold the only copy of a transcript the user was billed for, so they are retained 30 days rather than 7.';
