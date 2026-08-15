/* Applies the RELEASE SIGNING configuration to the generated Android
   project — the same way native-permissions.mjs applies the microphone
   declarations, and for the same reason: `mobile/android/` is untracked
   and regenerated per machine, so a hand-edited build.gradle is wiped by
   the next `cap add`. Anything that has to survive regeneration has to
   be re-applied by a script.

   WHAT IT INSERTS. The standard Android arrangement: build.gradle loads
   `mobile/key.properties` if it exists and defines a release
   signingConfig from it. When the file is absent — every machine except
   the one that builds releases — the patch is inert: debug builds work
   exactly as before, and `bundleRelease` produces an UNSIGNED bundle
   rather than failing, which Play rejects at upload with a clear message
   instead of a Gradle stack trace here.

   WHERE THE SECRETS LIVE, and why there are two places:

     the keystore   OUTSIDE the repository entirely (e.g. a keystores
                    folder in the home directory). It must never be in
                    the repo, and `mobile/android/` is no safer than the
                    repo root: that folder is deleted and regenerated
                    freely, which is exactly what must never happen to a
                    keystore.
     key.properties `mobile/key.properties` — beside, not inside, the
                    generated project, so regenerating the project does
                    not destroy it. Gitignored by name, and a test
                    asserts the ignore entries exist, because one
                    `git add -A` after creating it is otherwise enough
                    to publish the store passwords.

   The gradle reads it as rootProject.file("../key.properties"):
   rootProject is mobile/android/, so ../ is mobile/. `storeFile` inside
   key.properties should be an ABSOLUTE path to the keystore, which
   sidesteps Gradle's module-relative path resolution entirely.

   Idempotent: the marker comment is the guard, so `npm run sync` can run
   this every time. An already-patched gradle is left alone even if this
   script's output changes shape — same policy as the plist patch, where
   silently rewriting someone's deliberate edit would be worse than
   leaving it. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "uni-planner:release-signing";

export const KEY_PROPERTIES_NAME = "key.properties";

const GRADLE_PATH = path.join("android", "app", "build.gradle");

/* Everything before `android {` — loads the properties file when it
   exists. Declared once, above the android block, so the signingConfig
   and the buildType can both see it. */
const loadBlock = `// ${MARKER} — applied by mobile/scripts/native-signing.mjs; do not edit here.
def keystorePropertiesFile = rootProject.file("../${KEY_PROPERTIES_NAME}")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

`;

const signingConfigsBlock = `    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
            }
        }
    }
`;

/**
 * Adds the release signing arrangement to an app/build.gradle.
 *
 * Returns `{ gradle, changed, reason }`, the same contract as
 * patchInfoPlist / patchAndroidManifest so the three read alike.
 */
export function patchBuildGradle(source) {
  if (source.includes(MARKER)) {
    return { gradle: source, changed: false, reason: "already present" };
  }

  const androidOpen = source.match(/^android \{$/m);
  if (!androidOpen) {
    throw new Error("app/build.gradle has no `android {` block — has Capacitor's template changed shape?");
  }

  let gradle = source.replace(/^android \{$/m, loadBlock + "android {\n" + signingConfigsBlock.replace(/\n$/, ""));

  /* Wire the release build type to it. Capacitor's template has a
     buildTypes.release block; signingConfig goes inside it, guarded so
     a machine with no key.properties builds unsigned rather than
     erroring. If the template ever loses the block, fail loudly — a
     silently unsigned release that LOOKS configured is the bad outcome. */
  const releaseType = gradle.match(/(buildTypes \{[\s\S]*?release \{)/);
  if (!releaseType) {
    throw new Error("app/build.gradle has no buildTypes.release block to attach the signingConfig to");
  }
  gradle = gradle.replace(
    releaseType[1],
    releaseType[1] +
      `\n            if (keystorePropertiesFile.exists()) {\n                signingConfig signingConfigs.release\n            }`
  );

  return { gradle, changed: true, reason: "added" };
}

/* ---- apply to the generated project, if it exists ---- */

const mobileDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const gradlePath = path.join(mobileDir, GRADLE_PATH);
  if (!fs.existsSync(gradlePath)) {
    console.log("native-signing: no android project (run `npx cap add android` first) — skipped");
    return;
  }
  const before = fs.readFileSync(gradlePath, "utf8");
  const { gradle, changed, reason } = patchBuildGradle(before);
  if (changed) {
    fs.writeFileSync(gradlePath, gradle);
    console.log(`native-signing: release signing config ${reason} in app/build.gradle`);
  } else {
    console.log(`native-signing: ${reason}`);
  }

  const props = path.join(mobileDir, KEY_PROPERTIES_NAME);
  if (fs.existsSync(props)) {
    console.log(`native-signing: ${KEY_PROPERTIES_NAME} found — release builds will be SIGNED`);
  } else {
    console.log(`native-signing: no ${KEY_PROPERTIES_NAME} — debug builds unaffected, release would be unsigned`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
