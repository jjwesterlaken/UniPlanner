/* ==================================================================
   canary.js — is Supabase Auth able to send email? The decisions, as
   pure functions.

   WHY THIS EXISTS (27 September 2026). Signup and reset emails failed
   for hours with Resend's `550 domain is not verified`, because the
   Auth SMTP key belonged to a different Resend account from the one
   the domain was verified in (EMAIL-SETUP.md). Nothing of ours saw it:
   the error digest reads failures that EDGE FUNCTIONS record, and
   Auth's SMTP send is done by Supabase Auth itself. The student saw an
   error; we saw nothing.

   So every four hours the canary asks Auth to send a password reset to a
   canary account we own, exactly as the app does — the anon key, the
   public `/recover` endpoint. An SMTP failure comes back from that
   endpoint as a 5xx, so the check needs no access to any inbox.

   THREE OUTCOMES, NOT TWO, the fetchNote rule applied to a probe:

     ok       2xx — Auth accepted the send.
     failed   5xx — Auth tried to send and could not. The outage.
     unknown  anything else: a rate limit (429), another 4xx, a network
              error reaching Auth, or no canary account. We learned
              nothing about email, so the state does not move.

   Reading "unknown" as "failed" would page somebody over a rate limit;
   reading it as "ok" would announce a recovery that did not happen.
   Both are recorded for the digest, and neither changes the state.

   ONE ALERT WHEN IT STARTS FAILING, ONE WHEN IT RECOVERS. The state
   (healthy / failing, and since when) lives in one row
   (public.auth_email_canary, 0025), so an outage lasting a day is two
   emails, not twenty-four. The daily digest still counts every failed
   probe, so a failure that has already been alerted is not forgotten.

   THE STATE MOVES ONLY WHEN THE ALERT WAS SENT. If Resend refuses the
   alert, the state stays where it was, so the next run tries again.
   Flipping first would record "we told somebody" when nobody was told,
   which is the one failure this function exists to prevent.
   ================================================================== */

export const PROBE = Object.freeze({ OK: "ok", FAILED: "failed", UNKNOWN: "unknown" });
export const STATUS = Object.freeze({ HEALTHY: "healthy", FAILING: "failing" });

/** The code the digest shows this failure under, and floats to the top. */
export const AUTH_EMAIL_FAILED = "auth_email_failed";

/** Classify what /recover answered. `status` is the HTTP status, or null if the request never completed. */
export function classifyProbe(status) {
  if (!Number.isInteger(status)) return PROBE.UNKNOWN;
  if (status >= 200 && status < 300) return PROBE.OK;
  if (status >= 500) return PROBE.FAILED;
  return PROBE.UNKNOWN;
}

/**
 * What to do, given the stored state and this run's probe.
 * `prev` is the stored row or null (never run). Returns the alert to
 * send ("failing" | "recovered" | null) and the status to store IF the
 * alert, when there is one, was sent.
 */
export function decide(prev, probe) {
  const was = prev && prev.status === STATUS.FAILING ? STATUS.FAILING : STATUS.HEALTHY;
  if (probe === PROBE.FAILED) {
    return was === STATUS.FAILING ? { alert: null, status: STATUS.FAILING, changed: false } : { alert: "failing", status: STATUS.FAILING, changed: true };
  }
  if (probe === PROBE.OK) {
    return was === STATUS.FAILING ? { alert: "recovered", status: STATUS.HEALTHY, changed: true } : { alert: null, status: STATUS.HEALTHY, changed: false };
  }
  return { alert: null, status: was, changed: false };
}

/** The alert email. Plain text, like the digest, read on a phone. */
export function alertEmail(kind, { status, since, now, detail } = {}) {
  if (kind === "failing") {
    return {
      subject: "UniPlanner: sign-up and password emails are FAILING",
      text: [
        `Supabase Auth could not send the canary's password-reset email (HTTP ${status ?? "?"}).`,
        "Students cannot confirm new accounts or reset their passwords until this is fixed.",
        "",
        detail ? `Auth said: ${String(detail).slice(0, 300)}` : "",
        "",
        "Check first: Supabase → Authentication → Logs, and whether the SMTP key in",
        "Authentication → Emails → SMTP Settings comes from the Resend account where",
        "send.uniplannerapp.com is verified (EMAIL-SETUP.md, the one-account rule).",
        "",
        "You will get ONE more email from this check: when it recovers.",
      ]
        .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
        .join("\n"),
    };
  }
  return {
    subject: "UniPlanner: sign-up and password emails are working again",
    text: [
      "Supabase Auth sent the canary's password-reset email successfully.",
      since ? `It had been failing since ${since}.` : "",
      now ? `Recovered by ${now}.` : "",
      "",
      "Students who tried to sign up or reset during the outage may need to try again.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
