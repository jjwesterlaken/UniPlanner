# Essay feedback — discovery, for 1.3

**Status: BUILT for 1.3.0** (26 September 2026): the endpoint is on,
the panel sits on the Grades row, the capture and the mark loop write to
0023, and the example rewrite is built and switched OFF until its scope
limits are measured (see "THE EXAMPLE REWRITE" below). What follows was
written as discovery and is kept as the record of why it is shaped this
way.

The feature as briefed: a student supplies their marking criteria and
their essay draft; the AI returns an estimated band against those
criteria and specific suggestions for improvement. **It must never
write, rewrite, or complete the essay.** *That last sentence was the
brief. Jared reversed it on 18 September 2026, for one scoped action:
see "THE EXAMPLE REWRITE". The comments themselves still never offer
wording, and everything in §3 still holds for them.*

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

### AND IT ALREADY DID — 16 September 2026, verified by mutation, not by reading

**This section went on calling C1 "the first work item" for eight days
after it shipped.** `src/aiMaterialTypes.js` is the guard described
above: material types as facts, `materialFingerprint()` over
`id:retention`, and `CONSENT_MATERIAL_LEDGER` pinning the hash beside
the version. The paragraph is kept rather than deleted because the
reasoning is what justifies the guard, and a work item nobody struck
off is the third stale line this project has found in a fortnight —
worth leaving visible.

**Settled by running it, since a guard that is present and a guard that
bites are different claims.** Adding an `essay-draft` type without a
bump reddens two tests by name:

```
FAIL - every kind of material the AI features send is named on BOTH documents
FAIL - THE MATERIAL LIST IS TIED TO THE CONSENT VERSION: a new kind of
       material cannot ship without a bump
```

and the failure prints the remedy — add a ledger entry at the next
version, bump `AI_CONSENT_VERSION`, say on the screen what the material
is. **The cheap fix is refused too**: editing v7's ledger entry instead
of bumping reddens *"the material ledger is APPEND ONLY: an accepted
version's record may never be edited"*, which is the half that makes
the rest of it real.

So step 3 (consent v8) is now three edits that the suite will not let
you make two of.

### AND THE HOLE ONE LEVEL UP — found 24 September, BUILT the same day

C1 stops you **adding a material type without bumping**. Nothing stops
you **adding a feature without adding a type**.

`AI_MATERIAL_TYPES` is a hand-written list. CLAUDE.md describes it as
*"read out of `groq.js`, `ai-notes` and `ai-text/prompts.js` rather
than remembered"* — and that is a true statement about how a PERSON
compiled it, not about a derivation any test performs. So:

```
add `essay` to ai-text/prompts.js SYSTEM   ->  everything green
   fingerprint unchanged (no new provider)
   ledger matches v7  (no new type)
   the floors still hold (>= 4, >= 5, >= 6)
   the screen goes on describing six kinds of material out of seven
```

**That is the exact failure §0 is about, one step earlier in the
sequence somebody actually performs.** Nobody sets out to add a
material type; they set out to add a feature, and the type is the thing
they are supposed to remember. C1 mechanised the second half of the
chain and left the first half to memory.

**The shape that would close it** is the device-store guard's, which
this codebase reaches for every time: every task in `ai-text`'s prompt
set must be mapped to the material type it sends, or excused in writing
with a reason. Adding `essay` then fails until somebody declares what
it sends, which changes the fingerprint, which forces the bump — task
-> type -> fingerprint -> version, with no remembering anywhere in it.

**JARED'S RULING, 24 September 2026: build it before step 3, cover both
endpoints, and export what is needed rather than grepping prose.** Done
the same day — `MATERIAL_ROUTES` in `src/aiMaterialTypes.js`, `TASKS`
exported from `ai-text/prompts.js`, and the derivation in
`test-legal.mjs`. **Essay feedback is the first feature it covers**,
which is the whole reason it went before step 3 rather than after
1.3.0: a guard whose first customer is the feature that motivated it
has been tested by something real.

**The routes are DERIVED from both endpoints.** `ai-text`'s are
`SYSTEM`'s own keys — exported as `TASKS`, not restated beside them,
since `buildMessages` throws on a task `SYSTEM` has no entry for, so
those keys ARE the set. `ai-notes`'s are the adapter METHODS, read off
the three adapter objects. A grep was refused for the reason recorded
above: `prompts.js` is a file of prose *about* summarising readings and
photographs, so a pattern hunting task names in it is the
comment-stripping trap with extra steps.

**THE UNIT IS THE PROMPT, NOT THE FEATURE, and one row proves why.**
"Summarise a note I wrote" and "summarise a reading I pasted" are two
features on two screens and **one** `summarise` task, so
`ai-text:summarise` maps to two material types. A list keyed on
features would have split a single outbound prompt in two; a list keyed
on client task names would have had no row at all for
`summariseImages`, which is not a task the client can ask for — it is
selected inside `summarise` when the body carries photographs, and it
is the row through which every photographed page leaves the device.

**No "sends nothing" option exists**, deliberately. A route working on
output we generated maps to the material that output was DERIVED from —
`ai-text:merge` sends section summaries of a pasted reading, to the same
company, under the same promise, so it maps to `pasted-reading`. An
escape hatch would be the one row everybody reaches for, and the first
thing somebody would put an essay behind.

**Verified by five mutations, and the second is the one that matters:**

| mutation | what went red |
|---|---|
| add an `essay` task, change nothing else | `ai-text:essay` — *nothing says what it sends* |
| then map it to a new `essay-draft` type | the ledger AND the both-documents check — **the bump is now compulsory** |
| add an adapter method on the ai-notes side | `ai-notes:groq.diarise` |
| delete a task, leave its row | `MATERIAL_ROUTES names routes that no longer exist` |
| map a route to a type that does not exist | named the route and the bad id |

The second row is the claim: satisfying the new guard the obvious way
lands you on the old one, which then requires the version bump and the
screen wording. Four links, one judgement — *what does this actually
send?* — and no step that depends on remembering.

**WHAT IT CANNOT SEE, stated in the test rather than implied by a
pass:** it knows a route EXISTS, never what a given request puts in the
body. Adding a field to an existing call — a course name onto a
summarise request — is invisible to it and is caught only by somebody
reading the diff. The unit is the route because that is the unit a
feature adds.

**One false positive was fixed by moving, not by loosening.** The
filesystem-path sweep in `test-vacuous-guards.mjs` flagged
`import(file)` in the new test, because it cannot tell a relative
specifier held in a variable from a path held in one. It is guarding a
real Windows failure, so the argument became a literal in each call
rather than the check becoming laxer.

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
- **No new table** *for the essay feature itself*, so the derived table
  sweep in `test-legal.mjs` stays green on its own.

  **THIS STOPPED BEING TRUE ON 24 SEPTEMBER**, and the line is kept
  rather than rewritten because the reasoning is still right about the
  essay half. The mark-comparison loop (§"THE MARK COMPARISON") adds
  `assessment_feedback` in migration 0023, and that sweep matches
  `create table public.X` across the migrations and requires a declared
  phrase in BOTH published documents — so it goes red until the policy
  and the deletion page say what the table holds. The essay text still
  reaches no table; a mark does.

### Work items

| | |
|---|---|
| **C1** | ~~Tie `AI_CONSENT_VERSION` to the material-type list by a derived guard.~~ **DONE — `src/aiMaterialTypes.js`, 16 September 2026.** See the note below. |
| **C2** | Bump to v8 with an essay bullet naming identifiers, plus the "you can remove your name first, we don't" line. |
| **C3** | Policy: add the essay to the supplied-material enumeration in `AI features` and in `Sending things overseas`, and derive that enumeration from one constant so the next type cannot drift. |
| **C4** | A `test-legal.mjs` assertion that the essay bullet and the policy sentence name the same material. |

---

## 2. Input: paste only, and the size question mostly answers itself

### RULED, and it is no longer a recommendation — Jared, 16 September 2026

> **Essay feedback is text-only and paste-only, for 1.3 and the
> foreseeable future: no photographs, no screenshots, no file upload,
> and no artistic, design or performance work. Those are a different
> feature with a different risk and are not on the roadmap.**

The rest of this section argued for paste-only and left upload to be
"revisited with the readings file-upload work". That is settled: it is
not revisited with the readings work, because the two are no longer
one dependency serving two features. Readings may still get upload on
its own merits — an alternative that costs 10x in credits is a real
argument there. **An essay has no such argument**, which §2.1 below
already says: an essay is text in a text editor, copy-and-paste is one
keystroke, and the saving does not exist.

**THE NO-PHOTOGRAPHS HALF IS NOT THE SAME DECISION AS THE NO-UPLOAD
HALF, and it is the more important one.** Upload is about plumbing.
Photographs, screenshots and non-text work are about whether the
feature's central constraint can exist at all:

- §3 layer 3 — the only verifiable layer — is a **comparison against
  the words the student submitted**. A quoted span must appear in the
  essay; a novel run is prose that does not. Both are substring
  questions over text.
- There are no words to compare against in a photograph of a painting,
  a screenshot of a layout, or a recording of a recital. The
  no-writing guarantee is not weakened for that material, it is
  **absent** — and a feature whose guarantee is absent is a
  ghostwriter with a disclaimer.
- A screenshot of an essay is worse than either: it looks like text,
  so the constraint appears to apply, and it silently does not,
  because OCR output is not the submitted words and would read as
  novel against itself.

So a future version that took any of those would need a **different
constraint**, designed for that material, not a wider input field on
this one. That is why `scripts/measure-no-writing.mjs` and
`scripts/sample-asap.mjs` take text files and have no image path: the
shape of the instrument follows the shape of the claim.

**What the wording rule already forbids stays forbidden**, and this
ruling adds nothing to it — §3's grep bans substitution framing, and
"upload your assignment" is not currently in any copy because there is
nothing to upload it to.

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

**Recommendation: paste only for 1.3. Revisit upload with the readings
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

### The credit cost, derived — ON LUNA: 9 credits at a 4,000-token ceiling (RULED)

**The 3-credit figure below the line was derived for gpt-4o-mini at a
2,000-token output ceiling, and both halves have moved.** Gate A chose
`gpt-5.6-luna` (Jared, 25 September 2026) on measured agreement with the
human raters (11/18 and 9/18 on two seeds, the only model that stopped
reading every high-band essay one band low), at $0.20 / $1.20 per 1M
input / output tokens. Those rates are Jared's, read off OpenAI's pricing
page that day; the build container cannot reach it. They are in
`_shared/model.ts` as `ESSAY_USD_PER_1M_*`.

**The ceiling comes from what was measured, not from 8,000.** Luna is a
reasoning model, and its reasoning tokens are output tokens: 2,000 would
cut off most replies. Across 36 runs the max cost was $0.00455 a run. The
read printed a per-essay USD maximum but not a per-essay token maximum,
so the output maximum is BOUNDED, not read: at the smallest input any run
could have had (the 7,067-character system prompt plus a 250-word essay,
no rubric at all, ~2,010 tokens), $0.00455 buys at most **~3,460 output
tokens**. Every real run had more input than that, so the real maximum is
lower, around 3,200. The next read prints the token maximum directly.

Priced the product's way, at the task's own ceilings
(`MAX_INPUT_CHARS.essay` = 24,000, the system prompt excluded as for every
other task):

```
out ceiling   ceiling cost   credits   headroom over the ~3,460 bound
   3,000        $0.00474        7        none: BELOW the measured max, so some replies are cut off
   3,500        $0.00534        8        ~1%
   4,000        $0.00594        9        ~16%
   4,500        $0.00654       10        ~30%
```

**It did not land in the 5–7 band that was set as the price.** 7 credits
needs a ceiling below the measured maximum, and a reply cut off at the
ceiling is still billed, because the tokens were generated. And the
measurement is on ASAP essays of 350–650 words, where a university essay
runs to 3,000; its verbatim support spans and its points both grow with
length, so if anything the ceiling needs more headroom, not less.

**RULED, Jared, 25 September 2026: 9 credits, at `MAX_TOKENS.essay =
4,000` and `MAX_INPUT_CHARS.essay = 24,000`.** `TASK_CREDITS.essay` is
derived from those two ceilings at `ESSAY_USD_PER_1M_*` like every other
task's, and a test pins it at 9, so a ceiling or a rate that moves turns
the price red rather than drifting it. The two alternatives that were
not taken: 8 at 3,500 (about 1% headroom over the bound), and a lower
reasoning effort, which is a different configuration needing its own
agreement number before it could be priced.

What the MEAN run costs, for scale: $0.00342, **5 credits**. Pricing at
the mean charges an average student the average, and loses money on
every long essay. That is the reverse of how every other task here is
priced, which is why the ceiling is the price.

Against the allowances at 9 credits: the trial buys **6 runs**, not 20;
Study AI 100 a month; Study AI Max 333.

---

**THE gpt-4o-mini DERIVATION, superseded, kept because the reasoning
about ceilings still holds:**

Priced the same way every other task is — **at its own ceilings**, so the
number is an upper bound on what one call can cost us:

```
practice    in   8,000 chars  out 1,500 tok  $0.001186  = 2 credits
explain     in   4,000 chars  out   600 tok  $0.000503  = 1 credit
weakspots   in   6,000 chars  out   800 tok  $0.000694  = 1 credit
summarise   in  20,000 chars  out 2,000 tok  $0.001914  = 3 credits
merge       in  12,000 chars  out 2,000 tok  $0.001629  = 2 credits

essay       in  24,000 chars  out 2,000 tok  $0.002057  = 3 credits   <- on gpt-4o-mini, superseded
```

The input ceiling is unchanged by the model move: **`MAX_INPUT_CHARS.essay
= 24,000`** still covers 3,000 words with ~5,700 characters of criteria.
The output ceiling is what moved, from 2,000 to the figure being ruled on
above. The depth lesson from `ai-notes` still applies: if the output
reads thin, **fix the prompt first and measure**, do not raise the
ceiling.

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

### THE THRESHOLDS, AND THE RULE THEY ARE READ BY (Jared, 25 September 2026)

`ESSAY_NO_WRITING` in `ai-text/config.ts` holds four numbers, and until
they are set the essay task refuses before any spend. They are read off
the no-writing harness run on **gpt-5.6-luna**, the model that ships,
never on another model's output, and never guessed:

| threshold | what it refuses | read from |
|---|---|---|
| `maxNoteWords` | a note long enough to hold a paragraph | the constrained arm's note-length **p99, plus a margin** |
| `minQuoteWords` | a quote too short to locate anything | the **shortest quote that still locates uniquely** in the constrained arm |
| `window` | a run of new prose that long, not in the essay or the criteria | the constrained arm's **longest novel run**, with margin, so analysis in a note is never mistaken for a rewrite |
| `matchUnit` | the n-gram a word must share with the source to count as "not new" | the harness's own setting, the one the distribution was measured at |

**THE RULE: at the chosen settings, the constrained arm (the prompt we
ship) must refuse at most 2% of its legitimate points.** Every threshold
is taken from the constrained arm's own distribution, so the settings
protect real feedback first.

**WHERE THE TABLE SHOWS NO SEPARATION FROM THE ADVERSARIAL ARM, IT IS
SAID, and the thresholds are still set to protect legitimate feedback.**
On gpt-4o-mini there was none: the adversarial arm offered almost no
wording, so no cell separated the two. When that holds on Luna too, the
length and window thresholds are guards against size, not against
ghostwriting, and **the code-side offered-wording refusal is the
ghostwriting control**: any quoted span in a note that is not in the
essay or the criteria refuses the whole reply (`_shared/essayReply.js`).
Nothing in the numbers pretends to be more than that.

### THE SETTINGS, read off Luna (ASAP sets 1, 2 and 8, 25 September 2026)

Read from the two-arm harness on `claude/essay-thresholds`: the shipped
prompt, at the shipped 4,000-token ceiling. Every figure comes from the
constrained arm. The adversarial figure sits beside it only to show
whether the two arms separate.

| threshold | setting | constrained | adversarial | why this value |
|---|---|---|---|---|
| `maxNoteWords` | **30** | max 27, p99 23 | p99 71 | above the constrained max with margin |
| `minQuoteWords` | **3** | 3 words: 100% occur once; 2: 80%; 1: 33% | — | the shortest length that always locates one place |
| `window` | **30** | none can reach it: a note's novel run is at most its length, max 27 | 4% | at 25 it refused 2 of 72 constrained replies (2.8%), over the rule |
| `matchUnit` | **4** | — | — | the unit the window row was read at |
| `maxSentenceWords` | **50** | max 47 | — | above the constrained max; the opening sentence is one sentence |

**THE WINDOW APPLIES TO NOTES, NEVER TO THE OPENING SENTENCE.** The
sentence is the model's own summary, so every word of it is new prose:
its longest novel run on Luna was 29-42 words at unit 4 (p50 33). The
first gate run applied the 25-word window to it and refused 47 of 72
constrained replies (65.3%). No window could fix that without also
switching the window off for notes. So the sentence gets its 50-word cap
and nothing else, in the endpoint and the harness alike.

**THE MEASURED GATE, at these settings** (Jared's `--summarise` run on
the Luna `thresholds.json`, 26 September 2026):

| arm | whole replies refused | points dropped |
|---|---|---|
| constrained | **0 / 72** | 19 / 349 (5.4%) |
| adversarial | 26 / 72 | 8 / 382 |

**Offered wording in the opening sentence is NOT MEASURED** by that
figure: the file predates the sentence reading, and the harness says so
rather than counting those 72 sentences as clean. It is measured by the
next fresh run.

**TWO RATES, BECAUSE THE ENDPOINT HAS TWO KINDS OF REFUSAL.** A point
whose quote is too short, or is not in the essay, is DROPPED and the
rest of the reply stands. A note or opening sentence that breaks a
length, window or offered-wording rule REFUSES THE WHOLE REPLY, which is
billed. So the 2% rule is applied to whole replies: **at these settings
the constrained arm may have at most 2% of its replies refused** (Jared's
read of the Luna run is 0%). The point-drop rate is reported beside it,
and the harness's exit code follows the reply rule. About 5% of the constrained points are dropped,
all of them 1-2 word quotes or quotes not in the essay. The prompt now
asks for at least three words, so the short-quote drops should shrink.
**That prompt line was added after the measurement**: the drop rate
under it is not yet measured, and the next run is what measures it.

**NO SEPARATION, AGAIN, SAID PLAINLY.** The adversarial arm's note
lengths overlap the constrained arm's, and at 30 the window refuses 4%
of the adversarial arm's notes against none of the constrained. That is not a
detector. As on gpt-4o-mini, these settings are guards on SIZE, set so
legitimate feedback is never refused. The ghostwriting control is the
offered-wording refusal: any quoted span of three or more words in a
note or in the opening sentence that appears in neither the essay nor
the criteria refuses the reply (`_shared/essayReply.js`). The harness's old gate, which required
a cell refusing at most 10% of the constrained arm and at least 90% of
the adversarial arm, tested a claim this feature no longer makes, and
it has been retired.

### What happens on a refusal — and since 26 September 2026 it costs the student nothing

**RULED (Jared, 26 September 2026): "a refusal caused by our own model
or checks shouldn't cost the student, whatever the feature."** So
`writing_refused` is answered BEFORE the billing step and charges
nothing, as `rewrite_refused` already did. The copy says so: *nothing
was charged, and you can try again*, plus the line that it is not the
student's fault, because it is not.

**What this reverses, recorded so it is not re-derived.** This section
used to say the refusal is billed, on the codebase's rule that output
which cannot be used is billed because the tokens were generated. That
rule was about honesty (charging quietly is how a support ticket becomes
a chargeback) and the honesty half stands: the copy still says exactly
what happened. What changed is who absorbs the cost of our own check
firing. At Luna's rates that is a fraction of a cent a refusal.

**Extended the same day to unusable replies** on every text task: what
was `ai_failed_charged` is now the free `ai_failed`, and the charged
code and its wording are gone. **`pages_unreadable` stays billed**, by
ruling: the model did what it was told, and the cause is the photograph,
which the student can fix by retaking it.

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

### And a draft card on the AI tab (Jared, 26–27 September 2026)

"Not the AI tab" was about where the PANEL lives, and it still lives
on the Grades row for a student who starts from an assessment. The AI
tab is where students look for AI features, so it carries a **"Feedback
on a draft" card** too.

**The first version was a door, and it was too many steps.** It asked
for a course, then an assessment (or a new one with a title and a
weight), then navigated to Courses. On production its "new assessment"
choice could not even be selected on a course that already had an
assessment: the choice fell back to the first row whenever the picked
value was not a live id, and the new-assessment sentinel never is.
Reproduced in the real app, then removed with the design.

**Now it is one optional course and the draft, on the AI tab.** The
same panel renders open inside the card; the student pastes, runs and
reads the result without leaving the tab. **The run is filed under a
placeholder assessment** — "Essay draft, 27 Sep", under the chosen
course, **no weight and no due date** — created on DELIVERY so a
failed or refused run leaves no row behind (`placeholderAssessment` in
`essayFeedback.js`). From then on it is an ordinary Grades row, so a
mark entered on it asks the mark question. No weight means the grade
maths skips it (`weightOf() > 0` in `grades.js`); the row reads "no
weight", and a course holding nothing weighted says there is nothing
to work out rather than "your weights add up to 0%".

The draft's id lives in PlannerApp beside the hold, so the card's run
survives a tab switch exactly as a row's does. Closing the card starts
a new draft. `test-rendered-tabs.mjs` presses all of it in the real
app — the course dropdown, paste, run, result on the AI tab, the
placeholder under the course, a mark, the question — and goes red
naming the missing placeholder if the run is not filed.

**Not built: linking a placeholder to a real assessment.** Today a
student who later adds "Essay 1" with its weight has two rows, and the
mark loop runs on whichever carries the mark. Moving a placeholder's
feedback and AI-use record onto a real assessment is a small follow-up
if Grace wants the control.

**FOR GRACE: "Grades" now holds pre-submission work.** A draft is
reviewed on the Grades row before there is anything to grade, so the
section's name describes half of what it does. It may want a different
label; the card's own sentence ("It opens on that assessment in
Courses → Grades…") names it today and moves with it.

The panel also carries the app's **?** (`HelpButton`, the same
control), with three steps in `essayCopy.js`: paste before you submit;
get pointed at problems and ask for an example rewrite of one passage;
tell us how we did when the mark comes back.

### A RESULT OUTLIVES THE TAB — the production run, 26 September 2026

Jared's first production run lost a delivered result on a tab switch
and paid 9 credits to see it again. **The cause was the tab
conditional**, the same one that once ate a two-hour recording: the
panel renders under `{tab === "courses" && ...}`, so leaving the tab
unmounts it, and the result, the run id, the examples and both drafts
were component state. A run still in flight finished into an unmounted
component, was charged, and was never shown.

**The fix is `useRecordingSession`'s, one feature over.**
`src/essayHold.js` is a store PlannerApp owns above the tab switch;
the panel reads and writes its row's entry there. A result stays until
the student closes the panel (closing is dismissing) and stays after
saving, marked saved. A request that lands while the student is away
writes into the hold and is waiting when they come back, and a
remounted panel shows the run in flight rather than offering the button
again, which would charge a second read.

**MEMORY ONLY, deliberately, which is why this is not "write it to the
item".** The entry holds the pasted draft and the result, and the
result's quotes are the student's own words; the privacy policy says
supplied text is "not in your planner and not on our server". Writing
the result to the assessment would sync it and make that false. So a
**reload** still loses an unsaved result — saving the note is how a
student keeps one — and sign-out, or another account signing in, clears
the hold. `test-rendered-tabs.mjs` runs, switches tab through the real
nav, comes back, and requires the result, exactly one request, and the
draft absent from the stored planner; it goes red on the old panel with
"THE RESULT WAS LOST TO A TAB SWITCH".

**And the example rewrite is a button now** — the app's bordered
secondary button, with its cost on its own line beneath — because
"Show an example rewrite · An example costs 3 credits" in small grey
text read as a caption. Grace can restyle it; a test holds that it is a
bordered, padded button with the cost outside its label.

### Marking criteria from a photo (Jared, 27 September 2026)

The criteria box has a **Photograph your criteria** button: up to four
photos or screenshots, sent as one `criteria` batch, and the result
lands in the box as ordinary editable text for the student to check
against the original. **The essay stays paste-only**: the endpoint
refuses photos on the essay task, and refuses text on this one.

**A transcription, not a summary, and that is why it is its own
task.** The existing photo path summarises a reading. The essay's band
check reads the criteria's **own band names** ("reads like a Credit"),
so a paraphrased band is one the feedback can no longer name. The
prompt says word for word, keeps every band name exactly as written,
and lays a table out as `<band>: <descriptor>` lines under each
criterion.

**Priced as a photo batch, 18 credits for up to four photos, by
ruling.** `criteria` is in `PHOTO_ONLY_TASKS`, whose weight is derived
by the photo-batch formula at the same 2,000-token ceiling, and the
handler charges `PHOTO_BATCH_CREDITS` for any request carrying photos
(the #159 fix). Outcomes follow the existing rules: an illegible photo
is `pages_unreadable` and billed, as for a reading, because the cause
is the photograph; **no criteria in the photos** is `no_criteria_found`
and free; an unusable reply is `ai_failed` and free. The photos count
against the trial's eight-page photo cap like any photographed page.

**Consent: the page-photos material type, no bump (ruled).** The route
`ai-text:criteria` maps to `page-photos`, so the fingerprint and the
version do not move. The policy's "text or photos you supply" covers
it; its "photos of pages you are studying" is a looser fit, and is
worth Grace's eye on the next policy pass.

**NOT MEASURED.** `scripts/measure-criteria-photos.mjs` runs the
shipped prompt, model, ceiling and downscale against real photos and
reports word recall and precision against a typed truth, **every band
name not reproduced verbatim**, the input tokens a rubric really costs
against the reading batch the price is derived from, and truncation
headroom. The ceiling and the prompt move on what it prints.

**And a gap on the same path, fixed with it.** `callAiText` never put
the response body on the error it threw, so the unreadable page list
the reading screen reads from `err.body` never arrived: a student was
told pages could not be read, never which. The body rides on the error
now, and a test drives the real client against the server's shape.

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

- On gpt-4o-mini at 3 credits a run, the trial bought **20 essays**. On
  Luna at the ruled 9 credits (§2) it buys **6**. That is a
  demonstration rather than a semester, which is what the trial is for,
  and the argument for every tier stands.
- It costs about **2 cents** per free account that uses the whole trial
  on this feature alone: 6 runs at the measured $0.00342 mean.
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
| **4** | The endpoint task + caps (§2) | on `gpt-5.6-luna`: 24,000 in, 4,000 out, 9 credits (ruled) |
| **5** | The panel on the assessment row (§5) | Grace's, for layout and wording |
| **6** | The mark-comparison loop (§"THE MARK COMPARISON") | Migration 0023 WIDENS, so it is applied before the client that reads it |

**IT SHIPS AS 1.3.0, NOT 1.2.0** (Jared, 24 September 2026). 1.2.0 was
already tagged for desktop off a commit that predates this work, and
the iOS 1.2.0 build comes off a later `main` again — so one number was
about to name three code states, and `build-apps.yml`'s version check
cannot catch that: it asserts the tag's commit CARRIES the version, not
that it carries the work. The bump to 1.3.0 in the three `package.json`
files lands **with step 4**, not before, so the tree never advertises a
version whose feature is not in it.

**STEP 3 IS THE CONSENT BUMP, NOT STEP 5.** Worth stating plainly
because the two are easy to swap when reading the table quickly: v8 is
bumped by the ESSAY as a new material type (§1), which must precede any
deploy that can send one. Step 5 is the panel, and a panel changes no
promise — it inherits the gate through `AiActionFrame` with no new
wiring, which is what that component was built for.

**And step 6 bumps nothing.** A mark never reaches a provider, and
consent governs what happens to content we send away. What the mark
needs is a declaration, a table the documents name, and its own tick at
the point of use — three different mechanisms, none of them the consent
version.

**Two things must be measured before they are built on**, and both are
the same lesson this project keeps relearning:

- **The 12-word novelty window** is a starting point, not a measurement.
  Run it over real output first and look at the distribution; a
  threshold sized to one example clamps the wrong two-thirds.
- **`MAX_TOKENS.essay = 2,000` is derived from a guess about the output
  shape.** If the feedback reads thin, the fix is the prompt — measured,
  the way the summariser's depth was (+189% words per key point with the
  ceiling untouched) — and only then the ceiling.

## THE QUALITY JUDGEMENT — ANSWERABLE, and it always was (Jared, 23 September 2026)

> **Is the feedback any good?** Nothing measured so far answers that,
> and nothing measured so far was trying to.

**THE EXEMPLAR WAS IN THE CORPUS THE WHOLE TIME.** This section used to
say the search had failed: no annotated Australian university essay
with its mark and its criteria could be found, UC's study-help material
carries none, and public sources came up empty. All of that is true and
none of it was the question. **ASAP carries a human rater score for
every essay** — `domain1_score` in `training_set_rel3.tsv`, which
`sample-asap.mjs` has been reading since it was written, to stratify
the sample it draws.

**AND THE LICENCE FORBIDS REDISTRIBUTING THE TEXT, NOT READING IT.**
That is the distinction the old wording collapsed. Every instrument
here runs redacted because an unredacted run would put essay text into
a summary, a JSON file or a terminal somebody could paste — and from
"the text cannot leave" it does not follow that nobody may look at it.
A person reading feedback beside a real score, on their own machine,
breaks no rule.

So the blocker was never the corpus. It was that nothing had been built
to put an essay, its score and the feedback on one page.
`scripts/read-asap.mjs` is that, and §"The local read" below is how it
is run and what it refuses to do.

### The limits, stated, because this is not a university rubric

The read is worth having and it is not worth more than it is:

- **School essays, not university ones.** ASAP sets 1, 2, 7 and 8 are
  150–650 words by 7th–10th graders. A first-year essay is longer,
  makes a sustained argument, and is marked on criteria these prompts
  do not have.
- **A 1–6 band, not a mark against criteria.** `domain1_score` is a
  holistic rater score. It says an essay was better than another
  essay; it does not say *which criterion* it fell down on, which is
  exactly what the feedback claims to do. So the read can tell you the
  feedback is pointing at real problems and whether it is harder on the
  weaker essay — it cannot tell you the feedback agrees with a marker
  criterion by criterion, because no such marking exists here.
- **The rubric is a prompt-and-scoring guide, not a marking rubric.**
  What goes to the model as `criteria` is ASAP's own set description.
  It is closer to an assignment brief than to the criteria sheet a
  student is handed.

**What it therefore CAN answer**, and this is the whole of it: does the
feedback point at things a marker would care about, and does a
lower-scored essay draw more substantive comment than a higher-scored
one. If the answer to either is no, the feature is not ready whatever
the operating characteristic says. If the answer to both is yes, the
feature is worth showing to a real student — and a real marked
university essay, when one turns up, is still the better evidence.

**IT DOES NOT RETIRE THE OTHER ROUTE.** One real essay a student
submitted, with its criteria and its mark, remains the stronger
answer and is still worth getting. This is the read that is available
today rather than the read that would be best.

### The local read

`scripts/read-asap.mjs`, and everything about it is shaped by the one
rule above:

- it writes **one file, outside the repository** (`~/asap-read.md` by
  default) and **refuses** to write anywhere inside it;
- that file is the **only** unredacted output anywhere in this project.
  Every other instrument keeps its redaction, unchanged;
- the path pattern is in `.gitignore`, so an operator who points it
  somewhere odd still cannot commit it by accident;
- it opens with a **scoring sheet** to fill in while reading, because a
  judgement made after reading six essays is a memory of a judgement.

It runs **after** the scope control and the two-arm measurement, on the
same key: reading the prose of a mechanism that has not been shown to
hold is reading a draft, which is the reasoning the next section has
always given and which has not changed.

**THE SYNTHETIC PAIR IS STILL NOT A SUBSTITUTE** for either, and its
own README says why in its first paragraph.

**THE TWO QUESTIONS HAVE DIFFERENT EVIDENCE AND DIFFERENT DEADLINES**,
and keeping them apart is the whole point of writing this down:

| | answered by | due |
|---|---|---|
| Does the structure stop ghostwriting? | the two-arm run over the 32 ASAP essays | before the endpoint is built |
| Is the feedback worth its credits? | a person reading the feedback beside a real ASAP score, via `read-asap.mjs` | **before it ships to students** |

**WHY NOT BEFORE THE MECHANISM IS MEASURED.** A quality judgement made
against a mechanism that does not hold is a judgement about output
nobody would ship — the constrained prompt exists to be refused into
shape, and reading its prose before the operating characteristic says
whether the shape works is reading a draft. If the structure fails,
the feedback's quality is moot; if it holds, the quality question is
asked of output produced under the rules that will actually govern it.

**WHAT WOULD ANSWER IT**, so nobody has to reconstruct this later:

- one real essay a student submitted, with the criteria it was marked
  against and the mark it received;
- the constrained arm run over it, at whatever thresholds the ASAP run
  settles on;
- Jared or Grace reading the points beside that mark and answering:
  would this have helped, and is any of it wrong?

**THE SYNTHETIC PAIR CANNOT SUBSTITUTE**, and its own README says so
in the first paragraph: the enum, the essay and the checker have one
author, so recall against it is flattering by construction. It buys
text that may be SHOWN — the ASAP runs are redacted and a redacted run
gives nothing to look at when something seems wrong — and that is all
it buys.

**WHAT IT CAN HONESTLY PRODUCE** is a finding about the SCHEMA rather
than about any essay: faults are planted that the enum has no value
for, including the largest one in the fixture (the rubric asks 2,000
words, the essay is ~500). If the constrained arm invents values for
those rather than using `off-criterion`, the enum is too narrow and
needs widening before anything ships. That is a claim about our own
design, which a fixture we wrote is allowed to make.

---

## What this document cannot answer

- **Whether the model can grade against a UNIVERSITY rubric well enough
  to be worth its credits.** Narrowed on 23 September 2026 rather than
  closed. `read-asap.mjs` answers the weaker question — does the
  feedback point at real problems, and is it harder on a weaker essay —
  against ASAP's human rater scores, and the limits of that are in the
  quality section above. What it still cannot answer is agreement with
  a marker criterion by criterion, because a 1–6 holistic band is not
  a criterion-by-criterion mark and ASAP has no such marking in it.
  A real marked university essay remains the better evidence and is
  still worth getting.
- **Whether the no-writing constraint holds in practice.** The mechanism
  is sound; the window is not measured, and a model that evades it in
  some way nobody predicted is exactly what a first run would show.
- **Whether an academic-integrity office would accept the framing.** The
  posture rests on the same design facts the readings feature rests on —
  student-initiated, paste-only, never stored, never writes — but that
  is our reading, and the university's may differ.

---

## THE MARK COMPARISON — the other route, built into the feature (Jared, 24 September 2026)

The section above ends: *"IT DOES NOT RETIRE THE OTHER ROUTE. One real
essay a student submitted, with its criteria and its mark, remains the
stronger answer and is still worth getting."*

**This is that route, made systematic instead of anecdotal.** We have no
way to compare our feedback to a real marker, so the students are the
comparison — and the only moment the comparison is available is the one
where a mark comes back. That moment already exists in this app: it is
somebody typing a number into Grades.

**IT IS THE REASON THE FEATURE EXISTS, so it is designed in rather than
bolted on.** A feature that claims to point at what a marker cares about
and has no mechanism for finding out whether it does is a claim with no
instrument behind it. ASAP answers two questions at school level with a
holistic band (§"The limits"); this answers the third, at university
level, against criteria, with a real mark: **does a deficiency we raised
track a mark a marker gave?**

### The ask, and the three rules that keep it from becoming a nag

Rendered on the assessment row, not as a modal. Three conditions, all
required:

```
showMarkCompare(a) =
     isMarked(a)              // grades.js already decides this, and
                              // treats a mark of 0 as marked
  && !!a.essayFeedbackAt      // WE GAVE FEEDBACK ON THIS ASSESSMENT
  && !a.markCompareAsked      // once, ever
```

**IT IS A RENDER CONDITION, NEVER AN onChange HOOK**, and that decides
two things at once. A hook on the mark input fires on the keystroke
after `8` on the way to `85`, so the prompt appears under somebody's
fingers mid-typing; and a hook only covers the order *mark last*, while
a student can perfectly well be marked before the feedback is run. A
condition evaluated on the row covers both orders and cannot fire
mid-keystroke, provided it is read from the COMMITTED item rather than
from the input's live value — which it is, because the row renders from
`a.mark` and the field commits on blur like every other numeric field in
this app.

**`essayFeedbackAt` IS A TIMESTAMP, NOT A NOTE ID**, and the reason is
`sourceReadingId`'s rule pointing the other way. The feedback files
itself into the per-course folder as an ordinary note, and that note is
the student's — they may bin it. The *fact* that we gave feedback on
this assessment stays true after they do, and it is the fact the nudge
and the denominator both need. A note id would make deleting a note
silently retire the question.

**ONCE MEANS ONCE, INCLUDING AFTER A CORRECTED MARK.** A student who
fixes a typo in their mark must not be asked again. `markCompareAsked`
is set when the prompt is ANSWERED **or DISMISSED** — dismissal is an
answer to the question of whether they want to be asked — and it is one
ISO string on an existing item, so it rides the ordinary per-item merge
and needs no `COLLECTIONS` change. `assessments` is already in that
whitelist. Bump `updatedAt` on the write or the dismissal will not
propagate and the second device will ask again.

Size: two fields on assessments that have feedback, nowhere else.
`essayFeedbackAt` + `markCompareAsked` is ~70 bytes on an item that only
exists once per assessment per semester — call it 2 KB for a heavy
student who runs the feature on everything, against a 1 MB budget.

### What is stored, and what the tick decides

`assessment_feedback`, **migration 0023**, one row per occasion:

| occasion | written when | carries |
|---|---|---|
| `delivered` | a run succeeds, by the CLIENT | the deficiency codes we raised |
| `on_mark` | the student answers the prompt | rating, reasons, and — only with the tick — mark and band |

**TWO ROWS, NOT ONE, AND THE FIRST ONE IS THE DENOMINATOR.** A table
holding only the answers can say "essays we flagged for a weak thesis
averaged 62" and cannot say how many essays we flagged and never heard
about. That is the vacuous-pass shape arriving in a research
instrument: every number it prints is true and the population it is
true of is unknown. The `delivered` row costs one insert and makes the
response rate a fact.

**THE CLIENT WRITES BOTH, AND IT HAS TO BE THE CLIENT.** `ai-text`
carries a source-level invariant that no `.from(...)` may name a table
other than `profiles` and `ai_usage`, which is what lets that endpoint
skip the whole "exists but isn't yours" class. Having it write this
table would break the invariant to save a round trip. The cost is
named: a client that dies between the response and the insert records
no `delivered` row, so the denominator undercounts. That is the safe
direction — it under-reports our coverage rather than over-reporting
our accuracy — and it is the same trade as the row orphaned by a crash
in `aiNotesStore`.

**CORRECTED IN 0023: A RUN HAS ITS OWN ID.** The design above made
`(user_id, assessment_id, occasion)` unique, which refuses the SECOND
`delivered` row when a student runs feedback on a redraft of the same
assessment, so the denominator undercounts exactly the students using
the feature most, and a per-result rating would have nowhere to live.
0023 adds a third occasion, `rated` (the "Was this useful?" answer on
every result), and a client-minted `run_id`: `delivered` and `rated`
are once per RUN, `on_mark` is once per ASSESSMENT. The queries below
still hold, reading `on_mark` joined to any `delivered` row for the
same assessment.

**INSERT-ONLY, THREE POLICIES, THE `ai_notes` SHAPE.** Select, insert,
delete; no update policy and therefore no client update path to get
wrong. Once-ness is a database fact rather than a client habit:

```sql
unique (user_id, assessment_id, occasion)
```

so a double-tap is refused with 23505, which the client reads as
already-answered — the `migrateNote` pattern, and the reason that
pattern exists is that a definitive code may be acted on.

**`assessment_id` IS `text`.** It is the planner's own `uid()`, base36,
and this is the boundary 0009 cost weeks on: a client-minted id crossing
into a typed column. `uuid` here would reject every insert with 22P02,
PostgREST would answer 400, and the table would sit empty on every
account while nothing anywhere errored. The id-column guard enumerates
every id column from the database and requires each to be mapped to a
named client generator or excused in writing, so **this column fails the
suite until it is mapped** — which is the guard doing its job and is a
work item rather than a surprise.

**THE TICK IS THE ONLY THING THAT MOVES A MARK.** Unticked, the row is
written with `mark` and `band` null and the rating and reasons intact:
the student's verdict on us is not their academic record, and the two
are separable because we ask for them in one place, not because they
are the same thing. The copy says so in the plainest available form —
*nothing about the mark leaves your planner* — and the mark stays in the
blob where it already was.

**The band is `bandFor(mark)` on the assessment's own mark**, computed
with the semester's rounding rule, because that is the only band
vocabulary this app has. It is deliberately NOT the unit's final band,
which is unknown when one assessment comes back and would leak the rest
of the student's results into a row about one essay.

### The opt-in copy says why, because that is the deal

The feature's opt-in screen states the arrangement up front: **we are
checking this against real marks, and we will ask how we did when yours
comes back.** A student who learns at the prompt that we intended to ask
all along has been surprised by something we knew; a student told at the
start is being asked to take part in something.

This is also what makes the later prompt read as a question rather than
as data collection, and it is the only honest framing available given
§4's rule that the feedback is never a prediction — we are not
validating a score we gave, we are asking whether we pointed at the
right things.

### The query

Two of them, and the second is the one that answers the question.

```sql
-- Answered essays, with the codes we raised on them.
create or replace view essay_marks as
  select a.user_id, a.assessment_id, a.mark, a.band,
         a.rating, a.reasons, d.deficiency_codes
    from assessment_feedback a
    join assessment_feedback d
      on  d.user_id       = a.user_id
      and d.assessment_id = a.assessment_id
      and d.occasion      = 'delivered'
   where a.occasion = 'on_mark'
     and a.mark is not null;
```

**1. What did essays with this deficiency score?** Spread first, because
a mean over four essays is not a finding — the rule the bitrate harness
established (*let the spread decide whether extrapolation is
available*), applied to a research query rather than to a measurement.

```sql
select code,
       count(*)                                          as n,
       round(avg(mark)::numeric, 1)                      as avg_mark,
       round(stddev_samp(mark)::numeric, 1)              as sd,
       min(mark) as lo, max(mark) as hi,
       percentile_cont(0.5) within group (order by mark) as median
  from essay_marks, unnest(deficiency_codes) as code
 group by code
 order by avg_mark;
```

**2. THE CONTROL, and without it the first query says nothing.**
"Essays we flagged for a weak thesis averaged 62" is not a finding until
you know what the ones we did *not* flag averaged. This is the same
shape as the photo-prompt A/B refusing to run one arm, and as
`test-consent.mjs` requiring an accepted run beside the declined one.

```sql
select c.code,
       count(*) filter (where c.code = any(m.deficiency_codes))        as n_flagged,
       round(avg(m.mark) filter (where c.code = any(m.deficiency_codes))::numeric, 1)
                                                                      as avg_flagged,
       count(*) filter (where not (c.code = any(m.deficiency_codes)))  as n_clear,
       round(avg(m.mark) filter (where not (c.code = any(m.deficiency_codes)))::numeric, 1)
                                                                      as avg_clear,
       round((avg(m.mark) filter (where not (c.code = any(m.deficiency_codes)))
            - avg(m.mark) filter (where     c.code = any(m.deficiency_codes)))::numeric, 1)
                                                                      as gap
  from essay_marks m
 cross join (select distinct unnest(deficiency_codes) as code from essay_marks) c
 group by c.code
 order by gap desc nulls last;
```

A positive `gap` is the claim the feature makes, in the only form that
can be checked: essays we flagged for `code` scored that many marks
below the ones we did not. **Read `n_flagged` and `n_clear` before
reading `gap`** — a gap computed from three essays is a number, not
evidence.

**And the response rate, which is what the `delivered` rows are for:**

```sql
select count(*) filter (where occasion = 'delivered')                    as ran,
       count(*) filter (where occasion = 'on_mark')                      as answered,
       count(*) filter (where occasion = 'on_mark' and mark is not null) as shared_mark
  from assessment_feedback;
```

### What this changes elsewhere, and one of them is a document that is now wrong

- **§1's "What does NOT change" says "No new table, so the derived table
  sweep in `test-legal.mjs` stays green on its own."** That is FALSE from
  0023. The sweep matches `create table public.X` across the migrations
  and requires a declared phrase in BOTH published documents, so the
  privacy policy and the deletion page must say what this table holds
  before the suite is green. Corrected in place above.
- **`delete_my_account_data()` gains the table**, and the body is copied
  from **0020** — the latest migration that defines it — never from an
  older one. That exact mistake has been made once and was caught by two
  guards; the migration suite's derived sweep enumerates every table with
  a `user_id` column and asserts the function empties all of them, so a
  miss goes red naming the table.
- **The policy's overseas enumeration is untouched by this**, because
  nothing here leaves the country: the mark goes to our own database in
  our own region and never to a provider. That is the distinction §1
  draws and it holds.
- **App Privacy**: the purpose list on one row changes. See IOS-RELEASE.md
  §3a.

### It could ship in 1.2.1 at no cost, and that is worth knowing before the date is defended

The nudge cannot fire until a student has (1) had an essay read, (2)
submitted it, and (3) been marked. That is weeks after the feature
ships, on anyone's timetable. **So the mark loop in 1.3.0 buys being
there when the first mark lands, and nothing else** — no student is
worse off if it arrives a fortnight later, because no student can
answer it yet.

**RULED IN, Jared, 24 September 2026** — cut it only if Gate B
(Grace's Mac) or Gate C (App Review) squeezes the date.

It is not a reason to cut it: 0023 widens, so it wants to be applied
before the client that needs it, and doing that once is cheaper than
twice. It IS the thing to cut if the submission date comes under
pressure, and cutting it costs a two-week delay on an instrument whose
first data point is two weeks out regardless. Recorded so the decision
is available rather than rediscovered at midnight.

---

## The schedule, and the three gates (24 September 2026)

**Target: 16 October, as 1.3.0.** Written down rather than left in a
conversation, because the last fortnight lost a schedule to a document
nobody updated and a plan nobody wrote down.

**Step 1 is done** (§0), which takes the front off the plan: the only
thing between today and step 2 is Grace's sheet.

| | | gated by |
|---|---|---|
| **~26–27 Sep** | **Gate A — Grace's ASAP sheet** | if it reads badly, step 2 becomes prompt work and everything slips |
| **27 Sep → 3 Oct** | Steps 2, 3, 4. Step 2 decides whether the feature is defensible at all; step 3 is the v8 bump; step 4 carries the `package.json` bump to 1.3.0 | |
| **4 Oct → 9 Oct** | Step 5 (the panel — **Grace's**), step 6 (mark loop, 0023) | 0023 WIDENS, so it is applied before the client that reads it |
| **~10 Oct** | Deploy both functions, promote, verify | |
| **~11–12 Oct** | **Gate B — Grace's Mac session**, then device checklist items 11–15 in MOBILE-BUILD.md | her calendar |
| **~12 Oct** | Submit | |
| **+~2 days** | **Gate C — App Review** | see below |
| **14–16 Oct** | Live | |

### Gate C is planned on a RECOLLECTION, and that is said out loud

**The brief asked for 1.1.0's submitted and Ready-for-Sale dates and
the placeholders came through empty** — `[date]`, `[date]`, `[N]`. What
is planned on instead is Jared's own figure: *"each upload took roughly
2 days to get a response maybe less. Depends if there is an issue."*

That is a usable number and it is not the record. **App Store Connect →
App Store → Version History** has the two dates, and reading them costs
one click. It is worth doing only if the date comes under pressure —
the difference between "about two days" and the real figure changes
nothing at two days of slack, and changes the Mac session's date if the
real figure is four.

**The buffer is therefore ~2 days, not the ~3 first planned**, and the
plan is one day EARLIER at the front rather than one day later at the
back, because slack in front of Gate B is slack somebody can use and
slack behind Gate C is slack Apple owns.

### What the web half does NOT wait for

Promoting on ~10 Oct puts essay feedback in front of real students
**five or six days before the iOS release**, because the web deploys on
a promote and owes Apple nothing. So `delivered` rows — and therefore
the first real marks — start accumulating from the promote rather than
from the App Store release. If the date slips at Gate B or Gate C, the
instrument is still running.

### The only two things that move the date

Neither is engineering:

1. **Grace is on the path three times** — the sheet, the panel wording,
   the Mac. That is the real critical path and it is a person's
   calendar.
2. **Gate C is Apple's queue.** Two days is the estimate; an issue is
   what makes it longer, and the device checklist exists to find the
   issues before Apple does.


## THE EXAMPLE REWRITE (Jared, 18 September 2026) — built, switched off until measured

**The ruling.** Default unchanged: located comments, no replacement
wording. New, per suggestion: "show me an example rewrite", one passage
at a time, on the student's request. Limits, enforced and tested:

| rule | held by | refused |
|---|---|---|
| one sentence or one paragraph, never a section | `checkRewriteSpan`: verbatim in the essay, no paragraph break, at most `maxSpanWords`, at most `maxSpanShare` of the essay | **free**, before any spend (`span_too_long`) |
| rework their wording, add no argument, fact, example or reference | the prompt, then `checkScope` (#142) over the reply: `escapes-span`, `fabricated-fact`, `exceeds-span` | **free**, under `rewrite_refused`: only a delivered rewrite is charged (Jared, 26 September 2026) |
| side by side, nothing inserted | the panel renders both; nothing writes the example anywhere | — |
| never from the assignment prompt | the model gets the passage and the point's note only; the essay reaches our server for the check and goes no further | — |

**The AI-use record** is on each assessment (`aiUse`), bounded at 50
entries, and holds **no essay text**: when, what kind (feedback or an
example), which problem, how many words. The privacy policy says text
supplied to the AI features is "not in your planner", and copying the
rewritten sentences into the record would make that false; what a
disclosure needs is what was done, and the student has the essay. The
panel shows it as text with a Copy button.

**The price is derived, 3 credits**: the model reads at most 2,000
characters (passage, note, definition) and may write 1,500 tokens, which
is headroom for the essay model's reasoning. That ceiling is a guess,
and `measure-rewrite.mjs` prints real completion tokens.

**THE MEASUREMENT, and the switch-on** (Jared's run, 26 September 2026:
12 ASAP essays, 36 rewrites, on the essay model, at the shipped prompts
and ceilings):

| | result |
|---|---|
| passages refused by the span rules | 0 |
| cut off at 1,500 tokens | 0 (completion p50 89, max 380) |
| cost | at most $0.00052 a rewrite |
| escapes-span | 0 at every escape run >= 4 |
| exceeds-span | 4/36 at ratio 1.5, 0 at 2.5 |
| fabricated-fact | 1/36, whatever the settings |

The defaults (escape 6, ratio 1.5) refused 5/36: NOT MET. **Set: escape
run 4, length ratio 2.5**, which leaves only the fabricated one, 1/36 =
2.8%, ruled acceptable if it is a genuine invention.

**Which it was cannot be read from the kept file**, by design: it holds
numbers, and the token that fired may be the student's own word. So the
matcher was probed for the Eisenstein class instead, and two misreadings
turned up and were fixed in `essayScope.js`: a word the essay has in
lower case that the rewrite capitalises ("internet" -> "Internet"), and a
number the essay spells out that the rewrite writes as digits ("three" ->
"3"). **The fix only widens what counts as the student's own, so the
recount can only fall** from 1/36; the case the ruling does not cover is
a third misreading nobody has found. The harness now records which KIND
fired (figure, name, citation), never the token, so the next run says.

**A refusal is not charged** (Jared, 26 September 2026): the check is
ours, so its refusals are ours to absorb, at about $0.0005 each. A
rewrite that will not parse is free too. Only a delivered rewrite costs
the student its 3 credits.

**Two flags, both on:** `ESSAY_REWRITE` in `ai-text/config.ts` (the
server's limits) and `ESSAY_REWRITE_ENABLED` in `src/essayFeedback.js`
(the button). The server went first, in the same change.

**The claims changed in the same release** (LEGAL-REVIEW.md §5): Terms
§2, the privacy policy's AI section and OpenAI row, the opt-in, and the
reviewer note. The wording guard still bans any offer to write the
essay; each mention of the scoped example is declared by phrase in
`test-no-writing.mjs`, and a test asserts its copy says nothing is put
into the essay and that the unit's rules apply.

**No consent bump**: the rewrite sends part of an essay draft to the
same company as essay feedback, so `ai-text:rewrite` maps to the
existing `essay-draft` type and v8 covers it. v8 has not reached a
student yet (the web promote is held for the panel), so the wording
could still change without re-asking anyone.
