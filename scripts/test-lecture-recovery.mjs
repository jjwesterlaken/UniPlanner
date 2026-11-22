/* "Get it back", and the recording it gets back, in the built app at a
   phone's width.

   THE FAILURES THIS EXISTS FOR. The parked record held the key, the
   course and the week, and nothing else, and the recovery card did
   less with it than that:
   - it asked for the result with no translation and an estimate of 0;
   - the result went to the review screen as if freshly recorded, so it
     was saved under whatever the form held: no course on the study
     cards, "Lecture — Week ?" as the title, the translation dropped;
   - the key never reached the review screen, so "Try the summary
     again" on a recovered failed summary sent nothing at all;
   - and Discard on the error screen left the key parked, so a recording
     the server had refused came back as a card saying it was ready.

   WHAT THIS DRIVES. dist-web over http at /app/, signed in, consent
   given by the app's own helper, with Supabase answered by a fake that
   records every request. The last test makes a real recording from
   Chromium's fake microphone, because the error screen only exists
   after a recording has been refused.

   Skips without a browser; REQUIRE_BROWSER=1 makes that a failure. */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsentPatch } from "../src/aiNotesLogic.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

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
  const args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
  for (const executablePath of [undefined, ...findLocalChromium()]) {
    try {
      return await chromium.launch(executablePath ? { executablePath, args } : { args });
    } catch {
      /* next */
    }
  }
  return null;
}

/* Lifted from source rather than restated, as the other browser suites do. */
const SRC = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
const TAB_KEY = /const TAB_KEY = "([^"]+)"/.exec(SRC)[1];
const STORAGE_KEY = /const STORAGE_KEY = "([^"]+)"/.exec(SRC)[1];
const SUPABASE_HOST = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8"))[1];
const PROJECT_REF = new URL(SUPABASE_HOST).hostname.split(".")[0];
const USER = { id: "00000000-0000-4000-8000-0000000000aa", email: "recovery-probe@example.test", aud: "authenticated", role: "authenticated" };

const KEY = "11111111-2222-4333-8444-555555555555";
const SUMMARY = {
  overview: "Working memory holds about four chunks.",
  keyPoints: ["Chunking groups items into units."],
  terms: [{ term: "Chunk", content: "A unit of grouped information." }],
  assessable: [],
  openQuestions: [],
};
const ES = { ...SUMMARY, overview: "La memoria de trabajo contiene unos cuatro bloques." };
const PARKED = { key: KEY, course: "PSYC1001", week: "5", language: "es", seconds: 1800 };

/* ---- the built app on http at /app/ ---- */
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
async function serve() {
  const server = http.createServer((req, res) => {
    let p = new URL(req.url, "http://127.0.0.1").pathname.replace(/^\/app(\/|$)/, "/");
    if (p === "/") p = "/index.html";
    const file = path.normalize(path.join(OUT, p));
    if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, app: `http://127.0.0.1:${server.address().port}/app/` };
}

const ACAO = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const json = (body, status = 200) => ({ status, contentType: "application/json", headers: ACAO, body: body === undefined ? "" : JSON.stringify(body) });

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
  const { server, app } = await serve();
  const consent = buildConsentPatch();

  /* One signed-in phone on the AI tab, with `aiNotes` answering the
     function and every other request recorded. */
  async function open({ parked = null, aiNotes }) {
    const ctx = await browser.newContext({ ...PHONE, permissions: ["microphone"] });
    const page = await ctx.newPage();
    const errors = [];
    const calls = [];
    const rows = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    const stamp = new Date().toISOString();
    await page.addInitScript(
      ({ ref, user, tabKey, storageKey, blob }) => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(
          `sb-${ref}-auth-token`,
          JSON.stringify({ access_token: "tok-0", token_type: "bearer", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, refresh_token: "rt-0", user })
        );
        localStorage.setItem("uni-planner-mode", "light");
        localStorage.setItem(tabKey, "ai-notes");
        localStorage.setItem(storageKey, JSON.stringify(blob));
      },
      {
        ref: PROJECT_REF,
        user: USER,
        tabKey: TAB_KEY,
        storageKey: STORAGE_KEY,
        blob: {
          semester: "Semester 1",
          semesters: { "Semester 1": { courses: [{ id: "c1", name: "PSYC1001", updatedAt: stamp }] } },
          meta: { ...consent, updatedAt: stamp, ...(parked ? { pendingAiRecovery: { ...parked, startedAt: stamp } } : {}) },
        },
      }
    );
    await page.route(`${SUPABASE_HOST}/**`, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: ACAO, body: "" });
      const url = new URL(req.url());
      let body = null;
      try {
        body = req.postData() ? JSON.parse(req.postData()) : null;
      } catch {
        body = null;
      }
      calls.push({ method: req.method(), path: url.pathname, body });
      const p = url.pathname;
      if (p.includes("/functions/v1/ai-notes")) return route.fulfill(aiNotes(body, calls.filter((c) => c.path.includes("/functions/v1/ai-notes")).length));
      if (p.includes("/auth/v1/token")) return route.fulfill(json({ access_token: "tok-1", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "rt-1", user: USER }));
      if (p.includes("/auth/v1/user")) return route.fulfill(json(USER));
      if (p.includes("/rest/v1/profiles")) return route.fulfill(json([{ user_id: USER.id, tier: "ai", trial_credits_used: 0, active_device_id: null, active_device_at: null, store: null, trial_photo_pages_used: 0 }]));
      if (p.includes("/rest/v1/ai_usage")) return route.fulfill(json([{ credits_used: 12 }]));
      if (p.includes("/rest/v1/ai_notes") && req.method() === "POST") {
        rows.push(body);
        return route.fulfill(json(undefined, 201));
      }
      if (p.includes("/storage/v1/object/")) return route.fulfill(json({ Key: "lecture-audio/x", Id: "x" }));
      return route.fulfill(json([]));
    });
    await page.goto(app);
    await page.waitForSelector("#root > *", { timeout: 15_000 });
    const blob = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), STORAGE_KEY);
    const fnCalls = () => calls.filter((c) => c.path.includes("/functions/v1/ai-notes"));
    return { ctx, page, errors, calls, rows, blob, fnCalls };
  }

  const delivered = { ok: true, result: { ok: true, summaryFailed: false, original: SUMMARY, translated: ES } };
  const summaryFailed = { ok: true, result: { ok: true, summaryFailed: true, transcript: "Today we look at working memory.", original: null, translated: null } };

  await test("GET IT BACK SENDS THE RECORDING'S COURSE, LANGUAGE AND ESTIMATE", async () => {
    const m = await open({ parked: PARKED, aiNotes: () => json(delivered) });
    try {
      await m.page.getByRole("button", { name: "Get it back" }).click({ timeout: 15_000 });
      await m.page.getByRole("button", { name: "Save to Notes" }).waitFor({ timeout: 10_000 });
      const sent = m.fnCalls()[0] && m.fnCalls()[0].body;
      assert.ok(sent, "Get it back made no request");
      assert.deepEqual(
        { key: sent.idempotencyKey, course: sent.course, translateTo: sent.translateTo, seconds: sent.estimatedDurationSeconds },
        { key: KEY, course: "PSYC1001", translateTo: "es", seconds: 1800 }
      );
      assert.deepEqual(m.errors, [], m.errors.join("\n        "));
    } finally {
      await m.ctx.close();
    }
  });

  await test("A RECOVERED NOTE IS SAVED UNDER ITS OWN COURSE, WEEK AND LANGUAGE", async () => {
    const m = await open({ parked: PARKED, aiNotes: () => json(delivered) });
    try {
      await m.page.getByRole("button", { name: "Get it back" }).click({ timeout: 15_000 });
      await m.page.getByRole("button", { name: "Save to Notes" }).click({ timeout: 10_000 });
      await m.page.getByText(/Saved — check the Notes/).waitFor({ timeout: 10_000 });
      const sem = (await m.blob()).semesters["Semester 1"];
      const page = (sem.pages || []).find((p) => p && p.aiMeta);
      assert.ok(page, "no AI note was saved");
      assert.equal(page.title, "PSYC1001 — Week 5 notes", `the recovered note was saved as "${page.title}"`);
      assert.equal(page.aiMeta.activeLanguage, "es", `the note opens in "${page.aiMeta.activeLanguage}", not the translation that was asked for`);
      const cards = (sem.notes || []).filter((n) => n && !n.deletedAt);
      assert.ok(cards.length > 0, "no study cards were saved, so the course check below reads nothing");
      assert.deepEqual([...new Set(cards.map((c) => c.course))], ["PSYC1001"], "the study cards were saved without their course");
      assert.ok(m.rows.length === 1 && JSON.stringify(m.rows[0]).includes(ES.overview), "the stored note does not carry the translation");
      assert.equal((await m.blob()).meta.pendingAiRecovery, null, "saving left the key parked");
    } finally {
      await m.ctx.close();
    }
  });

  await test("A RECOVERED FAILED SUMMARY CAN BE RETRIED, WITH ITS KEY AND LANGUAGE", async () => {
    const m = await open({ parked: PARKED, aiNotes: (body) => json(body && body.mode === "resummarise" ? delivered : summaryFailed) });
    try {
      await m.page.getByRole("button", { name: "Get it back" }).click({ timeout: 15_000 });
      const retry = m.page.getByRole("button", { name: "Try the summary again" });
      await retry.click({ timeout: 10_000 });
      await m.page.waitForTimeout(1500);
      const retried = m.fnCalls().filter((c) => c.body && c.body.mode === "resummarise");
      assert.equal(retried.length, 1, `the retry made ${retried.length} re-summarise requests`);
      assert.deepEqual({ key: retried[0].body.idempotencyKey, translateTo: retried[0].body.translateTo }, { key: KEY, translateTo: "es" });
      await m.page.getByRole("button", { name: "Save to Notes" }).waitFor({ timeout: 5_000 });
    } finally {
      await m.ctx.close();
    }
  });

  await test("DISCARD ON THE ERROR SCREEN LETS GO OF THE PARKED KEY", async () => {
    const refused = json({ ok: false, code: "usage_exceeded", stage: "size_guard", error: "You've used all your AI credits for this month." }, 403);
    const m = await open({ aiNotes: () => refused });
    try {
      const start = m.page.getByRole("button", { name: "Start recording" });
      await start.waitFor({ timeout: 15_000 });
      const card = m.page.locator("xpath=//button[normalize-space()='Start recording']/ancestor::div[.//input[@placeholder='e.g. 5'] and .//select][1]");
      await card.locator('select:has(option[value="PSYC1001"])').selectOption("PSYC1001");
      await card.getByPlaceholder("e.g. 5").fill("5");
      await start.click();
      const stop = m.page.getByRole("button", { name: "Stop", exact: true }).first();
      await stop.waitFor({ timeout: 10_000 });
      await m.page.waitForTimeout(2500);
      await stop.click();
      await m.page.getByText(/used all your AI credits/).first().waitFor({ timeout: 15_000 });
      const parked = (await m.blob()).meta.pendingAiRecovery;
      assert.ok(parked && parked.key, "the refused recording never parked a key, so the discard below proves nothing");
      await m.page.getByRole("button", { name: "Discard" }).click();
      await m.page.waitForTimeout(800);
      const after = (await m.blob()).meta.pendingAiRecovery;
      const card2 = await m.page.getByRole("button", { name: "Get it back" }).count();
      assert.equal(after, null, `Discard left ${JSON.stringify(after)} parked`);
      assert.equal(card2, 0, "the recovery card offers to get back a recording the server refused");
      assert.deepEqual(m.errors, [], m.errors.join("\n        "));
    } finally {
      await m.ctx.close();
    }
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
