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

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const transcriptPath = args.find((a) => !a.startsWith("--"));
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
/*  The two prompts                                                   */
/* ------------------------------------------------------------------ */

/* BEFORE is pinned here deliberately, as the literal text that shipped.
   Reading it out of git would make the comparison move every time the
   prompt moves, which is the opposite of a baseline. AFTER is read from
   the live source, so this measures what is actually deployed rather
   than a copy that can drift. */
const BEFORE_BASE =
  `You turn lecture transcripts into structured study notes. Produce "original" in the transcript's spoken language (expected English).`;
const BEFORE_TAIL =
  ` Flag anything the lecturer signals is examinable (e.g. "this will be on the exam") under "assessable". List anything genuinely unclear or left unresolved under "openQuestions".`;

const beforePrompt = translateTo
  ? `${BEFORE_BASE} Also produce "translated": the same structure, fully translated into the language with ISO code "${translateTo}".${BEFORE_TAIL}`
  : `${BEFORE_BASE} Set "translated" to null.${BEFORE_TAIL}`;

/* The current prompt is built inside the adapter from `depthRules`, so
   it is reconstructed here from the same source file rather than
   restated. If the shape of that construction changes, this throws
   rather than silently measuring the wrong thing. */
function currentPrompt() {
  const src = fs.readFileSync(path.join(rootDir, "supabase/functions/ai-notes/openai.ts"), "utf8");
  const rulesBlock = src.match(/const depthRules = \[([\s\S]*?)\]\.join\(" "\);/);
  const baseLine = src.match(/const base = `([^`]*)`;/);
  if (!rulesBlock || !baseLine) {
    throw new Error("could not reconstruct the current prompt from openai.ts — its shape changed, so this script needs updating rather than trusting");
  }
  const rules = [...rulesBlock[1].matchAll(/`([\s\S]*?)`,\n/g)].map((m) => m[1]);
  if (rules.length < 4) throw new Error(`only found ${rules.length} depth rules — the parse is wrong`);
  const base = baseLine[1].replace("${depthRules}", rules.join(" "));
  return translateTo
    ? `${base} Also produce "translated": the same structure at the same depth, fully translated into the language with ISO code "${translateTo}".`
    : `${base} Set "translated" to null.`;
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
console.log(`translation: ${translateTo || "none"}\n`);

const before = describe(await run("before", beforePrompt));
const after = describe(await run("after", currentPrompt()));

if (before.truncated || after.truncated) {
  console.log("One of the runs hit the model's own 16,384-token ceiling. That is itself the finding:");
  console.log(JSON.stringify({ before, after }, null, 2));
  process.exit(1);
}

const rows = [
  ["output tokens", before.outputTokens, after.outputTokens],
  ["bytes (both languages)", before.bytes, after.bytes],
  ["overview words", before.overviewWords, after.overviewWords],
  ["key points", before.keyPoints, after.keyPoints],
  ["words per key point", before.wordsPerPoint, after.wordsPerPoint],
  ["terms", before.terms, after.terms],
  ["words per term", before.wordsPerTerm, after.wordsPerTerm],
  ["assessable", before.assessable, after.assessable],
  ["open questions", before.openQuestions, after.openQuestions],
];

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("", 24)}${pad("before", 12)}${pad("after", 12)}change`);
for (const [name, b, a] of rows) console.log(`${pad(name, 24)}${pad(b, 12)}${pad(a, 12)}${pct(a, b)}`);

console.log(`
WHAT TO DO WITH THIS

  TYPICAL_SUMMARY_OUTPUT_TOKENS in supabase/functions/ai-notes/config.ts
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
