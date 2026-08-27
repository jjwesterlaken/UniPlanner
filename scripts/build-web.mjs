/* Builds the web app into dist-web/
   Written in Node (not shell) so it runs identically on the Mac, Windows
   and Linux build machines. */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUILD_ID_TOKEN = "__BUILD_ID__";

const OUT = "dist-web";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. JavaScript bundle
await build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(OUT, "app.js"),
  logLevel: "info",
});

// 2. Stylesheet.
//    Tailwind is run by pointing Node straight at its JavaScript entry point.
//    We deliberately avoid both `npx` (unreliable on build servers) and the
//    node_modules/.bin shim, because on Windows that shim is a .cmd file and
//    modern Node refuses to execute .cmd directly (throws EINVAL).
const require = createRequire(import.meta.url);

let tailwindCli;
try {
  const pkgPath = require.resolve("tailwindcss/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.tailwindcss;
  tailwindCli = path.join(path.dirname(pkgPath), rel);
} catch (err) {
  throw new Error(
    'Could not find Tailwind. This usually means "npm install" did not install ' +
      `devDependencies. Original error: ${err.message}`
  );
}

if (!fs.existsSync(tailwindCli)) {
  throw new Error(`Tailwind CLI not found at ${tailwindCli}`);
}

// process.execPath is the Node binary currently running - works on every OS.
execFileSync(
  process.execPath,
  [tailwindCli, "-i", "src/input.css", "-o", path.join(OUT, "app.css"), "--minify"],
  { stdio: "inherit" }
);

// 3. Static files (html, icons, manifest, service worker, fonts).
//    Copied recursively so subfolders like public/fonts come across too.
fs.cpSync("public", OUT, { recursive: true });

/* ---------- the marketing site's build facts ----------

   THE PAGE NEEDS FOUR THINGS THAT LIVE IN desktop/package.json: the
   repository (for the download host), the product name and the three
   artifactName templates (for the asset names). A browser module
   cannot import that file, and typing the values into the page is the
   restatement that produces a 404 on a download button the day
   somebody renames an artifact.

   So they are GENERATED here, every build, from the one source. A test
   asserts the generated file matches what it was generated from, which
   is what makes this a derivation rather than a copy with extra steps. */
{
  const desktop = JSON.parse(fs.readFileSync("desktop/package.json", "utf8"));
  /* WHERE THE PLANNER LIVES, absolute and DERIVED.

     It was a hand-written "/app" — wrong twice over. Wrong today,
     because the app is still served from the root, so the hero button
     and two download cards 404. And root-relative is wrong from the
     APEX domain, where the marketing site is served from a different
     host and `/app` resolves to a path that does not exist there.

     Absolute, from SITE_URL, so the page works served from /site/, from
     the apex, or from / after the split. The split changes this line
     and PASSWORD_RESET_REDIRECT together — a test pins them to the same
     location, because a page pointing one place while the reset email
     points another is two half-working paths. */
  const links = fs.readFileSync("src/legalLinks.js", "utf8");
  const siteUrl = /export const SITE_URL = "([^"]+)"/.exec(links);
  if (!siteUrl) throw new Error("SITE_URL is gone from src/legalLinks.js — the site's app link cannot be derived");
  const appUrl = siteUrl[1]; // + "/app" when the origin split lands

  const facts = fs.readFileSync("site/build-facts.js", "utf8");
  const filled = facts
    .replace(/export const REPOSITORY_URL = "[^"]*";/, `export const REPOSITORY_URL = ${JSON.stringify(desktop.repository.url)};`)
    .replace(/export const PRODUCT_NAME = "[^"]*";/, `export const PRODUCT_NAME = ${JSON.stringify(desktop.build.productName)};`)
    .replace(
      /export const ARTIFACT_NAMES = \{[\s\S]*?\n\};/,
      "export const ARTIFACT_NAMES = " +
        JSON.stringify(
          {
            nsis: desktop.build.nsis.artifactName,
            portable: desktop.build.portable.artifactName,
            linux: desktop.build.linux.artifactName,
          },
          null,
          2
        ) +
        ";"
    );
  const withApp = filled.replace(
    /export const APP_URL = "[^"]*";/,
    `export const APP_URL = ${JSON.stringify(appUrl)};`
  );
  if (withApp !== facts) fs.writeFileSync("site/build-facts.js", withApp);

  /* The site's own modules ride along beside its page. Copied rather
     than bundled: three small ES modules a browser loads directly, and
     a bundler here would be a build step nobody needs. */
  for (const f of ["downloads.js", "pricing.js", "flags.js", "build-facts.js"]) {
    fs.copyFileSync(path.join("site", f), path.join(OUT, "site", f));
  }
}

// 4. Stamp the build id into the service worker and the page.
//
//    THIS IS HOW USERS RECEIVE UPDATES. The cache name in sw.js is
//    derived from the built bytes, so any change to the app produces a
//    different worker, which is what makes the browser install it, run
//    `install` again and re-fetch everything.
//
//    It replaced a hand-edited constant that was committed once and never
//    touched, which meant that for as long as that lasted, every browser
//    which had opened the app once kept serving that first build forever.
//    Nothing failed visibly; deploys simply didn't arrive. If you change
//    how assets are named or cached, keep this derivation intact.
const js = fs.readFileSync(path.join(OUT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(OUT, "app.css"), "utf8");

const buildId = crypto.createHash("sha256").update(js).update(css).digest("hex").slice(0, 12);

/* The placeholder has to be checked where it MATTERS, not merely
   somewhere in the file. Checking `includes(BUILD_ID_TOKEN)` passes on a
   comment that happens to mention the token, which would let a
   hardcoded cache name through while the build still looked happy --
   the same class of silent failure this whole change exists to remove. */
const MUST_CONTAIN_TOKEN = {
  "sw.js": /const\s+CACHE\s*=\s*"[^"]*__BUILD_ID__[^"]*"\s*;/,
  "index.html": /<meta\s+name="build-id"\s+content="[^"]*__BUILD_ID__[^"]*"\s*\/?>/,
};

for (const [file, required] of Object.entries(MUST_CONTAIN_TOKEN)) {
  const target = path.join(OUT, file);
  const before = fs.readFileSync(target, "utf8");
  if (!required.test(before)) {
    throw new Error(
      `${file} does not use ${BUILD_ID_TOKEN} where it is required (expected ${required}). ` +
        "Without it the cache name is fixed across builds, and users who have opened the app " +
        "once will never receive another update — silently."
    );
  }
  fs.writeFileSync(target, before.split(BUILD_ID_TOKEN).join(buildId));
}

if (js.length < 50_000) throw new Error("app.js looks too small - the build likely failed");
if (!css.includes("u-accent-bg") && !css.includes("bg-stone-100")) {
  throw new Error("app.css is missing expected styles - the Tailwind build likely failed");
}
if (!fs.existsSync(path.join(OUT, "index.html"))) throw new Error("index.html was not copied");

// A leftover placeholder would ship a literal "__BUILD_ID__" as the cache
// name -- fixed across every build, which is the original bug wearing a
// different string.
for (const file of ["sw.js", "index.html"]) {
  const out = fs.readFileSync(path.join(OUT, file), "utf8");
  if (out.includes(BUILD_ID_TOKEN)) throw new Error(`${file} still contains ${BUILD_ID_TOKEN} after stamping`);
  if (!out.includes(buildId)) throw new Error(`${file} does not carry the build id`);
}

console.log(
  `\nweb build OK -> ${OUT}/ (app.js ${(js.length / 1024).toFixed(0)}kb, app.css ${(css.length / 1024).toFixed(0)}kb, build ${buildId})`
);
