/* Tests for update delivery.

   WHY THIS FILE EXISTS, because the failure it guards is silent:

   The service worker's cache name was a hand-edited constant committed
   once and never changed. index.html referenced app.js and app.css by
   bare filename with no content hash, and the fetch handler was
   cache-first for everything. So any browser that had opened the app
   once served that build forever -- the worker script never changed, so
   no new worker installed, so `install` never re-ran, so nothing was
   re-fetched. Weeks of deploys reached nobody who already had the app
   cached. Nothing errored. Nothing looked wrong.

   Every assertion below exists to make that loud instead of silent.

   Run via `npm test`. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pathToUrl = (p) => new URL(`file://${p}`).href;
const rootDir = path.join(__dirname, "..");
const pub = (f) => fs.readFileSync(path.join(rootDir, "public", f), "utf8");
const dist = (f) => fs.readFileSync(path.join(rootDir, "dist-web", f), "utf8");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

async function run() {
  /* ---------- the cache name must be generated, never written ---------- */

  await test("the source service worker contains no hardcoded cache name", () => {
    const src = pub("sw.js");
    // Strip comments: this file explains the old bug and quotes the old
    // constant, and that explanation must not trip its own guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const assignment = /const\s+CACHE\s*=\s*(.+);/.exec(code);
    assert.ok(assignment, "couldn't find the CACHE assignment");
    assert.match(
      assignment[1],
      /__BUILD_ID__/,
      `CACHE is a literal (${assignment[1]}) instead of a build-stamped value — ` +
        "a fixed cache name means users who have opened the app once never get another update"
    );
    // The specific shape of the old bug: a version someone is expected to
    // remember to increment by hand.
    assert.doesNotMatch(code, /const\s+CACHE\s*=\s*"uni-planner-v\d+"/, "the hand-edited version constant is back");
  });

  await test("the built service worker carries a real hash, not the placeholder", () => {
    const out = dist("sw.js");
    assert.doesNotMatch(out, /__BUILD_ID__/, "the placeholder was never substituted");
    const assignment = /const CACHE = "uni-planner-([a-f0-9]+)";/.exec(out);
    assert.ok(assignment, "the built cache name isn't a stamped hash");
    assert.ok(assignment[1].length >= 8, `the build id is only ${assignment[1].length} characters`);
  });

  await test("the cache name actually changes when the app changes", () => {
    // The property that matters. Not "a hash exists" but "a different
    // build produces a different name" -- that is the entire update
    // mechanism, so it is asserted end to end rather than assumed.
    const js = dist("app.js");
    const css = dist("app.css");
    const current = crypto.createHash("sha256").update(js).update(css).digest("hex").slice(0, 12);
    const other = crypto.createHash("sha256").update(js + "// one more line\n").update(css).digest("hex").slice(0, 12);
    assert.notEqual(current, other, "a changed bundle produced the same build id");
    assert.match(dist("sw.js"), new RegExp(`uni-planner-${current}`), "the built worker doesn't match its own bundle");
  });

  await test("the build fails loudly if the placeholder is ever removed", () => {
    // Belt and braces on the guard above: if someone deletes the token
    // from public/sw.js, the build must stop rather than ship a fixed
    // cache name.
    const swPath = path.join(rootDir, "public", "sw.js");
    const original = fs.readFileSync(swPath, "utf8");
    let threw = null;
    try {
      fs.writeFileSync(swPath, original.replace('"uni-planner-__BUILD_ID__"', '"uni-planner-v7"'));
      execFileSync(process.execPath, [path.join(rootDir, "scripts/build-web.mjs")], { stdio: "pipe" });
    } catch (err) {
      threw = err;
    } finally {
      // Restore the source AND the output: the failed build left dist-web
      // half-written, and the assertions below read it.
      fs.writeFileSync(swPath, original);
      execFileSync(process.execPath, [path.join(rootDir, "scripts/build-web.mjs")], { stdio: "pipe" });
    }
    assert.ok(threw, "the build accepted a service worker whose cache name isn't build-stamped");
    assert.match(String(threw.stderr || threw.message), /__BUILD_ID__/, "the failure doesn't name the missing token");
  });

  /* ---------- what gets served from where ---------- */

  await test("legal documents are never served from a cache", () => {
    const src = pub("sw.js");
    assert.match(src, /privacy/, "the privacy path isn't listed as network-only");
    assert.match(src, /delete-account/, "the deletion path isn't listed as network-only");
    const list = /const NETWORK_ONLY = \[([^\]]*)\]/.exec(src);
    assert.ok(list, "there is no NETWORK_ONLY list");
    for (const p of ["/privacy.html", "/delete-account.html"]) {
      assert.ok(list[1].includes(p), `${p} is not network-only`);
    }
  });

  await test("a legal document is never replaced by the app shell", () => {
    // Serving the planner in place of a privacy policy would be a plain
    // misrepresentation, so the network-only branch must return before
    // any index.html fallback can apply.
    const src = pub("sw.js");
    const branch = src.slice(src.indexOf("if (isNetworkOnly"), src.indexOf("const navigation"));
    assert.ok(branch.length > 0, "couldn't find the network-only branch");
    assert.doesNotMatch(branch, /index\.html/, "the network-only branch can fall back to the app shell");
    assert.doesNotMatch(branch, /caches\.match/, "the network-only branch reads from the cache");
  });

  await test("the app shell is network-first, so a stale build can't win twice", () => {
    const src = pub("sw.js");
    const shell = src.slice(src.indexOf("if (navigation || isShell"), src.indexOf("// Everything else"));
    assert.ok(shell.length > 0, "couldn't find the app-shell branch");
    const fetchAt = shell.indexOf("fetch(request)");
    const cacheAt = shell.indexOf("caches.match");
    assert.ok(fetchAt > -1 && cacheAt > -1, "the shell branch doesn't both fetch and fall back");
    assert.ok(fetchAt < cacheAt, "the shell reads the cache before the network — that is cache-first again");
  });

  /* ---------- the packaged shells must not register a worker ---------- */

  await test("only the hosted web build registers a service worker", () => {
    // Capacitor serves Android from http://localhost, which IS a secure
    // context, so a worker registers and caches the bundled assets. After
    // an app-store update replaced those files on disk, the worker would
    // keep serving its cache -- an update that passed review and still
    // didn't reach anyone.
    const html = pub("index.html");
    assert.match(html, /location\.protocol === "https:"/, "registration isn't limited to https");
    assert.match(html, /localhost/, "registration doesn't exclude the Capacitor origin");
    const guard = html.slice(html.indexOf("if (!isHostedWeb)"), html.indexOf("window.addEventListener"));
    assert.match(guard, /unregister/, "an existing shell registration is never cleaned up");
  });

  /* ---------- knowing which build a user is on ---------- */

  await test("the built page carries the same build id as the worker", () => {
    const swId = /uni-planner-([a-f0-9]+)/.exec(dist("sw.js"))[1];
    const htmlId = /name="build-id" content="([a-f0-9]+)"/.exec(dist("index.html"));
    assert.ok(htmlId, "index.html has no stamped build id");
    assert.equal(htmlId[1], swId, "the page and the worker disagree about which build this is");
  });

  await test("the app shell is derived from the worker's own path, not hardcoded to the root", () => {
    // The app is not guaranteed to own "/" forever: a marketing site is
    // planned for the root with the app moving to /app, on the same
    // origin so localStorage survives. This list was the one place that
    // assumed otherwise.
    const src = pub("sw.js");
    const line = /const SHELL = \[([^\]]*)\]/.exec(src);
    assert.ok(line, "couldn't find the SHELL list");
    assert.doesNotMatch(line[1], /"\//, "the app shell is hardcoded to the site root");
    assert.match(src, /new URL\("\.\/", self\.location\)/, "the shell paths aren't derived from the worker's own location");
  });

  await test("the packaged shells really do come out with no service worker", () => {
    /* `npm run build` was BROKEN ON MAIN FOR A FORTNIGHT and nothing said
       so. prepare-native stripped the registration script with a regex
       that restated the script's shape; rewriting that script left the
       regex matching nothing, so the safety check below it threw and the
       whole native build exited 1.

       It survived because `npm test` builds only the web bundle and
       build-apps.yml is workflow_dispatch, so neither ran. This runs the
       real script and checks the real output -- which is the only thing
       that would have caught it. */
    execFileSync(process.execPath, [path.join(rootDir, "scripts/prepare-native.mjs")], {
      cwd: rootDir,
      stdio: "pipe",
    });

    for (const shell of ["desktop/www", "mobile/www"]) {
      const html = fs.readFileSync(path.join(rootDir, shell, "index.html"), "utf8");
      assert.ok(
        !html.includes("serviceWorker"),
        `${shell}/index.html still registers a service worker — inside a packaged app it can serve ` +
          "files from before a store update replaced them"
      );
      assert.ok(!fs.existsSync(path.join(rootDir, shell, "sw.js")), `${shell} still ships sw.js`);
      // And it must not have stripped the whole page while it was at it.
      assert.ok(html.includes("<body"), `${shell}/index.html lost its body`);
      assert.ok(html.includes("app.js"), `${shell}/index.html no longer loads the app`);
    }
  });

  await test("index.html keeps the markers prepare-native strips between", () => {
    // The contract that lets the registration script be rewritten freely.
    const html = fs.readFileSync(path.join(rootDir, "public/index.html"), "utf8");
    assert.match(html, /sw-register:start/, "the start marker is gone; the native build will keep the worker");
    assert.match(html, /sw-register:end/, "the end marker is gone");
  });

  await test("every shell ships under the same bundle identifier", async () => {
    /* A bundle identifier is PERMANENT once published: changing it later
       means a new store listing rather than an update, losing reviews,
       rankings and installs. It is also the one value that has to agree
       across three build systems that never see each other -- Capacitor
       generates the iOS bundle id and the Android applicationId from its
       config, electron-builder reads its own.

       Derived from SITE_URL rather than typed, so the identifier and the
       domain it is named after cannot drift apart. */
    const { SITE_URL } = await import(pathToUrl(path.join(rootDir, "src/legalLinks.js")));
    const domain = new URL(SITE_URL).hostname.replace(/^www\./, ""); // uniplannerapp.com
    const expected = `${domain.split(".").reverse().join(".")}.planner`; // com.uniplannerapp.planner

    const cap = JSON.parse(fs.readFileSync(path.join(rootDir, "mobile/capacitor.config.json"), "utf8"));
    const desktop = JSON.parse(fs.readFileSync(path.join(rootDir, "desktop/package.json"), "utf8"));

    assert.equal(cap.appId, expected, "the mobile bundle id is not derived from the domain we own");
    assert.equal(desktop.build.appId, expected, "the desktop app id disagrees with the mobile one");
  });

  await test("a build number always increases, and never repeats", async () => {
    /* This is the number the STORES enforce. Android versionCode and iOS
       CFBundleVersion must strictly increase on every upload, and a
       store rejects a build that reuses one -- which lands after a long
       upload, when you are already trying to ship a fix. */
    const { buildNumber } = await import(pathToUrl(path.join(rootDir, "scripts/stamp-native.mjs")));
    const t = Date.UTC(2026, 7, 13);
    assert.ok(buildNumber(t + 60_000) > buildNumber(t), "a minute later must produce a higher number");
    assert.equal(buildNumber(t), buildNumber(t), "the same instant must be stable");
    // Independent of the marketing version: a REJECTED build has to be
    // re-uploaded without inventing a new version number.
    const src = fs.readFileSync(path.join(rootDir, "scripts/stamp-native.mjs"), "utf8");
    const fn = src.slice(src.indexOf("export const buildNumber"), src.indexOf("/* ---------- settings"));
    assert.ok(!/version/i.test(fn), "the build number must not be derived from the marketing version");
    // Android's versionCode is a signed 32-bit int.
    assert.ok(buildNumber(Date.UTC(2100, 0, 1)) < 2_147_483_647, "the scheme overflows versionCode before 2100");
  });

  await test("the marketing version is stamped from one place", async () => {
    const { stamp } = await import(pathToUrl(path.join(rootDir, "scripts/stamp-native.mjs")));
    const root = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const desktop = JSON.parse(fs.readFileSync(path.join(rootDir, "desktop/package.json"), "utf8"));
    assert.equal(desktop.version, root.version, "desktop drifted from the root version — run `npm run stamp`");
    // And the stamper is what keeps them together, rather than luck.
    assert.match(fs.readFileSync(path.join(rootDir, "scripts/stamp-native.mjs"), "utf8"), /d\.version = version/);
  });

  await test("npm test still runs the service worker tests", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-service-worker\.mjs/, "the update-delivery tests were dropped from `npm test`");
  });

  /* ---------- the pre-paint script and the strip must not collide ----------

     index.html carries TWO marked blocks now: the service-worker
     registration in <body>, which prepare-native removes for the
     packaged shells, and the dark-mode pre-paint script in <head>,
     which every shell needs. Independent by construction -- separate
     markers, separate elements, different halves of the document --
     and this is what keeps a packaging change from silently taking
     dark mode out of the phone builds. */

  await test("the pre-paint script survives prepare-native, and the worker registration does not", () => {
    const shells = ["desktop/app/index.html", "mobile/www/index.html"]
      .map((rel) => path.join(rootDir, rel))
      .filter((f) => fs.existsSync(f));
    assert.ok(shells.length > 0, "no native shell was prepared, so this asserts nothing");
    for (const file of shells) {
      const html = fs.readFileSync(file, "utf8");
      assert.ok(!/serviceWorker/.test(html), `${file} still registers a service worker`);
      assert.match(html, /prepaint:start/, `${file} lost the pre-paint script — a dark-mode user gets a light flash on every launch`);
      assert.match(html, /uni-planner-mode/, `${file}'s pre-paint script no longer reads the stored mode`);
      assert.match(html, /prefers-color-scheme/, `${file}'s pre-paint script no longer follows the system`);
      assert.match(html, /app\.js/, `${file} lost its bundle`);
    }
  });

  await test("the pre-paint script runs BEFORE the stylesheet, or it is not pre-paint", () => {
    const html = fs.readFileSync(path.join(rootDir, "public/index.html"), "utf8");
    const prepaint = html.indexOf("prepaint:start");
    const css = html.indexOf('href="app.css"');
    const body = html.indexOf("<body");
    assert.ok(prepaint > -1 && css > -1, "one of the two is missing");
    assert.ok(prepaint < css, "the pre-paint script sits after the stylesheet, so the first frame can still be light");
    assert.ok(prepaint < body, "the pre-paint script is in the body — the shell paints before it runs");
    assert.match(html, /<meta name="color-scheme" content="light dark"/, "the browser's own UI will not follow the mode");
  });

  await test("the pre-paint script and the app agree on the key and the values", () => {
    /* Two copies of one contract -- an inline script cannot import
       from the bundle -- so the EQUALITY is the guard, the same
       arrangement as the billing hints. Drift means the first frame
       renders one mode and the app switches to the other. */
    const html = fs.readFileSync(path.join(rootDir, "public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const key = /const MODE_KEY = "([^"]+)"/.exec(app);
    assert.ok(key, "the app no longer names a mode key");
    assert.ok(html.includes(`"${key[1]}"`), `the pre-paint script reads a different key than the app writes (${key[1]})`);
    assert.match(app, /setAttribute\("data-theme", resolvedMode\)/, "the app no longer stamps data-theme");
    assert.match(html, /setAttribute\("data-theme"/, "the pre-paint script no longer stamps data-theme");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
