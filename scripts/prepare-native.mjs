/* Copies the built web app into the desktop and mobile shells.

   Inside a packaged app the files are already local, so the service worker
   is redundant -- and worse, it can keep serving old files after an update.
   It gets stripped here, and iPhone safe-area padding is added.

   ---------------------------------------------------------------------
   IS THE STRIP STILL LOAD-BEARING? Two halves, two different answers, and
   this is written down because the first half looks dead and isn't quite.

   Since the service-worker work, index.html only registers on `https:`
   with a non-localhost host -- which already excludes Electron
   (`file://`), Capacitor iOS (`capacitor://localhost`) and Capacitor
   Android (`http://localhost`). So:

     removing the SCRIPT   is now belt-and-braces. The gate would stop
                           registration on all three shells anyway. Two
                           independent mechanisms, deliberately, in the
                           same spirit as the derived cache name plus the
                           network-first shell.

     removing sw.js        still does something the gate does not. The
                           file is absent from the bundle, so there is
                           nothing to register even if the gate were
                           relaxed or bypassed later. Android is the live
                           case: `http://localhost` IS a secure context,
                           so it is excluded only by the protocol check,
                           and someone could reasonably decide to allow it.

   Delete the script strip if you like; do not delete the sw.js skip.
   --------------------------------------------------------------------- */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SRC = "dist-web";
const TARGETS = ["desktop/www", "mobile/www"];
const TOOLS = "tools";

/* ---------- what a PACKAGED app may contain ----------

   dist-web is the WEB deploy. A store bundle is a different artifact
   with different rules, and copying one into the other wholesale put
   two things inside a submitted app that had no business there:

   `site/` is the marketing page — it carries PRICES and external
   GitHub download links. Neither store looks kindly on an app bundle
   containing links to buy or download outside the store, and it is
   dead weight besides: nothing in the app can reach it.

   `measure-audio.html` asks for the microphone. It exists for one
   measurement and belongs in a diagnostic build, not in the one
   twelve testers install.

   DECLARED WITH REASONS RATHER THAN LISTED, and the guard in
   test-service-worker.mjs enumerates dist-web's top level and fails on
   anything that appears in neither map — so a new asset forces the
   decision instead of being copied by default. */
const NATIVE_EXCLUDED = {
  "sw.js": "a worker inside a packaged app can serve files from before a store update replaced them",
  site: "the marketing page: prices and external download links do not belong in a store bundle",
  "_headers": "Cloudflare Pages directives, meaningless anywhere but the web host",
};

/* Copied only when asked for. `INCLUDE_TOOLS=1 npm run build` produces
   a diagnostic build; a release build must not carry these. */
const INCLUDE_TOOLS = process.env.INCLUDE_TOOLS === "1";

/* WHAT A PACKAGED APP CARRIES, declared entry by entry.

   This map used to live only in test-service-worker.mjs, which meant
   the classification ran in CI and nowhere else: a local `npm run
   build` on the release Mac would copy a brand-new dist-web entry into
   the store bundle without anyone deciding it should — the exact
   mechanism that put the marketing page inside build 3494152. A gate
   that only runs where the mistake cannot happen is a remembered path
   with extra steps.

   So the BUILD enforces it, unconditionally: every top-level entry of
   dist-web must be named here or in NATIVE_EXCLUDED, and anything
   unnamed fails the build naming the file. The test now checks this
   gate behaves rather than keeping its own copy of the map. */
const NATIVE_SHIPPED = {
  "index.html": "the app shell",
  "app.js": "the bundle",
  "app.css": "the stylesheet",
  fonts: "self-hosted, so the packaged app has them offline",
  "manifest.webmanifest": "harmless in a shell; the PWA install path ignores it there",
  "icon-192.png": "referenced by the manifest",
  "icon-512.png": "referenced by the manifest",
  "apple-touch-icon.png": "referenced by index.html",
  "privacy.html": "the published policy — a local copy costs nothing and works offline",
  "delete-account.html": "as above, and Google Play requires the page to be reachable",
};

for (const entry of fs.readdirSync(SRC)) {
  if (!NATIVE_SHIPPED[entry] && !NATIVE_EXCLUDED[entry]) {
    throw new Error(
      `dist-web contains "${entry}", which is neither declared as shipped nor excluded from packaged apps. ` +
        "Add it to NATIVE_SHIPPED or NATIVE_EXCLUDED in scripts/prepare-native.mjs, with a reason — " +
        "an unclassified asset inside a store bundle is how the marketing page shipped to Apple."
    );
  }
}

if (!fs.existsSync(SRC)) {
  throw new Error(`${SRC} not found - run "npm run build:web" first`);
}

const SAFE_AREA = `
    <style>
      body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    </style>
  </head>`;

for (const target of TARGETS) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (NATIVE_EXCLUDED[entry.name]) continue;
    const from = path.join(SRC, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }

  /* DIAGNOSTICS THAT SHIP TO THE SHELLS AND NOT TO THE WEB.

     measure-audio.html asks for the microphone, so a public copy on the
     app's origin undercuts the zero-third-party, nothing-leaves-the-
     device positioning for no benefit — Jared's ruling. But it has to
     run INSIDE WKWebView to answer anything, so it cannot simply be
     deleted.

     It lives in tools/ rather than public/ and is copied in here. That
     way the rule is structural: public/ means "ships to the web",
     tools/ means "packaged shells only", and there is no filename
     exclusion list in build-web.mjs to drift out of step with what is
     really in the folder. */
  if (INCLUDE_TOOLS) {
    for (const name of fs.readdirSync(TOOLS)) {
      fs.copyFileSync(path.join(TOOLS, name), path.join(target, name));
    }
  }

  const htmlPath = path.join(target, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  /* Strip between the MARKERS, not by matching the script's contents.

     The previous regex looked for `<script>` immediately followed by
     `if ("serviceWorker" in navigator)`. That restated the shape of the
     code it was removing, so when the registration block was rewritten --
     gaining a comment, an IIFE wrapper and a negated condition -- it
     silently stopped matching and `npm run build` began failing on the
     check below. Nothing noticed for a fortnight, because `npm test`
     builds only the web bundle and the desktop workflow is manual.

     Markers are a contract index.html can keep while its contents
     change. Same rule as everywhere else here: derive the guard from
     something stable, don't restate the thing being guarded. */
  html = html.replace(/[ \t]*<!-- sw-register:start[\s\S]*?sw-register:end -->\n?/, "");
  html = html.replace("  </head>", SAFE_AREA);
  fs.writeFileSync(htmlPath, html);

  if (html.includes("serviceWorker")) {
    throw new Error(`service worker was not stripped from ${target}`);
  }
  console.log(`prepared ${target}`);
}

console.log("native copies ready");
