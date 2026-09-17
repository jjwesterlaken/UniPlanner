# Turning Stripe on — the order, and what proves each step

Web purchases are **built and switched off**. This is the sequence that
turns them on, in the order it is done.

**Why this file exists.** BILLING-PLAN.md Phase 6 holds the seven-step
order; DEPLOY-CHECKLIST.md §1e points at it and §2b/§7d hold one
dashboard dependency that belongs in the middle of it. Neither is
findable when you are actually doing this, and three things that decide
whether it goes smoothly are in neither. This is the one page to work
from; every figure in it is read from the code and cited, so it can be
re-derived rather than trusted.

Phase 6's list is **test-mode first**, and that is worth keeping. Do
steps 1–8 against test mode, then repeat 5–7 with live values, then
step 9.

---

## 1. Apply `0019_stripe.sql`

It WIDENS, so it goes before the deploy. A successful apply ends:

```
NOTICE: 0019 applied and verified: 6 properties checked.
```

One nullable `profiles.stripe_customer_id` with a UNIQUE index. Unique
because two accounts sharing a Stripe customer make the reverse lookup
ambiguous exactly when a webhook is deciding whose tier to write.

## 2. Create six Prices on two Products

Each must carry the `lookup_key` **exactly** as
`supabase/functions/_shared/stripe.ts` spells it. Prices are the AUD
figures in `site/pricing.js`.

| `lookup_key` | tier | AUD |
|---|---|---|
| `uniplanner_studyai_monthly` | Study AI | 8.99 |
| `uniplanner_studyai_sixmonth` | Study AI | 44.99 |
| `uniplanner_studyai_annual` | Study AI | 79.99 |
| `uniplanner_studyaimax_monthly` | Study AI Max | 18.99 |
| `uniplanner_studyaimax_sixmonth` | Study AI Max | 94.99 |
| `uniplanner_studyaimax_annual` | Study AI Max | 169.99 |

**A Price without its lookup key is the failure that matters.**
`tierFromStripeSubscription` returns `recognised: false`, the webhook
500s having written nothing, and Stripe retries until somebody fixes
the dashboard. That is deliberate — the alternative silently demotes a
paying subscriber to free — but it means a typo here surfaces as a
retry storm rather than as a wrong tier.

## 3. Configure the Customer Portal

Once, in the Stripe dashboard. Stripe refuses to create a portal
session until it has been set up, and that failure only appears when a
real student taps **Manage**.

**CANCEL AT PERIOD END, AND NOTHING IN THE CODE PINS IT.**
`billing-portal` sends only `customer` and `return_url` — no
`configuration` parameter — and nothing in the repository POSTs to
`/v1/billing_portal/configurations`. So whether cancelling in the
portal ends the subscription immediately or at the end of the paid
period is **entirely this dashboard setting**.

**Observed to be "at period end", 18 September 2026**, and worth
recording because the inference is not the obvious one. A portal
cancellation wrote `canceled_at` 08:51 UTC and the subscription was
still ACTIVE thirteen minutes later, when a refund found it and ended
it; the `ended_at` of 09:04:53 in that `customer.subscription.deleted`
is **our own DELETE**, not the portal's. What proves the setting is the
gap, not the end time.

**That matters because two documents promise it.** Terms section 5 and
the panel's `autoRenew` disclosure both say a student keeps access
until the period they have paid for ends — a promise resting on a
dropdown that no test can see. Pinning it by passing `configuration`
explicitly is recorded as an option and NOT taken: it would mean
creating and versioning a portal configuration in code, and the
cheaper half is to verify this setting whenever the portal is touched.
Verify it here, at this step.

## 4. Set the Terms of Service URL

Stripe → Settings → Public details → **Terms of service**:

```
https://www.uniplannerapp.com/terms
```

**Not optional.** `billing-checkout` sends
`consent_collection[terms_of_service]: "required"`, and Stripe
**refuses to create a session** when that dashboard field is empty. So
a forgotten field is a checkout that cannot start rather than a missing
link — the right direction, and a five-minute diagnosis only if you
know to look. (DEPLOY-CHECKLIST §2b and §7d.)

**IT IS ACCOUNT-WIDE, NOT PER MODE — do it once.** Observed on the
dashboard, 17 September 2026, which is why it is stated as fact here
rather than as a caution: setting it in test mode is REFUSED with
*"Only live keys can access this method"*, and test mode's Customer
portal page already displays the live values. Business details are one
setting for the account.

This entry exists because the rest of this file is written per mode and
somebody will reasonably assume this field is too — then either hunt
for a test-mode setting that does not exist, or worse, read the refusal
as a broken account. The steps that genuinely are per mode are 2, 3
and 5; this one is not.

## 5. Create the webhook endpoint

```
https://kuhtogvewcooigudmgwj.supabase.co/functions/v1/stripe-webhook
```

Subscribed to exactly these seven, which are the `ACTIONABLE` set in
`supabase/functions/stripe-webhook/index.ts` — not the
`customer.subscription.*` shorthand Phase 6 uses:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
charge.refunded
```

Anything else is recorded and answered 200 without action. A list of
types to ACT on is safer than a list to ignore, because a type nobody
enumerated then does nothing rather than something unintended.

**THIS LIST IS WHAT A PERSON TYPES INTO TWO DASHBOARDS, so a drift
between it and `ACTIONABLE` reproduces the exact bug `charge.refunded`
was added to fix**: the code was ready to act on a refund and the
endpoint never sent one, so the panel promised a refund ends the plan
and nothing did it. `scripts/test-stripe.mjs` therefore reads this
fenced block and requires it to EQUAL the set in the function — the
list is derived from the code rather than kept in step with it by
memory.

`charge.refunded` is the newest, added 17 September 2026. It fires on
PARTIAL refunds too, and the handler acts only on a FULL refund of a
SUBSCRIPTION invoice — so subscribing to it cannot end a plan somebody
is still paying for.

## 5a. The restricted key needs SEVEN grants, and three of them are for refunds

If `STRIPE_SECRET_KEY` is a restricted key (`rk_live_…`) rather than a
full `sk_live_…`, it needs every grant the code's calls require — and
the refund path alone makes four calls across three resources.

| Editor row | Level | Which calls need it |
|---|---|---|
| Prices | Read | the checkout's price lookup by `lookup_key` |
| Customers | Write | creating the Stripe customer at first checkout |
| Checkout Sessions | Write | starting a checkout |
| Customer portal | Write | opening the billing portal |
| **Charges and Refunds** | **Read** | `GET /charges/{id}` — the first call of the refund path |
| **Invoices** | **Read** | `GET /invoice_payments` and `GET /invoices/{id}` |
| **Subscriptions** | **Write** | the subscription read AND the `DELETE` that cancels it |

**THE LAST THREE WERE MISSING AND IT COST A LIVE REFUND.** The first
real refund taken on the account 403'd three times, answered 503, and
Stripe retried for three days while the tier stayed paid — a test
purchase rather than a student's, which is the only reason it was
cheap. Stripe's own message named the remedy
exactly — *"Enabling Charges and Refunds Read ('charge_read')
permissions on this key would allow this request to continue"* — and
the code discarded the body before logging it, so the diagnosis needed
the dashboard instead. Both halves are fixed; the grants still have to
be right.

**ADD ALL THREE AT ONCE.** Each one only buys a single stage: with
Charges alone the next retry 403s on `invoice_payments`, and with
Invoices too it 403s on the `DELETE`. Three round trips through a
student's refund window to learn something a table could have said.

**Subscriptions must be WRITE, not Read.** Read covers the lookup and
not the cancellation, and the cancellation is the entire point — a
refund that does not end the plan leaves a refunded student with a paid
tier, which is what the panel promises does not happen.

A permission error now answers `stripe_permission_denied` rather than
`upstream_unavailable`, so it is distinguishable in a log from an
outage without reading the message.

## 6. Set the two secrets

Supabase → Edge Functions → Secrets:

| secret | value | read by |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` | all three functions |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the step-5 endpoint | `stripe-webhook` |

**Both or neither.** The webhook refuses with `stripe_disabled` (503)
unless both are set, deliberately: a signing secret with no API key
would verify deliveries it could not act on and record them as handled.

**THE TWO `whsec_` VALUES ARE DIFFERENT SECRETS.** `stripe listen`
prints one for the CLI tunnel; the dashboard endpoint has its own.
Phase 6 step 4 says to use the endpoint's and step 6 says
`stripe listen` prints one for step 4 — both true of different
rehearsals, and easy to cross. For live it is the endpoint's.

**AND SO ARE THE TEST AND LIVE ONES, WHICH DECIDES HOW THIS WHOLE
SEQUENCE RUNS.** There is ONE deployment of `stripe-webhook` and it
reads ONE secret:

```ts
const signingSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
…
const expected = await signStripePayload(signingSecret, sig.t, raw);
```

Test mode and live mode issue different signing secrets for the same
endpoint URL, so **the two cannot both verify at once** — whichever
secret is not in the environment has its deliveries rejected as
unsigned, which looks identical to a forged one. So this is not
"configure both and they coexist": run test mode end to end, then swap
BOTH secrets to live together. The live endpoint may exist from the
start; it simply will not verify until its secret is the one in place.

The alternative — accepting a list of secrets and trying each — is not
built, deliberately. It would mean a function that verifies against a
secret nobody intended to be live, and the whole point of verify-before-
parse is that exactly one key is authoritative at a time.

## 7. Deploy the Edge Functions

The workflow derives its list from the directory and passes
`--no-verify-jwt` to `stripe-webhook` and `billing-webhook` only.
Without that flag every delivery is refused by the platform before our
code runs: nothing errors, nothing is logged, and the symptom is
*"students pay and their plan never changes."*

## 8. Watch a real delivery land BEFORE flipping anything

```
stripe trigger customer.subscription.updated
```

Then confirm a row in `billing_events`:

```sql
select id, event_type, user_id, app_user_id, received_at
from billing_events
order by received_at desc
limit 5;
```

**The column is `received_at`, not `created_at`.** 0017 names it that and
indexes `(user_id, received_at desc)`; an earlier draft of this file said
`created_at` and the query simply errored. Corrected from Jared's run,
17 September 2026.

**WHAT SUCCESS LOOKS LIKE IS NOT WHAT YOU EXPECT: rows with `user_id`
NULL.** `stripe trigger` invents a customer with no `profiles` row, so
the handler records the event, writes nothing to anyone's tier, and
answers 200. That is the `no_such_user` path, and it is designed: an
event for an account we do not hold is exactly the thing to notice — a
deleted account with a live subscription, or a webhook pointed at the
wrong project — so the row is kept rather than skipped, and answered 200
because nothing about it will differ on the fourth delivery.

**MORE THAN ONE ROW IS EXPECTED, AND ONE OF THEM PROVES THE IGNORE
PATH.** `stripe trigger` builds prerequisite objects, so the run
produces a cascade — Jared's produced `customer.subscription.updated`,
`customer.subscription.created` and `invoice.paid`. The last is NOT in
`ACTIONABLE`, and seeing it recorded with no action taken is the
unenumerated-type branch working: recorded, answered 200, nothing done.
A type nobody enumerated does nothing rather than something
unintended.

### What else is visible in that table, and it is not noise

A `billing_events` query at this point also shows **RevenueCat** rows,
because `billing-webhook` writes the same table. Jared's run surfaced
EXPIRATION and CANCELLATION from 13 September 2026 — Grace's sandbox
Apple subscription lapsing on its own.

That is worth more than it looks. **The lapse path had never been
observed**: every RevenueCat delivery before it was a dashboard test
event or a purchase. A real expiry is the event that exercises the rule
a careless `max` gets wrong — a tier must be able to go DOWN — and
`tierFromProviders` is a max over rows that are still live precisely so
the last one lapsing takes the account to `free`.

**CHECK WHAT IT WROTE, because the reader and the writer disagree about
one shape.** A lapse should write `('revenuecat', 'free')` with
`expires_at` set:

```sql
select user_id, source, tier, expires_at, updated_at
from entitlements order by updated_at desc limit 10;
```

`{ tier: 'free', expires_at: null }` is **exempt and correct** — that is
the one shape `open_ended_refused` deliberately does not cover, because
a refusal covering `free` would make cancellation unrecordable and hold
every expired tier open for ever. A PAID row with a null `expires_at`
is the thing to escalate: the writer should have refused it, and the
reader now skips it, but a build deployed either side of that change
can still produce one.

## 9. Flip the client flag

`STRIPE_ENABLED = true` in `src/billingFlags.js`, merge, promote. Only
now is any purchase control drawn.

---

# Three things Phase 6 does not tell you

## Step 9 breaks four tests — it is not a one-line change

Measured by flipping the flag and running the suite:

```
FAIL - the "account" tab renders from the built bundle, signed in, on a cold mount
FAIL - every tab was actually visited, so none of the above passed over nothing
FAIL - ON WEB the same page speaks to the SDK not once
FAIL - WITH STRIPE SWITCHED OFF the web panel offers no way to pay, and still shows the tier
```

Only the last is NAMED for the off state. The other three assert
`data-purchase-unavailable` — the "where plans are bought" line that
the on state replaces with real controls — and one is the cascade from
the account tab failing.

**The flip commit must carry their on-state twins or CI blocks the
merge.** Budget an hour, not a minute.

## Nothing in the code distinguishes test mode from live

`grep` for `sk_live` / `livemode` across `_shared/stripe.ts` and the
webhook returns only a fixture string in the test file. So `sk_test_…`
with the flag on gives working-looking buttons that take test cards and
move no money, with nothing warning anyone.

That is fine as a deliberate staging step and dangerous as an accident.
**Decide which key is in that box when you flip.**

## Read `periodSource` in the first live apply's log

`STRIPE_API_VERSION` is pinned to `2026-04-22.dahlia`. Which location
that version carries `current_period_end` on — the subscription or the
items — is not answerable from this repository, which is why
`periodSource` is logged on EVERY apply rather than only on failure.

A paid row whose period cannot be read is refused
(`open_ended_refused`, nothing written, the provider retries), so a
wrong pin shows up as retries rather than as a tier that never expires.

---

# After the flag flips — what no suite can check

1. A completed checkout writes `profiles.tier`, `tier_source = 'stripe'`,
   `store = 'stripe'` and a `stripe_customer_id`.
2. The plan line updates on the 0/2/5/10-second ladder **without a
   reload** — the gap where Stripe confirms before our server hears.
3. **Manage** opens the Portal for the right customer.
4. Cancelling drops the tier **at the period end, not before**.
5. A failing card leaves the tier alone while `past_due`. `unpaid` —
   retries exhausted — does not.
6. **The price on the button is the price Stripe charges.** No test
   here can check this: the figures are derived from `site/pricing.js`,
   but the Price object belongs to the dashboard.

Return URLs ship with the function deploy and need no dashboard entry
(`_shared/stripe.ts`):

```
https://www.uniplannerapp.com/app/?checkout=done
https://www.uniplannerapp.com/app/?checkout=cancelled
```

---

**A store subscriber cannot buy here.** `billing-checkout` refuses with
`store_subscription_active` (409) and the panel says which store. Apple
and Google cannot see a Stripe subscription and will not cancel one, so
the student would be charged twice and could stop only half of it.
