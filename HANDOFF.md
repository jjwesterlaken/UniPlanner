# AI lecture notes — where things stand

Working notes for picking this feature up in a new session. Delete once
it's stale.

Last updated: 2026-08-10, at commit `c45ad5f`.

## What's built

Record a lecture → transcribe (Groq, `whisper-large-v3-turbo`) →
structured summary + optional translation (OpenAI `gpt-4o-mini`) → saved
as a normal note plus study cards. All AI calls go through one Supabase
Edge Function; no provider key ever reaches the client.

| Area | Files |
|---|---|
| Recording UI, state machine | `src/aiNotes.jsx`, `src/aiNotesLogic.js` |
| Consent gate (standalone, no app deps) | `src/aiNotesConsent.jsx` |
| Storage upload + Edge Function calls | `src/aiNotesClient.js` |
| Edge Function | `supabase/functions/ai-notes/` |
| Provider adapters (swappable) | `.../groq.js`, `.../deepgram.js` |
| Money/size guards (pure, tested) | `.../guards.js` |
| Schema, RLS, triggers | `supabase/migrations/0001_ai_notes.sql` |
| Setup instructions | `SUPABASE-SETUP.md` |
| Tests | `scripts/test-ai-notes.mjs` (`npm test`) |

`npm test` builds the web bundle then runs 30 tests. All passing as of
`c45ad5f`. One of them greps `dist-web/app.js` to prove no API key
leaked into the shipped bundle — keep that passing.

## Design decisions worth not re-litigating

- **Audio never passes through the Edge Function.** The browser uploads
  straight to a private Storage bucket, the function signs a short-lived
  URL and hands *that* to the provider. This dodges Supabase's 256MB
  worker / 2s CPU limits entirely rather than trying to fit under them.
- **Audio is deleted only after transcription succeeds.** On failure the
  object stays put so a retry can reuse it; an hourly orphan sweep cleans
  up anything never retried.
- **Transcription duration is taken from the provider, never the
  client** — that's what gets billed against `ai_usage`.
- **Consent lives in `data.meta.aiConsent`** and rides the existing
  planner sync. `mergeData` in `src/sync.js` has an explicit carve-out so
  a sync can't drop it (newer `consentVersion` wins; ties break to the
  earliest `acceptedAt`).
- **Provider is one switch.** `TRANSCRIPTION_PROVIDER` in `config.ts`
  (Groq default), overridable per-deployment via the
  `AI_NOTES_TRANSCRIPTION_PROVIDER` secret for A/B testing without a
  redeploy.

## Open / unverified

1. **Test a ~2 hour recording (~29MB) before real users.** Groq's
   URL-path size ceiling is undocumented — this is the length that would
   expose it. See `SUPABASE-SETUP.md` §2i. A rejection now surfaces as a
   distinct `transcription_too_long` (client won't offer a doomed
   retry), so failing this test is safe and obvious.
2. **Never exercised against live provider APIs.** Both adapters are
   only covered by mocked `fetch`. The first real end-to-end run is
   still unproven.
3. **Mobile native projects aren't scaffolded.** No `mobile/ios/` or
   `mobile/android/` yet, so the mic permission strings aren't in place.
   Strings to paste in after `cap add ios` / `cap add android`:
   - `Info.plist` → `NSMicrophoneUsageDescription`: "University Planner
     uses your microphone to record lectures so it can generate an AI
     summary and study cards. Recordings are sent to our transcription
     provider for processing only and are not stored."
   - `AndroidManifest.xml` → `<uses-permission
     android:name="android.permission.RECORD_AUDIO" />`
4. **`delete_my_account()`** isn't tracked in this repo. The snippet to
   merge into it is in `SUPABASE-SETUP.md` §2h — unconfirmed whether
   that's been done.
5. **Cross-device sync of an AI note** has never been tested with two
   real signed-in sessions.
6. **No billing UI.** `profiles.tier` is flipped by hand in the
   dashboard; nothing charges anyone yet.

## Deploying

`.github/workflows/deploy-functions.yml` deploys the function from the
Actions tab (**Deploy Supabase function → Run workflow**) — no terminal
needed, works from a phone. It needs two repo secrets:
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`.

Note it deploys whatever is on the default branch, so push first. The
Supabase setup (project link, `GROQ_API_KEY` secret) was reported done
by the repo owner, but that happened outside this repo — if a call
fails, **Edge Functions → Logs** in the Supabase dashboard is the place
to look, and it's worth confirming the deployed function matches `main`
rather than assuming.
