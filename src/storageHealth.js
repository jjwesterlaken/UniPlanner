/* ==================================================================
   storageHealth.js — telling the user when a local save didn't happen

   WHY THIS EXISTS
   ---------------
   `store.set` used to swallow every localStorage failure:

       try { window.localStorage.setItem(key, val); } catch (e) { }

   which meant that once the planner outgrew the browser's ~5MB quota,
   saving silently stopped. A signed-in user would be rescued by sync
   without ever knowing. A demo-mode user — which is every brand-new
   user, before they make an account — would lose everything on refresh
   and never see a warning.

   That is a worse failure than anything a size cap prevents, because it
   is invisible. So the save path now reports, and this module holds the
   two pure pieces of that: which kind of failure it was, and what to
   say about it.

   The wording distinguishes signed-in from not, because the
   consequences genuinely differ. Signed in, the work is safe on the
   server and the device is merely without an offline copy. Signed out,
   the work is gone when the tab closes. Saying the same thing in both
   cases would either frighten the first user or under-warn the second.
   ================================================================== */

/**
 * Which kind of storage failure this was.
 *
 * Browsers disagree on how a full quota is reported: Chrome and Safari
 * throw `QuotaExceededError` (legacy code 22), Firefox throws
 * `NS_ERROR_DOM_QUOTA_REACHED` (code 1014). All three mean the same
 * thing to a user, so they collapse to "quota".
 *
 * Anything else — private browsing with storage disabled, a sandboxed
 * iframe, a hardened profile — is "unavailable": the write was refused
 * outright rather than for lack of room, and freeing space won't help.
 */
export function classifyStorageError(err) {
  if (!err) return "unavailable";
  const name = err.name || "";
  const code = err.code;
  if (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  ) {
    return "quota";
  }
  return "unavailable";
}

/** Human-readable size. Used in the failure message and, later, in the backup panel. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What to show when a local save fails.
 *
 * Returns { title, detail, severity } rather than one string so the
 * banner can weight them differently, and so Grace can reword either
 * half without touching the logic.
 *
 * `severity` is "warning" when sync will cover for the device and
 * "danger" when nothing will.
 */
export function describeSaveFailure({ reason, bytes, signedIn } = {}) {
  const size = formatBytes(bytes);
  const sizeNote = size ? ` Your planner is ${size}.` : "";

  if (reason === "quota") {
    return signedIn
      ? {
          severity: "warning",
          title: "This device is out of storage.",
          detail:
            `Your planner couldn't be saved on this device, but it is still syncing to your account, so nothing is lost.${sizeNote}` +
            " Free up space, or remove some old notes, to get an offline copy back.",
        }
      : {
          severity: "danger",
          title: "This device is out of storage — your changes are not saved.",
          detail:
            `Anything you add now will be lost when you close this tab.${sizeNote}` +
            " Make an account to sync your work, or remove some old notes to free up space.",
        };
  }

  return signedIn
    ? {
        severity: "warning",
        title: "This device isn't allowing saves.",
        detail:
          "Private browsing can do this. Your planner is still syncing to your account, so nothing is lost — but this device won't keep an offline copy.",
      }
    : {
        severity: "danger",
        title: "This device isn't allowing saves — your changes are not saved.",
        detail:
          "Private browsing can do this. Anything you add now will be lost when you close this tab. Make an account to sync your work, or try a normal browser window.",
      };
}

/* ---------- how big the planner is, before it becomes a problem ----------

   The size caps on individual features bound what THOSE features can
   add. They do nothing about the collections that have no cap at all --
   study cards, notebook pages, AI lecture notes -- or about the fact
   that the planner has no semester lifecycle, so a student in second
   year is filling the same two buckets again.

   That growth is real and invisible. A number in the backup panel is
   the cheapest possible answer: it costs one line, it is always true,
   and it turns "the app stopped saving" into something a student could
   have seen coming. */

/* The working budget is 1 MB (see CLAUDE.md). The warning sits above it
   rather than at it, so ordinary use never nags: 1.5 MB is comfortably
   past the budget and still far below the ~5 MB browser quota, which
   leaves room to act before anything actually fails. */
export const SIZE_WARN_BYTES = 1.5 * 1024 * 1024;

/* Demo mode writes the blob twice -- once as the planner and once as the
   simulated cloud copy -- so the same content costs double against the
   same quota. */
export const DEMO_SIZE_MULTIPLIER = 2;

/**
 * What the backup panel says about the planner's size.
 *
 * Always returns a line, because a size that is only shown once it is a
 * problem teaches nobody anything. `warn` is true only past the
 * threshold, and the advice differs by whether sync would rescue them.
 */
export function describeSize({ bytes, signedIn, isDemo = false } = {}) {
  const effective = isDemo ? bytes * DEMO_SIZE_MULTIPLIER : bytes;
  const line = `Your planner is ${formatBytes(bytes)}.`;
  if (effective < SIZE_WARN_BYTES) return { line, warn: false, detail: "" };

  const shared = "Large planners save more slowly and can eventually stop saving on a device.";
  return {
    line,
    warn: true,
    detail: signedIn
      ? `${shared} Your work is still syncing to your account. Removing old notes or study cards you no longer need will bring it down.`
      : `${shared} Nothing is backed up anywhere else yet — make an account to sync it, or remove old notes and study cards you no longer need.`,
  };
}
