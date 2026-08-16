/* ==================================================================
   noteBlocks.js — one note, a stack of blocks

   Step 3 of the unified note, and the one that must be PROVABLY
   behaviour-neutral: it introduces the block view and points every
   reader at it, while changing nothing anyone can see. No UI change, no
   writes, no conversion. The editor (step 4) is what starts writing
   `blocks`.

   THE SHAPE

     text block   { id, type: "text", html, body }

   There USED to be an ink block ({ type: "ink", strokes }). Handwriting
   was removed entirely -- feature and data -- on Grace and Jared's
   decision, 16 August 2026. Stored ink is stripped by
   removeHandwriting() below; the type string survives only as the
   LEGACY_INK constant the strip recognises old data by.

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
/* The stored type string of the removed ink block. Kept ONLY so the
   strip and the derivation can recognise pre-removal data; nothing
   creates blocks of this type any more. */
export const LEGACY_INK = "ink";

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

  /* Legacy strokes are IGNORED, not derived: handwriting is removed,
     and a note that still carries some (an old backup, a stale device)
     renders as its text until removeHandwriting strips it for good. */
  return html || body ? [{ id: textId(page, 0), type: TEXT, html, body }] : [];
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
 * THE BACKSPACE RULE. Backspace at offset 0 of a text block merges it
 * into the previous TEXT block. The non-text guard survives the ink
 * removal because a note not yet stripped can still hold a legacy ink
 * block, and merging "into" one would corrupt the stack. Returns null
 * when the merge is refused.
 */
export function mergeTextBack(blocks, id) {
  const list = asArray(blocks);
  const i = indexOfBlock(list, id);
  if (i <= 0) return null; // nothing before it; the caret is at the top
  const prev = list[i - 1];
  const here = list[i];
  if (!prev || !here || here.type !== TEXT) return null;

  if (prev.type !== TEXT) return null; // a legacy ink block, until stripped

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
 * What a note STORES — the single save path, shared by every screen
 * that can edit one.
 *
 * It lives here rather than in PlannerApp because it is note-shape
 * logic, not screen logic, and because there used to be two of it: the
 * Folders tab carried a hand-written copy that had already drifted.
 * One save path, several entry points.
 */
export function noteFields(d) {
  /* Ink blocks are dropped ON EVERY SAVE, which is the strip's second
     half: the one-time removeHandwriting pass handles the collection,
     and this handles any note a pre-removal device resurrects later --
     the next edit anywhere near it re-removes the ink, inside a write
     that bumps updatedAt anyway. */
  const derived = blocksOf(d);
  const blocks = derived && derived.filter((b) => b && b.type !== LEGACY_INK);
  /* STEP 4B: the legacy fields are no longer written alongside `blocks`.
     They were kept for one release so a device still on the pre-blocks
     build could read a note this one saved; that release has shipped.

     THEY ARE EMPTIED RATHER THAN OMITTED, and that is not a detail.
     `patchItem` spreads the patch over the existing item, so a key left
     out keeps its OLD value -- a note would carry the content twice
     forever, which is the exact cost this change exists to remove. The
     empty keys cost ~30 bytes against roughly half the note.

     Readers stay dual-shape indefinitely. Nothing converts on load, and
     an unconverted note still reads from its own fields; this only
     stops NEW writes duplicating. */
  /* `strokes: []` is written UNCONDITIONALLY: a pre-removal build on
     another device still reads the field, and an empty array is the
     shape every text note has always had there. */
  const legacy = blocks
    ? { html: "", body: "", strokes: [] }
    : { html: d.html || "", body: d.body || "", strokes: [] };
  return {
    title: d.title,
    ...legacy,
    ...(blocks ? { blocks } : {}),
    style: d.style,
    kind: d.kind || "text",
    font: d.font || "sans",
    // Only reference sheets carry entries; every other page keeps the
    // key absent rather than an empty array it never reads.
    ...(isReferenceSheet(d) ? { entries: d.entries || [] } : {}),
  };
}

/* ================================================================== */
/*  The removal of handwriting — feature AND data                     */
/* ================================================================== */

/* Grace and Jared both confirmed: existing handwritten content goes
   too, not just the tools. The escape hatch is the backup file — a
   pre-removal export preserves every stroke byte-for-byte, forever;
   the app stops rendering them but never mangles the file.

   THE PRINCIPLE: remove ink, never remove notes. A note that was only
   handwriting becomes an EMPTY TEXT NOTE KEEPING ITS TITLE — the title
   is user-typed content and the note's place in a folder is
   information; deleting whole notes is a bigger destructive act than
   the one that was ordered, and the affected users can delete the
   husks themselves.

   BULK-ONCE, NOT BULK-EVERY-LOAD. The pass bumps updatedAt (this is a
   real edit and must WIN merges, or a stale device's copy brings the
   ink back for good), so running it on every load would have two
   devices fighting through last-write-wins forever — the exact loop
   the old ink-rounding migration was built to avoid. `meta.inkRemoved`
   guards it — but the flag is BEST-EFFORT, not the guarantee:
   mergeData spreads {...local.meta, ...newerSide.meta}, so a flag
   that lives only on a non-newer remote is dropped. What makes that
   harmless is CONVERGENCE: on already-stripped data the pass returns
   every page by reference and bumps nothing, so a re-run's only
   effect is re-setting the flag — no edit propagates, no fight. The
   updatedAt bump only ever happens on a page that really has ink,
   and stripping the same ink twice produces the same result. The
   test named "the flag is best-effort across merges" pins both
   halves. noteFields' per-save strip catches any note a pre-removal
   device resurrects afterwards.

   Tombstones are left ENTIRELY alone: their payload is unread (the
   archive's differential mount proved that a contract), the 60-day
   purge clears them on its own schedule, and restamping a dead item
   only extends its life. AI-note stubs never carry ink (their strokes
   field has always been []) and fall through pageHasInk untouched. */

/** Whether a live page still carries any handwriting. */
export function pageHasInk(page) {
  if (!page || page.deletedAt) return false;
  if (page.aiMeta) return false;
  if (Array.isArray(page.strokes) && page.strokes.length > 0) return true;
  if (Array.isArray(page.blocks) && page.blocks.some((b) => b && b.type === LEGACY_INK)) return true;
  return page.kind === "drawing";
}

/**
 * One page, handwriting removed. Same reference when there is nothing
 * to remove, so callers can tell whether anything happened — and so a
 * pass over a clean collection writes nothing.
 */
export function stripInkFromPage(page, at) {
  if (!pageHasInk(page)) return page;
  const out = { ...page, strokes: [], updatedAt: at || page.updatedAt };
  if (Array.isArray(page.blocks)) out.blocks = page.blocks.filter((b) => b && b.type !== LEGACY_INK);
  if (page.kind === "drawing") out.kind = "text";
  return out;
}

/**
 * The one-time pass over the whole planner. Returns the same data
 * object when the flag says it has already run.
 */
export function removeHandwriting(data, at) {
  if (!data) return data;
  if (data.meta && data.meta.inkRemoved) return data;
  const semesters = {};
  for (const [name, sem] of Object.entries(data.semesters || {})) {
    const pages = (sem && sem.pages) || [];
    const stripped = pages.map((p) => stripInkFromPage(p, at));
    semesters[name] = stripped.some((p, i) => p !== pages[i]) ? { ...sem, pages: stripped } : sem;
  }
  return { ...data, semesters, meta: { ...(data.meta || {}), inkRemoved: true } };
}
