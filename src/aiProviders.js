/* ==================================================================
   aiProviders.js — the consent screen's view of who receives what

   THE FACTS LIVE IN `supabase/functions/_shared/aiProviders.js` and are
   re-exported here. That file is plain JS with no Deno and no browser
   APIs, so the Edge Functions and this bundle read ONE list — which is
   what lets the server refuse a provider the screen does not name
   instead of the screen having to name every provider the server might
   one day select.

   WHAT THAT REPLACED IS THE POINT. App Store build 3514249 was rejected
   under 5.1.1(i) and 5.1.2(i) because the screen said "a transcription
   service" and "a summarising service" without naming either. The first
   fix named them — and named Deepgram too, which nothing uses, because
   `AI_NOTES_TRANSCRIPTION_PROVIDER` can select it with no deploy and a
   screen naming only Groq would have become false with nothing to
   notice. That is disclosing an extra company to every student in place
   of a check. Deepgram is gone from the screen and the policy; the
   switch fails closed against this list instead.

   WHAT IS HERE: the user-facing wording only, because Grace edits copy
   and a wording pass must not mean editing a file under
   `supabase/functions/`. `PROVIDER_COPY` is keyed by the shared list's
   ids, and `scripts/test-consent.mjs` asserts the two cover exactly the
   same set — so a provider added to the facts without wording fails
   rather than rendering a blank bullet, and wording for a provider that
   no longer exists fails rather than sitting there.
   ================================================================== */

import {
  AI_PROVIDERS,
  TRANSCRIPTION_PROVIDER_IDS,
  SUMMARY_PROVIDER_IDS,
  providerNames,
  providerFingerprint,
  consentSetMatches,
  LEGACY_CONSENT_FINGERPRINT,
} from "../supabase/functions/_shared/aiProviders.js";

export {
  AI_PROVIDERS,
  TRANSCRIPTION_PROVIDER_IDS,
  SUMMARY_PROVIDER_IDS,
  providerNames,
  providerFingerprint,
  consentSetMatches,
  LEGACY_CONSENT_FINGERPRINT,
};

/**
 * Grace's sentence for each company, verbatim.
 *
 * ONE STRING PER PROVIDER RATHER THAN FIELDS TO ASSEMBLE, and the
 * reason is that these are written sentences, not data. The first
 * version held `receives` and `why` and built a bullet from a template —
 * which works until somebody writes real prose: "plus the course name
 * as a spelling hint" is not the second item of a comma list, and
 * bending it to fit a template is editing the copy to suit the code.
 *
 * The cost is that each sentence repeats its company's name, which the
 * facts table also holds. `scripts/test-consent.mjs` asserts every
 * provider's `name` appears in its own sentence, so a renamed company
 * whose sentence still says the old name goes red — the restatement is
 * allowed and the equality is the guard, which is the rule this codebase
 * applies wherever a mirror cannot be avoided.
 *
 * Checked against what the Edge Functions actually send —
 * `ai-notes/groq.js` and `ai-text/prompts.js` — not against what the
 * feature list implies.
 */
export const PROVIDER_COPY = {
  groq: {
    sentence:
      "Groq receives the audio of a lecture you record, plus the course name as a spelling hint, and turns it into text.",
  },
  openai: {
    sentence:
      "OpenAI receives your lecture transcript, text you paste from a reading, photos of pages you're studying, and notes or cards you've written, and writes the summary, study cards and practice questions.",
  },
};

/**
 * The sentences naming who receives what.
 *
 * Grouped BY PROVIDER rather than by feature, because the question the
 * student is being asked to answer is "who gets my stuff", and a list
 * organised by our features makes them assemble that themselves.
 */
export function providerBullets(providers = AI_PROVIDERS, copy = PROVIDER_COPY) {
  return providers.map((p) => {
    const entry = copy[p.id];
    /* A provider with no wording is a bug, not a blank bullet — the
       completeness test is what normally catches it, and this is the
       runtime half of the same claim, so a stale build says something
       true rather than rendering nothing. */
    if (!entry || !entry.sentence) return `${p.name}, in ${p.country}, receives your work for ${p.role}.`;
    return entry.sentence;
  });
}

/**
 * The countries, as a phrase, for the one sentence that names them.
 *
 * DERIVED RATHER THAN TYPED INTO THE INTRO. Grace's copy says "companies
 * in the United States", which is true of both recipients and is the
 * clearest way to say it — and it becomes FALSE the moment a provider
 * somewhere else is added. Building the phrase from the facts renders
 * her exact words today and follows the list rather than contradicting
 * it later.
 */
export function providerCountries(providers = AI_PROVIDERS) {
  const seen = [...new Set(providers.map((p) => p.country))];
  if (seen.length <= 1) return seen[0] || "";
  return `${seen.slice(0, -1).join(", ")} and ${seen.at(-1)}`;
}

/** The transcription companies, named — for the sentence about the audio. */
export const transcriptionProviderNames = (providers = AI_PROVIDERS) =>
  providerNames(providers.filter((p) => p.role === "transcription"));
