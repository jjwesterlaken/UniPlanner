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
import { STORE_NAME, SHORT_DESCRIPTION, FULL_DESCRIPTION, PRIVACY_POLICY_PATH, ACCOUNT_DELETION_PATH, LIMITS } from "../site/store-listing.js";
import { SITE_URL, PRIVACY_URL, DELETE_ACCOUNT_URL, APP_URL } from "../src/legalLinks.js";
import * as links from "../src/legalLinks.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* buildSync and not `build`: this runner is synchronous and refuses a
   test that returns a promise, for the reason written beside it. */
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

import { repoSlug, assetName, downloadUrl, releasesUrl, detectPlatform, downloadsFor } from "../site/downloads.js";
import { TIERS, PERIODS, CURRENCY, allowanceLine, priceLabel } from "../site/pricing.js";
import { FLAGS } from "../site/flags.js";
import { allowanceForTier, TRIAL_CREDITS } from "../src/aiTextLimits.js";
/* The desktop mic prompt is compared against this rather than against a
   typed sentence — the same constant every other shell interpolates. */
import { MIC_USAGE_DESCRIPTION } from "../mobile/scripts/native-permissions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const source = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const desktopPkg = JSON.parse(source("desktop/package.json"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    /* THE RUNNER IS SYNCHRONOUS, and an async fn returns a promise it
       would never await — so every assertion inside one runs after the
       summary has been printed and the exit code decided, and a failure
       surfaces as an unhandled rejection rather than as a failure. It
       reported three tests green that could not have gone red. Refusing
       is the fix; making it async would mean auditing every existing
       caller for ordering. */
    if (r && typeof r.then === "function") {
      throw new Error("this runner is synchronous — an async test would be reported green whatever it asserts");
    }
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
/* EVERY ASSET THE CARDS READ. It was missing `macDmg` the moment the Mac
   card started reading one, and the href came out carrying the word
   "undefined" — a real URL, pointing nowhere, which only the "is it a
   .dmg" assertion caught. A fixture that lags the code it stands in for
   is the weaker-stand-in pattern in its cheapest form. */
const ASSETS = {
  windowsInstaller: "S.exe",
  windowsPortable: "P.exe",
  linuxAppImage: "L.AppImage",
  /* SPACE-FREE, like the real one. It used to read "University
     Planner.dmg", which was accurate when the templates carried a space
     and is the shape the agreement test above now forbids — a fixture
     that keeps a defect alive after the code has dropped it is the
     stand-in-weaker-than-production pattern in its cheapest form. */
  macDmg: "UniPlanner.dmg",
};

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

/* EVERY TARGET THE DESKTOP BUILD IS CONFIGURED TO PRODUCE, and where
   electron-builder reads that target's artifactName from. The table is
   electron-builder's own convention rather than a restatement of a
   value, and it is COMPLETE BY ASSERTION below: a target configured in
   desktop/package.json with no row here fails, so adding one is a
   decision somebody has to make rather than a gap that opens quietly. */
const TARGETS = {
  dmg: { config: () => desktopPkg.build.dmg.artifactName, ext: "dmg" },
  zip: { config: () => desktopPkg.build.mac.artifactName, ext: "zip" },
  nsis: { config: () => desktopPkg.build.nsis.artifactName, ext: "exe" },
  portable: { config: () => desktopPkg.build.portable.artifactName, ext: "exe" },
  AppImage: { config: () => desktopPkg.build.linux.artifactName, ext: "AppImage" },
};

/** Every target named in the three platform blocks. */
function configuredTargets() {
  return [...desktopPkg.build.mac.target, ...desktopPkg.build.win.target, ...desktopPkg.build.linux.target];
}

/** The file electron-builder writes to desktop/dist for one target. */
function builtFilename(target) {
  const t = TARGETS[target];
  assert.ok(t, `desktop/package.json builds a "${target}" and this suite has no row for it — say which artifactName it uses`);
  return String(t.config()).replaceAll("${productName}", desktopPkg.build.productName).replaceAll("${ext}", t.ext);
}

test("an installer has ONE name — the file, the release asset, the update manifest and the site all agree", () => {
  /* THE BUG THIS EXISTS FOR, and it had been live on every release:
     `${productName}` is "University Planner", so electron-builder wrote
     `University Planner.dmg`; GitHub replaced the space with a DOT when
     the asset was uploaded; and the latest*.yml electron-builder writes
     beside the installer replaced the same space with a HYPHEN. Three
     spellings of one file. The site linked the dot form and worked; all
     three update manifests named the hyphen form, and every one of them
     404s against the release they shipped on — confirmed by requesting
     the v1.1.5 asset the manifest names.

     Silent in both directions: nothing reads a manifest today (no
     electron-updater is wired), and the day one is, it fails by finding
     no file rather than by erroring.

     So the claim is the agreement, not the spelling. It holds exactly
     when the built filename carries no whitespace, which is the thing
     to keep true — but asserting the AGREEMENT is what says why. */
  const targets = configuredTargets();
  assert.ok(targets.length >= 4, `only ${targets.length} target(s) configured — this suite would be checking almost nothing`);

  for (const target of targets) {
    const file = builtFilename(target);
    assert.ok(!/\$\{/.test(file), `${target}: "${file}" still carries a substitution, so the name moves with the release`);

    /* The three derivations, each written the way the thing that
       performs it really behaves. */
    const onTheRelease = file.replace(/ /g, ".");   // GitHub, at upload
    const inTheManifest = file.replace(/ /g, "-");  // electron-builder, writing latest*.yml
    const onTheSite = assetName(TARGETS[target].config(), { productName: desktopPkg.build.productName, ext: TARGETS[target].ext });

    assert.equal(
      onTheRelease,
      inTheManifest,
      `${target}: the release serves "${onTheRelease}" and latest*.yml names "${inTheManifest}" — ` +
        "auto-update would look for a file that is not there. The artifactName must carry no spaces."
    );
    assert.equal(onTheSite, onTheRelease, `${target}: the download button points at "${onTheSite}", the release has "${onTheRelease}"`);
  }
});

test("a release carries the desktop builds and nothing else", () => {
  /* v1.1.5 PUBLISHED THE MARKETING SITE AS RELEASE ASSETS. Thirty
     assets went up: four installers, three manifests, and twenty-five
     files of dist-web — app.js, privacy.html, three woff2 fonts, the
     service worker. The release job asked `download-artifact` for
     everything the run produced and then flattened it with `find`, and
     the web bundle is uploaded by the Linux job for hosting.

     Nothing failed. A student picking a download met a list in which
     the four files meant for them were a seventh of what was offered.

     TWO HALVES, AND THEY ARE NOT REDUNDANT. The download PATTERN is the
     mechanism, and it works by SHAPE — the desktop artifacts are
     `UniPlanner-Desktop-<label>` and the web bundle is
     `UniPlanner-Web`, which cannot match. The step in the job
     is the CHECK, because a pattern that silently stops matching
     produces a release that looks exactly like a tidy one. This test is
     what ties the check's allow-list to the build config, so a new
     target cannot be published by a step that has never heard of it. */
  const workflow = source(".github/workflows/build-apps.yml");
  const blocks = stepBlocks(workflow);

  const download = blocks.find((b) => /uses: actions\/download-artifact/.test(b));
  assert.ok(download, "the release job downloads nothing — this suite is reading the wrong workflow");
  const pattern = (download.match(/^\s*pattern:\s*(\S+)\s*$/m) || [])[1];
  assert.ok(pattern, "the download step takes every artifact the run produced, which is how the whole site shipped as a release");

  /* The two upload names, read out of the workflow rather than typed,
     and checked AGAINST THE PATTERN — the claim is that the shapes
     separate them, so both directions are asserted. */
  const uploadNames = [...workflow.matchAll(/uses: actions\/upload-artifact@v4\n\s*with:\n\s*name:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uploadNames.length, 2, `expected the desktop and web uploads, found ${uploadNames.length}: ${uploadNames.join(", ")}`);
  const matches = (name) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(name);
  const desktop = uploadNames.filter((n) => matches(n.replace("${{ matrix.label }}", "Mac")));
  const web = uploadNames.filter((n) => !matches(n.replace("${{ matrix.label }}", "Mac")));
  assert.equal(desktop.length, 1, `the pattern "${pattern}" matches ${desktop.length} of the two uploads, and it must match exactly the desktop one`);
  assert.equal(web.length, 1, `nothing is excluded by "${pattern}" — the web bundle would be published again`);
  assert.ok(/dist-web/.test(workflow), "the excluded upload is not the web bundle, so this test is excluding the wrong thing");

  /* THE ALLOW-LIST, DERIVED. Every extension the configured targets
     produce must be named in the publishing check's case list, and the
     case list must name nothing else that looks like an installer — so
     adding a target without widening it goes red here rather than on a
     release, and widening it to something nothing builds goes red too. */
  const guard = blocks.find((b) => /- name: Nothing but the desktop builds may be published/.test(b));
  assert.ok(guard, "nothing checks what is about to be published");
  const allowed = new Set([...guard.matchAll(/\*\.([A-Za-z]+)/g)].map((m) => m[1]));
  assert.ok(allowed.size > 0, "the publishing check names no extensions at all");

  const built = new Set(configuredTargets().map((t) => TARGETS[t].ext));
  assert.ok(built.size >= 3, `only ${built.size} extension(s) are built — the comparison below would be checking almost nothing`);
  for (const ext of built) {
    assert.ok(allowed.has(ext), `the build produces .${ext} files and the publishing check would reject them`);
  }
  for (const ext of allowed) {
    assert.ok(
      built.has(ext) || ext === "blockmap",
      `the publishing check allows .${ext} and no configured target produces one — either a target was removed or the list drifted`
    );
  }
  assert.ok(allowed.has("blockmap"), "blockmaps are collected and would be refused at publish time");

  /* And the blockmaps have to be collected in the first place. The
     matrix globbed `*.dmg` and `*.exe`, which do NOT match
     `<file>.<ext>.blockmap`, so the blockmaps electron-builder had been
     writing all along reached no release — the differential download
     they exist for was never available. */
  assert.ok(
    /desktop\/dist\/\*\.blockmap/.test(workflow),
    "no job collects the .blockmap files, so `*.dmg` and friends leave them behind"
  );

});

test("the publishing check refuses a stray asset, and refuses a release with no installer in it", () => {
  /* THE GREP VERSION OF THIS WAS DECORATIVE, and it took a mutation to
     find out: deleting the whole no-installer branch left the suite
     green, because the pattern still matched `installers=0` in one line
     and `-eq 0` in another several lines away. A source grep asserts
     that some text is present; the claim is about what a shell script
     DOES, and the only way to know what a shell script does is to run
     it. So the step is lifted out of the workflow and executed against
     real folders — the same arrangement as the Gatekeeper harness
     above, and for the same reason.

     THREE WORLDS, and the healthy one is what makes the other two mean
     something: a check that refuses everything satisfies both refusals
     and is useless. */
  const workflow = source(".github/workflows/build-apps.yml");
  const guard = stepBlocks(workflow).find((b) => /- name: Nothing but the desktop builds may be published/.test(b));
  assert.ok(guard, "nothing checks what is about to be published");
  const script = (guard.match(/\n        run: \|\n([\s\S]*?)(?=\n      - |\n  \w|$)/) || [])[1];
  assert.ok(script && script.trim(), "could not lift the step's script out of the workflow");
  const dedented = script
    .split("\n")
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");

  const run = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-guard-"));
    fs.mkdirSync(path.join(dir, "release"));
    for (const f of files) fs.writeFileSync(path.join(dir, "release", f), "x");
    const sh = path.join(dir, "step.sh");
    fs.writeFileSync(sh, "set -e\n" + dedented);
    try {
      const out = execFileSync("bash", [sh], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, out };
    } catch (err) {
      return { ok: false, out: `${err.stdout || ""}${err.stderr || ""}` };
    }
  };

  /* Built from the config, so the healthy world is the one this repo
     really produces rather than a remembered list of four names. */
  const healthy = [
    ...configuredTargets().map((t) => builtFilename(t).replace(/ /g, ".")),
    "latest.yml",
    "latest-mac.yml",
    "latest-linux.yml",
  ];
  const good = run([...healthy, healthy[0] + ".blockmap"]);
  assert.ok(good.ok, `a correct release was refused:\n${good.out}`);

  const strayed = run([...healthy, "app.js", "privacy.html"]);
  assert.equal(strayed.ok, false, "the whole marketing site would be published again and the step would report success");
  assert.match(strayed.out, /app\.js/, "the refusal does not name the file that should not be there");
  assert.match(strayed.out, /privacy\.html/, "the refusal names one stray file and stops, so a second pass is needed to see the rest");

  const metadataOnly = run(["latest.yml", "latest-mac.yml", "latest-linux.yml"]);
  assert.equal(metadataOnly.ok, false, "a release with no installer in it passes — 'nothing unexpected' is true of an empty folder");

  assert.equal(run([]).ok, false, "an empty release folder passes, so a download pattern that matched nothing would publish nothing and say nothing");
});

test("the macOS build ships a .zip, because electron-updater cannot step off a disk image", () => {
  /* A .dmg is what a student downloads and a .zip is what an updater
     swaps the app bundle out of — electron-updater's mac path needs
     one, and with dmg-only targets latest-mac.yml names the dmg, which
     it cannot use. Nothing asks for an update today; the metadata still
     has to have been correct on the releases somebody would be
     upgrading FROM, which is the same reason the release job checks the
     manifests are present at all. */
  assert.ok(
    desktopPkg.build.mac.target.includes("zip"),
    "mac.target has no zip — latest-mac.yml would name the .dmg and macOS auto-update would find nothing usable"
  );
  assert.ok(desktopPkg.build.mac.target.includes("dmg"), "the .dmg is what the download button offers");
  /* And the zip must be name-stable for the same reason everything else
     is: mac.artifactName is what it reads, and electron-builder's
     default for it carries ${version} and ${arch}. */
  assert.ok(
    desktopPkg.build.mac.artifactName,
    "mac.artifactName is unset, so the zip takes electron-builder's default — which carries the version and cannot be linked to"
  );
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

/* A workflow as STEP BLOCKS, with YAML comments stripped first.

   THE COMMENTS HAVE TO GO, and this file's own subject is why: the
   workflow explains at length why CSC_LINK must NOT be set on the
   packaging step, naming it repeatedly while doing so. A sweep that
   read those comments would find the forbidden thing in the paragraph
   forbidding it — the sixth costume of a rule this project has already
   learned five times, so the strip comes first.

   Split textually rather than with a YAML parser because there is no
   YAML dependency and adding one for this is worse than a split whose
   result is asserted: stepBlocks' callers check the blocks they expect
   are really there, so a change of indentation fails loudly instead of
   sweeping an empty list. */
function stepBlocks(workflow) {
  const stripped = workflow
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    /* Trailing comments too — but never on a line carrying an \${{ }}
       expression, which cannot contain one and might contain a #. */
    .map((l) => (l.includes("\${{") ? l : l.replace(/\s#.*$/, "")))
    .join("\n");
  return stripped.split(/\n(?=      - )/);
}

/* Every step that sets any of `names` in its env, with whether the step
   is confined to the Mac job — by its own `if:`, or by each setting
   line's own expression. Both are real gates and both are used. */
function stepsSetting(workflow, names) {
  const pattern = new RegExp(`^\\s*(${names.join("|")}):.*$`, "gm");
  const found = [];
  for (const block of stepBlocks(workflow)) {
    const lines = block.match(pattern);
    if (!lines) continue;
    const gate = /\n\s*if:[^\n]*matrix\.label == 'Mac'/.test("\n" + block);
    found.push({
      name: (block.match(/- name: [^\n]*/) || ["an unnamed step"])[0].replace("- name: ", "").trim(),
      sets: lines.map((l) => l.trim().split(":")[0]),
      macGated: gate || lines.every((l) => /matrix\.label == 'Mac'/.test(l)),
    });
  }
  /* NON-VACUITY: no step setting them at all means nothing signs, and
     every universal claim above would hold over the empty set. */
  assert.ok(found.length > 0, `no step sets ${names.join(" or ")} — nothing hands the build a certificate`);
  return found;
}

test("THE MAC DOWNLOAD CANNOT BE SWITCHED ON BY EDITING A BOOLEAN", () => {
  /* THE GATE, and the reason it is not simply `assert(FLAGS.macDownload)`
     either way: the thing that makes a Mac link safe is not a flag, it
     is a PIPELINE — a Developer ID certificate, a notarisation
     submission, and something that checks the result. The flag is only
     a statement that the pipeline exists.

     So this asserts the pipeline, from the workflow and the packaging
     config, and lets the flag follow. Flip the boolean without the
     workflow and it goes red naming what is missing; take the workflow
     away under a flag that is already true and it goes red too.

     WHY IT MATTERS MORE THAN THE USUAL FLAG: an unsigned or
     un-notarised .dmg uploads, publishes, and looks completely normal.
     It fails on the student's Mac, with a dialogue saying the app is
     damaged — which reads as a corrupt download rather than as an
     unsigned one, so the report that comes back is about the wrong
     thing entirely. */
  const mac = downloadsFor("mac", { slug: {}, assets: ASSETS }).cards.find((c) => c.id === "mac");

  if (!FLAGS.macDownload) {
    /* The pre-signing state, kept reachable rather than deleted: this is
       what the card must do while the pipeline is absent. */
    assert.equal(mac.available, false);
    assert.equal(mac.href, null, "an unsigned Mac build must not be downloadable — it refuses to open");
    assert.ok(mac.soon, "the card offers neither a download nor an explanation");
    return;
  }

  const workflow = fs.readFileSync(path.join(rootDir, ".github/workflows/build-apps.yml"), "utf8");
  const macConfig = desktopPkg.build.mac;

  /* 1. THE PACKAGING CONFIG MUST NOT CANCEL THE SIGNING. `identity: null`
        means "do not sign" and it overrides a perfectly good
        certificate, silently — secrets reaching a build that has been
        told not to sign produce an unsigned app and a green tick. */
  assert.ok(
    !("identity" in macConfig) || macConfig.identity !== null,
    "desktop/package.json has mac.identity: null, which means DO NOT SIGN — the certificate would be ignored"
  );
  assert.equal(macConfig.hardenedRuntime, true, "notarisation requires the hardened runtime");
  assert.equal(macConfig.notarize, true, "the build is signed but never submitted to the notary service");

  /* 2. THE ENTITLEMENTS FILE MUST EXIST AND CARRY THE MICROPHONE KEY.
        Under the hardened runtime the mic is HARD-DENIED without it —
        no prompt, nothing for the app to distinguish from "no device" —
        so turning the runtime on without this key takes a working
        desktop recorder and breaks it in the commit that fixed the
        signing. Read from the plist rather than asserted of the config. */
  assert.ok(macConfig.entitlements, "the hardened runtime is on with no entitlements file");
  const plist = fs.readFileSync(path.join(rootDir, "desktop", macConfig.entitlements), "utf8");
  assert.match(
    plist.replace(/<!--[\s\S]*?-->/g, " "),
    /com\.apple\.security\.device\.audio-input/,
    "no microphone entitlement — under the hardened runtime recording is refused, not prompted for"
  );

  /* 3. AND THE MICROPHONE STRING BESIDE IT. The entitlement is
        permission to ask; this is what the question says. macOS refuses
        the request outright when it is missing. A MIRROR with the
        EQUALITY as its guard, which is the one form CLAUDE.md allows:
        the constant is JavaScript and this file is JSON, so it genuinely
        cannot be imported. */
  assert.equal(
    macConfig.extendInfo && macConfig.extendInfo.NSMicrophoneUsageDescription,
    MIC_USAGE_DESCRIPTION,
    "the desktop mic prompt has drifted from the one MIC_USAGE_DESCRIPTION every other shell shows"
  );

  /* 4. THE WORKFLOW MUST ACTUALLY SIGN, NOTARISE, AND CHECK. The five
        secrets by name, because a renamed secret resolves to an empty
        string and electron-builder reads that as "no certificate" —
        producing an unsigned app and a passing build. */
  for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    assert.ok(
      new RegExp(`${secret}:\\s*\\$\\{\\{[^}]*secrets\\.${secret}`).test(workflow),
      `the workflow does not pass secrets.${secret} to the packaging step`
    );
  }

  /* AND THE TWO SHARED NAMES MUST BE MAC-SCOPED. CSC_LINK and
     CSC_KEY_PASSWORD are not Apple-specific: electron-builder reads the
     same two on Windows, where they mean an authenticode .pfx. Passed
     unconditionally they hand the Windows job an Apple certificate.

     SCOPED TO THE CLAIM, NOT TO A LINE. The first version of this read
     the single line starting `CSC_LINK:` and required the Mac
     conditional ON THAT LINE — which was true of the shape it was
     written against and says nothing about any other shape. Moving the
     two names into a step gated by `if: matrix.label == 'Mac'` is
     CORRECT and would have failed it; leaving an ungated
     `CSC_LINK: \${{ secrets.CSC_LINK }}` in a step that merely mentions
     the matrix elsewhere would have PASSED it. The claim is about a
     STEP: no step the Windows job runs may receive an Apple
     certificate. So the workflow is split into steps and each one that
     sets either name has to be gated — by its own `if:`, or by the
     setting line's own expression. */
  for (const step of stepsSetting(workflow, ["CSC_LINK", "CSC_KEY_PASSWORD"])) {
    assert.ok(
      step.macGated,
      `${step.name} sets ${step.sets.join(" and ")} without gating the step on the Mac job — ` +
        "electron-builder reads those two on Windows too, as an authenticode certificate"
    );
  }

  /* AND NOT ON THE PACKAGING STEP, which is a different claim from the
     one above and a newer one. The certificate now goes into a keychain
     the workflow creates, and electron-builder reads CSC_KEYCHAIN ONLY
     WHEN CSC_LINK IS ABSENT. Setting it there — even correctly gated to
     the Mac job — silently sends signing back through electron-builder's
     own temporary-keychain code, which is the thing that fails on the
     macOS 26 runner with "SecKeychainUnlock: The user name or passphrase
     you entered is not correct". It would look like a tidy-up. */
  const packaging = stepBlocks(workflow).find((b) => /- name: Package the desktop app/.test(b));
  assert.ok(packaging, "the packaging step has been renamed — this guard is reading nothing");
  assert.doesNotMatch(
    packaging,
    /^\s*(CSC_LINK|CSC_KEY_PASSWORD):/m,
    "the packaging step sets CSC_LINK/CSC_KEY_PASSWORD again — electron-builder then ignores CSC_KEYCHAIN and re-imports the certificate itself, which is the failure the keychain step exists to remove"
  );

  /* THE KEYCHAIN STEP ITSELF: the call that fails inside
     electron-builder, done with a password we generated, and the
     identity check that has to run BEFORE the twenty-minute package-and-
     notarise step rather than after it. */
  const blocks = stepBlocks(workflow);
  const keychainAt = blocks.findIndex((b) => /security create-keychain/.test(b));
  const packagingAt = blocks.findIndex((b) => /- name: Package the desktop app/.test(b));
  assert.ok(keychainAt >= 0, "nothing creates a signing keychain, so electron-builder is back on the code path that fails on macOS 26");
  assert.ok(
    keychainAt < packagingAt,
    "the keychain is prepared after the packaging step, so a certificate that never arrived is discovered by a signing failure rather than by the check written for it"
  );
  const keychain = blocks[keychainAt];
  assert.match(
    keychain,
    /security set-key-partition-list/,
    "the keychain is created but its key is never released to codesign — signing blocks on a UI prompt nothing can answer"
  );
  assert.match(
    keychain,
    /security find-identity -v -p codesigning/,
    "nothing verifies the certificate is usable before the build, so an unusable one is found by electron-builder instead"
  );
  assert.match(
    keychain,
    /CSC_KEYCHAIN=/,
    "the keychain is never handed to electron-builder, which will look for the identity somewhere else"
  );
  assert.match(
    keychain,
    /CSC_NAME=\$name/,
    "the verified identity is not passed on as CSC_NAME, so electron-builder picks one by auto-discovery instead of the one that was checked"
  );

  /* AND THE NAME MUST ARRIVE WITHOUT ITS PREFIX, WHICH IS RUN RATHER
     THAN GREPED.

     find-identity prints the full common name — "Developer ID
     Application: Some Person (TEAMID)" — and electron-builder REFUSES
     that as CSC_NAME: "Please remove prefix \"Developer ID
     Application:\" from the specified name". It wants the person and
     team id alone. The first version of this step passed the whole
     string and the v1.1.2 Mac job died on it, one stage past the
     identity check that had just reported success.

     THE ONLY WAY TO KNOW WHAT A sed EXPRESSION EXTRACTS IS TO RUN IT.
     A pattern asserting the workflow "does not contain the prefix"
     would be false of a correct step — the prefix HAS to appear in the
     expression, because that is the text being matched — and a pattern
     asserting some particular sed spelling would pin the writing
     rather than the claim, which this project has re-learned enough
     times. So the real line is lifted out of the workflow and executed
     against a find-identity fixture, and what is asserted is its
     OUTPUT. */
  const extraction = (keychain.match(/^\s*name="\$\(.*\)"\s*$/m) || [])[0];
  assert.ok(
    extraction,
    "no line in the keychain step assigns the identity name — this guard has nothing to run, which would make every assertion below it vacuous"
  );

  /* The expected answer is DERIVED from the fixture rather than typed
     beside it: the fixture is built from the name, so "the prefix is
     gone and nothing else is" is a comparison against the input. */
  const IDENTITY = "Jared Westerlaken (AB12CD34EF)";
  const findIdentityOutput = [
    `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Installer: ${IDENTITY}"`,
    `  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: ${IDENTITY}"`,
    "     2 valid identities found",
  ].join("\n");

  let extracted;
  try {
    extracted = execFileSync(
      "bash",
      ["-c", `set -uo pipefail\nidentities="$1"\n${extraction}\nprintf '%s' "$name"`, "bash", findIdentityOutput],
      { encoding: "utf8" }
    );
  } catch (err) {
    /* A GUARD THAT CANNOT RUN MUST SAY SO RATHER THAN PASS. The claim
       is about what a shell snippet produces, so there is no
       weaker-but-portable version of it worth having — a skip here is
       the guard switching itself off in exactly the situation it
       exists for. */
    assert.fail(`the identity-name extraction could not be run (${err.code === "ENOENT" ? "bash is not on PATH" : err.message}) — this check needs a shell`);
  }

  assert.ok(extracted, "the extraction produced nothing from a fixture that names one Developer ID Application identity");
  assert.equal(
    extracted,
    IDENTITY,
    'CSC_NAME carries more (or less) than the name and team id — electron-builder refuses a name prefixed "Developer ID Application:" and chooses the certificate type itself'
  );


  /* THE DISK IMAGE IS NOTARISED IN ITS OWN RIGHT. `mac.notarize` staples
     the .app and the dmg target then packages it into a file Apple has
     never seen, so the image carries no ticket — which is what a student
     downloads and what Gatekeeper assesses when they open it. v1.1.3
     produced exactly that ("does not have a ticket stapled to it"). */
  const notariseAt = blocks.findIndex((b) => /xcrun notarytool submit/.test(b));
  assert.ok(
    notariseAt >= 0,
    "nothing submits the disk image to the notary service, so it ships without a ticket of its own and an offline Mac refuses it"
  );
  assert.match(
    blocks[notariseAt],
    /xcrun stapler staple/,
    "the disk image is submitted for notarisation and the ticket is never attached to it"
  );
  const assessAt = blocks.findIndex((b) => /- name: Gatekeeper must accept/.test(b));
  assert.ok(assessAt > notariseAt, "the disk image is assessed before it is notarised, so the gate can only ever fail");

  /* AND NO PROBE MAY STOP A LATER ONE FROM RUNNING — run, not read.

     This is the v1.1.3 defect exactly. `xcrun stapler validate "$dmg"`
     sat unguarded under `set -e`, exited 65, and took the step with it,
     so the disk image's Gatekeeper assessment — the one line that
     answers what a student's Mac would do — never executed, on the one
     run where its answer mattered. Every source-level check in this
     file was green over that, because the line was present; what was
     wrong was that it was unreachable.

     So the real script is lifted out of the workflow and EXECUTED
     against fake `codesign`, `spctl` and `xcrun` on PATH, over a fake
     desktop/dist. The claim asserted is behavioural: when the disk
     image's staple check fails, the step still reaches the disk image's
     spctl assessment AND still fails. The old script was run through
     this same harness and reproduced production byte for byte — exit
     65, zero dmg assessments. */
  const assessScript = (blocks[assessAt].match(/\n {8}run: \|\n([\s\S]*)$/) || [])[1];
  assert.ok(assessScript, "the Gatekeeper step has no run: block — this harness has nothing to execute");

  const harness = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-"));
  try {
    fs.mkdirSync(path.join(harness, "work/desktop/dist/mac-universal/Some.app"), { recursive: true });
    fs.writeFileSync(path.join(harness, "work/desktop/dist/Some.dmg"), "");
    const bin = path.join(harness, "bin");
    fs.mkdirSync(bin);
    const state = path.join(harness, "state");
    fs.mkdirSync(state);
    const fake = (name, body) => {
      const f = path.join(bin, name);
      fs.writeFileSync(f, "#!/bin/bash\necho \"" + name + " $*\" >> \"$TRACE\"\n" + body);
      fs.chmodSync(f, 0o755);
    };
    /* STATEFUL FAKES, because the claims are about ORDER and about a step
       that asks whether work is already done. A `codesign --verify` that
       always succeeds cannot tell a signed image from an unsigned one, so
       the sign/staple markers are written and read like the real thing. */
    fake(
      "codesign",
      'mode=verify; t=""\n' +
        'for a in "$@"; do case "$a" in --sign) mode=sign;; *.dmg|*.app) t="$a";; esac; done\n' +
        'key="$STATE/$(basename "$t")"\n' +
        'if [ "$mode" = sign ]; then : > "$key.signed"; exit 0; fi\n' +
        'case "$t" in *.app) echo "valid on disk"; exit 0;; esac\n' +
        'if [ -f "$key.signed" ]; then echo "valid on disk"; exit 0; fi\n' +
        'echo "code object is not signed at all" >&2; exit 1\n'
    );
    fake(
      "spctl",
      'for a in "$@"; do case "$a" in *.dmg) k=dmg;; *.app) k=app;; esac; done\n' +
        'if [ "$k" = dmg ] && [ "${FAKE_DMG_UNSIGNED:-0}" = 1 ]; then\n' +
        '  echo "$k: rejected" >&2; echo "source=no usable signature" >&2; exit 3\n' +
        'fi\n' +
        'if [ "$k" = dmg ] && [ "${FAKE_DMG_SOURCE:-}" != "" ]; then\n' +
        '  echo "$k: accepted" >&2; echo "source=$FAKE_DMG_SOURCE" >&2; exit 0\n' +
        'fi\n' +
        'echo "$k: accepted" >&2; echo "source=Notarized Developer ID" >&2; exit 0\n'
    );
    fake(
      "xcrun",
      'if [ "$1" = notarytool ] && [ "$2" = submit ]; then\n' +
        '  for a in "$@"; do case "$a" in *.dmg) t="$a";; esac; done\n' +
        '  st="${FAKE_NOTARY_STATUS:-Accepted}"\n' +
        '  printf "Submission ID received\\n  id: 2efe2717-52ef-43a5-96dc-0797e4ca1041\\n"\n' +
        '  printf "Processing complete\\n  id: 2efe2717-52ef-43a5-96dc-0797e4ca1041\\n  status: %s\\n" "$st"\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [ "$1" = stapler ] && [ "$2" = staple ]; then : > "$STATE/$(basename "$3").stapled"; exit 0; fi\n' +
        'if [ "$1" = stapler ] && [ "$2" = validate ]; then\n' +
        '  case "$3" in *.app) echo "The validate action worked!"; exit 0;; esac\n' +
        '  if [ "${FAKE_DMG_STAPLE_FAILS:-0}" = 1 ]; then\n' +
        '    echo "does not have a ticket stapled to it."; exit 65\n' +
        '  fi\n' +
        '  if [ -f "$STATE/$(basename "$3").stapled" ] || [ "${FAKE_DMG_PRESTAPLED:-0}" = 1 ]; then\n' +
        '    echo "The validate action worked!"; exit 0\n' +
        '  fi\n' +
        '  echo "does not have a ticket stapled to it."; exit 65\n' +
        'fi\nexit 0\n'
    );

    const scriptFile = path.join(harness, "assess.sh");
    fs.writeFileSync(scriptFile, assessScript);
    const trace = path.join(harness, "trace.txt");

    const drive = (env, which = scriptFile) => {
      fs.writeFileSync(trace, "");
      fs.rmSync(state, { recursive: true, force: true });
      fs.mkdirSync(state);
      let status = 0;
      try {
        execFileSync("bash", [which], {
          cwd: path.join(harness, "work"),
          env: {
            ...process.env,
            PATH: bin + ":" + process.env.PATH,
            TRACE: trace,
            STATE: state,
            RUNNER_TEMP: harness,
            SIGNING_IDENTITY: "89ABCDEF0123456789ABCDEF0123456789ABCDEF",
            APPLE_ID: "someone@example.com",
            APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
            APPLE_TEAM_ID: "AB12CD34EF",
            GITHUB_ENV: path.join(harness, "github_env"),
            ...env,
          },
          stdio: "pipe",
        });
      } catch (err) {
        status = err.status === undefined ? 1 : err.status;
      }
      return { status, trace: fs.readFileSync(trace, "utf8") };
    };

    const healthy = drive({ FAKE_DMG_PRESTAPLED: "1" });
    /* NON-VACUITY: if the harness cannot drive the script at all, every
       claim below holds over a script that never ran. */
    assert.ok(healthy.trace.trim(), "the Gatekeeper script invoked none of the fakes — the harness is not running it");
    assert.equal(healthy.status, 0, `the Gatekeeper step fails over a wholly valid build:\n${healthy.trace}`);
    const dmgAssessments = (t) => (t.match(/spctl .*--type open/g) || []).length;
    assert.equal(dmgAssessments(healthy.trace), 1, "the disk image is never assessed even when everything passes");

    const broken = drive({ FAKE_DMG_STAPLE_FAILS: "1" });
    assert.notEqual(broken.status, 0, "an unstapled disk image passes the gate — that is the artifact a student downloads");
    assert.equal(
      dmgAssessments(broken.trace),
      1,
      "THE v1.1.3 REGRESSION: the disk image's staple check aborts the step before its Gatekeeper assessment runs, so the log cannot say what a student's Mac would do"
    );

    /* THE v1.1.4 STATE, REPRODUCED: notarised, stapled, and UNSIGNED.
       Every other probe passes; only the image's own assessment says
       otherwise, with the exact text the runner printed. A gate on
       "accepted" alone would have shipped it. */
    const unsigned = drive({ FAKE_DMG_PRESTAPLED: "1", FAKE_DMG_UNSIGNED: "1" });
    assert.notEqual(
      unsigned.status,
      0,
      "an UNSIGNED disk image passes the gate — Gatekeeper answers 'source=no usable signature' and refuses it on the student's Mac"
    );

    /* AND ACCEPTED-BUT-NOT-NOTARISED, which is what the source string is
       for. An image accepted for some other reason does not travel. */
    const wrongSource = drive({ FAKE_DMG_PRESTAPLED: "1", FAKE_DMG_SOURCE: "Developer ID" });
    assert.notEqual(
      wrongSource.status,
      0,
      "the disk image is accepted as something other than a notarised Developer ID image and the gate lets it through"
    );

    /* ---- THE SIGN/NOTARISE STEP, DRIVEN ---------------------------------

       v1.1.4 notarised and stapled the image and Gatekeeper still refused
       it: `source=no usable signature`. electron-builder signs the app and
       not the container, and **the notary service accepted the unsigned
       container anyway** — it checks the contents. So "Accepted" from
       notarytool was true and was not the claim a student needs.

       THE ORDER IS THE PART A TRACE CAN PROVE. A notarisation ticket is
       keyed to the bytes submitted, so signing AFTER submission changes
       them and invalidates both ticket and staple — a mistake that would
       leave every check here green while shipping a refused download,
       because each individual command succeeded. Nothing readable in the
       source distinguishes the two orders; the sequence of calls does. */
    const signScript = (blocks[notariseAt].match(/\n {8}run: \|\n([\s\S]*)$/) || [])[1];
    assert.ok(signScript, "the sign/notarise step has no run: block — this harness has nothing to execute");
    const signFile = path.join(harness, "sign.sh");
    fs.writeFileSync(signFile, signScript);

    const signed = drive({}, signFile);
    assert.ok(signed.trace.trim(), "the sign/notarise script invoked none of the fakes — the harness is not running it");
    assert.equal(signed.status, 0, `the sign/notarise step fails over a healthy build:\n${signed.trace}`);

    const at = (re) => signed.trace.split("\n").findIndex((l) => re.test(l));
    const signAt = at(/^codesign .*--sign.*\.dmg|^codesign .*\.dmg.*--sign/);
    const submitAt = at(/^xcrun notarytool submit/);
    const stapleAt = at(/^xcrun stapler staple/);
    assert.ok(signAt >= 0, `the disk image is never signed:\n${signed.trace}`);
    assert.ok(submitAt >= 0, `the disk image is never submitted for notarisation:\n${signed.trace}`);
    assert.ok(stapleAt >= 0, `the ticket is never stapled to the disk image:\n${signed.trace}`);
    assert.ok(
      signAt < submitAt,
      `THE IMAGE IS SIGNED AFTER IT IS SUBMITTED. A notarisation ticket is keyed to the submitted bytes, so this invalidates it while every command still succeeds:\n${signed.trace}`
    );
    assert.ok(
      submitAt < stapleAt,
      `the ticket is stapled before the submission that produces it:\n${signed.trace}`
    );

    /* A REFUSAL MUST FAIL THE STEP AND FETCH THE REASON. `--wait` does not
       reliably exit non-zero, so a status read that missed this would
       staple nothing and report success. */
    const refused = drive({ FAKE_NOTARY_STATUS: "Invalid" }, signFile);
    assert.notEqual(refused.status, 0, "a disk image Apple REFUSED to notarise passes the step");
    assert.match(
      refused.trace,
      /xcrun notarytool log/,
      "a rejected submission does not fetch the notary log, so the next round is blind"
    );
    assert.doesNotMatch(refused.trace, /xcrun stapler staple/, "a rejected submission is stapled anyway");
  } finally {
    fs.rmSync(harness, { recursive: true, force: true });
  }

  /* THE ASSESSMENT ITSELF, which is the only check anywhere that reads
     the thing a student would double-click. Everything above is
     configuration asserting its own intent. */
  /* BOTH ASSESSMENTS, NAMED SEPARATELY. A bare /spctl --assess/ is
     satisfied by EITHER of the two the workflow runs — demonstrated:
     deleting the app assessment left this green, because the disk-image
     one still matched. Two occurrences and one loose pattern is a guard
     that checks whichever happens to survive. */
  assert.match(
    workflow,
    /spctl --assess --type execute/,
    "nothing assesses the .app, so an unsigned bundle inside a fine-looking disk image would publish"
  );
  assert.match(
    workflow,
    /spctl --assess --type open/,
    "nothing assesses the .dmg, which is the artifact a student actually downloads"
  );
  assert.match(
    workflow,
    /source=Notarized Developer ID/,
    "the assessment accepts any 'accepted' — which includes acceptances that do not travel to another Mac"
  );
  assert.match(workflow, /stapler validate/, "the notarisation ticket is never confirmed to be stapled, so an offline Mac refuses the app");

  /* 5. ONLY THEN may the card offer a link. */
  assert.equal(mac.available, true);
  assert.ok(mac.href, "the flag is on and the card still offers no download");
  assert.match(mac.href, /\.dmg$/, "the Mac card links to something that is not a disk image");
  assert.equal(mac.soon, null, "the card offers a download AND says it is coming soon");
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
  /* CONDITIONAL, because that is what this line always meant — its own
     message says "while tiers still have unset figures" and the code
     said it unconditionally. Written when every paid figure was null,
     it fired the moment Phase 0 set them, which is the one change it
     was waiting for. The combination it was reaching for is asserted
     properly in the test below, in BOTH directions; this is the local
     half of it. Not deleted, because a half-finished pricing change —
     some figures set, flag flipped — is still exactly what must not
     ship. */
  const anyUnset = TIERS.some((t) => PERIODS.some((p) => t.prices[p.id] === null));
  if (anyUnset) {
    assert.equal(FLAGS.prices, false, "prices are flagged live while tiers still have unset figures");
  }
});

test("every price the page can show is a real figure in the stated currency", () => {
  /* THE OTHER HALF OF "cannot ship a made-up price", and it only
     becomes checkable once figures exist: a number that is set must
     also be sayable. A negative, a zero on a paid tier, or something
     with more than two decimal places is a typo that renders as an
     offer — and on Apple's and Google's side a price is entered
     separately in each dashboard, so this is the only place the six
     figures we PUBLISH can be checked against each other at all. */
  assert.equal(CURRENCY, "AUD", "the site quotes one currency and names it");
  const paid = TIERS.filter((t) => t.id !== "free");
  assert.ok(paid.length >= 2, `expected the paid tiers, found ${paid.length}`);
  for (const tier of paid) {
    for (const p of PERIODS) {
      const v = tier.prices[p.id];
      if (v === null) continue;
      assert.ok(v > 0, `${tier.name}/${p.id} is not a positive price`);
      assert.equal(Number(v.toFixed(2)), v, `${tier.name}/${p.id} has sub-cent precision, which no store accepts`);
      assert.match(priceLabel(tier, p.id), /^\$\d+\.\d{2} AUD$/, `${tier.name}/${p.id} does not render as a price`);
    }
    /* A LONGER PERIOD MUST NOT COST MORE THAN THE SHORTER ONES IT
       REPLACES. Six months at more than six monthlies is not a
       discount, it is a mistake nobody notices until a student does
       the arithmetic on a pricing page — and the whole reason the
       six-month row exists is that it maps to a semester. */
    const m = tier.prices.monthly;
    if (m !== null) {
      if (tier.prices.sixMonth !== null) {
        assert.ok(tier.prices.sixMonth < m * 6, `${tier.name}: six months costs more than six monthly payments`);
      }
      if (tier.prices.annual !== null) {
        assert.ok(tier.prices.annual < m * 12, `${tier.name}: a year costs more than twelve monthly payments`);
      }
    }
  }
  /* And the ranking: the tier with more credits costs more, at every
     period. Two tiers where the cheaper one buys more is the kind of
     thing that survives a review of each number on its own. */
  const byCredits = [...paid].sort((a, b) => a.credits - b.credits);
  for (let i = 1; i < byCredits.length; i++) {
    for (const p of PERIODS) {
      const lo = byCredits[i - 1].prices[p.id];
      const hi = byCredits[i].prices[p.id];
      if (lo === null || hi === null) continue;
      assert.ok(hi > lo, `${byCredits[i].name} buys more credits than ${byCredits[i - 1].name} but costs no more at ${p.id}`);
    }
  }
});

test("no tier sells a device limit while nothing enforces one — derived from the app, not from the copy", () => {
  /* JARED'S RULE: we do not sell limits we do not enforce, IN EITHER
     DIRECTION. Plus was dropped for charging for something every
     signed-in account already had. The Free tier's "on one device"
     was the same error mirrored — claiming a restriction that does
     not exist, which makes the paid tiers look like they lift
     something they do not.

     DERIVED, so it relaxes on its own. Order 5 computes
     `deviceStanding` in fetchUsage and returns it as `standing`; the
     ACTING half — shouldSignOut / shouldClaim — is called by no
     `.jsx`. While that is true, no tier's copy may mention a device
     count. Wire Order 5 and this guard stops applying without anyone
     having to remember it exists, which is the difference between a
     guard people satisfy and one they suppress.

     The alternative was a comment, and a comment is what let the
     bullet sit there through a pricing review. */
  const srcDir = path.join(rootDir, "src");
  const jsx = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".jsx"))
    .map((f) => fs.readFileSync(path.join(srcDir, f), "utf8"))
    // Comments first — this project has tripped that guard six times.
    .map((t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 "))
    .join("\n");
  assert.ok(jsx.length > 5000, "the jsx sweep read almost nothing — it would report 'unenforced' whatever the truth is");

  /* Named from deviceIdentity.js's exports rather than guessed, so a
     rename moves this with it. */
  const identity = fs.readFileSync(path.join(srcDir, "deviceIdentity.js"), "utf8");
  const actors = [...identity.matchAll(/export const (shouldSignOut|shouldClaim)\b/g)].map((m) => m[1]);
  /* assert.ok rather than assert.equal, and the shape matters: the
     vacuous-guards detector recognises `assert.ok(...length...)` and
     not `assert.equal(x.length, 2)`, so writing it the other way put
     this file on the unguarded list. It caught a real omission in
     form even though the count was asserted — worth satisfying in the
     shape the detector can see rather than raising its ceiling. */
  assert.ok(actors.length === 2, `deviceIdentity.js no longer exports the two acting helpers (found ${actors.join(", ") || "none"}) — re-point this guard`);

  const enforced = actors.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(jsx));

  const deviceClaims = TIERS.flatMap((tier) =>
    [tier.tagline, ...tier.features]
      .filter((line) => /\b(one|1|single|every|all|unlimited|multiple)\s+devices?\b/i.test(line))
      .map((line) => `${tier.name}: "${line}"`)
  );

  /* Order 5 wired: the copy may say what the app enforces. This branch
     is why the guard does not have to be deleted to let that through. */
  if (enforced) return;

  assert.deepEqual(
    deviceClaims,
    [],
    "the site sells a device limit while no screen acts on deviceStanding — Order 5's enforcing half is not wired, so this is a promise about behaviour the app does not have"
  );
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

/* ---------- the page itself ---------- */

/* COMMENTS STRIPPED BEFORE ANY OF THE GREPS BELOW, and this is the
   eighth time that has been necessary here. The page's own header
   comment names fonts.googleapis.com in order to say why the fonts are
   NOT loaded from it, and a check that trips over its own explanation
   is measuring the prose.

   HTML comments are safe to strip whole; in the script only BLOCK
   comments are, because every URL in it contains a double slash and a
   line-comment stripper would eat the code being checked. That
   asymmetry is instance six, learned once and reused. */
const stripHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, " ");
const stripBlockComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ");
const PAGE = stripHtmlComments(source("public/site/index.html"));
const PAGE_JS = stripBlockComments(source("public/site/site.js"));
/* One check needs the page WITH its comments — see the slot test. */
const PAGE_RAW = source("public/site/index.html");

test("THE PAGE MAKES NO THIRD-PARTY REQUEST — no host but this origin appears", () => {
  /* The claim the privacy policy makes is about this ORIGIN, so a
     marketing page pulling two fonts from Google would make it untrue
     — and the mockup did exactly that, which is the one place the
     markup departs from it.

     Every external-looking URL is enumerated with a reason rather than
     waved at, the same arrangement test-local-only.mjs uses: github.com
     is a download HREF (no request until a click), and a mailto is not
     a request at all. */
  const allowed = [/^https:\/\/github\.com\//, /^mailto:/];
  const urls = [...`${PAGE}\n${PAGE_JS}`.matchAll(/(?:https?:)?\/\/[^\s"'()<>]+/g)].map((m) => m[0]);
  const external = urls.filter((u) => !allowed.some((re) => re.test(u)));
  assert.deepEqual(external, [], `the page references external hosts: ${external.join(", ")}`);
  for (const host of ["fonts.googleapis.com", "fonts.gstatic.com", "api.github.com", "googletagmanager", "analytics"]) {
    assert.ok(!PAGE.includes(host), `the page still reaches ${host}`);
  }
  assert.ok(/@font-face/.test(PAGE), "the fonts are not self-hosted");
  for (const f of ["inter.woff2", "newsreader.woff2"]) {
    assert.ok(fs.existsSync(path.join(rootDir, "public/fonts", f)), `${f} is referenced but not committed`);
  }
});

test("the page ships no service worker and no manifest of its own", () => {
  /* Either would collide with the app's. A second worker at `/` is
     precisely the breakage this page exists to CLEAN UP, recreated
     deliberately; a manifest at `/` would make the browser offer to
     install the marketing site as the app. */
  assert.ok(!/serviceWorker\s*\.\s*register/.test(PAGE_JS), "the marketing page registers a service worker");
  assert.ok(!/manifest\.webmanifest/.test(PAGE), "the marketing page links a web app manifest");
});

test("it releases the service worker that used to own `/`", () => {
  /* Without this, an install from before the origin split keeps a
     worker scoped to `/`, which now controls this page — and OFFLINE
     that install opens the marketing site instead of the planner. It
     has to be in the first version of the page, because the window it
     covers is the transition itself. */
  assert.match(PAGE_JS, /getRegistrations\(\)/, "nothing enumerates the existing registrations");
  assert.match(PAGE_JS, /\br\.unregister\(\)/, "nothing actually unregisters anything");
  assert.match(PAGE_JS, /^releaseTheOldWorker\(\);$/m, "the cleanup is defined but never called");
  assert.match(PAGE_JS, /pathname === "\/"/, "the unregister is not scoped to the origin root");
  assert.match(PAGE_JS, /scope\.origin === location\.origin/, "it would unregister workers from another origin");
});

test("every in-page link points at something that exists", () => {
  /* The mockup's footer linked /terms when no terms page existed. A 404
     from the footer of a launch page is the cheapest possible mistake to
     make and one of the more embarrassing to ship.

     THE DOCUMENT HALF IS DERIVED NOW, and the reason is that the hand
     -written half had gone STALE IN THE FORBIDDING DIRECTION: this test
     ended with `assert.ok(!local.includes("/terms"))` — "no terms page
     exists" — which stopped being true when public/terms.html shipped.
     So the footer could not link the Terms document because a guard
     still believed it was missing, and the failure would have read as
     "your new link is broken" rather than "this line is out of date".
     That is the restatement pattern with the sign flipped: a list of
     what exists drifts into refusing what does.

     Every `*_URL` under SITE_URL is a document, its path is its
     filename, and the FILE must be there — so a new document is
     linkable the moment its constant exists, and a constant with no
     file still fails. The assets stay hand-declared, because they are
     files rather than documents and have no source of truth to derive
     from. */
  /* `DOCUMENT_PATHS` RATHER THAN "every _URL under SITE_URL", for the
     reason spelled out in legalLinks.js: since the path split APP_URL
     matches that shape too, and the planner is not a document with an
     HTML file behind it. */
  const documents = Object.fromEntries(links.DOCUMENT_PATHS.map((p) => [p, `public${p}.html`]));
  assert.ok(Object.keys(documents).length >= 4, "the published-document list came back short — this guard would refuse real links");

  const hrefs = [...PAGE.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const local = hrefs.filter((h) => h.startsWith("/") && !h.startsWith("//"));
  const exists = {
    ...documents,
    "/icon-192.png": "public/icon-192.png",
    "/apple-touch-icon.png": "public/apple-touch-icon.png",
    "/fonts/inter.woff2": "public/fonts/inter.woff2",
    "/fonts/newsreader.woff2": "public/fonts/newsreader.woff2",
  };
  for (const h of local) {
    assert.ok(exists[h], `the page links ${h}, which nothing in public/ serves`);
    assert.ok(fs.existsSync(path.join(rootDir, exists[h])), `${h} is linked but ${exists[h]} is missing`);
  }

  /* AND THE BUILT SITE MUST SERVE EVERY ONE OF THEM.

     THIS ASSERTION USED TO SAY THE OPPOSITE, and the inversion is the
     path split rather than a loosening. `dist-site` was an apex-only
     project that served no documents, so the build rewrote these links
     to absolute `www` URLs and this checked that none survived
     root-relative. One origin serves everything now — the documents
     are copied into the output — so root-relative is not merely
     allowed, it is CORRECT: it keeps an apex visitor on the apex
     instead of throwing them to `www` from a footer.

     What the guard is about did not change: a linked document must
     RESOLVE, checked against the built output where a missing copy
     would show. */
  const built = path.join(rootDir, "dist-site/index.html");
  assert.ok(fs.existsSync(built), "dist-site is missing — run the builds, or the published site is unverified");
  const builtHrefs = [...fs.readFileSync(built, "utf8").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const linkedDocs = builtHrefs.filter((h) => h in documents);
  assert.ok(linkedDocs.length > 0, "the built page links no published document — this check would pass over nothing");
  for (const p of linkedDocs) {
    assert.ok(
      fs.existsSync(path.join(rootDir, "dist-site", `${p.replace(/^\//, "")}.html`)),
      `the page links ${p} but the build serves no such document — it 404s on both hostnames`
    );
  }
});

test("the page's factual claims are ones the code can back", () => {
  /* Three claims on a public page that are checkable here, and were
     checked rather than assumed: the Sydney one against the privacy
     policy, the in-app deletion one against the code that does it, and
     the no-account one against the test that proves it. */
  assert.match(source("public/privacy.html"), /ap-southeast-2|Sydney/, "the page says Sydney and the policy does not");
  assert.ok(PAGE.includes("Stored in Sydney"), "the Sydney claim has gone from the page but stays in this test");
  assert.ok(
    fs.existsSync(path.join(rootDir, "src/accountDeletion.js")),
    "the page promises one-tap account deletion and the module that does it is gone"
  );
  assert.match(source("src/PlannerApp.jsx"), /deleteAccount\(/, "nothing in the app calls deleteAccount");
});

test("the page renders its tiers and downloads from data, never from typed HTML", () => {
  /* The mockup hard-coded two tiers, four download cards and a
     "Download for Windows" button. All three are facts that live in
     code — the tier table mirrors the server, the download names come
     from the build config, the button depends on the visitor — and a
     second copy in markup is a second copy to keep in step. */
  for (const slot of ["data-pricing", "data-downloads", "data-store-badges", "data-hero-cta"]) {
    assert.ok(PAGE_RAW.includes(slot), `the ${slot} slot is missing from the page`);
  }
  assert.ok(!/\$X\s*<small>/.test(PAGE), "a placeholder price is typed into the markup");
  assert.ok(!/60 hours of lecture/.test(PAGE), "the page still claims 60 hours a month, which no tier gives");
});

test("the release notes do not promise an update mechanism the app does not ship", () => {
  /* The workflow's release body said "It will update itself
     automatically." The desktop app bundles `electron` and
     `electron-builder` and NO `electron-updater`, and desktop/main.js
     has no autoUpdater — so nothing in it has ever checked for an
     update, and that sentence was published to anybody who downloaded
     a release.

     The same shape as the password-reset feature that had no ends: two
     plausible middle links (electron-builder writes latest.yml, the
     release publishes it) and no first or last one. The metadata is
     real and correct; the thing that would read it does not exist.

     DERIVED FROM THE DEPENDENCY rather than pinned to wording, so
     wiring an updater relaxes this guard on its own — the branch is
     the point, the way the device-count guard is written. */
  const desktop = JSON.parse(source("desktop/package.json"));
  const deps = { ...desktop.dependencies, ...desktop.devDependencies };
  const hasUpdater =
    "electron-updater" in deps ||
    /autoUpdater/.test(source("desktop/main.js"));

  const workflow = source(".github/workflows/build-apps.yml");
  assert.ok(workflow.includes("--notes"), "the release job no longer writes notes — this guard reads nothing");

  if (!hasUpdater) {
    /* THE DENIAL IS REMOVED FIRST, then the promise must be absent from
       what is left. Written the obvious way — a regex for "updates
       itself" — this tripped on the CORRECTED sentence, because "the
       desktop app does not update itself yet" contains the words it was
       looking for. That is the guard-trips-on-its-own-explanation shape
       from the CLAUDE.md ledger, arriving in a negation rather than in a
       comment, and the remedy is the one test-help.mjs already uses for
       the monthly-allowance sweep: name the sentence that DENIES the
       claim, take it out, and require the file to go quiet. */
    const DENIAL = /(does not|doesn't) update itself/i;
    assert.match(workflow, DENIAL, "the release notes neither promise nor deny self-updating — say which, since no updater ships");
    const withoutDenial = workflow.replace(new RegExp(DENIAL.source + "[^\\n]*", "gi"), " ");
    assert.doesNotMatch(
      withoutDenial,
      /updates? (itself|automatically)|automatic(ally)? updates?/i,
      "the release notes promise the app updates itself, but no updater ships in desktop/ — " +
        "wire electron-updater or do not make the claim"
    );
  }
});

test("the generated build facts really are what desktop/package.json says", () => {
  /* THE DERIVATION, CHECKED. build-web.mjs writes site/build-facts.js
     from desktop/package.json; if that generation silently stopped
     working, the page would go on serving whatever was committed last
     and every download button would 404 the day an artifact was
     renamed. */
  const facts = source("site/build-facts.js");
  assert.ok(facts.includes(JSON.stringify(desktopPkg.repository.url)), "the repository URL is stale");
  assert.ok(facts.includes(JSON.stringify(desktopPkg.build.productName)), "the product name is stale");
  for (const [key, cfg] of [["nsis", desktopPkg.build.nsis], ["portable", desktopPkg.build.portable], ["linux", desktopPkg.build.linux]]) {
    assert.ok(facts.includes(JSON.stringify(cfg.artifactName)), `the ${key} artifactName in build-facts.js is stale`);
  }
});

/* ---------- the store listing ---------- */

test("the store listing fits the limits Google actually enforces", () => {
  /* Over the limit, Play refuses to save the draft — after you have
     typed it. Under it by one character is fine; the point is that the
     copy lives where a test can count it rather than in a text box. */
  assert.ok(STORE_NAME.length <= LIMITS.name, `name is ${STORE_NAME.length} characters, limit ${LIMITS.name}`);
  assert.ok(
    SHORT_DESCRIPTION.length <= LIMITS.short,
    `short description is ${SHORT_DESCRIPTION.length} characters, limit ${LIMITS.short}`
  );
  assert.ok(
    FULL_DESCRIPTION.length <= LIMITS.full,
    `full description is ${FULL_DESCRIPTION.length} characters, limit ${LIMITS.full}`
  );
});

test("the listing links the two pages Play requires, at the paths that really serve them", () => {
  /* Derived from legalLinks rather than retyped: a store listing is the
     hardest place to fix a wrong URL, because it is reviewed. */
  assert.equal(`${SITE_URL}${PRIVACY_POLICY_PATH}`, PRIVACY_URL);
  assert.equal(`${SITE_URL}${ACCOUNT_DELETION_PATH}`, DELETE_ACCOUNT_URL);
});

test("the listing name matches the store record, and says so about the in-app name", () => {
  assert.equal(STORE_NAME, "UniPlanner", "the Play name must match the App Store record");
});

/* ---------- the recovery link that lands on the wrong page ---------- */

test("the marketing page forwards a recovery token to the app, hash intact", () => {
  /* REQUIRED BY BUILDS ALREADY IN THE STORES. PASSWORD_RESET_REDIRECT is
     baked in at build time, and the TestFlight build and the uploaded
     AAB both carry the BARE ORIGIN — which after the split is this
     page. Supabase recovery tokens are single-use, so a link that lands
     somewhere that cannot consume it is burnt, silently. */
  const src = fs.readFileSync(path.join(rootDir, "public/site/site.js"), "utf8");
  const body = src.slice(src.indexOf("function forwardRecoveryToTheApp"), src.indexOf("/* ---------- fill the slots"));
  assert.ok(body.length > 100, "forwardRecoveryToTheApp is gone from the marketing page");
  assert.match(src, /^forwardRecoveryToTheApp\(\);$/m, "it is defined but never called");

  /* APP_URL IS INJECTED, because it is an imported binding rather than
     a literal — and the REAL value, so this stays a test about where a
     token goes rather than about a string. */
  const run = (hash) => {
    let replaced = null;
    const location = { hash, replace: (u) => (replaced = u) };
    new Function("location", "URLSearchParams", "APP_URL", body + "; return forwardRecoveryToTheApp;")(
      location,
      URLSearchParams,
      APP_URL
    )();
    return replaced;
  };

  /* Forwarded, with the fragment carried across unchanged — the token
     is IN the fragment, so dropping it forwards an empty form. */
  const hash = "#access_token=abc&type=recovery&expires_in=3600";
  assert.equal(run(hash), `${APP_URL}/` + hash);
  /* An expired-link error rides the same fragment and belongs in the
     app too, where there is wording for it. */
  assert.equal(run("#error=access_denied&error_description=expired"), `${APP_URL}/#error=access_denied&error_description=expired`);
  /* ABSOLUTE, NOT `/app/`. This page is served on two HOSTNAMES and
     those are two ORIGINS; a relative forward would land an apex
     visitor on a planner whose localStorage nobody else shares, which
     is the data-loss the path split exists to avoid arriving by the
     back door. */
  assert.ok(run(hash).startsWith("https://"), "the recovery forward is relative — an apex visitor lands on the wrong origin");

  /* AND IT MUST NOT FIRE ON AN ORDINARY VISIT — a marketing page that
     bounces every reader to /app is worse than no page. */
  for (const quiet of ["", "#", "#features", "#access_token=abc&type=signup", "#type=recovery"]) {
    assert.equal(run(quiet), null, `the page forwarded on a hash it should ignore: "${quiet}"`);
  }
});

test("the app's reset destination and the forwarder agree on where the app lives", () => {
  /* If PASSWORD_RESET_REDIRECT moves to /app for new builds, the
     forwarder must point at the same place — otherwise old builds land
     one path away from where new ones do, and only one of them works. */
  /* `src`, not `links` — the module is imported at the top of this
     file under that name, and a local shadow made
     `links.PASSWORD_RESET_REDIRECT` a property of a STRING, which is
     `undefined` and compares unequal to everything. The assertion
     failed loudly, which is the good version of this mistake. */
  const src = fs.readFileSync(path.join(rootDir, "src/legalLinks.js"), "utf8");
  const m = /export const PASSWORD_RESET_REDIRECT = ([^;]+);/.exec(src);
  assert.ok(m, "PASSWORD_RESET_REDIRECT is gone from legalLinks.js");
  const site = fs.readFileSync(path.join(rootDir, "public/site/site.js"), "utf8");
  /* BOTH SIDES NAME THE SAME CONSTANT, which is stronger than "both
     strings match" and the only form that survives the app moving
     again. PASSWORD_RESET_REDIRECT is where NEW builds send a reset
     email; the forwarder is where OLD builds' emails get bounced to.
     One derived and the other typed is two half-working paths, and
     only the half nobody tests would break. */
  assert.equal(m[1].trim(), "APP_URL", "the reset email no longer goes to the app");
  assert.equal(links.PASSWORD_RESET_REDIRECT, APP_URL);
  assert.match(
    site,
    /location\.replace\(APP_URL \+ "\/" \+ hash\)/,
    "the forwarder no longer sends recovery links to APP_URL — a typed destination here is the drift this test exists for"
  );
  const facts = /export const APP_URL = "([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "site/build-facts.js"), "utf8"));
  assert.ok(facts, "APP_URL is gone from build-facts.js");
  assert.equal(facts[1], APP_URL, "the marketing page and the reset email disagree about where the app lives");
});

/* ---------- the apex build ---------- */

test("the app link is ABSOLUTE, so the page works off-origin", () => {
  /* Served from the apex, `/app` resolves to a path on a host that has
     no app. It was also wrong on `www`, where the planner is still at
     the root — the hero button 404s today. */
  const facts = fs.readFileSync(path.join(rootDir, "site/build-facts.js"), "utf8");
  const m = /export const APP_URL = "([^"]+)"/.exec(facts);
  assert.ok(m, "APP_URL is gone from build-facts.js");
  assert.match(m[1], /^https:\/\//, `APP_URL is "${m[1]}" — root-relative breaks the apex and any other host`);
  /* SAME ORIGIN AS THE SITE, AND DEEPER THAN IT. Both halves matter:
     a different origin is the subdomain plan that was ruled out and
     would strand localStorage; the same path is no split at all. */
  assert.ok(m[1].startsWith(`${SITE_URL}/`), "the app link is not on SITE_URL's origin — localStorage would not follow");
  assert.notEqual(m[1], SITE_URL, "the app link is the marketing page, so every 'Open the app' control is a loop");
  assert.equal(new URL(m[1]).origin, new URL(SITE_URL).origin);
  assert.ok(!/APP_PATH/.test(fs.readFileSync(path.join(rootDir, "public/site/site.js"), "utf8")), "the page still uses the old root-relative constant");
});

test("the apex build ships a page whose every link resolves", () => {
  /* THE ONE THAT ALREADY BIT. The build rewrites `./site.js` to
     `./site/site.js` and originally never copied site.js, so the page
     loaded, rendered its static markup, and filled in NO slots — no
     download buttons, no pricing, no worker release, no recovery
     forwarding — and nothing about it looked broken.

     Checked against the built output, because a rewrite that points
     somewhere is not the same claim as one that points at a file. */
  const out = path.join(rootDir, "dist-site");
  if (!fs.existsSync(out)) {
    /* Not built in this run. Say so rather than pass: a check that
       silently skips is the shape this project spends its discipline
       removing. */
    assert.fail("dist-site is missing — run `npm run build:site` before this suite, or the apex build is unverified");
  }
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((r) => r[1]);
  assert.ok(refs.length >= 8, `the apex page references ${refs.length} things — the markup did not survive the build`);

  const local = refs.filter((r) => !/^(https?:|mailto:|#|data:)/.test(r));
  assert.ok(local.length >= 2, "no local references at all — the rewrite took everything absolute, including the script");
  /* EXTENSIONLESS COUNTS AS PRESENT: Cloudflare Pages serves
     privacy.html at /privacy, and THAT is the canonical URL — the one
     in two store listings. */
  const missing = local.filter((r) => {
    const clean = r.split("#")[0].split("?")[0].replace(/^\.?\//, "");
    if (!clean) return false;
    return !fs.existsSync(path.join(out, clean)) && !fs.existsSync(path.join(out, `${clean}.html`));
  });
  assert.deepEqual(missing, [], `the page links to files that are not in the build: ${missing.join(", ")}`);

  /* THE LEGAL PAGES ARE IN THIS BUILD NOW, because one origin serves
     everything. Their URLs are in two store listings and a Stripe
     dashboard field, so a build that stopped copying one would 404 at
     a URL a reviewer already holds. */
  for (const p of links.DOCUMENT_PATHS) {
    assert.ok(
      fs.existsSync(path.join(out, `${p.replace(/^\//, "")}.html`)),
      `the build does not serve ${p}.html — ${SITE_URL}${p} 404s, and that URL is published`
    );
  }
  /* THE ROOT WORKER IS THE ONE THAT REMOVES ITSELF. This used to
     assert the path was EMPTY, on the reasoning that a 404 unregisters
     a stale worker — which is true of a 404 and production served
     none: the Pages origin fell back to index.html with a 200 and the
     www edge served the old worker out of its zone cache. The claim
     here is only that the root serves SOMETHING at that path, so no
     request reaches a fallback; what the file does is asserted
     behaviourally in test-path-split.mjs, which runs it. */
  assert.ok(fs.existsSync(path.join(out, "sw.js")), "the root serves no sw.js — an unmatched path falls back to HTML and the stale worker stays installed");
  assert.ok(fs.existsSync(path.join(out, "app", "sw.js")), "the app ships no worker at /app/");
  assert.notEqual(
    fs.readFileSync(path.join(out, "sw.js"), "utf8"),
    fs.readFileSync(path.join(out, "app", "sw.js"), "utf8"),
    "the root serves the APP's worker, which would claim scope / and cache the marketing page as a shell"
  );
});

test("every download card offers what its own data says it offers", () => {
  /* THE DEFECT THIS EXISTS FOR WAS LIVE, on production, on the one
     platform the whole Developer ID pipeline was built to serve.

     `fillDownloads` had three hand-written branches, one per platform,
     and the macOS one still carried its coming-soon shape: `href: null`
     and `label: c.soon`, both unconditional. `FLAGS.macDownload` has
     been true since signing landed, so `c.soon` is null — and the card
     rendered a DEAD "#" BUTTON LABELLED "null".

     EVERY GUARD IN THIS FILE WAS GREEN OVER IT. `downloads.js` had the
     right href all along, and `downloads.js` is what the suite tested:
     the data layer was correct, the renderer ignored it, and the two
     halves are each right on their own. That is exactly the shape the
     note-viewer bug had — read what the READER renders, not what the
     writer writes — so this mounts the BUILT page and reads the cards.

     Chromium is not needed: nothing here depends on layout. */
  const out = path.join(rootDir, "dist-site");
  assert.ok(fs.existsSync(path.join(out, "index.html")), "dist-site is missing — run `npm run build:site` before this suite");

  const bundle = path.join(os.tmpdir(), `site-cards-${process.pid}.js`);
  buildSync({ entryPoints: [path.join(out, "site/site.js")], bundle: true, format: "iife", outfile: bundle, logLevel: "silent" });

  const dom = new JSDOM(fs.readFileSync(path.join(out, "index.html"), "utf8"), {
    url: SITE_URL + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
  /* A Mac visitor, so the card under repair is also the LEAD one. */
  Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });
  const tag = w.document.createElement("script");
  tag.textContent = fs.readFileSync(bundle, "utf8");
  w.document.body.appendChild(tag);
  fs.rmSync(bundle, { force: true });

  const rendered = [...w.document.querySelectorAll("[data-downloads] .d")].map((card) => ({
    title: card.querySelector("h4")?.textContent,
    label: card.querySelector("a.dbtn")?.textContent,
    href: card.querySelector("a.dbtn")?.getAttribute("href"),
    note: card.querySelector(".dnote")?.textContent || null,
  }));
  /* NON-VACUITY FIRST: an empty page satisfies every claim below. */
  assert.ok(rendered.length >= 3, `only ${rendered.length} card(s) rendered — the probe is reading the wrong element`);

  /* The claim, and it is about ALL of them rather than about macOS: a
     card that is offered must be a card that works. "null" is asserted
     by name because it is what `esc()` makes of a missing label, and it
     is what a student actually saw. */
  for (const c of rendered) {
    assert.ok(c.label, `the ${c.title} card has no button`);
    assert.notEqual(c.label, "null", `the ${c.title} card's button is labelled "null" — a missing value reached the page`);
    assert.notEqual(c.label, "undefined", `the ${c.title} card's button is labelled "undefined"`);
    if (c.href !== "#") assert.ok(/^https?:\/\//.test(c.href), `the ${c.title} card links to "${c.href}"`);
  }

  /* THE NAMES ARE DERIVED, NOT TYPED. This read `byTitle("macOS")`,
     and renaming the card to "Mac" — one word, in the data layer —
     broke a guard that exists to check the card's LINK. A test that
     pins what a platform is CALLED cannot survive it being called
     something else, which is the ledger's first entry in the smallest
     possible costume. The card's own `label` is what the renderer puts
     in the heading, so asking `downloadsFor` for it is asking the one
     source both sides already read. */
  const named = downloadsFor("mac", {
    slug: { owner: "o", repo: "r" },
    assets: { windowsInstaller: "w.exe", windowsPortable: "p.exe", linuxAppImage: "l.AppImage", macDmg: "m.dmg" },
  });
  const labelOf = (id) => named.cards.find((c) => c.id === id).label;
  const byTitle = (t) => rendered.find((c) => c.title === t);
  const mac = byTitle(labelOf("mac"));
  assert.ok(mac, `no ${labelOf("mac")} card among: ${rendered.map((c) => c.title).join(", ")}`);
  const dmg = assetName(desktopPkg.build.dmg.artifactName, { productName: desktopPkg.build.productName, ext: "dmg" });
  if (FLAGS.macDownload) {
    assert.ok(mac.href.endsWith("/" + dmg), `the macOS button points at "${mac.href}", which is not the ${dmg} the build produces`);
    /* THE INSTALL NOTE, by instruction and in the same slot the Windows
       one uses — a .dmg is a disk image, and a student who runs the app
       from inside it has installed nothing and loses it on eject. */
    assert.ok(mac.note, "the macOS card offers a disk image with no word about what to do with it");
    assert.match(mac.note, /Applications/, `the macOS note does not mention the Applications folder: "${mac.note}"`);
  } else {
    assert.equal(mac.href, "#", "an unsigned Mac build must not be downloadable");
  }

  /* The other two, so a renderer that special-cases macOS back into
     existence cannot pass by fixing only the card this test is named
     for. Both notes come off the same card field the macOS one does. */
  assert.ok(byTitle(labelOf("linux")).note, "the Linux card lost its AppImage note");
  assert.equal(
    Boolean(byTitle(labelOf("windows")).note),
    FLAGS.windowsUnsignedNote,
    "the Windows note no longer follows FLAGS.windowsUnsignedNote — the flag turns off a sentence nobody sees, or leaves one nobody wants"
  );
});

/* ==================================================================
   THE PAGE FOLLOWS THE VISITOR, AND NOTHING SURVIVES ITS OWN FLAG

   Three claims, all of them about the RENDERED page rather than the
   data layer — which is the distinction the dead "null" button was
   made of: `downloads.js` was right the whole time and nothing read
   what the renderer produced.
   ================================================================== */

/** Mount the built page as a given platform and hand back the document. */
function renderSiteAs(userAgent, { maxTouchPoints = 0 } = {}) {
  const out = path.join(rootDir, "dist-site");
  const bundle = path.join(os.tmpdir(), `site-plat-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  buildSync({ entryPoints: [path.join(out, "site/site.js")], bundle: true, format: "iife", outfile: bundle, logLevel: "silent" });
  const dom = new JSDOM(fs.readFileSync(path.join(out, "index.html"), "utf8"), {
    url: SITE_URL + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
  Object.defineProperty(w.navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(w.navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
  const tag = w.document.createElement("script");
  tag.textContent = fs.readFileSync(bundle, "utf8");
  w.document.body.appendChild(tag);
  fs.rmSync(bundle, { force: true });
  return w.document;
}

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  linux: "Mozilla/5.0 (X11; Linux x86_64)",
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  android: "Mozilla/5.0 (Linux; Android 14; moto g05)",
};

test("the hero button offers THIS machine's build, and never one that does not exist", () => {
  /* IT USED TO BE A TABLE OF PLATFORMS with `mac: "Open the web app"`
     written into it before the Mac build was signed — so a signed,
     notarised .dmg sat in the download box while the button above it
     sent Mac visitors away. The claim is that the button and the card
     cannot disagree, so it is checked on the RENDERED page for every
     platform rather than on the label table. */
  const seen = {};
  for (const [name, ua] of Object.entries(UA)) {
    const doc = renderSiteAs(ua, { maxTouchPoints: name === "ios" ? 5 : 0 });
    const cta = doc.querySelector("[data-hero-cta]");
    assert.ok(cta, `${name}: no hero button rendered — the probe is reading the wrong element`);
    seen[name] = { text: cta.textContent.trim(), href: cta.getAttribute("href") };
    assert.ok(seen[name].text, `${name}: the hero button has no words on it`);
    assert.doesNotMatch(seen[name].text, /null|undefined/, `${name}: "${seen[name].text}" reached the hero button`);
  }
  /* NON-VACUITY: the platforms must not all get the same button, or
     this test is one assertion run five times. */
  assert.ok(new Set(Object.values(seen).map((x) => x.text)).size > 1, "every platform gets the same hero button");

  /* A DESKTOP PLATFORM WITH A LIVE CARD IS OFFERED IT, by name. */
  for (const id of ["windows", "mac", "linux"]) {
    const card = downloadsFor(id, {
      slug: { owner: "o", repo: "r" },
      assets: { windowsInstaller: "w.exe", windowsPortable: "p.exe", linuxAppImage: "l.AppImage", macDmg: "m.dmg" },
    }).cards.find((c) => c.id === id);
    if (!card.available) continue;
    assert.equal(
      seen[id].text,
      `Download for ${card.label}`,
      `${id} has a download and the hero button says "${seen[id].text}"`
    );
    assert.equal(seen[id].href, "#download", `${id}'s hero button should go to the downloads box`);
  }

  /* A PHONE HAS NO DESKTOP BUILD, so it gets the app rather than a
     downloads box with nothing in it — `lead` falls back to Windows
     for ordering and must not reach the button. */
  for (const id of ["ios", "android"]) {
    assert.doesNotMatch(seen[id].text, /^Download for/, `${id} was offered a desktop download: "${seen[id].text}"`);
    assert.equal(seen[id].href, APP_URL, `${id}'s hero button goes to "${seen[id].href}" rather than the app`);
  }
});

test("the store badges lead with the visitor's store, and still name the other", () => {
  /* ORDERED, NOT FILTERED — the rule downloadsFor states for the cards.
     Somebody on a laptop looking for the phone app is the ordinary
     case, so hiding a store is the trap; leading with theirs is the
     convenience. */
  const order = (ua, touch) =>
    [...renderSiteAs(ua, { maxTouchPoints: touch }).querySelectorAll("[data-store-badges] .badge b")].map(
      (b) => b.textContent
    );
  const onIos = order(UA.ios, 5);
  const onAndroid = order(UA.android, 5);
  const onDesktop = order(UA.windows, 0);

  assert.equal(onIos.length, 2, `the iOS visitor sees ${onIos.length} badge(s) — a store was hidden rather than moved`);
  assert.deepEqual([...onIos].sort(), [...onAndroid].sort(), "the two phones are offered different sets of stores");
  assert.deepEqual([...onIos].sort(), [...onDesktop].sort(), "a desktop visitor is offered a different set of stores");

  assert.equal(onIos[0], "App Store", `an iPhone leads with "${onIos[0]}"`);
  assert.equal(onAndroid[0], "Google Play", `an Android phone leads with "${onAndroid[0]}"`);
  /* AND THE TWO REALLY DIFFER, so a renderer that ignores the platform
     cannot satisfy both lines above by accident. */
  assert.notDeepEqual(onIos, onAndroid, "the badge order does not follow the platform at all");
});

test("no note survives the flag it describes — the box note comes off the cards", () => {
  /* THE DEFECT, IN PROSE: "Mac: a desktop build exists but is not
     signed by Apple yet. Use the web app in the meantime." was written
     into index.html and was still under a signed, notarised,
     downloadable .dmg. The remedy is the dead-button remedy — there is
     no longer anywhere to write a sentence about a platform that is not
     beside that platform's own availability. */
  const html = fs.readFileSync(path.join(rootDir, "public/site/index.html"), "utf8");
  const body = html.replace(/<!--[\s\S]*?-->/g, " ");
  assert.doesNotMatch(body, /not signed by Apple/i, "the pre-signing Mac note is back in the page");

  const doc = renderSiteAs(UA.mac);
  const slot = doc.querySelector("[data-downloads-note]");
  assert.ok(slot, "the derived note has no slot — the renderer has nowhere to put it");
  const shown = [...slot.querySelectorAll("p")].map((p) => p.textContent);
  const cards = downloadsFor("mac", {
    slug: { owner: "o", repo: "r" },
    assets: { windowsInstaller: "w.exe", windowsPortable: "p.exe", linuxAppImage: "l.AppImage", macDmg: "m.dmg" },
  }).cards;
  const missing = cards.filter((c) => !c.available);
  assert.equal(
    shown.length,
    missing.filter((c) => c.instead).length,
    `${shown.length} note(s) rendered for ${missing.length} unavailable platform(s): ${shown.join(" | ")}`
  );
  /* THE CLAIM THAT MATTERS, stated over every card rather than over
     macOS: a platform you can download must not carry a sentence about
     not being able to. */
  for (const c of cards) {
    if (!c.available) continue;
    assert.ok(
      !shown.some((t) => t.startsWith(`${c.label}:`)),
      `${c.label} is downloadable and the box still carries a note about it: ${shown.join(" | ")}`
    );
  }
});

test("the AI notes section no longer advertises readings", () => {
  /* Removed by instruction (Jared, 16 September 2026). Asserted on the
     SECTION rather than on the whole page, because "readings" is a real
     feature named legitimately elsewhere — the reading planner is in
     the "And the rest of it" grid — and a page-wide ban would be a
     guard that has to be suppressed to let that stay. */
  const html = fs.readFileSync(path.join(rootDir, "public/site/index.html"), "utf8");
  const start = html.indexOf("How the AI notes work");
  assert.ok(start > 0, "the AI notes section is gone — this guard is reading the wrong page");
  const section = html.slice(start, html.indexOf("</section>", start));
  assert.doesNotMatch(section, /It also does readings/i, "the readings paragraph is back under the AI notes steps");
  /* Non-vacuity: the section still has its three steps, so the
     assertion above is not passing over an emptied block. */
  assert.equal((section.match(/class="stepn"/g) || []).length, 3, "the AI notes section lost its steps");
});

await test("A TAGGED RELEASE TAKES ITS VERSION FROM THE TAG, not from a file somebody forgot", () => {
  /* v1.1.1 through v1.1.6 all shipped installers and `latest*.yml`
     manifests advertising 1.1.0, because this workflow triggers on `v*`
     and then read the tag for nothing: electron-builder takes the
     version from desktop/package.json, and nobody had bumped it since
     the 1.1.0 release.

     SILENT IN BOTH DIRECTIONS, which is why six releases went by.
     Nothing errors at build time, and no electron-updater is wired —
     so the day one is, it offers 1.1.0 to somebody already on 1.1.0
     and does nothing at all.

     CLAUDE.md recorded this exact trap at v1.0.1, and the remedy then
     was to bump the file by hand. This asserts the DERIVATION instead,
     because the hand-bump is the step that stopped happening. */
  const wf = fs.readFileSync(path.join(rootDir, ".github/workflows/build-apps.yml"), "utf8");

  /* THE STEP IS RUN, NOT READ, and the first version of this test is
     why. It grepped for `GITHUB_REF_NAME#v` — which appears in BOTH
     the derivation step and the readback step below it — so replacing
     the derivation with a hardcoded 1.1.0 left the guard green on the
     surviving occurrence. Two occurrences and one loose pattern is a
     guard that checks whichever happens to survive, which is the
     `spctl --assess` hole one workflow over.

     So the step's own script is extracted and EXECUTED against a fake
     tag environment over throwaway package.json files, and what is
     asserted is the three versions it produces. The expected value is
     derived from the fake tag rather than typed beside it. */
  const step = wf.split("- name: Take the marketing version from the tag")[1];
  assert.ok(step, "the version-from-tag step is gone");
  const script = step.split("run: |")[1].split("\n      - name:")[0];
  assert.ok(script && script.includes("GITHUB_REF_TYPE"), "the step's script could not be extracted");
  const dedented = script.split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ver-"));
  try {
    fs.mkdirSync(path.join(dir, "desktop"));
    fs.mkdirSync(path.join(dir, "mobile"));
    for (const f of ["package.json", "desktop/package.json", "mobile/package.json"]) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ name: "x", version: "0.0.1" }, null, 2) + "\n");
    }
    const sh = path.join(dir, "step.sh");
    fs.writeFileSync(sh, dedented);

    const TAG = "v9.8.7";
    execFileSync("bash", [sh], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: TAG },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const expected = TAG.slice(1);
    for (const f of ["package.json", "desktop/package.json", "mobile/package.json"]) {
      const got = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).version;
      assert.equal(got, expected, `on tag ${TAG}, ${f} came out at ${got} rather than ${expected}`);
    }

    /* THE CONTROL: a manual dispatch has no tag, so it must leave the
       committed version alone. Without this, a step that rewrote the
       files unconditionally would satisfy everything above. */
    for (const f of ["package.json", "desktop/package.json", "mobile/package.json"]) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ name: "x", version: "0.0.1" }, null, 2) + "\n");
    }
    execFileSync("bash", [sh], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version,
      "0.0.1",
      "a manual dispatch rewrote the version, so the tag branch is not what is being measured"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* AND THE READBACK EXISTS, before the twenty-minute package step: a
     derivation that silently did not take is the same bug again. */
  assert.match(wf, /building tag .* but the version is/, "nothing refuses a tag build whose version does not match the tag");

  /* THE COMMITTED VERSION MUST STILL BE SANE, because a manual
     dispatch has no tag and falls back to it. Compared ACROSS the
     three files rather than pinned to a number, so a bump needs no
     test edit. */
  const v = (f) => JSON.parse(fs.readFileSync(path.join(rootDir, f), "utf8")).version;
  assert.equal(v("desktop/package.json"), v("package.json"), "desktop/package.json disagrees with the root version");
  assert.equal(v("mobile/package.json"), v("package.json"), "mobile/package.json disagrees with the root version");
  assert.match(v("package.json"), /^\d+\.\d+\.\d+$/, `the root version is not a release version: ${v("package.json")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
