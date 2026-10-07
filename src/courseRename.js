/* ==================================================================
   courseRename.js — renaming a course, everywhere it is written down

   A course is referenced by NAME, not by id: every assignment,
   assessment, reading, card, event, to-do and AI-note stub stores the
   course as the string the student typed. So "rename" is not a field
   edit on one row; it is the same string rewritten on every item that
   carries it. Before 1.3.1 there was no rename at all (the Courses chip
   row had add and remove only), which is why nothing needed this.

   THE RULES, each a test in scripts/test-course-rename.mjs:

   - Every LIVE item whose course is the old name gets the new one and a
     fresh `updatedAt`, so the rename propagates by the ordinary per-item
     merge. An item that does not change is returned BY REFERENCE and
     keeps its stamp, so a rename touches exactly what it changed.
   - TOMBSTONES ARE NEVER TOUCHED. A deleted item keeps the name it died
     with. For an AI-note stub this is the absolute rule from the archive
     and clear-everything work: reconciliation recognises a tombstoned
     stub by its aiMeta, and nothing here may rewrite one.
   - The study log (studyStats) keys minutes by course name, on the day
     rows and on the totals row. Those keys are moved, and summed into
     the new key if it already holds minutes (a course once called that
     and since removed). It is bookkeeping, but a renamed course that
     lost its streak minutes would read as "you never studied this".
   - The auto-created "<course> recordings" folder is renamed with it,
     because folderForRecording files the next lecture by that exact
     name and would otherwise make a second folder. A folder the student
     renamed themselves is left alone, and so is the rename if a live
     folder already has the new name.
   - Refused, with nothing changed: an empty new name, an unchanged
     name, and a new name another live course already has (compared
     without case: "psyc1001" and "PSYC1001" would be two cards for one
     unit). Merging two courses is a different action and not this one.
     A change of case on the same course is allowed.

   WHAT IT CANNOT REACH, said rather than implied: archived semesters
   (their own rows, by design), the server copy of an AI note (the
   ai_notes row is immutable; its stub carries the course the app
   shows), and device-local state on OTHER devices (the study timer's
   remembered course). Another device editing an item under the old
   name before it syncs wins that item by last-write-wins and keeps the
   old tag; it shows as its own card, exactly as a removed course does.
   ================================================================== */

import { recordingFolderName } from "./aiNotesLogic.js";

/* The collections whose items carry `course` as a plain field. */
export const COURSE_FIELD_COLLECTIONS = Object.freeze(["todos", "textbook", "assignments", "notes", "events", "assessments"]);

const live = (x) => x && !x.deletedAt;
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/** Why a rename would be refused, or null when it can go ahead. */
export function renameRefusal(semester, from, to) {
  const next = String(to || "").trim();
  if (!next) return "empty";
  if (next === from) return "unchanged";
  const clash = ((semester && semester.courses) || []).some((c) => live(c) && c.name !== from && same(c.name, next));
  return clash ? "exists" : null;
}

function rekey(map, from, to) {
  if (!map || typeof map !== "object" || !(from in map)) return map;
  const out = { ...map };
  const moved = out[from];
  delete out[from];
  out[to] = Math.round(((out[to] || 0) + moved) * 10) / 10;
  return out;
}

/**
 * Rename `from` to `to` across one semester.
 * Returns { semester, changed } or { refused } with the semester untouched.
 */
export function renameCourse(semester, { from, to, now }) {
  const refused = renameRefusal(semester, from, to);
  if (refused) return { refused };
  const name = String(to).trim();
  let changed = 0;
  const touch = (item, patch) => {
    changed += 1;
    return { ...item, ...patch, updatedAt: now };
  };

  const out = { ...semester };

  out.courses = (semester.courses || []).map((c) => (live(c) && c.name === from ? touch(c, { name }) : c));

  for (const key of COURSE_FIELD_COLLECTIONS) {
    if (!semester[key]) continue;
    out[key] = semester[key].map((it) => (live(it) && it.course === from ? touch(it, { course: name }) : it));
  }

  if (semester.pages) {
    out.pages = semester.pages.map((p) =>
      live(p) && p.aiMeta && p.aiMeta.course === from ? touch(p, { aiMeta: { ...p.aiMeta, course: name } }) : p
    );
  }

  if (semester.folders) {
    const oldFolder = recordingFolderName(from);
    const newFolder = recordingFolderName(name);
    const taken = semester.folders.some((f) => live(f) && f.name === newFolder);
    out.folders = taken ? semester.folders : semester.folders.map((f) => (live(f) && f.name === oldFolder ? touch(f, { name: newFolder }) : f));
  }

  if (semester.studyStats) {
    out.studyStats = semester.studyStats.map((row) => {
      if (!live(row)) return row;
      const m = rekey(row.m, from, name);
      const mins = rekey(row.mins, from, name);
      if (m === row.m && mins === row.mins) return row;
      return touch(row, { ...(m !== row.m ? { m } : {}), ...(mins !== row.mins ? { mins } : {}) });
    });
  }

  return { semester: out, changed };
}

/* What a card's Remove does, decided here so the confirmation can say it
   before it happens. A course with nothing filed under it in Grades is
   just removed; one with assessments takes them with it (they are that
   card's rows, and a removed course whose rows stayed would leave the
   card exactly where it was). Everything ELSE tagged with the course
   keeps its tag, as removing a course always did. */
export function removalPlan(semester, name) {
  const assessments = ((semester && semester.assessments) || []).filter((a) => live(a) && a.course === name);
  const course = ((semester && semester.courses) || []).find((c) => live(c) && c.name === name) || null;
  return { course, assessmentIds: assessments.map((a) => a.id) };
}
