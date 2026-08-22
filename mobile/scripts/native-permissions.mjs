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

   THE TWO PLATFORMS ARE NOT SYMMETRIC, and the asymmetry cost a
   hardware round. Android needs TWO manifest permissions (see
   ANDROID_PERMISSIONS); iOS needs only the usage string, because
   WKWebView manages its own AVAudioSession under that declaration and
   there is no routing permission to ask for. What iOS has instead is a
   VERSION floor: getUserMedia only exists in WKWebView from iOS 14.3.
   That is guarded by IOS_DEPLOYMENT_TARGET in scripts/stamp-native.mjs
   and asserted by a test, because lowering it would remove recording
   from the phone build with no error anywhere.

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

/* THE CAMERA STRING IS NOT OPTIONAL ONCE A FILE INPUT CAN REACH THE
   CAMERA, and this is the MODIFY_AUDIO_SETTINGS lesson in its second
   costume. The reading summariser's photo input offers three routes on
   iOS — Photo Library, Take Photo, Choose File. Library and Files need
   no declaration at all (WKWebView uses PHPicker, which hands back only
   what the user picked). **Take Photo without NSCameraUsageDescription
   does not fail politely: iOS terminates the app**, and it does so on
   the one route a student is most likely to take when told to
   photograph a page.

   Nothing in the suite can see this: desktop browsers have no plist,
   and jsdom has no file picker. It took reading what the WebView
   actually presents, exactly as the audio permission did. */
export const CAMERA_USAGE_DESCRIPTION =
  "University Planner uses your camera so you can photograph pages of a " +
  "reading to summarise. Photos are sent for summarising and are not stored by us.";

export const IOS_CAMERA_PLIST_KEY = "NSCameraUsageDescription";

/* THE PHOTO LIBRARY STRING IS INSURANCE, AND THAT IS THE ARGUMENT FOR
   ADDING IT. The reasoning for the camera string above says Library
   and Files need no declaration, because WKWebView presents PHPicker,
   which hands back only what the user picked. That is true of the
   MODERN picker. What could not be established from a build machine is
   which picker WKWebView presents on iOS 15.0 -- our deployment floor
   -- for `<input type="file" accept="image/*">`, and if any route on
   any supported version reaches the legacy UIImagePickerController,
   this key's absence TERMINATES THE APP exactly the way the camera
   one does.

   The asymmetry is what decides it: an unused usage string is never
   shown and costs nothing, while a missing one that turns out to be
   needed kills the app on one of the three routes a student is told to
   take. Fail towards declaring. If the iOS build later proves PHPicker
   is always used, this can go -- but removing it needs the evidence,
   not the reasoning. */
export const PHOTO_LIBRARY_USAGE_DESCRIPTION =
  "University Planner uses your photo library so you can pick a photo of a " +
  "reading to summarise. Photos are sent for summarising and are not stored by us.";

export const IOS_PHOTO_LIBRARY_PLIST_KEY = "NSPhotoLibraryUsageDescription";

/* NOT A PERMISSION -- an EXPORT COMPLIANCE declaration, and the only
   boolean in this file.

   Without it, every TestFlight and App Store Connect upload stops and
   asks the encryption question by hand. The answer never changes: the
   app uses HTTPS and nothing else, which is the exempt case, so
   declaring it once removes a manual step from every upload forever.

   It is `false` rather than absent on purpose. Absent means "unknown"
   and prompts; false means "exempt" and does not. */
export const IOS_ENCRYPTION_PLIST_KEY = "ITSAppUsesNonExemptEncryption";
export const IOS_USES_NON_EXEMPT_ENCRYPTION = false;

/* BOTH are required, and the second one is the whole reason this list
   is a list.

   RECORD_AUDIO alone looks sufficient -- the runtime prompt appears, the
   student taps Allow -- and then the WebView still refuses, logging:

     Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO.
     No audio device will be available for recording

   Android's WebView needs the APP to declare MODIFY_AUDIO_SETTINGS
   before it will expose an audio device to getUserMedia at all. The
   user's runtime grant does not substitute for it: the app is asking to
   change audio routing and mode to record, and that is an app-manifest
   question rather than a user-consent one.

   It is a NORMAL permission -- granted at install, no second prompt, and
   not on Google Play's list of permissions needing a declaration form.
   (Confirm at submission rather than trusting this comment; the check
   costs nothing and store rules move.) Empirically it is confirmed by
   the absence of a new prompt on the next install.

   THIS CANNOT BE CAUGHT ANYWHERE BUT ON HARDWARE. Desktop browsers have
   no manifest, so every environment we test in is happy without it. It
   took a real device, a granted permission, and a Logcat line to find. */
export const ANDROID_PERMISSIONS = ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"];

const IOS_PLIST_PATH = path.join("ios", "App", "App", "Info.plist");
const ANDROID_MANIFEST_PATH = path.join("android", "app", "src", "main", "AndroidManifest.xml");

function escapeXmlText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Adds one key to an Info.plist's root <dict>.
 *
 * Returns `{ xml, changed, reason }`. An existing key is left exactly as
 * it is rather than overwritten — someone may have deliberately reworded
 * it, and silently reverting that on the next `cap sync` would be worse
 * than leaving it alone.
 *
 * `type` is "string" for the three usage descriptions and "bool" for the
 * export-compliance flag. A plist boolean is an EMPTY ELEMENT
 * (`<true/>`) and not a string containing the word — written as a
 * string, iOS reads a non-empty string as truthy and the declaration
 * says the opposite of what was meant, silently.
 */
export function patchInfoPlist(xml, description = MIC_USAGE_DESCRIPTION, key = IOS_PLIST_KEY, type = "string") {
  if (new RegExp(`<key>\\s*${key}\\s*</key>`).test(xml)) {
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
  const value =
    type === "bool" ? `<${description ? "true" : "false"}/>` : `<string>${escapeXmlText(description)}</string>`;
  const entry = `${entryIndent}<key>${key}</key>\n${entryIndent}${value}\n`;

  return {
    xml: xml.replace(rootDictClose, `${entry}${indent}</dict>${match[2]}</plist>`),
    changed: true,
    reason: "added",
  };
}

/**
 * Adds every permission in ANDROID_PERMISSIONS that isn't already there.
 *
 * Capacitor's bridge grants the WebView's audio-capture request at
 * runtime, but only if the app itself declares these — so these two
 * lines are the whole difference between a working mic and a recorder
 * that reports "microphone access was denied" to a student who just
 * granted it.
 *
 * Adds only what is MISSING, so a manifest that already has one of them
 * (hand-edited, or half-patched by an older version of this script)
 * gains the other rather than being left broken or duplicated.
 *
 * Returns `{ xml, changed, reason }`.
 */
export function patchAndroidManifest(xml) {
  const missing = ANDROID_PERMISSIONS.filter((name) => !xml.includes(name));
  if (missing.length === 0) {
    return { xml, changed: false, reason: "already present" };
  }

  const elements = missing.map((name) => `<uses-permission android:name="${name}" />`);

  // Prefer grouping with the permissions Capacitor already declares (it
  // puts them after </application>); fall back to just inside <manifest>
  // for a template that declares none.
  const permissionLines = [...xml.matchAll(/^([ \t]*)<uses-permission\b[^>]*\/>[ \t]*$/gm)];
  if (permissionLines.length > 0) {
    const last = permissionLines[permissionLines.length - 1];
    const indent = last[1] || "";
    const insertAt = last.index + last[0].length;
    const block = elements.map((el) => `\n${indent}${el}`).join("");
    return {
      xml: `${xml.slice(0, insertAt)}${block}${xml.slice(insertAt)}`,
      changed: true,
      reason: `added ${missing.length}`,
    };
  }

  const manifestClose = /([ \t]*)<\/manifest>/;
  if (!manifestClose.test(xml)) {
    throw new Error("AndroidManifest.xml has no </manifest> to insert into — is this a valid manifest?");
  }
  return {
    xml: xml.replace(
      manifestClose,
      (whole, indent) => `${elements.map((el) => `${indent}    ${el}\n`).join("")}${indent}</manifest>`
    ),
    changed: true,
    reason: `added ${missing.length}`,
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
    /* ALL FOUR KEYS, in one pass over the file, each patch reading the
       PREVIOUS one's output. A pass that read the original xml would
       silently drop every key but the last — which is why this is a
       fold rather than four independent calls, and why the test applies
       the real function to a real fixture instead of pinning the shape
       of the expression. */
    ios: applyToFile(path.join(mobileDir, IOS_PLIST_PATH), (xml) => {
      const steps = [
        [MIC_USAGE_DESCRIPTION, IOS_PLIST_KEY, "string"],
        [CAMERA_USAGE_DESCRIPTION, IOS_CAMERA_PLIST_KEY, "string"],
        [PHOTO_LIBRARY_USAGE_DESCRIPTION, IOS_PHOTO_LIBRARY_PLIST_KEY, "string"],
        [IOS_USES_NON_EXEMPT_ENCRYPTION, IOS_ENCRYPTION_PLIST_KEY, "bool"],
      ];
      let out = xml;
      let changed = false;
      for (const [value, key, type] of steps) {
        const r = patchInfoPlist(out, value, key, type);
        out = r.xml;
        changed = changed || r.changed;
      }
      return { xml: out, changed, reason: changed ? "added" : "already present" };
    }),
    android: applyToFile(path.join(mobileDir, ANDROID_MANIFEST_PATH), patchAndroidManifest),
  };
}

function describe(platform, file, result) {
  switch (result.status) {
    case "skipped":
      return `${platform}: skipped (no ${file} — run "npx cap add ${platform}" first)`;
    case "patched":
      return `${platform}: iOS declarations ${result.reason} in ${file}`;
    default:
      return `${platform}: iOS declarations ${result.reason} in ${file}`;
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
