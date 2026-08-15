/* Tests for src/noteBlocks.js — step 3 of the unified note.

   THE CLAIM THIS FILE HAS TO ESTABLISH is that pointing every reader at
   blocksOf changed nothing anyone can see. It is established three
   ways, deliberately, because each is weak on its own:

     1. THE INVERSE THEOREM. For any legacy note P,
        fieldsFromBlocks(blocksOf(P)) is exactly P's html/body/strokes.
        Derivation is lossless and invertible, so a reader that goes
        through blocksOf reads the identical bytes. This is the actual
        proof; the rest is corroboration.

     2. NO WRITES, NO MUTATION. Asserted from the source, and by calling
        every function on deeply-frozen input -- a mutation would throw.

     3. A DIFFERENTIAL RENDER against the previous commit, in
        scripts/test-blocks-neutral.mjs: the same seeded planner rendered
        by both bundles, HTML compared byte for byte. That one is the
        answer to "demonstrate rather than assert", and it is the only
        one that would catch a reader I forgot to think about. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blocksOf,
  fieldsFromBlocks,
  isBlockNote,
  inkOf,
  htmlOf,
  bodyOf,
  TEXT,
  INK,
  CANVAS_H,
  INK_DEFAULT_H,
  newTextBlock,
  newInkBlock,
  insertInkAfter,
  mergeTextBack,
  removeBlock,
  noteUsedPen,
  withBlock,
} from "../src/noteBlocks.js";

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

const stroke = (n = 3) => ({ color: "#1c1917", width: 3, erase: false, points: [[1, 2, 0.5], [n, 4, 0.5]] });

/* Every shape a page is actually stored in today, plus the awkward
   ones. This corpus is what the theorem is quantified over. */
const CORPUS = {
  "a typed note": { id: "p1", kind: "text", html: "<p>hello</p>", body: "hello", strokes: [] },
  "a typed note with no plain body": { id: "p2", kind: "text", html: "<p>rich</p>", body: "", strokes: [] },
  "a handwritten note": { id: "p3", kind: "drawing", html: "", body: "", strokes: [stroke(1), stroke(2)] },
  "a handwritten note carrying stray html": {
    id: "p4",
    kind: "drawing",
    html: "<p>note</p>",
    body: "note",
    strokes: [stroke(1)],
  },
  "a typed note carrying stray strokes": { id: "p5", kind: "text", html: "<p>x</p>", body: "x", strokes: [stroke(9)] },
  "an empty note": { id: "p6", kind: "text", html: "", body: "", strokes: [] },
  "a note with the keys absent entirely": { id: "p7", kind: "text" },
};

const legacyFields = (p) => ({ html: p.html || "", body: p.body || "", strokes: p.strokes || [] });

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.values(v).forEach(deepFreeze);
  }
  return v;
};

console.log("\nnote blocks");

/* ---------- 1. the inverse theorem ---------- */

for (const [label, page] of Object.entries(CORPUS)) {
  test(`${label} survives blocksOf -> fieldsFromBlocks unchanged`, () => {
    /* THE PROOF that pointing readers at blocksOf is neutral: derivation
       loses nothing and reorders nothing, so every reader sees the same
       bytes it saw before. */
    assert.deepEqual(fieldsFromBlocks(blocksOf(page)), legacyFields(page));
  });
}

test("the convenience readers return exactly what the page held", () => {
  for (const page of Object.values(CORPUS)) {
    assert.equal(htmlOf(page), page.html || "", "htmlOf drifted from the page");
    assert.equal(bodyOf(page), page.body || "", "bodyOf drifted from the page");
    assert.deepEqual(inkOf(page), page.strokes || [], "inkOf drifted from the page");
  }
});

test("inkOf hands back the SAME array, not a copy", () => {
  /* Not a micro-optimisation. Both canvases redraw from
     useEffect(..., [strokes]), so a fresh array on every render redraws
     the whole page on every render -- during handwriting, on a
     200-stroke note. It is invisible in the DOM, so the differential
     render in test-blocks-neutral.mjs structurally cannot catch it:
     this is the only thing asserting it. */
  const page = CORPUS["a handwritten note"];
  assert.equal(inkOf(page), page.strokes, "a legacy note's own strokes array was rebuilt");
  assert.equal(inkOf(page), inkOf(page), "two calls returned two different arrays");

  const blocks = [{ id: "b1", type: INK, strokes: [stroke(1)] }];
  const asBlocks = { id: "p10", kind: "drawing", blocks };
  assert.equal(inkOf(asBlocks), blocks[0].strokes, "a block note's strokes array was rebuilt");

  // And the empty case, which every typed note in the list goes through.
  assert.equal(inkOf(CORPUS["an empty note"]), inkOf(CORPUS["a typed note"]), "no ink is two different empty arrays");
});

/* ---------- what the blocks actually are ---------- */

test("a typed note is one text block", () => {
  const blocks = blocksOf(CORPUS["a typed note"]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, TEXT);
});

test("a handwritten note is one ink block", () => {
  const blocks = blocksOf(CORPUS["a handwritten note"]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, INK);
  assert.equal(blocks[0].strokes.length, 2);
});

test("a handwritten note carrying stray html reads INK FIRST", () => {
  /* fieldsOf writes html/body onto every page, so this shape is real.
     Text-first here would reorder a note on screen -- exactly the
     visible change step 3 must not make. */
  assert.deepEqual(
    blocksOf(CORPUS["a handwritten note carrying stray html"]).map((b) => b.type),
    [INK, TEXT]
  );
});

test("a typed note carrying stray strokes reads TEXT FIRST", () => {
  assert.deepEqual(blocksOf(CORPUS["a typed note carrying stray strokes"]).map((b) => b.type), [TEXT, INK]);
});

test("an empty note has no blocks at all", () => {
  /* [] is what inverts back to the empty fields. "Always end in
     somewhere to type" is the editor's rule, and it belongs to step 4. */
  assert.deepEqual(blocksOf(CORPUS["an empty note"]), []);
  assert.deepEqual(blocksOf(CORPUS["a note with the keys absent entirely"]), []);
});

test("a note already stored as blocks is returned as-is", () => {
  const blocks = [{ id: "b1", type: TEXT, html: "<p>new</p>", body: "new" }];
  const page = { id: "p9", kind: "text", blocks };
  assert.equal(blocksOf(page), blocks, "a block note was re-derived rather than read");
});

test("block ids are derived from the page id, not minted", () => {
  /* blocksOf runs on every render of every note in the list. Random ids
     would churn React keys and make the eventual conversion
     non-deterministic, so two devices converting the same note would
     produce different ids for identical content. */
  const page = CORPUS["a typed note carrying stray strokes"];
  assert.deepEqual(blocksOf(page).map((b) => b.id), blocksOf(page).map((b) => b.id));
  assert.ok(blocksOf(page).every((b) => b.id.startsWith("p5:")));
});

/* ---------- what is NOT a block note ---------- */

test("a reference sheet is not a block note", () => {
  const sheet = { id: "s1", kind: "formula", entries: [{ label: "a", body: "b" }] };
  assert.equal(isBlockNote(sheet), false);
  assert.equal(blocksOf(sheet), null, "null is louder than an empty note");
});

test("an AI lecture note is not a block note", () => {
  const ai = { id: "a1", kind: "text", html: "", body: "", aiMeta: { course: "PHYS1001", remote: true } };
  assert.equal(isBlockNote(ai), false);
  assert.equal(blocksOf(ai), null);
});

test("the readers still work on a note that is not a block note", () => {
  /* The list renders AI notes and reference sheets through the same
     component, so a fallback is not optional. */
  const ai = { id: "a1", kind: "text", html: "<p>ai</p>", body: "ai", strokes: [], aiMeta: { remote: true } };
  assert.equal(htmlOf(ai), "<p>ai</p>");
  assert.deepEqual(inkOf(ai), []);
  assert.equal(htmlOf(null), "");
  assert.deepEqual(inkOf(undefined), []);
});

/* ---------- 2. no writes, no mutation ---------- */

test("nothing in noteBlocks.js writes", () => {
  /* Step 3 is readers only. A write here would make the conversion
     bulk-on-load, which is the thing the bulk-vs-lazy rule forbids. */
  const src = fs.readFileSync(path.join(rootDir, "src/noteBlocks.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const forbidden of ["addItem", "patchItem", "setDraft", "setData", "localStorage", "updatedAt"]) {
    assert.ok(!src.includes(forbidden), `noteBlocks.js references "${forbidden}" — step 3 must not write`);
  }
});

test("no function mutates the page it is given", () => {
  /* Called on deeply-frozen input: a mutation throws in strict mode,
     which every ES module is. */
  for (const page of Object.values(CORPUS)) {
    const frozen = deepFreeze(structuredClone(page));
    blocksOf(frozen);
    inkOf(frozen);
    htmlOf(frozen);
    bodyOf(frozen);
    fieldsFromBlocks(blocksOf(frozen));
  }
});

/* ---------- the readers were actually moved over ---------- */

test("no reader still pulls strokes or html straight off a page", () => {
  /* The theorem only buys neutrality for readers that GO THROUGH
     blocksOf. This is what stops a reader being left behind, which
     would leave step 4 writing blocks that one screen cannot see. */
  const app = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");

  const viewer = app.slice(app.indexOf("function NoteView"), app.indexOf("function ReferenceSheetView"));
  assert.match(viewer, /inkOf\(page\)/, "the note viewer still reads page.strokes");
  assert.match(viewer, /htmlOf\(page\)/, "the note viewer still reads page.html");
  assert.doesNotMatch(viewer, /page\.strokes/, "the note viewer still reads page.strokes");

  assert.match(app, /inkOf\(p\)\.length/, "the list preview still counts p.strokes");
  assert.match(app, /htmlToText\(htmlOf\(p\)\)/, "the list preview still reads p.html");
});

/* ================================================================== */
/*  Step 4 — editing                                                  */
/* ================================================================== */

const T = (id, html = "") => ({ id, type: TEXT, html, body: html.replace(/<[^>]*>/g, "") });
const I = (id, n = 1) => ({ id, type: INK, strokes: [stroke(n)], h: 700 });

/* ---------- THE BACKSPACE RULE ---------- */

test("backspace at the start of a text block merges it into the one above", () => {
  const blocks = [T("a", "<p>one</p>"), T("b", "<p>two</p>")];
  const out = mergeTextBack(blocks, "b");
  assert.ok(out, "the merge was refused between two text blocks");
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].html, "<p>one</p><p>two</p>");
  assert.equal(out.focusId, "a", "focus did not follow the text it merged into");
  assert.equal(out.caretAt, 3, "the caret is not at the join");
});

test("BACKSPACE ABOVE INK DELETES NOTHING", () => {
  /* THE ONE THAT MATTERS. A student typing under a diagram, holding
     backspace to clear a line, must not silently take the diagram with
     it: strokes are recoverable from nowhere, and nothing about holding
     a key says "and now the drawing".

     Refusal is `null` rather than an unchanged array, so the caller can
     tell "nothing to do" from "did something". */
  const blocks = [T("a", "<p>above</p>"), I("ink", 4), T("b", "<p>below</p>")];
  assert.equal(mergeTextBack(blocks, "b"), null, "backspace merged a text block INTO an ink block");
});

test("a refused backspace leaves every stroke where it was", () => {
  // The same claim from the other side: not just "returns null" but
  // "the ink is still there", which is what a student would check.
  const ink = I("ink", 6);
  const blocks = [T("a"), ink, T("b", "<p>x</p>")];
  const out = mergeTextBack(blocks, "b");
  assert.equal(out, null);
  assert.equal(blocks[1], ink, "the ink block was replaced");
  assert.equal(blocks[1].strokes.length, 1);
  assert.equal(blocks.length, 3, "a block went missing on a refused merge");
});

test("backspace in the first block does nothing at all", () => {
  assert.equal(mergeTextBack([T("a", "<p>x</p>")], "a"), null);
  assert.equal(mergeTextBack([], "a"), null);
});

test("merging never mutates the blocks it was given", () => {
  const blocks = deepFreeze([T("a", "<p>one</p>"), T("b", "<p>two</p>")]);
  mergeTextBack(blocks, "b");
});

/* ---------- inserting handwriting ---------- */

test("a note never ENDS in ink", () => {
  /* Otherwise there is nowhere to type and the only way back to typing
     is the toolbar -- which is the "where did my cursor go" problem the
     editor exists to avoid. */
  const { blocks } = insertInkAfter([T("a", "<p>x</p>")], "a", "p1");
  assert.deepEqual(blocks.map((b) => b.type), [TEXT, INK, TEXT]);
});

test("handwriting inserted in the middle does NOT get a trailing block", () => {
  const { blocks } = insertInkAfter([T("a"), T("b")], "a", "p1");
  assert.deepEqual(blocks.map((b) => b.type), [TEXT, INK, TEXT]);
  assert.equal(blocks.length, 3, "a redundant text block was added mid-note");
});

test("a new ink block is half a page; a CONVERTED one is a full page", () => {
  /* The bug this pins: an existing handwritten note's coordinates were
     captured on a 1000x1400 page. Convert it into a block with the
     new-block default and the bottom half of the drawing is cropped.
     Caught by the conversion render, not by looking. */
  assert.equal(newInkBlock([], "p1").h, INK_DEFAULT_H);
  assert.equal(INK_DEFAULT_H, 700);
  const legacy = { id: "p9", kind: "drawing", html: "", body: "", strokes: [stroke(3)] };
  assert.equal(blocksOf(legacy)[0].h, CANVAS_H, "a converted drawing was given the new-block height");
});

test("block ids never collide, however many are added", () => {
  let blocks = [newTextBlock([], "p1")];
  for (let i = 0; i < 5; i++) blocks = insertInkAfter(blocks, blocks[blocks.length - 1].id, "p1").blocks;
  const ids = blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate block id: ${ids.join(",")}`);
});

test("removing the last block leaves somewhere to type", () => {
  assert.deepEqual(removeBlock([I("ink")], "ink").map((b) => b.type), [TEXT]);
});

/* ---------- THE LATCH IS NOTE-LEVEL ---------- */

test("a pen used in ONE block protects EVERY block on the note", () => {
  /* THE REGRESSION THIS EXISTS TO KILL. usedPen is stored per block, so
     a canvas that consulted only its own flag would start unprotected
     the moment a student added a second piece of handwriting -- which
     is precisely the per-canvas behaviour the note-level latch
     replaced. Pen in block one, fresh block two, still protected. */
  const one = { ...I("i1"), usedPen: true };
  const two = I("i2");
  assert.equal(noteUsedPen([one, two]), true, "a second ink block starts unprotected");
  assert.equal(noteUsedPen([two]), false, "a note that has never seen a pen is latched anyway");
  assert.equal(noteUsedPen([T("a"), one]), true);
});

test("the latch survives being written through withBlock", () => {
  const blocks = [I("i1"), I("i2")];
  const next = withBlock(blocks, "i1", { usedPen: true });
  assert.equal(noteUsedPen(next), true);
  assert.equal(noteUsedPen(blocks), false, "withBlock mutated the array it was given");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
