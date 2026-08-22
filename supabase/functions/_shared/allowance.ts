/* ==================================================================
   allowance.ts — reading and billing the allowance, once for both
   functions

   THE BRANCH THIS EXISTS TO HOLD: an account's credits live in one of
   two places depending on its tier, and the two functions must agree
   about which. A monthly tier's spend is a row in `ai_usage` keyed
   (user_id, month); a trial tier's is a column on `profiles` with no
   month in it at all. Two copies of that branch is two chances to bill
   the wrong counter, and billing the wrong counter on a trial tier
   means the lifetime allowance silently refills every month.

   TWO ORDERING RULES SURVIVE UNCHANGED, and both are load-bearing:

   - THE READ PRECEDES THE PROVIDER CALL. That is what makes a missing
     column and an exhausted allowance both fail having spent nothing,
     and it is pinned by a traced fake. Nothing here checks anything;
     it reads, and the caller decides.
   - THE WRITE IS ATOMIC, in the database, under the row lock that
     `ON CONFLICT DO UPDATE` (or a bare UPDATE) takes. A
     read-modify-write loses one of any two overlapping requests, which
     on a LIFETIME counter is permanent rather than expiring with the
     month.
   ================================================================== */

import { allowanceForTier } from "./credits.ts";

/**
 * What this account has spent, against what it is allowed.
 *
 * `profile` is the row the tier lookup already fetched, so a trial tier
 * costs NO extra query — its counter is a column on that same row. Only
 * a monthly tier reaches the database again.
 *
 * Returns `{ error }` rather than a number when the read fails, because
 * a failed read is not zero: the whole reason this happens before the
 * provider call is so a broken query refuses instead of spending.
 */
// deno-lint-ignore no-explicit-any
export async function readAllowance(admin: any, { userId, profile, month }: Record<string, any>) {
  const { credits: limit, perMonth } = allowanceForTier(profile?.tier);

  if (!perMonth) {
    return { ok: true, used: Number(profile?.trial_credits_used) || 0, limit, perMonth };
  }

  const { data, error } = await admin
    .from("ai_usage")
    .select("credits_used")
    .eq("user_id", userId)
    .eq("month", month)
    .maybeSingle();
  if (error) return { ok: false, error, limit, perMonth };
  return { ok: true, used: Number(data?.credits_used) || 0, limit, perMonth };
}

/**
 * Add `credits` to whichever counter this tier uses.
 *
 * Returns the POST-INCREMENT total, so a caller reports the figure the
 * database holds rather than one it computed from a read taken before
 * the provider call.
 *
 * A failure here is logged loudly and does NOT fail the request: the
 * work is done and the student has it. An unbilled success is a revenue
 * hole; an error shown for work that succeeded is a worse one.
 */
// deno-lint-ignore no-explicit-any
export async function billAllowance(admin: any, { userId, profile, month, credits }: Record<string, any>) {
  const { perMonth } = allowanceForTier(profile?.tier);
  const { data, error } = perMonth
    ? await admin.rpc("add_ai_credits", { p_user_id: userId, p_month: month, p_credits: credits })
    : await admin.rpc("add_trial_credits", { p_user_id: userId, p_credits: credits });
  if (error) return { ok: false, error };
  const row = Array.isArray(data) ? data[0] : data;
  const total = row && (row.new_credits ?? row.new_trial_credits);
  return { ok: true, used: typeof total === "undefined" || total === null ? null : Number(total) };
}
