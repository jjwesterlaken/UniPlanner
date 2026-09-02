/* Ink on paper, measured on the BUILT page, in a real engine.

   THE BUG THIS EXISTS FOR. The lined note page keeps a white paper
   background in both themes (--paper is pinned; Grace's open decision),
   while the text on it was coloured by the FLIPPING tone ramp
   (text-stone-800 -> near-white in dark mode). Two sources of truth for
   one surface: white paper, white ink, an unreadable note editor in
   dark mode — confirmed on a real screen, invisible to every
   source-level check because each half was individually correct.

   THE RULING IT PINS (Jared, 2 September 2026): lined pages stay white
   in both themes — the lined page reads as paper — so ink on a lined
   page is DARK in both themes, a property of the surface rather than
   of the theme. Blank pages follow the theme, in both directions.

   WHY IT MEASURES RATHER THAN GREPS. Prior colour work here has been
   "verified" by a coincidentally-matching colour (the shell ground) and
   by reading source while the artifact did something else (the
   transparent root). So this loads dist-web in Chromium, walks into the
   real note viewer and editor over seeded notes, reads
   getComputedStyle off the actual elements — pseudo-elements included —
   and asserts WCAG contrast ratios. A selector that finds nothing is a
   FAILURE: an empty result satisfies every claim made about it.

   Skips without a browser; REQUIRE_BROWSER=1 turns the skip into a
   failure. CI runs it in the browser job (test.yml), and a wiring test
   in test-ai-notes.mjs derives that list, so this file cannot quietly
   drop out of it. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}\n        ${err.message}`);
  }
}

/* Lifted from source rather than typed here, the usual reason. */
const TAB_KEY = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const m = /const TAB_KEY = "([^"]+)"/.exec(src);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx");
  return m[1];
})();

/* ---- WCAG 2.x contrast, from the two rendered colours ---- */

function parseRgb(s) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(s || "");
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

function luminance({ r, g, b }) {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---- the seeded planner: four notes that between them cover every
   text element the two page styles can draw ---- */

const NOTES = [
  {
    id: "probe-lined",
    title: "Lined probe",
    style: "lined",
    kind: "text",
    font: "sans",
    folderId: null,
    entries: [],
    strokes: [],
    html: "",
    body: "",
    /* html is what the editor loads (TextBlockEditor sets innerHTML
       from block.html once); body is its text mirror, the shape the
       real save path writes. */
    blocks: [{ id: "b1", type: "text", html: "The quick brown fox reads a lined page.", body: "The quick brown fox reads a lined page." }],
    updatedAt: new Date().toISOString(),
  },
  {
    id: "probe-blank",
    title: "Blank probe",
    style: "blank",
    kind: "text",
    font: "sans",
    folderId: null,
    entries: [],
    strokes: [],
    html: "",
    body: "",
    blocks: [{ id: "b1", type: "text", html: "The quick brown fox reads a blank page.", body: "The quick brown fox reads a blank page." }],
    updatedAt: new Date().toISOString(),
  },
  {
    /* blocks: [] is the one shape whose VIEWER renders the muted
       "This note is empty." span on the lined surface. */
    id: "probe-lined-empty",
    title: "Empty lined probe",
    style: "lined",
    kind: "text",
    font: "sans",
    folderId: null,
    entries: [],
    strokes: [],
    html: "",
    body: "",
    blocks: [],
    updatedAt: new Date().toISOString(),
  },
  {
    /* one EMPTY block is the shape whose EDITOR shows the
       contentEditable placeholder ::before. */
    id: "probe-lined-placeholder",
    title: "Placeholder lined probe",
    style: "lined",
    kind: "text",
    font: "sans",
    folderId: null,
    entries: [],
    strokes: [],
    html: "",
    body: "",
    blocks: [{ id: "b1", type: "text", html: "", body: "" }],
    updatedAt: new Date().toISOString(),
  },
];

function findLocalChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((n) => n.startsWith("chromium"))
    .map((n) => path.join(base, n, "chrome-linux", "chrome"))
    .filter((p) => fs.existsSync(p));
}

async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  for (const executablePath of [undefined, ...findLocalChromium()]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* next */
    }
  }
  return null;
}

/* Mounts the notes tab in the given mode, expands the given note, and
   returns whatever `measure` reads out of the page. One cold mount per
   probe: no state bleeds between notes, and expanding-while-editing
   (which collapses the list) never has to be unwound. */
async function probe(browser, { mode, noteId, edit, expectText, measure }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.addInitScript(
    ({ tabKey, mode2, notes }) => {
      localStorage.setItem("uni-planner-mode", mode2);
      localStorage.setItem(tabKey, "notes");
      localStorage.setItem(
        "uni-planner-v1",
        JSON.stringify({ semester: "Semester 1", semesters: { "Semester 1": { pages: notes } } })
      );
    },
    { tabKey: TAB_KEY, mode2: mode, notes: NOTES }
  );

  /* Signed out on purpose — the notes tab needs no session, and
     test-local-only.mjs proves the signed-out planner makes no outbound
     calls, so there is nothing to intercept. */
  await page.goto("file://" + path.join(OUT, "index.html"));
  await page.waitForSelector(`[data-note-row="${noteId}"]`, { timeout: 15_000 });
  await page.click(`[data-note-row="${noteId}"] .cursor-pointer`);
  if (edit) {
    await page.click(`[data-note-row="${noteId}"] button:has-text("Edit")`);
  }
  /* The surface the probe is about must actually be there — a missing
     selector is a broken probe, never a pass. */
  await page.waitForSelector(`[data-note-row="${noteId}"] ${edit ? "[contenteditable]" : ""}`.trim(), {
    timeout: 15_000,
  });
  /* The editor fills its blocks after mount, so "the element exists"
     arrives before "the text is in it" — wait for the content the
     probe is about, not just the box that will hold it. */
  if (expectText) {
    await page.waitForFunction(
      ({ id, re }) => new RegExp(re).test((document.querySelector(`[data-note-row="${id}"]`) || {}).textContent || ""),
      { id: noteId, re: expectText },
      { timeout: 15_000 }
    );
  }

  const out = await page.evaluate(measure, noteId);
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await ctx.close();

  assert.deepEqual(errors, [], `the page threw while probing ${noteId} (${mode}):\n        ${errors.join("\n        ")}`);
  assert.equal(theme, mode, `the pre-paint script stamped "${theme}" when the probe asked for ${mode}`);
  return out;
}

/* Runs IN the page. Finds the note's body element (viewer div or editor
   contentEditable), reads its computed ink, its EFFECTIVE background
   (walking ancestors past transparent), the caret, the placeholder
   ::before, and the muted span if present. Returns null fields rather
   than guessing — the assertions outside decide what must exist. */
function readSurface(noteId) {
  const row = document.querySelector(`[data-note-row="${noteId}"]`);
  if (!row) return { missing: "row" };
  const el = row.querySelector("[contenteditable]") || row.querySelector(".lined-paper, .whitespace-pre-wrap");
  if (!el) return { missing: "surface" };

  const effectiveBg = (start) => {
    for (let n = start; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(bg) && bg !== "transparent") return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };

  const cs = getComputedStyle(el);
  const before = getComputedStyle(el, "::before");
  /* Inside the SURFACE, not the row: the row header's meta line also
     uses text-stone-400, sits outside the paper, and correctly follows
     the theme — reading it here measured the wrong element and blamed
     the surface for it. */
  const muted = el.querySelector(".text-stone-400");
  return {
    classes: el.className,
    color: cs.color,
    ownBg: cs.backgroundColor,
    bg: effectiveBg(el),
    caret: cs.caretColor,
    colorScheme: cs.colorScheme,
    tone400: cs.getPropertyValue("--tone-400").trim(),
    placeholder: before.content && before.content !== "none" ? before.color : null,
    mutedColor: muted ? getComputedStyle(muted).color : null,
    text: (el.textContent || "").slice(0, 60),
  };
}

async function run() {
  assert.ok(fs.existsSync(path.join(OUT, "app.js")), "dist-web is missing — run npm run build:web first");

  const browser = await launch();
  if (!browser) {
    const message = 'no Chromium — skipping (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)';
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    return;
  }

  /* Every measurement first, assertions after — so one failure still
     prints the whole table, which is the report a colour bug needs. */
  const seen = {};
  for (const mode of ["light", "dark"]) {
    seen[mode] = {
      linedView: await probe(browser, { mode, noteId: "probe-lined", edit: false, expectText: "quick brown fox", measure: readSurface }),
      linedEdit: await probe(browser, { mode, noteId: "probe-lined", edit: true, expectText: "quick brown fox", measure: readSurface }),
      blankView: await probe(browser, { mode, noteId: "probe-blank", edit: false, expectText: "quick brown fox", measure: readSurface }),
      blankEdit: await probe(browser, { mode, noteId: "probe-blank", edit: true, expectText: "quick brown fox", measure: readSurface }),
      linedEmpty: await probe(browser, { mode, noteId: "probe-lined-empty", edit: false, measure: readSurface }),
      linedPlaceholder: await probe(browser, {
        mode,
        noteId: "probe-lined-placeholder",
        edit: true,
        measure: readSurface,
      }),
    };
  }
  await browser.close();

  const ratio = (fgS, bgS) => {
    const fg = parseRgb(fgS);
    const bg = parseRgb(bgS);
    assert.ok(fg && bg, `unparseable colour pair: "${fgS}" on "${bgS}"`);
    return contrast(fg, bg);
  };

  console.log("\n  measured (text on effective background):");
  for (const mode of ["light", "dark"]) {
    for (const key of ["linedView", "linedEdit", "blankView", "blankEdit"]) {
      const s = seen[mode][key];
      if (s.missing) continue;
      console.log(`    ${mode.padEnd(5)} ${key.padEnd(10)} ${s.color} on ${s.bg}  ${ratio(s.color, s.bg).toFixed(2)}:1`);
    }
  }
  console.log("");

  const WHITE = "rgb(255, 255, 255)";
  const AA = 4.5;

  for (const mode of ["light", "dark"]) {
    const s = seen[mode];

    await test(`every probe found its surface in ${mode} mode — nothing below passes over nothing`, () => {
      for (const [key, v] of Object.entries(s)) {
        assert.ok(!v.missing, `${key} found no ${v.missing} — the probe is broken, not the page`);
      }
      assert.match(s.linedView.text, /quick brown fox/, "the lined viewer is not showing the seeded note body");
      assert.match(s.linedEdit.text, /quick brown fox/, "the lined editor is not showing the seeded note body");
      assert.ok(s.linedView.classes.includes("lined-paper"), "the lined viewer element lost the lined-paper class");
      assert.ok(s.linedEdit.classes.includes("lined-paper"), "the lined editor element lost the lined-paper class");
    });

    await test(`the lined page is white paper in ${mode} mode — the ruling, not an accident`, () => {
      assert.equal(s.linedView.ownBg, WHITE, `viewer paper is ${s.linedView.ownBg}`);
      assert.equal(s.linedEdit.ownBg, WHITE, `editor paper is ${s.linedEdit.ownBg}`);
    });

    await test(`ink on the lined page meets WCAG AA in ${mode} mode (viewer and editor)`, () => {
      const rv = ratio(s.linedView.color, s.linedView.bg);
      const re = ratio(s.linedEdit.color, s.linedEdit.bg);
      assert.ok(rv >= AA, `viewer: ${s.linedView.color} on ${s.linedView.bg} is ${rv.toFixed(2)}:1 — unreadable`);
      assert.ok(re >= AA, `editor: ${s.linedEdit.color} on ${s.linedEdit.bg} is ${re.toFixed(2)}:1 — unreadable`);
    });

    await test(`the caret on the lined page is the ink, in ${mode} mode`, () => {
      const caret = s.linedEdit.caret === "auto" ? s.linedEdit.color : s.linedEdit.caret;
      assert.equal(caret, s.linedEdit.color, `caret ${s.linedEdit.caret} vs ink ${s.linedEdit.color}`);
    });

    await test(`the lined surface is a light-scheme island in ${mode} mode — selection and controls render light`, () => {
      assert.equal(s.linedEdit.colorScheme, "light", `color-scheme on the lined editor is "${s.linedEdit.colorScheme}"`);
    });

    await test(`text on a blank page meets WCAG AA in ${mode} mode (viewer and editor)`, () => {
      const rv = ratio(s.blankView.color, s.blankView.bg);
      const re = ratio(s.blankEdit.color, s.blankEdit.bg);
      assert.ok(rv >= AA, `viewer: ${s.blankView.color} on ${s.blankView.bg} is ${rv.toFixed(2)}:1`);
      assert.ok(re >= AA, `editor: ${s.blankEdit.color} on ${s.blankEdit.bg} is ${re.toFixed(2)}:1`);
    });

    await test(`the muted "empty note" hint and the placeholder are paper ink in ${mode} mode`, () => {
      assert.ok(s.linedEmpty.mutedColor, "the empty lined note renders no muted span — the probe reads nothing");
      assert.ok(s.linedPlaceholder.placeholder, "the empty lined editor renders no placeholder ::before");
      /* Both take the surface-scoped --tone-400, so they must agree
         with the surface's own resolution of it — not with the theme's. */
      const t400 = s.linedPlaceholder.tone400.split(/\s+/).join(", ");
      assert.equal(s.linedPlaceholder.placeholder, `rgb(${t400})`, "the placeholder is not the surface's muted ink");
    });
  }

  await test("lined ink and paper are MODE-INVARIANT — dark equals light, byte for byte", () => {
    assert.equal(seen.dark.linedView.color, seen.light.linedView.color, "viewer ink flips with the theme");
    assert.equal(seen.dark.linedEdit.color, seen.light.linedEdit.color, "editor ink flips with the theme");
    assert.equal(seen.dark.linedEmpty.mutedColor, seen.light.linedEmpty.mutedColor, "the muted hint flips with the theme");
    assert.equal(seen.dark.linedPlaceholder.placeholder, seen.light.linedPlaceholder.placeholder, "the placeholder flips with the theme");
  });

  await test("blank pages FOLLOW the theme — the two modes really differ, so nothing above passed by coincidence", () => {
    /* The colour-coincidence trap: light --surface and --paper are the
       same white, so a blank page pinned to paper is invisible in light
       mode and wrong only in dark — exactly how the unthemed root hid.
       The discriminating assertion is that dark REALLY moves. */
    assert.notEqual(seen.dark.blankEdit.ownBg, seen.light.blankEdit.ownBg, "the blank editor page does not follow the theme");
    assert.notEqual(seen.dark.blankEdit.ownBg, WHITE, "the blank editor page is pinned to white in dark mode");
    assert.notEqual(seen.dark.blankView.bg, seen.light.blankView.bg, "the blank viewer's ground does not follow the theme");
    assert.notEqual(seen.dark.blankView.color, seen.light.blankView.color, "blank-page ink does not follow the theme");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
