/* ==================================================================
   measure-photo-prompt.mjs — did tightening the vision prompt help?

   THE PAIR IS THE POINT. One run of a changed prompt tells you what
   that prompt produced and nothing about whether it is better; the
   defects being counted here are ones a model varies on run to run. So
   this makes the SAME model read the SAME photographs twice — once
   under the prompt in the working tree, once under the prompt at a git
   ref — and prints the two side by side. Everything except the prompt
   is held: same bytes, same detail, same output ceiling, same model.

   THE BASELINE IS EXTRACTED FROM GIT, never retyped. A "before" prompt
   pasted into a script is a restatement, and it would go on describing
   the old prompt after somebody edited it. Default ref is the merge
   base with origin/main, which on a branch is the prompt as it was
   before this work; pass --baseline <ref> for anything else.

   IT REFUSES IF THE TWO PROMPTS ARE THE SAME. A comparison between two
   identical things discriminates nothing and reports success either
   way — the vacuous-pass shape, which is why the check is first.

   ------------------------------------------------------------------
   USAGE

     npm i --no-save sharp
     export OPENAI_API_KEY=sk-...
     node scripts/measure-photo-prompt.mjs page1.jpg page2.jpg page3.jpg page4.jpg

   The SAME photographs the gate ran on, or the comparison is with a
   different reading rather than with a different prompt. Two calls to
   the shipped model plus one to the documented fallback; well under a
   cent.

   Options:
     --baseline <ref>   git ref holding the "before" prompt
     --no-fallback      skip the gpt-5.4-mini reference call
     --dry-run          resolve both prompts, print their sizes, make no
                        call and spend nothing

   ------------------------------------------------------------------
   WHAT IT CAN AND CANNOT SEE

   Two of the three defects this prompt change targets are mechanical
   and are COUNTED:

     - a parenthesised letter inside a word ("Data crunc(h)ers") — the
       page's line-break hyphenation, and a model's uncertainty marker,
       reaching the note
     - the same term twice in `terms`

   The third is NOT, and no string can see it: "Hopper was the first
   group to be granted a PhD" fuses two true claims about two subjects
   into one false sentence, and every word in it is ordinary. It is
   printed for a person to judge, and that is stated rather than
   implied — a guard that names its hole is worth more than one that
   looks thorough.

   AND THE CONTROL ON THE FIX ITSELF: entry and word counts per
   section, both sides. Noise falling because the model said LESS is
   not an improvement, it is the depth regression ai-notes measured its
   way out of — so the numbers that would show it are on the page next
   to the ones that would flatter the change.
   ================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, appDownscale, loadSharp, preparePhoto, callVision } from "./lib/photo-calls.mjs";

/* ---------- arguments ---------- */

const argv = process.argv.slice(2);
let baselineRef = null;
let withFallback = true;
/* --dry-run resolves both prompts and stops. It is what makes the
   refusal below TESTABLE without a key, a photograph or a network —
   the pair of outcomes is run by scripts/test-ai-text-function.mjs
   rather than read out of this file. It is also the cheap way for a
   person to see what changed before spending anything. */
let dryRun = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--baseline") baselineRef = argv[++i];
  else if (argv[i] === "--no-fallback") withFallback = false;
  else if (argv[i] === "--dry-run") dryRun = true;
  else files.push(argv[i]);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!dryRun && (!apiKey || files.length === 0)) {
  console.error(
    "usage: OPENAI_API_KEY=sk-... node scripts/measure-photo-prompt.mjs <page1.jpg> [page2.jpg ...]\n\n" +
      "Use the same photographs the gate ran on, or this compares two readings\n" +
      "rather than two prompts."
  );
  process.exit(1);
}
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`no such file: ${f}`);
    process.exit(1);
  }
}
if (!dryRun && files.length === 0) process.exit(1);

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

if (!baselineRef) {
  try {
    baselineRef = git("merge-base", "HEAD", "origin/main");
  } catch {
    console.error(
      "could not work out a baseline: no merge base with origin/main.\n" +
        "Pass one explicitly:  --baseline <ref>"
    );
    process.exit(1);
  }
}

/* ---------- the two prompts: one from the tree, one from git ---------- */

const REL = "supabase/functions/ai-text/prompts.js";

const current = await import(pathToFileURL(path.join(ROOT, REL)).href);

let baselineSrc;
try {
  baselineSrc = git("show", `${baselineRef}:${REL}`);
} catch {
  console.error(`could not read ${REL} at ${baselineRef}`);
  process.exit(1);
}
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "photo-prompt-")), "prompts.js");
fs.writeFileSync(tmp, baselineSrc);
const baseline = await import(pathToFileURL(tmp).href);

const oneImage = { images: ["data:image/jpeg;base64,AA"] };
const promptOf = (mod) => mod.buildMessages("summarise", oneImage)[0].content;
const beforeText = promptOf(baseline);
const afterText = promptOf(current);

/* THE FIRST CHECK, because everything after it is meaningless without
   it: two identical prompts produce two samples of one configuration,
   and any difference printed below would be run-to-run variation
   reported as an improvement. */
if (beforeText === afterText) {
  console.error(
    `\nREFUSING TO RUN: the prompt at ${baselineRef.slice(0, 12)} is byte-identical to the one in\n` +
      "the working tree, so this would compare a configuration with itself and\n" +
      "report whatever the model happened to do twice.\n\n" +
      "Pass --baseline <ref> naming a commit from before the prompt changed."
  );
  process.exit(1);
}

if (dryRun) {
  console.log(`\nbaseline ${baselineRef.slice(0, 12)}: ${beforeText.length} chars`);
  console.log(`working tree:         ${afterText.length} chars  (${afterText.length > beforeText.length ? "+" : ""}${afterText.length - beforeText.length})`);
  console.log("the two prompts differ, so a run would compare two configurations.");
  console.log("dry run — nothing was called and nothing was spent.");
  process.exit(0);
}

/* ---------- the model and ceiling the app would use ---------- */

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const constOf = (src, name) => {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`not found: ${name}`);
  return Function(`"use strict";return (${m[1]})`)();
};
const model = read("supabase/functions/_shared/model.ts");
const VISION_MODEL = constOf(model, "VISION_MODEL");
const FALLBACK_MODEL = "gpt-5.4-mini"; // COST-MODEL 12.9's documented fallback
const cfgSrc = read("supabase/functions/ai-text/config.ts");
const MAX_TOKENS = Function(
  `"use strict";return (${cfgSrc.match(/export const MAX_TOKENS[^=]*=\s*(\{[\s\S]*?\});/)[1]})`
)().summarise;

/* ---------- the photos, prepared the way the app prepares them ---------- */

const downscale = appDownscale();
const sharp = await loadSharp();
const pages = [];
for (const f of files) pages.push(await preparePhoto(sharp, f, downscale));

console.log(`\nBEFORE: ${REL} at ${baselineRef.slice(0, 12)}  (${beforeText.length} chars)`);
console.log(`AFTER:  ${REL} in the working tree        (${afterText.length} chars)`);
console.log(`model:  ${VISION_MODEL}, ceiling ${MAX_TOKENS}, maxEdge ${downscale.maxEdge}, quality ${downscale.quality}`);
console.log(`\n${files.length} page${files.length === 1 ? "" : "s"}`);
if (!sharp) {
  console.log("  !! sharp is not installed, so the ORIGINALS were sent, not a downscale.");
  console.log("     The comparison below is still valid — both arms got the same bytes —");
  console.log("     but the token counts are not what the app would bill.");
  console.log("     npm i --no-save sharp");
} else {
  for (let i = 0; i < pages.length; i++) {
    console.log(`  page ${i + 1}: ${pages[i].w}x${pages[i].h}, ${Math.round(pages[i].dataUrl.length / 1024)} KB of base64`);
  }
}

/* ---------- the calls ---------- */

const arms = [
  { key: "before", label: `${VISION_MODEL}, BEFORE`, mod: baseline, model: VISION_MODEL },
  { key: "after", label: `${VISION_MODEL}, AFTER`, mod: current, model: VISION_MODEL },
];
if (withFallback) {
  arms.push({ key: "fallback", label: `${FALLBACK_MODEL}, AFTER (the documented fallback)`, mod: current, model: FALLBACK_MODEL });
}

for (const arm of arms) {
  const messages = arm.mod.buildMessages("summarise", { images: pages.map((p) => p.dataUrl) });
  process.stdout.write(`\ncalling ${arm.label} ... `);
  const started = Date.now();
  const { json, error } = await callVision({ apiKey, model: arm.model, messages, maxTokens: MAX_TOKENS });
  if (error) {
    console.log(`FAILED (${error})`);
    if (json) console.log(`  ${JSON.stringify(json).slice(0, 400)}`);
    arm.error = error;
    continue;
  }
  console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  arm.json = json;
  const content = json?.choices?.[0]?.message?.content || "";
  arm.finish = json?.choices?.[0]?.finish_reason;
  try {
    const raw = JSON.parse(content);
    if (Array.isArray(raw.unreadable)) {
      arm.refused = raw.unreadable;
      continue;
    }
    /* Shaped through the app's OWN parser, so what is counted below is
       the note a student would have been saved — not what the model
       said. The difference is not academic: a lone string where the
       schema says a list used to become an empty section, silently. */
    arm.note = arm.mod.parseTaskResult("summarise", content);
  } catch {
    arm.unparsed = content;
  }
}

/* ---------- the two mechanical defects ---------- */

/* A parenthesised letter or two INSIDE a word: "crunc(h)ers". Letters
   are required on BOTH sides deliberately — "student(s)" is an
   author's legitimate shorthand and ends the word, so it is not this.  */
const IN_WORD_BRACKET = /[A-Za-z]\([A-Za-z]{1,2}\)[A-Za-z]/g;
/* A hyphen left dangling at a line break: "crunch- ers", "data-". */
const DANGLING_HYPHEN = /[A-Za-z]-(?=\s|$)/g;

const textOf = (note) =>
  [
    note.overview,
    ...(note.keyPoints || []),
    ...(note.assessable || []),
    ...(note.openQuestions || []),
    ...(note.terms || []).flatMap((t) => [t.term, t.content]),
  ]
    .filter(Boolean)
    .join("\n");

function defectsOf(note) {
  const text = textOf(note);
  const brackets = text.match(IN_WORD_BRACKET) || [];
  const hyphens = text.match(DANGLING_HYPHEN) || [];
  const seen = new Map();
  const dupes = [];
  for (const t of note.terms || []) {
    const k = String(t.term || "").trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) dupes.push(t.term);
    else seen.set(k, true);
  }
  return { brackets, hyphens, dupes };
}

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
function sizeOf(note) {
  const sections = ["keyPoints", "assessable", "openQuestions"];
  const out = { overview: { n: 1, w: words(note.overview) } };
  for (const s of sections) out[s] = { n: (note[s] || []).length, w: (note[s] || []).reduce((a, x) => a + words(x), 0) };
  out.terms = {
    n: (note.terms || []).length,
    w: (note.terms || []).reduce((a, t) => a + words(t.term) + words(t.content), 0),
  };
  return out;
}

console.log("\n\n================ THE DEFECTS THE PROMPT CHANGE TARGETS ================\n");
console.log("  arm                        in-word brackets   dangling hyphens   duplicate terms");
for (const arm of arms) {
  if (!arm.note) {
    console.log(`  ${arm.label.padEnd(26)} ${(arm.error || (arm.refused ? "refused as illegible" : "no usable note"))}`);
    continue;
  }
  const d = defectsOf(arm.note);
  arm.defects = d;
  console.log(
    `  ${arm.label.padEnd(26)} ${String(d.brackets.length).padStart(16)}   ${String(d.hyphens.length).padStart(16)}   ${String(d.dupes.length).padStart(15)}`
  );
}
for (const arm of arms) {
  if (!arm.defects) continue;
  const { brackets, hyphens, dupes } = arm.defects;
  if (brackets.length || hyphens.length || dupes.length) {
    console.log(`\n  ${arm.label}:`);
    if (brackets.length) console.log(`    in-word brackets: ${brackets.join(", ")}`);
    if (hyphens.length) console.log(`    dangling hyphens: ${hyphens.join(", ")}`);
    if (dupes.length) console.log(`    duplicate terms:  ${dupes.join(", ")}`);
  }
}

const before = arms.find((a) => a.key === "before");
const after = arms.find((a) => a.key === "after");
if (before?.defects && after?.defects) {
  const total = (d) => d.brackets.length + d.hyphens.length + d.dupes.length;
  const b = total(before.defects);
  const a = total(after.defects);
  console.log(
    `\n  COUNTED DEFECTS: ${b} before, ${a} after.  ` +
      (a < b ? "The change removed some." : a === b ? "No change." : "The change added some.")
  );
  if (b === 0) {
    console.log(
      "  NOTE: the BEFORE arm produced none this run, so this comparison says nothing\n" +
        "  about the two prompts — these defects are intermittent. Re-run, or judge on\n" +
        "  the printed notes below."
    );
  }
}

/* ---------- the control on the fix: did it just say less? ---------- */

console.log("\n\n================ DID IT SIMPLY SAY LESS? ================\n");
console.log("  Cleaner output bought by dropping content is the depth regression, not a fix.");
console.log("  entries / words, per section\n");
const SECTIONS = ["overview", "keyPoints", "terms", "assessable", "openQuestions"];
console.log("  arm                        " + SECTIONS.map((s) => s.padEnd(16)).join(""));
for (const arm of arms) {
  if (!arm.note) continue;
  const z = sizeOf(arm.note);
  console.log("  " + arm.label.padEnd(26) + SECTIONS.map((s) => `${z[s].n} / ${z[s].w}`.padEnd(16)).join(""));
}

/* ---------- the judgement nothing here can make ---------- */

console.log("\n\n================ THE FUSED-CLAIM CHECK — YOU JUDGE ================\n");
console.log('  "Hopper was the first group to be granted a PhD" is two true claims about two');
console.log("  subjects welded into one false sentence, and no pattern can see it: every word");
console.log("  is ordinary and the grammar is fine. Read the key points against the pages and");
console.log("  look for a sentence whose subject does not carry its predicate.\n");
for (const arm of arms) {
  console.log(`\n---------------- ${arm.label} ----------------`);
  if (arm.error) {
    console.log(`  no result: ${arm.error}`);
    continue;
  }
  if (arm.refused) {
    console.log(`  REFUSED as illegible, pages: ${arm.refused.join(", ")}`);
    continue;
  }
  if (arm.unparsed) {
    console.log("  output did not parse as JSON — the app treats this as ai_failed_charged:");
    console.log(`  ${arm.unparsed.slice(0, 800)}`);
    continue;
  }
  if (arm.finish === "length") console.log("  !! hit the output ceiling — truncated, which the app treats as a hard failure");
  console.log(`\n  overview: ${arm.note.overview || "(none)"}\n`);
  for (const k of ["keyPoints", "assessable", "openQuestions"]) {
    const list = arm.note[k] || [];
    console.log(`  ${k} (${list.length}):`);
    for (const item of list) console.log(`    - ${item}`);
  }
  console.log(`  terms (${arm.note.terms.length}):`);
  for (const t of arm.note.terms) console.log(`    - ${t.term}: ${t.content}`);
  const u = arm.json?.usage || {};
  console.log(`\n  usage: ${u.prompt_tokens} in / ${u.completion_tokens} out`);
}

/* ---------- the price, which this run also re-measures ---------- */

const measured = constOf(model, "MEASURED_PHOTO_BATCH_INPUT_TOKENS");
console.log("\n\n================ AND THE PRICE ================\n");
console.log(`  _shared/model.ts records ${measured} input tokens for one batch, and`);
console.log("  PHOTO_BATCH_CREDITS is derived from it. A longer prompt is more input tokens,");
console.log("  so the AFTER arm's reported prompt_tokens above is the figure that constant");
console.log("  should hold — re-measured on the configuration that ships.");
if (after?.json?.usage?.prompt_tokens) {
  const now = after.json.usage.prompt_tokens;
  console.log(`\n  this run, AFTER: ${now} in  (recorded: ${measured}, ${now > measured ? "+" : ""}${now - measured})`);
  if (pages.length !== 4) {
    console.log(`  !! ${pages.length} pages, and the recorded figure is for four — not comparable.`);
  }
}
console.log("\n  Whether the WEIGHT moves is a separate question, and the band is wide:");
console.log("  scripts/test-ai-text-function.mjs asserts the derivation, so run `npm test`");
console.log("  after updating the constant and the weight will follow or the test will say so.\n");
