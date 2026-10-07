# Notes style — a per-account profile for AI lecture notes (1.3.2)

**A plan, not a build.** Written 7 October 2026 on Jared's instruction.
No code exists for it yet. **It is 1.3.2, not 1.3.1** (Jared, 7 October
2026): it depends on 1.3.1 item 8 (the lecture-notes rating, migration
0026) being live and collecting, because the ratings are what drive the
suggestions below.

> **FOR A RULING, before any code: the consent wording.** Known terms
> are study-card text, the existing `own-notes-and-cards` material
> ("notes, study cards and explanations you have written"), but sent on a
> route that has never carried them: alongside a lecture, to the notes
> summariser. Does the v8 consent screen's description cover that, or
> is it v9? The reasoning is under "Consent" below. The alternative that
> needs no ruling is to ship 1.3.2 without known terms.

## What it is

A **Notes style** card in Settings. The student can see it and change
it. Each value is chosen from a fixed list, and the chosen values are
prepended to the lecture-notes prompt on every request:

| Setting | Values | Default |
|---|---|---|
| Length | shorter · standard · longer | standard |
| Detail | headline · standard · thorough | standard |
| Format | bullets · prose | bullets |
| Examples | include the lecturer's examples · leave them out | include |
| Terms I already know | up to 40 terms, **picked from the student's own study cards** | none |

That table is all there is. Nothing here is typed free text, and
nothing is inferred.

**Nothing changes silently.** The defaults reproduce today's prompt
exactly, so a student who never opens the card gets byte-identical
requests. A setting changes only when the student changes it, or when
they accept a suggestion (next section).

## Suggestions from the ratings, never changes

Item 8 records ratings in `lecture_notes_feedback`, and its select
policy already lets a student read their own rows. When the Notes style
card opens, and after each rating, the client reads the student's own
last **five rated** results and checks:

| If at least 3 of the last 5 rated results say | Suggest |
|---|---|
| too-long | "Make your notes shorter by default?" (Length → shorter) |
| too-short | "Make your notes longer by default?" (Length → longer) |
| missed-assessable | "Spend more of each note on what might be assessed?" (Detail → thorough) |
| wrong-structure | "Try prose instead of bullet points?" (or back the other way) |

- **Accept** sets the one value and says which value changed.
- **Not now** records `{reason, declinedAt}` in the profile. That
  suggestion isn't offered again for 30 days, and isn't offered again
  until three more matching ratings arrive. A declined suggestion that
  comes straight back is a nag, and a nag teaches people to tap Not now.
- **Suggestions are off the ratings only.** `wrong-terms` and `other`
  have no automatic suggestion, because no single setting fixes them.
- **Comments never feed anything.** The opt-in comment is for us to
  read. It never drives a suggestion and never enters a prompt. The
  suggestion logic doesn't read the column at all, and a test should
  assert that by grepping for it, comments stripped.
- The rule is a **pure function** (`suggestStyle(ratings, profile, now)`
  in its own module, with tests), so "3 of 5" and the 30 days are each a
  test rather than a hope about a component.
- **A failed read suggests nothing.** It never suggests the opposite,
  and never clears a decline. This is the `fetchNote` rule: unknown is
  not none.

## Where it lives

`meta.notesStyle` in the planner blob, synced:
`{ length, detail, format, examples, knownTerms: [cardId…], declined: [{ reason, at }], updatedAt }`.

Store **card ids, not terms.** The words are looked up from the cards
at request time, so a deleted or renamed card follows rather than
going stale. A card that's gone is skipped.

**Size:** the enums are about 80 bytes. 40 card ids are about 640
bytes, and declines carry at most four entries. **The whole profile is
under 1 KB, fixed and bounded**, so it can't grow without a ceiling
(the first rule in CLAUDE.md). It doesn't need a semester collection,
so `COLLECTIONS` doesn't change. `meta` merges as last-writer-wins on
the whole object, which is right for a settings card edited on one
device at a time.

## How it reaches the prompt — codes in, fixed sentences out

The client sends **codes**, never sentences:
`style: { length: "shorter", detail: "standard", format: "bullets", examples: true, knownTerms: ["Chunk", …] }`.

`ai-notes` maps each code to a **fixed sentence held server-side**.
For example, `shorter` becomes "Keep each section brief: fewer key
points, one or two sentences each; keep the reasoning, drop
restatement." A client can't inject wording, because there's no field
whose text reaches the prompt verbatim — except the terms.

**Known terms are the one piece of student text.** They are:

- validated server-side: at most 40, each at most 40 characters,
  printable text only, deduplicated;
- placed in the user message, not the system prompt, as a JSON array
  under a fixed label ("Terms the student already knows; do not define
  these unless the lecturer adds something new about them");
- never echoed back.

**An unknown code is dropped to the default for that field and logged.
The request is never refused.** A stale client must not break notes
somebody is paying for. That's the "fail towards keeping" rule, applied
to a preference.

**The depth rules still bind.** The 15 August prompt work (CLAUDE.md,
"Depth is bought with instructions") made every section say what
belongs in it. "Shorter" means fewer, tighter entries. It never means
dropping the reasoning, and the fixed sentence says so. This needs
measuring, not assuming, with the pair below.

## What it costs — inside the existing credit price

A credit is defined as one minute of recorded lecture: transcription
plus a 50th of one typical summary. That's **$0.000686**, from
`_shared/credits.ts`. The model rates are $0.15 per 1M input tokens and
$0.60 per 1M output tokens. Figures below are computed from those
constants, not estimated by eye.

**Input — the profile itself:**

| Profile | Tokens | Cost per call | Credits |
|---|---|---|---|
| Defaults (sent as nothing) | 0 | $0 | 0 |
| Four non-default settings | ~60 | $0.000009 | 0.013 |
| Plus 10 known terms | ~140 | $0.000021 | 0.031 |
| Plus 40 known terms (the cap) | ~260 | $0.000039 | 0.057 |

At the cap, that's under a 17th of one credit per lecture. A 50-minute
lecture is charged 50 credits.

**Output is the half that matters.** Output is four times the price of
input, and "longer" or "thorough" asks for more of it:

| Extra output tokens per summary | Cost | Credits |
|---|---|---|
| +600 | $0.00036 | 0.52 |
| +1,200 (doubling today's measured 1,203) | $0.00072 | 1.05 |
| +2,400 | $0.00144 | 2.10 |

**Against a 50-minute lecture charged 50 credits, the worst plausible
case (thorough plus longer, roughly doubling the output) is about 2% of
the price.** It stays inside the existing per-minute charge, with no
price change. `SUMMARY_MAX_TOKENS` (8,000) is unchanged, so the worst
case per call is bounded exactly as it is today. "Shorter" moves the
other way.

**Where it is NOT comfortably inside: short recordings.** This is
pre-existing and should be said plainly. The credit is cost-neutral at
50 minutes by construction, so most recordings shorter than that cost
more than they are charged.

How a recording is costed, all from `_shared/credits.ts`:

- transcription: $0.04 per hour, which is $0.0006667 a minute;
- one summary at the measured typical size (1,600 in, 1,203 out):
  $0.0009618, whatever the length;
- one credit: $0.0006667 + $0.0009618 ÷ 50 = **$0.0006859**.

So a recording of *m* minutes costs `m × 0.0006667 + 0.0009618`, and is
charged `max(m, 3)` credits (`billedCredits` in `ai-notes/guards.js`:
exact minutes, not rounded, floor of 3). In credits:

| Recording | Charged | Real cost | Charged ÷ cost |
|---|---|---|---|
| 1 min | 3 credits | 2.37 credits ($0.00163) | 1.26 |
| 1.64 min | 3 credits | 3.00 credits | 1.00 (break-even on the floor) |
| 2 min | 3 credits | 3.35 credits | 0.90 |
| 3 min | 3 credits | **4.32 credits** ($0.00296) | **0.69** |
| 10 min | 10 credits | 11.12 credits ($0.00763) | 0.90 |
| 50 min | 50 credits | 50.00 credits ($0.03430) | 1.00 (break-even by definition) |
| 120 min | 120 credits | 118.04 credits ($0.08096) | 1.02 |

**Every recording between 1.64 and 50 minutes is charged below its
cost.** Under 1.64 minutes the floor of 3 covers it, and over 50 the
fixed summary is spread thin enough to come out above. The worst point
is just over the floor, at 3 minutes: 1.40 credits of summary plus 2.92
of transcription is 4.32, against 3 charged.

(A correction, for the record: a chat summary of this file on 7 October
said a short clip was "3 credits charged against 1.4 credits of real
cost". The 1.4 is the summary alone; it dropped the transcription. The
table above was right and the summary of it was not.)

A "thorough" summary of a 3-minute clip pushes 0.69 lower, to **0.56**:
+1,200 output tokens is $0.00072, so the cost becomes 5.37 credits
against the same 3. It's a few hundredths of a cent, and only
on an action nobody repeats at volume. But it's a real number, so it's
recorded rather than rounded away. **This is not a reason to price the
profile.** It's a reason to measure first. Per tier, the
every-tier-pays-for-itself test in `test-readings.mjs` is the arbiter,
and it should be re-run with the doubled output figure before this
ships.

**The measurement gate, before any of the above is believed.** Every
figure here is modelled, and `TYPICAL_SUMMARY_OUTPUT_TOKENS` was once a
model that turned out to be 5.9× reality. Before 1.3.2 ships, run
`scripts/measure-summary-depth.mjs` as a **pair** (the prompt-change
rule): the same recording under defaults and under shorter, longer and
thorough, printing output tokens and words per key point for each arm.
The doubling assumption above is the thing that measurement confirms or
replaces. If thorough-plus-longer comes out above about +2,400 tokens,
cap it in the fixed sentence rather than raising a price.

## Consent and the privacy policy — "your preferences", never "learning"

**The wording rule, as binding as the study-not-substitution rule for
readings:** every user-facing sentence about this says **"your notes
preferences"** or **"the style you chose"**. It never says "learns",
"personalises from your data", "adapts to you" or "trains". The reason
is substantive, not tonal: nothing here learns. A preference is a value
the student set, and a suggestion is a fixed rule over their own five
most recent ratings that they can refuse. **No model is trained, tuned
or fine-tuned on anything, by us or by a provider at our request**, and
no student's ratings affect another student's notes. A test should grep
the copy, the policy and the store text for the banned verbs, comments
stripped, the way `test-readings.mjs` does.

**Privacy policy:** a short paragraph beside the item 8 paragraph.

> If you set a notes style, your choices (length, detail, bullets or
> prose, whether to include examples, and any study-card terms you mark
> as already known) are kept in your planner and sent with each
> lecture-notes request as instructions for that request. They are not
> stored on our server apart from your synced planner, and no AI model
> is trained on them or on anything else you send. Suggestions such as
> "make your notes shorter by default?" come from your own recent
> ratings, are only suggestions, and change nothing unless you accept
> them.

`test-legal.mjs` should assert the paragraph's three claims: kept in
the planner, sent as instructions, and no training.

**Consent: probably no version bump, but this needs a ruling (flagged
at the top of this file), and the reasoning has to be checked, not
assumed.** The consent rule is to bump for a change in
what happens to content, and the material-type ledger
(`aiMaterialTypes.js`) is the mechanism.

- The enum codes aren't material. They're instructions we wrote, keyed
  by a code.
- Known terms **are** student content leaving the device on a route
  that didn't carry them before: the `ai-notes` summariser. But they're
  terms from the student's own study cards, which is the existing
  `own-notes-and-cards` type, already named on the consent screen and
  in the policy. So the type set, and with it `materialFingerprint()`,
  doesn't move.
- What does move is `MATERIAL_ROUTES`: the lecture-summary route gains
  `own-notes-and-cards`. The route guard requires that edit, and it's
  where a person must confirm the consent screen's description of that
  material still covers "sent with your lecture so the notes skip what
  you know". If it doesn't, that's a v9 bump, and the ledger ratchet
  makes it impossible to skip quietly.

**The route guard can't see a new field on an existing call**, as its
own header says, so the `MATERIAL_ROUTES` edit is a decision somebody
has to make, not something a test will force. That's the reason it's
written down here.

## Tests to write with it

1. `suggestStyle`: 3 of 5 suggests and 2 of 5 doesn't; a decline holds
   for 30 days and for three more ratings; a failed read suggests
   nothing; the comment column is never read.
2. Defaults send nothing: a request with no profile is byte-identical
   to today's.
3. Server mapping: every code maps to a fixed sentence; an unknown code
   falls back to the default and is logged, never refused; known terms
   are bounded, deduplicated and never placed in the system prompt.
4. A profile-size test: 40 terms plus every field filled stays under
   1 KB serialised.
5. The banned-verbs sweep over the copy, the policy and the store text.
6. A real mount: the Settings card renders, a change persists, and an
   accepted suggestion changes exactly one field.
7. The measurement pair, run by hand, with its result recorded in this
   file before release.

## What it deliberately does not do

- **No free-text instructions** ("write like my lecturer"). A free-text
  box is a prompt-injection surface and an unbounded field, and it
  makes the consent screen describe something nobody can enumerate.
- **No automatic changes**, however strong the signal.
- **No cross-student signal.** One student's ratings never inform
  another's notes, and a weekly query over everyone's ratings
  (`notes-quality-weekly.sql`) is for us to improve the fixed prompt,
  by hand, in a reviewed commit.
- **Not for text tasks** (summarise a reading or a note). Same idea,
  different prompts and different credit weights. A later item, if this
  one proves useful.
