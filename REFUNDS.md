# Applying the refund policy by hand

The policy is in [Terms section 7](public/terms.html) and, in short form, on
the [support page](public/support.html). This file is the part that is not
public: the queries that turn "a small portion of your credits" into a number,
and the order to do things in.

**The rule, restated once so this file stands alone:** a web subscriber's
FIRST payment is refundable in full within 14 days if they have spent no more
than **20% of one month's credits**. Everything else is either a fault case
(refund it, no window, no threshold), a store purchase (not ours), or a
renewal (not refunded unless we charged it after a cancellation or twice).

The figures below are not typed here — `scripts/test-legal.mjs` re-derives
them from `credits.ts` and fails if the documents and the code disagree. If
a tier's allowance changes, the documents change with it.

| Tier | A month's credits | 20% threshold |
|---|---|---|
| Study AI | 900 | **180** |
| Study AI Max | 3,000 | **600** |

**Why 20% and not 10%** (Jared, 18 September 2026): recording costs about
one credit a minute, so 90 credits would have ruled out a student who
recorded a single two-hour lecture and decided the app was not for them
&mdash; which is the commonest refund there is. 180 is three hours of
lecture. The threshold has to clear the first real use of the feature, or
it refuses exactly the person the window is for.

## 1. Is it ours to refund?

```sql
select tier, tier_source, store, stripe_customer_id
from profiles where user_id = '<uid>';
```

`store = 'stripe'` and a `stripe_customer_id` means we took the payment and
we can refund it. `app_store` or `play_store` means we cannot — send them to
Apple or Google, which is what the support page already does.

## 2. Is it the first payment, and is it within 14 days?

```sql
select id, event_type, received_at
from billing_events
where user_id = '<uid>' order by received_at asc;
```

The earliest row is the first payment we ever took from that account, which
is what the 14 days runs from — **not** the start of the current
subscription. Stripe's own dashboard is the authority on the charge itself;
this is the cheap lookup.

**Why the account and not the subscription:** it stops subscribe-refund-
resubscribe from being a free month on repeat. It is the harsher of the two
readings, so a student who genuinely comes back a year later and has a real
problem is covered by the fault cases and by the ACL instead — both of which
have no window at all.

## 3. How many credits have they spent?

```sql
select coalesce(sum(credits_used), 0) as credits_spent
from ai_usage where user_id = '<uid>';
```

**One query, and summing every row is correct here rather than lazy.**
`ai_usage` only ever accumulates PAID spend — `_shared/allowance.ts` sends a
trial tier's spend to `profiles.trial_credits_used` instead — so on a first
payment every row in it is post-payment by construction. That is also why
the window straddling a month boundary does not matter: subscribing on 25
September and asking on 5 October leaves two rows, and the sum is the answer.

Compare against the threshold in the table above for their tier. At or under
it, refund. Over it, the 14-day offer does not apply — but read step 5
before saying no.

## The path a refund takes, PROVEN LIVE

Confirmed end to end on 18 September 2026, on the first real refund the
account has taken. Recorded because two of the three hops turned out to
use the newer of two possible shapes, and neither was answerable from
this repository until a delivery said so.

```
charge.refunded
  → GET /charges/{id}                      refunded: true
  → GET /invoice_payments?payment[...]     invoice_id_source: invoice_payments
  → GET /invoices/{id}                     invoice_source: parent
  → GET /subscriptions/{id}                status: active
  → DELETE /subscriptions/{id}             status: canceled
  → apply                                  before: ai, after: free
```

The evidence line, which is the one to look for in the function log:

```json
{"stage":"refund_ends_subscription","invoice_id_source":"invoice_payments","invoice_source":"parent"}
```

**BOTH SOURCES ARE THE NEWER SHAPE, and both legacy fields are dead on
this pinned version.** `charge.invoice` is gone (2025-03-31.basil moved
the link to InvoicePayment) and `invoice.subscription` is gone
(the subscription moved under `parent.subscription_details`). The code
still reads both legacy fields FIRST, because what is confirmed is what
`2026-04-22.dahlia` sends TODAY and a pin is a thing somebody changes —
an observation tells you which branch is live, never that the other one
is dead.

**Stripe then sends its own `customer.subscription.deleted`** for the
cancellation we just made, which re-derives `free` and writes the same
value. That is idempotent by design and is not a second decision.

## 4. Refund it, in this order

1. **Refund the charge in Stripe** (dashboard → the payment → Refund).
2. **Check the tier dropped.** The refund fires `charge.refunded`, and
   `stripe-webhook` cancels the subscription in Stripe and writes the tier
   back to `free` through the ordinary apply path. Confirm:

   ```sql
   select tier, tier_source from profiles where user_id = '<uid>';
   select tier, expires_at from entitlements where user_id = '<uid>';
   ```

   Expect `free`, and `{ tier: 'free', expires_at: null }` on the row.
3. **If the tier did not move**, the event is in `billing_events` with an
   outcome that says why. A partial refund is `partial_refund` and does
   nothing on purpose. Anything else, read the function logs.

**Do not cancel the subscription by hand first.** The refund does it, and
doing it yourself first turns the refund into a cancellation we then refund
separately — two events about one decision, and the second one arrives
against an already-cancelled subscription.

## 5. When to say yes anyway

The threshold decides the no-questions case. It does not decide the answer.

- **Something did not work.** No window, no threshold. Terms section 7 says
  so in as many words, and the ACL says it louder.
- **A renewal after a cancellation, or a double charge.** Always refunded in
  full. These are our mistakes.
- **We withdrew something central to a paid plan mid-term.** Section 8 names
  this as a refund case.
- **The Australian Consumer Law.** It has no time limit and no usage limit,
  and it sits above everything in this file. If a request looks like a major
  failure to supply what we said we would, the 14 days is irrelevant.

## What the threshold costs us

Refunding at the cap means eating the provider spend behind those credits.
Derived from `USD_PER_CREDIT` in `credits.ts`:

| | credits | provider spend written off |
|---|---|---|
| Study AI at the cap | 180 | **~$0.12** |
| Study AI Max at the cap | 600 | **~$0.41** |

Twelve cents and forty-one cents. The threshold is not there to protect the
margin — at these numbers 20% could be 60% and it would not matter
financially. It is there so "a small portion" is a number rather than an
argument, and so the offer cannot be used to run a month's credits through
the AI and then ask for the money back. **That is the thing the cap is
sized against: usage, not cost.**

## The one setting this policy rests on, and how you find out it moved

Steps 4 and 5 both assume a cancelled plan runs to the end of the paid
period. Terms §5 says so and the panel's auto-renew line says so, and on
the web the whole promise rests on **one dropdown in Stripe → Settings →
Billing → Customer portal → cancellation behaviour**. Nothing in this
repository can read it, and `billing-portal` sends only `customer` and
`return_url`, so whatever it says is what a student gets.

Pinning a portal configuration was considered and refused —
`_shared/stripe.ts` has the reasoning, and the short version is that a
bad configuration id fails the session outright, so it trades "a
dropdown somebody would have to go and change" for "nobody can cancel
at all".

**So the dropdown is observed instead.** Every cancellation is logged,
and the two settings produce different lines:

| the dropdown says | the log line reads |
|---|---|
| cancel at period end | `"stage":"cancellation","kind":"scheduled"` |
| cancel immediately | `"stage":"failure","stage":"portal_configuration","kind":"immediate"` |

The healthy one is logged deliberately, not just the anomaly: a promise
nobody can see being kept is one nobody notices being broken.

**If a `portal_configuration` line appears**, read `seconds_lost` — it
says how much paid time that student lost, and it is the number the
conversation is about. Then check the dropdown. The line fires only when
a **paid** period ended early and nothing accounts for it: a refund we
issued, a failed card, a gifted tier and a cancellation that landed on
its period end are each excluded by name.

## Not decided here

Four questions about this policy need a solicitor rather than a decision,
and they are listed in **[LEGAL-REVIEW.md](LEGAL-REVIEW.md)** with what is
known about each. None of them is resolved by this file, and the one about
selling outside Australia is bigger than refunds.
