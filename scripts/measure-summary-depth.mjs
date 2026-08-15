/* measure-summary-depth.mjs — what the depth change actually cost, and
   whether it actually deepened anything.

   WHY THIS IS A SCRIPT RATHER THAN A TEST. It makes two real, paid
   OpenAI calls. Nothing in `npm test` may do that, and nothing in CI
   can: a suite that spends money on every push is a suite people turn
   off. So this is an instrument, run by hand by someone holding a key,
   in the same shape as scripts/measure-ink.mjs — which exists for the
   same reason, that synthetic input cannot answer the question.

   WHAT IT IS FOR. TYPICAL_SUMMARY_OUTPUT_TOKENS in the Edge Function's
   config.ts is currently a MODELLED figure (~1.3x the pre-depth 2,800),
   and both the billing floor and the output ceiling are derived from
   it. A modelled input to a billing constant is a guess with an invoice
   attached. Run this against a real transcript and put the observed
   number in config.ts; the floor re-derives and its test re-runs.

   USAGE

     OPENAI_API_KEY=sk-... node scripts/measure-summary-depth.mjs \
       path/to/transcript.txt [--translate es]

   A transcript can come from the ai_notes_requests row of a real
   recording, within its retention window (7 days for a success, 30 for
   a failure) -- the `result` column holds it. Failing that, any real
   lecture transcript of a realistic length answers the same question;
   say which was used when reporting, because a 5-minute transcript and
   a 50-minute one give very different absolute numbers.

   WHAT IT REPORTS, and why each column is there:

     tokens      what the billing constants are derived from
     bytes       what the note costs against MAX_AI_NOTE_BYTES
     key points  the count, because "deeper" that is really "more
                 entries" is a different change from "more per entry"
     words/point the one that says whether depth landed where it was
                 aimed -- into the sections rather than beside them */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const refValues = new Set(["--before", "--after"].map((f) => args[args.indexOf(f) + 1]).filter(Boolean));
const transcriptPath = args.find((a) => !a.startsWith("--") && !refValues.has(a));
const translateIdx = args.indexOf("--translate");
const translateTo = translateIdx >= 0 ? args[translateIdx + 1] : null;

if (!transcriptPath) {
  console.error("usage: OPENAI_API_KEY=... node scripts/measure-summary-depth.mjs <transcript.txt> [--translate es]");
  process.exit(2);
}
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is not set. This script makes two real, paid calls — that is the point of it.");
  process.exit(2);
}
if (!fs.existsSync(transcriptPath)) {
  console.error(`no transcript at ${transcriptPath}`);
  process.exit(2);
}
const transcript = fs.readFileSync(transcriptPath, "utf8");

/* ------------------------------------------------------------------ */
/*  The two prompts — each from an explicit git ref                   */
/* ------------------------------------------------------------------ */

/* WHERE EACH SIDE COMES FROM, and why neither is "the working tree".
   This script prices a CHANGE, so it needs both sides of it, and which
   branch the operator happens to be standing on must not decide what
   gets measured. Reading the file out of a named ref makes the pair
   explicit and reproducible:

     before  the prompt that is shipped        (default origin/main)
     after   the prompt being proposed         (default the depth branch)

   The first version read `after` from the working tree, which broke the
   moment the depth change was reverted off main -- and would have
   silently measured main-against-main from a main checkout, reporting a
   0% change as though the prompt did nothing. */
/* `indexOf` returns -1 when a flag is absent, and -1 + 1 is 0 -- which
   is the transcript path, not a default. Read the flag explicitly. */
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BEFORE_REF = flag("--before", "origin/main");
const AFTER_REF = flag("--after", "origin/claude/summary-depth");
const PROMPT_SRC = "supabase/functions/ai-notes/openai.ts";

const readRef = (ref) => {
  try {
    return execFileSync("git", ["show", `${ref}:${PROMPT_SRC}`], { cwd: rootDir, encoding: "utf8" });
  } catch (e) {
    /* The message matters: a catch that reports every failure as "no
       such ref" hides the real one. This swallowed a missing import and
       reported it as a missing branch, which cost a debugging pass. */
    throw new Error(
      `cannot read ${PROMPT_SRC} from "${ref}": ${e.message.split("\n")[0]}\n` +
        `  If the ref is missing:  git fetch origin\n` +
        `  Or name refs directly:  --before <ref> --after <ref>`
    );
  }
};

/* Handles BOTH shapes the prompt has had, and throws when it recognises
   neither. THE GUARD IS KEPT DELIBERATELY: it has already earned its
   place by refusing to measure a prompt it could not reconstruct, which
   is better than confidently measuring the wrong text. What changed is
   that it now says which ref and which shapes it tried. */
function parsePrompt(source, ref, translateTo) {
  // Shape B: the depth prompt — rules array plus a base template.
  const rulesBlock = source.match(/const depthRules = \[([\s\S]*?)\]\.join\(" "\);/);
  const baseLine = source.match(/const base = `([^`]*)`;/);
  if (rulesBlock && baseLine) {
    const rules = [...rulesBlock[1].matchAll(/`([\s\S]*?)`,\n/g)].map((m) => m[1]);
    if (rules.length < 4) throw new Error(`${ref}: found the depth prompt but only ${rules.length} rules — the parse is wrong`);
    const base = baseLine[1].replace("${depthRules}", rules.join(" "));
    return {
      shape: `depth (${rules.length} rules)`,
      prompt: translateTo
        ? `${base} Also produce "translated": the same structure at the same depth, fully translated into the language with ISO code "${translateTo}".`
        : `${base} Set "translated" to null.`,
    };
  }

  // Shape A: the original — one ternary over two template literals.
  const plain = source.match(/const systemPrompt = translateTo\s*\?\s*`([\s\S]*?)`\s*:\s*`([\s\S]*?)`;/);
  if (plain) {
    return {
      shape: "plain",
      prompt: (translateTo ? plain[1].replace(/\$\{translateTo\}/g, translateTo) : plain[2]),
    };
  }

  throw new Error(
    `${ref}: could not reconstruct the prompt from ${PROMPT_SRC}.\n` +
      "  Recognised shapes: `const depthRules = [...]` + `const base = ...`, or `const systemPrompt = translateTo ? ... : ...`.\n" +
      "  Its shape changed again — update parsePrompt rather than trusting a guess."
  );
}

/* BOTH PROMPTS ARE RESOLVED BEFORE ANY PAID CALL.

   The first version parsed the "after" prompt only when it was about to
   use it, which is after the "before" call has already run and already
   been charged. A run that failed on the parse therefore cost real money
   and produced nothing. Same ordering rule as the allowance read
   preceding the provider call in ai-text: fail free, or do not fail. */
const before = parsePrompt(readRef(BEFORE_REF), BEFORE_REF, translateTo);
const after = parsePrompt(readRef(AFTER_REF), AFTER_REF, translateTo);

if (before.prompt === after.prompt) {
  console.error(
    `\nBoth refs give the SAME prompt (${BEFORE_REF} and ${AFTER_REF}).\n` +
      "There is no change to price. Name the two sides explicitly with --before/--after.\n"
  );
  process.exit(2);
}

/* ------------------------------------------------------------------ */

const SUMMARY_SCHEMA_OBJECT = {
  type: "object",
  properties: {
    overview: { type: "string" },
    keyPoints: { type: "array", items: { type: "string" } },
    terms: {
      type: "array",
      items: {
        type: "object",
        properties: { term: { type: "string" }, content: { type: "string" } },
        required: ["term", "content"],
        additionalProperties: false,
      },
    },
    assessable: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["overview", "keyPoints", "terms", "assessable", "openQuestions"],
  additionalProperties: false,
};

async function run(label, systemPrompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lecture_summary",
          strict: true,
          schema: {
            type: "object",
            properties: { original: SUMMARY_SCHEMA_OBJECT, translated: { anyOf: [SUMMARY_SCHEMA_OBJECT, { type: "null" }] } },
            required: ["original", "translated"],
            additionalProperties: false,
          },
        },
      },
      // Deliberately the model's own ceiling, not SUMMARY_MAX_TOKENS:
      // the question is what the prompt WANTS to produce. Capping it
      // here would measure the cap.
      max_tokens: 16384,
    }),
  });
  if (!res.ok) throw new Error(`${label}: OpenAI request failed (${res.status}) ${await res.text()}`);
  const json = await res.json();
  const choice = json.choices?.[0];
  const truncated = choice?.finish_reason === "length";
  const parsed = truncated ? null : JSON.parse(choice.message.content);
  return { label, usage: json.usage, parsed, truncated };
}

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

function describe(r) {
  if (r.truncated) return { label: r.label, truncated: true, outputTokens: r.usage.completion_tokens };
  const o = r.parsed.original;
  const points = o.keyPoints || [];
  const bytes = new TextEncoder().encode(JSON.stringify(r.parsed)).length;
  return {
    label: r.label,
    outputTokens: r.usage.completion_tokens,
    inputTokens: r.usage.prompt_tokens,
    bytes,
    overviewWords: words(o.overview),
    keyPoints: points.length,
    wordsPerPoint: points.length ? Math.round(points.reduce((a, p) => a + words(p), 0) / points.length) : 0,
    terms: (o.terms || []).length,
    wordsPerTerm: (o.terms || []).length
      ? Math.round((o.terms || []).reduce((a, t) => a + words(t.content), 0) / o.terms.length)
      : 0,
    assessable: (o.assessable || []).length,
    openQuestions: (o.openQuestions || []).length,
  };
}

const pct = (a, b) => (b ? `${a > b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : "—");

console.log(`\ntranscript: ${transcriptPath} (${transcript.length.toLocaleString()} chars)`);
console.log(`translation: ${translateTo || "none"}`);
console.log(`before:      ${BEFORE_REF}  [${before.shape}]  ${before.prompt.length} chars`);
console.log(`after:       ${AFTER_REF}  [${after.shape}]  ${after.prompt.length} chars\n`);

const beforeOut = describe(await run("before", before.prompt));
const afterOut = describe(await run("after", after.prompt));

if (beforeOut.truncated || afterOut.truncated) {
  console.log("One of the runs hit the model's own 16,384-token ceiling. That is itself the finding:");
  console.log(JSON.stringify({ before: beforeOut, after: afterOut }, null, 2));
  process.exit(1);
}

const rows = [
  ["output tokens", beforeOut.outputTokens, afterOut.outputTokens],
  /* Reported so no figure in the billing derivation has to be estimated.
     The first run of this script omitted it, and the input count had to
     be inferred from character count -- immaterial that time (input is a
     quarter the price of output), but "mostly complete" is not a
     property a billing derivation should have. */
  ["input tokens", beforeOut.inputTokens, afterOut.inputTokens],
  ["bytes (both languages)", beforeOut.bytes, afterOut.bytes],
  ["overview words", beforeOut.overviewWords, afterOut.overviewWords],
  ["key points", beforeOut.keyPoints, afterOut.keyPoints],
  ["words per key point", beforeOut.wordsPerPoint, afterOut.wordsPerPoint],
  ["terms", beforeOut.terms, afterOut.terms],
  ["words per term", beforeOut.wordsPerTerm, afterOut.wordsPerTerm],
  ["assessable", beforeOut.assessable, afterOut.assessable],
  ["open questions", beforeOut.openQuestions, afterOut.openQuestions],
];

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("", 24)}${pad("before", 12)}${pad("after", 12)}change`);
for (const [name, b, a] of rows) console.log(`${pad(name, 24)}${pad(b, 12)}${pad(a, 12)}${pct(a, b)}`);

console.log(`
WHAT TO DO WITH THIS

  TYPICAL_SUMMARY_OUTPUT_TOKENS and TYPICAL_SUMMARY_INPUT_TOKENS in
  supabase/functions/ai-notes/config.ts
  should become the observed "after" output tokens FOR A SHORT
  RECORDING -- that constant prices the billing floor, and the floor
  exists to cover short clips. Measuring a 50-minute lecture and putting
  that number in would set the floor far too high.

  If "words per key point" barely moved but "key points" jumped, depth
  went sideways into more entries rather than into the entries. That is
  not what was asked for, and the prompt needs another pass.

  Check the after-note's bytes against MAX_AI_NOTE_BYTES (20KB) in
  src/aiNotesLogic.js. Over it, a translated note starts losing its
  second language on every save.
`);
