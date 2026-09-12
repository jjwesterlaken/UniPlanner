/* ==================================================================
   test-icons.mjs — every icon slot derives from the master

   App Store build 3514249 was rejected under guideline 2.3.8 for
   placeholder icons. The structural cause was that the set had no
   single source: the 1024 master, a separately produced set of web
   icons, and whatever `capacitor-assets` last wrote into the generated
   native projects were three independent renderings of the same glyph,
   and nothing in this repository could see the third at all.

   SO THE CLAIM THIS FILE MAKES IS "DERIVES FROM THE MASTER", AND IT
   ESTABLISHES IT BY RE-DERIVING. `scripts/lib/png.mjs` is deterministic,
   so the guard regenerates every slot and compares bytes rather than
   holding a list of hashes somebody has to maintain — which would be
   the restatement pattern this project has a seventeen-entry ledger
   about, in the one place where the value being restated is an image
   nobody reads by eye.

   WHAT IT CANNOT SEE, said here rather than implied by a pass:

   - THE GENERATED NATIVE PROJECTS. `mobile/ios` and `mobile/android`
     are created per machine by `cap add` and git-ignored (CLAUDE.md),
     so on a build machine they do not exist and their slots cannot be
     checked. That is exactly where the rejected icons lived. The test
     asserts the two halves it CAN: that the tracked slots are right,
     and that `make-icons.mjs` would write the native ones when the
     projects are present. Confirming the artifact Apple actually
     received is a step on MOBILE-BUILD.md, on the Mac, and no grep here
     substitutes for it.
   - WHETHER THE ARTWORK IS ANY GOOD. "Is this a placeholder" is a human
     judgement about a picture. What is mechanical is consistency and
     the store's technical requirements, and those are what is below.
   ================================================================== */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, decodeIco } from "./lib/png.mjs";
import { deriveAll, nativePresent, WEB, STORE, DESKTOP_ICO_SIZES, ANDROID_DENSITIES, MASTER, rootDir } from "./make-icons.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  - ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
}

const masterBuffer = fs.readFileSync(MASTER);

async function run() {
  await test("the master is 1024x1024, which is what every store asks for", () => {
    const m = decodePng(masterBuffer);
    assert.equal(m.width, 1024, `master is ${m.width}px wide`);
    assert.equal(m.height, 1024, `master is ${m.height}px tall`);
  });

  await test("THE MASTER CARRIES NO ALPHA — Apple rejects an app icon that does", () => {
    /* "App icons must not contain an alpha channel or transparency" is
       a hard App Store rule, and it is the one property of the artwork
       a machine can check. It matters more than it looks: the iOS slot
       is the master passed through VERBATIM precisely so that an opaque
       master stays opaque — re-encoding it here would add an alpha
       channel and earn a second rejection for the same guideline.

       Checked at the IHDR rather than by scanning pixels, because a
       fully-opaque RGBA file still HAS the channel and is still
       refused. */
    const colourType = masterBuffer[25];
    assert.equal(
      colourType,
      2,
      `the master's PNG colour type is ${colourType}; Apple needs 2 (RGB, no alpha). ` +
        "Flatten it onto its background before committing."
    );
  });

  await test("every tracked slot re-derives from the master, byte for byte", () => {
    const slots = deriveAll(masterBuffer, { includeNative: false });
    /* Derived from the tables rather than a number I guessed — which I
       did, wrongly, on the first run. The three that are not in a size
       table are named rather than counted, so an accidental extra slot
       fails here instead of being absorbed by an arithmetic constant. */
    const composed = [
      "mobile/store/play-feature-graphic.png",
      "desktop/build/icon.png",
      "desktop/build/icon.ico",
    ];
    for (const p of composed) {
      assert.ok(slots.some((s) => s.path === p), `${p} is not generated at all`);
    }
    assert.equal(
      slots.length,
      WEB.length + STORE.length + composed.length,
      `${slots.length} tracked slots, expected ${WEB.length + STORE.length + composed.length} — the table and the generator disagree`
    );
    assert.ok(WEB.length >= 3, "the web icon table shrank below the three the app references");

    for (const slot of slots) {
      const abs = path.join(rootDir, slot.path);
      assert.ok(fs.existsSync(abs), `${slot.path} is missing — run: node scripts/make-icons.mjs`);
      const onDisk = fs.readFileSync(abs);
      assert.ok(
        onDisk.equals(slot.bytes),
        `${slot.path} does not match what the master produces — it is a second rendering. ` +
          "Run: node scripts/make-icons.mjs"
      );
    }
  });

  await test("the slot table covers every size the three stores and the web actually ask for", () => {
    /* Derived from the tables in make-icons.mjs rather than retyped, so
       adding a slot there is covered here automatically. The point of
       the assertion is the SET: a missing size is a store rejection and
       an unexplained extra is a file nobody knows the purpose of. */
    const webSizes = WEB.map((s) => s.size).sort((a, b) => a - b);
    assert.deepEqual(webSizes, [180, 192, 512], "the web sizes moved — manifest and index.html name these");

    const androidSizes = ANDROID_DENSITIES.map((d) => d.size).sort((a, b) => a - b);
    assert.deepEqual(androidSizes, [48, 72, 96, 144, 192], "the five Android launcher densities are mdpi..xxxhdpi");

    assert.ok(
      STORE.some((s) => s.size === 512),
      "the Play listing icon is 512x512 and is required"
    );
    const all = deriveAll(masterBuffer, { includeNative: false }).map((s) => s.path);
    assert.ok(
      all.includes("mobile/store/play-feature-graphic.png"),
      "the Play feature graphic is required for a listing and is not generated"
    );
  });

  await test("the feature graphic is 1024x500 and carries no baked-in text", () => {
    /* Size is Play's requirement. "No text" cannot be proved from
       pixels, so what is asserted is the mechanism: it is composed from
       the master and a solid ground by `featureGraphic`, so there is
       nothing in it that is not in the icon. The guard is that it
       re-derives, which the tracked-slot test above already covers —
       this one pins the dimensions Play refuses to accept anything
       else for. */
    const g = decodePng(fs.readFileSync(path.join(rootDir, "mobile/store/play-feature-graphic.png")));
    assert.equal(g.width, 1024);
    assert.equal(g.height, 500);
  });

  await test("the desktop PNG is the master VERBATIM, so it gains no alpha channel", () => {
    /* The same reasoning as the iOS slot. `encodePng` always writes
       RGBA, so a slot that re-encodes an opaque master hands Windows
       and macOS a channel neither needs — and on Apple's side that is
       the rejection this whole file is about. Passing the bytes
       through is what keeps colour type 2 all the way out. */
    const onDisk = fs.readFileSync(path.join(rootDir, "desktop/build/icon.png"));
    assert.ok(onDisk.equals(masterBuffer), "desktop/build/icon.png is not the master — run: node scripts/make-icons.mjs");
    assert.equal(onDisk[25], 2, "the desktop icon carries an alpha channel the master does not");
  });

  await test("the Windows .ico carries every declared size, each a readable PNG", () => {
    /* electron-builder hands this straight to Windows, so what matters
       is that the CONTAINER is well formed rather than that our encoder
       ran — a directory pointing at the wrong offsets produces a file
       that exists, re-derives, and shows a blank icon. So it is decoded
       back and every payload is decoded as a PNG at its declared size. */
    const entries = decodeIco(fs.readFileSync(path.join(rootDir, "desktop/build/icon.ico")));
    assert.ok(entries.length > 0, "the .ico declares no images — this check would pass over nothing");
    assert.deepEqual(
      entries.map((e) => e.size),
      DESKTOP_ICO_SIZES,
      "the .ico's sizes are not the ones the generator declares"
    );
    for (const entry of entries) {
      assert.equal(entry.bits, 32, `the ${entry.size}px entry is not 32-bit`);
      const img = decodePng(entry.png);
      assert.equal(img.width, entry.size, `the ${entry.size}px entry holds a ${img.width}px image`);
      assert.equal(img.height, entry.size);
    }
    assert.ok(DESKTOP_ICO_SIZES.includes(256), "256 is the size Windows uses for large views and it is missing");
  });

  await test("the native slots are ENUMERATED even where they cannot be written", () => {
    /* The rejected icons lived in the generated projects, which do not
       exist on a build machine — so the one thing this repository can
       assert is that the generator KNOWS about every native slot, and
       would write it. A generator that silently covered iOS and forgot
       Android's round icon would pass every other test in this file. */
    const native = deriveAll(masterBuffer, { includeNative: true })
      .map((s) => s.path)
      .filter((p) => p.startsWith("mobile/ios/") || p.startsWith("mobile/android/"));
    assert.ok(native.length > 0, "no native slots are enumerated at all");

    assert.ok(
      native.some((p) => p.endsWith("AppIcon.appiconset/AppIcon-1024.png")),
      "no iOS 1024 app icon is generated"
    );
    assert.ok(
      native.some((p) => p.endsWith("AppIcon.appiconset/Contents.json")),
      "the iOS asset catalogue has no Contents.json, so Xcode will not see the icon"
    );
    for (const { dir } of ANDROID_DENSITIES) {
      for (const name of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
        assert.ok(
          native.includes(`mobile/android/app/src/main/res/mipmap-${dir}/${name}`),
          `Android mipmap-${dir}/${name} is not generated`
        );
      }
    }
  });

  await test("the generator reports which native projects it found, rather than assuming", () => {
    /* A script that wrote nothing and said nothing is how an icon set
       goes stale on one machine. `nativePresent` is what the run line
       reports, and it is a fact about the filesystem rather than a
       flag somebody sets. */
    const present = nativePresent();
    assert.equal(typeof present.ios, "boolean");
    assert.equal(typeof present.android, "boolean");
    assert.equal(
      present.ios,
      fs.existsSync(path.join(rootDir, "mobile/ios")),
      "nativePresent disagrees with the filesystem about iOS"
    );
  });

  await test("the web icons the manifest names are the ones the generator writes", () => {
    /* The drift that started this: `public/icon-512.png` was a
       separately produced rendering — RGBA with rounded corners against
       an RGB square master — and nothing compared them. Now the
       manifest's list and the generator's list are checked against each
       other, so a size added to one and not the other goes red. */
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "public/manifest.webmanifest"), "utf8"));
    const named = new Set((manifest.icons || []).map((i) => i.src.replace(/^\.?\//, "")));
    assert.ok(named.size > 0, "the manifest names no icons — this check would pass over nothing");

    const generated = new Set(WEB.map((s) => path.basename(s.file)));
    for (const src of named) {
      assert.ok(
        generated.has(path.basename(src)),
        `manifest.webmanifest names ${src}, which make-icons.mjs does not generate`
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

await run();
