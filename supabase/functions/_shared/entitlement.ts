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
 * Write a tier, unless a human decided it.
 *
 * MANUAL WINS, ALWAYS. `tier_source = 'manual'` is how the App Review
 * account, and anyone granted a tier by hand, keeps a tier nobody
 * bought. Apple's reviewer needs working paid features or sees none of
 * them (IOS-RELEASE.md line 154), and an account whose tier is a gift
 * has no subscription for a webhook to read — so the first event that
 * touched it would take the gift away.
 *
 * SCOPED BY HAND, ON EVERY STATEMENT. This runs on the service-role
 * client, which exists to bypass RLS, so every `.eq("user_id", …)` that
 * a policy would have applied has to be written here. The id is the one
 * that came back FROM RevenueCat for this subscriber, never one lifted
 * out of a request.
 *
 * An account we have no row for is a no-op, not an insert: a
 * `profiles` row is created by the signup trigger, so its absence means
 * a deleted account or an id that was never ours. Inserting one would
 * resurrect a deleted account as a side effect of a webhook.
 */
// deno-lint-ignore no-explicit-any
export async function applyEntitlement(
  admin: any,
  { userId, tier, store, expiresAt }: { userId: string; tier: BillingTier; store: string | null; expiresAt: string | null }
): Promise<{ ok: boolean; outcome: string; before?: string | null; after?: string | null; error?: unknown }> {
  const { data: profile, error: readErr } = await admin
    .from("profiles")
    .select("tier, tier_source")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) return { ok: false, outcome: "read_failed", error: readErr };
  if (!profile) return { ok: true, outcome: "no_such_user" };
  if (profile.tier_source === "manual") return { ok: true, outcome: "manual_override", before: profile.tier, after: profile.tier };

  /* Written even when the tier is unchanged, because the other three
     columns move on a renewal that changes nothing else: a new
     expiry, and sometimes a new store after a cross-platform restore.
     A no-op guard here would freeze those. */
  const { error: writeErr } = await admin
    .from("profiles")
    .update({
      tier,
      tier_source: "revenuecat",
      tier_updated_at: new Date().toISOString(),
      entitlement_expires_at: expiresAt,
      store,
    })
    .eq("user_id", userId);

  if (writeErr) return { ok: false, outcome: "write_failed", before: profile.tier, error: writeErr };
  return { ok: true, outcome: profile.tier === tier ? "unchanged" : "changed", before: profile.tier, after: tier };
}
