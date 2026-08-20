# What the AI features cost us

A measurement and planning document, 20 August 2026. It exists to unblock the
website pricing copy: nothing here is a feature, and only the two changes in
section 10 were on the table.

**One flag before anything else.** The brief said to run this *after the exposure
sweep*. No exposure sweep has been commissioned in this session or appears in the
repository, so either it is somewhere I cannot see or it has not happened. This
document does not depend on one — it is self-contained — but if a sweep was meant
to precede it, its findings have not been folded in.

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
**12× more**. This is the one finding that rests on a number I could not verify at
the source; section 11's second reading is designed to falsify it with a single
unmistakable figure.

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

**This is the number I am least able to stand behind, and I am saying so.** OpenAI's
own pages are blocked by this container's egress proxy. The 2,833 / 5,667 figures
are corroborated by three independent write-ups of the vision docs, including a
maintained open-source vision cost calculator that cites them and a widely-read
post whose entire subject is this exact quirk. That is strong, and it is not the
source. Section 11 is built to settle it.

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

### The levers, and the one that looks obvious is not a lever at all

**Sending smaller photos saves nothing.** This is worth spelling out because
"downscale harder" is the first thing anyone will reach for. Step 2 of the tiling
rule normalises the **shortest side to 768px** — in both directions, scaling small
images up as well as large ones down. A portrait A4 page therefore arrives at the
tiler as 768 × 1086 whatever it was sent at, which is always 2 × 3 = **6 tiles**.
Dropping `maxEdge` from 1536 to 1024, or to 768, changes the picture quality and
not the bill.

*(If OpenAI in fact does not upscale — the documented wording implies it does, and I
could not read the page to be sure — then **1024px** on the long edge gives 4 tiles
instead of 6 and saves 31% of the per-photo tokens, with 768px saving no more than
that. So the check is worth one glance at the docs: if upscaling is not applied,
there is a 31% saving available at a resolution where a photographed page is
probably still legible. The script prints both.)*

So there are two real levers:

- **Re-weight the photo batch.** At $0.0078 per billed unit against $0.0005–$0.0014
  for everything else, a weight of 3 is off by roughly 10×. A weight of **12** per
  batch would bring it into line and make a 16-page reading cost 49 units — a third
  of the AI tier's monthly text allowance, which is an honest thing to tell a
  student and is the shape `sectionsAffordable` already renders.
- **`detail: "low"`**, which is a flat 2,833 tokens per image — 13× cheaper — and is
  a 512 × 512 thumbnail. For a page of print that is a page of grey, exactly as the
  comment in `prompts.js` says. **Not a real option**, listed so nobody rediscovers
  it as one.

The honest third option is to send photos to a model whose image pricing is not
inverted, which is section 7's territory.

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

## 7. gpt-4o-mini's lifespan

**I could not confirm the brief's premise, and I think it may be wrong.** Both
`platform.openai.com` and `developers.openai.com` are blocked by this container's
egress proxy, so I could not read the deprecations page itself. What web search
returns, consistently across sources:

- **gpt-4o, gpt-4.1, gpt-4.1-mini and o4-mini** were retired from ChatGPT on 13
  February 2026, with API shutdowns reported around 16 February 2026.
- **gpt-4o-mini is repeatedly named as an exception with no sunset date**, alongside
  gpt-4o-mini-transcribe and gpt-4o-mini-tts.

**Jared: please read the deprecations page directly before anything is planned on
this.** If gpt-4o-mini genuinely carries a published sunset, the six-month notice
policy still applies and this is not urgent, but the migration below becomes real
work rather than a contingency.

### Pricing a replacement — I am declining to, and here is why

Third-party price aggregators disagree with each other by a factor of six on the
current mini-class model ($0.125/$1.00, $0.25/$2.00 and $0.75/$4.50 per 1M in/out
all appear, for models with confusingly similar names). Picking one and building a
migration budget on it would be the `TYPICAL_SUMMARY_OUTPUT_TOKENS` mistake again —
a constant nobody measured quietly setting the price of the product, at 5.9× reality.

What I will say without a number: **the successor generation is more expensive per
text token, plausibly 1.7×–7.5× on output.** Applied to the Typical scenario's
$0.397, even the top of that range is about $2/month/user — survivable, and it
would need to be reflected in the site copy.

**And it might make photos dramatically cheaper.** The 2,833/5,667 multiplier is
specific to gpt-4o-mini's unusually low text-token price. Newer models generally
price images closer to the gpt-4o ratio. So the migration that looks like a cost
increase for lectures could be a large cost *decrease* for readings. **That is the
first thing to price once the real rate table is in hand**, because it may make the
photo re-weighting in section 4 unnecessary.

### The model string, and how to stop it drifting

Two production occurrences plus one in a measurement script:

- `supabase/functions/ai-notes/openai.ts:97`
- `supabase/functions/ai-text/openai.ts:27`
- `scripts/measure-summary-depth.mjs:192`

This is not the unavoidable browser/Deno mirror. **Both are Deno functions in the
same repository, and `supabase/functions/ai-notes/_shared/` already exists.**
Recommendation: move `_shared/` up to `supabase/functions/_shared/model.ts`
exporting a single `SUMMARY_MODEL`, import it in both adapters, and have the
measurement script read it too. A model migration then touches one line, and a test
grepping for a bare `model: "` literal in either adapter keeps it that way.

### Prompt portability

**The prompts themselves are portable.** The depth rules are plain instructions
about specificity and not-inventing; nothing in them depends on model-specific
behaviour. The two structural risks are mechanical rather than linguistic:

- `ai-notes` uses `response_format: { type: "json_schema", strict: true }`;
  `ai-text` uses `json_object`. Both survive into the GPT-5 family, but strict
  schema support and its quirks (it still has no `minItems`, which is why depth is a
  prompt property here) need re-checking on whatever we land on.
- **`max_tokens` is the migration hazard.** The GPT-5 family takes
  `max_completion_tokens`, and reasoning tokens count toward that budget. Every
  ceiling in `ai-text/config.ts` and `SUMMARY_MAX_TOKENS` is sized against *visible*
  output. Ported unchanged, a reasoning model could spend the entire budget
  thinking and return `finish_reason: "length"` with nothing — which this code
  correctly treats as a hard failure, so it would fail loudly rather than truncate,
  but it would fail on every request. **Budget one re-measurement pass, not one
  find-and-replace.**

---

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

**The input token count is the whole experiment.** It is not a near-miss kind of
number:

- **~590,000 input tokens** — the 2,833/5,667 model is right, photos are the most
  expensive thing in the app, and section 4's remedies are live.
- **~20,000 input tokens** — the 85/170 model in `ai-text/config.ts` was right all
  along, a photo batch really does cost about what a text chunk costs, the weight of
  3 is correct, and **finding 1 at the top of this document is wrong and should be
  struck.**

There is no reading of the dashboard that lands between those two. That is
deliberate — a check that can only come back "roughly right" is not a check.

**If either total is out by more than 20%, stop and find out why before any of this
reaches the website.** The most likely culprits, in order: the summariser output
model (soft, flagged, affects lectures only), the image token model (binary,
flagged, affects photos only), and the 140 wpm speech-rate assumption (affects
summariser input by the same proportion it is wrong by, and lecture totals by about
a third of that).
