/* ==================================================================
   photoCap.js — the trial's photographed-page rule, as plain JS

   PLAIN JS AND NO IMPORTS, for the reason `aiProviders.js` is: a module
   under `_shared/` with no Deno and no browser APIs can be imported by
   the EDGE FUNCTION, re-exported into the WEB BUNDLE, and loaded
   directly by a plain-Node test. A `.ts` file is none of those things
   without type stripping, which Node only enables unflagged from
   22.18 — and `.nvmrc` says 22, so a colleague on 22.10 would find the
   suite unrunnable rather than failing. That is the `.bin` shim and the
   drive-letter URL again: a platform the suite never runs on is a
   platform it cannot speak for.

   IT TAKES `perMonth` RATHER THAN A TIER, so it holds no opinion about
   which tiers are trials. That question already has one answer, in
   `allowanceForTier`, and asking it twice is how the cap and the
   allowance came to disagree about an unknown tier — the cap saying
   "not a trial, so uncapped" while the allowance said "unknown, so give
   it the trial". The expensive direction, caught by a test row.
   ================================================================== */

/**
 * Whether this request's photographed pages fit under the cap.
 *
 * `{ ok: true, remaining: null }` means UNCAPPED — a paid tier, or no
 * photographs in the request. `remaining: 0` means a trial account with
 * nothing left, which is a different thing, and a caller that collapses
 * the two refuses every paying student.
 */
export function photoCapDecision({ perMonth, pagesUsed, pages, cap }) {
  const asked = Number(pages) || 0;
  if (asked <= 0) return { ok: true, remaining: null };
  if (perMonth) return { ok: true, remaining: null };

  const limit = Number(cap) || 0;
  const remaining = Math.max(0, limit - (Number(pagesUsed) || 0));
  if (asked <= remaining) return { ok: true, remaining };
  return { ok: false, code: "free_photo_limit", remaining, cap: limit, asked };
}
