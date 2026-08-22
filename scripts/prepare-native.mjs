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

const SRC = "dist-web";
const TARGETS = ["desktop/www", "mobile/www"];
const TOOLS = "tools";

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
    // Not wanted inside a packaged app -- and see the header: this is
    // the half of the strip that is still doing real work.
    if (entry.name === "sw.js") continue;
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
  for (const name of fs.readdirSync(TOOLS)) {
    fs.copyFileSync(path.join(TOOLS, name), path.join(target, name));
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
