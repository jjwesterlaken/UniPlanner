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
   which are waste regardless of how anyone writes. The two further
   stages priced in measure-ink.mjs — dropping near-collinear points,
   delta-encoding along the stroke — depend on stroke shape and are
   deliberately NOT done here until they have been measured against
   real handwriting.
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
