/* The mid-semester break, entered the way a student enters it: one
   date at a time, typed into the date field, in the built app at a
   phone's width.

   THE FAILURE THIS EXISTS FOR. `setBreak` stored a range only once it
   had both ends, and read the other end back from what was stored —
   so the first date typed was dropped, the field emptied itself, and
   the second date had nothing to pair with. No platform could save a
   break from d63a5f9 (11 August 2026), while "Other non-teaching
   weeks", which keeps a half-filled range, worked beside it. Every
   week label after the break was one too high, which is the failure
   CLAUDE.md names as worse than a date: it looks authoritative.

   WHAT THIS DRIVES. The built bundle in real Chromium at 390px with
   an en-AU locale, signed out (a planner every student starts with,
   and nothing here depends on sync). Dates are TYPED, digit by digit,
   in the field order this browser's locale gives a date input, rather
   than set with fill(): a typed date passes through every intermediate
   value a student's keystrokes produce, which is exactly where the
   old code lost it. The semester start is typed the same way first,
   as the control: if that does not land in the stored planner, the
   failure is this harness and not the break.

   Every date is derived from today, so nothing here goes stale on a
   calendar date.

   SERVED OVER HTTP, NOT OPENED FROM A FILE, because of what a reload
   reads. On a file:// page headless Chromium sometimes hands the
   reloaded document localStorage from BEFORE the previous document's
   last writes: a counter written 1, 2, 3 read back as 1 in three
   trials out of six, and over http in none out of 48. The app then
   loads that older copy and saves it over the newer one, so "the
   break survives a reopen" failed one run in two for a reason that
   had nothing to do with the break.

   Skips without a browser; REQUIRE_BROWSER=1 makes that a failure. */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teachingWeek, weekStart } from "../src/workload.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");
const PHONE = { width: 390, height: 844 };
const ZONE = "Australia/Sydney";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") await out;
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

/* Lifted from source rather than restated, as the other browser
   suites do. */
const PLANNER_SRC = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
const TAB_KEY = (() => {
  const m = /const TAB_KEY = "([^"]+)"/.exec(PLANNER_SRC);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx — this cannot open a tab it cannot name");
  return m[1];
})();
const STORAGE_KEY = (() => {
  const m = /const STORAGE_KEY = "([^"]+)"/.exec(PLANNER_SRC);
  assert.ok(m, "STORAGE_KEY is gone from PlannerApp.jsx — this cannot read the planner it cannot name");
  return m[1];
})();

/* ---- the calendar, from today ---- */

const DAY = 86_400_000;
const isoInZone = (ms) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const TODAY = isoInZone(Date.now());
const THIS_MONDAY = weekStart(TODAY);
const START = addDays(THIS_MONDAY, -35); /* week 1 began five weeks ago */
const BREAK = { from: addDays(START, 21), to: addDays(START, 25) }; /* week 4's Monday to Friday */
const DEADLINE = addDays(THIS_MONDAY, 9); /* next week's Wednesday, inside the six-week forecast */
const TITLE = "Break probe essay";
const WITH_BREAK = teachingWeek(DEADLINE, { start: START, breaks: [BREAK] });
const WITHOUT_BREAK = teachingWeek(DEADLINE, { start: START });

const SEED = (() => {
  const stamp = new Date().toISOString();
  return {
    semester: "Semester 1",
    semesters: {
      "Semester 1": {
        courses: [{ id: "c1", name: "PSYC1001", updatedAt: stamp }],
        assessments: [{ id: "a1", course: "PSYC1001", title: TITLE, w: 20, due: DEADLINE, kind: "assignment", updatedAt: stamp }],
      },
    },
    meta: { updatedAt: stamp },
  };
})();

/* The built app on plain http at 127.0.0.1: no service worker
   registers there (the app's https-and-not-localhost rule), so nothing
   is served from a cache an earlier run warmed. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
async function serve(root) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    let file = path.normalize(path.join(root, pathname === "/" ? "index.html" : pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function run() {
  assert.ok(fs.existsSync(path.join(OUT, "app.js")), "dist-web is missing — run npm run build:web first");

  await test("the dates this uses really put a break between week 1 and the deadline", () => {
    /* Non-vacuity for the label check below: if the break changed
       nothing, a label that ignored it would pass. */
    assert.ok(START < BREAK.from && BREAK.to < DEADLINE, `start ${START}, break ${BREAK.from}–${BREAK.to}, deadline ${DEADLINE}`);
    assert.equal(WITH_BREAK, WITHOUT_BREAK - 1, `the break moves the deadline from week ${WITHOUT_BREAK} to ${WITH_BREAK}`);
  });

  const browser = await launch();
  if (!browser) {
    const message = "no Chromium — skipping (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)";
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    console.log(`\n${passed} passed, ${failed} failed (browser checks skipped)`);
    if (failed > 0) process.exit(1);
    return;
  }

  const { server, url: APP } = await serve(OUT);
  const errors = [];
  async function openPlanner() {
    const ctx = await browser.newContext({
      viewport: PHONE,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      locale: "en-AU",
      timezoneId: ZONE,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => errors.push(String(err)));
    /* Seeded ONCE per tab: an init script runs on every navigation,
       and reseeding on the reload below would wipe the very dates the
       reload is there to find. */
    await page.addInitScript(
      ({ tabKey, storageKey, seed }) => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("uni-planner-mode", "light");
        localStorage.setItem(tabKey, "courses");
        localStorage.setItem(storageKey, JSON.stringify(seed));
      },
      { tabKey: TAB_KEY, storageKey: STORAGE_KEY, seed: SEED }
    );
    await page.goto(APP);
    await page.waitForSelector("#root > *", { timeout: 15_000 });
    return { ctx, page };
  }

  /* What the planner holds on this device, read the way the app reads it. */
  const stored = (page) =>
    page.evaluate((key) => {
      const blob = JSON.parse(localStorage.getItem(key) || "{}");
      const rows = ((blob.semesters || {})["Semester 1"] || {}).settings || [];
      const row = rows.find((r) => r && !r.deletedAt) || {};
      return { start: row.start, breaks: row.breaks };
    }, STORAGE_KEY);

  /* THE ORDER THE FIELD TAKES ITS DIGITS IN, learned by typing into a
     throwaway date field outside the app. Not from the locale: headless
     Chromium lays a date field out month first whatever locale the
     context emulates, while Intl reports the locale's own order — the
     control below went red on exactly that, storing 10 December for a
     typed 12 October. */
  async function dateFieldOrder(page) {
    await page.evaluate(() => {
      const el = document.createElement("input");
      el.type = "date";
      el.id = "date-order-probe";
      el.style.cssText = "position:fixed;top:0;left:0";
      document.body.appendChild(el);
    });
    await page.locator("#date-order-probe").focus();
    await page.keyboard.type("01022003");
    const value = await page.locator("#date-order-probe").inputValue();
    await page.evaluate(() => document.getElementById("date-order-probe").remove());
    if (value === "2003-02-01") return ["day", "month", "year"];
    if (value === "2003-01-02") return ["month", "day", "year"];
    throw new Error(`typing 01 02 2003 into a date field gave "${value}", so this harness cannot type a date here`);
  }

  /* Typed the way a student types it: focus the field, then the digits. */
  async function typeDate(page, input, iso) {
    const [yyyy, mm, dd] = iso.split("-");
    page.__order = page.__order || (await dateFieldOrder(page));
    await input.focus();
    await page.keyboard.type(page.__order.map((t) => (t === "day" ? dd : t === "month" ? mm : yyyy)).join(""));
    await page.waitForTimeout(250);
  }

  async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  }

  const startInput = (page) =>
    page.locator('xpath=//label[starts-with(normalize-space(.), "Semester starts")]/following-sibling::input[1]');
  const breakFrom = (page) => page.getByLabel("Break starts");
  const breakTo = (page) => page.getByLabel("Break ends");

  /* ---- start first, then end ---- */
  {
    const { ctx, page } = await openPlanner();

    await test("the semester start, typed on its own, is saved (the control: this harness reads what the app stores)", async () => {
      await typeDate(page, startInput(page), START);
      await until(async () => (await stored(page)).start === START);
      assert.equal((await stored(page)).start, START, "a typed semester start never reached the stored planner, so nothing below can be trusted");
      assert.equal(await startInput(page).inputValue(), START);
    });

    await test("the break's start date stays in its box when it is typed on its own", async () => {
      await typeDate(page, breakFrom(page), BREAK.from);
      const shown = await breakFrom(page).inputValue();
      const s = await stored(page);
      assert.equal(
        shown,
        BREAK.from,
        `the box shows "${shown}" after typing ${BREAK.from}, and the planner stored breaks = ${JSON.stringify(s.breaks)}`
      );
      assert.equal(((s.breaks || [])[0] || {}).from, BREAK.from, `stored breaks = ${JSON.stringify(s.breaks)}`);
    });

    await test("the break is saved once its end date is typed too", async () => {
      await typeDate(page, breakTo(page), BREAK.to);
      await until(async () => ((await stored(page)).breaks || []).length === 1 && (await stored(page)).breaks[0].to === BREAK.to);
      assert.deepEqual((await stored(page)).breaks, [BREAK]);
      assert.equal(await breakFrom(page).inputValue(), BREAK.from);
      assert.equal(await breakTo(page).inputValue(), BREAK.to);
    });

    await test("the break is still there after the app is reopened", async () => {
      await page.reload();
      await page.waitForSelector("#root > *", { timeout: 15_000 });
      assert.equal(await breakFrom(page).inputValue(), BREAK.from);
      assert.equal(await breakTo(page).inputValue(), BREAK.to);
    });

    await test(`a deadline after the break is labelled week ${WITH_BREAK}, not week ${WITHOUT_BREAK}`, async () => {
      /* Pressed, the way a student gets there. */
      await page.locator("nav").getByRole("button", { name: "Plan", exact: true }).click();
      await page.locator("[data-upcoming-kind]", { hasText: TITLE }).first().waitFor({ timeout: 5_000 });
      /* The week block holding the deadline, and the label it carries. */
      const label = await page.evaluate((title) => {
        const li = [...document.querySelectorAll("[data-upcoming-kind]")].find((el) => el.textContent.includes(title));
        const week = li && li.closest("ul") && li.closest("ul").parentElement;
        const span = week && week.querySelector("span");
        return span ? span.textContent.trim() : null;
      }, TITLE);
      const s = await stored(page);
      const held = `the planner holds start ${s.start} and breaks ${JSON.stringify(s.breaks)}`;
      assert.match(String(label), /^Week \d+$/, `the deadline's week is labelled "${label}", which is not a teaching week; ${held}`);
      assert.equal(label, `Week ${WITH_BREAK}`, `the deadline reads "${label}"; week ${WITHOUT_BREAK} is the number with no break; ${held}`);
    });

    await ctx.close();
  }

  /* ---- end first, then start; then cleared ---- */
  {
    const { ctx, page } = await openPlanner();

    await test("the dates can be typed end first", async () => {
      await typeDate(page, breakTo(page), BREAK.to);
      assert.equal(await breakTo(page).inputValue(), BREAK.to, "the end date, typed first, emptied itself");
      await typeDate(page, breakFrom(page), BREAK.from);
      await until(async () => ((await stored(page)).breaks || [])[0]?.from === BREAK.from);
      assert.deepEqual((await stored(page)).breaks, [BREAK]);
    });

    await test("clearing one date keeps the other, and clearing both removes the break", async () => {
      await breakFrom(page).fill("");
      await until(async () => ((await stored(page)).breaks || [])[0]?.from === "");
      assert.deepEqual((await stored(page)).breaks, [{ from: "", to: BREAK.to }], "clearing the start lost the end as well");
      assert.equal(await breakTo(page).inputValue(), BREAK.to);
      await breakTo(page).fill("");
      await until(async () => ((await stored(page)).breaks || []).length === 0);
      assert.deepEqual((await stored(page)).breaks, [], "an empty range was left behind");
    });

    await ctx.close();
  }

  await test("nothing threw", () => {
    assert.deepEqual(errors, [], errors.join("\n        "));
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
