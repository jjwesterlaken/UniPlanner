/* What the BUILT page actually computes, in a real engine.

   THE REASON THIS FILE EXISTS. `html, body { background-color:
   rgb(var(--page)); }` is in src/input.css, survives into
   dist-web/app.css, and is overridden by nothing — every source-level
   check passes. On a real device the root still reported
   `rgba(0, 0, 0, 0)`. Source said one thing and the artifact did
   another, which is the fifth time that has happened here (see the
   "read the artifact, not the source" rule in CLAUDE.md), and every
   guard that reads a .css or .jsx file is structurally unable to see
   it.

   So this one loads the built page in Chromium and reads
   getComputedStyle. It cannot answer for WebKit — nothing on a build
   machine can — and it says so rather than implying otherwise. What it
   does cover is the whole class of "the rule is in the file and does
   not reach the element": a selector that stops matching, a cascade
   order that changes, a variable that resolves to nothing, a Tailwind
   upgrade whose preflight grows a root background.

   SKIPS without a browser, the same arrangement as the migration
   tests, and REQUIRE_BROWSER=1 turns that skip into a failure so CI
   cannot quietly stop running it. */

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
    console.log(`  ok  - ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  - ${name}\n        ${err.message}`);
    failed += 1;
  }
}

/* The palette, read from the SOURCE OF TRUTH rather than typed here.
   The assertion below compares what the browser computed against what
   input.css declares, so changing a ground colour changes both sides
   at once and the guard keeps meaning the same thing. */
function groundTokens() {
  const css = fs.readFileSync(path.join(rootDir, "src/input.css"), "utf8");
  const block = (start, end) => css.slice(css.indexOf(start), end ? css.indexOf(end) : undefined);
  const pageIn = (text) => {
    const m = /--page:\s*(\d+)\s+(\d+)\s+(\d+)/.exec(text);
    assert.ok(m, "--page is gone from input.css");
    return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  };
  return {
    light: pageIn(block(":root {", ':root[data-theme="dark"]')),
    dark: pageIn(block(':root[data-theme="dark"]')),
  };
}

async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  /* The container's browsers live outside node_modules, and a project
     that pins a different Playwright version finds nothing at the
     default path. Try the default first, then whatever is on disk. */
  const candidates = [undefined, ...findLocalChromium()];
  for (const executablePath of candidates) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function findLocalChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((n) => n.startsWith("chromium"))
    .map((n) => path.join(base, n, "chrome-linux", "chrome"))
    .filter((p) => fs.existsSync(p));
}

async function run() {
  if (!fs.existsSync(path.join(OUT, "app.css"))) {
    throw new Error("dist-web is missing — run npm run build:web first");
  }

  const browser = await launch();
  if (!browser) {
    const message =
      "no Chromium available — skipping the computed-ground check " +
      '(run "npx playwright install chromium", or set REQUIRE_BROWSER=1 to make this a failure)';
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    return;
  }

  const tokens = groundTokens();
  const url = "file://" + path.join(OUT, "index.html");

  for (const mode of ["dark", "light"]) {
    await test(`the ROOT element really paints the ground in ${mode} mode`, async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.addInitScript((m) => {
        try {
          localStorage.setItem("uni-planner-mode", m);
        } catch {
          /* a context that refuses storage still tests the light default */
        }
      }, mode);
      await page.goto(url);
      await page.waitForSelector("#root > *", { timeout: 10_000 });

      const seen = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute("data-theme"),
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        /* Both are empty in this app — the mode is an ATTRIBUTE, not a
           class. Captured so a future change to a class-driven theme
           shows up here rather than as a mystery. */
        htmlClass: document.documentElement.className,
        bodyClass: document.body.className,
      }));
      await ctx.close();

      assert.equal(seen.theme, mode, "the pre-paint script did not stamp the mode it was asked for");
      assert.notEqual(
        seen.htmlBg,
        "rgba(0, 0, 0, 0)",
        `the root element computes to TRANSPARENT in ${mode} mode. The rule is in input.css and in ` +
          "dist-web/app.css and nothing overrides it — which is exactly the state this test exists to catch, " +
          "because every source-level check passes while the artifact does something else"
      );
      assert.equal(seen.htmlBg, tokens[mode], `the root ground is not --page (${mode})`);
      assert.equal(seen.bodyBg, tokens[mode], `body's ground is not --page (${mode})`);
    });
  }

  await test("the two modes really differ, so neither assertion passes by coincidence", async () => {
    /* The light ground and the hardcoded shell colour are byte-identical
       (see CLAUDE.md), which is how an unthemed root hid in light mode
       for weeks. A test that only ever checked one mode would be
       satisfied by a page that never changed at all. */
    const tokens2 = groundTokens();
    assert.notEqual(tokens2.light, tokens2.dark, "light and dark declare the same --page — this suite proves nothing");
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
