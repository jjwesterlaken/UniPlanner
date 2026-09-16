/* ==================================================================
   measure-no-writing.mjs — SIZE the no-writing threshold, do not
   assume it

   ESSAY-FEEDBACK.md §3 proposes refusing any run of >= 12 consecutive
   words that is neither in the essay nor in the criteria, and says in
   the same breath that 12 is "a starting point, not a measurement,
   and it must be measured before it ships — the distribution lesson
   from the ink work: a threshold sized to an anecdote is sized to the
   wrong thing."

   So this script does not test whether 12 works. It PRINTS THE
   DISTRIBUTION and leaves the number to a person, because the two
   populations it has to separate are:

     runs produced by LOCATING a problem   — quote the student, add a
                                             few words of your own
     runs produced by WRITING one          — a sentence that is
                                             nowhere in the input

   and a threshold is defensible only where those two separate. If
   they overlap, the answer is not a different number, it is that this
   layer does not work and §3 needs rethinking — which is a finding
   worth having BEFORE the endpoint is built rather than after.

   ------------------------------------------------------------------
   SCOPE — Jared's ruling, 16 September 2026

   Essay feedback is TEXT-ONLY and PASTE-ONLY, for 1.2 and the
   foreseeable future. No photographs, no screenshots, no file upload,
   and no artistic, design or performance work — those are a different
   feature with a different risk and are not on the roadmap.

   That is why this harness takes two TEXT files and has no image path
   at all. It matters beyond convenience: the no-writing constraint
   below is a comparison against the words the student submitted, and
   there are no words to compare against in a photograph of a painting
   or a video of a recital. A feature that took those would need a
   different constraint, not a wider input.

   ESSAY-FEEDBACK.md §2 carries the ruling and the reasoning behind
   the half that matters: the no-photographs half is not the same
   decision as the no-upload half, because the no-writing guarantee is
   not weakened for non-text material, it is ABSENT.

   ------------------------------------------------------------------
   USAGE — on your own machine, with your own key

     export OPENAI_API_KEY=sk-...
     node scripts/measure-no-writing.mjs --essay essay.txt --rubric rubric.txt

   Nothing is stored and nothing is uploaded anywhere but the provider:
   this calls the API directly and prints to your terminal. It does not
   go through our Edge Function, so it involves no consent version, no
   deploy and no student.

   Options:
     --essay <file>     required: a real essay, the longer the better
     --rubric <file>    required: the criteria it was marked against
     --model <id>       default is the shipped SUMMARY_MODEL
     --runs <n>         default 3. MORE THAN ONE ON PURPOSE — see below
     --redact           print NUMBERS ONLY. No model output, no quoted
                        spans, no novel-run text, and none of it in the
                        --json file either. Required for any corpus
                        whose licence forbids redistributing the text —
                        the ASAP essays are one, which is why the
                        sampler always passes it.
     --dry-run          resolve the prompt and the inputs, print sizes,
                        make no call and spend nothing
     --json <file>      also write the raw measurements, for a second
                        look without paying again

   ------------------------------------------------------------------
   WHY IT RUNS MORE THAN ONCE BY DEFAULT

   The same lesson as the bitrate harness: one sample cannot tell you
   whether it is representative. Four separate recordings agreeing to
   within 1.0% is what made a three-second measurement say something
   about three hours; four samples spread across 40% would have said
   "it depends what you record", which is a different finding needing a
   different experiment. So the spread is printed, and if it is wide
   the honest conclusion is that a fixed threshold is not available.

   ------------------------------------------------------------------
   THE CONTROL, AND IT COSTS NOTHING

   Every measurement is ALSO computed against an unrelated source —
   the model's own output measured as if the student had submitted a
   different essay entirely. That is the top of the scale: it is what
   "definitely novel" looks like for these exact words. Without it a
   column of numbers has no upper reference and a small one cannot be
   told from a small SCALE.

   That is the row-4 rule from the bitrate work: include the
   configuration you do NOT ship, so the pair says which is which.

   ------------------------------------------------------------------
   WHAT IT CANNOT ANSWER

   Whether the feedback is any GOOD. Nothing here reads the output for
   quality, and ESSAY-FEEDBACK.md is explicit that "whether the model
   can grade against a rubric well enough to be worth 3 credits" needs
   a person reading the output beside a mark the essay actually got.
   This script prints the output in full so that can happen in the same
   sitting, and says so rather than implying the numbers settle it.
   ================================================================== */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, callVision } from "./lib/photo-calls.mjs";
import { resolveEssayMessages } from "./lib/essay-prompt.mjs";
import { normaliseWords, novelRuns, longestNovelRun, quotedSpans } from "../src/noWriting.js";

/* ---------- arguments ---------- */

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

const dryRun = has("--dry-run");
/* WITHOUT THIS THE SCRIPT PRINTS ESSAY TEXT, and that is not a
   hypothetical: the per-field section prints every quoted span, and a
   span the model quoted VERBATIM is the student's own words. Any
   corpus under a no-redistribution licence needs this on. */
const redact = has("--redact");
const essayFile = opt("--essay");
const rubricFile = opt("--rubric");
const jsonOut = opt("--json");
const runCount = Math.max(1, Number(opt("--runs") || 3));

const apiKey = process.env.OPENAI_API_KEY;

if (!essayFile || !rubricFile) {
  console.error(
    "usage: OPENAI_API_KEY=sk-... node scripts/measure-no-writing.mjs --essay essay.txt --rubric rubric.txt\n\n" +
      "Both are required. A real essay and the real criteria it was marked against —\n" +
      "a synthetic pair measures the example somebody invented, which is the anecdote\n" +
      "this script exists to replace."
  );
  process.exit(1);
}
for (const f of [essayFile, rubricFile]) {
  if (!fs.existsSync(f)) {
    console.error(`no such file: ${f}`);
    process.exit(1);
  }
}
if (!dryRun && !apiKey) {
  console.error("OPENAI_API_KEY is not set. Use --dry-run to check the inputs without calling anything.");
  process.exit(1);
}

const essay = fs.readFileSync(essayFile, "utf8");
const criteria = fs.readFileSync(rubricFile, "utf8");

/* ---------- the prompt: from prompts.js if it is there yet ----------

   The essay task is not in supabase/functions/ai-text/prompts.js at
   the time of writing, because putting it there is step 4 and it
   cannot ship before consent v8. So this carries a CANDIDATE — and it
   FOLLOWS rather than pins: the moment prompts.js grows an `essay`
   entry this reads that instead, and says which it used on every run.
   A "before" prompt pasted into a measurement script is a restatement
   that goes on describing a prompt somebody has since edited. */

const CANDIDATE_PROMPT = `You are helping a university student improve their own draft essay.

You will be given the student's essay and the marking criteria it will be assessed against.

For each criterion, say where the essay currently stands and what specifically would strengthen it.

RULES, and the first is absolute:

1. NEVER WRITE ANY PART OF THE ESSAY. Do not supply sentences, phrases
   or wording for the student to use. You may quote the student's own
   words back to them to point at something; you may not produce new
   prose that could be pasted into the essay.
2. To point at a problem, QUOTE THE STUDENT'S OWN TEXT verbatim and
   then describe what is wrong with it in your own words as ANALYSIS,
   not as a replacement.
3. Describe what is missing or weak; do not demonstrate the fix.
4. Use the criteria's own language. Do not invent a mark, a grade, a
   percentage or a scale of your own.
5. Do not predict what mark this will receive.

Reply as JSON: { "criteria": [ { "name": string, "standing": string, "suggestions": [string] } ] }`;

/* The resolution lives in scripts/lib/essay-prompt.mjs so it can be
   DRIVEN by a test with a fake prompts module. It used to be inline
   here, and the only available check was a grep for the call — which
   passes on a script that makes the call and ignores the result.
   Mutating the probe to null left that grep green. */
const { build: buildRequestMessages, source: promptSource } = resolveEssayMessages({
  prompts: await import(pathToFileURL(path.join(ROOT, "supabase/functions/ai-text/prompts.js")).href).catch(() => null),
  essay,
  criteria,
  candidate: ({ essay, criteria }) => [
    { role: "system", content: CANDIDATE_PROMPT },
    { role: "user", content: `MARKING CRITERIA:\n${criteria}\n\nTHE STUDENT'S ESSAY:\n${essay}` },
  ],
});

let model = opt("--model");
if (!model) {
  const m = fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/model.ts"), "utf8");
  model = (m.match(/SUMMARY_MODEL\s*=\s*"([^"]+)"/) || [])[1] || "gpt-4o-mini";
}

/* ---------- the control source ----------

   Deliberately about something else entirely, and deliberately in the
   same register, so it shares ordinary English function words with any
   essay and therefore UNDERSTATES the control rather than flattering
   it. */
const CONTROL_SOURCE = `The migratory patterns of the Arctic tern are among the longest of any bird.
Ringing studies begun in the 1920s established that individuals breeding in Greenland winter
in the Weddell Sea, a round trip which may exceed seventy thousand kilometres. Ornithologists
continue to debate how the birds navigate across open ocean without landmarks.`;

const MATCH_UNITS = [3, 4, 5, 6];

console.log("=".repeat(72));
console.log("NO-WRITING THRESHOLD — sizing run");
console.log("=".repeat(72));
console.log(`essay        ${essayFile} (${normaliseWords(essay).length} words)`);
console.log(`criteria     ${rubricFile} (${normaliseWords(criteria).length} words)`);
console.log(`model        ${model}`);
console.log(`prompt       ${promptSource}`);
console.log(`runs         ${runCount}`);
console.log(`prompt bytes ${Buffer.byteLength(JSON.stringify(buildRequestMessages()))}`);

if (dryRun) {
  console.log("\n--dry-run: nothing was called and nothing was spent.");
  process.exit(0);
}

/* ---------- the calls ---------- */

const measurements = [];

for (let run = 1; run <= runCount; run++) {
  process.stderr.write(`run ${run}/${runCount}…\n`);
  const { json, error } = await callVision({
    apiKey,
    model,
    messages: buildRequestMessages(),
    maxTokens: 2000,
  });
  if (error) {
    console.error(`run ${run} failed: ${error}`);
    /* `json` IS UNDEFINED WHEN THE BODY WAS NOT JSON AT ALL — a 502
       HTML page, a proxy's "host not in allowlist", a rate-limit page.
       Stringifying it unguarded threw a TypeError that took the whole
       PROCESS down, so one transient failure lost every remaining
       essay in a thirty-essay run instead of one. Found by running the
       sampler end to end against a fake rather than by reading it. */
    if (json !== undefined) console.error(JSON.stringify(json, null, 2).slice(0, 800));
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(json.choices[0].message.content);
  } catch (e) {
    /* Redacted: the raw body is model output ABOUT the essay and can
       quote it. The shape is what a person needs here, not the words. */
    const raw = json && json.choices && json.choices[0] && json.choices[0].message
      ? String(json.choices[0].message.content || "")
      : "";
    console.error(`run ${run}: the model returned output that is not JSON (${raw.length} chars)`);
    if (!redact) console.error(raw.slice(0, 1200));
    continue;
  }

  /* Every piece of prose the model produced, flattened. A field is the
     unit a threshold would be applied to. */
  const fields = [];
  for (const c of parsed.criteria || []) {
    if (c.standing) fields.push({ label: `${c.name}/standing`, text: String(c.standing) });
    for (const [i, s] of (c.suggestions || []).entries()) {
      fields.push({ label: `${c.name}/suggestion[${i}]`, text: String(s) });
    }
  }

  for (const f of fields) {
    const row = { run, label: f.label, text: f.text, words: normaliseWords(f.text).length, real: {}, control: {} };
    for (const k of MATCH_UNITS) {
      row.real[k] = longestNovelRun(f.text, `${essay}\n${criteria}`, { matchUnit: k });
      row.control[k] = longestNovelRun(f.text, CONTROL_SOURCE, { matchUnit: k });
    }
    row.quotes = quotedSpans(f.text).map((q) => {
      const qw = normaliseWords(q);
      const src = normaliseWords(`${essay}\n${criteria}`).join(" ");
      return { words: qw.length, verbatim: src.includes(qw.join(" ")), text: q };
    });
    measurements.push(row);
  }
  if (redact) {
    console.log(`\n--- run ${run}: ${fields.length} fields measured (output withheld: --redact) ---`);
  } else {
    console.log(`\n--- run ${run} output, in full (read this for QUALITY; the numbers do not) ---`);
    console.log(JSON.stringify(parsed, null, 2));
  }
}

if (measurements.length === 0) {
  console.error("\nno measurements were taken — every run failed.");
  process.exit(1);
}

/* ---------- the distribution ---------- */

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

console.log(`\n${"=".repeat(72)}`);
console.log("LONGEST NOVEL RUN PER FIELD — the number a threshold is compared against");
console.log("=".repeat(72));
console.log("\nAGAINST THE REAL ESSAY (what the app would see):\n");
console.log("  matchUnit   n    min   p50   p90   max");
for (const k of MATCH_UNITS) {
  const xs = measurements.map((m) => m.real[k]);
  console.log(
    `  ${String(k).padEnd(11)} ${String(xs.length).padEnd(4)} ${String(Math.min(...xs)).padEnd(5)} ` +
      `${String(pct(xs, 50)).padEnd(5)} ${String(pct(xs, 90)).padEnd(5)} ${Math.max(...xs)}`
  );
}
console.log("\nAGAINST AN UNRELATED SOURCE (the control — what 'definitely novel' looks like):\n");
console.log("  matchUnit   n    min   p50   p90   max");
for (const k of MATCH_UNITS) {
  const xs = measurements.map((m) => m.control[k]);
  console.log(
    `  ${String(k).padEnd(11)} ${String(xs.length).padEnd(4)} ${String(Math.min(...xs)).padEnd(5)} ` +
      `${String(pct(xs, 50)).padEnd(5)} ${String(pct(xs, 90)).padEnd(5)} ${Math.max(...xs)}`
  );
}

console.log(`\n${"=".repeat(72)}`);
console.log("EVERY FIELD, LONGEST FIRST — this is what a person reads");
console.log("=".repeat(72));
const K = MATCH_UNITS[2];
for (const m of [...measurements].sort((a, b) => b.real[K] - a.real[K])) {
  console.log(`\n  run ${m.run}  ${m.label}`);
  console.log(`    ${m.words} words | novel run vs essay: ${m.real[K]} | vs control: ${m.control[K]}  (matchUnit ${K})`);
  for (const q of m.quotes) {
    const tail = redact ? "" : `: ${q.text.slice(0, 80)}`;
    console.log(`    quote ${q.words}w ${q.verbatim ? "VERBATIM" : "*** NOT IN THE ESSAY ***"}${tail}`);
  }
  for (const r of novelRuns(m.text, `${essay}\n${criteria}`, { matchUnit: K })) {
    if (r.length >= 6) {
      const tail = redact ? "" : `: ${r.text.slice(0, 110)}`;
      console.log(`    novel ${String(r.length).padStart(3)}w${tail}`);
    }
  }
}

/* ---------- the spread, which decides whether a threshold exists ---------- */

if (runCount > 1) {
  const byRun = new Map();
  for (const m of measurements) {
    if (!byRun.has(m.run)) byRun.set(m.run, []);
    byRun.get(m.run).push(m.real[K]);
  }
  console.log(`\n${"=".repeat(72)}`);
  console.log(`RUN-TO-RUN SPREAD (matchUnit ${K}) — one sample cannot say whether it is representative`);
  console.log("=".repeat(72));
  const maxes = [];
  for (const [run, xs] of byRun) {
    const mx = Math.max(...xs);
    maxes.push(mx);
    console.log(`  run ${run}: ${xs.length} fields, longest novel run ${mx}`);
  }
  const lo = Math.min(...maxes);
  const hi = Math.max(...maxes);
  const spread = lo === 0 ? 0 : ((hi - lo) / lo) * 100;
  console.log(`\n  across runs: ${lo} to ${hi}  (${spread.toFixed(0)}% spread)`);
  console.log(
    spread > 40
      ? "  WIDE. A fixed threshold is NOT available from this data — that is a finding,\n" +
          "  not a reason to average. It means the run-to-run variation is the same size as\n" +
          "  the thing being measured, and §3 needs rethinking rather than a number."
      : "  Tight enough that a threshold sized here means something for other essays."
  );
}

console.log(`\n${"=".repeat(72)}`);
console.log("HOW TO READ THIS");
console.log("=".repeat(72));
console.log(`
  A threshold is defensible only where the two populations SEPARATE.
  Look for the gap between the longest novel runs produced by fields
  that quote the essay and those that do not — the per-field list above
  is sorted to put the worst first, so read from the top and find where
  "pointing at a problem" stops and "writing a sentence" starts.

  The control column is the top of the scale for these exact words. A
  real number close to the control means the field is novel prose; a
  real number far below it means the field is largely the student's own
  text.

  IF THERE IS NO GAP, the answer is not a different number. It is that
  this layer does not separate the two cases on real output, and
  ESSAY-FEEDBACK.md §3 needs rethinking before anything is built on it.

  Nothing here says whether the feedback is any GOOD. Read the full
  output above beside a mark the essay actually got — that is the
  question §"What this document cannot answer" names, and no number
  settles it.
`);

if (jsonOut) {
  /* THE JSON IS REDACTED TOO. A file is the likeliest thing to get
     attached to a message, so a --redact that cleaned only the
     terminal would be the leak wearing a different hat. */
  const forFile = redact
    ? measurements.map(({ text, quotes, ...rest }) => ({
        ...rest,
        quotes: quotes.map(({ text: _t, ...q }) => q),
      }))
    : measurements;
  fs.writeFileSync(jsonOut, JSON.stringify({ model, promptSource, redacted: redact, matchUnits: MATCH_UNITS, measurements: forFile }, null, 2));
  console.log(`  raw measurements written to ${jsonOut}\n`);
}
