/* Tests for the two storage-failure fixes.

   Both cover a failure that was previously invisible, which is what
   makes them worth writing:

   - src/storageHealth.js — a localStorage write that fails must be
     reported. `store.set` used to swallow the exception, so once the
     planner outgrew the browser quota, saving silently stopped and a
     demo-mode user lost everything on refresh with nothing on screen.

   - truncateTranscript in src/aiNotesLogic.js — a failed summary used
     to put the entire transcript (~88KB for a two-hour lecture) into
     the synced blob. Nothing observable went wrong at the time, which
     is exactly why it survived so long.

   Plain Node and `assert`, same style as the other suites.
   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyStorageError, formatBytes, describeSaveFailure } from "../src/storageHealth.js";
import { truncateTranscript, TRANSCRIPT_EXCERPT_CHARS, mapAiResultToItems } from "../src/aiNotesLogic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

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

/* A DOMException-alike, since Node has no localStorage to throw a real one. */
const err = (name, code) => Object.assign(new Error(name), { name, code });

async function run() {
  /* ---------- classifying the failure ---------- */

  await test("a full quota reads as 'quota' in every browser's dialect", () => {
    // Chrome/Safari, Firefox, and the legacy numeric codes for both.
    assert.equal(classifyStorageError(err("QuotaExceededError")), "quota");
    assert.equal(classifyStorageError(err("NS_ERROR_DOM_QUOTA_REACHED")), "quota");
    assert.equal(classifyStorageError(err("SomethingElse", 22)), "quota");
    assert.equal(classifyStorageError(err("SomethingElse", 1014)), "quota");
  });

  await test("storage being switched off reads as 'unavailable', not as a full disk", () => {
    // Private browsing and sandboxed frames refuse the write outright.
    // Telling that user to delete notes would be useless advice.
    assert.equal(classifyStorageError(err("SecurityError")), "unavailable");
    assert.equal(classifyStorageError(new Error("nope")), "unavailable");
    assert.equal(classifyStorageError(null), "unavailable");
  });

  /* ---------- what the user is told ---------- */

  await test("a signed-out user is told their work will be lost; a signed-in one is not", () => {
    const out = describeSaveFailure({ reason: "quota", bytes: 5_400_000, signedIn: false });
    const inn = describeSaveFailure({ reason: "quota", bytes: 5_400_000, signedIn: true });
    assert.equal(out.severity, "danger");
    assert.equal(inn.severity, "warning");
    assert.match(out.detail, /will be lost/i);
    assert.doesNotMatch(inn.detail, /will be lost/i);
    // The signed-in case must say the work is safe, or it reads worse
    // than it is and the user starts deleting notes they didn't need to.
    assert.match(inn.detail, /nothing is lost|still syncing/i);
  });

  await test("the message names the size, so the number isn't a mystery", () => {
    const d = describeSaveFailure({ reason: "quota", bytes: 5_400_000, signedIn: false });
    assert.match(d.detail, /5\.1 MB/);
  });

  await test("an unknown size is omitted rather than shown as 0 B", () => {
    const d = describeSaveFailure({ reason: "quota", signedIn: false });
    assert.doesNotMatch(d.detail, /0 B/);
    assert.ok(d.detail.length > 0);
  });

  await test("'unavailable' advises a different remedy than 'quota'", () => {
    const quota = describeSaveFailure({ reason: "quota", signedIn: false });
    const gone = describeSaveFailure({ reason: "unavailable", signedIn: false });
    assert.match(quota.detail, /free up space|remove some old notes/i);
    assert.match(gone.detail, /private browsing/i);
    assert.doesNotMatch(gone.detail, /free up space/i);
  });

  await test("every failure produces a title and a detail, whatever it is handed", () => {
    for (const reason of ["quota", "unavailable", undefined, "nonsense"]) {
      for (const signedIn of [true, false]) {
        const d = describeSaveFailure({ reason, signedIn });
        assert.ok(d.title && d.title.length > 0, `no title for ${reason}/${signedIn}`);
        assert.ok(d.detail && d.detail.length > 0, `no detail for ${reason}/${signedIn}`);
        assert.ok(["warning", "danger"].includes(d.severity));
      }
    }
  });

  await test("sizes read in the unit a person would use", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(5_400), "5.3 KB");
    assert.equal(formatBytes(600_000), "586 KB");
    assert.equal(formatBytes(5_400_000), "5.1 MB");
    assert.equal(formatBytes(-1), "");
    assert.equal(formatBytes("nope"), "");
  });

  /* ---------- the transcript that used to be stored whole ---------- */

  await test("a short transcript is kept in full and not marked truncated", () => {
    const t = truncateTranscript("A short lecture.");
    assert.equal(t.text, "A short lecture.");
    assert.equal(t.truncated, false);
    assert.equal(t.fullLength, 16);
  });

  await test("a two-hour lecture is cut to the excerpt, not stored whole", () => {
    // 15,000 words is a realistic two-hour lecture and measures ~88KB.
    const transcript = Array.from({ length: 15000 }, () => "word").join(" ");
    const t = truncateTranscript(transcript);
    assert.equal(t.truncated, true);
    assert.equal(t.fullLength, transcript.length);
    assert.ok(t.text.length <= TRANSCRIPT_EXCERPT_CHARS, "the excerpt exceeded its own limit");
    assert.ok(t.text.length > TRANSCRIPT_EXCERPT_CHARS * 0.8, "the excerpt threw away most of its budget");
  });

  await test("the excerpt ends on a whole word", () => {
    const transcript = Array.from({ length: 5000 }, () => "hippopotamus").join(" ");
    const t = truncateTranscript(transcript);
    assert.ok(!t.text.endsWith("hippo"), "cut mid-word");
    assert.ok(/\bhippopotamus$/.test(t.text), `ended on ${JSON.stringify(t.text.slice(-20))}`);
  });

  await test("a transcript with no spaces still yields an excerpt rather than nothing", () => {
    // No word boundary to honour; the excerpt must not collapse to "".
    const t = truncateTranscript("x".repeat(9000));
    assert.equal(t.text.length, TRANSCRIPT_EXCERPT_CHARS);
    assert.equal(t.truncated, true);
  });

  await test("a missing transcript is empty rather than the string 'undefined'", () => {
    for (const input of [undefined, null, 0, {}]) {
      const t = truncateTranscript(input);
      assert.equal(t.text, "");
      assert.equal(t.fullLength, 0);
    }
  });

  /* ---------- what actually reaches the synced blob ---------- */

  const bigTranscript = Array.from({ length: 15000 }, () => "word").join(" ");
  const uid = () => "id" + Math.random().toString(36).slice(2, 8);
  const nowISO = () => "2026-08-11T00:00:00.000Z";

  await test("a failed summary stores an excerpt, not 88KB of transcript", () => {
    const { pageItem } = mapAiResultToItems({
      result: { summaryFailed: true, transcript: bigTranscript },
      course: "PSYC2001",
      week: "7",
      uid,
      nowISO,
    });
    const bytes = Buffer.byteLength(JSON.stringify(pageItem));
    assert.ok(bytes < 4096, `the failure page was ${bytes} bytes; it used to be ~88KB`);
    assert.ok(!pageItem.body.includes(bigTranscript), "the whole transcript is still in there");
  });

  await test("the note says how much was kept, so nothing looks like a lost recording", () => {
    const { pageItem } = mapAiResultToItems({
      result: { summaryFailed: true, transcript: bigTranscript },
      course: "PSYC2001",
      week: "7",
      uid,
      nowISO,
    });
    assert.match(pageItem.body, /Only the first/);
    assert.match(pageItem.body, /Download the full transcript/);
    // The full length must appear, or "the first 2,000 characters" of an
    // unknown total tells the student nothing.
    assert.match(pageItem.body, new RegExp(bigTranscript.length.toLocaleString().replace(/,/g, ",")));
  });

  await test("a short failed transcript gets no truncation notice", () => {
    const { pageItem } = mapAiResultToItems({
      result: { summaryFailed: true, transcript: "Only a sentence." },
      course: "PSYC2001",
      week: "7",
      uid,
      nowISO,
    });
    assert.ok(pageItem.body.includes("Only a sentence."));
    assert.doesNotMatch(pageItem.body, /Only the first/);
  });

  await test("the failure page opens in the normal editor, so it can be fixed by hand", () => {
    // aiMeta would route it to the read-only AI viewer instead.
    const { pageItem } = mapAiResultToItems({
      result: { summaryFailed: true, transcript: bigTranscript },
      course: "PSYC2001",
      week: "7",
      uid,
      nowISO,
    });
    assert.equal(pageItem.aiMeta, undefined);
    assert.equal(pageItem.kind, "text");
  });

  await test("a successful summary never persists the transcript anywhere", () => {
    // The Edge Function returns `transcript` on the success path too
    // (index.ts). Persisting it would be a one-line change nobody would
    // notice until a semester of lectures had been recorded.
    const marker = "UNIQUE_TRANSCRIPT_MARKER_" + "z".repeat(200);
    const { pageItem, noteItems } = mapAiResultToItems({
      result: {
        summaryFailed: false,
        transcript: marker + " " + bigTranscript,
        original: {
          overview: "An overview.",
          keyPoints: ["A point."],
          terms: [{ term: "Term", content: "Meaning." }],
          assessable: ["Assessable."],
          openQuestions: ["Unclear."],
        },
        translated: null,
      },
      course: "PSYC2001",
      week: "7",
      uid,
      nowISO,
    });
    const serialised = JSON.stringify({ pageItem, noteItems });
    assert.ok(!serialised.includes(marker), "the transcript reached the synced blob on the success path");
    assert.ok(!serialised.includes("word word word"), "transcript text leaked into the saved items");
  });

  /* ---------- the wiring these fixes depend on ---------- */

  await test("store.set reports failures instead of swallowing them", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const setBody = src.slice(src.indexOf("async set(key, val)"), src.indexOf("async del(key)"));
    assert.ok(setBody.length > 0, "couldn't find store.set");
    assert.match(setBody, /classifyStorageError/, "store.set no longer classifies the failure");
    assert.match(setBody, /return \{ ok: false/, "store.set no longer reports a failure to its caller");
    // The original bug, in one regex: a bare catch that drops the error.
    assert.doesNotMatch(
      setBody,
      /catch \(e\) \{\s*\/\* ignore \*\/\s*\}/,
      "the swallowed-error catch is back in store.set"
    );
  });

  await test("every local write goes through persist(), so none can report silently", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    // Exactly one: the call inside persist() itself. Any second one is a
    // caller that bypassed it, and whose failure would go unreported.
    const calls = [...src.matchAll(/store\.set\(STORAGE_KEY/g)];
    assert.equal(
      calls.length,
      1,
      `${calls.length} writes to STORAGE_KEY; all but persist()'s own must go through persist(), or their failure is never surfaced`
    );
    assert.match(src, /const persist = async[\s\S]{0,200}store\.set\(STORAGE_KEY/, "persist() no longer does the writing");
    assert.match(src, /setSaveError/, "the save failure never reaches the UI");
  });

  await test("the header can't claim 'Saved' after a failed write", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    assert.match(src, /setSaveState\("error"\)/, "there is no error save state");
    assert.match(src, /saveState === "error"/, "the header never renders the error state");
  });

  await test("npm test still runs the storage tests", () => {
    // Same reasoning as the guards in test-ai-notes.mjs: a suite that is
    // dropped from `npm test` fails silently, which is the exact class of
    // bug this file exists to catch.
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-storage\.mjs/, "the storage tests were dropped from `npm test`");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
