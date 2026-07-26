/* Builds the web app into dist-web/
   Written in Node (not shell) so it runs identically on the Mac, Windows
   and Linux build machines. */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
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

// 2. Stylesheet. Call the locally installed Tailwind binary directly rather
//    than going through npx, which behaves inconsistently on build servers.
const binName = process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss";
const tailwindBin = path.join("node_modules", ".bin", binName);

if (!fs.existsSync(tailwindBin)) {
  throw new Error(
    `Tailwind was not found at ${tailwindBin}. ` +
      `This usually means "npm install" did not install devDependencies. ` +
      `Check that NODE_ENV is not set to "production" before installing.`
  );
}

execFileSync(
  tailwindBin,
  ["-i", "src/input.css", "-o", path.join(OUT, "app.css"), "--minify"],
  { stdio: "inherit" }
);

// 3. Static files (html, icons, manifest, service worker)
for (const file of fs.readdirSync("public")) {
  fs.copyFileSync(path.join("public", file), path.join(OUT, file));
}

// 4. Fail loudly rather than shipping something broken
const js = fs.readFileSync(path.join(OUT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(OUT, "app.css"), "utf8");
if (js.length < 50_000) throw new Error("app.js looks too small - the build likely failed");
if (!css.includes("u-accent-bg") && !css.includes("bg-stone-100")) {
  throw new Error("app.css is missing expected styles - the Tailwind build likely failed");
}
if (!fs.existsSync(path.join(OUT, "index.html"))) throw new Error("index.html was not copied");

console.log(`\nweb build OK -> ${OUT}/ (app.js ${(js.length / 1024).toFixed(0)}kb, app.css ${(css.length / 1024).toFixed(0)}kb)`);
