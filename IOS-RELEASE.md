# iOS submission readiness, audited against the tree

Audited at `4809a5f` (main). Every PASS cites the line that makes it
true, not the intention — with one honest caveat stated up front:
`mobile/ios/` is generated per machine and does not exist in this
tree, so for anything living in the Xcode project the tree's evidence
is the SCRIPT that writes it plus the test that pins the script, and
the last step is reading the generated project on the Mac. Those rows
say so rather than claiming more than the tree can.

**Nothing is unmerged.** `origin/main..origin/claude/uni-planner-handoff-rw4yac`
is empty and the working tree is clean. Two things are unfinished BY
DESIGN and ship safely (§5), and one build-time check gates the cut
(§4, first row).

## Submission record

| Version | Build | Commit | Submitted (Sydney) | Status |
|---|---|---|---|---|
| 1.3.0 | 3543343 | `e78acd7` | 27 September 2026 | **In review** — awaiting Apple |

**1.3.0 was built from `e78acd7`, not the tip of `main`.** `main` moved
on to `82dd43e` (#162) after Grace's build, and that commit changes a
test only (`test-blocks-neutral` waits for the save indicator to
settle), so the web bundle and build id (`bc8d90c1321a`) are identical
and nothing in the submitted binary differs from what production
serves. A rejection fix branches from `main` as usual; what Apple is
reviewing is `e78acd7`.

The row is a RECORD of the submission, not evidence of the store's
state (see CLAUDE.md, *A document is a claim about the artifact*):
when a date or a plan depends on whether 1.3.0 is live, look at App
Store Connect rather than this table.

---

## 1. The asked items

| # | Item | Verdict |
|---|---|---|
| 1 | Account deletion in-app (5.1.1(v)) | **PASS** |
| 2 | `NSMicrophoneUsageDescription` | **PASS**, accuracy tested |
| 3 | `NSCameraUsageDescription` | **PASS** |
| 4 | `NSPhotoLibraryUsageDescription` | **PASS** |
| 5 | `ITSAppUsesNonExemptEncryption` | **PASS** (`<false/>`, boolean element pinned) |
| 6 | `PrivacyInfo.xcprivacy` in the target | **HUMAN STEP** — file written, target membership is Xcode work, warned on by the stamp |
| 7 | Review (demo) account | **HUMAN STEP** — and use a dedicated account, not the e2e one |
| 8 | App Privacy questionnaire | **MAPPED** in §3, with one judgement call flagged |

### 1. Account deletion — WAS A FALSE PASS; now gated on a live check

**This section said PASS on 1 September 2026 and was wrong.** On 5
September Jared queried `pg_proc` on the production project and found
`public.delete_my_account_data` and no `public.delete_my_account` — so
`rpc("delete_my_account")` failed, in-app deletion deleted nothing
server-side, and the store requirement this section certifies was not
met. Migration 0016 repairs it.

**How the PASS was reached, because the method is the defect:** the
evidence below is file-and-line citations into a migration FILE, and
the claim being made is about a DATABASE. Every line quoted was
accurate; none of it was evidence for the thing asserted. That is the
artifact rule in CLAUDE.md, in the place it costs most — a submission
readiness audit — and the audit's own promise was "pass/fail with the
evidence — the file and line, not the intention", which a file and line
cannot deliver for a claim about server state.

**Dates here are Sydney (AEST, UTC+10 in September)** and are anchored
to commit timestamps rather than memory: the false PASS shipped in
`61be13d`, the absence was found and diagnosed on the day of `a457637`,
the first apply rolled back on the day of `30b4d7c`, and the live
verification is recorded in `6c887b9`. Re-check any of them with
`TZ=Australia/Sydney git show -s --format=%cd <sha>`.

**This section may not read PASS again on file evidence.** It is PASS
only when `supabase/checks/verify-account-deletion.sql` returns ALL
PASS against the production project AND the end-to-end run in
`supabase/checks/verify-deletion-end-to-end.sql` has been done on a
throwaway account, both dated here.

- Live check last run: **6 September 2026** — `verify-account-deletion.sql`
  against `kuhtogvewcooigudmgwj` returned 12 rows, every property PASS,
  verdict ALL PASS, 11 properties checked. That includes both
  *anon may NOT execute* rows, which were failing beforehand: migration
  0016 applied without raising, the revoke took, and the pre-existing
  0002 exposure (anon holding EXECUTE on both deletion functions via
  Supabase's function default privileges) is closed.
- End-to-end run: **NOT YET RUN** — do this before submitting, on a
  throwaway account, following
  `supabase/checks/verify-deletion-end-to-end.sql`. The live check
  proves the function exists with the right properties; only this proves
  a real account and its rows actually go.

**The iOS archive is unaffected.** The repair was server-side only — no
migration changes a byte of the bundle — so **build 1.0.0 (3509882)
stands and does not need rebuilding.** What changed is the database the
shipped client was already calling: `rpc("delete_my_account")` now
resolves where before it did not.

- The flow (client half, which was never in doubt):
  `src/accountDeletion.js:87` (`deleteAccount`) removes the
  account's own audio objects, then `:96` calls
  `rpc("delete_my_account")` — the name that was missing server-side.
- Reachable in-app: `src/PlannerApp.jsx:5263`, behind a typed
  confirmation phrase (`:4116`).
- Guarded against regression: `scripts/test-migrations.mjs:1453`
  asserts deletion really clears the trial counter — i.e. the deletion
  is total, and nobody later "fixes" the trial-reset hole by retaining
  data after a deletion request.

### 2–4. The three usage strings — PASS

All three are constants in `mobile/scripts/native-permissions.mjs`,
applied to the generated plist after every `cap add`/`cap sync` and
verified structurally by `scripts/test-ai-notes.mjs:1388`, which runs
the REAL `applyNativePermissions` over a fixture plist and parses the
result — every key in the root dict, every value the right element
type.

| Key | Declared at | String at |
|---|---|---|
| `NSMicrophoneUsageDescription` | `native-permissions.mjs:48` | `:43` |
| `NSCameraUsageDescription` | `:67` | `:63` |
| `NSPhotoLibraryUsageDescription` | `:90` | `:86` |

**Accuracy is tested, not asserted:**

- The mic string's promise ("deleted as soon as it has been
  transcribed") is pinned to the SAME phrase in the in-app consent by
  `scripts/test-ai-notes.mjs:1561` — if either rewording drifts, one
  of the two dialogs is misleading and the suite goes red. The same
  test forbids the string implying the transcript is deleted (it is
  kept 7/30 days) and requires it to say what the mic is FOR, which
  Apple rejects the absence of.
- The camera and photo-library strings say photos "are not stored by
  us", which is pinned by `scripts/test-readings.mjs:552`: the
  `ai-text` endpoint has no storage client at all.

### 5. `ITSAppUsesNonExemptEncryption` — PASS

`native-permissions.mjs:102–103`, written as a plist **boolean
element**. The test (`test-ai-notes.mjs:1388` block) asserts the value
node's tag name is `false` — because `<string>false</string>` is a
non-empty string and reads as TRUE, which would declare non-exempt
encryption we don't have. Effect: no export-compliance prompt per
upload. HTTPS-only is the exempt case.

### 6. `PrivacyInfo.xcprivacy` — HUMAN STEP, warned on

- The file is written by `npm run stamp`
  (`scripts/stamp-native.mjs:170`), content at `:99` — all four keys
  empty and `NSPrivacyTracking` `<false/>`, matching what Capacitor
  8.5.0 ships for its own pod (checked against the real tarball; its
  Swift calls no required-reason API). `test-ai-notes.mjs:914` parses
  it and checks each claim.
- **What the tree cannot do:** put the file in the App target's
  Resources build phase — that is pbxproj surgery, done once per
  `cap add ios` in Xcode (drag into the App group, tick the App
  target). `stamp-native.mjs:230–233` **warns** whenever the pbxproj
  does not reference the file, so the half-done state — file on disk,
  absent from the bundle — is caught on the machine that matters.
  **On the Mac: re-run `npm run stamp` after the drag and confirm the
  warning is gone.** Build 3494152 shipped with this done, so the
  step is known-doable; it just has to be redone if the project is
  regenerated.

### 7. The review account — HUMAN STEP, with a correction to earlier advice

The AI features require a session: `AiNotesPanel` refuses without one,
and the boundaries refuse on their own
(`src/aiNotesClient.js:212,254`, `src/aiTextClient.js:68`). So App
Store Connect → App Review Information → **Sign-in required**, with
working credentials, or the reviewer sees none of the paid feature.

**THE STANDING REVIEWER ACCOUNT — decided.** One dedicated account,
free tier, seeded once, **never touched by CI**, serving **both Apple
review and Play review** — which retires the pause-CI-during-review
workaround permanently. The e2e account was the wrong tool because it
resets to seed at the start of every run (`e2e/helpers.mjs:12–13`),
and an Apple review can span days.

**The tier: leave it FREE. The trial credits suffice, with real
margin.** Every gated action, costed from `TASK_CREDITS`
(`src/aiTextLimits.js:38`) and `MINIMUM_BILLED_CREDITS`
(`src/aiNotesLogic.js:215`):

| Action | Credits |
|---|---|
| record a short lecture | 3 (the minimum) |
| summarise a short pasted reading (1 chunk) | 3 |
| photograph pages (one batch of ≤4) | 3 |
| summarise a note | 3 |
| practice questions | 2 |
| explain-it-back | 1 |
| weak spots | 1 |
| **one full pass over everything** | **16** |

Against the 60-credit trial that is nearly four complete passes, which
covers both stores' reviews and a rejection cycle. If it ever drains,
reset `trial_credits_used` on that row in the dashboard rather than
changing the tier — the counter is documented as "never reset by
anything but a human", and this is the human case. **Keeping it free
is also the point**: the reviewer then sees the trial's own copy —
the once-ever wording, the pre-flight estimates, the upgrade pitch —
exactly as the students they are protecting will.

**The seed, beyond a course, two assignments, a note and a study
card:**

- **A reading row** (week + pages). Without one, Summarise-a-reading
  is UNREACHABLE — the panel lives on the reading row, the same shape
  as the rubric panel, and there is no other way in.
- **Assessment weights and an exam with a date**, so Grades answers
  its question and the exam countdown/plan renders rather than showing
  preconditions.
- **Six study cards rather than one** — six is `DEFAULT_CARDS_SELECTED`,
  and practice over one card is a degenerate screen.
- **One practice run with a couple of deliberate misses**, so Weak
  Spots has history to show instead of its empty state.
- **Leave AI consent UNACCEPTED.** The reviewer should meet the
  consent gate — it is the flow Apple most wants to see working, and
  it is one tap.

In App Review notes, say the planner works fully signed out and the
account is only needed for the AI features — true, tested
(`test-local-only.mjs`), and it frames the sign-in requirement as
scoped rather than as a wall.

---

## 3. Apple's App Privacy questionnaire, mapped from ANDROID-RELEASE.md §2

Same facts, Apple's taxonomy. "Linked to you" is yes throughout
because everything is keyed to the account; nothing is used for
tracking, and there is no third-party SDK to disagree
(`test-local-only.mjs` proves zero outbound calls signed out).

| Apple category → type | Collected? | Linked | Tracking | Purpose |
|---|---|---|---|---|
| Contact Info → **Email Address** | Yes | Yes | No | App Functionality |
| Identifiers → **User ID** | Yes | Yes | No | App Functionality |
| User Content → **Audio Data** | Yes | Yes | No | App Functionality |
| User Content → **Other User Content** (courses, notes, cards…) | Yes | Yes | No | App Functionality |
| User Content → **Photos or Videos** | **see below** | — | No | App Functionality |
| Diagnostics → **Crash Data** | Yes | Yes* | No | App Functionality |

\* Crash rows carry `user_id` when signed in and null when not
(migration 0010); Apple has no partial option, so declare linked — the
conservative direction, same call as on Play.

**PURCHASES: FLIPPED FOR 1.1.0, and this is one of the two console
answers that must change before the version with subscriptions is
submitted.** 1.0.0 declared Purchases NOT collected and that was true —
there was no billing in the app at all. Phase 2 of BILLING-PLAN.md
shipped the client half, so 1.1.0 declares **Purchases: collected,
LINKED to identity, NOT used for tracking.** Linked because the
RevenueCat app user id IS the Supabase user id, deliberately — an
anonymous id would attach a purchase to an account we do not have (see
`billing-webhook`'s `no_account` path), so the link is a design
decision rather than an accident, and declaring it is the honest
answer. **Do not flip this until the build being submitted actually
contains the SDK**; a declaration ahead of the binary is as wrong as
one behind it.

`PrivacyInfo.xcprivacy` (tracking: none) stays TRUE, provided Apple
Search Ads attribution is never enabled on the RevenueCat SDK. It is
off by default and nothing in `src/purchases.js` turns it on.

**Still declared as NOT collected**, flatly: Location, Financial Info,
Health & Fitness, Contacts, Browsing History, Search History,
**Usage Data** (no product analytics, no SDK, and nothing records what
a student taps or looks at — the one `Analytics` purpose, from 1.3.0,
is a rating or mark a student chooses to send; see 3a), and Sensitive
Info. Financial Info stays NOT collected and is worth saying out loud:
the payment is taken by Apple, we never see a card, and nothing in the
app handles one. **Data Used to Track You: none** — which is also what
`PrivacyInfo.xcprivacy` declares, so the questionnaire and the manifest
agree.

**PHOTOS: DECLARED. Decided-conservative, Jared, and recorded here so
the question does not reopen next submission.** The relay-not-retained
reading is defensible — Apple's "collect" requires retention beyond
the request, and `ai-text` has no storage client, pinned at
`test-readings.mjs:552` — but the asymmetry settles it: declaring
costs one privacy-label row; omitting risks a rejection cycle if a
reviewer reads the definition the other way. It also matches the Play
data-safety answer, so the two labels cannot be played against each
other, and it is true in the sense a student reads it: their photo
leaves the device. So the table above stands with **Photos or Videos:
collected, linked, no tracking, App Functionality** — do not
un-declare it on a future pass without a ruling.

Note the division of labour the reviewer may probe: the app-level
`PrivacyInfo.xcprivacy` declares what the **binary** does (nothing);
the questionnaire declares what the **service** collects. That is the
standard arrangement for first-party collection. If App Store Connect
ever flags a mismatch between them, that is the seam to look at.

---

## 3a. What 1.3.0 changes, and it is ONE ROW — but not the one expected

Essay feedback, its quality capture, and the mark comparison
(ESSAY-FEEDBACK.md). The answers to enter:

**THE VERSION STRING IN APP STORE CONNECT IS `1.3.0`** — not 1.2.0,
which is the desktop tag and the iOS build that precede this work. ASC
refuses a version string that does not increase, so entering it wrong
is caught; entering 1.2.0 for a build that contains essay feedback is
NOT caught by anything, and would leave two different binaries
submitted under one number.

### The essay text needs NO change, and the precedent settles it

An essay is supplied text, relayed to a provider and stored nowhere —
`ai-text` has no storage client and `test-readings.mjs` pins that. So
on the strict reading it is not "collected" at all, and on the
conservative reading it is **already covered by the existing
`User Content -> Other User Content` row**, which is declared Yes.
Either way there is no new row and no new type.

That is the **Photos ruling applied unchanged**: the relay-not-retained
argument is defensible, declaring costs nothing extra here because the
row already exists, and omitting risks a reviewer reading the
definition the other way. Do not open it again.

### The rating, the reasons and the quality log — same row, NEW PURPOSE

A student rating our feedback, and the reasons they pick, are **supplied
by the student**, so they are User Content rather than telemetry. They
go under the existing `Other User Content` row too.

**What changes is the PURPOSE.** Every row in the table above is
`App Functionality`. Evaluating whether our feedback matched a real
marker is not making the app work for that student — it is
**Analytics**, in Apple's own words *"using data to evaluate user
behavior, including to understand the effectiveness of existing product
features"*, which is this exactly.

| Apple type | Collected | Linked | Tracking | Purpose |
|---|---|---|---|---|
| User Content -> **Other User Content** | Yes | Yes | No | App Functionality **+ Analytics** |

### The shared mark and band — the same row again, and the tick is the story

Opt-in, per assessment, and refusable without losing the rest of the
prompt. Still `Other User Content`, still linked (it is keyed to the
account like everything else), still not tracking, and it is the second
thing under the new `Analytics` purpose.

**Apple has no "optional" column**, so a data type collected sometimes
is declared collected. Declaring it is the honest answer and matches
what the student is told at the tick.

It is **not** `Sensitive Info` — Apple's list there is race, religion,
sexual orientation, pregnancy, disability, biometrics, union
membership and political opinion. An academic mark is none of them.

### The comment box and the AI-use record — the same row, nothing new

**The optional comment** on a rating is User Content the student types
and chooses to send, with the box saying it is stored and trains
nothing. It may quote their essay. `Other User Content`, linked, no
tracking, **Analytics** — the rating's row and purpose.

**The AI-use record** (when and what kind of AI help was asked for on an
assessment, no essay text) lives in the planner and syncs with it, like
marks and notes: `Other User Content`, **App Functionality**, already
declared. It exists so the student can disclose, which is the student's
own use.

### AND ONE SENTENCE IN THIS DOCUMENT BECOMES FALSE — edited 26 September 2026

Section 3 says: *"**Usage Data** (there is no analytics of any kind)"*.

The TYPE is still not collected — we have no product-interaction
telemetry, no SDK, and `test-local-only.mjs` still proves zero
third-party calls. **But the parenthetical is a stronger claim than the
declaration, and from 1.3.0 it is untrue.** A purpose named `Analytics`
beside a document saying there is no analytics of any kind is exactly
the seam a reviewer probes, and it is the restatement pattern one
document over: a reassuring aside that outlives the fact it described.

The replacement says the thing that is actually true, which is
narrower and stronger:

> **Usage Data: not collected.** There is no product analytics, no
> SDK, and nothing that records what a student taps or looks at.
> Where `Analytics` appears as a *purpose* on User Content, it is one
> thing: a mark a student chose to share so we can check our feedback
> against a real marker.

**Play's data-safety form takes the same edit.** ANDROID-RELEASE.md
section 2 is the other half, and the two labels must agree or they can
be played against each other — which is the reason Photos was declared
on both.

### The review account can run it

The credit table in section 7 gains a row. At the derived cost in
ESSAY-FEEDBACK.md section 2, essay feedback is **3 credits**, and the
free tier's 60 trial credits cover a reviewer running it several times
over alongside everything else on that list. No tier change, no seeded
subscription.

### The reviewer note — DRAFTED HERE, not carried over

**Corrected 26 September 2026.** The first draft said the feature
"never rewrites the essay", which the 18 September ruling reversed, and
it named an Assessments tab, a "Get feedback" button and a 3-credit
price, none of which is what shipped. **If the example rewrite is still
switched off in the build that is submitted, delete the sentence about
it** rather than describe a control the reviewer cannot find.

**There was no essay reviewer note in this repository before now**; the
earlier one existed only in a conversation and is not evidence of
anything. This is a fresh draft for Jared to approve, and it is short
on purpose — App Review Notes are read quickly and a long note invites
questions.

> UniPlanner's essay feedback gives a student written comments on
> their own draft against their own marking criteria. It never predicts
> a grade. If the student asks, it can show an example rewrite of one
> sentence or paragraph that a comment pointed at, beside their own; it
> never writes or inserts into their work, and it keeps a record of the
> help asked for so they can disclose it under their unit's rules. The
> limits are enforced on our server, not just in the prompt.
>
> To try it: sign in with the account above, open **Courses**, add an
> assessment under **Grades**, and use **Get feedback on a draft** on
> its row. Paste any text into the draft box and anything into the
> criteria box. The account has free trial credits; one read costs 9.
>
> The essay is sent to our server, relayed to our AI provider for the
> single request, and stored nowhere. Students are told this on the
> consent screen before the first use, which you will see on that
> first run.

---

## 3b. The App Store Connect text for 1.3.0 — paste-ready

Drafted 26 September 2026 for Jared to approve. **Wording is Grace's**
wherever a student reads it (What's New); the reviewer note and the
questionnaire answers are facts and are Jared's.

### Version

`1.3.0`. Not 1.2.0 (see 3a).

### What's New

Written against **1.1.0, the version live on the App Store**. If iOS
1.2.0 was approved in between, drop the second paragraph's items that
shipped in it.

> **Feedback on your essays.** Paste a draft and your marking criteria
> on any assessment in Grades, and get comments that quote your own
> words and say what to work on first. It reads your draft against the
> criteria you give it, and it never predicts your mark. If you ask,
> it can show an example rewrite of one sentence it pointed at, beside
> yours — nothing is put into your essay. When your mark comes back,
> we'll ask once how we did.
>
> Also new: edit your AI lecture notes, a ? on every study tool with
> a worked example, photographed readings with the price shown before
> you start, and a way to tell us about problems or ideas from Settings.
> Text fields no longer zoom on iPhone, and dark mode no longer shows
> white bars when you scroll past the end.

The example rewrite is switched on (26 September 2026), so What's New
and the reviewer note both describe it. If it is ever switched off
before a submission, take the sentence out of both: neither may
describe a control the reviewer cannot find.

### Reviewer notes

The essay note is in section 3 above (corrected 26 September). Put it
**after** the account credentials and the existing notes for the AI
lecture notes and purchases, which are unchanged from 1.1.0.

### Age rating — the answers, against Apple's live questionnaire

Read from *Age ratings values and definitions* on 26 September 2026.
**There is no question about AI or generated content**, so the answers
follow from what the app does, not from how it does it.

| Question | Answer | Why |
|---|---|---|
| Parental Controls | No | none in the app |
| Age Assurance | No | none in the app |
| Unrestricted Web Access | **No** | links go to our own pages (privacy, terms, support) and Stripe's checkout; there is no browser |
| User-Generated Content | **No** | everything a student writes is private to their account; nothing is distributed to other users |
| Social Media | No | |
| Messaging and Chat | **No** | the AI features are not communication between users |
| Advertising | No | |
| Mature themes, sexuality, violence, medical or wellness, chance-based | None / No | the app supplies none of it. The AI works only on what the student pastes, and returns comments on it to that student alone |

That should keep the **4+** rating the app already has. The one row a
reviewer could read differently is **User-Generated Content**: a
student's own notes are content they generate, but Apple's definition
is about *broad distribution*, which the app has none of. Answer No.

### Guidelines checked for the rewrite (the 18 September order)

**No App Review Guideline addresses academic integrity, cheating or
AI-written schoolwork** (checked 26 September 2026). The ones that
apply are **5.1.1** and **5.1.2(i)**, on sharing personal data with a
third-party AI, which the consent screen naming Groq and OpenAI already
answers, and which v8's line about essays being sent as written
extends. Nothing further is needed for review. The integrity question
is a legal one, and it is LEGAL-REVIEW.md §5.

### App Privacy

Section 3a: one row gains the `Analytics` purpose; nothing else
changes. **Play's data-safety form takes the same edit** so the two
labels agree (ANDROID-RELEASE.md §2).

---

## 4. Items that bite at submission but were not on your list

| Item | State | Evidence |
|---|---|---|
| **Cut from a tree with the classification gate** | PASS — **the build itself enforces it, unconditionally** | `scripts/prepare-native.mjs` throws on any dist-web entry not declared in `NATIVE_SHIPPED` or `NATIVE_EXCLUDED`, naming the file — so a local Mac `npm run build` cannot copy an unclassified asset, and `ls mobile/www` is confirmation rather than the gate. Build **3494152 contains `site/` and `measure-audio.html`** — this build supersedes it |
| iPhone-only | PASS | `TARGETED_DEVICE_FAMILY = "1"`, `stamp-native.mjs:89`, re-applied every `cap add`, asserted by `test-ai-notes.mjs:914` block |
| `CFBundleVersion` strictly increases | PASS by construction | derived (minutes since 2020) in `stamp-native.mjs`; the marketing version is independent of it and comes from the root `package.json` — 1.1.0 since the billing release |
| Privacy policy + deletion URLs live | PASS | `src/legalLinks.js` exports both; `test-legal.mjs` pins documents ↔ code; served network-only so never stale from cache |
| Diagnostic mime override ships | PASS, safe | `uni-planner-force-mime`: unset by default, written by no UI (tested), validated against the candidate list — it cannot select a format the recorder doesn't already offer |

---

## 5. Unfinished by design — safe in this build, stated so nobody rediscovers them

- **Order 5's PlannerApp wiring.** `claimDevice` is called by nothing
  and no `.jsx` reads `standing`; the only live effect is two columns
  in `fetchUsage`'s select, and migration 0015 is applied and verified
  in production. Ships inert. Do not revert; the missing half is the
  half that acts.
- **The mp4/Opus decision.** Deferred behind the transcript diff
  (`MOBILE-BUILD.md` 13b). This build records Opus at the measured
  51 kbps, under the 86 MB ceiling to 3 h 45 m — the duration cap
  binds before the size cap, which is the right way round.
- **The name split is CLOSED.** It read '"University Planner" vs
  "UniPlanner" in-app, deferred by ruling' until 18 September 2026; the
  product is "UniPlanner" everywhere now. iOS decided it rather than
  taste — a home-screen label truncates at ~12 characters, so the long
  form was never available as the single name.
  The home-screen name is already "UniPlanner" (`stamp-native.mjs`,
  `DISPLAY_NAME`), matching the store record where it is visible.
