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
    supplied: true,
  },
  {
    id: "page-photos",
    what: "photographs of pages you are studying",
    retention: "relayed-not-stored",
    disclosedAs: /photo/i,
    supplied: true,
  },
  {
    id: "own-notes-and-cards",
    what: "notes, study cards and explanations you have written",
    retention: "relayed-not-stored",
    disclosedAs: /study cards/i,
    supplied: true,
  },
  /* v8, 25 September 2026. An essay is not "notes you have written"
     stretched: it carries the student's name, student ID, course code
     and sometimes their tutor's, and it is their own assessable work
     (ESSAY-FEEDBACK.md §1). It is sent AS WRITTEN, identifiers
     included, because a filter that removes "some" names is a promise
     that cannot be kept. The screen says so and says the student can
     remove them first; the policy says the same. */
  {
    id: "essay-draft",
    what: "a draft essay you paste in for feedback, with the marking criteria you paste beside it, sent as written, including any name or student ID in it",
    retention: "relayed-not-stored",
    disclosedAs: /essay/i,
    supplied: true,
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
/* WHAT THE STUDENT SUPPLIES, as opposed to what the app produces from a
   recording. The policy lists these in two hand-written sentences (an
   HTML file cannot import this one), so each such passage is marked in
   privacy.html and test-legal.mjs requires every supplied type in every
   marked passage. That is ESSAY-FEEDBACK.md's C3: the next type added
   here cannot be left out of the enumeration. */
export const suppliedMaterialTypes = (types = AI_MATERIAL_TYPES) => types.filter((t) => t.supplied === true);

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
  /* v8: essay drafts, sent as written. Jared, 25 September 2026: v8
     before the essay route exists, and every student is re-asked once. */
  8: "course-name:relayed-not-stored,essay-draft:relayed-not-stored,lecture-audio:deleted-on-transcription,lecture-transcript:kept-server-side,own-notes-and-cards:relayed-not-stored,page-photos:relayed-not-stored,pasted-reading:relayed-not-stored",
};

/**
 * EVERY ROUTE BY WHICH A STUDENT'S MATERIAL REACHES A PROVIDER, and
 * which kinds of material go out along it.
 *
 * WHY THIS EXISTS, and it is the hole the ledger above does NOT close.
 * `CONSENT_MATERIAL_LEDGER` stops you adding a material TYPE without
 * bumping the consent version. Nothing stopped you adding a FEATURE
 * without adding a type — and nobody sets out to add a material type,
 * they set out to add a feature, and the type is the thing they were
 * supposed to remember. Adding `essay` to `ai-text`'s prompt set left
 * the fingerprint unchanged (no new provider), the ledger matching v7
 * (no new type) and all three floors green, while the screen went on
 * describing six kinds of material out of seven.
 *
 * So the chain is closed end to end:
 *
 *     a route         (DERIVED from the endpoints, in test-legal.mjs)
 *  -> its materials   (declared here, and a new route has none)
 *  -> the fingerprint (DERIVED from AI_MATERIAL_TYPES)
 *  -> the version     (pinned by CONSENT_MATERIAL_LEDGER)
 *
 * Every arrow but the second is automatic. The second is a judgement —
 * what does this actually send? — and the guard's whole job is to force
 * it to be made, in writing, at the moment the route appears.
 *
 * IT IS DATA AND IT IMPORTS NOTHING, which is load-bearing rather than
 * tidy. `test-legal.mjs` loads `origin/main`'s copy of THIS FILE
 * standing alone to ratchet the ledger, and a single import would make
 * a historical copy unloadable — which the catch would read as "no
 * baseline" and skip, a guard switching itself off at exactly the
 * moment somebody was rewriting history. So the route NAMES are
 * written here and the route LIST is derived in the test.
 *
 * KEYS ARE `<endpoint>:<route>`. The endpoint prefix is not decoration:
 * `summarise` exists on one side and `summarize` on the other, and a
 * flat namespace would make those two collide on a typo.
 *
 * EVERY ROUTE MAPS TO AT LEAST ONE TYPE. There is deliberately no
 * "sends nothing" escape hatch: a route that operates on output we
 * generated maps to the material that output was DERIVED from, which is
 * what a student agreed to when they supplied it. `merge` is that case
 * and it is why the rule is stated rather than assumed.
 */
export const MATERIAL_ROUTES = {
  /* ---- ai-text: one entry per SYSTEM prompt ---- */

  // The student's own typed explanation of a concept.
  "ai-text:explain": ["own-notes-and-cards"],
  // The terms they keep forgetting, out of their own study cards.
  "ai-text:weakspots": ["own-notes-and-cards"],
  // Their study cards, turned into questions.
  "ai-text:practice": ["own-notes-and-cards"],
  /* ONE PROMPT, TWO KINDS OF MATERIAL, and this is the row that would
     be wrong if the unit were the feature rather than the prompt:
     "summarise a note I wrote" and "summarise a reading I pasted" are
     two features on two screens and one `summarise` task. */
  "ai-text:summarise": ["own-notes-and-cards", "pasted-reading"],
  // Photographs of pages, selected inside `summarise` by the body.
  "ai-text:summariseImages": ["page-photos"],
  /* Marking criteria from a photograph (Jared, 27 September 2026):
     photographs of pages, under the same promise as a photographed
     reading — relayed, never stored. RULED: no consent bump. */
  "ai-text:criteria": ["page-photos"],
  /* DERIVED, NOT NEW. `merge` sends the section summaries this endpoint
     produced from a pasted reading — so what goes out is the reading's
     content in our words, to the same company, under the same promise.
     Mapping it to the source is more truthful than excusing it, and it
     is why no "sends nothing" option exists above. */
  "ai-text:merge": ["pasted-reading"],
  /* The essay and the criteria pasted beside it. One type, because the
     criteria go only with an essay and are disclosed in the same line:
     a type of its own would be a disclosure nobody reads separately. */
  "ai-text:essay": ["essay-draft"],
  /* The example rewrite sends ONE PASSAGE of the essay and the point's
     note to the model, and the essay itself to our server for the scope
     check, which never sends it on. The same material v8 disclosed, to
     the same company: no new type, so no bump. What it gives BACK is new,
     and the screen and the policy say so. */
  "ai-text:rewrite": ["essay-draft"],

  /* ---- ai-notes: one entry per adapter method ---- */

  /* THE COURSE NAME RIDES WITH THE AUDIO and is easy to miss, which is
     the argument for listing materials per route rather than per
     endpoint. Whisper takes it as a vocabulary `prompt` and Deepgram as
     `keywords`; either way the student's course name leaves the device
     on the same request as the recording. */
  "ai-notes:groq.transcribe": ["lecture-audio", "course-name"],
  "ai-notes:deepgram.transcribe": ["lecture-audio", "course-name"],
  // The transcript, and the translation is of the same transcript.
  "ai-notes:openai.summarize": ["lecture-transcript"],
};
