# What needs a solicitor

Neither the privacy policy nor the Terms of Use has been reviewed by a
lawyer, and nothing in this repository is legal advice. This file is the
list of specific questions that a review should answer, so they are in one
findable place rather than scattered through pull request bodies where
nobody looks again.

Each item says what is known, what was done about it in the meantime, and
what is still open. **An item being mitigated is not an item being
answered.**

---

## 1. Should UniPlanner be sold outside Australia at all before the Terms are reviewed?

**Raised by Jared, 18 September 2026.** This is the biggest of the four and
it is not a refunds question.

The facts, as stated:

- **iOS 1.1.0 is available in 148 countries.**
- **Web Checkout accepts any card**, from anywhere. No country restriction
  is configured, and none has been changed while this question is open.
- **The Terms name the Australian Capital Territory** as the governing law
  (section 11, Jared's ruling of 10 September 2026).

So the app is already sold into jurisdictions whose consumer law we have
not read, under a governing-law clause chosen for one of them. A
choice-of-law clause does not reliably displace another country's
*mandatory* consumer protections, which is the whole difficulty: the clause
can be perfectly valid and still not be the end of the question.

The concrete instances we already know about:

- **EU and UK distance selling gives a 14-day right of withdrawal.** For
  digital content it can be waived, but only by express consent plus an
  acknowledgement that the right is lost — which our Checkout does not
  collect. Our own 14 days is a *discretion* conditioned on credit usage
  (see REFUNDS.md). The two look alike and are not the same thing, and ours
  is the weaker of the two where theirs applies.
- **Consumer guarantees elsewhere** are not the ACL, and the Terms only
  disclaim-and-preserve the ACL by name.

**What was done in the meantime: nothing, deliberately.** No copy change,
no Checkout country settings touched. The options, for the solicitor to
choose between rather than for us to pick:

1. Restrict sales to Australia until the Terms are reviewed.
2. Keep selling everywhere and add the mandatory-rights paragraph the
   review specifies.
3. Keep selling everywhere on advice that the current wording is adequate.

**Open.**

---

## 2. Can a 14-day window plus a usage cap read as excluding ACL guarantees?

The consumer guarantees carry no time limit and no usage limit; a major
failure entitles a remedy whenever it happens. A no-fault offer phrased
"refundable within 14 days if you have not used much" invites the reading
"and not otherwise", which would be a representation that a guarantee is
narrower than it is.

That matters more than unfairness to one student: under the ACL a
representation that a right or remedy does not exist or is limited is
itself actionable (s18 on misleading conduct, and s29(1)(m) specifically on
rights and remedies). The document would become the problem.

**What was done in the meantime**, and it is drafting rather than an
answer: the ACL paragraph comes first in section 7, states that the
guarantees carry no time or usage limit of their own, and says everything
below is offered *on top of* them and never instead. The fault-based refund
is stated as not limited by the 14 days. `scripts/test-legal.mjs` asserts
all of that, so it cannot be quietly edited away.

**Open**: whether the mitigation is sufficient.

---

## 3. Is "renewals are not refunded as a matter of course" safe?

A renewal is a fresh supply. If the service then fails, a remedy can be
owed regardless of what the Terms say about renewals, and a blanket
no-refund statement is close to the shape the ACL voids and treats as
misleading.

**What was done in the meantime:** the flat sentence was never shipped. It
reads "not refunded as a matter of course", the two cases that are our own
mistake (a renewal charged after a cancellation, a payment taken twice) are
named and refunded in full, and a test reddens if it is flattened back.

**Open**: whether the qualification is enough.

---

## 4. Is the refund threshold itself defensible as a term?

"No more than 20% of one month's credits" is a condition on a discretionary
offer, not a condition on a legal right — which is the intended reading and
may not be the only available one. Worth a sentence of advice on whether a
usage-based condition on a cooling-off-shaped offer needs to be described
differently.

**Open**, and the least urgent of the four.

---

## Not on this list, because it is decided

- **Governing law is the ACT**, named rather than left at "Australia"
  (Jared, 10 September 2026). A governing-law clause without a jurisdiction
  is the first thing a solicitor changes; item 1 above is about its reach,
  not its existence.
- **Apple's standard EULA governs App Store purchases** and our own Terms
  govern web purchases, split by platform in `termsLink`. Section 10 says
  so in prose.
