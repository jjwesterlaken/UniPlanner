/* The block view of a note, POST-HANDWRITING: text blocks only, and
   the strip that removed the ink.

   This file was rewritten when handwriting was removed (16 August
   2026, Grace and Jared's decision — feature AND data). The old
   claims that died with the feature: the strokes half of the inverse
   theorem, inkOf's reference-identity contract, ink-vs-text block
   ordering, the note-level pen latch, and the encode-on-save chain.
   What replaced them is the strip's own contract, which is now the
   most destructive code in the file and therefore the most tested:

   - remove ink, NEVER remove notes — an ink-only note becomes an
     empty text note keeping its title
   - a text+ink note keeps its text, byte for byte
   - tombstones and AI stubs are left entirely alone
   - the pass runs ONCE (flag-guarded), bumps updatedAt so the removal
     wins merges, and returns the same references when there is
     nothing to do
   - noteFields drops ink on every save, so a note resurrected by a
     pre-removal device is re-stripped by its next edit

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEXT,
  LEGACY_INK,
  isBlockNote,
  blocksOf,
  fieldsFromBlocks,
  htmlOf,
  bodyOf,
  newTextBlock,
  withBlock,
  mergeTextBack,
  removeBlock,
  noteFields,
  pageHasInk,
  stripInkFromPage,
  removeHandwriting,
} from "../src/noteBlocks.js";
import { mergeData } from "../src/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    /* A synchronous runner given an async fn gets a promise, throws
       nothing, and counts a pass — while every assertion inside runs
       after the summary and the exit code. Refuse rather than ignore. */
    if (r && typeof r.then === "function") {
      throw new Error("this runner is synchronous — an async test would be reported green whatever it asserts");
    }
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const AT = "2026-08-16T15:00:00.000Z";
const EARLIER = "2026-07-01T00:00:00.000Z";
const stroke = () => ({ color: "#1c1917", width: 3, points: [[10, 20, 0.5], [30, 40, 0.5]] });
const encodedStroke = () => ({ color: "#1c1917", width: 3, erase: false, v: 2, o: [100, 200, 50], d: [4, 4, 0] });

const typed = (over = {}) => ({
  id: "p1",
  title: "Typed",
  html: "<p>Hello</p>",
  body: "Hello",
  strokes: [],
  style: "lined",
  kind: "text",
  font: "sans",
  updatedAt: EARLIER,
  ...over,
});

/* ---------- the block view, text-only ---------- */

test("a typed note is one text block, and the theorem still inverts for text", () => {
  const p = typed();
  const blocks = blocksOf(p);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, TEXT);
  const f = fieldsFromBlocks(blocks);
  assert.equal(f.html, p.html);
  assert.equal(f.body, p.body);
});

test("legacy strokes are IGNORED by derivation — handwriting no longer derives to anything", () => {
  const p = typed({ strokes: [stroke()] });
  const blocks = blocksOf(p);
  assert.equal(blocks.length, 1, "an ink block was derived for removed content");
  assert.equal(blocks[0].type, TEXT);
});

test("an empty note derives to [], which inverts to empty fields", () => {
  const f = fieldsFromBlocks(blocksOf(typed({ html: "", body: "" })));
  assert.equal(f.html, "");
  assert.equal(f.body, "");
});

test("block ids are derived from the page id, never minted", () => {
  const a = blocksOf(typed());
  const b = blocksOf(typed());
  assert.equal(a[0].id, b[0].id, "two derivations of the same note disagree about its block ids");
});

test("AI notes and reference sheets are not block notes", () => {
  assert.equal(blocksOf({ id: "x", aiMeta: {} }), null);
  assert.equal(blocksOf({ id: "x", kind: "formula", entries: [] }), null);
  assert.equal(isBlockNote(null), false);
});

test("the convenience readers return what the page holds, both shapes", () => {
  const legacy = typed();
  assert.equal(htmlOf(legacy), legacy.html);
  assert.equal(bodyOf(legacy), legacy.body);
  const asBlocks = typed({ html: "", body: "", blocks: [{ id: "p1:t0", type: TEXT, html: "<p>B</p>", body: "B" }] });
  assert.equal(bodyOf(asBlocks), "B");
});

/* ---------- editing ---------- */

test("backspace at the top of the note is refused", () => {
  const blocks = [newTextBlock([], "p1")];
  assert.equal(mergeTextBack(blocks, blocks[0].id), null);
});

test("backspace merges two text blocks and puts the caret at the join", () => {
  const a = { id: "p1:t0", type: TEXT, html: "<p>one</p>", body: "one" };
  const b = { id: "p1:t1", type: TEXT, html: "<p>two</p>", body: "two" };
  const r = mergeTextBack([a, b], b.id);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].body, "onetwo");
  assert.equal(r.caretAt, 3);
});

test("backspace against a legacy ink block (not yet stripped) is still refused", () => {
  const ink = { id: "p1:i0", type: LEGACY_INK, strokes: [stroke()] };
  const b = { id: "p1:t1", type: TEXT, html: "", body: "" };
  assert.equal(mergeTextBack([ink, b], b.id), null, "merged 'into' an ink block — the stack is corrupted");
});

test("removing the last block leaves somewhere to type", () => {
  const only = newTextBlock([], "p1");
  const out = removeBlock([only], only.id);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, TEXT);
});

test("withBlock patches one block and leaves every other reference alone", () => {
  const a = { id: "a", type: TEXT, html: "", body: "" };
  const b = { id: "b", type: TEXT, html: "", body: "" };
  const out = withBlock([a, b], "b", { body: "x" });
  assert.equal(out[0], a);
  assert.equal(out[1].body, "x");
});

/* ---------- the save path ---------- */

test("noteFields drops ink blocks on save — the strip's second half", () => {
  const d = typed({
    blocks: [
      { id: "p1:t0", type: TEXT, html: "<p>kept</p>", body: "kept" },
      { id: "p1:i0", type: LEGACY_INK, strokes: [encodedStroke()] },
    ],
  });
  const saved = noteFields(d);
  assert.equal(saved.blocks.length, 1);
  assert.equal(saved.blocks[0].body, "kept");
  assert.deepEqual(saved.strokes, [], "the legacy strokes key must be written empty, not omitted — patchItem spreads");
});

test("noteFields writes strokes: [] for every shape, so a pre-removal build reads a normal empty note", () => {
  assert.deepEqual(noteFields(typed()).strokes, []);
  assert.deepEqual(noteFields(typed({ blocks: [], strokes: [stroke()] })).strokes, []);
  // Unconverted legacy note with strokes: stripped on save too.
  const legacy = typed({ strokes: [stroke()] });
  delete legacy.blocks;
  assert.deepEqual(noteFields(legacy).strokes, []);
});

test("a reference sheet keeps its entries through noteFields", () => {
  const sheet = { id: "s", title: "S", kind: "formula", entries: [{ id: "e", label: "L", body: "B" }], style: "lined" };
  assert.equal(noteFields(sheet).entries.length, 1);
});

/* ---------- the strip: remove ink, never remove notes ---------- */

test("a note that was ONLY handwriting becomes an empty text note KEEPING ITS TITLE", () => {
  const p = { id: "d1", title: "Lecture 4 diagram", body: "", html: "", strokes: [stroke(), stroke()], kind: "drawing", folderId: "f1", updatedAt: EARLIER };
  const s = stripInkFromPage(p, AT);
  assert.equal(s.title, "Lecture 4 diagram", "the title is user content and must survive");
  assert.equal(s.folderId, "f1", "its place in a folder is information");
  assert.deepEqual(s.strokes, []);
  assert.equal(s.kind, "text");
  assert.equal(s.updatedAt, AT, "the removal is a real edit and must win merges");
});

test("a text+ink note keeps its text byte for byte and loses only the ink", () => {
  const p = typed({
    blocks: [
      { id: "p1:t0", type: TEXT, html: "<p>the essay plan</p>", body: "the essay plan" },
      { id: "p1:i0", type: LEGACY_INK, strokes: [encodedStroke()], h: 700 },
      { id: "p1:t1", type: TEXT, html: "<p>after the diagram</p>", body: "after the diagram" },
    ],
  });
  const s = stripInkFromPage(p, AT);
  assert.deepEqual(s.blocks.map((b) => b.type), [TEXT, TEXT]);
  assert.equal(bodyOf(s), "the essay planafter the diagram");
});

test("a clean page comes back BY REFERENCE, so a pass over stripped data writes nothing", () => {
  const p = typed();
  assert.equal(stripInkFromPage(p, AT), p);
});

test("tombstones are left entirely alone — payload, stamps, everything", () => {
  const dead = { id: "d", title: "x", strokes: [stroke()], deletedAt: EARLIER, updatedAt: EARLIER };
  assert.equal(stripInkFromPage(dead, AT), dead, "restamping a dead item only extends its purge life");
});

test("AI-note stubs are untouched — their strokes have always been []", () => {
  const stub = { id: "s", title: "PHYS", strokes: [], aiMeta: { remote: true, previews: {} }, updatedAt: EARLIER };
  assert.equal(stripInkFromPage(stub, AT), stub);
  assert.equal(pageHasInk(stub), false);
});

test("the pass is flag-guarded: it runs once and a second run is a no-op by reference", () => {
  const data = {
    semesters: { "Semester 1": { pages: [typed({ strokes: [stroke()] })], todos: [] } },
    meta: { updatedAt: EARLIER },
  };
  const once = removeHandwriting(data, AT);
  assert.equal(once.meta.inkRemoved, true);
  assert.deepEqual(once.semesters["Semester 1"].pages[0].strokes, []);
  assert.equal(removeHandwriting(once, AT), once, "the pass ran again — two devices would fight through last-write-wins");
});

test("the flag is best-effort across merges, and CONVERGENCE is what makes losing it safe", () => {
  /* mergeData spreads {...local.meta, ...newerSide.meta}. When the
     flag is on LOCAL it survives either direction (a spread never
     deletes a key the other side lacks). When the flag is only on a
     NON-NEWER REMOTE, it is lost — local is the newer side, so
     local.meta is the only meta spread. That direction is real and
     this test does not pretend otherwise. */
  const stripped = { meta: { updatedAt: AT, inkRemoved: true }, semesters: {} };
  const oldDevice = { meta: { updatedAt: "2026-08-20T00:00:00.000Z" }, semesters: {} };

  // The covered directions: the flag on local survives a newer flagless remote.
  assert.equal(mergeData(stripped, oldDevice).meta.inkRemoved, true, "a newer pre-removal meta erased the local flag");
  // The lost direction, asserted AS lost so a future mergeData change is noticed either way.
  assert.equal(mergeData(oldDevice, stripped).meta.inkRemoved, undefined, "mergeData now preserves the remote flag — the convergence rationale below is obsolete, simplify");

  /* Why the loss is harmless: the merged data is already stripped, so
     re-running the pass touches NOTHING — every page comes back by
     reference, no updatedAt moves, so no edit propagates and two
     devices cannot fight through last-write-wins. The re-run's only
     effect is re-setting the flag. Convergence, not the flag, is the
     guarantee. */
  const preRemoval = {
    meta: { updatedAt: "2026-08-20T00:00:00.000Z" },
    semesters: { S: { pages: [stripInkFromPage(typed({ strokes: [stroke()] }), AT)], todos: [] } },
  };
  const merged = mergeData(preRemoval, stripped);
  const rerun = removeHandwriting(merged, "2026-08-21T00:00:00.000Z");
  assert.equal(rerun.meta.inkRemoved, true);
  assert.equal(rerun.semesters.S.pages[0], merged.semesters.S.pages[0], "the re-run rebuilt a stripped page — an edit with nothing behind it");
  assert.equal(rerun.semesters.S.pages[0].updatedAt, AT, "the re-run bumped updatedAt on clean data — two devices would fight forever");
});

test("the stripped note WINS the merge against its pre-removal self", () => {
  const withInk = typed({ strokes: [stroke()] });
  const stripped = stripInkFromPage(withInk, AT);
  const local = { meta: { updatedAt: EARLIER }, semesters: { S: { pages: [withInk] } } };
  const remote = { meta: { updatedAt: AT }, semesters: { S: { pages: [stripped] } } };
  const merged = mergeData(local, remote);
  assert.deepEqual(merged.semesters.S.pages[0].strokes, [], "the ink came back through the merge");
});

/* ---------- the wiring ---------- */

test("normalizeData runs the strip, so both restore paths are covered", () => {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  assert.match(src, /return removeHandwriting\(out, nowISO\(\)\)/, "normalizeData no longer strips — a restored backup resurrects every drawing");
});

test("archive restore strips too — the second resurrection door", () => {
  const src = fs.readFileSync(path.join(rootDir, "src/semesterArchive.js"), "utf8");
  assert.match(src, /stripInkFromPage\(live, at\)/, "restoreTransform no longer strips — a pre-removal archive restores its ink");
});

test("ink.js is gone, and nothing imports it", () => {
  assert.ok(!fs.existsSync(path.join(rootDir, "src/ink.js")), "the file is back");
  for (const f of fs.readdirSync(path.join(rootDir, "src")).filter((x) => /\.jsx?$/.test(x))) {
    const src = fs.readFileSync(path.join(rootDir, "src", f), "utf8");
    assert.ok(!src.includes('from "./ink.js"'), `${f} still imports the deleted module`);
  }
});

test("the husk previews as 'Empty note', not as a stroke count or a blank row", () => {
  const raw = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  assert.match(raw, />Empty note</, "an ink-only note's husk now renders a blank row");
  /* Strip comments before grepping — the explanation of why the husk
     copy exists mentions "stroke count", and a guard that trips on
     its own documentation is the recurring trap (fifth instance). */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!/stroke\{?s?\}? ?count|stroke\$\{|\bstrokes\.length\b.*stroke/.test(code), "a stroke count survived in the UI");
});

test("npm test still runs this file", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /test-note-blocks\.mjs/);
  assert.ok(!/test-ink\.mjs/.test(pkg.scripts.test), "the deleted ink suite is still named");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
