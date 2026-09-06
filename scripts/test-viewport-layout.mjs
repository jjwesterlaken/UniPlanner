/* What the LAYOUT actually does, at real iPhone widths, in a real engine.

   TWO DEFECTS THIS EXISTS FOR, and they were independent — which is
   worth stating, because they arrived together and looked like one
   safe-area fault in two axes.

   1. THE DOUBLED TOP INSET was native-only. `prepare-native.mjs`
      injected `body { padding: env(safe-area-inset-*) }` into the
      native copies, and the app had since grown per-element insets, so
      iOS applied the top inset TWICE — an empty band the height of the
      header above the header, on every build. dist-web never had that
      style, so every browser check and every existing test loaded the
      one artifact where the bug was absent.

   2. THE TAB ROW HANGING OFF THE RIGHT was not iOS-specific at all.
      `useBottomBar()` initialised to `false` and consulted matchMedia
      in an effect, which runs after paint — so the first frame a phone
      drew used the desktop row, whose buttons are `flex-shrink-0
      whitespace-nowrap` and cannot compress. It reproduces in desktop
      Chromium at 320, 375, 402 and 440.

   SO THIS FILE MEASURES BOTH BUNDLES. mobile/www is what Apple gets;
   dist-web is what everything else had been checking. Where they can
   differ, both are asserted.

   AND IT MEASURES THE FIRST PAINTED FRAME, not the settled one. The
   settled DOM was always correct — the bottom bar replaced the desktop
   row a frame later — so a check that waits for the app to settle
   passes over the exact thing a student photographs. A MutationObserver
   captures the DOM at the first animation frame after #root fills.

   Insets are injected over CDP (Emulation.setSafeAreaInsetsOverride),
   so `env(safe-area-inset-*)` really resolves rather than falling back
   to zero — without which every assertion here would be vacuous, since
   a zero inset cannot be doubled.

   WHAT IT CANNOT SEE, AND THIS HAS ALREADY COST A BUILD.

   Everything here measures the DOCUMENT: element rects inside the web
   viewport. iOS can inset the document from OUTSIDE it, and that band
   is invisible to every assertion in this file.

   `ios.contentInset` in capacitor.config.json becomes
   `WKWebView.scrollView.contentInsetAdjustmentBehavior`. At `.always`
   UIScrollView adds the safe-area insets to the scroll content, so the
   whole document is pushed down while the page also pads itself. And
   because Capacitor makes the web view the view controller's ROOT view
   (`view = webView`), `header.getBoundingClientRect().top` reads 0 on
   the device exactly as it does here — the header really is at the top
   of the document; the document is not at the top of the screen.

   So this file reported `dead band above header = 0` at every width on
   build 3514031 while the simulator showed an empty band the height of
   the status-bar inset. It was not measuring the wrong element or the
   wrong state: it was measuring the wrong LAYER, and was reported as
   though it settled the on-screen symptom. It does not, and cannot.

   The native half is asserted in test-dark-mode.mjs ("THE NATIVE SCROLL
   VIEW MUST NOT INSET TOO") from the config, and confirmed only on
   hardware — MOBILE-BUILD.md carries the measurement.

   Skips without a browser; REQUIRE_BROWSER=1 makes that a failure. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/* The breakpoint is LIFTED from the source, so a change to it moves
   this file's idea of "a phone" with it instead of stranding it. */
const PHONE_MAX_WIDTH = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const m = /const PHONE_MAX_WIDTH = (\d+)/.exec(src);
  assert.ok(m, "PHONE_MAX_WIDTH is gone from PlannerApp.jsx");
  return Number(m[1]);
})();

/* Every width is a real device this build can be installed on.
   TARGETED_DEVICE_FAMILY is 1 (iPhone only) and the deployment target
   is iOS 15, which still runs on the 320pt iPhone SE 1st gen — so 320
   is the narrowest supported width, not a round number. */
const DEVICES = [
  { w: 320, h: 568, inset: 20, label: "iPhone SE 1st gen (narrowest iOS 15 iPhone)" },
  { w: 375, h: 667, inset: 20, label: "iPhone SE 2nd/3rd" },
  { w: 390, h: 844, inset: 47, label: "iPhone 13/14" },
  { w: 393, h: 852, inset: 59, label: "iPhone 15/16" },
  { w: 402, h: 874, inset: 59, label: "iPhone 17" },
  { w: 430, h: 932, inset: 59, label: "iPhone 14/15 Pro Max" },
  { w: 440, h: 956, inset: 62, label: "iPhone 16 Pro Max" },
];

const BUNDLES = [
  { dir: "dist-web", label: "web" },
  { dir: "mobile/www", label: "native (what Apple gets)" },
];

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

/* Captured INSIDE the page, at the first animation frame after #root
   gains children — i.e. the frame the device actually paints, before
   React's effects have run. */
const FIRST_PAINT_PROBE = () => {
  window.__firstPaint = null;
  const capture = () => {
    if (window.__firstPaint) return;
    window.__firstPaint = {
      /* The bottom bar is "a nav that is not the header's". A
         structural selector was wrong here — the tree is
         body > #root > div > nav — and named the wrong thing rather
         than nothing, which is the failure mode a selector has. */
      hasBottomBar: [...document.querySelectorAll("nav")].some((n) => !n.closest("header")),
      hasTopRow: !!document.querySelector("header nav"),
      widest: Math.max(
        0,
        ...[...document.querySelectorAll("nav button")].map((b) => b.getBoundingClientRect().right)
      ),
    };
  };
  /* Observe `document`, not #root and not documentElement: this script
     runs before the document is parsed, so BOTH of those are still
     null and observing either throws. `document` always exists, and
     subtree:true sees the tree appear underneath it.

     Two earlier versions of this probe attached to null and captured
     nothing — which the "really measured a rendered page" assertion
     turned into a failure rather than a silent pass, which is the only
     reason it was noticed. */
  const obs = new MutationObserver(() => {
    const root = document.getElementById("root");
    if (root && root.children.length) {
      requestAnimationFrame(() => {
        capture();
        obs.disconnect();
      });
    }
  });
  obs.observe(document, { childList: true, subtree: true });
};

async function measure(browser, bundleDir, dev, insets) {
  const ctx = await browser.newContext({
    viewport: { width: dev.w, height: dev.h },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  await page.addInitScript(FIRST_PAINT_PROBE);
  await page.addInitScript(() => {
    localStorage.setItem("uni-planner-mode", "light");
    localStorage.setItem("uni-planner-tab", "planner");
  });
  await page.goto("file://" + path.join(rootDir, bundleDir, "index.html"));
  await page.waitForSelector("#root > *", { timeout: 15_000 });
  await page.waitForTimeout(350);

  const out = await page.evaluate((vw) => {
    /* What env() really resolved to, read off a probe element rather
       than assumed from what CDP was told — the inset is the number
       every assertion below is compared against, so it has to be
       measured too. */
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top,0px)";
    document.body.appendChild(probe);
    const insetTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();

    /* An element inside a horizontal scroller is ALLOWED to sit past
       the viewport — that is what a scroller is for. Anything else is
       content the user cannot reach. */
    const inScroller = (el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      return false;
    };

    const past = [];
    let examined = 0;
    for (const el of document.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      examined += 1;
      if ((b.right > vw + 0.5 || b.left < -0.5) && !inScroller(el)) {
        past.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 20),
          left: +b.left.toFixed(1),
          right: +b.right.toFixed(1),
        });
      }
    }

    const header = document.querySelector("header");
    const hb = header.getBoundingClientRect();
    const inner = header.firstElementChild.getBoundingClientRect();

    return {
      examined,
      insetTop,
      past,
      docScrollWidth: document.documentElement.scrollWidth,
      headerTop: +hb.top.toFixed(1),
      headerPaddingTop: parseFloat(getComputedStyle(header).paddingTop) || 0,
      gapAboveHeaderContent: +(inner.top - hb.top).toFixed(1),
      deadBandAboveHeader: +hb.top.toFixed(1),
      firstPaint: window.__firstPaint,
    };
  }, dev.w);

  await ctx.close();
  return out;
}

async function run() {
  for (const b of BUNDLES) {
    assert.ok(
      fs.existsSync(path.join(rootDir, b.dir, "index.html")),
      `${b.dir} is missing — run "npm run build" (build:web alone does not produce the native copies)`
    );
  }

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

  const seen = {};
  for (const b of BUNDLES) {
    seen[b.dir] = {};
    for (const dev of DEVICES) {
      seen[b.dir][dev.w] = await measure(browser, b.dir, dev, {
        top: dev.inset,
        left: 0,
        right: 0,
        bottom: dev.inset ? 34 : 0,
      });
    }
  }
  await browser.close();

  console.log("\n  measured (portrait, per bundle):");
  for (const b of BUNDLES) {
    console.log(`    ${b.dir}:`);
    for (const dev of DEVICES) {
      const m = seen[b.dir][dev.w];
      console.log(
        `      ${String(dev.w).padStart(3)}px inset=${String(m.insetTop).padStart(2)}  ` +
          `dead band above header=${String(m.deadBandAboveHeader).padStart(4)}  ` +
          `gap above header content=${String(m.gapAboveHeaderContent).padStart(4)}  ` +
          `past viewport=${m.past.length}`
      );
    }
  }
  console.log("");

  for (const b of BUNDLES) {
    for (const dev of DEVICES) {
      const m = seen[b.dir][dev.w];

      await test(`${b.label} @ ${dev.w}px (${dev.label}): the probe really measured a rendered page`, () => {
        assert.ok(m.examined > 50, `only ${m.examined} laid-out elements — the page did not render, so nothing below means anything`);
        assert.ok(m.firstPaint, "the first painted frame was never captured, so the first-paint assertions would pass over nothing");
        assert.equal(m.insetTop, dev.inset, `env(safe-area-inset-top) resolved to ${m.insetTop}, not the ${dev.inset} injected — the inset assertions cannot discriminate`);
      });

      await test(`${b.label} @ ${dev.w}px: nothing is laid out past the viewport`, () => {
        assert.deepEqual(
          m.past,
          [],
          `content the user cannot reach:\n        ` +
            m.past.map((p) => `<${p.tag}> [${p.left}..${p.right}] "${p.text}"`).join("\n        ")
        );
        assert.ok(
          m.docScrollWidth <= dev.w + 0.5,
          `the document scrolls horizontally: scrollWidth ${m.docScrollWidth} > viewport ${dev.w}`
        );
      });

      await test(`${b.label} @ ${dev.w}px: the top inset is applied ONCE, not twice`, () => {
        /* Compared against the inset this run actually injected, never
           a hardcoded number — the point is the RELATIONSHIP. The
           header pads itself so its background paints under the status
           bar, so its own padding SHOULD equal the inset; what must be
           zero is any band above the header, which is what a second
           application produces. */
        assert.equal(
          m.headerPaddingTop,
          dev.inset,
          `the header pads ${m.headerPaddingTop} against an inset of ${dev.inset} — its content would sit under the status bar`
        );
        assert.equal(
          m.deadBandAboveHeader,
          0,
          `there is a ${m.deadBandAboveHeader}px empty band above the header against an inset of ${dev.inset}. ` +
            "The inset is being applied a second time by something outside the header — the native bundle used to " +
            "pad BODY by every inset on top of this."
        );
        assert.equal(
          m.gapAboveHeaderContent,
          dev.inset,
          `header content sits ${m.gapAboveHeaderContent} below the header's top edge, against an inset of ${dev.inset}`
        );
      });

      if (dev.w < PHONE_MAX_WIDTH) {
        await test(`${b.label} @ ${dev.w}px: the FIRST PAINTED FRAME already has the phone tab bar`, () => {
          /* The settled DOM was always right. This is the frame the
             device draws before any effect runs, and it is the one
             that was showing the desktop row's 508px of buttons on a
             402px screen. */
          assert.equal(
            m.firstPaint.hasBottomBar,
            true,
            "the first painted frame has no bottom tab bar, so the phone drew the desktop row first"
          );
          assert.equal(
            m.firstPaint.hasTopRow,
            false,
            "the first painted frame still renders the desktop tab row, whose buttons cannot compress"
          );
          assert.ok(
            m.firstPaint.widest <= dev.w + 0.5,
            `a tab button reaches x=${m.firstPaint.widest} on a ${dev.w}px screen in the first painted frame`
          );
        });
      }
    }
  }

  await test("the two bundles agree about the top inset — the native one is not special", () => {
    /* The whole reason this defect survived: mobile/www carried a style
       dist-web did not, so checking one said nothing about the other. */
    for (const dev of DEVICES) {
      const web = seen["dist-web"][dev.w];
      const nat = seen["mobile/www"][dev.w];
      assert.equal(
        nat.deadBandAboveHeader,
        web.deadBandAboveHeader,
        `at ${dev.w}px the native bundle has a ${nat.deadBandAboveHeader}px band above the header and the web one has ${web.deadBandAboveHeader} — ` +
          "the native copies have grown a layout rule of their own again"
      );
      assert.equal(nat.gapAboveHeaderContent, web.gapAboveHeaderContent, `header content sits differently in the two bundles at ${dev.w}px`);
    }
  });

  await test("every device width was really measured, in both bundles", () => {
    for (const b of BUNDLES) {
      const widths = Object.keys(seen[b.dir]).map(Number).sort((x, y) => x - y);
      assert.deepEqual(
        widths,
        DEVICES.map((d) => d.w).sort((x, y) => x - y),
        `${b.dir} was measured at ${widths.length} widths, not ${DEVICES.length}`
      );
    }
    assert.ok(DEVICES.some((d) => d.w === 320), "the narrowest supported iPhone is not in the list");
  });

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
