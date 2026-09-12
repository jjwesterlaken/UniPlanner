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
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildConsentPatch } from "../src/aiNotesLogic.js";

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

/* AN ACCEPTED CONSENT. Without one the AI tab renders the gate instead
   of the panel, and the badge — the component that actually threw —
   never mounts at all. That is how the first version of THIS FILE
   passed over the very bug it was written for: it rendered the tab, saw
   markup, and called it a pass.

   BUILT BY THE APP'S OWN HELPER rather than assembled here. It used to
   lift the version number out of the source and seed `{ version,
   acceptedAt }`, which stopped being an acceptance the day
   `needsConsent` started reading the provider fingerprint too — so every
   probe below went quietly back behind the gate. A helper cannot drift
   from the function that reads it; a shape typed in three test files
   can, and did. */
const CONSENTED_META = buildConsentPatch();

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
        ({ ref, userId, tabKey, tab, consent }) => {
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
              meta: consent,
            })
          );
        },
        { ref: projectRef, userId: USER_ID, tabKey: TAB_KEY, tab: id, consent: CONSENTED_META }
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
        /* THE GATE'S ABSENCE, ASSERTED DIRECTLY, because the positive
           match was satisfied BY THE GATE. `/record a lecture/i` matched
           a consent bullet — "If you record a lecture, you are
           responsible for having permission" — so this guard, written to
           prove the tab got PAST its gate, was green while showing it.
           Same shape as a grep tripping on the comment that explains it:
           the forbidden state names the thing being looked for.

           The hooks are what the gate and the compact notice render, so
           their absence is not a phrase anybody can reword. */
        assert.doesNotMatch(html, /data-consent-gate/, "the AI tab is showing the consent gate, so the panel never mounted");
        assert.doesNotMatch(html, /data-consent-needed/, "the AI tab is showing the consent notice, so the panel never mounted");
        assert.match(
          html,
          /Summarise a reading/,
          "the AI tab rendered with no consent gate and no panel either — the signed-out notice, or nothing"
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

  /* `rejectSdk` IS THE SIMULATOR. StoreKit is absent there, so every
     bridge call rejects — `configure` first, then `getOfferings`. The
     rejection is thrown at CAPACITOR's boundary rather than at ours, so
     the real plugin and the real src/purchases.js both run and only the
     last hop is faked. */
  const bridgeScript = ({ native, packages, customerInfo = { managementURL: null }, rejectSdk = false }) => `
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
        if (${rejectSdk}) return Promise.reject(new Error("There is an issue with your configuration. StoreKit is unavailable."));
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
  async function mountAccount({
    native,
    profile = PROFILE_ROW,
    customerInfo = { managementURL: null },
    rejectSdk = false,
    signedOut = false,
    usageStatus = 200,
  }) {
    const dir = await keyedBuild();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.addInitScript(
      ({ ref, userId, tabKey, consent, signedOut: out }) => {
        const hour = Math.floor(Date.now() / 1000) + 3600;
        if (!out) localStorage.setItem(
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
          JSON.stringify({ semester: "Semester 1", semesters: {}, meta: consent })
        );
      },
      { ref: projectRef, userId: USER_ID, tabKey: TAB_KEY, consent: CONSENTED_META, signedOut }
    );
    await page.addInitScript(bridgeScript({ native, packages: PACKAGES, customerInfo, rejectSdk }));
    await page.route(`${SUPABASE_HOST}/**`, async (route) => {
      const url = route.request().url();
      if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: "plans-probe@example.test" }));
      if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "test-token", user: { id: USER_ID } }));
      if (url.includes("/rest/v1/profiles")) return route.fulfill(json(profile));
      if (url.includes("/rest/v1/ai_usage")) {
        /* The SPEND, which is a SECOND read and can fail on its own —
           the tier came back from `profiles` one query earlier. */
        return usageStatus === 200
          ? route.fulfill(json({ user_id: USER_ID, credits_used: 12 }))
          : route.fulfill({ ...json({ message: "boom" }), status: usageStatus });
      }
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

  await test("THE CURRENT PLAN IS IN ITS OWN BOX, and the disclosures are not in it with it", async () => {
    /* Jared's layout order. The plan line was one of five paragraphs in
       the same column, so the line somebody opens this panel to read
       looked exactly like the small print about it. Asserted as
       CONTAINMENT in a real mount rather than as a class name, because
       the claim is about what is inside what — a grep for a border
       utility would pass on a box with nothing in it. */
    const { page, errors, close } = await mountAccount({ native: true });
    const m = await page.evaluate(() => {
      const box = document.querySelector("[data-plan-box]");
      if (!box) return { box: false };
      const line = document.querySelector("[data-plan-line]");
      const disclosures = [...document.querySelectorAll("[data-purchase-controls] ~ div p")];
      return {
        box: true,
        planLineInside: !!line && box.contains(line),
        boxText: box.textContent.trim().slice(0, 60),
        disclosureCount: disclosures.length,
        anyDisclosureInside: disclosures.some((p) => box.contains(p)),
        bordered: getComputedStyle(box).borderTopWidth,
      };
    });
    await close();
    assert.deepEqual(errors, [], errors.join("\n        "));
    assert.ok(m.box, "there is no plan box on the panel at all");
    assert.ok(m.planLineInside, "the plan line is not inside the plan box");
    assert.ok(m.boxText.length > 0, "the plan box is empty, so containment proves nothing");
    /* MEASURED ON THE RUNNING PAGE, not read off a class: "visually
       distinct" is a computed border or it is a class name that a later
       stylesheet rule could be overriding. */
    assert.notEqual(m.bordered, "0px", `the plan box computes no border: ${m.bordered}`);
    assert.ok(m.disclosureCount >= 3, `only ${m.disclosureCount} disclosures found — this check reads nothing`);
    assert.ok(!m.anyDisclosureInside, "a disclosure is inside the plan box, which is what the box exists to separate it from");
  });

  await test("THE SIX PACKAGES ARE TWO TIER CARDS OF THREE, not six stacked buttons", async () => {
    const { page, errors, close } = await mountAccount({ native: true });
    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-tier-card]")];
      return {
        tiers: cards.map((c) => c.dataset.tierCard),
        perCard: cards.map((c) => c.querySelectorAll("[data-package]").length),
        titles: cards.map((c) => (c.querySelector("p") || {}).textContent || ""),
        /* Every button's ACCESSIBLE NAME, which is the half a compact
           label gives up: the visible text no longer says which plan
           the button buys, so the card title carries it — and a screen
           reader does not read the card title with the button. */
        names: [...document.querySelectorAll("[data-package]")].map((b) => b.getAttribute("aria-label") || b.textContent),
        loose: [...document.querySelectorAll("[data-package]")].filter((b) => !b.closest("[data-tier-card]")).length,
      };
    });
    await close();
    assert.deepEqual(errors, [], errors.join("\n        "));
    assert.deepEqual(m.tiers, ["ai", "ai_max"], `the tier cards are ${m.tiers.join(", ") || "(none)"}`);
    assert.deepEqual(m.perCard, [3, 3], `the cards hold ${m.perCard.join(" and ")} packages, not three each`);
    assert.equal(m.loose, 0, `${m.loose} buy buttons are outside a tier card`);
    for (const [i, title] of m.titles.entries()) {
      assert.ok(title.trim().length > 0, `tier card ${i} has no title, so the buttons inside it name no plan at all`);
    }
    assert.equal(m.names.length, 6, `${m.names.length} buy buttons, expected 6`);
    for (const name of m.names) {
      assert.match(name, /Study AI/, `a buy button's accessible name does not say which plan it buys: "${name}"`);
      assert.match(name, /month/, `a buy button's accessible name does not say the period: "${name}"`);
    }
  });

  await test("EVERY DISCLOSURE AND LINK SURVIVED THE LAYOUT CHANGE", async () => {
    /* The explicit other half of the order — the shape moved and the
       required content did not. Derived from the copy module rather
       than retyped, so a reworded disclosure follows instead of
       breaking this. */
    const { html, errors, close } = await mountAccount({ native: true });
    await close();
    assert.deepEqual(errors, [], errors.join("\n        "));
    const { DISCLOSURES } = await import(pathToFileURL(path.join(rootDir, "src/plansCopy.js")).href);
    const keys = Object.keys(DISCLOSURES);
    assert.ok(keys.length >= 3, `only ${keys.length} disclosures are declared — this check reads nothing`);
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
    for (const key of keys) {
      const words = DISCLOSURES[key].replace(/\s+/g, " ").slice(0, 40);
      assert.ok(text.includes(words), `the "${key}" disclosure is gone from the panel`);
    }
    for (const hook of ["data-restore", "data-manage", "data-terms", "data-privacy"]) {
      assert.match(html, new RegExp(hook), `${hook} is gone from the panel`);
    }
  });

  await test("CONFIGURE IS THE FIRST NATIVE CALL, and nothing reaches the plugin before it", async () => {
    /* THE DEVICE LOG, on a cold launch:

           Purchases.logOut
           Purchases.getOfferings   <- "Purchases must be configured
           Purchases.configure         before calling this function"

       Two orderings, neither of them decided in purchases.js. `session`
       is restored asynchronously, so the identity effect fired once with
       no session and logged out an SDK that had never been told
       anything. And `loadPackages` runs from an effect in PlansPanel,
       which is a CHILD of the component that configures — React runs
       child effects before parent effects, so the offering was always
       going to be asked for first, on every launch.

       This asserts the ORDER on the real bundle, through Capacitor's own
       bridge, because that is the only place the two effects really race.
       A source-level check could not see it: both call sites are
       individually correct. */
    const { calls, errors, close } = await mountAccount({ native: true });
    await close();
    assert.deepEqual(errors, [], `the Account tab threw:\n        ${errors.join("\n        ")}`);

    /* NON-VACUITY FIRST: the bridge was used at all. An empty list
       satisfies every claim about ordering ever made. */
    assert.ok(calls.length > 0, "the bridge recorded no calls, so this test orders nothing");
    assert.ok(calls.includes("Purchases.configure"), `configure never reached the bridge: ${calls.join(", ")}`);

    assert.equal(
      calls[0],
      "Purchases.configure",
      `the first native call was ${calls[0]}, not configure — the full order was: ${calls.join(", ")}`
    );

    /* AND IT IS THE ONLY ONE BEFORE THE REST, said separately because
       `calls[0]` alone would pass on a second configure racing a
       getOfferings that also beat the first one. */
    const firstOther = calls.findIndex((c) => c !== "Purchases.configure");
    if (firstOther !== -1) {
      assert.ok(
        calls.slice(0, firstOther).every((c) => c === "Purchases.configure"),
        `something reached the plugin before configure finished: ${calls.join(", ")}`
      );
    }

    /* THE SPURIOUS logOut IS GONE. It was the first line on the device,
       from the effect firing once with no session — an SDK that has
       never been configured has no identity to forget. */
    assert.ok(
      !calls.includes("Purchases.logOut"),
      `a signed-in launch logged the SDK out: ${calls.join(", ")}`
    );
  });

  /* ------------------------------------------------------------------ */
  /*  The tier does not come from the store, so the store cannot take it */
  /* ------------------------------------------------------------------ */

  /* REPORTED FROM THE iOS SIMULATOR: an account with profiles.tier =
     'ai' saw "We couldn't check your plan just now", no tier, no buy
     buttons. The hypothesis was that the SDK throws where StoreKit is
     absent and the panel reported that as a plan-fetch failure.

     THE FIRST OF THESE TWO IS THE CONTROL THAT DISPROVED IT, and it is
     kept for that reason as much as for what it guards: the SDK really
     does reject every call here, and the tier line was ALREADY correct
     before the fix, because `purchases.js` catches and the tier has
     never come from the SDK. What blanks the tier is a `fetchUsage`
     failure — which is the second test. Two tests because the report
     described one screen and the causes were independent. */

  await test("AN SDK THAT REJECTS EVERY CALL CANNOT TAKE THE TIER OFF THE SCREEN", async () => {
    const { html, calls, errors, close } = await mountAccount({ native: true, rejectSdk: true });
    await close();
    assert.deepEqual(errors, [], `the Account tab threw when the SDK rejected:\n        ${errors.join("\n        ")}`);

    /* NON-VACUITY: the SDK was really spoken to and really refused.
       Without this the assertions below pass on a page that never
       reached the plugin at all — which is the WEB state, one test
       down, and would make this one a duplicate of it.

       IT ASKS FOR `configure` RATHER THAN `getOfferings`, and the
       change is the point of the ordering fix: the offering is no
       longer requested at all when configuring fails, because
       `ensureConfigured` returns the failure instead of letting the
       next call relay a provider message about configuration to a
       student. Configure being attempted and refused is the whole of
       "the SDK was really spoken to" now. */
    assert.ok(calls.includes("Purchases.configure"), `the SDK was never spoken to at all: ${calls.join(", ") || "(no calls)"}`);
    assert.ok(!calls.includes("Purchases.getOfferings"), `the offering was requested although configuring failed: ${calls.join(", ")}`);

    const line = /data-plan-line[^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html);
    assert.ok(line, "the plan line is not on the page at all");
    assert.match(line[1], /Study AI/, `the tier vanished with the SDK: ${line[1].trim()}`);
    assert.doesNotMatch(line[1], /couldn't check/i, "an SDK failure is being reported as a failure to read the plan");

    /* AND IT DEGRADES VISIBLY rather than silently. A purchase screen
       with no buttons and no sentence reads as "this app sells
       nothing", which is what the simulator showed. */
    assert.match(html, /data-store-status/, "an unreachable store produced no explanation at all");
    assert.doesNotMatch(html, /data-package=/, "packages rendered although the offering call rejected");
    assert.match(html, /data-restore/, "Restore disappeared when the SDK failed — it is the one control that might recover it");
  });

  await test("a failed ALLOWANCE read does not discard a tier that was read successfully", async () => {
    /* THE REAL CAUSE, and the shape is the `fetchNote` rule: `profiles`
       and `ai_usage` are two queries, and the panel gated the tier on a
       flag that means "the SPEND is unknown". So a 500 on the second
       one told a paying student we could not check their plan. */
    const { html, errors, close } = await mountAccount({ native: true, usageStatus: 500 });
    await close();
    assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), [], `the Account tab threw:\n        ${errors.join("\n        ")}`);
    const line = /data-plan-line[^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html);
    assert.ok(line, "the plan line is not on the page at all");
    assert.match(line[1], /Study AI/, `a failed ai_usage read blanked the tier: ${line[1].trim()}`);
  });

  await test("SIGNED OUT the panel says to make an account, and offers no control that needs one", async () => {
    /* "We couldn't check your plan" describes a failure that never
       happened, on the screen somebody sees before they have ever had a
       plan. And Restore without a session can only attach a real store
       receipt to an ANONYMOUS RevenueCat id — the delivery the webhook
       answers `no_account` to. */
    const { html, errors, close } = await mountAccount({ native: true, signedOut: true });
    await close();
    assert.deepEqual(errors, [], `the Account tab threw signed out:\n        ${errors.join("\n        ")}`);
    const line = /data-plan-line[^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html);
    assert.ok(line, "the plan line is not on the page at all");
    assert.doesNotMatch(line[1], /couldn't check/i, `a signed-out student is told a read failed: ${line[1].trim()}`);
    assert.match(line[1], /account/i, `the signed-out line does not say what to do: ${line[1].trim()}`);
    assert.doesNotMatch(html, /data-restore/, "Restore is offered with no account to restore onto");
    assert.doesNotMatch(html, /data-package=/, "purchase buttons are offered with no account to buy for");
    /* The legal links stay, because they are about the app rather than
       about a subscription and a reviewer may never sign in. */
    assert.match(html, /data-terms/, "the Terms link is gone when signed out");
    assert.match(html, /data-privacy/, "the Privacy link is gone when signed out");
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
