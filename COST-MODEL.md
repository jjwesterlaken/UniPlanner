# What the AI features cost us

A measurement and planning document, 20 August 2026. It exists to unblock the
website pricing copy: nothing here is a feature, and only the two changes in
section 10 were on the table.

**Reviewed and corrected, 20 August 2026.** Jared checked the two figures this
document could not reach from inside the build container. Both corrections are
folded in below and marked where they land:

- **The image tokenisation is confirmed exact.** OpenAI's vision guide lists
  `gpt-4o-mini` at 2,833 base / 5,667 per tile against `gpt-4o` at 85/170. Section
  11's photo reading is now confirmation rather than a gate — nothing waits on it.
- **The tiler scales the shortest side to 768px in BOTH directions**, so the
  possible 31% saving from a smaller `maxEdge` does not exist. The caveat is
  closed.
- **The deprecation premise in the brief was wrong**, and section 7 is withdrawn
  to a short correction. `gpt-4o-mini` appears nowhere on the deprecations page.
- **A live lever this document could not see** — patch-based image tokenisation on
  the newer mini and nano models — plausibly inverts finding 1. Pricing it is its
  own piece of work; see the note under finding 1.

**One flag, unresolved.** The brief said to run this *after the exposure sweep*.
No exposure sweep has been commissioned in this session or appears in the
repository. This document does not depend on one — it is self-contained — but if
a sweep was meant to precede it, its findings have not been folded in.

**Every number came from the source code plus published rates plus arithmetic.**
This container cannot reach Supabase, OpenAI or Groq, so nothing below is a
measurement of a bill. It is a model. Section 11 is the procedure for checking it
against two real dashboard readings, with the predictions stated in advance so the
check can fail.

The arithmetic is not typed into this document. It is printed by
`scripts/measure-cost-model.mjs`, which pulls the real prompt strings out of the
Edge Function sources and counts them with a real tokenizer:

```
npm i --no-save gpt-tokenizer
node scripts/measure-cost-model.mjs
```

That script adds no dependency to `package.json` and is not part of `npm test`. A
document full of dollar figures typed by hand is the restatement pattern wearing
its most expensive costume — these are the numbers that set a price.

---

## The three things that would change a decision

**1. A photographed reading is the most expensive action in the app, and the code
believes the opposite.** A 16-page reading photographed costs **$0.095**, which is
**2.2× an entire hour of recorded, transcribed, summarised and translated
lecture** ($0.044). It bills 13 of 150 text units — 8.7% of a month — where the
lecture bills 60 of 300 minutes, 20%. The comment in `ai-text/config.ts` that
justifies pricing a photo batch the same as a text chunk uses gpt-4o's image
tokenisation (85 base + 170/tile). gpt-4o-**mini** bills images at **2,833 base +
5,667/tile** — 33× higher — because its text tokens are so cheap that OpenAI
charges images at a token multiple. The conclusion in that comment ("a full batch
of photos costs slightly LESS input than a full text chunk") is inverted: it costs
**12× more**.

**CONFIRMED at the source, 20 August 2026** — this was the one figure I could not
reach from the build container, and it is exact.

**And there is a lever that plausibly inverts it.** The newer mini and nano models
do not tile at all: they cover the image in 32×32 patches, cap it at a patch budget
(1,536 on the mini tier), and apply a per-model multiplier. Our page comes out at
about **2,385 tokens instead of 36,835 — fifteen times fewer**. Even at three times
the per-token price, photos land roughly five times cheaper than today, which would
make them cheaper than lectures rather than 2.2× dearer. So **do not re-weight the
photo batch against the current model**: pricing the candidates and setting the
weight is one decision, taken together, and it is the next piece of work rather
than part of this document. The `detail` setting points the same way — the docs
recommend `original` for OCR and small text and warn that `low` and `high` may
resize and obscure fine detail, so today's `high` is not the OCR-optimal choice on
a modern model either.

**2. Both of the changes I was permitted to make are already done, and one of them
would have been a downgrade.** The Groq model is already
`whisper-large-v3-turbo` (`ai-notes/groq.js:69`), not full Large v3.
`MONTHLY_MINUTES_LIMIT` is already **300**, not the 30 the brief assumed — so
"raise it to 200" would have cut the closed test's allowance by a third. I changed
nothing. Details in section 10.

**3. The most expensive legal way to spend the allowance is not recording at all —
it is the re-summarise retry, and it has no "did it actually fail?" check.**
`ai-notes/index.ts` step 4b requires only that the request row exists, belongs to
the caller, and still holds a transcript. It does not require the summary to have
failed. So a successful three-hour lecture can be re-summarised repeatedly for the
whole 7-day retention window, at a flat 2 billed minutes each against a real cost
of $0.0072 — **$0.0036 per billed minute, five times the $0.0007 that every actual
recording costs.** At a 3,000-minute cap that is $10.21 of provider spend from one
recording. See section 5.

---

## 1. What we are actually calling

Read out of the sources, not from memory.

| Step | Provider | Exact model string | Where |
|---|---|---|---|
| Transcription | Groq | `whisper-large-v3-turbo` | `ai-notes/groq.js:69` |
| Lecture summary + translation | OpenAI | `gpt-4o-mini` | `ai-notes/openai.ts:97` |
| All five text tasks | OpenAI | `gpt-4o-mini` | `ai-text/openai.ts:27` |
| Reading summary from photos | OpenAI | `gpt-4o-mini` (vision) | same call, `detail: "high"` |

**Turbo, already.** No swap to recommend. `TRANSCRIPTION_PROVIDER` is `"groq"`, and
`selectTranscriber` falls back to it if the `AI_NOTES_TRANSCRIPTION_PROVIDER`
secret names something unknown — so a typo in that secret cannot silently move us
onto Deepgram at $0.26/hour. A Deepgram adapter exists and is unused by default.

**Other paid calls in the request path: none.** Supabase Storage does a put, a
`list`, a `createSignedUrl` and a `remove` per recording, and Postgres does a
handful of row reads and writes; all of that is platform cost on a plan, not
per-call metered spend. Neither function calls anything else.

**The model string appears in two production places and one script.** That is a
restatement-ledger problem — the twelfth. Both Edge Functions are Deno and live in
the same repository, and `ai-notes/_shared/` already exists, so this one is not the
unavoidable browser/Deno mirror. Recommendation in section 7.

---

## 2. Audio chunking and the 10-second minimum

**There is no chunking. The 10-second minimum never bites.** Worth confirming
rather than assuming, and it is the cheapest possible shape:

- `uploadAudio` (`src/aiNotesClient.js:93`) puts the entire recording into Storage
  as one object, in one call.
- The Edge Function never downloads it. Step 8 signs a 10-minute URL
  (`SIGNED_URL_TTL_SECONDS`) and step 9 hands **the URL** to Groq, so the function
  never allocates the audio in memory at all.
- **One Groq request per recording, whatever its length.** A 60-minute recording is
  one request billed at 60 minutes of audio. Billed duration equals real duration.
- No silence trimming, no VAD, no client-side segmentation anywhere.

**The 25 MB limit does not apply to us.** Groq documents 25 MB (free) / 100 MB
(dev) for the `file` upload parameter; this app always uses `url`, which Groq's own
docs point at as the way to handle larger files and for which no ceiling is
published. `groq.js` says in as many words that whether the `url` path has its own
unstated ceiling is **not confirmed**.

**What actually guards the boundary**, and both refuse before any provider call is
made, so an oversized recording costs nothing:

| Guard | Value | What it is really for |
|---|---|---|
| `MAX_BODY_BYTES` | 46,000,000 | Supabase Storage's 50 MB free-tier per-file ceiling. At the client's 32 kbps, 3 h ≈ 43.2 MB. |
| `MAX_REQUEST_SECONDS` | 10,800 (3 h) | The duration ceiling proper. |

**The open risk, and it is not a cost risk:** no recording longer than a few minutes
has ever been through this path. If Groq's `url` endpoint does have an unstated
ceiling, a two-hour lecture fails *after* the upload — and `isSizeError` turns that
into `transcription_too_long`, which bills nothing and suppresses the retry
button. So the failure is handled; it just has never been observed. Testing one
long recording is already on the `MOBILE-BUILD.md` list and stays there.

---

## 3. Token counts per AI action

**Tokenizer: `gpt-tokenizer`, `o200k_base` encoding via its `gpt-4o-mini` model
export.** Run against the real prompt strings, extracted from the sources by the
measurement script rather than pasted into it.

### Fixed prompt overhead, billed on every single call

| Prompt | Tokens |
|---|---|
| `ai-notes` system, no translation | 335 |
| `ai-notes` system, with translation | 352 |
| `ai-notes` `json_schema`, serialised | 283 |
| `ai-text` explain | 132 |
| `ai-text` weakspots | 134 |
| `ai-text` practice | 131 |
| `ai-text` summarise (text) | 134 |
| `ai-text` summarise (photos) | 184 |
| `ai-text` merge | 156 |

**No prompt here is a prompt-caching candidate, and none can be made into one
cheaply.** OpenAI's automatic caching requires a matching prefix of at least
**1,024 tokens**; our longest prompt is 352. The cached-input rate of $0.075/1M is
unreachable. Padding a prompt to 1,024 tokens to qualify would add ~670 billed
input tokens to every call to save 50% on the first 1,024 — that is a loss at any
volume. *(The 1,024-token floor is a published figure I am recalling, not one I
could fetch; it is worth confirming, but it would have to be below ~350 to change
the answer.)*

### The assumptions this section rests on

| Assumption | Value | Confidence |
|---|---|---|
| Lecture speech rate | 140 words/minute | Middle of the usual 120–160 range. A ±20 swing moves summariser **input** by ±14%, which is ~25% of the summary cost, which is ~6% of a lecture's total. Cannot change any decision. |
| Tokens per spoken word | 1.33 | Assumption. Measured English prose in this repo runs 1.45 tokens/word, but that is dense technical Markdown with tables and code; spoken lecture English is simpler. This is a **guess bounded above by a measurement.** |
| Chars per token | 4.2 | **Measured**, on two real corpora — the app's own help copy is 4.61 chars/token and CLAUDE.md is 4.20 — with the **conservative (densest) end** taken, because fewest chars per token means the highest bill. Frozen as a constant so re-runs are reproducible; the script warns if a re-measurement drifts more than 5%. Academic prose, which is what a reading really is, sits between the two. |
| Summariser output length | modelled | Calibrated against the single real measurement on record (4,772-char sample → 1,203 output tokens with a translation). Output is not proportional to input: the schema is fixed and the depth rules saturate at 20 key points / 15 terms. **This is the softest number in the document.** |

### Per invocation

Text inputs are priced at their `MAX_INPUT_CHARS` ceiling and outputs at their
`MAX_TOKENS` ceiling, so these are upper bounds for the text features.

| Action | Input tokens | Output tokens | USD |
|---|---|---|---|
| Lecture summary, 60 min, no translation | 11,790 | 1,646 | $0.00276 |
| Lecture summary, 60 min, translated | 11,807 | 3,292 | $0.00375 |
| Reading summary, pasted text (20,000 chars) | 4,896 | 2,000 | $0.00193 |
| **Reading summary, 4 photos** | **147,544** | 2,000 | **$0.0233** |
| Practice questions (30 cards) | 2,036 | 1,500 | $0.00121 |
| Explain-it-back | 1,084 | 600 | $0.00052 |
| Weak spots | 1,563 | 800 | $0.00071 |
| Summarise-a-note | 4,896 | 2,000 | $0.00193 |
| Merge (4 sections) | 1,585 | 2,000 | $0.00144 |

**`SUMMARY_MAX_TOKENS` is not binding.** The longest case this model produces — a
180-minute lecture with a translation — is 3,378 output tokens against a ceiling of
8,000. That agrees with the existing rule in `config.ts` that the ceiling moves
only on a measured long lecture, and says the measurement is unlikely to ask for it.

---

## 4. The photo path, in detail

### What is actually sent

- **Resized client-side.** `downscalePhoto` (`src/aiText.jsx:143`) draws to a
  canvas at `maxEdge = 1536` and calls `toDataURL("image/jpeg", 0.8)`. So a
  portrait A4 page leaves the device at roughly **1086 × 1536**.
- **`detail: "high"`, explicitly**, set in `prompts.js` where the image parts are
  built. The comment is right that low detail on a page of print is a page of grey
  — but "high" is what makes the tiling arithmetic below apply.
- Server-side cap `MAX_IMAGE_BASE64_CHARS` = 700,000 chars, `PHOTOS_PER_CHUNK` = 4,
  `MAX_READING_PHOTOS` = 16.

### The tokenisation rule, and the arithmetic

OpenAI's documented rule for the gpt-4o family at `detail: "high"`:

1. Scale to fit inside 2048 × 2048. *(1086 × 1536 already fits — no change.)*
2. Scale so the **shortest** side is 768px. *(1086 → 768, so the factor is 0.707;
   1536 → 1086.)*
3. Cover the result with 512 × 512 tiles: `ceil(768/512) = 2` by
   `ceil(1086/512) = 3` = **6 tiles**.
4. `tokens = base + tiles × tile_tokens`.

The base and tile figures are **per model**, and this is where the code is wrong:

| Model | base | per tile | 6-tile page | Cost of that page |
|---|---|---|---|---|
| gpt-4o | 85 | 170 | 1,105 tokens | $0.00276 (at $2.50/1M) |
| **gpt-4o-mini (what we call)** | **2,833** | **5,667** | **36,835 tokens** | **$0.00553** (at $0.15/1M) |
| what `ai-text/config.ts` assumes | 85 | 170 | 1,105 tokens | $0.00017 |

An image on gpt-4o-mini costs **twice** what the same image costs on gpt-4o. That
is a real and well-documented quirk: the mini model's text tokens are ~17× cheaper,
so OpenAI charges images at a token multiple that lands above the big model's
price. The config comment's error is 33×.

**CONFIRMED AT THE SOURCE, 20 August 2026.** This was written as the number I was
least able to stand behind — OpenAI's own pages are blocked by this container's
egress proxy, and the figures came from three independent write-ups rather than
from the guide itself. Jared checked the vision guide: 2,833 / 5,667 for
`gpt-4o-mini`, 85 / 170 for `gpt-4o`, exact. Section 11's photo reading is now a
confirmation rather than a gate.

### What the whole feature costs

| | Input tokens | USD | Units billed |
|---|---|---|---|
| One page | 36,835 | $0.00553 | — |
| One batch of 4 pages | 147,544 | $0.0233 | 3 |
| One 20,000-char text chunk | 4,896 | $0.00193 | 3 |
| **A 16-page reading** (4 batches + merge) | 591,761 | **$0.0948** | 13 |

**The comparison the brief asked for:** one hour of lecture — recorded,
transcribed, summarised and translated — costs **$0.0437**. A 16-page photographed
reading costs **$0.0948**, which is **2.2×** it. A single batch of four photos
($0.0233) costs more than half an hour of lecture, and bills 3 units.

### The levers, and the one that looks obvious is not one

**Sending smaller photos saves nothing. This is settled, not suspected.** It is
worth spelling out because "downscale harder" is the first thing anyone will reach
for. Step 2 of the tiling rule scales the image *so that the shortest side is
768px* — up as well as down — so a portrait A4 page arrives at the tiler as
768 × 1086 whatever it was sent at, which is always 2 × 3 = **6 tiles**. Dropping
`maxEdge` from 1536 to 1024, or to 768, changes the picture quality and not the
bill. The measurement script prints the tile count at each size, in both
directions, so the claim is visible rather than asserted.

That leaves two levers, and **they are one decision rather than two**:

- **The model.** The patch-based tokenisation on the newer mini and nano models
  takes our page from ~36,835 tokens to ~2,385. That is the lever, and it is large
  enough that everything else is rounding.
- **The weight.** Against *today's* model a photo batch costs $0.0078 per billed
  unit where everything else costs $0.0005–$0.0014, so 3 is off by roughly 10×.
  **Do not act on that number alone.** Re-weighting to 12 and then moving models
  would tell students a batch costs 12 when it costs 1, which is a worse error
  than the one being fixed — it is visible, and it is ours.

Listed so nobody rediscovers it as an option: **`detail: "low"`** is a flat 2,833
tokens per image, 13× cheaper, and a 512 × 512 thumbnail. For a page of print that
is a page of grey, exactly as the comment in `prompts.js` says. The interesting
`detail` question is the opposite one — `original`, which the docs recommend for
OCR and small text — and it belongs with the model pricing.

Both levers are priced together in the follow-up work, and the recommendation is
one decision: **model and weight, named at the same time.**

---

## 5. How minutes are currently metered

### Everything that decrements, and by how much

**THE TABLE BELOW IS THE CURRENT ONE.** The two-counter version it replaces is
kept underneath, because the paragraphs after it were written against that shape
and read oddly without it. One counter now — `ai_usage.credits_used`, and
`profiles.trial_credits_used` for the lifetime trial — and every text weight is
DERIVED by `TASK_CREDITS` from that task's own input and output ceilings rather
than chosen.

| Action | Counter | Credits | Where the write happens |
|---|---|---|---|
| Recording a lecture | `credits_used` | `max(provider-reported minutes, MINIMUM_BILLED_CREDITS = 3)` | `ai-notes/index.ts` step 12 |
| Re-summarising a FAILED one | `credits_used` | `RESUMMARISE_BILLED_CREDITS` = 2, derived | `ai-notes/index.ts`, resummarise branch |
| Explain-it-back | `credits_used` | 1 | `ai-text/index.ts` |
| Weak spots | `credits_used` | 1 | same |
| Practice questions | `credits_used` | 2 | same |
| Summarise a note / a text chunk / **a photo batch** | `credits_used` | 3 | same |
| Merge | `credits_used` | **2** | same |

`merge` moved from 1 to 2 under the derivation: it had been weighted down for its
smaller input, which was true and stopped deciding anything once the weights came
off the ceilings — output is four times the price of input and merge's output
ceiling equals summarise's.

<details>
<summary>The two-counter table this replaces (pre-migration-0013)</summary>

| Action | Counter | Amount | Where the write happens |
|---|---|---|---|
| Recording a lecture | `ai_usage.minutes_used` | `max(provider-reported duration, 3)` | `ai-notes/index.ts` step 12 |
| Re-summarising one | `ai_usage.minutes_used` | flat **2** | `ai-notes/index.ts`, resummarise branch |
| Explain-it-back | `ai_usage.text_units_used` | 1 | `ai-text/index.ts:262` |
| Weak spots | `ai_usage.text_units_used` | 1 | same |
| Practice questions | `ai_usage.text_units_used` | 2 | same |
| Summarise a note / a text chunk / **a photo batch** | `ai_usage.text_units_used` | 3 | same |
| Merge | `ai_usage.text_units_used` | 1 | same |

</details>

**Nothing that calls a provider decrements nothing.** The brief's suspicion that
the four text features are unmetered is not the case. *(Written when they metered
against a second counter — "minutes answer how much lecture, units answer how much
text". That split is gone: it is what hid the photo mispricing, because "3 units"
and "50 minutes" cannot be put beside each other by any screen or any test. One
currency makes the comparison unavoidable rather than impossible, which is how
section 13 exists at all.)*

**Both decrements happen server-side, in the Edge Function, on the service-role
client.** Neither is client-side and **a modified client cannot bypass either.**
Specifically: the client's `estimatedDurationSeconds` is used only for the
pre-flight guard; the billed figure comes from `result.durationSeconds`, reported
by Groq. That was deliberate — the comment at step 9 records that this used to fall
back to the client's number, so a crafted request could bill itself zero.

### Three holes, in descending order of what they cost

> **STATUS, RE-CHECKED AGAINST THE CODE ON 15 SEPTEMBER 2026 — read this
> before acting on anything below it.** Two of the three are CLOSED and this
> section still described them as open, which is how somebody comes to re-do
> work or re-panic about a bill. The table that opens section 5 is stale in a
> third way: it names `ai_usage.minutes_used` and `ai_usage.text_units_used`,
> and migration **0013 dropped both columns** when the two currencies collapsed
> into one. There is one counter now, `credits_used`, and one weight table,
> `TASK_CREDITS`.
>
> | | status | where |
> |---|---|---|
> | **(a)** re-summarise has no failure precondition | **FIXED** | `ai-notes/index.ts`, the `resummarise` branch |
> | **(b)** the allowance increment is not atomic | **FIXED** (the lost update; a smaller race is kept on purpose) | migration 0011, then 0012's `add_ai_credits` |
> | **(c)** the cap can be overshot by one recording | **OPEN, deliberately** | unchanged |
>
> Each is written up under its own heading below, with what actually changed.

**(a) The re-summarise retry has no failure precondition — FIXED.** It used to
check that the row exists, belongs to the caller, and holds a transcript, and
never asked whether the summary had failed, so a SUCCESSFUL lecture could be
re-summarised for the whole retention window. That is closed:

- `existing.summary_failed !== true` returns **`already_summarised`** (409) and
  bills nothing.
- It is checked **BEFORE** the transcript, deliberately — a successful note has
  nothing to retry whether or not the sweep has taken its transcript, and
  answering "expired" there is a true sentence about the wrong question.
- The success path writes `summary_failed = false`, so it is **one retry per
  failure** rather than an open door. That property falls out free.
- A distinct code does not breach the identical-rejection rule: that rule is
  about not-found versus not-yours, and this branch is only reachable once
  ownership is proven.

**Verified by mutation, not by reading.** Replacing the precondition with a
branch that never fires reddens three tests in
`scripts/test-ai-notes-function.mjs` by name — *"a lecture whose summary
SUCCEEDED cannot be re-summarised"*, *"the precondition is checked BEFORE the
transcript"*, and *"one retry per failure: a successful retry closes the door
behind it"* — the last of which reports the real symptom, `creditsBilled: 2` on
a successful lecture.

**The fix was the precondition and not the price**, which is what the original
entry recommended: `RESUMMARISE_BILLED_CREDITS` is derived correctly for a
*typical short* summary, and what was wrong was that the action could be taken
when there was nothing to retry.

<details>
<summary>The original entry, kept because its arithmetic is what justified the fix</summary>

Step 4b checks that the
row exists, belongs to the caller, and holds a transcript. It never checks
`summary_failed` or `status`. So a *successful* lecture can be re-summarised as
many times as the retention window allows. The cost is the app's single most
expensive OpenAI call — the full transcript back through the summariser — for a
flat 2 minutes:

| | Real cost | Billed | Per billed minute |
|---|---|---|---|
| Recording a 180-min lecture | $0.1271 | 180 min | $0.00071 |
| **Re-summarising it** | **$0.00715** | **2 min** | **$0.00357** |
| Re-summarising a 50-min lecture | $0.00323 | 2 min | $0.00162 |

`RESUMMARISE_BILLED_MINUTES` is derived correctly for the case it was designed for
— a *typical short* summary at $0.00096. It is derived from
`USD_PER_SUMMARY_REQUEST`, which is built from
`TYPICAL_SUMMARY_INPUT_TOKENS = 1600`. A three-hour transcript is **21× that
input.** The constant is right and the assumption underneath it — that a
re-summarise costs about what a fresh summary costs — is only true for short
recordings. **The fix is a precondition, not a price:** require
`summary_failed = true` (or `status = 'failed'`) in the lookup, which makes the
action unrepeatable by construction and leaves the billing derivation alone.

</details>

**(b) The allowance read/write is not atomic, in either function — FIXED, with
a smaller race kept on purpose.** `_shared/allowance.ts` calls
`add_ai_credits` (or `add_trial_credits` for the lifetime trial), a Postgres
function that does the `+` under the row lock `ON CONFLICT DO UPDATE` takes and
returns the post-increment totals — so the fraction a student is shown is the
database's rather than one computed from a stale read. Migration 0011
introduced it; 0012 replaced it when the currencies collapsed.

**What was NOT changed, and it is a decision rather than an omission:** the
allowance READ still precedes the provider call, so a missing column and an
exhausted allowance both fail having spent nothing. Folding the check into the
increment — "add it and tell me if I went over" — would move the refusal to
after the money was spent. So a bounded race survives: two requests can both
pass the check at *N* and both be billed, exceeding the cap by one request's
cost. That is the same class as (c). What is fixed is the strictly worse bug,
where the second request was never billed at all.

The test worth knowing by name is **"THE LOST UPDATE, demonstrated"**, which
runs the OLD read-modify-write in two concurrent psql sessions and asserts the
total is 3 rather than 6 — without which "two concurrent calls add up" could
pass because the two calls never overlapped.

<details>
<summary>The original entry</summary>

**(b) The allowance read/write is not atomic, in either function.** Both do
`select … minutes_used` (or `text_units_used`), then `upsert { …: read + cost }`.
Two requests that overlap both read *N* and both write *N + cost*, so one of them
is free. This is what makes a cap not quite a cap. It is not a plausible accident
at 12 testers and it is a trivial script for anyone who wants it. The fix is one
statement: a Postgres function doing `update … set minutes_used = minutes_used + $1`
(or an insert-on-conflict-do-update with the same expression), so the increment
happens in the database rather than in the function's memory. Worth doing before
money is charged, not before the closed test.

</details>

**(c) The cap can be overshot by exactly one recording — OPEN, deliberately,
and re-confirmed in the code.** `ai-notes/index.ts` still takes
`estimatedDurationSeconds` off the request body for the pre-flight guard, and
the BILLED figure still comes from `result.durationSeconds` as the provider
reports it. Both halves are as described: the billing is correct and the
ceiling is soft by one action. Left alone for the reason the entry gives, and
it is now the same shape as the race (b) deliberately keeps.

<details>
<summary>The original entry</summary>

**(c) The cap can be overshot by exactly one recording.** The pre-flight guard uses
the *client's* `estimatedDurationSeconds`. A client reporting 0 passes the guard at
299/300 minutes used, and then the honest post-hoc billing lands the account at 479.
The billing is correct; the ceiling is soft by one action. Bounded and acceptable
while `MAX_REQUEST_SECONDS` is 3 h, worth knowing when the cap becomes a paid
entitlement.

</details>

### The comparison the brief asked for: minutes charged vs real cost

> **The re-summarise row below is HISTORICAL** — the action it describes cannot
> be taken any more, per (a). The photo row is live, and section 13 prices what
> it costs an account.

| Action | Real cost | Minutes billed | USD per billed minute | Verdict |
|---|---|---|---|---|
| 50-min lecture | $0.0357 | 50 | $0.00071 | honest |
| 180-min lecture, translated | $0.1271 | 180 | $0.00071 | honest |
| 3-min clip, translated | $0.00283 | 3 | $0.00094 | the floor is working |
| Re-summarise a 180-min lecture | $0.00715 | 2 | $0.00357 | **5× under-charged, and repeatable** |
| **A 16-page photo reading** | **$0.0948** | 0 (13 **units**) | — | **the meter is lying** |

On that last row, plainly: a 16-photo reading costs more than two hours of lecture
and is metered as 8.7% of a text allowance that a student can also spend on
explanations costing a twentieth as much. The two currencies are a good design; the
weight inside one of them is wrong by an order of magnitude.

---

## 6. The cost table

Every row at its input and output ceiling, so these are upper bounds.

| Action | Groq | OpenAI | Total | Minutes billed | Units billed | Cost per billed minute |
|---|---|---|---|---|---|---|
| Lecture, 3 min | $0.00200 | $0.00050 | $0.00250 | 3 | — | $0.00083 |
| Lecture, 3 min + translation | $0.00200 | $0.00083 | $0.00283 | 3 | — | $0.00094 |
| Lecture, 50 min | $0.0333 | $0.00236 | $0.0357 | 50 | — | $0.00071 |
| Lecture, 50 min + translation | $0.0333 | $0.00323 | $0.0366 | 50 | — | $0.00073 |
| Lecture, 60 min + translation | $0.0400 | $0.00375 | $0.0437 | 60 | — | $0.00073 |
| Lecture, 180 min + translation | $0.1200 | $0.00715 | $0.1271 | 180 | — | $0.00071 |
| Re-summarise, 180-min transcript | — | $0.00715 | $0.00715 | 2 | — | **$0.00357** |
| Explain-it-back | — | $0.00052 | $0.00052 | — | 1 | — |
| Weak spots | — | $0.00071 | $0.00071 | — | 1 | — |
| Practice questions | — | $0.00121 | $0.00121 | — | 2 | — |
| Summarise a note / text chunk | — | $0.00193 | $0.00193 | — | 3 | — |
| **Summarise 4 photos** | — | **$0.0233** | **$0.0233** | — | 3 | — |
| Merge | — | $0.00144 | $0.00144 | — | 1 | — |
| **16-page photo reading (whole)** | — | **$0.0948** | **$0.0948** | — | 13 | — |

The photo rows price the model we call **today**. The patch-based lever under
finding 1 would take a page from ~36,835 tokens to ~2,385, so every photo figure in
this document is an upper bound on what the feature costs after that decision — and
the whole worst-case column below moves with it.

### Three scenarios

| Scenario | Composition | Monthly cost |
|---|---|---|
| **Light** | 2 × 50-min lectures, 4 explain-it-backs | **$0.074** |
| **Typical** | 8 × 50-min lectures, 2 × 8-page photo readings, 20 text actions | **$0.397** |
| | *of which the photos are* | *$0.096 — 24%* |

Two photo readings out of thirty actions are a quarter of a typical month's cost.

### Cap-hitting, composed the most expensive legal way

Not an average — the worst mix a user could legally compose inside the cap. In each
case the minutes are spent, and then the 150 text units are spent entirely on photo
batches on top.

| Cap | All 3-min clips | All 180-min lectures | **1 recording + re-summarises** | + 150 units of photos | **Worst total** |
|---|---|---|---|---|---|
| 300 min (today) | $0.284 | $0.127 | **$0.556** | $1.167 | **$1.72** |
| 900 min (Study AI) | $0.851 | $0.636 | **$2.70** | $1.167 | **$3.87** |
| 3,000 min (Study AI Max) | $2.83 | $2.03 | **$10.21** | $1.167 | **$11.37** |

**Read the columns, not just the totals.** Recording lectures — the thing the tier
is named for and the thing everyone assumes is expensive — is the *cheapest* column
at every cap. The worst case is dominated by two mechanisms that are both bugs
rather than usage: the unguarded re-summarise, and photo batches priced at a
twelfth of what they cost.

**With both fixed** — a failure precondition on re-summarise, and photo batches
re-weighted to 12 — the 3,000-minute worst case falls to roughly **$2.31**: 16
long translated lectures at $2.03, plus 12 photo batches at $0.28, since 150 units
at 12 a batch buys twelve rather than fifty. That is the number a price should be
set against, and it is **4.9× smaller** than the one the current code underwrites.

---

## 7. Model lifespan — WITHDRAWN, the premise was wrong

**The brief's premise did not survive checking, and it was not mine to check.**
`gpt-4o-mini` appears nowhere on OpenAI's deprecations page — not upcoming, not
past. The brief took it from a third-party tracker that had conflated it with the
audio and realtime variants. The analysis that stood here has been withdrawn
rather than corrected: there is nothing to plan around.

What this document originally said — that I could not reach the page, that every
source I *could* reach named `gpt-4o-mini` as an exception, and that it wanted a
human's eyes — was the right shape of answer to give. Recording that here because
the next brief written from a remembered figure will look exactly like this one.

**THE TRAP TO RECORD, since somebody will walk into it:**

> **`gpt-4.1-nano` and `o4-mini` shut down 23 October 2026. Neither is the cheap
> option.**

They are the two names that come up first when someone goes looking for something
smaller and cheaper than what we run, and both have a date on them.

### Still true, and still worth doing: the model string sits in three places

Not a deprecation matter, and it becomes live the moment the photo work moves a
model. Two production occurrences plus one in a measurement script:

- `supabase/functions/ai-notes/openai.ts:97`
- `supabase/functions/ai-text/openai.ts:27`
- `scripts/measure-summary-depth.mjs:192`

This is not the unavoidable browser/Deno mirror. **Both are Deno functions in the
same repository, and `supabase/functions/ai-notes/_shared/` already exists.** Move
`_shared/` up to `supabase/functions/_shared/model.ts` exporting a single
`SUMMARY_MODEL`, import it in both adapters, and have the measurement script read
it too. A model change then touches one line, and a test grepping for a bare
`model: "` literal in either adapter keeps it that way. Worth doing *before* the
photo model change rather than after, so that change is one line rather than three.

### Portability, since a model move is now likely rather than hypothetical

**The prompts themselves are portable.** The depth rules are instructions about
specificity and not-inventing; nothing in them depends on model-specific behaviour.
Two structural risks, both mechanical:

- `ai-notes` uses `response_format: { type: "json_schema", strict: true }`;
  `ai-text` uses `json_object`. Strict-schema support and its quirks (still no
  `minItems`, which is why depth is a prompt property here) need re-checking on
  whatever we land on.
- **`max_tokens` is the hazard.** The GPT-5 family takes `max_completion_tokens`,
  and reasoning tokens count toward that budget. Every ceiling in
  `ai-text/config.ts` and `SUMMARY_MAX_TOKENS` is sized against *visible* output.
  Ported unchanged, a reasoning model could spend the whole budget thinking and
  return `finish_reason: "length"` with nothing — which this code correctly treats
  as a hard failure, so it would fail loudly rather than truncate, but it would
  fail on every request. **Budget a re-measurement pass, not a find-and-replace.**

## 8. Plan: per-tier limits — plan only, nothing built

Target shape:

| Tier | Monthly AI minutes | Text units | Shape of the counter |
|---|---|---|---|
| Free | 60, **once ever** | 10/month (today's `FREE_TEXT_UNITS_LIMIT`) | lifetime |
| Plus | 60, **once ever** (shared with Free — Plus buys sync) | 10/month | lifetime |
| Study AI | 900/month | 150/month | monthly |
| Study AI Max | 3,000/month | 150/month? — see below | monthly |

### Every place `MONTHLY_MINUTES_LIMIT` is read

**Server (authoritative):**
- `ai-notes/config.ts:21` — the definition
- `ai-notes/index.ts:362` — the re-summarise allowance guard
- `ai-notes/index.ts:515` — passed into `checkRequestGuards` for a fresh recording

**Client (display only):**
- `src/aiNotesLogic.js:169` — `MONTHLY_MINUTES_LIMIT_HINT`
- `src/aiNotes.jsx:81` — the near-cap warning at 90%
- `src/aiNotes.jsx:86` — the "X of Y AI minutes used this month" badge

The hint is already asserted equal to the server constant
(`scripts/test-ai-notes.mjs:684`). **That assertion becomes wrong the moment the
limit is per-tier**: there is no single number to mirror. It must become a mirrored
*table* — `limitForTier` on both sides, deep-equalled, exactly the arrangement
`aiTextLimits.js` already has for text units. That is the model to copy; it exists
and it works.

### Where tier lives, and where it is enforced

`profiles.tier` already exists, defaults to `'free'`, and is already read
server-side by both functions (`ai-notes/index.ts:241`, `ai-text/index.ts:103`).
**The enforcement point already exists and is already server-side.** The change is
that `MONTHLY_MINUTES_LIMIT` becomes `minutesForTier(profile.tier)`, mirroring
`limitForTier`. Nothing about the trust boundary moves.

Today `ai-notes` requires `tier === "ai"` outright. Under the new table it must
accept Free and Plus too, gated by the lifetime allowance instead — so the tier
check stops being a gate and becomes a limit lookup. **That is the diff that
matters**, and it is the one that could accidentally open recording to everyone
with no ceiling if the lifetime counter is not in place first. Order: counter
first, gate relaxed second.

### The lifetime trial is a different shape, not a different number

`ai_usage` is keyed `(user_id, month)`. A lifetime allowance has no month, and
faking one (a sentinel month like `'lifetime'`) would make every existing query
that filters by `currentMonthKey()` silently wrong in ways nothing would catch.

**Recommended shape: a column on `profiles`.**

```sql
alter table public.profiles
  add column if not exists trial_minutes_used numeric not null default 0;
```

- It is a property of the account, not of a month, which is what the row already is.
- The tier lookup at step 4 already reads `profiles`, so it costs no extra query —
  `select tier, trial_minutes_used` instead of `select tier`.
- It survives a month rollover with no logic, because there is no month in it.
- **It must never be reset by anything.** Not by account tier changes, not by the
  retention sweep. The one legitimate reset is a human in the dashboard.

The billing write then branches on tier: paid tiers upsert `ai_usage` as today,
trial tiers increment `profiles.trial_minutes_used`. Both should use the atomic
`set x = x + $1` form recommended in section 5(b) — a lifetime counter is exactly
where a lost increment is permanent.

**The deletion question, and it needs a ruling.** `delete_my_account_data()` empties
every table with a `user_id` column, and a migration test enumerates them from the
database to prove it. If the trial counter lives on `profiles` and `profiles` is
emptied, **delete-and-resignup resets the lifetime trial.** That is the cost line
the lifetime design exists to close, reopened by the privacy feature. There is no
clean answer that keeps both promises — retaining a per-email counter after
deletion is retaining personal data after a deletion request. My recommendation is
to **accept the hole and say nothing about it**: it costs $0.04 per abuse (60
minutes of Turbo), it requires confirming a new email address each time, and the
alternative is a privacy-policy change to close a four-cent leak.

### What the allowance line shows

Today: *"{n} of 300 AI minutes used this month"*, with a warning at 90%.

| Tier | Line | Why |
|---|---|---|
| Free / Plus | "{n} of 60 free AI minutes used" — **no "this month"** | The single most important word to remove. A student who reads "this month" and waits for a reset is a support ticket, and an angry one. |
| Study AI | "{n} of 900 AI minutes used this month" | unchanged shape |
| Study AI Max | "{n} of 3,000 AI minutes used this month" | unchanged shape |

At 100% the Free/Plus wording must say what happens next — the trial is over, the
tier that has more is named — rather than the current "used all your AI minutes for
this month", which is false for a lifetime allowance. That string is in
`ai-notes/guards.js:44` and would need a per-tier variant.

### Migration for existing accounts

Three real accounts: two users plus the e2e test account.

- The column defaults to `0`, so every existing account gets a fresh 60-minute trial
  whether or not it has already recorded. For two users that is correct and
  generous; nothing to script.
- **The e2e account must be set to a paid tier by hand**, or the journeys start
  failing 60 minutes into their collective lifetime — silently, and looking like a
  code bug. Journey 2 records. This is the one migration step that is not optional.
- Existing `ai_usage` rows are untouched and stay meaningful for paid tiers.

### What the tests must cover, and which guard goes red

The question "which guard would go red if tier enforcement were removed" is the
right one, and today's honest answer for the analogous text gate is: a source-level
invariant, plus a behavioural test in `test-ai-text-function.mjs` that runs the real
handler against a fake database. Copy that arrangement:

1. **Deleting the tier lookup makes a `free` caller's recording succeed** — a
   behavioural test in `test-ai-notes-function.mjs` running the real handler with a
   fake profile row at each tier and asserting the refusal. This is the one that
   goes red.
2. **The lifetime counter is not `ai_usage`** — a test asserting that a trial-tier
   recording writes `profiles.trial_minutes_used` and writes **no** `ai_usage` row,
   and that a paid-tier one does the opposite. Otherwise a refactor quietly makes
   the lifetime allowance monthly and every test still passes.
3. **A month rollover does not restore the trial** — the fake clock advanced past a
   month boundary, the trial still exhausted. This is the property the whole design
   exists for and nothing else tests it.
4. **The client's tier table deep-equals the server's**, the `aiTextLimits.js`
   arrangement, so the badge cannot promise 900 while the server enforces 60.
5. **The copy has no "this month" on a trial tier** — a grep, comments stripped
   first (six instances now say why).

---

## 9. Plan: free tier is one device at a time — plan only

### Where it would be enforced, and why the sync path makes the obvious shape awkward

`getDeviceId()` already exists (`src/sync.js:37`) and returns a stable per-device id
from `localStorage`. So half the mechanism is built.

**The awkward part is that sync has no server-side code at all.** `push` and `pull`
are a bare `upsert` and `select` on `planner_data` under RLS (`src/sync.js:461`,
`475`). There is no function in the middle to check anything. So a
`current_device_id` column on `profiles` "checked on sync" has to be enforced in one
of three places:

| Where | How | Verdict |
|---|---|---|
| Client checks it | read `profiles.current_device_id` before pushing | **No.** A client-side entitlement check is not one. Trivially removed. |
| RLS policy on `planner_data` | policy references `profiles.current_device_id`, device id sent as a request header or a column | Workable but ugly: the device id has to reach the policy, which means either a custom JWT claim (needs an auth hook) or a column on `planner_data` the client sets and the policy compares — and a client that lies sets it to whatever the server holds. |
| **A Postgres trigger + a claim** | `before insert or update on planner_data`, comparing a device id carried in the JWT | The only shape where the client cannot forge it, and it needs a Supabase Auth hook to put the device id in the token at sign-in. |

**My recommendation is different from all three: do not enforce it on sync. Enforce
it at sign-in.** A `profiles.current_device_id` written by an Edge Function at
sign-in, plus Supabase's existing `signOut({ scope: 'others' })`, gives exactly the
stated product behaviour — *"signing in on a second device signs the first out"* —
without touching the sync path at all. The second device's sign-in revokes the
first device's refresh token; the first device discovers this on its next token
refresh and lands in the signed-out state the app already has. **That is the whole
feature**, and it reuses a mechanism Supabase maintains rather than one we would.

### What the signed-out device shows

**It must not look like a crash and must not lose local data**, and the good news is
that the app already behaves correctly here by construction: local state lives in
`localStorage` under `uni-planner-v1`, is never cleared by signing out, and the
planner works signed-out. So the signed-out device shows the planner, with its data,
and a sign-in prompt.

What it needs is **one sentence explaining why**, or the student reads it as data
loss. Something like: *"You've been signed out because your account was opened on
another device. Free accounts can be signed in on one device at a time. Everything
here is still saved on this device."* The last clause is the load-bearing one.

### Upgrading to Plus

Clearing `profiles.current_device_id` on upgrade releases the restriction. **The
previously-signed-out device recovers by signing in**, and its local planner merges
with the server copy through the ordinary `mergeData` union — which is per-item
last-write-wins and is the most-tested function in the codebase. Nothing special is
needed. Worth an explicit test: *a device signed out by the device limit, then
signed back in after an upgrade, keeps the edits it made while signed out.*

### The failure mode you care about

*A free user reinstalls or clears their browser and cannot get back in because the
server thinks another device holds the slot.*

Under the sign-in-time design, **this failure cannot occur.** Signing in on the
reinstalled browser is simply "a second device signing in": it takes the slot and
signs out whatever held it. The slot is never a lock that can be held against the
account's own owner, because the only thing that grants it is a successful
password authentication.

That is the strongest argument for the sign-in-time shape over the sync-time one.
The sync-time design has exactly this failure and needs a recovery path — a
"sign out my other devices" button, which is a screen, its own copy, and its own
support burden. The sign-in design needs none of it.

### Interaction with the origin split

**The origin split changes nothing here, and it is worth being precise about why.**
The plan on record is `/` → `/app` **on the same origin** (`www.uniplannerapp.com`),
specifically so `localStorage` survives. Same origin means the same
`uni-planner-device-id`, so a device does not look like a new one.

Where a device *does* legitimately look new: preview deployments on
`*.uniplanner.pages.dev` are a different origin, so signing into a preview mints a
new device id and — under this design — would sign out the developer's production
session. Annoying during development, harmless in production, and worth knowing
before someone reports it as a bug. The desktop (`file://`) and phone
(`capacitor://localhost`, `http://localhost`) shells each have their own origin and
therefore their own device id, which is correct: they *are* different devices.

---

## 10. The two one-line changes — neither was needed

**1. Switch Groq to Turbo.** Already Turbo. `ai-notes/groq.js:69` sets
`whisper-large-v3-turbo`, and `config.ts` documents the choice against Deepgram.
**No PR.** For the record, had it been full Large v3 the difference at the current
300-minute cap would have been $0.20 → $0.56 per fully-used account per month.

**2. Raise `MONTHLY_MINUTES_LIMIT` from 30 to 200.** It is **300**, not 30
(`ai-notes/config.ts:21`), and `MONTHLY_MINUTES_LIMIT_HINT` mirrors it at 300 with a
test asserting they agree. **Setting it to 200 would cut the closed test's allowance
by a third.** No PR.

Worth flagging as a process point rather than a criticism: both instructions were
written from a remembered value, and both remembered values were wrong. The tier
table in section 8 should be entered against the code, not against the brief.

---

## 11. Making this checkable

Everything above is a model. Here is how to break it.

### Where to look

**Groq** — `console.groq.com` → **Usage**. Filter by model
`whisper-large-v3-turbo` and by day. The usage view reports **seconds of audio
processed** and spend; seconds is the number that matters, because it is what the
per-hour rate multiplies and it is directly comparable to the recording's real
length. If seconds materially exceeds the recording's length, something is chunking
that I said does not chunk.

**OpenAI** — `platform.openai.com` → **Usage**, then the **Cost** tab for dollars
and the **Activity**/completions breakdown for per-request **input and output token
counts**. Filter by the project or API key the Edge Function uses and by day.
*(I could not reach either dashboard to confirm the current layout — both hosts are
blocked from the build container. If the pages have moved, the two figures to find
are unchanged: audio seconds on Groq, input/output tokens on OpenAI.)*

Do both readings on a **quiet day with no other traffic**, or the numbers cannot be
attributed.

### The two-step script

**Step A — one lecture.** Record a **50-minute** lecture with **translation off**,
in one recording, and let it complete. Note the wall-clock length.

**Step B — one photo reading.** Summarise a reading from **16 photographed pages**,
in one run, using the same photo path a student would (gallery or camera, so
`downscalePhoto` runs). Let it complete including the merge.

Then read both dashboards.

### What this model predicts, stated in advance

**Step A — a 50-minute lecture, no translation**

| Figure | Prediction | ±20% band |
|---|---|---|
| Groq, audio processed | 50.0 minutes (3,000 s) | 40–60 min |
| Groq, spend | $0.0333 | $0.0267 – $0.0400 |
| OpenAI, input tokens | 9,928 | 7,942 – 11,914 |
| OpenAI, output tokens | 1,449 | 1,159 – 1,739 |
| OpenAI, spend | $0.00236 | $0.00189 – $0.00283 |
| **Total** | **$0.0357** | **$0.0286 – $0.0428** |

The Groq figure is nearly arithmetic and should land almost exactly; it is the
control. **The OpenAI output-token figure is the soft one** — it is the modelled
number flagged in section 3, and it is the one most likely to miss. If input lands
and output is out by more than 20%, the output model needs recalibrating and
nothing else in this document does.

**Step B — a 16-photo reading summary**

| Figure | Prediction | ±20% band |
|---|---|---|
| **OpenAI, input tokens** | **591,761** | **473,409 – 710,113** |
| OpenAI, output tokens | ~10,000 | 8,000 – 12,000 |
| OpenAI, spend | $0.0948 | $0.0758 – $0.1137 |
| Groq | $0 | — |

**The input token count was designed to be the experiment**, and the experiment
has been settled another way: the tokenisation was confirmed from OpenAI's guide on
20 August. So this reading is now a **confirmation, and nothing waits on it.**

It is still worth doing when convenient, because it checks the whole path rather
than the rate — that `downscalePhoto` really emits what we think, that `detail`
really arrives as `high`, that four batches really go out. Expect **~590,000 input
tokens.** If it reads ~20,000 instead, something in our own client is not doing what
this document says it does, which would be a different and more interesting
finding than the one it was built to test.

The lever recorded under finding 1 changes what this reading is *for*: once the
photo path moves to a patch-based model, the number to expect is around 2,400
tokens a page rather than 36,835, and the reading becomes the check on that move.

**If either total is out by more than 20%, stop and find out why before any of this
reaches the website.** The most likely culprits, in order: the summariser output
model (soft, flagged, affects lectures only), the image token model (binary,
flagged, affects photos only), and the 140 wpm speech-rate assumption (affects
summariser input by the same proportion it is wrong by, and lecture totals by about
a third of that).

---

## 12. The photo model — priced, with one recommendation and one measurement

> **SINCE THIS SECTION WAS WRITTEN:** the single currency has shipped, and the
> weights in it are now derived in code rather than argued in prose —
> `supabase/functions/_shared/credits.ts`. A credit is a minute of recorded
> lecture; a text chunk is 3, a merge is 2, and the photo batch is **held** at 3
> with a test that goes red if it moves. The credit figures below are the ones
> the code now produces, give or take the rounding described in 12.6. The two
> gates are unchanged and nothing about the photo path has been built.

Commissioned after the review, which supplied the lever this document could not
see. **Report before building**: nothing here is implemented.

Every figure is printed by `scripts/measure-cost-model.mjs`, which now implements
the patch rule and checks it against the worked example in the brief — 1086 × 1536
on a 1,536-patch budget comes out at 1,472 patches and **2,385 tokens**, matching
to the digit. The second step of the shrink is what makes that work, and leaving it
out gets the answer wrong by about 8%: shrink to fit the budget, then land the
width on a whole patch boundary and scale the height by *that* adjusted factor.

### The headline, before the tables

**The brief's estimate was right about the mechanism and wrong about the size of
the prize, and the reason is a price nobody was looking at.** "Even at three times
the per-token price, photos land roughly five times cheaper" assumes the image
tokens dominate. They do today. They do not on `gpt-5.4-mini`, whose **output** is
$4.50/1M against gpt-4o-mini's $0.60 — 7.5× — and `MAX_TOKENS.summarise` is 2,000.

> On `gpt-5.4-mini`, **the summary costs more than the four photos it is about.**

So the real numbers are 1.4–1.8× for `gpt-5.4-mini` and 4.3–5.8× for
`gpt-5.4-nano`. The five-fold prize is real, and it is on nano.

### 12.1 Availability

| Model | Status | Image scheme |
|---|---|---|
| `gpt-4o-mini` | live, no sunset published | tiles, 2,833 + 5,667 |
| `gpt-5.4-mini` | live, not on the deprecation list | patches, budget 1,536, ×1.62 |
| `gpt-5.4-nano` | live, not on the deprecation list | patches, budget 1,536, ×2.46 |
| `gpt-5-mini` / `gpt-5-nano` | **2025-08-07 snapshots shut down 11 December 2026** | patches |
| `gpt-4.1-nano`, `o4-mini` | **shut down 23 October 2026** | patches |

The last two rows are the trap from section 7: the cheap-looking names both have
dates on them, and `gpt-5-mini`/`gpt-5-nano` are only pinned-snapshot deaths — but
pinning a snapshot is exactly what you do when you want a model to stay put.

**RATES ARE THIRD-HAND AND THAT IS THE WEAKEST PART OF THIS SECTION.** OpenAI's own
pricing and vision pages are unreachable from the build container. The figures
below came from search results that agreed with one another, and two of them decide
the recommendation. Section 12.7 says which, and how one API call settles both.

| Model | Input /1M | Output /1M |
|---|---|---|
| `gpt-4o-mini` | $0.150 | $0.600 |
| `gpt-5.4-mini` | $0.750 | $4.50 |
| `gpt-5.4-nano` | $0.200 | $1.25 |

### 12.2 One A4 page, at each `maxEdge` — and the lever that now exists

`downscalePhoto` keeps the aspect ratio, so an A4 page leaves the device at
`round(edge / 1.414) × edge`.

| `maxEdge` | `gpt-4o-mini` (tiles) | `gpt-5.4-mini` | `gpt-5.4-nano` |
|---|---|---|---|
| 1536px (today) | 36,835 tok · $0.00553 | 2,385 tok · $0.00179 | 3,621 tok · $0.00072 |
| 1280px | 36,835 tok · $0.00553 | 1,879 tok · $0.00141 | 2,854 tok · $0.00057 |
| **1024px** | 36,835 tok · $0.00553 | **1,192 tok · $0.00089** | **1,811 tok · $0.00036** |
| 896px | 36,835 tok · $0.00553 | 907 tok · $0.00068 | 1,378 tok · $0.00028 |
| 768px | 36,835 tok · $0.00553 | 661 tok · $0.00050 | 1,004 tok · $0.00020 |

**`maxEdge` IS a lever under patch tokenisation, and this is the answer to the
question the brief said was not obvious.** Under tiling the shortest side is
normalised to 768 in both directions, so the column is flat — that is section 4's
settled finding. Under patches the budget is a **cap, not a target**: an image that
fits under it is billed for exactly the patches it needs, so the cost falls
linearly with what we send. Dropping 1536 → 1024 halves the image tokens.

It is a free change in code and it is **worth nothing on the model we run today**,
which is why it belongs in this decision rather than beside it.

### 12.3 `detail` — the setting we have wrong, and it is nearly free to fix

`prompts.js` sends `detail: "high"`. The docs recommend **`"original"`** for OCR
and small text, and warn that `low` and `high` may resize and obscure fine detail —
so today's setting is not the OCR-optimal one for a photographed page of print.

`"original"` raises the patch budget to 10,000 (max dimension 6,000) and does not
resize, so the page is billed exactly as sent:

| `maxEdge` | `gpt-5.4-mini` | `gpt-5.4-nano` |
|---|---|---|
| 1536px | 2,644 tok · $0.00198 | 4,015 tok · $0.00080 |
| **1024px** | **1,192 tok · $0.00089** | **1,811 tok · $0.00036** |
| 768px | 661 tok · $0.00050 | 1,004 tok · $0.00020 |

**At 1024px, `original` and `high` cost the same** — the budget is not binding, so
there is nothing to shrink — and `original` guarantees the model reads the pixels
we chose rather than a resize we did not. At 1536px `original` costs 11% more and
buys a page that was not silently shrunk.

That is the shape of the recommendation: **stop letting the provider decide the
resolution, decide it ourselves, and pick the number by legibility rather than by
what a budget happens to allow.**

### 12.4 A batch of four pages, and a whole 16-page reading

| Model | `maxEdge` | Batch input | Batch output | **Batch** | 16 pages | vs today |
|---|---|---|---|---|---|---|
| `gpt-4o-mini` (today) | 1536 | $0.0221 | $0.00120 | **$0.0233** | $0.0948 | 1.00× |
| `gpt-5.4-mini` | 1536 | $0.00731 | $0.00900 | **$0.0163** | $0.0754 | 1.43× |
| `gpt-5.4-mini` | 1024 | $0.00373 | $0.00900 | **$0.0127** | $0.0611 | 1.83× |
| `gpt-5.4-nano` | 1536 | $0.00294 | $0.00250 | **$0.00544** | $0.0246 | 4.29× |
| **`gpt-5.4-nano`** | **1024** | $0.00149 | $0.00250 | **$0.00399** | **$0.0188** | **5.85×** |

The output column is the one to read. At 2,000 tokens it is $0.00120 on
`gpt-4o-mini`, $0.00250 on nano and **$0.00900 on `gpt-5.4-mini`** — where it is
more than twice the cost of the four photographed pages. Moving to `gpt-5.4-mini`
trades an image problem for an output problem and keeps most of the bill.

One consequence worth naming for later: **`MAX_TOKENS.summarise` becomes a price
lever it has never been.** On gpt-4o-mini the ceiling is a safety rail costing a
tenth of a cent. On any of these it is a real fraction of the action's cost, so a
future "let summaries be longer" is a pricing change rather than a comfort change.

### 12.5 The model must be chosen per MEDIUM, not per task

Photos and pasted text are the **same `summarise` task**, so moving the task moves
both. That would be a bad trade:

| Model | 20,000-char text chunk | 60-minute lecture summary |
|---|---|---|
| `gpt-4o-mini` (today) | $0.00193 | $0.00375 |
| `gpt-5.4-mini` | $0.0127 — **6.6× worse** | $0.0237 — **6.3× worse** |
| `gpt-5.4-nano` | $0.00348 — 1.8× worse | $0.00648 — 1.7× worse |

**Text stays on `gpt-4o-mini`.** It has no published sunset, it is the cheapest
thing in the table for text, and the lecture summariser has a measured prompt tuned
against it.

That means two model strings rather than one, which **raises the priority of the
`_shared/model.ts` move in section 7 rather than lowering it**: `SUMMARY_MODEL` and
`VISION_MODEL`, one place each, imported by both functions. Do that first and the
photo change is one line.

Ruled out on the arithmetic, so nobody proposes it: **OCR the pages with a cheap
model, then summarise the text with `gpt-4o-mini`.** Nano would have to emit the
page text (~3,200 tokens for four pages) at $1.25/1M, which alone is $0.0040 —
more than the entire single-call nano batch — before the second call is paid for.
Two calls, two failure paths, and it costs more.

### 12.6 What it does to the weight — model and weight, as one decision

Priced in credits, where **1 credit = 1 minute of recorded lecture = $0.00071**
(the single-currency preview; the full pass is the next piece of work). A 20,000-
character text chunk comes out at **3 credits — exactly today's
`TASK_UNITS.summarise`**, which is a good sign the currency change will be clean.

| Photo batch of 4 | Honest weight | A 16-page reading |
|---|---|---|
| `gpt-4o-mini` today, any `maxEdge` | **34 credits** | ~138 credits |
| `gpt-5.4-mini` @1024 | 19 credits | ~78 credits |
| **`gpt-5.4-nano` @1024** | **6 credits** | **~26 credits** |

*(The shipped code defines a credit slightly more conservatively than this
section did — transcription plus a SHORT lecture's summary share, rather than a
measured 50-minute lecture's total — so its credit is worth $0.000686 against
$0.00071 here and every weight rounds up rather than down. The direction is
deliberate: a credit worth less means an action costs more.)*

**Read the first row, because it is the real conclusion of this section.** Priced
honestly on the model we run today, four photographed pages cost eleven text chunks,
and a 16-page reading costs most of a month. Weight 3 is not a mispricing that
needs correcting — **at an honest weight the feature is unusable on this model.**
The move is not an optimisation; it is what makes the feature exist at a price we
can state out loud.

Nano at 1024 puts a whole reading at ~25 credits, which is a sentence a student can
hear: *a 16-page reading costs about as much as a 25-minute lecture.*

### 12.7 THE RECOMMENDATION, and the one thing that must be measured first

**Move the photo path — and only the photo path — to `gpt-5.4-nano`, with
`detail: "original"` and `maxEdge` 1024, and weight a batch at 6 credits.**
Keep text and lectures on `gpt-4o-mini`. Split the model string into
`SUMMARY_MODEL` and `VISION_MODEL` in `supabase/functions/_shared/` first.

**It is conditional on one measurement, and I would not ship it without.** Two
things are unverified and both can only be settled by a real call:

1. **Can nano actually read a photographed page of print?** This is the whole
   feature. Nano is the cheapest model in the family and OCR of a phone photo is
   the hardest thing we would ask of it. A summariser that quietly misreads a page
   is the worst outcome the readings work has — it is billed, saved and trusted —
   which is exactly why the legibility rule is a model *refusal* rather than a
   client heuristic. If nano's refusals get worse rather than its reading, that is
   a silent quality regression on the most sensitive path in the app.
2. **The rates and the tokenisation on this specific path.** There is an
   unresolved report of a 1920×1080 PNG billing ~66,000 prompt tokens on
   `gpt-5.4-mini`, where the documented arithmetic says ~2,400. Cause unknown;
   PNG-as-data-URL and the `detail` handling are both implicated in the thread.
   **We send exactly that shape** — a base64 data URL from a canvas — so if that
   report is real, the whole saving evaporates and the recommendation inverts.

That is *verify the evidence before endorsing the remedy*, pointed at a remedy I am
proposing. The arithmetic is clean, checks against the brief to the digit, and rests
on two published numbers I could not read at the source and one behaviour somebody
says does not match its documentation.

**IT IS A SCRIPT, NOT A PROCEDURE.** `scripts/measure-photo-gates.mjs` makes the
three calls, downscales the photos exactly as `downscalePhoto` does (sharp, 1024px,
quality 0.8 — and says so loudly if sharp is absent, because then the bytes sent
are not the bytes the app sends), pulls the vision prompt out of `prompts.js`
rather than retyping it, and prints reported `prompt_tokens` beside this
document's prediction with the ratio. Gate 1 is that ratio. Gate 2 is the three
summaries it prints, which need a human and the actual pages.

```
export OPENAI_API_KEY=sk-...
npm i --no-save sharp
node scripts/measure-photo-gates.mjs page1.jpg page2.jpg page3.jpg page4.jpg
```

**Photograph the pages, do not screenshot them.** A clean PDF export answers an
easier question than the one gate 2 asks.

**The measurement, and it is cheap.** One reading, four photographed pages, run
three times — once on `gpt-4o-mini` @1536/high (the control, which this document
predicts at **147,544 input tokens**), once on `gpt-5.4-nano` @1024/original
(predicted **7,448 input tokens**), once on `gpt-5.4-mini` @1024/original
(predicted **4,972**). Read the input token counts on the OpenAI dashboard and read
the three summaries side by side.

- If the token counts land within 20%, the rates and the tokenisation are sound.
- If nano's summary is as good, ship it.
- If nano misreads and mini does not, the answer is `gpt-5.4-mini` at 18 credits —
  worse economics, still a real improvement, and a feature that works.
- If any of them bills five figures for four pages, that community report is real
  and none of this is the answer.

**Do not re-weight photos before this runs.** Setting 33 credits against a model we
are about to leave tells students a reading costs a third of their month when it is
about to cost a fortieth, and a visible wrong number is worse than an invisible one.

### 12.8 GATE 1 WAS CONSCIOUSLY DEFERRED, and the prices shipped anyway

Recorded because "the prices are live" must never be mistaken for "the measurement
was taken".

Section 12.7 says the photo-token ratio must be measured before the photo path is
re-weighted, and it also gated the marketing site's prices: a price per credit set
before that ratio is known is set against a cost known to be wrong. On **6 September
2026** Jared decided to ship prices without running it — AUD 8.99 / 44.99 / 79.99
for Study AI and 18.99 / 94.99 / 169.99 for Study AI Max — and `FLAGS.prices` went
true in the same commit that set the figures.

**What that does and does not license.** It licenses publishing a price. It does
**not** license moving `PHOTO_BATCH_CREDITS`, which is still held at
`TASK_CREDITS.summarise` and still pinned by a test in three places, for the reason
12.6 gives: re-weighting against a model we are about to leave tells a student a
reading costs a third of their month when it is about to cost a fortieth, and a
visible wrong number is worse than an invisible one. The measurement in 12.7 and
the model move are unchanged and still owed.

**The exposure the deferral accepts, stated so it is a decision and not a
surprise.** A student on Study AI who photographs readings heavily can, at the held
weight, spend 900 credits on roughly six 16-page readings. If the measurement lands
where 12.6 predicts, that is generous by a factor of five and costs us nothing. If
it lands where the unresolved community report suggests, the photo path is far more
expensive than the price supports — and the remedy then is the model move, not a
price rise, because the price is now published and a published price is the one
number this project has never been able to take back.

**The trigger to run it is unchanged:** before the photo path moves model, and
before any re-weighting. `scripts/measure-photo-gates.mjs`, three calls, an OpenAI
key and four photographed pages.

---

## 12.9 THE GATES RAN. The swap shipped.

Both gates were run on **16 September 2026**, on Windows, against four phone
photographs of consecutive printed pages of a computing-history textbook.
`scripts/measure-photo-gates.mjs` prints every figure below.

### Gate 1 — out of band, and in the SAFE direction

| configuration | predicted | reported | |
|---|---|---|---|
| `gpt-4o-mini` @1024, detail high | 147,550 | **102,210** | the control |
| `gpt-5.4-nano` @1024, detail original | 8,082 | **4,045** | |
| `gpt-5.4-mini` @1024, detail original | 5,394 | **4,045** | |

The script called this a FAIL, because it bands the ratio at 0.8–1.25 and all
three came in low. **Read the direction, not just the band.** Gate 1 exists to
catch a bill MANY TIMES the arithmetic — the 66,000-token report. Every count
came in BELOW prediction. **The report did not reproduce on the shape we send**,
and the documented tokenisation was conservative rather than wrong. The band is
now a two-sided check on a one-sided risk, which is a flaw in the instrument
and is recorded in it.

**The control's miss was the SCRIPT, and it was a restatement.** `predict` for
`gpt-4o-mini` hardcoded `2833 + 6 * 5667` — six tiles, which is right for an A4
page at maxEdge **1536** and wrong for the 1024 the script sends. At 771×1024 the
shortest side scales 768/771, the long side lands at 1020, and that is 2×2 = **4
tiles**. Computed from the dimensions it already had, the prediction is
**102,210 against 102,210 reported — exact.** The tiling model was never in
doubt; the prediction had stopped reading its own inputs.

**AND THE TWO PATCH MODELS REPORTED THE SAME NUMBER, which is two findings.**
4,045 for both, where the documented multipliers (2.46 and 1.62) predict 8,082
and 5,394. So the published per-model multipliers are **not what is applied**,
and nano and mini **bill an image identically** — which made the choice between
them a pure price-per-token decision rather than a tokenisation one.

**The mechanism is not understood and is deliberately not guessed at.** Two
observations of one image size cannot separate "a 1.2× multiplier" from "a
different patch count" from "a flat per-image rate", and a coincidence between
two ratios is not a mechanism. The consequence is stated rather than papered
over: **`MEASURED_PHOTO_BATCH_INPUT_TOKENS` does not extrapolate.** It is the
bill for four pages at 771×1024 and detail `original`; moving maxEdge, the page
count or the detail setting invalidates it and the price derived from it.

### Gate 2 — both models read the pages; neither invented anything

Judged against the actual pages: every date and figure both models reported is
correct — 1880 census, HP 1939, ENIAC 1943, Intel's microchip 1970, Xerox Alto
1973, AAUW 1881, women under 30% of STEM.

- **nano** is more thorough (18 key points) and **noisy**: "Data crunc(h)ers", a
  duplicated COBOL term, and "Hopper was the first group to be granted a PhD"
  garbled.
- **mini** is cleaner (10 key points) and caught two things nano missed
  (Programma 101, Ethernet). **Volume is not coverage.**

### The price that came out of it

Input MEASURED, output at `MAX_TOKENS.summarise` — because a price built on one
observation of a variable quantity is the `TYPICAL_SUMMARY_OUTPUT_TOKENS`
mistake again:

| configuration | in tokens | batch | credits | 16-page reading |
|---|---|---|---|---|
| `gpt-4o-mini` @1536 *(what used to ship)* | 147,544 | $0.0233 | **34** | 138 |
| `gpt-4o-mini` @1024 | 102,210 | $0.0165 | 24 | 98 |
| `gpt-5.4-mini` @1024 | 4,045 | $0.0120 | **18** | 74 |
| **`gpt-5.4-nano` @1024** | **4,045** | **$0.00331** | **5** | **22** |

### nano, and the argument that decided it

Both passed gate 2's actual bar. nano's defects are presentation quality, not
accuracy — it read everything correctly and invented nothing — and nano is
**3.6× cheaper**.

**What settles it is the trial.** `credits.ts` says the 60-credit trial has to
be able to demonstrate what is being sold, and names completing one
photographed reading. At mini's 18 a 16-page reading is **74 credits — more
than the whole trial**, so a free student could not finish one. At nano's 5 it
is **22**. No other candidate manages it.

**The noise is a prompt property, and that is a claim with a precedent rather
than a hope**: `ai-notes` output was "helpful but shallower than I'd like" until
its prompt was told what belonged in each section, measured at +189% words per
key point with the ceiling untouched. `ai-text`'s summarise prompt is still a
schema and one sentence — PRODUCT-PLANS.md has the depth work queued against
exactly this prompt. A duplicated term and a garbled clause are what that work
addresses. **If Grace judges the output quality unacceptable, `gpt-5.4-mini` at
18 credits is the fallback** and that is her call, not this document's.

**One measured risk, stated because it is headroom rather than price:** nano
produced **1,591 output tokens against a 2,000 ceiling — 80% of it.** A denser
four pages could truncate, which the adapter turns into a hard error. Raising
`MAX_TOKENS.summarise` re-prices the batch automatically, so that is a decision
with a number attached rather than a free one.

## 12.11 THE REVERSAL: mini at 18, and the rule that had chosen for us

The pair ran on the same four photographs (Jared, 16 September 2026). The
tightened prompt did **not** fix nano, and the honest reading of the two
outputs reversed 12.9.

### What the second run showed

| | nano BEFORE | nano AFTER | **mini AFTER** |
|---|---|---|---|
| key points | 16 / 512 words | 15 / 358 | **35 / 436** |
| terms | 16 | 17 | 13 |
| in-word brackets, dangling hyphens, duplicate terms | 0 | 0 | 0 |
| output tokens of a 2,000 ceiling | 1,696 | 1,888 | **1,314** |

**The counted defects were zero on every arm, which is exactly what the
script warned would happen** — it printed *"the BEFORE arm produced none
this run, so this comparison says nothing about the two prompts"*. The
mechanical half discriminated nothing; the judgement half did all the
work. That is the design working, not failing: a guard that named its
hole kept a null result from reading as a pass.

### The defects that decided it are the ones no pattern can see

- **nano BEFORE fabricated a term.** It listed `ARPANET / Internet` as a
  term of the reading. The page says **Ethernet**. Not a misreading of a
  word — an invented entity attached to a real sentence.
- **nano AFTER still fused claims**, under a prompt that says *"each key
  point is a single claim about a single subject"* in as many words:
  *"a screen resembling desktop-sized programmable calculator"* welds
  the Xerox Alto's screen to the Programma 101. It also degraded
  elsewhere: the overview lost a third of its words and `openQuestions`
  doubled to six, which is padding.
- **mini AFTER is atomic**, 35 one-claim key points, and it ALONE read
  three things nano missed on both runs: the **Programma 101** by name,
  the **Z1's 2,000 pounds**, and that **ENIAC was built at the
  University of Pennsylvania**.

**A PROMPT CANNOT FIX A MODEL THAT FUSES CLAIMS.** The three rules were
written against three observed defects and applied precisely; two were
already absent and the third survived a direct instruction. That is the
boundary between what a prompt buys and what a model is — and the pair
is what made it visible rather than arguable, because nano AFTER on its
own would have read as a clean run.

### And the argument that had chosen nano was a rule nobody re-derived

12.9 settled on nano with this: *"`credits.ts` says the 60-credit trial
must be able to demonstrate the feature, and at mini's 18 a 16-page
reading is 74 credits — more than the whole trial. At nano's 5 it is 22.
No other candidate manages it."*

Every number there is right. **The rule was wrong.** `credits.ts` said a
trial must let a student *"complete one photographed reading"*, which
nobody had examined since it was written — and it made a whole reading a
trial requirement, which made the CHEAPEST vision model mandatory, which
is how a fabricating model came to be the recommendation. The rule now
reads: a trial demonstrates **one batch**.

> **A constraint nobody has re-derived can decide a quality question on
> its own.** It does not announce itself as a decision; it arrives as
> arithmetic, and the arithmetic is correct.

This is the `TYPICAL_SUMMARY_OUTPUT_TOKENS` lesson with the subject
changed. There, an unmeasured constant was setting the price of the
product. Here, an unexamined *rule* was choosing the model.

### The price, derived again

`MEASURED_PHOTO_BATCH_INPUT_TOKENS` is **4,234** — mini, four pages at
771x1024, `detail: "original"`, on the prompt that ships, from the run
above. At mini's published $0.75 / $4.50 per 1M:

```
4,234 × $0.75/1M  +  2,000 × $4.50/1M  =  $0.012176
$0.012176 / $0.000686 per credit       =  17.75  ->  18 credits
```

**A batch of four photographed pages is 18 credits; a 16-page reading is
74.** The weight covers its own cost at **0.986x** — the credits charged
are worth marginally more than the batch costs, which is the property
every other weight in `config.ts` has.

**THE HEADROOM IS A QUARTER OF WHAT IT WAS, and that is a live
constraint rather than trivia.** The weight holds for an input between
**4,005 and 4,918** tokens: 684 above the measured figure, against
nano's 2,317. mini's input is 3.75x dearer, so **the next edit to the
vision prompt can genuinely re-price the feature** — re-run
`scripts/measure-photo-prompt.mjs` and move the constant in the same
commit. `prompts.js` states the band and a test re-derives it.

### Every tier pays for itself at 100% photo usage

Worst case: every credit in the allowance spent on photographed pages.
AUD ex-GST, converted at 0.714 (September 2026).

| tier | batches | our cost | Apple 15% | Play/Stripe 30% |
|---|---|---|---|---|
| Study AI, monthly | 50 (200 pages) | $0.61 | +$4.35 (88%) | +$3.48 (85%) |
| Study AI, annual | 50 | $0.61 | +$3.07 (83%) | **+$2.42 (80%)** |
| Study AI Max, monthly | 166 (664 pages) | $2.03 | +$8.45 (81%) | +$6.60 (76%) |
| Study AI Max, annual | 166 | $2.03 | +$5.79 (74%) | **+$4.41 (68%)** |

Free is 3 batches, $0.041, once ever.

**It is a test, not a table.** `test-readings.mjs` re-derives all of it
from `model.ts`, `credits.ts`, `config.ts` and `site/pricing.js` and
fails naming the tier, the period and the store — and it asserts at a
**stressed FX of 0.50**, so it goes red when the product economics break
rather than when the currency moves. At 0.40 the worst margin is still
+$1.09.

### The student has to see which path is cheaper, before choosing

**Parts hid a sixfold difference.** Eight photographed pages and eight
pages of pasted text are both *"2 parts"*, and they cost **38 credits
and 8**. The "both numbers in parts, never units" rule was written when
a photo batch and a text chunk cost the same, so parts really were the
whole story; they are not, and a currency that cannot express a sixfold
difference has stopped hiding an internal weight and started hiding a
price. The banned word was always *units*. **Credits are sayable.**

So both estimates now carry credits, and `photoVsPasteLine()` renders at
the picker — before the first photo is added, because after it the
choice is made:

> Photographs cost 18 credits for every 4 pages. Pasting the text
> instead costs 3 credits for a section of up to 20,000 characters, so
> pasting is much cheaper where you can select the text. **A screenshot
> is an image, so it costs the same as a photograph.**

The screenshot sentence is there because it is the obvious thing to try
with a PDF open on a laptop, it *looks* cheaper because it is cleaner,
and it costs the same. The sentence deliberately does not convert pages
into characters: "a page is about 3,000 characters" is a modelled
constant of the kind this document exists to be suspicious of, and it
would put a made-up multiple on a screen. Both figures quoted are
ceilings the server enforces.

---

## 12.10 The prompt answer to 12.9's noise, and why one run cannot report it

The paragraph above predicted the noise was a prompt property. Three rules now
name the three defects — the layout hyphenation reaching the note, the repeated
term, and the fused claim — and `scripts/measure-photo-prompt.mjs` is what says
whether they worked.

**A SINGLE RUN OF THE NEW PROMPT WOULD PROVE NOTHING.** These defects are
intermittent: a model that produced `crunc(h)ers` once need not produce it
again, so a clean run after the change is as likely to be the model's day as
the prompt's doing. The instrument therefore runs the pair — the same model,
the same photographs, the same bytes, detail and ceiling, under the prompt in
the working tree and the prompt **at a git ref** — and it REFUSES when the two
prompts are identical, because a comparison between two identical things
reports success either way. That refusal is exercised by the suite in both
directions through a `--dry-run` that spends nothing.

**Two of the three defects are counted; the third cannot be.** An in-word
bracketed letter and a duplicate term are patterns. "Hopper was the first group
to be granted a PhD" is ordinary words in correct grammar, so it is printed for
a person to judge and the script says so rather than implying coverage it does
not have.

**And the control on the fix**: entries and words per section, both arms, on the
same page as the defect counts. Noise falling because the model said *less* is
the depth regression 12.9 warns about, not a fix.

### One loose end, with its bound

`MEASURED_PHOTO_BATCH_INPUT_TOKENS` (4,045) is a bill for one configuration and
the prompt is part of that configuration — it grew by roughly 200 tokens, so the
constant is now slightly low. **The weight does not move**: at the shipped rates
it is 5 credits for anything between 2,933 and 6,362 input tokens, which is
2,317 tokens of headroom. Those four numbers are re-derived by a test and
compared with the sentence in `prompts.js` rather than left as a comment. The
A/B prints the new count beside the recorded one, so the re-measure lands with
the next run.

---

## 13. The margin on an ACCOUNT, and the cap that bounds it

> **STATUS AFTER 12.9: THE LOSS THIS SECTION MEASURES NO LONGER EXISTS.**
> Everything below is true of the configuration that shipped until 16 September
> 2026 — `gpt-4o-mini` at maxEdge 1536, a batch costing 34 credits and charged
> 3 — and it is kept because it is the argument that justified the swap.
>
> With `gpt-5.4-nano` at a **derived** 5 credits against a measured 4.8, a
> batch is charged 1.0× what it costs, and **every tier, every period and every
> channel is profitable even when the entire allowance is spent on photos**:
>
> | | monthly | 6-month | annual |
> |---|---|---|---|
> | Study AI (Play 30%) | +$3.49 | +$2.81 | **+$2.43** |
> | Study AI Max (Play 30%) | +$6.64 | +$5.21 | **+$4.45** |
>
> There is no break-even to stay under: spending the whole allowance on photos
> is profitable, so the cap in 13.6 bounds nothing. **It is built and held
> unmerged as insurance against the swap being reverted**, not as pending work.

Sections 4 and 12 price an ACTION. This prices an ACCOUNT, which is the
question a per-tier loss is actually about: what a tier's whole allowance costs
us if it is spent on the one action that is under-charged, against what that
tier pays. Every figure is printed by `scripts/measure-cost-model.mjs` — section
13 of its output — which lifts the rates, the credit's value and the summarise
weight out of `_shared/credits.ts` and `ai-text/config.ts` and **imports the
tier table from `site/pricing.js`**, the same file the pricing page renders.

**It uses the SHIPPED rounding, and that is not a detail.** The preview
arithmetic earlier in that script uses `Math.ceil`; `creditsFor` rounds with a
floor of 1. A margin computed with the wrong rounding is a margin about a
product nobody sells.

### 13.1 The three assumptions that are not derived

| | value | why it is here |
|---|---|---|
| AUD → USD | 0.714 (14 September 2026) | prices are AUD, provider bills are USD |
| GST | one eleventh removed | Australian consumer prices INCLUDE 10% GST, which is remitted and is not revenue |
| Commission | **per channel**, below | one "store cut" was the wrong shape — they differ by a factor of ten |

**THE COMMISSION IS PER CHANNEL, and the first version of this section had it as
one number.** Corrected 16 September 2026:

| Channel | rate | status |
|---|---|---|
| Apple App Store | **15%** | Small Business Programme, **Jared is enrolled** |
| Google Play | 15% or 30% | the equivalent programme is a **separate enrolment** and is not confirmed here |
| Stripe, on the web | ~2.9% + A$0.30 | a payment fee, not a commission — and the flat fee is charged **per transaction**, so an annual plan pays it once rather than twelve times |

**Every bound here is read off Google Play at 30%, the worst channel in use.** Not
an average and not Apple's rate: the revenue mix at launch is unknown, and a bound
that only holds on the friendliest channel is not a bound. Stripe is the cheapest
of the three and never binds.

A figure that depends on an exchange rate has a half-life. That is why the
**break-even batch counts** below matter more than the dollar margins: they move
only when a price or an allowance does.

### 13.2 The loss is real, on every paid tier and every period

A credit is defined as **$0.000686**. One four-photo batch really costs
**$0.0233** — **34.0 credits** of real cost — and is charged **3**.
**An 11.3× under-charge**, which is section 4's "roughly 10×" measured exactly.

Every credit spent on photo batches, against net revenue:

| Tier | All-photos cost | What the price assumed | monthly | 6-month | annual |
|---|---|---|---|---|---|
| Free (60, once ever) | $0.47 | $0.04 | — | — | — |
| Study AI (900/mo) | $7.00 | $0.62 | **−$2.91** | **−$3.59** | **−$3.97** |
| Study AI Max (3000/mo) | $23.33 | $2.06 | **−$14.70** | **−$16.14** | **−$16.90** |

*(net of GST, at Google Play's standard 30%.)*

**AND THE COMMISSION DOES NOT CHANGE THE ANSWER, which is worth stating rather
than leaving as an absence.** At Apple's 15% the same losses are $2.04 / $2.86 /
$3.32 and $12.85 / $14.60 / $15.52; on Stripe, the cheapest channel, they are
$1.55 / $2.31 / $2.82 and $11.58 / $13.39 / $14.42. **Every tier, every period,
every channel is a loss**, and the reason it is insensitive is arithmetic rather
than luck: fifteen points of commission moves net revenue by about 21%, and the
gap being closed is **11.3×**. A commission correction cannot reach an
order-of-magnitude mispricing, and if it could, the mispricing would not be the
thing to fix.

**Free is not a problem and should not be treated as one.** 60 credits is 20
batches, $0.47, **once ever** — the trial's whole shape is what bounds it, which
is the argument `credits.ts` makes for the shape in the first place.

**The loss is a TAIL, not a typical case.** A student doing two eight-page
readings a month spends 4 batches — nine cents. The loss appears only near the
cap, which is exactly why a cap is the instrument: it bounds the tail without
touching anybody's ordinary month.

### 13.3 What a tier can absorb

Break-even, with the rest of the allowance at its nominal cost, at Play's 30%:

| Tier | monthly | 6-month | annual |
|---|---|---|---|
| Study AI | 162 batches (648 pages) | 131 (524) | **113 (452)** |
| Study AI Max | 308 (1,232) | 241 (964) | **205 (820)** |

The annual column is the binding one: it is the least revenue per month, so a cap
set under it holds for every period.

### 13.4 THE RECOMMENDATION — model and weight, one decision, unchanged

**`gpt-5.4-nano`, `detail: "original"`, `maxEdge` 1024, a batch weighted at 6
credits**, with `SUMMARY_MODEL` and `VISION_MODEL` split in `_shared/` first and
text and lectures left on `gpt-4o-mini`. That is section 12.7's recommendation
and re-deriving it changed nothing.

**Two of the three published rates it rests on have now been independently
reproduced** (15 September 2026): `gpt-4o-mini` at $0.15/$0.60, `gpt-5.4-mini` at
$0.75/$4.50 and `gpt-5.4-nano` at $0.20/$1.25 all match 12.1's table exactly.
OpenAI's own pages remain unreachable from this container — `platform.openai.com`
and `developers.openai.com` are both refused by the egress proxy — so this is a
second independent agreement rather than a reading at the source.

**IT DOES NOT CLOSE GATE 1, and the distinction is the whole reason gate 1
exists.** A published rate is what a token costs. Gate 1 asks **how many tokens
the API actually bills for our image**, and the report it exists to resolve is a
disagreement between the documented arithmetic and a real invoice. A rate and a
count are different claims; confirming one says nothing about the other.

**One thing about that report has narrowed, and it is not a resolution.** The
1920×1080 / ~66,000-token case is described as having been sent at
**`detail: "high"`** — the setting 12.3 recommends moving OFF, and the
recommended configuration is `original`. So the reported configuration is not the
recommended one. The thread itself is unreachable from here, no staff answer is
visible, and **nothing about our own numbers has been measured**, so this lowers
the prior and closes nothing. Gate 1 stands.

### 13.5 The model change CANNOT ship before launch, and the reason is structural

Both gates need a real `OPENAI_API_KEY` and **four photographs of a real page of
print** — a phone photo, not a screenshot, because the thing being tested is
whether a model can read a photograph. Neither exists in a build container, and
no amount of work here substitutes for either. `scripts/measure-photo-gates.mjs`
is the entire procedure and it is one command:

```
export OPENAI_API_KEY=sk-...
npm i --no-save sharp
node scripts/measure-photo-gates.mjs page1.jpg page2.jpg page3.jpg page4.jpg
```

It costs well under a cent at the documented rates, and a few cents if gate 1
fails — which is the point of running it.

### 13.6 SO: A PHOTO-BATCH CAP, DERIVED FROM THE TIER'S OWN ALLOWANCE

**15% of the tier's allowance, in batches**, applied to per-month tiers only:

| Tier | cap | pages a month | worst case (annual, Play 30%) |
|---|---|---|---|
| Study AI | 45 batches | 180 | **+$1.45** |
| Study AI Max | 150 batches | 600 | **+$1.19** |

Both stay profitable at the least generous period and the worst commission,
which is the property being bought. 180 pages a month is about eleven sixteen-page
readings; the cap is roughly **a third of break-even**, so it survives an
exchange-rate move that the dollar figures would not.

Five things about the shape, each of which is a rule this codebase already holds:

- **DERIVED, not a second table.** `floor(credits × PHOTO_CAP_FRACTION /
  PHOTO_BATCH_CREDITS)` follows the tier table, so a tier added or an allowance
  changed carries its own cap and there is no second list to keep in step.
- **PER-MONTH TIERS ONLY, and this falls out of `allowanceForTier`'s existing
  shape rather than needing a branch of its own.** 15% of the trial is 3 batches,
  which would stop a free account finishing a 16-page reading — the exact thing
  `credits.ts` says the trial has to be able to demonstrate. The trial is bounded
  once-ever at $0.47 and needs no cap.
- **The counter belongs beside `credits_used`** in `ai_usage`, keyed
  `(user_id, month)`, incremented in the same atomic RPC — the row is already
  being written, so it costs no extra query and inherits migration 0011's fix for
  the lost update.
- **The refusal is PRE-FLIGHT.** `sectionsAffordable` already exists for the
  variable-cost case; the cap folds into it, so a student is told before the work
  rather than halfway through a reading. A cap discovered mid-reading is the
  keep-what-was-charged rule doing its job over a refusal that should have come
  first.
- **The copy states the specific situation**, as the readings refusal already
  does: how many batches are left this month, and that pasted text is not capped —
  which is the one thing the student can act on, and is also the cheaper path we
  would rather they took.

### 13.7 WHAT IS DELIBERATELY NOT RECOMMENDED: re-weighting to 34

It is the honest number and it would make the feature unusable — a 16-page
reading becomes 138 credits, more than twice the whole free trial and 15% of a
Study AI month. Section 12.6 says this in as many words: *at an honest weight the
feature is unusable on this model.*

The argument 12.7 makes against re-weighting is that the model move is imminent,
and that argument is **weaker now** than when it was written, because the move is
gated on a measurement nobody has been able to take. It is not gone: 34 would be
a visible, user-facing number that is wrong by 5.7× in the other direction the
moment the model moves, and this project has a ledger of what visible wrong
numbers cost. The cap keeps the price honest for every ordinary month and bounds
the tail, which is what re-weighting was for.

**The cap is a bound, not a fix, and it should be removed when the model moves.**
Whatever ships should say so where somebody will read it, next to the constant.
