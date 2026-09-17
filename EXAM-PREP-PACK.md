# Exam prep pack — discovery, for 1.2

**Status: DISCOVERY AND PLAN ONLY.** No code, no endpoint, no screens.
Nothing here merges to `main` until 1.1.0 is approved and the closed
test is running.

The feature as scoped: for one exam the student has already entered, the
app assembles what it already holds for that course — the study cards,
the weak spots, the AI lecture notes — and produces **one revision pack
they can read the night before**, filed as a note in the course's
folder.

Every figure below was computed by bundling the project's own constants
out of `_shared/credits.ts` and `ai-text/config.ts`, the way
`scripts/test-ai-text-function.mjs` does it. None of them is retyped and
none is estimated.

---

## 0. THE FINDING THAT DECIDES THE DESIGN, AND IT IS A PRICE

The obvious build is an orchestration: summarise each topic, generate
some practice questions, fold in the weak spots. Three or four existing
tasks, no new endpoint, no new prompt, no new weight. It is the cheap
thing to build and it is **the expensive thing to run.**

Derived, not estimated:

| assembled from existing tasks | credits | of the 60-credit trial | of Study AI's 900 |
|---|---|---|---|
| 1 `summarise` + 1 `practice` | 5 | 8% | 0.6% |
| + 1 `weakspots` | 6 | 10% | 0.7% |
| 3 topics + practice + weak spots | **12** | **20%** | 1.3% |
| 6 topics + 2 practice + weak spots | **23** | **38%** | 2.6% |

A six-topic course is an ordinary course. **38% of a trial for one
exam** is not a demonstration, it is the trial gone — and a student with
two exams in the same week has nothing left for the lectures, which is
the other half of what the trial exists to demonstrate.

**One call is cheaper than three, and the reason is the input ceiling.**
Every task's weight is `MAX_INPUT_CHARS / CHARS_PER_TOKEN` at the input
rate plus `MAX_TOKENS` at the output rate. Assembling from four tasks
pays four input ceilings for material that is mostly the same cards
read four times.

| a single `pack` task | credits |
|---|---|
| 8,000 chars in, 2,000 tokens out | 2 |
| 12,000 chars in, 2,000 tokens out | 2 |
| 20,000 chars in, 2,000 tokens out | 3 |
| 20,000 chars in, 3,000 tokens out | 4 |
| 20,000 chars in, 4,000 tokens out | 5 |

**Recommendation: one new `pack` task, one provider call.** Three
credits for a whole exam's pack against twelve for the same thing
assembled, and the input can be generous because input is barely the
price.

### AND THE OUTPUT CEILING IS THE PRICE, WHICH IS THE PART TO CARRY

Read the two tables again. Tripling the input — 8,000 to 20,000
characters — moves the weight by **one credit**. Doubling the output
ceiling moves it by **three**. Output is four times the price of input
per token and the ceiling is what we are charged for at worst.

That is the same error in a new costume as the file-upload finding in
PRODUCT-PLANS.md: extracted text is 41x cheaper than a photograph on
*input tokens* and only ~10x cheaper in *credits*, because the output
ceiling is identical either way. **Assuming input dominates is how the
photo model looked five times better than it was.**

So: **the ceiling decision IS the pricing decision**, and it is the one
thing here that must be measured rather than chosen. §4.

---

## 1. Where the material comes from, and the invariant it must not break

`ai-text` **reads no user content from the database.** The client sends
the text; the server touches `profiles` and `ai_usage` and nothing else,
only ever the caller's own row. Two source-level invariants hold it: no
`.from(...)` may name another table, and `ai-text` has no storage client
at all.

That is not a detail. It is why `ai-text` never had to answer "exists
but isn't yours" — the whole class of bug `ai-notes` shipped is *absent*
there rather than handled. The re-summarise retry is what it costs to
give that up: scoped service-role queries by hand, byte-identical
rejection for malformed and not-yours, told apart in the logs and never
in the response.

**A pack must therefore be assembled CLIENT-SIDE and sent as text.**

| material | where it lives | how the client gets it |
|---|---|---|
| study cards (term + content) | the blob | already in memory |
| weak spots | derived | `weakSpots()` in `srs.js` |
| the exam's topics | derived | the existing plan's topics ARE the cards' terms |
| AI lecture notes | `ai_notes` rows | `fetchNote`, under RLS with the student's own JWT |

The client reading its own rows under RLS is not the same thing as the
server reading them under a service-role key, and the difference is the
entire ownership question. **Do not move this to the server.** A pack
endpoint that reads `ai_notes` inherits every obligation in
COST-MODEL.md's retry section, for a feature that does not need them.

### THE FAILED FETCH IS THE TRAP, AND IT COSTS MONEY

`fetchNote` has three outcomes on purpose: `{content}`, `{missing:true}`
and `{failed:true}`. A pack built from six lectures where one fetch
**failed** is a pack silently missing a lecture — and the student has
paid for it, in full, and has no way to know.

So a failed fetch must be **disclosed before the call**, never dropped:
either "one of your notes could not be loaded — try again, or continue
without it" with the count, or a refusal. Not silence. `{missing:true}`
is different and is fine to skip: the note is definitively gone, and
saying so is a true statement about a note that no longer exists.

This is the `fetchNote` rule arriving at a screen rather than at a
tombstone, and it is the failure this feature is most likely to ship
with, because a dropped note looks exactly like a course with fewer
lectures.

---

## 2. Consent: no bump, and it is checkable rather than argued

Two triggers, both already satisfied:

**`providerFingerprint()`** is over the provider `id`, `name` and
`country`. A pack goes to OpenAI, which is already named. Unchanged, so
no re-prompt — and that is correct, not a gap: the companies receiving
material have not changed.

**`AI_CONSENT_VERSION`** is the trigger for a change in what happens to
the CONTENT, and nothing changes. The material is the student's own
study cards and their own AI notes, relayed and not stored — and
`CONSENT_MATERIAL_LEDGER`'s v7 entry already reads:

```
own-notes-and-cards:relayed-not-stored
```

So the material set does not move, `materialFingerprint()` does not
move, and `scripts/test-legal.mjs`'s append-only ratchet has nothing to
ratchet. **Confirmed from the ledger rather than reasoned about**, which
is the only kind of confirmation that file accepts.

**It is still gated**, through `AiActionFrame`, which every text feature
renders its controls through — so consent and the allowance arrive
together and a sixth feature inherits both. There is no route to a
provider in that file that does not pass the branch.

### What WOULD bump it

If a pack ever took the lecture **transcripts** rather than the notes
derived from them, that is a different promise: a transcript is ours for
7 or 30 days and a note is the student's until they delete it, and the
documents make different promises about the two tables. Reading one to
build the other is a change in what happens to content. Not proposed.

---

## 3. What it must never do

Three rules, and each one needs a guard rather than a comment, because a
rule written beside one caller is not a guard.

**NEVER A PREDICTION.** Not "you would get a Credit", not "you are on
track for a Distinction", not a percentage of readiness. The app has no
information about the exam and never will: it has the student's own
cards, which are a record of what they chose to write down. A confident
number built on that is a lie with arithmetic attached. This is the
essay-feedback framing rule (`ESSAY-FEEDBACK.md` §4) with a harder case,
because an exam has a mark at the end of it and a student will remember
what they were told.

**NEVER "WHAT WILL BE ON THE EXAM".** The pack revises what the student
has; it does not forecast a paper nobody here has seen. Copy offering to
tell somebody what is coming up is both false and the kind of claim that
produces a support conversation the week after results. A blunt grep,
the `test-readings.mjs` shape, comments stripped first — and it will
catch its own documentation on the first run, as that one did.

**NEVER A SUBSTITUTE.** "Revise from your notes", not "skip the
lectures". Same wording rule as the readings feature and the same legal
reason: the private-study framing is what the whole thing rests on.

---

## 4. HOW THE CREDIT COST GETS MEASURED

This is the part worth being explicit about, because the last two
features got it wrong in opposite directions.

### 4a. The weight is DERIVED, never chosen

`TASK_CREDITS` is `creditsFor(usdForTask(task))` over `MAX_INPUT_CHARS`
and `MAX_TOKENS`. Adding a `pack` entry to `TASKS` re-prices it
automatically, and two existing tests hold it: one asserts **no literal
weight exists** in the config, the other re-runs `usdForTask` and
compares. Both sweep `TASKS`, so a new task inherits them.

That is what `TYPICAL_SUMMARY_OUTPUT_TOKENS` cost: a constant nobody had
measured was quietly setting the price of the product, modelled at 2,800
and measured at **475 — the guess was 5.9x reality**, and two proposed
user-visible increases evaporated when it was re-derived.

### 4b. The CEILING is measured before it is set, and the spread decides

`MAX_TOKENS.pack` is the only free parameter and it is the whole price.
So:

1. **Write the prompt first, measure second.** The `ai-notes` depth work
   found +189% words per key point from prompt instructions with the
   ceiling untouched; raising a ceiling without fixing the prompt buys
   permission to be verbose and we pay for the tokens.
2. **Run `measure-summary-depth.mjs`'s shape** against a real course's
   cards, and read the **observed output token count** off the
   provider's own response rather than counting words.
3. **Take enough samples to see the spread.** One is an anecdote. Four
   agreeing within 1% is what licensed extrapolating a three-second
   recording to three hours; four spread across 40% would have said "it
   depends what you record", which is a different finding needing a
   different experiment. **Let the spread decide whether extrapolation
   is available.**
4. **Vary the size of the course**, not just the content: a three-topic
   course and a twelve-topic course are the two ends, and the ceiling has
   to cover the second without pricing the first out.
5. **Set the ceiling from the observed maximum plus headroom**, and
   record the measurement beside the constant. A hit ceiling is a hard
   failure that is still billed — truncated structured JSON is worse than
   a refusal — so headroom is not generosity, it is the difference
   between a refund and a pack.

### 4c. The end-to-end cost is a test, not a paragraph

`test-readings.mjs` already asserts **every tier pays for itself at 100%
usage**, derived from `model.ts`, `credits.ts`, `config.ts` and
`site/pricing.js`, at a **stressed FX of 0.50** so it reddens when the
product economics break and not when the currency moves. A pack is
another task in that sweep and needs no new machinery.

What DOES need a new assertion is the trial, because that is the number
this feature can break:

```
one pack must cost <= 5 credits, so a trial account can produce
at least one pack AND still record a lecture
```

At the recommended shape that is 3, with room. At the four-task
assembly it was 12 to 23, and the test would have refused it.

### 4d. A prompt change is a configuration change, so it needs the pair

If the pack's prompt is ever edited, `measure-photo-prompt.mjs`'s
arrangement applies: run the **pair** — same model, same input, one arm
under the working tree's prompt and one under the prompt at a git ref,
extracted rather than retyped — and print entries and words per section
beside any defect counts. One run of a new prompt proves nothing, and
noise falling because the model said *less* is a depth regression rather
than a fix.

And **re-measure the ceiling in the same commit**, because the prompt is
part of the input bill: `MEASURED_PHOTO_BATCH_INPUT_TOKENS` holds only
between 4,005 and 4,918 input tokens, and the next edit to that prompt
can re-price the feature.

---

## 5. Where it lives

**On the exam row, in the Exams section, as a panel that opens inline.**
The same shape as `RubricPanel` on an assignment and `SummariseReading`
on a reading row — deliberately, because this app has one way of
attaching a do-something panel to a row and a second one would be a
second thing to learn.

The student is looking at "PHYS1001, 14 days" when the thought occurs,
which is where the action belongs.

**It does not touch the exam PLAN.** The plan is a schedule — which
topic on which day, with its deliberate no-review-day case at two days
and five topics. The pack is content. Folding one into the other would
mean a student cannot get either without the other, and the plan works
today with no AI and no account.

**The result is a note**, filed into the course's folder exactly as a
recording is, inside its own `try` for the same reason: a folder is a
convenience and must never take down work just paid for.

**The blob cost has to be measured before this ships.** A pack is one
note; six packs a semester at a few KB each is nothing against the 1 MB
budget, and "is nothing" is a claim, so the arithmetic belongs in
`test-reference.mjs` beside the other caps — and the sum of the caps
still has to fit.

---

## 6. The order of work, and what gates what

1. **The wording guards first** (§3), before any feature work. They are
   three greps and they are what stops the copy drifting while the
   feature is being built — and the substitution grep caught its own
   documentation on the readings feature, which is cheaper to discover
   now than after Grace has written the screens.
2. **The client-side assembly**, as a pure module with tests: which
   cards, which notes, how the weak spots are folded in, and what
   happens when a `fetchNote` fails. No provider call, no screens. This
   is where the §1 trap lives and it is testable without a network.
3. **The prompt**, written for depth, with the schema.
4. **Measure the ceiling** (§4b). Nothing downstream can be priced
   before this and the weight must not be typed in the meantime — a
   placeholder weight in `TASK_CREDITS` is the `UNMEASURED` marker
   situation without the marker.
5. **The endpoint**, as another `TASKS` entry. The allowance read
   precedes the provider call, which is what makes a missing column fail
   free; a failed call bills nothing and unparseable output IS billed,
   under its own code, because those tokens were generated and charged.
6. **The screen**, through `AiActionFrame`, with the pre-flight estimate.
   The cost is FIXED at one call, so this is the ordinary `canAfford`
   rather than `sectionsAffordable` — which is a simplification the
   one-call design buys and the assembly design would not have.
7. **The tier-economics assertion** (§4c) and the blob arithmetic (§5)
   in the same commit as the weight.

---

## What this document cannot answer

**Whether the pack is any good.** Nothing here is a judgement about
whether a revision pack built from a student's own cards is worth
reading — that needs a real course, a real exam and a student who sat
it, which is Grace's and Jared's call and cannot be settled by
arithmetic. Everything above is about what it would cost, what it must
not claim, and which invariants it must not break.

**Whether one call is enough for a twelve-topic course.** §0 prices a
single call and §4b measures the ceiling, and it is possible the answer
comes back "a big course needs two passes". That would make the cost
variable, which brings back the pre-flight estimate in credits and
`sectionsAffordable`. It is a measurement, not a guess to resolve now.

**What the model actually does with a pile of study cards.** The cards
are the student's own shorthand, often three words long. A prompt
written for lecture transcripts has a source that explains itself; this
one does not, and whether the model produces revision or padding from
terse input is the first thing step 3 will find out.
