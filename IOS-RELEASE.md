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

**Declared as NOT collected**, flatly: Location, Financial Info,
Health & Fitness, Contacts, Browsing History, Search History,
Purchases, **Usage Data** (there is no analytics of any kind), and
Sensitive Info. **Data Used to Track You: none** — which is also what
`PrivacyInfo.xcprivacy` declares, so the questionnaire and the
manifest agree.

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

## 4. Items that bite at submission but were not on your list

| Item | State | Evidence |
|---|---|---|
| **Cut from a tree with the classification gate** | PASS — **the build itself enforces it, unconditionally** | `scripts/prepare-native.mjs` throws on any dist-web entry not declared in `NATIVE_SHIPPED` or `NATIVE_EXCLUDED`, naming the file — so a local Mac `npm run build` cannot copy an unclassified asset, and `ls mobile/www` is confirmation rather than the gate. Build **3494152 contains `site/` and `measure-audio.html`** — this build supersedes it |
| iPhone-only | PASS | `TARGETED_DEVICE_FAMILY = "1"`, `stamp-native.mjs:89`, re-applied every `cap add`, asserted by `test-ai-notes.mjs:914` block |
| `CFBundleVersion` strictly increases | PASS by construction | derived (minutes since 2020) in `stamp-native.mjs`; marketing version stays 1.0.0 from the root `package.json` |
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
- **"University Planner" vs "UniPlanner" in-app.** Deferred by ruling.
  The home-screen name is already "UniPlanner" (`stamp-native.mjs`,
  `DISPLAY_NAME`), matching the store record where it is visible.
