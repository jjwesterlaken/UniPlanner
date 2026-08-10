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
import { mergeData, COLLECTIONS, purgeOldTombstones } from "../src/sync.js";
import {
  schedule,
  readSrs,
  isNew,
  isDue,
  localDay,
  addDays,
  daysBetween,
  interleave,
  buildReviewSession,
  buildPracticeSession,
  weakSpots,
  recordStudy,
  pruneStats,
  windowDays,
  studySummary,
  clampSessionMinutes,
  idleTimer,
  timerElapsedMs,
  timerStart,
  timerPause,
  timerStop,
  timerDiscard,
  timerPark,
  findTotals,
  dayId,
  EASE_MIN,
  EASE_MAX,
  EASE_DEFAULT,
  WINDOW_DAYS,
  TOMBSTONE_DAYS,
  MAX_SESSION_MINUTES,
} from "../src/srs.js";
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

  /* ---------- spaced repetition: the scheduler ---------- */

  const TODAY = "2026-08-10";
  const card = (srs, extra = {}) => ({ id: "c1", course: "BIO101", term: "Osmosis", ...extra, ...(srs ? { srs } : {}) });

  await test("a card with no srs is new and due immediately", () => {
    // Every card that exists in every user's account today. This is the
    // no-migration guarantee: they must all just work.
    assert.equal(isNew(card(null)), true);
    assert.equal(isDue(card(null), TODAY), true);
    assert.equal(readSrs(card(null)), null);
  });

  await test("legacy, partial and corrupt srs shapes degrade to 'new' rather than throwing", () => {
    // A bad field must never make a card unstudiable.
    for (const bad of [{}, { d: "not-a-date", i: 1, e: 2.5, n: 1 }, { d: "2026-08-10", i: "x", e: "y", n: "z" }, "nonsense", 42, []]) {
      const c = { id: "c", srs: bad };
      assert.equal(readSrs(c), null, `should have been treated as new: ${JSON.stringify(bad)}`);
      assert.equal(isDue(c, TODAY), true);
    }
  });

  await test("first Good sets a 1 day interval; the next Good multiplies by ease", () => {
    const first = schedule(card(null), "good", TODAY);
    assert.equal(first.i, 1);
    assert.equal(first.d, "2026-08-11");
    assert.equal(first.n, 1);
    assert.equal(first.e, EASE_DEFAULT);

    const second = schedule(card(first), "good", "2026-08-11");
    assert.equal(second.i, Math.round(1 * EASE_DEFAULT)); // 3 days
    assert.equal(second.d, "2026-08-14");
    assert.equal(second.n, 2);
  });

  await test("Easy raises ease and jumps further than Good", () => {
    const base = { d: TODAY, i: 10, e: 2.5, l: 0, n: 4 };
    const good = schedule(card(base), "good", TODAY);
    const easy = schedule(card(base), "easy", TODAY);
    assert.ok(easy.e > base.e, "Easy must raise ease");
    assert.equal(good.e, base.e, "Good must leave ease alone");
    assert.ok(easy.i > good.i, `Easy (${easy.i}d) must outrun Good (${good.i}d)`);
  });

  await test("Again lapses the card: ease drops, interval resets, it returns today", () => {
    const base = { d: TODAY, i: 20, e: 2.5, l: 1, n: 9 };
    const after = schedule(card(base), "again", TODAY);
    assert.equal(after.i, 0, "a failed card must not be scheduled days away");
    assert.equal(after.d, TODAY, "it should come back in this same session");
    assert.equal(after.l, 2, "the lapse must be counted");
    assert.ok(after.e < base.e, "ease must drop");
    assert.equal(after.n, 10, "reps count exposure, including failures");
    assert.equal(isDue(card(after), TODAY), true);
  });

  await test("ease is clamped at both ends however it's driven", () => {
    let s = { d: TODAY, i: 1, e: EASE_DEFAULT, l: 0, n: 1 };
    for (let i = 0; i < 40; i++) s = schedule(card(s), "again", TODAY);
    assert.ok(s.e >= EASE_MIN, `ease fell through the floor: ${s.e}`);
    assert.equal(s.e, EASE_MIN);

    let t = { d: TODAY, i: 1, e: EASE_DEFAULT, l: 0, n: 1 };
    for (let i = 0; i < 40; i++) t = schedule(card(t), "easy", TODAY);
    assert.ok(t.e <= EASE_MAX, `ease broke the ceiling: ${t.e}`);
    assert.equal(t.e, EASE_MAX);
  });

  await test("a card is not due before its due date, and is due on it", () => {
    const s = { d: "2026-08-14", i: 3, e: 2.5, l: 0, n: 2 };
    assert.equal(isDue(card(s), "2026-08-13"), false);
    assert.equal(isDue(card(s), "2026-08-14"), true);
    assert.equal(isDue(card(s), "2026-08-20"), true);
  });

  await test("addDays and daysBetween survive a DST boundary", () => {
    // Built from local getters rather than toISOString precisely so an
    // hour shift can't move a study day onto the wrong date.
    assert.equal(addDays("2026-04-04", 1), "2026-04-05"); // AU DST ends
    assert.equal(addDays("2026-10-03", 1), "2026-10-04"); // AU DST starts
    assert.equal(daysBetween("2026-04-04", "2026-04-05"), 1);
    assert.equal(daysBetween("2026-10-03", "2026-10-04"), 1);
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(daysBetween("2026-08-10", "2026-08-10"), 0);
  });

  /* ---------- interleaved practice ---------- */

  await test("interleaving avoids putting two cards from one course together", () => {
    const cards = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, course: "BIO101" })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, course: "CHEM110" })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, course: "MATH120" })),
    ];
    const out = interleave(cards, () => 0.5);
    assert.equal(out.length, 12, "every card must survive interleaving");
    let repeats = 0;
    for (let i = 1; i < out.length; i++) if (out[i].course === out[i - 1].course) repeats++;
    assert.equal(repeats, 0, "with three balanced courses no repeat is necessary");
  });

  await test("interleaving degrades gracefully when one course dominates", () => {
    // 10 BIO + 1 CHEM cannot avoid adjacent BIO cards -- that's arithmetic.
    // What matters is that nothing is dropped or duplicated.
    const cards = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, course: "BIO101" })),
      { id: "b0", course: "CHEM110" },
    ];
    const out = interleave(cards, () => 0.5);
    assert.equal(out.length, 11);
    assert.equal(new Set(out.map((c) => c.id)).size, 11, "no duplicates");
  });

  await test("a review session pulls due cards from every course; practice ignores due dates", () => {
    const cards = [
      { id: "a", course: "BIO101", srs: { d: "2026-08-01", i: 2, e: 2.5, l: 0, n: 3 } }, // due
      { id: "b", course: "CHEM110" }, // new, due
      { id: "c", course: "BIO101", srs: { d: "2026-09-01", i: 9, e: 2.5, l: 0, n: 5 } }, // not due
    ];
    const review = buildReviewSession(cards, { today: TODAY, rand: () => 0.5 });
    assert.deepEqual(review.map((c) => c.id).sort(), ["a", "b"], "only due cards, across courses");

    const practice = buildPracticeSession(cards, "BIO101", { rand: () => 0.5 });
    assert.deepEqual(practice.map((c) => c.id).sort(), ["a", "c"], "practice drills the whole course");
  });

  await test("cards with no course still group and study", () => {
    const cards = [{ id: "a" }, { id: "b", course: "" }];
    assert.equal(buildReviewSession(cards, { today: TODAY, rand: () => 0.5 }).length, 2);
    assert.equal(buildPracticeSession(cards, "No course", { rand: () => 0.5 }).length, 2);
  });

  /* ---------- weak spots (derived, never stored) ---------- */

  await test("weak spots rank by lapses then ease, grouped by course", () => {
    const cards = [
      { id: "bad", course: "BIO101", srs: { d: TODAY, i: 1, e: 1.6, l: 5, n: 12 } },
      { id: "mid", course: "BIO101", srs: { d: TODAY, i: 3, e: 2.2, l: 2, n: 6 } },
      { id: "fine", course: "CHEM110", srs: { d: TODAY, i: 9, e: 2.5, l: 0, n: 4 } },
      { id: "new", course: "CHEM110" },
    ];
    const groups = weakSpots(cards);
    assert.deepEqual([...groups.keys()], ["BIO101"], "only courses with weak cards appear");
    assert.deepEqual(groups.get("BIO101").map((r) => r.card.id), ["bad", "mid"]);
    assert.ok(!JSON.stringify(cards).includes("weak"), "weak spots must not write anything onto cards");
  });

  /* ---------- daily stats: the 42-day window and its tombstones ---------- */

  await test("the daily log never exceeds 42 live day entries", () => {
    let stats = [];
    // 200 consecutive days of study, one write each.
    let day = "2026-01-01";
    for (let i = 0; i < 200; i++) {
      stats = recordStudy(stats, { day, course: "BIO101", minutes: 10, cards: 5, now: `${day}T09:00:00.000Z` });
      day = addDays(day, 1);
    }
    const lastDay = addDays(day, -1);
    const live = windowDays(stats, lastDay);
    assert.ok(live.length <= WINDOW_DAYS, `window held ${live.length} days, cap is ${WINDOW_DAYS}`);
    assert.equal(live.length, WINDOW_DAYS, "a 200-day streak should fill the window exactly");
  });

  await test("the whole studyStats collection stays bounded, tombstones included", () => {
    let stats = [];
    let day = "2026-01-01";
    for (let i = 0; i < 400; i++) {
      stats = recordStudy(stats, { day, course: "BIO101", minutes: 10, cards: 5, now: `${day}T09:00:00.000Z` });
      day = addDays(day, 1);
    }
    // 42 live days + at most 60 days of tombstones + 1 totals row.
    assert.ok(stats.length <= WINDOW_DAYS + TOMBSTONE_DAYS + 1, `collection grew to ${stats.length} items`);
    const bytes = Buffer.byteLength(JSON.stringify(stats));
    assert.ok(bytes < 12 * 1024, `studyStats reached ${bytes} bytes, over the 12KB ceiling`);
  });

  await test("srs.js and sync.js agree on how long a tombstone lives", () => {
    // pruneStats drops its own tombstones because sync.js's purge only
    // runs when syncing; if that constant ever moves, this must move too.
    const src = fs.readFileSync(path.join(rootDir, "src/sync.js"), "utf8");
    const m = src.match(/TOMBSTONE_DAYS\s*=\s*(\d+)/);
    assert.ok(m, "could not find TOMBSTONE_DAYS in sync.js");
    assert.equal(Number(m[1]), TOMBSTONE_DAYS);
  });

  await test("pruning tombstones rather than deleting, so a sync can't resurrect a dropped day", () => {
    const old = "2026-01-01";
    const today = addDays(old, WINDOW_DAYS + 5);
    let local = recordStudy([], { day: old, course: "BIO101", minutes: 10, cards: 5, now: `${old}T09:00:00.000Z` });
    local = pruneStats(local, today, `${today}T09:00:00.000Z`);

    const pruned = local.find((it) => it.id === dayId(old));
    assert.ok(pruned, "the day must remain as a tombstone, not vanish");
    assert.ok(pruned.deletedAt, "a plain delete would be re-added by the next sync");
    assert.equal(pruned.m, undefined, "tombstone payload should be stripped to save bytes");
  });

  await test("a pruned day does not come back after merging with a device that still has it", () => {
    const old = "2026-01-01";
    const today = addDays(old, WINDOW_DAYS + 5);
    const stale = recordStudy([], { day: old, course: "BIO101", minutes: 30, cards: 9, now: `${old}T09:00:00.000Z` });
    const pruned = pruneStats(stale, today, `${today}T09:00:00.000Z`);

    const semester = (studyStats) => ({
      courses: [], todos: [], textbook: [], assignments: [], notes: [], events: [], pages: [], folders: [], studyStats,
    });
    const merged = mergeData(
      { semesters: { "Semester 1": semester(pruned) }, meta: { updatedAt: `${today}T09:00:00.000Z` } },
      { semesters: { "Semester 1": semester(stale) }, meta: { updatedAt: `${old}T09:00:00.000Z` } }
    );
    const row = merged.semesters["Semester 1"].studyStats.find((it) => it.id === dayId(old));
    assert.ok(row.deletedAt, "the tombstone must win over the other device's live copy");
    assert.equal(windowDays(merged.semesters["Semester 1"].studyStats, today).length, 0);
  });

  await test("a day outside the window is ignored even if a sync resurrects it", () => {
    // Correctness must not depend on pruning having run.
    const old = "2026-01-01";
    const today = addDays(old, WINDOW_DAYS + 5);
    const resurrected = [{ id: dayId(old), m: { BIO101: 999 }, c: 999, updatedAt: `${today}T10:00:00.000Z` }];
    assert.equal(windowDays(resurrected, today).length, 0);
    const summary = studySummary(resurrected, today);
    assert.equal(summary.minutesToday, 0);
    assert.equal(summary.minutesWeek, 0);
    assert.equal(summary.cardsToday, 0);
  });

  /* ---------- streaks are read-time, not write-time ---------- */

  await test("a streak that has lapsed reads as 0, however good it once was", () => {
    // The bug this prevents: someone who last studied a week ago being
    // told they're on a 5-day streak.
    let stats = [];
    let day = "2026-08-01";
    for (let i = 0; i < 5; i++) {
      stats = recordStudy(stats, { day, course: "BIO101", minutes: 10, cards: 3, now: `${day}T09:00:00.000Z` });
      day = addDays(day, 1);
    }
    const lastStudied = "2026-08-05";
    assert.equal(studySummary(stats, lastStudied).current, 5, "on the day itself the streak stands");
    assert.equal(studySummary(stats, addDays(lastStudied, 1)).current, 5, "the next day it still stands");
    assert.equal(studySummary(stats, addDays(lastStudied, 2)).current, 0, "a missed day breaks it");
    assert.equal(studySummary(stats, addDays(lastStudied, 7)).current, 0, "a week later it is certainly 0");
    assert.equal(studySummary(stats, addDays(lastStudied, 7)).longest, 5, "but the record survives");
  });

  await test("the longest streak only ever moves upward", () => {
    let stats = [];
    for (const day of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
      stats = recordStudy(stats, { day, course: "BIO", minutes: 5, cards: 1, now: `${day}T09:00:00.000Z` });
    }
    assert.equal(findTotals(stats).max, 3);
    // A gap, then a shorter streak.
    stats = recordStudy(stats, { day: "2026-08-20", course: "BIO", minutes: 5, cards: 1, now: "2026-08-20T09:00:00.000Z" });
    assert.equal(findTotals(stats).cur, 1, "the current streak restarts");
    assert.equal(findTotals(stats).max, 3, "the record must not be overwritten downward");
  });

  await test("studying twice in one day doesn't inflate the streak", () => {
    let stats = recordStudy([], { day: "2026-08-01", course: "BIO", minutes: 5, cards: 1, now: "2026-08-01T09:00:00.000Z" });
    stats = recordStudy(stats, { day: "2026-08-01", course: "BIO", minutes: 5, cards: 1, now: "2026-08-01T10:00:00.000Z" });
    assert.equal(findTotals(stats).cur, 1);
    assert.equal(studySummary(stats, "2026-08-01").minutesToday, 10, "but the minutes do add up");
    assert.equal(studySummary(stats, "2026-08-01").cardsToday, 2);
  });

  /* ---------- increments read fresh, so a mid-session sync isn't clobbered ---------- */

  await test("a sync landing mid-session is added to, not overwritten", () => {
    const day = "2026-08-10";
    // This device logs 10 minutes.
    let mine = recordStudy([], { day, course: "BIO101", minutes: 10, cards: 4, now: `${day}T09:00:00.000Z` });
    // A sync arrives carrying the other device's 25 minutes for the same day.
    const merged = mine.map((it) =>
      it.id === dayId(day) ? { ...it, m: { BIO101: 25 }, c: 9, updatedAt: `${day}T09:30:00.000Z` } : it
    );
    // Committing again must read the CURRENT collection, not a cached one.
    const after = recordStudy(merged, { day, course: "BIO101", minutes: 5, cards: 2, now: `${day}T09:31:00.000Z` });
    const row = after.find((it) => it.id === dayId(day));
    assert.equal(row.m.BIO101, 30, "5 must be added to the synced 25, not to this device's stale 10");
    assert.equal(row.c, 11);
  });

  await test("minutes are tracked per course and split correctly", () => {
    let stats = recordStudy([], { day: "2026-08-10", course: "BIO101", minutes: 20, cards: 0, now: "2026-08-10T09:00:00.000Z" });
    stats = recordStudy(stats, { day: "2026-08-10", course: "CHEM110", minutes: 35, cards: 0, now: "2026-08-10T10:00:00.000Z" });
    const s = studySummary(stats, "2026-08-10");
    assert.equal(s.minutesToday, 55);
    assert.deepEqual(s.byCourse, { BIO101: 20, CHEM110: 35 });
  });

  await test("an abandoned timer is clamped instead of logging the whole night", () => {
    assert.equal(clampSessionMinutes(14 * 60), MAX_SESSION_MINUTES);
    assert.equal(clampSessionMinutes(30), 30);
    assert.equal(clampSessionMinutes(-5), 0);
    assert.equal(clampSessionMinutes(NaN), 0);
    assert.equal(clampSessionMinutes(undefined), 0);
  });

  /* ---------- the study timer's transitions ---------- */

  const T0 = 1_760_000_000_000; // a fixed "now" in ms
  const running = (mins) => ({ course: "BIO101", startedAt: T0, accumulatedMs: 0 });
  const min = (n) => n * 60000;

  await test("committed minutes cannot be parked again", () => {
    // The regression for the same-tick re-park: the component mirrors the
    // timer into a ref so it can park on unmount, and if a save left the
    // committed minutes in that state, an unmount in the same tick would
    // write them back to localStorage and offer them for a second save.
    const t = running();
    const stopped = timerStop(t, T0 + min(30));
    assert.equal(stopped.recorded, true);
    assert.equal(stopped.minutes, 30);
    assert.equal(
      timerPark(stopped.next, T0 + min(30)),
      null,
      "minutes that were just logged must leave nothing behind to log again"
    );
    // ...and still nothing even if the park happens some time later.
    assert.equal(timerPark(stopped.next, T0 + min(90)), null);
  });

  await test("discarding a timer leaves nothing to park either", () => {
    const t = { course: "BIO101", startedAt: T0, accumulatedMs: min(12) };
    assert.equal(timerPark(timerDiscard(t), T0 + min(20)), null);
  });

  await test("parking a running timer keeps the time but stops the clock", () => {
    const parked = timerPark(running(), T0 + min(8));
    assert.equal(parked.accumulatedMs, min(8));
    assert.equal(parked.startedAt, null, "a parked timer must not keep accruing while the user is elsewhere");
    assert.equal(parked.course, "BIO101");
    // Re-parking later must not add the time spent away.
    assert.equal(timerPark(parked, T0 + min(99)).accumulatedMs, min(8));
  });

  await test("pause then start again resumes from where it stopped", () => {
    const paused = timerPause(running(), T0 + min(5));
    assert.equal(paused.accumulatedMs, min(5));
    const resumed = timerStart(paused, T0 + min(60)); // 55 minutes later
    assert.equal(timerElapsedMs(resumed, T0 + min(61)), min(6), "the gap while paused must not count");
  });

  await test("starting an already-running timer changes nothing", () => {
    const t = running();
    assert.equal(timerStart(t, T0 + min(5)), t, "a second Start must not reset the clock");
  });

  await test("a session too short to record keeps the timer instead of eating it", () => {
    const t = { course: "BIO101", startedAt: T0, accumulatedMs: 0 };
    const stopped = timerStop(t, T0 + 2000); // two seconds
    assert.equal(stopped.recorded, false);
    assert.equal(stopped.minutes, 0, "a couple of seconds must not be rounded up into study time");
    assert.equal(stopped.tooShort, true, "the user pressed save -- they have to be told why nothing happened");
    assert.equal(stopped.next, t, "and their running timer must survive being told");
  });

  await test("a stopped timer that never ran reports nothing rather than 'too short'", () => {
    const stopped = timerStop(idleTimer("BIO101"), T0);
    assert.equal(stopped.recorded, false);
    assert.equal(stopped.tooShort, false, "there is nothing to explain when the timer was never started");
  });

  await test("an abandoned timer is capped when it's saved, not silently logged whole", () => {
    const stopped = timerStop(running(), T0 + min(14 * 60));
    assert.equal(stopped.minutes, MAX_SESSION_MINUTES);
    assert.equal(stopped.recorded, true);
  });

  /* ---------- demo mode: no backend, no crash ---------- */

  await test("every stats reader tolerates missing or empty collections", () => {
    // Demo mode has shipped a null-dereference before. Each of these is a
    // shape the UI can genuinely hold before anything has been studied.
    for (const empty of [undefined, null, []]) {
      assert.deepEqual(windowDays(empty, TODAY), []);
      assert.equal(findTotals(empty), null);
      const s = studySummary(empty, TODAY);
      assert.equal(s.current, 0);
      assert.equal(s.longest, 0);
      assert.equal(s.minutesToday, 0);
      assert.equal(s.cardsToday, 0);
      assert.deepEqual(s.byCourse, {});
      assert.deepEqual(weakSpots(empty).size, 0);
      assert.deepEqual(buildReviewSession(empty, { today: TODAY }), []);
      assert.deepEqual(interleave(empty), []);
      assert.deepEqual(pruneStats(empty, TODAY, "x"), []);
    }
  });

  /* ---------- the new collection has to survive a real sync ---------- */

  await test("a card carrying srs round-trips mergeData with nothing lost", () => {
    const srs = { d: "2026-08-14", i: 3, e: 2.5, l: 1, n: 7 };
    const sem = (extra) => ({
      courses: [], todos: [], textbook: [], assignments: [],
      notes: [{ id: "card1", course: "BIO101", term: "Osmosis", content: "x", srs, updatedAt: "2026-08-10T00:00:00.000Z", ...extra }],
      events: [], pages: [], folders: [], studyStats: [],
    });
    const merged = mergeData(
      { semesters: { "Semester 1": sem() }, meta: { updatedAt: "2026-08-10T00:00:00.000Z" } },
      { semesters: { "Semester 1": sem() }, meta: { updatedAt: "2026-08-09T00:00:00.000Z" } }
    );
    assert.deepEqual(merged.semesters["Semester 1"].notes[0].srs, srs);
  });

  await test("a studyStats item survives mergeData", () => {
    // The regression test for the blocker: mergeSemester rebuilds each
    // semester from a COLLECTIONS whitelist, so a collection missing from
    // that list is silently dropped on every sync.
    assert.ok(COLLECTIONS.includes("studyStats"), "studyStats must be in COLLECTIONS or it will not sync at all");

    const stats = recordStudy([], { day: "2026-08-10", course: "BIO101", minutes: 30, cards: 20, now: "2026-08-10T09:00:00.000Z" });
    const sem = (studyStats) => ({
      courses: [], todos: [], textbook: [], assignments: [], notes: [], events: [], pages: [], folders: [], studyStats,
    });
    const merged = mergeData(
      { semesters: { "Semester 1": sem(stats) }, meta: { updatedAt: "2026-08-10T09:00:00.000Z" } },
      { semesters: { "Semester 1": sem([]) }, meta: { updatedAt: "2026-08-09T00:00:00.000Z" } }
    );
    const out = merged.semesters["Semester 1"].studyStats;
    assert.ok(Array.isArray(out) && out.length > 0, "studyStats was dropped by the merge");
    assert.equal(studySummary(out, "2026-08-10").minutesToday, 30);
  });

  await test("two devices studying different days both survive the merge", () => {
    // Why the log is one item per day rather than one object.
    const mine = recordStudy([], { day: "2026-08-10", course: "BIO101", minutes: 30, cards: 10, now: "2026-08-10T09:00:00.000Z" });
    const theirs = recordStudy([], { day: "2026-08-11", course: "CHEM110", minutes: 20, cards: 5, now: "2026-08-11T09:00:00.000Z" });
    const sem = (studyStats) => ({
      courses: [], todos: [], textbook: [], assignments: [], notes: [], events: [], pages: [], folders: [], studyStats,
    });
    const merged = mergeData(
      { semesters: { "Semester 1": sem(mine) }, meta: { updatedAt: "2026-08-10T09:00:00.000Z" } },
      { semesters: { "Semester 1": sem(theirs) }, meta: { updatedAt: "2026-08-11T09:00:00.000Z" } }
    );
    const out = merged.semesters["Semester 1"].studyStats;
    assert.equal(studySummary(out, "2026-08-10").minutesToday, 30);
    assert.equal(studySummary(out, "2026-08-11").minutesToday, 20);
  });

  await test("semester isolation holds: one semester's study never leaks into the other", () => {
    const sem = (studyStats) => ({
      courses: [], todos: [], textbook: [], assignments: [], notes: [], events: [], pages: [], folders: [], studyStats,
    });
    const s1 = recordStudy([], { day: "2026-08-10", course: "BIO101", minutes: 30, cards: 10, now: "2026-08-10T09:00:00.000Z" });
    const merged = mergeData(
      { semesters: { "Semester 1": sem(s1), "Semester 2": sem([]) }, meta: { updatedAt: "2026-08-10T09:00:00.000Z" } },
      { semesters: { "Semester 1": sem([]), "Semester 2": sem([]) }, meta: { updatedAt: "2026-08-09T00:00:00.000Z" } }
    );
    assert.equal(studySummary(merged.semesters["Semester 1"].studyStats, "2026-08-10").minutesToday, 30);
    assert.equal(studySummary(merged.semesters["Semester 2"].studyStats, "2026-08-10").minutesToday, 0);
  });

  await test("stats tombstones are cleaned up by sync.js's purge too", () => {
    const old = "2026-01-01";
    const today = addDays(old, 200);
    let stats = recordStudy([], { day: old, course: "BIO", minutes: 5, cards: 1, now: `${old}T09:00:00.000Z` });
    stats = pruneStats(stats, addDays(old, WINDOW_DAYS + 1), `${addDays(old, WINDOW_DAYS + 1)}T09:00:00.000Z`);
    const data = {
      semesters: {
        "Semester 1": { courses: [], todos: [], textbook: [], assignments: [], notes: [], events: [], pages: [], folders: [], studyStats: stats },
      },
    };
    const purged = purgeOldTombstones(data);
    const rows = purged.semesters["Semester 1"].studyStats;
    assert.ok(!rows.some((it) => it.id === dayId(old)), "an ancient stats tombstone should be purged like any other");
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
