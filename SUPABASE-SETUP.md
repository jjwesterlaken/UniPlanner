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

| Provider | What it's for | Where to get a key |
|---|---|---|
| [Deepgram](https://deepgram.com) | Transcription | Sign up → create a project → create an API key |
| [OpenAI](https://platform.openai.com) | Structured summarizing + translation (`gpt-4o-mini`) | Sign up → add billing → create an API key |

### 2d. Set secrets

```bash
supabase secrets set DEEPGRAM_API_KEY=<your deepgram key>
supabase secrets set OPENAI_API_KEY=<your openai key>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` do **not** need to be
set — Supabase auto-injects both into every Edge Function.

### 2e. Deploy the function

```bash
supabase functions deploy ai-notes
```

### 2f. Grant yourself access

There's no billing UI yet, so tier changes are manual. Find your user
id under **Authentication → Users**, then in the SQL editor:

```sql
update public.profiles set tier = 'ai' where user_id = '<your-user-uuid>';
```

(The signup trigger already created your `profiles` row with
`tier = 'free'` — you're just flipping it.)

### 2g. Account deletion

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

## Provider limits this design was built around

Researched while designing this feature, in case you change providers
or limits later:

- Supabase Edge Functions: 256MB memory per worker, 2 second max CPU
  time per request (excluding async I/O), no documented request body
  size limit — see [supabase.com/docs/guides/functions/limits](https://supabase.com/docs/guides/functions/limits).
- Supabase Storage: 50MB per file on the Free plan, up to 500GB on paid
  plans — see [supabase.com/docs/guides/storage/uploads/file-limits](https://supabase.com/docs/guides/storage/uploads/file-limits).

This is why audio is uploaded straight to Storage from the browser and
handed to Deepgram via a signed URL, rather than posted directly to the
Edge Function — it avoids betting a core use case (40+ minute lecture
recordings) on an undocumented limit, and keeps the Edge Function from
ever allocating the audio in memory at all.
