/* ==================================================================
   digest.js — grouping and wording, as pure functions.

   Plain JS with no Deno globals and no network, the `guards.js`
   arrangement, so scripts/test-error-digest.mjs exercises the real
   grouping and the real email body directly rather than through a
   bundle. Everything that decides what a person reads at seven in the
   morning is in here; index.ts does the reading, the purge and the
   send.

   THE GROUPING IS (function, stage, error name) because that is what a
   person greps for. Not the message: a provider error quotes an id, a
   status or a timestamp, so grouping by message turns one broken thing
   into forty lines and hides the one that matters.

   IT IS ORDERED BY COUNT, LOUDEST FIRST. Deliberately NOT by "which of
   these is new" — that would be the more useful order and it is not
   available from a 24-hour window, because every group in a 24-hour
   window is first seen in it. Answering it needs a lookback query and
   a definition of new, and guessing at it from the window we have would
   print a confident wrong order. Recorded rather than faked.
   ================================================================== */

/** The longest a quoted provider message may run in the email. */
export const MESSAGE_EXCERPT_CHARS = 300;

/* CODES THAT MUST NOT BE BURIED, and the reason is the ordering above.
   The digest is sorted LOUDEST FIRST, which is right for the usual
   case and exactly wrong for these two: one `stripe_permission_denied`
   sinks below forty transient upstream 500s, and it is the one line
   that means somebody has to go and change a setting.

   Both are CONFIGURATION failures wearing the clothes of a transient
   one:

   - `stripe_permission_denied` — Stripe answered 403. The key has lost
     a permission, or it is the wrong key. Every affected delivery
     fails identically until a person fixes it, so retrying achieves
     nothing and nobody is told.
   - `not_an_invoice` — a refunded charge we could not tie to an
     invoice. We sell nothing but subscriptions, so it is either a
     payment we did not make or the invoice lookup breaking again. It
     is the outcome that hid the period-field move for a day.

   The codes are the ones the endpoints already produce; nothing here
   invents a vocabulary. They are matched on `detail`, never on the
   message text, because a message quotes ids and timestamps and a
   substring match on it would be a guess. */
/* `portal_configuration` (Jared, 24 September 2026): a cancellation
   ended a paid period early, so a student lost time they paid for.
   Raised by stripe-webhook with `code` set in the detail — see the
   test named for why the stage name alone would never have matched. */
export const MUST_REPORT_CODES = ["stripe_permission_denied", "not_an_invoice", "portal_configuration"];

/**
 * The must-report code a row carries, or "".
 *
 * Reads `detail.code` and `detail.reason` — the two fields the
 * endpoints already put a code in — and nothing else. A row whose
 * detail is absent or is not an object simply has none.
 */
export function mustReportCode(row) {
  const detail = row && row.detail;
  if (!detail || typeof detail !== "object") return "";
  for (const field of ["code", "reason"]) {
    const value = detail[field];
    if (typeof value === "string" && MUST_REPORT_CODES.includes(value)) return value;
  }
  return "";
}

/**
 * Group a window's rows.
 *
 * `total` is passed in rather than derived from `rows.length`, because
 * the read is bounded: a loop that wrote 40,000 rows must be reported
 * as 40,000 and not as the 500 that were read. `truncated` says which
 * happened, so a reader is never quietly told a smaller number.
 */
export function buildDigest(rows, { total, since, windowHours } = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = [row.fn, row.stage, row.name || ""].join(" / ");
    const code = mustReportCode(row);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      /* ANY row in the group carrying one is enough: a group is (fn,
         stage, name), and the same stage can fail for a transient
         reason forty times and a configuration reason once. The once is
         the one that matters. */
      if (code && !existing.mustReport) existing.mustReport = code;
      continue;
    }
    groups.set(key, {
      fn: row.fn,
      stage: row.stage,
      name: row.name || "",
      count: 1,
      /* The rows arrive newest-first, so the first one seen for a group
         is its most recent. Kept rather than overwritten. */
      latest: row.occurred_at,
      message: String(row.message || "").slice(0, MESSAGE_EXCERPT_CHARS),
      detail: row.detail ?? null,
      mustReport: code,
    });
  }

  const read = (rows || []).length;
  const counted = typeof total === "number" ? total : read;

  return {
    since: since ?? null,
    windowHours: windowHours ?? null,
    total: counted,
    read,
    truncated: counted > read,
    /* MUST-REPORT FIRST, then loudest. Count alone is what would hide
       a single configuration failure under a noisy transient one. */
    groups: [...groups.values()].sort(
      (a, b) => (b.mustReport ? 1 : 0) - (a.mustReport ? 1 : 0) || b.count - a.count
    ),
    mustReport: [...new Set([...groups.values()].map((g) => g.mustReport).filter(Boolean))],
  };
}

/**
 * The subject line. It carries the numbers, because a subject that
 * reads the same every day is a subject nobody opens — and the one
 * thing worth knowing before opening is how much, and how many kinds.
 */
export function digestSubject(digest) {
  const kinds = digest.groups.length;
  const failures = digest.total;
  const base = `UniPlanner: ${failures} failure${failures === 1 ? "" : "s"} in ${kinds} kind${kinds === 1 ? "" : "s"}`;
  /* IN THE SUBJECT, because the subject is the part that gets read on a
     phone without opening anything, and these two are the ones worth
     opening for. */
  const flagged = digest.mustReport || [];
  return flagged.length ? `${base} — ${flagged.join(", ")}` : base;
}

/**
 * The body, as plain text.
 *
 * NO HTML, and that is a decision rather than laziness: this is read on
 * a phone at seven in the morning, the content is provider messages and
 * JSON, and a proportional font with a template around it makes both
 * harder to read. Plain text also means there is nothing in the message
 * that can fail to render.
 */
export function digestText(digest) {
  const lines = [];
  lines.push(`${digest.total} failed request${digest.total === 1 ? "" : "s"} in the last ${digest.windowHours ?? 24} hours.`);
  if (digest.truncated) {
    lines.push(`Showing the ${digest.read} most recent. The counts below are of those ${digest.read}, not of all ${digest.total}.`);
  }
  lines.push("");

  for (const g of digest.groups) {
    lines.push(
      `${g.mustReport ? "!! " : ""}${g.count}x  ${g.fn} — ${g.stage}${g.name ? ` (${g.name})` : ""}`
    );
    if (g.mustReport) {
      lines.push(`    ${g.mustReport} — this is a setting to change, not a failure that will clear itself.`);
    }
    if (g.message) lines.push(`    ${g.message}`);
    if (g.detail) lines.push(`    ${JSON.stringify(g.detail)}`);
    lines.push(`    most recent: ${g.latest}`);
    lines.push("");
  }

  /* WHERE TO LOOK NEXT, because a digest that names a problem and not
     the place to read about it sends somebody hunting. The table is the
     fuller record — it holds the stacks, which are deliberately not in
     the email. */
  lines.push("Full rows, with stacks: Supabase → Table editor → function_errors.");
  lines.push("Sent by the error-digest function on a daily pg_cron schedule.");
  lines.push("A morning with no email is a morning with no failures.");
  return lines.join("\n");
}
