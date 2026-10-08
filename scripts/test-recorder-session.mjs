/* A lecture recorded from ANOTHER TAB, end to end, from the BUILT bundle,
   in real Chromium, sharing a REAL tab.

   THE INCIDENT, 7 October 2026, build 39ffb2b353a5. A meeting recorded
   from another browser tab produced one three-minute request at 12:04
   and nothing after, while the meeting ran until 1:50. Nothing failed:
   the share ended about three minutes in, the recorder's own listener
   stopped and uploaded what it had -- by design -- in a tab nobody was
   looking at, and the student found out at 1:50. And the investigation
   found the worse half: had the recording run to 1:50 as intended, the
   end would very likely have FAILED, because the recorder handed the
   AI-notes function the token React held when the recording stopped,
   and a tab hidden for over an hour holds an expired one (auth-js does
   not refresh in a hidden tab).

   WHAT IS REAL HERE, and what is not, said rather than implied:

   - The SHARE is real. `--auto-select-tab-capture-source-by-title`
     shares the tab titled TARGET through the browser's own tab-capture
     path, and the first test asserts the track labels say so. The
     obvious alternative, `--use-fake-ui-for-media-stream`, silently
     shares a FAKE SCREEN instead -- it is how the first run of the
     investigation's experiment measured the wrong thing, and it would
     make "closing the meeting tab ends the share" untestable.
   - Closing the TARGET tab really ends both tracks; the browser does
     it, not this file.
   - HIDDEN IS SIMULATED. Playwright keeps every page "visible" (checked:
     bringToFront changes nothing), so the hidden state is driven the way
     the browser would report it -- `document.visibilityState` and
     `document.hidden` read "hidden", and a bubbling `visibilitychange`
     fires. Those two properties and that event are exactly what the app
     and auth-js read, so the logic under test sees what it would see.
   - Three device events are DISPATCHED, not caused: a microphone track's
     `ended` (a real device unplugged cannot be produced here) and a
     shared audio track's `mute`. They exercise the app's listeners, not
     the browser's reasons for firing them. The browser-stops-the-
     recorder case is REAL: adding a track to a recorded stream makes
     Chromium fire error, data, stop -- measured on 7 October.
   - The network is intercepted. Tokens are minted by the intercepted
     refresh endpoint with a lifetime this file chooses, and the
     intercepted ai-notes function refuses an expired one with a 401, the
     way the functions gateway does.

   HEADFUL, so it needs a display. Chromium 141 headless closes the page
   the moment tab capture starts (checked); without DISPLAY this file
   re-runs itself under xvfb-run. Skips without a browser;
   REQUIRE_BROWSER=1 makes that a failure. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildConsentPatch } from "../src/aiNotesLogic.js";
import { AI_NOTES_COPY } from "../src/aiNotesCopy.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");
const SELF = fileURLToPath(import.meta.url);

/* ---------- a display, or a re-run under one ---------- */
if (!process.env.DISPLAY && process.env.RECORDER_UNDER_XVFB !== "1") {
  const has = spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" });
  if (has.status === 0 && has.stdout.trim()) {
    const r = spawnSync("xvfb-run", ["-a", process.execPath, SELF], {
      stdio: "inherit",
      env: { ...process.env, RECORDER_UNDER_XVFB: "1" },
    });
    process.exit(r.status === null ? 1 : r.status);
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  /* ONLY=<words> runs the tests whose names contain them. */
  if (process.env.ONLY && !name.toLowerCase().includes(process.env.ONLY.toLowerCase())) return;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}\n        ${String(err.message).split("\n").join("\n        ")}`);
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

const ARGS = [
  "--auto-select-tab-capture-source-by-title=TARGET",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  for (const executablePath of [undefined, ...findLocalChromium()]) {
    try {
      return await chromium.launch({ headless: false, args: ARGS, ...(executablePath ? { executablePath } : {}) });
    } catch {
      /* next */
    }
  }
  return null;
}

const SUPABASE_HOST = (() => {
  const cfg = fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8");
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(cfg);
  assert.ok(m, "SUPABASE_URL is gone from config.js — this file cannot intercept what it cannot name");
  return m[1];
})();
const TAB_KEY = (() => {
  const m = /const TAB_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8"));
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx");
  return m[1];
})();

const USER_ID = "00000000-0000-4000-8000-000000000007";
const USER = { id: USER_ID, email: "recorder-probe@example.test", aud: "authenticated", role: "authenticated" };
const PROFILE_ROW = { user_id: USER_ID, tier: "ai", trial_credits_used: 0, active_device_id: null, active_device_at: null };
const CONSENTED_META = buildConsentPatch();
const SOURCE = AI_NOTES_COPY.audioSource.options;
const RECOVERY_KEY = "11111111-2222-4333-8444-555555555555";
/* Seconds a minted token lives in the expiry tests: long enough that a
   token is good through one tap after it is minted, short enough that
   waiting it out costs seconds rather than the hour it stands for. */
const LIFE = 6;

const RESULT = {
  ok: true,
  summaryFailed: false,
  translated: null,
  original: {
    overview: "Working memory holds about four chunks, not seven.",
    keyPoints: ["Chunking lets several items count as one, which is why phone numbers are grouped."],
    terms: [{ term: "Chunk", content: "A group of items remembered as a single unit." }],
    assessable: ["The four-chunk estimate will be on the exam."],
    openQuestions: [],
  },
};
const FAILED_SUMMARY = { ok: true, summaryFailed: true, transcript: "Today we look at working memory.", original: null, translated: null };

const ACAO = { "access-control-allow-origin": "*" };
const json = (body, status = 200) => ({ status, contentType: "application/json", headers: ACAO, body: JSON.stringify(body) });

/* The meeting: a tab titled TARGET that is making a sound. */
const TARGET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-target-"));
const TARGET_FILE = path.join(TARGET_DIR, "meeting.html");
fs.writeFileSync(
  TARGET_FILE,
  `<!doctype html><title>TARGET</title><body>a meeting<script>
  const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 330; o.connect(c.destination); o.start();
  </script></body>`
);

/* Installed before the app's own scripts: the hidden-tab switch, and a
   record of every recorder and stream the app makes, so a test can
   reach the objects the app is holding. Nothing here changes what the
   app does unless a test pulls one of these levers. */
const INSTRUMENT = () => {
  let hidden = false;
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => hidden });
  window.__setHidden = (h) => {
    hidden = !!h;
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  };
  window.__titles = [];
  const watchTitle = () => {
    const t = document.querySelector("title");
    if (!t) return false;
    new MutationObserver(() => window.__titles.push(document.title)).observe(t, { childList: true, characterData: true, subtree: true });
    return true;
  };
  if (!watchTitle()) document.addEventListener("DOMContentLoaded", watchTitle);

  const Original = window.MediaRecorder;
  window.__recorders = [];
  window.MediaRecorder = class extends Original {
    constructor(...a) {
      super(...a);
      window.__recorders.push(this);
    }
  };
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  const gdm = md.getDisplayMedia.bind(md);
  window.__micStreams = [];
  window.__displayStreams = [];
  md.getUserMedia = async (c) => {
    const s = await gum(c);
    window.__micStreams.push(s);
    return s;
  };
  md.getDisplayMedia = async (c) => {
    const s = await gdm(c);
    window.__displayStreams.push(s);
    return s;
  };
};

/**
 * The app, signed in, on the AI tab, with every request it makes
 * answered here. `lifetime` is how long a minted token lives, in
 * seconds; `fnReplies` scripts the ai-notes function ("ok", "401",
 * "failedSummary"), one reply per call, "ok" once it runs out.
 */
async function openApp(browser, { lifetime = 3600, fnReplies = [], pendingKey = null } = {}) {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["microphone"]);
  const target = await ctx.newPage();
  await target.goto("file://" + TARGET_FILE);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const net = { minted: new Map(), fn: [], uploads: [], reports: [], errors, slowRefreshMs: 0 };
  let n = 0;
  net.minted.set("tok-0", Date.now());
  const expiresIn = (token) => net.minted.get(token) + lifetime * 1000 - Date.now();
  const projectRef = new URL(SUPABASE_HOST).hostname.split(".")[0];

  await page.addInitScript(INSTRUMENT);
  await page.addInitScript(
    ({ ref, user, tabKey, consent, lifetime: life, pending }) => {
      localStorage.setItem(
        `sb-${ref}-auth-token`,
        JSON.stringify({
          access_token: "tok-0",
          token_type: "bearer",
          expires_at: Math.floor(Date.now() / 1000) + life,
          expires_in: life,
          refresh_token: "rt-0",
          user,
        })
      );
      localStorage.setItem("uni-planner-mode", "light");
      localStorage.setItem(tabKey, "ai-notes");
      localStorage.setItem(
        "uni-planner-v1",
        JSON.stringify({
          semester: "Semester 1",
          semesters: { "Semester 1": { courses: [{ id: "c1", name: "PSYC1001", updatedAt: "2026-10-01T00:00:00.000Z" }] } },
          meta: pending
            ? { ...consent, pendingAiRecovery: { key: pending, course: "PSYC1001", week: "3", startedAt: new Date().toISOString() } }
            : consent,
        })
      );
    },
    { ref: projectRef, user: USER, tabKey: TAB_KEY, consent: CONSENTED_META, lifetime, pending: pendingKey }
  );

  await page.route(`${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes("/auth/v1/token")) {
      /* A slow connection: the refresh a returning tab starts is still
         in flight when the student taps. */
      if (net.slowRefreshMs) await new Promise((r) => setTimeout(r, net.slowRefreshMs));
      n += 1;
      const token = `tok-${n}`;
      net.minted.set(token, Date.now());
      return route.fulfill(
        json({
          access_token: token,
          token_type: "bearer",
          expires_in: lifetime,
          expires_at: Math.floor(Date.now() / 1000) + lifetime,
          refresh_token: `rt-${n}`,
          user: USER,
        })
      );
    }
    if (url.includes("/auth/v1/user")) return route.fulfill(json(USER));
    if (url.includes("/functions/v1/ai-notes")) {
      const token = (req.headers()["authorization"] || "").replace(/^Bearer\s+/, "");
      const known = net.minted.has(token);
      const call = { token, body: JSON.parse(req.postData() || "{}"), valid: known && expiresIn(token) > 0, expiredForMs: known ? -expiresIn(token) : null };
      net.fn.push(call);
      const reply = fnReplies.length ? fnReplies.shift() : "ok";
      /* What the functions gateway does with a token that is unknown or
         past its expiry, before our code runs. */
      if (reply === "401" || !call.valid) return route.fulfill(json({ code: 401, message: "Invalid JWT" }, 401));
      return route.fulfill(json({ ok: true, result: reply === "failedSummary" ? FAILED_SUMMARY : RESULT }));
    }
    if (url.includes("/storage/v1/object/")) {
      net.uploads.push({ url, bytes: (req.postDataBuffer() || Buffer.alloc(0)).length });
      return route.fulfill(json({ Key: "lecture-audio/x", Id: "x" }));
    }
    if (url.includes("/rest/v1/client_errors") && req.method() === "POST") {
      net.reports.push(req.postData());
      return route.fulfill(json([], 201));
    }
    if (url.includes("/rest/v1/profiles")) return route.fulfill(json(PROFILE_ROW));
    if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 12 }));
    return route.fulfill(json([]));
  });

  await page.goto("file://" + path.join(OUT, "index.html"));
  await page.waitForSelector("#root > *", { timeout: 15_000 });
  return { ctx, page, target, net };
}

/** Hidden, and every token the app was ever given has expired — the
    state an hour in a background tab leaves it in. Waited for rather
    than slept: anything the app does while hidden (a debounced push,
    say) mints a new token and moves the deadline. */
async function hideUntilEveryTokenExpires(page, net, lifetime) {
  await page.evaluate(() => window.__setHidden(true));
  const last = () => Math.max(...net.minted.values());
  const reached = await until(() => Date.now() > last() + lifetime * 1000 + 500, 30_000);
  assert.ok(reached, "tokens kept being minted while the planner was hidden, so the expired-token case was never reached");
}

async function until(fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Fill the form and start, from the given source. The AI tab has a
    second week field (summarise a reading), so the form is found from
    its own Start button rather than by a placeholder two cards share. */
async function startRecording(page, source = "system") {
  await page.getByRole("button", { name: "Start recording" }).waitFor({ timeout: 15_000 });
  const card = page.locator(
    "xpath=//button[normalize-space()='Start recording']/ancestor::div[.//input[@placeholder='e.g. 5'] and .//select][1]"
  );
  await card.locator('select:has(option[value="PSYC1001"])').selectOption("PSYC1001");
  await card.getByPlaceholder("e.g. 5").fill("3");
  await page.getByRole("button", { name: SOURCE[source], exact: true }).click();
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByRole("button", { name: "Stop" }).first().waitFor({ timeout: 10_000 });
}

const review = (page) => page.getByRole("button", { name: "Save to Notes" });
const plannerPages = (page) =>
  page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("uni-planner-v1") || "{}");
    return (((d.semesters || {})["Semester 1"] || {}).pages || []).filter((p) => !p.deletedAt && p.aiMeta);
  });

async function run() {
  assert.ok(fs.existsSync(path.join(OUT, "app.js")), "dist-web is missing — run npm run build:web first");

  await test("EVERY WAY THE RECORDER CAN END ON ITS OWN HAS A SENTENCE ON THE REVIEW SCREEN — derived from the recorder's source", () => {
    /* Read out of the recorder, not listed here: a fifth way to end
       added later must arrive with its sentence, or the review screen
       shows a short recording and says nothing about why. Comments are
       stripped first -- the explanations name the reasons too. */
    const src = fs
      .readFileSync(path.join(rootDir, "src/aiNotes.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const reasons = [...new Set([...src.matchAll(/"([a-z]+-ended)"/g)].map((m) => m[1]))].sort();
    assert.ok(reasons.length >= 3, `found ${JSON.stringify(reasons)} — the recorder names no way of ending on its own, so this checks nothing`);
    const ended = AI_NOTES_COPY.ended || {};
    const silent = reasons.filter((r) => typeof ended[r] !== "string" || !ended[r].trim());
    assert.deepEqual(silent, [], `the recorder can end with ${JSON.stringify(silent)} and the review screen has nothing to say about it`);
  });

  const browser = await launch();
  if (!browser) {
    const message = "no headful Chromium (needs a display or xvfb-run) — skipping (REQUIRE_BROWSER=1 to fail)";
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    return;
  }

  /* ---------------- the share itself ---------------- */

  await test("THE SHARE IS A REAL TAB: the tracks the app records from are the browser's tab capture, not a fake screen", async () => {
    const { ctx, page } = await openApp(browser);
    await startRecording(page);
    const labels = await page.evaluate(() => window.__displayStreams[0].getTracks().map((t) => `${t.kind}:${t.label}`));
    await ctx.close();
    assert.ok(labels.length === 2, `expected an audio and a video track, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("audio:Tab audio"), `the audio track is ${JSON.stringify(labels)} — not a tab share, so nothing below is about one`);
    assert.ok(labels.some((l) => l.startsWith("video:web-contents-media-stream://")), `not a tab's video: ${JSON.stringify(labels)}`);
  });

  /* ---------------- fix 1: the token is read when the call is made ---------------- */

  await test("A RECORDING THAT ENDS AFTER THE PLANNER WAS HIDDEN LONGER THAN A TOKEN LIVES IS SENT WITH A TOKEN THAT IS STILL VALID", async () => {
    /* The 1:50 case, compressed: tokens live seconds, the planner stays
       hidden until every one of them has expired, then the meeting tab
       closes and the share ends. */
    const { ctx, page, target, net } = await openApp(browser, { lifetime: LIFE });
    await startRecording(page);
    await hideUntilEveryTokenExpires(page, net, LIFE);
    await target.close();
    await until(() => net.fn.length >= 1, 15_000);
    await page.waitForTimeout(800);
    const reachedReview = await review(page).isVisible();
    await ctx.close();
    assert.ok(net.uploads.length === 1 && net.uploads[0].bytes > 0, `expected one upload with audio in it, got ${JSON.stringify(net.uploads)}`);
    assert.ok(net.fn.length >= 1, "the ai-notes function was never called");
    assert.ok(
      net.fn[0].valid,
      `the call to ai-notes carried ${net.fn[0].token}, which had expired ${(net.fn[0].expiredForMs / 1000).toFixed(1)} s before ` +
        "the request — the gateway answers that with a 401 and the student sees “Something went wrong (401)”"
    );
    assert.ok(reachedReview, "the notes never reached the review screen");
  });

  await test("A 401 FROM THE FUNCTION GETS ONE FRESH TOKEN AND ONE RETRY, AND THE NOTES ARRIVE", async () => {
    const { ctx, page, net } = await openApp(browser, { fnReplies: ["401", "ok"] });
    await startRecording(page);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Stop" }).first().click();
    await until(() => net.fn.length >= 2, 10_000);
    await page.waitForTimeout(800);
    const reachedReview = await review(page).isVisible();
    await ctx.close();
    assert.equal(net.fn.length, 2, `expected the refused call and one retry, got ${net.fn.length} call(s)`);
    assert.notEqual(net.fn[1].token, net.fn[0].token, "the retry went out with the same token that was refused");
    assert.equal(net.uploads.length, 1, `the retry re-uploaded the audio (${net.uploads.length} uploads)`);
    assert.ok(reachedReview, "the notes never reached the review screen");
  });

  await test("A 401 THAT PERSISTS IS SHOWN AFTER ONE RETRY — NOT RETRIED IN A LOOP", async () => {
    const { ctx, page, net } = await openApp(browser, { fnReplies: ["401", "401", "401", "401"] });
    await startRecording(page);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Stop" }).first().click();
    await until(() => net.fn.length >= 2, 10_000);
    await page.waitForTimeout(2500);
    const tryAgain = await page.getByRole("button", { name: "Try again" }).isVisible();
    await ctx.close();
    assert.equal(net.fn.length, 2, `expected exactly two attempts, got ${net.fn.length}`);
    assert.ok(tryAgain, "the failure was not shown with its Try again");
  });

  await test("THE RECOVERY CARD SENDS A TOKEN THAT IS VALID WHEN IT IS PRESSED", async () => {
    /* Coming back to the tab starts a refresh; on a slow connection it
       is still in flight when the student taps. */
    const { ctx, page, net } = await openApp(browser, { lifetime: LIFE, pendingKey: RECOVERY_KEY });
    await page.getByRole("button", { name: "Get it back" }).waitFor({ timeout: 15_000 });
    await hideUntilEveryTokenExpires(page, net, LIFE);
    net.slowRefreshMs = 1500;
    await page.evaluate(() => window.__setHidden(false));
    await page.getByRole("button", { name: "Get it back" }).click();
    await until(() => net.fn.length >= 1, 10_000);
    await page.waitForTimeout(800);
    const reachedReview = await review(page).isVisible();
    await ctx.close();
    assert.ok(net.fn.length >= 1, "Get it back made no request");
    assert.ok(net.fn[0].valid, `Get it back sent ${net.fn[0].token}, expired ${(net.fn[0].expiredForMs / 1000).toFixed(1)} s earlier`);
    assert.ok(reachedReview, "the recovered notes never reached the review screen");
  });

  await test("THE SUMMARY RETRY SENDS A TOKEN THAT IS VALID WHEN IT IS PRESSED", async () => {
    /* A recording whose summary failed: the retry is offered on the
       review screen and goes out under the recording's own key. */
    const { ctx, page, net } = await openApp(browser, { lifetime: LIFE, fnReplies: ["failedSummary", "ok"] });
    await startRecording(page);
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Stop" }).first().click();
    const retry = page.getByRole("button", { name: AI_NOTES_COPY.summaryFailed.retry });
    await retry.waitFor({ timeout: 10_000 });
    await hideUntilEveryTokenExpires(page, net, LIFE);
    net.slowRefreshMs = 1500;
    await page.evaluate(() => window.__setHidden(false));
    await retry.click();
    await until(() => net.fn.length >= 2, 10_000);
    await page.waitForTimeout(800);
    const reachedReview = await review(page).isVisible();
    await ctx.close();
    assert.ok(net.fn.length >= 2, "the summary retry made no request");
    assert.equal(net.fn[1].body.mode, "resummarise", "the second call is not the summary retry");
    assert.ok(net.fn[1].valid, `the summary retry sent ${net.fn[1].token}, expired ${(net.fn[1].expiredForMs / 1000).toFixed(1)} s earlier`);
    assert.ok(reachedReview, "the retried summary never reached the review screen");
  });

  /* ---------------- fix 2: a share that ends on its own is seen ---------------- */

  await test("A SHARE THAT ENDS ON ITS OWN WHILE THE PLANNER IS HIDDEN: THE TAB TITLE SAYS SO UNTIL IT IS SEEN, AND THE REQUEST SAYS WHY", async () => {
    const { ctx, page, target, net } = await openApp(browser);
    const base = await page.title();
    await startRecording(page);
    await page.evaluate(() => window.__setHidden(true));
    await page.waitForTimeout(1500);
    const recordingTitle = await page.title();
    await target.close();
    await until(() => net.fn.length >= 1, 10_000);
    await page.waitForTimeout(800);
    const stoppedTitle = await page.title();
    await page.evaluate(() => window.__setHidden(false));
    await page.waitForTimeout(400);
    const seenTitle = await page.title();
    const line = await page.getByText(AI_NOTES_COPY.audioSource.shareEnded).isVisible();
    await ctx.close();
    assert.notEqual(recordingTitle, base, `the planner's own tab still read “${base}” while recording, so nothing in the tab strip said so`);
    assert.ok(net.fn.length === 1, `expected one request, got ${net.fn.length}`);
    assert.equal(net.fn[0].body.endReason, "share-ended", `the request says the recording ended because ${JSON.stringify(net.fn[0].body.endReason)}`);
    assert.ok(net.fn[0].body.estimatedDurationSeconds >= 1, "the request carries no recorded length");
    assert.notEqual(stoppedTitle, base, "the share ended on its own and the hidden tab's title said nothing about it");
    assert.notEqual(stoppedTitle, recordingTitle, "the hidden tab still says it is recording after the recording ended");
    assert.equal(seenTitle, base, `the warning title outlived the student coming back to the tab: “${seenTitle}”`);
    assert.ok(line, "the review screen does not say the share ended");
  });

  await test("A RECORDING THE STUDENT STOPS SAYS SO, AND THE TAB NEVER SHOWS THE WARNING", async () => {
    const { ctx, page, net } = await openApp(browser);
    const base = await page.title();
    await startRecording(page);
    await page.waitForTimeout(1200);
    const recordingTitle = await page.title();
    await page.getByRole("button", { name: "Stop" }).first().click();
    await until(() => net.fn.length >= 1, 10_000);
    await page.waitForTimeout(800);
    const titles = await page.evaluate(() => window.__titles);
    const after = await page.title();
    await ctx.close();
    assert.equal(net.fn[0] && net.fn[0].body.endReason, "you-stopped", `the request says ${JSON.stringify(net.fn[0] && net.fn[0].body.endReason)}`);
    assert.equal(after, base, `after the student stopped it the title reads “${after}”`);
    const strays = titles.filter((t) => t !== base && t !== recordingTitle);
    assert.deepEqual(strays, [], `a stopped-by-the-student recording showed other titles: ${JSON.stringify(strays)}`);
  });

  await test("RECORD THE REST: SAVES THE FIRST PART AND STARTS AGAIN FOR THE SAME COURSE AND WEEK", async () => {
    const { ctx, page, target, net } = await openApp(browser);
    await startRecording(page);
    await page.waitForTimeout(1500);
    await target.close();
    await until(() => net.fn.length >= 1, 10_000);
    const control = page.locator("[data-record-the-rest]");
    const offered = await control.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
    assert.ok(offered, "after the share ended on its own there is no “Record the rest”");
    const second = await ctx.newPage();
    await second.goto("file://" + TARGET_FILE);
    await page.bringToFront();
    await control.click();
    await page.getByRole("button", { name: "Stop" }).first().waitFor({ timeout: 10_000 });
    const firstPart = await until(async () => (await plannerPages(page)).length === 1, 5_000);
    const pagesAfterFirst = await plannerPages(page);
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Stop" }).first().click();
    await until(() => net.fn.length >= 2, 10_000);
    await review(page).click({ timeout: 10_000 });
    await until(async () => (await plannerPages(page)).length === 2, 5_000);
    const pages = await plannerPages(page);
    await ctx.close();
    assert.ok(firstPart, `the first part was not saved when the second recording started (${pagesAfterFirst.length} notes)`);
    const [one] = pagesAfterFirst;
    assert.equal(one.aiMeta.course, "PSYC1001");
    assert.equal(one.aiMeta.week, "3");
    assert.equal(one.aiMeta.endReason, "share-ended", "the saved first part does not say why it ended");
    assert.ok(one.aiMeta.recordedSeconds >= 1, "the saved first part does not say how long it was");
    assert.equal(net.fn[1].body.course, "PSYC1001", "the second recording lost the course");
    assert.equal(net.fn[1].body.endReason, "you-stopped");
    assert.equal(pages.length, 2, `expected both parts saved, found ${pages.length}`);
    assert.ok(pages.every((p) => p.aiMeta.course === "PSYC1001" && p.aiMeta.week === "3"), "the second part lost the course or the week");
  });

  /* ---------------- fix 3: the recorder notices its own end ---------------- */

  /* Real: a recorded stream whose track set changes makes Chromium fire
     error (InvalidModificationError), then data, then stop. */
  const browserStopsTheRecorder = (page, { appHearsIt = true } = {}) =>
    page.evaluate((hears) => {
      const r = window.__recorders[window.__recorders.length - 1];
      /* The case a recorder with no handler of its own was in: the
         browser's stop arrives and nothing of the app's is listening. */
      if (!hears) r.onstop = null;
      const c = new AudioContext();
      r.stream.addTrack(c.createMediaStreamDestination().stream.getAudioTracks()[0]);
    }, appHearsIt);

  await test("A RECORDER THE BROWSER STOPS BY ITSELF BECOMES NOTES ON ITS OWN — NOBODY HAS TO PRESS ANYTHING", async () => {
    const { ctx, page, net } = await openApp(browser);
    await startRecording(page);
    await page.waitForTimeout(2500);
    await browserStopsTheRecorder(page);
    const onItsOwn = await until(() => net.uploads.length >= 1, 4_000);
    await until(() => net.fn.length >= 1, 8_000);
    await page.waitForTimeout(600);
    const reachedReview = await review(page).isVisible();
    const said = await page.locator("[data-ended-reason='recorder-ended']").isVisible();
    await ctx.close();
    assert.ok(onItsOwn, "the browser stopped the recorder and the screen went on saying Recording — the audio never left the device");
    assert.ok(net.uploads[0].bytes > 0, "the upload was empty");
    assert.equal(net.fn[0] && net.fn[0].body.endReason, "recorder-ended");
    assert.ok(reachedReview, "the notes never reached the review screen");
    assert.ok(said, "the review screen does not say the browser stopped the recording");
  });

  await test("STOP ON A RECORDER THE BROWSER HAS ALREADY STOPPED FINISHES — IT DOES NOT HANG", async () => {
    /* A stop() on an inactive recorder fires no event at all (measured),
       so anything that waits for one waits for ever. */
    const { ctx, page, net } = await openApp(browser);
    await startRecording(page);
    await page.waitForTimeout(2500);
    await browserStopsTheRecorder(page, { appHearsIt: false });
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Stop" }).first().click({ timeout: 3_000 });
    const finished = await until(() => net.uploads.length >= 1, 5_000);
    await until(() => net.fn.length >= 1, 8_000);
    await ctx.close();
    assert.ok(finished, "Stop was pressed on a recorder the browser had already stopped, and nothing happened — the minutes stayed in memory");
    assert.ok(net.uploads[0].bytes > 0, "the upload was empty");
  });

  await test("A MICROPHONE THAT GOES AWAY STOPS THE RECORDING AND KEEPS WHAT WAS CAPTURED", async () => {
    const { ctx, page, net } = await openApp(browser);
    await startRecording(page, "microphone");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const s = window.__micStreams[window.__micStreams.length - 1];
      s.getAudioTracks()[0].dispatchEvent(new Event("ended"));
    });
    await until(() => net.fn.length >= 1, 8_000);
    await page.waitForTimeout(600);
    const said = await page.locator("[data-ended-reason='mic-ended']").isVisible();
    await ctx.close();
    assert.ok(net.uploads.length === 1 && net.uploads[0].bytes > 0, "a microphone that went away left the recording running on silence");
    assert.equal(net.fn[0] && net.fn[0].body.endReason, "mic-ended");
    assert.ok(said, "the review screen does not say the microphone stopped");
  });

  await test("SHARED AUDIO THAT GOES MUTED IS WARNED ABOUT; THE VIDEO TRACK'S ROUTINE MUTE IS NOT", async () => {
    const { ctx, page } = await openApp(browser);
    await startRecording(page);
    await page.waitForTimeout(6000);
    const videoMuted = await page.evaluate(() => window.__displayStreams[0].getVideoTracks()[0].muted);
    const beforeAudioMute = await page.locator("[data-share-muted]").count();
    await page.evaluate(() => window.__displayStreams[0].getAudioTracks()[0].dispatchEvent(new Event("mute")));
    const warned = await page
      .locator("[data-share-muted]")
      .waitFor({ timeout: 3_000 })
      .then(() => true, () => false);
    await ctx.close();
    assert.ok(videoMuted, "precondition: the shared tab's video track never went muted, so “no warning” below would prove nothing");
    assert.equal(beforeAudioMute, 0, "the video track's routine mute raised a warning — it would on every share of a still page");
    assert.ok(warned, "the shared audio went muted and nothing said so — that is a recording of silence, billed");
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) process.exit(1);
}

run().catch((err) => {
  console.log(`FAIL  - the suite itself threw\n        ${err.stack || err}`);
  process.exit(1);
});
