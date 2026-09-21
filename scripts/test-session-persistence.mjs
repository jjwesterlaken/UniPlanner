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
  /* EVERY EDGE FUNCTION CALL WITH THE HEADER IT CARRIED. "It called the
     function" and "it called the function as somebody" are different
     claims, and the stale-token half of this bug sits between them. */
  const fnCalls = [];
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes("/functions/v1/")) {
      fnCalls.push({
        fn: url.split("/functions/v1/")[1].split(/[?#]/)[0],
        auth: route.request().headers()["authorization"] || "",
      });
      return route.fulfill(json({ ok: true, url: "https://checkout.stripe.test/c/session_probe" }));
    }
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
  /* WHERE IT SETTLES, NOT WHAT IT FIRST PAINTS: the boot read is a
     promise and the refresh is a network round trip, so a signed-out
     frame early on is legitimate.

     THE WINDOW MUST OUTLAST THE FIRST RETRY, which cost a mutation to
     learn. The startup ladder re-reads at 2s, and collapsing `failed`
     back into "signed out" only does its damage on that second read —
     so a 1.5s window was green over the exact branch this file exists
     to hold. Anything under 2s measures the app before it has had the
     chance to get it wrong. */
  await page.waitForTimeout(3500);

  const read = async () => ({
    html: await page.locator("main").innerHTML(),
    passwordInputs: await page.locator('main input[type="password"]').count(),
    storedAfter: await page.evaluate((k) => localStorage.getItem(k), AUTH_KEY),
    refreshAttempts,
    fnCalls: [...fnCalls],
    errors,
  });

  /* The page is handed back rather than closed, because a cold mount
     cannot exercise anything that only exists after an interaction --
     and the token a button sends is exactly that. */
  return { ...(await read()), page, read, close: () => ctx.close() };
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
    await r.close();
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(
      signedOut(r),
      "a reopen with nothing in storage did not show the sign-in form, so every 'still signed in' below could be an app that never signs anybody out"
    );
  });

  await test("a live session survives a reopen", async () => {
    const r = await reopen(browser, { stored: storedSession(3600), refresh: "ok" });
    await r.close();
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(signedIn(r), `an unexpired session did not render signed in — nothing below is about expiry. Got: ${r.html.slice(0, 300)}`);
  });

  /* ---------------------------------------------------------------- */
  /*  Expiry: the refresh happens, and its OUTCOME is what decides     */
  /* ---------------------------------------------------------------- */

  await test("an expired access token is refreshed on reopen, and the student stays in", async () => {
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "ok" });
    await r.close();
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(r.refreshAttempts > 0, "no refresh was attempted, so the seeded expiry is not reaching auth-js and the offline case below proves nothing");
    assert.ok(signedIn(r), "an expired token with a working network did not refresh into a signed-in app");
  });

  await test("THE CONTROL: A REFRESH THAT COULD NOT REACH THE SERVER IS NOT A SIGN-OUT", async () => {
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "offline" });
    await r.close();
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

  await test("AND IT IS STILL NOT A SIGN-OUT ONCE auth-js GIVES UP — the slow one, deliberately", async () => {
    /* THE BRANCH A SHORT WINDOW CANNOT SEE, and it took two mutations
       to find. `supabase.auth.getSession()` does not resolve while the
       refresh is being retried, and every later caller queues behind
       the same in-flight attempt — so for the first half-minute there
       is no answer to misread, and collapsing `failed` back into
       "signed out" is green over its own bug.

       MEASURED rather than guessed. auth-js backs off 0.1 / 0.3 / 0.7 /
       1.5 / 3.1 / 6.3 / 12.7 / 25.5 seconds and then gives up, at which
       point `getSession` finally answers `{ session: null, error }`.
       With `failed` read as a sign-out the form appears at 26.3s; with
       it read as "we do not know" the app is still signed in at 50s.

       SO THIS TEST IS SLOW ON THE HAPPY PATH AND FAST WHEN BROKEN,
       which is the right way round: it polls and fails the instant the
       form appears, and only pays the full window when there is nothing
       to report. Thirty-five seconds of `npm test` for the branch that
       decides whether a student on a train is signed out is a trade
       worth making, and it is the only test here that costs anything. */
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "offline" });
    try {
      assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
      assert.ok(signedIn(r), "not signed in even at the start, so the wait below proves nothing");

      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        const pw = await r.page.locator('main input[type="password"]').count();
        assert.equal(
          pw,
          0,
          "the sign-in form appeared once auth-js stopped retrying — `failed` is being read as " +
            "\"definitively signed out\" again, which is the whole bug on a half-minute delay"
        );
        await r.page.waitForTimeout(1000);
      }

      const after = await r.read();
      assert.ok(
        after.refreshAttempts >= 5,
        `only ${after.refreshAttempts} refresh attempts in 35s — auth-js is not retrying the way this test assumes, ` +
          "so the window may no longer outlast its backoff"
      );
      assert.ok(signedIn(after), "the app stopped showing a signed-in account without ever showing the sign-in form");
    } finally {
      await r.close();
    }
  });

  await test("a REVOKED refresh token really does sign the student out", async () => {
    const r = await reopen(browser, { stored: storedSession(-60), refresh: "revoked" });
    await r.close();
    assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
    assert.ok(r.refreshAttempts > 0, "no refresh was attempted");
    assert.ok(
      signedOut(r),
      "a definitively rejected refresh token left the app looking signed in — 'keep what we had' must not become 'never sign anybody out'"
    );
  });

  await test("A REFRESH AN HOUR IN REACHES THE APP, not just auth-js", async () => {
    /* THE SECOND HALF OF THE SAME ROOT, and it has nothing to do with
       being shown a sign-in form. `shapeSession` stores the ACCESS
       token, and five call sites read it: aiNotes.jsx (record,
       re-summarise, save), aiText.jsx and plans.jsx. The auth listener
       handled only PASSWORD_RECOVERY, so a refresh partway through a
       session updated auth-js and NOT the app -- every one of those
       screens rendered perfectly and every request was refused.

       THE SCENARIO HAS TO BE A REFRESH AFTER BOOT HAS SETTLED, which
       cost a run to learn: the obvious version seeds an expired session
       and lets the boot read refresh it, and that passes with the
       listener deleted, because the boot read returns the new session
       itself. What the listener alone covers is the app that has been
       OPEN for an hour -- the startup read is long finished and its
       retry ladder has stopped, so auth-js's own refresh is the only
       thing left that knows.

       So: open with a valid session, age it, and hand the tab back the
       way a phone does. auth-js re-runs recovery on hidden -> visible,
       finds the token expired, refreshes, and emits. Nothing else in
       the app is listening at that point. */
    const r = await reopen(browser, { stored: storedSession(3600), refresh: "ok" });
    try {
      assert.equal(r.errors.length, 0, `the page threw: ${r.errors[0]}`);
      assert.ok(signedIn(r), "not signed in, so no plan button exists to press");
      assert.equal(r.refreshAttempts, 0, "a refresh already happened at startup, so this test would be measuring the boot read again");

      await r.page.evaluate((key) => {
        const raw = JSON.parse(localStorage.getItem(key));
        raw.expires_at = Math.floor(Date.now() / 1000) - 60;
        raw.expires_in = -60;
        localStorage.setItem(key, JSON.stringify(raw));
        const set = (state) => {
          Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        };
        set("hidden");
        set("visible");
      }, AUTH_KEY);
      await r.page.waitForTimeout(1200);

      const mid = await r.read();
      assert.ok(
        mid.refreshAttempts > 0,
        "coming back to the tab did not make auth-js refresh, so this test is not exercising what it names"
      );

      const button = r.page.locator('[data-web-plan="ai-monthly"]');
      assert.equal(await button.count(), 1, "no plan button to press, so this test reads nothing");
      await button.click();
      await r.page.waitForTimeout(800);

      const after = await r.read();
      const checkout = after.fnCalls.filter((c) => c.fn === "billing-checkout");
      assert.equal(
        checkout.length,
        1,
        `pressing a plan made ${checkout.length} calls to billing-checkout — the page called: ` +
          `${after.fnCalls.map((c) => c.fn).join(", ") || "(no Edge Function at all)"}`
      );
      assert.equal(
        checkout[0].auth,
        "Bearer refreshed-access-token",
        `the request carried "${checkout[0].auth}" — the app is still sending the token it opened with, ` +
          "so every Edge Function call is refused from the moment the first refresh lands"
      );
    } finally {
      await r.close();
    }
  });

  await browser.close();
}

await main();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
