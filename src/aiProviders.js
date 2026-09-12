/* ==================================================================
   aiProviders.js — WHO the AI features send things to, and WHAT

   App Store build 3514249 was rejected under guidelines 5.1.1(i) and
   5.1.2(i): the consent prompt described "a transcription service" and
   "a summarising service" without naming either. Apple's requirement is
   that a third party receiving personal data is NAMED, before the fact,
   in the app — a privacy policy is not sufficient on its own.

   SO THIS FILE IS THE ONE PLACE THAT ANSWERS IT, and everything else —
   the consent screen, the privacy policy's third-party section, the
   test that checks them against each other — reads it rather than
   restating it. A provider named in two places is two places to forget.

   THE FACTS BELOW WERE READ OUT OF THE EDGE FUNCTIONS, not remembered:

     supabase/functions/ai-notes/groq.js      api.groq.com, whisper-large-v3-turbo
     supabase/functions/ai-notes/deepgram.js  api.deepgram.com
     supabase/functions/ai-notes/openai.ts    api.openai.com, chat/completions
     supabase/functions/ai-text/prompts.js    what each of the five tasks sends

   AND THE ONE THAT CHANGES THE DESIGN: the transcription provider is
   SELECTABLE AT RUNTIME. `ai-notes/config.ts` says so in its own
   comment — "can also be overridden per-deployment without a redeploy
   via the AI_NOTES_TRANSCRIPTION_PROVIDER secret". So a consent screen
   that named only Groq would become false the moment somebody set that
   secret to `deepgram`, with no code change, no deploy, and nothing to
   notice. Apple would have approved a screen that later lied.

   Two consequences, and both are load-bearing:

   1. EVERY PROVIDER THE CODE CAN USE IS NAMED HERE, not only the one it
      uses today. Deepgram is listed as a transcription provider because
      one dashboard field selects it.
   2. AN ADAPTER THIS FILE DOES NOT NAME CANNOT SHIP. The closure is in
      two halves, and it is worth being exact about which does what
      rather than claiming a runtime check this cannot have — an Edge
      Function is deployed from `supabase/functions/` alone, so it cannot
      import this module, and restating the list over there would be the
      pattern this codebase keeps a ledger about.

      The halves: `selectTranscriber` (ai-notes/guards.js) FALLS BACK to
      the configured default for a value it does not recognise, so the
      secret can only ever choose among the adapters that exist; and
      `scripts/test-ai-notes.mjs` asserts the adapter keys the function
      can select are a SUBSET of the ids below, derived from both sides.
      Between them, reaching an unnamed third party takes a new adapter,
      which is a code change, which goes red.
   ================================================================== */

/**
 * The third parties, and exactly what reaches each.
 *
 * `receives` is in the student's words rather than the code's, because
 * it is rendered verbatim on the consent screen. `id` matches the
 * adapter key the Edge Function selects by, which is what lets the
 * server check itself against this list.
 */
export const AI_PROVIDERS = [
  {
    id: "groq",
    name: "Groq",
    role: "transcription",
    /* The default. ai-notes/config.ts: TRANSCRIPTION_PROVIDER = "groq". */
    used: "default",
    country: "the United States",
    receives: [
      "the audio of the lecture you recorded",
      "the course name you filed it under, as a spelling hint",
    ],
    why: "to turn the recording into text",
  },
  {
    id: "deepgram",
    name: "Deepgram",
    role: "transcription",
    /* NAMED THOUGH NOT CURRENTLY SELECTED. One secret switches to it,
       so a consent that omitted it would be false without a deploy. */
    used: "alternative",
    country: "the United States",
    receives: [
      "the audio of the lecture you recorded",
      "the course name you filed it under, as a spelling hint",
    ],
    why: "to turn the recording into text",
  },
  {
    id: "openai",
    name: "OpenAI",
    role: "summarising and study help",
    used: "default",
    country: "the United States",
    receives: [
      "the transcript of your lecture",
      "text you paste in from a reading",
      "photographs of pages you are studying",
      "notes, explanations and study cards you have written",
    ],
    why: "to write the summary, the study cards and the practice questions",
  },
];

/** The ids each step may use, derived — so the server can check itself. */
export const TRANSCRIPTION_PROVIDER_IDS = AI_PROVIDERS.filter((p) => p.role === "transcription").map((p) => p.id);
export const SUMMARY_PROVIDER_IDS = AI_PROVIDERS.filter((p) => p.role !== "transcription").map((p) => p.id);

/** Every provider name, for the sentence that lists them. */
export const providerNames = () => AI_PROVIDERS.map((p) => p.name);

/**
 * A fingerprint of the provider set.
 *
 * "Re-shown if the third parties change" has to be true by
 * construction, not by somebody remembering to bump a number in the
 * same commit. This is recorded with the acceptance, and `needsConsent`
 * re-prompts when it differs — so adding, removing or renaming a
 * provider re-asks every student automatically, which is the property
 * Apple's requirement actually needs.
 *
 * Ids and names, sorted: an id change is a different service, and a
 * name change is a different name on the screen the student agreed to.
 * Not `receives`, deliberately — rewording a bullet for clarity should
 * go through the editorial version, so that a typo fix does not
 * re-prompt everybody and train them to click through.
 */
export function providerFingerprint(providers = AI_PROVIDERS) {
  return providers
    .map((p) => `${p.id}:${p.name}`)
    .sort()
    .join(",");
}

/**
 * The sentence naming who receives what, built from the list.
 *
 * Grouped BY PROVIDER rather than by feature, because the question the
 * student is being asked to answer is "who gets my stuff", and a list
 * organised by our features makes them assemble that themselves.
 */
export function providerBullets(providers = AI_PROVIDERS) {
  return providers.map((p) => {
    const what = p.receives.length === 1 ? p.receives[0] : `${p.receives.slice(0, -1).join(", ")} and ${p.receives.at(-1)}`;
    /* THE CONDITION TRAILS rather than interrupting the recipient.
       "Deepgram, in the United States, if we switch transcription
       provider: the audio…" makes a reader parse a clause before they
       have been told what is sent, which is the one thing the sentence
       exists to say. */
    const when = p.used === "alternative" ? " — but only if we ever switch transcription provider, which we have not" : "";
    return `${p.name}, in ${p.country}: ${what} — ${p.why}${when}.`;
  });
}
