/* ==================================================================
   aiMaterialTypes.js — WHAT a student's consent covers, as FACTS

   THE HOLE THIS CLOSES. `needsConsent` re-asks for exactly two
   reasons: the editorial VERSION moved, or the PROVIDER FINGERPRINT
   moved. The second is derived and therefore automatic — add,
   rename or relocate a recipient and every student is re-asked
   whether or not anybody remembered. The first is a hand-typed
   integer.

   So a new KIND OF MATERIAL triggers neither. Send a student's essay
   to the same two companies under the same promises and nothing in
   the code notices: the provider set has not moved, and the version
   only moves if somebody thinks to move it. Every bump so far —
   v4's text features, v5's supplied-text category, v6's photographed
   pages — was somebody thinking to. The evidence that this is a hole
   rather than a habit is in `scripts/test-legal.mjs`, where each of
   those decisions is recorded as a FLOOR (`>= 4`, `>= 5`, `>= 6`)
   added by hand AFTER the fact. A floor records history. It cannot
   compel the next bump.

   WHAT IS HERE: the list of material types, and a per-version record
   of what the list held when that version was accepted. The guard in
   `test-legal.mjs` compares the two, so adding a type without a bump
   goes red — the same shape as the provider fingerprint, moved from
   runtime to the only place it can live until the client sends its
   accepted material set.

   WHY NOT AT RUNTIME, WHICH IS THE OBVIOUS QUESTION. Folding this
   into `providerFingerprint()` would re-prompt EVERY STUDENT
   IMMEDIATELY: their recorded fingerprint is providers-only and
   would stop matching on deploy. That is a change to shipped
   behaviour in exchange for nothing — the list has not changed, so
   nobody has anything new to agree to. The runtime half becomes
   worth building when a type is actually added, and it is the same
   two lines then as now.

   WHY IT IS NOT UNDER `supabase/functions/_shared/`, where the
   provider facts live. That list moved there because the SERVER
   enforces it: a provider this list does not name cannot be used,
   checked at the environment gate. Nothing server-side reads this
   one — the material a request carries is its task, and the task is
   already what the allowance and the prompts are chosen by. Moving
   it there speculatively would claim a check that does not exist.

   NO IMPORTS, DELIBERATELY. The append-only ratchet writes
   `origin/main`'s copy of this file to a temp file and imports it
   standing alone; a single import would make a historical copy
   unloadable and quietly turn the ratchet into a skip.
   ================================================================== */

/**
 * What we promise about a kind of material, as a category.
 *
 * THREE CATEGORIES, NOT A NUMBER OF DAYS. The day-counts live in
 * `aiNotesRetention.js` and already have their own guard — the policy
 * may not state a period the server does not enforce. Restating them
 * here would be the restatement pattern one file over. What this
 * records is the SHAPE of the promise, which is what a student is
 * agreeing to and what the consent bump rule is written in terms of:
 * "a change in what happens to the content — where it goes, who sees
 * it, how long it is kept".
 *
 * THE HOLE, NAMED: a change from 7 days to 30 does not move the
 * fingerprint, because both are `kept-server-side`. That change is
 * caught by the retention guard in `test-legal.mjs` instead, and
 * whether it deserves a consent bump is a judgement this file does
 * not make.
 */
export const RETENTION_CATEGORIES = [
  /* Gone the moment it has served its purpose. The audio, and only
     the audio — `AUDIO_DELETION_PROMISE` is the sentence. */
  "deleted-on-transcription",
  /* Relayed to do what was asked and kept nowhere: not in the
     planner, not on our server. The promise `ai-text` can make
     because it writes only `ai_usage`. */
  "relayed-not-stored",
  /* A server-side copy exists for a stated window, so the student can
     recover it. Transcripts and the notes made from them. */
  "kept-server-side",
];

/**
 * Every kind of material a student's work is sent as.
 *
 * READ OUT OF THE CODE, not remembered — the same discipline the
 * provider facts were assembled under:
 *
 *   supabase/functions/ai-notes/groq.js     the audio, and the course
 *                                           name as a Whisper prompt
 *   supabase/functions/ai-notes/index.ts    the transcript, onward
 *   supabase/functions/ai-text/prompts.js   what each of the five
 *                                           tasks puts in a message
 *
 * `disclosedAs` is what the consent screen must say for this type to
 * count as disclosed. It is a pattern rather than a sentence for the
 * reason every wording pin in this codebase has had to learn twice:
 * Grace rewrites the copy, and a guard pinned to her phrasing goes
 * red on a correct improvement. The CLAIM is that the material is
 * named; the pattern is the loosest thing that can tell.
 *
 * It is NOT part of the fingerprint. Rewording a bullet must not
 * re-ask everybody — the same reason the provider fingerprint covers
 * id, name and country and not the sentence around them.
 */
export const AI_MATERIAL_TYPES = [
  {
    id: "lecture-audio",
    what: "the audio of a lecture you record",
    retention: "deleted-on-transcription",
    disclosedAs: /recording|audio/i,
  },
  {
    id: "course-name",
    what: "the course name, sent with the audio as a spelling hint",
    retention: "relayed-not-stored",
    disclosedAs: /course name/i,
  },
  {
    id: "lecture-transcript",
    what: "the lecture as text, once transcribed",
    retention: "kept-server-side",
    disclosedAs: /transcript/i,
  },
  {
    id: "pasted-reading",
    what: "text you paste from a reading",
    retention: "relayed-not-stored",
    disclosedAs: /paste/i,
  },
  {
    id: "page-photos",
    what: "photographs of pages you are studying",
    retention: "relayed-not-stored",
    disclosedAs: /photo/i,
  },
  {
    id: "own-notes-and-cards",
    what: "notes, study cards and explanations you have written",
    retention: "relayed-not-stored",
    disclosedAs: /study cards/i,
  },
];

/**
 * The material set, as one comparable string.
 *
 * A FINGERPRINT RATHER THAN A DIGEST, and the difference is who reads
 * it. A hex hash says something changed; this says WHAT — the diff of
 * a bump commit shows the type that was added, beside the version
 * that was moved for it, which is the one thing the person reviewing
 * that commit needs to see. `LEGACY_CONSENT_FINGERPRINT` is written
 * out for the same reason.
 *
 * ID AND RETENTION. An id is a kind of material; a retention category
 * is what we promise about it. Both are things a student agreed to.
 * The wording around them is not.
 */
export function materialFingerprint(types = AI_MATERIAL_TYPES) {
  return types
    .map((t) => `${t.id}:${t.retention}`)
    .sort()
    .join(",");
}

/**
 * What the material list held at each consent version.
 *
 * APPEND ONLY. NEVER EDIT AN EXISTING ENTRY.
 *
 * Every value here is a fact about a screen students have already
 * agreed to, in the same sense as `LEGACY_CONSENT_FINGERPRINT` — and
 * it is load-bearing in exactly the way that constant is. The guard
 * asserts `materialFingerprint()` equals the entry for the CURRENT
 * `AI_CONSENT_VERSION`. Without the append-only half, the cheapest
 * way back to green after adding a type would be to edit this line,
 * which is precisely as cheap as bumping and leaves no trace. So the
 * ratchet in `test-legal.mjs` reads `origin/main`'s copy of this file
 * and requires every entry already there to be byte-identical.
 *
 * ADDING A TYPE, therefore, is: add it above, add an entry here at
 * the next version, and bump `AI_CONSENT_VERSION` — three edits that
 * say the same thing, which is what makes the middle one impossible
 * to make by accident.
 *
 * v7 IS THE FIRST ENTRY. Earlier versions are not reconstructed: the
 * list did not exist then, and inventing what it would have held is
 * writing history rather than recording it. The floors in
 * `test-legal.mjs` are the record of those decisions.
 */
export const CONSENT_MATERIAL_LEDGER = {
  7: "course-name:relayed-not-stored,lecture-audio:deleted-on-transcription,lecture-transcript:kept-server-side,own-notes-and-cards:relayed-not-stored,page-photos:relayed-not-stored,pasted-reading:relayed-not-stored",
};
