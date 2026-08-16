/* ==================================================================
   archiveCopy.js — every user-facing sentence the semester archive
   shows, in one place so wording can change without touching logic
   (the same arrangement as aiNotesCopy.js), and so tests can pin the
   claims that matter:

   - The late-edits line is DEVICE-NEUTRAL. On the device that made
     the edits, "another device" would be false — the archive happened
     elsewhere, the edits happened here.
   - The offline refusal says the ORDER (stored before removed), which
     is the true promise and the reason the refusal is safe.
   - Nothing here says "deleted" for a failure, and nothing promises a
     restore it can't check. A failed read reads as unknown, never as
     gone — same rule as everywhere else.
   ================================================================== */

export const ARCHIVE_COPY = {
  /* The signed-out gate names the tool, per the gate rule: a feature
     nobody can see is not a gate, it is absence. */
  gate: {
    title: "Archive a semester",
    body:
      "Box up a finished semester — notes, cards, grades and all — to free space on this device. " +
      "Grades and AI lecture notes stay readable, and the whole semester can be restored any time. " +
      "Archiving needs an account, so the archive is stored safely and follows you between devices.",
  },

  /* One line on the Backup panel's size warning. A nudge, never an
     action taken for the student. */
  nudge: "Archiving a finished semester frees space — see the Semester archive below.",

  confirm: {
    title: "Archive this semester?",
    body:
      "Everything in it is stored in your account as an archive, and this semester starts fresh. " +
      "Your study streak carries over. Grades and AI lecture notes stay readable here, and you can " +
      "restore the whole semester any time.",
    action: "Archive",
  },

  offline:
    "Couldn't store the archive, so nothing was removed from this device. " +
    "The semester is always stored in your account before anything is cleared — check your connection and try again.",
  changed:
    "The semester changed while it was being archived, so nothing was removed. Try again.",

  archivedLine: ({ label, items }) =>
    `Archived as “${label}” · ${items} item${items === 1 ? "" : "s"}`,

  lateEdits: (n) =>
    `${n} item${n === 1 ? " was" : "s were"} added or edited after this semester was archived.`,
  lateFold: "Add to the archive",
  lateKeep: "Keep here",
  lateFoldFailed: "Couldn't reach the archive, so nothing was moved. Try again.",
  lateFoldMissing:
    "That archive isn't in your account any more, so there's nowhere to add these. They'll stay here.",

  restore: "Restore",
  /* The way back from the marker itself, so restoring never depends on
     the archive list having loaded. */
  restoreThis: "Restore this semester",
  restoreOccupied:
    "This semester has new content in it. Archive the current semester first, then restore.",
  restoreMissing: "That archive isn't in your account any more.",
  /* Said when THIS DEVICE still holds the marker: the archive should
     exist, so "it's gone" is a claim we have evidence against. Names
     what to do instead of guessing at the cause. */
  restoreMissingButMarked:
    "This semester says it was archived, but the archive can't be found in your account. " +
    "Nothing has been changed here. Sign out and back in, then try again — and don't clear this device's data in the meantime.",
  restoreFailed: "Couldn't reach your archives. Check your connection and try again.",
  restored: "Semester restored.",

  deleteConfirm: "Delete this archive for good? This can't be undone.",
  deleteFailed: "Couldn't delete that archive, so it hasn't been deleted. Try again.",

  listFailed: "Couldn't load your archives. Check your connection and try again.",
  /* An empty list while this device holds a marker is a CONTRADICTION,
     not an empty account — an RLS-filtered query returns 200 with no
     rows and no error, which is byte-identical to having none. Never
     render "nothing archived yet" over an archive we know exists. */
  listContradicted:
    "Your archive list came back empty, but this semester is archived — so the list didn't load properly. " +
    "Your archive hasn't been touched; use “Restore this semester” above, or try again.",
  listEmpty: "Nothing archived yet. When a semester ends, box it up here.",
  lecturesHeading: "Archived lectures",
  lecturesHint: "Saved AI lecture notes from archived semesters — still readable, off your semester lists.",
};
