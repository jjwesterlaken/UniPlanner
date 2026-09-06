/* Every text-entry control, measured in its FOCUSED state on a touch
   device, against WebKit's auto-zoom threshold.

   THE FAILURE THIS EXISTS FOR — iPhone 17 simulator, build 3514163:
   focus a sign-in field and the page pans 27px sideways with the left
   edge cut off. Measured in Web Inspector: scrollWidth 440 ==
   clientWidth 440 (so NOT overflow), innerWidth 385, visualViewport
   width 384.89. 440 / 385 = 1.143 = 16 / 14. WebKit zooms the page on
   focus so the focused control's text reads at 16px (WKContentView's
   _zoomToRevealFocusedElement, minimum scale = 16 / nodeFontSize), and
   then pans to keep the caret visible. `inputCls` is text-sm — 14px —
   and so is the note editor's contentEditable, so this was every text
   field in the app, not the two Jared happened to tap.

   WHAT THIS MEASURES. The built bundle in real Chromium, in a context
   whose primary pointer is COARSE (touch emulation, an iPhone 17
   viewport), walking every tab signed in, the signed-out sign-in
   form, and the note editor. Every control that WebKit would zoom
   for — input, textarea, select, contentEditable — is FOCUSED and its
   computed font-size read while it holds focus, because the previous
   viewport guard passed on an idle page and the defect only exists
   with a field focused. The same walk runs again with a FINE pointer
   and the two are compared, so the floor is proved to be scoped to
   touch (desktop unchanged, which is Grace's constraint) and the
   comparison is proved to discriminate.

   WHAT IT CANNOT SEE, stated so nobody reads more into a green run.
   Chromium does not implement WebKit's focus zoom; visualViewport.scale
   is 1 here whatever the font size is, so asserting it would be
   vacuous and it is NOT asserted. The "WebKit would zoom to" column is
   16 / fontSize — WebKit's documented rule applied to a measured
   input, a MODEL and not an observation. The observation is one line
   in Safari Web Inspector against the running app, with a field
   focused and the keyboard up:

     ({ scale: visualViewport.scale, w: visualViewport.width,
        innerW: innerWidth, scrollX, fs: getComputedStyle(document.activeElement).fontSize })

   scale must read 1 and scrollX 0. MOBILE-BUILD.md §13e has it.

   Skips without a browser; REQUIRE_BROWSER=1 makes that a failure. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");

/* WebKit's threshold. Not lifted from anywhere in this repository
   because it is not ours: WKContentViewInteraction.mm zooms a focused
   element whose font renders below 16 CSS px. The CSS floor in
   input.css mirrors it, and the measurement below is what keeps the
   mirror honest — the built page must COMPUTE to at least this. */
const WEBKIT_AUTOZOOM_PX = 16;

/* The device the defect was measured on. Any iPhone would do; the
   width only has to be a phone's so the phone layout renders. */
const DEVICE = { width: 402, height: 874, name: "iPhone 17" };

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

/* Lifted from source, the same way test-rendered-tabs.mjs does it. */
const PLANNER_SRC = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");

function tabIds() {
  const block = PLANNER_SRC.slice(PLANNER_SRC.indexOf("const TABS = ["), PLANNER_SRC.indexOf("const SETTINGS_TAB"));
  const ids = [...block.matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  const settings = /id:\s*"([a-z-]+)"/.exec(PLANNER_SRC.slice(PLANNER_SRC.indexOf("const SETTINGS_TAB")));
  if (settings) ids.push(settings[1]);
  return [...new Set(ids)];
}

const TAB_KEY = (() => {
  const m = /const TAB_KEY = "([^"]+)"/.exec(PLANNER_SRC);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx — this guard cannot open a tab it cannot name");
  return m[1];
})();

const SUPABASE_HOST = (() => {
  const cfg = fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8");
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(cfg);
  assert.ok(m, "SUPABASE_URL is gone from config.js — this guard cannot intercept what it cannot name");
  return m[1];
})();

const AI_CONSENT_VERSION = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/aiNotesLogic.js"), "utf8");
  const m = /export const AI_CONSENT_VERSION = (\d+)/.exec(src);
  assert.ok(m, "AI_CONSENT_VERSION is gone from aiNotesLogic.js");
  return Number(m[1]);
})();

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PROFILE_ROW = { user_id: USER_ID, tier: "ai", trial_credits_used: 0, active_device_id: null, active_device_at: null };

/* THE CONTROLS WEBKIT ZOOMS FOR. Text entry of every kind, selects
   (iOS zooms for the picker too), and editable regions. Checkboxes,
   radios, files and hidden inputs never take a caret and never zoom. */
const CONTROL_SELECTOR =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="range"]):not([type="color"]):not([type="submit"]):not([type="button"]), ' +
  'textarea, select, [contenteditable]:not([contenteditable="false"])';

/* The fields Jared named, so the coverage claim is specific rather
   than "some inputs were measured". Each must appear in the measured
   set, matched on what a person would recognise it by. */
const NAMED_FIELDS = [
  { label: "sign-in email", scene: "account (signed out)", match: (c) => c.type === "email" },
  { label: "sign-in password", scene: "account (signed out)", match: (c) => c.type === "password" },
  { label: "reading planner: week", match: (c) => c.type === "number" && c.hint === "e.g. 3" },
  { label: "reading planner: pages", match: (c) => c.hint === "e.g. pp. 40-58" },
  { label: "AI notes: week", scene: "ai-notes", match: (c) => c.type === "number" && c.hint === "e.g. 5" },
  { label: "note editor: body (contentEditable)", scene: "notes (editor open)", match: (c) => c.tag === "div" && c.editable },
  { label: "note editor: title", scene: "notes (editor open)", match: (c) => c.hint === "Note title" },
  { label: "header: semester select", match: (c) => c.tag === "select" && /Semester/.test(c.text) },
];

/* Focus each control in turn and read its computed font-size WHILE it
   holds focus. Runs in the page. */
function measureControls(selector) {
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; /* not rendered */
    el.focus();
    const focused = document.activeElement === el;
    const cs = getComputedStyle(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      editable: el.isContentEditable,
      hint: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-label") || "",
      text: el.tagName === "SELECT" ? Array.from(el.options).map((o) => o.textContent).join("|").slice(0, 40) : "",
      focused,
      fontPx: parseFloat(cs.fontSize),
      scale: window.visualViewport ? window.visualViewport.scale : null,
      scrollX: window.scrollX,
    });
    el.blur();
  }
  return out;
}

async function run() {
  assert.ok(fs.existsSync(path.join(OUT, "app.js")), "dist-web is missing — run npm run build:web first");

  const browser = await launch();
  if (!browser) {
    const message = "no Chromium — skipping (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)";
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    return;
  }

  const ids = tabIds();
  assert.ok(ids.length >= 5, `expected the tab list, found ${ids.length} — the guard is reading the wrong block`);
  const projectRef = new URL(SUPABASE_HOST).hostname.split(".")[0];
  const json = (body) => ({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });

  /* One scene = one cold mount of one screen. `touch` decides the
     pointer the page sees; everything else is identical between the
     two runs, which is what makes the comparison a comparison. */
  async function mountScene({ tab, signedIn, touch, then }) {
    const ctx = await browser.newContext(
      touch
        ? { viewport: { width: DEVICE.width, height: DEVICE.height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
        : { viewport: { width: DEVICE.width, height: DEVICE.height } }
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.addInitScript(
      ({ ref, userId, tabKey, tab, consentVersion, signedIn }) => {
        if (signedIn) {
          const hour = Math.floor(Date.now() / 1000) + 3600;
          localStorage.setItem(
            `sb-${ref}-auth-token`,
            JSON.stringify({
              access_token: "test-token",
              token_type: "bearer",
              expires_at: hour,
              expires_in: 3600,
              refresh_token: "test-refresh",
              user: { id: userId, email: "zoom-probe@example.test", aud: "authenticated", role: "authenticated" },
            })
          );
        }
        localStorage.setItem("uni-planner-mode", "light");
        localStorage.setItem(tabKey, tab);
        localStorage.setItem(
          "uni-planner-v1",
          JSON.stringify({
            semester: "Semester 1",
            semesters: {},
            meta: { aiConsent: { version: consentVersion, acceptedAt: new Date().toISOString() } },
          })
        );
      },
      { ref: projectRef, userId: USER_ID, tabKey: TAB_KEY, tab, consentVersion: AI_CONSENT_VERSION, signedIn }
    );
    await page.route(`${SUPABASE_HOST}/**`, async (route) => {
      const url = route.request().url();
      if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: "zoom-probe@example.test" }));
      if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "test-token", user: { id: USER_ID } }));
      if (url.includes("/rest/v1/profiles")) return route.fulfill(json(PROFILE_ROW));
      if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 12 }));
      return route.fulfill(json([]));
    });
    await page.goto("file://" + path.join(OUT, "index.html"));
    await page.waitForSelector("#root > *", { timeout: 15_000 });
    await page.waitForTimeout(600);
    if (then) await then(page);

    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    const controls = await page.evaluate(measureControls, CONTROL_SELECTOR);
    await ctx.close();
    assert.deepEqual(errors, [], `the scene threw:\n        ${errors.join("\n        ")}`);
    return { coarse, controls };
  }

  /* The scenes: every tab signed in, the sign-in form, the editor. */
  const openEditor = async (page) => {
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByRole("button", { name: /Create note/ }).click();
    await page.waitForSelector("[contenteditable]", { timeout: 5_000 });
  };
  const scenes = [
    ...ids.map((id) => ({ name: id, tab: id, signedIn: true })),
    { name: "account (signed out)", tab: "account", signedIn: false },
    { name: "notes (editor open)", tab: "notes", signedIn: true, then: openEditor },
  ];

  const measured = { touch: [], fine: [] };
  for (const touch of [true, false]) {
    const pointer = touch ? "touch" : "fine";
    for (const scene of scenes) {
      await test(`[${pointer} pointer] "${scene.name}" mounts and its controls take focus`, async () => {
        const { coarse, controls } = await mountScene({ ...scene, touch });
        assert.equal(
          coarse,
          touch,
          `(pointer: coarse) is ${coarse} in the ${pointer} context — the emulation is not producing the pointer the CSS floor keys on, so nothing below measures what it claims to`
        );
        assert.ok(controls.length > 0, `"${scene.name}" rendered no text-entry control at all — an empty walk proves nothing`);
        const unfocused = controls.filter((c) => !c.focused);
        assert.deepEqual(
          unfocused.map((c) => `${c.tag}[${c.type}] "${c.hint}"`),
          [],
          "these controls refused focus, so their focused font-size was never read"
        );
        for (const c of controls) measured[pointer].push({ ...c, scene: scene.name });
      });
    }
  }

  const fmt = (c) => `${c.scene}: ${c.tag}${c.type ? `[${c.type}]` : ""}${c.editable ? "[contenteditable]" : ""} "${c.hint || c.text}"`;
  const zoom = (c) => Math.max(1, WEBKIT_AUTOZOOM_PX / c.fontPx);

  console.log(`\n  measured, FOCUSED, ${DEVICE.name} ${DEVICE.width}x${DEVICE.height}, touch pointer (WebKit would zoom to = ${WEBKIT_AUTOZOOM_PX} / font-size, a model):`);
  const seen = new Set();
  for (const c of measured.touch) {
    const key = fmt(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const fine = measured.fine.find((f) => fmt(f) === key);
    console.log(
      `    ${String(c.fontPx).padStart(5)}px  ${zoom(c) === 1 ? "no zoom " : `x${zoom(c).toFixed(3)}`}  (fine pointer: ${fine ? fine.fontPx + "px" : "n/a"})  ${key}`
    );
  }

  await test("the walk reached a real spread of controls, not a token few", () => {
    /* 61 control sites exist in src/*.jsx; most sit behind an edit
       button. The floor here is the number a cold mount of every tab
       plus the two opened forms reaches — a walk that suddenly finds
       fewer has lost a screen, not gained a fix. */
    assert.ok(seen.size >= 12, `only ${seen.size} distinct controls were measured`);
  });

  await test("every field Jared named was measured, by name", () => {
    const missing = NAMED_FIELDS.filter(
      (f) => !measured.touch.some((c) => (!f.scene || c.scene === f.scene) && f.match(c))
    ).map((f) => f.label);
    assert.deepEqual(missing, [], `not reached by the walk: ${missing.join(", ")}`);
  });

  await test(`on a touch pointer, every focused text-entry control computes to at least ${WEBKIT_AUTOZOOM_PX}px — WebKit's zoom rule yields x1.000 for all of them`, () => {
    const below = measured.touch.filter((c) => c.fontPx < WEBKIT_AUTOZOOM_PX);
    assert.deepEqual(
      [...new Set(below.map((c) => `${c.fontPx}px -> WebKit zooms x${zoom(c).toFixed(3)}  ${fmt(c)}`))],
      [],
      "these controls would make iOS zoom and pan on focus:"
    );
  });

  await test("on a fine pointer the desktop sizes are untouched — and they DIFFER from the touch sizes, so the comparison discriminates", () => {
    /* Two things, deliberately in one assertion: the floor must be
       scoped (Grace has not ruled on desktop input sizes), and the
       guard must be able to tell the two contexts apart, or "touch is
       16px" could pass because everything is 16px for some unrelated
       reason. */
    const pairs = measured.touch
      .map((t) => [t, measured.fine.find((f) => fmt(f) === fmt(t))])
      .filter(([, f]) => f);
    assert.ok(pairs.length >= 12, `only ${pairs.length} controls were measured in BOTH contexts`);
    const differing = pairs.filter(([t, f]) => t.fontPx !== f.fontPx);
    assert.ok(
      differing.length > 0,
      "touch and fine contexts computed identical sizes for every control — either the floor applies everywhere (desktop changed without a ruling) or it applies nowhere and the touch pass above is a coincidence"
    );
    const grewOnDesktop = pairs.filter(([, f]) => f.fontPx >= WEBKIT_AUTOZOOM_PX);
    /* Desktop controls are text-sm/text-xs today. If every one of
       them reads 16px on a fine pointer, the floor leaked. */
    assert.ok(
      grewOnDesktop.length < pairs.length,
      "every control is already >= 16px on a fine pointer — the floor is not scoped to touch"
    );
  });

  await browser.close();
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
