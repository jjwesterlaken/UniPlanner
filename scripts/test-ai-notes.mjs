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
