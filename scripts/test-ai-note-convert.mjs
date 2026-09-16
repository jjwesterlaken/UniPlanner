/* Turning an AI lecture note into an ordinary, editable one.

   ONE CLAIM IN HERE MATTERS MORE THAN THE REST, and it is the reason
   the module refuses rather than trusting its caller:

     A FAILED FETCH NEVER CONVERTS.

   `fetchNote` has three outcomes — {content}, {missing}, {failed} —
   and only the first is knowledge. Converting on the other two writes
   an EMPTY note into the blob while the `ai_notes` row still holds the
   whole lecture: the content survives on the server with nothing
   pointing a reader at it, which from the student's side is
   indistinguishable from having lost the note. It is the `fetchNote`
   rule pointed at a destructive LOCAL write, and the destruction is
   silent in both directions — the blob save succeeds and the row is
   untouched, so nothing anywhere errors.

   The other two things the conversion must not do, each a rule this
   codebase has already paid for once:

     - it must NOT remove `aiMeta`, because reconcilePlan recognises a
       tombstoned stub by it and the row would leak on the server for
       ever
     - it must NOT delete the row, because the row holds every language
       and the student converted one of them

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  escapeHtml,
  isConverted,
  isLectureNote,
  summaryToNote,
  convertPatch,
} from "../src/aiNoteConvert.js";
import { isBlockNote, blocksOf, htmlOf, bodyOf, fieldsFromBlocks } from "../src/noteBlocks.js";
import { reconcilePlan, buildStub, KEPT_META_KEYS } from "../src/aiNotesStore.js";
import { aiNotePreview } from "../src/aiNotesLogic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
/* Comments name the thing they forbid -- the ledger's own rule, five
   instances deep -- so every source sweep in here strips them first. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let passed = 0;
let failed = 0;
function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === "function") {
    throw new Error(`test "${name}" returned a promise; this runner is synchronous and would report a pass before it settled`);
  }
  passed++;
  console.log(`  ok  - ${name}`);
}
const orig = test;
function safeTest(name, fn) {
  try {
    orig(name, fn);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const summary = (over = {}) => ({
  overview: "Oxidative phosphorylation, end to end.",
  keyPoints: ["Succinate to fumarate is the only membrane-bound step.", "NADH carries the electrons."],
  assessable: ["Name the four complexes."],
  openQuestions: [],
  ...over,
});

const lecturePage = (over = {}) => ({
  id: "msn0duf5-hk684",
  title: "BIO 101 — Week 3 notes",
  body: "",
  html: "",
  strokes: [],
  style: "lined",
  kind: "text",
  font: "sans",
  folderId: null,
  aiMeta: {
    course: "BIO 101",
    week: "3",
    generatedAt: "2026-09-01T00:00:00Z",
    activeLanguage: "en",
    remote: true,
    previews: { en: "Oxidative phosphorylation, end to end." },
  },
  ...over,
});

const at = () => "2026-09-16T10:00:00Z";
const converted = (page = lecturePage(), content = summary(), language = "en") => {
  const patch = convertPatch({ page, content, language, nowISO: at });
  assert.ok(patch, "the fixture's own conversion must succeed, or every test below is about nothing");
  return { ...page, ...patch };
};

/* ---------- 1. the refusals ---------- */

safeTest("A FAILED FETCH NEVER CONVERTS — no content means no patch, whatever the caller thought", () => {
  /* This is the shape a caller holds after fetchNote returns
     {failed:true}: it has no summary, so it has nothing to pass. */
  assert.equal(convertPatch({ page: lecturePage(), content: undefined, nowISO: at }), null);
  assert.equal(convertPatch({ page: lecturePage(), content: null, nowISO: at }), null);
  /* And the literal fetchNote results, in case somebody passes the
     wrapper rather than its .content -- which is the mistake that
     would actually be made. */
  assert.equal(convertPatch({ page: lecturePage(), content: { failed: true }, nowISO: at }), null);
  assert.equal(convertPatch({ page: lecturePage(), content: { missing: true }, nowISO: at }), null);
});

safeTest("a summary with nothing in it is refused too, so an empty row cannot empty a note", () => {
  assert.equal(convertPatch({ page: lecturePage(), content: {}, nowISO: at }), null);
  assert.equal(convertPatch({ page: lecturePage(), content: { overview: "   ", keyPoints: [] }, nowISO: at }), null);
});

safeTest("THE REFUSAL LEAVES THE PAGE EXACTLY AS IT WAS — a null patch is not an empty patch", () => {
  const page = lecturePage();
  const before = JSON.stringify(page);
  convertPatch({ page, content: { failed: true }, nowISO: at });
  assert.equal(JSON.stringify(page), before);
});

safeTest("converting twice is refused, so a second tap cannot overwrite the student's edits", () => {
  const once = converted();
  const edited = { ...once, blocks: [{ id: "x:t0", type: "text", html: "<p>my own words</p>", body: "my own words" }] };
  assert.equal(convertPatch({ page: edited, content: summary(), nowISO: at }), null);
});

safeTest("a page that was never an AI note is refused", () => {
  assert.equal(convertPatch({ page: { id: "p", title: "plain" }, content: summary(), nowISO: at }), null);
  assert.equal(convertPatch({ page: null, content: summary(), nowISO: at }), null);
});

/* ---------- 2. what it keeps ---------- */

safeTest("aiMeta SURVIVES, so reconciliation can still find the row when the note is deleted", () => {
  const page = converted();
  assert.ok(page.aiMeta, "aiMeta must not be removed");
  assert.equal(page.aiMeta.remote, true);
  /* The claim stated behaviourally rather than by inspecting a field:
     drive the real reconciliation over a tombstoned converted note and
     require the row to be scheduled for deletion. */
  const tombstoned = { ...page, deletedAt: "2026-09-17T00:00:00Z" };
  const { toDelete } = reconcilePlan({ remoteIds: [page.id], pages: [tombstoned] });
  assert.deepEqual(toDelete, [page.id], "a deleted converted note must still take its server row with it");
});

safeTest("a LIVE converted note's row is never deleted, and never counted as an orphan", () => {
  const page = converted();
  const { toDelete, orphanCount } = reconcilePlan({ remoteIds: [page.id], pages: [page] });
  assert.deepEqual(toDelete, []);
  assert.equal(orphanCount, 0);
});

safeTest("the previews and the course stay on the stub, so the row it points at is still identifiable", () => {
  const page = converted();
  assert.equal(page.aiMeta.course, "BIO 101");
  assert.equal(page.aiMeta.week, "3");
  assert.deepEqual(Object.keys(page.aiMeta.previews), ["en"]);
});

safeTest("it records WHICH language was converted, because the row still holds the others", () => {
  const es = converted(lecturePage({ aiMeta: { ...lecturePage().aiMeta, activeLanguage: "es" } }), summary(), "es");
  assert.equal(es.aiMeta.convertedFrom, "es");
  assert.equal(es.aiMeta.convertedAt, at());
});

safeTest("the language argument WINS over the stub's activeLanguage — the student converts what they are reading", () => {
  const page = lecturePage({ aiMeta: { ...lecturePage().aiMeta, activeLanguage: "en" } });
  const out = converted(page, summary(), "es");
  assert.equal(out.aiMeta.convertedFrom, "es");
});

/* ---------- 3. what it produces ---------- */

safeTest("A CONVERTED NOTE IS A BLOCK NOTE, and an unconverted one still is not", () => {
  assert.equal(isBlockNote(lecturePage()), false, "an unconverted lecture note belongs to the read-only viewer");
  assert.equal(isBlockNote(converted()), true, "a converted one must reach the editor");
  assert.equal(blocksOf(lecturePage()), null);
  assert.equal(Array.isArray(blocksOf(converted())), true);
});

safeTest("the readers round-trip it: htmlOf and bodyOf return what was written", () => {
  const page = converted();
  const { html, body } = summaryToNote(summary());
  assert.equal(htmlOf(page), html);
  assert.equal(bodyOf(page), body);
  assert.deepEqual(fieldsFromBlocks(page.blocks), { html, body });
});

safeTest("every section the viewer shows reaches the note, in the order it was on screen", () => {
  const { html, body } = summaryToNote(summary({ openQuestions: ["Why is complex II different?"] }));
  const order = ["Oxidative phosphorylation", "Succinate to fumarate", "Might be assessed", "Name the four complexes", "Open questions", "Why is complex II different?"];
  let cursor = -1;
  for (const fragment of order) {
    const found = html.indexOf(fragment);
    assert.ok(found > cursor, `"${fragment}" is missing from the converted note, or is out of order`);
    cursor = found;
    assert.ok(body.includes(fragment), `"${fragment}" is missing from the note's plain text`);
  }
});

safeTest("an empty section contributes NOTHING — no stray heading over no bullets", () => {
  const { html } = summaryToNote(summary({ assessable: [], openQuestions: [] }));
  assert.doesNotMatch(html, /Might be assessed/);
  assert.doesNotMatch(html, /Open questions/);
  assert.doesNotMatch(html, /<ul><\/ul>/);
});

safeTest("MODEL OUTPUT IS ESCAPED — a summary is not markup, and the editor stores html", () => {
  const nasty = summary({
    overview: '<img src=x onerror="alert(1)">',
    keyPoints: ["<script>steal()</script>", "a < b && c > d"],
  });
  const { html, body } = summaryToNote(nasty);
  /* THE CLAIM IS THAT NOTHING THE MODEL WROTE BECOMES MARKUP, and
     saying it as "the word onerror is absent" would be the wrong
     claim twice over: the word survives as inert TEXT, correctly --
     it is what the lecturer said, as far as a note is concerned --
     and a lecture on XSS would then fail its own conversion.
     So: remove this module's OWN tags and require no angle bracket
     to remain anywhere. A single surviving `<` is a tag the content
     smuggled in. */
  const withoutOurTags = html.replace(/<\/?(?:p|strong|ul|li)>/g, "");
  assert.doesNotMatch(withoutOurTags, /[<>]/, "content reached the html as markup rather than as text");
  assert.match(html, /&lt;img/, "and it really is still there, escaped -- not silently dropped");
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  /* The plain text keeps the characters as the lecturer's words: it is
     never rendered as markup, and mangling it would change the note. */
  assert.ok(body.includes("a < b && c > d"));
});

safeTest("the html and the body are BOTH derived from the summary, so neither can describe the other wrongly", () => {
  /* Not a tautology: the body is built from the source object, never
     by parsing the html -- which is what keeps this module free of a
     DOM and testable from here at all. The check is that the plain
     text carries every line and none of the tags. */
  const { html, body } = summaryToNote(summary());
  assert.doesNotMatch(body, /[<>]/, "the plain text must carry no markup");
  for (const line of body.split("\n")) assert.ok(html.includes(escapeHtml(line)), `"${line}" is in the text and not in the html`);
});

safeTest("the block id is DERIVED FROM THE PAGE ID, so two devices converting the same note agree", () => {
  const a = converted();
  const b = converted();
  assert.equal(a.blocks[0].id, b.blocks[0].id);
  assert.ok(a.blocks[0].id.startsWith("msn0duf5-hk684"));
});

safeTest("the legacy fields are EMPTIED rather than omitted, so patchItem cannot leave a second copy", () => {
  const patch = convertPatch({ page: lecturePage(), content: summary(), nowISO: at });
  assert.equal(patch.html, "");
  assert.equal(patch.body, "");
  assert.deepEqual(patch.strokes, []);
});

/* ---------- 4. the readers that must stop quoting the AI ---------- */

safeTest("THE LIST STOPS QUOTING THE SUMMARY once the note is converted", () => {
  /* Otherwise the row shows a sentence the note no longer contains,
     and gets further wrong with every edit the student makes. */
  const old = lecturePage({ aiMeta: { ...lecturePage().aiMeta, remote: false, translations: { en: summary() } } });
  assert.ok(aiNotePreview(old).length > 0, "the unconverted preview must be non-empty, or this proves nothing");
  const page = converted(old, summary());
  assert.equal(aiNotePreview(page), "");
});

safeTest("a converted note is not a lecture note, and an unconverted one is", () => {
  assert.equal(isLectureNote(lecturePage()), true);
  assert.equal(isLectureNote(converted()), false);
  assert.equal(isConverted(lecturePage()), false);
  assert.equal(isConverted(converted()), true);
});

/* ---------- 5. the stub whitelist ---------- */

safeTest("THE STUB CARRIES convertedAt — without it, migrating reverts the note to the viewer", () => {
  /* buildStub rebuilds aiMeta from a whitelist, so a key it does not
     name is dropped on the one path every signed-in student takes.
     A converted note whose marker was dropped keeps its `blocks` and
     routes back to the read-only viewer, which renders none of them:
     the student's edits are still there and nothing shows them. */
  const page = converted(lecturePage({ aiMeta: { ...lecturePage().aiMeta, remote: false, translations: { en: summary() } } }));
  const stub = buildStub(page);
  assert.equal(stub.aiMeta.convertedAt, at());
  assert.equal(isConverted(stub), true);
  assert.equal(isBlockNote(stub), true);
});

/* THE SWEEP ITSELF LIVES IN test-ai-store.mjs, which is the file that
   owns buildStub's claims -- widened there to read this module rather
   than copied here. Two sweeps of one rule is the restatement pattern
   arriving as a pair of guards, and the copy that drifts is the one
   nobody is looking at. What stays here is the claim this feature
   depends on: the marker survives migration. */

safeTest("sourceReadingId and partsMerged survive the stub — the two the whitelist had already lost", () => {
  const page = lecturePage({
    aiMeta: {
      ...lecturePage().aiMeta,
      remote: false,
      translations: { en: summary() },
      sourceReadingId: "reading-42",
      partsMerged: false,
      parts: 3,
    },
  });
  const stub = buildStub(page);
  assert.equal(stub.aiMeta.sourceReadingId, "reading-42", "the Textbook tab's Summarised link reads this");
  assert.equal(stub.aiMeta.partsMerged, false, "false must survive, which an `if (x)` carry would drop");
  assert.equal(stub.aiMeta.parts, 3);
});

/* ---------- 6. the boundary, not only the screen ---------- */

safeTest("THE VIEWER OFFERS EDIT ONLY WITH CONTENT IN HAND, and the module refuses anyway", () => {
  /* Two layers, deliberately: the screen does not show a control that
     cannot work, and the module refuses regardless -- because a
     UI-only gate is one refactor from writing an empty note, and the
     refactor need not touch this module. */
  const src = stripComments(read("src/aiNotes.jsx"));
  const button = src.match(/\{content && onConvert && \(/);
  assert.ok(button, "the Edit control must be gated on `content`, which is truthy only when the fetch returned a summary");
  /* And the other half is the behavioural refusal, which every test in
     section 1 already makes. */
});

safeTest("escapeHtml has ONE definition — PlannerApp reads it rather than keeping a second", () => {
  const planner = stripComments(read("src/PlannerApp.jsx"));
  assert.doesNotMatch(planner, /function escapeHtml\s*\(/, "a second escape is a second chance to miss a character");
  assert.match(planner, /import \{[^}]*escapeHtml[^}]*\} from "\.\/aiNoteConvert\.js"/);
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
