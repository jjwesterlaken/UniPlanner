# Supabase setup

This documents the SQL and dashboard steps for everything that runs on
your Supabase project: the existing account-sync backend (`src/sync.js`
has referenced this file for a while, but it never actually existed
until now) and the new AI lecture notes feature.

## 1. Accounts + sync (`planner_data`)

`src/sync.js`'s `supabaseBackend` stores one JSON blob per signed-in
user. If your project doesn't have this table yet:

```sql
create table if not exists public.planner_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.planner_data enable row level security;

create policy "planner_data_select_own"
  on public.planner_data for select
  using (auth.uid() = user_id);
create policy "planner_data_upsert_own"
  on public.planner_data for insert
  with check (auth.uid() = user_id);
create policy "planner_data_update_own"
  on public.planner_data for update
  using (auth.uid() = user_id);
```

Without RLS switched on here, every signed-in user could read
everyone else's planner — don't skip it.

## 2. AI lecture notes

### 2a. Run the migration

`supabase/migrations/0001_ai_notes.sql` creates `profiles`, `ai_usage`,
`ai_notes_requests`, the signup trigger, and the Storage RLS policies.
Run it with:

```bash
supabase link --project-ref kuhtogvewcooigudmgwj
supabase db push
```

or paste the file's contents into the Supabase dashboard's SQL editor.

### 2b. Create the `lecture-audio` Storage bucket

Bucket creation isn't part of a SQL migration. In the dashboard:
**Storage → New bucket**

- Name: `lecture-audio`
- Public: **off**
- File size limit: 50MB (the free-plan ceiling; the app records at
  32kbps, so a 3-hour lecture is ~43.2MB — comfortably under this)

The RLS policies from the migration take effect automatically once the
bucket exists with this exact name.

### 2c. Provider accounts

Transcription defaults to **Groq** (`whisper-large-v3-turbo`) — about
$0.04/hour versus Deepgram's ~$0.26/hour, which is what makes a generous
monthly minutes allowance viable. Deepgram is still fully supported and
selectable (see 2f) for A/B testing or as a fallback, so it's worth
setting up too if you want that option available.

| Provider | What it's for | Where to get a key |
|---|---|---|
| [Groq](https://console.groq.com) | Transcription (default) | Sign up → API Keys → create a key |
| [Deepgram](https://deepgram.com) | Transcription (optional alternate) | Sign up → create a project → create an API key |
| [OpenAI](https://platform.openai.com) | Structured summarizing + translation (`gpt-4o-mini`) | Sign up → add billing → create an API key |

### 2d. Set secrets

```bash
supabase secrets set GROQ_API_KEY=<your groq key>
supabase secrets set DEEPGRAM_API_KEY=<your deepgram key>
supabase secrets set OPENAI_API_KEY=<your openai key>
```

(`DEEPGRAM_API_KEY` only needs a real value if you actually switch to it —
see 2f — but there's no harm setting it now.)

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` do **not** need to be
set — Supabase auto-injects both into every Edge Function.

### 2e. Deploy the function

```bash
supabase functions deploy ai-notes
```

### 2f. Switching transcription providers

`supabase/functions/ai-notes/config.ts`'s `TRANSCRIPTION_PROVIDER` is
`"groq"` by default. To A/B test on the same recording without a
redeploy, set (and later unset) a secret instead:

```bash
supabase secrets set AI_NOTES_TRANSCRIPTION_PROVIDER=deepgram
# and to go back to the default:
supabase secrets unset AI_NOTES_TRANSCRIPTION_PROVIDER
```

To change the *default* permanently, edit `TRANSCRIPTION_PROVIDER` in
`config.ts` and redeploy.

### 2g. Grant yourself access

There's no billing UI yet, so tier changes are manual. Find your user
id under **Authentication → Users**, then in the SQL editor:

```sql
update public.profiles set tier = 'ai' where user_id = '<your-user-uuid>';
```

(The signup trigger already created your `profiles` row with
`tier = 'free'` — you're just flipping it.)

### 2h. Account deletion

`ON DELETE CASCADE` on every new table's `user_id` foreign key means
deleting a user's `auth.users` row automatically removes their
`profiles`, `ai_usage`, and `ai_notes_requests` rows too — including
`ai_notes_requests.result`, which is a full duplicate of their lecture
content and just as privacy-sensitive as the note itself.

If your project already has a `delete_my_account()` function (it isn't
tracked in this repo, so it couldn't be edited directly as part of this
change), add these lines to it as a belt-and-braces measure, in case it
deletes app data without deleting the `auth.users` row itself:

```sql
delete from public.ai_notes_requests where user_id = auth.uid();
delete from public.ai_usage where user_id = auth.uid();
delete from public.profiles where user_id = auth.uid();
```

### 2i. Before letting real users in: test a long recording

**Not yet confirmed, and worth doing before launch.** Groq's `url`-based
transcription (what this app always uses) has no documented size or
duration ceiling of its own — only the `file` upload path's limits
(25MB free / 100MB dev tier) are documented, and Groq's docs simply
point to `url` as the way around those without stating what its actual
limit is, if any.

**Record and process a real ~2 hour lecture (~29MB at the app's 32kbps
recording rate) before opening this up to real users.** That's the
length that would expose an undocumented ceiling if one exists — the
app's own cap is 3 hours (~43MB), so a 2-hour test leaves headroom to
confirm the gap between "works" and "the app's stated limit" isn't
silently smaller than promised.

If it fails, you'll now get a specific `transcription_too_long` error
(distinct from a generic transcription failure, and the client won't
offer a "Try again" that would just fail identically) — so a real
failure here is safe to test and easy to recognize, not a dead end. If
it does fail below 3 hours, lower `MAX_REQUEST_SECONDS`/`MAX_BODY_BYTES`
in `config.ts` to match what actually works, or plan for chunking long
recordings client-side instead.

## Provider limits this design was built around

Researched while designing this feature, in case you change providers
or limits later:

- Supabase Edge Functions: 256MB memory per worker, 2 second max CPU
  time per request (excluding async I/O), no documented request body
  size limit — see [supabase.com/docs/guides/functions/limits](https://supabase.com/docs/guides/functions/limits).
- Supabase Storage: 50MB per file on the Free plan, up to 500GB on paid
  plans — see [supabase.com/docs/guides/storage/uploads/file-limits](https://supabase.com/docs/guides/storage/uploads/file-limits).
- Groq's audio transcription endpoint accepts a `url` field (as a
  multipart/form-data field, not JSON) alongside `file` — its documented
  25MB (free)/100MB (dev tier) size caps are stated for the `file` upload
  path specifically; Groq's own docs point to `url` as the way to handle
  larger files and don't list a separate ceiling for it — see
  [console.groq.com/docs/speech-to-text](https://console.groq.com/docs/speech-to-text).
  `duration` is only present in the response when
  `response_format=verbose_json` is requested (the default `json` format
  is text-only), which matters since billing depends on that duration.

This is why audio is uploaded straight to Storage from the browser and
handed to the transcription provider via a signed URL, rather than
posted directly to the Edge Function — it avoids betting a core use case
(40+ minute lecture recordings) on an undocumented limit, and keeps the
Edge Function from ever allocating the audio in memory at all. No
recording-length cap change was made for the Groq switch — see the
comment on `MAX_BODY_BYTES` in `config.ts` — but this hasn't been
verified against Groq in practice with a genuinely long recording. See
§2i above — do that test before opening this up to real users.
