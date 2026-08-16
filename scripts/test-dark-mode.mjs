/* Light and dark as an AXIS, and the one check that makes the sweep safe.

   THE CLAIM THIS FILE EXISTS TO PROVE: turning the ground into tokens
   changed nothing about the app in light mode. Not "looks the same" —
   the same seeded planner, mounted before and after, renders
   BYTE-IDENTICAL HTML, with one documented exception that is itself
   enumerated below rather than waved at.

   The sweep is small because it happened at the theme layer rather
   than at 557 call sites: `text-stone-500` still says "muted text"
   and only the value behind it moves. The only source substitution is
   bg-white -> bg-surface (surfaces flip) with bg-paper for note paper
   (which does not). Everything else is tailwind.config.js.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

/* The documented substitutions. The baseline's HTML is transformed
   through these before comparing, so the comparison asserts "nothing
   changed EXCEPT exactly this" rather than "nothing changed much".
   A stray edit anywhere else fails. */
const SUBSTITUTIONS = [
  // Surfaces flip with the mode; `white` stays white, because
  // text-white sits on accent buttons in both modes.
  ["bg-white", "bg-surface"],
  /* The ruled paper now names its tokens instead of hardcoding the
     line colour. In LIGHT the tokens hold exactly the values it used
     to hardcode (--paper: white, --paper-line: #d6d3d1), so this is
     the same pixels through a variable — which is precisely the kind
     of claim this differential is here to check rather than assert. */
  [
    ".lined-paper{background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 27px,#d6d3d1 27px,#d6d3d1 28px);",
    ".lined-paper{background-color:rgb(var(--paper));background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 27px,var(--paper-line) 27px,var(--paper-line) 28px);",
  ],
];
const applySubstitutions = (html) =>
  SUBSTITUTIONS.reduce((acc, [from, to]) => acc.split(from).join(to), html);

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
  /* ---------- the differential ---------- */

  let baselineDir = null;
  try {
    /* The baseline is origin/main: this branch's parent, which has the
       navigation work and none of the tokens. Deriving it from "the
       last commit that touched tailwind.config.js" was wrong and the
       test caught it -- that resolves to a tree from before the nav
       restructure, so the comparison would have measured two changes
       at once and blamed them both on this one. */
    const before = execFileSync("git", ["rev-parse", "origin/main"], { cwd: rootDir, encoding: "utf8" }).trim();
    baselineDir = path.join(tmp, "baseline");
    fs.rmSync(baselineDir, { recursive: true, force: true });
    fs.mkdirSync(baselineDir, { recursive: true });
    execFileSync("git", ["--work-tree", baselineDir, "checkout", before, "--", "src", "tailwind.config.js"], {
      cwd: rootDir,
    });
    // git checkout --work-tree leaves the index pointing at the old
    // commit; restore it so the repo is not left mid-checkout.
    execFileSync("git", ["reset", "--quiet"], { cwd: rootDir });
  } catch (e) {
    baselineDir = null;
  }

  if (!baselineDir || !fs.existsSync(path.join(baselineDir, "src/main.jsx"))) {
    const msg = "no baseline available (needs git history) — the differential did not run";
    if (process.env.REQUIRE_BASELINE === "1") {
      console.error(`FAIL  - ${msg}`);
      failed++;
    } else {
      console.log(`  skip - ${msg}`);
    }
  } else {
    await test("LIGHT MODE IS BYTE-IDENTICAL: tokenising the ground changed nothing anyone can see", async () => {
      const [after, before] = [await bundleFrom(rootDir), await bundleFrom(baselineDir)];
      const a = await render(after, { mode: "light" });
      const b = await render(before, { mode: "light" });
      assert.equal(a.errors.length, 0, `the tokenised build logged errors: ${a.errors[0] || ""}`);
      assert.ok(a.html.length > 500, "the comparison rendered almost nothing, which proves almost nothing");
      const expected = applySubstitutions(b.html);
      if (expected !== a.html) {
        let i = 0;
        while (i < Math.min(expected.length, a.html.length) && expected[i] === a.html[i]) i++;
        console.error(`        first difference at ${i}:`);
        console.error(`        before: ${JSON.stringify(expected.slice(Math.max(0, i - 60), i + 90))}`);
        console.error(`        after : ${JSON.stringify(a.html.slice(Math.max(0, i - 60), i + 90))}`);
      }
      assert.equal(
        expected,
        a.html,
        "light mode renders differently after tokenising — the only permitted difference is " +
          SUBSTITUTIONS.map(([f, t]) => `${f} -> ${t}`).join(", ")
      );
      a.dom.window.close();
      b.dom.window.close();
    });
  }

  /* ---------- the axis itself ---------- */

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

  await test("PAPER DOES NOT FLIP, so no stored stroke colour ever needs touching", () => {
    /* The decision to read before reaching for inversion: handwriting
       carries its own colour per stroke, chosen by the student. A dark
       sheet would need either rewriting those (an edit to their work)
       or a render-time lie about what they drew. */
    const css = fs.readFileSync(path.join(rootDir, "src/input.css"), "utf8");
    const lightPaper = /--paper: ([^;]+);/.exec(css.slice(css.indexOf(":root {")));
    const darkPaper = /--paper: ([^;]+);/.exec(css.slice(css.indexOf(':root[data-theme="dark"] {')));
    assert.ok(lightPaper && darkPaper, "the paper token is missing from one of the modes");
    assert.equal(darkPaper[1].trim(), lightPaper[1].trim(), "the note paper flipped — existing handwriting is now near-black on near-black");
    // And nothing may rewrite what is stored.
    const ink = fs.readFileSync(path.join(rootDir, "src/ink.js"), "utf8");
    assert.ok(!/invert|data-theme|dark/i.test(ink), "src/ink.js has learned about themes — stroke colour is stored data, not a view concern");
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
