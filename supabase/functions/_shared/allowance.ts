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

import { allowanceForTier, MAX_FREE_PHOTO_PAGES } from "./credits.ts";
import { photoCapDecision } from "./photoCap.js";

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

/**
 * Count photographed pages against a trial account's lifetime cap.
 *
 * A SECOND WRITE RATHER THAN A PARAMETER on the credits RPC, because
 * adding one would create an overload rather than replacing the
 * function — see 0021. The cost is that a crash between the two leaves
 * an account billed for a batch whose pages were not counted: bounded
 * at one batch, in the student's favour, and the reverse ordering
 * would count pages for work that was never billed.
 *
 * Nothing to do on a paid tier, and NO QUERY IS MADE for one — the
 * column is simply never read or written outside the trial.
 *
 * A failure is reported and does NOT fail the request, the same rule
 * as billAllowance: the work is done and the student has it.
 */
// deno-lint-ignore no-explicit-any
export async function billPhotoPages(admin: any, { userId, profile, pages }: Record<string, any>) {
  const asked = Number(pages) || 0;
  /* Same rule as checkPhotoPages, for the same reason: counting must
     cover exactly the accounts the cap covers, or an unknown tier is
     refused against a counter nothing increments. */
  if (asked <= 0 || allowanceForTier(String(profile?.tier)).perMonth) return { ok: true, counted: null };
  const { data, error } = await admin.rpc("add_trial_photo_pages", {
    p_user_id: userId,
    p_pages: asked,
  });
  if (error) return { ok: false, error };
  const row = Array.isArray(data) ? data[0] : data;
  const total = row && row.new_trial_photo_pages;
  return { ok: true, counted: typeof total === "undefined" || total === null ? null : Number(total) };
}

/* ==================================================================
   THE TRIAL'S PHOTOGRAPHED-PAGE CAP

   PURE, and it takes the cap as an argument, so the whole table is a
   test rather than something only a deployed function can answer.

   WHY IT IS NOT JUST THE ALLOWANCE. A photo batch is 18 credits and
   the trial is 60, so a free account can put 54 of its 60 credits into
   three batches of photographs and never record the lecture — which is
   the other half of what the trial is meant to demonstrate. credits.ts
   says a trial demonstrates ONE BATCH; this is what makes that true.

   IT COUNTS PAGES, NOT BATCHES, because a partial batch is still
   pages: three plus three plus three is nine pages and would pass a
   two-batch cap.

   THE REFUSAL NAMES WHAT IS LEFT, not just that there is a limit. A
   student told "you have 4 pages left" can send four; one told "you've
   hit the limit" has been told to go away. Same rule as
   sectionsAffordable, which exists for exactly this reason.

   PAID TIERS ARE NOT CAPPED: credits meter them, and a cap on top of a
   meter is a second limit to explain and a second one to get wrong. */
export function checkPhotoPages(
  { tier, pagesUsed, pages, cap = MAX_FREE_PHOTO_PAGES }: Record<string, unknown> & { cap?: number },
) {
  /* THE SAME QUESTION THE ALLOWANCE ASKS, and not `isTrialTier`. The
     two disagree on an UNKNOWN tier: `isTrialTier` says no, while
     `allowanceForTier` gives it the trial — deliberately, because a
     typo in the dashboard should cost a demonstration rather than
     three thousand credits a month. Asking the narrower question here
     would hand a mistyped tier UNCAPPED photographs, which is the
     expensive direction, so both branches are decided by one rule.
     Caught by the row named "an unknown tier" in test-readings.mjs. */
  return photoCapDecision({
    perMonth: allowanceForTier(String(tier)).perMonth,
    pagesUsed,
    pages,
    cap,
  });
}
