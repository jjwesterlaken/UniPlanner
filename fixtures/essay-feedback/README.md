# The synthetic pair — a fixture, not evidence

`essay.txt` and `rubric.txt` exist so the mechanism can be exercised
on text that **may be shown**. The ASAP corpus cannot be: its licence
forbids redistributing the essays, so every run over it is redacted,
and when something looks wrong in a redacted run there is nothing to
look at. This pair is the one you can run with `--show-text`.

```
node scripts/measure-two-arm.mjs \
  --essay fixtures/essay-feedback/essay.txt \
  --rubric fixtures/essay-feedback/rubric.txt \
  --runs 3 --show-text
```

## READ THIS BEFORE QUOTING ANY NUMBER FROM IT

**I wrote the deficiency enum, this essay, and the checker.** That is a
closed loop, and a number from it flatters the mechanism by
construction: I planted the kinds of fault my own enum has names for.
It cannot tell you whether the enum covers the faults real essays
have, whether a real model finds them, or whether the feedback is any
good.

**The 32 ASAP essays are the measurement.** They were written by
people who had never heard of this schema, which is the only property
that matters here. This pair is for driving the machinery and for
reading actual output when a redacted run raises a question.

## What is planted, and where

Ground truth, so a run can be read for recall rather than vibes. The
enum value each maps to is named where one applies.

| # | fault | enum value | where |
|---|---|---|---|
| 1 | The thesis is asserted as "the single most important cause" and then contradicted in ¶4, which concedes the connection "has sometimes been overstated" — and ¶6 returns to the original claim as though ¶4 had not happened | `contradiction` | ¶1, ¶4, ¶6 |
| 2 | "Historians agree that this was the decisive break" — no historian named, and the claim is false of the field | `unsupported-generalisation` | ¶2 |
| 3 | "modernity" carries weight and is never defined | `undefined-term` | ¶2 |
| 4 | "over four thousand separate acts" and "Something like six million acres" — figures with no source, one of them hedged | `claim-without-evidence` | ¶1, ¶2 |
| 5 | "the English working class was present at its own making" is Thompson, unattributed and unmarked | `unattributed-source` | ¶9 |
| 6 | ¶6 restates ¶1's claim almost exactly | `repetition` | ¶1, ¶6 |
| 7 | The landscape paragraph and the poor-law paragraph are tangents the argument never uses | `unclear-relevance` | ¶5, ¶7 |
| 8 | "A further point concerns the poor law" — a bolt-on with no connection to what precedes it | `structure-unsignposted` | ¶7 |
| 9 | ¶4 raises the strongest counter-argument and then abandons it rather than answering | `missing-counterargument` | ¶4 |

## And what is planted that the enum has NO value for

This is the more interesting half, and it is deliberate. A model with
a closed set and a fault outside it can do three things, all
informative:

- use `off-criterion`, which is the honest answer and what that value
  exists for;
- invent a value, which the checker refuses as `deficiency-unknown`
  and which tells us the enum is too narrow;
- say nothing, which tells us the same thing more quietly.

The faults with no enum value:

- **The rubric asks for 2,000 words and the essay is ~500.** The single
  largest problem with this submission, and no value names it.
- **No referencing apparatus at all** — no footnotes, no bibliography,
  where the rubric asks for attribution. Partly covered by
  `unattributed-source`, not wholly.
- **"The irony is considerable"** and similar — vague expression the
  rubric's EXPRESSION band would mark down, with nothing to call it.

If the constrained arm handles these by inventing values, the enum
needs widening before anything ships. That is a finding this fixture
**can** produce honestly, because it is about the schema rather than
about the essay.

## What it cannot answer

Whether the feedback is worth 3 credits. That needs a real marked
essay with its criteria, read by a person beside the mark it actually
received — recorded as OPEN in ESSAY-FEEDBACK.md, to be answered
before the feature ships to students and not before the mechanism is
measured.
