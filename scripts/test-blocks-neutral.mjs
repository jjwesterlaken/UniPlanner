/* DEMONSTRATES that step 3 changed nothing anyone can see, rather than
   asserting it.

   test-note-blocks.mjs proves the inverse theorem — derivation is
   lossless, so a reader that goes through blocksOf sees the same bytes.
   That is a proof about the FUNCTION. It says nothing about whether I
   found every reader, and a reader I forgot to think about is exactly
   the failure a theorem cannot see. So this file renders the app and
   compares pixels-as-HTML:

     1. THE SAME PLANNER, RENDERED BY BOTH COMMITS. The bundle from the
        last commit that did not contain noteBlocks.js, and the bundle
        from the working tree, each mounted in jsdom over identical
        seeded data with the clock and Math.random frozen. Every notes
        screen captured and compared byte for byte. A reader left on the
        old path still renders identically, so this passes; a reader
        moved to a path that renders DIFFERENTLY fails, whatever the
        theorem says about the function it now calls.

     2. THE SAME NOTE IN BOTH SHAPES, RENDERED BY THE CURRENT BUNDLE.
        Legacy html/body/strokes against the same content stored as
        `blocks`, with the legacy fields emptied. Byte-identical output
        is the claim step 4 rests on: it may start writing blocks
        because every reader already handles both. (1) retires when the
        editor lands and the UI legitimately changes; this one does not.

   (1) needs git history. A shallow checkout has none, so it SKIPS —
   loudly, and REQUIRE_BASELINE=1 turns the skip into a failure, the same
   arrangement as REQUIRE_POSTGRES on the migration tests. CI sets
   fetch-depth: 0 so it really runs there.

   WHAT THIS FILE CANNOT SEE, established by mutation rather than
   guessed, because a guard whose hole is written down is worth more
   than one that looks thorough:

     BLOCK ORDER. Reversing blocksOf to always emit text-first leaves
     every screen byte-identical. Today's readers concatenate by TYPE
     (all text, then all ink), so with one block of each the order is
     genuinely unobservable. It becomes observable in step 4, when
     blocks render in sequence. test-note-blocks.mjs asserts it
     directly, and is the only thing that does.

     REFERENCE IDENTITY. inkOf returning a fresh array each call renders
     identically and redraws the canvas on every render. Also asserted
     in test-note-blocks.mjs; see the comment on inkOf. */

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
  const rows = buttons(dom, "Edit note");
  if (rows.length !== pages.length) throw new Error(`expected ${pages.length} note rows, saw ${rows.length}`);

  for (let i = 0; i < rows.length; i++) {
    buttons(dom, "Edit note")[i].click();
    await settle();
    shots[`view:${pages[i].id}`] = snap(dom);
    // A reference sheet closes with "Close" rather than "Back to notes".
    const back =
      dom.window.document.querySelector('[aria-label="Back to notes"]') ||
      dom.window.document.querySelector('[aria-label="Close"]');
    if (!back) throw new Error(`no way back from the view of ${pages[i].id}`);
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
  buttons(dom, "Edit note")[index].click();
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
function checkInkWasCaptured(label, shots) {
  const shot = shots["view:n3"] || "";
  check(
    shot.includes("lineTo(") && shot.includes("strokeStyle="),
    `${label}: the handwritten note's drawing was actually captured`,
    "no drawing calls in the snapshot — the canvas half of this test is not measuring anything"
  );
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
    check(before[key] === after[key], `${label}: ${key} is byte-identical`, before[key] === after[key] ? null : firstDifference(before[key], after[key]));
  }
}

console.log("\nblocks: behaviour-neutral");

const current = await bundleFrom(rootDir);

/* ---------- 1. against the commit before blocks existed ---------- */

/* DERIVED, not pinned: the parent of whichever commit added
   noteBlocks.js. A hardcoded sha is the restatement pattern — it would
   go on "passing" against a baseline that no longer means anything. */
function baselineCommit() {
  let added = "";
  try {
    added = git(["log", "--diff-filter=A", "--format=%H", "--", "src/noteBlocks.js"]).split("\n")[0];
  } catch {
    return null;
  }
  // Uncommitted: HEAD is itself the last commit without blocks.
  if (!added) return git(["rev-parse", "HEAD"]);
  try {
    return git(["rev-parse", `${added}^`]);
  } catch {
    return null; // shallow clone, or blocks landed in the root commit
  }
}

let worktree = null;
try {
  const base = baselineCommit();
  if (!base) throw new Error("no baseline commit is available (shallow clone?)");
  worktree = path.join(tmp, "baseline");
  git(["worktree", "add", "--detach", worktree, base]);

  const legacy = PAGES;
  const beforeShots = await captureAll(await bundleFrom(worktree), legacy);
  const afterShots = await captureAll(current, legacy);
  compare(`vs ${base.slice(0, 7)}`, beforeShots, afterShots);
  checkInkWasCaptured(`vs ${base.slice(0, 7)}`, afterShots);

  // A comparison of two empty strings passes and proves nothing.
  check(
    Object.values(afterShots).every((s) => s.length > 500),
    "every captured screen actually rendered something",
    "a screen came back near-empty, so the comparison above is vacuous"
  );
} catch (err) {
  const required = process.env.REQUIRE_BASELINE === "1";
  check(!required, "the differential against the previous commit ran", err.message);
  if (!required) console.log(`  SKIP  - differential vs the previous commit: ${err.message}`);
} finally {
  if (worktree) {
    try {
      git(["worktree", "remove", "--force", worktree]);
    } catch {
      /* the temp dir goes anyway */
    }
  }
}

/* ---------- 2. the same note in both shapes ---------- */

{
  /* This is the claim step 4 depends on, and unlike (1) it does not
     expire: whatever the editor changes, a note stored as blocks must
     go on rendering the same as the note it was converted from. */
  const legacyShots = await captureAll(current, PAGES);
  const blockShots = await captureAll(current, PAGES.map(asBlocks));
  compare("legacy vs blocks", legacyShots, blockShots);
  checkInkWasCaptured("legacy vs blocks", blockShots);

  // The block variant has to actually BE in block shape, or the two
  // sides are the same input and every comparison above is a tautology.
  const converted = PAGES.map(asBlocks).filter((p) => Array.isArray(p.blocks));
  check(converted.length === PAGES.length - 1, "every note but the reference sheet was really stored as blocks", `${converted.length} of ${PAGES.length - 1}`);
  check(
    converted.every((p) => !p.html && !p.body && !p.strokes.length),
    "the block variant carries NO legacy fields",
    "a reader could have been reading the legacy copy the whole time"
  );
  check(
    converted.some((p) => p.blocks.length > 1),
    "at least one note converted to more than one block",
    "single-block notes alone would not exercise ordering"
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
