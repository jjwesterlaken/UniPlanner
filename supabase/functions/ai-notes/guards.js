/* ==================================================================
   guards.js — the logic that decides whether we pay money

   Plain JS, no Deno or Node-only APIs, so this one file is imported
   unmodified by both the Edge Function (Deno) and the Node test
   script (scripts/test-ai-notes.mjs) — no TypeScript toolchain needed
   on the Node side just for this.
   ================================================================== */

/**
 * @param {object} args
 * @param {number} args.estimatedDurationSeconds - client-supplied, can be
 *   faked; used only as a cheap early exit, never trusted for billing.
 * @param {number} args.receivedBytes - server-measured (the Storage
 *   object's real size); this is the authoritative check.
 * @param {number} args.minutesUsedThisMonth
 * @param {number} args.monthlyLimitMinutes
 * @param {number} args.maxRequestSeconds
 * @param {number} args.maxBodyBytes
 * @returns {{ok: true} | {ok: false, code: string, error: string}}
 */
export function checkRequestGuards({
  estimatedDurationSeconds,
  receivedBytes,
  minutesUsedThisMonth,
  monthlyLimitMinutes,
  maxRequestSeconds,
  maxBodyBytes,
}) {
  if (typeof receivedBytes === "number" && receivedBytes > maxBodyBytes) {
    return { ok: false, code: "recording_too_long", error: "Recordings are limited to about 3 hours." };
  }
  if (typeof estimatedDurationSeconds === "number" && estimatedDurationSeconds > maxRequestSeconds) {
    return { ok: false, code: "recording_too_long", error: "Recordings are limited to about 3 hours." };
  }
  const projectedMinutes = (minutesUsedThisMonth || 0) + (estimatedDurationSeconds || 0) / 60;
  if (projectedMinutes > monthlyLimitMinutes) {
    return { ok: false, code: "usage_exceeded", error: "You've used all your AI minutes for this month." };
  }
  return { ok: true };
}
