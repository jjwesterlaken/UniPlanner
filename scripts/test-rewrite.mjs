/* ==================================================================
   test-rewrite.mjs — the example rewrite's limits, and the instrument
   that sets them

   The endpoint half (refused free, billed on scope, the model never sees
   the rest of the essay) is in test-ai-text-function.mjs. This file is
   the pure module and the harness: the numbers it keeps carry no text,
   the settings evaluate the way the endpoint would refuse, and the exit
   code follows the 2% rule.
   ================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkRewriteSpan,
  finishRewrite,
  rewriteUserMessage,
  REWRITE_SYSTEM_PROMPT,
  rewriteSchema,
} from "../supabase/functions/_shared/essayRewrite.js";
import { evaluateRewrites, refusedAt, MAX_REFUSAL } from "./lib/rewrite-summary.mjs";
import { recordFor, PROPOSED } from "./measure-rewrite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}\n        ${e.message}`);
  }
}

const ESSAY =
  "Computers help people in many ways every single day. They let families talk every week across oceans and time zones. " +
  "They help students learn at their own pace with patient explanations.\n\nLibraries now lend laptops to anyone who asks. " +
  "Teachers set homework that only works online. Parents check school notices on their phones every evening.";
const LIMITS = { maxSpanWords: 120, maxSpanShare: 0.25, escapeRun: 6, exceedsRatio: 1.5 };

test("A PASSAGE MUST BE IN THE ESSAY, ONE PARAGRAPH, AND SMALL", () => {
  assert.equal(checkRewriteSpan({ essay: ESSAY, span: "They help students learn at their own pace with patient explanations.", limits: LIMITS }).ok, true);
  assert.equal(checkRewriteSpan({ essay: ESSAY, span: "Nothing like this is in it.", limits: LIMITS }).code, "bad_request");
  assert.equal(
    checkRewriteSpan({ essay: ESSAY, span: "patient explanations.\n\nLibraries now lend laptops", limits: LIMITS }).code,
    "span_too_long",
    "a passage crossing a paragraph break was allowed"
  );
  assert.equal(checkRewriteSpan({ essay: ESSAY, span: "Computers help people in many ways every single day.", limits: { ...LIMITS, maxSpanWords: 5 } }).code, "span_too_long");
  assert.equal(checkRewriteSpan({ essay: ESSAY, span: "Computers help people in many ways every single day.", limits: { ...LIMITS, maxSpanShare: 0.1 } }).code, "span_too_long");
});

test("THE REPLY IS CHECKED FOR SCOPE before anyone sees it", () => {
  const span = "They help students learn at their own pace with patient explanations.";
  assert.deepEqual(finishRewrite({ raw: JSON.stringify({ rewrite: "Students can learn at their own pace, with patient explanations." }), essay: ESSAY, span, limits: LIMITS }), {
    rewrite: "Students can learn at their own pace, with patient explanations.",
  });
  let err = null;
  try {
    finishRewrite({ raw: JSON.stringify({ rewrite: "In 2019, 73% of students learned faster." }), essay: ESSAY, span, limits: LIMITS });
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.essayRefusal === "scope" && err.violations.includes("fabricated-fact"));
  assert.throws(() => finishRewrite({ raw: "not json", essay: ESSAY, span, limits: LIMITS }), /not JSON/);
});

test("THE PROMPT FORBIDS NEW FACTS AND ANYTHING PAST THE PASSAGE, and the message can carry nothing else", () => {
  assert.match(REWRITE_SYSTEM_PROMPT, /ONLY the passage/);
  assert.match(REWRITE_SYSTEM_PROMPT, /Do NOT add any new argument, fact, figure, date, example, name, quotation or reference/);
  const msg = rewriteUserMessage({ span: "THE SPAN", note: "n".repeat(900), deficiency: "repetition", criteria: "SECRET CRITERIA", essay: "SECRET ESSAY" });
  assert.ok(msg.includes("THE SPAN"));
  assert.ok(!msg.includes("SECRET"), "the message builder carried the criteria or the essay");
  assert.ok(msg.length < 1500, "the note is not capped");
  assert.equal(rewriteSchema().strict, true);
});

test("A KEPT RECORD CARRIES NUMBERS, NEVER TEXT", () => {
  const r = recordFor({ essay: ESSAY, span: "They help students learn at their own pace with patient explanations.", rewrite: "SENTINELWORD students learn at their own pace.", spanOk: true, truncated: false, completion: 412 });
  const s = JSON.stringify(r);
  assert.ok(!/SENTINELWORD|students|patient/i.test(s), `text reached the record: ${s}`);
  assert.equal(r.completion, 412);
  assert.equal(typeof r.ratio, "number");
});

test("EVALUATION: free span refusals and cut-off replies are counted apart; fabrication always refuses", () => {
  const recs = [
    { spanOk: false },
    { spanOk: true, truncated: true },
    { spanOk: true, truncated: false, fabricated: true, escapeFires: [], ratio: 1 },
    { spanOk: true, truncated: false, fabricated: false, escapeFires: [3, 4, 5, 6], ratio: 1 },
    { spanOk: true, truncated: false, fabricated: false, escapeFires: [], ratio: 1.6 },
    { spanOk: true, truncated: false, fabricated: false, escapeFires: [], ratio: 1 },
  ];
  const e = evaluateRewrites(recs, { escapeRun: 6, exceedsRatio: 1.5 });
  assert.equal(e.spanRefused, 1);
  assert.equal(e.truncated, 1);
  assert.equal(e.judged, 4);
  assert.equal(e.refused, 3);
  assert.equal(evaluateRewrites(recs, { escapeRun: 7, exceedsRatio: 2 }).refused, 1, "only the fabrication survives looser settings");
  assert.equal(refusedAt({ spanOk: false }, { escapeRun: 6, exceedsRatio: 1.5 }), false);
});

test("THE GATE IS 2%: one more refusal breaks it", () => {
  const clean = { spanOk: true, truncated: false, fabricated: false, escapeFires: [], ratio: 1 };
  const bad = { ...clean, fabricated: true };
  assert.equal(evaluateRewrites([...Array(49).fill(clean), bad], PROPOSED).meetsRule, true);
  assert.equal(evaluateRewrites([...Array(48).fill(clean), bad, bad], PROPOSED).meetsRule, false);
  assert.equal(MAX_REFUSAL, 0.02);
});

test("THE HARNESS MEASURES WHAT SHIPS: the shipped prompts, schemas, ceilings and thresholds", () => {
  const src = strip(read("scripts/measure-rewrite.mjs"));
  for (const needle of ['productionCeiling("rewrite")', 'productionCeiling("essay")', "productionThresholds()", "ESSAY_SYSTEM_PROMPT", "REWRITE_SYSTEM_PROMPT", "finishEssayReply", "rewriteSchema()", "essayFeedbackSchema()"]) {
    assert.ok(src.includes(needle), `the harness no longer uses ${needle}`);
  }
  assert.doesNotMatch(src, /maxTokens:\s*\d/, "a literal ceiling");
  const cfg = read("supabase/functions/ai-text/config.ts");
  const proposed = /\{ maxSpanWords: (\d+), maxSpanShare: ([\d.]+), escapeRun: (\d+), exceedsRatio: ([\d.]+) \}/.exec(cfg);
  assert.ok(proposed, "config.ts no longer names the proposed values");
  assert.deepEqual(
    { maxSpanWords: +proposed[1], maxSpanShare: +proposed[2], escapeRun: +proposed[3], exceedsRatio: +proposed[4] },
    { maxSpanWords: PROPOSED.maxSpanWords, maxSpanShare: PROPOSED.maxSpanShare, escapeRun: PROPOSED.escapeRun, exceedsRatio: PROPOSED.exceedsRatio },
    "the harness measures different values from the ones config.ts proposes"
  );
});

test("--summarise reads a kept file with no calls, and the exit code follows the rule both ways", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewrites-"));
  try {
    const clean = { spanOk: true, truncated: false, fabricated: false, escapeFires: [], ratio: 1, completion: 300 };
    const f = (name, records) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify({ ceiling: 1500, records }));
      return p;
    };
    const run = (p) => spawnSync(process.execPath, [path.join(rootDir, "scripts/measure-rewrite.mjs"), "--summarise", p], { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" } });
    const good = run(f("good.json", Array(50).fill(clean)));
    const bad = run(f("bad.json", [...Array(40).fill(clean), ...Array(10).fill({ ...clean, fabricated: true })]));
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /RULE: at most 2% refused — MET/);
    assert.equal(bad.status, 1, "a failing run exited 0");
    assert.match(bad.stdout, /NOT MET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--keep REFUSES A PATH INSIDE THE REPOSITORY", () => {
  const r = spawnSync(process.execPath, [path.join(rootDir, "scripts/measure-rewrite.mjs"), "--dir", "/nowhere", "--keep", path.join(rootDir, "x.json")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside the repository/);
});

test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-rewrite\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed || passed === 0) process.exit(1);
