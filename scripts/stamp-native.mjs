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
/* iPhone ONLY for the first submission, and it is a decision rather
   than a limitation.

   Nothing is broken on iPad — the whole app is one `mx-auto max-w-2xl`
   column, so it renders as a phone-shaped app centred on a big screen
   and nothing overflows. What is missing is a DESIGN for 1366 points,
   which is Grace's call, plus a second full screenshot set, while the
   thing that actually binds the calendar is the closed test.

   THE DIRECTION MATTERS. Going universal later is this setting plus
   screenshots. Going iPhone-only later is REMOVING platform support
   from people who already installed it, which is the direction that
   generates one-star reviews. So the reversible choice is the one to
   ship.

   "1" is iPhone/iPod, "2" is iPad; Capacitor's template ships "1,2". */
export const IOS_DEVICE_FAMILY = "1";

export const ANDROID_MIN_SDK = 26;
export const ANDROID_REQUIRED_TARGET_SDK = 36;

/* Deliberately identical in shape to Capacitor's own, which declares
   nothing on all four keys. Each is a claim about the APP BINARY:
   it calls no required-reason API, it collects nothing itself (the
   account data is declared in App Store Connect), it contacts no
   tracking domain, and it does not track. */
export const PRIVACY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSPrivacyAccessedAPITypes</key>
\t<array/>
\t<key>NSPrivacyCollectedDataTypes</key>
\t<array/>
\t<key>NSPrivacyTrackingDomains</key>
\t<array/>
\t<key>NSPrivacyTracking</key>
\t<false/>
</dict>
</plist>
`;

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
  editFile(pbxproj, "iOS version, build, deployment target and device family", (s) =>
    s
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
      .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
      .replace(/IPHONEOS_DEPLOYMENT_TARGET = [^;]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`)
      .replace(/TARGETED_DEVICE_FAMILY = [^;]+;/g, `TARGETED_DEVICE_FAMILY = "${IOS_DEVICE_FAMILY}";`)
  );

  /* ---- the privacy manifest ----

     Apple requires one per binary. Capacitor ships its own for the pod
     (all four keys empty, checked against @capacitor/ios 8.5.0), which
     covers the framework and not the app target.

     OURS SAYS THE SAME THING AND EVERY LINE OF IT IS CHECKABLE. The app
     target carries no Swift of our own beyond Capacitor's template, so
     it calls none of the required-reason APIs; nothing third-party is
     in the bundle, so there are no tracking domains; and the app does
     not track. What the student's ACCOUNT collects — an email address,
     the planner's contents — is declared in App Store Connect's privacy
     questionnaire, which is where a first-party app declares it, and
     the published policy is the same answer in prose.

     WRITING THE FILE IS NOT ENOUGH AND THE SCRIPT SAYS SO. A
     .xcprivacy has to be in the app target's Resources build phase or
     it never reaches the bundle, and that is a change to project.pbxproj
     which this script will not attempt blind. The file is created; the
     one Xcode step is on MOBILE-BUILD.md's list beside choosing the
     signing team, which is manual for the same reason; and the check
     below catches the half-done state, which is the one that ships. */
  const privacyPath = path.join(rootDir, "mobile/ios/App/App/PrivacyInfo.xcprivacy");
  if (fs.existsSync(path.dirname(privacyPath))) {
    if (!fs.existsSync(privacyPath)) {
      fs.writeFileSync(privacyPath, PRIVACY_MANIFEST);
      edits.push("iOS privacy manifest (created — ADD IT TO THE TARGET IN XCODE)");
    } else {
      edits.push("iOS privacy manifest (already present)");
    }
  } else {
    skipped.push("iOS privacy manifest");
  }

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
  /* THE HALF-DONE STATE IS THE ONE THAT SHIPS: the file on disk, absent
     from the target, so it is not in the bundle and Apple's validator
     complains after the upload. Reading the pbxproj catches it here. */
  const iosProject = path.join(rootDir, "mobile/ios/App/App.xcodeproj/project.pbxproj");
  if (fs.existsSync(iosProject) && !read(iosProject).includes("PrivacyInfo.xcprivacy")) {
    console.error(
      "\nWARNING: mobile/ios/App/App/PrivacyInfo.xcprivacy is not referenced by the Xcode project, " +
        "so it will not be in the built bundle. In Xcode: drag it into the App group and tick the App target."
    );
  }

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
