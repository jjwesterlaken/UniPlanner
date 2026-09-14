/* ==================================================================
   originHandover.js — carrying a signed-out planner across the split

   THE PROBLEM, STATED EXACTLY. `localStorage` is keyed by ORIGIN. The
   origin split moves the app from `https://www.uniplannerapp.com` to
   `https://app.uniplannerapp.com`, and those are different origins, so
   every planner that exists only on a device — which is every planner
   belonging to somebody who never made an account — is invisible from
   the new origin. Nothing about a redirect changes that: a 301 is
   served by the edge, before any script of ours runs, so after the
   redirect lands there is no page left that can read the old origin's
   storage at all.

   WHY THIS IS POSSIBLE AT ALL, and it is the one fact the whole module
   rests on: `www.uniplannerapp.com` and `app.uniplannerapp.com` are
   different ORIGINS but the SAME SITE (same registrable domain). Every
   browser's storage partitioning is keyed on the SITE, not the origin
   — so a same-site iframe still reaches its own unpartitioned storage.
   A genuinely cross-site handover would be blocked outright and this
   module could not exist.

   SO: the app frames one page on the old origin, that page reads its
   own `localStorage` and posts it back, and the app merges it in.
   The bridge path is excluded from the redirect rules for exactly this
   reason — it is the one old URL that must NOT move, and it has to be
   in the FIRST deploy of the split, because the window it covers is
   the transition itself.

   WHAT THIS DOES NOT COVER, and none of it is fixable from here:

     - a browser that never opens the new origin. There is no route to
       storage nobody visits.
     - an INSTALLED PWA, whose `start_url` was resolved at install time
       to the old origin. A shortcut cannot be migrated, and after the
       redirect it opens the marketing site.
     - a different browser, profile, or device. Storage is per-browser
       as well as per-origin.
     - the SUPABASE SESSION, deliberately. It lives in localStorage
       like everything else, and it is an access token: shipping one
       through a postMessage to widen a login is a security decision
       with no upside, since signing in again costs a password and
       fixes itself. EVERY user signs in again after the split.

   WHAT IT DELIBERATELY DOES NOT MOVE, beyond the session: the demo
   keys (a developer fixture), the device id (a new origin is entitled
   to its own), and the note cache in IndexedDB — that one is a CACHE,
   it is allowed to fail by design, it repopulates from the server, and
   a signed-out user has nothing in it because every AI boundary
   refuses without a session.

   Everything here is pure or takes its environment as an argument, so
   scripts/test-origin-handover.mjs can exercise the awkward cases from
   Node without a browser.
   ================================================================== */

/* THE KEYS THAT TRAVEL, enumerated rather than swept.

   A sweep of `uni-planner-*` would carry the session, the demo
   fixtures and the archive-pending marker along with the planner, and
   "everything that matched a prefix" is not a decision anybody made.
   Each entry here is a thing somebody would notice the loss of. */
export const HANDOVER_KEYS = [
  /* The planner itself. This is the one that matters; the rest are
     comfort. */
  "uni-planner-v1",
  /* Light/dark. Carried so the first paint on the new origin is the
     one they chose, rather than a flash of the other mode on top of
     everything else that is about to be unfamiliar. */
  "uni-planner-mode",
  /* Which tab they were on. Cheap, and it makes the new origin open
     where the old one left off. */
  "uni-planner-tab",
];

/** The message names, kept as constants so both halves cannot drift. */
export const HANDOVER_REQUEST = "uni-planner:handover-request";
export const HANDOVER_RESULT = "uni-planner:handover-result";

/* Marks the attempt as made, on the NEW origin, so a student who
   genuinely wants an empty planner is not handed the old one back on
   every visit. One attempt, ever, per browser. */
export const HANDOVER_DONE_KEY = "uni-planner-handover";

/**
 * Whether to ask the old origin for anything.
 *
 * THREE CONDITIONS, AND THE MIDDLE ONE IS THE LOAD-BEARING ONE.
 *
 * `hasLocalPlanner` false is what makes this safe: the handover only
 * ever runs into an EMPTY planner, so there is nothing of the
 * student's on this origin for it to overwrite. Merging two real
 * planners would be the better-sounding answer and the worse one —
 * `mergeData` is last-write-wins per item by `updatedAt`, and a blob
 * carried from another origin has timestamps that were never in a
 * race with these, so "newer" would decide things nobody decided.
 * An empty destination has no such question in it.
 */
export function shouldAttemptHandover({ hasLocalPlanner, alreadyAttempted, isNativeShell } = {}) {
  if (isNativeShell) return false; // a phone or desktop shell never moved origin
  if (alreadyAttempted) return false;
  if (hasLocalPlanner) return false;
  return true;
}

/**
 * Whether a message really came from the bridge.
 *
 * ORIGIN FIRST, ALWAYS. `event.origin` is set by the browser and
 * cannot be forged by the framed page; every other field in the
 * message can be. A check on the message's own contents without this
 * one would accept a handover from anybody who could get a frame onto
 * the page.
 */
export function isTrustedHandover(event, allowedOrigins) {
  if (!event || typeof event !== "object") return false;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return false;
  if (!allowedOrigins.includes(event.origin)) return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  if (data.type !== HANDOVER_RESULT) return false;
  return data.values && typeof data.values === "object";
}

/**
 * What to write, given what arrived.
 *
 * FILTERED AGAINST `HANDOVER_KEYS` RATHER THAN TRUSTED. The bridge
 * sends what it was told to send, but the bridge is a page and pages
 * get edited; a key the app did not ask for must not be written just
 * because it arrived. Values must be strings, because that is what
 * `localStorage` holds and anything else means something upstream
 * changed.
 */
export function handoverWrites(values, keys = HANDOVER_KEYS) {
  const out = {};
  if (!values || typeof values !== "object") return out;
  for (const key of keys) {
    const v = values[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

/**
 * Whether what arrived is worth anything.
 *
 * A handover that carries only a theme preference is not a rescued
 * planner, and telling somebody their planner was brought across when
 * it was not is worse than saying nothing.
 */
export function handoverCarriedAPlanner(writes) {
  return Boolean(writes && typeof writes["uni-planner-v1"] === "string" && writes["uni-planner-v1"].length > 0);
}

/**
 * Ask the old origin for its planner.
 *
 * Takes its whole environment, so the test drives it with fakes. It
 * RESOLVES on every path and never rejects: this runs at startup, in
 * front of the planner, and a handover that throws would be a blank
 * screen in exchange for a convenience.
 *
 * THE TIMEOUT IS NOT OPTIONAL. A frame pointed at an origin that is
 * down, blocked by an extension, or has had its bridge removed never
 * answers at all — there is no error event for "nobody replied" — so
 * without a deadline the app would wait for ever on a page that is
 * never coming.
 */
export function requestHandover({
  bridgeUrl,
  allowedOrigins,
  createFrame,
  addMessageListener,
  removeMessageListener,
  setTimer,
  clearTimer,
  timeoutMs = 4000,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let frame = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { removeMessageListener(onMessage); } catch {}
      try { if (timer !== null) clearTimer(timer); } catch {}
      /* The frame is removed on EVERY path, including the timeout.
         A bridge left in the document is a live frame on another
         origin sitting under the planner for the rest of the session. */
      try { if (frame && frame.remove) frame.remove(); } catch {}
      resolve(result);
    };

    const onMessage = (event) => {
      if (!isTrustedHandover(event, allowedOrigins)) return;
      finish({ ok: true, values: handoverWrites(event.data.values) });
    };

    /* THE ORDER OF THESE THREE IS LOAD-BEARING IN BOTH DIRECTIONS,
       and the second half was wrong until a test drove it.

       The LISTENER goes first: the bridge posts unprompted as soon as
       it parses, so attaching after the frame is a race that loses the
       only message there is.

       The TIMER goes LAST, after `frame` holds something. It was
       second, which read fine and left `frame` still null if the
       deadline ever resolved before the assignment — so `finish` had
       nothing to remove and the bridge stayed in the document, a live
       frame on another origin sitting under the planner for the rest
       of the session. A fake timer that fires synchronously is what
       exposed it; a real one would have needed a 4-second stall at
       exactly the wrong moment, which is the kind of bug that ships. */
    try {
      addMessageListener(onMessage);
      frame = createFrame(bridgeUrl);
      timer = setTimer(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    } catch (err) {
      finish({ ok: false, reason: "unavailable" });
    }
  });
}
