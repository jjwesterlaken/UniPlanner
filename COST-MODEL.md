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

| Action | Counter | Amount | Where the write happens |
|---|---|---|---|
| Recording a lecture | `ai_usage.minutes_used` | `max(provider-reported duration, 3)` | `ai-notes/index.ts` step 12 |
| Re-summarising one | `ai_usage.minutes_used` | flat **2** | `ai-notes/index.ts`, resummarise branch |
| Explain-it-back | `ai_usage.text_units_used` | 1 | `ai-text/index.ts:262` |
| Weak spots | `ai_usage.text_units_used` | 1 | same |
| Practice questions | `ai_usage.text_units_used` | 2 | same |
| Summarise a note / a text chunk / **a photo batch** | `ai_usage.text_units_used` | 3 | same |
| Merge | `ai_usage.text_units_used` | 1 | same |

**Nothing that calls a provider decrements nothing.** The brief's suspicion that
the four text features are unmetered is not the case — they meter against a
*different counter*, which is a design choice with its own section in CLAUDE.md
(minutes answer "how much lecture", units answer "how much text"), not an oversight.

**Both decrements happen server-side, in the Edge Function, on the service-role
client.** Neither is client-side and **a modified client cannot bypass either.**
Specifically: the client's `estimatedDurationSeconds` is used only for the
pre-flight guard; the billed figure comes from `result.durationSeconds`, reported
by Groq. That was deliberate — the comment at step 9 records that this used to fall
back to the client's number, so a crafted request could bill itself zero.

### Three holes, in descending order of what they cost

**(a) The re-summarise retry has no failure precondition.** Step 4b checks that the
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

**(b) The allowance read/write is not atomic, in either function.** Both do
`select … minutes_used` (or `text_units_used`), then `upsert { …: read + cost }`.
Two requests that overlap both read *N* and both write *N + cost*, so one of them
is free. This is what makes a cap not quite a cap. It is not a plausible accident
at 12 testers and it is a trivial script for anyone who wants it. The fix is one
statement: a Postgres function doing `update … set minutes_used = minutes_used + $1`
(or an insert-on-conflict-do-update with the same expression), so the increment
happens in the database rather than in the function's memory. Worth doing before
money is charged, not before the closed test.

**(c) The cap can be overshot by exactly one recording.** The pre-flight guard uses
the *client's* `estimatedDurationSeconds`. A client reporting 0 passes the guard at
299/300 minutes used, and then the honest post-hoc billing lands the account at 479.
The billing is correct; the ceiling is soft by one action. Bounded and acceptable
while `MAX_REQUEST_SECONDS` is 3 h, worth knowing when the cap becomes a paid
entitlement.

### The comparison the brief asked for: minutes charged vs real cost

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
