/* ==================================================================
   authEmailFailure.js — telling US when Supabase Auth could not send
   a signup or reset email.

   On 27 September 2026 every such email failed for hours (EMAIL-SETUP.md)
   and the only people who knew were the students: Auth answered their
   signup or reset with an error, the app showed it, and nothing was
   reported anywhere we look. The hourly canary (auth-email-canary)
   catches the outage itself; this catches it at the first student,
   through the error reports the app already sends (client_errors,
   0010), which the daily digest now reads and floats to the top.

   WHAT A REPORT CARRIES: a fixed message, `auth_email_failed: signup`
   or `auth_email_failed: reset`, through the ordinary reporter — so
   its six fields, its cap and its dedupe apply unchanged. NEVER the
   email address, and never Auth's own message, which can quote it.

   WHAT THE STUDENT SEES is unchanged: the same sentence as before. And
   the report does not reveal whether an account exists — it reaches
   only us, and Auth answers a reset for an unknown address with success
   without sending anything, so a send failure only ever happens for an
   address with an account, which the report does not contain.

   Plain JS with no React and no browser globals, so the rule is a Node
   test.
   ================================================================== */

/** The code the digest flags. Mirrors MUST_REPORT_CODES in error-digest/digest.js; a test holds them equal. */
export const AUTH_EMAIL_FAILED = "auth_email_failed";

export const AUTH_EMAIL_FLOWS = Object.freeze(["signup", "reset"]);

/**
 * Is this Auth error a failure to SEND an email, rather than a wrong
 * password, a rate limit or a bad address? Auth reports it as a 5xx
 * whose message names sending an email ("Error sending recovery
 * email", "Error sending confirmation email"). A 5xx that does not
 * mention email is some other server failure and is not this.
 */
export function isAuthEmailSendFailure(error) {
  if (!error) return false;
  const message = String(error.message || "");
  if (/error sending [a-z ]*e-?mail/i.test(message)) return true;
  const status = Number(error.status);
  return Number.isInteger(status) && status >= 500 && /e-?mail/i.test(message);
}

/** The Error handed to the reporter. Its message is the whole of what we learn. */
export function authEmailFailureReport(flow) {
  const f = AUTH_EMAIL_FLOWS.includes(flow) ? flow : "unknown";
  return new Error(`${AUTH_EMAIL_FAILED}: ${f}`);
}
