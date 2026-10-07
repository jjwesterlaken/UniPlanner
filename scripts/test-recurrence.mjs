/* test-recurrence.mjs — bounded weekly events (src/recurrence.js).

   The claims:

   1. NOTHING CHANGES UNDER ANYONE. An event saved before this — weekly,
      no end — occurs on exactly the days it did, checked against the old
      predicate for every day of a year, with and without a break set.
   2. "UNTIL THE END OF SEMESTER" is the Sunday of teaching week N, the
      break not counted, and the break's own week has no class.
   3. "N TIMES" skips the break and does not count it.
   4. Deleting one occurrence, or this-and-following, is a patch on the
      one item — never a removal — and it rides the per-item merge.
   5. In the real app: a new weekly event defaults to the semester end
      when the dates are set, and the three delete choices do what they
      say to the stored planner. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as R from "../src/recurrence.js";
import { addDays, localDay } from "../src/srs.js";
import { weekStart } from "../src/workload.js";
import { mergeData } from "../src/sync.js";
import { RECURRENCE_COPY } from "../src/calendarCopy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok  - ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  - ${name}`);
      console.error(`        ${err.message}`);
    }
  });
}

/* A semester: starts Monday 27 July 2026, 12 teaching weeks, a break
   in calendar week 10 (28 Sep – 4 Oct). 13 calendar weeks in all, so
   it ends Sunday 25 October. */
const SEM = { start: "2026-07-27", teachingWeeks: 12, breaks: [{ from: "2026-09-28", to: "2026-10-04" }] };
const TUE = "2026-07-28";
const tuesdays = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, 7 * i));
const days = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
const on = (e, s = SEM) => days("2026-07-01", 200).filter((d) => R.occursOn(e, d, s));

/* The predicate exactly as Calendar's eventsForDay had it. */
const parseISO = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const OLD = (e, iso) => {
  if (!e.date) return false;
  if (e.repeat === "weekly") return parseISO(e.date).getDay() === parseISO(iso).getDay() && iso >= e.date;
  return e.date === iso;
};

test("NOTHING CHANGES UNDER ANYONE: every legacy event occurs on exactly the old days, for a year, with and without a semester set", () => {
  const events = [];
  for (let i = 0; i < 14; i++) {
    events.push({ id: `w${i}`, date: addDays("2026-06-01", i * 5), repeat: "weekly" });
    events.push({ id: `n${i}`, date: addDays("2026-06-01", i * 5), repeat: "none" });
  }
  events.push({ id: "odd", date: "2026-07-28" }); // no repeat field at all
  events.push({ id: "nodate", repeat: "weekly" });
  let compared = 0;
  let occurrences = 0;
  for (const s of [{}, SEM, undefined]) {
    for (const e of events) {
      for (const d of days("2026-05-01", 400)) {
        const a = OLD(e, d);
        assert.equal(R.occursOn(e, d, s), a, `${e.id} on ${d}`);
        compared++;
        if (a) occurrences++;
      }
    }
  }
  assert.ok(compared > 30000 && occurrences > 1000, "the differential compared almost nothing");
  // The break week is where the new rules differ, so a legacy series must
  // still show up in it — this is the day a careless rewrite would change.
  assert.equal(R.occursOn({ date: TUE, repeat: "weekly" }, "2026-09-29", SEM), true);
});

test("THE SEMESTER END is the Sunday of teaching week N, not counting the break", () => {
  assert.equal(R.semesterEnd(SEM), "2026-10-25");
  assert.equal(R.semesterEnd({ ...SEM, breaks: [] }), "2026-10-18");
  // A start mid-week still makes that week week 1.
  assert.equal(R.semesterEnd({ start: "2026-07-29", teachingWeeks: 1 }), "2026-08-02");
  // A break that starts on a Wednesday still takes its week out.
  assert.equal(R.semesterEnd({ ...SEM, breaks: [{ from: "2026-09-30", to: "2026-10-06" }] }), "2026-10-25");
  for (const bad of [{}, { start: SEM.start }, { teachingWeeks: 12 }, { ...SEM, teachingWeeks: 0 }, { ...SEM, teachingWeeks: "x" }, { ...SEM, teachingWeeks: 2.5 }, { ...SEM, teachingWeeks: 99 }]) {
    assert.equal(R.semesterEnd(bad), null, JSON.stringify(bad));
  }
});

test("UNTIL THE END OF SEMESTER: twelve Tuesdays, none in the break, none after", () => {
  const e = { date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" } };
  const got = on(e);
  assert.equal(got.length, 12);
  assert.ok(!got.includes("2026-09-29"), "a class in the break");
  assert.equal(got[0], TUE);
  assert.equal(got.at(-1), "2026-10-20");
  assert.equal(R.occurrenceCount(e, SEM), 12);
});

test("N TIMES: the break is skipped and not counted, so twelve is twelve classes", () => {
  const e = { date: TUE, repeat: "weekly", repeatEnd: { kind: "count", n: 12 } };
  const got = on(e, { breaks: SEM.breaks }); // no semester dates: the count mode's own case
  assert.equal(got.length, 12);
  assert.ok(!got.includes("2026-09-29"));
  assert.equal(got.at(-1), "2026-10-20", "the break was counted as a class");
  assert.equal(on({ ...e, repeatEnd: { kind: "count", n: 3 } }).length, 3);
  assert.equal(R.occurrenceCount({ ...e, repeatEnd: { kind: "count", n: 1000 } }, SEM), R.MAX_REPEAT_COUNT, "an absurd count is not capped");
});

test("THE DEFAULT: semester when the dates are set, twelve times when they aren't", () => {
  assert.deepEqual(R.defaultRepeatEnd(SEM), { kind: "semester" });
  assert.deepEqual(R.defaultRepeatEnd({ start: SEM.start }), { kind: "count", n: 12 });
  assert.deepEqual(R.defaultRepeatEnd({}), { kind: "count", n: R.DEFAULT_REPEAT_COUNT });
  assert.equal(R.DEFAULT_REPEAT_COUNT, 12);
});

test("A SEMESTER SERIES NEVER BECOMES FOREVER OR NOTHING: dates cleared, or a class starting after the end, falls back to twelve", () => {
  const e = { date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" } };
  assert.equal(on(e, {}).length, 12, "clearing the dates made it endless");
  const late = { ...e, date: "2026-11-03" };
  const got = days("2026-11-01", 200).filter((d) => R.occursOn(late, d, SEM));
  assert.equal(got.length, 12, "a class entered for next term showed nothing");
});

test("THIS EVENT ONLY: one date goes, the rest stay, and the series still ends where it did", () => {
  const e = { date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" } };
  const p = R.skipPatch(e, "2026-08-11");
  assert.deepEqual(p, { skip: ["2026-08-11"] });
  const e2 = { ...e, ...p };
  assert.equal(R.occursOn(e2, "2026-08-11", SEM), false);
  assert.equal(on(e2).length, 11);
  assert.equal(on(e2).at(-1), "2026-10-20", "a deleted class moved the end");
  assert.deepEqual(R.skipPatch(e2, "2026-08-11"), { skip: ["2026-08-11"] }, "a second tap duplicated the date");
  // It works on a legacy series too — the one place a legacy event gains a field.
  const legacy = { date: TUE, repeat: "weekly" };
  assert.equal(R.occursOn({ ...legacy, ...R.skipPatch(legacy, "2026-08-04") }, "2026-08-04", SEM), false);
  assert.equal(R.occursOn({ ...legacy, ...R.skipPatch(legacy, "2026-08-04") }, "2026-08-11", SEM), true);
});

test("THIS AND ALL FOLLOWING: ends the day before, keeps skipping the break, and on the first class removes the series", () => {
  const e = { date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" } };
  const r = R.followingPatch(e, "2026-10-06", SEM);
  assert.deepEqual(r, { patch: { until: "2026-10-05" } });
  const cut = { ...e, ...r.patch };
  const got = on(cut);
  assert.equal(got.at(-1), "2026-09-22", "the week after the break is the cut, so the last class is the one before it");
  assert.ok(!got.includes("2026-09-29"), "cutting the series brought the break week back");
  assert.equal(R.occurrenceCount(cut, SEM), 9);
  assert.deepEqual(R.followingPatch(e, TUE, SEM), { remove: true });
  // A legacy, endless series gets an end — and nothing else about it changes.
  const legacy = { date: TUE, repeat: "weekly" };
  const lr = R.followingPatch(legacy, "2026-09-29", SEM);
  assert.deepEqual(lr, { patch: { until: "2026-09-28" } });
  assert.equal(on({ ...legacy, ...lr.patch }).length, 9);
  // The first occurrence of a series whose own first date was skipped is its second date.
  const skipped = { ...e, skip: [TUE] };
  assert.deepEqual(R.followingPatch(skipped, "2026-08-04", SEM), { remove: true });
});

test("THE FIELDS RIDE THE MERGE: a delete on one device reaches the other, and an older edit cannot undo it", () => {
  const base = { id: "lec", title: "Lecture", date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" }, updatedAt: "2026-08-01T00:00:00.000Z" };
  const phone = { semesters: { "Semester 1": { events: [{ ...base, ...R.skipPatch(base, "2026-08-11"), updatedAt: "2026-08-10T00:00:00.000Z" }], settings: [SEM] } }, meta: { updatedAt: "2026-08-10T00:00:00.000Z" } };
  const laptop = { semesters: { "Semester 1": { events: [base], settings: [SEM] } }, meta: { updatedAt: "2026-08-02T00:00:00.000Z" } };
  for (const [a, b] of [[phone, laptop], [laptop, phone]]) {
    const [ev] = mergeData(a, b).semesters["Semester 1"].events;
    assert.deepEqual(ev.skip, ["2026-08-11"]);
    assert.deepEqual(ev.repeatEnd, { kind: "semester" });
  }
});

/* OTHER NON-TEACHING WEEKS (1.3.1): the same semester with two more
   ranges, in calendar weeks 4 and 12. They are skipped exactly as the
   break is, so twelve teaching weeks now take fifteen calendar weeks. */
const SEM2 = {
  ...SEM,
  extraBreaks: [
    { id: "x1", from: "2026-08-17", to: "2026-08-23" },
    { id: "x2", from: "2026-10-12", to: "2026-10-18" },
  ],
};

test("OTHER NON-TEACHING WEEKS: with two extra ranges the semester ends two calendar weeks later", () => {
  assert.equal(R.semesterEnd(SEM), "2026-10-25", "the control: one break, thirteen calendar weeks");
  assert.equal(R.semesterEnd(SEM2), "2026-11-08", "two extra ranges and the break: fifteen calendar weeks");
});

test("OTHER NON-TEACHING WEEKS: a semester series skips both extra ranges and the break, and still runs twelve classes", () => {
  const e = { id: "e", date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" } };
  const got = on(e, SEM2);
  const skipped = ["2026-08-18", "2026-09-29", "2026-10-13"];
  for (const d of skipped) assert.ok(!got.includes(d), `a class on ${d}, inside a non-teaching range`);
  assert.equal(got.length, 12, `${got.length} classes`);
  assert.equal(got.at(-1), "2026-11-03", "the last class is in teaching week 12");
  /* NON-VACUITY: without the extra ranges the same series has classes
     on both of those dates, so the skip above is the ranges' doing. */
  const control = on(e, SEM);
  assert.ok(control.includes("2026-08-18") && control.includes("2026-10-13"), "the control never had classes on those dates");
});

test("OTHER NON-TEACHING WEEKS: N times skips them and does not count them", () => {
  const e = { id: "e", date: TUE, repeat: "weekly", repeatEnd: { kind: "count", n: 12 } };
  const got = on(e, SEM2);
  assert.equal(got.length, 12);
  assert.ok(!got.includes("2026-08-18") && !got.includes("2026-10-13"));
  assert.equal(R.occurrenceCount(e, SEM2), 12);
});

test("OTHER NON-TEACHING WEEKS: an empty list, or a half-typed range, changes nothing", () => {
  const e = { id: "e", date: TUE, repeat: "weekly", repeatEnd: { kind: "semester" } };
  assert.deepEqual(on(e, { ...SEM, extraBreaks: [] }), on(e, SEM));
  assert.deepEqual(on(e, { ...SEM, extraBreaks: [{ id: "h", from: "2026-08-17", to: "" }] }), on(e, SEM), "a range with one end was applied");
  assert.equal(R.semesterEnd({ ...SEM, extraBreaks: [{ id: "h", from: "2026-08-17" }] }), "2026-10-25");
});

test("THE SIZE: a fully-used bounded series stays under a kilobyte", () => {
  let e = { id: "x".repeat(14), title: "Statistics lecture", course: "STAT1001", date: TUE, start: "09:00", end: "11:00", location: "Building 8, Room 204", repeat: "weekly", repeatEnd: { kind: "semester" }, updatedAt: new Date().toISOString() };
  for (const d of on(e)) e = { ...e, ...R.skipPatch(e, d) };
  e.until = "2026-10-19";
  assert.ok(JSON.stringify(e).length < 1024, `${JSON.stringify(e).length} bytes`);
});

/* ---------- the real app ---------- */

const tmp = path.join(rootDir, ".recurrence-tmp");
fs.mkdirSync(tmp, { recursive: true });
const demoConfig = path.join(tmp, "config-demo.js");
fs.writeFileSync(demoConfig, 'export const SUPABASE_URL = "PASTE_YOUR_URL";\nexport const SUPABASE_ANON_KEY = "PASTE_YOUR_KEY";\nexport const isConfigured = false;\n');
const bundle = await build({
  entryPoints: [path.join(rootDir, "src/main.jsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  write: false,
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "demo", setup: (b) => b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig })) }],
});
fs.rmSync(tmp, { recursive: true, force: true });
const JS = bundle.outputFiles[0].text;

/* The calendar opens on today, so the fixture is built around today:
   the series started two weeks ago and today is its third class. */
const TODAY = localDay(new Date());
const MOUNT_SEM = { id: "settings", start: weekStart(addDays(TODAY, -14)), teachingWeeks: 12, breaks: [], updatedAt: "2026-01-01T00:00:00.000Z" };
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function mount(events) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: "outside-only", url: "https://example.test/", pretendToBeVisual: true });
  const w = dom.window;
  const complaints = [];
  w.console.error = (...a) => complaints.push(a.join(" "));
  w.localStorage.setItem(
    "uni-planner-v1",
    JSON.stringify({ semester: "Semester 1", semesters: { "Semester 1": { events, settings: [MOUNT_SEM] } }, meta: { updatedAt: "2026-01-01T00:00:00.000Z" } })
  );
  w.localStorage.setItem("uni-planner-tab", "calendar");
  w.eval(JS);
  await settle(400);
  const doc = w.document;
  const button = (label) => [...doc.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);
  if (!doc.querySelector("[aria-label='Previous month']")) {
    button("Plan") && button("Plan").click();
    await settle(120);
    button("Calendar") && button("Calendar").click();
    await settle(200);
  }
  assert.ok(doc.querySelector("[aria-label='Previous month']"), "the walk did not reach the calendar");
  const stored = async () => {
    await settle(1500);
    return JSON.parse(w.localStorage.getItem("uni-planner-v1")).semesters["Semester 1"].events;
  };
  const deleteOf = (title) => {
    const li = [...doc.querySelectorAll("li")].find((l) => l.querySelector("h5") && l.querySelector("h5").textContent === title);
    assert.ok(li, `"${title}" is not on today's list`);
    return li;
  };
  return { w, doc, button, stored, deleteOf, complaints };
}

const lecture = (id, title, extra = {}) => ({ id, title, date: addDays(TODAY, -14), repeat: "weekly", repeatEnd: { kind: "semester" }, updatedAt: "2026-01-01T00:00:00.000Z", ...extra });

async function choose(m, title, which) {
  const li = m.deleteOf(title);
  li.querySelector("[aria-label='Delete']").click();
  await settle(80);
  const group = m.deleteOf(title).querySelector("[data-delete-choices]");
  assert.ok(group, "a weekly event's delete did not offer the choices");
  assert.deepEqual([...group.querySelectorAll("[data-delete]")].map((b) => b.textContent.trim()), [RECURRENCE_COPY.deleteOne, RECURRENCE_COPY.deleteFollowing, RECURRENCE_COPY.deleteAll]);
  group.querySelector(`[data-delete='${which}']`).click();
  await settle(80);
}

test("IN THE APP: the chip says how a series ends, and a one-off event still deletes in one tap", async () => {
  const m = await mount([lecture("a", "Semester lecture"), { id: "b", title: "Old tutorial", date: addDays(TODAY, -7), repeat: "weekly", updatedAt: "2026-01-01T00:00:00.000Z" }, { id: "c", title: "Dentist", date: TODAY, repeat: "none", updatedAt: "2026-01-01T00:00:00.000Z" }]);
  assert.match(m.deleteOf("Semester lecture").querySelector("[data-repeat-chip]").textContent, /until end of semester/);
  assert.equal(m.deleteOf("Old tutorial").querySelector("[data-repeat-chip]").textContent.trim(), RECURRENCE_COPY.chipWeekly, "a legacy series changed its label");
  m.deleteOf("Dentist").querySelector("[aria-label='Delete']").click();
  const ev = await m.stored();
  assert.ok(ev.find((e) => e.id === "c").deletedAt, "a one-off event did not delete on the first tap");
  assert.deepEqual(m.complaints, []);
});

test("IN THE APP: this event only, this and all following, and all events — each writes what it says", async () => {
  const m = await mount([lecture("one", "Lecture one"), lecture("fol", "Lecture following"), lecture("all", "Lecture all"), lecture("first", "Starts today", { date: TODAY })]);
  await choose(m, "Lecture one", "one");
  await choose(m, "Lecture following", "following");
  await choose(m, "Lecture all", "all");
  await choose(m, "Starts today", "following");
  const ev = Object.fromEntries((await m.stored()).map((e) => [e.id, e]));
  assert.deepEqual(ev.one.skip, [TODAY]);
  assert.ok(!ev.one.deletedAt, "this-event-only deleted the series");
  assert.equal(ev.fol.until, addDays(TODAY, -1));
  assert.ok(!ev.fol.deletedAt);
  assert.ok(ev.all.deletedAt, "all-events did not delete the series");
  assert.ok(ev.first.deletedAt, "this-and-following on the first class left an empty series behind");
  for (const id of ["one", "fol"]) assert.ok(ev[id].updatedAt > "2026-01-01", `${id} was not stamped, so the delete would not sync`);
  assert.equal([...m.doc.querySelectorAll("h5")].filter((h) => /Lecture|Starts today/.test(h.textContent)).length, 0, "an occurrence is still on today's list");
  assert.deepEqual(m.complaints, []);
});

test("IN THE APP: ticking 'repeats weekly' on a new event defaults to the end of semester, and the three ends are offered", async () => {
  const m = await mount([]);
  m.button("Add").click();
  await settle(80);
  const box = [...m.doc.querySelectorAll("label")].find((l) => l.textContent.includes(RECURRENCE_COPY.repeatLabel)).querySelector("input");
  box.click();
  await settle(80);
  const radios = Object.fromEntries([...m.doc.querySelectorAll("[data-repeat-end]")].map((r) => [r.dataset.repeatEnd, r]));
  assert.deepEqual(Object.keys(radios).sort(), ["count", "none", "semester"]);
  assert.equal(radios.semester.checked, true, "the default is not the semester end");
  radios.count.click();
  await settle(80);
  assert.equal(m.doc.querySelector(`[aria-label='${RECURRENCE_COPY.endCountAria}']`).value, "12");
  assert.deepEqual(m.complaints, []);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || passed === 0) process.exit(1);
