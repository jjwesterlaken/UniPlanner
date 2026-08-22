# Three product plans

Plans, not builds. Written 20 August 2026, after the currency collapse
and the per-tier work, so every cost below is in credits — one credit is
one minute of recorded lecture.

**Sequencing, as ruled:** 1 and 2 before the AAB; 3 during the closed
test, as an update to the closed track.

Costs are computed by `scripts/measure-cost-model.mjs` and by the same
arithmetic `TASK_CREDITS` uses, so a ceiling change re-prices rather than
leaving a figure nobody re-derived.

---

## 1. Reading summary depth

### The diagnosis, and it is only half right

Summaries read thin, and `MAX_TOKENS.summarise = 2000` is the likely
cause — but it is not sufficient on its own, and this project has the
receipts on why.

**`ai-notes` had this exact problem and the ceiling was not what fixed
it.** Its output was "helpful and great, but shallower than I'd like"
and the cause was visible in the prompt: it named five sections and said
nothing about what belonged in them, so the model wrote headings.
Measured, the fix took **words per key point from 9 to 26 — +189% — while
the number of entries barely moved** (5 to 6). The ceiling never changed.

`ai-text`'s `summarise` prompt is in exactly the state `ai-notes`' was:

```
Summarise the student's own note into the same structure the app uses
for lecture notes. Schema: {...}. Draw only on the note.
```

That is a schema and one sentence. It says nothing about what a key
point contains, whether a term is defined as the author defined it, or
how much of a 16-page reading a "point" should cover. **Raising the
ceiling without fixing the prompt buys permission to be verbose, not
depth** — and we would pay for the tokens.

So: **do both, and expect the prompt to be the larger effect.**

### The output schema

The brief asks for headings, subheadings, key terms and bullets. One
constraint decides the shape: **the reading summariser writes into the
same note shape `ai-notes` produces** — that is deliberate and load-
bearing, because the whole storage path (stub, row, cache,
reconciliation) is reused rather than reimplemented for a second kind of
AI note. A different schema means a second kind of note.

So the proposal is to **deepen the existing five fields rather than add
a sixth**, exactly as `ai-notes` did:

| Field | Today | Proposed |
|---|---|---|
| `overview` | one sentence in practice | 3–5 sentences: what the reading argues and how it is organised |
| `keyPoints` | bare labels | one entry per distinct claim, **each a complete sentence or two carrying the reasoning, the evidence, and any names, dates or figures the text used** |
| `terms` | thin glosses | 8–15, **explained as the author explained them**, not from the model's own knowledge |
| `assessable` | rarely populated | what the text flags as central, quoted or closely paraphrased |
| `openQuestions` | invented to fill the section | only what the reading genuinely leaves unresolved; empty is correct |

**Subheadings and bullets are a RENDERING decision, not a schema one.**
`keyPoints` is already an array — that is the bullets. Grouping under
subheadings would need a sixth field and would touch every screen that
renders a note plus every note already saved. **Recommend against**
until somebody has read a deep summary and still wants grouping.

**"Do not pad" is load-bearing rather than decorative.** Told to go
deeper with nothing to be deep about, a model reliably inflates —
restating one claim in three registers, glossing terms from its own
knowledge. That is longer output at the same information content and the
student pays for the tokens. Every added rule is either *include what
the text actually says* or *do not invent*.

### Depth scaling with input length

Agreed, and it is a prompt property because **OpenAI's strict structured
output mode does not support `minItems`** — the schema cannot express
it. `ai-notes` does this with one clause and it works:

> "A fifty-minute lecture usually yields 12–20; a short recording yields
> few, and that is correct."

The reading equivalent, and it needs the model to know how much it is
looking at:

> "One entry per distinct claim the text develops. A chapter yields
> 12–20; two paragraphs yield two or three, and that is correct."

**One thing to get right:** a 16-page reading arrives as up to four
CHUNKS, each summarised alone and then merged. A chunk does not know it
is one of four. So the per-chunk prompt scales to the CHUNK, and it is
the **merge** that must not flatten four deep summaries into one thin
one — its ceiling matters as much as `summarise`'s, and its prompt
currently says "combine them into a single summary" with no depth
instruction at all.

### The cost, stated rather than assumed

At 20,000 characters in, on `gpt-4o-mini`:

| Output ceiling | Cost/call | Credits | A 16-page reading (4 + merge) |
|---|---|---|---|
| **2,000 (today)** | $0.00191 | **3** | **14 credits** |
| 3,000 | $0.00251 | 4 | 19 |
| **4,000 (proposed)** | $0.00311 | **5** | **24** |
| 6,000 | $0.00431 | 6 | 30 |
| 8,000 | $0.00551 | 8 | 39 |

**Recommend 4,000**, for both `summarise` and `merge`.

- It is `ai-notes`' 8,000 halved, and a chunk of reading is about half a
  lecture with no translation.
- A 16-page reading goes 14 → 24 credits. On a 900-credit month that is
  2.7% instead of 1.6% — immaterial. **On the 60-credit trial it is 40%
  of the whole thing**, which is the number that decides this, and it is
  survivable only because the trial's job is to demonstrate rather than
  to complete a semester.
- **It re-prices automatically.** `TASK_CREDITS` is derived from
  `MAX_TOKENS`, so changing the ceiling changes the weight in the same
  commit, and the mirror test fails until the client is updated too.

**The ceiling is a FAILURE when hit, not a truncation**, and that rule
does not change. Raising it to 4,000 reduces how often a deep summary
fails outright, which is a second and less obvious benefit: today a
genuinely dense chunk that wants 2,100 tokens does not get a shorter
summary, it gets `ai_failed_charged`.

### Is another model better here? Priced, not assumed

**No, on the model we run today — and the reason is the same one that
decided the photo path.** These tasks are output-dominated, and the
newer models are more expensive per output token:

| Model | 2,000 out | 4,000 out |
|---|---|---|
| `gpt-4o-mini` | $0.00120 | $0.00240 |
| `gpt-5.4-nano` | $0.00250 | $0.00500 |
| `gpt-5.4-mini` | $0.00900 | $0.01800 |

At the proposed 4,000-token ceiling, `gpt-5.4-mini` makes a text chunk
**7.5× dearer**, which would take a 16-page reading past 100 credits.
`gpt-5.4-nano` is 2×.

**What is NOT settled is quality**, and this is where I refuse to guess:
whether a bigger model writes a better summary from the same prompt is a
judgement about output, not arithmetic. The honest answer is the same
shape as the photo gates.

**`scripts/measure-summary-depth.mjs` is the instrument and needs one
change** — it currently builds the ai-notes prompt from `openai.ts` and
compares two git refs. Extend it to (a) take an `ai-text` `summarise`
prompt, (b) take a model as an argument, and (c) report words-per-key-
point, which is the column that says whether depth landed *in* the
sections rather than beside them. Then run: today's prompt at 2,000,
the deep prompt at 2,000, the deep prompt at 4,000, and the deep prompt
at 4,000 on nano. Four calls, a few cents.

**Do not raise the ceiling and change the model in the same step.** If
the summaries get better, nobody will know which did it.

### Order of work

1. Extend `measure-summary-depth.mjs` (model argument, ai-text prompt,
   words-per-entry).
2. Write the deep prompt for `summarise`, and a depth instruction for
   `merge`. Measure at the current ceiling. **This alone may be enough**
   — it was for `ai-notes`.
3. Only if the measured output is hitting 2,000: raise both ceilings to
   4,000, in the same commit as the client mirror.
4. Model comparison last, and separately.

---

## 2. AI output language

### Scope, and what it is not

A setting for the language AI output is written in, applied to:
lecture summaries, practice questions, explain-it-back feedback, and
reading summaries. **Prompt-level only.**

**Explicitly NOT UI internationalisation.** No interface strings are
translated, no locale files, no RTL layout work. That is deferred
indefinitely and this plan must not become a first step toward it — the
distinction to hold is that the app speaks English *about* your notes,
and your notes come back in your language.

### What already exists, and what it teaches

`ai-notes` **already translates**, and the design is right to copy
wholesale:

- `TRANSLATION_CODES` is an **allowlist**, not a hint. `translateTo` is
  interpolated into the system prompt, so an arbitrary string is both an
  unbounded output cost and free text in a prompt. Ten languages today:
  zh, hi, ne, vi, bn, id, ko, th, es, ar.
- It is **one call, not two**. The summariser produces `original` and
  `translated` in one response, so translation costs extra output length
  rather than a second round trip.
- Unknown codes become "no translation" rather than reaching the prompt.

### The design

**One setting, device-local or synced?** **Synced**, in the blob's
`settings` — unlike the theme and the audio device, which are
per-device by design, the language you want notes in is a property of
you, not of the laptop you are on. It rides the ordinary per-item merge.

**The four features differ in one important way**, and it decides the
shape:

| Feature | Today | With a language setting |
|---|---|---|
| Lecture summary | `original` + optional `translated` | the SETTING becomes the default for `translateTo`; the per-recording picker stays |
| Reading summary | English only | one output, in the setting's language |
| Practice questions | English only | one output, in the setting's language |
| Explain-it-back | English only | **see below — this one is different** |

**Explain-it-back is the exception and must be thought about.** The
student writes an explanation *in some language* and the model marks it.
Forcing the feedback into a set language when the student wrote in
another is worse than useless — and the reverse (always answering in the
student's language) is what they actually want. **Recommend: for
explain-it-back, instruct the model to answer in the language the
STUDENT wrote in**, ignoring the setting. That is a prompt clause, not a
setting, and it is more robust than any detection we would write.

**Do not add a `translated` field to the text tasks.** `ai-notes` has
one because a lecture is delivered in one language and the student may
want both. A reading summary in the student's language is just the
summary. One output, one schema, no storage change.

### The token cost, and it does change the credit maths

**CJK output is roughly one token per character**, against ~4.2
characters per token for English. For a fixed *token* ceiling that means
CJK output is about **72% as much text** as English at the same price —
so the cost does not rise, the OUTPUT SHRINKS.

At the current 2,000-token ceiling:

| | Roughly |
|---|---|
| English | ~1,530 words |
| Chinese / Japanese / Korean | ~2,000 characters |

2,000 Chinese characters is a substantial summary, so this is not fatal
— but **combined with the depth work in plan 1 it is the case most
likely to hit the ceiling**, and hitting it is a hard failure that is
still billed. Two consequences:

- **If plan 1 raises the ceiling to 4,000, that is the number that makes
  CJK safe**, and it should be stated as part of the reason rather than
  discovered afterwards.
- **The pre-flight estimate does not change.** Credits are derived from
  the ceiling, not from actual output, so a CJK summary costs the same
  credits as an English one. That is the right answer — charging more
  for writing in Chinese is indefensible — and it is what a
  ceiling-derived weight gives us for free.

Languages with longer words than English (German, Finnish) run slightly
*more* tokens per unit of meaning; the effect is small (~10–15%) and in
the same direction as CJK's saving, so the ceiling covers both.

### Which languages

**Start with the ten `ai-notes` already allowlists**, plus the obvious
European additions the lecture path did not need: fr, de, pt, ru, ja,
tr. Sixteen total. The constraint is not the model — it handles far more
— it is that **every code is a promise we cannot verify**. We have no
way to check the Nepali output is good.

**Recommend saying so in the UI**: the picker offers the languages, and
one line notes that quality varies by language. That is honest and it
is what every translation feature ought to say.

### Cost of the work

Small. One setting, one allowlist shared between the two functions
(`_shared/` — it is already the mirror problem, and `TRANSLATION_CODES`
is currently duplicated between the Edge Function and
`aiNotesLogic.js`), one clause per prompt, and the explain-it-back
exception. No schema change, no storage change, no migration.

---

## 3. File upload for reading summaries

### The economics first, because they justify the work

| Route | Input tokens/page | A 16-page reading |
|---|---|---|
| **Photographed** (today, `gpt-4o-mini`) | 36,835 | **~138 credits** |
| **Extracted text** | ~905 | **~14 credits** |

**ONE CORRECTION TO THE BRIEF'S FIGURE, and it does not weaken the
case.** Extracted text is **41× cheaper in INPUT TOKENS** — a page of
print is ~3,800 characters, ~905 tokens, against 36,835 for the same
page as an image. But a whole reading is **~10× cheaper in CREDITS**,
not 40×, because the OUTPUT ceiling is identical either way and output
is four times the price of input. Sixteen pages: 138 credits
photographed, 14 extracted.

Ten times is still the largest single saving available anywhere in this
app, and it is worth being exact about because the same confusion —
assuming input dominates — is what made the photo model look 5× better
than it is (COST-MODEL 12). **Output price is the thing that keeps being
underestimated here.**

This does not shave the most expensive path in the app — **it routes
users off it entirely**, and it does so for the *most common* case,
because a reading a student was given is usually a PDF before it is ever
a photograph.

Two consequences for the credit model:

- **The photo weight matters less than COST-MODEL 12.6 implies.** If
  most readings arrive as files, the held photo weight prices a fallback
  rather than the main path. It does not change the model decision —
  photos are still the expensive path when used — but it lowers the
  urgency.
- **A 16-page reading at 14 credits fits inside the 60-credit trial.**
  That is the plan-1 argument in reverse: today a free student cannot
  complete one photographed reading, and with extraction they can
  complete four. At plan 1's proposed 4,000-token ceiling it is 24
  credits and they can complete two — which is the interaction between
  these two plans, and the reason to state both numbers now rather than
  discover the collision later.

### Extraction, client-side

**Client-side, and this is not a performance choice.** The whole
copyright posture rests on "the student supplies a piece at a time, of
material they already have, which is relayed and never stored". A file
uploaded to a server is stored, however briefly, and `ai-text` **has no
storage client at all** — a test pins that, because the day someone adds
`.storage` there the policy and the consent both become false.

Extracting in the browser keeps the existing shape exactly: what leaves
the device is text in a request body, indistinguishable from a paste.

| Format | Library | Notes |
|---|---|---|
| `.txt`, `.md` | none | `File.text()`. Markdown goes through as-is; the model reads it fine. |
| `.pdf` | `pdfjs-dist` | Text layer only. **No OCR.** ~350 KB gzipped — the single real cost of this feature. |
| `.docx` | `mammoth` or a zip+XML read | docx is a zip of XML; `word/document.xml` text nodes are enough. ~40 KB, or hand-rolled with `DecompressionStream` for zero dependency. |

**Bundle size is the thing to weigh.** `app.js` is 615 KB today.
`pdfjs-dist` is the biggest single addition this app has ever
considered. **Recommend lazy-loading it** — `import()` on first PDF
selected, not at startup — so a student who never opens a PDF never
downloads it, and the service worker caches it after first use.

### The routing rule, and the number that decides it

> Extract client-side; fall back to the vision path only when
> extraction yields little text.

**"Little" needs a threshold and it must be per page, not per document.**
A 40-page PDF with a 3-page scanned appendix should extract 37 pages and
not fall back wholesale.

Proposed: **fewer than 100 characters of extracted text per page** reads
as "no text layer". A genuinely sparse page (a full-page figure with a
caption) trips it, which is the safe direction — it gets photographed
instead, and a figure is what the vision path is for.

**The fallback is not automatic and must not be.** Falling straight from
"free-ish extraction" to "the most expensive action in the app" without
saying so would spend 40× a student's expectation. **The student is
shown the choice**, with both costs in credits, using the existing
pre-flight estimate. That is the same rule readings already follow:
the estimate is mandatory because the cost is variable and nothing else
on screen hints at it.

**And the vision fallback needs page images, which a PDF does not hand
you.** `pdfjs-dist` can render a page to a canvas, which is then the
existing `downscalePhoto` path — so the fallback reuses everything and
adds no second pipeline. For `.docx` there is nothing to render; a docx
with no text is a docx of images, and the honest answer is "we can't
read this file — try photographing the pages", not a silent failure.

### The failure cases, each with a decided answer

| Case | Answer |
|---|---|
| **Encrypted / password-protected PDF** | `pdfjs` throws `PasswordException`. Ask for the password? **No.** Say the file is protected and suggest exporting an unprotected copy. Accepting passwords means handling them, and there is no version of that worth building here. |
| **Scanned PDF, no text layer** | The per-page rule fires. Offer the vision path **with the cost stated**, per page, so a 40-page scan is visibly unaffordable rather than silently expensive. |
| **Corrupt / not really a PDF** | `pdfjs` throws `InvalidPDFException`. One message naming the file. Never a generic failure — a student who renamed a `.doc` to `.pdf` needs to know that is what happened. |
| **Enormous file** | Cap at **25 MB**, refused before anything is read. That is comfortably above a scanned chapter and below what will lock up a phone. The cap is on the FILE; the existing `READING_MAX_CHARS` still caps the extracted text, and a 900-page book hits it and is refused with a number. |
| **Extraction succeeds but produces garbage** (ligature soup, two-column jumble) | **The known limitation with no clean fix.** Two-column PDFs extract in reading order sometimes and in column order others. Mitigation: show the student the first ~500 characters of what was extracted before spending anything, with "does this look right?". Cheap, honest, and the only reliable detector is a human. |
| **DRM'd EPUB, `.pages`, `.odt`** | Out of scope. Named so nobody adds one format at a time. |

### What does NOT change

- **No storage, client or server.** The extracted text goes into the
  same request body a paste goes into, is never written anywhere, and
  the file never leaves the device.
- **No new consent version.** Consent v6 already covers "text and audio
  and images the student supplies, of whatever origin". A PDF the
  student already has is that category exactly, and the extracted text
  is *less* than what a photo of the same page sends. **A bump is for a
  change in what happens to the content**, and nothing here changes it.
- **The wording rule.** Every string describes study, never
  substitution. "Summarise a reading to revise it", never "skip the
  reading" — and a file picker makes that temptation stronger, not
  weaker. `scripts/test-readings.mjs` greps for it.

### Why it belongs in the closed test rather than before the AAB

It is the largest of the three by some distance — a new dependency, a
new extraction path, a fallback with a threshold, and six failure cases
— and none of it blocks a first submission. It is also the one that most
benefits from real users: **what we cannot predict is what students
actually upload**, and a fortnight of twelve testers uploading their
real course PDFs answers the two-column question better than any amount
of arguing about it here.
