/* ==================================================================
   essayHold.js — where an essay run lives while the student is elsewhere

   THE BUG THIS EXISTS FOR (Jared's production run, 26 September 2026):
   a delivered result vanished on a tab switch and the student paid
   9 credits to see it again. The panel sits under the Courses tab's
   `{tab === "courses" && ...}`, so switching tabs UNMOUNTS it, and the
   result, the run id, the examples and the drafts were all component
   state. A run still in flight was worse: it finished into an unmounted
   component, was charged, and was never shown.

   The `useRecordingSession` answer, one feature over: PlannerApp owns
   one of these, above the tab switch, and the panel reads and writes
   its row's entry here instead of in its own state. A request that
   finishes while the panel is unmounted writes here and is waiting on
   return.

   MEMORY ONLY, and that is a privacy property, not an omission. The
   entry holds the pasted draft and the result, whose quotes are the
   student's own words; the policy says supplied text is "not in your
   planner and not on our server", so none of this may reach the synced
   blob or localStorage. It lives as long as the page and no longer: a
   reload loses it (saving the note is how a student keeps a result),
   and sign-out clears it.

   An entry is dropped when the student closes the panel. Saving keeps
   it, marked saved, so the result stays on screen after the note is
   written.

   Plain JS with no React, so the rules are Node tests; the panel
   subscribes through useSyncExternalStore.
   ================================================================== */

export const blankEntry = () => ({
  open: false,
  essay: "",
  criteria: "",
  result: null,
  runId: null,
  saved: false,
  rated: false,
  rewrites: {},
  /* A request is in flight. Held here and not in the hook's `busy`, so
     a panel remounted mid-request shows it running rather than offering
     the button again, which would charge a second read. */
  pending: false,
  rewritePending: null,
});

export function createEssayHold() {
  const entries = new Map();
  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  /* The snapshot must be the SAME object until something changes, or
     useSyncExternalStore re-renders for ever; entries are replaced,
     never mutated, so the reference is the version. */
  const EMPTY = Object.freeze(blankEntry());
  return {
    get: (id) => entries.get(id) || EMPTY,
    set(id, patch) {
      const cur = entries.get(id) || blankEntry();
      const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
      entries.set(id, next);
      emit();
      return next;
    },
    clear(id) {
      if (entries.delete(id)) emit();
    },
    clearAll() {
      if (entries.size === 0) return;
      entries.clear();
      emit();
    },
    size: () => entries.size,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
