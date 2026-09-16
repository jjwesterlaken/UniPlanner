/* ==================================================================
   reviewPrompt.js — asking for a store review, once, at the one
   moment the app has just done the thing it is for

   Pure. The platform and the storage are arguments, so every awkward
   case is a table in scripts/test-review-prompt.mjs rather than
   something only a handset can answer — the purchasePlans.js split,
   for the same reason: the plugin half cannot be imported by a
   plain-Node test, so nothing decidable is allowed to live there.

   WHEN: after a lecture note has SAVED. Not when recording starts, not
   when the summary arrives — at the moment the student is looking at
   notes they did not have to type. A prompt before the payoff is a
   prompt about nothing.

   WHERE: native shells only. There is no store to review on the web or
   on the desktop build, so the plugin is never spoken to there — the
   same rule the purchase SDK has, and for the same reason: a plugin
   call off a native shell is a call into something that does not
   exist.

   HOW OFTEN: once per install, and the flag is DEVICE-LOCAL rather
   than in the synced blob. `uni-planner-review-asked` sits beside
   `uni-planner-mode` and `uni-planner-audio-input` for the reason
   those do: the ask is a property of this copy of the app on this
   device, iOS's own limit is per-device, and syncing it would be at
   best a no-op and at worst two devices disagreeing through
   last-write-wins.
   ================================================================== */

/* Device-local, outside the synced blob. See the note above. */
export const REVIEW_ASKED_KEY = "uni-planner-review-asked";

/* The platforms with a store to review in. Deliberately the same two
   `purchasePlans.js` sells on: a shell that is neither is a shell we
   do not ship, and guessing at it would mean calling a plugin that
   may not be installed. */
export const REVIEWABLE_PLATFORMS = ["ios", "android"];

/**
 * Should this device be asked, right now?
 *
 * THE REASONS ARE DISTINCT ON PURPOSE, the `purchaseCapability` rule:
 * "web" and "already-asked" both mean no prompt and are completely
 * different to whoever is debugging — the first is permanent and
 * correct, the second means it worked once already.
 *
 * `saved` is required rather than assumed. A failed save is the worst
 * possible moment to ask somebody to rate the app, and the caller that
 * knows whether it succeeded is the one that must say so.
 */
export function shouldAskForReview({ isNative, platform, alreadyAsked, saved } = {}) {
  if (!saved) return { ask: false, reason: "not-saved" };
  if (!isNative) return { ask: false, reason: "web" };
  if (!REVIEWABLE_PLATFORMS.includes(platform)) return { ask: false, reason: "unknown-platform" };
  if (alreadyAsked) return { ask: false, reason: "already-asked" };
  return { ask: true, reason: null };
}

/**
 * Has this device already been asked?
 *
 * A STORAGE FAILURE READS AS "YES", WHICH IS THE CAUTIOUS DIRECTION
 * and the opposite of what a cache would do. If we cannot find out
 * whether we have asked, asking is the branch that can go wrong
 * repeatedly: Safari in private browsing throws on every read, so a
 * failure reading as "no" would ask on every single lecture, for ever,
 * which is the exact behaviour app stores penalise and students
 * complain about. Not asking costs one review request.
 */
export function hasAskedForReview(storage) {
  try {
    return storage.getItem(REVIEW_ASKED_KEY) !== null;
  } catch (e) {
    return true;
  }
}

/**
 * Record that we asked. Returns whether the record is durable.
 *
 * The caller must not ask unless this returned true — see
 * `askForReviewOnce` for why the order is what it is.
 */
export function markAskedForReview(storage, nowISO) {
  try {
    storage.setItem(REVIEW_ASKED_KEY, typeof nowISO === "function" ? nowISO() : new Date().toISOString());
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Record first, then ask.
 *
 * THE ORDERING IS THE WHOLE DESIGN, and it is the aiNotesStore table
 * pointed at an outward-facing action instead of a row. An
 * interruption between the two has to leave the survivable state:
 *
 *   record, then ask   an interruption leaves "recorded, never asked"
 *                      — the student is never prompted, which costs
 *                      one review request and nothing else
 *
 *   ask, then record   an interruption leaves "asked, no record" — the
 *                      student is prompted again after the next
 *                      lecture, and the one after that, for ever
 *
 * So a storage write that FAILS means we do not ask at all. That is
 * deliberate and it is the same "fail towards keeping" instinct as
 * `recoveryFailureKind`: the cheap failure is the one to choose when
 * the alternative is unbounded.
 *
 * `request` is injected and its result is IGNORED. The platform API is
 * a REQUEST, not a command — iOS shows the prompt at most three times
 * a year and may show nothing at all, and nothing it returns tells us
 * whether a human saw anything. So the flag records that WE ASKED, not
 * that a prompt appeared, and there is no retry: a request that the OS
 * swallowed is indistinguishable from one it showed.
 */
export async function askForReviewOnce({ isNative, platform, storage, request, nowISO } = {}) {
  const decision = shouldAskForReview({
    isNative,
    platform,
    alreadyAsked: hasAskedForReview(storage),
    saved: true,
  });
  if (!decision.ask) return { asked: false, reason: decision.reason };

  if (!markAskedForReview(storage, nowISO)) return { asked: false, reason: "not-recorded" };

  try {
    await request();
    return { asked: true, reason: null };
  } catch (e) {
    /* THE ASK MUST NEVER TAKE DOWN WHAT IT FOLLOWS. This runs at the
       end of saving a lecture the student may have paid for; a plugin
       that is missing, or an OS that refuses, must cost the review
       request and nothing else. Same rule as the folder-filing try in
       the save path directly above the caller. */
    return { asked: true, reason: "request-failed" };
  }
}
