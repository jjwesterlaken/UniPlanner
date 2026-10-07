# Decisions

Closed decisions, one entry each, newest first. An entry records what
was decided, who decided it, the numbers it rests on, and **what would
reopen it**. It is a record, not evidence: when a number in an entry
matters again, re-derive it from the file it names.

Earlier rulings live in the documents they shaped (CLAUDE.md,
COST-MODEL.md, BILLING-PLAN.md, ESSAY-FEEDBACK.md). This file starts on
7 October 2026; nothing has been moved into it.

---

## 7 October 2026 — short recordings are charged below cost, and that stands

**Ruled by Jared.** No pricing change, no consent change.

**What is true.** A recorded lecture of *m* minutes costs
`m × $0.0006667 + $0.0009618` (transcription per minute, plus one
summary whatever the length) and is charged `max(m, 3)` credits at
$0.0006859 each (`_shared/credits.ts`; `billedCredits` in
`ai-notes/guards.js`, exact minutes, floor of 3). The credit is defined
so that a 50-minute lecture breaks even. So every recording between
**1.64 and 50 minutes** is charged below its modelled cost:

| Recording | Charged | Modelled cost | Charged ÷ cost |
|---|---|---|---|
| 1 min | 3 credits | 2.37 credits | 1.26 |
| 3 min | 3 credits | 4.32 credits | **0.69** (worst) |
| 10 min | 10 credits | 11.12 credits | 0.90 |
| 50 min | 50 credits | 50.00 credits | 1.00 |
| 120 min | 120 credits | 118.04 credits | 1.02 |

The worst case, 3 minutes, is $0.00090 short. That is under a tenth
of a cent per recording.

**Why it stands.** The absolute amount is a fraction of a cent per
recording, and the subscription price carries it. Every tier is
asserted to pay for itself in `test-readings.mjs`.

**What would reopen it.** The `recording_lengths` block of
`supabase/checks/ai-cost-weekly.sql` showing short recordings
dominating: most of a week's recordings in the first two buckets
(charged 3, or over 3 and under 50 minutes). That block was added with
this entry, because `ai_task_costs` (0024) records `ai-text` only and
could not have shown a lecture at all. It reads `minutes_billed` from
`ai_notes_requests` and nothing else on that row.

**Derivation in full:** NOTES-STYLE-PROFILE.md, "What it costs".
