/* Builds the web app into dist-web/
   Written in Node (not shell) so it runs identically on the Mac, Windows
   and Linux build machines. */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

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

// 4. Fail loudly rather than shipping something broken
const js = fs.readFileSync(path.join(OUT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(OUT, "app.css"), "utf8");
if (js.length < 50_000) throw new Error("app.js looks too small - the build likely failed");
if (!css.includes("u-accent-bg") && !css.includes("bg-stone-100")) {
  throw new Error("app.css is missing expected styles - the Tailwind build likely failed");
}
if (!fs.existsSync(path.join(OUT, "index.html"))) throw new Error("index.html was not copied");

console.log(`\nweb build OK -> ${OUT}/ (app.js ${(js.length / 1024).toFixed(0)}kb, app.css ${(css.length / 1024).toFixed(0)}kb)`);
