/* ==================================================================
   read-asap.mjs — the essay, its human score and the feedback, on one
   page, for a person to read.

   THE ONE QUESTION NO NUMBER ANSWERS. `measure-two-arm.mjs` says
   whether the STRUCTURE separates description from ghostwriting;
   `sample-asap.mjs` says it over thirty essays. Neither says whether
   the feedback is any good, and neither was trying to.

   ESSAY-FEEDBACK.md recorded that as unanswerable for a fortnight,
   on the grounds that no marked exemplar could be found. That was
   wrong twice over and both corrections are Jared's:

     - ASAP carries a human rater score for EVERY essay
       (`domain1_score`), which this project has been reading since the
       sampler was written — to stratify its sample;
     - the competition rules forbid REDISTRIBUTING the text, not
       READING it. A person reading on their own machine breaks no
       rule. "The text cannot leave" and "nobody may look at it" are
       different sentences and only the first is true.

   ------------------------------------------------------------------
   THIS IS THE ONLY UNREDACTED OUTPUT IN THE PROJECT, AND IT IS FENCED

   Every other instrument here withholds essay text by default and is
   tested for it. This one writes it, because it cannot do its job
   otherwise — so the fence is on WHERE, not on whether:

     - it writes ONE file, and REFUSES any path inside the repository;
     - the default is `~/asap-read.md`, outside it by construction;
     - the pattern is in `.gitignore`, so even a path somewhere odd
       cannot be committed by accident;
     - it prints no essay text to the terminal, because a terminal is
       pasteable and a file on your own disk is not.

   DELETE THE FILE WHEN YOU HAVE READ IT. Nothing here will do that for
   you, because a script that deletes the thing it just asked somebody
   to read is a script that deletes it before they have.

   ------------------------------------------------------------------
   USAGE

     set OPENAI_API_KEY=sk-...
     node scripts/read-asap.mjs --dir "C:\\path\\to\\asap-aes"

   Options:
     --dir <folder>   the folder holding training_set_rel3.tsv  (required)
     --out <file>     where to write        (default ~/asap-read.md)
     --n <count>      how many essays       (default 6)
     --sets <list>    default 1,2,7,8       (source-dependent sets excluded)
     --seed <n>       default 1, so the same essays come back
     --model <id>     default is the shipped SUMMARY_MODEL. A MEASUREMENT OVERRIDE ONLY: it
                      changes what this script calls and nothing else. The feature's
                      model is modelFor() in _shared/model.ts, and nothing here writes it.
     --usd-in <n>     the provider's price per 1M input tokens, for a model the
     --usd-out <n>    repository does not price (per 1M output tokens). Without them
                      the read reports tokens and says the cost is unknown.
     --max-tokens <n> the output ceiling. Default 2000, or 8000 for the GPT-5 family,
                      whose reasoning tokens count against it: a ceiling a reasoning
                      model spends before answering is a truncated reply, not a reading.
     --dry-run        pick the essays, call nothing, spend nothing

   IT RUNS AFTER THE SCOPE CONTROL AND THE TWO-ARM MEASUREMENT, on the
   same key. Reading the prose of a mechanism that has not been shown
   to hold is reading a draft: the constrained prompt exists to be
   refused into shape, and its output before the operating
   characteristic says the shape works is output nobody would ship.
   ================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCorpus, selectForRead, bandAvailability, DEFAULT_SETS, MIN_ESSAY_WORDS, BANDS } from "./lib/asap-corpus.mjs";
import { essayFeedbackSchema, severityOf, BAND_RATING_MIN, BAND_RATING_MAX } from "../src/essayPoints.js";
import { measureReply } from "./lib/essay-read.mjs";
import { ARMS, userMessage } from "./lib/essay-arms.mjs";
import { callVision } from "./lib/photo-calls.mjs";
import { productionModel } from "./lib/production-model.mjs";
import { loadPricing, usdFor } from "./lib/model-prices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- arguments ---------- */

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const dir = opt("--dir");
const n = Number(opt("--n", "6"));
const seed = Number(opt("--seed", "1"));
const sets = (opt("--sets", DEFAULT_SETS.join(","))).split(",").map((x) => Number(x.trim()));
const shipped = await productionModel({ hasImages: false });
const model = opt("--model") || shipped;
const maxTokens = Number(opt("--max-tokens", model.startsWith("gpt-5") ? "8000" : "2000"));
const num = (x) => (x === null ? null : Number(x));
const pricing = await loadPricing({ usdIn: num(opt("--usd-in")), usdOut: num(opt("--usd-out")) });
const price = pricing.priceFor(model);
const dryRun = argv.includes("--dry-run");
const outArg = opt("--out", path.join(os.homedir(), "asap-read.md"));

if (!dir) {
  console.error(
    "usage: node scripts/read-asap.mjs --dir <folder containing training_set_rel3.tsv>\n\n" +
      "Options: --out ~/asap-read.md   --n 6   --sets 1,2,7,8   --seed 1   --dry-run"
  );
  process.exit(1);
}

/* ---------- THE FENCE, checked before anything is read or called ----

   REFUSED RATHER THAN REDIRECTED. Writing essay text somewhere inside
   a git working tree is one `git add -A` away from a commit that
   cannot be taken back, and .gitignore is a second line rather than a
   first — an operator who passes `--out` explicitly has overridden the
   default and deserves to be told, not quietly moved.

   Compared on RESOLVED, REAL paths: `..` segments, a symlink into the
   repo and a relative path all have to answer the same question, and
   only a resolved comparison makes them. */
const outPath = path.resolve(outArg.startsWith("~") ? path.join(os.homedir(), outArg.slice(1)) : outArg);
const realRoot = fs.realpathSync(ROOT);
const realOutDir = (() => {
  let d = path.dirname(outPath);
  /* The directory may not exist yet; walk up to the first that does,
     so a symlinked parent is still resolved. */
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return fs.realpathSync(d);
})();
if (realOutDir === realRoot || realOutDir.startsWith(realRoot + path.sep)) {
  console.error(
    `\nREFUSED: ${outPath}\n\n` +
      `That is inside the repository (${realRoot}).\n\n` +
      "This file holds ASAP essay text in full. The competition rules permit reading it\n" +
      "and forbid redistributing it, and a file in a working tree is one `git add -A`\n" +
      "away from being redistributed permanently.\n\n" +
      `Write it somewhere else — the default is ${path.join(os.homedir(), "asap-read.md")}.\n`
  );
  process.exit(1);
}

if (!dryRun && !process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Add --dry-run to check the selection without calling anything.");
  process.exit(1);
}

/* ---------- the essays ---------- */

let corpus;
try {
  corpus = loadCorpus({ dir, sets });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

/* SPREAD ACROSS NORMALISED BANDS, which is the whole design of the
   read: the sheet asks whether a weaker essay draws more substantive
   comment than a stronger one, and that needs essays from different
   bands.

   THE FIRST VERSION SORTED RAW SCORES ACROSS SETS, and ASAP scores each
   set on its own range — so a set-7 essay at 5/30 ranked as a "score 5"
   and sat at the top of the sheet as the strong essay while being a weak
   one. Found by Jared reading the file, 24 September 2026. The selection
   now lives in `selectForRead`, where it is tested without a corpus. */
const { chosen, ranges, bandsCovered } = selectForRead({
  rows: corpus.rows,
  allScores: corpus.allScores,
  n,
  seed,
});

console.log("=".repeat(72));
console.log("ASAP READ — essay, human score and feedback, for a person");
console.log("=".repeat(72));
console.log(`corpus       ${corpus.tsvPath}`);
console.log(`sets         ${sets.join(", ")}`);
console.log(`essays       ${chosen.length} (asked for ${n}), seed ${seed}`);
console.log(`bands        ${bandsCovered.join(", ")}   <- normalised within each set; the sheet needs a spread here`);
console.log(`word floor   ${corpus.minWords}`);
console.log("");
const avail = bandAvailability({ rows: corpus.rows, ranges });
console.log("  set  range   source     essays >= floor / all    low  middle  high");
for (const set of sets) {
  const r = ranges[set];
  const a = corpus.perSet[set] || { total: 0, clear: 0 };
  const b = avail[set] || { low: 0, middle: 0, high: 0 };
  const range = r ? `${r.min}-${r.max}`.padEnd(7) : "-      ";
  const src = r ? r.source.padEnd(10) : "-         ";
  /* A SHORTFALL IS SAID, not hidden, and PER BAND. Set 7 is short
     narratives and was predicted to fall short of the floor. The floor
     keeps the longer essays and length tracks score, so the low band is
     where it would fall short first, and a total would hide that. */
  const thin = BANDS.filter((x) => b[x] < 3);
  const warn = a.clear < 3 ? "   <- too few to read at this floor" : thin.length ? `   <- under 3 in: ${thin.join(", ")}` : "";
  console.log(
    `  ${String(set).padEnd(4)} ${range} ${src} ${String(a.clear).padStart(5)} / ${String(a.total).padEnd(9)}` +
      `${String(b.low).padStart(5)} ${String(b.middle).padStart(7)} ${String(b.high).padStart(5)}${warn}`
  );
}
console.log("");
console.log(`ids          ${chosen.map((c) => `${c.set}:${c.id}`).join(" ")}`);
console.log(`model        ${model}${model === shipped ? "   (the shipped model)" : `   (a MEASUREMENT OVERRIDE; the shipped model is ${shipped})`}`);
console.log(`price        ${price ? `$${price.in} / $${price.out} per 1M in / out, from ${price.source}` : "UNKNOWN: this model is not priced in the repository; pass --usd-in and --usd-out from the provider's pricing page"}`);
console.log(`ceiling      ${maxTokens} output tokens`);
console.log(`out          ${outPath}`);
console.log(`text         WRITTEN IN FULL to that file, and nowhere else. Delete it when read.`);

if (bandsCovered.length < 2) {
  console.error(
    "\nREFUSED: every chosen essay falls in the same normalised band.\n" +
      "The sheet asks whether a weaker essay draws more substantive comment than a stronger one,\n" +
      "and that cannot be answered inside one band. Raise --n, change --seed, or add a set.\n"
  );
  process.exit(1);
}

/* THE COST, ESTIMATED BEFORE ANYTHING IS SPENT: input from characters
   at credits.ts's own CHARS_PER_TOKEN, output at the full ceiling, so
   this is an upper bound per essay. The real run reports what was
   actually used. */
{
  const sysChars = ARMS.constrained.system.length;
  const inTok = chosen.map((r) => (sysChars + (corpus.rubricFor.get(r.set) || "").length + r.essay.length) / pricing.charsPerToken);
  const meanIn = inTok.reduce((a, b) => a + b, 0) / (inTok.length || 1);
  const ceilingUsd = price ? usdFor({ prompt_tokens: meanIn, completion_tokens: maxTokens }, price) : null;
  console.log(
    `estimate     ~${Math.round(meanIn)} input tokens per essay; at most ` +
      (ceilingUsd === null ? "(price unknown)" : `$${ceilingUsd.toFixed(4)} and ${pricing.creditsFor(ceilingUsd)} credit(s) per essay, $${(ceilingUsd * chosen.length).toFixed(3)} for the run`)
  );
}

if (dryRun) {
  console.log("\n--dry-run: nothing was called, nothing was spent and nothing was written.");
  process.exit(0);
}

/* ---------- the constrained arm, once per essay ---------- */

/* THE SHIPPED PROMPT AND NOTHING ELSE. The adversarial arm exists to
   generate a negative population for a separation statistic; there is
   nothing to read in it, and putting ghostwritten prose in front of a
   reader who is judging quality would be actively misleading. */
const arm = ARMS.constrained;
const out = [];

for (const [i, row] of chosen.entries()) {
  process.stderr.write(`[${i + 1}/${chosen.length}] set ${row.set} essay ${row.id} (${row.score}/${ranges[row.set].max}, ${row.band})…\n`);
  const { json, error } = await callVision({
    apiKey: process.env.OPENAI_API_KEY,
    model,
    messages: [
      { role: "system", content: arm.system },
      { role: "user", content: userMessage({ essay: row.essay, criteria: corpus.rubricFor.get(row.set), placeholders: true }) },
    ],
    maxTokens,
    /* THE STRICT SCHEMA, so the deficiency enum is enforced by the
       decoder rather than requested in the prose. See essaySchema.js. */
    jsonSchema: essayFeedbackSchema(),
  });

  /* REPORTED IN THE FILE, not skipped. An essay that produced nothing
     is a fact about the feature and the reader should see it beside the
     ones that worked; a file containing only the successes is a
     flattering sample of our own output. */
  const m = error
    ? measureReply({ content: "", set: row.set })
    : measureReply({ content: json?.choices?.[0]?.message?.content ?? "", set: row.set, essay: row.essay, criteria: corpus.rubricFor.get(row.set), humanBand: row.band });
  if (error) m.failure = error;
  /* WHAT WAS REALLY USED, per call. A reply cut off at the ceiling is
     reported as a failure of THIS configuration rather than parsed as
     a short reading. */
  const usage = json?.usage || null;
  const finish = json?.choices?.[0]?.finish_reason || null;
  if (finish === "length") m.failure = `cut off at the ${maxTokens}-token ceiling (finish_reason length)`;
  out.push({ row, ...m, usage, finish, usd: usage ? usdFor(usage, price) : null });
}

/* ---------- the file ---------- */

/* THE NUMBERS ARE PRINTED, NOT FILLED IN. Point count and the
   severity mix are facts about the output, computed the same way for
   every essay, so a reader does not have to count and cannot miscount.
   What stays for a person is the judgement the numbers cannot make. */
const measured = out;

const byBand = BANDS.map((band) => {
  const inBand = measured.filter((m) => m.row.band === band && !m.failure);
  const sum = (k) => inBand.reduce((a, m) => a + m.sev[k], 0);
  const pts = inBand.reduce((a, m) => a + m.count, 0);
  const counted = inBand.reduce((a, m) => a + m.counted, 0);
  const agree = inBand.filter((m) => m.agrees).length;
  const placed = inBand.filter((m) => m.placed).length;
  return { band, essays: inBand.length, pts, counted, agree, placed, fundamental: sum("fundamental"), minor: sum("minor"), outside: sum("outside") };
});
const ok = measured.filter((m) => !m.failure);
const unknownTotal = ok.reduce((a, m) => a + m.sev.unknown, 0);
const offGenreTotal = ok.reduce((a, m) => a + m.offGenre.length, 0);
const genreKnown = ok.filter((m) => m.genreMatches !== null);
const genreRight = genreKnown.filter((m) => m.genreMatches).length;
const predictionTotal = ok.filter((m) => m.predictionHits.length).length;
const placedOk = ok.filter((m) => m.placed);
const agreeing = placedOk.filter((m) => m.agrees).length;
const thesisTotal = ok.reduce((a, m) => a + m.thesisFlagged.length, 0);
const droppedTotal = ok.reduce((a, m) => a + m.thesisDropped.length, 0);
const notVerbatimTotal = ok.reduce((a, m) => a + m.notVerbatim.length, 0);
const placeholderOnlyTotal = ok.reduce((a, m) => a + m.placeholderOnly.length, 0);
const bandsShort = ok.filter((m) => m.bandsShort).length;
const bandsBelowKnown = ok.filter((m) => m.bandsBelowKnown).length;
const knownSets = ok.filter((m) => [1, 2].includes(m.row.set)).length;
const namedOk = ok.filter((m) => m.namedPlaced);
const namedAgreeing = namedOk.filter((m) => m.namedAgrees).length;
const namedOff = ok.filter((m) => m.namedMatchesPick === false).length;
const tiedTotal = ok.filter((m) => m.pickTied.length).length;
const ratingsBad = ok.reduce((a, m) => a + m.ratingsOutOfRange.length, 0);
const highOk = ok.filter((m) => m.row.band === "high" && m.placed);
const highPicks = highOk.map((m) => m.pick);
const highUniformlyLow = highOk.length > 0 && highOk.every((m) => m.placed.band !== "high");
/* COST, measured. Mean and max over the calls that reported usage. */
const used = measured.filter((m) => m.usage);
const meanOf = (f) => (used.length ? used.reduce((a, m) => a + f(m), 0) / used.length : null);
const meanIn = meanOf((m) => m.usage.prompt_tokens || 0);
const meanOut = meanOf((m) => m.usage.completion_tokens || 0);
const meanReason = meanOf((m) => m.usage.completion_tokens_details?.reasoning_tokens || 0);
const priced = used.filter((m) => m.usd !== null);
const meanUsd = priced.length ? priced.reduce((a, m) => a + m.usd, 0) / priced.length : null;
const maxUsd = priced.length ? Math.max(...priced.map((m) => m.usd)) : null;
const truncated = measured.filter((m) => m.finish === "length").length;
const descriptorsInvented = ok.reduce((a, m) => a + m.descriptorsInvented.length, 0);

const sheet = [
  "# ASAP read — does the feedback point at anything a marker cares about?",
  "",
  `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} · model \`${model}\` · seed ${seed} · word floor ${corpus.minWords}`,
  "",
  "**This file contains ASAP essay text in full. Do not commit it, paste it or send it.**",
  "Reading it is permitted; redistributing it is not. Delete it when you have finished.",
  "",
  "## What this can and cannot tell you",
  "",
  "These are school essays scored by human raters, and **each ASAP set is scored on its own",
  "range** — so a raw score means nothing across sets. Every essay below is placed in a",
  "**band** by its position within its own set's range (low / middle / high thirds), and it",
  "is the BAND, not the raw number, that you compare across essays.",
  "",
  "| set | range | from | essays at or above the word floor |",
  "|---|---|---|---|",
  ...sets.map((x) => {
    const r = ranges[x];
    const a = corpus.perSet[x] || { total: 0, clear: 0 };
    return `| ${x} | ${r ? `${r.min}–${r.max}` : "—"} | ${r ? r.source : "—"} | ${a.clear} of ${a.total} |`;
  }),
  "",
  "*declared* ranges are the rubric's; an *observed* one is the lowest and highest score in",
  "the corpus, which is narrower than the rubric if no essay reached an extreme.",
  "",
  "A score still says one essay was better than another, not which criterion it fell down",
  "on — there is no criterion-by-criterion marking here to agree with.",
  "",
  "## The numbers — computed, not for filling in",
  "",
  "**Point count against band.** If volume tracked quality, weaker essays would draw more",
  "points. It need not — a strong essay can have six small things worth saying — which is",
  "why the severity mix beside it is the number that matters more.",
  "",
  "| band | essays | points | per essay | fundamental | minor | outside the count | faults per essay | reading agrees |",
  "|---|---|---|---|---|---|---|---|---|",
  ...byBand.map((b) =>
    `| ${b.band} | ${b.essays} | ${b.pts} | ${b.essays ? (b.pts / b.essays).toFixed(1) : "—"} | ${b.fundamental} | ${b.minor} | ${b.outside} | ${b.essays ? (b.counted / b.essays).toFixed(1) : "—"} | ${b.agree} of ${b.placed} |`
  ),
  "",
  `**Codes outside the closed set: ${unknownTotal}.** Under the strict schema this run sends,`,
  "that is zero by construction. A non-zero here means the schema did not reach the model,",
  "and every severity number above is computed over points with holes in them.",
  "",
  "*outside the count* is `off-criterion`: the model saying it had nothing against a",
  "criterion. It is not a fault, so it is counted apart from both severity columns.",
  "",
  "*faults per essay* leaves out `off-criterion`. If it is still flat across the bands, the",
  "prompt is still asking for a quota rather than for what is wrong.",
  "",
  `**Best-fit reading agrees with the human band: ${agreeing} of ${placedOk.length}.** The model rates`,
  "every band's descriptor for how well it describes the essay, and the pick is the best-rated band,",
  "chosen in code. Where it sits in the model's own list of bands is put into thirds and compared",
  "with where the human score sits in the set's range. Rounds so far: 2 of 12, 5 of 12, 6 of 18.",
  `Picks that could not be placed are left out: ${ok.length - placedOk.length} this run.`,
  "",
  `**The high band:** ${highOk.length} essays, picked as ${highPicks.join(", ") || "(none)"}.`,
  `${highUniformlyLow ? "**Every high-band essay was read below the high band, as in the last three rounds.**" : "Not uniformly read low."}`,
  "",
  `The band the model itself NAMED agrees ${namedAgreeing} of ${namedOk.length}, and differed from its own best-rated`,
  `band on ${namedOff} essay(s). Ties for the top rating: ${tiedTotal}. Ratings outside ${BAND_RATING_MIN}-${BAND_RATING_MAX}: ${ratingsBad}.`,
  "",
  "**Did it weigh every band?** Strict mode cannot require a list length, so this is counted:",
  `lists shorter than the band count the model itself stated: ${bandsShort}; shorter than the rubric's`,
  `six score points on sets 1 and 2: ${bandsBelowKnown} of ${knownSets}; descriptors not found in the criteria: ${descriptorsInvented}.`,
  "",
  "**Checks on the instructions, each counted rather than judged:**",
  "",
  `- **Genre read from the criteria:** ${genreRight} of ${genreKnown.length} essays got the genre their ASAP set really asks for (sets 1 and 2 argument, 7 and 8 narrative).`,
  `- **Codes that do not fit the genre the model itself stated: ${offGenreTotal}.** Each genre's codes are now an enum in the schema, so this is zero by construction. A non-zero means the schema did not reach the model.`,
  `- **Opening sentences that read as a prediction (the ESSAY-FEEDBACK.md §4 ban): ${predictionTotal}.** It should be zero.`,
  `- **Points removed by the thesis rule: ${droppedTotal}.** An unsupported-claim point on the main idea, while the model's own support list is not empty, is now removed in code rather than asked against in prose; the last read had 3. Each removal is shown under its essay. (Left after the rule: ${thesisTotal}, which is zero by construction.)`,
  `- **Spans not in the essay even with placeholders set aside: ${notVerbatimTotal}.** These are the likely fabrications: main-idea or support text the model wrote rather than copied. **Spans that differed only by a dropped placeholder: ${placeholderOnlyTotal}**, which is copying, not writing.`,
  "",
  "## What this run cost, measured",
  "",
  `Model \`${model}\`${model === shipped ? " (the shipped model)" : ` — a measurement override; the shipped model is \`${shipped}\``}.`,
  `Price: ${price ? `$${price.in} / $${price.out} per 1M input / output tokens, from ${price.source}` : "**unknown**, not priced in the repository and not passed"}.`,
  `Ceiling: ${maxTokens} output tokens; **replies cut off at it: ${truncated}**.`,
  "",
  "| per essay | input tokens | output tokens | of which reasoning | USD | credits |",
  "|---|---|---|---|---|---|",
  `| mean | ${meanIn === null ? "—" : Math.round(meanIn)} | ${meanOut === null ? "—" : Math.round(meanOut)} | ${meanReason === null ? "—" : Math.round(meanReason)} | ${meanUsd === null ? "—" : meanUsd.toFixed(5)} | ${meanUsd === null ? "—" : pricing.creditsFor(meanUsd)} |`,
  `| max | | | | ${maxUsd === null ? "—" : maxUsd.toFixed(5)} | ${maxUsd === null ? "—" : pricing.creditsFor(maxUsd)} |`,
  "",
  `Credits use credits.ts's own \`creditsFor\` at $${pricing.usdPerCredit.toFixed(6)} a credit. This is the MEASURED cost of`,
  "these essays, not the price: the product prices an action from its ceilings, so a re-derived",
  "credit price is set in step 4 from the chosen model's ceilings, with this as the check on it.",
  "",
  "## The sheet — fill this in as you read",
  "",
  "| # | set | score | band | model's reading | agrees | points | fund. | minor | Points at things a marker would care about? | Notes |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...measured.map(
    (m, i) =>
      `| ${i + 1} | ${m.row.set} | ${m.row.score}/${ranges[m.row.set].max} | ${m.row.band} | ${m.failure ? "—" : m.pick || "(none)"} | ${m.failure || m.agrees === null ? "—" : m.agrees ? "yes" : "no"} | ${m.failure ? "—" : m.count} | ${m.failure ? "—" : m.sev.fundamental} | ${m.failure ? "—" : m.sev.minor} | yes / partly / no | |`
  ),
  "",
  "**Two questions the table cannot hold:**",
  "",
  "> **1. Does the WEAKER essay get more substantive comment than the stronger one?**",
  "> Compare a low-band essay against a high-band one and answer **yes / partly / no**, with",
  "> a sentence on why:",
  ">",
  "> `                                                                        `",
  "",
  "> **2. Does the SUBSTANCE track the band?** On the high-band essays, are the points",
  "> mostly MINOR — wording, tightening, signposting? On the low-band essays, are they",
  "> mostly FUNDAMENTAL — no evidence, no argument, contradicting itself? Judge what the",
  "> points SAY, not the label beside them: the label is the model's choice of code, and",
  "> whether it chose well is part of the question. **yes / partly / no**, and why:",
  ">",
  "> `                                                                        `",
  "",
  "**What the answers decide.** This run already ORDERS points by severity and OPENS with an",
  "overall reading, the presentation fix the last read pointed to, so the question is now",
  "whether that presentation is honest. If 2 is *yes*, the opening sentence and the order",
  "should make a weak essay read as weak and a strong one as strong. If 2 is *no*, the",
  "codes the model picks do not follow quality, and ordering by them only arranges noise:",
  "that is a prompt problem to solve before any screen is built.",
  "",
  "The *model's reading* column is the band the model says the essay reads like, in the",
  "rubric's own terms. Set it beside *score*: it is the easiest place to see whether the",
  "opening sentence tracks the human rater at all.",
  "",
  "---",
  "",
];

for (const [i, m] of measured.entries()) {
  const r = ranges[m.row.set];
  sheet.push(
    `## ${i + 1}. Set ${m.row.set}, essay ${m.row.id} — ${m.row.score}/${r.max} (${m.row.band} band) · ${m.row.words} words`
  );
  sheet.push("");
  sheet.push("### The essay");
  sheet.push("");
  sheet.push("```");
  sheet.push(m.row.essay);
  sheet.push("```");
  sheet.push("");
  sheet.push("### The feedback");
  sheet.push("");
  /* THE OPENING READING FIRST, then the points FUNDAMENTAL FIRST: the
     order the student would see. The model's own order is kept inside a
     level (orderBySeverity is stable). The genre and anything that
     breaks the new rules are shown beside the point, so a reader can
     see a violation without counting. */
  if (m.failure) {
    sheet.push(`**Nothing came back.** ${m.failure}`);
  } else {
    const genreNote = m.genreMatches === false ? ` · **the set asks for ${m.expectedGenre}**` : "";
    sheet.push(`Genre stated: _${m.genre}_${genreNote}`);
    sheet.push("");
    sheet.push(`> **Opening reading** · reads like: ${m.pick ? `**${m.pick}**` : "_(no band)_"}`);
    sheet.push(`> ${m.overall.sentence || "_(no sentence)_"}`);
    if (m.overall.bandsConsidered.length) {
      sheet.push(`> Bands rated (${m.overall.bandsConsidered.length} of a stated ${m.overall.bandCount}): ${m.overall.bandsConsidered.map((b) => `${b.band} _(${b.rating})_`).join(" · ")}`);
      sheet.push(`> Best fit, picked in code: **${m.pick || "(none)"}**${m.pickTied.length ? ` (tied: ${m.pickTied.join(", ")})` : ""}`);
    }
    if (m.namedMatchesPick === false) sheet.push(`> ⚠ named **${m.overall.band}**, but its own best-rated band is **${m.pick}**`);
    if (m.predictionHits.length) sheet.push(`> ⚠ trips the §4 prediction ban: ${m.predictionHits.join(", ")}`);
    sheet.push("");
    sheet.push(`Main idea: \`${String(m.mainIdea || "(none)").replace(/`/g, "'")}\` · ${m.support.length} supporting span(s)`);
    for (const x of m.notVerbatim) sheet.push(`- ⚠ **not in the essay:** \`${String(x).replace(/`/g, "'")}\``);
    for (const p of m.thesisDropped) {
      sheet.push(`- ✂ **removed by the thesis rule:** ${p.deficiency} on \`${String(p.quote || "").replace(/`/g, "'")}\` (${p.note || ""})`);
    }
    sheet.push("");
    if (!m.count) {
      sheet.push("**No points at all.** The model read the essay and raised nothing — worth noting on the sheet.");
    }
    for (const p of m.ordered) {
      const off =
        (m.offGenre.includes(p) ? ` · **does not fit ${m.genre}**` : "") +
        (m.thesisFlagged.includes(p) ? " · **the main idea, coded unsupported despite support**" : "");
      sheet.push(`- **${p.deficiency || "(no deficiency)"}** · _${severityOf(p.deficiency)}_${off}`);
      sheet.push(`  - quotes: \`${String(p.quote || "").replace(/`/g, "'")}\``);
      sheet.push(`  - says: ${p.note || "(nothing)"}`);
    }
  }
  sheet.push("");
  sheet.push("---");
  sheet.push("");
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, sheet.join("\n"), "utf8");

console.log(`\nWritten: ${outPath}`);
console.log(`  agreement ${agreeing} of ${placedOk.length} (best fit); high band read as ${highPicks.join(", ") || "(none)"}${highUniformlyLow ? " — ALL BELOW HIGH" : ""}`);
console.log(`  cost      ${meanUsd === null ? "unknown (no price)" : `$${meanUsd.toFixed(5)} mean, $${maxUsd.toFixed(5)} max per essay; ${pricing.creditsFor(meanUsd)} credit(s) mean`}; ${truncated} cut off at the ceiling`);
console.log(`  ${out.filter((o) => !o.failure && o.count).length} of ${out.length} essays produced feedback.`);
console.log("  Open it, fill in the sheet at the top, and delete the file when you are done.");
