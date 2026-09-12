/* ==================================================================
   make-icons.mjs — every icon slot, from ONE master

   Run: node scripts/make-icons.mjs          (write)
        node scripts/make-icons.mjs --check  (verify, write nothing)

   THE MASTER IS `mobile/assets/icon.png`, 1024x1024. Everything below
   is derived from it by `scripts/lib/png.mjs`, which is deterministic —
   so `--check` can re-derive every slot and compare BYTES rather than
   trusting a recorded hash. "Derived from the master" is then a fact the
   guard establishes rather than a claim somebody maintains.

   WHY THAT MATTERS HERE. App Store build 3514249 was rejected under
   guideline 2.3.8 for placeholder icons. The set had drifted into three
   independent renderings of the same glyph — the master, a separately
   produced set of web icons (rounded corners, RGBA, different
   proportions), and whatever `capacitor-assets` last wrote into the
   generated native projects, which are git-ignored and therefore
   invisible to every check in this repository. One generator and a
   re-derivation guard is what stops a fourth rendering appearing.

   THE NATIVE PROJECTS ARE GENERATED, NOT TRACKED (see CLAUDE.md: they
   are created per machine by `cap add` and git-ignored). So this script
   writes into them ONLY WHEN THEY EXIST, and says which it found. On a
   build machine it writes the tracked web and store slots and reports
   the native ones as absent; on Jared's Mac, after `cap add`, it writes
   all of them. That is the same arrangement `native-permissions.mjs`
   and `stamp-native.mjs` already use, and it is why this belongs in
   mobile's `settings` chain.
   ================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, resize, solid, blank, composite } from "./lib/png.mjs";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = path.join(rootDir, "mobile/assets/icon.png");

/* THE BRAND GROUND, and it is read from the master rather than typed.
   The master is full-bleed, so its corner pixel IS the background
   colour — which means the feature graphic and the adaptive background
   cannot drift away from the icon they sit behind. A hardcoded hex here
   would be the restatement this codebase has a ledger about. */
function groundOf(image) {
  const [r, g, b] = image.pixels.subarray(0, 3);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/* ---------- the slots ----------

   Every entry says where it goes, how big it is, and WHY that size —
   because a size with no reason behind it is the thing nobody dares
   change later. */

/** Tracked in the repository: the web app's own icons. */
const WEB = [
  { file: "public/icon-192.png", size: 192, why: "manifest.webmanifest, the Android PWA launcher size" },
  { file: "public/icon-512.png", size: 512, why: "manifest.webmanifest, the splash and install-prompt size" },
  { file: "public/apple-touch-icon.png", size: 180, why: "index.html, iOS Safari add-to-home-screen" },
];

/** Tracked: what the Play Console listing asks for. */
const STORE = [
  { file: "mobile/store/play-icon-512.png", size: 512, why: "Play Console listing icon, 512x512, required" },
];

/** Android launcher rasters, inside the generated project. */
const ANDROID_DENSITIES = [
  { dir: "mdpi", size: 48 },
  { dir: "hdpi", size: 72 },
  { dir: "xhdpi", size: 96 },
  { dir: "xxhdpi", size: 144 },
  { dir: "xxxhdpi", size: 192 },
];

/* Adaptive icons are 108dp with only the middle 72dp guaranteed visible
   and the middle 66dp safe from every OEM mask. The foreground is drawn
   at the same densities as the legacy icon, x108/48. */
const ADAPTIVE_SCALE = 108 / 48;
const SAFE_FRACTION = 66 / 108;

const IOS_ICON = "mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset";
const ANDROID_RES = "mobile/android/app/src/main/res";

/* ---------- derivation ---------- */

const square = (master, size) => encodePng(resize(master, size, size));

/** The round launcher icon: the same square, circle-cropped. */
function round(master, size) {
  const img = resize(master, size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const d = Math.sqrt(dx * dx + dy * dy);
      /* One pixel of feathering at the rim. A hard cut on a 48px icon
         is a visibly jagged circle; anti-aliasing the boundary is what
         the platform's own tooling does. */
      const cover = Math.max(0, Math.min(1, r - d));
      const p = (y * size + x) * 4;
      img.pixels[p + 3] = Math.round(img.pixels[p + 3] * cover);
    }
  }
  return encodePng(img);
}

/**
 * The adaptive foreground: the master scaled into the safe zone, on
 * transparency.
 *
 * THIS ASSUMES A FULL-BLEED MASTER and is worth stating, because it is
 * the one derivation whose correctness depends on what the artwork
 * looks like rather than on arithmetic. Scaling a full-bleed master
 * into the safe zone puts the master's own ground inside the mask, so
 * the adaptive background colour shows only in the corners the mask
 * trims — which is right for a solid-ground icon and wrong for a glyph
 * that expects to float. Grace's master is the former; if that ever
 * changes, this is the function to revisit.
 */
function adaptiveForeground(master, size) {
  const inner = Math.round(size * SAFE_FRACTION);
  const canvas = blank(size, size);
  const offset = Math.round((size - inner) / 2);
  return encodePng(composite(canvas, resize(master, inner, inner), offset, offset));
}

/**
 * The Play feature graphic: 1024x500, the icon centred on the ground.
 *
 * NO TEXT. Play renders this behind and around the listing's own title
 * at sizes nobody controls, and baked-in wording is what makes a
 * feature graphic look like a placeholder. The icon on the brand ground
 * is the honest minimum, and it is derived rather than drawn so it
 * cannot drift from the icon beside it.
 */
function featureGraphic(master) {
  const w = 1024;
  const h = 500;
  const canvas = solid(w, h, groundOf(master));
  const icon = Math.round(h * 0.62);
  return encodePng(composite(canvas, resize(master, icon, icon), Math.round((w - icon) / 2), Math.round((h - icon) / 2)));
}

/**
 * Xcode's single-size app icon.
 *
 * SINCE XCODE 14 AN iOS APP ICON IS ONE 1024x1024 IMAGE and the system
 * derives every other size, which is why this writes one file and a
 * Contents.json declaring it universal. The older multi-slot catalogue
 * is what produced the half-filled sets this rejection is about: sixteen
 * slots, some from the master, some Capacitor's default, and no way to
 * tell by looking.
 *
 * THIS SHAPE IS NOT VERIFIABLE FROM THIS CONTAINER — no Xcode here, and
 * the generated project is git-ignored. It is stated rather than
 * assumed, and MOBILE-BUILD.md carries it as a step Jared confirms on
 * the Mac.
 */
const IOS_CONTENTS = JSON.stringify(
  {
    images: [{ filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
    info: { author: "make-icons.mjs", version: 1 },
  },
  null,
  2
) + "\n";

/** Everything this script produces, as `{ path, bytes }`, from one master. */
export function deriveAll(masterBuffer, { includeNative = true } = {}) {
  const master = decodePng(masterBuffer);
  if (master.width !== 1024 || master.height !== 1024) {
    throw new Error(`the master must be 1024x1024, found ${master.width}x${master.height}`);
  }

  const out = [];
  for (const slot of [...WEB, ...STORE]) out.push({ path: slot.file, bytes: square(master, slot.size) });
  out.push({ path: "mobile/store/play-feature-graphic.png", bytes: featureGraphic(master) });

  if (!includeNative) return out;

  out.push({ path: `${IOS_ICON}/AppIcon-1024.png`, bytes: masterBuffer });
  out.push({ path: `${IOS_ICON}/Contents.json`, bytes: Buffer.from(IOS_CONTENTS, "utf8") });

  for (const { dir, size } of ANDROID_DENSITIES) {
    out.push({ path: `${ANDROID_RES}/mipmap-${dir}/ic_launcher.png`, bytes: square(master, size) });
    out.push({ path: `${ANDROID_RES}/mipmap-${dir}/ic_launcher_round.png`, bytes: round(master, size) });
    out.push({
      path: `${ANDROID_RES}/mipmap-${dir}/ic_launcher_foreground.png`,
      bytes: adaptiveForeground(master, Math.round(size * ADAPTIVE_SCALE)),
    });
  }
  return out;
}

/** Which native projects exist right now. */
export const nativePresent = () => ({
  ios: fs.existsSync(path.join(rootDir, "mobile/ios")),
  android: fs.existsSync(path.join(rootDir, "mobile/android")),
});

/* ---------- the command ---------- */

function main() {
  const check = process.argv.includes("--check");
  const masterBuffer = fs.readFileSync(MASTER);
  const present = nativePresent();

  const slots = deriveAll(masterBuffer, { includeNative: true });
  let written = 0;
  let skipped = 0;
  const wrong = [];

  for (const slot of slots) {
    const isIos = slot.path.startsWith("mobile/ios/");
    const isAndroid = slot.path.startsWith("mobile/android/");
    if ((isIos && !present.ios) || (isAndroid && !present.android)) {
      skipped++;
      continue;
    }
    const abs = path.join(rootDir, slot.path);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    if (existing && existing.equals(slot.bytes)) continue;

    if (check) {
      wrong.push(`${slot.path} — ${existing ? "does not match the master" : "missing"}`);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, slot.bytes);
    written++;
  }

  const where = `ios ${present.ios ? "present" : "absent"}, android ${present.android ? "present" : "absent"}`;
  if (check) {
    if (wrong.length) {
      console.error(`icons DO NOT match the master (${where}):`);
      for (const line of wrong) console.error(`  ${line}`);
      console.error("\nRun: node scripts/make-icons.mjs");
      process.exit(1);
    }
    console.log(`icons OK — every slot derives from ${path.relative(rootDir, MASTER)} (${where}, ${skipped} native slots not generated here)`);
    return;
  }
  console.log(`icons written: ${written} updated, ${skipped} skipped because the project is absent (${where})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

export { WEB, STORE, ANDROID_DENSITIES, IOS_ICON, ANDROID_RES, MASTER, rootDir };
