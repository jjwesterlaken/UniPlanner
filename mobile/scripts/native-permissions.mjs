/* Adds the microphone declarations the AI lecture notes recorder needs to
   the generated native projects.

   `cap add ios` / `cap add android` scaffold Info.plist and
   AndroidManifest.xml from Capacitor's stock templates, neither of which
   declares a microphone. Without those declarations `getUserMedia` inside
   the WebView fails: iOS rejects the call outright (and App Store review
   rejects a build whose usage string is missing), while Android's
   permission prompt never appears, so recording a lecture silently can't
   start.

   Those generated folders are deliberately untracked (they're rebuilt per
   machine), so the strings can't simply be committed once — they have to
   be re-applied after every `cap add`. This script does that, and is
   idempotent so `npm run sync` can run it every time.

   Run directly (`node scripts/native-permissions.mjs`) or via
   `npm run permissions` from the `mobile` folder. Missing platforms are
   skipped, not an error — most people only ever add one. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Apple shows this verbatim in the permission dialog, so it has to say
   what the mic is for AND where the audio goes. Kept consistent with the
   in-app consent wording (CONSENT_TEXT in src/aiNotesLogic.js): both
   promise the recording is deleted as soon as it has been transcribed.
   That exact phrase is what a test greps for in both files, so if one
   changes, change the other. Note it is a promise about the AUDIO only
   — the transcript has its own, longer retention, and conflating them
   here would make this dialog inaccurate. */
export const MIC_USAGE_DESCRIPTION =
  "University Planner uses your microphone to record lectures so it can " +
  "generate an AI summary and study cards. Your recording is sent to a " +
  "transcription service and is deleted as soon as it has been transcribed.";

export const IOS_PLIST_KEY = "NSMicrophoneUsageDescription";
export const ANDROID_PERMISSION = "android.permission.RECORD_AUDIO";

const IOS_PLIST_PATH = path.join("ios", "App", "App", "Info.plist");
const ANDROID_MANIFEST_PATH = path.join("android", "app", "src", "main", "AndroidManifest.xml");

function escapeXmlText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Adds NSMicrophoneUsageDescription to an Info.plist's root <dict>.
 *
 * Returns `{ xml, changed, reason }`. An existing key is left exactly as
 * it is rather than overwritten — someone may have deliberately reworded
 * it, and silently reverting that on the next `cap sync` would be worse
 * than leaving it alone.
 */
export function patchInfoPlist(xml, description = MIC_USAGE_DESCRIPTION) {
  if (new RegExp(`<key>\\s*${IOS_PLIST_KEY}\\s*</key>`).test(xml)) {
    return { xml, changed: false, reason: "already present" };
  }

  // Anchor on the root dict's close rather than the first `</dict>`: a
  // plist commonly nests dicts (UIApplicationSceneManifest, for one), and
  // inserting into one of those would put the key in the wrong scope.
  const rootDictClose = /([ \t]*)<\/dict>(\s*)<\/plist>/;
  const match = xml.match(rootDictClose);
  if (!match) {
    throw new Error("Info.plist has no root </dict></plist> to insert into — is this a valid plist?");
  }

  const indent = match[1] || "";
  const entryIndent = indent + "\t";
  const entry =
    `${entryIndent}<key>${IOS_PLIST_KEY}</key>\n` +
    `${entryIndent}<string>${escapeXmlText(description)}</string>\n`;

  return {
    xml: xml.replace(rootDictClose, `${entry}${indent}</dict>${match[2]}</plist>`),
    changed: true,
    reason: "added",
  };
}

/**
 * Adds the RECORD_AUDIO <uses-permission> to an AndroidManifest.
 *
 * Capacitor's bridge already grants the WebView's audio-capture request
 * at runtime, but only if the app itself declares the permission here —
 * so this one line is the whole difference between a working mic and a
 * recorder that never starts.
 *
 * Returns `{ xml, changed, reason }`.
 */
export function patchAndroidManifest(xml) {
  if (xml.includes(ANDROID_PERMISSION)) {
    return { xml, changed: false, reason: "already present" };
  }

  const element = `<uses-permission android:name="${ANDROID_PERMISSION}" />`;

  // Prefer grouping with the permissions Capacitor already declares (it
  // puts them after </application>); fall back to just inside <manifest>
  // for a template that declares none.
  const permissionLines = [...xml.matchAll(/^([ \t]*)<uses-permission\b[^>]*\/>[ \t]*$/gm)];
  if (permissionLines.length > 0) {
    const last = permissionLines[permissionLines.length - 1];
    const indent = last[1] || "";
    const insertAt = last.index + last[0].length;
    return {
      xml: `${xml.slice(0, insertAt)}\n${indent}${element}${xml.slice(insertAt)}`,
      changed: true,
      reason: "added",
    };
  }

  const manifestClose = /([ \t]*)<\/manifest>/;
  if (!manifestClose.test(xml)) {
    throw new Error("AndroidManifest.xml has no </manifest> to insert into — is this a valid manifest?");
  }
  return {
    xml: xml.replace(manifestClose, (whole, indent) => `${indent}    ${element}\n${indent}</manifest>`),
    changed: true,
    reason: "added",
  };
}

function applyToFile(absPath, patch) {
  if (!fs.existsSync(absPath)) return { status: "skipped" };
  const { xml, changed, reason } = patch(fs.readFileSync(absPath, "utf8"));
  if (changed) fs.writeFileSync(absPath, xml);
  return { status: changed ? "patched" : "unchanged", reason };
}

/**
 * Applies both patches to whichever native projects exist under
 * `mobileDir`. Returns a report keyed by platform so callers (and tests)
 * can assert on what happened without parsing stdout.
 */
export function applyNativePermissions(mobileDir) {
  return {
    ios: applyToFile(path.join(mobileDir, IOS_PLIST_PATH), (xml) => patchInfoPlist(xml)),
    android: applyToFile(path.join(mobileDir, ANDROID_MANIFEST_PATH), patchAndroidManifest),
  };
}

function describe(platform, file, result) {
  switch (result.status) {
    case "skipped":
      return `${platform}: skipped (no ${file} — run "npx cap add ${platform}" first)`;
    case "patched":
      return `${platform}: microphone permission added to ${file}`;
    default:
      return `${platform}: microphone permission ${result.reason} in ${file}`;
  }
}

// Only run the file IO when invoked as a script, so importing the pure
// patch functions from a test costs nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = applyNativePermissions(mobileDir);
  console.log(describe("ios", IOS_PLIST_PATH, report.ios));
  console.log(describe("android", ANDROID_MANIFEST_PATH, report.android));
  if (report.ios.status === "skipped" && report.android.status === "skipped") {
    console.log("Nothing to do yet — this runs automatically after cap add / cap sync.");
  }
}
