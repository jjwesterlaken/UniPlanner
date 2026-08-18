/* CONVERTING A NOTE MUST NOT CHANGE HOW IT LOOKS — POST-HANDWRITING.

   Step 4 converts lazily: the first time a student edits an existing
   note, it is rewritten from html/body into `blocks`. That conversion
   happens without asking and without telling them, so the only
   acceptable outcome is that they cannot tell. This file renders the
   same note both ways through the same bundle and compares what a
   student can actually see.

   WHAT CHANGED WHEN HANDWRITING WAS REMOVED (16 August 2026). Ink was
   half of what this file measured: the recording canvas context, the
   encoded-note comparison, and the ink block in the ordering corpus
   all existed because strokes drew pixels no HTML diff could see.
   The strokes are gone — from the feature and from the data, stripped
   at load by removeHandwriting — so those claims died. What replaced
   them is their negative, which is now a guard on the removal itself:

   - a pre-removal note carrying strokes renders IDENTICALLY in its
     legacy shape and its blocks shape — as the same stripped note
   - NO reader mounts a canvas any more, on any screen this walks
   - an ink-only note renders as the "Empty note" husk, not a blank
   - a LEGACY_INK block inside a blocks note renders nothing and
     crashes nothing

   The corpus deliberately KEEPS its stroke-carrying fixtures. They are
   exactly the data a real pre-removal account still holds, and the
   walk proves the app renders them without a canvas, without a crash,
   and without a stroke count.

   WHY NOT BYTE-IDENTICAL HTML. That was the bar in step 3 and it was
   the right one there, because the claim was that NOTHING changed. It
   is the wrong bar here: a converted note is rendered by the stack
   renderer, so it legitimately gains a wrapper element even when it
   holds a single block. The comparison is over the things a student
   can point at — the VISIBLE TEXT and the TYPEFACE classes.

   The canvas context still RECORDS (a stub that swallows calls made
   half of step 3's test blind — found by mutation), so if a canvas
   ever mounts again its drawing lands in the snapshot and the
   no-canvas check goes red with evidence rather than silence. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { blocksOf, isBlockNote, stripInkFromPage } from "../src/noteBlocks.js";

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

/* ------------------------------------------------------------------ */
/*  The planner both sides render                                     */
/* ------------------------------------------------------------------ */

/* The clock every mount runs on. The load-time strip bumps updatedAt
   on any page it touches, so the blocks-side corpus below is stripped
   with the SAME instant — otherwise the comparison would be measuring
   the fixture, not the renderer. */
const FROZEN_NOW = "2026-08-14T09:00:00.000Z";

/* Pre-removal stroke shapes, kept verbatim: this is what a real
   account that drew before the removal still syncs today. */
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
   test anyway. */

/* The blocks form only ever exists POST-strip: conversion happens on
   save, and every save runs noteFields, which drops ink. So the blocks
   variant is derived from the stripped page — the same page the legacy
   side becomes at load. */
const asBlocks = (page) => {
  const p = stripInkFromPage(page, FROZEN_NOW);
  return isBlockNote(p) ? { ...p, blocks: blocksOf(p), html: "", body: "", strokes: [] } : p;
};

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

  const FIXED = Date.parse(FROZEN_NOW);
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

  /* The recording canvas context, kept from step 3. Nothing should
     mount a canvas any more — but if a reader regresses to one, this
     is what makes its drawing part of the snapshot instead of an
     invisible rectangle two runs would agree about. */
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

/* The HTML, plus what was drawn on any canvas in it (there should be
   none — see checkNoCanvas). */
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
   commit ever runs. */
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

/* A typed note and an ink-only husk: RichTextEditor reads htmlOf for
   the first, and the second proves the husk opens in the TEXT editor
   — there is no other editor left for it to open in. */
const EDITOR_INDEXES = [0, 2];

async function captureAll(js, pages) {
  const shots = await captureReading(js, pages);
  for (const i of EDITOR_INDEXES) shots[`edit:${pages[i].id}`] = await captureEditor(js, pages, i);
  return shots;
}

/* The removal's own guard: NO screen this file walks may mount a
   canvas. The recording context guarantees that if one ever does, its
   drawing is in the snapshot — so this check failing comes with the
   evidence attached. */
function checkNoCanvas(label, shots) {
  const offenders = Object.entries(shots)
    .filter(([, s]) => String(s).includes("<canvas"))
    .map(([k]) => k);
  check(
    offenders.length === 0,
    `${label}: no reader mounts a canvas any more`,
    offenders.length ? `canvas found in: ${offenders.join(", ")}` : null
  );
}

/* What a student can point at: the words and the typeface. Everything
   else in the markup is the renderer's business. */
function visibleOf(snapshot) {
  const [html, ink = ""] = String(snapshot).split("\n<!-- ink -->\n");
  const text = html
    .replace(/<[^>]*>/g, "")
    .split("")
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

console.log("\nblocks: behaviour-neutral (post-handwriting)");

const current = await bundleFrom(rootDir);

/* ---------- the same note, converted ---------- */

{
  /* The legacy side seeds the PRE-REMOVAL shapes — strokes and all —
     and relies on the load-time strip. The blocks side seeds what the
     first post-removal save produces. A student whose note was
     converted must not be able to tell which they are looking at. */
  const legacyShots = await captureAll(current, PAGES);
  const blockShots = await captureAll(current, PAGES.map(asBlocks));
  compare("converted", legacyShots, blockShots);
  checkNoCanvas("legacy", legacyShots);
  checkNoCanvas("blocks", blockShots);

  /* The husk, as ordered: an ink-only note's list preview must read
     sensibly — not a stroke count, not a blank row. Asserted in the
     real mount, not by grepping the source. */
  check(
    String(legacyShots.list).includes("Empty note"),
    "the ink-only husk previews as 'Empty note' in the real list",
    "n3 lost its strokes and its row now shows nothing at all"
  );
  check(
    String(legacyShots.list).includes("Lecture sketch"),
    "the husk KEPT ITS TITLE in the list",
    "the ink-only note's title is gone from the list"
  );

  const converted = PAGES.map(asBlocks).filter((p) => Array.isArray(p.blocks));
  check(
    converted.length === PAGES.length - 1,
    "every note but the reference sheet was really stored as blocks",
    `${converted.length} of ${PAGES.length - 1}`
  );
  check(
    converted.every((p) => !p.html && !p.body && !p.strokes.length),
    "the converted variant carries NO legacy fields",
    "a reader could have been reading the legacy copy the whole time"
  );
}

/* ---------- order is a visible property, and legacy ink renders nothing ---------- */

{
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
      { id: `${id}:t1`, type: "text", html: "<p>OMEGA</p>", body: "OMEGA" },
    ],
  };
  const reversed = { ...textFirst, blocks: [textFirst.blocks[1], textFirst.blocks[0]] };

  const a = await captureReading(current, [textFirst]);
  const b = await captureReading(current, [reversed]);
  check(a[`view:${id}`] !== b[`view:${id}`], "block ORDER is visible in the rendered note", "reordering the blocks changed nothing — the stack is not being rendered in order");

  const html = a[`view:${id}`];
  check(html.indexOf("ALPHA") < html.indexOf("OMEGA"), "text blocks render in stack order");
  check(html.includes("ALPHA") && html.includes("OMEGA"), "a note with two text blocks renders BOTH", "the second text block was dropped");

  /* A blocks note a pre-removal device wrote can still hold a
     LEGACY_INK block until its next save strips it. It must render as
     if absent: no canvas, no crash, both text blocks intact. */
  const withLegacyInk = {
    ...textFirst,
    blocks: [textFirst.blocks[0], { id: `${id}:i0`, type: "ink", strokes: [stroke(6)], h: 700 }, textFirst.blocks[1]],
  };
  const c = await captureReading(current, [withLegacyInk]);
  const inkHtml = c[`view:${id}`];
  check(!String(inkHtml).includes("<canvas"), "a legacy ink block renders NO canvas", "the ink renderer is back");
  check(
    inkHtml.includes("ALPHA") && inkHtml.includes("OMEGA"),
    "text on both sides of a legacy ink block still renders",
    "a legacy ink block took its neighbours down with it"
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
