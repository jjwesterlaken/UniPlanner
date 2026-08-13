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

  await test("npm test still runs the service worker tests", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-service-worker\.mjs/, "the update-delivery tests were dropped from `npm test`");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
