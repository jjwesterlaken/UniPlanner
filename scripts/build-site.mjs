/* The published site: marketing at `/`, the planner at `/app`.

   ONE OUTPUT, BECAUSE IT IS ONE ORIGIN. That is the whole shape of
   this file and the thing to understand before changing it. The path
   split puts the marketing page and the app on the SAME host, and a
   Cloudflare Pages project serves exactly one directory — so there is
   no arrangement in which two builds land on one origin except by one
   of them containing the other. `dist-site` is that container:

     dist-site/            the marketing page, the four legal
                           documents, the fonts and icons
     dist-site/app/        the entire web build, verbatim
     dist-site/_headers    ONE policy for the whole origin
     dist-site/_redirects  the app's old root URLs, moved

   `dist-web` IS NOT TOUCHED and is still the artifact the desktop and
   phone shells are packaged from. It is copied in, not moved, so
   `prepare-native.mjs` and electron-builder see exactly what they saw
   before the split.

   WHY THE APP NEEDED NO CHANGES TO MOVE. Everything in it is already
   path-relative — `manifest.webmanifest`'s `start_url` and `scope` are
   `"."`, the icons and `app.js` are bare filenames, the worker is
   registered as `register("sw.js")`, and `sw.js` derives its shell
   list from `new URL("./", self.location)`. So the app at `/app/`
   scopes its worker to `/app/`, installs a PWA whose start_url is
   `/app/`, and caches the right files, with no edit at all. That was
   predicted in SITE-DEPLOY.md and is now checked rather than assumed.

   AND `localStorage` DOES NOT MOVE, which is the entire reason this is
   a path and not a subdomain: storage is scoped by ORIGIN and paths do
   not scope it. No planner is migrated because none of them moves.

   Run: npm run build:web && npm run build:site  ->  dist-site/ */

import fs from "node:fs";
import path from "node:path";

const OUT = "dist-site";
const APP_BUILD = "dist-web";
const SRC_PAGE = "public/site/index.html";

/* IMPORTED, NOT REGEXED OUT OF THE SOURCE. This build used to match
   the constants as text, which worked while they were quoted literals
   and stopped the moment APP_URL became a template. legalLinks.js is
   plain JS with no browser globals, so Node can simply load it and
   there is nothing to parse. */
import { SITE_URL, APP_URL, DOCUMENT_PATHS } from "../src/legalLinks.js";

/* The app's PATH, from the same constant every button points at, so
   the directory this build writes the app into and the URL it is
   reached by cannot disagree. */
if (!APP_URL.startsWith(`${SITE_URL}/`)) {
  throw new Error(`APP_URL (${APP_URL}) is not a path under SITE_URL — the path split is the whole reason it must be`);
}
const APP_PATH = APP_URL.slice(SITE_URL.length); // "/app"
const APP_DIR = APP_PATH.replace(/^\//, "");
if (!APP_DIR) throw new Error(`APP_URL has no path under SITE_URL — the app would overwrite the marketing site`);

/* The one filename that means something at BOTH depths: `/sw.js` is
   the registration every pre-split browser still holds, and
   `/app/sw.js` is the live one. Named once, used by the root-worker
   block and by the redirect derivation below. */
const WORKER_SCRIPT = "sw.js";

/* THE APP BUILD MUST ALREADY EXIST. Assembling a site with an empty
   `/app` produces a marketing page whose every button 404s and whose
   build looked fine — the same failure as the apex page that shipped
   with a dead script tag, one directory up. */
if (!fs.existsSync(path.join(APP_BUILD, "index.html"))) {
  throw new Error(`${APP_BUILD}/index.html is missing — run \`npm run build:web\` first, or ${OUT}/${APP_DIR} ships empty`);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "site"), { recursive: true });

/* The page's own modules, beside it. Read from the folder rather than
   listed, so a new one comes along. */
const modules = fs.readdirSync("site").filter((f) => f.endsWith(".js"));
if (modules.length === 0) throw new Error("site/ has no modules — nothing would work");
for (const f of modules) fs.copyFileSync(path.join("site", f), path.join(OUT, "site", f));

/* AND THE PAGE'S OWN SCRIPT, which lives in public/site/ beside the
   markup rather than in site/ with the data modules. Missing it
   produced a page that loaded, rendered its static markup, and filled
   in none of the slots — no download buttons, no pricing, no worker
   release, no recovery forwarding. It looked fine. */
fs.copyFileSync(path.join("public", "site", "site.js"), path.join(OUT, "site", "site.js"));

/* THE SCREENSHOTS, READ FROM THE FOLDER rather than listed — the same
   reason the modules above are. The page references them as bare
   filenames, so they land beside index.html at the root; a list here
   would drift the moment somebody added a shot, and the link check
   below would fail naming a file that is sitting in public/site/ the
   whole time. */
const shots = fs.readdirSync(path.join("public", "site")).filter((f) => f.endsWith(".png"));
for (const f of shots) fs.copyFileSync(path.join("public", "site", f), path.join(OUT, f));

/* Icons and fonts the page and the documents reference. */
for (const f of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
  const from = path.join("public", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, f));
}
if (fs.existsSync("public/fonts")) {
  fs.mkdirSync(path.join(OUT, "fonts"), { recursive: true });
  for (const f of fs.readdirSync("public/fonts")) {
    fs.copyFileSync(path.join("public/fonts", f), path.join(OUT, "fonts", f));
  }
}

/* THE PUBLISHED DOCUMENTS, DERIVED FROM legalLinks.js rather than
   listed. Every `*_URL` under SITE_URL is a document the ROOT must
   serve — those four URLs are in two app-store listings and a Stripe
   dashboard field, and they do not move when the app does. A fifth is
   copied the moment its constant exists, rather than 404ing at a URL
   somebody has already been given. */
const DOC_PATHS = DOCUMENT_PATHS;
if (DOC_PATHS.length === 0) throw new Error("DOCUMENT_PATHS is empty — the site would serve no legal pages");
for (const p of DOC_PATHS) {
  const file = `${p.replace(/^\//, "")}.html`;
  const from = path.join("public", file);
  if (!fs.existsSync(from)) throw new Error(`${SITE_URL}${p} has a URL constant but no public/${file} to serve`);
  fs.copyFileSync(from, path.join(OUT, file));
}

/* ---------- the guides ----------

   Static pages that answer a question somebody typed into a search
   engine, with a link into the app. No script in them at all, which is
   asserted rather than intended: a guide is the one kind of page on
   this origin with no reason to run anything, so anything it ran would
   be a third-party tag or an analytics snippet arriving where nobody
   was looking for it.

   COPIED FROM THE FOLDER, NOT LISTED. A third guide comes along by
   existing, which is the same rule as the site's data modules above and
   the documents below — and the opposite of the deploy workflow that
   named one Edge Function while the repo had two.

   THEY ARE NOT LEGAL DOCUMENTS and deliberately do not go through
   DOCUMENT_PATHS. That list is derived from the `*_URL` constants, and
   every one of those URLs is in a store listing or a Stripe dashboard
   field and is swept by test-legal for claims about a student's data. A
   marketing page in there would be held to promises it does not make
   and would be demanded by documents that should not mention it. */
const GUIDE_DIR = "guides";
/* THEY LIVE UNDER public/site/, WITH THE MARKETING PAGE, and that is
   load-bearing rather than tidy. `build-web` copies all of `public/`
   into `dist-web`, and `prepare-native` refuses any top-level entry of
   dist-web that is not declared shipped or excluded — the gate that
   exists because the marketing page once shipped inside a store
   bundle. `site` is already excluded, with the reason "prices and
   external download links do not belong in a store bundle", which is
   exactly what a guide is. So site-only content belongs under it and
   inherits that decision instead of needing a new one. */
const guideSrc = path.join("public", "site", GUIDE_DIR);
if (!fs.existsSync(guideSrc)) throw new Error(`public/${GUIDE_DIR}/ is missing — the guides would 404 at URLs that are indexed`);
const guides = fs.readdirSync(guideSrc).filter((f) => f.endsWith(".html"));
if (guides.length === 0) throw new Error(`public/${GUIDE_DIR}/ has no pages — an empty guides directory ships a folder nothing serves`);
fs.mkdirSync(path.join(OUT, GUIDE_DIR), { recursive: true });
/* Each guide's own canonical, collected as they are written. See the
   sitemap block below for why it is READ rather than rebuilt. */
const guideUrls = [];
for (const f of fs.readdirSync(guideSrc)) {
  const from = path.join(guideSrc, f);
  if (!f.endsWith(".html")) {
    fs.copyFileSync(from, path.join(OUT, GUIDE_DIR, f));
    continue;
  }
  /* THE SAME SUBSTITUTION THE MARKETING PAGE GETS, and absolute for the
     same reason: this origin answers on two hostnames, those are two
     origins, and a relative app link would strand an apex visitor's
     planner on an origin nobody else ever uses. */
  let page = fs.readFileSync(from, "utf8");
  page = page.split("__APP_URL__").join(`${SITE_URL}${APP_PATH}`);
  if (page.includes("__APP_")) throw new Error(`public/${GUIDE_DIR}/${f} still carries an unfilled app-link placeholder`);
  /* AND IT MUST CARRY THE LINK AT ALL. A guide with no route into the
     app is an article we wrote for nothing — and the placeholder is the
     only thing that would have said so, silently, by being absent. */
  if (!page.includes(`${SITE_URL}${APP_PATH}`)) {
    throw new Error(`public/${GUIDE_DIR}/${f} has no link into the app — a guide with no call to action is an article written for nobody`);
  }
  /* THE CANONICAL IS THE PAGE'S OWN STATEMENT OF ITS URL, and the
     sitemap takes it from here rather than rebuilding it from the
     filename. Cloudflare Pages 301s `/x.html` to `/x`, so the served
     URL is extensionless while the file is not — rebuilding the path
     means encoding that redirect in a second place and getting to
     disagree with the page about which URL is canonical. A sitemap and
     a canonical that name different URLs for one page is the one
     mistake a sitemap can make that is worse than having none. */
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(page);
  if (!canonical) {
    throw new Error(`public/site/${GUIDE_DIR}/${f} has no canonical link — the sitemap would have to guess its URL`);
  }
  if (!canonical[1].startsWith(`${SITE_URL}/`)) {
    throw new Error(`public/site/${GUIDE_DIR}/${f} declares a canonical outside ${SITE_URL}: ${canonical[1]}`);
  }
  guideUrls.push(canonical[1]);
  fs.writeFileSync(path.join(OUT, GUIDE_DIR, f), page);
}

/* ---------- the sitemap, and the robots line that points at it ----------

   WHY THIS EXISTS AT ALL: nothing on the marketing page links to a
   guide. That link is Grace's call and is not made here, so without a
   sitemap the two pages are reachable only by knowing the URL — which
   is the same as not being published. `test-guides.mjs` already says
   in its header that nothing in `npm test` can answer whether a search
   engine found a page; this is the one thing we can do about it that
   is not a design change to somebody else's page.

   DERIVED FROM WHAT WAS BUILT. A third guide appears in the sitemap by
   existing, exactly as it appears in the build by existing. A typed
   list here would be the restatement pattern in the one file whose
   whole job is to be a list.

   WHAT IS IN IT: the marketing page and the guides — the pages we want
   found. Deliberately NOT the app: `/app/` is a JavaScript shell whose
   indexed form is a blank mount, and offering it to a crawler as
   content competes with the page written to be the answer. Also not
   the legal documents: they are reachable and indexable either way
   (nothing here blocks anything), but a sitemap says "these are the
   pages I want ranked", and ranking a privacy policy is not a goal.

   NO `lastmod`, DELIBERATELY. The honest value would be when the
   CONTENT changed, and the only value available here is when the BUILD
   ran — which moves on every deploy whether or not a word changed. A
   lastmod that always says "today" is not a weaker signal than none,
   it is a false one, and crawlers discount a feed that cries wolf. */
const xmlEscape = (u) =>
  u.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sitemapUrls = [`${SITE_URL}/`, ...guideUrls];
if (sitemapUrls.length < 2) throw new Error("the sitemap would list only the home page — no guide contributed a URL");
fs.writeFileSync(
  path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    sitemapUrls.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>\n`).join("") +
    `</urlset>\n`
);
/* ONE `Sitemap:` LINE AND NOTHING ELSE. An absent robots.txt already
   means "crawl everything", so `User-agent: * / Allow: /` restates the
   default and exists only to make the file well-formed for the crawlers
   that expect a group. NO `Disallow` is written: blocking `/app/` from
   indexing is a real decision with a real effect, nobody asked for it,
   and the correct mechanism for it would be a noindex meta in the app
   shell rather than a line here. Recorded in the pull request instead
   of taken quietly. */
fs.writeFileSync(
  path.join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
);

/* ---------- the app, verbatim, one level down ---------- */
fs.cpSync(APP_BUILD, path.join(OUT, APP_DIR), { recursive: true });

/* TWO FILES THAT MEAN NOTHING WHERE THEY LAND, removed rather than
   left. Cloudflare Pages reads `_headers` and `_redirects` from the
   OUTPUT ROOT only, so copies under `/app/` are configuration-shaped
   files that configure nothing — which is worse than absent, because
   the next person to change a header will find two and edit the one
   that does not work. The root pair below is the live one. */
for (const inert of ["_headers", "_redirects"]) {
  fs.rmSync(path.join(OUT, APP_DIR, inert), { force: true });
}

/* ---------- the marketing page ---------- */
let html = fs.readFileSync(SRC_PAGE, "utf8");
/* `./site.js` -> `./site/site.js`: the page sits at the root here and
   its modules are one level down. */
html = html.replace(/(src|href)="\.\/([\w.-]+\.js)"/g, `$1="./site/$2"`);
/* The app's URL, substituted rather than typed into the markup, from
   the same constant everything else derives from — and ABSOLUTE, for
   the reason set out at length in public/site/site.js: this page is
   served on two hostnames, those are two origins, and a relative app
   link would strand an apex visitor's planner on an origin nobody else
   ever uses. */
html = html.split("__APP_URL__").join(`${SITE_URL}${APP_PATH}`);
if (html.includes("__APP_")) throw new Error("the marketing page still carries an unfilled app-link placeholder");
fs.writeFileSync(path.join(OUT, "index.html"), html);

/* ---------- the worker at the root, which removes itself ----------

   THIS PATH USED TO BE LEFT EMPTY ON PURPOSE, and the reasoning was
   wrong in the way this repository keeps finding: it depended on a
   behaviour nobody had measured. A 404 on a worker script really does
   unregister it — but production served neither a 404 nor the script.
   At the Pages origin `/sw.js` answered 200 WITH THE MARKETING PAGE'S
   HTML (an unmatched path falls back to index.html), and at the www
   edge the zone cache was still handing out the OLD worker under a
   four-hour max-age. Both outcomes leave the stale root worker
   installed and controlling `/`.

   AN ABSENCE CANNOT BE VERIFIED FROM HERE. A FILE CAN. So the root now
   serves a real script whose whole content is its own removal, and the
   fallback stops being part of the answer — a request only reaches a
   fallback when no asset matches it, and one does now.

   It is NOT the app's worker and does not cache anything; see
   public/site/root-sw.js for why it must never touch `caches`. */
const ROOT_WORKER_SRC = path.join("public", "site", "root-sw.js");
if (!fs.existsSync(ROOT_WORKER_SRC)) {
  throw new Error(`${ROOT_WORKER_SRC} is missing — the root would fall back to HTML at /sw.js and the stale worker would stay installed`);
}
fs.copyFileSync(ROOT_WORKER_SRC, path.join(OUT, WORKER_SCRIPT));
const rootWorker = fs.readFileSync(path.join(OUT, WORKER_SCRIPT), "utf8");
/* COMMENTS STRIPPED BEFORE MATCHING, which is not fastidiousness: the
   stub's header explains what it must call and what it must never
   touch, so every check below matches its own documentation and passes
   over a file that does none of it. Commenting the unregister OUT left
   this green until the strip was added. */
const rootWorkerCode = rootWorker.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/* The two things that make it a REMOVAL rather than a worker. */
for (const required of ["skipWaiting", "registration.unregister()"]) {
  if (!rootWorkerCode.includes(required)) throw new Error(`the root worker does not call ${required} — it would install and then simply sit there`);
}
if (/addEventListener\(\s*["']fetch["']/.test(rootWorkerCode)) {
  throw new Error("the root worker has a fetch handler — it must be transparent, not a second cache over the marketing page");
}
/* AND THE ONE IT MUST NEVER NAME. Cache Storage is scoped to the
   ORIGIN, not to the worker, so deleting `uni-planner-*` from here
   takes the LIVE app's cache at /app/ with it — they share the prefix
   because they are the same product. A running test cannot catch this
   on its own: the stub's own try/catch swallows the throw, and in
   production the call would SUCCEED. */
if (/\bcaches\b/.test(rootWorkerCode)) {
  throw new Error("the root worker touches `caches` — Cache Storage is per ORIGIN, so this deletes the live app's cache at /app/ too");
}
if (!fs.existsSync(path.join(OUT, APP_DIR, "sw.js"))) throw new Error(`${APP_DIR}/sw.js is missing — the app would register nothing`);

/* ---------- one policy for one origin ---------- */

/* THE APP'S HEADERS ARE THE ORIGIN'S HEADERS, and this is a real
   consequence of the path split rather than a copy for convenience.
   One origin can have one Content-Security-Policy that means anything:
   two `_headers` rules both matching a path produce TWO CSP headers,
   and a browser enforces the INTERSECTION — so a second, tighter
   policy written for the marketing pages would silently narrow the
   app's, and the file would look correct while the planner stopped
   reaching Supabase.
   `public/_headers` is the app's, it is the permissive side of that
   intersection, and it is what ships. The marketing page needs
   nothing it does not already allow. */
fs.copyFileSync("public/_headers", path.join(OUT, "_headers"));

/* ---------- the app's old root URLs ---------- */

/* DERIVED, AND NARROW ON PURPOSE. Before the split the app WAS the
   root, so its assets sat at `/app.js`, `/sw.js` and so on. Those
   paths now hold nothing.

   WHAT DOES NOT TRANSFER FROM THE SUBDOMAIN BRANCH: a catch-all. There
   the rule was "everything that is not the site moved to another
   host", which needs a Pages middleware, because expressing the
   exceptions in `_redirects` would need 200-rewrites that Cloudflare
   Pages does not support. Here the app did not move HOST, only depth,
   and a catch-all would be actively wrong — `/nonsense` is not an app
   URL and sending it to `/app/nonsense` turns a 404 into a planner
   that cannot route it.

   So these are exact sources, derived from the files the app build
   really produces at its root, MINUS every path the site root serves
   itself. That subtraction is what makes `_redirects` safe here where
   it was not safe there: every source below is a path with NO FILE, so
   the question of whether static assets take precedence over redirects
   cannot arise. Nothing depends on a precedence this container cannot
   verify. */
const rootServes = new Set(fs.readdirSync(OUT, { withFileTypes: true }).map((e) => e.name));

/* `sw.js` IS EXCLUDED BY NAME, twice over and for a reason that
   survives the file now existing there.

   The derivation already skips it, because the root serves a real
   file at that path and `rootServes` is read from the output. The
   explicit exclusion stays because a redirect there would be a
   CORRECTNESS bug rather than a redundant line: A SERVICE WORKER
   SCRIPT REQUEST MAY NOT BE REDIRECTED. The Update algorithm fails
   outright on one, so a 301 is refused and the stale worker stays
   installed, controlling `/`, which is now the marketing page. If
   somebody later deletes the root stub, this line is what stops the
   derivation quietly replacing it with the one answer that cannot
   work.

   `site.js`'s `releaseTheOldWorker()` is still the other half, and
   the two cover different people: it runs on the first visit to `/`
   and does not wait for an update check, while the stub reaches
   browsers that never load the marketing page at all — an installed
   shortcut opening straight into a cached shell, most of all. */
const moved = fs
  .readdirSync(path.join(OUT, APP_DIR), { withFileTypes: true })
  .filter((e) => e.isFile() && !rootServes.has(e.name) && e.name !== WORKER_SCRIPT)
  .map((e) => e.name)
  .sort();
if (!fs.existsSync(path.join(OUT, WORKER_SCRIPT))) {
  throw new Error("the root serves no sw.js — an unmatched path falls back to HTML and the stale worker stays installed");
}
if (moved.length === 0) throw new Error("no app asset moved path — the redirect list would be empty and this check would pass over nothing");
fs.writeFileSync(
  path.join(OUT, "_redirects"),
  [
    "# GENERATED by scripts/build-site.mjs — do not edit.",
    "#",
    "# The app's assets used to sit at the origin root. Each source",
    "# below is a path that now holds NO FILE, so this list can never",
    "# shadow something the site serves.",
    ...moved.map((f) => `/${f}  ${APP_PATH}/${f}  301`),
    "",
  ].join("\n")
);

/* ---------- every link must resolve ---------- */

/* Checked against the OUTPUT rather than assumed. The first version of
   this script rewrote `./site.js` to `./site/site.js` and then never
   copied site.js, so the page shipped with a dead script tag — static
   markup intact, every slot empty, and nothing about it looked broken
   until you read it. A rewrite that points somewhere is not the same
   claim as a rewrite that points at a file. */
const servedBy = (p) => {
  const clean = p.split("#")[0].split("?")[0].replace(/^\//, "");
  if (!clean) return true; // "/" is index.html
  const full = path.join(OUT, clean);
  /* Extensionless counts: Cloudflare Pages serves privacy.html at
     /privacy, and THAT is the canonical URL — the one in two store
     listings. A directory counts too, which is how `/app/` resolves. */
  if (fs.existsSync(full)) return true;
  return fs.existsSync(`${full}.html`);
};
for (const page of ["index.html", ...DOC_PATHS.map((p) => `${p.replace(/^\//, "")}.html`)]) {
  const refs = [...fs.readFileSync(path.join(OUT, page), "utf8").matchAll(/(?:src|href)="([^"]+)"/g)].map((r) => r[1]);
  if (refs.length === 0) throw new Error(`${page} references nothing — the markup did not survive`);
  const missing = refs.filter((r) => !/^(https?:|mailto:|#|data:)/.test(r)).filter((r) => !servedBy(r));
  if (missing.length) throw new Error(`${page} links to files that are not in ${OUT}: ${missing.join(", ")}`);
}

console.log(
  `site build OK -> ${OUT}/ (${modules.length} modules, ${DOC_PATHS.length} documents, ${guides.length} guides, sitemap ${sitemapUrls.length} urls, app at ${APP_PATH}/, ${moved.length} moved paths)`
);
