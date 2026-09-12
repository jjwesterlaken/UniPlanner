/* ==================================================================
   aiProviders.js — WHO may receive a student's work, as FACTS

   ONE LIST, READ BY BOTH HALVES. This file is plain JS with no Deno and
   no browser APIs, exactly like `ai-notes/guards.js`, so the Edge
   Functions import it directly and `src/aiProviders.js` re-exports it
   into the web bundle. That is what makes the consent screen and the
   server's refusal two views of one table rather than two tables
   somebody has to keep in step.

   IT USED TO BE A `src/` MODULE, AND THE CONSEQUENCE IS WHY IT MOVED.
   An Edge Function is deployed from `supabase/functions/` alone, so it
   could not import the list — and the conclusion drawn from that was
   that Deepgram had to be NAMED ON THE CONSENT SCREEN even though
   nothing used it, because `AI_NOTES_TRANSCRIPTION_PROVIDER` could
   select it with no deploy and a screen naming only Groq would have
   become false. That is disclosing a company to every student to work
   around a missing check. The check is now possible: a provider this
   file does not name CANNOT BE USED, because `ai-notes` refuses the
   request at its environment check. So the screen names who really
   receives things, and the switch fails closed.

   WHAT IS HERE AND WHAT IS NOT. Facts the server must enforce: the id
   the adapter is selected by, the company's name, the country, and what
   step it serves. The user-facing wording — what each one receives, in
   a student's words — lives in `src/aiProviders.js`, because Grace edits
   copy and a copy change must not mean editing a file under
   `supabase/functions/`. A test asserts the two cover exactly the same
   set, so a provider added here without wording fails rather than
   rendering a blank bullet.

   THE FACTS WERE READ OUT OF THE EDGE FUNCTIONS, not remembered:

     supabase/functions/ai-notes/groq.js      api.groq.com, whisper-large-v3-turbo
     supabase/functions/ai-notes/openai.ts    api.openai.com, chat/completions
     supabase/functions/ai-text/prompts.js    what each of the five tasks sends
   ================================================================== */

/**
 * Every company that may receive a student's work.
 *
 * `id` matches the adapter key the Edge Function selects by, which is
 * what lets the server check itself against this list.
 *
 * DEEPGRAM IS DELIBERATELY ABSENT. The adapter still exists
 * (`ai-notes/deepgram.js`) and the switch still works — what changed is
 * that selecting a provider this list does not name is refused before
 * anything is spent, instead of being pre-disclosed to everybody on the
 * chance that somebody might flip a secret. Adding it back is two lines
 * here plus wording in `src/aiProviders.js`, and the fingerprint below
 * re-asks every student automatically when it happens.
 */
export const AI_PROVIDERS = [
  {
    id: "groq",
    name: "Groq",
    role: "transcription",
    country: "the United States",
  },
  {
    id: "openai",
    name: "OpenAI",
    role: "summarising and study help",
    country: "the United States",
  },
];

/** The ids each step may use, derived — so the server can check itself. */
export const TRANSCRIPTION_PROVIDER_IDS = AI_PROVIDERS.filter((p) => p.role === "transcription").map((p) => p.id);
export const SUMMARY_PROVIDER_IDS = AI_PROVIDERS.filter((p) => p.role !== "transcription").map((p) => p.id);

/** Every provider name, for a sentence that lists them. */
export const providerNames = (providers = AI_PROVIDERS) => providers.map((p) => p.name);

/**
 * A fingerprint of the provider set.
 *
 * "Re-shown if the third parties change" has to be true by
 * construction, not by somebody remembering to bump a number in the
 * same commit. This is recorded with the acceptance; `needsConsent`
 * re-prompts when it differs, and the server refuses a request carrying
 * a stale one — so adding, removing or renaming a recipient re-asks
 * every student automatically.
 *
 * ID, NAME AND COUNTRY. An id change is a different service, a name
 * change is a different name on the screen somebody agreed to, and a
 * country change is a different jurisdiction — all three are things a
 * student accepted rather than details of how we phrased it. Not the
 * wording, deliberately: a typo fix in a bullet must not re-prompt
 * everybody and train them to click through the screen that matters.
 */
export function providerFingerprint(providers = AI_PROVIDERS) {
  return providers
    .map((p) => `${p.id}:${p.name}:${p.country}`)
    .sort()
    .join(",");
}

/**
 * What clients written BEFORE they sent their accepted fingerprint named.
 *
 * A HISTORICAL CONSTANT. NEVER UPDATE IT.
 *
 * `consentProviders` arrives on the request from this commit onwards, and
 * the server refuses a mismatch. A build that predates the field sends
 * nothing — and reading absence as "fine" would be the one hole this
 * whole arrangement exists to close: the next time the list changes, an
 * old build would go on sending lectures to a company its own consent
 * screen never named, because its own list had not moved and it had no
 * reason to re-prompt.
 *
 * So absence is read as THIS value, which is what those builds really
 * named. It is a literal because it is a fact about the past: the day
 * the list changes, this constant must stay exactly as it is and every
 * pre-field build starts being refused, which is the correct outcome.
 * Nothing asserts it equals the live fingerprint — such a test would go
 * red precisely when the change is intended, and the fix under pressure
 * would be to update the line that must not move.
 */
export const LEGACY_CONSENT_FINGERPRINT =
  "groq:Groq:the United States,openai:OpenAI:the United States";

/**
 * Whether a request's accepted provider set is the one in force.
 *
 * `accepted` is what the student's planner recorded when they agreed.
 * Absent means a build that predates the field — see above.
 */
export function consentSetMatches(accepted, providers = AI_PROVIDERS) {
  const claimed = typeof accepted === "string" && accepted ? accepted : LEGACY_CONSENT_FINGERPRINT;
  return claimed === providerFingerprint(providers);
}
