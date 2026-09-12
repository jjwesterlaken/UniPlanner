# Essay feedback — discovery, for 1.2

**Status: DISCOVERY AND PLAN ONLY.** No code, no endpoint, no screens.
Nothing here merges to `main` until 1.1.0 is approved.

The feature as briefed: a student supplies their marking criteria and
their essay draft; the AI returns an estimated band against those
criteria and specific suggestions for improvement. **It must never
write, rewrite, or complete the essay.**

Every figure below was computed by running the project's own constants
out of `_shared/credits.ts` and `ai-text/config.ts`, bundled the way
`scripts/test-ai-text-function.mjs` does it. None of them is retyped and
none is estimated.

---

## 0. THE ONE THING IN THE BRIEF THAT IS WRONG, AND IT IS THE ONE THAT MATTERS

> *"A new data type means every existing consent is re-prompted —
> confirm that's what the fingerprint does."*

**It is not what the fingerprint does.** Confirmed by running it, not by
reading it:

```
fingerprint today                       groq:Groq:the United States,openai:OpenAI:the United States
built from                              id : name : country, per provider, sorted

every provider's ROLE rewritten    ->   unchanged        (does NOT re-prompt)
one provider ADDED                 ->   changed          (re-prompts)
AI_CONSENT_VERSION bumped          ->   n/a              (re-prompts)
```

`providerFingerprint()` is over `id`, `name` and `country`. The facts
list in `_shared/aiProviders.js` **has no field for what a provider
receives** — that wording lives in `PROVIDER_COPY` in `src/aiProviders.js`,
which the fingerprint never reads. This is deliberate and CLAUDE.md says
so: *"Deliberately NOT over `receives`: a typo fix in a bullet must not
re-prompt everybody and train them to click through."*

So the fingerprint answers **"has the list of companies changed?"** and
nothing else. Essays go to OpenAI, which is already on the list. The
fingerprint will not move, and **every existing acceptance would stand
while the screen quietly started describing a new kind of material.**

**The mechanism that re-prompts for a change of CONTENT is
`AI_CONSENT_VERSION`, and it is a hand-typed integer.** `needsConsent`
has exactly two triggers and that is the other one.

### And nothing compels the bump

`scripts/test-legal.mjs` guards past bumps as **floors** —
`AI_CONSENT_VERSION >= 4` for the text features, `>= 5` for the
supplied-text category, `>= 6` for photographed pages. Each was added by
hand *after* the decision. They record history; they cannot demand a
future bump. An essay feature could ship at v7 with all three still
green.

**So the first work item is a guard, before any feature work:** tie the
consent version to the set of material types the screen names, so adding
one without a bump goes red. The shape that fits this codebase is the
device-store guard's: derive the list of material types from one place,
hash it, and pin the hash beside the version — a change to the list with
no version bump fails, naming both.

That is a change to the consent machinery and it is **independent of
essay feedback**. It should land first, on its own, whatever happens to
this feature.

---

## 1. Data and consent

### It is a bump, and the precedent is exact

CLAUDE.md's own test for a bump: *"a new kind of material leaves the
country, and a new promise is made about it."* v6 bumped for
photographed pages on precisely that reasoning. An essay draft qualifies
on the first half alone.

But it is stronger than photos, because of what an essay contains.

### The personal-information problem is real and it is NEW

A lecture transcript captures the lecturer. A pasted reading is
published material. **An essay carries the student's own name, their
student ID, the course code, sometimes their tutor's name — and it is
their own assessable work.** The existing "text you supply" category
covers the *relaying*, but the policy's `What we collect` and
`Sending things overseas` sections were written when the supplied text
was a note or a reading.

Three specific consequences:

1. **The consent screen's "what is sent" list needs an essay bullet that
   says the essay is sent AS WRITTEN**, identifiers included, because we
   do not strip them. Offering to strip them would be worse: a regex that
   removes "some" names is a promise we cannot keep, and a student who
   believes it would paste more freely than they should.
2. **The honest mitigation is a prompt on the screen, not a filter in
   the code**: one line telling the student they can remove their name
   and student ID before pasting, and that we do not remove it for them.
   That is true, actionable, and does not claim a capability.
3. **The policy's overseas section needs the essay named.** It currently
   enumerates "a note you wrote, your study cards, an explanation you
   have typed, a section of a reading you paste in, or photos of pages".
   The document list is derived from `legalLinks.js` and the table list
   from the migrations, but **this sentence is a hand-written
   enumeration** — so it is a restatement, and adding a sixth material
   type is exactly the drift the ledger is about.

### What does NOT change

- **No new provider.** OpenAI already receives supplied text; this is
  more of the same kind going to the same company. So the *fingerprint*
  legitimately does not move, and the version bump is doing all the work.
- **No storage.** `ai-text` has no storage client and a test pins that.
  An essay is relayed and not stored, exactly like a pasted reading —
  which is the strongest thing we can say and must not be blurred (the
  "not in your planner, not on our server" location clause).
- **No new table**, so the derived table sweep in `test-legal.mjs` stays
  green on its own.

### Work items

| | |
|---|---|
| **C1** | Tie `AI_CONSENT_VERSION` to the material-type list by a derived guard. **Independent of this feature; land it first.** |
| **C2** | Bump to v8 with an essay bullet naming identifiers, plus the "you can remove your name first, we don't" line. |
| **C3** | Policy: add the essay to the supplied-material enumeration in `AI features` and in `Sending things overseas`, and derive that enumeration from one constant so the next type cannot drift. |
| **C4** | A `test-legal.mjs` assertion that the essay bullet and the policy sentence name the same material. |

---

## 2. Input: paste only, and the size question mostly answers itself

### Paste only for the first version

Three reasons, in order of weight:

1. **`ai-text` has no storage client, and a test pins it.** Any upload
   path that goes through our server makes the privacy policy and the
   consent both false. PRODUCT-PLANS already records that file
   extraction must be **client-side** for this reason.
2. **Client-side extraction is a real dependency**, not a flag: pdf.js
   for PDF, a zip reader plus XML parse for docx, both in a 662 KB
   bundle that ships to phones. It is its own piece of work and it is
   already scoped in PRODUCT-PLANS with a 10x credit saving attached —
   which belongs to *readings*, where the alternative is photographing
   pages. An essay is already text in a text editor. **Copy and paste is
   one keystroke; the saving does not exist here.**
3. Paste-only is the shape that makes the readings feature defensible,
   and it is the same argument here.

**Recommendation: paste only for 1.2. Revisit upload with the readings
file-upload work, as one dependency serving two features.**

### A 3,000-word essay already fits, and that is the finding

| chars/word | 3,000 words | input tokens |
|---|---|---|
| 5.8 | 17,400 | 4,143 |
| 6.1 | 18,300 | 4,357 |
| 6.5 | 19,500 | 4,643 |

`MAX_INPUT_CHARS.summarise` is already **20,000**. A 3,000-word essay is
~18,300 characters, so the essay alone fits under the existing cap and
only the criteria push it over.

**This matters more than it looks: it means NO CHUNKING.** And chunking
would be wrong here regardless — a marker reads the whole essay, and
structure, argument and coherence are the things criteria ask about.
Feedback assembled from four independently-summarised quarters cannot
say anything true about whether the argument holds together. The
readings pipeline chunks; **this one must refuse instead.**

**Proposed ceiling: `MAX_INPUT_CHARS.essay = 24,000`** — essay plus
criteria in one call, which covers 3,000 words with ~5,700 characters of
criteria, or ~3,600 words with a short rubric. Over it, refuse naming
the overage, the existing rule.

### The credit cost, derived

Priced the same way every other task is — **at its own ceilings**, so the
number is an upper bound on what one call can cost us:

```
practice    in   8,000 chars  out 1,500 tok  $0.001186  = 2 credits
explain     in   4,000 chars  out   600 tok  $0.000503  = 1 credit
weakspots   in   6,000 chars  out   800 tok  $0.000694  = 1 credit
summarise   in  20,000 chars  out 2,000 tok  $0.001914  = 3 credits
merge       in  12,000 chars  out 2,000 tok  $0.001629  = 2 credits

essay       in  24,000 chars  out 2,000 tok  $0.002057  = 3 credits   <- proposed
```

**A run costs 3 credits.** And it is stable across the sensible range —
every combination from 20k/2000 to 30k/2500 lands on 3 or 4, so the
answer does not hinge on picking the cap precisely:

```
in 20,000  out 2,000  = 3      in 28,000  out 2,000  = 3
in 24,000  out 2,500  = 3      in 28,000  out 2,500  = 4
in 24,000  out 3,000  = 4      in 30,000  out 3,000  = 4
```

A **real** 3,000-word run (not the ceiling) is `$0.001805` = **3
credits**. A 1,500-word one is 2.

Against the allowances:

| tier | allowance | runs |
|---|---|---|
| Free | 60, once ever | **20** |
| Study AI | 900/month | 300 |
| Study AI Max | 3,000/month | 1,000 |

For scale: 3 credits is a **3-minute recorded lecture**, and a whole
pasted reading (4 chunks + merge) is **14**. Essay feedback is one of the
*cheapest* things in the app — cheaper per run than summarising a
reading, because an essay is shorter than a reading and the output
ceiling is what dominates.

**`MAX_TOKENS.essay = 2,000`** — the same as `summarise`. Feedback across
~5 criteria with a paragraph each plus the band reasoning is that shape.
Note the depth lesson from `ai-notes`: if the output reads thin, **fix
the prompt first and measure**, do not raise the ceiling. Raising it to
3,000 costs a fourth credit and buys permission to be verbose.

---

## 3. The no-writing guarantee

> *"A prompt alone is a hope."*

Agreed, and the prompt is still necessary — it is what makes the model
try. What follows is what makes it **checkable**. Three layers, and the
third is the one that actually bites.

### Layer 1 — the schema gives a rewrite nowhere to live

Output is parsed against a strict JSON schema already. Make every field
short and purpose-named, with no free-text field big enough to hold a
paragraph of replacement prose:

```
{ band, bandReason,
  suggestions: [ { criterion, whatIsMissing, whereInEssay, whyItMatters } ] }
```

`whereInEssay` is a **locator** ("the third paragraph, beginning
'Although the data…'"), not a container. A field capped at ~300
characters cannot hold a rewritten section.

This is real but weak on its own: it bounds length, not kind. Six 300-
character fields is still 1,800 characters of prose the student could
paste in.

### Layer 2 — a per-field length refusal

Refuse the whole response if any single field exceeds its cap. Cheap,
deterministic, and it catches the obvious failure. Still not sufficient:
a model that writes *short* replacement sentences passes.

### Layer 3 — THE VERIFIABLE ONE: a quotation must be the student's own words

This is the constraint worth building, and it is checkable server-side
with no extra provider call.

**The rule:** any quoted span in the output above ~12 words must appear
**verbatim in the submitted essay**. Quoting the student back to them is
how you point at a problem; producing new prose in quotation marks is
how you hand them something to paste.

- Locating a problem requires quoting *their* text → always passes.
- Offering replacement wording produces a span that is **not** in the
  input → always fails.

The two are separated by whether the text already exists, which is a
substring check. That is the whole mechanism, and unlike a length cap it
is about **kind** rather than size.

**Plus an unquoted-novelty check** for the model that drops the quotes:
any suggestion field containing a run of ≥ 12 consecutive words that is
neither in the essay nor in the criteria is new prose written *for* the
essay. Tune the window on real output; 12 is a starting point, not a
measurement, **and it must be measured before it ships** — the
distribution lesson from the ink work: a threshold sized to an anecdote
is sized to the wrong thing.

### What happens on a refusal, and it costs money

**The refusal is BILLED**, under its own code, and the copy says so.
That is not a choice — it is the rule the codebase already follows:
output that cannot be used IS billed because the tokens were generated
and charged (`pages_unreadable` is the precedent). Charging quietly is
how a support ticket becomes a chargeback.

So the copy carries both halves: *this attempt was charged; try again
and it charges again.* And the refusal should say what happened in a way
that is not the student's fault, because it is not.

### And a wording guard, the readings shape

`scripts/test-readings.mjs` bans substitution framing with a blunt grep
over the copy — *"skip the reading"* is not the product. The same guard,
pointed at this feature:

```
/write (it|your essay) for you/i, /rewrite/i, /fix your essay/i,
/improve[sd]? your writing for you/i, /(polish|edit) your (essay|draft)/i,
/(better|stronger) version of/i
```

Strip comments first — the rule will be stated in the modules, and the
guard tripped on its own documentation the first time it was written for
readings.

### What none of this can do

**It cannot stop a student pasting a suggestion in and calling it their
own.** No client-side or server-side check can. What the three layers
buy is that the app never *hands them the text to paste* — which is the
difference between a study tool and a ghostwriter, and it is the
difference an academic-integrity office would ask about.

---

## 4. Framing: never a prediction

"Estimated mark" is the wrong phrase and should not ship.

**The claim we can defend:** *this is what your essay looks like against
the criteria you pasted.* **The claim we cannot:** *this is what your
marker will give you.* Three things separate them and all three must be
in the wording.

### Use the criteria's own language, never invent a scale

If the pasted criteria say Distinction / Credit / Pass, the answer says
Distinction. If they say 1–7, it says 5. **If they carry no bands at
all, the feature returns no band** — only the criterion-by-criterion
feedback — rather than inventing a scale the marker does not use. A
number nobody's rubric contains is the clearest possible way to be
confidently wrong.

### Proposed wording

> **Against the criteria you pasted, this reads like a Credit.**
>
> This is the AI's reading of the criteria you gave it — not a
> prediction of your mark. It hasn't seen your unit's standards, your
> cohort, or how your marker weighs things, and it can be wrong about
> all three. Use it to find what to work on, not to decide whether
> you're done.

Three things that sentence does deliberately:

- **"Against the criteria you pasted"** puts the input in the claim. The
  criteria are the student's own paste and may be partial or wrong, and
  the reading inherits that.
- **"reads like"** rather than "is" or "would get".
- **Names the three things it cannot see.** Vague hedging
  ("results may vary") trains people to ignore hedges; specific
  limitations are actionable.

### A wording guard, same shape as §3

Ban prediction framing anywhere in the copy: `/you'?ll get/i`,
`/your mark will/i`, `/predicted (mark|grade)/i`, `/guarantee/i`,
`/what you'?ll score/i`. Plus the positive half — absence is not the
same as saying the right thing — asserting the disclaimer names the
criteria as the student's and the reading as the AI's.

### And the band must never appear without it

Pin by a real mount, not by a source read: the band and the disclaimer
render in the same component, and a test asserts the disclaimer is
present wherever the band is. A band in a summary card, a notification
or a saved note with the caveat left behind on another screen is exactly
how the claim escapes.

---

## 5. Where it lives, and which tier

### Where: the Assessments tab, on the assessment row

**Not the AI tab.** The precedent is `SummariseReading`, and the
reasoning transfers exactly: it sits on the *reading row*, collapsed to
one line, opening inline, because *"the student is looking at
'pp. 89–112' when the thought occurs, which is where the action
belongs."*

A student thinking about essay feedback is looking at the assessment —
its due date, its weight, its rubric. **The app already has a
paste-and-do-something panel attached to a row** (`RubricPanel` on an
assignment, `SummariseReading` on a reading), and a second pattern would
be a second thing to learn.

This also gives the criteria a home: an assessment row is where a rubric
already lives.

**The result files into the per-course folder** exactly as a recording
and a reading summary do, **inside its own `try`** — a folder is a
convenience and must never take down work just paid for.

### Consent: the same gate, through `AiActionFrame`

All five text features render their controls through `AiActionFrame`,
and consent rides on the allowance object every one of them already
takes. **A sixth inherits the gate with no new wiring** — that is what
`AiActionFrame` was built for, and there is no route to a provider in
that file that does not pass the branch.

The boundary refusal in `src/aiConsentState.js` covers it too, since it
gates `callAiText` rather than any individual screen.

### Tier: every tier, and the trial is the argument

Recommendation: **`TEXT_TIERS` unchanged — free, ai, ai_max.**

The existing reasoning applies with more force here than anywhere:

- At 3 credits a run, the trial buys **20 essays**. That is not a
  teaser, it is a semester.
- It costs about **2 cents** per free account that uses the whole trial
  on this feature alone.
- Essay feedback is the most legible reason to pay for this app. Gating
  it entirely means nobody experiences the thing they would be buying —
  and a student who has had one essay read and found it useful is the
  conversion.

**Lecture recording stays `ai`-only**, unchanged; it costs real
transcription minutes where this costs a fifth of a cent.

---

## The order of work, and what gates what

| | | |
|---|---|---|
| **1** | The consent-version guard (§0, item C1) | **Independent. Land first, whatever happens to this feature.** |
| **2** | The no-writing constraint, measured on real output (§3) | Decides whether the feature is defensible at all |
| **3** | Consent v8 + policy (§1) | Must precede any deploy that can send an essay |
| **4** | The endpoint task + caps (§2) | 24,000 / 2,000 / 3 credits |
| **5** | The panel on the assessment row (§5) | Grace's, for layout and wording |

**Two things must be measured before they are built on**, and both are
the same lesson this project keeps relearning:

- **The 12-word novelty window** is a starting point, not a measurement.
  Run it over real output first and look at the distribution; a
  threshold sized to one example clamps the wrong two-thirds.
- **`MAX_TOKENS.essay = 2,000` is derived from a guess about the output
  shape.** If the feedback reads thin, the fix is the prompt — measured,
  the way the summariser's depth was (+189% words per key point with the
  ceiling untouched) — and only then the ceiling.

## What this document cannot answer

- **Whether the model can grade against a rubric well enough to be worth
  3 credits.** Nothing here has called a provider. That needs a real
  essay, a real rubric, and Jared or Grace reading the output beside a
  mark the essay actually got.
- **Whether the no-writing constraint holds in practice.** The mechanism
  is sound; the window is not measured, and a model that evades it in
  some way nobody predicted is exactly what a first run would show.
- **Whether an academic-integrity office would accept the framing.** The
  posture rests on the same design facts the readings feature rests on —
  student-initiated, paste-only, never stored, never writes — but that
  is our reading, and the university's may differ.
