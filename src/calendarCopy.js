/* ==================================================================
   calendarCopy.js — the words on the recurring-event controls

   For Grace to rework. Nothing here decides behaviour: recurrence.js
   does, and these only describe it. `{n}` and `{date}` are filled in.
   ================================================================== */

export const RECURRENCE_COPY = {
  repeatLabel: "Repeats weekly (for recurring class times)",
  endLabel: "Ends",
  endSemester: "At the end of semester",
  endSemesterHint: "Skips the mid-semester break. Last class the week ending {date}.",
  endSemesterUnset: "Set the semester start and teaching weeks on the Courses tab to use this.",
  endCount: "After a number of classes",
  endCountHint: "Break weeks are skipped and not counted.",
  endCountAria: "Number of classes",
  endNone: "Never",

  /* The chip on an event in the day list. */
  chipWeekly: "Weekly",
  chipSemester: "Weekly · until end of semester",
  chipCount: "Weekly · {n} times",
  chipUntil: "Weekly · until {date}",

  /* Deleting one occurrence of a weekly event. */
  deleteTitle: "Delete a repeating event",
  deleteOne: "This event only",
  deleteFollowing: "This and all following",
  deleteAll: "All events in the series",
  deleteCancel: "Cancel",
};

export const fillCopy = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
