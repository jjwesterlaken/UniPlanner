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

  await test("THE PAPER CARRIES ITS OWN INK — .lined-paper re-pins the ramp to the light values, byte for byte", () => {
    /* The lined page stays white in both modes (the pin above) while
       text-stone-* used to flip with the theme: white paper, white
       ink, an unreadable note editor in dark mode. The fix scopes the
       whole tone ramp on .lined-paper to the LIGHT values, so every
       utility on the surface — body, placeholder, muted span, border,
       caret via currentColor — is paper ink by construction.

       That block is a MIRROR of the :root light ramp (var()
       indirection would break the literal token parsers this suite and
       two others share), so the equality IS the guard: every tone the
       light ramp declares must be re-pinned on the surface with the
       identical value, and nothing else may hide in the block. What
       the values COMPUTE to on the built page is test-paper-ink.mjs's
       half. */
    const css = fs.readFileSync(path.join(rootDir, "src/input.css"), "utf8");
    const at = css.indexOf(".lined-paper {");
    assert.ok(at > -1, "the .lined-paper ink block is gone from input.css — lined ink follows the theme again");
    const island = css.slice(at, css.indexOf("}", at));
    const light = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));

    const tones = (b) => new Map([...b.matchAll(/--(tone-\d+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const lightTones = tones(light);
    const islandTones = tones(island);
    assert.ok(lightTones.size >= 10, `only ${lightTones.size} light tones parsed — the guard is reading the wrong block`);
    for (const [name, value] of lightTones) {
      assert.equal(
        islandTones.get(name),
        value,
        `--${name} on .lined-paper is "${islandTones.get(name)}" but the light ramp says "${value}" — the mirror drifted`
      );
    }
    for (const name of islandTones.keys()) {
      assert.ok(lightTones.has(name), `--${name} is pinned on .lined-paper but is not a light ramp token`);
    }
    assert.match(island, /color-scheme: light/, ".lined-paper lost color-scheme: light — selection and controls render dark on white paper");
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

  await test("the ROOT element carries the ground, not only body — the overscroll gutter", () => {
    /* THE iOS BUG, and the reason it took a device. `body` was themed
       from the day the tokens landed, and in a normal browser that is
       enough: with no background on the root element, body's
       PROPAGATES to the document canvas, which fills the overscroll
       gutter. WKWebView's rubber-band overhang reads the ROOT
       element's own background instead, so it fell through to the web
       view's hardcoded colour — white bars at both ends of a dark app.

       Asserted on the BUILT css, not the source, because that is what
       ships and because Tailwind's preflight is in the same cascade. */
    const css = fs.readFileSync(path.join(rootDir, "dist-web/app.css"), "utf8");
    const ground = /(^|})([^{}]*\bhtml\b[^{}]*)\{([^}]*background-color:\s*rgb\(var\(--page\)\)[^}]*)\}/;
    assert.match(css, ground, "html has no themed background — the overscroll gutter falls through to the shell's colour");
    assert.match(css, /body[^{}]*\{[^}]*background-color:\s*rgb\(var\(--page\)\)/, "body lost its themed ground");
  });

  await test("THE SHELL COLOURS ARE DERIVED FROM THE LIGHT TOKENS, since they cannot follow the theme", () => {
    /* Three files outside the token system hardcode a ground colour:
       the Capacitor config (the web view's background, which is what
       showed through the overscroll gutter), and the manifest's
       background_color and theme_color. NONE of them can follow a
       theme — they are static JSON and a static meta tag read before
       any script runs.

       So light is the only defensible value, and the guard is that
       they EQUAL the light tokens rather than merely resembling them.
       That matters because the resemblance is what hid the bug: the
       Capacitor colour and light `--page` are byte-identical, so the
       unthemed ground was invisible in light mode and wrong only in
       dark. Pin the equality and a change to the light ground goes red
       here naming the file, instead of re-creating the coincidence
       somewhere new. */
    const css = fs.readFileSync(path.join(rootDir, "src/input.css"), "utf8");
    const light = css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="dark"]'));
    const hexOf = (token) => {
      const m = new RegExp(`--${token}:\\s*(\\d+) (\\d+) (\\d+)`).exec(light);
      assert.ok(m, `--${token} is gone from the light palette`);
      return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    };
    const page = hexOf("page");
    const tone50 = hexOf("tone-50");

    const cap = JSON.parse(fs.readFileSync(path.join(rootDir, "mobile/capacitor.config.json"), "utf8"));

    /* iOS DELIBERATELY CONFIGURES NO BACKGROUND COLOUR, and this is the
       assertion that keeps it that way.

       Capacitor's CAPBridgeViewController does exactly this:

           if let backgroundColor = configuration.backgroundColor {
               aWebView.backgroundColor = backgroundColor
               aWebView.scrollView.backgroundColor = backgroundColor
           } else {
               aWebView.backgroundColor = UIColor.systemBackground
               aWebView.scrollView.backgroundColor = UIColor.systemBackground
           }

       `UIColor.systemBackground` is DYNAMIC — it resolves per
       appearance and follows the device between light and dark. A
       configured hex cannot, and the scroll view's background is what
       WKWebView paints in the rubber-band overhang, which is where the
       white bars came from. Setting the key is therefore strictly worse
       than not setting it, and the fix is a deletion.

       Note the fallback chain: iOS reads `ios.backgroundColor` and then
       the TOP-LEVEL `backgroundColor`, so BOTH have to be absent or the
       dynamic branch is never reached. Android reads its own key and is
       unaffected, which is why it still equals the light token below. */
    assert.equal(cap.backgroundColor, undefined, "a top-level backgroundColor is inherited by iOS and defeats UIColor.systemBackground");
    assert.equal(cap.ios && cap.ios.backgroundColor, undefined, "ios.backgroundColor pins the overhang to one appearance");

    assert.equal(
      ((cap.android && cap.android.backgroundColor) || "").toLowerCase(),
      page,
      `capacitor.config.json android.backgroundColor is not the light --page (${page}). It cannot follow the ` +
        "theme, so it must at least be right in the mode it can be right in"
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "public/manifest.webmanifest"), "utf8"));
    assert.equal(manifest.background_color.toLowerCase(), page, "the PWA splash ground is not the light --page");
    assert.equal(manifest.theme_color.toLowerCase(), tone50, "the manifest theme colour is not the light --tone-50");

    const html = fs.readFileSync(path.join(rootDir, "public/index.html"), "utf8");
    const meta = /<meta name="theme-color" content="([^"]+)"/.exec(html);
    assert.ok(meta, "the theme-color meta is gone");
    assert.equal(meta[1].toLowerCase(), tone50, "the theme-color meta disagrees with the light --tone-50");
  });

  await test("EVERY viewport-pinned element accounts for the safe area on the edge it touches", () => {
    /* viewport-fit=cover is in index.html, which is what makes the page
       extend under the status bar, the Dynamic Island and the home
       indicator. Anything pinned to a viewport edge has to put it back,
       or it paints into a cutout.

       The bottom was handled in three places from the day the phone nav
       landed. THE TOP WAS HANDLED NOWHERE, and neither were the sides,
       which is what a notched device in LANDSCAPE eats into. Found by
       the iOS readiness audit (IOS-READINESS.md item 4), before the
       first compile.

       THE ELEMENTS ARE FOUND, NOT LISTED. A hardcoded list of three is
       the guard that goes stale the moment a fourth floating control
       lands — and this file already carries one guard of that shape
       (the color-mix grep reads PlannerApp.jsx while the claim is about
       everything that ships; see the ledger). Every .jsx in src/ is
       scanned, so a new fixed bar fails here until somebody decides.

       WHAT IT CANNOT SEE, said out loud: it reads classes and inline
       styles, not layout. It cannot tell whether the resulting padding
       is the RIGHT size, whether contentInset in capacitor.config.json
       double-insets on top of it, or whether the pill actually clears
       the home indicator. Those need a device and they are on
       MOBILE-BUILD.md. This guard covers the failure that is invisible
       until then: an edge nobody thought about at all. */
    const jsx = fs
      .readdirSync(path.join(rootDir, "src"))
      .filter((n) => n.endsWith(".jsx"))
      .map((n) => ["src/" + n, fs.readFileSync(path.join(rootDir, "src", n), "utf8")]);

    /* A full-screen scrim (`inset-0`) is deliberately not in the axis
       rules: whether it needs an inset depends on what it contains, so
       it is declared instead. Keyed by a distinctive slice of the
       className, with a reason, and the reason CHECKED — an excuse
       nobody verifies is a rubber stamp. */
    const EXCUSED = [
      {
        match: "sticky top-0 z-10 rounded-lg",
        why: "the note editor's toolbar: sticky INSIDE a panel, in content flow, never at the viewport edge",
        /* Weak by nature — source cannot prove where an element sits.
           What is checkable is that it is a rounded card rather than an
           edge-to-edge bar, which no viewport chrome in this app is. */
        check: (tag) => /rounded/.test(tag) && !/inset-x-0|w-screen/.test(tag),
      },
      {
        match: "fixed inset-0 z-50 flex items-center justify-center",
        why: "a centered modal over a scrim: the scrim SHOULD cover the cutout, and the card is centred and width-bounded so it cannot reach one",
        check: (tag) => /items-center/.test(tag) && /justify-center/.test(tag),
      },
    ];

    // Which inset an edge class demands. inset-0 is excused, not ruled.
    const AXES = [
      { cls: /\btop-0\b/, needs: ["top"] },
      { cls: /\bbottom-0\b/, needs: ["bottom"] },
      { cls: /\binset-x-0\b/, needs: ["left", "right"] },
    ];

    let checked = 0;
    const excusesUsed = new Set();
    for (const [file, src] of jsx) {
      /* The whole opening tag, so the className and the inline style are
         both in scope: an inset written in `style` is the only way to
         express env() from React, and reading the class alone would
         report every correct element as broken. */
      for (const m of src.matchAll(/<[A-Za-z][^<>]*className="([^"]*\b(?:fixed|sticky)\b[^"]*)"[^<>]*>/gs)) {
        const [tag, classes] = m;
        const excuse = EXCUSED.find((e) => classes.includes(e.match));
        if (excuse) {
          excusesUsed.add(excuse.match);
          assert.ok(excuse.check(tag), `${file}: the excuse for "${excuse.match}" no longer describes it — ${excuse.why}`);
          continue;
        }
        if (/\binset-0\b/.test(classes)) {
          assert.fail(`${file}: a full-screen element is neither ruled nor declared: ${classes}`);
        }
        const needed = AXES.filter((a) => a.cls.test(classes)).flatMap((a) => a.needs);
        assert.ok(needed.length > 0, `${file}: a ${/fixed/.test(classes) ? "fixed" : "sticky"} element pins to no edge this guard understands: ${classes}`);
        for (const axis of needed) {
          assert.match(
            tag,
            new RegExp(`safe-area-inset-${axis}`),
            `${file}: this element is pinned to the ${axis} and does not account for the safe area there — ` +
              `viewport-fit=cover means it will paint under a cutout. Classes: ${classes}`
          );
        }
        checked += 1;
      }
    }

    assert.ok(checked >= 3, `expected the header, the phone nav and the recording indicator at least; found ${checked}`);
    for (const e of EXCUSED) {
      assert.ok(excusesUsed.has(e.match), `nothing matches the excuse "${e.match}" any more — delete it rather than leaving it`);
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
