/* test-promo.mjs — the launch-offer banner on the marketing page.

   The claims (site/promo.js, public/site/site.js):

   1. IT COMES DOWN ON ITS OWN. The built page is mounted with the clock
      on either side of PROMO_ENDS_AT: the bar renders before and does
      not after, with no rebuild in between. The same bundle, the same
      markup — only Date.now differs, which is the whole point.
   2. DISMISSAL IS REMEMBERED IN THIS BROWSER, AND STORAGE MAY FAIL. A
      click hides it and records it; a remount with the record stays
      hidden; a localStorage that throws on every call still shows the
      bar and still closes it for this view, and never throws.
   3. IT MAKES NO REQUEST. Every channel is spied on the mounted page,
      and the module that holds the offer is swept for them.
   4. IT SAYS WEB-ONLY THINGS. No mention of the apps or a store; the
      code in the sentence is PROMO_CODE, never a stale literal.

   The plan-panel half is asserted in test-rendered-tabs.mjs, where the
   web app's Account tab is mounted in Chromium with a fixed clock. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const promo = await import(pathToFileURL(path.join(rootDir, "site/promo.js")).href);
const { SITE_URL } = await import(pathToFileURL(path.join(rootDir, "src/legalLinks.js")).href);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous; an async test would pass before it asserted");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const END = Date.parse(promo.PROMO_ENDS_AT);
const BEFORE = END - 60_000;

/* ---------- the built page, mounted ---------- */
const out = path.join(rootDir, "dist-site");
assert.ok(fs.existsSync(path.join(out, "index.html")), "dist-site is missing — run `npm run build:site` before this suite");
const bundleFile = path.join(os.tmpdir(), `site-promo-${process.pid}.js`);
buildSync({ entryPoints: [path.join(out, "site/site.js")], bundle: true, format: "iife", outfile: bundleFile, logLevel: "silent" });
const BUNDLE = fs.readFileSync(bundleFile, "utf8");
fs.rmSync(bundleFile, { force: true });
const HTML = fs.readFileSync(path.join(out, "index.html"), "utf8");

/** Mount the page at `now`. `storage`: "real" (a fresh jsdom store, optionally seeded) or "broken" (every call throws). */
function mount({ now, seed = {}, storage = "real" } = {}) {
  const dom = new JSDOM(HTML, { url: SITE_URL + "/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
  w.Date.now = () => now;
  const requests = [];
  w.fetch = (...a) => (requests.push(["fetch", String(a[0])]), Promise.reject(new Error("no network")));
  w.XMLHttpRequest = function () {
    requests.push(["xhr"]);
    throw new Error("no network");
  };
  w.navigator.sendBeacon = (u) => (requests.push(["beacon", String(u)]), false);
  w.WebSocket = function (u) {
    requests.push(["ws", String(u)]);
    throw new Error("no network");
  };
  w.EventSource = function (u) {
    requests.push(["es", String(u)]);
    throw new Error("no network");
  };
  if (storage === "broken") {
    Object.defineProperty(w, "localStorage", {
      configurable: true,
      get() {
        return {
          getItem() {
            throw new Error("SecurityError");
          },
          setItem() {
            throw new Error("QuotaExceededError");
          },
        };
      },
    });
  } else {
    for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
  }
  const errors = [];
  w.addEventListener("error", (e) => errors.push(String(e.error || e.message)));
  const tag = w.document.createElement("script");
  tag.textContent = BUNDLE;
  w.document.body.appendChild(tag);
  const bar = w.document.querySelector("[data-promo]");
  return { w, bar, errors, requests, text: () => bar.querySelector("[data-promo-text]").textContent };
}

test("THE RULE: running until PROMO_ENDS_AT, ended from it, and an unreadable clock reads as ended", () => {
  assert.equal(promo.promoActive(BEFORE), true);
  assert.equal(promo.promoActive(END - 1), true);
  assert.equal(promo.promoActive(END), false, "the offer is still running at its own end");
  assert.equal(promo.promoActive(END + 86_400_000), false);
  assert.equal(promo.promoActive(new Date(BEFORE)), true, "a Date is not accepted");
  assert.equal(promo.promoActive(NaN), false, "an unreadable clock shows a code that may no longer work");
  assert.equal(promo.promoBanner(END), null);
  assert.equal(promo.promoPlanLine(END), null);
  /* The end is the START of 30 November in Sydney. */
  assert.equal(new Date(END).toISOString(), "2026-11-29T13:00:00.000Z");
});

test("THE WORDS: the code is filled from PROMO_CODE, both sentences say first payment, and neither mentions an app or a store", () => {
  for (const s of [promo.promoBanner(BEFORE), promo.promoPlanLine(BEFORE)]) {
    assert.ok(s.includes(promo.PROMO_CODE), `"${s}" does not carry the code`);
    assert.ok(!/\{code\}/.test(s), `"${s}" left a placeholder unfilled`);
    assert.match(s, /first payment/i, `"${s}" does not say the code is for the first payment`);
    assert.doesNotMatch(s, /\bapp\b|app store|google play|iphone|ipad|android|ios\b/i, `"${s}" mentions the apps; the code is web only`);
  }
  assert.equal(promo.promoBanner(BEFORE), "To celebrate our launch, use the code UNI50 for 50% off your first payment.");
  assert.ok(promo.PROMO_DISMISS_KEY.endsWith(promo.PROMO_CODE), "the dismissal key is not per code, so an old dismissal would hide a new offer");
});

test("BEFORE THE END: the bar renders, with the code in bold, and nothing is requested", () => {
  const m = mount({ now: BEFORE });
  assert.deepEqual(m.errors, []);
  assert.ok(m.bar, "the page has no promo slot");
  assert.equal(m.bar.hidden, false, "the bar did not render while the offer runs");
  assert.equal(m.text(), promo.promoBanner(BEFORE));
  assert.equal(m.bar.querySelector("[data-promo-text] b").textContent, promo.PROMO_CODE);
  assert.equal(m.bar.querySelector("[data-promo-dismiss]").getAttribute("aria-label"), promo.PROMO_COPY.dismiss);
  assert.deepEqual(m.requests, [], `the page made a request: ${JSON.stringify(m.requests)}`);
});

test("FROM THE END: the same page, the same bundle, and no bar — it came down without a redeploy", () => {
  const m = mount({ now: END });
  assert.deepEqual(m.errors, []);
  assert.ok(m.bar, "the control: the slot is still in the markup");
  assert.equal(m.bar.hidden, true, "the bar is still up at PROMO_ENDS_AT");
  assert.equal(m.text(), "", "the expired sentence was written into the page");
  /* The control that makes the pair mean something: the page's other
     scripted slots still filled, so the script really ran. */
  assert.ok(m.w.document.querySelectorAll("[data-downloads] .d").length >= 3, "the page script did not run, so a hidden bar proves nothing");
});

test("DISMISS: hides it, records it, and a later visit stays dismissed", () => {
  const m = mount({ now: BEFORE });
  m.bar.querySelector("[data-promo-dismiss]").click();
  assert.equal(m.bar.hidden, true, "the close button did not close it");
  assert.equal(m.w.localStorage.getItem(promo.PROMO_DISMISS_KEY), "1", "the dismissal was not remembered");
  const again = mount({ now: BEFORE, seed: { [promo.PROMO_DISMISS_KEY]: "1" } });
  assert.equal(again.bar.hidden, true, "a dismissed bar came back on the next visit");
  /* And an old dismissal of a different code hides nothing. */
  const other = mount({ now: BEFORE, seed: { "uni-planner-promo-dismissed-SOMETHINGELSE": "1" } });
  assert.equal(other.bar.hidden, false, "a dismissal of another code hid this one");
});

test("STORAGE THAT THROWS: the bar still renders, still closes for this view, and nothing throws", () => {
  const m = mount({ now: BEFORE, storage: "broken" });
  assert.deepEqual(m.errors, [], `a broken localStorage threw: ${m.errors.join("; ")}`);
  assert.equal(m.bar.hidden, false, "a failed read hid the bar");
  m.bar.querySelector("[data-promo-dismiss]").click();
  assert.deepEqual(m.errors, []);
  assert.equal(m.bar.hidden, true, "a failed write stopped the bar closing");
});

test("NO REQUEST CAN COME FROM IT: the offer module and the banner code open no channel", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const mod = strip(fs.readFileSync(path.join(rootDir, "site/promo.js"), "utf8"));
  const site = strip(fs.readFileSync(path.join(rootDir, "public/site/site.js"), "utf8"));
  const fn = site.slice(site.indexOf("function fillPromo"), site.indexOf("releaseTheOldWorker();"));
  assert.ok(fn.length > 200, "could not find fillPromo in site.js");
  for (const [name, src] of [["site/promo.js", mod], ["fillPromo", fn]]) {
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\s*\(/, `${name} opens a channel`);
    assert.doesNotMatch(src, /https?:\/\//, `${name} names a URL`);
  }
  /* No new script on the page: still exactly the one module tag. */
  const tags = HTML.match(/<script\b[^>]*\bsrc=/g) || [];
  assert.equal(tags.length, 1, `the page loads ${tags.length} scripts`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed === 0) process.exit(1);
