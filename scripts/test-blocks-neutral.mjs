/* CONVERTING A NOTE MUST NOT CHANGE HOW IT LOOKS.

   Step 4 converts lazily: the first time a student edits an existing
   note, it is rewritten from html/body/strokes into `blocks`. That
   conversion happens without asking and without telling them, so the
   only acceptable outcome is that they cannot tell. This file renders
   the same note both ways through the same bundle and compares what a
   student can actually see.

   WHY NOT BYTE-IDENTICAL HTML. That was the bar in step 3 and it was
   the right one there, because the claim was that NOTHING changed. It
   is the wrong bar here: a converted note is rendered by the stack
   renderer, so it legitimately gains a wrapper element even when it
   holds a single block. Insisting on byte-identity would mean
   contorting the renderer to satisfy a test rather than a user.

   So the comparison is over the things a student can point at -- the
   VISIBLE TEXT, the INK actually drawn, and the TYPEFACE classes -- and
   dropping the stronger check is recorded here rather than quietly
   loosened. What it still catches: a dropped block, reordered content,
   lost strokes, a note that renders empty after conversion, a font that
   stops being applied. What it no longer catches: pure markup churn,
   which is what it was asked to stop catching.

   WHAT THIS FILE USED TO BE, and why it changed. In step 3 it also
   built the bundle from the PREVIOUS COMMIT and compared the whole app
   against it, which is what demonstrated that introducing `blocksOf`
   changed nothing anyone could see. That comparison has now expired,
   exactly as its header said it would: step 4 changes the editor on
   purpose, and the faint-writing fix changes how every stroke is drawn
   on purpose. A guard that has to be suppressed to let intended changes
   through is not a guard. It is deleted rather than pinned to a moving
   baseline, and this is the claim that replaced it.

   THE ORDERING CLAIM IS NEW AND ONLY MEANINGFUL NOW. In step 3, block
   order was unobservable -- readers concatenated all text then all ink,
   so reversing blocksOf changed nothing. NoteView now renders the stack
   in order, so order is a visible property and is asserted directly.

   A stub that swallows the canvas calls would make half of this blind
   -- found by mutation in step 3, when reverting a reader to
   page.strokes left every byte identical. The context RECORDS, and the
   log is part of the snapshot. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { blocksOf, isBlockNote } from "../src/noteBlocks.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
const check = (ok, name, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`FAIL  - ${name}`);
    if (detail) console.error(`        ${detail}`);
  }
};

const git = (args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();

/* ------------------------------------------------------------------ */
/*  The planner both sides render                                     */
/* ------------------------------------------------------------------ */

/* Every shape a page is stored in, including the two awkward ones that
   only exist because fieldsOf writes html/body onto every page —
   a handwritten note carrying stray html, and a typed note carrying
   stray strokes. Those are where a derivation that reordered blocks
   would show up on screen. */
const stroke = (n, erase = false) => ({
  color: "#1c1917",
  width: 3,
  erase,
  points: Array.from({ length: n }, (_, i) => [10 + i * 3.4, 20 + i * 1.1, 0.5]),
});

const PAGES = [
  { id: "n1", title: "Osmosis", kind: "text", style: "lined", font: "sans", html: "<p>Water moves down its gradient.</p>", body: "Water moves down its gradient.", strokes: [] },
  { id: "n2", title: "Rich only", kind: "text", style: "plain", font: "serif", html: "<p><b>bold</b> and <i>italic</i></p>", body: "", strokes: [] },
  { id: "n3", title: "Lecture sketch", kind: "drawing", style: "grid", font: "sans", html: "", body: "", strokes: [stroke(6), stroke(4, true)] },
  { id: "n4", title: "Sketch with stray html", kind: "drawing", style: "lined", font: "sans", html: "<p>leftover</p>", body: "leftover", strokes: [stroke(5)] },
  { id: "n5", title: "Typed with stray strokes", kind: "text", style: "lined", font: "mono", html: "<p>typed</p>", body: "typed", strokes: [stroke(3)] },
  { id: "n6", title: "Empty", kind: "text", style: "lined", font: "sans", html: "", body: "", strokes: [] },
  { id: "n7", title: "Formulae", kind: "formula", style: "plain", font: "mono", entries: [{ id: "e1", label: "Quadratic", body: "x = (-b ± √(b²-4ac)) / 2a" }] },
].map((p) => ({ folderId: null, updatedAt: "2026-08-01T00:00:00.000Z", ...p }));

/* An AI stub is deliberately NOT seeded. Opening one reaches fetchNote
   and the note cache, whose timing is not something two separate jsdom
   runs agree on to the millisecond — and it is covered by the smoke
   test anyway. This file is about the readers step 3 moved. */

/* A page whose legacy fields flatten to more than one block -- those
   are the shapes where conversion is NOT expected to be invisible,
   because the stack now renders in order and the flattened form never
   could. They are covered by the ordering section instead. */
const isMulti = (p) => (p.html || p.body) && (p.strokes || []).length > 0;

const asBlocks = (page) =>
  isBlockNote(page)
    ? { ...page, blocks: blocksOf(page), html: "", body: "", strokes: [] }
    : page;

const seedFor = (pages) => ({
  semester: "Semester 1",
  semesters: { "Semester 1": { pages } },
  meta: { updatedAt: "2026-08-01T00:00:00.000Z" },
});

/* ------------------------------------------------------------------ */
/*  Bundling                                                          */
/* ------------------------------------------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blocks-neutral-"));
const demoConfig = path.join(tmp, "config-demo.js");
fs.writeFileSync(
  demoConfig,
  'export const SUPABASE_URL = "PASTE_YOUR_URL";\n' +
    'export const SUPABASE_ANON_KEY = "PASTE_YOUR_KEY";\n' +
    "export const isConfigured = false;\n"
);

async function bundleFrom(treeDir) {
  const out = await build({
    entryPoints: [path.join(treeDir, "src/main.jsx")],
    bundle: true,
    format: "iife",
    jsx: "automatic",
    write: false,
    // Both trees resolve react from the one real install, so a version
    // difference can never be what the comparison is measuring.
    nodePaths: [path.join(rootDir, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "force-demo-config",
        setup(b) {
          b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}

/* ------------------------------------------------------------------ */
/*  Rendering                                                         */
/* ------------------------------------------------------------------ */

/* Everything that would differ between two runs of the same code is
   pinned here, so a difference in the captured HTML can only be a
   difference in the code. */
function boot(js, pages) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: "outside-only",
    url: "https://example.test/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.console.error = () => {};
  w.console.warn = () => {};

  const FIXED = Date.parse("2026-08-14T09:00:00.000Z");
  const RealDate = w.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED);
      else super(...args);
    }
    static now() {
      return FIXED;
    }
  }
  w.Date = FrozenDate;
  w.Math.random = () => 0.42;
  Object.defineProperty(w, "devicePixelRatio", { value: 2, configurable: true });

  /* jsdom has no 2D context, and A STUB THAT SWALLOWS THE CALLS MAKES
     THIS TEST BLIND TO INK. Found by mutation: reverting the note
     viewer to `page.strokes` — the exact "reader left behind" this file
     exists to catch — left every byte of HTML identical, because a
     canvas with six strokes and a canvas with none are the same
     element. Handwriting is half of what step 3 touched, so half the
     test was decorative.

     So the context RECORDS instead. Every call and every property set
     goes into a per-canvas log, which the snapshot carries alongside
     the HTML — the drawing becomes comparable bytes.

     The log resets on clearRect, which is the first thing both redraw
     paths do. That is what makes it insensitive to HOW MANY times the
     canvas was redrawn: only the last complete redraw survives, so an
     extra render changes nothing while a different PICTURE changes
     everything. */
  const traces = new WeakMap();
  const fmt = (v) => (typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v));
  w.__traceOf = (el) => traces.get(el) || [];
  w.HTMLCanvasElement.prototype.getContext = function () {
    const el = this;
    if (!traces.has(el)) traces.set(el, []);
    return new Proxy(
      {},
      {
        get(t, k) {
          if (k === "canvas") return el;
          return (...args) => {
            const log = traces.get(el);
            if (k === "clearRect") log.length = 0;
            else log.push(`${String(k)}(${args.map(fmt).join(",")})`);
          };
        },
        set(t, k, v) {
          traces.get(el).push(`${String(k)}=${fmt(v)}`);
          return true;
        },
      }
    );
  };

  w.navigator.mediaDevices = {
    getUserMedia: async () => {
      throw new Error("not in this test");
    },
    getDisplayMedia: async () => {
      throw new Error("not in this test");
    },
    enumerateDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  w.localStorage.setItem("uni-planner-v1", JSON.stringify(seedFor(pages)));
  w.eval(js);
  return dom;
}

const settle = (ms = 160) => new Promise((r) => setTimeout(r, ms));

/* The HTML, plus what was drawn on every canvas in it. Without the
   second half a handwritten note is an empty rectangle to this test. */
const snap = (dom) => {
  const root = dom.window.document.getElementById("root");
  const ink = [...root.querySelectorAll("canvas")]
    .map((c, i) => `canvas#${i} ${c.width}x${c.height}\n${dom.window.__traceOf(c).join("\n")}`)
    .join("\n");
  return ink ? `${root.innerHTML}\n<!-- ink -->\n${ink}` : root.innerHTML;
};
const buttons = (dom, label) => [...dom.window.document.querySelectorAll(`button[aria-label="${label}"]`)];
const named = (dom, text) =>
  [...dom.window.document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);

async function openNotes(dom) {
  const tab = named(dom, "Notes");
  if (!tab) throw new Error("the Notes tab was not reachable");
  tab.click();
  await settle();
}

/* The list, then every note's read-only view. One boot: the viewer sets
   no draft, so nothing autosaves and the walk cannot perturb what the
   next capture sees. */
async function captureReading(js, pages) {
  const dom = boot(js, pages);
  await settle(300);
  await openNotes(dom);

  const shots = { list: snap(dom) };
  /* The accordion: rows expand in place via the chevron, one at a time,
     and collapse via the same control. Uniform across every note type,
     which retired the old sheet-closes-differently special case. */
  const rows = buttons(dom, "Expand note");
  if (rows.length !== pages.length) throw new Error(`expected ${pages.length} note rows, saw ${rows.length}`);

  for (let i = 0; i < rows.length; i++) {
    buttons(dom, "Expand note")[i].click();
    await settle();
    shots[`view:${pages[i].id}`] = snap(dom);
    const back = dom.window.document.querySelector('[aria-label="Collapse note"]');
    if (!back) throw new Error(`no way to collapse the view of ${pages[i].id}`);
    back.click();
    await settle();
  }
  dom.window.close();
  return shots;
}

/* The EDITOR, one boot per note.

   Separate because opening the editor arms the 1200ms autosave, and a
   commit part-way through a walk would change what every later capture
   sees. Capturing at ~160ms and then discarding the window means no
   commit ever runs — which also keeps this test off step 4's territory:
   `fieldsOf` still reads the legacy fields, so a Done click on a
   block-shape note would empty it today. That is the editor's job to
   fix, and it is why nothing here clicks Done. */
async function captureEditor(js, pages, index) {
  const dom = boot(js, pages);
  await settle(300);
  await openNotes(dom);
  buttons(dom, "Expand note")[index].click();
  await settle();
  const edit = named(dom, "Edit");
  if (!edit) throw new Error(`no Edit button on ${pages[index].id}`);
  edit.click();
  await settle();
  const shot = snap(dom);
  dom.window.close();
  return shot;
}

/* A typed note and a handwritten one: RichTextEditor reads htmlOf, and
   DrawingCanvas reads inkOf, so one of each is what covers the two
   editor readers step 3 moved. */
const EDITOR_INDEXES = [0, 2];

async function captureAll(js, pages) {
  const shots = await captureReading(js, pages);
  for (const i of EDITOR_INDEXES) shots[`edit:${pages[i].id}`] = await captureEditor(js, pages, i);
  return shots;
}

/* The comparison is only as good as what got captured. A snapshot of a
   handwritten note that carries no drawing calls means the recording
   context has stopped working, and every "byte-identical" above it is
   two empty rectangles agreeing. */
function checkInkWasCaptured(label, shots, id) {
  const shot = shots[`view:${id}`] || "";
  check(
    shot.includes("lineTo(") && shot.includes("strokeStyle="),
    `${label}: the handwritten note's drawing was actually captured`,
    "no drawing calls in the snapshot — the canvas half of this test is not measuring anything"
  );
}

/* What a student can point at: the words, the drawing, the typeface.
   Everything else in the markup is the renderer's business. */
function visibleOf(snapshot) {
  const [html, ink = ""] = String(snapshot).split("\n<!-- ink -->\n");
  const text = html
    .replace(/<[^>]*>/g, "\u0001")
    .split("\u0001")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" | ");
  const fonts = [...html.matchAll(/font-(serif|mono)|lined-paper/g)].map((m) => m[0]).join(",");
  return `TEXT ${text}\nFONTS ${fonts}\nINK ${ink}`;
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 90);
  return `at char ${i}\n          before: …${a.slice(from, i + 90)}…\n          after:  …${b.slice(from, i + 90)}…`;
}

function compare(label, before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const key of keys) {
    if (!(key in before) || !(key in after)) {
      check(false, `${label}: ${key} rendered on both sides`, "one side did not produce this screen at all");
      continue;
    }
    const a = visibleOf(before[key]);
    const b = visibleOf(after[key]);
    check(a === b, `${label}: ${key} looks the same`, a === b ? null : firstDifference(a, b));
  }
}

console.log("\nblocks: behaviour-neutral");

const current = await bundleFrom(rootDir);

/* ---------- the same note, converted ---------- */

{
  /* A SIMPLE note -- one text block, or one ink block -- is what almost
     every existing note converts to, so this is the case that decides
     whether the conversion is invisible to real users. */
  const simple = PAGES.filter((p) => !isMulti(p));
  const legacyShots = await captureAll(current, simple);
  const blockShots = await captureAll(current, simple.map(asBlocks));
  compare("converted", legacyShots, blockShots);
  checkInkWasCaptured("converted", blockShots, "n3");

  const converted = simple.map(asBlocks).filter((p) => Array.isArray(p.blocks));
  check(
    converted.length === simple.length - 1,
    "every note but the reference sheet was really stored as blocks",
    `${converted.length} of ${simple.length - 1}`
  );
  check(
    converted.every((p) => !p.html && !p.body && !p.strokes.length),
    "the converted variant carries NO legacy fields",
    "a reader could have been reading the legacy copy the whole time"
  );
}

/* ---------- an encoded note draws the same ink ---------- */

{
  /* Ink compression stores strokes delta-encoded, and every renderer
     reads through pointsOf. This renders the same handwriting raw and
     encoded and compares what was DRAWN — the canvas trace — because a
     renderer still reading stroke.points would draw an encoded note as
     an empty rectangle while every byte of HTML stayed identical. */
  /* encodeStroke alone, NOT encodeStrokes: the save chain also
     simplifies, which deliberately drops points within its tolerance —
     and the corpus strokes are straight lines that collapse to their
     endpoints, so comparing against the save chain measured the lossy
     stage, not the encoding. First run of this test failed exactly
     there, correctly. Encoding must be render-invisible; simplification
     is bounded instead, by its own test. */
  const { encodeStroke } = await import("../src/ink.js");
  const raw = PAGES.find((p) => p.id === "n3");
  const encoded = {
    ...raw,
    blocks: [{ id: "n3:i0", type: "ink", strokes: raw.strokes.map(encodeStroke), h: 1400 }],
    html: "", body: "", strokes: [],
  };
  const a = await captureReading(current, [raw]);
  const b = await captureReading(current, [encoded]);
  const inkOfShot = (shot) => String(shot).split("\n<!-- ink -->\n")[1] || "";
  check(
    inkOfShot(a["view:n3"]).length > 100,
    "the raw side actually drew something, so the comparison is not two blanks"
  );
  check(
    inkOfShot(a["view:n3"]) === inkOfShot(b["view:n3"]),
    "AN ENCODED NOTE DRAWS THE SAME INK as its raw self",
    "the drawn strokes differ — a renderer is reading .points directly and seeing nothing"
  );
}

/* ---------- order is now a visible property ---------- */

{
  /* Reversing blocksOf was undetectable in step 3, because readers
     concatenated by type. NoteView renders the stack, so it is
     detectable now -- and this is the assertion that says so, rather
     than the file continuing to claim a coverage it does not have. */
  const id = "m1";
  const textFirst = {
    id,
    title: "Mixed",
    kind: "text",
    style: "lined",
    font: "sans",
    folderId: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    blocks: [
      { id: `${id}:t0`, type: "text", html: "<p>ALPHA</p>", body: "ALPHA" },
      { id: `${id}:i0`, type: "ink", strokes: [stroke(6)], h: 700 },
      { id: `${id}:t1`, type: "text", html: "<p>OMEGA</p>", body: "OMEGA" },
    ],
  };
  const inkFirst = { ...textFirst, blocks: [textFirst.blocks[1], textFirst.blocks[0], textFirst.blocks[2]] };

  const a = await captureReading(current, [textFirst]);
  const b = await captureReading(current, [inkFirst]);
  check(a[`view:${id}`] !== b[`view:${id}`], "block ORDER is visible in the rendered note", "reordering the blocks changed nothing — the stack is not being rendered in order");

  const html = a[`view:${id}`];
  check(html.indexOf("ALPHA") < html.indexOf("OMEGA"), "text blocks render in stack order");
  check(html.includes("ALPHA") && html.includes("OMEGA"), "a note with two text blocks renders BOTH", "the second text block was dropped");
  check((html.match(/<canvas/g) || []).length === 1, "the ink block between them renders as its own canvas");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
