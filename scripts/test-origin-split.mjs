/* The origin split: what moved, what deliberately did not, and the one
   thing that cannot cross.

   THE SHAPE, because every assertion below is about one of these three:

     uniplannerapp.com          the marketing site, the four published
     www.uniplannerapp.com      legal documents, and /handover
     app.uniplannerapp.com      the planner

   THREE CLAIMS THIS FILE EXISTS FOR:

   1. EVERY OLD APP URL MOVES AND EVERY DOCUMENT URL DOES NOT. The two
      halves are one decision and only one of them is obvious. A
      redirect that swallowed /privacy would 301 a store reviewer to an
      origin that was never given the document; a redirect that missed
      /app.js would leave the old host serving a stale bundle for ever.
      Driven against the GENERATED middleware rather than the source it
      came from, because the generated file is what Cloudflare runs.

   2. THE "OPEN THE APP" CONTROL IS REALLY REACHABLE. Not "the markup
      contains a link" — a link inside a collapsed nav, below the fold,
      or behind a media query is a link nobody can press. Measured in a
      real engine at a phone width and a desktop width, on the marketing
      page and on all four documents.

   3. A SIGNED-OUT PLANNER CAN CROSS, AND ONLY UNDER THE CONDITIONS
      THAT MAKE IT SAFE. The handover runs once, into an empty planner,
      from one origin, carrying an enumerated set of keys and not the
      session. Each of those is a separate assertion because each is a
      separate way to get it wrong.

   WHAT IT CANNOT SEE, said here rather than implied by a pass:

     - whether Cloudflare Pages runs the middleware at all. That is a
       dashboard fact (the project must have Functions enabled and the
       custom domains attached), and no test here can ask.
     - whether a REAL browser hands a same-site iframe its
       unpartitioned storage. The reasoning is that partitioning is
       keyed on the registrable domain and these origins share one, so
       it should — but "should" is the word, and Safari in particular
       is unreachable from this container. The observation is a
       hardware step on DEPLOY-CHECKLIST.
     - the Supabase redirect allowlist and the Stripe dashboard. Both
       are configuration outside this repository, and both have bitten
       this project before, which is why they are checklist items
       rather than comments. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SITE_URL, SITE_APEX_URL, SITE_ORIGINS, APP_URL, PRIVACY_URL } from "../src/legalLinks.js";
import {
  HANDOVER_KEYS,
  HANDOVER_RESULT,
  HANDOVER_DONE_KEY,
  shouldAttemptHandover,
  isTrustedHandover,
  handoverWrites,
  handoverCarriedAPlanner,
  requestHandover,
} from "../src/originHandover.js";
import { ownedPaths, redirectFor } from "../site/redirects.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

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

(async () => {
  /* ---------- the two origins ---------- */

  await test("the app and the marketing site are different origins, and nothing confuses them", () => {
    assert.notEqual(APP_URL, SITE_URL, "APP_URL and SITE_URL are the same host — there is no split");
    assert.ok(SITE_ORIGINS.includes(SITE_URL) && SITE_ORIGINS.includes(SITE_APEX_URL), "SITE_ORIGINS does not cover both marketing hosts");
    assert.ok(!SITE_ORIGINS.includes(APP_URL), "the app origin is listed as a marketing origin");
    /* SAME SITE, DIFFERENT ORIGIN — the fact the handover rests on. If
       the app ever moved to a different registrable domain, the bridge
       would be a cross-SITE frame, its storage would be partitioned,
       and it would return nothing while looking exactly like a browser
       that had nothing to bring across. */
    const registrable = (u) => new URL(u).host.split(".").slice(-2).join(".");
    assert.equal(
      registrable(APP_URL),
      registrable(SITE_URL),
      "the app and the site no longer share a registrable domain, so the handover frame's storage is partitioned and it can never return anything"
    );
    /* The documents did NOT move. Their URLs are in two store listings
       and a Stripe dashboard field. */
    assert.ok(PRIVACY_URL.startsWith(`${SITE_URL}/`), "the privacy policy moved origin — that URL is published");
  });

  /* ---------- the redirects ---------- */

  await test("THE GENERATED MIDDLEWARE MOVES EVERY OLD APP URL AND MOVES NO DOCUMENT", async () => {
    const built = path.join(rootDir, "dist-site/functions/_middleware.js");
    assert.ok(fs.existsSync(built), "dist-site/functions/_middleware.js is missing — run `npm run build:site`, or the redirects are unverified");
    const mw = await import(pathToFileURL(built).href);

    const call = async (url) => {
      let servedHere = false;
      const res = await mw.onRequest({
        request: { url },
        next: async () => {
          servedHere = true;
          return new Response("asset");
        },
      });
      return servedHere ? null : res.headers.get("location");
    };

    /* STAYS. Each of these is a URL somebody else already holds: two
       store listings, a Stripe dashboard field, and the app's own
       frame. */
    const stays = ["/", "/privacy", "/privacy.html", "/terms", "/support", "/delete-account", "/handover", "/site/site.js"];
    for (const p of stays) {
      assert.equal(await call(`${SITE_URL}${p}`), null, `${p} is redirected away from the marketing origin, where it is published`);
    }

    /* MOVES. Everything that was the app. */
    const moves = ["/app.js", "/app.css", "/sw.js", "/manifest.webmanifest", "/index-old", "/whatever/deep"];
    for (const p of moves) {
      assert.equal(await call(`${SITE_URL}${p}`), `${APP_URL}${p}`, `${p} is not redirected to the app`);
    }

    /* THE TWO WORLDS MUST DIFFER BEFORE EITHER IS ASSERTED. "always
       serve here" and "always redirect" each satisfy one half of this
       test, and a middleware that ignored its argument would pass one
       loop and fail the other only by luck. */
    assert.ok(stays.length > 0 && moves.length > 0, "one of the two sets is empty — this test would pass over nothing");

    /* THE QUERY RIDES ALONG. A fragment does not need to: it never
       reaches a server, and a browser re-applies it when the Location
       carries none. That is what gets a recovery token through. */
    assert.equal(await call(`${SITE_URL}/thing?a=1&b=2`), `${APP_URL}/thing?a=1&b=2`);

    /* AND IT ANSWERS FOR THE APEX TOO, which is the other host this
       one bundle serves. */
    assert.equal(await call(`${SITE_APEX_URL}/app.js`), `${APP_URL}/app.js`);
    assert.equal(await call(`${SITE_APEX_URL}/privacy`), null);
  });

  await test("the owned set is DERIVED from the build, so a new marketing asset is not 301'd away", () => {
    /* The failure this prevents: somebody adds an image to the page,
       the owned set is a hand-written list that does not know about
       it, and the image 301s to an app origin that has no such file —
       a broken picture on the launch page, caused by adding a file. */
    const owned = ownedPaths(["index.html", "privacy.html", "brand/new-thing.svg"]);
    assert.ok(owned.includes("/brand/new-thing.svg"), "a file in the output is not in the owned set");
    assert.equal(redirectFor("/brand/new-thing.svg", owned, APP_URL), null);
    /* And the canonical extensionless form of every document, which is
       the half that would have cost the most: `/privacy` is what the
       store listings name, and a set built from filenames alone holds
       only `/privacy.html`. */
    assert.ok(owned.includes("/privacy"), "the extensionless form of a document is not owned — the published URL would 301 away");
  });

  /* ---------- the handover ---------- */

  await test("the handover runs ONCE, into an EMPTY planner, and never on a phone shell", () => {
    assert.equal(shouldAttemptHandover({ hasLocalPlanner: false, alreadyAttempted: false }), true);
    /* The condition that makes it safe: it can only ever write into an
       origin that has nothing, so there is no merge to get wrong. */
    assert.equal(shouldAttemptHandover({ hasLocalPlanner: true, alreadyAttempted: false }), false, "it would overwrite a planner that already exists here");
    assert.equal(shouldAttemptHandover({ hasLocalPlanner: false, alreadyAttempted: true }), false, "it would ask again on every load");
    /* A Capacitor or Electron shell never changed origin and has no
       old storage to reach — framing a website from one would be a
       request the app promises not to make. */
    assert.equal(shouldAttemptHandover({ hasLocalPlanner: false, alreadyAttempted: false, isNativeShell: true }), false, "a native shell would frame a website");
  });

  await test("only the marketing origins are believed, and only the enumerated keys are written", () => {
    const good = { origin: SITE_URL, data: { type: HANDOVER_RESULT, values: { "uni-planner-v1": "{}" } } };
    assert.equal(isTrustedHandover(good, SITE_ORIGINS), true);
    /* ORIGIN FIRST. Everything else in a message can be forged by
       whatever sent it; `event.origin` is set by the browser. */
    assert.equal(isTrustedHandover({ ...good, origin: "https://evil.example" }, SITE_ORIGINS), false, "a message from anywhere is accepted");
    assert.equal(isTrustedHandover(good, []), false, "an empty allowlist accepts everything");
    assert.equal(isTrustedHandover({ ...good, data: { type: "something-else", values: {} } }, SITE_ORIGINS), false);

    /* THE SESSION MUST NOT CROSS. It lives in localStorage like
       everything else and it is an access token; widening a login
       through a postMessage is a security decision with no upside,
       since signing in again costs a password. */
    const sweep = handoverWrites({
      "uni-planner-v1": "{}",
      "uni-planner-demo-session": "nope",
      "sb-kuhtogvewcooigudmgwj-auth-token": "nope",
      "uni-planner-device-id": "nope",
    });
    assert.deepEqual(Object.keys(sweep), ["uni-planner-v1"], "a key nobody enumerated was written");
    for (const k of HANDOVER_KEYS) assert.ok(!/session|auth|token|device/i.test(k), `${k} is on the handover list and should not be`);

    /* A handover that carried only a theme preference is not a rescued
       planner, and saying so would be worse than saying nothing. */
    assert.equal(handoverCarriedAPlanner({ "uni-planner-mode": "dark" }), false);
    assert.equal(handoverCarriedAPlanner({ "uni-planner-v1": "{}" }), true);
  });

  await test("a bridge that never answers resolves rather than hanging the app", async () => {
    /* There is no error event for "nobody replied" — a frame pointed
       at an origin that is down, blocked by an extension, or whose
       bridge has been removed simply sits there. This runs in front of
       the planner, so without a deadline it is a blank screen in
       exchange for a convenience. */
    let removed = false;
    const result = await requestHandover({
      bridgeUrl: `${SITE_URL}/handover`,
      allowedOrigins: SITE_ORIGINS,
      createFrame: () => ({ remove: () => (removed = true) }),
      addMessageListener: () => {},
      removeMessageListener: () => {},
      setTimer: (fn) => { fn(); return 1; },
      clearTimer: () => {},
      timeoutMs: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.ok(removed, "the frame was left in the document — a live frame on another origin under the planner");
  });

  await test("THE BRIDGE POSTS TO ONE ORIGIN AND READS ONLY WHAT THE APP ASKED FOR", () => {
    const built = path.join(rootDir, "dist-site/handover.html");
    assert.ok(fs.existsSync(built), "dist-site/handover.html is missing — the one old URL that must not redirect is not being served");
    const html = fs.readFileSync(built, "utf8");
    assert.ok(!/__[A-Z_]+__/.test(html), "the bridge shipped with an unfilled placeholder");
    /* The targetOrigin is what makes this safe: postMessage is not
       DELIVERED to any other origin, so a hostile page that frames
       this receives nothing — there is no message to intercept. */
    /* TWO HALVES, because either alone is satisfiable by a broken
       bridge: it must POST to a named targetOrigin rather than "*",
       and that name must be the app. A `"*"` here would deliver a
       student's whole planner to any page that framed this one. */
    assert.match(html, /parent\.postMessage\([^)]*,\s*APP_ORIGIN\s*\)/, "the bridge does not post to a fixed targetOrigin");
    assert.ok(!/postMessage\([^)]*,\s*["']\*["']\s*\)/.test(html), "the bridge posts to any origin at all");
    assert.ok(html.includes(`var APP_ORIGIN = "${APP_URL}"`), "the bridge's app origin is not the app");
    assert.ok(html.includes(JSON.stringify(HANDOVER_KEYS)), "the bridge reads a different key list from the app's");
    /* GENERATED, so the two halves cannot drift. The source carries a
       placeholder and would fail this if it ever shipped verbatim. */
    const src = read("public/site/handover.html");
    assert.ok(src.includes("__HANDOVER_KEYS__"), "the bridge source stopped being generated and is now a second list of keys");
  });

  await test("the app may frame the bridge, and the bridge may be framed by the app, and by nothing else", () => {
    const appHeaders = read("public/_headers");
    assert.match(appHeaders, /frame-src __SITE_ORIGINS__/, "the app's CSP does not derive frame-src, so the bridge is refused by default-src");
    assert.match(appHeaders, /frame-ancestors 'none'/, "the app became framable");
    const built = path.join(rootDir, "dist-web/_headers");
    assert.ok(fs.existsSync(built), "dist-web/_headers is missing — run the web build");
    const builtApp = fs.readFileSync(built, "utf8");
    for (const o of SITE_ORIGINS) {
      assert.ok(builtApp.includes(o), `the built CSP does not allow framing ${o}, so the handover is refused before it starts`);
    }

    const siteHeaders = path.join(rootDir, "dist-site/_headers");
    assert.ok(fs.existsSync(siteHeaders), "the marketing build ships no security headers at all");
    const site = fs.readFileSync(siteHeaders, "utf8");
    assert.ok(site.includes(`frame-ancestors 'self' ${APP_URL}`), "the marketing origin does not permit the app to frame it");
    /* One policy, not two. Two Content-Security-Policy headers are
       enforced as their INTERSECTION, so a path-specific one beside a
       general `frame-ancestors 'none'` would still block the frame
       while the file looked correct. */
    assert.equal((site.match(/Content-Security-Policy:/g) || []).length, 1, "a second CSP would be intersected with the first and block the frame silently");
    /* And X-Frame-Options is absent here on purpose: it cannot express
       "one other origin", so SAMEORIGIN would contradict the CSP. */
    assert.ok(!/X-Frame-Options/i.test(site), "X-Frame-Options is back on the marketing origin and contradicts frame-ancestors");
  });

  /* ---------- the documents, on both origins ---------- */

  await test("every published document is served by BOTH builds, and both carry the app link", () => {
    const docs = ["privacy.html", "terms.html", "support.html", "delete-account.html"];
    for (const dir of ["dist-web", "dist-site"]) {
      for (const d of docs) {
        const f = path.join(rootDir, dir, d);
        assert.ok(fs.existsSync(f), `${dir} does not serve ${d} — one of the two origins 404s a published URL`);
        const html = fs.readFileSync(f, "utf8");
        assert.ok(html.includes(`href="${APP_URL}"`), `${dir}/${d} has no route to the app`);
        /* THE TWO CONTROLS IN THAT BAR MUST GO TO DIFFERENT PLACES.
           The brand link was `/`, which is the marketing page on the
           marketing origins and THE PLANNER on the app origin — so on
           one of the two origins both controls led to the same place
           and one of them was silently dead. Absolute fixes it, and
           the assertion is that they differ rather than that either
           holds a particular string. */
        assert.ok(html.includes(`class="home" href="${SITE_URL}"`), `${dir}/${d}: the brand link is not absolute, so it means the planner on the app origin`);
        assert.notEqual(SITE_URL, APP_URL);
      }
    }
  });

  await test("nothing in the app still sends a person to the planner via the marketing origin", () => {
    /* The failure this catches is a link that still resolves, still
       looks right in review, and lands somebody on an advertisement
       for the product they are already using. */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const offenders = [];
    for (const f of fs.readdirSync(path.join(rootDir, "src"))) {
      if (!/\.(js|jsx)$/.test(f) || f === "legalLinks.js") continue;
      const code = strip(read(`src/${f}`));
      if (/PASSWORD_RESET_REDIRECT\s*=\s*SITE_URL/.test(code)) offenders.push(f);
      if (/redirectTo:\s*SITE_URL/.test(code)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `${offenders.join(", ")} still sends somebody to the marketing origin expecting the app`);
  });

  /* ---------- "visible without scrolling", measured ---------- */

  const browser = await launch();
  if (!browser) {
    const message = 'no Chromium — the "Open the app" control is unmeasured (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)';
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      failed++;
    } else {
      console.log(`skip  - ${message}`);
    }
  } else {
    /* A PHONE WIDTH AND A DESKTOP WIDTH, because the nav collapses at
       900px and the control must survive that — on a phone it is the
       only route to the app above the fold. */
    const WIDTHS = [
      { label: "phone", width: 390, height: 664 },
      { label: "desktop", width: 1280, height: 800 },
    ];
    const PAGES = ["index.html", "privacy.html", "terms.html", "support.html", "delete-account.html"];
    for (const { label, width, height } of WIDTHS) {
      await test(`the "Open the app" control is on screen without scrolling, ${label} (${width}px)`, async () => {
        const ctx = await browser.newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        try {
          for (const name of PAGES) {
            await page.goto(pathToFileURL(path.join(rootDir, "dist-site", name)).href);
            const box = await page.evaluate(() => {
              const a = document.querySelector("[data-open-app]");
              if (!a) return null;
              const r = a.getBoundingClientRect();
              const cs = getComputedStyle(a);
              return {
                top: r.top, bottom: r.bottom, left: r.left, right: r.right,
                w: r.width, h: r.height,
                href: a.getAttribute("href"),
                display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
              };
            });
            assert.ok(box, `${name} at ${width}px has no [data-open-app] control at all`);
            /* NOT MERELY PRESENT. A zero-sized, hidden or off-screen
               control satisfies "the markup contains a link" and
               satisfies nothing a person can press. */
            assert.notEqual(box.display, "none", `${name} at ${width}px: the control is display:none`);
            assert.notEqual(box.visibility, "hidden", `${name} at ${width}px: the control is hidden`);
            assert.ok(Number(box.opacity) > 0.5, `${name} at ${width}px: the control is transparent`);
            assert.ok(box.w > 40 && box.h > 20, `${name} at ${width}px: the control is ${box.w}x${box.h}, too small to press`);
            /* ABOVE THE FOLD, which is the actual claim: on screen
               with no scrolling, at the initial scroll position. */
            assert.ok(box.top >= 0 && box.bottom <= height, `${name} at ${width}px: the control is at ${box.top}..${box.bottom}, outside a ${height}px viewport`);
            assert.ok(box.left >= 0 && box.right <= width, `${name} at ${width}px: the control runs from ${box.left} to ${box.right}, outside a ${width}px viewport`);
            assert.equal(box.href, APP_URL, `${name} at ${width}px: the control points at ${box.href}`);
          }
        } finally {
          await ctx.close();
        }
      });
    }

    await test("the control STAYS on screen when the page is scrolled", async () => {
      /* "Persistent" is the word in the order and it is a different
         claim from "above the fold": a header that scrolls away is
         visible without scrolling and gone the moment somebody does. */
      const ctx = await browser.newContext({ viewport: { width: 390, height: 664 } });
      const page = await ctx.newPage();
      try {
        for (const name of ["index.html", "privacy.html"]) {
          await page.goto(pathToFileURL(path.join(rootDir, "dist-site", name)).href);
          await page.evaluate(() => window.scrollTo(0, 2000));
          const box = await page.evaluate(() => {
            const r = document.querySelector("[data-open-app]").getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          });
          assert.ok(box.top >= 0 && box.bottom <= 664, `${name}: after scrolling, the control sits at ${box.top}..${box.bottom} — it is not persistent`);
        }
        /* Non-vacuity: the page really did scroll, so "still at the
           top" is a sticky header rather than a page that never
           moved. */
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
