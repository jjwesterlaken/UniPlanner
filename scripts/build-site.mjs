/* The marketing site, standalone — for the APEX and `www`.

   WHAT THIS OUTPUT IS, AFTER THE ORIGIN SPLIT. One Cloudflare Pages
   project serving `uniplannerapp.com` AND `www.uniplannerapp.com`:

     - the marketing page at `/`
     - the four published legal documents, at the URLs they were
       published under and which two app-store listings and a Stripe
       dashboard field already name
     - `/handover`, the one old URL that must not redirect, which is
       how a signed-out planner crosses to the new origin
     - a middleware that 301s everything else — every URL that used to
       be the app — to `app.uniplannerapp.com`

   `dist-web` is the OTHER project and serves the app at
   `app.uniplannerapp.com`. It keeps its own copies of the legal
   documents, so they resolve on both origins.

   WHAT CHANGED HERE WITH THE SPLIT, and why the old transformation is
   gone: this build used to rewrite the page's root-relative links
   (`/privacy`) to absolute `www` URLs, because the apex served no such
   files. It serves them now — the documents are copied in below — so
   root-relative is not merely adequate, it is BETTER: a visitor who
   arrived on the apex stays on the apex instead of being thrown to
   `www` by a footer link. The test that asserted nothing root-relative
   survives is inverted to match, in the same commit, because a guard
   left pointing at the old arrangement is one somebody deletes.

   Run: npm run build:site  ->  dist-site/ */

import fs from "node:fs";
import path from "node:path";

import { ownedPaths } from "../site/redirects.js";
import { HANDOVER_KEYS, HANDOVER_RESULT } from "../src/originHandover.js";

const OUT = "dist-site";
const SRC_PAGE = "public/site/index.html";

const links = fs.readFileSync("src/legalLinks.js", "utf8");
const read = (name) => {
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(links);
  if (!m) throw new Error(`${name} is gone from src/legalLinks.js`);
  return m[1];
};
const SITE_URL = read("SITE_URL");
const APP_URL = read("APP_URL");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "site"), { recursive: true });

/* The page's own modules, beside it. Same ones the web build copies —
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

/* THE FONTS, because the legal documents and the page are served from
   here now and a self-hosted font that is not in the output is a
   third-party request waiting to be "fixed" by somebody pointing it at
   Google. The zero-third-party promise is about this origin too. */
if (fs.existsSync("public/fonts")) {
  fs.mkdirSync(path.join(OUT, "fonts"), { recursive: true });
  for (const f of fs.readdirSync("public/fonts")) {
    fs.copyFileSync(path.join("public/fonts", f), path.join(OUT, "fonts", f));
  }
}

/* THE PUBLISHED DOCUMENTS, DERIVED FROM legalLinks.js rather than
   listed — the same derivation the rewrite used to use, pointed at a
   different job. Every `*_URL` under SITE_URL is a document this
   origin is now responsible for serving, so a fifth one is copied the
   moment its constant exists rather than 404ing at the URL a store
   listing already names. */
const DOC_PATHS = [...links.matchAll(/export const \w+_URL = `\$\{SITE_URL\}(\/[\w-]+)`/g)].map((m) => m[1]);
if (DOC_PATHS.length === 0) throw new Error("no document paths found in src/legalLinks.js — the site would serve no legal pages");
for (const p of DOC_PATHS) {
  const file = `${p.replace(/^\//, "")}.html`;
  const from = path.join("public", file);
  if (!fs.existsSync(from)) throw new Error(`${SITE_URL}${p} has a URL constant but no public/${file} to serve`);
  fs.copyFileSync(from, path.join(OUT, file));
}

/* THE HANDOVER BRIDGE. Generated rather than copied, because the keys
   it may read and the message it sends are owned by
   src/originHandover.js — the app's half — and two lists of keys that
   have to agree is the failure this project spends its discipline
   avoiding. The app filters what arrives against the same constant, so
   neither side can widen alone. */
{
  const bridge = fs
    .readFileSync("public/site/handover.html", "utf8")
    .split("__HANDOVER_KEYS__").join(JSON.stringify(HANDOVER_KEYS))
    .split("__HANDOVER_RESULT__").join(HANDOVER_RESULT)
    .split("__APP_ORIGIN__").join(APP_URL);
  if (bridge.includes("__")) {
    const left = [...bridge.matchAll(/__[A-Z_]+__/g)].map((m) => m[0]);
    if (left.length) throw new Error(`handover.html still carries placeholders: ${left.join(", ")}`);
  }
  fs.writeFileSync(path.join(OUT, "handover.html"), bridge);
}

let html = fs.readFileSync(SRC_PAGE, "utf8");

/* `./site.js` -> `./site/site.js`: the page sits at the root here and
   its modules are one level down, where the web build also puts them. */
html = html.replace(/(src|href)="\.\/([\w.-]+\.js)"/g, `$1="./site/$2"`);

/* THE APP ORIGIN, substituted rather than typed into the markup. The
   "Open the app" control is in the nav of this page and of all four
   legal documents, and a subdomain typed into five files is five
   chances to publish a link to an origin that does not exist. */
html = html.split("__APP_ORIGIN__").join(APP_URL).split("__SITE_ORIGIN__").join(SITE_URL);

fs.writeFileSync(path.join(OUT, "index.html"), html);

/* The legal documents carry the same control and the same placeholder. */
for (const p of DOC_PATHS) {
  const file = path.join(OUT, `${p.replace(/^\//, "")}.html`);
  const doc = fs
    .readFileSync(file, "utf8")
    .split("__APP_ORIGIN__").join(APP_URL)
    /* Absolute, not `/`: these documents are served from the app
       origin as well, where `/` is the planner. */
    .split("__SITE_ORIGIN__").join(SITE_URL);
  fs.writeFileSync(file, doc);
}

/* No service worker here, deliberately: this page is not an app shell,
   and a worker on the marketing origin would cache a marketing page
   for people who are about to be sent somewhere else. */
const stray = fs.readdirSync(OUT).filter((f) => f === "sw.js");
if (stray.length) throw new Error("a service worker reached the marketing build");

/* ---------- security headers ----------

   THE MARKETING BUILD HAD NONE, which is a gap the split exposes
   rather than creates: `public/_headers` is copied into `dist-web` by
   the web build and this output never had a copy, so the apex has been
   serving a page with no CSP and no nosniff since it went up. Now that
   these origins serve the LEGAL DOCUMENTS as well, that is the same
   class of problem the app's own header file exists for.

   `frame-ancestors` IS THE ONE THAT IS DELIBERATELY NOT `'none'`, and
   it is worth being explicit about why rather than leaving it looking
   like an oversight. The app frames `/handover` on this origin to
   carry a signed-out planner across the split (src/originHandover.js),
   so this origin must permit exactly one framer: the app.

   IT IS SCOPED TO THE ORIGIN RATHER THAN TO `/handover`, because a
   path-specific CSP beside a general one means TWO Content-Security-
   Policy headers on that path, and two policies are enforced as their
   INTERSECTION — the narrower `frame-ancestors 'none'` would still
   win and the frame would still be blocked, silently, with the header
   file looking correct. One policy, one answer.

   The cost of that is real and small: any page on the marketing origin
   may be framed by our own app. These are a brochure and four public
   legal documents, with no session, no form that does anything and
   nothing to clickjack.

   AND `X-Frame-Options` IS OMITTED HERE, not set to SAMEORIGIN. It is
   origin-based and has no way to express "one other origin", so
   SAMEORIGIN would block the app's frame in every browser that honours
   it while the CSP said otherwise — the same disagreement one header
   over. `frame-ancestors` supersedes it wherever both are understood,
   and the app's own build keeps the stricter pair. */
{
  const headers = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  Permissions-Policy: microphone=(), camera=(), geolocation=(), payment=(), usb=()",
    "  Content-Security-Policy: " +
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        /* Zero third-party, the same promise the app makes and the
           privacy policy states. Nothing on these pages fetches
           anything: every download is an href GitHub resolves at click
           time, and the fonts are served from here. */
        "connect-src 'none'",
        "img-src 'self' data:",
        "font-src 'self'",
        "object-src 'none'",
        `frame-ancestors 'self' ${APP_URL}`,
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "_headers"), headers);
}

/* ---------- the redirect middleware ----------

   Generated LAST, from the files that were actually written, so the
   set of paths this origin keeps is a fact about the output rather
   than a list somebody maintains. See site/redirects.js for why this
   is middleware and not a _redirects file. */
const walk = (dir, base = "") => {
  const out = [];
  for (const entry of fs.readdirSync(path.join(OUT, dir), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
};
const files = walk(".");
if (files.length === 0) throw new Error("the marketing build wrote no files");
const OWNED = ownedPaths(files);

fs.mkdirSync(path.join(OUT, "functions"), { recursive: true });
fs.writeFileSync(
  path.join(OUT, "functions", "_middleware.js"),
  `/* GENERATED by scripts/build-site.mjs — do not edit.

   Runs on the marketing origins before any asset is served. A path
   this origin owns falls through to the asset; everything else was
   the app and is 301'd to it, path and query intact. Fragments are
   never sent to a server, and a browser re-applies the one it had
   when the Location carries none — which is what gets a Supabase
   recovery token through this intact. */
const OWNED = ${JSON.stringify(OWNED, null, 2)};
const APP_ORIGIN = ${JSON.stringify(APP_URL)};

${fs.readFileSync("site/redirects.js", "utf8").split("export function redirectFor")[1].replace(/^/, "export function redirectFor")}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = redirectFor(url.pathname, OWNED, APP_ORIGIN, url.search);
  if (target) return Response.redirect(target, 301);
  return context.next();
}
`
);

/* EVERY LINK MUST RESOLVE, checked against the output rather than
   assumed. The first version of this script rewrote `./site.js` to
   `./site/site.js` and then never copied site.js, so the page shipped
   with a dead script tag — static markup intact, every slot empty, and
   nothing about it looked broken until you read it. A rewrite that
   points somewhere is not the same claim as a rewrite that points at a
   file. Now it checks the legal documents too, since this origin
   serves them and a footer link to a file nobody copied is the same
   failure one page over. */
for (const page of ["index.html", ...DOC_PATHS.map((p) => `${p.replace(/^\//, "")}.html`)]) {
  const referenced = [...fs.readFileSync(path.join(OUT, page), "utf8").matchAll(/(?:src|href)="([^"]+)"/g)].map((r) => r[1]);
  if (referenced.length === 0) throw new Error(`${page} references nothing — the markup did not survive`);
  const local = referenced.filter((r) => !/^(https?:|mailto:|#|data:)/.test(r));
  const missing = local.filter((r) => {
    const clean = r.split("#")[0].split("?")[0].replace(/^\.?\//, "");
    if (!clean) return false;
    return !fs.existsSync(path.join(OUT, clean)) && !fs.existsSync(path.join(OUT, `${clean}.html`));
  });
  if (missing.length) throw new Error(`${page} links to files that are not in ${OUT}: ${missing.join(", ")}`);
}

console.log(
  `site build OK -> ${OUT}/ (${modules.length} modules, ${ASSETS.length} icons, ${DOC_PATHS.length} documents, ${OWNED.length} owned paths)`
);
