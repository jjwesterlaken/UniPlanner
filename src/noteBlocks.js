/* ==================================================================
   noteBlocks.js — one note, a stack of blocks

   Step 3 of the unified note, and the one that must be PROVABLY
   behaviour-neutral: it introduces the block view and points every
   reader at it, while changing nothing anyone can see. No UI change, no
   writes, no conversion. The editor (step 4) is what starts writing
   `blocks`.

   THE SHAPE

     text block   { id, type: "text", html, body }
     ink block    { id, type: "ink",  strokes }

   A note is `blocks` if it has them, and is DERIVED into blocks if it
   doesn't. Readers never branch on which — that is the whole point of
   blocksOf being the single accessor.

   WHY DERIVATION RATHER THAN CONVERSION HERE. Converting on load would
   rewrite the entire pages collection on the first launch after deploy
   — a full blob write, a full sync — and a bug in it would have touched
   every note before anyone noticed. A change to the shape readers
   branch on converts LAZILY, on first edit, one note at a time. See the
   bulk-vs-lazy rule in CLAUDE.md. Nothing in this file writes.

   THE NEUTRALITY THEOREM, which is what makes pointing readers here
   safe, and which is tested rather than asserted:

     for any legacy note P,
       fieldsFromBlocks(blocksOf(P)) === { html, body, strokes } of P

   Derivation is therefore lossless and invertible, so a reader that
   goes through blocksOf sees exactly the bytes it saw before.
   ================================================================== */

import { isReferenceSheet } from "./reference.js";

export const TEXT = "text";
export const INK = "ink";

/* The canvas a stroke's coordinates live in. Here rather than in
   PlannerApp because the CONVERSION needs them: a note written before
   blocks existed was drawn on a full 1000x1400 page, so its derived ink
   block must say so. Give it the new-block default instead and the
   bottom half of every existing drawing is cut off -- which is exactly
   what happened, and what the conversion test caught. */
export const CANVAS_W = 1000;
export const CANVAS_H = 1400;

const asArray = (v) => (Array.isArray(v) ? v : []);
const asString = (v) => (typeof v === "string" ? v : "");

/**
 * Whether this page is (or can become) a stack of blocks.
 *
 * Reference sheets have `entries` and their own editor; AI lecture notes
 * carry `aiMeta`, live in their own row and open in AiLectureNoteView.
 * Neither is a block note, neither is ever converted, and blocksOf
 * returns null for both so nothing tries.
 */
export function isBlockNote(page) {
  if (!page) return false;
  if (isReferenceSheet(page)) return false;
  if (page.aiMeta) return false;
  return true;
}

/* Block ids are DERIVED FROM THE PAGE ID, never minted randomly.
   blocksOf runs on every render of every note in the list; random ids
   would change on each call, churning React keys and — worse — making
   the eventual conversion non-deterministic, so two devices converting
   the same note would produce different ids for identical content. */
const textId = (page, i) => `${page.id || "new"}:t${i}`;
const inkId = (page, i) => `${page.id || "new"}:i${i}`;

/**
 * The blocks of a note, whichever shape it is stored in.
 *
 * Returns `null` for anything that is not a block note, so a caller
 * that forgets to check gets a loud failure rather than a plausible
 * empty note.
 *
 * An empty note derives to `[]`, not to one empty text block: `[]` is
 * what inverts back to the empty fields, and the editor's
 * "always end in somewhere to type" rule belongs to the editor.
 */
export function blocksOf(page) {
  if (!isBlockNote(page)) return null;
  if (Array.isArray(page.blocks)) return page.blocks;

  const html = asString(page.html);
  const body = asString(page.body);
  const strokes = asArray(page.strokes);

  const text = html || body ? [{ id: textId(page, 0), type: TEXT, html, body }] : [];
  /* h is the page height these coordinates were captured in, NOT the
     default for a new block. See CANVAS_H above. */
  const ink = strokes.length ? [{ id: inkId(page, 0), type: INK, strokes, h: CANVAS_H }] : [];

  /* Order follows what the note was: a handwritten note that also
     carries stray html (fieldsOf writes both keys onto every page) reads
     ink-first, which is how it looked before. A typed note reads
     text-first. Getting this backwards would reorder a note on screen,
     which is exactly the visible change step 3 must not make. */
  return page.kind === "drawing" ? [...ink, ...text] : [...text, ...ink];
}

/**
 * The inverse: the legacy fields a stack of blocks represents.
 *
 * This is what makes the neutrality theorem checkable, and it is also
 * what step 4 will write alongside `blocks` for one release so a
 * restore from an older backup cannot eat handwriting.
 */
export function fieldsFromBlocks(blocks) {
  const list = asArray(blocks);
  return {
    html: list
      .filter((b) => b && b.type === TEXT)
      .map((b) => asString(b.html))
      .join(""),
    body: list
      .filter((b) => b && b.type === TEXT)
      .map((b) => asString(b.body))
      .join(""),
    strokes: list.filter((b) => b && b.type === INK).flatMap((b) => asArray(b.strokes)),
  };
}

/* ------------------------------------------------------------------ */
/*  What readers actually ask for                                     */
/* ------------------------------------------------------------------ */

/* Each returns exactly what the reader used to read off the page, so
   swapping a reader onto one of these is neutral by the theorem above
   rather than by inspection. They tolerate a non-block note by falling
   back to the raw field, because the list renders AI notes and
   reference sheets through the same component. */

/* Nothing to return, returned as the SAME array every time. See below
   for why identity matters here and not for the strings. */
const NO_INK = Object.freeze([]);

/**
 * Every stroke in the note, in block order.
 *
 * REFERENCE IDENTITY IS PART OF THE CONTRACT, which is not obvious and
 * is why this isn't a one-line flatMap. Both canvases redraw from
 * `useEffect(..., [strokes])`, so a reader handed a freshly-built array
 * on every render redraws the whole page on every render — for a
 * 200-stroke note, during handwriting. That is invisible in the DOM, so
 * the differential render cannot see it; it would have been a silent
 * performance regression dressed as a neutral change.
 *
 * A legacy note derives to exactly one ink block holding the page's own
 * array, so returning it unwrapped hands back the identical reference
 * the reader had before. htmlOf and bodyOf need no equivalent: strings
 * compare by value.
 */
export function inkOf(page) {
  const same = (v) => (Array.isArray(v) ? v : NO_INK);
  const blocks = blocksOf(page);
  if (!blocks) return same(page && page.strokes);
  const ink = blocks.filter((b) => b && b.type === INK);
  if (ink.length === 0) return NO_INK;
  if (ink.length === 1) return same(ink[0].strokes);
  return ink.flatMap((b) => asArray(b.strokes));
}

/** The note's rich text, in block order. */
export function htmlOf(page) {
  const blocks = blocksOf(page);
  if (!blocks) return asString(page && page.html);
  return fieldsFromBlocks(blocks).html;
}

/** The note's plain text, in block order. */
export function bodyOf(page) {
  const blocks = blocksOf(page);
  if (!blocks) return asString(page && page.body);
  return fieldsFromBlocks(blocks).body;
}

/* ================================================================== */
/*  Editing — step 4. Pure, so the awkward cases are testable.        */
/* ================================================================== */

/* An ink block's canvas is CANVAS_W wide and `h` tall. Half a page by
   default: a note that is a paragraph and a diagram should not be two
   screens tall. Stored per block rather than derived, so "always full
   page" is a change to this constant and nothing else -- which is what
   makes the schema safe to fix before the UX question is settled. */
export const INK_DEFAULT_H = 700;

/* Ids stay derived from the page, never minted, for the reason in
   blocksOf. A counter keeps them unique within the note without
   introducing randomness: two devices editing the same note produce
   different content, which merge resolves by updatedAt, but neither can
   produce a COLLIDING id for different content. */
const nextId = (blocks, pageId, prefix) => {
  const base = pageId || "new";
  let n = 0;
  const taken = new Set(asArray(blocks).map((b) => b && b.id));
  while (taken.has(`${base}:${prefix}${n}`)) n++;
  return `${base}:${prefix}${n}`;
};

export const newTextBlock = (blocks, pageId) => ({
  id: nextId(blocks, pageId, "t"),
  type: TEXT,
  html: "",
  body: "",
});

export const newInkBlock = (blocks, pageId, h = INK_DEFAULT_H) => ({
  id: nextId(blocks, pageId, "i"),
  type: INK,
  strokes: [],
  h,
  usedPen: false,
});

export const indexOfBlock = (blocks, id) => asArray(blocks).findIndex((b) => b && b.id === id);

/** Replace one block, leaving every other reference untouched. */
export function withBlock(blocks, id, patch) {
  const list = asArray(blocks);
  const i = indexOfBlock(list, id);
  if (i < 0) return list;
  const next = list.slice();
  next[i] = { ...next[i], ...patch };
  return next;
}

/**
 * Insert an ink block after `afterId`.
 *
 * A note must never END in ink: there would be nowhere to type, and the
 * only way back to typing would be to add a block from the toolbar --
 * which is exactly the "where did my cursor go" problem the editor
 * exists to avoid. So a trailing text block comes with it.
 */
export function insertInkAfter(blocks, afterId, pageId) {
  const list = asArray(blocks).slice();
  const at = indexOfBlock(list, afterId);
  const ink = newInkBlock(list, pageId);
  const head = at < 0 ? list.length : at + 1;
  list.splice(head, 0, ink);
  if (head === list.length - 1) list.push(newTextBlock(list, pageId));
  return { blocks: list, focusId: ink.id };
}

/**
 * THE BACKSPACE RULE.
 *
 * Backspace at offset 0 of a text block merges it into the previous
 * TEXT block. If the previous block is ink, it does NOTHING -- deleting
 * handwriting needs the explicit control, with the block selected.
 *
 * This is the data-loss case in the whole editor. A student typing under
 * a diagram, holding backspace to clear a line, must not silently take
 * the diagram with it: strokes are not recoverable from anywhere, and
 * nothing about holding a key says "and now the drawing".
 *
 * Returns null when the merge is refused, so the caller can leave the
 * keystroke alone rather than swallowing it.
 */
export function mergeTextBack(blocks, id) {
  const list = asArray(blocks);
  const i = indexOfBlock(list, id);
  if (i <= 0) return null; // nothing before it; the caret is at the top
  const prev = list[i - 1];
  const here = list[i];
  if (!prev || !here || here.type !== TEXT) return null;

  // THE REFUSAL. Ink before text is a wall, not a thing to merge into.
  if (prev.type !== TEXT) return null;

  const next = list.slice();
  next[i - 1] = {
    ...prev,
    html: asString(prev.html) + asString(here.html),
    body: asString(prev.body) + asString(here.body),
  };
  next.splice(i, 1);
  return { blocks: next, focusId: prev.id, caretAt: asString(prev.body).length };
}

/** Remove a block outright — the explicit delete, never the keystroke. */
export function removeBlock(blocks, id) {
  const list = asArray(blocks).filter((b) => b && b.id !== id);
  return list.length ? list : [newTextBlock([], null)];
}

/**
 * THE LATCH IS NOTE-LEVEL, AND THIS IS THE FUNCTION THAT MAKES IT SO.
 *
 * `usedPen` is stored per ink block, but the question a canvas asks is
 * "has a pen ever been used on THIS NOTE" -- because a block that
 * consulted only itself would start unprotected the moment a student
 * added a second one, which is precisely the per-canvas regression the
 * note-level latch exists to kill.
 */
export function noteUsedPen(blocks) {
  return asArray(blocks).some((b) => b && b.type === INK && b.usedPen);
}
