/* Tests for summarising a reading: the chunker, the pricing, what
   happens when the merge fails, and the wording rule.

   Three of these are the ones to read first:

     "the pasted text is never persisted anywhere"  — the design fact
     the whole copyright posture rests on, asserted for readings
     specifically rather than inherited from the note path

     "a failed merge keeps every section summary" — each section was
     charged, so discarding them takes the allowance and gives nothing

     "the copy never suggests skipping the reading" — a blunt grep, and
     deliberately so */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  chunkReading,
  estimateReading,
  combineParts,
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  MAX_READING_CHUNKS,
  READING_MAX_CHARS,
  estimatePhotos,
  batchPhotos,
  photoNumberFor,
  PHOTOS_PER_CHUNK,
  MAX_READING_PHOTOS,
} from "../src/readingChunks.js";
import { READING_COPY } from "../src/aiTextCopy.js";
import * as failuresCopy from "../src/aiTextCopy.js";
import { TASK_UNITS, sectionsAffordable, canAffordUnits } from "../src/aiTextLimits.js";
import { validateRequest } from "../supabase/functions/ai-text/guards.js";
import { buildMessages, parseTaskResult } from "../supabase/functions/ai-text/prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const source = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const para = (n, filler = "word ") => filler.repeat(Math.ceil(n / filler.length)).slice(0, n).trim();
const reading = (paras) => paras.join("\n\n");

console.log("\nreadings");

/* ---------- the chunker ---------- */

test("a short reading is one chunk and needs no merge", () => {
  const r = estimateReading("A short paragraph about tectonics.");
  assert.equal(r.ok, true);
  assert.equal(r.chunks, 1);
  assert.equal(r.units, TASK_UNITS.summarise);
});

test("a reading is split on paragraph boundaries, never mid-sentence", () => {
  const paras = [para(9000), para(9000), para(9000)];
  const { ok, chunks } = chunkReading(reading(paras));
  assert.equal(ok, true);
  assert.ok(chunks.length > 1, "a 27,000-character reading should not be one chunk");
  /* Each chunk after the first starts with carried-over text, so what
     matters is that no chunk ENDS mid-word. */
  for (const c of chunks) assert.ok(!/\S$/.test(c) || /[\w.!?"')\]]$/.test(c), "a chunk ended mid-token");
});

test("no chunk exceeds what one summarise call accepts", () => {
  /* Including the overlap. Packing to the full cap and then prepending
     200 characters is the obvious mistake, and the server would answer
     it with a 413 after the student had already paid for the earlier
     parts. */
  const { chunks } = chunkReading(reading([para(19000), para(19000), para(19000), para(19000)]));
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX_CHARS, `chunk of ${c.length} exceeds ${CHUNK_MAX_CHARS}`);
});

test("consecutive chunks overlap, so a claim on a boundary survives whole", () => {
  const { chunks } = chunkReading(reading([para(15000), para(15000)]));
  assert.ok(chunks.length >= 2);
  const tail = chunks[0].slice(-CHUNK_OVERLAP_CHARS);
  const head = chunks[1].slice(0, CHUNK_OVERLAP_CHARS + 40);
  /* Some suffix of chunk 1 appears at the top of chunk 2. */
  const carried = tail.slice(-80);
  assert.ok(head.includes(carried.slice(-40)), "no overlap was carried across the boundary");
});

test("an over-long single paragraph falls back to sentence splitting", () => {
  /* Dense academic prose runs for thousands of words without a blank
     line, and it is exactly the sort of reading this is for. */
  const oneParagraph = "This sentence is a claim about the material. ".repeat(1200); // ~54,000 chars
  const { ok, chunks } = chunkReading(oneParagraph);
  assert.equal(ok, true);
  assert.ok(chunks.length > 1, "one long paragraph was never split");
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX_CHARS);
  /* Split at sentence ends: every chunk should finish on punctuation. */
  assert.ok(chunks.slice(0, -1).every((c) => /[.!?]\s*$/.test(c)), "a chunk was cut mid-sentence");
});

test("a single sentence longer than a chunk is cut rather than dropped", () => {
  const monster = `${"a".repeat(45000)}.`;
  const { ok, chunks } = chunkReading(monster);
  assert.equal(ok, true);
  const total = chunks.join("").replace(/\s/g, "").length;
  assert.ok(total >= 45000, "content was lost splitting an unsplittable sentence");
});

test("a reading over the ceiling is refused with a number, not trimmed", () => {
  /* Silently summarising the first three quarters and presenting it as
     the whole reading is the worst outcome available here. */
  const huge = para(READING_MAX_CHARS + 5000);
  const r = estimateReading(huge);
  assert.equal(r.ok, false);
  assert.equal(r.code, "too_long");
  assert.equal(r.limit, READING_MAX_CHARS);
  assert.match(READING_COPY.tooLong({ chars: r.chars, limit: r.limit }), /\d/);
});

test("empty input is refused before anything is priced", () => {
  assert.equal(estimateReading("").ok, false);
  assert.equal(estimateReading("   \n\n  ").code, "empty");
});

test("nothing is lost between the paragraphs of a split reading", () => {
  const paras = [para(8000, "alpha "), para(8000, "beta "), para(8000, "gamma ")];
  const { chunks } = chunkReading(reading(paras));
  const joined = chunks.join(" ");
  for (const marker of ["alpha", "beta", "gamma"]) assert.ok(joined.includes(marker), `${marker} vanished`);
});

/* ---------- what it costs, before the work ---------- */

test("the cost of a reading rises with its length, and the estimate says so", () => {
  const one = estimateReading(para(10_000));
  const many = estimateReading(reading([para(19000), para(19000), para(19000)]));
  assert.equal(one.chunks, 1);
  assert.ok(many.chunks > one.chunks);
  assert.ok(many.units > one.units);
  assert.equal(many.units, many.chunks * TASK_UNITS.summarise + TASK_UNITS.merge);
});

test("the four-chunk ceiling costs 13 units", () => {
  /* The arithmetic in config.ts, asserted rather than left in a comment. */
  assert.equal(MAX_READING_CHUNKS * TASK_UNITS.summarise + TASK_UNITS.merge, 13);
});

test("a single-chunk reading is never charged for a merge", () => {
  const r = estimateReading(para(500));
  assert.equal(r.units, TASK_UNITS.summarise);
});

test("a refusal states the real numbers: how big it is and what's left", () => {
  /* Not a generic "not enough left". The interaction is otherwise
     baffling: ten units is ONE shorter reading, not four of anything,
     and a student refused a long one after using nothing all month
     reads the counter as broken rather than as spent. */
  const copy = READING_COPY.cantAfford({ chunks: 4, sectionsLeft: 1, isFree: true });
  assert.match(copy.title, /4 parts/, "the size of the reading is not stated");
  assert.match(copy.title, /one/, "what is left is not stated");
});

test("a refusal says a shorter paste still fits, when it does", () => {
  /* The actionable half. It turns a dead end into a smaller paste,
     which is the one thing the student can do about it. */
  const some = READING_COPY.cantAfford({ chunks: 4, sectionsLeft: 2, isFree: true });
  assert.match(some.detail, /section at a time/i);

  const none = READING_COPY.cantAfford({ chunks: 4, sectionsLeft: 0, isFree: true });
  assert.doesNotMatch(none.detail, /section at a time/i, "offered a smaller paste that would also be refused");
  assert.match(none.title, /none of them/i);
});

test("both numbers in a refusal are parts, never units", () => {
  /* Rule 1 of aiTextCopy.js. "This needs 13 and you have 7" would be
     the first time an internal unit count reached a screen, and it
     would mean nothing to anyone. */
  for (const sectionsLeft of [0, 1, 3]) {
    for (const isFree of [true, false]) {
      const c = READING_COPY.cantAfford({ chunks: 4, sectionsLeft, isFree });
      assert.doesNotMatch(`${c.title} ${c.detail}`, /\bunits?\b/i);
    }
  }
});

test("only a free student is told what the plan adds", () => {
  const free = READING_COPY.cantAfford({ chunks: 4, sectionsLeft: 1, isFree: true });
  assert.ok(free.action, "a free student is told what the plan adds");
  const paid = READING_COPY.cantAfford({ chunks: 4, sectionsLeft: 1, isFree: false });
  /* Selling someone the plan they already have is the fastest way to
     make an app feel like it isn't listening. */
  assert.equal(paid.action, null);
  assert.doesNotMatch(paid.detail, /AI plan/i);
  assert.match(paid.detail, /next month/);
});

test("how many sections are left is the same arithmetic the server bills", () => {
  /* Reusing canAfford's machinery rather than a second scheme beside
     it: sectionsAffordable counts SINGLE-section pastes, which is
     exactly what the advice tells the student to do. */
  assert.equal(sectionsAffordable({ remaining: 10 }), 3);
  assert.equal(sectionsAffordable({ remaining: 3 }), 1);
  assert.equal(sectionsAffordable({ remaining: 2 }), 0);
  assert.equal(sectionsAffordable(null), 0);
  assert.equal(canAffordUnits({ remaining: 13 }, 13), true);
  assert.equal(canAffordUnits({ remaining: 12 }, 13), false);
});

test("a summarised reading is filed into the per-course folder, like a recording", () => {
  /* One place per course for everything the AI wrote, rather than
     readings landing loose while lectures get filed. And the folder is
     a convenience: its own try, so a failure leaves the note filed
     nowhere rather than losing work just paid for. */
  const app = source("src/PlannerApp.jsx");
  const handler = app.slice(app.indexOf("const summariseReading ="));
  const body = handler.slice(0, handler.indexOf("\n  };"));
  assert.match(body, /folderForRecording/, "a summarised reading is not filed anywhere");
  const filing = body.slice(body.indexOf("folderForRecording") - 400, body.indexOf("folderForRecording") + 400);
  assert.match(filing, /try \{/, "the folder lookup can take the note down with it");
});

test("the row says whether a reading has been summarised already", () => {
  /* Built from sourceReadingId on the stub, which is the same field
     that must NOT cascade a deletion. */
  const app = source("src/PlannerApp.jsx");
  assert.match(app, /aiMeta\.sourceReadingId/, "nothing reads the link back onto the reading row");
  assert.ok(READING_COPY.summarisedLink, "no wording for an already-summarised reading");
  assert.ok(READING_COPY.rowAction, "no wording for the action on the row");
});

test("the estimate is stated in parts, never in units", () => {
  const words = READING_COPY.estimate({ chars: 40000, chunks: 3 });
  assert.doesNotMatch(words, /\bunits?\b/i);
  assert.match(words, /3 parts/);
});

/* ---------- the merge, and its failure ---------- */

const part = (n) => ({
  overview: `Overview ${n}`,
  keyPoints: [`Point ${n}`],
  terms: [{ term: `Term ${n}`, content: `About ${n}` }],
  assessable: [`Assessable ${n}`],
  openQuestions: [`Question ${n}`],
});

test("a failed merge keeps every section summary", () => {
  /* Each section was summarised and each of those calls was charged.
     Throwing them away because the last, cheapest step failed would take
     the student's allowance and hand back nothing. */
  const combined = combineParts([part(1), part(2), part(3)]);
  assert.equal(combined.merged, false);
  assert.equal(combined.parts, 3);
  for (const n of [1, 2, 3]) {
    assert.ok(combined.overview.includes(`Overview ${n}`), `section ${n} was dropped`);
    assert.ok(combined.keyPoints.includes(`Point ${n}`));
    assert.ok(combined.assessable.includes(`Assessable ${n}`));
    assert.ok(combined.openQuestions.includes(`Question ${n}`));
  }
});

test("locally combined sections are labelled so the note says what it is", () => {
  const combined = combineParts([part(1), part(2)]);
  assert.match(combined.overview, /Part 1 of 2/);
  assert.match(combined.overview, /Part 2 of 2/);
});

test("duplicate terms from the overlap become one study card", () => {
  /* The chunks deliberately repeat ~200 characters, so the same term
     really does come back twice. A duplicate card is a visible defect,
     not a cosmetic one. */
  const a = { overview: "a", terms: [{ term: "Entropy", content: "x" }] };
  const b = { overview: "b", terms: [{ term: "entropy", content: "y" }, { term: "Enthalpy", content: "z" }] };
  const combined = combineParts([a, b]);
  assert.equal(combined.terms.length, 2);
  assert.deepEqual(combined.terms.map((t) => t.term).sort(), ["Enthalpy", "Entropy"]);
});

test("a merge that succeeded is not labelled as parts", () => {
  const one = combineParts([part(1)]);
  assert.equal(one.merged, true);
  assert.equal(combineParts([]), null);
});

test("the merge-failed wording says what was charged and what wasn't", () => {
  /* Two different facts, two different sentences. The merge failing
     outright costs nothing; unusable output from it costs allowance. */
  assert.match(READING_COPY.mergeFailed.billing, /hasn't been counted/i);
  assert.match(READING_COPY.mergeCharged.billing, /charged/i);
  assert.notEqual(READING_COPY.mergeFailed.title, READING_COPY.mergeCharged.title);
});

/* ---------- the server side of merge ---------- */

const validate = (body) =>
  validateRequest({
    body,
    tasks: ["practice", "explain", "weakspots", "summarise", "merge"],
    maxInputChars: { explain: 4000, weakspots: 6000, practice: 8000, summarise: 20000, merge: 12000 },
    practiceMaxCards: 30,
    weakspotsMaxTopics: 40,
    maxReadingChunks: MAX_READING_CHUNKS,
  });

test("merge accepts two to four sections", () => {
  assert.equal(validate({ task: "merge", parts: [part(1), part(2)] }).ok, true);
  assert.equal(validate({ task: "merge", parts: [part(1), part(2), part(3), part(4)] }).ok, true);
});

test("merging one section is refused rather than charged for a no-op", () => {
  /* The client never sends one -- a single-chunk reading skips the
     merge -- so reaching this is a hand-built request, and taking money
     to hand back the input would be the worst way to answer it. */
  const r = validate({ task: "merge", parts: [part(1)] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_request");
});

test("more sections than the chunker can produce is refused", () => {
  const r = validate({ task: "merge", parts: [part(1), part(2), part(3), part(4), part(5)] });
  assert.equal(r.ok, false);
});

test("a merge rejection is byte-identical to every other bad request", () => {
  /* One error shape for every rejection, so the endpoint never becomes
     an oracle about what it expects. */
  const a = validate({ task: "merge", parts: [part(1)] });
  const b = validate({ task: "merge", parts: [{ nonsense: true }, { nonsense: true }] });
  assert.equal(a.code, b.code);
  assert.equal(a.error, b.error);
  assert.notEqual(a.detail, b.detail, "the logs should still tell them apart");
});

test("merge sees the sections in order, each as its own message", () => {
  const msgs = buildMessages("merge", { parts: [part(1), part(2)] });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[1].content, /Section 1 of 2/);
  assert.match(msgs[2].content, /Section 2 of 2/);
  /* Nothing client-supplied is interpolated into the instruction. */
  assert.doesNotMatch(msgs[0].content, /Overview 1/);
});

test("the merge prompt tells the model the sections overlap", () => {
  /* Without it the repetition carried across a boundary is reported as
     emphasis. */
  assert.match(buildMessages("merge", { parts: [part(1), part(2)] })[0].content, /overlap/i);
});

test("merge output is parsed into exactly the shape a note is built from", () => {
  const parsed = parseTaskResult(
    "merge",
    JSON.stringify({ overview: "All of it", keyPoints: ["a"], terms: [{ term: "t", content: "c" }] })
  );
  assert.equal(parsed.overview, "All of it");
  assert.deepEqual(parsed.terms, [{ term: "t", content: "c" }]);
  assert.deepEqual(parsed.assessable, []);
});

test("a merge with no overview is an error, not a blank note", () => {
  assert.throws(() => parseTaskResult("merge", JSON.stringify({ keyPoints: ["a"] })), /merge/);
});

/* ---------- the constants that are mirrored ---------- */

test("the chunk ceiling matches the server's", () => {
  /* Derived from the source of truth rather than restated: a client
     that split into five would have the fifth call refused after the
     first four were charged. */
  const config = source("supabase/functions/ai-text/config.ts");
  const serverMax = Number(config.match(/MAX_READING_CHUNKS = (\d+)/)[1]);
  assert.equal(MAX_READING_CHUNKS, serverMax);
  const serverSummarise = Number(config.match(/summarise: ([\d_]+),\s*\/\/ a long typed note/)[1].replace(/_/g, ""));
  assert.equal(CHUNK_MAX_CHARS, serverSummarise);
});

test("the merge weight matches the server's", () => {
  const config = source("supabase/functions/ai-text/config.ts");
  const units = config.slice(config.indexOf("export const TASK_UNITS"));
  assert.equal(Number(units.match(/merge: (\d+)/)[1]), TASK_UNITS.merge);
});

/* ---------- the design facts ---------- */

test("the pasted text is never persisted anywhere", () => {
  /* THE fact the copyright posture rests on, asserted for readings
     specifically rather than inherited from the note path.

     Two halves. The endpoint writes only ai_usage -- so the text has no
     server-side home even on the failure path, unlike a lecture, whose
     transcript is kept for 7 or 30 days. And the client's save path
     stores the RESULT, never the source. */
  const fn = source("supabase/functions/ai-text/index.ts");
  const tables = [...fn.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ["ai_usage", "profiles"]);
  const written = [...fn.matchAll(/\.from\("([^"]+)"\)\s*\.(?:upsert|insert|update|delete)/gs)].map((m) => m[1]);
  assert.deepEqual([...new Set(written)], ["ai_usage"]);

  const app = source("src/PlannerApp.jsx");
  const handler = app.slice(app.indexOf("const summariseReading ="), app.indexOf("const summariseReading =") + 2000);
  assert.doesNotMatch(handler, /\btext\b/, "the reading save path mentions the source text");
  assert.match(handler, /sourceReadingId/);
});

/* ---------- photographed pages ---------- */

test("photos are priced as parts of the reading, not as a second scheme", () => {
  /* The entire pricing story: a batch of PHOTOS_PER_CHUNK pages is one
     summarise call, further batches are further chunks, merge as
     today. Derived from TASK_UNITS, so a weight change re-runs this
     instead of leaving it green. */
  assert.equal(estimatePhotos(1).units, TASK_UNITS.summarise);
  assert.equal(estimatePhotos(4).units, TASK_UNITS.summarise);
  assert.equal(estimatePhotos(5).units, 2 * TASK_UNITS.summarise + TASK_UNITS.merge);
  /* The photo ceiling costs exactly what the text ceiling costs -- 16
     photos and an 80,000-character reading are the same 4-chunk job. */
  assert.equal(estimatePhotos(MAX_READING_PHOTOS).units, 4 * TASK_UNITS.summarise + TASK_UNITS.merge);
  assert.equal(estimatePhotos(MAX_READING_PHOTOS).chunks, MAX_READING_CHUNKS);
});

test("more photos than the ceiling is refused with the numbers, not trimmed", () => {
  const out = estimatePhotos(MAX_READING_PHOTOS + 1);
  assert.equal(out.ok, false);
  assert.equal(out.code, "too_many");
  assert.equal(out.count, MAX_READING_PHOTOS + 1);
  assert.equal(out.maxPhotos, MAX_READING_PHOTOS);
  assert.match(READING_COPY.photosTooMany({ count: 17, max: 16 }), /17/, "the refusal doesn't state the count");
});

test("the photo constants match the server's", () => {
  // Restated because a browser bundle can't import from
  // supabase/functions/ -- so the equality is the guard.
  const config = source("supabase/functions/ai-text/config.ts");
  assert.equal(PHOTOS_PER_CHUNK, Number(config.match(/PHOTOS_PER_CHUNK = (\d+)/)[1]));
  assert.equal(MAX_READING_PHOTOS, Number(config.match(/MAX_READING_PHOTOS = (\d+)/)[1]));
});

test("an unreadable page maps back to the photo the student can retake", () => {
  /* The server names 1-based positions within the batch it saw; the
     student is looking at their whole strip. Batch 2 of a 7-photo run
     starts at photo 5, so its position 2 is photo 6. */
  const { batches } = batchPhotos(7);
  assert.equal(photoNumberFor(batches[0], 2), 2);
  assert.equal(photoNumberFor(batches[1], 2), 6);
});

test("the unreadable copy carries BOTH halves: this attempt charged, the resubmit charges again", () => {
  /* By ruling. A student retaking one page of eight must know the
     resubmit costs before they send it. */
  const { AI_TEXT_FAILURES } = failuresCopy;
  const c = AI_TEXT_FAILURES.pages_unreadable;
  assert.ok(c, "no copy for pages_unreadable");
  const text = `${c.title} ${c.detail}`;
  assert.match(text, /used some of your AI study help/i, "doesn't say this attempt was charged");
  assert.match(text, /will use more|charge/i, "doesn't say the resubmit costs again");
  assert.match(text, /smaller batch/i, "doesn't say the retaken pages go as their own smaller batch");
  assert.match(READING_COPY.unreadablePages([3]), /3/, "the page number never reaches the student");
});

test("the photos are never persisted anywhere, on any path", () => {
  /* The same design fact as the pasted text, asserted for photos
     specifically. Server half: the endpoint writes only ai_usage and
     has NO storage client at all -- images arrive in the request body
     and are relayed, the deliberate opposite of the audio path. Client
     half: photos live in component state; nothing about them reaches
     the draft, the blob, or localStorage. */
  const fn = source("supabase/functions/ai-text/index.ts");
  assert.doesNotMatch(fn, /\.storage/, "ai-text touches the Storage API — photos would have a server-side home");
  const written = [...fn.matchAll(/\.from\("([^"]+)"\)\s*\.(?:upsert|insert|update|delete)/gs)].map((m) => m[1]);
  assert.deepEqual([...new Set(written)], ["ai_usage"], "the endpoint writes more than usage");

  /* Comments stripped before the grep -- this assertion caught its own
     explanatory comment on the first run, the same way the wording
     guard caught its own documentation. A filter that can be tripped
     by prose about the rule is measuring the prose. */
  const stripJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const panel = stripJs(source("src/aiText.jsx"));
  const summarise = panel.slice(panel.indexOf("export function SummariseReading"));
  assert.doesNotMatch(summarise, /localStorage/, "the reading panel touches localStorage");
  const app = source("src/PlannerApp.jsx");
  const handler = app.slice(app.indexOf("const summariseReading ="), app.indexOf("const summariseReading =") + 2000);
  assert.doesNotMatch(handler, /photo|image/i, "the reading save path mentions the photos");
});

test("a deleted reading leaves its summary note intact", () => {
  /* sourceReadingId is decorative. The note is the student's work and
     must not vanish with a row of metadata about which pages they were
     on -- so nothing may cascade a reading's deletion into pages. */
  const app = source("src/PlannerApp.jsx");
  const noCascade = !/sourceReadingId[\s\S]{0,400}(removeItem|deletedAt)\s*\(/.test(app);
  assert.ok(noCascade, "something deletes notes based on sourceReadingId");
  /* And the link is optional in the first place, so a note with no
     reading is an ordinary note rather than a broken one. */
  assert.match(app, /if \(sourceReadingId\) pageItem\.aiMeta/);
});

/* ---------- the wording rule ---------- */

test("the copy never suggests skipping the reading", () => {
  /* A HARD RULE, not a tone preference. What makes this defensible is
     that it is a private-study tool pointed at material the student
     already has; wording that offers to replace the material undermines
     exactly that, and it would sit in a store listing where a reviewer
     reads it.

     Blunt, deliberately -- so was "every returnable code has wording",
     and that found a real gap within the hour. */
  const banned = [
    /skip(ping)? the reading/i,
    /instead of reading/i,
    /(don't|do not|never) (have to|need to) read/i,
    /no need to read/i,
    /without (having to )?read/i,
    /replace[sd]? the reading/i,
    /save[sd]? you reading/i,
    /so you don't have to/i,
  ];
  /* Comments are stripped first, the same way test-legal.mjs strips
     them before counting device stores -- and for the same reason. The
     modules STATE the rule ("'Skip the reading' is not the product"),
     so a guard that counted comments would be reporting the rule as a
     violation of itself. It caught exactly that on its first run. */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const text =
    JSON.stringify(READING_COPY) + strip(source("src/aiTextCopy.js")) + strip(source("src/readingChunks.js"));
  for (const rx of banned) assert.doesNotMatch(text, rx, `substitution framing: ${rx}`);
});

test("the copy frames the summary as something to revise from", () => {
  /* The positive half. Absence of the banned phrases is not the same as
     saying the right thing. */
  assert.match(READING_COPY.intro, /revis|study|check yourself/i);
  assert.match(READING_COPY.intro, /you'?ve read|working through/i);
});

test("the copy says the reading itself is not kept", () => {
  assert.match(READING_COPY.privacy, /(isn'?t|not) stored/i);
  assert.match(READING_COPY.privacy, /only the summary/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
