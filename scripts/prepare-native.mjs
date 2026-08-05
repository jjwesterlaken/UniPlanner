/* Copies the built web app into the desktop and mobile shells.

   Inside a packaged app the files are already local, so the service worker
   is redundant -- and worse, it can keep serving old files after an update.
   It gets stripped here, and iPhone safe-area padding is added. */

import fs from "node:fs";
import path from "node:path";

const SRC = "dist-web";
const TARGETS = ["desktop/www", "mobile/www"];

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
    if (entry.name === "sw.js") continue; // not wanted inside a packaged app
    const from = path.join(SRC, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }

  const htmlPath = path.join(target, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html.replace(
    /\s*<script>\s*if \("serviceWorker" in navigator\)[\s\S]*?<\/script>/,
    ""
  );
  html = html.replace("  </head>", SAFE_AREA);
  fs.writeFileSync(htmlPath, html);

  if (html.includes("serviceWorker")) {
    throw new Error(`service worker was not stripped from ${target}`);
  }
  console.log(`prepared ${target}`);
}

console.log("native copies ready");
