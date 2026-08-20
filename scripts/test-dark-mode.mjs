/* Light and dark as an AXIS.

   WHAT THIS FILE PROVES NOW: the mode reaches the document, dark is
   genuinely different from light, every ground token has a value in
   both modes, the note paper does not flip, the dark accents are
   DERIVED from each palette rather than hand-picked, and the mode
   never enters the synced blob.

   WHAT IT USED TO PROVE, AND NO LONGER CAN: that tokenising the
   ground rendered BYTE-IDENTICAL light mode against the pre-token
   build. See the note in run() — that claim was verified when the
   sweep landed and expired the first time a UI change landed on top
   of it, exactly as test-blocks-neutral's git baseline did.

   The sweep it checked was small because it happened at the theme
   layer rather than at 557 call sites: `text-stone-500` still says
   "muted text" and only the value behind it moves.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const tmp = path.join(rootDir, ".dark-tmp");
fs.mkdirSync(tmp, { recursive: true });
const demoConfig = path.join(tmp, "config-demo.js");
fs.writeFileSync(
  demoConfig,
  'export const SUPABASE_URL = "x";\nexport const SUPABASE_ANON_KEY = "y";\nexport const isConfigured = false;\n'
);

const SEED = JSON.stringify({
  semester: "Semester 1",
  theme: "teal",
  semesters: {
    "Semester 1": {
      courses: [{ id: "c1", name: "PHYS1001", updatedAt: "2026-07-01T00:00:00.000Z" }],
      todos: [{ id: "t1", text: "Read chapter 4", done: false, updatedAt: "2026-07-01T00:00:00.000Z" }],
      pages: [
        {
          id: "p1",
          title: "Lecture notes",
          body: "Some body text.",
          html: "<p>Some body text.</p>",
          strokes: [],
          style: "lined",
          kind: "text",
          font: "sans",
          folderId: null,
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    },
  },
  meta: { updatedAt: "2026-07-01T00:00:00.000Z" },
});

async function bundleFrom(dir) {
  const out = await build({
    entryPoints: [path.join(dir, "src/main.jsx")],
    bundle: true,
    format: "iife",
    jsx: "automatic",
    write: false,
    absWorkingDir: dir,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "demo-config",
        setup(b) {
          b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}

async function render(js, { mode } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: "outside-only",
    url: "https://example.test/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const FIXED = new Date("2026-08-16T02:00:00Z").getTime();
  const RealDate = w.Date;
  w.Date = class extends RealDate {
    constructor(...a) {
      if (a.length) super(...a);
      else super(FIXED);
    }
    static now() {
      return FIXED;
    }
  };
  let seed = 7;
  w.Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // Deliberately steerable: the differential runs in LIGHT, and the
  // dark assertions ask for dark explicitly.
  w.matchMedia = (q) => ({
    matches: /prefers-color-scheme: dark/.test(q) ? mode === "dark" : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  w.localStorage.setItem("uni-planner-v1", SEED);
  const errors = [];
  w.console.error = (...a) => errors.push(a.join(" "));
  w.eval(js);
  await new Promise((r) => setTimeout(r, 350));
  /* The header's save indicator is TIMING, not content: two mounts can
     land on opposite sides of a save on a slow runner, which is the
     flake the archive differential already met. Settle it before
     snapshotting — the comparison is about what the DATA renders. */
  for (let i = 0; i < 60; i++) {
    if (!(w.document.body.textContent || "").includes("Saving")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { dom, html: w.document.body.innerHTML, root: w.document.documentElement, errors };
}

async function run() {
  /* ---------- the differential that EXPIRED, and why it is gone ----------

     This file used to build origin/main's bundle and assert that light
     mode was BYTE-IDENTICAL to it, which is what turned a 557-class
     token sweep into a checked refactor. That claim was true, it was
     verified when the sweep landed (#46), and it has now expired —
     for the same reason test-blocks-neutral's git baseline expired
     when step 4 changed the editor on purpose.

     The comparison is against a MOVING baseline, so ANY intended UI
     change breaks it: adding the ? help control to a Section did, and
     the only ways to keep it green would have been to enumerate that
     control as a permitted "substitution" — which it is not; the
     substitution list is for the same pixels through a variable — or
     to pin the baseline to a sha, which this project refuses for the
     usual reason.

     **A guard that has to be suppressed to let intended changes
     through is not a guard.** It is deleted rather than weakened, and
     what it proved is recorded here: on 20 August 2026 the tokenised
     build rendered light mode byte-for-byte identically to the
     pre-token build, with two enumerated substitutions (bg-white →
     bg-surface, and the lined-paper rule naming its tokens).

     Everything below does NOT expire: those claims are about the
     current build compared with itself in two modes, and about the
     tokens' own values. */

  const js = await bundleFrom(rootDir);

  await test("the mode reaches the document, and dark really is different", async () => {
    const light = await render(js, { mode: "light" });
    const dark = await render(js, { mode: "dark" });
    assert.equal(light.root.getAttribute("data-theme"), "light");
    assert.equal(dark.root.getAttribute("data-theme"), "dark", "the system preference was not followed");
    assert.equal(dark.errors.length, 0, `dark mode logged errors: ${dark.errors[0] || ""}`);
    // Same markup, different ground: the axis is in the tokens, not in
    // per-mode components, so the DOM must NOT fork.
    /* The accent variables live in the root div's style attribute and
       SHOULD differ -- that is the axis doing its job. Masking them
       is what makes the rest of the assertion meaningful: any OTHER
       difference means a component has branched on the mode, which is
       the thing this design exists to avoid. */
    const maskVars = (html) => html.replace(/style="[^"]*--accent[^"]*"/g, 'style="ACCENTS"');
    assert.equal(
      maskVars(light.html),
      maskVars(dark.html),
      "dark mode renders different markup — the axis has leaked into components"
    );
    light.dom.window.close();
    dark.dom.window.close();
  });

  await test("every ground token has a value in both modes", () => {
    const css = fs.readFileSync(path.join(rootDir, "src/input.css"), "utf8");
    const block = (sel) => {
      const at = css.indexOf(sel);
      assert.ok(at > -1, `${sel} is missing`);
      return css.slice(at, css.indexOf("}", at));
    };
    const names = (b) => new Set([...b.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
    const light = names(block(":root {"));
    const dark = names(block(':root[data-theme="dark"] {'));
    assert.ok(light.size >= 10, `only ${light.size} ground tokens — the ramp is incomplete`);
    for (const n of light) {
      assert.ok(dark.has(n), `--${n} has no dark value, so it keeps its light one and will glare`);
    }
    assert.match(block(":root {"), /color-scheme: light/);
    assert.match(block(':root[data-theme="dark"] {'), /color-scheme: dark/);
  });

  await test("PAPER DOES NOT FLIP — a decision, now an open one", () => {
    /* The original reason was handwriting: strokes carried their own
       stored colour, so a dark sheet meant rewriting a student's work
       or lying about it at render time. Handwriting was REMOVED on 16
       August 2026, so that constraint is gone — dark paper is now a
       pure look-and-feel call, which makes it Grace's, not a test's.
       Until she rules, the paper stays light and this pins the current
       decision rather than an accident: flipping it is a one-token
       change that should arrive as a choice, with this assertion
       updated in the same commit. */
    const css = fs.readFileSync(path.join(rootDir, "src/input.css"), "utf8");
    const lightPaper = /--paper: ([^;]+);/.exec(css.slice(css.indexOf(":root {")));
    const darkPaper = /--paper: ([^;]+);/.exec(css.slice(css.indexOf(':root[data-theme="dark"] {')));
    assert.ok(lightPaper && darkPaper, "the paper token is missing from one of the modes");
    assert.equal(darkPaper[1].trim(), lightPaper[1].trim(), "the note paper flipped — if that is Grace's ruling, update this test in the same commit");
  });

  await test("the dark accents are DERIVED from each palette, not a second hand-picked set", () => {
    const app = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const themes = app.slice(app.indexOf("const THEMES = {"), app.indexOf("\n};", app.indexOf("const THEMES = {")));
    const count = [...themes.matchAll(/label:/g)].length;
    assert.ok(count >= 8, `only ${count} palettes found`);
    // Eight palettes x two modes hand-written would be 64 values to
    // keep in step; the axis derives one half from the other.
    assert.match(app, /function themeVarsFor/, "the per-mode accent derivation is gone");
    assert.match(app, /rgba\(\$\{rgb\[0\]\}/, "accent-soft is no longer a wash derived from the accent");
    assert.ok(!/accentSoftDark|darkAccent/.test(themes), "a second hand-picked palette set has appeared");
    // iOS 15 is the deployment floor and has no color-mix().
    /* Comments stripped first: this file EXPLAINS why color-mix() is
       avoided, and a guard that trips on its own reasoning has now
       happened four times in this codebase. */
    const code = app.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    assert.ok(!/color-mix/.test(code), "color-mix() is unsupported on the iOS version this app deploys to");
  });

  await test("the mode is device-local and never enters the synced blob", () => {
    const app = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    assert.match(app, /const MODE_KEY = "uni-planner-mode"/);
    // The palette lives in the blob (it is a preference about the
    // planner); the mode does not (it is about this screen, in this
    // light, in this hand).
    assert.match(app, /localStorage\.setItem\(MODE_KEY, mode\)/, "the mode is not persisted per device");
    assert.ok(!/mode:/.test(app.slice(app.indexOf("const DEFAULT = {"), app.indexOf("// Accept older saved data"))), "the mode leaked into the synced document");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
