/* The pure half of the 7 October recorder fixes, without a browser.

   test-recorder-session.mjs drives the real bundle; this pins the rules
   underneath it where Node can reach them: which token a call goes out
   with, how a 401 is retried and where that stops, which parked key a
   save may clear, what the reducer carries, what a note keeps, what the
   tab title says, and how a clock-skew refusal is told apart from any
   other. Modules are imported WHOLE, so a missing export fails its own
   test with a sentence instead of failing the file at load. */

import assert from "node:assert/strict";

import * as client from "../src/aiNotesClient.js";
import * as logic from "../src/aiNotesLogic.js";
import * as copy from "../src/aiNotesCopy.js";
import * as sync from "../src/sync.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}\n        ${String(err.message).split("\n").join("\n        ")}`);
  }
}
const has = (mod, name, where) => assert.equal(typeof mod[name], "function", `${where} has no ${name}`);

/* What auth-js hands back, as auth-js shapes it: a user and a token. */
const USER = { id: "00000000-0000-4000-8000-000000000009", email: "logic-probe@example.test" };

/* An auth client that hands out the token it is told to, and counts. */
function fakeAuth({ current = "fresh", refreshed = "refreshed", sessionError = false, refreshFails = false } = {}) {
  const calls = { getSession: 0, refreshSession: 0 };
  return {
    calls,
    auth: {
      getSession: async () => {
        calls.getSession += 1;
        if (sessionError) throw new Error("storage blocked");
        return { data: { session: current ? { access_token: current, user: USER } : null } };
      },
      refreshSession: async () => {
        calls.refreshSession += 1;
        if (refreshFails) return { data: { session: null }, error: { message: "refresh token revoked" } };
        return { data: { session: { access_token: refreshed, user: USER } } };
      },
    },
  };
}
const refused = () => Object.assign(new Error("Request failed (401)"), { status: 401 });

async function run() {
  /* ---------- fix 1: the token is read when the call is made ---------- */

  await test("THE TOKEN IS THE ONE AUTH HOLDS NOW, NOT THE ONE THE CALLER WAS HOLDING", async () => {
    has(client, "currentAccessToken", "aiNotesClient.js");
    const auth = fakeAuth({ current: "fresh" });
    assert.equal(await client.currentAccessToken({ token: "stale" }, auth), "fresh");
    assert.equal(auth.calls.getSession, 1);
  });

  await test("WITH NO AUTH CLIENT, OR ONE THAT FAILS, THE CALLER'S TOKEN IS THE FALLBACK — demo mode and blocked storage", async () => {
    has(client, "currentAccessToken", "aiNotesClient.js");
    assert.equal(await client.currentAccessToken({ token: "held" }, null), "held");
    assert.equal(await client.currentAccessToken({ token: "held" }, fakeAuth({ sessionError: true })), "held");
    assert.equal(await client.currentAccessToken({ token: "held" }, fakeAuth({ current: null })), "held");
    assert.equal(await client.currentAccessToken(null, null), null);
  });

  await test("A 401 GETS ONE FORCED REFRESH AND ONE RETRY WITH THE NEW TOKEN", async () => {
    has(client, "withFreshToken", "aiNotesClient.js");
    const auth = fakeAuth({ current: "fresh", refreshed: "refreshed" });
    const seen = [];
    const out = await client.withFreshToken({ token: "stale" }, async (t) => {
      seen.push(t);
      if (seen.length === 1) throw refused();
      return "notes";
    }, auth);
    assert.equal(out, "notes");
    assert.deepEqual(seen, ["fresh", "refreshed"]);
    assert.equal(auth.calls.refreshSession, 1);
  });

  await test("A SECOND 401 IS THROWN AS IT CAME — TWO CALLS, NEVER A LOOP", async () => {
    has(client, "withFreshToken", "aiNotesClient.js");
    let calls = 0;
    await assert.rejects(
      () => client.withFreshToken({ token: "stale" }, async () => { calls += 1; throw refused(); }, fakeAuth()),
      (e) => e.status === 401
    );
    assert.equal(calls, 2);
  });

  await test("ONLY A 401 IS RETRIED; A FAILED REFRESH OR AN UNCHANGED TOKEN THROWS THE ORIGINAL REFUSAL", async () => {
    has(client, "withFreshToken", "aiNotesClient.js");
    let calls = 0;
    const boom = Object.assign(new Error("transcription_failed"), { status: 502 });
    await assert.rejects(() => client.withFreshToken({}, async () => { calls += 1; throw boom; }, fakeAuth()), (e) => e === boom);
    assert.equal(calls, 1, "a 502 was retried");
    calls = 0;
    await assert.rejects(() => client.withFreshToken({}, async () => { calls += 1; throw refused(); }, fakeAuth({ refreshFails: true })), (e) => e.status === 401);
    assert.equal(calls, 1, "a call was retried without a new token");
    calls = 0;
    await assert.rejects(() => client.withFreshToken({}, async () => { calls += 1; throw refused(); }, fakeAuth({ current: "same", refreshed: "same" })), (e) => e.status === 401);
    assert.equal(calls, 1, "a call was retried with the token that was just refused");
    calls = 0;
    await assert.rejects(() => client.withFreshToken({ token: "held" }, async () => { calls += 1; throw refused(); }, null), (e) => e.status === 401);
    assert.equal(calls, 1, "with no auth client there is nothing to refresh with");
  });

  /* ---------- fix 2: the end reason travels, and is kept ---------- */

  await test("THE REQUEST CARRIES endReason WHEN THERE IS ONE, AND NOTHING EXTRA WHEN THERE IS NOT", async () => {
    const bodies = [];
    const fetchImpl = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };
    /* Consent accepted, the way the app records it -- the boundary
       refuses an AI call without it, and that refusal is not what this
       test is about. */
    const { recordConsentState } = await import("../src/aiConsentState.js");
    recordConsentState(logic.buildConsentPatch());
    const args = { token: "t", course: "PSYC1001", translateTo: null, idempotencyKey: "k", estimatedDurationSeconds: 180 };
    await client.callAiNotes({ ...args, endReason: "share-ended" }, fetchImpl).catch((e) => bodies.push({ threw: e.message }));
    await client.callAiNotes(args, fetchImpl).catch((e) => bodies.push({ threw: e.message }));
    assert.equal(bodies.length, 2, JSON.stringify(bodies));
    assert.ok(!bodies[0].threw, `the call refused before sending: ${bodies[0].threw}`);
    assert.equal(bodies[0].endReason, "share-ended", "the request does not say why the recording ended");
    assert.equal(bodies[0].estimatedDurationSeconds, 180);
    assert.ok(!("endReason" in bodies[1]), "a request with no end reason sent the key anyway");
  });

  await test("THE REDUCER CARRIES THE END REASON, AND A NEW RECORDING STARTS FROM NOTHING", () => {
    const { recorderReducer, INITIAL_RECORDER_STATE } = logic;
    assert.ok("endReason" in INITIAL_RECORDER_STATE, "the recorder state has no end reason");
    const stopped = recorderReducer({ ...INITIAL_RECORDER_STATE, status: "recording" }, {
      type: "stop", blob: {}, mimeType: "audio/webm", extension: "webm", idempotencyKey: "k", estimatedDurationSeconds: 9, endReason: "share-ended",
    });
    assert.equal(stopped.endReason, "share-ended");
    /* "Record the rest" starts the next recording from the review screen:
       the last one's result and reason must not ride into it. */
    const review = { ...stopped, status: "review", result: { ok: true } };
    const next = recorderReducer(review, { type: "request" });
    assert.equal(next.status, "requesting");
    assert.equal(next.result, null, "the last recording's result rode into the next one");
    assert.equal(next.endReason, null, "the last recording's end reason rode into the next one");
  });

  await test("A SAVE CLEARS ONLY ITS OWN PARKED KEY — the next recording's survives", () => {
    const { clearPendingRecovery, setPendingRecovery } = logic;
    const parkedNext = setPendingRecovery({}, { key: "next", course: "C", week: "3", startedAt: "t" });
    const kept = clearPendingRecovery(parkedNext, "first").pendingAiRecovery;
    assert.ok(kept && kept.key === "next", "saving the first part threw away the parked key of the recording in flight");
    assert.equal(clearPendingRecovery(parkedNext, "next").pendingAiRecovery, null);
    assert.equal(clearPendingRecovery(parkedNext).pendingAiRecovery, null, "an unkeyed clear (Save, Discard) must still clear");
  });

  await test("A SAVED RECORDING KEEPS WHY AND AFTER HOW LONG IT ENDED; A RECOVERED ONE KEEPS NOTHING INVENTED", async () => {
    const result = {
      ok: true, summaryFailed: false, translated: null,
      original: { overview: "o", keyPoints: ["k"], terms: [{ term: "t", content: "c" }], assessable: [], openQuestions: [] },
    };
    let n = 0;
    const base = { result, course: "PSYC1001", week: "3", language: null, uid: () => `id${(n += 1)}`, nowISO: () => "2026-10-08T00:00:00.000Z" };
    const meta = logic.mapAiResultToItems({ ...base, endReason: "share-ended", recordedSeconds: 180 }).pageItem.aiMeta;
    assert.equal(meta.endReason, "share-ended", "the saved note does not say why its recording ended");
    assert.equal(meta.recordedSeconds, 180, "the saved note does not say how long its recording ran");
    const recovered = logic.mapAiResultToItems(base).pageItem.aiMeta;
    assert.ok(!("endReason" in recovered) && !("recordedSeconds" in recovered), "a note with no recording behind it was given an end reason");
    const { KEPT_META_KEYS } = await import("../src/aiNotesStore.js");
    assert.ok(KEPT_META_KEYS.includes("endReason") && KEPT_META_KEYS.includes("recordedSeconds"), "the stub drops them on the first sync");
  });

  await test("THE TAB TITLE: RECORDING, PAUSED, AND STOPPED-ON-ITS-OWN OUTRANKING EVERYTHING UNTIL SEEN", () => {
    has(copy, "recordingTabTitle", "aiNotesCopy.js");
    const t = copy.AI_NOTES_COPY.tabTitle;
    const base = "UniPlanner";
    assert.equal(copy.recordingTabTitle(base, { status: "idle" }), base);
    assert.equal(copy.recordingTabTitle(base, { status: "recording" }), `${t.recording} · ${base}`);
    assert.equal(copy.recordingTabTitle(base, { status: "paused" }), `${t.paused} · ${base}`);
    assert.equal(copy.recordingTabTitle(base, { status: "review", unseenEnd: true }), `${t.stopped} · ${base}`);
    assert.equal(copy.recordingTabTitle(base, { status: "recording", unseenEnd: true }), `${t.stopped} · ${base}`);
    assert.equal(new Set([t.recording, t.paused, t.stopped]).size, 3, "two states read the same in the tab strip");
  });

  /* ---------- fix 4: a clock-skew refusal is told apart ---------- */

  await test("A CLOCK-SKEW REFUSAL IS RECOGNISED BY ITS CODE OR ITS MESSAGE, AND NOTHING ELSE IS", () => {
    has(sync, "isClockSkewRefusal", "sync.js");
    assert.equal(sync.isClockSkewRefusal({ code: "PGRST303", message: "JWT issued at future" }), true);
    assert.equal(sync.isClockSkewRefusal(Object.assign(new Error("JWT issued at future"), { code: undefined })), true);
    assert.equal(sync.isClockSkewRefusal({ code: "PGRST301", message: "JWT expired" }), false);
    assert.equal(sync.isClockSkewRefusal(null), false);
  });

  await test("ONE REFUSAL IS RETRIED AFTER THE WAIT; TWO STOP THERE; ANY OTHER ERROR IS NOT RETRIED", async () => {
    has(sync, "retryClockSkewOnce", "sync.js");
    const waits = [];
    const wait = async (ms) => { waits.push(ms); };
    const skew = { error: { code: "PGRST303", message: "JWT issued at future" } };
    let runs = 0;
    const ok = await sync.retryClockSkewOnce(async () => (++runs === 1 ? skew : { data: 1, error: null }), wait);
    assert.deepEqual([runs, ok.data, waits], [2, 1, [sync.CLOCK_SKEW_RETRY_MS]]);
    runs = 0;
    const still = await sync.retryClockSkewOnce(async () => { runs += 1; return skew; }, wait);
    assert.equal(runs, 2, "a skew that persists was retried more than once");
    assert.equal(still.error.code, "PGRST303");
    runs = 0;
    await sync.retryClockSkewOnce(async () => { runs += 1; return { error: { code: "42501", message: "permission denied" } }; }, wait);
    assert.equal(runs, 1, "a permission error was retried");
    assert.ok(sync.CLOCK_SKEW_RETRY_MS >= 1000, "the wait is too short to outlast a sub-second skew");
  });

  await test("THE STUDENT READS PLAIN WORDS FOR A SKEW; EVERY OTHER FAILURE KEEPS ITS OWN SENTENCE", () => {
    has(sync, "syncFailureSentence", "sync.js");
    const skew = sync.syncFailureSentence(Object.assign(new Error("JWT issued at future"), { code: "PGRST303" }));
    assert.doesNotMatch(skew, /JWT|issued at|PGRST/i);
    assert.match(skew, /sync/i);
    assert.equal(sync.syncFailureSentence(new Error("Can't reach the server.")), "Can't reach the server.");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) process.exit(1);
}

run().catch((err) => {
  console.log(`FAIL  - the suite itself threw\n        ${err.stack || err}`);
  process.exit(1);
});
