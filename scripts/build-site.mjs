/* The marketing site, standalone, for the APEX domain.

   WHY A SECOND OUTPUT. `dist-web` is one Cloudflare Pages project
   serving the app at `/` with the site under `/site/`. The apex
   (`uniplannerapp.com`) is a DIFFERENT host, so it needs its own Pages
   project with its own build — and pointing it at `dist-web` would
   serve the app from the apex, which is the thing we are avoiding.

   THE ONE TRANSFORMATION, and it is the reason this file exists rather
   than a `cp`: the page's off-page links are ROOT-RELATIVE
   (`/privacy`, `/icon-192.png`). Served from `www` those resolve to the
   right documents. Served from the apex they resolve to paths that do
   not exist there. So they are rewritten to absolute `www` URLs, and a
   test asserts nothing root-relative survives — a broken privacy link
   on a launch page is the kind of thing nobody clicks until a store
   reviewer does.

   `APP_URL` needs no rewriting: build-web.mjs already writes it
   absolute, from SITE_URL, for exactly this reason.

   Run: npm run build:site  ->  dist-site/ */

import fs from "node:fs";
import path from "node:path";

const OUT = "dist-site";
const SRC_PAGE = "public/site/index.html";

const links = fs.readFileSync("src/legalLinks.js", "utf8");
const m = /export const SITE_URL = "([^"]+)"/.exec(links);
if (!m) throw new Error("SITE_URL is gone from src/legalLinks.js");
const SITE_URL = m[1];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "site"), { recursive: true });

/* The page's own modules, beside it. Same four the web build copies —
   read from the folder rather than listed, so a new one comes along. */
const modules = fs.readdirSync("site").filter((f) => f.endsWith(".js"));
if (modules.length === 0) throw new Error("site/ has no modules — nothing would work");
for (const f of modules) fs.copyFileSync(path.join("site", f), path.join(OUT, "site", f));

/* AND THE PAGE'S OWN SCRIPT, which lives in public/site/ beside the
   markup rather than in site/ with the data modules. Missing it
   produced a page that loaded, rendered its static markup, and filled
   in none of the slots — no download buttons, no pricing, no worker
   release, no recovery forwarding. It looked fine. */
fs.copyFileSync(path.join("public", "site", "site.js"), path.join(OUT, "site", "site.js"));

/* Icons the page references. Copied rather than linked absolutely,
   because an icon is cheap and a cross-origin favicon is a request
   this site's zero-third-party promise would rather not make. */
const ASSETS = ["icon-192.png", "icon-512.png", "apple-touch-icon.png"];
for (const f of ASSETS) {
  const from = path.join("public", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, f));
}

let html = fs.readFileSync(SRC_PAGE, "utf8");

/* `./site.js` -> `./site/site.js`: the page sits at the root here and
   its modules are one level down, where the web build also puts them. */
html = html.replace(/(src|href)="\.\/([\w.-]+\.js)"/g, `$1="./site/$2"`);

/* Root-relative -> absolute, EXCEPT the icons copied above. Listed by
   what they are rather than matched blindly, so a new root-relative
   link is a decision instead of a silent rewrite. */
const ABSOLUTE = ["/privacy", "/delete-account"];
for (const p of ABSOLUTE) {
  html = html.split(`href="${p}"`).join(`href="${SITE_URL}${p}"`);
}

fs.writeFileSync(path.join(OUT, "index.html"), html);

/* No service worker here, deliberately: this page is not an app shell,
   and a worker on the apex would cache a marketing page for people who
   later get sent somewhere else. */
const stray = fs.readdirSync(OUT).filter((f) => f === "sw.js");
if (stray.length) throw new Error("a service worker reached the apex build");

/* EVERY LINK MUST RESOLVE, checked against the output rather than
   assumed. The first version of this script rewrote `./site.js` to
   `./site/site.js` and then never copied site.js, so the page shipped
   with a dead script tag — static markup intact, every slot empty, and
   nothing about it looked broken until you read it. A rewrite that
   points somewhere is not the same claim as a rewrite that points at a
   file. */
const referenced = [...fs.readFileSync(path.join(OUT, "index.html"), "utf8").matchAll(/(?:src|href)="([^"]+)"/g)].map(
  (r) => r[1]
);
if (referenced.length === 0) throw new Error("the page references nothing — the markup did not survive");
const local = referenced.filter((r) => !/^(https?:|mailto:|#|data:)/.test(r));
const missing = local.filter((r) => !fs.existsSync(path.join(OUT, r.replace(/^\.?\//, ""))));
if (missing.length) {
  throw new Error(`the apex page links to files that are not in ${OUT}: ${missing.join(", ")}`);
}

console.log(`site build OK -> ${OUT}/ (${modules.length} modules, ${ASSETS.length} icons)`);
