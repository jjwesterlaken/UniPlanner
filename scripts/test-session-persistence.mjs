/* A SIGN-IN SURVIVES A REOPEN — including the reopen where the refresh
   could not reach the server.

   THE FAILURE THIS EXISTS FOR, reported from a phone and diagnosed
   before it was reproduced. `supabaseBackend.getSession` (sync.js)
   reads `data.session` and throws `error` away, so THREE outcomes
   arrive as two:

     - there is a session
     - there is definitively no session
     - we could not find out

   auth-js is careful about this and we were not. On a retryable fetch
   error it PRESERVES the stored session (GoTrueClient `_callRefreshToken`)
   — but `__loadSession` still answers `{ session: null, error }` once
   the access token has genuinely expired. Discard the error and a live
   refresh token, sitting in localStorage, reads as "signed out".

   Nothing then corrects it. `onAuthStateChange` in PlannerApp handled
   only PASSWORD_RECOVERY, so the `SIGNED_IN` that auth-js emits when it
   recovers on hidden->visible was ignored; and the app's own focus sync
   opens `if (!session || !loaded) return`, so it is inert the moment
   `session` is null. The student is shown a sign-in form over a live
   session for the rest of that app run, and signs in again.

   WHY IT IS WORST ON A PHONE and why no existing guard saw it: it needs
   an access token past its hour AND no network for the first moment of
   the reopen, which is a phone waking its radio. Every suite that
   mounts the app seeds a session that has not expired, and `e2e/`
   builds its client with `persistSession: false` — a fixture default
   asserting the opposite of production.

   WHAT IS AND IS NOT MODELLED HERE. The built bundle runs in real
   Chromium with the real auth-js, its real storage and its real refresh
   path; only the network is intercepted. What no test on a build
   machine can answer is whether iOS evicts WKWebView storage across an
   app update — that is on MOBILE-BUILD.md's hardware list, unverified,
   and it is a DIFFERENT bug with a different symptom (every reopen,
   immediately) if it turns out to be real.

   Skips without a browser; REQUIRE_BROWSER=1 makes that a failure. */

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

/* EVERY NAME BELOW IS LIFTED, NOT TYPED. A guard that restates the key
   it seeds is a guard that goes on seeding the old one. */
const TAB_KEY = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const m = /const TAB_KEY = "([^"]+)"/.exec(src);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx — this guard cannot open a tab it cannot name");
  return m[1];
})();

const SUPABASE_URL = (() => {
  const cfg = fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8");
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(cfg);
  assert.ok(m, "SUPABASE_URL is gone from config.js — this guard cannot intercept what it cannot name");
  return m[1];
})();

/* The storage key auth-js derives from the project ref. Derived the way
   the library derives it, so a project change follows. */
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const AUTH_KEY = `sb-${PROJECT_REF}-auth-token`;

const USER_ID = "00000000-0000-4000-8000-000000000001";
const EMAIL = "reopen-probe@example.test";

const PROFILE_ROW = {
  user_id: USER_ID,
  tier: "ai",
  trial_credits_used: 0,
  active_device_id: null,
  active_device_at: null,
};

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** A stored session, `secondsToExpiry` from now. Negative means expired. */
function storedSession(secondsToExpiry) {
  const at = Math.floor(Date.now() / 1000) + secondsToExpiry;
  return {
    access_token: "seeded-access-token",
    token_type: "bearer",
    expires_at: at,
    expires_in: secondsToExpiry,
    refresh_token: "seeded-refresh-token",
    user: { id: USER_ID, email: EMAIL, aud: "authenticated", role: "authenticated" },
  };
}

/**
 * Open the app on the Account tab with `stored` already in localStorage
 * — which IS the reopen: a fresh page over storage that survived.
 *
 * `refresh` decides what the token endpoint does, and the three values
 * are the three things that actually happen to a phone:
 *   "ok"      — the network is there
 *   "offline" — the request never completes (radio still waking)
 *   "revoked" — the server definitively rejects the refresh token
 */
async function reopen(browser, { stored, refresh }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.addInitScript(
    ({ key, value, tabKey }) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      localStorage.setItem("uni-planner-mode", "light");
      localStorage.setItem(tabKey, "account");
      localStorage.setItem(
        "uni-planner-v1",
        JSON.stringify({ semester: "Semester 1", semesters: {}, meta: {} })
      );
    },
    { key: AUTH_KEY, value: stored ? JSON.stringify(stored) : null, tabKey: TAB_KEY }
  );

  let refreshAttempts = 0;
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes("/auth/v1/token")) {
      refreshAttempts += 1;
      /* ABORT, NOT A 5xx. auth-js tells a dropped connection from a
         rejection by the ERROR TYPE: a failed fetch is retryable and
         the session is kept, a definitive rejection is not and the
         session is removed. A 500 here would test neither branch
         faithfully. */
      if (refresh === "offline") return route.abort("connectionfailed");
      if (refresh === "revoked") {
        return route.fulfill(json({ error: "invalid_grant", error_description: "Invalid Refresh Token" }, 400));
      }
      return route.fulfill(
        json({
          access_token: "refreshed-access-token",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: "refreshed-refresh-token",
          user: { id: USER_ID, email: EMAIL, aud: "authenticated", role: "authenticated" },
        })
      );
    }
    if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: EMAIL }));
    if (url.includes("/rest/v1/profiles")) return route.fulfill(json(PROFILE_ROW));
    if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 12 }));
    return route.fulfill(json([]));
  });

  await page.goto("file://" + path.join(OUT, "index.html"));
  await page.waitForSelector("main", { timeout: 15000 });
  /* The boot read is a promise and the refresh is a network round trip,
     so the signed-out shell can be the FIRST frame legitimately. What is
     asserted is where it SETTLES. */
  await page.waitForTimeout(1500);

  const html = await page.locator("main").innerHTML();
  const passwordInputs = await page.locator('main input[type="password"]').count();
  const storedAfter = await page.evaluate((k) => localStorage.getItem(k), AUTH_KEY);

  await ctx.close();
  return { html, passwordInputs, storedAfter, refreshAttempts, errors };
}

/* A password field on the Account tab is the sign-in form, which is the
   thing the student reported seeing. Structural rather than a phrase,
   because every wording pin in this repository has gone red on somebody
   improving the writing. */
const signedOut = (r) => r.passwordInputs > 0;
const signedIn = (r) => r.passwordInputs === 0 && r.html.includes(EMAIL);

async function main() {
  if (!fs.existsSync(path.join(OUT, "index.html"))) {
    console.log("dist-web is missing — run `npm run build:web` first.");
    process.exit(1);
  }

  const browser = await launch();
  if (!browser) {
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log("FAIL  - no browser, and REQUIRE_BROWSER=1");
      process.exit(1);
    }
    console.log("  --  no Chromium available; skipping (set REQUIRE_BROWSER=1 to make this a failure)");
    return;
  }

  /* ---------------------------------------------------------------- */
  /*  The two ends, asserted FIRST. Without them every claim below is  */
  /*  satisfied by an app that always renders one way.                 */
  /* ---------------------------------------------------------------- */

  await test("WITH NO STORED SESSION THE APP IS SIGNED OUT — the other end of the claim", async () => {
    const r = await reopen(browser, { stored: null, refresh: "ok" });
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(
      signedOut(r),
      "a reopen with nothing in storage did not show the sign-in form, so every 'still signed in' below could be an app that never signs anybody out"
    );
  });

  await test("a live session survives a reopen", async () => {
    const r = await reopen(browser, { stored: storedSession(3600), refresh: "ok" });
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(signedIn(r), `an unexpired session did not render signed in — nothing below is about expiry. Got: ${r.html.slice(0, 300)}`);
  });

  /* ---------------------------------------------------------------- */
  /*  Expiry: the refresh happens, and its OUTCOME is what decides     */
  /* ---------------------------------------------------------------- */

  await test("an expired access token is refreshed on reopen, and the student stays in", async () => {
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "ok" });
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(r.refreshAttempts > 0, "no refresh was attempted, so the seeded expiry is not reaching auth-js and the offline case below proves nothing");
    assert.ok(signedIn(r), "an expired token with a working network did not refresh into a signed-in app");
  });

  await test("THE CONTROL: A REFRESH THAT COULD NOT REACH THE SERVER IS NOT A SIGN-OUT", async () => {
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "offline" });
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(r.refreshAttempts > 0, "no refresh was attempted, so this test is not exercising the failure it names");

    /* THE EVIDENCE, asserted before the verdict: auth-js kept the
       session. Whatever the app decided, it did not decide it because
       the credential was gone. */
    assert.ok(
      r.storedAfter && JSON.parse(r.storedAfter).refresh_token === "seeded-refresh-token",
      "auth-js discarded the refresh token on a network failure — that would be a library problem, not the one this file is about"
    );

    assert.ok(
      signedIn(r),
      "a reopen with no network showed the sign-in form over a refresh token still in storage — the student is being asked to sign in to an account they are still signed in to"
    );
  });

  await test("a REVOKED refresh token really does sign the student out", async () => {
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "revoked" });
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(r.refreshAttempts > 0, "no refresh was attempted");
    assert.ok(
      signedOut(r),
      "a definitively rejected refresh token left the app looking signed in — 'keep what we had' must not become 'never sign anybody out'"
    );
  });

  await browser.close();
}

await main();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
