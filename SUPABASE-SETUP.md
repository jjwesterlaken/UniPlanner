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
- File size limit: see below — **and it is TWO settings, not one**

**THE 32 kbps ASSUMPTION WAS WRONG, measured on device.** iOS's Opus
encoder floors at about **51 kbps** whatever bitrate is requested
(`tools/measure-audio.html`, row 1). At that rate a two-hour lecture is
45.9MB and a three-hour one is 68.8MB, so the free plan's 50MB
per-file ceiling fails the app's own stated use case.

**Storage enforces the LOWER of two limits and both are in the
dashboard:**

| | where | free plan | Pro |
|---|---|---|---|
| project global | Settings → Storage → Upload file size limit | 50 MB max | up to 500 GB |
| per bucket | Storage → `lecture-audio` → Configuration | ≤ the global | ≤ the global |

Raising only the bucket does nothing — the global still binds.

**Both are set to 100 MB and read back after a reload (22 August
2026), and `LECTURE_AUDIO_FILE_LIMIT_BYTES` is `100_000_000` to
match** — so `MAX_BODY_BYTES` is now bound by the derivation
(86.1 MB, a 3h45m recording at the measured rate) rather than by
Storage, which is the state to keep it in.

**If you change either limit again, raise both, then update
`LECTURE_AUDIO_FILE_LIMIT_BYTES` in
`supabase/functions/ai-notes/config.ts` to match.** That constant is
what `MAX_BODY_BYTES` is capped by, so the code is correct at every
stage of the change rather than only at the end: with the dashboard
still at 50MB the ceiling sits at 48MB and refuses cleanly, and it
rises to the derived 86MB the moment the constant follows the
dashboard. Never the other way round — a ceiling above what Storage
takes waves uploads through to a slow, unexplained rejection.

86MB is `51 kbps × 3 hours × 1.25` headroom; the derivation and the
reasoning for 25% are in `config.ts`.

**Then confirm it, because the two-settings trap cannot be documented
away:**

```
SUPABASE_URL=... SUPABASE_KEY=... node scripts/check-storage-limit.mjs
```

It reads neither setting. It uploads an object of exactly
`MAX_BODY_BYTES` and one over the constant, and reports what Storage
did — which is the only figure a real lecture meets.

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

## 3. Scheduled jobs: the retention sweep and the error digest

Two pg_cron jobs, both of the same shape — pg_cron calling pg_net
calling an Edge Function — and they share one set of prerequisites.
Neither is created by the migration that schedules it unless the
prerequisites are in place; the migration raises a **notice** naming
what is missing and applies cleanly anyway, so a project without them
is not broken, it is unscheduled.

**Until the sweep is scheduled, the retention periods in the privacy
policy are aspirational rather than enforced** — `ai-notes` sweeps
opportunistically, after a request, so a quiet month sweeps nothing.
Until the digest is scheduled, nothing tells you a function is failing
except reading the logs.

### 3a. Enable the two extensions

Supabase dashboard → **Database → Extensions**, enable both:

- **`pg_cron`** — the scheduler.
- **`pg_net`** — outbound HTTP from SQL. The jobs call Edge Functions
  rather than running as pure SQL, because deleting the staged audio
  needs the Storage API and sending an email needs a provider.

They are enabled per project in the dashboard, not by SQL, which is why
no migration can do it.

### 3b. The four Vault secrets

Dashboard → **Project Settings → Vault**. Names are lower case and
exact; the migrations look them up by name.

| Vault secret | Value | Read by |
|---|---|---|
| `ai_notes_function_url` | `https://<project-ref>.supabase.co/functions/v1/ai-notes` | 0004, at schedule time |
| `ai_notes_sweep_secret` | a long random string you invent | 0004's job, at run time |
| `error_digest_function_url` | `https://<project-ref>.supabase.co/functions/v1/error-digest` | 0022, at schedule time |
| `error_digest_secret` | a long random string you invent | 0022's job, at run time |

**The URL is read when the migration is applied; the secret is read
when the job runs.** That is deliberate and worth understanding before
changing either migration: the credential is never written into
`cron.job`'s stored command text, only the lookup that fetches it.

> **The retention sweep's job will not work as 0004 writes it, and this
> was found while building the digest.** 0004 sends the sweep secret as
> `Authorization: Bearer <secret>` to `ai-notes` — and `ai-notes` is
> deployed **with** JWT verification, because it identifies a signed-in
> student from that same header. So the platform refuses the delivery
> before our code runs, `ai-notes` never sees the secret it would have
> compared, and the symptom is a cron job whose run always "succeeds"
> (pg_net got a response) while nothing is ever swept.
>
> `error-digest` is not affected: it reads no user from a token, so it
> is deployed without JWT verification and its own secret check is the
> whole of its authentication — which is the property the deploy guard
> now derives rather than taking from a naming convention.
>
> **Not fixed here**, because the remedy touches the function that
> spends money: either `ai-notes` reads the sweep secret from a header
> of its own (so the platform's JWT check can stay on), or the sweep
> moves to its own endpoint. Worth deciding before enabling pg_cron,
> since enabling it otherwise creates a job that reports success and
> does nothing.

**Neither job authenticates with the service role key, and it must
stay that way.** pg_net stores every outbound request — headers
included — in `net.http_request_queue` until its TTL expires, so
whatever authenticates a job sits at rest in a database table for hours
at a time. A sweep secret only lets its holder trigger a sweep the
system does hourly anyway; a digest secret only lets its holder trigger
an email to an address the function reads from its own environment. The
service role key there would be a full-database credential in a queue
table.

### 3c. The digest's own secrets

The same two random strings go in two places: the Vault (so the job can
send them) and the function's environment (so the function can check
them).

```bash
supabase secrets set ERROR_DIGEST_SECRET=<the same string as error_digest_secret>
supabase secrets set RESEND_API_KEY=<the restricted key from 3d>
supabase secrets set ERROR_DIGEST_TO=support@uniplannerapp.com
supabase secrets set ERROR_DIGEST_FROM="UniPlanner <alerts@send.uniplannerapp.com>"
```

`ERROR_DIGEST_SECRET` is the only one that is required: without it the
function refuses every request with `digest_disabled`, because there
would be nothing to authenticate the caller with and it reads a table
no client may read. Without the other three the digest is still built
and the table is still purged, and the response says
`mail_not_configured` rather than `ok` — a cron run reporting success
over an unconfigured mailer is how a digest is believed to be arriving
for a month.

### 3d. The Resend key, restricted to the sending subdomain

Resend → **API Keys → Create API Key**:

- **Permission: Sending access** (not Full access). This key only ever
  posts to `/emails`.
- **Domain: `send.uniplannerapp.com`** — the subdomain already verified
  for transactional mail. Restricting the key to it means a leaked key
  cannot send as the root domain, which is where Jared's actual mail
  lives.

`ERROR_DIGEST_FROM` must be an address **on that subdomain**, or Resend
refuses the send with a 403 and the reason in the body — which the
function logs, because an unverified domain and a bad key are the same
status with different messages and guessing between them costs a
morning.

**Do not touch the DNS for this.** `send.uniplannerapp.com` is already
verified (EMAIL-SETUP.md), and the SPF conflict that section warns
about is the reason a subdomain was used in the first place: the root
domain carries a Google Workspace SPF record, a domain may have exactly
one, and publishing a second invalidates both.

### 3e. The order, and why re-running the migration is a step

For the digest, the first apply of 0022 deliberately does **not**
schedule anything:

1. **Apply `0022_function_errors.sql`.** It WIDENS — it creates the
   table the functions write — so it goes **before** the deploy. With
   no Vault secret yet it raises a notice about skipping the schedule
   and applies cleanly. Its self-check verifies the table, the revoked
   grants, the absence of an account column and the column bounds; an
   apply cannot report success while any of that is untrue.
2. **Deploy the functions.** `deploy-functions.yml` globs every
   function, so `error-digest` ships with the rest and nothing needs
   adding to a list.
3. **Set the secrets** (3c) and add the **Vault secrets** (3b).
4. **Re-apply `0022_function_errors.sql`.** Now the Vault lookups
   succeed and the cron job is created. It is idempotent —
   `cron.unschedule` runs first — so re-applying is the intended way to
   (re)create the schedule.

Verify it exists:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

and, after it has run once:

```sql
select jobname, status, start_time, return_message
  from cron.job_run_details
 order by start_time desc limit 5;
```

**A morning with no email is the healthy signal, not a broken job** —
the digest sends nothing on a day with no failures, because a daily "0
errors" message is one that gets filtered, and a filtered digest is not
read on the morning it matters. `cron.job_run_details` is what
distinguishes "nothing to report" from "never ran", which is why
silence is safe here and would not be otherwise.

To force one for a test, write a row and trigger the function by hand:

```sql
insert into public.function_errors (fn, stage, name, message)
  values ('ai-notes', 'summarise', 'Error', 'a test row, delete me');
```

```bash
curl -s -X POST https://<project-ref>.supabase.co/functions/v1/error-digest \
  -H "Authorization: Bearer <ERROR_DIGEST_SECRET>" \
  -H "content-type: application/json" -d '{"digest":true}'
```

`{"ok":true,"outcome":"sent"}` means the email went. Then remove the
row, or leave it — the digest purges anything older than 30 days on
every run.

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
