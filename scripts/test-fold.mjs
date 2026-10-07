/* test-fold.mjs — the 1.3.1 fold: fewer sections, no overlaps.

   The claims, each made against the real app mounted in jsdom from a
   demo bundle, over a seeded planner:

   1. GRADES IS ONE CARD PER COURSE. A course with nothing in it still
      gets a card, assessments with no course are one "No course" card
      at the bottom, there is no separate add form or Course dropdown,
      and a card's own "Add assessment" files under that card's course.
   2. THE EXAM COUNTDOWN LIVES IN UPCOMING. An exam shows on its own
      week with the days left, even beyond Upcoming's six-week window,
      its study plan opens from that row, and Study has no Exams
      section any more.
   3. SAVED ESSAY FEEDBACK IS ITS OWN NOTES SECTION, read-only, and is
      not listed a second time among the ordinary notes.
   4. SEMESTER SETUP TAKES OTHER NON-TEACHING WEEKS, any number.
   5. "Essay feedback" is the name everywhere the old "Get feedback on a
      draft" was. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { addDays, localDay } from "../src/srs.js";
import { ESSAY_COPY } from "../src/essayCopy.js";

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

const tmp = path.join(rootDir, ".fold-tmp");
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
const EXAM_DAY = addDays(TODAY, 70); // ten weeks out: beyond the six-week window
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const SEMESTER = {
  courses: [
    { id: "c1", name: "BIOL1001", updatedAt: T },
    { id: "c2", name: "HIST1001", updatedAt: T },
    { id: "c3", name: "STAT1001", updatedAt: T }, // no assessments yet
  ],
  assessments: [
    { id: "a1", course: "BIOL1001", title: "Lab report", w: 30, kind: "assignment", due: addDays(TODAY, 10), updatedAt: T },
    { id: "a2", course: "BIOL1001", title: "Final exam", w: 50, kind: "exam", due: EXAM_DAY, updatedAt: T },
    { id: "a3", course: "HIST1001", title: "Essay 1", w: 40, kind: "assignment", mark: 72, updatedAt: T },
    { id: "a4", course: "", title: "Essay draft, 01/10/2026", kind: "assignment", essayPlaceholder: true, updatedAt: T },
  ],
  notes: [
    { id: "n1", course: "BIOL1001", week: "2", term: "Glycolysis", def: "Glucose to pyruvate", updatedAt: T },
    { id: "n2", course: "BIOL1001", week: "3", term: "Krebs cycle", def: "Acetyl-CoA oxidised", updatedAt: T },
  ],
  pages: [
    { id: "p1", title: "Lecture 3 notes", style: "lined", blocks: [{ id: "p1:t0", type: "text", html: "<p>Ordinary note</p>", body: "Ordinary note" }], html: "", body: "", strokes: [], folderId: null, updatedAt: T },
    {
      id: "p2",
      title: "Essay 1 — 01/10/2026",
      blocks: [{ id: "p2:t0", type: "text", html: "<p><b>Reads like a Credit</b></p>", body: "Reads like a Credit" }],
      html: "",
      body: "",
      strokes: [],
      folderId: null,
      essayFeedback: { assessmentId: "a3" },
      updatedAt: T,
    },
  ],
  settings: [
    {
      id: "settings",
      start: addDays(TODAY, -21),
      teachingWeeks: 12,
      breaks: [],
      extraBreaks: [
        { id: "x1", from: addDays(TODAY, 35), to: addDays(TODAY, 41) },
        { id: "x2", from: addDays(TODAY, 56), to: addDays(TODAY, 62) },
      ],
      updatedAt: T,
    },
  ],
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

test("GRADES: one card per course, the empty course included, and No course last", async () => {
  const m = await mount("courses");
  const cards = [...m.doc.querySelectorAll("[data-grades-card]")].map((c) => c.getAttribute("data-grades-card"));
  assert.deepEqual(cards, ["BIOL1001", "HIST1001", "STAT1001", "No course"]);
  const stat = m.doc.querySelector('[data-grades-card="STAT1001"]');
  assert.match(stat.textContent, /No assessments yet/, "a course with nothing in it does not say so");
  assert.ok(stat.querySelector("[data-add-assessment]"), "the empty course's card has no way to add its first assessment");
  /* The placeholder is in the No course card, with its link control. */
  const none = m.doc.querySelector('[data-grades-card="No course"]');
  assert.match(none.textContent, /Essay draft, 01\/10\/2026/);
  assert.deepEqual(m.complaints, []);
});

test("GRADES: no separate add form, and no Course dropdown anywhere in Grades", async () => {
  const m = await mount("courses");
  const cards = [...m.doc.querySelectorAll("[data-grades-card]")];
  assert.ok(cards.length >= 4);
  /* Every Add-assessment control is inside a course card. */
  const adds = [...m.doc.querySelectorAll("[data-add-assessment]")];
  assert.equal(adds.length, cards.length, "an Add assessment control sits outside the course cards");
  for (const a of adds) assert.ok(a.closest("[data-grades-card]"), "an add control outside a card");
  /* No <select> offering the courses: the old form's Course dropdown. */
  for (const sel of m.doc.querySelectorAll("select")) {
    const options = [...sel.options].map((o) => o.textContent);
    assert.ok(!(options.includes("BIOL1001") && options.includes("No course")), "a Course dropdown is still on the Courses tab");
  }
});

test("GRADES: a card's own Add assessment files the new row under that card's course", async () => {
  const m = await mount("courses");
  const card = m.doc.querySelector('[data-grades-card="STAT1001"]');
  card.querySelector("[data-add-assessment]").click();
  await settle(80);
  const form = card.querySelector("[data-add-assessment-form]");
  assert.ok(form, "the inline row did not open");
  const inputs = form.querySelectorAll("input");
  setValue(m.w, inputs[0], "Quiz 1");
  setValue(m.w, inputs[1], "10");
  await settle(50);
  [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add").click();
  const sem = await m.stored();
  const added = sem.assessments.find((a) => a.title === "Quiz 1");
  assert.ok(added, "the assessment was not saved");
  assert.equal(added.course, "STAT1001", "the new assessment is not under the card it was added from");
  assert.equal(added.w, 10);
  assert.ok(!("mark" in added), "the inline row wrote a mark");
});

test("UPCOMING: an exam ten weeks out has its own row with the days left, and its study plan opens from it", async () => {
  const m = await mount("planner");
  const h2s = [...m.doc.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.ok(h2s.includes("Upcoming"), `no Upcoming heading: ${h2s.join(", ")}`);
  assert.ok(!h2s.includes("What's coming"), "the old heading is still there");
  const days = m.doc.querySelector('[data-exam-days="a2"]');
  assert.ok(days, "the exam beyond the six-week window is not in Upcoming");
  assert.equal(days.textContent.trim(), "Exam · 70 days to go");
  const row = days.closest("li");
  assert.equal(row.getAttribute("data-upcoming-kind"), "exam");
  const toggle = row.querySelector('[data-exam-plan="a2"] button');
  assert.ok(toggle, "the exam row has no study plan control");
  toggle.click();
  await settle(80);
  const plan = row.querySelectorAll('[data-exam-plan="a2"] li');
  assert.ok(plan.length > 0, "the study plan did not open from the exam row");
  assert.match(row.textContent, /Glycolysis|Krebs cycle/, "the plan is not built from the course's study cards");
});

test("STUDY: the separate exam countdown section is gone", async () => {
  const m = await mount("study");
  const h2s = [...m.doc.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.ok(h2s.includes("Study cards"), `the Study tab did not render: ${h2s.join(", ")}`);
  assert.ok(!h2s.includes("Exams"), "Study still has an Exams section");
});

test("NOTES: saved essay feedback is its own section, read-only, and not listed twice", async () => {
  const m = await mount("notes");
  const list = m.doc.querySelector("[data-essay-feedback-notes]");
  assert.ok(list, "no Essay feedback section on the Notes tab");
  const h2s = [...m.doc.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.ok(h2s.includes(ESSAY_COPY.notesSection));
  const rows = [...m.doc.querySelectorAll("[data-note-row]")].map((r) => r.getAttribute("data-note-row"));
  assert.equal(rows.filter((id) => id === "p2").length, 1, "the essay result is listed more than once");
  assert.ok(list.querySelector('[data-note-row="p2"]'), "the essay result is not in its section");
  assert.ok(!list.querySelector('[data-note-row="p1"]'), "an ordinary note is in the Essay feedback section");
  /* Read-only: expanding it offers no Edit. The ordinary note does,
     which is the control that keeps this from passing on a viewer
     that has lost its Edit button everywhere. */
  const editIn = async (id) => {
    const row = m.doc.querySelector(`[data-note-row="${id}"]`);
    row.querySelector('[aria-label="Expand note"]').click();
    await settle(80);
    return [...m.doc.querySelector(`[data-note-row="${id}"]`).querySelectorAll("button")].some((b) => b.textContent.trim() === "Edit");
  };
  assert.equal(await editIn("p2"), false, "a saved essay result can be edited");
  assert.equal(await editIn("p1"), true, "the control failed: an ordinary note offers no Edit either");
});

test("SEMESTER SETUP: two other non-teaching ranges show, and another can be added", async () => {
  const m = await mount("courses");
  const box = m.doc.querySelector("[data-extra-breaks]");
  assert.ok(box, "no Other non-teaching weeks field");
  assert.equal(box.querySelectorAll("[data-extra-break]").length, 2);
  [...box.querySelectorAll("button")].find((b) => /Add non-teaching weeks/.test(b.textContent)).click();
  const sem = await m.stored();
  assert.equal(sem.settings[0].extraBreaks.length, 3, "Add did not add a range");
  assert.deepEqual(sem.settings[0].breaks, [], "adding a range touched the mid-semester break");
});

test('NAMING: "Essay feedback" replaces "Get feedback on a draft" everywhere it was', () => {
  assert.equal(ESSAY_COPY.rowAction, "Essay feedback");
  assert.equal(ESSAY_COPY.entry.title, "Essay feedback");
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  for (const f of ["src/essayCopy.js", "src/essayPanel.jsx", "src/PlannerApp.jsx", "src/aiNotes.jsx"]) {
    assert.doesNotMatch(strip(fs.readFileSync(path.join(rootDir, f), "utf8")), /Get feedback on a draft|Feedback on a draft/, `${f} still says the old name`);
  }
});


/* ---------------- 1.3.1 item 10: the Courses list folds into Grades ---------------- */

const live = (list) => (list || []).filter((x) => !x.deletedAt);

test("COURSES IN GRADES: no separate Courses section; an Add a course card comes last", async () => {
  const m = await mount("courses");
  const headings = [...m.doc.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.ok(!headings.includes("Courses"), "the Courses section is still there");
  assert.ok(headings.includes("Grades") && headings.includes("Semester setup"));
  const grades = [...m.doc.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Grades").closest("section");
  const cards = [...grades.querySelectorAll("[data-grades-card], [data-add-course]")];
  assert.ok(cards[cards.length - 1].hasAttribute("data-add-course"), "Add a course is not the last card");
});

test("COURSES IN GRADES: adding a course makes its card; the same name in another case is refused", async () => {
  const m = await mount("courses");
  const box = m.doc.querySelector("[data-add-course]");
  const input = box.querySelector("input");
  setValue(m.w, input, "biol1001");
  await settle(50);
  assert.match(box.textContent, /already have a course called biol1001/);
  assert.ok(box.querySelector("button").disabled, "a duplicate course can still be added");
  setValue(m.w, input, "CHEM1001");
  await settle(50);
  box.querySelector("button").click();
  await settle(150);
  assert.ok(m.doc.querySelector('[data-grades-card="CHEM1001"]'), "the new course has no card");
  const sem = await m.stored();
  assert.ok(live(sem.courses).some((c) => c.name === "CHEM1001"));
});

test("COURSES IN GRADES: rename on the card renames the course everywhere it is written", async () => {
  const m = await mount("courses");
  m.doc.querySelector('[aria-label="Rename BIOL1001"]').click();
  await settle(50);
  const box = m.doc.querySelector("[data-course-rename]");
  setValue(m.w, box.querySelector("input"), "BIOL1002");
  await settle(30);
  [...box.querySelectorAll("button")].find((b) => /Save/.test(b.textContent)).click();
  await settle(150);
  assert.ok(m.doc.querySelector('[data-grades-card="BIOL1002"]'), "the card did not take the new name");
  assert.ok(!m.doc.querySelector('[data-grades-card="BIOL1001"]'), "the old name still has a card");
  const sem = await m.stored();
  assert.deepEqual(live(sem.courses).map((c) => c.name).sort(), ["BIOL1002", "HIST1001", "STAT1001"]);
  assert.deepEqual(live(sem.assessments).filter((a) => a.course === "BIOL1002").map((a) => a.id).sort(), ["a1", "a2"]);
  assert.deepEqual(live(sem.notes).map((n) => n.course), ["BIOL1002", "BIOL1002"], "the study cards kept the old name");
});

test("COURSES IN GRADES: a rename onto another course's name is refused on the card, and nothing changes", async () => {
  const m = await mount("courses");
  m.doc.querySelector('[aria-label="Rename BIOL1001"]').click();
  await settle(50);
  const box = m.doc.querySelector("[data-course-rename]");
  setValue(m.w, box.querySelector("input"), "hist1001");
  await settle(30);
  [...box.querySelectorAll("button")].find((b) => /Save/.test(b.textContent)).click();
  await settle(150);
  assert.match(m.doc.querySelector("[data-course-rename]").textContent, /already have a course called hist1001/);
  const sem = await m.stored();
  assert.deepEqual(live(sem.assessments).filter((a) => a.course === "BIOL1001").length, 2);
});

test("COURSES IN GRADES: remove says what goes, and takes the card's assessments with the course — tombstoned, not dropped", async () => {
  const m = await mount("courses");
  m.doc.querySelector('[aria-label="Remove BIOL1001"]').click();
  await settle(50);
  const box = m.doc.querySelector("[data-course-remove]");
  assert.match(box.textContent, /Remove BIOL1001 and its 2 assessments from Grades\?/);
  assert.match(box.textContent, /keep the tag/);
  box.querySelector("[data-course-remove-confirm]").click();
  await settle(150);
  assert.ok(!m.doc.querySelector('[data-grades-card="BIOL1001"]'), "the card is still there");
  const sem = await m.stored();
  const dead = sem.assessments.filter((a) => a.course === "BIOL1001");
  assert.equal(dead.length, 2, "the assessments were dropped rather than tombstoned");
  assert.ok(dead.every((a) => a.deletedAt), "the card's assessments survived the course");
  assert.ok(sem.courses.find((c) => c.name === "BIOL1001").deletedAt);
  /* Everything else tagged BIOL1001 keeps the tag. */
  assert.deepEqual(live(sem.notes).map((n) => n.course), ["BIOL1001", "BIOL1001"]);
});

test("COURSES IN GRADES: assessments under a course that isn't in the list get a card that can add it back", async () => {
  const sem0 = { ...SEMESTER, assessments: [...SEMESTER.assessments, { id: "a9", course: "CHEM9999", title: "Lab", w: 20, kind: "assignment", updatedAt: T }] };
  const m = await mount("courses", sem0);
  const card = m.doc.querySelector('[data-grades-card="CHEM9999"]');
  assert.match(card.textContent, /Not in your courses/);
  [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add to courses").click();
  await settle(150);
  const sem = await m.stored();
  assert.ok(live(sem.courses).some((c) => c.name === "CHEM9999"));
  assert.doesNotMatch(m.doc.querySelector('[data-grades-card="CHEM9999"]').textContent, /Not in your courses/);
});

test("COURSES IN GRADES: the course tag on a card still highlights it across the app", async () => {
  const m = await mount("courses");
  const tag = m.doc.querySelector('[aria-label="Highlight HIST1001 across the app"]');
  assert.ok(tag, "the highlight control went with the Courses section");
  tag.click();
  await settle(100);
  assert.match(m.doc.body.textContent, /Highlighting|HIST1001/);
  assert.ok(!m.doc.querySelector('[data-grades-card="BIOL1001"]'), "highlighting did not narrow Grades to the course");
  assert.equal(m.doc.querySelector('[aria-label="Highlight HIST1001 across the app"]').getAttribute("aria-pressed"), "true");
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
