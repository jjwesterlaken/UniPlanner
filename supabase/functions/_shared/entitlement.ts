/* ==================================================================
   entitlement.ts — what a subscriber is entitled to, and how that
   becomes a tier

   THE ONE RULE THIS FILE EXISTS TO HOLD: the webhook payload is a
   TRIGGER, never evidence. Nothing here reads an entitlement claim out
   of a delivered event; every function takes the SUBSCRIBER RECORD that
   was fetched back from RevenueCat after the event arrived, and the
   tier is computed from that.

   WHY, and it is not paranoia about forgery alone. Three separate
   problems collapse into one answer:

   - AUTHENTICATION IS A SHARED SECRET, not a per-user proof. Even with
     the signature verified, a header and a signing key are two values;
     the day either leaks, an attacker who can also forge a body would
     be granting themselves tiers. Re-reading means the worst a forged
     event can do is make us ask RevenueCat about a user and write what
     RevenueCat already believes. That is a wasted request, not a theft.
   - ORDERING. Webhook deliveries are not ordered. A CANCELLATION that
     overtakes the RENEWAL after it would, under payload-trust, leave a
     paying student unsubscribed. Re-reading makes every event mean the
     same thing — "go and look" — so the order they arrive in stops
     mattering.
   - REDELIVERY. A retried event replays a claim. It cannot replay a
     fact.

   It is also RevenueCat's own documented recommendation after any
   webhook, which is the cheapest kind of agreement to have.

   The cost is one API call per event. At this app's volume that is
   nothing, and it is the same trade `fetchNote` makes: never act on
   the absence of evidence, act on the definitive answer.
   ================================================================== */

/* THE TIERS, RANKED. Index is rank, so "highest active entitlement
   wins" is a max over indices rather than a chain of ifs somebody
   later reorders. `free` is rank 0 and is not an entitlement — it is
   what you have when none of the others is active.

   THE ENTITLEMENT IDS ARE THE TIER STRINGS THEMSELVES (Jared, Phase
   0), so the mapping from RevenueCat's world to ours is the identity
   function and there is no table to drift. A test asserts these are
   exactly the paid tiers in _shared/credits.ts, which is the only
   other place the strings live. */
export const TIER_RANK = ["free", "ai", "ai_max"] as const;
export type BillingTier = (typeof TIER_RANK)[number];

/** The entitlement ids a subscriber can hold. Not `free`, which is the absence of all of them. */
export const PAID_ENTITLEMENTS: readonly string[] = TIER_RANK.slice(1);

/* WHO WROTE THIS TIER. `signup` and `manual` are set elsewhere (the
   trigger, and a human in the dashboard); these two are the automated
   writers, and 0017's CHECK names all four.

   TWO SOURCES, ONE WRITER — the phrase is BILLING-PLAN §6's and it is
   the whole design. A Stripe subscription and an App Store one reach
   `profiles.tier` through this same function, each having re-read its
   OWN provider first, so there is exactly one place that decides what a
   write to that column looks like. What differs is the sentence in
   `tier_source`, which is how a support question ("where did this plan
   come from?") is answerable at all.

   THE HAZARD THAT COMES WITH TWO SOURCES — and it was WRITTEN DOWN
   HERE AS ACCEPTED before it was handled, which is this project's own
   "a rule written beside one caller is not a guard" one more time.

   Each writer re-reads only its OWN provider. So for a student paying
   through Stripe who also has last year's App Store subscription
   lapsing: Stripe renews and sets `ai`; the Apple EXPIRATION lands,
   RevenueCat is re-read, holds nothing active, `tierFromSubscriber`
   returns `free` — and `free` is written over a live, paid Stripe
   entitlement. The student is being charged and has lost what they are
   paying for, and nothing errors.

   The old note pointed at `billing-checkout`'s `store_subscription_active`
   refusal as closing "the door we control". It does not close this one:
   that refusal stops a NEW Stripe checkout while a store subscription
   is live, and says nothing about the reverse order or about an OLD
   store subscription expiring months later.

   SO A TIER IS A MAX, NOT A RACE. `applyEntitlement` records what the
   calling provider asserts in `entitlements` (one row per provider,
   migration 0020) and then sets `profiles.tier` to the highest tier any
   provider currently grants. A provider can only ever speak for itself.

   AND A MAX MUST STILL BE ABLE TO GO DOWN, which is the half that gets
   forgotten: the max is over rows that are STILL LIVE, so the last one
   lapsing takes the account to `free`. A test is named for exactly
   that, beside the two orderings. */
export const ENTITLEMENT_SOURCES = ["revenuecat", "stripe"] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/* RevenueCat's store names to ours. Ours are the three
   `profiles.store` accepts (migration 0017); anything else — amazon,
   promotional, a store that does not exist yet — becomes null rather
   than being coerced into the nearest match, because this column
   decides which "manage your subscription" link a student is sent to
   and a wrong one sends them to a store that has never heard of them. */
const STORES: Record<string, string> = {
  app_store: "app_store",
  mac_app_store: "app_store",
  play_store: "play_store",
  stripe: "stripe",
};

export const normaliseStore = (store: unknown): string | null =>
  typeof store === "string" ? STORES[store.toLowerCase()] ?? null : null;

/**
 * Is an entitlement live at `now`?
 *
 * A null or absent `expires_date` means a non-expiring entitlement,
 * which is how a lifetime purchase and some promotional grants read.
 * THIS FUNCTION REPORTS WHAT REVENUECAT SAYS AND NOTHING ELSE — it is
 * a reader of their record, so it must not answer `false` to a thing
 * they consider live. Whether WE honour an open-ended subscription
 * entitlement is a policy, it is `no`, and it lives in exactly one
 * place: `applyEntitlement` refuses to record one. Putting it here as
 * well would be the same decision made twice, in two functions that
 * can drift.
 *
 * An UNPARSEABLE date reads as NOT active, deliberately: the two
 * failure directions are "a student briefly loses a tier they paid
 * for, and the next event restores it" against "an entitlement never
 * expires because its date was malformed". The first is visible and
 * self-correcting; the second is silent and permanent.
 */
export function isActive(entitlement: Record<string, unknown> | null | undefined, now = Date.now()): boolean {
  if (!entitlement || typeof entitlement !== "object") return false;
  const raw = (entitlement as { expires_date?: unknown }).expires_date;
  if (raw === null || raw === undefined) return true;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) && ms > now;
}

/**
 * The tier a SUBSCRIBER RECORD implies — the whole decision, in one
 * pure function so the awkward cases are a table in a test rather than
 * something only a live purchase can answer.
 *
 * Takes RevenueCat's `subscriber` object (the body of
 * GET /v1/subscribers/{id}), never a webhook event.
 *
 * Returns `free` for a subscriber with nothing active, which is the
 * correct answer for a lapsed, refunded or never-subscribed account
 * and is also what an EXPIRATION event resolves to without any code
 * knowing what expiry means.
 */
export function tierFromSubscriber(
  subscriber: Record<string, unknown> | null | undefined,
  now = Date.now()
): { tier: BillingTier; store: string | null; expiresAt: string | null; entitlement: string | null } {
  const entitlements = (subscriber?.entitlements ?? {}) as Record<string, Record<string, unknown>>;

  let best: { rank: number; id: string; ent: Record<string, unknown> } | null = null;
  for (const id of PAID_ENTITLEMENTS) {
    const ent = entitlements[id];
    if (!isActive(ent, now)) continue;
    const rank = TIER_RANK.indexOf(id as BillingTier);
    if (!best || rank > best.rank) best = { rank, id, ent };
  }

  if (!best) return { tier: "free", store: null, expiresAt: null, entitlement: null };

  /* The store comes from the SUBSCRIPTION the winning entitlement
     points at, not from the event's own `store` field — the event
     names the store that produced THIS event, which on a transfer or a
     cross-platform restore is not necessarily the store the active
     subscription lives in. */
  const productId = String(best.ent.product_identifier ?? "");
  const subs = (subscriber?.subscriptions ?? {}) as Record<string, Record<string, unknown>>;
  const store = normaliseStore(subs[productId]?.store);

  const expires = best.ent.expires_date;
  return {
    tier: TIER_RANK[best.rank],
    store,
    expiresAt: expires === null || expires === undefined ? null : String(expires),
    entitlement: best.id,
  };
}

/* A Supabase user id is a UUID; a RevenueCat app user id is whatever
   the client set it to, and for an anonymous client that is
   "$RCAnonymousID:...". This is the filter that keeps the webhook from
   ever pointing a write at something that is not one of our accounts —
   the 0009 boundary, seen from the other side: an id minted elsewhere
   crossing into a typed column, checked BEFORE it gets there rather
   than after Postgres rejects it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isOurUserId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

/**
 * Every account id an event could be about.
 *
 * A TRANSFER moves an entitlement between two of our accounts and the
 * event names BOTH — and, on RevenueCat's side, may leave `app_user_id`
 * null while carrying the ids in `transferred_from` / `transferred_to`.
 * Re-reading only one of them leaves the other holding a tier it no
 * longer has, which is the failure mode where somebody keeps a paid
 * plan they gave away.
 *
 * Collected as a SET over every id-shaped field rather than branched on
 * the event type, because a type we have not enumerated is exactly the
 * case where guessing which field matters costs a wrong tier.
 */
export function affectedUserIds(event: Record<string, unknown> | null | undefined): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (isOurUserId(v)) out.add(v);
  };
  add(event?.app_user_id);
  add(event?.original_app_user_id);
  for (const key of ["transferred_from", "transferred_to"]) {
    const list = event?.[key];
    if (Array.isArray(list)) list.forEach(add);
  }
  return [...out];
}

/**
 * The tier a set of PER-PROVIDER assertions implies: the highest one
 * that is still live.
 *
 * Pure, so the awkward cases are a table in a test rather than
 * something only two overlapping subscriptions can answer. Takes the
 * rows of `entitlements` for one account.
 *
 * A ROW WHOSE EXPIRY HAS PASSED DOES NOT COUNT. Normally a provider
 * tells us — an expiry arrives and writes `free` — so this filter is
 * the backstop for the provider that goes quiet instead, which is the
 * failure that would otherwise hold a tier open forever.
 *
 * AND A ROW WITH NO EXPIRY AT ALL DOES NOT COUNT EITHER, which is the
 * half that used to be wrong. Every row in this table is one
 * PROVIDER'S assertion about a SUBSCRIPTION (`ENTITLEMENT_SOURCES`),
 * and a subscription always has a period end; a null there is a field
 * we failed to read, never a grant that runs forever. Reading it as
 * `Infinity` — which is what this did — disables the backstop above
 * for precisely the row whose data we already know is wrong, in the
 * direction `isActive` names as silent and permanent. Only a MANUAL
 * grant may be open-ended, and a manual grant is not a row here at
 * all: it is `profiles.tier_source = 'manual'`, which short-circuits
 * `applyEntitlement` before any of this runs.
 *
 * This is the READER's half. The writer refuses to create such a row
 * in the first place, and the two are not redundant: the writer stops
 * new ones, this one is what stops an EXISTING bad row — written by a
 * build deployed before the refusal — from holding a tier open for
 * ever.
 *
 * AN UNPARSEABLE DATE READS AS EXPIRED, for `isActive`'s reason: a
 * student briefly losing a tier is visible and self-correcting, an
 * entitlement that never expires is silent and permanent.
 *
 * The winner carries `store` and `expiresAt` with it, because those
 * describe the subscription the student would have to go and cancel —
 * so they must come from the row that is actually granting the tier,
 * not from whichever provider happened to send the last event.
 */
export function tierFromProviders(
  rows: Array<{ source?: string; tier?: string; store?: string | null; expires_at?: string | null }> | null | undefined,
  now = Date.now()
): { tier: BillingTier; store: string | null; expiresAt: string | null; source: EntitlementSource | null } {
  let best: { rank: number; store: string | null; expiresAt: string | null; source: EntitlementSource; until: number } | null = null;

  for (const row of rows ?? []) {
    const rank = TIER_RANK.indexOf(row?.tier as BillingTier);
    if (rank <= 0) continue;                       // absent, unknown, or `free` — not an entitlement
    if (!ENTITLEMENT_SOURCES.includes(row?.source as EntitlementSource)) continue;

    const raw = row?.expires_at;
    if (raw === null || raw === undefined) continue;   // open-ended, which no provider row may be
    const until = Date.parse(String(raw));
    if (!(until > now)) continue;                      // expired, or a date we cannot read

    /* Highest tier wins; between two providers granting the SAME tier,
       the one that lasts longer, because that is the subscription the
       student still has after the other lapses. Deterministic to the
       end: the source order breaks a remaining tie, so two runs over
       the same rows can never disagree about which store to name. */
    const better =
      !best ||
      rank > best.rank ||
      (rank === best.rank && until > best.until) ||
      (rank === best.rank &&
        until === best.until &&
        ENTITLEMENT_SOURCES.indexOf(row.source as EntitlementSource) < ENTITLEMENT_SOURCES.indexOf(best.source));

    if (better) {
      best = {
        rank,
        store: row?.store ?? null,
        expiresAt: String(raw),
        source: row.source as EntitlementSource,
        until,
      };
    }
  }

  if (!best) return { tier: "free", store: null, expiresAt: null, source: null };
  return { tier: TIER_RANK[best.rank], store: best.store, expiresAt: best.expiresAt, source: best.source };
}

/**
 * Record what ONE provider asserts, then set the tier to what ALL of
 * them together imply.
 *
 * ONLY A MANUAL GRANT MAY BE OPEN-ENDED (Jared, 10 September 2026), so
 * a PAID tier asserted with NO EXPIRY is REFUSED and nothing is
 * written. Every source in `ENTITLEMENT_SOURCES` is a provider speaking
 * about a SUBSCRIPTION, and a subscription has a period end; a null
 * there means we failed to read the field, which is how a live Stripe
 * subscription came to write `expires_at = NULL` while
 * `current_period_end` sat in the payload.
 *
 * REFUSING rather than recording-and-ignoring, and the direction is the
 * whole point. The reader (`tierFromProviders`) now skips such a row, so
 * WRITING it would demote a student who is paying — silently, on the
 * strength of a field we could not parse. A refusal writes nothing, so
 * the previous tier stands, the webhook answers 5xx, the provider
 * retries, and the log names the source and the tier. The cost is a
 * retry loop while the field is unreadable; the alternative costs
 * somebody the plan they are being charged for.
 *
 * `free` IS EXEMPT, and must be: a cancellation is asserted as
 * `{ tier: "free", expiresAt: null }` and is the normal shape of every
 * lapse. Refusing it would make cancellations impossible to record and
 * hold every expired tier open — the exact failure this rule exists to
 * close, inverted.
 *
 * IT COMES AFTER THE USER IS RESOLVED AND AFTER `manual`, which is the
 * same ordering the unrecognised-price refusal uses: refuse only when
 * there is somebody to protect. Refusing before `no_such_user` would
 * retry forever on behalf of an account we do not have, and refusing
 * before `manual` would 5xx over a gift that was never going to be
 * touched.
 *
 * MANUAL WINS, ALWAYS. `tier_source = 'manual'` is how the App Review
 * account, and anyone granted a tier by hand, keeps a tier nobody
 * bought. Apple's reviewer needs working paid features or sees none of
 * them (IOS-RELEASE.md line 154), and an account whose tier is a gift
 * has no subscription for a webhook to read — so the first event that
 * touched it would take the gift away. It short-circuits BEFORE the
 * provider row is written: a manual tier is a decision about the
 * account, and recording assertions underneath it would mean the day
 * somebody clears `manual` the account silently inherits whatever the
 * providers last said.
 *
 * TWO WRITES, IN THIS ORDER, AND THE ORDER IS THE USUAL ONE. The
 * provider row goes first, then the derived tier. An interruption
 * between them leaves an account whose recorded facts are ahead of its
 * tier — which the next event of ANY kind repairs, because the derive
 * step reads every row. The reverse would put a tier on an account
 * whose rows do not justify it, and nothing would ever notice.
 *
 * SCOPED BY HAND, ON EVERY STATEMENT. This runs on the service-role
 * client, which exists to bypass RLS, so every `.eq("user_id", …)` that
 * a policy would have applied has to be written here. The id is the one
 * that came back FROM the provider for this subscriber, never one
 * lifted out of a request.
 *
 * An account we have no row for is a no-op, not an insert: a
 * `profiles` row is created by the signup trigger, so its absence means
 * a deleted account or an id that was never ours. Inserting one would
 * resurrect a deleted account as a side effect of a webhook — and the
 * `entitlements` row is not written either, for the same reason and
 * because its foreign key would refuse it anyway.
 */
// deno-lint-ignore no-explicit-any
export async function applyEntitlement(
  admin: any,
  {
    userId,
    tier,
    store,
    expiresAt,
    source = "revenuecat",
    now = Date.now(),
  }: {
    userId: string;
    tier: BillingTier;
    store: string | null;
    expiresAt: string | null;
    source?: EntitlementSource;
    now?: number;
  }
): Promise<{
  ok: boolean;
  outcome: string;
  before?: string | null;
  after?: string | null;
  asserted?: BillingTier;
  effectiveSource?: EntitlementSource | null;
  error?: unknown;
}> {
  const { data: profile, error: readErr } = await admin
    .from("profiles")
    .select("tier, tier_source")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) return { ok: false, outcome: "read_failed", error: readErr };
  if (!profile) return { ok: true, outcome: "no_such_user" };
  if (profile.tier_source === "manual") return { ok: true, outcome: "manual_override", before: profile.tier, after: profile.tier };

  /* ONLY A MANUAL GRANT MAY BE OPEN-ENDED. See the note above for why
     this refuses instead of recording, why `free` is exempt, and why it
     sits below the two branches above rather than at the top. */
  if (TIER_RANK.indexOf(tier) > 0 && (expiresAt === null || expiresAt === undefined)) {
    return {
      ok: false,
      outcome: "open_ended_refused",
      before: profile.tier,
      asserted: tier,
      error: new Error(
        `${source} asserted ${tier} with no expiry; only a manual grant may be open-ended, so nothing was written`
      ),
    };
  }

  /* 1. WHAT THIS PROVIDER SAYS. Keyed (user_id, source), so a
        redelivery updates rather than accumulating — the max would
        otherwise be taken over a growing pile of stale assertions. */
  const { error: recordErr } = await admin
    .from("entitlements")
    .upsert(
      { user_id: userId, source, tier, store, expires_at: expiresAt, updated_at: new Date(now).toISOString() },
      { onConflict: "user_id,source" }
    );

  if (recordErr) return { ok: false, outcome: "record_failed", before: profile.tier, asserted: tier, error: recordErr };

  /* 2. WHAT EVERY PROVIDER SAYS. Read back rather than merged in
        memory: another provider's row may have been written by another
        request between the two statements, and the database holds the
        only complete answer. A FAILED READ IS NOT AN EMPTY ONE — it
        returns without writing, so the tier keeps its previous value
        and the retry re-derives. Deriving `free` from a failed read is
        the `fetchNote` mistake with a paid subscription attached. */
  const { data: rows, error: rowsErr } = await admin
    .from("entitlements")
    .select("source, tier, store, expires_at")
    .eq("user_id", userId);

  if (rowsErr) return { ok: false, outcome: "derive_failed", before: profile.tier, asserted: tier, error: rowsErr };

  const effective = tierFromProviders(rows, now);

  /* 3. THE PROJECTION. Written even when the tier is unchanged,
        because the other three columns move on a renewal that changes
        nothing else: a new expiry, and sometimes a new store after a
        cross-platform restore. A no-op guard here would freeze those.

        `tier_source` names the provider whose subscription is actually
        granting the tier — not the one that sent this event. On the
        expiry that used to cause the demotion, that is the difference
        between the row saying `revenuecat` over a Stripe subscription
        and saying what is true. */
  const { error: writeErr } = await admin
    .from("profiles")
    .update({
      tier: effective.tier,
      tier_source: effective.source ?? source,
      tier_updated_at: new Date(now).toISOString(),
      entitlement_expires_at: effective.expiresAt,
      store: effective.store,
    })
    .eq("user_id", userId);

  if (writeErr) return { ok: false, outcome: "write_failed", before: profile.tier, asserted: tier, error: writeErr };
  return {
    ok: true,
    outcome: profile.tier === effective.tier ? "unchanged" : "changed",
    before: profile.tier,
    after: effective.tier,
    /* What THIS provider asserted, kept distinct from what the account
       ended up with. They differ exactly when another provider is
       carrying the tier, which is the case worth seeing in a log. */
    asserted: tier,
    effectiveSource: effective.source,
  };
}
