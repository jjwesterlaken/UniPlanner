# Billing for 1.1.0 — the map, then the plan

Discovery and plan only. Nothing here is built, no product is created,
no native project is touched. The build follows Jared's review and the
pricing decision.

**Ruled, not re-litigated:** RevenueCat through `@revenuecat/purchases-capacitor`
for both stores; iOS and Android only in this phase, web read-only;
ships as 1.1.0 with the in-app products submitted alongside the binary.

**Where each fact comes from.** The schema facts are read from the
CATALOGUE of a scratch Postgres with all sixteen migrations applied
through the same Supabase-shaped shim `test-migrations.mjs` uses — not
from the migration text. The live project is behind the network policy
of the build container, so §1 ends with the one query that re-checks it
there. The plugin facts are read from the published tarball of
`@revenuecat/purchases-capacitor@13.5.0` (npm was reachable). RevenueCat's,
Apple's, Google's and Stripe's documentation were NOT reachable (egress
blocked to both RevenueCat doc hosts); every statement about their
behaviour below is marked **[confirm]** and is a claim from memory that
the build must check against the source before relying on it. The
rest is code.

---

## Part 1 — What exists

> **THIS PART IS THE DISCOVERY RECORD, as found on 6 September 2026,
> BEFORE the Phase 0 decisions.** It still describes `plus` as a live
> tier because it was one when this was written, and the case it makes
> against Plus is what got Plus dropped. It is dated rather than
> rewritten: a survey edited to match the decision it produced stops
> being evidence for it. Part 2 carries the decisions and what was
> built; where the two disagree, Part 2 is current.

### 1. The tier model as it exists today

**In the database (catalogue, post-0016):**

| object | what it is |
|---|---|
| `profiles.tier` | `text not null default 'free'`. **No CHECK constraint, no enum.** |
| `profiles.trial_credits_used` | `numeric not null default 0` — the lifetime counter, 0014 |
| `profiles.active_device_id`, `active_device_at` | the one-device rule's columns, 0015; written by `claim_device()`, read by nothing that acts |
| `ai_usage(user_id, month, credits_used, updated_at)` | pk `(user_id, month)`; `month` is `text`, `"YYYY-MM"` in **UTC** |
| `add_ai_credits(uuid, text, numeric)` | atomic monthly increment; EXECUTE: `service_role` only |
| `add_trial_credits(uuid, numeric)` | atomic lifetime increment; `service_role` only |
| `claim_device(text)` | security definer, scoped to `auth.uid()`; `authenticated` may call |
| `handle_new_profile()` | trigger on `auth.users` insert → `profiles(user_id, tier) = (new.id, 'free')` |
| `delete_my_account_data()` | empties every `user_id` table, `profiles` and `ai_usage` included |
| policies | `profiles_select_own`, `ai_usage_select_own` — **select only**, `auth.uid() = user_id` |
| grants | `authenticated`: SELECT on both (plus the platform's default REFERENCES/TRIGGER/TRUNCATE, which PostgREST never exposes — see the note at the end of this section); `anon`: nothing |

**The tier VALUES exist nowhere in the database.** No function body,
default or constraint names `plus`, `ai` or `ai_max`; `'free'` appears
only in the column default and the signup trigger. The four strings live
in exactly two places, `_shared/credits.ts` (`TIERS`) and its browser
mirror `src/aiTextLimits.js`, and a mirror-equality test holds them
together. A row can hold any string, and any string that is not one of
the four is treated as the trial (`allowanceForTier`: unknown → 60,
once-ever), by design — "a typo in the dashboard costs sixty credits".

**Nothing in this repository writes `profiles.tier`.** There is no
update policy, no update grant, no function and no client path. It is
flipped by hand in the dashboard — `ai-text/config.ts` says so, and
ANDROID-RELEASE.md §2 answered Play's "does the app allow purchases?"
with *"NO — tiers are flipped by hand"*. That is the whole of "billing
NOT built": the READ side is finished and enforced server-side; the
WRITE side does not exist. 1.1.0's structural job is one writer.

**What each tier actually receives** (`credits.ts`, the only place the
numbers are written; `aiTextLimits.js` mirrors it under test):

| tier | allowance | counter | recording | text features |
|---|---|---|---|---|
| `free` | 60 credits, **once ever** | `profiles.trial_credits_used` | yes | yes |
| `plus` | 60 credits, **once ever** — identical to free | same | yes | yes |
| `ai` | 900 a month | `ai_usage(month)` | yes | yes |
| `ai_max` | 3,000 a month | `ai_usage(month)` | yes | yes |
| anything else | the trial | `trial_credits_used` | yes | yes |
| no `profiles` row | **refused** (`no_access`) | — | no | no |

The handoff's "60-lifetime / ? / 900 / 3000" is exactly right, and the
`?` is **60, once**. No tier is refused from any AI feature any more:
`TEXT_TIERS` is all four, and `ai-notes` dropped its `tier === "ai"`
gate when tiers landed — **the allowance is the gate**, on both
functions, read before the provider call (`readAllowance`) and billed
after it (`billAllowance`), both branching on `perMonth` in one place.

**What `plus` grants right now: nothing.** Its allowance is the trial's.
Sync (`sync.js`), the semester archive, backup and restore are gated on
a **session**, never on a tier — `grep tier src/sync.js` finds only the
device-claim comment. Every signed-in account already has everything
`pricing.js` lists under Plus ("Sync across your phone, laptop and
tablet", "Cloud backup"). And the 1.0.0 store listing — submitted —
promises it for free: *"Make an account and it syncs across your
devices — you choose when."* So Plus, as the site describes it, would
sell a thing the listing gives away, and making it real by gating sync
would take a promised feature off every existing signed-in account.

There is a coherent Plus that does not do that, and it is already
half-built: **Order 5**. The one-device-at-a-time rule applies to
`isTrialTier(tier)` (`deviceIdentity.appliesTo`), which today includes
`plus` — so the tier whose tagline is "on every device you use" would
be one-device the moment Order 5 is wired. Flip that one line and Plus
becomes *"the planner on every device, the AI trial unchanged"*, which
is what "Plus buys sync, not AI" always meant. It costs separating two
lists that are currently the same list — `TRIAL_TIERS` (allowance
shape) and the device-rule tiers — and it needs Order 5's client half
wired, which is on the pending list anyway. **Decision for Jared (§Phase 0).**
The alternative is to drop Plus before it is ever sold, which is cheaper
than dropping it after.

**The monthly reset exists, by construction, and nothing schedules it.**
`ai_usage` is keyed by `currentMonthKey()` = `YYYY-MM` from
`getUTCFullYear`/`getUTCMonth` (client and both functions agree); a new
month has no row; the limit is re-read from the tier per request;
nothing stores unused credits, so there is nothing to carry. Two
consequences 1.1.0 has to say out loud:

- **The reset is the calendar month in UTC**, i.e. 10:00 or 11:00 in
  Sydney on the 1st — not the subscription anniversary that Apple and
  Google bill on. A student who subscribes on the 25th gets a full 900
  for five days and a full 900 again on the 1st. Cheap for us to keep,
  and it matches every sentence in the copy ("a month", "resets at the
  start of next month"). Moving to anniversary resets means storing the
  period start from RevenueCat and re-keying `ai_usage` — a bigger
  change than the writer itself. Recommend: keep calendar-month for
  1.1.0 and disclose it in the plan copy.
- **A tier change is felt on the next request, against the same month
  row.** Upgrade mid-month: the limit rises, `credits_used` stays, so the
  student gains the difference at once. Downgrade or expiry: the limit
  drops to the trial and the counter switches to `trial_credits_used`,
  which may already be exhausted — a lapsed subscriber can have zero
  credits the moment the entitlement ends. Correct, and worth a sentence
  on the expiry screen.

**One catalogue oddity, observed here, to re-check live.** The shim
reproduces Supabase's default table grants, and after 0008
`authenticated` still holds REFERENCES, TRIGGER and TRUNCATE on
`profiles` and `ai_usage`. PostgREST exposes none of the three and
`authenticated` cannot log in directly, so this is not a hole through
the API; it is a grant nothing needs, of the kind 0008 tidied for the
four data verbs. Cheap to revoke in 0017 alongside the writer. The
query that says what production actually holds, for the SQL editor:

```sql
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('profiles','ai_usage')
group by 1, 2 order by 1, 2;
```

### 2. Every place the client reads tier or credits — the enforcement surface

The client never sees a tier NAME. No screen says "Free", "Plus" or
"Study AI"; the only tier-derived display is the credits badge and the
sentence about whether they reset. What reads the tier, and what it
drives:

| read | where | drives |
|---|---|---|
| `fetchUsage` | `aiNotesClient.js:34` — `profiles.select("tier, trial_credits_used, active_device_id, active_device_at")` then, for a monthly tier, `ai_usage.select("credits_used")` for the current UTC month | the **allowance badge** (`aiNotes.jsx:84`): "N of LIMIT AI credits used[ this month]" + `trialAllowance` sentence + minimum-billing line; and `standing` (Order 5, computed and returned, **read by no `.jsx`**) |
| `fetchRecordingAccess` | `aiNotesClient.js:108` | `canRecord` — whether the record button is offered before a request is made |
| `fetchAllowance` → `allowanceState` | `aiTextClient.js:41`, `aiTextLimits.js:95` | every text feature's pre-flight: `canAfford`, `sectionsAffordable`, `lastActionWarning`, `describeExhausted`, `cantAfford` — and `perMonth` decides every period word in `aiTextCopy.js` |
| `deviceStanding` | `deviceIdentity.js:70` | statuses `exempt / unknown / unclaimed / ours / displaced`; `shouldSignOut` / `shouldClaim` exist and nothing calls them |
| `TIERS`, `TRIAL_TIERS`, `allowanceForTier` | `aiTextLimits.js` (mirror) | all of the above |

Server side, the same two lookups gate for real: `ai-notes/index.ts:239`
and `ai-text/index.ts:100` each `select tier, trial_credits_used` with
the service-role client scoped to the verified user, then
`readAllowance` before the provider call. **The client cannot grant
itself anything** — `profiles` is select-only to `authenticated`, and
the number a student sees is a courtesy copy of the number the server
enforces. That is why the whole of 1.1.0's enforcement is *write
`profiles.tier` correctly*: nothing on the read side changes.

Two things the surface is missing, both visible from the table:

- **There is no upgrade path.** `describeExhausted()` returns
  `action: "See what the AI plan includes"` for a trial account and
  `ExhaustedNotice` (`aiText.jsx:113`) renders `title` and `detail` only.
  The action label is computed and never rendered, anywhere. A student
  who runs out is told the AI plan exists and given nothing to tap.
- **The badge is fetched once, on the AI tab's mount** (`aiNotes.jsx:74`).
  After a purchase, a restore, or a webhook landing while the tab is
  open, nothing refetches. 1.1.0 needs a refetch on the RevenueCat
  customer-info listener, after `purchasePackage` / `restorePurchases`
  resolve, and on window focus (the planner already syncs on focus).

### 3. The pricing placeholders, and what the listing already promises

**`site/pricing.js`** — `CURRENCY = "AUD"`; `PERIODS` monthly / 6 months
("a semester") / annual, deliberately no quarterly; four tiers whose
`credits` and `perMonth` are asserted equal to the server's, and whose
`prices` are `null` behind the `PLACEHOLDER` marker for `plus`, `ai`
and `ai_max` (free is 0/0/0). **`site/flags.js`** `prices: false` —
"ON when Gate 1 lands and the tier prices are decided"; until then the
table renders the placeholder treatment, and `test-site.mjs` refuses a
shipped figure while the marker stands and asserts the flag and the
numbers cannot disagree.

**Gate 1 is not a pricing meeting.** It is COST-MODEL.md §12.7's
measurement — `scripts/measure-photo-gates.mjs`, three calls, the
photo-token ratio — because the photo path is the most expensive action
in the app on the model we run and the cheapest on the one recommended,
and a price per credit set before that ratio is known is set against a
cost known to be wrong. Jared's pricing decision has that measurement
as a precondition, or it has to be made knowing photos are priced on
the held weight (`PHOTO_BATCH_CREDITS`, tested not to move).

**What the 1.0.0 metadata promises, and 1.1.0 must honour** (`site/store-listing.js`,
the text submitted to both stores):

- *"Recording lectures, summarising a reading you supply, and the
  study help are optional and use a credit allowance. Every plan
  includes credits to try them."* — true under the tier table; stays
  true as long as the trial survives on every tier.
- *"Make an account and it syncs across your devices — you choose
  when."* — sync is free for a signed-in account. This is the sentence
  that constrains Plus (§1).
- **No price, period or tier name is promised anywhere in the listing
  or the documents.** The site's tier bullets ("900 AI credits a month",
  "Credits do not roll over", "3,000 … around fifty hours") are what a
  paying student will hold us to, and they are already asserted equal
  to `credits.ts`.

**What both store questionnaires currently declare, and must flip:**
IOS-RELEASE.md §3 — *Purchases: declared as NOT collected*; Play Data
safety (ANDROID-RELEASE.md §2) — *"Does the app allow purchases? NO"*.
1.1.0 declares Purchases collected, linked to identity (the RevenueCat
app user id is the Supabase uid), not used for tracking. The app's own
`PrivacyInfo.xcprivacy` (tracking: none) stays true provided Apple
Search Ads attribution is never enabled on the SDK.

**There is no Terms of Use.** `legalLinks.js` exports a privacy URL, a
deletion URL and two addresses; `public/` holds two documents. Apple
requires a Terms of Use (EULA) link, together with the privacy policy,
in the purchase UI and in the App Store metadata for auto-renewable
subscriptions **[confirm — Schedule 2 §3.8(b) and Guideline 3.1.2]**. A
third document is a third URL through `legalLinks.js`, the sw's
`NETWORK_ONLY` list, both drift tests in `test-legal.mjs`, and a store
listing field.

### 4. What the Capacitor project needs

**The plugin, from its tarball** (`@revenuecat/purchases-capacitor@13.5.0`,
latest on npm today):

| requirement | plugin | ours | |
|---|---|---|---|
| `@capacitor/core` | `>= 8.0.0` (peer) | `^8.4.2` | ✔ |
| iOS deployment target | 15.0 (podspec and Package.swift) | `IOS_DEPLOYMENT_TARGET = "15.0"` | ✔ exactly |
| Android `minSdk` | 24 | `ANDROID_MIN_SDK = 26` | ✔ |
| native dependency | `PurchasesHybridCommon 18.33.1` (pod / SPM), `purchases-hybrid-common:18.33.1` (Gradle) | resolved by `cap sync` | — |

Install is `npm install` in `mobile/` and `npx cap sync`; the native
projects are regenerated per machine, so nothing native is committed.
What the repo's own machinery has to say about it:

- **`prepare-native.mjs` will not object.** It copies `dist-web` into
  `mobile/www`, strips the service-worker block by marker and refuses
  any safe-area rule. The plugin is JavaScript in the bundle plus native
  code resolved by `cap sync`; neither touches what it checks.
- **`native-permissions.mjs` adds nothing.** Android's
  `com.android.vending.BILLING` is merged from the Play Billing library's
  own manifest; iOS needs no plist key. The In-App Purchase capability
  is on by default for an App ID **[confirm on the developer portal]**,
  and the Xcode capability toggle edits the regenerated `.pbxproj`, so
  if a toggle turns out to be required it belongs in `stamp-native.mjs`
  with the other regenerated settings, never done by hand.
- **The third-party-host guard passes as things stand.** The plugin's
  JavaScript contains no RevenueCat host string (grepped the shipped
  `dist/`), so `test-local-only`'s sweep of `dist-web/app.js` finds
  nothing new. The native SDK does contact `api.revenuecat.com` from the
  device — which is a privacy-document problem (§5, Phase 2), not a
  bundle-guard one.
- **The web implementation REJECTS every call** — `PurchasesWeb`
  returns `Promise.reject("…not supported on web")` unless
  `setMockWebResults(true)`. Every call must sit behind
  `Capacitor.isNativePlatform()`, or the hosted app, the Electron shell
  and every jsdom/Chromium suite (`test-app-smoke`, `test-rendered-tabs`,
  the journeys) get an unhandled rejection on first render. Web
  read-only falls out of that gate for free.
- **The leak gate is too narrow for the keys this feature introduces.**
  `test-ai-notes.mjs` forbids `"sk-"`, `DEEPGRAM_API_KEY`,
  `OPENAI_API_KEY` and `service_role` in `dist-web/app.js`. RevenueCat's
  *public* SDK keys (`appl_…`, `goog_…`) are meant to ship and match
  nothing — correct. RevenueCat's *secret* API key and Stripe's secret
  keys use an **underscore** (`sk_…`, `sk_live_…`, `sk_test_…`,
  `rk_live_…`, `whsec_…`) and would pass the gate today. Widen it in
  the same PR that mints the first such secret, before the secret exists.
- **Configure RevenueCat only after sign-in.** `Purchases.configure()`
  mints an anonymous app user and talks to RevenueCat at once; done at
  launch it would make a signed-out phone contact a US server, which the
  policy says never happens and `test-local-only` exists to prove
  (against the web bundle — it cannot see the native path, which is
  exactly why the rule has to be by construction). This also settles the
  identity question in §8.

### 5. The Supabase surface for entitlements

**Where.** A third Edge Function, `supabase/functions/billing-webhook`,
Deno like the other two, sharing `_shared/supabaseAdmin.ts`. It must be
deployed with JWT verification OFF for that function only — RevenueCat
cannot send a Supabase JWT — and do its own authentication. Two
restatements have to move with it: `deploy-functions.yml` enumerates
`ai-notes ai-text` by hand in two places, and the wiring test in
`test-ai-notes.mjs` restates the same list. Derive both from
`supabase/functions/*/index.ts` in the same PR; a third function is the
first thing that would have been silently left out.

**Authentication — and a correction to the brief.** RevenueCat does not
HMAC-sign webhook bodies; it sends a value you choose in the dashboard
as the `Authorization` header of every delivery **[confirm — this is the
load-bearing claim of the section]**. So there is no signature to
verify; there is a shared secret to compare, in constant time, held as
the function secret `REVENUECAT_WEBHOOK_SECRET` (the sweep-secret rule:
a dedicated secret that authorises exactly one thing). That is weaker
than a signature, and the design below is what makes the difference not
matter:

**The payload is a trigger. The subscriber record is the truth.** On
every accepted event the function ignores the body's entitlement
claims, reads `app_user_id` from it, and fetches
`GET https://api.revenuecat.com/v1/subscribers/{app_user_id}` with
`REVENUECAT_SECRET_KEY` **[confirm endpoint]**. The tier is computed
from the ACTIVE entitlements in that response — highest wins,
`ai_max > ai > plus`, none → `free` — and written. A forged event with a
stolen header can therefore only cause a re-read of what RevenueCat
already believes about that user; it cannot grant anything. Ordering
and duplicate delivery stop mattering for the same reason: every event
is "go and look", and looking twice is idempotent. This is `fetchNote`'s
rule applied to money: never act on the claim, act on the definitive
answer.

**The service-role rule applies in full.** The function writes with the
client that bypasses RLS, so `.eq("user_id", …)` is written by hand on
every statement, the `user_id` is the one RevenueCat returned for that
subscriber and never one taken from the request, and a `TRANSFER`
event re-reads BOTH users it names, because a transfer is the one event
that changes two rows. The Stripe webhook was named in CLAUDE.md as the
next place this mistake would flip the wrong user's tier; this is that
place, one integration earlier.

**What it writes (migration 0017, WIDENS, applied before the deploy):**

- `profiles.tier` — with a CHECK constraint on the four values now that
  a program writes it. The unknown-tier-means-trial rule stays in the
  code for rows that predate the constraint; the constraint stops the
  writer from creating one.
- `profiles.tier_source` `text` — `'manual'` or `'revenuecat'` (later
  `'stripe'`). **The webhook never overwrites a `'manual'` row.** That is
  how Grace's, Jared's and the App Review account keep a tier nobody
  bought (IOS-RELEASE.md line 154: the reviewer needs working paid
  features or sees none of them), and it is the rule that makes a
  dashboard flip survive the next webhook. A student on a manual tier
  who later subscribes needs the flag cleared by hand — one dashboard
  query lists manual rows; decision noted for Phase 0.
- `profiles.tier_updated_at`, `profiles.entitlement_expires_at`
  (informational; the truth is re-read), `profiles.store`
  (`app_store` / `play_store` / `stripe` / null) — the last one decides
  which "manage your subscription" link the Account tab shows, because
  a subscription can only be changed where it was bought.
- `billing_events(id text primary key, user_id uuid references
  auth.users on delete cascade, type text, received_at timestamptz,
  tier_before text, tier_after text)` — the RevenueCat event id is the
  key, so a redelivery is a no-op by constraint. **No client policy at
  all** (service role only; `anon` nothing; the grant audit's derived
  checks go red until the grants are written out). It holds purchase
  metadata and never student content, so it needs: a `DOCUMENTED_AS`
  entry in `test-legal.mjs` for both published documents ("nothing you
  see, and why" is the required shape), and `delete_my_account_data()`
  re-created to empty it — the behavioural migration test enumerates
  `user_id` tables from the catalogue and will refuse 0017 until it does.
- The migration verifies itself and raises (0016's rule): constraint
  present, columns present, function empties the new table, grants as
  written. And `supabase/checks/verify-billing.sql` asks the LIVE
  database the same questions, in DEPLOY-CHECKLIST, run once against
  the un-migrated project to watch it FAIL.

**Secrets, written down because nothing can see them:**
`REVENUECAT_WEBHOOK_SECRET` and `REVENUECAT_SECRET_KEY` in Supabase →
Edge Functions → Secrets, beside the five already listed in CLAUDE.md;
the RevenueCat public keys in `src/config.js`, one per platform.

### 6. The Stripe surface (a later phase — web is read-only in this one)

Mapped now because the identities have to be right before the first
Stripe customer exists.

- **Purchase:** Stripe Checkout in subscription mode, created
  server-side by a JWT-verified function `billing-checkout` for the
  signed-in user, with `client_reference_id` = the Supabase uid and the
  same uid in `metadata`. The user never types their identity; the
  session carries it.
- **Linking the customer:** on the completed session, store
  `profiles.stripe_customer_id`, scoped by the uid from the session's
  metadata — **never matched by email**, which is the takeover CLAUDE.md
  warns about. A second function `billing-portal` creates a Customer
  Portal session from that stored id for cancel/change.
- **How RevenueCat learns about it [confirm every step]:** RevenueCat's
  Stripe integration ingests a subscription when (a) Stripe's webhooks
  are pointed at RevenueCat's Stripe endpoint and (b) the subscription
  is REGISTERED by POSTing to RevenueCat's receipts endpoint with
  `X-Platform: stripe`, the uid as `app_user_id`, and the Stripe
  subscription id as `fetch_token` — done by `billing-checkout`'s
  completion handler. From then on renewals, cancellations, refunds and
  billing issues arrive as the same RevenueCat webhook events the stores
  produce, and the tier path in §5 needs no second writer.
- **The gaps to name, rather than assume closed:** RevenueCat creates no
  Checkout session, links no customer, and every Stripe Price a student
  can move to through the Customer Portal must ALSO be a RevenueCat
  product with the entitlement attached, or the change lands in Stripe
  and never in the tier. Whether RevenueCat's Stripe support carries
  Portal plan changes, trials and grace periods end to end is the thing
  to read in its documentation before Phase 6 — and if it does not,
  the fallback is Stripe's own webhook (which IS HMAC-signed, `whsec_…`)
  feeding the same `applyEntitlement()` in `billing-webhook`. Two
  sources, one writer.

### 7. Desktop

Electron already refuses to open any `http` link in-app and hands it to
the system browser (`desktop/main.js:31`, `setWindowOpenHandler` →
`shell.openExternal`). Checkout opens there with no new code. How the
app learns it completed: **it does not need to be told.** The webhook
writes `profiles.tier` within seconds of the completed session; the
desktop app refetches the allowance on window focus (it already syncs
on focus) and, while a checkout is in flight, polls `fetchUsage` every
few seconds for a bounded window. A custom URL scheme
(`setAsDefaultProtocolClient`) would return the user to the app, but it
is per-OS registration inside the electron-builder config, it is not
registered today, and it would only save one Alt-Tab. Recommend the
poll-on-focus route; revisit the scheme only if the checkout's success
page cannot say "return to the app".

### 8. Restore across platforms, and identity

- **The RevenueCat app user id IS the Supabase uid.** `configure({ apiKey,
  appUserID: session.user.id })` runs after sign-in and never before
  (§4); on sign-out the app stops calling RevenueCat rather than calling
  `logOut()`, which would mint an anonymous id and contact the server.
  The same uid on iPhone, Android and — in a later phase — Stripe means
  every platform's purchases attach to one subscriber, the webhook
  writes one row, and the web, which never talks to RevenueCat, reads
  the tier from `profiles` like everything else.
- **Web sees the tier without being able to buy.** The Account tab
  shows the plan name and "Managed in the App Store / Google Play",
  the badge shows the allowance, and there is no buy button. Apple's
  rules concern an iOS app steering users OUT to the web; a web page
  pointing at the store apps is unconstrained.
- **What breaks with an anonymous user on one platform.** If the app
  configured anonymously and a student bought before signing in, the
  purchase would belong to `$RCAnonymousID:…`; `logIn(uid)` then
  transfers or aliases it **[confirm RevenueCat's "restore behaviour"
  setting and its default]**, and if that student had ALSO bought on
  the web as the uid, RevenueCat would be merging two paying identities
  by a rule nobody here has read. Configuring only after sign-in makes
  this case unreachable. The case that stays reachable is Apple's own:
  the App Store receipt belongs to the Apple ID, not to our account, so
  a student who signs into account B on a phone whose Apple ID bought
  for account A and taps Restore moves the entitlement to B — a
  `TRANSFER` event naming both, which §5 handles by re-reading both rows.
  That is the correct outcome (the person who paid keeps the tier, on
  whichever account they are using) and it must not surprise support.
- **The restore flow Apple requires:** a visible "Restore Purchases"
  button wherever the plans are shown, calling `restorePurchases()`,
  then refetching `profiles` — the client displays what the server
  holds and grants itself nothing from `customerInfo`, so "restoring…"
  is shown until the webhook has landed (poll, bounded) and then the
  server's tier is shown. If RevenueCat says entitled and the server
  still says free after the poll, that is a webhook failure to report,
  not a state to paper over locally.

---

## Part 2 — The plan

### Phase 0 — DECIDED (Jared, 6 September 2026)

1. **Plus is dropped.** Two paid tiers. `TIERS` is `free / ai / ai_max`
   in `credits.ts` and its mirror; the CHECK in 0017 names three; the
   unknown-tier-means-trial rule stays for legacy rows, and the
   migration's pre-flight is what proves there are none.
2. **Prices, AUD**: Study AI 8.99 / 44.99 / 79.99, Study AI Max
   18.99 / 94.99 / 169.99 (monthly / six-month / annual). Set in
   `site/pricing.js` with `FLAGS.prices` flipped in the same commit and
   the PLACEHOLDER markers removed — `test-site.mjs` demands both
   halves together and now also checks each figure is sayable, that a
   longer period never costs more than the shorter ones it replaces,
   and that the tier with more credits costs more at every period.
3. **Gate 1 consciously deferred**, recorded in COST-MODEL.md §12.8
   with the exposure it accepts. `PHOTO_BATCH_CREDITS` is still held.
4. **Reset stays the calendar month, UTC.** The plans copy discloses it
   (Phase 2).
5. **Manual overrides win.** `tier_source = 'manual'` is never
   overwritten; the reviewer account is manual.
6. **Terms of Use for 1.1.0 is Apple's standard EULA**
   (`https://www.apple.com/legal/internet-services/itunes/dev/stdeula/`).
   A UniPlanner Terms document is a **Phase 6 prerequisite**, not a
   1.1.0 one.
7. **Refund wording accepted as written** (see the section below).

**Six products, not nine**, since Plus is gone — the identifier table
below is updated accordingly.

**THE ONE THING PHASE 0 ASKED FOR THAT IS STILL OUTSTANDING:** the live
count of `profiles` rows holding a tier outside the three. It cannot be
run from the build container. It is now asked TWICE, by machinery
rather than by memory — `verify-billing.sql` reports it as a property,
and 0017 REFUSES to apply while any such row exists, naming the count,
the values and the statement to run, and changing nothing when it
refuses. So the assumption is never made; it is either confirmed or the
migration stops.

### Two [confirm] markers resolved (Jared, from RevenueCat's current docs)

- The **Authorization header** is a dashboard-configured value sent on
  every delivery — as recorded.
- **HMAC signing is now available as an opt-in**, and is being enabled:
  `X-RevenueCat-Webhook-Signature: t=<ts>,v1=<hmac_sha256_hex>` over
  `<timestamp>.<raw_body>`.

The function verifies **both**, and in that order: constant-time
comparison of the header, then the HMAC over the **raw request bytes**
before any JSON parsing. That ordering is not a preference — a parsed
and re-serialised body is a different string (key order, whitespace,
number formatting), so verifying against a re-render fails every valid
delivery. `req.json()` appears nowhere in the function and a test
asserts it, which is what makes verify-before-parse structural rather
than a comment. A second test signs a pretty-printed body and requires
it to be ACCEPTED, so the rule is pinned from both sides.

The re-read design stays regardless, and is also RevenueCat's own
documented recommendation after any webhook.

### The permanent names — product identifiers and the entitlement mapping

Identifiers cannot be changed after creation on either store, so they
are named here and not in a dashboard on the day. Lowercase, dot-
separated, legal on both stores **[confirm Play's character rules]**,
and carrying no price or credit figure so a price change never makes an
id lie:

| tier | Apple product id (one auto-renewable product per period, all in ONE subscription group so Apple handles up/down/cross-grades) | Play (one subscription per tier, three base plans) |
|---|---|---|
| `ai` | `uniplanner.studyai.monthly` · `uniplanner.studyai.sixmonth` · `uniplanner.studyai.annual` | subscription `uniplanner.studyai`, base plans `monthly` / `sixmonth` / `annual` |
| `ai_max` | `uniplanner.studyaimax.monthly` · `uniplanner.studyaimax.sixmonth` · `uniplanner.studyaimax.annual` | subscription `uniplanner.studyaimax` + the same three |

Subscription group ranking on Apple: `studyaimax` above `studyai`, so a
change between tiers is an upgrade or downgrade in Apple's
terms (upgrade immediate and prorated, downgrade at the next renewal),
and a change of period within a tier is a crossgrade. Play's base-plan
model gives the same shape natively.

**RevenueCat entitlement ids are the tier strings themselves** —
`ai` and `ai_max` — so the webhook's mapping is the identity
function and there is no table to drift. One offering, `default`, with
the six packages. `credits.ts`'s `TIERS` is unchanged; the CHECK
constraint in 0017 names the same four strings, and a test asserts the
three lists (TypeScript, SQL, and a `BILLING_ENTITLEMENTS` constant the
webhook reads) are equal.

### Phase 1 — Server: the writer, and everything that proves it

**Changes.** Migration 0017 (columns, constraint, `billing_events`,
grants written out, the three table-default grants tidied,
`delete_my_account_data()` re-created, self-check); `billing-webhook`
with `_shared/entitlement.ts` holding `tierFromEntitlements()` and
`applyEntitlement()`; `deploy-functions.yml` and its wiring test derived
from the functions directory; the leak gate widened; `verify-billing.sql`.
No client change.

**Verification, and what each run really exercises.**

- `test-migrations.mjs`: 0017 applies, re-applies, fails its own
  self-check when a property is removed (mutation), empties
  `billing_events` on deletion (the existing catalogue-derived test does
  this without being edited), and `verify-billing.sql` FAILS against a
  pre-0017 database and passes after.
- A function-level suite in the shape of `test-ai-notes-function.mjs`,
  against a fake RevenueCat API and a fake database that models
  ownership: wrong header → 401 and no fetch; right header + a body
  claiming `ai_max` for user X while the fake subscriber record says
  nothing → X's row untouched (the traced fake asserts the RE-READ
  precedes the WRITE, the allowance-read ordering rule pointed at
  money); redelivery of the same event id → one row, one write;
  `TRANSFER` → both users re-read; a `'manual'` row → never written;
  an entitlement id outside the three → trial, logged, not written.
- Source-level invariants, as `ai-notes` has: no `.from(...)` without a
  `user_id` scope in the function; no host but RevenueCat's contacted.
- **What the container cannot do:** deliver a real RevenueCat event.
  After the deploy, Jared sends a test event from the RevenueCat
  dashboard to the function URL with the wrong header first (expect
  401 in the function log), then the right one for a uid that does not
  exist (expect "no such user, nothing written" in the log and no row
  in `billing_events`). That is the first end-to-end proof, and it needs
  no purchase.

**What could go wrong.** JWT verification left ON for the function
(every delivery 401s, RevenueCat retries, nothing is written, the
symptom is "subscriptions never activate"); 0017 applied after the
deploy rather than before (the function 400s on a missing column —
0015's silent-regression shape, but here it is the paid feature not
activating); `verify_jwt` off on a function that trusts its body (the
re-read design is what makes this survivable, and the traced-fake test
is what keeps the re-read in place).

### Phase 1 — BUILT, 6 September 2026 (server only; nothing a student can see)

What landed, and the three things worth knowing before reading the diff:

- **`supabase/migrations/0017_billing.sql`** — the four columns, three
  CHECK constraints, `billing_events`, the derived revoke of the stray
  trigger/truncate/references grants across every public table,
  `delete_my_account_data()` re-created to empty the new table, and a
  self-check that raises with a count of 13. Plus a **pre-flight that
  REFUSES** while any `profiles` row holds a tier outside the three,
  naming the count, the values and the statement to run, and changing
  nothing when it refuses. A test plants such a row and asserts the
  refusal, that nothing changed, and that the remedy the message
  prescribes — **extracted from the file and run verbatim** — lets the
  migration through. That test is what caught the first version of the
  message prescribing `set tier_source = 'manual'`, a column 0017 has
  not added yet, so following the instruction on a live pre-0017
  database would have errored.
- **`supabase/functions/billing-webhook/`** and
  **`_shared/entitlement.ts`** — header, then HMAC over raw bytes, then
  parse; re-read the subscriber, then apply, then record. 33 tests,
  every guard mutation-checked.
- **`supabase/checks/verify-billing.sql`** — 16 properties, run against
  a pre-0017 database and watched to FAIL (13 FAIL, 3 PASS) before
  being trusted. Its first version ERRORED there instead of reporting,
  because `where tier_source = 'signup'` does not PARSE without the
  column; it reads the column by name at runtime now. That is the
  `has_function_privilege` trap from `verify-account-deletion.sql`,
  one file over, found the same way — by running the guard against the
  broken state first.

**The deploy workflow is now DERIVED** from `supabase/functions/*/index.ts`
rather than enumerating two names, with one branch: `billing-webhook`
alone is deployed `--no-verify-jwt`. A wiring test asserts both halves —
that the flag is there, and that it appears exactly once, so it cannot
leak onto the two functions that spend money.

**Also armed, for a change that has not happened yet:** a test in
`test-legal.mjs` fires the day `mobile/package.json` gains the purchase
SDK, because three sentences in the privacy policy become false at that
moment ("the AI features are the only part that sends anything
overseas", "every request is made from our server rather than from your
device", "the only server the app itself contacts is our own"). Phase 1
does not falsify them — no products, no client, no traffic — so they
stay, and the tripwire is keyed on the dependency rather than on
somebody remembering. It asserts its own precondition too: if none of
the three sentences is in the document any more, it fails rather than
passing over nothing.

### Phase 2 — Client: plans on the Account tab, restore, and the documents

**Changes.** The plugin installed in `mobile/`; `configure` after
sign-in behind `isNativePlatform()`; a **Plans panel** on the Account
tab (a new screen — Grace) showing the current plan and, on native
only, the offering's packages, a Restore Purchases button, and "Manage
subscription" linking to the store recorded in `profiles.store`; the
badge refetching on the customer-info listener, after purchase/restore,
and on focus; `describeExhausted().action` finally rendered, opening the
Plans panel; the period sentence unchanged (already tier-driven).
Documents: a Payments section in the privacy policy, a `billing_events`
line in both documents, the Terms of Use, `legalLinks.js`, the sw's
`NETWORK_ONLY`, and the two store questionnaires.

**Three sentences in `privacy.html` become false the day the SDK
ships and must be rewritten, not appended to:** *"The AI features are
the only part that sends anything overseas"* (line 48), *"every request
is made from our server rather than from your device. Nothing else in
the app is sent overseas"* (line 206), and *"The only server the app
itself contacts is our own"* (line 277). Purchases go from the device
to Apple or Google (unavoidable, their store) and the receipt plus the
uid to RevenueCat (United States). This is a **privacy-policy change,
not a consent bump**: consent governs what happens to a student's
content, and no content is involved. The sentence `test-local-only`
pins — *"nothing reaches us / never leaves it"* without an account —
stays true because RevenueCat is never configured without one.

**Verification.** `test-rendered-tabs`: the Account tab, signed in, with
the plugin mocked as native, renders the Plans panel with three named
packages and a Restore button (assert on markup that exists only past
the gate, the AI-tab lesson); signed out, no panel. `test-app-smoke` and
the journeys stay green with the web implementation's rejection never
reaching `pageerror`. `test-local-only`: still zero outbound signed out,
and its host sweep still clean. `test-legal`: every new table and URL
declared; the sentence check re-pointed deliberately at the reworded
promise. `test-focus-zoom` and `test-viewport-layout` walk the new panel
(its inputs, if any, inherit the 16px floor by element type).

**What the container cannot do:** render a real paywall, complete a
purchase, or observe the customer-info listener firing. Those are
Phase 4.

### Phase 3 — Store and dashboard setup (Jared; dashboards, no code)

Apple: sign the Paid Applications agreement and enter banking and tax
in App Store Connect — **sandbox purchases do not work until this is
done**, and it can take days to clear; create the subscription group
and nine products with the ids above; create at least two sandbox
tester accounts (one for Grace's iPhone, one for a "second account"
transfer test). Google: a payments/merchant profile in Play Console;
three subscriptions with three base plans each; an internal-testing
track with license testers (the moto g05's account). RevenueCat: the
project, both store apps with their credentials (App Store Connect API
key or shared secret; Play service-account JSON), three entitlements,
the `default` offering, the webhook URL with the `Authorization` value,
and the two public SDK keys into `config.js`.

**Lead items:** the Apple agreement and the Play merchant profile are
the two things with an external clock. Start them the day Phase 0 closes.

### Phase 4 — Sandbox verification on hardware (the part no test replaces)

Every row below is a state the container cannot reach. Each one names
what to observe on the SERVER, because the app showing a tier proves
only that the app showed a tier:

| step | device | observe |
|---|---|---|
| Buy `studyai.monthly` in sandbox | Grace's iPhone, sandbox Apple account | `billing_events` gains `INITIAL_PURCHASE`; `profiles.tier = 'ai'`, `store = 'app_store'` within seconds; the badge reads "of 900 … this month" |
| Sandbox auto-renewal (Apple: a month renews every 5 minutes, up to 6 times, then expires **[confirm]**) | same | `RENEWAL` rows; then `EXPIRATION`; `tier` back to `free`; badge back to "once — they don't reset" with the trial counter |
| Cancel in the sandbox subscription settings | same | `CANCELLATION` with access continuing to the period end, then `EXPIRATION` |
| Upgrade `studyai` → `studyaimax` | same | `PRODUCT_CHANGE`; `tier = 'ai_max'` immediately; the SAME month's `credits_used` retained, limit now 3,000 |
| Restore on a second device signed into the same account | Jared's device or a second sandbox install | tier shown without a purchase; no new `INITIAL_PURCHASE` |
| Sign into account B on the phone whose Apple ID bought for A, tap Restore | the iPhone | `TRANSFER`; A → `free`, B → `ai`; both rows updated in one event |
| Refund | **Apple's sandbox has no refund button** [confirm]; simulate with a `CANCELLATION` whose reason is `CUSTOMER_SUPPORT` from the RevenueCat test-event sender | tier drops; spent credits stay spent |
| Play purchase with a test card, cancel from the Play subscription centre, refund from Play Console orders | moto g05, license tester | the same three transitions with `store = 'play_store'` |
| Kill the network mid-purchase, reopen the app | either | the store completes the transaction later; RevenueCat's listener fires; the badge refetches; nothing is billed twice |

Every "observe" is a query against `billing_events` and `profiles`, so
each is a row that either exists or does not — none can pass over
nothing.

### Phase 5 — Ship 1.1.0

Root `package.json` → `1.1.0` (`stamp-native.mjs` propagates it to both
shells; the build number is derived). Apply 0017 → deploy the three
functions → Phase 4 → submit iOS with the nine products attached to the
version (the first in-app products must be submitted with a binary
**[confirm]**), the App Privacy questionnaire updated, the Terms URL in
the metadata; Play with Data safety updated and the subscriptions
active. `FLAGS.prices` on the site goes true only once the figures are
decided and the `PLACEHOLDER` markers are removed in the same commit —
`test-site` refuses either half alone. Promote the web bundle so the web
shows the tier read-only from the same day.

### Phase 6 — Later: Stripe and desktop purchase

§6 and §7 as written, after RevenueCat's Stripe page has been read
against the gap list. Not in 1.1.0.

---

## What refund, expiry and lapse do to credits — stated once

- **Refund:** the entitlement ends at once (a `CANCELLATION` with a
  support reason, then `EXPIRATION`); the tier returns to `free`; the
  month's `credits_used` row is left as it is and credits already spent
  are not clawed back; the trial counter — which may already be at 60 —
  is what applies next. No credit is ever restored by a refund.
- **Expiry or cancellation at period end:** the same transition, on the
  day the period ends, whatever day of the month that is; the next
  calendar month's row starts at zero as always, against the trial
  limit until a new entitlement lands.
- **Billing grace period** (recommend enabling it in App Store Connect):
  the entitlement stays active while the store retries the card, so
  the re-read design keeps the tier without any code knowing grace
  periods exist.
- **A monthly limit that drops below the month's spend** makes every
  AI action refuse until the 1st (UTC) — the exhausted notice already
  says what it needs to say for a monthly tier and the trial sentence
  for a trial one.

## What cannot be tested here, listed so nobody reads a green suite as more than it is

- **Anything RevenueCat, Apple, Google or Stripe do on their side.** The
  container reaches none of their hosts, so even their documentation
  is a **[confirm]** in this document.
- **A real webhook delivery** — Phase 1's dashboard test event is the
  first and needs a deployed function and Jared's hand.
- **A purchase, a renewal, a cancellation, a transfer, a refund** — all
  Phase 4, all on hardware with store test accounts.
- **The paywall as rendered on a device**, and the customer-info
  listener firing — the container can mock the plugin and assert the
  markup, and that is all it can do.
- **Store review of the subscription UI** — Apple's required elements
  (price, period, auto-renew terms, Restore, Terms and Privacy links)
  are checked by a reviewer, not a test; the checklist belongs in
  IOS-RELEASE.md when Phase 2 lands.
