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
  const ink = strokes.length ? [{ id: inkId(page, 0), type: INK, strokes }] : [];

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
