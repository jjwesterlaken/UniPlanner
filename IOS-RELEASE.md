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

### 1. Account deletion — PASS

- The flow: `src/accountDeletion.js:87` (`deleteAccount`) removes the
  account's own audio objects, then `:96` calls
  `rpc("delete_my_account")`, whose body — `delete from auth.users`,
  scoped to `auth.uid()` — is `supabase/migrations/0002_account_deletion.sql`.
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

**Use a dedicated standing account, not the e2e one.** The e2e suite
resets its account to a seed at the START of every CI run
(`e2e/helpers.mjs:12–13`) — for a one-shot Play review that was
survivable; an Apple review can span days, and any state the reviewer
creates gets wiped by the next push to main. Create
`review@`-something, seed it with a course, an assignment and a note,
and let nothing automated touch it. (Same change is worth making on
the Play form.)

What the reviewer can exercise on a free-tier account: everything.
Recording is no longer tier-gated — the allowance is the gate
(`src/aiNotesClient.js:91`), and a fresh account has the 60-credit
trial. They will meet the consent gate first; that is a consent flow
working, not an obstacle to explain away.

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

**THE ONE JUDGEMENT CALL — photos.** Apple's definition of "collect"
is transmitting data off the device **and retaining it longer than
needed to service the request**. Photos are relayed to the model and
written nowhere — `ai-text` has no storage client, pinned at
`test-readings.mjs:552` — so under the definition they are arguably
not "collected" at all, and omitting them is defensible. Declaring
them anyway is the conservative reading. This is the mirror of the
Play service-provider call, and the same rule applies: **read Apple's
current definition yourself before answering** — it is one paragraph —
rather than taking either reading of mine.

Note the division of labour the reviewer may probe: the app-level
`PrivacyInfo.xcprivacy` declares what the **binary** does (nothing);
the questionnaire declares what the **service** collects. That is the
standard arrangement for first-party collection. If App Store Connect
ever flags a mismatch between them, that is the seam to look at.

---

## 4. Items that bite at submission but were not on your list

| Item | State | Evidence |
|---|---|---|
| **Cut from a tree with `NATIVE_EXCLUDED`** | main has it; **check the output at cut time** | `scripts/prepare-native.mjs` exclusion map; after `npm run build`, `ls mobile/www` must show no `site/` and no `measure-audio.html`. Build **3494152 contains both** — this build supersedes it, and the guard (`test-service-worker.mjs`) now fails a build where any dist-web entry is unclassified |
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
