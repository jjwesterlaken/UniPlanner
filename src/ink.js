/* ==================================================================
   ink.js — how a stroke is stored

   Pure. No React, no canvas, no browser globals — so the byte counts
   and the idempotence can be exercised directly from Node, which is
   what `scripts/measure-ink.mjs` and `scripts/test-ink.mjs` both do.

   WHY THIS EXISTS. A point was `[((e.clientX - rect.left) / rect.width)
   * CANVAS_W, ...]` — an unrounded division, serialised at full float
   precision (`123.45678901234567`) for a coordinate on a 1000-unit
   canvas where nothing past the decimal point can be seen. A stroke
   cost ~1,420 bytes; a 200-stroke page cost **278 KB, a quarter of the
   entire 1 MB blob budget in one note.** Anyone taking handwritten
   notes on an iPad was heading toward breaking their own sync with
   nothing warning them.

   Rounding takes that page to ~95 KB. Measured, not estimated, and the
   figure is a FLOOR rather than an estimate: it removes float digits,
   which are waste regardless of how anyone writes.

   THE TWO FURTHER STAGES HAVE NOW LANDED, unblocked by the stylus
   sample (Grace's iPad, 15 Aug 2026 — the first real Apple Pencil
   data): dropping near-collinear points (−61% on the stylus page, on
   top of rounding) and delta-encoding along the stroke (−74%). A dense
   200-stroke stylus page goes ~113 KB → ~29 KB. See simplifyStroke and
   encodeStroke below, and the assumptions block above encodeStroke —
   every one of them was revealed by a real sample, not designed in.
   ================================================================== */

/* ---------- the grid, and why it is a TENTH of a canvas unit ----------

   The obvious choice is whole units, and it is wrong. The canvas
   backing store is sized `CANVAS_W * devicePixelRatio` with the ratio
   capped at 3, so on a 3x display one canvas unit is THREE PHYSICAL
   PIXELS -- and the drawing code's own comment promises strokes "stay
   sharp at any zoom". Whole-unit quantisation would be visible on
   exactly the hardware this feature exists for, and worst on small
   handwriting.

   A tenth of a unit is below one physical pixel at the largest ratio
   the app ever uses, so it cannot produce a visible step. It costs one
   digit per coordinate: 66% instead of 72% for rounding alone. There is
   no zoom control and no image export today, but neither is what makes
   whole units unsafe -- the device pixel ratio already does. */
export const GRID = 10;

/* Pressure feeds exactly one thing:
     lineWidth = max(0.5, width * (0.4 + pressure * 1.6))
   At a typical width of 3 the whole pressure range spans 1.2px to 6px,
   so 100 levels move the line by 0.048px per step. Two decimal places
   is invisible; a single byte would be too. */
export const PRESSURE_DP = 100;

const snap = (v) => Math.round(v * GRID) / GRID;
const snapPressure = (p) => Math.round((p == null ? 0.5 : p) * PRESSURE_DP) / PRESSURE_DP;

/** One point, at storage precision. Used at capture time and by the migration. */
export const roundPoint = (x, y, pressure) => [snap(x), snap(y), snapPressure(pressure)];

/**
 * A stroke at storage precision.
 *
 * IDEMPOTENT: rounding an already-rounded stroke returns an identical
 * value. That is what makes it safe to run on every load — see
 * migrateStrokes — and it is asserted rather than assumed.
 */
export function roundStroke(stroke) {
  if (!stroke || !Array.isArray(stroke.points)) return stroke;
  return {
    ...stroke,
    points: stroke.points.map((p) => roundPoint(p[0], p[1], p[2])),
  };
}

/** True when every coordinate is already on the grid — nothing to do. */
export function isRounded(stroke) {
  if (!stroke || !Array.isArray(stroke.points)) return true;
  return stroke.points.every(
    (p) => p[0] === snap(p[0]) && p[1] === snap(p[1]) && (p[2] == null || p[2] === snapPressure(p[2]))
  );
}

/**
 * Round every stroke on a page, or return the page UNCHANGED.
 *
 * Returning the same object reference when nothing needed rounding is
 * not an optimisation — it is what lets the caller tell "I rewrote
 * this" from "I didn't", so a load that changes nothing writes nothing.
 */
export function migrateStrokes(page) {
  if (!page || !Array.isArray(page.strokes) || page.strokes.length === 0) return page;
  if (page.strokes.every(isRounded)) return page;
  return { ...page, strokes: page.strokes.map(roundStroke) };
}

/**
 * Round the ink in a whole collection of pages.
 *
 * **DOES NOT TOUCH `updatedAt`, AND THAT IS THE LOAD-BEARING PART.**
 *
 * A lossless representation change is not an edit. If it looked like
 * one, two devices each opening the app would rewrite the same notes,
 * each rewrite would look newer than the other's, and they would fight
 * through last-write-wins forever — a sync loop that never settles,
 * caused by a change that alters nothing anyone can see.
 *
 * `mergeList` breaks a tie with `t2 > t1`, strictly greater, so equal
 * timestamps keep the existing item and the merge is stable. That
 * strictness is what makes a silent rewrite safe, which is why there is
 * a test for it that mentions this function by name.
 *
 * Returns the same array reference when nothing changed.
 */
export function migratePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return pages;
  let changed = false;
  const out = pages.map((p) => {
    const next = migrateStrokes(p);
    if (next !== p) changed = true;
    return next;
  });
  return changed ? out : pages;
}


/* ==================================================================
   Stage 2: drop near-collinear points

   The same operation measure-ink.mjs priced, verbatim, so the shipped
   figure is the measured figure. Greedy chord test: a middle point
   whose perpendicular distance from the line between its kept
   neighbour and its successor is within tolerance carries no visible
   information.

   WHY 0.8 CANVAS UNITS IS SAFE, argued rather than felt: the thinnest
   line the renderer draws after the pressure remap is ~1.9 canvas
   units wide (width 3 at the remapped pressure floor), so the maximum
   deviation this can introduce is under HALF the thinnest stroke's own
   width — the ink moves within its own line. It runs on stroke END at
   capture (never mid-stroke; the live stroke stays raw so drawing
   feels immediate) and when a note is saved, which is lazy across the
   collection: only edited notes are touched, per the shape-change
   rule.
   ================================================================== */

export const SIMPLIFY_TOLERANCE = 0.8;

export function simplifyStroke(stroke, tolerance = SIMPLIFY_TOLERANCE) {
  const pts = stroke && stroke.points;
  /* Single-point strokes exist (three in the stylus sample) and
     two-point strokes have no middle to drop. */
  if (!Array.isArray(pts) || pts.length < 3) return stroke;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = out[out.length - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const dx = x2 - x0;
    const dy = y2 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const dist = Math.abs(dy * x1 - dx * y1 + x2 * y0 - y2 * x0) / len;
    if (dist > tolerance) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  if (out.length === pts.length) return stroke; // nothing dropped — same reference
  return { ...stroke, points: out };
}

/* ==================================================================
   Stage 3: delta-encode along the stroke

   Handwriting samples densely, so consecutive offsets are one or two
   digits where absolute coordinates are four or five. Stored shape:

     { color, width, erase, v: 2,
       o: [x·10, y·10, p·100],          the first point, absolute
       d: [dx·10, dy·10, dp·100, …] }   every later point as offsets

   ASSUMPTIONS THIS ENCODER HOLDS TO — each revealed by a real sample,
   recorded in CLAUDE.md before this code existed:

   - Coordinates are NOT bounded by the canvas and not non-negative
     (finger sample ran to x=−99; stylus to y=−39.7 and x=1004.1).
     Everything here is a plain signed JSON integer: nothing packs into
     a fixed range, nothing assumes a sign, nothing clamps — clamping
     would MOVE ink that currently renders.
   - A missing pressure is the neutral 0.5, never 0 — zero renders a
     hairline where a mouse drew a normal stroke.
   - Observed pressure spans [0, 0.5] but is encoded over [0, 1]
     anyway: that observation is one hand on one device through one
     browser's mapping, and 0..100 costs the same as 0..50.
   - Width varies WITHIN a page (the eraser is a width), so width stays
     per-stroke; nothing hoists it.
   - A single-point stroke encodes as `o` with an empty `d`.
   - Input is grid-aligned already (rounding at capture and on load),
     so ·10/·100 are exact integers, and decode's /10 and /100 land on
     the identical IEEE doubles rounding produced — the round trip is
     bit-exact, which is what makes re-encoding on every save safe.
   ================================================================== */

export const isEncoded = (stroke) =>
  !!stroke && stroke.v === 2 && Array.isArray(stroke.o) && Array.isArray(stroke.d);

export function encodeStroke(stroke) {
  if (!stroke || isEncoded(stroke)) return stroke;
  const pts = Array.isArray(stroke.points) ? stroke.points : [];
  if (pts.length === 0) return stroke; // nothing to encode; keep the odd shape visible
  const P = (p) => Math.round(snapPressure(p) * PRESSURE_DP);
  const X = (v) => Math.round(v * GRID);
  const [x0, y0, p0] = pts[0];
  const o = [X(x0), X(y0), P(p0)];
  const d = [];
  let px = o[0];
  let py = o[1];
  let pp = o[2];
  for (let i = 1; i < pts.length; i++) {
    const [x, y, p] = pts[i];
    const xi = X(x);
    const yi = X(y);
    const pi = P(p);
    d.push(xi - px, yi - py, pi - pp);
    px = xi;
    py = yi;
    pp = pi;
  }
  /* `_at` is the transient marker the palm latch's retroactive discard
     matches on. The autosave can fire between a touch stroke landing
     and the first pen contact, so encoding must not strip it — a palm
     mark would survive purely because a save ran at the wrong moment. */
  const out = { color: stroke.color, width: stroke.width, erase: !!stroke.erase, v: 2, o, d };
  if (stroke._at) out._at = stroke._at;
  return out;
}

export function decodeStroke(stroke) {
  if (!isEncoded(stroke)) return stroke;
  const points = [];
  let [x, y, p] = stroke.o;
  points.push([x / GRID, y / GRID, p / PRESSURE_DP]);
  for (let i = 0; i < stroke.d.length; i += 3) {
    x += stroke.d[i];
    y += stroke.d[i + 1];
    p += stroke.d[i + 2];
    points.push([x / GRID, y / GRID, p / PRESSURE_DP]);
  }
  return { color: stroke.color, width: stroke.width, erase: !!stroke.erase, points };
}

/**
 * The points of a stroke, whichever shape it is stored in — the
 * dual-shape accessor every renderer goes through, same pattern as
 * blocksOf. Encoded strokes decode on demand; legacy strokes pass
 * through by reference.
 */
export function pointsOf(stroke) {
  if (isEncoded(stroke)) return decodeStroke(stroke).points;
  return (stroke && stroke.points) || [];
}

/**
 * What a note SAVES: every stroke simplified and encoded. Returns the
 * same array reference when nothing changed, the same contract as
 * migratePages — a save that alters nothing writes nothing new.
 */
export function encodeStrokes(strokes) {
  if (!Array.isArray(strokes)) return strokes;
  let changed = false;
  const out = strokes.map((s) => {
    if (isEncoded(s)) return s;
    const next = encodeStroke(simplifyStroke(s));
    if (next !== s) changed = true;
    return next;
  });
  return changed ? out : strokes;
}
