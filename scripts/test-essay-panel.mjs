/* ==================================================================
   test-essay-panel.mjs — essay feedback on the assessment row

   Two halves, and the second is the one that matters:

   1. The pure rules (essayFeedback.js): which rows go to
      assessment_feedback, when the mark comparison is asked, what the
      saved note carries. Plain Node.

   2. THE REAL Grades COMPONENT, mounted in jsdom, signed in, driven by
      CLICKING. A guard for a bug that needs a user action has to
      perform the action: an idle mount would render the one-line
      button and pass over everything behind it. The network is stubbed
      at the client module (aiTextClient.js), so what is tested is our
      own state machine, and the stub records what reached it.

   What it cannot see: layout (Grace's), WebKit, and the real endpoint.
   The endpoint half is test-ai-text-function.mjs.
   ================================================================== */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import {
  showMarkCompare,
  ratedRow,
  onMarkRow,
  deliveredRow,
  essayNoteFields,
  reasonsFor,
  optInNeeded,
  ESSAY_OPT_IN_VERSION,
  FEEDBACK_REASONS,
  RATINGS,
  MAX_COMMENT_CHARS,
  MAX_REASONS,
} from "../src/essayFeedback.js";
import { ESSAY_COPY, copyCovers } from "../src/essayCopy.js";
import { DEFICIENCIES, SEVERITY_LEVELS, PREDICTION_PATTERNS } from "../src/essayPoints.js";
import { recordFeedback } from "../src/essayFeedbackStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}\n        ${e.message}`);
  }
}

/* ---------------- 1. the pure rules ---------------- */

await test("THE ASK IS A RENDER CONDITION: marked, given feedback, never asked, and not while the mark is being typed", () => {
  const a = { id: "a1", mark: 72, essayFeedbackAt: "2026-09-26T00:00:00Z" };
  assert.equal(showMarkCompare(a), true);
  assert.equal(showMarkCompare({ ...a, mark: 0 }), true, "a mark of 0 is a mark");
  assert.equal(showMarkCompare({ ...a, mark: null }), false);
  assert.equal(showMarkCompare({ ...a, essayFeedbackAt: undefined }), false, "asked about an assessment we never read");
  assert.equal(showMarkCompare({ ...a, markCompareAsked: "x" }), false, "asked twice");
  assert.equal(showMarkCompare(a, { editing: true }), false, "asked mid-keystroke");
});

await test("A COMMENT TRAVELS ONLY ON THE TICK, whatever is in the box", () => {
  const base = { id: "i", userId: "u", assessmentId: "a", runId: "r", result: { points: [] }, rating: "no", reasons: ["too-vague"], comment: "my essay's own words" };
  assert.equal(ratedRow({ ...base, sendComment: false }).comment, null);
  assert.equal(ratedRow({ ...base, sendComment: true }).comment, "my essay's own words");
  assert.equal(ratedRow({ ...base, sendComment: true, comment: "x".repeat(900) }).comment.length, MAX_COMMENT_CHARS);
  assert.equal(ratedRow({ ...base, sendComment: true, comment: "   " }).comment, null);
});

await test("reasons: none on a yes, only known ids, and the rewrite complaint only when a rewrite was asked for", () => {
  const base = { id: "i", userId: "u", assessmentId: "a", runId: "r", result: {}, sendComment: false };
  assert.deepEqual(ratedRow({ ...base, rating: "yes", reasons: ["too-vague"] }).reasons, []);
  assert.deepEqual(ratedRow({ ...base, rating: "no", reasons: ["too-vague", "made-up", "too-vague"] }).reasons, ["too-vague"]);
  assert.deepEqual(ratedRow({ ...base, rating: "no", reasons: ["rewrite-changed-meaning"] }).reasons, []);
  assert.deepEqual(ratedRow({ ...base, rating: "no", reasons: ["rewrite-changed-meaning"], rewriteRequested: true }).reasons, ["rewrite-changed-meaning"]);
  assert.ok(!reasonsFor().includes("rewrite-changed-meaning"));
  assert.throws(() => ratedRow({ ...base, rating: "maybe" }), /not a rating/);
});

await test("THE TICK IS THE ONLY THING THAT MOVES A MARK, and the band follows the semester's rounding rule", () => {
  const assessment = { id: "a1", mark: 74.5 };
  const unticked = onMarkRow({ id: "i", userId: "u", assessment, rating: "partly", reasons: [], shareMark: false });
  assert.equal(unticked.mark, null);
  assert.equal(unticked.band, null);
  assert.equal(unticked.rating, "partly", "the verdict survives without the mark");
  assert.equal(onMarkRow({ id: "i", userId: "u", assessment, rating: "yes", shareMark: true, rule: "half-up" }).band, "Distinction");
  assert.equal(onMarkRow({ id: "i", userId: "u", assessment, rating: "yes", shareMark: true, rule: "truncate" }).band, "Credit");
  assert.equal(onMarkRow({ id: "i", userId: "u", assessment, rating: "yes", shareMark: true }).mark, 74.5);
  assert.equal(onMarkRow({ id: "i", userId: "u", assessment, rating: "yes" }).run_id, null, "on_mark carries no run, as 0023 requires");
});

await test("the delivered row carries each code once and nothing a student wrote", () => {
  const row = deliveredRow({
    id: "i", userId: "u", assessmentId: "a", runId: "r",
    result: { points: [{ deficiency: "repetition", quote: "SECRET", note: "n" }, { deficiency: "repetition" }, { deficiency: "contradiction" }], sentence: "SECRET" },
  });
  assert.deepEqual(row.deficiency_codes, ["repetition", "contradiction"]);
  assert.ok(!JSON.stringify(row).includes("SECRET"), "essay text reached the delivered row");
  assert.equal(row.occasion, "delivered");
  assert.equal(row.rating, undefined, "0023 refuses a rating on a delivered row");
});

await test("THE ROWS MATCH 0023's COLUMN CHECKS, read from the migration rather than restated", () => {
  const sql = read("supabase/migrations/0023_assessment_feedback.sql");
  assert.equal(Number(/char_length\(comment\) <= (\d+)/.exec(sql)[1]), MAX_COMMENT_CHARS);
  assert.equal(Number(/cardinality\(reasons\) <= (\d+)/.exec(sql)[1]), MAX_REASONS);
  assert.ok(FEEDBACK_REASONS.length <= MAX_REASONS);
  const ratings = /rating in \(([^)]+)\)/.exec(sql)[1].split(",").map((x) => x.trim().replace(/'/g, ""));
  assert.deepEqual(ratings, [...RATINGS]);
});

await test("THE SAVED NOTE NEVER CARRIES A BAND WITHOUT THE DISCLAIMER, and escapes what the model wrote", () => {
  const result = {
    band: "Credit",
    sentence: "Reads clearly.",
    points: [
      { deficiency: "repetition", quote: "<script>x</script>", note: "Said twice." },
      { deficiency: "claim-without-evidence", quote: "It is true", note: "No support." },
    ],
  };
  const f = essayNoteFields({ result, assessment: { title: "Essay 1" }, copy: ESSAY_COPY, pageId: "p1" });
  const b = f.blocks[0];
  assert.ok(b.html.includes(ESSAY_COPY.bandLine("Credit")) && b.html.includes("not a prediction of your mark"));
  assert.ok(b.body.includes(ESSAY_COPY.disclaimer));
  assert.ok(!b.html.includes("<script>"), "model output was written into the note as markup");
  assert.ok(b.html.indexOf("It is true") < b.html.indexOf("&lt;script"), "the fundamental point is not first");
  assert.equal(f.title, "Essay feedback — Essay 1");
  const noBand = essayNoteFields({ result: { ...result, band: "" }, assessment: {}, copy: ESSAY_COPY, pageId: "p2" });
  assert.ok(!noBand.blocks[0].html.includes("reads like"));
});

await test("the opt-in is once per account and versioned", () => {
  assert.equal(optInNeeded({}), true);
  assert.equal(optInNeeded({ essayOptIn: { version: ESSAY_OPT_IN_VERSION } }), false);
  assert.equal(optInNeeded({ essayOptIn: { version: ESSAY_OPT_IN_VERSION - 1 } }), true);
});

await test("recordFeedback: no client does nothing, 23505 is done, any other error is a failure, and it never throws", async () => {
  assert.equal((await recordFeedback({ supabaseClient: null, row: { user_id: "u" } })).skipped, true);
  const client = (error) => ({ from: () => ({ insert: async () => ({ error }) }) });
  assert.equal((await recordFeedback({ supabaseClient: client(null), row: { user_id: "u" } })).ok, true);
  assert.equal((await recordFeedback({ supabaseClient: client({ code: "23505" }), row: { user_id: "u" } })).existed, true);
  assert.equal((await recordFeedback({ supabaseClient: client({ code: "42P01" }), row: { user_id: "u" } })).ok, false);
  const throws = { from: () => ({ insert: async () => { throw new Error("offline"); } }) };
  assert.equal((await recordFeedback({ supabaseClient: throws, row: { user_id: "u" } })).ok, false);
  assert.ok(!/\.upsert\(/.test(read("src/essayFeedbackStore.js")), "an upsert needs UPDATE, which 0023 does not grant");
});

/* ---------------- the copy ---------------- */

const strings = [];
const walk = (v) => {
  if (typeof v === "string") strings.push(v);
  else if (typeof v === "function") strings.push(String(v.length ? v("Credit", 24000) : v()));
  else if (v && typeof v === "object") Object.values(v).forEach(walk);
};
walk(ESSAY_COPY);

await test("EVERY CODE HAS A LABEL AND EVERY SEVERITY A HEADING, derived from the schema's own lists", () => {
  assert.ok(DEFICIENCIES.length >= 10 && SEVERITY_LEVELS.length === 3, "the lists being checked are nearly empty");
  const c = copyCovers({ levels: SEVERITY_LEVELS, codes: DEFICIENCIES });
  assert.ok(c.ok, `missing: ${[...c.missingLevels, ...c.missingCodes].join(", ")}`);
  for (const r of FEEDBACK_REASONS) assert.ok(ESSAY_COPY.capture.reasons[r], `reason ${r} has no words`);
});

await test("NO SENTENCE PREDICTS A MARK, and the disclaimer says the two things it must (§4)", () => {
  assert.ok(strings.length > 30, `the sweep read ${strings.length} strings, so it is reading almost nothing`);
  for (const s of strings) for (const p of PREDICTION_PATTERNS) assert.ok(!p.test(s), `prediction framing: "${s}"`);
  assert.match(ESSAY_COPY.bandLine("Credit"), /criteria you pasted/);
  assert.match(ESSAY_COPY.disclaimer, /not a prediction of your mark/);
  assert.match(ESSAY_COPY.disclaimer, /criteria you gave it/);
  /* THE CONTROL: the patterns really do catch a prediction. */
  assert.ok(PREDICTION_PATTERNS.some((p) => p.test("You'll get a Credit.")));
});

await test("THE OPT-IN SAYS WHAT THE RULING ASKED FOR, and disclaims no responsibility", () => {
  const t = ESSAY_COPY.optIn.bullets.join(" ");
  assert.match(t, /can be wrong|may be wrong/i);
  assert.match(t, /marker's judgement/i);
  assert.match(t, /unit's rules/i);
  assert.match(t, /real marks/i);
  assert.match(t, /useful/i);
  assert.doesNotMatch(t, /own risk|not responsible|no responsibility|liab/i);
});

await test("THE COMMENT BOX SAYS WHAT IS STORED AND THAT IT TRAINS NOTHING, and the mark tick says what unticking means", () => {
  const note = ESSAY_COPY.capture.commentNote(MAX_COMMENT_CHARS);
  assert.match(note, /Only sent if you tick/);
  assert.match(note, /trains nothing/);
  assert.match(note, /essay/);
  assert.match(ESSAY_COPY.markAsk.shareNote, /nothing about the mark leaves your planner/i);
});

/* ---------------- 2. the real component, clicked ---------------- */

const tmp = path.join(rootDir, ".essay-panel-tmp");
fs.mkdirSync(tmp, { recursive: true });
const clientStub = path.join(tmp, "ai-text-client-stub.js");
fs.writeFileSync(
  clientStub,
  "export const fetchTextAllowance = async () => ({ unavailable: true });\n" +
    "export const callAiText = async (args) => {\n" +
    "  globalThis.__calls = [...(globalThis.__calls || []), args];\n" +
    "  return { allowanceUsed: 0.15, result: globalThis.__result };\n" +
    "};\n"
);
const configStub = path.join(tmp, "config-demo.js");
fs.writeFileSync(configStub, 'export const SUPABASE_URL = "x";\nexport const SUPABASE_ANON_KEY = "x";\nexport const isConfigured = false;\n');
const probe = path.join(tmp, "probe.jsx");
fs.writeFileSync(
  probe,
  `import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Grades } from "../src/PlannerApp.jsx";
const ALLOWANCE = { tier: "free", limit: 60, used: 0, remaining: 60, fraction: 0, perMonth: false };
function Harness({ initial, optInNeeded, sink }) {
  const [list, setList] = useState(initial);
  const [needed, setNeeded] = useState(optInNeeded);
  const patchItem = (key, id, patch) => {
    sink.patches.push({ key, id, patch });
    setList((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };
  const essay = {
    session: { token: "t", user: { id: "u" } },
    allowanceApi: { allowance: ALLOWANCE, applyFraction: () => {}, consent: { needed: false } },
    rule: "half-up",
    optIn: { needed, accept: () => { sink.optedIn = true; setNeeded(false); } },
    onDelivered: (a, x) => { sink.delivered.push({ a, ...x }); patchItem("assessments", a.id, { essayFeedbackAt: "now" }); },
    onRate: async (a, x) => { sink.rated.push({ a, ...x }); return true; },
    onSave: (a, x) => sink.saved.push({ a, ...x }),
    onMarkAnswer: (a, x) => { sink.answers.push({ a, ...x }); patchItem("assessments", a.id, { markCompareAsked: "now" }); },
    onMarkDismiss: (a) => { sink.dismissed.push(a.id); patchItem("assessments", a.id, { markCompareAsked: "now" }); },
  };
  return <Grades assessments={list} courses={[{ id: "c", name: "HIST1001" }]} addItem={() => {}} patchItem={patchItem}
    removeItem={() => {}} focused={null} rule="half-up" essay={sink.signedOut ? null : essay} />;
}
window.__mount = (initial, { optInNeeded = false, signedOut = false } = {}) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const sink = { patches: [], delivered: [], rated: [], saved: [], answers: [], dismissed: [], optedIn: false, signedOut };
  createRoot(host).render(<Harness initial={initial} optInNeeded={optInNeeded} sink={sink} />);
  return { host, sink };
};
`
);

const bundle = await build({
  entryPoints: [probe],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  write: false,
  absWorkingDir: rootDir,
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "silent",
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: configStub }));
        b.onResolve({ filter: /aiTextClient\.js$/ }, () => ({ path: clientStub }));
      },
    },
  ],
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: "outside-only", url: "https://example.test/", pretendToBeVisual: true });
const win = dom.window;
const complaints = [];
win.console.error = (...a) => complaints.push(a.join(" "));
win.eval(bundle.outputFiles[0].text);
fs.rmSync(tmp, { recursive: true, force: true });

/* Objects built inside the jsdom window carry that realm's prototypes,
   which strict deepEqual rejects however equal the contents are. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 30));
const q = (host, sel) => host.querySelector(sel);
const type = (el, value) => {
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
};

win.__result = {
  genre: "argument",
  band: "Score Point 3",
  bandTied: [],
  sentence: "The position is clear and the support is thin in places.",
  points: [
    { quote: "people learn faster", deficiency: "repetition", note: "Said in two paragraphs.", severity: "minor" },
    { quote: "computers help everyone", deficiency: "claim-without-evidence", note: "Nothing shows this.", severity: "fundamental" },
  ],
  dropped: {},
};

const essayRow = (over = {}) => ({ id: "a1", course: "HIST1001", title: "Essay 1", w: 40, ...over });

await test("SIGNED OUT, THE ROW HAS NO ESSAY CONTROL AT ALL", async () => {
  const { host } = win.__mount([essayRow()], { signedOut: true });
  await tick();
  assert.ok(host.textContent.includes("Essay 1"), "the row did not render, so this proves nothing");
  assert.equal(q(host, "[data-essay-open]"), null);
});

await test("THE OPT-IN COMES BEFORE ANY INPUT, and accepting it reaches the fields", async () => {
  const { host, sink } = win.__mount([essayRow()], { optInNeeded: true });
  await tick();
  q(host, "[data-essay-open]").click();
  await tick();
  assert.ok(q(host, "[data-essay-opt-in]"), "no opt-in screen");
  assert.equal(q(host, "[data-essay-text]"), null, "the essay box is reachable before opting in");
  [...host.querySelectorAll("button")].find((b) => b.textContent.includes(ESSAY_COPY.optIn.accept)).click();
  await tick();
  assert.equal(sink.optedIn, true);
  assert.ok(q(host, "[data-essay-text]"), "accepting did not open the fields");
});

await test("A RUN, CLICKED THROUGH: the request carries both texts, the band shows with its disclaimer, fundamental first, and the run is recorded", async () => {
  win.__calls = [];
  const { host, sink } = win.__mount([essayRow()]);
  await tick();
  q(host, "[data-essay-open]").click();
  await tick();
  q(host, "[data-essay-go]").click();
  await tick();
  assert.equal(win.__calls.length, 0, "an empty paste reached the provider");
  type(q(host, "[data-essay-text]"), "My draft about computers.");
  type(q(host, "[data-essay-criteria]"), "Score Point 1 ... Score Point 4");
  await tick();
  q(host, "[data-essay-go]").click();
  await tick();
  await tick();
  assert.equal(win.__calls.length, 1);
  assert.equal(win.__calls[0].task, "essay");
  assert.deepEqual(plain(win.__calls[0].payload), { text: "My draft about computers.", criteria: "Score Point 1 ... Score Point 4" });
  const band = q(host, "[data-essay-band]");
  assert.ok(band && band.textContent.includes("reads like a Score Point 3"));
  assert.ok(q(band, "[data-essay-disclaimer]"), "THE BAND RENDERED WITHOUT ITS DISCLAIMER");
  const sev = [...host.querySelectorAll("[data-essay-severity]")].map((e) => e.getAttribute("data-essay-severity"));
  assert.deepEqual(sev, ["fundamental", "minor"]);
  assert.equal(sink.delivered.length, 1);
  assert.ok(sink.delivered[0].runId, "the run has no id, so its rating could not be tied to it");
  assert.ok(sink.patches.some((p) => p.patch.essayFeedbackAt), "the assessment was not marked as having feedback");
  assert.ok(!JSON.stringify(sink.patches).includes("My draft"), "THE ESSAY REACHED THE PLANNER");
});

await test("THE RATING, CLICKED: reasons appear for a no, the comment is off until ticked, and it is tied to the run", async () => {
  const { host, sink } = win.__mount([essayRow()]);
  await tick();
  q(host, "[data-essay-open]").click();
  await tick();
  type(q(host, "[data-essay-text]"), "Draft.");
  type(q(host, "[data-essay-criteria]"), "Criteria.");
  await tick();
  q(host, "[data-essay-go]").click();
  await tick();
  await tick();
  assert.ok(q(host, "[data-essay-capture]"), "no rating on the result");
  q(host, '[data-essay-rating="no"]').click();
  await tick();
  const vague = [...host.querySelectorAll("label")].find((l) => l.textContent.includes(ESSAY_COPY.capture.reasons["too-vague"]));
  assert.ok(vague, "no reasons offered for a no");
  assert.ok(!host.textContent.includes(ESSAY_COPY.capture.reasons["rewrite-changed-meaning"]), "the rewrite complaint shows with no rewrite asked for");
  vague.querySelector("input").click();
  await tick();
  assert.equal(q(host, "[data-essay-capture] textarea"), null, "the comment box is open before the tick");
  [...host.querySelectorAll("button")].find((b) => b.textContent === ESSAY_COPY.capture.send).click();
  await tick();
  assert.equal(sink.rated.length, 1);
  assert.equal(sink.rated[0].rating, "no");
  assert.deepEqual(plain(sink.rated[0].reasons), ["too-vague"]);
  assert.equal(sink.rated[0].sendComment, false);
  assert.equal(sink.rated[0].runId, sink.delivered[0].runId);
  assert.ok(host.textContent.includes(ESSAY_COPY.capture.thanks));
});

await test("THE ASK APPEARS ON A MARKED ROW WITH FEEDBACK, and not while the mark field has focus", async () => {
  const { host } = win.__mount([essayRow({ mark: 72, essayFeedbackAt: "x" }), { ...essayRow({ id: "a2", title: "Quiz", mark: 60 }) }]);
  await tick();
  assert.equal(host.querySelectorAll("[data-mark-compare]").length, 1, "the ask shows on a row we never read, or not on the one we did");
  const input = host.querySelector('input[aria-label="Mark for Essay 1"]');
  input.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  input.focus();
  await tick();
  assert.equal(host.querySelectorAll("[data-mark-compare]").length, 0, "the ask appeared under the student's fingers");
  input.blur();
  await tick();
  assert.equal(host.querySelectorAll("[data-mark-compare]").length, 1);
});

await test("ANSWERED ONCE: the tick decides the mark, the thanks outlives the flag, and it never asks again", async () => {
  const { host, sink } = win.__mount([essayRow({ mark: 72, essayFeedbackAt: "x" })]);
  await tick();
  q(host, '[data-mark-compare] [data-essay-rating="partly"]').click();
  await tick();
  q(host, "[data-mark-send]").click();
  await tick();
  assert.equal(sink.answers.length, 1);
  assert.equal(sink.answers[0].shareMark, false, "the mark was shared without the tick");
  assert.ok(sink.patches.some((p) => p.patch.markCompareAsked));
  assert.ok(host.textContent.includes(ESSAY_COPY.markAsk.thanks), "the thanks vanished with the flag");
});

await test("DISMISSED IS ANSWERED: the ask goes and does not return", async () => {
  const { host, sink } = win.__mount([essayRow({ mark: 72, essayFeedbackAt: "x" })]);
  await tick();
  q(host, "[data-mark-dismiss]").click();
  await tick();
  assert.deepEqual(plain(sink.dismissed), ["a1"]);
  assert.equal(q(host, "[data-mark-compare]"), null);
});

await test("nothing above logged a React error", () => {
  assert.deepEqual(complaints.filter((c) => !/act\(|ReactDOMTestUtils/.test(c)), []);
});

await test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-essay-panel\.mjs|test-\*|scripts\/test-/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
if (passed === 0) process.exit(1);
