/* test-labels.mjs — 1.3.1 items 11 and 12, against the real app.

   11. THE TWO "PRACTICE" FEATURES ARE DISTINCT. The study-cards mode
       that ignores the schedule is "Drill"; "Practice questions" (the AI
       feature) keeps its name. Nothing in the Study cards section says
       "Practice" any more, and the AI section still does — both halves,
       or a rename that hit both would pass.
   12. A "BREAK INTO STEPS" TASK SAYS WHERE IT CAME FROM, on the task in
       To-do, as a link that opens that assignment with its steps shown.
       A step whose assignment was deleted says so; a task the student
       typed says nothing. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { addDays, localDay } from "../src/srs.js";

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

const tmp = path.join(rootDir, ".labels-tmp");
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

const SEMESTER = {
  courses: [{ id: "c1", name: "BIOL1001", updatedAt: T }],
  assignments: [
    { id: "as1", course: "BIOL1001", title: "Essay 1", due: addDays(TODAY, 20), updatedAt: T },
    { id: "as2", course: "BIOL1001", title: "Old report", due: addDays(TODAY, 9), deletedAt: T, updatedAt: T },
  ],
  todos: [
    { id: "t1", text: "Essay 1: Outline the argument", done: false, parentId: "as1", gen: "essay", slot: 0, due: addDays(TODAY, 3), updatedAt: T },
    { id: "t2", text: "Old report: Draft", done: false, parentId: "as2", gen: "essay", slot: 0, due: addDays(TODAY, 4), updatedAt: T },
    { id: "t3", text: "Buy printer ink", done: false, updatedAt: T },
    { id: "t4", text: "My own wording for this step", done: false, parentId: "as1", gen: "essay", slot: 1, edited: true, due: addDays(TODAY, 5), updatedAt: T },
    { id: "t5", text: "Essay 1: Find three sources", done: true, parentId: "as1", gen: "essay", slot: 2, edited: true, due: addDays(TODAY, 1), updatedAt: T },
  ],
  notes: [
    { id: "n1", course: "BIOL1001", week: "2", term: "Glycolysis", def: "Glucose to pyruvate", updatedAt: T },
    { id: "n2", course: "BIOL1001", week: "3", term: "Krebs cycle", def: "Acetyl-CoA oxidised", updatedAt: T },
  ],
};

async function mount(tab) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: "outside-only", url: "https://example.test/", pretendToBeVisual: true });
  const w = dom.window;
  const complaints = [];
  w.console.error = (...a) => complaints.push(a.join(" "));
  w.localStorage.setItem("uni-planner-v1", JSON.stringify({ semester: "Semester 1", semesters: { "Semester 1": SEMESTER }, meta: { updatedAt: T } }));
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

/* The <section> that OWNS the heading, not any ancestor that contains it. */
const own = (m, title) => {
  const h = [...m.doc.querySelectorAll("h2")].find((x) => x.textContent.trim() === title);
  return h ? h.closest("section") : null;
};
const rowOf = (m, text) => [...m.doc.querySelectorAll("li")].find((li) => li.textContent.includes(text));

test("DRILL: the Study cards section says Drill and never Practice; Practice questions keeps its name", async () => {
  const m = await mount("study");
  const cards = own(m, "Study cards");
  assert.ok(cards, "no Study cards section");
  assert.match(cards.textContent, /drill one course/i);
  assert.doesNotMatch(cards.textContent, /\bPractice\b/, "the Study cards section still says Practice");
  assert.ok(own(m, "Practice questions"), "the AI Practice questions section lost its name");
  assert.deepEqual(m.complaints, []);
});

test("DRILL: starting a course drill reads 'Drill · N to go', and finishing it offers 'Drill again'", async () => {
  const m = await mount("study");
  const cards = own(m, "Study cards");
  [...cards.querySelectorAll("button")].find((b) => /BIOL1001/.test(b.textContent)).click();
  await settle(100);
  assert.match(own(m, "Study cards").textContent, /Drill · 2 to go/);
  for (let i = 0; i < 2; i++) {
    const reveal = [...m.doc.querySelectorAll("button")].find((b) => /Show answer|Reveal/i.test(b.textContent));
    if (reveal) reveal.click();
    await settle(50);
    [...m.doc.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Good")).click();
    await settle(50);
  }
  const done = own(m, "Study cards").textContent;
  assert.match(done, /Drill done/);
  assert.ok(m.buttons("Drill again").length === 1, "no Drill again button");
  assert.doesNotMatch(done, /\bPractice\b/);
});

test("STEPS: a generated step says which assignment it came from, and drops the repeated title from its text", async () => {
  const m = await mount("todo");
  const row = rowOf(m, "Outline the argument");
  assert.ok(row, "the step is not in To-do");
  const src = row.querySelector('[data-step-source="as1"]');
  assert.ok(src, "the step does not say where it came from");
  assert.equal(src.textContent.trim(), "From Essay 1 →");
  assert.doesNotMatch(row.textContent, /Essay 1: Outline/, "the title is shown twice");
  /* The CONTROL: a step the student reworded shows exactly what is stored, with its source. */
  const own = rowOf(m, "My own wording for this step");
  assert.ok(own.querySelector('[data-step-source="as1"]'));
  /* A ticked step's text is struck through; its source link is not. */
  const ticked = rowOf(m, "Find three sources");
  assert.ok(ticked.querySelector(".line-through"), "the control failed: the ticked step is not struck through at all");
  assert.equal(ticked.querySelector('[data-step-source="as1"]').closest(".line-through"), null, "the source link is crossed out with the step");
});

test("STEPS: a step from a deleted assignment says so, and a task the student typed says nothing", async () => {
  const m = await mount("todo");
  const orphan = rowOf(m, "Old report: Draft");
  assert.ok(orphan, "a step outlived its assignment's deletion and vanished");
  assert.match(orphan.textContent, /From an assignment you deleted/);
  assert.equal(orphan.querySelector("button[data-step-source]"), null, "a deleted assignment is offered as a link");
  const mine = rowOf(m, "Buy printer ink");
  assert.equal(mine.querySelector("[data-step-source]"), null, "a typed task claims a source");
});

test("STEPS: the link opens Plan at that assignment with its steps showing", async () => {
  const m = await mount("todo");
  rowOf(m, "Outline the argument").querySelector('[data-step-source="as1"]').click();
  await settle(200);
  const assignment = m.doc.querySelector('[data-assignment-row="as1"]');
  assert.ok(assignment, "the link did not open the assignment");
  assert.match(assignment.textContent, /Outline the argument/, "the assignment opened with its steps hidden");
  assert.match(assignment.textContent, /Regenerate steps/);
  assert.doesNotMatch(assignment.textContent, /Essay 1: Outline/, "the steps under the assignment repeat its title");
  assert.equal(m.w.localStorage.getItem("uni-planner-tab"), "planner");
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
