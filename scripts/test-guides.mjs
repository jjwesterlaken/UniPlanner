/* The guides — static pages answering a question somebody typed into a
 * search engine, with a link into the app.
 *
 * THE CLAIM THAT MATTERS IS NOT "THE PAGE EXISTS". It is that **every
 * figure on them is the one the app would give**. A guide that teaches
 * the arithmetic and then gets it wrong is worse than no guide: it is
 * wrong in public, at a URL a search engine hands to somebody deciding
 * what to revise, and it undermines the only thing the page is for.
 *
 * So the exam-mark table is re-derived by running the real
 * `requiredForBand` over the real bands, and the WAM table is checked
 * against its own arithmetic — every product, the totals, the stated
 * average, and the plain average it is compared with. That is the same
 * rule as the help text's worked example, which re-derives its figures
 * from grades.js for exactly this reason.
 *
 * AND IT READS THE BUILT PAGES, not the sources, wherever the claim is
 * about what a visitor receives: the app link is substituted at build
 * time, so a source check would pass over a page shipping a literal
 * `__APP_URL__` in an href.
 *
 * WHAT THIS CANNOT SEE, said here rather than implied by a pass:
 * whether anything ever indexes them. There is no sitemap and no
 * internal link from the marketing page — that page is built to Grace's
 * approved mockup and adding a link to it is her call, so it is flagged
 * in the pull request rather than done here. Nothing in `npm test` can
 * answer whether a search engine found a page either way.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-site");
const GUIDES = path.join(OUT, "guides");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  - ${name}\n        ${err.message}`);
  }
}

const load = (p) => import(pathToFileURL(path.join(rootDir, p)).href);
const grades = await load("src/grades.js");
const links = await load("src/legalLinks.js");

if (!fs.existsSync(GUIDES)) {
  console.error("dist-site/guides is missing — run `npm run build:web && npm run build:site` first");
  process.exit(1);
}

/* DERIVED FROM THE BUILD OUTPUT, so a third guide is covered by
   existing. The list is asserted non-empty below, because every sweep
   in this file is a `for` over it and an empty one would satisfy all of
   them. */
const pages = fs
  .readdirSync(GUIDES)
  .filter((f) => f.endsWith(".html"))
  .sort();
const html = (f) => fs.readFileSync(path.join(GUIDES, f), "utf8");

/** Tags stripped, entities that matter decoded, whitespace collapsed. */
const prose = (s) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Every table on a page, as arrays of cell text. */
function tables(src) {
  return [...src.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((t) =>
    [...t[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => prose(c[1])))
  );
}

/** The table whose header row contains `needle`. */
function tableWith(src, needle) {
  const found = tables(src).filter((rows) => rows[0] && rows[0].some((c) => c.includes(needle)));
  assert.equal(found.length, 1, `expected exactly one table headed "${needle}", found ${found.length}`);
  return found[0];
}

const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ""));

async function run() {
  await test("THE GUIDES ARE BUILT, and there is more than one of them", () => {
    /* THE NON-VACUITY ASSERTION FOR EVERY SWEEP BELOW. An empty
       directory satisfies every universal claim made about its
       contents, and the build's own summary line would still read
       "site build OK". */
    assert.ok(pages.length >= 2, `only ${pages.length} guides in the build output`);
    assert.ok(pages.includes("what-mark-do-i-need.html"), "the exam-mark guide is not in the build");
    assert.ok(pages.includes("what-is-a-wam.html"), "the WAM guide is not in the build");
    assert.ok(fs.existsSync(path.join(GUIDES, "guide.css")), "the shared stylesheet was not copied, so every guide is unstyled");
  });

  await test("EVERY EXAM-MARK FIGURE IS RE-DERIVED from grades.js, not typed", () => {
    /* THE REASON THIS FILE EXISTS. The page teaches the arithmetic and
       then shows it, at a URL a search engine hands to somebody
       deciding what to revise. A typo there is wrong in public and
       undermines the only thing the page is for.

       The example is the app's own — the one helpText.js uses, for the
       same reason it uses it: 30/20/50 with 75 and 60 banked is the
       shape almost every Australian unit outline takes. */
    const course = [
      { id: "1", title: "Essay", w: 30, mark: 75 },
      { id: "2", title: "Quiz", w: 20, mark: 60 },
      { id: "3", title: "Exam", w: 50 },
    ];
    const src = html("what-mark-do-i-need.html");

    /* The table's own inputs must match the course this test derives
       from, or the derived answers are about a different example. */
    const banked = tableWith(src, "Weight");
    const rows = banked.slice(1, 4);
    assert.deepEqual(
      rows.map((r) => [num(r[1]), r[2] === "—" ? null : num(r[2])]),
      course.map((a) => [a.w, a.mark === undefined ? null : a.mark]),
      "the page's assessment table is not the course this test derives from"
    );
    /* And each banked figure is the product, so a slip in the middle
       column cannot pass because the total happens to be right. */
    for (const r of rows.filter((r) => r[3] !== "—")) {
      assert.equal(num(r[3]), (num(r[1]) * num(r[2])) / 100, `banked column is wrong for "${r[0]}"`);
    }
    const s = grades.summarise(course);
    assert.equal(num(banked[4][3]), s.earned, `the page says ${banked[4][3]} banked, grades.js says ${s.earned}`);
    assert.equal(num(banked[4][1]), 100 - s.remainingWeight, "the page's 'weight sat so far' does not match the course");

    /* THE BANDS, BY LABEL, so a reordered table cannot pass by
       accident, and every band in GRADE_BANDS must appear — a page
       quietly missing HD would otherwise be fine by every other
       assertion here. */
    const needs = tableWith(src, "So the exam needs");
    const byLabel = new Map(needs.slice(1).map((r) => [r[0], r]));
    for (const band of grades.GRADE_BANDS) {
      const row = byLabel.get(band.label);
      assert.ok(row, `the page's band table has no row for ${band.label}`);
      assert.equal(num(row[1]), band.min, `${band.label}: the page says a final mark of ${row[1]}, grades.js says ${band.min}`);
      const derived = grades.requiredForBand(course, band.min, grades.DEFAULT_ROUNDING);
      assert.equal(num(row[2]), derived.required, `${band.label}: the page says the exam needs ${row[2]}, grades.js says ${derived.required}`);
    }
    assert.equal(byLabel.size, grades.GRADE_BANDS.length, "the band table has rows grades.js does not know about");
  });

  await test("THE ROUNDING TABLE IS DERIVED UNDER BOTH RULES, including the impossible one", () => {
    /* The half-mark gap is the clearest available explanation of why
       the rounding setting exists, which is why the page shows both
       columns — and at the top it decides whether the grade is
       REACHABLE, which is the part a reader would otherwise not
       believe. `requiredForBand` reports that as `impossible`, so the
       page's word for it is checked against the status rather than
       against a number it does not have. */
    const course = [
      { id: "1", title: "Essay", w: 30, mark: 75 },
      { id: "2", title: "Quiz", w: 20, mark: 60 },
      { id: "3", title: "Exam", w: 50 },
    ];
    const src = html("what-mark-do-i-need.html");
    const table = tableWith(src, "Rounded down");
    const byLabel = new Map(table.slice(1).map((r) => [r[0], r]));
    assert.ok(byLabel.size >= 3, `only ${byLabel.size} rows in the rounding table`);

    let sawImpossible = false;
    let sawDifference = false;
    for (const [label, row] of byLabel) {
      const band = grades.GRADE_BANDS.find((b) => b.label === label);
      assert.ok(band, `the rounding table has a row for "${label}", which is not a band`);
      const nearest = grades.requiredForBand(course, band.min, "half-up");
      const down = grades.requiredForBand(course, band.min, "truncate");
      assert.equal(num(row[1]), nearest.required, `${label}: rounded-to-nearest column`);
      if (down.status === "impossible") {
        sawImpossible = true;
        assert.match(row[2], /impossible/i, `${label} is unreachable when rounded down, and the page prints a number instead`);
      } else {
        assert.equal(num(row[2]), down.required, `${label}: rounded-down column`);
      }
      if (nearest.required !== down.required) sawDifference = true;
    }
    /* Both halves must be exercised, or a table of identical columns
       would satisfy the loop and the page's whole point would be
       unchecked. */
    assert.ok(sawDifference, "no row differs between the two rounding rules, so the table demonstrates nothing");
    assert.ok(sawImpossible, "no row is unreachable when rounded down, so the 'impossible' claim is untested");
  });

  await test("THE WAM EXAMPLE IS ARITHMETICALLY SELF-CONSISTENT, every cell of it", () => {
    /* Nothing in the app computes a WAM, so there is no function to
       derive this from — which makes the page its own source of truth
       and the arithmetic the only thing that can be checked. So all of
       it is: every product, both totals, the stated average, and the
       plain average it is contrasted with. A typo in a number a reader
       would trust is the failure this catches. */
    const src = html("what-is-a-wam.html");
    const table = tableWith(src, "Credit points");
    const rows = table.slice(1, -1);
    assert.ok(rows.length >= 3, `only ${rows.length} unit rows in the WAM example`);

    let cp = 0;
    let weighted = 0;
    const marks = [];
    for (const r of rows) {
      const points = num(r[1]);
      const mark = num(r[2]);
      assert.ok(points > 0 && mark > 0, `a WAM row has no usable figures: ${r.join(" | ")}`);
      assert.equal(num(r[3]), points * mark, `the mark x cp column is wrong for "${r[0]}"`);
      cp += points;
      weighted += points * mark;
      marks.push(mark);
    }

    const total = table[table.length - 1];
    assert.equal(num(total[1]), cp, "the credit-point total does not add up");
    assert.equal(num(total[3]), weighted, "the weighted total does not add up");

    /* THE STATED ANSWER, read out of the sentence under the table
       rather than assumed. A correct table with a wrong conclusion
       under it is the likeliest single mistake on a page like this. */
    const wam = weighted / cp;
    const stated = prose(src).match(new RegExp(`${weighted}\\s*÷\\s*${cp}\\s*=\\s*([0-9.]+)`));
    assert.ok(stated, `the page does not state ${weighted} ÷ ${cp} anywhere, so its own arithmetic is unstated`);
    assert.equal(Number(stated[1]), wam, `the page says the WAM is ${stated[1]}, the table says ${wam}`);

    /* AND THE COMPARISON THAT MAKES THE POINT. The page says the plain
       average is lower; if the example were ever edited so it wasn't,
       the paragraph would contradict its own table. */
    const plain = marks.reduce((a, b) => a + b, 0) / marks.length;
    assert.match(prose(src), new RegExp(`plain average of [^.]*is ${plain}\\b`), `the page's plain average is not ${plain}`);
    assert.ok(wam > plain, "the WAM is not higher than the plain average, so the paragraph explaining the gap is wrong");

    /* The sensitivity figure, which is the other number a reader would
       take away. Ten units at 70 plus one at 85. */
    const sensitivity = (10 * 70 + 85) / 11;
    assert.match(
      prose(src),
      new RegExp(`\\b${sensitivity.toFixed(1)}\\b`),
      `the page's "one more unit" figure is not ${sensitivity.toFixed(1)}`
    );
  });

  await test("THE WAM PAGE DOES NOT CLAIM THE APP CALCULATES ONE", () => {
    /* We do not sell what we do not have, in either direction — Jared's
       rule, and this is the direction that would be a lie rather than a
       missed opportunity. Nothing in the app computes a WAM: the
       formula is the university's and varies between them, which the
       page says. A call to action implying otherwise is a
       bait-and-switch at the exact moment somebody clicks through.

       Asserted as a POSITIVE disclaimer rather than as the absence of a
       phrase, because "no page says it calculates a WAM" is satisfied
       by a page that says nothing at all and lets the reader assume. */
    const text = prose(html("what-is-a-wam.html"));
    assert.match(text, /does not calculate a WAM/i, "the page does not say the app cannot do this, so a reader will assume it can");
    /* And what it DOES offer has to be a thing that exists. */
    assert.match(text, /what you need on/i, "the call to action does not name what the app actually does");
  });

  await test("EVERY GUIDE LINKS INTO THE APP, at the absolute URL the build substituted", () => {
    /* ABSOLUTE, and it matters: this origin answers on two hostnames,
       those are two origins, and `localStorage` is scoped per origin —
       so a relative link followed from the apex would strand that
       visitor's planner on a host nobody else ever uses. The same
       reasoning as the marketing page's, and the reason the whole split
       is a path rather than a subdomain.

       DERIVED from legalLinks.js. A literal here would be the
       restatement pattern in the guard written to check the link. */
    for (const f of pages) {
      const src = html(f);
      assert.ok(src.includes(`href="${links.APP_URL}"`), `${f} has no absolute link to ${links.APP_URL}`);
      assert.ok(!src.includes("__APP_"), `${f} shipped with an unfilled placeholder in it`);
    }
  });

  await test("A GUIDE RUNS NOTHING AND FETCHES NOTHING THIRD-PARTY", () => {
    /* STRICTER THAN THE LEGAL PAGES' RULE, deliberately. A guide is the
       one kind of page on this origin with no reason to run anything at
       all, so a script in one would be an analytics tag or a
       third-party snippet arriving where nobody was looking for it —
       and this origin promises none, the privacy policy says so, and
       test-local-only pins it for the app.

       The fonts are self-hosted for the same reason, which is why the
       stylesheet is checked too: `@import` is the way a third-party
       font sneaks back in without an element to notice. */
    for (const f of [...pages, "guide.css"]) {
      const src = fs.readFileSync(path.join(GUIDES, f), "utf8");
      assert.ok(!/<script/i.test(src), `${f} contains a script`);
      assert.ok(!/\son[a-z]+\s*=/i.test(src), `${f} has an inline event handler, which is a script by another name`);
      assert.ok(!/@import/i.test(src), `${f} pulls in another stylesheet, which is how a third-party font returns`);
      for (const m of src.matchAll(/(?:src|href)="(https?:)?\/\/([^/"]+)/g)) {
        assert.ok(
          m[2].endsWith("uniplannerapp.com"),
          `${f} loads or links ${m[2]} — this origin makes no third-party requests, and every link on a guide is our own`
        );
      }
    }
  });

  await test("EVERY INTERNAL LINK ON A GUIDE RESOLVES TO SOMETHING THE BUILD SERVES", () => {
    /* A cross-link to a page that does not exist is the cheapest
       possible SEO mistake and the least visible: nothing errors, the
       page renders, and a reader (or a crawler) hits a 404. Cloudflare
       Pages serves these extensionless, so both spellings are accepted
       — and the resolution is done against the BUILD OUTPUT rather than
       against `public/`, since that is what a visitor receives. */
    let checked = 0;
    for (const f of pages) {
      for (const m of html(f).matchAll(/href="(\/[^"#?]*)"/g)) {
        const target = m[1];
        if (target === "/") {
          assert.ok(fs.existsSync(path.join(OUT, "index.html")), "a guide links / and the build has no index.html");
          checked += 1;
          continue;
        }
        const rel = target.replace(/^\//, "");
        const found = [rel, `${rel}.html`, path.join(rel, "index.html")].some((c) => fs.existsSync(path.join(OUT, c)));
        assert.ok(found, `${f} links ${target}, which the build does not serve`);
        checked += 1;
      }
    }
    assert.ok(checked >= 6, `only ${checked} internal links were checked, so this sweep is reading the wrong thing`);
  });

  await test("EACH GUIDE CARRIES THE THREE THINGS A SEARCH RESULT IS MADE OF", () => {
    /* A title, a description and a canonical URL. The canonical is the
       one worth asserting rather than assuming: Pages serves these
       extensionless AND with the extension, so both spellings resolve,
       and without a canonical a crawler may index either — which is a
       duplicate of our own page competing with itself.

       The expected canonical is BUILT from SITE_URL and the file's own
       name, so a page renamed without its canonical following goes
       red. */
    for (const f of pages) {
      const src = html(f);
      const slug = f.replace(/\.html$/, "");
      const title = src.match(/<title>([^<]+)<\/title>/);
      assert.ok(title, `${f} has no title`);
      assert.match(title[1], /UniPlanner/, `${f}'s title does not carry the brand`);
      assert.ok(title[1].length <= 65, `${f}'s title is ${title[1].length} characters, which a search result will cut off`);

      const desc = src.match(/<meta name="description" content="([^"]+)"/);
      assert.ok(desc, `${f} has no meta description`);
      assert.ok(desc[1].length >= 70 && desc[1].length <= 200, `${f}'s description is ${desc[1].length} characters`);

      const canonical = src.match(/<link rel="canonical" href="([^"]+)"/);
      assert.ok(canonical, `${f} has no canonical URL, so the extensionless and .html spellings compete`);
      assert.equal(canonical[1], `${links.SITE_URL}/guides/${slug}`, `${f}'s canonical URL is not its own address`);

      const h1 = [...src.matchAll(/<h1>/g)];
      assert.equal(h1.length, 1, `${f} has ${h1.length} h1 elements`);
    }
  });

  await test("THE BUILD REFUSES A GUIDE WITH NO ROUTE INTO THE APP", () => {
    /* The build's own guard, run rather than read. A guide with no call
       to action is an article written for nobody, and the placeholder
       is the only thing that would have said so — silently, by being
       absent. Checked by giving the real build a page without one. */
    const src = fs.readFileSync(path.join(rootDir, "scripts/build-site.mjs"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    assert.match(code, /no link into the app/, "the build no longer refuses a guide with no call to action");
    assert.match(code, /has no pages/, "the build no longer refuses an empty guides directory");
    /* AND IT IS DERIVED FROM THE FOLDER, not a list — so the third
       guide ships by existing, which is the rule that the deploy
       workflow naming one Edge Function while the repo had two exists
       to teach. */
    assert.match(code, /readdirSync\(guideSrc\)/, "the build enumerates the guides by hand");
  });

  /* ================================================================
     THE SITEMAP — the only thing standing between a guide and nobody

     Nothing on the marketing page links to a guide (that link is
     Grace's) and there is no other route in, so the sitemap IS the
     publication. A guide missing from it is a page that exists and is
     not published, which is exactly the state these tests would
     otherwise report as healthy.
     ================================================================ */

  await test("EVERY BUILT GUIDE IS IN THE SITEMAP, and the list is derived from what was built", () => {
    const xml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length > 0, "the sitemap lists no URLs at all, so every check below would pass over nothing");

    /* The claim, in the direction that matters: a page that was built
       and not listed is unreachable. `pages` is read from the build
       output, so a third guide is covered by existing. */
    const missing = pages.filter((f) => {
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html(f))[1];
      return !locs.includes(canonical);
    });
    assert.deepEqual(missing, [], `built but absent from the sitemap: ${missing.join(", ")}`);

    /* And the other direction: a URL in the sitemap that no page
       claims is a 404 offered to a crawler. */
    const canonicals = pages.map((f) => /<link rel="canonical" href="([^"]+)"/.exec(html(f))[1]);
    const stray = locs.filter((u) => u !== `${links.SITE_URL}/` && !canonicals.includes(u));
    assert.deepEqual(stray, [], `listed in the sitemap but no page declares it: ${stray.join(", ")}`);
  });

  await test("THE SITEMAP AND THE CANONICAL NEVER NAME DIFFERENT URLS FOR ONE PAGE", () => {
    /* The one mistake a sitemap can make that is worse than not
       existing. Pages 301s `/x.html` to `/x`, so the served URL is
       extensionless while the file is not — and the sitemap READS the
       canonical rather than rebuilding the path from the filename,
       which is what makes the two incapable of disagreeing. This
       asserts the property that arrangement buys. */
    const xml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
    for (const f of pages) {
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html(f))[1];
      assert.ok(xml.includes(`<loc>${canonical}</loc>`), `${f} declares ${canonical}, which the sitemap does not list`);
      assert.ok(!canonical.endsWith(".html"), `${f}'s canonical keeps the .html Pages redirects away from: ${canonical}`);
    }
  });

  await test("EVERY SITEMAP URL RESOLVES TO SOMETHING THE BUILD SERVES", () => {
    /* A sitemap is a list of promises about what is at the other end.
       Checked against dist-site rather than against the sources,
       because the built tree is what Pages uploads — and the
       extensionless form has to be mapped back to the file that
       answers it, which is the redirect this project already relies on
       for the legal documents. */
    const xml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length > 0, "no URLs to resolve");
    for (const u of locs) {
      assert.ok(u.startsWith(`${links.SITE_URL}/`), `${u} is not on this origin`);
      const rel = u.slice(links.SITE_URL.length + 1);
      const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
      const hit = candidates.find((c) => fs.existsSync(path.join(OUT, c)));
      assert.ok(hit, `${u} is in the sitemap and nothing in dist-site answers it (tried ${candidates.join(", ")})`);
    }
  });

  await test("THE APP IS NOT IN THE SITEMAP, and that is a decision rather than an oversight", () => {
    /* `/app/` is a JavaScript shell whose indexed form is a blank
       mount, and offering it to a crawler as content competes with the
       page written to be the answer. Asserted so that "add every URL"
       is a change somebody has to make on purpose. */
    const xml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
    assert.ok(!xml.includes(links.APP_URL), `the app (${links.APP_URL}) is offered to crawlers as content`);
  });

  await test("NO lastmod, because the only date available would be a false one", () => {
    /* The honest value is when the CONTENT changed; the only value
       this build has is when the BUILD ran, which moves on every
       deploy whether or not a word changed. A lastmod that always says
       today is not a weaker signal than none, it is a false one. */
    const xml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
    assert.ok(!/lastmod/i.test(xml), "the sitemap carries a lastmod, which can only be the build date");
    assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/, "the sitemap has no sitemaps.org namespace, so it is not a sitemap");
  });

  await test("ROBOTS.TXT POINTS AT THE SITEMAP, at a URL the build really serves", () => {
    const robots = fs.readFileSync(path.join(OUT, "robots.txt"), "utf8");
    const line = /^Sitemap:\s*(\S+)\s*$/m.exec(robots);
    assert.ok(line, "robots.txt has no Sitemap line, so the guides are discoverable only by knowing the URL");
    assert.equal(line[1], `${links.SITE_URL}/sitemap.xml`, "robots.txt points somewhere other than this origin's sitemap");
    assert.ok(fs.existsSync(path.join(OUT, "sitemap.xml")), "robots.txt names a sitemap the build does not produce");
    /* NO Disallow: blocking the app from indexing is a real decision
       nobody asked for, and the mechanism for it would be a noindex
       meta in the app shell rather than a line here. Asserted so that
       adding one is deliberate. */
    assert.ok(!/^Disallow:\s*\S/m.test(robots), "robots.txt blocks a path — that is a decision, not a tidy-up");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

await run();
