/* Tests for the marketing site's data layer.

   The site's MARKUP is not here — it is built to Jared's approved
   mockup and is a design artefact. What is here is everything the
   markup reads: where a download link points, which platform to lead
   with, what a tier costs, and which slots are hidden.

   Three of these are the ones to read first:

     "no release URL is written down anywhere"  — the whole reason
     site/downloads.js exists rather than three hrefs in the HTML

     "the site's asset names are the ones electron-builder will emit"
     — derived from desktop/package.json, so a build-config change that
     would 404 every download button goes red here instead of on the day

     "the pricing page cannot ship a made-up price" — the placeholder
     marker, guarded the way the UNMEASURED billing marker is */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repoSlug, assetName, downloadUrl, releasesUrl, detectPlatform, downloadsFor } from "../site/downloads.js";
import { TIERS, PERIODS, CURRENCY, allowanceLine, priceLabel } from "../site/pricing.js";
import { FLAGS } from "../site/flags.js";
import { allowanceForTier, TRIAL_CREDITS } from "../src/aiTextLimits.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const source = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const desktopPkg = JSON.parse(source("desktop/package.json"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log("\nmarketing site");

/* Declared before the first test that reads it. A `const` below its own
   use is the temporal-dead-zone shape that has taken this app down
   twice, and a test file is no more immune to it than a component. */
const ASSETS = { windowsInstaller: "S.exe", windowsPortable: "P.exe", linuxAppImage: "L.AppImage" };

/* ---------- downloads: the URLs ---------- */

test("the repo comes from the field electron-builder already requires", () => {
  /* DERIVED, not restated. desktop/package.json must carry a
     `repository` for electron-builder to run at all, so this cannot
     quietly disappear the way a second copy could. */
  const slug = repoSlug(desktopPkg.repository.url);
  assert.ok(slug, `could not parse a repo out of ${desktopPkg.repository.url}`);
  assert.equal(slug.owner, "jjwesterlaken");
  assert.equal(slug.repo, "UniPlanner");
  // The ssh spelling is legal in that field too.
  assert.deepEqual(repoSlug("git@github.com:o/r.git"), { owner: "o", repo: "r" });
  assert.equal(repoSlug("not a url"), null);
});

test("no release URL is written down anywhere in the site or the app", () => {
  /* THE POINT OF THE WHOLE MODULE. A pinned tag or a versioned asset
     path strands the site on an old build the day a release is cut,
     silently, and the only symptom is a download button that gives
     people last month's app. */
  const files = ["site/downloads.js", "site/pricing.js", "site/flags.js"];
  for (const f of files) {
    const src = source(f);
    assert.ok(
      !/releases\/download\/v?\d/.test(src),
      `${f} contains a version-pinned release URL — a new release would strand it`
    );
    assert.ok(!/\/releases\/tag\//.test(src), `${f} links to a specific release tag`);
  }
});

test("the download link is a LINK, never a fetch — the site makes no third-party request", () => {
  /* The alternative is api.github.com for the latest release, which
     works and is a third-party request from the visitor's browser. The
     marketing site holds the same zero-third-party-requests promise the
     app does, so `latest/download` is the mechanism rather than a
     convenience: an href costs nothing until somebody clicks it. */
  /* BLOCK COMMENTS STRIPPED, LINE COMMENTS LEFT, and the asymmetry is
     deliberate. This is the seventh time a grep here has tripped over
     the comment explaining the very thing it forbids: downloads.js
     names the GitHub API in its header to say why it does NOT call it.

     Line comments cannot be stripped, because every URL in that module
     contains a double slash and eating from there to the end of the
     line would remove the code being checked. That was instance six,
     where a strip pattern ate an attribute rather than prose.

     (Writing this comment is itself instance eight in miniature: the
     first draft quoted the block-comment delimiters and closed itself
     early. Say "block comment", never the characters.) */
  const src = source("site/downloads.js").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.ok(!/\bfetch\s*\(/.test(src), "site/downloads.js fetches something — the site must make no requests");
  assert.ok(!/api\.github\.com/.test(src), "site/downloads.js reaches api.github.com");
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(src), "site/downloads.js opens a channel");
});

test("every download points at `latest`, so a new release needs no rebuild", () => {
  const slug = { owner: "o", repo: "r" };
  assert.equal(downloadUrl(slug, "A B.exe"), "https://github.com/o/r/releases/latest/download/A%20B.exe");
  assert.equal(releasesUrl(slug), "https://github.com/o/r/releases/latest");
});

/* ---------- downloads: the asset names ---------- */

test("the site's asset names are exactly the ones electron-builder will emit", () => {
  /* DERIVED FROM THE BUILD CONFIG, because the failure it prevents is
     invisible until somebody clicks: a renamed artifact means a 404 on
     the download button, on a page nothing in CI opens. */
  const productName = desktopPkg.build.productName;
  const names = {
    windowsInstaller: assetName(desktopPkg.build.nsis.artifactName, { productName, ext: "exe" }),
    windowsPortable: assetName(desktopPkg.build.portable.artifactName, { productName, ext: "exe" }),
    linuxAppImage: assetName(desktopPkg.build.linux.artifactName, { productName, ext: "AppImage" }),
  };
  assert.equal(names.windowsInstaller, "University.Planner.Setup.exe");
  assert.equal(names.windowsPortable, "University.Planner.Portable.exe");
  assert.equal(names.linuxAppImage, "University.Planner.AppImage");
});

test("an artifactName carrying a version is REFUSED, not guessed at", () => {
  /* THE FAILURE THIS EXISTS FOR. electron-builder's default puts
     ${version} in the name, which makes `latest/download` impossible —
     and the symptom is a 404 rather than an error, on a link nobody
     tests. Throwing here is the only place it can be caught offline. */
  assert.throws(
    () => assetName("${productName} Setup ${version}.${ext}", { productName: "X", ext: "exe" }),
    /still contains a substitution/
  );
  for (const [target, cfg] of [
    ["nsis", desktopPkg.build.nsis],
    ["portable", desktopPkg.build.portable],
    ["linux", desktopPkg.build.linux],
    ["dmg", desktopPkg.build.dmg],
  ]) {
    assert.ok(
      cfg.artifactName && !cfg.artifactName.includes("${version}"),
      `${target}'s artifactName still has a version in it — every download link for it would 404`
    );
  }
});

/* ---------- which platform to lead with ---------- */

test("the visitor's platform is read from what a browser really reports", () => {
  const cases = [
    [{ platformHint: "Windows" }, "windows"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, "windows"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, "mac"],
    [{ userAgent: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64)" }, "linux"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 14; moto g05)" }, "android"],
    [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }, "ios"],
    [{ userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)" }, "linux"],
  ];
  for (const [env, expected] of cases) {
    assert.equal(detectPlatform(env), expected, `${JSON.stringify(env)} should read as ${expected}`);
  }
});

test("an iPad is not a Mac, and a Chromebook is not Linux", () => {
  /* The two that catch people. iPadOS reports itself as a Macintosh and
     is told apart only by having a touchscreen — get it wrong and every
     iPad visitor is offered a .dmg. Every Chromebook UA says "Linux",
     and an AppImage is not what a Chromebook wants. */
  const iPad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 };
  assert.equal(detectPlatform(iPad), "ios");
  assert.equal(detectPlatform({ ...iPad, maxTouchPoints: 0 }), "mac");
  assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)" }), "other");
});

test("an unknown platform still gets a page full of downloads", () => {
  /* Detection is a convenience and must never be a gate. */
  const out = downloadsFor("other", { slug: { owner: "o", repo: "r" }, assets: ASSETS });
  assert.equal(out.cards.length, 3);
  assert.equal(out.lead, "windows", "an unrecognised visitor should be led to the commonest build, not to nothing");
});

test("EVERY platform is always shown; the visitor's is only moved to the front", () => {
  /* Hiding the others is the trap: the person choosing a download is
     often not on the machine they are downloading for. A student on a
     phone picking up the Windows build for their laptop is the ordinary
     case. */
  for (const p of ["windows", "mac", "linux", "android", "ios", "other"]) {
    const out = downloadsFor(p, { slug: { owner: "o", repo: "r" }, assets: ASSETS });
    assert.deepEqual(
      [...out.cards.map((c) => c.id)].sort(),
      ["linux", "mac", "windows"],
      `${p} was not offered every build`
    );
    assert.equal(out.cards[0].id, out.lead, `${p}: the lead card is not first`);
  }
  assert.equal(downloadsFor("ios", { slug: {}, assets: ASSETS }).lead, "mac", "an iOS visitor is a Mac household");
  assert.equal(downloadsFor("android", { slug: {}, assets: ASSETS }).lead, "windows");
});

test("the Windows note is present, and says the two things a student has to do", () => {
  /* A SmartScreen warning with no warning that it was coming reads as
     "this download is malware", which is the correct instinct and the
     wrong conclusion. */
  const win = downloadsFor("windows", { slug: {}, assets: ASSETS }).cards.find((c) => c.id === "windows");
  assert.match(win.note, /More info/i, "the note does not say to click More info");
  assert.match(win.note, /Run anyway/i, "the note does not say to click Run anyway");
  assert.ok(FLAGS.windowsUnsignedNote, "the note is flagged off while the build is still unsigned");
});

test("macOS is unavailable and offers no link at all", () => {
  /* NOT "we haven't built it" — a signed .dmg is the missing thing, not
     a .dmg. Unsigned, macOS refuses to open rather than warning, so
     there is no equivalent of the Windows note to write. */
  const mac = downloadsFor("mac", { slug: {}, assets: ASSETS }).cards.find((c) => c.id === "mac");
  assert.equal(mac.available, false);
  assert.equal(mac.href, null, "an unsigned Mac build must not be downloadable — it refuses to open");
  assert.ok(mac.soon);
  assert.equal(FLAGS.macDownload, false, "the Mac download flag is on while the build is unsigned");
});

/* ---------- pricing ---------- */

test("the marketed allowances are the ones the server enforces", () => {
  /* THE WORST PLACE FOR DRIFT IN THE WHOLE PROJECT. A page promising
     900 credits while the server enforces 450 is a promise made to
     somebody about to pay. Derived from the client mirror, which is
     itself deep-equalled against the Edge Function's config. */
  for (const tier of TIERS) {
    const server = allowanceForTier(tier.id);
    assert.equal(tier.credits, server.credits, `the site sells ${tier.name} ${tier.credits} credits; the server gives ${server.credits}`);
    assert.equal(tier.perMonth, server.perMonth, `${tier.name}'s allowance SHAPE differs from the server's`);
  }
  assert.equal(TIERS.find((t) => t.id === "free").credits, TRIAL_CREDITS);
});

test("'a month' appears only on the tiers where it is true", () => {
  for (const tier of TIERS) {
    const line = allowanceLine(tier);
    if (tier.perMonth) assert.match(line, /a month/, `${tier.name} is monthly and does not say so`);
    else {
      assert.doesNotMatch(line, /a month/, `${tier.name} is a once-ever trial and the line calls it monthly`);
      assert.match(line, /don't reset|once/i, `${tier.name} must say the credits do not reset`);
    }
  }
  /* And on the FEATURE lists, where it is just as easy to get wrong. */
  for (const tier of TIERS.filter((t) => !t.perMonth)) {
    for (const f of tier.features) {
      assert.doesNotMatch(f, /credits a month/i, `${tier.name} sells "credits a month" on a once-ever trial`);
    }
  }
});

test("the pricing page cannot ship a made-up price", () => {
  /* Every unset price is null and renders as the placeholder treatment.
     A number typed in "for now" is the thing this prevents: on a
     pricing page it is not a stale figure, it is an offer. */
  for (const tier of TIERS) {
    for (const p of PERIODS) {
      const v = tier.prices[p.id];
      assert.ok(v === null || typeof v === "number", `${tier.name}/${p.id} is neither a number nor unset`);
      if (v === null) assert.equal(priceLabel(tier, p.id), null, "an unset price must render as the placeholder, not as a number");
    }
  }
  assert.equal(priceLabel(TIERS.find((t) => t.id === "free"), "monthly"), "Free");
  assert.equal(FLAGS.prices, false, "prices are flagged live while tiers still have unset figures");
});

test("the prices flag and the numbers agree — one cannot be turned on without the other", () => {
  /* THE COMBINATION, not each alone. Flipping FLAGS.prices with figures
     still unset renders "—" where a price belongs, on the page where
     that is least survivable. */
  const anyUnset = TIERS.some((t) => PERIODS.some((p) => t.prices[p.id] === null));
  if (FLAGS.prices) {
    assert.ok(!anyUnset, "FLAGS.prices is on but some tiers have no price — the table would render dashes");
  } else {
    assert.ok(anyUnset, "every price is set but FLAGS.prices is still off — turn it on and delete this branch");
  }
});

test("one currency, stated, and three periods with no quarterly", () => {
  assert.equal(CURRENCY, "AUD");
  assert.deepEqual(PERIODS.map((p) => p.id), ["monthly", "sixMonth", "annual"]);
  assert.ok(!PERIODS.some((p) => /quarter/i.test(p.id + p.label)), "three months maps to nothing in a student's year");
});

/* ---------- flags ---------- */

test("every store badge is behind a flag, and every flag names its condition", () => {
  assert.equal(FLAGS.playBadge, false, "the Play badge is showing and the listing is not live");
  assert.equal(FLAGS.appStoreBadge, false, "the App Store badge is showing and iOS has never been compiled");
  /* Comments stripped before the grep: this file explains at length
     WHAT turns each flag on, and a check that trips over its own
     explanation is measuring the prose. */
  const src = source("site/flags.js").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const key of Object.keys(FLAGS)) {
    assert.ok(src.includes(`${key}:`), `${key} is exported but not declared in the file this test reads`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
