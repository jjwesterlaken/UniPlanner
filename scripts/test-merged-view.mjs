/* test-merged-view.mjs — 1.3.1 item 9 RELEASE A and item 13.

   9A. Plan and Grades READ one merged view of assignments and
       assessments; nothing is converted, merged or re-stamped:
       - an unlinked look-alike pair shows as TWO rows on BOTH screens;
       - a linked pair (assessment.assignmentId) is one row on each;
       - essay-feedback ids and step parentIds are untouched;
       - a 1.3.0-shaped planner round-trips byte-for-byte.
   13. The Calendar shows Grades' dates read-only, "From Grades"; the add
       form says where exams go, and an exam-like title gets a pointer
       that never blocks the save. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { addDays, localDay } from "../src/srs.js";
import { linkedAssessments, gradesRecordsForPlan, planRecordsForGrades, gradesDatesOn, looksLikeAssessment } from "../src/assessmentRecords.js";

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

const tmp = path.join(rootDir, ".merged-tmp");
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

const TODAY = localDay(new Date());
const T = "2026-01-01T00:00:00.000Z";
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/* A 1.3.0-SHAPED SEMESTER: only fields 1.3.0 wrote. */
const SEMESTER = {
  courses: [
    { id: "c1", name: "HIST1001", updatedAt: T },
    { id: "c2", name: "BIOL1001", updatedAt: T },
  ],
  assignments: [
    { id: "as1", course: "HIST1001", title: "Essay 1", due: TODAY, requirements: "2000 words", notes: "", updatedAt: T },
    { id: "as2", course: "BIOL1001", title: "Lab report", due: addDays(TODAY, 9), requirements: "", notes: "", updatedAt: T },
    { id: "as3", course: "HIST1001", title: "Reading log", due: "", requirements: "", notes: "", updatedAt: T },
  ],
  assessments: [
    { id: "s1", course: "HIST1001", title: "Essay 1", w: 40, kind: "assignment", due: TODAY, updatedAt: T },
    { id: "s2", course: "BIOL1001", title: "Lab report", w: 30, kind: "assignment", due: addDays(TODAY, 9), mark: 68, assignmentId: "as2", updatedAt: T },
    { id: "s3", course: "HIST1001", title: "Final exam", w: 60, kind: "exam", due: addDays(TODAY, 40), updatedAt: T },
    { id: "s4", course: "", title: "Essay draft, 01/10/2026", kind: "assignment", essayPlaceholder: true, updatedAt: T },
  ],
  todos: [{ id: "t1", text: "Essay 1: Outline", done: false, parentId: "as1", gen: "essay", slot: 0, due: TODAY, updatedAt: T }],
  pages: [
    { id: "p1", title: "Essay 1 — 01/10/2026", essayFeedback: { assessmentId: "s1" }, blocks: [{ id: "p1:t0", type: "text", html: "<p>Reads like a Credit</p>", body: "Reads like a Credit" }], html: "", body: "", strokes: [], folderId: null, updatedAt: T },
  ],
  events: [],
};

async function mount(tab, semester = SEMESTER) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: "outside-only", url: "https://example.test/", pretendToBeVisual: true });
  const w = dom.window;
  const complaints = [];
  w.console.error = (...a) => complaints.push(a.join(" "));
  w.localStorage.setItem("uni-planner-v1", JSON.stringify({ semester: "Semester 1", semesters: { "Semester 1": semester }, meta: { updatedAt: T } }));
  w.localStorage.setItem("uni-planner-tab", tab);
  w.eval(JS);
  await settle(400);
  const doc = w.document;
  const buttons = (label) => [...doc.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === label);
  const stored = async () => {
    await settle(1500);
    return JSON.parse(w.localStorage.getItem("uni-planner-v1")).semesters["Semester 1"];
  };
  const section = (title) => [...doc.querySelectorAll("section, div")].find((el) => el.querySelector(":scope > div h2, :scope > header h2, :scope h2") && [...el.querySelectorAll("h2")].some((h) => h.textContent.trim() === title));
  return { w, doc, buttons, stored, section, complaints };
}

const setValue = (w, el, value) => {
  const proto = el.tagName === "SELECT" ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new w.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};

const KEEP = ["courses", "assignments", "assessments", "todos", "pages", "events"];
const snapshot = (sem) => JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, sem[k]])));
const planRow = (m, id) => m.doc.querySelector(`[data-plan-record="${id}"]`) || m.doc.querySelector(`[data-assignment-row="${id}"]`);

test("THE MODULE: the linked pair is one record; the look-alike pair stays two; the placeholder never shows in Plan", () => {
  const L = linkedAssessments(SEMESTER.assignments, SEMESTER.assessments);
  assert.deepEqual([...L.keys()], ["as2"]);
  assert.deepEqual(gradesRecordsForPlan(SEMESTER.assignments, SEMESTER.assessments).map((s) => s.id), ["s1", "s3"]);
  assert.deepEqual([...planRecordsForGrades(SEMESTER.assignments, SEMESTER.assessments).entries()].map(([k, v]) => [k, v.map((a) => a.id)]), [["HIST1001", ["as1", "as3"]]]);
  assert.deepEqual(gradesDatesOn(SEMESTER.assessments, TODAY).map((s) => s.id), ["s1"]);
  /* A tombstoned link is no link: the assessment shows on its own. */
  const dead = SEMESTER.assignments.map((a) => (a.id === "as2" ? { ...a, deletedAt: T } : a));
  assert.ok(gradesRecordsForPlan(dead, SEMESTER.assessments).some((s) => s.id === "s2"));
});

test("EXAM-LIKE TITLES are recognised by whole word, and nothing else is", () => {
  for (const t of ["Final exam", "Week 5 quiz", "Mid-sem test", "PSYC finals", "Exam review session"]) assert.ok(looksLikeAssessment(t), t);
  for (const t of ["Tutorial", "Examine the lab", "Testimony reading", "Group meeting", ""]) assert.ok(!looksLikeAssessment(t), t);
});

test("PLAN: the look-alike pair is TWO rows, the Grades one labelled; the linked pair is ONE row carrying its weight and mark", async () => {
  const m = await mount("planner");
  assert.ok(m.doc.querySelector('[data-assignment-row="as1"]'), "the Plan assignment is missing");
  const g = m.doc.querySelector('[data-plan-record="s1"][data-from-grades]');
  assert.ok(g, "the Grades record of the same essay is not shown in Plan");
  assert.match(g.textContent, /In Grades · 40%/);
  assert.ok(!m.doc.querySelector('[data-plan-record="s2"]'), "the linked assessment is shown twice in Plan");
  assert.match(m.doc.querySelector('[data-assignment-row="as2"]').textContent, /In Grades · 30% · marked 68/);
  assert.ok(m.doc.querySelector('[data-plan-record="s3"]'), "the dated exam from Grades is missing in Plan");
  assert.ok(!m.doc.querySelector('[data-plan-record="s4"]'), "an essay-draft placeholder is listed in Plan");
  assert.deepEqual(m.complaints, []);
});

test("GRADES: the same look-alike pair is TWO rows on the course card — the Plan one listed apart and never counted", async () => {
  const m = await mount("courses");
  const hist = m.doc.querySelector('[data-grades-card="HIST1001"]');
  assert.ok(hist.querySelector('[data-assessment-row="s1"]'));
  const planOnly = hist.querySelector("[data-plan-only]");
  assert.ok(planOnly, "the Plan assignments are not listed on their course card");
  assert.ok(planOnly.querySelector('[data-plan-record="as1"]') && planOnly.querySelector('[data-plan-record="as3"]'));
  /* Not counted: the card's arithmetic is the two weighted rows only. */
  assert.match(hist.textContent, /Nothing marked yet/);
  const biol = m.doc.querySelector('[data-grades-card="BIOL1001"]');
  assert.ok(!biol.querySelector("[data-plan-only]"), "the linked assignment is listed again in Grades");
});

test("NOTHING IS WRITTEN: a 1.3.0-shaped planner round-trips unchanged through both screens and the calendar", async () => {
  const before = snapshot(SEMESTER);
  for (const tab of ["planner", "courses", "calendar"]) {
    const m = await mount(tab);
    const sem = await m.stored();
    assert.equal(snapshot(sem), before, `the ${tab} tab rewrote stored records`);
    /* The two links the plan names, explicitly. */
    assert.equal(sem.pages[0].essayFeedback.assessmentId, "s1");
    assert.equal(sem.todos[0].parentId, "as1");
  }
});

test("THE CONTROL: the same snapshot DOES see a write, so 'unchanged' above is a finding and not a blind spot", async () => {
  const m = await mount("todo");
  m.doc.querySelector('[aria-label="Mark done"]').click();
  const sem = await m.stored();
  assert.notEqual(snapshot(sem), snapshot(SEMESTER), "ticking a to-do left the snapshot unchanged, so the round-trip test proves nothing");
});

test("THE LINKS ACROSS: Open in Grades from Plan lands on the row; Open in Plan from Grades lands on the assignment", async () => {
  const m = await mount("planner");
  m.doc.querySelector('[data-plan-record="s1"] [data-open-grades]').click();
  await settle(200);
  assert.equal(m.w.localStorage.getItem("uni-planner-tab"), "courses");
  assert.ok(m.doc.querySelector('[data-assessment-row="s1"]'));
  m.doc.querySelector('[data-plan-record="as1"] [data-open-plan]').click();
  await settle(200);
  assert.equal(m.w.localStorage.getItem("uni-planner-tab"), "planner");
  assert.ok(m.doc.querySelector('[data-assignment-row="as1"]'));
});

test("CALENDAR: today's Grades date shows read-only, From Grades, and opens Grades", async () => {
  const m = await mount("calendar");
  const row = m.doc.querySelector('[data-from-grades="s1"]');
  assert.ok(row, "the Grades date is not on the calendar");
  assert.match(row.textContent, /From Grades · 40%/);
  assert.ok(!row.querySelector('[aria-label="Delete"]'), "a Grades date can be deleted from the calendar");
  assert.ok(!m.doc.querySelector('[data-from-grades="s4"]'), "a placeholder appeared on the calendar");
  row.querySelector("[data-open-grades]").click();
  await settle(200);
  assert.equal(m.w.localStorage.getItem("uni-planner-tab"), "courses");
});

test("CALENDAR: the add form says where exams go; an exam-like title gets a pointer and STILL SAVES", async () => {
  const m = await mount("calendar");
  m.buttons("Add")[0].click();
  await settle(80);
  assert.ok(m.doc.querySelector("[data-calendar-line]"), "the add form does not say where exams go");
  const title = [...m.doc.querySelectorAll("input")].find((i) => /Statistics lecture/.test(i.placeholder || ""));
  setValue(m.w, title, "Exam review session");
  await settle(80);
  assert.ok(m.doc.querySelector("[data-exam-pointer]"), "an exam-like title got no pointer");
  const save = m.buttons("Add to calendar")[0];
  assert.ok(save && !save.disabled, "the pointer blocked the save");
  save.click();
  const sem = await m.stored();
  assert.deepEqual(sem.events.map((e) => e.title), ["Exam review session"], "the event was not saved");
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
