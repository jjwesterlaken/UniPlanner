/* ==================================================================
   failureLog.ts — every failure line, also written where a digest can
   read it.

   THE PROBLEM IS NOT THAT FAILURES ARE UNLOGGED. Every function already
   writes one structured FAILURE line per failed request, and has since
   `diagnostics.js` was written for exactly that reason. The problem is
   WHERE those lines go: the platform log viewer, which nothing can
   query on a schedule, which no email can be built from, and which is
   only ever read by somebody who already suspects something is wrong.

   That is how the revoked OpenAI key stayed unexplained for as long as
   it did. The signature was two stages failing for two different
   reasons — transcription succeeding and being billed, summarising
   failing and not — plainly visible in the logs and invisible to
   anybody not reading them.

   ------------------------------------------------------------------
   THE PRINT COMES FIRST, AND IT IS UNCHANGED.

   `console.error(failureLine(...))` runs before anything touches the
   database, with the same arguments producing the same bytes. The log
   line is the mechanism that has always worked and it must not become
   contingent on the one being added — a table that is missing, revoked,
   or full has to cost the digest and never the log.

   ------------------------------------------------------------------
   IT CANNOT THROW, AND THAT IS NOT A STYLE PREFERENCE.

   Every caller is already inside a failure path, most of them one line
   before a `return`. A throw here would replace a diagnosed failure
   with an undiagnosed one — the request would 500 from a different
   place, the response code would change, and the line explaining the
   original failure would be the last thing anybody saw about it.

   So the insert is fire-and-forget with its own catch, and its
   failure is printed rather than raised.

   ------------------------------------------------------------------
   `waitUntil` IS WHAT MAKES THE WRITE ACTUALLY LAND.

   A floating promise in an Edge Function is not a promise that
   completes: the worker may be torn down the moment the response is
   returned, and this is called one line before a return almost
   everywhere. `EdgeRuntime.waitUntil` is the platform's primitive for
   "finish this before you shut me down", and it is reached through a
   typeof guard because it does not exist under plain Node, which is
   where the tests run.

   WITHOUT THE GUARD THIS FILE WOULD THROW ReferenceError INSIDE A
   FAILURE PATH — a free variable in the one module whose entire job is
   to never make things worse. That is the class `freeVariables()` was
   written for after `allowanceForTier` blanked the AI tab, and here it
   would be masked by the catch and read as "the digest is quiet".

   ------------------------------------------------------------------
   WHAT IS STORED IS WHAT IS PRINTED, WITH ONE FIELD REMOVED.

   `describeError` does the redaction — query strings (the signed audio
   URL carries an access token in one), JWTs, provider keys, long
   tokens — and the stored `name`/`message`/`stack` are those same
   strings, so the table cannot hold something the logs would not.

   `app_user_id` is DROPPED. It is the only account-shaped field the
   failure lines carry, `function_errors` has deliberately no user_id
   column and no deletion coverage (0022's header has the reasoning),
   and the same id is already recorded in `billing_events.app_user_id`,
   which IS covered by account deletion. So nothing is lost by dropping
   it and an account identifier does not end up in a table no deletion
   reaches. A test pins the list, the way the client reporter's six
   fields are pinned.
   ================================================================== */

import { describeError, failureLine } from "../ai-notes/diagnostics.js";
import { getSupabaseAdmin } from "./supabaseAdmin.ts";

/** How long a row lives. The digest purges to this on every run. */
export const FUNCTION_ERROR_RETENTION_DAYS = 30;

/** Keys stripped out of `detail` before it is stored. */
export const DETAIL_DROPPED_KEYS = ["app_user_id"];

/**
 * The `extra` a failure line carried, minus anything that names an
 * account. Returns null rather than `{}` so a row with nothing to add
 * is visibly empty instead of holding an object that says nothing.
 */
export function detailForStorage(extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (DETAIL_DROPPED_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** The row an insert would write. Separated so a test can read it without a database. */
export function failureRow(fn: string, stage: string, err: unknown, extra: Record<string, unknown> = {}) {
  const { name, message, stack } = describeError(err);
  return { fn, stage, name, message, stack, detail: detailForStorage(extra) };
}

/* Keeps a fire-and-forget promise alive past the response where the
   platform offers it, and degrades to a floating promise where it does
   not. `typeof` on an undeclared identifier is the one expression that
   cannot throw — the same reason the RevenueCat keys are read that way
   rather than through `process.env`. */
function keepAlive(work: Promise<unknown>): void {
  try {
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") rt.waitUntil(work);
  } catch {
    /* Nothing: the promise is already running either way. */
  }
}

/* The service-role client, or null if there is not a usable one.
   Answers the question WITHOUT throwing and without assuming
   `getSupabaseAdmin` throws rather than returning something unusable --
   a stub that hands back `undefined` produces a TypeError one property
   access later, which is how a missing client used to arrive as a
   stack trace. */
// deno-lint-ignore no-explicit-any
function usableAdmin(): any {
  try {
    const admin = getSupabaseAdmin();
    // deno-lint-ignore no-explicit-any
    return admin && typeof (admin as any).from === "function" ? admin : null;
  } catch {
    return null;
  }
}

/**
 * Print the failure line, then record it. Drop-in for the `logFailure`
 * each function already defines — same arguments, same bytes on the
 * log.
 */
export function recordFailure(fn: string, stage: string, err: unknown, extra: Record<string, unknown> = {}): void {
  console.error(failureLine(stage, err, extra, fn));

  /* NO CLIENT AT ALL IS A ONE-LINE FACT, NOT A STACK, and the reason
     is that it is not a failure of anything -- it is the recorder
     saying it is not configured here. It happens in every bundled test
     with a stubbed platform, and it would happen in production only if
     the service-role key were unset, which is static and which a stack
     trace tells nobody anything about.

     Printed all the same, and still carrying `function_errors_insert`
     so one grep finds every reason a row is missing: a recorder that
     says nothing turns an empty digest into evidence that nothing is
     wrong. What changed is the volume, and the reason that matters is
     that pages of identical stacks are how a line that IS worth
     reading gets scrolled past. */
  const admin = usableAdmin();
  if (!admin) {
    console.error(
      `${fn} FAILURE function_errors_insert recorder unavailable: no database client, so ${stage} was logged and not recorded`
    );
    return;
  }

  const work = (async () => {
    try {
      const { error } = await admin.from("function_errors").insert(failureRow(fn, stage, err, extra));
      /* PRINTED, NEVER RAISED — and printed rather than swallowed,
         because a recorder that fails silently turns an empty digest
         into evidence that nothing is wrong. That is the same reading
         `fetchNote` refuses: a failed write is not an absence of
         failures. */
      if (error) console.error(failureLine("function_errors_insert", error, { of: stage }, fn));
    } catch (recordErr) {
      console.error(failureLine("function_errors_insert", recordErr, { of: stage }, fn));
    }
  })();

  keepAlive(work);
}
