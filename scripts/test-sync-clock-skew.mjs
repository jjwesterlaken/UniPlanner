/* "JWT issued at future": a refusal that clears itself is retried, not
   shown — from the BUILT bundle, in real Chromium, signed in.

   THE INCIDENT, 7 October 2026, 1:50:19 pm. A tab hidden for an hour
   and forty-six minutes became visible; auth-js refreshed the session
   that had expired while it was hidden, and the app's sync went out with
   a token minted milliseconds earlier. PostgREST's clock was behind the
   issuer's, so it read the token's issued-at as in the future and
   refused it: PGRST303, "JWT issued at future". The error reporter's own
   insert, a moment later with the same token, was ACCEPTED -- which is
   what says the skew was under a second and clears by itself.

   So the student was shown "JWT issued at future" in red on the Account
   tab, and the daily digest was fed a report, for a condition one
   waited retry fixes. The rules this holds:

   - ONE refusal is retried once, after a wait, and is neither shown nor
     reported.
   - One that PERSISTS is shown in plain words -- never the token
     jargon -- and reported, because then it is not a passing skew.
   - The retry WAITS. Retrying at once hits the same skew; looping hits
     the server. Two attempts, a measurable gap between them.

   The network is intercepted: the planner pull answers exactly what
   PostgREST answered at 02:50:19 UTC. Skips without a browser;
   REQUIRE_BROWSER=1 makes that a failure. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");

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

const SUPABASE_HOST = (() => {
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8"));
  assert.ok(m, "SUPABASE_URL is gone from config.js");
  return m[1];
})();
const TAB_KEY = (() => {
  const m = /const TAB_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8"));
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx");
  return m[1];
})();
const ACCOUNT_TAB = (() => {
  const m = /const SETTINGS_TAB = \{ id: "([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8"));
  assert.ok(m, "SETTINGS_TAB is gone from PlannerApp.jsx");
  return m[1];
})();

const USER_ID = "00000000-0000-4000-8000-000000000008";
const USER = { id: USER_ID, email: "sync-probe@example.test", aud: "authenticated", role: "authenticated" };
const ACAO = { "access-control-allow-origin": "*" };
const json = (body, status = 200) => ({ status, contentType: "application/json", headers: ACAO, body: JSON.stringify(body) });
/* Byte for byte what PostgREST answered at 02:50:19 UTC. */
const PGRST303 = { code: "PGRST303", details: null, hint: null, message: "JWT issued at future" };

/** The app on the Account tab; `refusals` is how many planner pulls are refused before one succeeds. */
async function openAccount(browser, refusals) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const net = { pulls: [], pushes: 0, reports: [], errors };
  const projectRef = new URL(SUPABASE_HOST).hostname.split(".")[0];
  await page.addInitScript(
    ({ ref, user, tabKey, tab }) => {
      localStorage.setItem(
        `sb-${ref}-auth-token`,
        JSON.stringify({
          access_token: "tok-0",
          token_type: "bearer",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          refresh_token: "rt-0",
          user,
        })
      );
      localStorage.setItem("uni-planner-mode", "light");
      localStorage.setItem(tabKey, tab);
    },
    { ref: projectRef, user: USER, tabKey: TAB_KEY, tab: ACCOUNT_TAB }
  );
  await page.route(`${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes("/auth/v1/user")) return route.fulfill(json(USER));
    if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "tok-0", token_type: "bearer", expires_in: 3600, refresh_token: "rt-0", user: USER }));
    if (url.includes("/rest/v1/planner_data")) {
      if (req.method() === "GET") {
        net.pulls.push(Date.now());
        if (net.pulls.length <= refusals) return route.fulfill(json(PGRST303, 401));
        return route.fulfill(json([]));
      }
      net.pushes += 1;
      return route.fulfill(json([], 201));
    }
    if (url.includes("/rest/v1/client_errors") && req.method() === "POST") {
      net.reports.push(JSON.parse(req.postData() || "null"));
      return route.fulfill(json([], 201));
    }
    return route.fulfill(json([]));
  });
  await page.goto("file://" + path.join(OUT, "index.html"));
  await page.waitForSelector("#root > *", { timeout: 15_000 });
  return { ctx, page, net };
}

const accountText = (page) => page.locator("#root").innerText();
const shownSyncError = (page) => page.locator("p.text-rose-700").allInnerTexts();

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

  await test("ONE “JWT ISSUED AT FUTURE” IS RETRIED AFTER A WAIT, AND IS NEITHER SHOWN NOR REPORTED", async () => {
    const { ctx, page, net } = await openAccount(browser, 1);
    await page.waitForTimeout(5000);
    const text = await accountText(page);
    const shown = await shownSyncError(page);
    await ctx.close();
    assert.ok(net.pulls.length >= 1, "the app never pulled the planner, so nothing here was tested");
    /* The window is what separates the RETRY from the app's next
       scheduled sync, which comes about four seconds after launch
       (measured: 3,980 ms) and would otherwise look like one. */
    const gaps = net.pulls.slice(1).map((t) => t - net.pulls[0]);
    assert.ok(
      gaps.some((g) => g >= 1000 && g <= 3000),
      `no waited retry: the pulls after the refusal came at ${JSON.stringify(gaps)} ms — a retry belongs 1–3 s after it, before the next scheduled sync`
    );
    assert.ok(net.pushes >= 1, "the sync never completed with a push");
    assert.ok(!/issued at future|JWT/i.test(text), "the Account tab shows the token jargon");
    assert.deepEqual(shown, [], `a sync error is on screen: ${JSON.stringify(shown)}`);
    assert.equal(net.reports.length, 0, `a refusal that cleared on the retry was reported: ${JSON.stringify(net.reports.map((r) => r && r.message))}`);
  });

  await test("ONE THAT PERSISTS IS SHOWN IN PLAIN WORDS AND REPORTED — AFTER EXACTLY ONE WAITED RETRY, NOT A LOOP", async () => {
    const { ctx, page, net } = await openAccount(browser, 99);
    /* WATCHED, not read once: each sync clears the message as it
       starts, and the app's own scheduled sync (about four seconds in)
       spends its retry wait with nothing on screen. */
    const seen = new Set();
    const jargon = [];
    const end = Date.now() + 7000;
    while (Date.now() < end) {
      for (const t of await shownSyncError(page)) if (t.trim()) seen.add(t.trim());
      if (/issued at future|JWT/i.test(await accountText(page))) jargon.push(Date.now());
      await page.waitForTimeout(100);
    }
    const shown = [...seen];
    const text = jargon.length ? "JWT" : "";
    await ctx.close();
    assert.ok(net.pulls.length >= 1, "the app never pulled the planner, so nothing here was tested");
    const firstSync = net.pulls.filter((t) => t - net.pulls[0] < 3000);
    assert.equal(firstSync.length, 2, `the first sync made ${firstSync.length} pull(s) in its first 3 s — expected the refused pull and one waited retry, and no more`);
    assert.ok(firstSync[1] - firstSync[0] >= 1000, `the retry did not wait: ${firstSync[1] - firstSync[0]} ms after the refusal`);
    assert.ok(shown.length === 1, `expected one sync error on screen, saw ${JSON.stringify(shown)}`);
    assert.ok(!/issued at future|JWT/i.test(text), `the Account tab shows the token jargon: ${JSON.stringify(shown)}`);
    assert.ok(net.reports.length >= 1, "a refusal that persisted through the retry was not reported");
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
