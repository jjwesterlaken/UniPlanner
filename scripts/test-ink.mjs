/* Tests for src/ink.js — how a stroke is stored.

   Two claims matter more than the rest:

     "rounding is idempotent"       — it runs on every load, so a second
                                      pass must be a no-op or the app
                                      rewrites notes forever
     "the migration does not bump updatedAt" — a lossless representation
                                      change is not an edit, and if it
                                      looked like one, two devices would
                                      fight through last-write-wins
                                      forever over a change nobody can
                                      see

   The second is guarded here AND by a merge-stability test in
   test-ai-notes.mjs, because it depends on mergeList breaking ties with
   strictly-greater. Neither test is sufficient alone. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRID, PRESSURE_DP, roundPoint, roundStroke, isRounded, migrateStrokes, migratePages } from "../src/ink.js";
import { mergeData } from "../src/sync.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const raw = (n = 20) =>
  Array.from({ length: n }, (_, i) => [
    123.45678901234567 + i * 0.7654321,
    456.78901234567 + i * 1.2345678,
    0.4567890123 + (i % 5) * 0.0123456,
  ]);

const stroke = (n) => ({ color: "#1c1917", width: 3, erase: false, points: raw(n) });

console.log("\nink storage");

/* ---------- the grid ---------- */

test("a coordinate is kept to a tenth of a canvas unit", () => {
  const [x, y] = roundPoint(123.45678901234567, 456.78901234567, 0.5);
  assert.equal(x, 123.5);
  assert.equal(y, 456.8);
});

test("the grid is a TENTH of a unit, not a whole one", () => {
  /* Whole units would be visible. The canvas backing store is
     CANVAS_W * devicePixelRatio with the ratio capped at 3, so one
     canvas unit is three physical pixels on a 3x display -- exactly the
     hardware handwriting is done on. */
  assert.equal(GRID, 10);
  assert.notEqual(roundPoint(1.4, 0, 0.5)[0], roundPoint(1.6, 0, 0.5)[0]);
});

test("pressure keeps two decimal places, which is below what the line can show", () => {
  /* lineWidth = max(0.5, width * (0.4 + pressure * 1.6)). At width 3 the
     whole range spans 1.2px to 6px, so one step of 1/100 moves the line
     by 0.048px. */
  assert.equal(PRESSURE_DP, 100);
  assert.equal(roundPoint(0, 0, 0.4567890123)[2], 0.46);
});

test("a missing pressure reads as the neutral half, not as zero", () => {
  // Zero would render a hairline where a mouse drew a normal stroke.
  assert.equal(roundPoint(0, 0, undefined)[2], 0.5);
  assert.equal(roundPoint(0, 0, null)[2], 0.5);
});

/* ---------- idempotence, which is what makes it safe on every load ---------- */

test("rounding is idempotent", () => {
  const once = roundStroke(stroke(30));
  const twice = roundStroke(once);
  assert.deepEqual(twice, once);
  assert.equal(isRounded(once), true);
});

test("an already-rounded page is returned UNCHANGED, by reference", () => {
  /* Not an optimisation. It is how the caller tells "I rewrote this"
     from "I didn't", so a load that changes nothing writes nothing --
     which is what stops the app rewriting every note on every start. */
  const page = { id: "p1", strokes: [roundStroke(stroke(5))], updatedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(migrateStrokes(page), page);
  const pages = [page];
  assert.equal(migratePages(pages), pages);
});

test("a page with no ink is left completely alone", () => {
  const typed = { id: "p2", html: "<p>hello</p>", strokes: [] };
  assert.equal(migrateStrokes(typed), typed, "an empty strokes array was rewritten");
  const noStrokes = { id: "p3", html: "<p>hi</p>" };
  assert.equal(migrateStrokes(noStrokes), noStrokes, "a page with no strokes key was rewritten");
  assert.equal(migrateStrokes(null), null);
});

/* ---------- the rule the whole migration rests on ---------- */

test("the migration does not bump updatedAt", () => {
  /* THE LOAD-BEARING ONE. A lossless representation change is not an
     edit. If it looked like one, two devices each opening the app would
     rewrite the same notes, each rewrite would look newer than the
     other's, and they would fight through last-write-wins forever --
     over a change that alters nothing anyone can see. */
  const when = "2026-08-01T00:00:00.000Z";
  const page = { id: "p1", strokes: [stroke(10)], updatedAt: when };
  const out = migratePages([page])[0];
  assert.notDeepEqual(out.strokes, page.strokes, "nothing was rounded, so this test proves nothing");
  assert.equal(out.updatedAt, when, "the migration bumped updatedAt");
});

test("a rounded note merges against an unrounded copy without either side winning", () => {
  /* The migration is only safe because mergeList breaks ties with
     `t2 > t1`, STRICTLY greater -- so equal timestamps keep the existing
     item and the merge is stable. Two devices that each round the same
     note must settle, not ping-pong. */
  const when = "2026-08-01T00:00:00.000Z";
  const unrounded = { id: "p1", strokes: [stroke(10)], updatedAt: when };
  const rounded = migratePages([unrounded])[0];

  const blob = (pages) => ({
    semester: "Semester 1",
    semesters: { "Semester 1": { pages } },
    meta: { updatedAt: when },
  });

  const a = mergeData(blob([rounded]), blob([unrounded]));
  const b = mergeData(blob([unrounded]), blob([rounded]));
  assert.equal(a.semesters["Semester 1"].pages.length, 1, "the note was duplicated rather than merged");
  assert.equal(b.semesters["Semester 1"].pages.length, 1);
  // Whichever side is kept, merging again changes nothing.
  const settled = mergeData(a, b);
  assert.deepEqual(mergeData(settled, settled), settled, "the merge does not settle");
});

/* ---------- what it actually saves ---------- */

test("rounding takes a realistic page well under half its size", () => {
  /* The floor, not an estimate: this removes float digits, which are
     waste regardless of how anyone writes. Synthetic strokes measured
     66%; asserting 50% leaves room for real handwriting to be less
     compressible without turning this into a brittle benchmark. */
  const page = { id: "p1", strokes: Array.from({ length: 50 }, () => stroke(24)) };
  const before = JSON.stringify(page).length;
  const after = JSON.stringify(migrateStrokes(page)).length;
  assert.ok(after < before * 0.5, `only ${Math.round((1 - after / before) * 100)}% smaller`);
});

test("what a stroke costs is bounded per point", () => {
  // A guard against a future representation change quietly inflating.
  const s = roundStroke(stroke(24));
  assert.ok(JSON.stringify(s).length / s.points.length < 24, "a point costs more than 24 bytes");
});

/* ---------- the drawing code rounds at capture, not only on load ---------- */

test("new strokes are rounded when drawn, not left for the migration", () => {
  /* Otherwise every stroke arrives at full float precision and the
     migration is forever cleaning up after the drawing code -- which
     also means the first load after every drawing session rewrites the
     note. Asserted from the source: the pointer handlers are not
     reachable from Node. */
  const src = fsReadPlanner();
  assert.match(src, /points: \[roundPoint\(/, "the first point of a stroke is not rounded at capture");
  assert.match(src, /points\.push\(roundPoint\(/, "points added mid-stroke are not rounded at capture");
  assert.match(src, /Math\.round\(x \* GRID\) \/ GRID/, "toCanvas no longer snaps to the grid");
});

function fsReadPlanner() {
  return fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
