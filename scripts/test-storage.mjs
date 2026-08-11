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
import {
  truncateTranscript,
  TRANSCRIPT_EXCERPT_CHARS,
  mapAiResultToItems,
  summaryForStorage,
  capAiNote,
  MAX_AI_NOTE_BYTES,
  aiNotePreview,
  setPendingRecovery,
  clearPendingRecovery,
  pendingRecovery,
} from "../src/aiNotesLogic.js";
import { mergeData } from "../src/sync.js";
import { RESULT_RETENTION_DAYS, FAILED_RESULT_RETENTION_DAYS } from "../src/aiNotesRetention.js";

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


  /* ---------- de-duplication ---------- */

  const summaryOf = (n = 6) => ({
    overview: "An overview of the lecture. ".repeat(4),
    keyPoints: Array.from({ length: n }, (_, i) => `Key point ${i} ` + "x".repeat(80)),
    terms: Array.from({ length: n }, (_, i) => ({ term: `Term ${i}`, content: "y".repeat(120) })),
    assessable: Array.from({ length: 3 }, (_, i) => `Assessable ${i} ` + "z".repeat(60)),
    openQuestions: ["Something unresolved."],
  });

  const mapped = (over = {}) =>
    mapAiResultToItems({
      result: { summaryFailed: false, transcript: bigTranscript, original: summaryOf(), translated: null, ...over },
      course: "PSYC2001",
      week: "7",
      uid,
      nowISO,
      ...(over.__mapArgs || {}),
    });

  await test("terms are stored once, as study cards, not again inside aiMeta", () => {
    const { pageItem, noteItems } = mapped();
    assert.equal(noteItems.length, 6, "the study cards are the canonical copy and must still be there");
    for (const lang of Object.keys(pageItem.aiMeta.translations)) {
      assert.equal(pageItem.aiMeta.translations[lang].terms, undefined, `terms survived in aiMeta.${lang}`);
    }
  });

  await test("the summary is stored once, in aiMeta, not rendered into body as well", () => {
    const { pageItem } = mapped();
    assert.equal(pageItem.body, "", "body still holds a second copy of the summary");
    assert.ok(pageItem.aiMeta.translations.en.overview.length > 0);
  });

  await test("de-duplication roughly halves what a lecture note costs", () => {
    const { pageItem, noteItems } = mapped();
    const bytes = Buffer.byteLength(JSON.stringify({ pageItem, noteItems }));
    // Measured at ~12.9KB before this change for a realistic lecture.
    assert.ok(bytes < 7500, `a de-duplicated note was ${bytes} bytes`);
  });

  await test("summaryForStorage leaves everything except terms alone", () => {
    const s = summaryOf(2);
    const out = summaryForStorage(s);
    assert.deepEqual(out.keyPoints, s.keyPoints);
    assert.deepEqual(out.assessable, s.assessable);
    assert.deepEqual(out.openQuestions, s.openQuestions);
    assert.equal(out.overview, s.overview);
    assert.equal(out.terms, undefined);
  });

  await test("a note saved before this change still previews from its body", () => {
    assert.equal(aiNotePreview({ body: "An older note." }), "An older note.");
    assert.equal(aiNotePreview({ body: "", aiMeta: { activeLanguage: "en", translations: { en: { overview: "New." } } } }), "New.");
  });

  /* ---------- the 20KB cap ---------- */

  const bigSummary = () => ({
    overview: "o".repeat(4000),
    keyPoints: Array.from({ length: 40 }, () => "k".repeat(400)),
    assessable: Array.from({ length: 20 }, () => "a".repeat(400)),
    openQuestions: Array.from({ length: 20 }, () => "q".repeat(400)),
  });
  const page = (translations, activeLanguage = "en") => ({
    id: "p1", title: "T", body: "", html: "", strokes: [], style: "lined", kind: "text", font: "sans",
    folderId: null, aiMeta: { course: "C", week: "1", generatedAt: nowISO(), activeLanguage, translations },
  });

  await test("a note within the cap is returned untouched", () => {
    const p = page({ en: { overview: "Short.", keyPoints: [], assessable: [], openQuestions: [] } });
    const out = capAiNote({ pageItem: p, requestedLanguage: "en" });
    assert.deepEqual(out.pageItem, p);
    assert.equal(out.droppedLanguage, null);
    assert.equal(out.trimmed, false);
  });

  await test("the cap keeps the language the student asked for and drops the other", () => {
    // The whole point of the rule: a student who asked for Chinese is
    // reading Chinese. Dropping it would leave them the copy they can't
    // use, while never affecting a monolingual user at all.
    const out = capAiNote({ pageItem: page({ en: bigSummary(), zh: bigSummary() }, "zh"), requestedLanguage: "zh" });
    assert.ok(out.pageItem.aiMeta.translations.zh, "the requested language was dropped");
    assert.equal(out.pageItem.aiMeta.translations.en, undefined, "the unrequested language survived");
    assert.equal(out.droppedLanguage, "en");
    assert.equal(out.pageItem.aiMeta.activeLanguage, "zh");
  });

  await test("with no translation requested, English is what survives", () => {
    const out = capAiNote({ pageItem: page({ en: bigSummary(), zh: bigSummary() }, "en"), requestedLanguage: "en" });
    assert.ok(out.pageItem.aiMeta.translations.en);
    assert.equal(out.pageItem.aiMeta.translations.zh, undefined);
    assert.equal(out.droppedLanguage, "zh");
  });

  await test("a single-language note still over the cap is trimmed from the least valuable end", () => {
    const out = capAiNote({ pageItem: page({ en: bigSummary() }), requestedLanguage: "en" });
    const kept = out.pageItem.aiMeta.translations.en;
    assert.equal(out.trimmed, true);
    assert.equal(kept.openQuestions.length, 0, "open questions should go before key points");
    assert.ok(kept.keyPoints.length > 0, "key points were given up before open questions ran out");
    assert.ok(Buffer.byteLength(JSON.stringify(out.pageItem)) <= MAX_AI_NOTE_BYTES);
  });

  await test("trimming never leaves a note without an overview", () => {
    const monster = page({ en: { overview: "o".repeat(60000), keyPoints: [], assessable: [], openQuestions: [] } });
    const out = capAiNote({ pageItem: monster, requestedLanguage: "en" });
    assert.ok(out.pageItem.aiMeta.translations.en.overview.length >= 200);
  });

  await test("every capped note ends up under the cap", () => {
    for (const langs of [{ en: bigSummary() }, { en: bigSummary(), zh: bigSummary() }]) {
      const out = capAiNote({ pageItem: page(langs), requestedLanguage: "en" });
      const bytes = Buffer.byteLength(JSON.stringify(out.pageItem));
      assert.ok(bytes <= MAX_AI_NOTE_BYTES, `still ${bytes} bytes after capping`);
    }
  });

  await test("a capped note records what it gave up, so the UI can say so", () => {
    const { pageItem } = mapAiResultToItems({
      result: { summaryFailed: false, transcript: "", original: bigSummary(), translated: bigSummary() },
      course: "C", week: "1", language: "zh", uid, nowISO,
    });
    assert.ok(pageItem.aiMeta.capped, "nothing recorded that the note was capped");
    assert.equal(pageItem.aiMeta.capped.droppedLanguage, "en");
  });

  await test("study cards stay in the original language even when a translation was asked for", () => {
    // The Study tab has one deck per semester and no notion of language.
    const { noteItems } = mapAiResultToItems({
      result: {
        summaryFailed: false, transcript: "",
        original: { ...summaryOf(3), terms: [{ term: "Mitochondrion", content: "The powerhouse." }] },
        translated: { ...summaryOf(3), terms: [{ term: "线粒体", content: "细胞的动力工厂。" }] },
      },
      course: "C", week: "1", language: "zh", uid, nowISO,
    });
    assert.equal(noteItems.length, 1);
    assert.equal(noteItems[0].term, "Mitochondrion");
  });

  /* ---------- the recovery key ---------- */

  await test("the parked key costs a few dozen bytes, not a transcript", () => {
    const meta = setPendingRecovery({}, { key: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", course: "PSYC2001", week: "7", startedAt: nowISO() });
    const bytes = Buffer.byteLength(JSON.stringify(meta)) - 2;
    assert.ok(bytes < 160, `the parked key was ${bytes} bytes`);
    assert.equal(pendingRecovery(meta).key, "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  await test("clearing the key propagates to the other device instead of being undone by it", () => {
    // mergeData spreads local.meta then newer.meta, so a key simply
    // deleted on one device would be reinstated by the other's copy.
    // An explicit null is what makes the clear survive a merge.
    const stale = { meta: { updatedAt: "2026-08-11T10:00:00.000Z", pendingAiRecovery: { key: "k" } }, semesters: {} };
    const cleared = { meta: { ...clearPendingRecovery(stale.meta), updatedAt: "2026-08-11T11:00:00.000Z" }, semesters: {} };
    // The device still holding the key merges in the one that cleared it.
    // This is the direction that matters: meta is a spread of local then
    // newer, so only an explicit null overwrites the stale key.
    assert.equal(pendingRecovery(mergeData(stale, cleared).meta), null, "the cleared key came back from the stale device");
    // And the reverse order must agree, or the two devices disagree forever.
    assert.equal(pendingRecovery(mergeData(cleared, stale).meta), null, "clearing didn't survive a merge on the clearing device");
  });

  await test("a missing or malformed pending key reads as nothing to recover", () => {
    assert.equal(pendingRecovery(undefined), null);
    assert.equal(pendingRecovery({}), null);
    assert.equal(pendingRecovery({ pendingAiRecovery: null }), null);
    assert.equal(pendingRecovery({ pendingAiRecovery: { course: "C" } }), null);
  });

  await test("the key is parked before the upload, not after it", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/aiNotes.jsx"), "utf8");
    const body = src.slice(src.indexOf("const runUpload = async"), src.indexOf("useEffect(() => {\n    if (initialRecovery)"));
    assert.ok(body.length > 0, "couldn't find runUpload");
    const parkAt = body.indexOf("setPendingRecovery");
    const uploadAt = body.indexOf("await uploadAudio");
    assert.ok(parkAt > -1, "runUpload no longer parks the key at all");
    assert.ok(uploadAt > -1, "couldn't find the upload inside runUpload");
    assert.ok(parkAt < uploadAt, "the key is parked after the upload, so a crash during it loses the key");
  });

  await test("saving and discarding both clear the parked key", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/aiNotes.jsx"), "utf8");
    assert.equal(
      [...src.matchAll(/clearPendingRecovery/g)].length >= 3,
      true,
      "save, discard and forget must all clear the key"
    );
  });

  /* ---------- retention is a promise, so it has to match ---------- */

  await test("the retention days the UI promises are the ones the server enforces", () => {
    const config = fs.readFileSync(path.join(rootDir, "supabase/functions/ai-notes/config.ts"), "utf8");
    const short = /REQUEST_RETENTION_DAYS = (\d+)/.exec(config);
    const long = /FAILED_REQUEST_RETENTION_DAYS = (\d+)/.exec(config);
    assert.ok(short && long, "couldn't read the server's retention constants");
    assert.equal(Number(short[1]), RESULT_RETENTION_DAYS, "the UI promises a different retention than the server keeps");
    assert.equal(Number(long[1]), FAILED_RESULT_RETENTION_DAYS, "the UI promises a different failed-row retention than the server keeps");
  });

  await test("the sweep keeps failed rows longer instead of deleting everything at 7 days", () => {
    const src = fs.readFileSync(path.join(rootDir, "supabase/functions/ai-notes/index.ts"), "utf8");
    assert.match(src, /FAILED_REQUEST_RETENTION_DAYS/, "the long sweep is gone");
    assert.match(src, /\.eq\("summary_failed", false\)/, "the short sweep no longer spares failed rows");
    assert.match(src, /summary_failed: summaryFailed/, "nothing records the failure on the row, so the sweep can't see it");
  });

  await test("the failure screen says the minutes were billed", () => {
    // Charging for transcription and saying only "we couldn't generate a
    // summary" is how a support ticket becomes a chargeback.
    const copy = fs.readFileSync(path.join(rootDir, "src/aiNotesCopy.js"), "utf8");
    assert.match(copy, /AI minutes/, "the billing sentence is gone");
    const src = fs.readFileSync(path.join(rootDir, "src/aiNotes.jsx"), "utf8");
    assert.match(src, /AI_NOTES_COPY\.summaryFailed\.billing/, "the failure screen no longer renders it");
  });

  await test("no user-facing copy calls a dropped result regenerable", () => {
    // The audio is deleted as soon as transcription succeeds and there is
    // no text-only re-summarise endpoint, so it is recoverable, not
    // regenerable. The two words promise different things.
    const copy = fs.readFileSync(path.join(rootDir, "src/aiNotesCopy.js"), "utf8");
    // Strip comments first -- this file explains at length WHY the word
    // is banned, and that explanation must not trip its own guard.
    const code = copy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/regenerat/i.test(code), "user-facing copy claims something is regenerable");
    assert.match(code, /recover/i, "the copy should say recoverable, which is the true claim");
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
