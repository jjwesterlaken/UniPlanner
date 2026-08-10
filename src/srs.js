/* ==================================================================
   srs.js — spaced repetition, study session assembly, and stats

   Every function here is pure: state in, new state out. No React, no
   browser globals, no clock of its own (anything needing "today" takes
   it as an argument). That's what lets scripts/test-ai-notes.mjs
   exercise the scheduling rules directly from Node, and it's why the
   awkward cases -- a card with no history, a user who stopped studying
   a week ago -- are testable at all.

   STORAGE RULE, non-negotiable: this module stores review STATE, never
   review HISTORY. One `srs` object per card, one row per day, and a
   42-day window on the day rows. The whole account syncs as a single
   JSON blob, so anything that grows without a ceiling eventually breaks
   sync for the user. There are no arrays of past reviews here and there
   must never be.
   ================================================================== */

/* ---------- dates ----------

   All dates are the DEVICE'S LOCAL date, formatted YYYY-MM-DD. Local
   rather than UTC because a streak is about the user's day: someone in
   Sydney studying at 9am should not have it counted as yesterday. Built
   from local getters (not toISOString) so it stays correct across DST.
   ---------------------------- */

const pad = (n) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD. */
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Adds whole days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  // Noon avoids a DST shift pushing the result onto the wrong date.
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  dt.setDate(dt.getDate() + n);
  return localDay(dt);
}

/** Whole days from `a` to `b` (negative if b is earlier). */
export function daysBetween(a, b) {
  const toUTC = (day) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

/* ---------- the scheduler ----------

   A simplified SM-2. Each card carries one compact object:

     srs: { d: "2026-08-14", i: 3, e: 2.5, l: 1, n: 7 }
            due          interval  ease  lapses  reps

   ~51 bytes per card. `d` is kept as a readable date rather than a day
   number: the integer form saves 7 bytes, which is 6.8KB across 1000
   cards, and is not worth making every stored card unreadable.
   ------------------------------------ */

export const EASE_DEFAULT = 2.5;
export const EASE_MIN = 1.3; // SM-2's floor: below this, intervals barely grow
export const EASE_MAX = 3.0; // a ceiling SM-2 lacks, so one lucky run can't push a card years out
export const MAX_INTERVAL_DAYS = 365;

export const RATINGS = ["again", "good", "easy"];

/**
 * Reads whatever is stored on a card and returns usable scheduling
 * state. A card with no `srs` -- every card that exists today -- is a
 * new card, due immediately. Legacy or corrupt shapes fall back the
 * same way rather than throwing, because a bad field must not be able
 * to make a card unstudiable.
 */
export function readSrs(card) {
  const s = card && card.srs;
  if (!s || typeof s !== "object") return null;
  const i = Number(s.i);
  const e = Number(s.e);
  const l = Number(s.l);
  const n = Number(s.n);
  if (typeof s.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.d)) return null;
  if (!Number.isFinite(i) || !Number.isFinite(e) || !Number.isFinite(n)) return null;
  return {
    d: s.d,
    i: Math.max(0, i),
    e: clampEase(e),
    l: Number.isFinite(l) ? Math.max(0, l) : 0,
    n: Math.max(0, n),
  };
}

const clampEase = (e) => Math.min(EASE_MAX, Math.max(EASE_MIN, e));

/** True when a card has never been reviewed (or lost its state). */
export const isNew = (card) => readSrs(card) === null;

/** True when the card should come up in a review session today. */
export function isDue(card, today = localDay()) {
  const s = readSrs(card);
  if (!s) return true; // new cards are due immediately
  return s.d <= today;
}

/**
 * The core transition: current card state + rating -> new `srs` object.
 *
 * - Again: lapse. Ease drops, interval resets to 0 so the card returns
 *   today, and it stays in the session queue until it's answered better.
 * - Good:  first pass sets 1 day, thereafter interval x ease.
 * - Easy:  ease rises and the interval jumps beyond a plain Good.
 *
 * `n` counts every review including lapses -- it measures exposure, not
 * success, and the weak-spot view reads it that way.
 */
export function schedule(card, rating, today = localDay()) {
  const prev = readSrs(card);
  const base = prev || { d: today, i: 0, e: EASE_DEFAULT, l: 0, n: 0 };
  const n = base.n + 1;

  if (rating === "again") {
    const e = clampEase(base.e - 0.2);
    // Interval 0 (due today) rather than 1: a card just failed, so it
    // should come back in this session, not tomorrow.
    return { d: today, i: 0, e, l: base.l + 1, n };
  }

  if (rating === "easy") {
    const e = clampEase(base.e + 0.15);
    const i = Math.min(MAX_INTERVAL_DAYS, base.i <= 0 ? 3 : Math.round(base.i * e * 1.3));
    return { d: addDays(today, i), i, e, l: base.l, n };
  }

  // "good" (and any unrecognised rating, which is treated as the safe middle)
  const e = base.e;
  const i = Math.min(MAX_INTERVAL_DAYS, base.i <= 0 ? 1 : Math.round(base.i * e));
  return { d: addDays(today, i), i, e, l: base.l, n };
}

/** Human-readable "next review" hint for the session-complete screen. */
export function nextDueDay(cards, today = localDay()) {
  let best = null;
  for (const c of cards || []) {
    const s = readSrs(c);
    if (!s) return today; // a new card is due now
    if (best === null || s.d < best) best = s.d;
  }
  return best;
}

/* ---------- building a session ---------- */

/**
 * Interleaved practice: due cards from every course, ordered so that
 * consecutive cards come from different courses wherever possible.
 *
 * Greedy round-robin over per-course buckets, always taking from the
 * largest bucket that isn't the course just used. When one course has
 * more cards than all others combined its cards must eventually sit
 * together -- that's arithmetic, not a bug -- so the aim is "no
 * avoidable repeat", not "never repeats".
 *
 * `rand` is injected so tests are deterministic.
 */
export function interleave(cards, rand = Math.random) {
  const buckets = new Map();
  for (const c of cards || []) {
    const key = (c && c.course) || "No course";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  for (const list of buckets.values()) shuffleInPlace(list, rand);

  const out = [];
  let lastCourse = null;
  while (true) {
    let pick = null;
    let pickSize = -1;
    for (const [course, list] of buckets) {
      if (!list.length) continue;
      // Prefer the biggest remaining bucket; skip the previous course
      // unless it's all that's left (handled by the fallback below).
      if (course !== lastCourse && list.length > pickSize) {
        pick = course;
        pickSize = list.length;
      }
    }
    if (pick === null) {
      for (const [course, list] of buckets) {
        if (list.length) {
          pick = course;
          break;
        }
      }
    }
    if (pick === null) break;
    out.push(buckets.get(pick).shift());
    lastCourse = pick;
  }
  return out;
}

function shuffleInPlace(a, rand) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Cards due today across every course, interleaved. */
export function buildReviewSession(cards, { today = localDay(), rand = Math.random } = {}) {
  return interleave((cards || []).filter((c) => isDue(c, today)), rand);
}

/** Every card for one course, due or not, for cram/practice. Writes no state. */
export function buildPracticeSession(cards, course, { rand = Math.random } = {}) {
  const wanted = (cards || []).filter((c) => ((c && c.course) || "No course") === course);
  return shuffleInPlace([...wanted], rand);
}

/* ---------- weak spots ----------

   Purely derived from scheduling state -- nothing extra is stored. A
   card is weak when it has lapsed repeatedly or its ease has been
   driven down; both mean the same thing from different directions.
   --------------------------------- */

export function weakSpots(cards, { limit = 20, minLapses = 1 } = {}) {
  const scored = [];
  for (const c of cards || []) {
    const s = readSrs(c);
    if (!s || s.l < minLapses) continue;
    // Lapses dominate; ease breaks ties. A card failed 4 times at ease
    // 2.5 is worse than one failed twice at 1.3.
    scored.push({ card: c, lapses: s.l, ease: s.e, score: s.l * 10 + (EASE_MAX - s.e) });
  }
  scored.sort((a, b) => b.score - a.score);
  const byCourse = new Map();
  for (const row of scored.slice(0, limit)) {
    const key = (row.card && row.card.course) || "No course";
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key).push(row);
  }
  return byCourse;
}

/* ---------- daily stats ----------

   Two item kinds live in the `studyStats` collection, which syncs like
   any other collection (whole-item last-write-wins by updatedAt):

     { id: "d:2026-08-10", m: { BIO101: 30 }, c: 20, updatedAt }  one per day
     { id: "t", cur, max, last, mins: { BIO101: 640 }, updatedAt }  totals

   One item PER DAY rather than one log object so two devices studying
   on different days both survive the merge. Same day on both devices
   still resolves last-write-wins; merging additively would mean
   changing the merge algorithm, which is out of bounds.
   --------------------------------- */

export const WINDOW_DAYS = 42;
// Mirrors sync.js's TOMBSTONE_DAYS. Duplicated rather than imported so
// this module stays free of sync concerns; the test asserts they agree.
export const TOMBSTONE_DAYS = 60;
export const TOTALS_ID = "t";
export const dayId = (day) => `d:${day}`;
export const MAX_SESSION_MINUTES = 4 * 60; // an abandoned timer must not log 14 hours

/** True for a day row inside the rolling window, ignoring tombstones. */
function inWindow(item, today) {
  if (!item || !item.id || item.deletedAt) return false;
  if (item.id === TOTALS_ID) return false;
  const day = String(item.id).slice(2);
  const age = daysBetween(day, today);
  // Readers filter unconditionally, so a day resurrected by a sync can
  // never inflate a stat even before pruning catches it again.
  return age >= 0 && age < WINDOW_DAYS;
}

/** Day rows inside the window, oldest first. */
export function windowDays(studyStats, today = localDay()) {
  return (studyStats || [])
    .filter((it) => inWindow(it, today))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function findTotals(studyStats) {
  return (studyStats || []).find((it) => it && it.id === TOTALS_ID && !it.deletedAt) || null;
}

/**
 * Applies one increment to the studyStats collection and returns the
 * new collection.
 *
 * The caller passes the CURRENT collection every time; nothing is
 * cached across a session. A sync landing mid-session therefore gets
 * added to rather than overwritten.
 *
 * Pruning marks old days with `deletedAt` instead of dropping them --
 * a plain delete would be re-added by the next sync, which is exactly
 * what tombstones exist to prevent. Tombstones themselves are dropped
 * after 60 days by this function rather than by sync.js's purge,
 * because that purge only runs when syncing and this collection prunes
 * every single day: a demo-mode user would otherwise accumulate one
 * tombstone per day forever.
 */
export function recordStudy(studyStats, { day, course, minutes = 0, cards = 0, now }) {
  const list = [...(studyStats || [])];
  const stamp = now || new Date().toISOString();
  const id = dayId(day);

  const idx = list.findIndex((it) => it && it.id === id);
  const existing = idx >= 0 && !list[idx].deletedAt ? list[idx] : null;
  const mins = { ...((existing && existing.m) || {}) };
  if (minutes > 0) {
    const key = course || "No course";
    mins[key] = round1((mins[key] || 0) + minutes);
  }
  const row = {
    id,
    m: mins,
    c: ((existing && existing.c) || 0) + cards,
    updatedAt: stamp,
  };
  if (idx >= 0) list[idx] = row;
  else list.push(row);

  return pruneStats(applyTotals(list, { day, course, minutes, cards, stamp }), day, stamp);
}

function applyTotals(list, { day, course, minutes, cards, stamp }) {
  const out = [...list];
  const idx = out.findIndex((it) => it && it.id === TOTALS_ID);
  const prev = idx >= 0 && !out[idx].deletedAt ? out[idx] : null;

  const mins = { ...((prev && prev.mins) || {}) };
  if (minutes > 0) {
    const key = course || "No course";
    mins[key] = round1((mins[key] || 0) + minutes);
  }

  // Streak advances only on a day that actually saw study.
  const studied = minutes > 0 || cards > 0;
  let cur = (prev && prev.cur) || 0;
  let last = (prev && prev.last) || null;
  if (studied) {
    if (last === day) {
      cur = Math.max(cur, 1);
    } else if (last && daysBetween(last, day) === 1) {
      cur = cur + 1;
    } else {
      cur = 1;
    }
    last = day;
  }
  const max = Math.max((prev && prev.max) || 0, cur);

  const row = { id: TOTALS_ID, cur, max, last, mins, updatedAt: stamp };
  if (idx >= 0) out[idx] = row;
  else out.push(row);
  return out;
}

/** Tombstones day rows past the window; drops tombstones past 60 days. */
export function pruneStats(studyStats, today = localDay(), now) {
  const stamp = now || new Date().toISOString();
  const tombCutoff = addDays(today, -TOMBSTONE_DAYS);
  const out = [];
  for (const it of studyStats || []) {
    if (!it || !it.id) continue;
    if (it.id === TOTALS_ID) {
      out.push(it);
      continue;
    }
    const day = String(it.id).slice(2);
    const age = daysBetween(day, today);
    if (it.deletedAt) {
      // Drop long-dead tombstones ourselves: sync.js's purge only runs
      // when syncing, and this collection prunes daily.
      if (day > tombCutoff) out.push(it);
      continue;
    }
    if (age >= WINDOW_DAYS) {
      // Payload stripped: a tombstone only ever wins the merge against a
      // day already outside the window, so keeping it costs bytes for
      // nothing.
      out.push({ id: it.id, deletedAt: stamp, updatedAt: stamp });
      continue;
    }
    out.push(it);
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;

/* ---------- derived figures for the stats panel ---------- */

/**
 * Everything the stats view shows, derived at READ time.
 *
 * The streak matters here: a stored `cur` goes stale the moment the
 * user stops studying, so someone who last studied a week ago would
 * still be shown a 5-day streak. `cur` only stands if the last study
 * day was today or yesterday.
 */
export function studySummary(studyStats, today = localDay()) {
  const days = windowDays(studyStats, today);
  const totals = findTotals(studyStats);

  const byDay = new Map(days.map((d) => [String(d.id).slice(2), d]));
  const todayRow = byDay.get(today) || null;

  const minutesToday = sumMinutes(todayRow);
  const cardsToday = (todayRow && todayRow.c) || 0;

  let minutesWeek = 0;
  for (let i = 0; i < 7; i++) {
    minutesWeek += sumMinutes(byDay.get(addDays(today, -i)));
  }

  const last = (totals && totals.last) || null;
  const gap = last ? daysBetween(last, today) : null;
  const current = last && (gap === 0 || gap === 1) ? (totals && totals.cur) || 0 : 0;

  return {
    current,
    longest: (totals && totals.max) || 0,
    minutesToday: round1(minutesToday),
    cardsToday,
    minutesWeek: round1(minutesWeek),
    byCourse: { ...((totals && totals.mins) || {}) },
    activeDays: days.filter((d) => sumMinutes(d) > 0 || (d.c || 0) > 0).length,
  };
}

function sumMinutes(row) {
  if (!row || !row.m) return 0;
  let total = 0;
  for (const v of Object.values(row.m)) total += Number(v) || 0;
  return total;
}

/** Clamps one timer run. An abandoned timer must not log a whole night. */
export function clampSessionMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return round1(Math.min(MAX_SESSION_MINUTES, minutes));
}
