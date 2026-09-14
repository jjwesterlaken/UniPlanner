/* The path split: marketing at `/`, the planner at `/app`, ONE origin.

   WHY ONE ORIGIN IS THE CLAIM AND NOT A DETAIL. A subdomain was built
   on a branch and REFUSED (Jared, 21 August and again 14 September):
   `localStorage` is scoped per ORIGIN, every planner belonging to
   somebody without an account lives only there, and the same-site
   iframe bridge that would have rescued them had holes — a browser
   that never opened the new origin, an installed PWA, any other
   device — plus behaviour no build machine here can verify. A PATH
   change needs no rescue because nothing moves. Several assertions
   below are therefore about the ORIGIN being unchanged, and they are
   the most important ones in the file.

   THREE THINGS THIS EXISTS FOR:

   1. THE APP IS STILL ON SITE_URL'S ORIGIN, and every route into it is
      ABSOLUTE. The page is served on two HOSTNAMES — the apex and www
      — which are two origins; a relative `/app/` link would land an
      apex visitor on a planner whose storage nobody else shares. That
      is the refused subdomain arriving through the back door because a
      link was one character shorter.

   2. THE OLD ROOT URLS DO THE RIGHT THING, and `/sw.js` does the right
      thing by being ABSENT — see below, it is the least obvious part
      of this change.

   3. BOTH NAV CONTROLS ARE REALLY REACHABLE. Grace's download call to
      action is kept and "Open the app" sits beside it; neither may be
      a link nobody can press.

   WHAT IT CANNOT SEE, said here rather than implied by a pass:

     - whether Cloudflare Pages is serving `dist-site` on both custom
       domains. That is a dashboard fact and no test here can ask.
     - whether a real browser unregisters a worker on a 404 script.
       That is specification, exercised by every browser, and not
       reproducible from Node.
     - the Supabase allowlist. It needs no new entry (the existing
       `/**` wildcard covers `/app`) but the Site URL fallback does
       move, and that is configuration outside this repository. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SITE_URL, SITE_APEX_URL, SITE_ORIGINS, APP_URL, DOCUMENT_PATHS } from "../src/legalLinks.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const OUT = path.join(rootDir, "dist-site");

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

/* Pull one function out of site.js and run it against a fake world.
   The module imports build-facts, so it cannot simply be imported —
   and injecting the REAL APP_URL is what keeps these tests about
   where somebody lands rather than about a string. */
const SITE_JS = read("public/site/site.js");
function forwarder(name, { pathname = "/", search = "", hash = "", standalone = false } = {}) {
  const start = SITE_JS.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} is gone from the marketing page`);
  const body = SITE_JS.slice(start, SITE_JS.indexOf("\n}", start) + 2);
  let replaced = null;
  const location = { pathname, search, hash, replace: (u) => (replaced = u) };
  const window = { matchMedia: (q) => ({ matches: standalone && /standalone|minimal-ui|fullscreen/.test(q) }) };
  const navigator = { standalone: false };
  new Function(
    "location",
    "window",
    "navigator",
    "URLSearchParams",
    "APP_URL",
    `${body}; return ${name};`
  )(location, window, navigator, URLSearchParams, APP_URL)();
  return replaced;
}

(async () => {
  /* ---------- the origin did not move ---------- */

  await test("THE APP IS A PATH ON THE SITE'S ORIGIN — not a host, which is the whole ruling", () => {
    assert.equal(
      new URL(APP_URL).origin,
      new URL(SITE_URL).origin,
      "the app left SITE_URL's origin — localStorage is scoped per origin and every signed-out planner would be stranded"
    );
    assert.ok(APP_URL.startsWith(`${SITE_URL}/`), "APP_URL is not under SITE_URL");
    assert.notEqual(APP_URL, SITE_URL, "the app and the marketing page are the same URL — there is no split");
    /* AND NOT A SUBDOMAIN, named explicitly because that is the shape
       somebody reaches for and it was refused twice. */
    assert.ok(
      !/^https:\/\/app\./.test(APP_URL),
      "the app is on an app. subdomain — that is a different origin and was ruled out on 21 August and 14 September 2026"
    );
    assert.ok(SITE_ORIGINS.includes(SITE_URL) && SITE_ORIGINS.includes(SITE_APEX_URL), "SITE_ORIGINS does not cover both hostnames");
  });

  await test("nothing carries a cross-origin storage handover, because nothing needs one", () => {
    /* The subdomain branch needed an iframe bridge to carry a
       signed-out planner between origins. A path split does not, and
       the presence of one here would mean somebody had reintroduced
       the origin change it exists to survive. */
    assert.ok(!fs.existsSync(path.join(rootDir, "src/originHandover.js")), "an origin handover exists — the app has left its origin");
    assert.ok(!fs.existsSync(path.join(rootDir, "public/site/handover.html")), "a handover bridge is being served");
    const headers = read("public/_headers");
    assert.ok(!/frame-src/.test(headers), "the CSP opens frame-src, which only a cross-origin handover needed");
    assert.match(headers, /frame-ancestors 'none'/, "the app became framable");
  });

  /* ---------- the built site ---------- */

  await test("one output serves both, and the two index pages are not the same page", () => {
    assert.ok(fs.existsSync(OUT), "dist-site is missing — run the builds");
    const marketing = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
    const app = fs.readFileSync(path.join(OUT, "app", "index.html"), "utf8");
    /* NON-VACUITY FIRST: a build that copied the app over the root, or
       the root into /app, satisfies "both files exist" perfectly. */
    assert.notEqual(marketing, app, "the marketing page and the app are the same file — one overwrote the other");
    assert.match(marketing, /data-open-app/, "the root is not the marketing page");
    assert.match(app, /id="root"/, "/app/ is not the planner");
    for (const p of DOCUMENT_PATHS) {
      assert.ok(
        fs.existsSync(path.join(OUT, `${p.replace(/^\//, "")}.html`)),
        `${SITE_URL}${p} is published and this build serves no file for it`
      );
    }
  });

  await test("THE APP MOVED WITH NO EDITS — every path in it was already relative", () => {
    /* This is the claim SITE-DEPLOY.md made before the split and it is
       checked on the BUILT artifact rather than taken on trust, since
       "it is relative" and "it resolves under /app/" are different
       sentences. */
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "app", "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.start_url, ".", "start_url is absolute — a new install would open the marketing page");
    assert.equal(manifest.scope, ".", "scope is absolute — the installed app would claim the marketing page");
    const appHtml = fs.readFileSync(path.join(OUT, "app", "index.html"), "utf8");
    assert.match(appHtml, /register\("sw\.js"\)/, "the worker is no longer registered by a relative path");
    assert.match(appHtml, /href="manifest\.webmanifest"/, "the manifest is no longer linked relatively");
    const sw = fs.readFileSync(path.join(OUT, "app", "sw.js"), "utf8");
    assert.match(sw, /new URL\("\.\/", self\.location\)/, "sw.js no longer derives its shell from where it is served");
  });

  await test("THE ROOT SHIPS NO WORKER, and /sw.js is DELIBERATELY not redirected", () => {
    /* THE LEAST OBVIOUS PART OF THIS CHANGE, and the derivation got it
       wrong before it was named.

       Every browser that has opened this app holds a worker at scope
       `/` from `/sw.js`. A service worker script request MAY NOT BE
       REDIRECTED — the Update algorithm fails on one — so a 301 there
       is refused and the stale worker stays, controlling what is now
       the marketing page. A 404 UNREGISTERS the registration instead.
       So the empty path is the active mechanism and the redirect would
       be the inert one. */
    assert.ok(!fs.existsSync(path.join(OUT, "sw.js")), "a worker at the root would claim scope / and fight the app's own");
    assert.ok(fs.existsSync(path.join(OUT, "app", "sw.js")), "the app ships no worker");
    const redirects = fs.readFileSync(path.join(OUT, "_redirects"), "utf8");
    assert.ok(!/^\/sw\.js\s/m.test(redirects), "/sw.js is redirected — the stale worker would fail its update and stay installed");
    /* And the belt to that braces is still there. */
    assert.match(SITE_JS, /getRegistrations\(\)/, "the marketing page no longer releases the worker that owned /");
    assert.match(SITE_JS, /scope\.pathname === "\/"/, "the release no longer targets the root scope specifically");
  });

  await test("NO DOCUMENT SENDS THE BUILD-ID CHECK TO THE ROOT WORKER", () => {
    /* The build-id curl is the ONLY thing that tells "merged" from
       "deployed" on this project, and the path split moved the file it
       reads. Pointed at the root it now gets a 404 page, the grep
       matches nothing, and an EMPTY RESULT is indistinguishable from a
       deploy that did not happen — the failure this whole section of
       CLAUDE.md exists to make visible, reintroduced by a stale URL in
       the instructions for finding it.

       Scoped to the CLAIM, not to a file: every tracked markdown, and
       the forbidden thing is a build-id read of a ROOT worker, never
       the mention of one. DEPLOY-CHECKLIST legitimately curls
       `/sw.js` expecting a 404 — that is the absence being VERIFIED,
       and a guard that banned the string would have had to be
       suppressed to let it through. The marker is the grep for the
       cache constant, lifted from the worker rather than typed. */
    const cacheDecl = read("public/sw.js").match(/^const (\w+) = "uni-planner-/m);
    assert.ok(cacheDecl, "public/sw.js no longer declares the cache name this guard keys on");
    const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: rootDir, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.ok(docs.length > 0, "no markdown was swept — this check would pass over nothing");

    const appPath = new URL(APP_URL).pathname;
    const buildIdReads = [];
    for (const doc of docs) {
      for (const line of read(doc).split("\n")) {
        const url = line.match(/https?:\/\/[^\s)]+\/sw\.js/);
        if (!url || !line.includes(cacheDecl[1])) continue;
        buildIdReads.push({ doc, url: url[0] });
      }
    }
    assert.ok(buildIdReads.length > 0, "no document states the build-id check at all — this check proved nothing");
    for (const { doc, url } of buildIdReads) {
      assert.ok(
        new URL(url).pathname === `${appPath}/sw.js`,
        `${doc} reads the build id from ${url}, which the path split left holding no file — the grep returns empty and an empty result reads as "the deploy did not happen"`
      );
    }
  });

  await test("every redirect source is a path that holds NO FILE", () => {
    /* THIS IS WHY `_redirects` IS SAFE HERE AND WAS NOT ON THE
       SUBDOMAIN BRANCH. There the rule needed exceptions for every
       path the site keeps, which needs 200-rewrites Cloudflare Pages
       does not support — or a reliance on asset precedence over a
       catch-all that this container cannot verify. Here every source
       is a path with nothing behind it, so precedence cannot arise. */
    const lines = fs
      .readFileSync(path.join(OUT, "_redirects"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    assert.ok(lines.length > 0, "no redirects at all — this check would pass over nothing");
    for (const line of lines) {
      const [from, to, code] = line.trim().split(/\s+/);
      assert.equal(code, "301", `${from} is not a permanent redirect`);
      assert.ok(to.startsWith(`${new URL(APP_URL).pathname}/`), `${from} does not move into the app`);
      assert.ok(
        !fs.existsSync(path.join(OUT, from.replace(/^\//, ""))),
        `${from} is redirected but a real file sits there — which of the two wins is behaviour this container cannot verify`
      );
      assert.ok(fs.existsSync(path.join(OUT, to.replace(/^\//, ""))), `${from} redirects to ${to}, which is not in the build`);
    }
  });

  await test("one origin gets ONE policy, and it is the app's", () => {
    /* Two `_headers` rules matching a path produce two CSP headers,
       and a browser enforces the INTERSECTION — so a second, tighter
       policy for the marketing pages would silently narrow the app's
       and the file would look correct while the planner stopped
       reaching Supabase. */
    const headers = fs.readFileSync(path.join(OUT, "_headers"), "utf8");
    assert.equal((headers.match(/Content-Security-Policy:/g) || []).length, 1, "a second CSP would be intersected with the first");
    assert.equal(headers, read("public/_headers"), "the origin's headers are not the app's");
    /* And no inert copy left where Pages will never read it. */
    assert.ok(!fs.existsSync(path.join(OUT, "app", "_headers")), "an inert _headers sits under /app for somebody to edit by mistake");
    assert.ok(!fs.existsSync(path.join(OUT, "app", "_redirects")), "an inert _redirects sits under /app");
  });

  /* ---------- the three forwarders ---------- */

  await test("EVERY ROUTE INTO THE APP IS ABSOLUTE, because two hostnames are two origins", () => {
    const hash = "#access_token=abc&type=recovery&expires_in=3600";
    const recovery = forwarder("forwardRecoveryToTheApp", { hash });
    const checkout = forwarder("forwardCheckoutReturnToTheApp", { search: "?checkout=done" });
    const installed = forwarder("forwardInstalledShortcutToTheApp", { standalone: true });
    for (const [name, got] of [["recovery", recovery], ["checkout", checkout], ["installed shortcut", installed]]) {
      assert.ok(got, `the ${name} forwarder did not fire on the case it exists for`);
      assert.ok(
        got.startsWith(`${APP_URL}/`),
        `the ${name} forwarder goes to "${got}" — a relative route lands an apex visitor on a second origin with its own empty planner`
      );
    }
    assert.equal(recovery, `${APP_URL}/${hash}`, "the recovery fragment was not carried across intact");
    assert.ok(checkout.includes("?checkout=done"), "the checkout query was dropped");
  });

  await test("none of the three fires on an ordinary visit", () => {
    /* A marketing page that bounces its readers to the app is worse
       than no marketing page. Each forwarder is driven on the states a
       reader is really in. */
    for (const quiet of ["", "#", "#features", "#access_token=abc&type=signup", "#type=recovery"]) {
      assert.equal(forwarder("forwardRecoveryToTheApp", { hash: quiet }), null, `recovery fired on "${quiet}"`);
    }
    assert.equal(forwarder("forwardCheckoutReturnToTheApp", { search: "" }), null, "checkout fired with no query");
    assert.equal(forwarder("forwardCheckoutReturnToTheApp", { search: "?utm=x" }), null, "checkout fired on an unrelated query");
    assert.equal(forwarder("forwardCheckoutReturnToTheApp", { pathname: "/privacy", search: "?checkout=done" }), null, "checkout fired off the root");
    /* THE ONE THAT WOULD BE WORST: an ordinary tab matches no
       display-mode, so a reader is never thrown into the app. */
    assert.equal(forwarder("forwardInstalledShortcutToTheApp", { standalone: false }), null, "an ordinary browser visit was redirected into the app");
    assert.equal(forwarder("forwardInstalledShortcutToTheApp", { pathname: "/terms", standalone: true }), null, "a shortcut opened on a document was redirected");
  });

  /* ---------- the nav, measured ---------- */

  const browser = await launch();
  if (!browser) {
    const message = "no Chromium — the nav controls are unmeasured (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)";
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      failed++;
    } else {
      console.log(`skip  - ${message}`);
    }
  } else {
    for (const { label, width, height } of [
      { label: "phone", width: 390, height: 664 },
      { label: "desktop", width: 1280, height: 800 },
    ]) {
      await test(`BOTH nav controls are on screen without scrolling, ${label} (${width}px)`, async () => {
        const ctx = await browser.newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        try {
          await page.goto(pathToFileURL(path.join(OUT, "index.html")).href);
          const boxes = await page.evaluate(() => {
            const pick = (sel) => {
              const a = document.querySelector(sel);
              if (!a) return null;
              const r = a.getBoundingClientRect();
              const cs = getComputedStyle(a);
              return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height,
                href: a.getAttribute("href"), text: a.textContent.trim(), display: cs.display, visibility: cs.visibility };
            };
            /* `.navcta`, not any `nav a[href="#download"]` — the nav
               ALSO carries a plain "Download" link among the section
               links, and it matches first. The first version of this
               test picked that one up and reported Grace's call to
               action as reworded, which it was not. A selector's
               failure mode is naming the wrong element, not naming
               nothing. */
            return { app: pick("nav .navcta[data-open-app]"), download: pick('nav .navcta[href="#download"]') };
          });
          /* GRACE'S CONTROL IS KEPT — asserted by name, because "add a
             button" is satisfied by a commit that replaced one. */
          assert.ok(boxes.download, "the Get UniPlanner control is gone from the nav");
          assert.equal(boxes.download.text, "Get UniPlanner", "the download control was reworded");
          assert.ok(boxes.app, "there is no Open the app control in the nav");

          for (const [name, b] of Object.entries(boxes)) {
            assert.notEqual(b.display, "none", `${name} is display:none at ${width}px`);
            assert.notEqual(b.visibility, "hidden", `${name} is hidden at ${width}px`);
            assert.ok(b.w > 40 && b.h > 20, `${name} is ${Math.round(b.w)}x${Math.round(b.h)} at ${width}px — too small to press`);
            assert.ok(b.top >= 0 && b.bottom <= height, `${name} sits at ${b.top}..${b.bottom}, outside a ${height}px viewport`);
            assert.ok(b.left >= 0 && b.right <= width, `${name} runs ${Math.round(b.left)}..${Math.round(b.right)}, outside ${width}px`);
          }
          /* THEY MUST NOT OVERLAP — two buttons that fit individually
             and sit on top of each other pass every check above. */
          assert.ok(
            boxes.app.right <= boxes.download.left + 1 || boxes.download.right <= boxes.app.left + 1,
            `the two nav controls overlap at ${width}px`
          );
          assert.equal(boxes.app.href, APP_URL, `the app control points at ${boxes.app.href}`);
          assert.equal(boxes.download.href, "#download", "the download control no longer points at the download section");
        } finally {
          await ctx.close();
        }
      });
    }

    await test("the nav stays on screen when the page is scrolled", async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 664 } });
      const page = await ctx.newPage();
      try {
        await page.goto(pathToFileURL(path.join(OUT, "index.html")).href);
        /* `scroll-behavior: smooth` is set on `html`, so `scrollTo`
           ANIMATES and reading scrollY on the next line returns ~0 —
           which the non-vacuity assertion below caught rather than
           the sticky check silently passing on an unscrolled page.
           Setting scrollTop is not animated. */
        /* `scroll-behavior: smooth` is set on `html`, and it animates a
           `scrollTop` ASSIGNMENT too, not only `scrollTo` — so reading
           scrollY on the next line returned 0 and the sticky check
           would have passed on a page that never moved. The
           non-vacuity assertion below is what caught it. Turn the
           behaviour off first, then scroll. */
        await page.evaluate(() => {
          document.documentElement.style.scrollBehavior = "auto";
          document.documentElement.scrollTop = 2000;
        });
        const box = await page.evaluate(() => {
          const r = document.querySelector("nav .navcta[data-open-app]").getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
        assert.ok(box.top >= 0 && box.bottom <= 664, `after scrolling the control sits at ${box.top}..${box.bottom} — the nav is not sticky`);
        const scrolled = await page.evaluate(() => window.scrollY);
        assert.ok(scrolled > 100, `the page only scrolled ${scrolled}px — this check proved nothing`);
      } finally {
        await ctx.close();
      }
    });

    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
