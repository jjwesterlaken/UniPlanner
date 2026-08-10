/* Mounts the real app in jsdom with NO backend configured and drives the
   Study tab.

   Why this exists: demo mode has shipped a null-dereference crash before,
   and it's the mode hardest to notice breaking -- the app is built and
   used with a configured backend, so a crash that only happens without
   one gets found by users rather than by us. Everything here runs against
   `isConfigured === false`, which is the code path a brand-new user with
   no account takes.

   It's a smoke test, not a UI test: it asserts the screen renders, the
   study features are present, and nothing writes to console.error. React
   reports render-time crashes there, so a null-deref in any new component
   fails this even when the surrounding markup still appears.

   Run via `npm test`. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

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

const tmp = path.join(rootDir, ".smoke-tmp");
fs.mkdirSync(tmp, { recursive: true });

/* Swap config.js for one that reports "no backend", which is what makes
   backend fall through to demoBackend in sync.js. */
const demoConfig = path.join(tmp, "config-demo.js");
fs.writeFileSync(
  demoConfig,
  'export const SUPABASE_URL = "PASTE_YOUR_URL";\n' +
    'export const SUPABASE_ANON_KEY = "PASTE_YOUR_KEY";\n' +
    "export const isConfigured = false;\n"
);

const bundle = await build({
  entryPoints: [path.join(rootDir, "src/main.jsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  write: false,
  define: { "process.env.NODE_ENV": '"development"' }, // keeps React's warnings on
  plugins: [
    {
      name: "force-demo-config",
      setup(b) {
        b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
      },
    },
  ],
});

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  runScripts: "outside-only",
  url: "https://example.test/",
  pretendToBeVisual: true,
});

// React reports render errors through console.error, so collecting it is
// what turns "it rendered something" into "it rendered without crashing".
const complaints = [];
dom.window.console.error = (...a) => complaints.push(a.join(" "));

let threw = null;
try {
  dom.window.eval(bundle.outputFiles[0].text);
} catch (err) {
  threw = err;
}
check(!threw, "the app mounts in demo mode with no backend configured", threw && threw.message);

await new Promise((r) => setTimeout(r, 300));
const doc = dom.window.document;
check((doc.body.textContent || "").length > 0, "it renders something rather than a blank page");

const findButton = (label) =>
  [...doc.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);

const studyTab = findButton("Study");
check(!!studyTab, "the Study tab is reachable");
if (studyTab) {
  studyTab.click();
  await new Promise((r) => setTimeout(r, 200));
  const text = doc.body.textContent || "";
  for (const phrase of ["Your studying", "Study timer", "Class notes", "Study cards", "Weak spots"]) {
    check(text.includes(phrase), `the Study tab shows "${phrase}"`);
  }
  // With nothing studied yet, every stat reads from empty collections --
  // the exact shape that caused the previous demo-mode crash.
  for (const phrase of ["Current streak", "Longest streak", "Cards today"]) {
    check(text.includes(phrase), `stats render from an empty semester: "${phrase}"`);
  }

  const start = findButton("Start");
  check(!!start, "the study timer offers a Start button");
  if (start) {
    start.click();
    await new Promise((r) => setTimeout(r, 150));
    check(!!findButton("Pause"), "starting the timer switches it to Pause");
  }
}

check(complaints.length === 0, "nothing logged a React error or warning", complaints.slice(0, 3).join(" | ").slice(0, 400));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
// The running timer holds an interval open, so close jsdom rather than
// waiting for an event loop that will never drain.
dom.window.close();
process.exit(failed > 0 ? 1 : 0);
