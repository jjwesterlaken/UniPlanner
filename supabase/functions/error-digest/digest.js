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
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
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
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
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
  return `University Planner: ${failures} failure${failures === 1 ? "" : "s"} in ${kinds} kind${kinds === 1 ? "" : "s"}`;
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
    lines.push(`${g.count}x  ${g.fn} — ${g.stage}${g.name ? ` (${g.name})` : ""}`);
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
