/* Stamps the settings that must agree across three build systems into
   the generated native projects.
 *
 * WHY A SCRIPT AND NOT COMMITTED FILES: mobile/ios and mobile/android are
 * gitignored and rebuilt per machine (`cap add`), so anything set inside
 * them is lost on the next scaffold. That is the same reason
 * mobile/scripts/native-permissions.mjs exists. Missing platforms are
 * skipped, not an error — most people only ever add one.
 *
 * Run via `npm run stamp` from the repo root, or automatically after
 * `cap add` / `cap sync` from the mobile folder.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(p, "utf8");
const pkg = JSON.parse(read(path.join(rootDir, "package.json")));

/* ---------- the two kinds of version, and why they differ ----------

   MARKETING VERSION is what a person reads: 1.0.0, semantic, from the
   root package.json. Cosmetic — no store enforces it.

   BUILD NUMBER is what the stores enforce. Android `versionCode` and iOS
   `CFBundleVersion` must STRICTLY INCREASE on every upload, and a store
   rejects a build that reuses one. That rejection lands after a long
   upload, when you are already trying to ship a fix, which is the worst
   possible moment to discover a number nobody remembered to bump.

   So it is DERIVED, not remembered: minutes elapsed since 2020-01-01
   UTC. Properties that matter:

     - monotonic by construction; there is no state to keep and nothing
       to forget
     - independent of the marketing version, so a REJECTED build can be
       rebuilt and re-uploaded without inventing a new version number --
       which is exactly the case that breaks a scheme tied to the version
     - the same commit rebuilt tomorrow gets a higher number, which a
       git-commit-count scheme cannot do
     - Android's versionCode is a signed 32-bit int capped at
       2,100,000,000. Minutes since 2020 is ~3.5 million now and grows by
       ~525,600 a year, so this has roughly four thousand years of
       headroom.

   Minutes rather than seconds because seconds would burn the 32-bit
   range in ~66 years and buys nothing: nobody uploads twice a minute. */
const BUILD_EPOCH = Date.UTC(2020, 0, 1);
export const buildNumber = (now = Date.now()) => Math.floor((now - BUILD_EPOCH) / 60000);

/* ---------- settings that are decisions, not defaults ---------- */

/* The home-screen label. "University Planner" is 18 characters and iOS
   truncates around 12, so it would show as "University…" on the device
   someone just installed it to. The STORE LISTING name is separate and
   can stay long. */
export const DISPLAY_NAME = "UniPlanner";

/* iOS 15, not Capacitor's default of 14. Everything this app leans on --
   MediaRecorder, IndexedDB, pointer pressure for the Pencil -- is more
   reliable above 14, and 15 still covers every device a student is
   realistically carrying. */
export const IOS_DEPLOYMENT_TARGET = "15.0";

/* Android 8.0. Capacitor defaults to 24 (Android 7, 2016); 26 drops a
   compatibility surface for a device population that barely exists.
   NOTE this is the MINIMUM, which is ours to choose. The TARGET is not:
   Google Play requires new apps to target API 36 from 31 August 2026.
   Capacitor's template already sets 36 -- verify it in the generated
   variables.gradle rather than trusting this comment. */
export const ANDROID_MIN_SDK = 26;
export const ANDROID_REQUIRED_TARGET_SDK = 36;

const edits = [];
const skipped = [];

function editFile(file, label, fn) {
  if (!fs.existsSync(file)) return skipped.push(label);
  const before = read(file);
  const after = fn(before);
  if (after !== before) fs.writeFileSync(file, after);
  edits.push(`${label}${after === before ? " (already correct)" : ""}`);
}

export function stamp({ now = Date.now() } = {}) {
  const version = pkg.version;
  const build = buildNumber(now);

  /* ---- desktop ---- */
  const desktopPkgPath = path.join(rootDir, "desktop/package.json");
  editFile(desktopPkgPath, "desktop/package.json version", (s) => {
    const d = JSON.parse(s);
    d.version = version;
    return `${JSON.stringify(d, null, 2)}\n`;
  });

  /* ---- iOS ---- */
  const pbxproj = path.join(rootDir, "mobile/ios/App/App.xcodeproj/project.pbxproj");
  editFile(pbxproj, "iOS version, build and deployment target", (s) =>
    s
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
      .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
      .replace(/IPHONEOS_DEPLOYMENT_TARGET = [^;]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`)
  );

  const iosPlist = path.join(rootDir, "mobile/ios/App/App/Info.plist");
  editFile(iosPlist, "iOS display name", (s) =>
    s.includes("CFBundleDisplayName")
      ? s.replace(
          /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
          `$1${DISPLAY_NAME}$2`
        )
      : s.replace(
          "<dict>",
          `<dict>\n\t<key>CFBundleDisplayName</key>\n\t<string>${DISPLAY_NAME}</string>`
        )
  );

  /* ---- Android ---- */
  const gradle = path.join(rootDir, "mobile/android/app/build.gradle");
  editFile(gradle, "Android versionName and versionCode", (s) =>
    s.replace(/versionName ".*?"/, `versionName "${version}"`).replace(/versionCode \d+/, `versionCode ${build}`)
  );

  const variables = path.join(rootDir, "mobile/android/variables.gradle");
  editFile(variables, "Android minSdkVersion", (s) =>
    s.replace(/minSdkVersion = \d+/, `minSdkVersion = ${ANDROID_MIN_SDK}`)
  );

  const strings = path.join(rootDir, "mobile/android/app/src/main/res/values/strings.xml");
  editFile(strings, "Android display name", (s) =>
    s
      .replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${DISPLAY_NAME}$2`)
      .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${DISPLAY_NAME}$2`)
  );

  return { version, build, edits, skipped };
}

/* Run directly, not when imported by a test. */
if (process.argv[1] && process.argv[1].endsWith("stamp-native.mjs")) {
  const r = stamp();
  console.log(`version ${r.version}, build ${r.build}`);
  for (const e of r.edits) console.log(`  stamped  ${e}`);
  for (const s of r.skipped) console.log(`  skipped  ${s} (platform not added yet)`);

  /* The target SDK is the one number here that a store enforces and that
     we do NOT set — Capacitor's template does. Check it rather than
     assume it, because being below it blocks submission outright. */
  const variables = path.join(rootDir, "mobile/android/variables.gradle");
  if (fs.existsSync(variables)) {
    const found = read(variables).match(/targetSdkVersion = (\d+)/);
    const target = found ? Number(found[1]) : 0;
    if (target < ANDROID_REQUIRED_TARGET_SDK) {
      console.error(
        `\nWARNING: targetSdkVersion is ${target}. Google Play requires ${ANDROID_REQUIRED_TARGET_SDK} ` +
          "for new apps from 31 August 2026 — a lower value is rejected at submission."
      );
    } else {
      console.log(`  target SDK ${target} meets the Play requirement (${ANDROID_REQUIRED_TARGET_SDK})`);
    }
  }
}
