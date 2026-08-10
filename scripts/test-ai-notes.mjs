/* Tests for the AI lecture notes feature.

   Plain Node + `assert` (no test framework, matching build-web.mjs's
   style), plus `jsdom` for the two DOM-touching checks. Run via
   `npm test` (which builds first, since one test greps the built
   bundle for leaked secrets). */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

import {
  needsConsent,
  buildConsentPatch,
  AI_CONSENT_VERSION,
  CONSENT_TEXT,
  describeRecorderError,
  parseAiNotesError,
  PERMANENT_FAILURE_CODES,
  mapAiResultToItems,
  recorderReducer,
  INITIAL_RECORDER_STATE,
} from "../src/aiNotesLogic.js";
import { fetchUsage, callAiNotes } from "../src/aiNotesClient.js";
import { mergeData } from "../src/sync.js";
import { checkRequestGuards, selectTranscriber, minutesFromSeconds } from "../supabase/functions/ai-notes/guards.js";
import { deepgramAdapter } from "../supabase/functions/ai-notes/deepgram.js";
import { groqAdapter, isSizeError } from "../supabase/functions/ai-notes/groq.js";
import {
  patchInfoPlist,
  patchAndroidManifest,
  MIC_USAGE_DESCRIPTION,
  IOS_PLIST_KEY,
  ANDROID_PERMISSION,
} from "../mobile/scripts/native-permissions.mjs";

/* ---------- tiny test harness ---------- */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

/* ---------- 1. consent gate can't be bypassed ---------- */

async function bundleConsentGate() {
  const result = await build({
    entryPoints: [path.join(rootDir, "src/aiNotesConsent.jsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    // react/react-dom must stay external and resolve to the SAME copy this
    // test script itself imports — bundling a second copy of react inline
    // causes "Invalid hook call" (React's internals get split across two
    // module instances). That means the output file needs a real
    // node_modules in its ancestry, so it's written inside the repo
    // (cleaned up right after importing it) rather than to the OS temp dir.
    external: ["react", "react/jsx-runtime", "lucide-react"],
    write: false,
  });
  const dir = path.join(rootDir, ".ai-notes-test-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "aiNotesConsent.bundled.mjs");
  fs.writeFileSync(outPath, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(outPath).href);
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

async function run() {
  await test("needsConsent: no prior consent -> true", () => {
    assert.equal(needsConsent(null, AI_CONSENT_VERSION), true);
    assert.equal(needsConsent({}, AI_CONSENT_VERSION), true);
  });

  await test("needsConsent: accepted current version -> false", () => {
    assert.equal(needsConsent({ aiConsent: { version: AI_CONSENT_VERSION } }, AI_CONSENT_VERSION), false);
  });

  await test("needsConsent: version bump re-prompts", () => {
    assert.equal(needsConsent({ aiConsent: { version: 1 } }, 2), true);
  });

  await test("buildConsentPatch shape", () => {
    const patch = buildConsentPatch(1, () => "2024-01-01T00:00:00.000Z");
    assert.deepEqual(patch, { aiConsent: { version: 1, acceptedAt: "2024-01-01T00:00:00.000Z" } });
  });

  await test("ConsentGate renders every required phrase and exactly one button", async () => {
    const { ConsentGate } = await bundleConsentGate();
    const html = renderToStaticMarkup(React.createElement(ConsentGate, { onAccept: () => {} }));
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent;
    for (const phrase of CONSENT_TEXT.bullets) {
      assert.ok(text.includes(phrase), `missing required phrase: "${phrase}"`);
    }
    assert.ok(text.includes(CONSENT_TEXT.title));
    const buttons = dom.window.document.body.querySelectorAll("button");
    assert.equal(buttons.length, 1, "ConsentGate must expose no dismiss control besides the single accept button");
    assert.ok(buttons[0].textContent.includes(CONSENT_TEXT.acceptLabel));
  });

  /* ---------- 2. denied mic permission handled gracefully ---------- */

  await test("describeRecorderError never returns something unusable", () => {
    for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "SomethingElse", undefined]) {
      const msg = describeRecorderError({ name });
      assert.equal(typeof msg, "string");
      assert.ok(msg.length > 0);
    }
  });

  /* ---------- 3. usage cap gives a clear message ---------- */

  await test("parseAiNotesError maps usage_exceeded to a clear sentence", () => {
    const msg = parseAiNotesError({ code: "usage_exceeded" }, 403);
    assert.equal(msg, "You've used all your AI minutes for this month.");
  });

  await test("callAiNotes surfaces the server's error via a thrown Error", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ ok: false, code: "usage_exceeded", error: "You've used all your AI minutes for this month." }),
    });
    let thrown = null;
    try {
      await callAiNotes(
        { token: "t", path: "p", mimeType: "audio/webm", course: "", week: "", translateTo: null, idempotencyKey: "k", estimatedDurationSeconds: 10 },
        fakeFetch
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "expected callAiNotes to throw");
    assert.equal(parseAiNotesError(thrown.body, thrown.status), "You've used all your AI minutes for this month.");
  });

  /* ---------- 4. failed transcription doesn't lose the recording ---------- */

  await test("recorderReducer preserves blob through an upload failure", () => {
    let state = INITIAL_RECORDER_STATE;
    state = recorderReducer(state, { type: "request" });
    state = recorderReducer(state, { type: "started" });
    const fakeBlob = { size: 123, marker: "the-recording" };
    state = recorderReducer(state, {
      type: "stop",
      blob: fakeBlob,
      mimeType: "audio/webm",
      idempotencyKey: "key-1",
      estimatedDurationSeconds: 42,
    });
    assert.equal(state.status, "stopped");
    assert.equal(state.blob, fakeBlob);

    state = recorderReducer(state, { type: "upload" });
    assert.equal(state.status, "uploading");
    assert.equal(state.blob, fakeBlob);

    state = recorderReducer(state, { type: "uploadFailed", code: "transcription_failed", message: "nope" });
    assert.equal(state.status, "error");
    assert.equal(state.blob, fakeBlob, "a failed transcription must not lose the user's recording");

    // Only an explicit discard clears it.
    state = recorderReducer(state, { type: "discard" });
    assert.equal(state.blob, null);
  });

  await test("recorderReducer preserves blob through a save failure too", () => {
    let state = { ...INITIAL_RECORDER_STATE, status: "review", blob: { marker: "x" }, result: {} };
    state = recorderReducer(state, { type: "save" });
    assert.equal(state.status, "saving");
    state = recorderReducer(state, { type: "saveFailed", message: "db down" });
    assert.equal(state.status, "review");
    assert.deepEqual(state.blob, { marker: "x" });
  });

  /* ---------- 5. result saves as a normal note and appears in study cards ---------- */

  await test("mapAiResultToItems produces a page + study cards from a normal result", () => {
    let n = 0;
    const uid = () => `id${n++}`;
    const result = {
      summaryFailed: false,
      original: {
        overview: "An overview.",
        keyPoints: ["point one"],
        terms: [{ term: "Osmosis", content: "Movement of water across a membrane." }],
        assessable: ["this will be on the exam"],
        openQuestions: ["what about plants?"],
      },
      translated: null,
    };
    const { pageItem, noteItems } = mapAiResultToItems({
      result,
      course: "BIO101",
      week: "3",
      language: null,
      uid,
      nowISO: () => "2024-01-01T00:00:00.000Z",
    });
    assert.equal(pageItem.kind, "text");
    assert.equal(pageItem.folderId, null);
    assert.equal(pageItem.aiMeta.translations.en, result.original);
    assert.equal(noteItems.length, 1);
    assert.deepEqual(noteItems[0], { id: "id1", course: "BIO101", week: "3", term: "Osmosis", content: "Movement of water across a membrane." });
  });

  await test("mapAiResultToItems falls back to a plain transcript note when summarizing failed", () => {
    const result = { summaryFailed: true, transcript: "raw lecture transcript text" };
    const { pageItem, noteItems } = mapAiResultToItems({
      result,
      course: "BIO101",
      week: "3",
      language: null,
      uid: () => "idX",
      nowISO: () => "2024-01-01T00:00:00.000Z",
    });
    assert.equal(noteItems.length, 0, "nothing structured to turn into study cards when summarizing failed");
    assert.ok(pageItem.body.includes("raw lecture transcript text"), "the paid-for transcript must not be discarded");
    assert.equal(pageItem.aiMeta, undefined);
  });

  /* ---------- demo/no-account mode doesn't crash ---------- */

  await test("fetchUsage never crashes with no session or no Supabase client", async () => {
    assert.deepEqual(await fetchUsage(null), { minutesUsed: 0, unavailable: true });
    assert.deepEqual(
      await fetchUsage({ user: { id: "u1" } }, { supabaseClient: null, isDemo: false }),
      { minutesUsed: 0, unavailable: true }
    );
    assert.deepEqual(
      await fetchUsage({ user: { id: "u1" } }, { supabaseClient: {}, isDemo: true }),
      { minutesUsed: 0, unavailable: true }
    );
  });

  /* ---------- the guard that decides whether we pay money ---------- */

  await test("checkRequestGuards rejects on real byte size even with a tiny claimed duration", () => {
    const g = checkRequestGuards({
      estimatedDurationSeconds: 5,
      receivedBytes: 100_000_000,
      minutesUsedThisMonth: 0,
      monthlyLimitMinutes: 300,
      maxRequestSeconds: 3 * 3600,
      maxBodyBytes: 46_000_000,
    });
    assert.equal(g.ok, false);
    assert.equal(g.code, "recording_too_long");
  });

  await test("checkRequestGuards rejects on an oversized claimed duration alone", () => {
    const g = checkRequestGuards({
      estimatedDurationSeconds: 4 * 3600,
      receivedBytes: 1000,
      minutesUsedThisMonth: 0,
      monthlyLimitMinutes: 300,
      maxRequestSeconds: 3 * 3600,
      maxBodyBytes: 46_000_000,
    });
    assert.equal(g.ok, false);
    assert.equal(g.code, "recording_too_long");
  });

  await test("checkRequestGuards rejects when this request would push usage over the cap", () => {
    const g = checkRequestGuards({
      estimatedDurationSeconds: 600, // 10 minutes
      receivedBytes: 1000,
      minutesUsedThisMonth: 295,
      monthlyLimitMinutes: 300,
      maxRequestSeconds: 3 * 3600,
      maxBodyBytes: 46_000_000,
    });
    assert.equal(g.ok, false);
    assert.equal(g.code, "usage_exceeded");
  });

  await test("checkRequestGuards passes a normal small request", () => {
    const g = checkRequestGuards({
      estimatedDurationSeconds: 600,
      receivedBytes: 1_000_000,
      minutesUsedThisMonth: 0,
      monthlyLimitMinutes: 300,
      maxRequestSeconds: 3 * 3600,
      maxBodyBytes: 46_000_000,
    });
    assert.equal(g.ok, true);
  });

  /* ---------- swapping the transcription provider can't silently break billing ---------- */

  await test("groqAdapter and deepgramAdapter return the identical shape given equivalent mocked responses", async () => {
    const fakeGroqFetch = async () => ({ ok: true, json: async () => ({ text: "hello world", duration: 12.5 }) });
    const groqResult = await groqAdapter.transcribe({
      audioUrl: "https://example.com/a.webm",
      apiKey: "k",
      fetchImpl: fakeGroqFetch,
    });
    assert.deepEqual(Object.keys(groqResult).sort(), ["durationSeconds", "transcript"]);
    assert.equal(groqResult.transcript, "hello world");
    assert.equal(groqResult.durationSeconds, 12.5);

    const fakeDeepgramFetch = async () => ({
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: "hello world" }] }] },
        metadata: { duration: 12.5 },
      }),
    });
    const dgResult = await deepgramAdapter.transcribe({
      audioUrl: "https://example.com/a.webm",
      apiKey: "k",
      fetchImpl: fakeDeepgramFetch,
    });
    assert.deepEqual(groqResult, dgResult, "swapping providers must not change the shape billing/saving code relies on");
  });

  await test("a provider's reported duration flows through to billed minutes correctly", () => {
    assert.equal(minutesFromSeconds(120), 2);
    assert.equal(minutesFromSeconds(90), 1.5);
    assert.equal(minutesFromSeconds(0), 0);
    assert.equal(minutesFromSeconds(undefined), 0, "a missing/zero duration must bill zero, not throw or bill NaN");
  });

  await test("selectTranscriber actually switches which adapter gets called", () => {
    const providers = { deepgram: deepgramAdapter, groq: groqAdapter };
    assert.equal(selectTranscriber(providers, "groq", "deepgram").name, "groq");
    assert.equal(selectTranscriber(providers, "deepgram", "groq").name, "deepgram");
    // Missing/unknown override falls back to the configured default rather
    // than silently calling no adapter at all.
    assert.equal(selectTranscriber(providers, undefined, "groq").name, "groq");
    assert.equal(selectTranscriber(providers, "not-a-real-provider", "deepgram").name, "deepgram");
  });

  await test("a Groq failure is handled the same way a Deepgram failure is (both throw, so index.ts's single catch-all covers either)", async () => {
    const emptyGroqFetch = async () => ({ ok: true, json: async () => ({ text: "", duration: 0 }) });
    await assert.rejects(() => groqAdapter.transcribe({ audioUrl: "u", apiKey: "k", fetchImpl: emptyGroqFetch }));

    const failedGroqFetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(() => groqAdapter.transcribe({ audioUrl: "u", apiKey: "k", fetchImpl: failedGroqFetch }));

    const emptyDeepgramFetch = async () => ({
      ok: true,
      json: async () => ({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }),
    });
    await assert.rejects(() => deepgramAdapter.transcribe({ audioUrl: "u", apiKey: "k", fetchImpl: emptyDeepgramFetch }));
  });

  /* ---------- a size/duration rejection can't strand the recording in a retry loop ---------- */

  await test("isSizeError recognizes Groq's documented 413 status regardless of body", () => {
    assert.equal(isSizeError(413, null), true);
    assert.equal(isSizeError(413, {}), true);
  });

  await test("isSizeError falls back to matching size/duration wording for a non-413 rejection", () => {
    assert.equal(isSizeError(400, { error: { message: "File size exceeds the maximum allowed.", type: "invalid_request_error" } }), true);
    assert.equal(isSizeError(400, { error: { message: "Audio duration is too long for this model.", type: "invalid_request_error" } }), true);
  });

  await test("isSizeError does not misclassify an unrelated failure", () => {
    assert.equal(isSizeError(500, null), false);
    assert.equal(isSizeError(401, { error: { message: "Invalid API key", type: "invalid_request_error" } }), false);
  });

  await test("groqAdapter throws a distinguishable, actionable error on a 413 rejection", async () => {
    const tooLargeFetch = async () => ({
      ok: false,
      status: 413,
      json: async () => ({ error: { message: "Payload too large", type: "invalid_request_error" } }),
    });
    let thrown = null;
    try {
      await groqAdapter.transcribe({ audioUrl: "u", apiKey: "k", fetchImpl: tooLargeFetch });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "expected groqAdapter to throw");
    assert.equal(thrown.code, "too_large");
    assert.match(thrown.message, /shorter segments|too long/i);
  });

  await test("parseAiNotesError and PERMANENT_FAILURE_CODES agree on which codes shouldn't invite a retry", () => {
    assert.equal(parseAiNotesError({ code: "transcription_too_long" }, 413), "This recording is too long to process — try recording in shorter segments.");
    assert.ok(PERMANENT_FAILURE_CODES.has("transcription_too_long"));
    assert.ok(PERMANENT_FAILURE_CODES.has("recording_too_long"));
    // A transient failure must still be retryable.
    assert.ok(!PERMANENT_FAILURE_CODES.has("transcription_failed"));
  });

  /* ---------- a sync merge can't silently drop consent ---------- */

  await test("mergeData: an acceptance on either side survives", () => {
    const consented = {
      semesters: {},
      meta: { updatedAt: "2024-01-01T00:00:00.000Z", aiConsent: { version: 1, acceptedAt: "2024-01-01T00:00:00.000Z" } },
    };
    const notConsentedButNewer = { semesters: {}, meta: { updatedAt: "2024-06-01T00:00:00.000Z" } };

    assert.deepEqual(mergeData(consented, notConsentedButNewer).meta.aiConsent, consented.meta.aiConsent);
    assert.deepEqual(mergeData(notConsentedButNewer, consented).meta.aiConsent, consented.meta.aiConsent);
  });

  await test("mergeData: same version, earliest acceptedAt wins", () => {
    const earlier = { semesters: {}, meta: { updatedAt: "2024-01-01T00:00:00.000Z", aiConsent: { version: 1, acceptedAt: "2024-01-01T00:00:00.000Z" } } };
    const later = { semesters: {}, meta: { updatedAt: "2024-03-01T00:00:00.000Z", aiConsent: { version: 1, acceptedAt: "2024-02-01T00:00:00.000Z" } } };
    assert.equal(mergeData(earlier, later).meta.aiConsent.acceptedAt, "2024-01-01T00:00:00.000Z");
    assert.equal(mergeData(later, earlier).meta.aiConsent.acceptedAt, "2024-01-01T00:00:00.000Z");
  });

  await test("mergeData: a newer consentVersion always wins, even over an earlier timestamp on the 'newer' side", () => {
    // v1 is "newer" by meta.updatedAt AND has a later acceptedAt than v2 --
    // and must still lose to v2, since v2 represents agreeing to updated
    // wording. This is the regression case for the version-vs-timestamp bug.
    const v1 = { semesters: {}, meta: { updatedAt: "2024-05-01T00:00:00.000Z", aiConsent: { version: 1, acceptedAt: "2024-04-01T00:00:00.000Z" } } };
    const v2 = { semesters: {}, meta: { updatedAt: "2024-01-01T00:00:00.000Z", aiConsent: { version: 2, acceptedAt: "2024-01-15T00:00:00.000Z" } } };
    assert.equal(mergeData(v1, v2).meta.aiConsent.version, 2);
    assert.equal(mergeData(v2, v1).meta.aiConsent.version, 2);
  });

  /* ---------- the native apps can actually reach the microphone ---------- */

  /* Fixtures mirror what `cap add ios` / `cap add android` actually
     generate — neither declares a microphone, which is the whole reason
     mobile/scripts/native-permissions.mjs exists. */

  const CAP_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>University Planner</string>
\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<false/>
\t</dict>
\t<key>UIRequiredDeviceCapabilities</key>
\t<array>
\t\t<string>armv7</string>
\t</array>
</dict>
</plist>
`;

  const CAP_ANDROID_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" />
    </application>

    <!-- Permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

  function parseXml(xml, label) {
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const errors = dom.window.document.getElementsByTagName("parsererror");
    assert.equal(errors.length, 0, `${label} is no longer well-formed XML after patching`);
    return dom.window.document;
  }

  /** Direct <key> children of the plist's root <dict>, in document order. */
  function rootDictKeys(doc) {
    const rootDict = doc.documentElement.getElementsByTagName("dict")[0];
    return [...rootDict.children].filter((el) => el.tagName === "key").map((el) => el.textContent);
  }

  await test("patchInfoPlist adds the microphone usage string Apple requires", () => {
    const { xml, changed } = patchInfoPlist(CAP_INFO_PLIST);
    assert.equal(changed, true);
    const doc = parseXml(xml, "Info.plist");

    // It has to land in the ROOT dict — dropped inside the nested
    // UIApplicationSceneManifest dict it parses fine and does nothing.
    assert.ok(rootDictKeys(doc).includes(IOS_PLIST_KEY), `${IOS_PLIST_KEY} must be a key of the root dict`);

    const rootDict = doc.documentElement.getElementsByTagName("dict")[0];
    const children = [...rootDict.children];
    const keyIndex = children.findIndex((el) => el.tagName === "key" && el.textContent === IOS_PLIST_KEY);
    const value = children[keyIndex + 1];
    assert.equal(value.tagName, "string", "a plist key must be followed by its value element");
    assert.equal(value.textContent, MIC_USAGE_DESCRIPTION);
    // Everything Capacitor generated is still there.
    assert.ok(rootDictKeys(doc).includes("CFBundleDisplayName"));
  });

  await test("patchInfoPlist is idempotent and never overwrites a reworded description", () => {
    const once = patchInfoPlist(CAP_INFO_PLIST);
    const twice = patchInfoPlist(once.xml);
    assert.equal(twice.changed, false, "re-running cap sync must not append a second copy of the key");
    assert.equal(twice.xml, once.xml);

    const reworded = patchInfoPlist(CAP_INFO_PLIST, "A deliberately different wording.");
    const left = patchInfoPlist(reworded.xml);
    assert.equal(left.changed, false);
    assert.ok(left.xml.includes("A deliberately different wording."), "a hand-edited description must survive");
  });

  await test("patchAndroidManifest declares RECORD_AUDIO exactly once, alongside the existing permissions", () => {
    const { xml, changed } = patchAndroidManifest(CAP_ANDROID_MANIFEST);
    assert.equal(changed, true);
    const doc = parseXml(xml, "AndroidManifest.xml");

    const declared = [...doc.getElementsByTagName("uses-permission")].map((el) =>
      el.getAttribute("android:name")
    );
    assert.deepEqual(declared, ["android.permission.INTERNET", ANDROID_PERMISSION]);

    const again = patchAndroidManifest(xml);
    assert.equal(again.changed, false, "re-running cap sync must not duplicate the permission");
    assert.equal(again.xml, xml);
  });

  await test("patchAndroidManifest still works on a manifest that declares no permissions at all", () => {
    const bare = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name" />
</manifest>
`;
    const { xml, changed } = patchAndroidManifest(bare);
    assert.equal(changed, true);
    const doc = parseXml(xml, "AndroidManifest.xml");
    const permissions = [...doc.getElementsByTagName("uses-permission")];
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].getAttribute("android:name"), ANDROID_PERMISSION);
    assert.equal(permissions[0].parentNode.tagName, "manifest", "uses-permission belongs directly under <manifest>");
  });

  await test("the OS permission prompt makes the same promise the in-app consent does", () => {
    // Two places tell the user what happens to their audio: the consent
    // gate and iOS's own microphone dialog. If they ever disagree, one of
    // them is misleading — this is the nag that stops that drifting.
    const consentPromise = CONSENT_TEXT.bullets.find((b) => /not retained/i.test(b));
    assert.ok(consentPromise, "consent wording no longer promises audio isn't retained — update MIC_USAGE_DESCRIPTION to match");
    assert.match(MIC_USAGE_DESCRIPTION, /not retained/i);
    assert.match(MIC_USAGE_DESCRIPTION, /record lectures/i, "Apple rejects a usage string that doesn't say what the mic is for");
  });

  /* ---------- the migration tests can't quietly stop running ---------- */

  /* These two guard the wiring rather than the app, and they live in this
     file specifically because this is the suite that always runs. Putting
     them in test-migrations.mjs would be circular: that file skips itself
     without a database, so a guard inside it would skip too, in exactly
     the situation it's meant to catch. */

  await test("npm test still runs the migration tests", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(
      pkg.scripts.test,
      /test-migrations\.mjs/,
      "the migration tests were dropped from `npm test` — CI's postgres run goes through this script"
    );
  });

  await test("CI forces the migration tests to run rather than skip", () => {
    const workflow = fs.readFileSync(path.join(rootDir, ".github/workflows/test.yml"), "utf8");
    // REQUIRE_POSTGRES is the whole reason local skipping is acceptable:
    // it turns "no postgres, never mind" into a failed build. Without it
    // CI would still be green while testing none of the SQL.
    assert.match(workflow, /REQUIRE_POSTGRES:\s*"1"/, "the test workflow no longer forces the migration tests to run");
    assert.match(workflow, /PGHOST:/, "the test workflow no longer points the tests at its postgres service");
    assert.match(workflow, /image:\s*postgres:/, "the test workflow no longer starts a postgres service container");
  });

  /* ---------- no API key ever ends up in the shipped bundle ---------- */

  await test("dist-web/app.js contains no leaked provider keys or secrets", () => {
    const bundlePath = path.join(rootDir, "dist-web", "app.js");
    if (!fs.existsSync(bundlePath)) {
      console.warn('        (skipped: dist-web/app.js not found - run "npm run build:web" first)');
      return;
    }
    const js = fs.readFileSync(bundlePath, "utf8");
    // "Token " (Deepgram's Authorization header scheme) deliberately isn't
    // checked here — it collides with unrelated text already shipped by
    // @supabase/supabase-js itself (an "...accessToken option..." error
    // message), and that code path never exists client-side anyway (the
    // Deepgram adapter only runs inside the Edge Function). The literal
    // secret env var names and key-prefix patterns below are what actually
    // matter.
    for (const forbidden of ["sk-", "DEEPGRAM_API_KEY", "OPENAI_API_KEY", "service_role"]) {
      assert.ok(!js.includes(forbidden), `bundle must not contain "${forbidden}"`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
