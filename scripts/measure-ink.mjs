/* Read-only instrument: what handwriting costs, and what it could cost.
 *
 * WHY THIS EXISTS: a stroke currently serialises to ~1.7KB, so a
 * 200-stroke page is ~336KB -- a third of the entire 1MB blob budget in
 * ONE note. That is a live problem today, not a consequence of the
 * planned unified note: anyone taking handwritten notes on an iPad right
 * now is heading toward breaking their own sync with nothing warning
 * them.
 *
 * The cause is visible in PlannerApp.jsx: a point is
 *
 *     [((e.clientX - rect.left) / rect.width) * CANVAS_W, ...]
 *
 * an unrounded division, so it serialises with full float precision --
 * "123.45678901234567" -- for a coordinate on a 1000-unit-wide canvas
 * where anything past the decimal point is invisible.
 *
 * USAGE
 *   node scripts/measure-ink.mjs                 # priced on synthetic strokes
 *   node scripts/measure-ink.mjs <backup.json>   # the real thing
 *
 * The backup is the file the Account tab's "Back up my planner" button
 * produces. Nothing is uploaded, nothing is written; this only reads.
 */

import fs from "node:fs";

const CANVAS_W = 1000;
const CANVAS_H = 1400;
const bytes = (v) => JSON.stringify(v).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/* ---------- the candidate encodings ---------- */

/** Round coordinates to whole canvas units and pressure to 2dp. */
const rounded = (stroke) => ({
  ...stroke,
  points: stroke.points.map(([x, y, p]) => [Math.round(x), Math.round(y), Math.round((p ?? 0.5) * 100) / 100]),
});

/** Drop points that sit (nearly) on the line between their neighbours. */
function simplified(stroke, tolerance = 0.8) {
  const pts = stroke.points;
  if (pts.length < 3) return stroke;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = out[out.length - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    // Perpendicular distance of the middle point from the chord.
    const dx = x2 - x0;
    const dy = y2 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const dist = Math.abs(dy * x1 - dx * y1 + x2 * y0 - y2 * x0) / len;
    if (dist > tolerance) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return { ...stroke, points: out };
}

/**
 * Delta-encode along the stroke: first point absolute, the rest offsets.
 *
 * Handwriting samples densely, so consecutive offsets are single digits
 * where absolute coordinates are three or four -- which is most of the
 * remaining size once rounding has done its work.
 */
function delta(stroke) {
  const pts = stroke.points;
  if (pts.length === 0) return { ...stroke, points: [], d: [] };
  const [x0, y0, p0] = pts[0];
  const d = [];
  let px = x0;
  let py = y0;
  let pp = Math.round((p0 ?? 0.5) * 100);
  for (let i = 1; i < pts.length; i++) {
    const [x, y, p] = pts[i];
    const pi = Math.round((p ?? 0.5) * 100);
    d.push(x - px, y - py, pi - pp);
    px = x;
    py = y;
    pp = pi;
  }
  return { color: stroke.color, width: stroke.width, erase: stroke.erase, o: [x0, y0, pp], d };
}

const encode = (s) => delta(simplified(rounded(s)));

/* ---------- sample data, when there is no real export ---------- */

/* A handwriting stroke is a letter or part of one: short, curved, and
   sampled at pointer-event rate. Coordinates carry the float noise the
   real capture produces, because that noise IS the cost being measured --
   synthetic integer points would flatter the "before" number. */
function syntheticStroke(points = 24) {
  const x0 = Math.random() * CANVAS_W;
  const y0 = Math.random() * CANVAS_H;
  return {
    color: "#1c1917",
    width: 3,
    points: Array.from({ length: points }, (_, i) => [
      x0 + Math.sin(i / 3) * 12 + i * 1.7 + Math.random() * 0.4,
      y0 + Math.cos(i / 4) * 9 + Math.random() * 0.4,
      0.4 + Math.random() * 0.3,
    ]),
  };
}

/* ---------- reading a real export ---------- */

function strokesFromBackup(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const found = [];
  for (const sem of Object.values(data.semesters || {})) {
    for (const page of (sem && sem.pages) || []) {
      const s = (page && page.strokes) || [];
      if (s.length) found.push({ title: page.title || "(untitled)", strokes: s });
    }
  }
  return found;
}

/* ---------- report ---------- */

function report(label, strokes) {
  const before = bytes(strokes);
  const afterRound = bytes(strokes.map(rounded));
  const afterSimplify = bytes(strokes.map((s) => simplified(rounded(s))));
  const afterDelta = bytes(strokes.map(encode));
  const pts = strokes.reduce((n, s) => n + s.points.length, 0);
  const keptPts = strokes.map((s) => simplified(rounded(s))).reduce((n, s) => n + s.points.length, 0);

  console.log(`\n${label}`);
  console.log(`  ${strokes.length} strokes, ${pts} points (${(pts / strokes.length).toFixed(1)} per stroke)`);
  console.log(`  now                     ${kb(before).padStart(9)}   ${(before / strokes.length).toFixed(0).padStart(5)} B/stroke`);
  console.log(`  + rounded               ${kb(afterRound).padStart(9)}   ${((1 - afterRound / before) * 100).toFixed(0).padStart(4)}% smaller`);
  console.log(`  + dropped straight bits ${kb(afterSimplify).padStart(9)}   ${((1 - afterSimplify / before) * 100).toFixed(0).padStart(4)}% smaller  (${keptPts} points kept, ${((1 - keptPts / pts) * 100).toFixed(0)}% dropped)`);
  console.log(`  + delta-encoded         ${kb(afterDelta).padStart(9)}   ${((1 - afterDelta / before) * 100).toFixed(0).padStart(4)}% smaller   ${(afterDelta / strokes.length).toFixed(0).padStart(5)} B/stroke`);
  return { before, after: afterDelta };
}

const file = process.argv[2];

if (file) {
  const pages = strokesFromBackup(file);
  if (pages.length === 0) {
    console.log("No handwritten pages found in that backup.");
    process.exit(0);
  }
  console.log(`${pages.length} handwritten page(s) in ${file}`);
  let before = 0;
  let after = 0;
  for (const p of pages) {
    const r = report(`"${p.title}"`, p.strokes);
    before += r.before;
    after += r.after;
  }
  console.log(`\nAll handwriting: ${kb(before)} -> ${kb(after)}  (${((1 - after / before) * 100).toFixed(0)}% smaller)`);
} else {
  console.log("No backup supplied — pricing on synthetic strokes.");
  console.log("Run again with a real export for the numbers that decide anything:");
  console.log("  node scripts/measure-ink.mjs ~/Downloads/uni-planner-backup.json\n");
  for (const [label, count] of [["a light page", 50], ["a full page of notes", 200], ["a dense page", 500]]) {
    report(`${label} (${count} strokes)`, Array.from({ length: count }, () => syntheticStroke()));
  }
}
