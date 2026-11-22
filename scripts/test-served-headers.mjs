/* The site served the way Cloudflare Pages serves it, and the claims
   made on what the BROWSER RECEIVES rather than on the text of
   _headers.

   THE SERVER. dist-site/, with every rule in its _headers applied to
   each response the rule's path matches: splats, rules combining, a
   header set twice joined with a comma, `! Name` detaching. The headers
   a request gets are derived from the shipped file, never restated
   here. Two things are MODELLED rather than observed, and are the live
   curls in DEPLOY-CHECKLIST §7a: Pages' own defaults (an ETag and
   `public, max-age=0, must-revalidate`, which a rule of the same name
   replaces), and anything the zone does on top of Pages.

   1. A PHOTOGRAPHED PAGE SHOWS A THUMBNAIL UNDER THE PRODUCTION POLICY.
      downscalePhoto decodes the picked file from a blob URL, and an
      img-src without `blob:` refuses it — so every photo was skipped
      without a word, on the website only: the shells send no policy.
      The CONTROL is the same walk under the same policy with `blob:`
      taken out of img-src: it must show no thumbnail AND the browser
      must report img-src refusing a blob URL. That is what proves this
      harness enforces the policy at all, and that `blob:` is what the
      thumbnail needs, rather than something else about the walk.

   2. THE FILES AN UPDATE DEPENDS ON ARE REVALIDATED ON EVERY LOAD. The
      scripts and stylesheets the built /app/index.html loads, and the
      worker it registers, are read out of that file, so a renamed
      bundle is followed rather than missed. Each must reach the browser
      with no-cache. The control is an icon on the same page, which
      keeps the default: a server stamping no-cache on everything would
      pass the first half alone.

      The essay panel's marking-criteria photo goes through the same
      decode, so it is walked too: there the photo has to reach the
      request rather than a thumbnail.

   At 390px, signed in with the network to Supabase faked, the way the
   other browser suites do it. Skips without a browser; REQUIRE_BROWSER=1
   makes that a failure. */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsentPatch } from "../src/aiNotesLogic.js";
import { ESSAY_COPY } from "../src/essayCopy.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(rootDir, "dist-site");
const PHONE = { width: 390, height: 844 };

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") await out;
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}\n        ${err.message}`);
  }
}

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

/* ---- _headers, read the way Pages reads it ---- */

function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), set: [], detach: [] };
      rules.push(current);
      continue;
    }
    assert.ok(current, `a header line before any path in _headers: "${raw}"`);
    const line = raw.trim();
    if (line.startsWith("!")) {
      current.detach.push(line.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `not a header line in _headers: "${raw}"`);
    current.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

function matcher(pattern) {
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/:[A-Za-z]\w*/g, "[^/]+");
  return new RegExp(`^${body}$`);
}

/* lower-case name -> [Name, value], in the order rules apply. */
function headersFor(pathname, rules) {
  const out = new Map();
  for (const rule of rules) {
    if (!matcher(rule.pattern).test(pathname)) continue;
    for (const name of rule.detach) out.delete(name);
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      out.set(key, out.has(key) ? [name, `${out.get(key)[1]}, ${value}`] : [name, value]);
    }
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/* `rewrite` lets the control change ONE header on the way out. */
async function servePages(root, { rewrite = (name, value) => value } = {}) {
  const rules = parseHeaders(fs.readFileSync(path.join(root, "_headers"), "utf8"));
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    let file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!pathname.endsWith("/")) return res.writeHead(308, { location: `${pathname}/` }).end();
      file = path.join(file, "index.html");
    } else if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) {
      file = `${file}.html`;
    }
    if (!fs.existsSync(file)) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    const body = fs.readFileSync(file);
    const etag = `"${crypto.createHash("sha1").update(body).digest("hex")}"`;
    const headers = new Map([
      ["content-type", ["Content-Type", MIME[path.extname(file)] || "application/octet-stream"]],
      ["etag", ["ETag", etag]],
      ["cache-control", ["Cache-Control", "public, max-age=0, must-revalidate"]],
    ]);
    for (const [key, entry] of headersFor(pathname, rules)) headers.set(key, entry);
    const out = {};
    for (const [, [name, value]] of headers) out[name] = rewrite(name.toLowerCase(), value);
    if (req.headers["if-none-match"] === etag) return res.writeHead(304, out).end();
    res.writeHead(200, out).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, rules };
}

/* ---- what the app needs to show its AI tab signed in ---- */

const PLANNER_SRC = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
const TAB_KEY = (() => {
  const m = /const TAB_KEY = "([^"]+)"/.exec(PLANNER_SRC);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx — this cannot open a tab it cannot name");
  return m[1];
})();
const SUPABASE_HOST = (() => {
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8"));
  assert.ok(m, "SUPABASE_URL is gone from config.js — this cannot intercept what it cannot name");
  return m[1];
})();
const PROJECT_REF = new URL(SUPABASE_HOST).hostname.split(".")[0];
const USER_ID = "00000000-0000-4000-8000-000000000001";
const PHOTO = path.join(SITE, "app", "icon-192.png");
const CRITERIA_READ = "1. Argument and evidence (40%)";

async function run() {
  assert.ok(fs.existsSync(path.join(SITE, "app", "index.html")), "dist-site is missing — run npm run build:web && npm run build:site first");

  const rules = parseHeaders(fs.readFileSync(path.join(SITE, "_headers"), "utf8"));
  await test("the headers file is read whole: every rule is a path, and it has more than the catch-all", () => {
    assert.ok(rules.length >= 2, `only ${rules.length} rule(s) were parsed out of _headers`);
    for (const r of rules) assert.ok(r.pattern.startsWith("/"), `${r.pattern}: only path rules are modelled here`);
    assert.ok(rules.some((r) => r.pattern === "/*"), "no catch-all rule, so no page would get the policy");
    const policies = rules.flatMap((r) => r.set.filter(([n]) => n.toLowerCase() === "content-security-policy"));
    assert.equal(policies.length, 1, "this suite reads one policy; two would be enforced as their intersection");
  });

  const browser = await launch();
  if (!browser) {
    const message = "no Chromium — skipping (npx playwright install chromium, or REQUIRE_BROWSER=1 to fail)";
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    console.log(`\n${passed} passed, ${failed} failed (browser checks skipped)`);
    if (failed > 0) process.exit(1);
    return;
  }

  const json = (body) => ({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });

  /* Signed in, consent given by the app's own helper, on the AI tab. */
  async function openAiTab(base) {
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    const sent = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.addInitScript(
      ({ ref, userId, tabKey, consent }) => {
        window.__refused = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          window.__refused.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI || "") })
        );
        localStorage.setItem(
          `sb-${ref}-auth-token`,
          JSON.stringify({
            access_token: "test-token",
            token_type: "bearer",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            expires_in: 3600,
            refresh_token: "test-refresh",
            user: { id: userId, email: "headers-probe@example.test", aud: "authenticated", role: "authenticated" },
          })
        );
        localStorage.setItem("uni-planner-mode", "light");
        localStorage.setItem(tabKey, "ai-notes");
        localStorage.setItem("uni-planner-v1", JSON.stringify({ semester: "Semester 1", semesters: {}, meta: consent }));
      },
      { ref: PROJECT_REF, userId: USER_ID, tabKey: TAB_KEY, consent: buildConsentPatch() }
    );
    await ctx.route(`${SUPABASE_HOST}/**`, async (route) => {
      const url = route.request().url();
      if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: "headers-probe@example.test" }));
      if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "test-token", user: { id: USER_ID } }));
      if (url.includes("/rest/v1/profiles")) return route.fulfill(json({ user_id: USER_ID, tier: "ai", trial_credits_used: 0, active_device_id: null, active_device_at: null }));
      if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 12 }));
      if (url.includes("/functions/v1/ai-text")) {
        sent.push(JSON.parse(route.request().postData() || "{}"));
        return route.fulfill(json({ result: { criteria: CRITERIA_READ }, allowanceUsed: 0.01 }));
      }
      return route.fulfill(json([]));
    });
    const doc = await page.goto(`${base}/app/`);
    await page.waitForSelector("#root > *", { timeout: 15_000 });
    return { ctx, page, errors, sent, policy: doc.headers()["content-security-policy"] || "" };
  }

  /* Open the reading summariser and add one photographed page. */
  async function addPhoto(page) {
    const open = page.getByRole("button", { name: "Summarise this" });
    await open.waitFor({ timeout: 10_000 });
    assert.equal(await open.count(), 1, "expected the one reading summariser on the AI tab");
    await open.click();
    const input = page.locator("label", { hasText: "Add photos of the pages" }).locator('input[type="file"]');
    await input.waitFor({ state: "attached", timeout: 5_000 });
    await input.setInputFiles(PHOTO);
    await page.locator('img[alt="Page photo 1"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    const thumbnail = await page.locator('img[alt="Page photo 1"]').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
    return { thumbnail, refused: await page.evaluate(() => window.__refused) };
  }

  /* Turn essay feedback on, then photograph the marking criteria. */
  async function addCriteriaPhoto(page) {
    await page.getByRole("button", { name: ESSAY_COPY.optIn.accept }).click();
    const input = page.locator("[data-criteria-photo-input]");
    await input.waitFor({ state: "attached", timeout: 5_000 });
    await input.setInputFiles(PHOTO);
    await page.locator("[data-criteria-photo-done], [data-criteria-photo-error]").first().waitFor({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    return { box: await page.locator("[data-essay-criteria]").inputValue(), refused: await page.evaluate(() => window.__refused) };
  }

  const imgSrc = (policy) => (/(?:^|;)\s*img-src([^;]*)/.exec(policy) || [])[1] || "";

  /* ---- 1. the photo ---- */
  {
    const { server, base } = await servePages(SITE);
    const { ctx, page, errors, sent, policy } = await openAiTab(base);
    await test("a photographed page shows a thumbnail on the website, under the policy the website sends", async () => {
      assert.ok(policy.includes("default-src"), "the app page arrived with no policy, so this would prove nothing about one");
      const { thumbnail, refused } = await addPhoto(page);
      assert.ok(
        thumbnail,
        `no thumbnail after adding a photo; the policy's img-src is "${imgSrc(policy).trim()}" and the browser refused ${JSON.stringify(refused)}`
      );
      assert.deepEqual(refused, [], "the browser refused something while a photo was added");
      assert.deepEqual(errors, [], errors.join("\n        "));
    });
    await test("a photographed marking guide reaches the request under the same policy, and fills the criteria box", async () => {
      const { box, refused } = await addCriteriaPhoto(page);
      const criteria = sent.filter((b) => b.task === "criteria");
      assert.equal(criteria.length, 1, `expected one criteria request, saw ${criteria.length}; the browser refused ${JSON.stringify(refused)}`);
      assert.ok(Array.isArray(criteria[0].images) && criteria[0].images.length === 1, "the criteria request carried no photo");
      assert.match(criteria[0].images[0], /^data:image\/jpeg;base64,/, "the photo was not sent as the scaled JPEG");
      assert.ok(box.includes(CRITERIA_READ), `the criteria box holds "${box}"`);
      assert.deepEqual(refused, [], "the browser refused something while the criteria photo was added");
      assert.deepEqual(errors, [], errors.join("\n        "));
    });
    await ctx.close();
    server.close();
  }

  /* ---- the control: the same policy with blob: taken out of img-src ---- */
  {
    const { server, base } = await servePages(SITE, {
      rewrite: (name, value) =>
        name === "content-security-policy"
          ? value.replace(/(img-src[^;]*)/, (d) => d.replace(/\s+blob:/g, ""))
          : value,
    });
    const { ctx, page, sent, policy } = await openAiTab(base);
    await test("the control: with blob: taken out of img-src there is no thumbnail, and the browser says img-src refused a blob", async () => {
      assert.ok(policy.includes("default-src") && !/\bblob:/.test(imgSrc(policy)), `the control's img-src still allows blob: — "${imgSrc(policy)}"`);
      const { thumbnail, refused } = await addPhoto(page);
      assert.equal(thumbnail, false, "a thumbnail appeared under a policy that refuses blob: images, so this harness is not enforcing the policy");
      assert.ok(
        refused.some((r) => r.directive === "img-src" && r.blocked.startsWith("blob")),
        `the browser reported no img-src refusal of a blob, only ${JSON.stringify(refused)}`
      );
    });
    await test("the control: and the marking-guide photo never leaves the page", async () => {
      const { refused } = await addCriteriaPhoto(page);
      assert.deepEqual(sent.filter((b) => b.task === "criteria"), [], "a criteria request was sent under a policy that refuses blob: images");
      assert.ok(refused.filter((r) => r.directive === "img-src" && r.blocked.startsWith("blob")).length >= 2, `expected a second img-src refusal, saw ${JSON.stringify(refused)}`);
    });
    await ctx.close();
    server.close();
  }

  /* ---- 2. what an update depends on ---- */
  {
    const { server, base } = await servePages(SITE);
    const appHtml = fs.readFileSync(path.join(SITE, "app", "index.html"), "utf8");
    const at = (ref) => new URL(ref, `${base}/app/`).href;
    const loaded = [
      ...[...appHtml.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]),
      ...[...appHtml.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]),
    ]
      .filter((ref) => !/^[a-z]+:/i.test(ref))
      .map(at);
    const worker = [...appHtml.matchAll(/serviceWorker\.register\(\s*"([^"]+)"/g)].map((m) => at(m[1]));

    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const responses = new Map();
    page.on("response", (r) => responses.set(r.url(), r));
    await page.goto(`${base}/app/`);
    await page.waitForSelector("#root > *", { timeout: 15_000 });

    await test("the app page's own scripts, stylesheet and worker reach the browser with no-cache", async () => {
      assert.ok(loaded.length >= 2, `found only ${loaded.length} script/stylesheet references in the built app page`);
      assert.equal(worker.length, 1, `expected the one worker registration in the built app page, found ${worker.length}`);
      for (const url of loaded) {
        const r = responses.get(url);
        assert.ok(r, `the page never requested ${url}`);
        assert.equal(r.headers()["cache-control"], "no-cache", `${new URL(url).pathname} arrived with cache-control "${r.headers()["cache-control"]}"`);
        const policies = (await r.headersArray()).filter((h) => h.name.toLowerCase() === "content-security-policy");
        assert.equal(policies.length, 1, `${new URL(url).pathname} arrived with ${policies.length} policies; a rule meant to add Cache-Control added more`);
      }
      const workerCache = await page.evaluate((u) => fetch(u).then((r) => r.headers.get("cache-control")), worker[0]);
      assert.equal(workerCache, "no-cache", `${new URL(worker[0]).pathname} arrived with cache-control "${workerCache}"`);
    });

    await test("the control: an icon on the same page keeps the default, so the rule is scoped and the check discriminates", async () => {
      const icon = await page.evaluate((u) => fetch(u).then((r) => r.headers.get("cache-control")), `${base}/app/icon-192.png`);
      assert.equal(icon, "public, max-age=0, must-revalidate", `/app/icon-192.png arrived with "${icon}"`);
    });

    await ctx.close();
    server.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
