/* Every tab, rendered from the BUILT bundle, signed in.

   THE FAILURE THIS EXISTS FOR, and it reached production.
   `src/aiNotes.jsx` called `allowanceForTier()` and never imported it.
   esbuild does not error on a free variable — it leaves it as a global
   — so the build was clean, 22 suites were green, coverage was 83%,
   and the AI tab threw `ReferenceError: allowanceForTier is not
   defined` on every render for every signed-in student.

   WHY NOTHING CAUGHT IT. The unit suites import the modules, which
   resolves the identifier through Node's own module graph — the bug
   is invisible there by construction. `test-app-smoke.mjs` mounts the
   real bundle and walks the tabs, but in DEMO MODE: `AiNotesPanel`
   returns "needs a real signed-in account" before rendering anything,
   and the allowance badge returns `null` on `!usage ||
   usage.unavailable` two lines above the call. Every guard stopped
   short of the line.

   So this one goes all the way: the built bundle, in a real engine,
   with a session and a SUCCESSFUL allowance read, clicking every tab
   and failing on any uncaught error. The network is intercepted rather
   than reached — no credentials, no live project, nothing to leak.

   THE RULE IT ENFORCES: a screen that only renders behind a signed-in
   session and a successful fetch is a screen no demo-mode walk can
   reach, and "the module imports fine" is not the same claim as "the
   component renders".

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

/* The tab IDS, read from the source rather than typed here — a tab
   added later must be rendered too, and a hardcoded list is how a new
   screen goes unvisited. */
function tabIds() {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const block = src.slice(src.indexOf("const TABS = ["), src.indexOf("const SETTINGS_TAB"));
  const ids = [...block.matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  const settings = /id:\s*"([a-z-]+)"/.exec(src.slice(src.indexOf("const SETTINGS_TAB")));
  if (settings) ids.push(settings[1]);
  return [...new Set(ids)];
}

/* The key the app remembers the last tab in. Lifted rather than typed,
   for the same reason as everything else here. */
const TAB_KEY = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const m = /const TAB_KEY = "([^"]+)"/.exec(src);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx — this guard cannot open a tab it cannot name");
  return m[1];
})();

const SUPABASE_HOST = (() => {
  const cfg = fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8");
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(cfg);
  assert.ok(m, "SUPABASE_URL is gone from config.js — this guard cannot intercept what it cannot name");
  return m[1];
})();

const USER_ID = "00000000-0000-4000-8000-000000000001";

/* THE CONSENT VERSION, lifted from source. Without accepted consent the
   AI tab renders the gate instead of the panel, and the badge — the
   component that actually threw — never mounts at all. That is how the
   first version of THIS FILE passed over the very bug it was written
   for: it rendered the tab, saw markup, and called it a pass. */
const AI_CONSENT_VERSION = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/aiNotesLogic.js"), "utf8");
  const m = /export const AI_CONSENT_VERSION = (\d+)/.exec(src);
  assert.ok(m, "AI_CONSENT_VERSION is gone from aiNotesLogic.js");
  return Number(m[1]);
})();

/* A profile that is DEFINITELY readable — a monthly tier with credits
   spent, so the allowance badge gets past `!usage || usage.unavailable`
   and reaches the line that threw. An "unavailable" answer here would
   reproduce exactly the blind spot this file exists to remove. */
const PROFILE_ROW = {
  user_id: USER_ID,
  tier: "ai",
  trial_credits_used: 0,
  active_device_id: null,
  active_device_at: null,
};

/* ------------------------------------------------------------------ */
/*  The browser-free half: free variables, found statically            */
/* ------------------------------------------------------------------ */

/* WHY BOTH HALVES. The render walk below catches anything that throws
   on a tab's initial render, which is where this bug lived. It cannot
   reach code behind an interaction — a click handler, a save path — and
   a free variable there fails just as hard, later, in front of a
   student.

   esbuild does not help: a named import that does not exist is a build
   ERROR, but a free variable is left as a global and the build is
   clean. Verified by mutation — injecting `aFreeVariableNobodyImported()`
   into the courses tab produced zero esbuild complaints and a blank
   page.

   PARAMETERS ARE THE FALSE POSITIVE THAT MATTERS. These modules take
   their dependencies as arguments on purpose — `buildAttempt({ uid })`,
   `buildConsentPatch(version, nowISO)` — so a detector that only knows
   about const/let/function flags five pure-by-design injections and
   gets itself disabled. It counts parameters as declarations. */
function freeVariables() {
  const dir = path.join(rootDir, "src");
  const files = fs.readdirSync(dir).filter((f) => /\.(js|jsx)$/.test(f));
  /* An empty file list would make every claim below vacuously true —
     the sweep would find nothing and report success. */
  assert.ok(files.length >= 10, `expected the src modules, found ${files.length}`);

  const exported = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/^export\s+(?:const|function|let|class)\s+([A-Za-z_$][\w$]*)/gm)) exported.set(m[1], f);
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const n of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) exported.set(n, f);
    }
  }

  const names = (list) =>
    list
      .replace(/[{}[\]]/g, " ")
      .split(",")
      .map((p) => p.split("=")[0].split(":").pop().replace(/\.\.\./, "").trim())
      .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));

  assert.ok(exported.size >= 20, `expected a table of exported names, built ${exported.size}`);

  const found = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    const known = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) names(m[1]).forEach((n) => known.add(n));
    for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) known.add(m[1]);
    for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) names(m[1]).forEach((n) => known.add(n));
    for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) names(m[1]).forEach((n) => known.add(n));
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) known.add(m[1]);

    for (const [name, owner] of exported) {
      if (owner === f || known.has(name)) continue;
      if (new RegExp(`[^.\\w$]${name}\\s*[({<]`).test(src)) found.push(`${f} uses ${name} (exported by ${owner})`);
    }
  }
  return found.sort();
}

async function run() {
  assert.ok(fs.existsSync(path.join(OUT, "app.js")), "dist-web is missing — run npm run build:web first");

  await test("no module uses another module's export without importing it", () => {
    /* THE PRODUCTION BUG, statically. src/aiNotes.jsx called
       allowanceForTier() and imported only MONTHLY_CREDITS_LIMIT from
       the same module — one name short, no build error, blank AI tab
       for every signed-in student. */
    const found = freeVariables();
    assert.deepEqual(
      found,
      [],
      `free variables — these will throw ReferenceError when the line runs:\n        ${found.join("\n        ")}`
    );
  });
  const browser = await launch();
  if (!browser) {
    const message = 'no Chromium — skipping (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)';
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    return;
  }

  const ids = tabIds();
  assert.ok(ids.length >= 5, `expected the tab list, found ${ids.length} — the guard is reading the wrong block`);

  const json = (body) => ({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });

  const projectRef = new URL(SUPABASE_HOST).hostname.split(".")[0];
  const visited = [];

  /* EACH TAB FROM A COLD MOUNT, not by clicking through.

     Clicking is what a person does and it is the wrong instrument
     here: the AI tab opens the consent overlay, which correctly
     intercepts pointer events, so every later click times out — the
     guard would report five failures caused by one modal doing its
     job. Seeding the remembered-tab key and reloading renders each tab
     as the FIRST thing the app does, which is also where a
     ReferenceError actually bites: on initial render, before anybody
     has clicked anything. */
  for (const id of ids) {
    await test(`the "${id}" tab renders from the built bundle, signed in, on a cold mount`, async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));

      await page.addInitScript(
        ({ ref, userId, tabKey, tab, consentVersion }) => {
          const hour = Math.floor(Date.now() / 1000) + 3600;
          localStorage.setItem(
            `sb-${ref}-auth-token`,
            JSON.stringify({
              access_token: "test-token",
              token_type: "bearer",
              expires_at: hour,
              expires_in: 3600,
              refresh_token: "test-refresh",
              user: { id: userId, email: "render-probe@example.test", aud: "authenticated", role: "authenticated" },
            })
          );
          localStorage.setItem("uni-planner-mode", "light");
          localStorage.setItem(tabKey, tab);
          /* A planner with AI consent already accepted, so the AI tab
             renders the PANEL rather than the gate. */
          localStorage.setItem(
            "uni-planner-v1",
            JSON.stringify({
              semester: "Semester 1",
              semesters: {},
              meta: { aiConsent: { version: consentVersion, acceptedAt: new Date().toISOString() } },
            })
          );
        },
        { ref: projectRef, userId: USER_ID, tabKey: TAB_KEY, tab: id, consentVersion: AI_CONSENT_VERSION }
      );

      await page.route(`${SUPABASE_HOST}/**`, async (route) => {
        const url = route.request().url();
        if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: "render-probe@example.test" }));
        if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "test-token", user: { id: USER_ID } }));
        if (url.includes("/rest/v1/profiles")) return route.fulfill(json(PROFILE_ROW));
        if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 12 }));
        return route.fulfill(json([]));
      });

      await page.goto("file://" + path.join(OUT, "index.html"));
      await page.waitForSelector("#root > *", { timeout: 15_000 });
      await page.waitForTimeout(900);

      const html = await page.locator("#root").innerHTML();
      await ctx.close();

      assert.deepEqual(errors, [], `rendering "${id}" threw:\n        ${errors.join("\n        ")}`);
      assert.ok(html.length > 200, `"${id}" rendered an essentially empty #root — a thrown render leaves a blank page`);

      /* THE PROOF THAT THIS TAB GOT PAST ITS GATES. Rendering "some
         markup" is what the first version of this file checked, and it
         passed with the production bug still in place: the AI tab was
         showing the consent screen, so the component that threw never
         mounted. A tab with a known gate must show something that only
         exists on the far side of it. */
      if (id === "ai-notes") {
        assert.match(
          html,
          /AI credits used|record a lecture|Record a lecture/i,
          "the AI tab rendered, but not the panel — it is still showing the consent gate or the signed-out notice, " +
            "so the allowance badge never mounted and this check proves nothing"
        );
      }
      visited.push(id);
    });
  }

  await test("every tab was actually visited, so none of the above passed over nothing", () => {
    assert.deepEqual(visited, ids, `visited ${visited.length} of ${ids.length} tabs`);
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
