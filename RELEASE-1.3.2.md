# 1.3.2 — the list

Started 7 October 2026 (Sydney). A record of what is planned for 1.3.2 and
what gates it, not evidence of what has shipped.

| # | Item | State |
|---|---|---|
| 1 | One assessment record, Release B: convert on first edit | **Gated** — see below. Plan approved 7 October 2026 (RELEASE-1.3.1.md section 8) |
| 2 | Notes style profile | **Plan** — NOTES-STYLE-PROFILE.md. Needs the rating data 1.3.1 starts collecting, and a ruling on the consent wording flagged at the top of that file |

## 1. One assessment record, Release B

**THE GATE: iOS 1.3.1 live on the App Store for two weeks.** Release B
converts an assignment into an assessment on its first edit and tombstones
the assignment. A device still on 1.3.0 reads only `assignments` in Plan,
so on that device a converted assignment disappears from Plan — its data
survives (in `assessments`, which 1.3.0 shows in Grades), but it moves.
Release A (1.3.1) is what reads both, so B waits until 1.3.1 has been on
the store long enough for most devices to have it.

**The date:** two weeks after the day iOS 1.3.1 is approved and live.
**1.3.1 has not been submitted yet (7 October 2026), so the date is not
set.** When it goes live, write the date here as live + 14 days, and
nothing in Release B merges before it. There is no version telemetry to
gate on a share of devices; this is a date, and saying so is the point.
Android follows its own store on the same rule.

**What B does (the approved plan):**
- **Convert on first edit**, one record at a time, never in bulk on load
  (CLAUDE.md: a shape change converts lazily). An edit to an assignment
  writes it as an assessment with the same id plus the assignment-only
  fields (`requirements`, `notes`, `rubric`), and tombstones the
  assignment in the same write.
- **Linked pairs** (if any exist): the assessment absorbs the assignment's
  fields and records `formerAssignmentId`; step lookups check id or
  `formerAssignmentId`.
- **Unlinked look-alikes are never merged automatically.** Plan offers
  "These look like the same piece of work: combine?"; only a yes merges,
  and the assessment's id wins.
- **Late edits:** an older build editing an assignment after it was
  converted (its `updatedAt` newer than the conversion) is surfaced on the
  converted record with "fold in" / "keep", the archive's late-edit shape.

**Tests B ships with:** a step's `parentId` resolves after conversion;
essay-feedback ids untouched; no look-alike merges without a yes; a late
edit from an older build is surfaced, not swept; merging with a 1.3.0
device's blob loses nothing.
