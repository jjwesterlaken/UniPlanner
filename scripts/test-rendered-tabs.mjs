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
import os from "node:os";
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
      /* THE PLANS PANEL, on the surface that cannot sell anything. The
         tier still has to show — it is the same account wherever a
         student signs in, and hiding it would leave somebody who paid
         on their phone wondering whether the laptop knew — and the
         purchase controls must not. Asserted on the far side of the
         gate, the AI-tab lesson: "the account tab rendered" would pass
         with the panel missing entirely. */
      if (id === "account") {
        assert.match(html, /data-plan-line/, "the Account tab rendered without the Plans panel at all");
        assert.match(html, /Study AI/, "the plan line does not name the tier the profiles read returned");
        assert.match(html, /data-purchase-unavailable/, "web does not say where plans are bought");
        assert.doesNotMatch(html, /data-purchase-controls/, "the web build is showing purchase controls");
        assert.doesNotMatch(html, /data-package=/, "the web build is showing buyable packages");
        assert.match(html, /Privacy Policy/, "the panel does not link the privacy policy, which Apple requires on a subscription screen");
      }
      visited.push(id);
    });
  }

  await test("every tab was actually visited, so none of the above passed over nothing", () => {
    assert.deepEqual(visited, ids, `visited ${visited.length} of ${ids.length} tabs`);
  });

  /* ------------------------------------------------------------------ */
  /*  The Plans panel, on a shell that CAN sell                          */
  /* ------------------------------------------------------------------ */

  /* FAKED AT CAPACITOR'S OWN BOUNDARY, not at ours. `window.androidBridge`
     is what `getPlatformId()` looks for, and `Capacitor.PluginHeaders`
     plus `Capacitor.nativePromise` are what a real native bridge
     injects — so the REAL RevenueCat plugin code marshals the REAL
     calls, and only the last hop is ours. Stubbing src/purchases.js
     instead would have tested a module against itself.

     It is also what makes the web half above a measurement rather than
     an assumption: the same spy is installed WITHOUT androidBridge, so
     "nothing called the SDK on web" is an empty array rather than a
     hope. */
  const PACKAGES = [
    { identifier: "studyai_monthly", product: { identifier: "uniplanner.studyai.monthly", priceString: "A$8.99", title: "Study AI" } },
    { identifier: "studyai_sixmonth", product: { identifier: "uniplanner.studyai.sixmonth", priceString: "A$44.99", title: "Study AI" } },
    { identifier: "studyai_annual", product: { identifier: "uniplanner.studyai.annual", priceString: "A$79.99", title: "Study AI" } },
    { identifier: "studyaimax_monthly", product: { identifier: "uniplanner.studyaimax.monthly", priceString: "A$18.99", title: "Study AI Max" } },
    { identifier: "studyaimax_sixmonth", product: { identifier: "uniplanner.studyaimax.sixmonth", priceString: "A$94.99", title: "Study AI Max" } },
    { identifier: "studyaimax_annual", product: { identifier: "uniplanner.studyaimax.annual", priceString: "A$169.99", title: "Study AI Max" } },
  ];

  const bridgeScript = ({ native, packages, customerInfo = { managementURL: null } }) => `
    if (${native}) window.androidBridge = { postMessage() {} };
    window.__RC_CALLS__ = [];
    window.Capacitor = {
      PluginHeaders: [{
        name: "Purchases",
        methods: ["configure", "logOut", "getOfferings", "purchasePackage", "restorePurchases", "getCustomerInfo"]
          .map((name) => ({ name, rtype: "promise" })),
      }],
      nativePromise: (plugin, method) => {
        window.__RC_CALLS__.push(plugin + "." + method);
        if (method === "getOfferings") return Promise.resolve({ current: { identifier: "default", availablePackages: ${JSON.stringify(packages)} } });
        if (method === "restorePurchases") return Promise.resolve({ customerInfo: ${JSON.stringify(customerInfo)} });
        if (method === "getCustomerInfo") return Promise.resolve({ customerInfo: ${JSON.stringify(customerInfo)} });
        return Promise.resolve({});
      },
    };
  `;

  /* A STORE BUILD, made here, because dist-web is deliberately not one.
     `purchaseCapability` refuses without a RevenueCat key, and a web
     build has none — that is correct and is asserted elsewhere. So the
     native half of this file needs the artifact a phone would actually
     get: the same sources through the same esbuild defines, with the
     two keys set, exactly as MOBILE-BUILD.md's store-build steps do it.

     Built once and reused. It is still an ARTIFACT rather than a
     source read; what it is not is `dist-web`, and saying so is the
     difference between this and reading a build that answers a
     different question. */
  const KEYED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "keyed-build-"));
  let keyedBuilt = false;
  async function keyedBuild() {
    if (keyedBuilt) return KEYED_DIR;
    for (const f of fs.readdirSync(OUT)) fs.cpSync(path.join(OUT, f), path.join(KEYED_DIR, f), { recursive: true });
    const { build } = await import("esbuild");
    await build({
      entryPoints: [path.join(rootDir, "src/main.jsx")],
      bundle: true,
      minify: true,
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        __REVENUECAT_IOS_KEY__: '"appl_testkeyforrendering"',
        __REVENUECAT_ANDROID_KEY__: '"goog_testkeyforrendering"',
      },
      outfile: path.join(KEYED_DIR, "app.js"),
      logLevel: "silent",
    });
    keyedBuilt = true;
    return KEYED_DIR;
  }

  /* BOTH HALVES USE THE KEYED BUILD, and that is the whole point of
     building one. Running the web half against `dist-web` would have it
     show no purchase controls for TWO reasons at once — no native
     platform AND no key — so an empty call list would not discriminate
     between them. Same bundle, same spy, one difference: the platform.
     (`dist-web` having no key is a separate, real property, and the
     per-tab account assertion above is what covers it.) */
  async function mountAccount({ native, profile = PROFILE_ROW, customerInfo = { managementURL: null } }) {
    const dir = await keyedBuild();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.addInitScript(
      ({ ref, userId, tabKey, consentVersion }) => {
        const hour = Math.floor(Date.now() / 1000) + 3600;
        localStorage.setItem(
          `sb-${ref}-auth-token`,
          JSON.stringify({
            access_token: "test-token",
            token_type: "bearer",
            expires_at: hour,
            expires_in: 3600,
            refresh_token: "test-refresh",
            user: { id: userId, email: "plans-probe@example.test", aud: "authenticated", role: "authenticated" },
          })
        );
        localStorage.setItem("uni-planner-mode", "light");
        localStorage.setItem(tabKey, "account");
        localStorage.setItem(
          "uni-planner-v1",
          JSON.stringify({ semester: "Semester 1", semesters: {}, meta: { aiConsent: { version: consentVersion, acceptedAt: new Date().toISOString() } } })
        );
      },
      { ref: projectRef, userId: USER_ID, tabKey: TAB_KEY, consentVersion: AI_CONSENT_VERSION }
    );
    await page.addInitScript(bridgeScript({ native, packages: PACKAGES, customerInfo }));
    await page.route(`${SUPABASE_HOST}/**`, async (route) => {
      const url = route.request().url();
      if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: "plans-probe@example.test" }));
      if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "test-token", user: { id: USER_ID } }));
      if (url.includes("/rest/v1/profiles")) return route.fulfill(json(profile));
      if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 12 }));
      return route.fulfill(json([]));
    });
    await page.goto("file://" + path.join(dir, "index.html"));
    await page.waitForSelector("#root > *", { timeout: 15_000 });
    await page.waitForTimeout(1200);
    const read = async () => ({
      html: await page.locator("#root").innerHTML(),
      calls: await page.evaluate(() => window.__RC_CALLS__ || []),
    });
    const first = await read();
    /* The page is handed back so a test can DO something and read
       again. A cold mount cannot exercise anything that only exists
       after an interaction — which is how the first version of the
       customerInfo test below passed while proving nothing. */
    return { ...first, errors, page, read, close: () => ctx.close() };
  }

  await test("ON A NATIVE SHELL the panel shows all six packages, their prices and Restore", async () => {
    const { html, calls, errors, close } = await mountAccount({ native: true });
    await close();
    assert.deepEqual(errors, [], `the Account tab threw on a native shell:\n        ${errors.join("\n        ")}`);
    assert.match(html, /data-purchase-controls/, "a native shell is not showing purchase controls");
    for (const pkg of PACKAGES) {
      assert.ok(html.includes(`data-package="${pkg.identifier}"`), `${pkg.identifier} is missing from the panel`);
      assert.ok(html.includes(pkg.product.priceString), `${pkg.identifier} renders without the store's price — Apple requires the price on the screen`);
    }
    assert.match(html, /data-restore/, "no Restore Purchases control, which Apple requires to be visible");
    assert.match(html, /data-manage/, "no way to manage or cancel the subscription");
    assert.match(html, /1 month[\s\S]*6 months[\s\S]*12 months/, "the periods are missing or out of order");
    assert.match(html, /data-terms/, "no Terms of Use link");
    /* AND THE SDK WAS REALLY SPOKEN TO, which is what makes the web
       assertion below a comparison rather than a coincidence. */
    assert.ok(calls.includes("Purchases.configure"), `configure never reached the bridge: ${calls.join(", ") || "(no calls at all)"}`);
    assert.ok(calls.includes("Purchases.getOfferings"), "the offering was never fetched");
  });

  await test("ON WEB the same page speaks to the SDK not once", async () => {
    /* The measurement the web tab assertion above cannot make on its
       own: the bridge spy is installed identically, and the platform is
       the only difference. An empty array here against a non-empty one
       above is the whole claim. */
    const { html, calls, errors, close } = await mountAccount({ native: false });
    await close();
    assert.deepEqual(errors, [], `the Account tab threw on web:\n        ${errors.join("\n        ")}`);
    assert.deepEqual(calls, [], `the store SDK was called on web: ${calls.join(", ")}`);
    assert.match(html, /data-purchase-unavailable/, "web is not saying where plans are bought");
    assert.doesNotMatch(html, /data-package=/, "web is offering packages for sale");
    assert.doesNotMatch(html, /data-restore/, "web is offering to restore a purchase it cannot make");
  });

  await test("THE TIER COMES FROM profiles EVEN WITH THE SDK SAYING OTHERWISE — after a real Restore", async () => {
    /* RULE 2 OF THE CLIENT HALF, measured rather than asserted, and the
       FIRST VERSION OF THIS TEST PROVED NOTHING — which is the part
       worth keeping. It mounted the tab cold and compared a disagreeing
       `customerInfo` against `profiles`; mutating the panel to read the
       SDK left it green, because on a cold mount `customerInfo` is
       still null. There was nothing there to disbelieve. A guard for a
       bug that needs a user action has to perform the action.

       So it taps Restore Purchases, which is the one path that really
       puts a customerInfo in the component's hands, and only then asks
       what the plan line says. The store's answer and the server's are
       made to DISAGREE — the SDK reports an active `ai_max`, `profiles`
       says `free` — because agreement discriminates nothing.

       Why it matters on a real device: a refunded, expired or
       family-shared entitlement can read as active in customerInfo for
       a while, so a panel trusting it grants a paid tier nobody is
       paying for. And in the boring direction, a purchase completes on
       the device before the webhook lands, so a client that believed
       the SDK would show a plan the server then refuses to honour.
       One source keeps the screen and the allowance in step even when
       both are briefly behind. */
    const { errors, page, read, close } = await mountAccount({
      native: true,
      profile: { ...PROFILE_ROW, tier: "free" },
      customerInfo: {
        managementURL: null,
        entitlements: {
          active: { ai_max: { identifier: "ai_max", isActive: true, productIdentifier: "uniplanner.studyaimax.annual" } },
        },
        activeSubscriptions: ["uniplanner.studyaimax.annual"],
      },
    });

    const restore = page.locator("[data-restore]");
    assert.equal(await restore.count(), 1, "no Restore control to press, so this test cannot reach the state it is about");
    await restore.click();
    await page.waitForFunction(() => (window.__RC_CALLS__ || []).includes("Purchases.restorePurchases"), null, { timeout: 10_000 });
    await page.waitForTimeout(600);

    const { html, calls } = await read();
    await close();
    assert.deepEqual(errors, [], `the Account tab threw:\n        ${errors.join("\n        ")}`);
    /* NON-VACUITY: the SDK really was consulted and really did answer
       with an entitlement. Without this the assertion below is happy
       with a restore that silently failed. */
    assert.ok(calls.includes("Purchases.restorePurchases"), `restore never reached the bridge: ${calls.join(", ")}`);

    const line = /data-plan-line[^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html);
    assert.ok(line, "the current-plan line is not on the page, so this test read nothing");
    const text = line[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    assert.ok(!/Max/i.test(text), `the panel took its tier from the SDK: it says "${text}" while profiles says free`);
    assert.match(text, /Free/i, `the panel does not show the server's tier: "${text}"`);
  });

  await test("WITH STRIPE SWITCHED OFF the web panel offers no way to pay, and still shows the tier", async () => {
    /* PHASE 6, IN THE BROWSER. `STRIPE_ENABLED` is false, so this is
       the state that ships: web and desktop show the plan READ-ONLY.
       Two failures are being ruled out at once and they are opposite —
       a checkout button that reaches an unconfigured server, and a
       flag whose "off" state accidentally hid the plan itself.

       Measured on the built bundle rather than by reading the flag,
       because the flag is one of three things that have to agree (the
       constant, the capability, and a session) and only the rendered
       page knows whether they did. */
    const { html, calls, errors, close } = await mountAccount({ native: false });
    await close();
    assert.deepEqual(errors, [], `the Account tab threw on web:\n        ${errors.join("\n        ")}`);
    assert.deepEqual(calls, [], `the store SDK was called on web: ${calls.join(", ")}`);

    for (const marker of ["data-web-purchase", "data-web-plan", "data-web-manage"]) {
      assert.ok(!html.includes(marker), `${marker} is on the page while STRIPE_ENABLED is false — a student can start a checkout the server refuses`);
    }
    /* AND THE PANEL IS STILL THERE. The web ruling is "just the tier",
       not a blank space and not a coming-soon. */
    assert.match(html, /data-plan-line/, "the flag being off removed the whole panel, not just the purchase controls");
    assert.match(html, /data-purchase-unavailable/, "web no longer says where plans are bought");
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
