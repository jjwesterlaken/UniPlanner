/* ==================================================================
   recurrence.js — when a weekly calendar event occurs

   A weekly event used to repeat forever: `repeat: "weekly"` and a start
   date, expanded at render. Uni classes run for a semester, so a
   student either lived with a Tuesday lecture haunting the calendar
   into January or deleted it and lost the term's entries with it.

   THREE OPTIONAL FIELDS, all riding the ordinary per-item merge (a new
   field on an existing item needs no merge change — see CLAUDE.md):

     repeatEnd  absent/null  no end. EXACTLY the old behaviour, which is
                             what every event saved before this has.
                {kind:"semester"}  until the Sunday of the last teaching
                             week (settings.start + settings.teachingWeeks,
                             break weeks not counted), and skipping the
                             mid-semester break.
                {kind:"count", n}  n occurrences, break weeks skipped
                             and NOT counted, so "12 times" is twelve
                             classes rather than eleven and a holiday.
     until      ISO date, inclusive. "This and all following" writes it,
                on top of whichever end the series already had, so a
                semester series cut short still skips the break.
     skip       ISO dates. "This event only" appends one.

   An absent repeatEnd is LEGACY, and legacy is left alone completely:
   no break skipping, no end. The differential in test-recurrence.mjs
   runs the old predicate beside this one for a year of days.

   Deleting an occurrence is a PATCH, never a removal, so it is an
   ordinary edit with a bumped updatedAt and it propagates like one.
   Only "all events in the series" tombstones the item.

   SIZE: `skip` grows only by a deliberate tap per occurrence, and a
   bounded series has at most ~13 of those. Nothing grows on its own.

   Pure: no React, no browser globals.
   ================================================================== */

import { addDays } from "./srs.js";
import { breaksOf, inBreak, teachingWeek, weekStart } from "./workload.js";

/** Default for "repeat N times" when the semester dates aren't set. */
export const DEFAULT_REPEAT_COUNT = 12;
/** A teaching-weeks figure above this is a typo, not a semester. */
export const MAX_TEACHING_WEEKS = 30;
/** The most occurrences a count series may ask for. */
export const MAX_REPEAT_COUNT = 60;

const isISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const weekday = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getDay();
};

/** The whole number of teaching weeks, or null when unset or unusable. */
export function teachingWeeksOf(settings) {
  const n = Number(settings && settings.teachingWeeks);
  return Number.isInteger(n) && n >= 1 && n <= MAX_TEACHING_WEEKS ? n : null;
}

/**
 * The last day of the semester: the Sunday of teaching week N.
 * Null when the start date or the number of teaching weeks is missing.
 */
export function semesterEnd(settings) {
  const start = settings && settings.start;
  const n = teachingWeeksOf(settings);
  if (!isISO(start) || !n) return null;
  const breaks = breaksOf(settings);
  let monday = weekStart(start);
  // Every week is either a teaching week or a break week, so N teaching
  // weeks end within N + (number of breaks) weeks. The bound is generous.
  for (let i = 0; i < n + breaks.length + 2; i++, monday = addDays(monday, 7)) {
    const probe = monday < start ? start : monday;
    // A break week has no teaching week; look at every day, since a
    // break needn't start on the Monday.
    for (let d = 0; d < 7; d++) {
      const day = addDays(monday, d);
      if (day < probe) continue;
      if (teachingWeek(day, settings) === n) return addDays(monday, 6);
    }
  }
  return null;
}

/** "Until the end of semester" when the dates allow it, otherwise N times. */
export function defaultRepeatEnd(settings) {
  return semesterEnd(settings) ? { kind: "semester" } : { kind: "count", n: DEFAULT_REPEAT_COUNT };
}

function countOf(end) {
  const n = Number(end && end.n);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_REPEAT_COUNT;
  return Math.min(n, MAX_REPEAT_COUNT);
}

/** The date of the last occurrence a bounded series can have, before `until`. */
function lastByKind(event, settings) {
  const end = event.repeatEnd;
  const breaks = breaksOf(settings);
  if (end.kind === "semester") {
    const last = semesterEnd(settings);
    if (last && last >= event.date) return last;
    // The semester dates were cleared after the event was saved, or the
    // event starts after the semester has ended (next term's timetable
    // entered before its dates were). A series with no end is the thing
    // this exists to prevent, and one that shows nothing at all reads as
    // "the app lost my class", so both fall back to the count default.
  }
  const n = end.kind === "count" ? countOf(end) : DEFAULT_REPEAT_COUNT;
  let day = event.date;
  let found = 0;
  let last = event.date;
  for (let i = 0; found < n && i < n + 60; i++, day = addDays(day, 7)) {
    if (inBreak(day, breaks)) continue;
    found += 1;
    last = day;
  }
  return last;
}

const skipsBreaks = (event) => !!(event.repeatEnd && event.repeatEnd.kind);

/** Does `event` occur on `iso`? The one question the calendar asks. */
export function occursOn(event, iso, settings) {
  if (!event || !isISO(event.date) || !isISO(iso)) return false;
  if (event.repeat !== "weekly") return event.date === iso;
  if (weekday(event.date) !== weekday(iso) || iso < event.date) return false;
  if (Array.isArray(event.skip) && event.skip.includes(iso)) return false;
  if (isISO(event.until) && iso > event.until) return false;
  if (!skipsBreaks(event)) return true; // legacy / no end: unchanged
  if (inBreak(iso, breaksOf(settings))) return false;
  return iso <= lastByKind(event, settings);
}

/** The occurrence before `iso` in this series, or null when `iso` is the first. */
export function previousOccurrence(event, iso, settings) {
  for (let day = addDays(iso, -7); day >= event.date; day = addDays(day, -7)) {
    if (occursOn(event, day, settings)) return day;
  }
  return null;
}

/** The patch for "this event only". */
export function skipPatch(event, iso) {
  const skip = Array.isArray(event.skip) ? event.skip : [];
  return { skip: skip.includes(iso) ? skip : [...skip, iso].sort() };
}

/**
 * What "this and all following" does: a patch ending the series the day
 * before, or `{ remove: true }` when nothing would be left of it.
 */
export function followingPatch(event, iso, settings) {
  if (!previousOccurrence(event, iso, settings)) return { remove: true };
  return { patch: { until: addDays(iso, -1) } };
}

/** How many occurrences a series has, or null when it has no end. */
export function occurrenceCount(event, settings) {
  if (!event || event.repeat !== "weekly" || !isISO(event.date)) return null;
  if (!skipsBreaks(event) && !isISO(event.until)) return null;
  const last = skipsBreaks(event) ? lastByKind(event, settings) : event.until;
  const cap = isISO(event.until) && event.until < last ? event.until : last;
  let n = 0;
  for (let day = event.date; day <= cap; day = addDays(day, 7)) if (occursOn(event, day, settings)) n += 1;
  return n;
}
