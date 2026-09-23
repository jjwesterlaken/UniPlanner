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
     --model <id>     default is the shipped SUMMARY_MODEL
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

import { loadCorpus, stratify, DEFAULT_SETS } from "./lib/asap-corpus.mjs";
import { ARMS, userMessage } from "./lib/essay-arms.mjs";
import { callVision } from "./lib/photo-calls.mjs";
import { productionModel } from "./lib/production-model.mjs";

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
const model = opt("--model") || (await productionModel({ hasImages: false }));
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

/* SPREAD ACROSS THE SCORE BANDS, which is the whole design of the
   read: the second question on the sheet is whether a lower-scored
   essay draws more substantive comment than a higher-scored one, and
   six essays from the same band cannot answer it.

   The stratified draw already spreads within each set, so taking one
   per set and then filling up gives both spreads at n=6. */
const perSet = Math.max(1, Math.ceil(n / sets.length));
const pool = stratify({ rows: corpus.rows, sets, perSet, seed });
const chosen = pool
  .slice()
  .sort((a, b) => a.score - b.score || a.set - b.set)
  .filter((_, i, all) => {
    const step = Math.max(1, Math.floor(all.length / n));
    return i % step === 0;
  })
  .slice(0, n);

const bands = [...new Set(chosen.map((c) => c.score))].sort((a, b) => a - b);

console.log("=".repeat(72));
console.log("ASAP READ — essay, human score and feedback, for a person");
console.log("=".repeat(72));
console.log(`corpus       ${corpus.tsvPath}`);
console.log(`sets         ${sets.join(", ")}`);
console.log(`essays       ${chosen.length} (asked for ${n}), seed ${seed}`);
console.log(`score bands  ${bands.join(", ")}   <- the sheet's second question needs a spread here`);
console.log(`ids          ${chosen.map((c) => `${c.set}:${c.id}`).join(" ")}`);
console.log(`model        ${model}`);
console.log(`out          ${outPath}`);
console.log(`text         WRITTEN IN FULL to that file, and nowhere else. Delete it when read.`);

if (bands.length < 2) {
  console.error(
    "\nREFUSED: every chosen essay has the same human score.\n" +
      "The sheet asks whether a lower-scored essay draws more comment than a higher-scored one,\n" +
      "and that question cannot be answered inside one band. Raise --n or change --seed.\n"
  );
  process.exit(1);
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
  process.stderr.write(`[${i + 1}/${chosen.length}] set ${row.set} essay ${row.id} (score ${row.score})…\n`);
  const { json, error } = await callVision({
    apiKey: process.env.OPENAI_API_KEY,
    model,
    messages: [
      { role: "system", content: arm.system },
      { role: "user", content: userMessage({ essay: row.essay, criteria: corpus.rubricFor.get(row.set) }) },
    ],
    maxTokens: 2000,
  });

  let points = null;
  let failure = null;
  if (error) failure = error;
  else {
    try {
      points = JSON.parse(json.choices[0].message.content).points;
      if (!Array.isArray(points)) throw new Error("no points array");
    } catch (e) {
      /* REPORTED IN THE FILE, not skipped. An essay that produced
         nothing is a fact about the feature and the reader should see
         it beside the ones that worked — a file containing only the
         successes is a flattering sample of our own output. */
      failure = `the output did not parse as the schema (${e.message})`;
    }
  }
  out.push({ row, points, failure });
}

/* ---------- the file ---------- */

const sheet = [
  "# ASAP read — does the feedback point at anything a marker cares about?",
  "",
  `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} · model \`${model}\` · seed ${seed}`,
  "",
  "**This file contains ASAP essay text in full. Do not commit it, paste it or send it.**",
  "Reading it is permitted; redistributing it is not. Delete it when you have finished.",
  "",
  "## What this can and cannot tell you",
  "",
  "These are school essays of 150–650 words, scored by human raters on a **1–6 holistic",
  "band** — not a university essay marked against criteria. So a score says one essay was",
  "better than another; it does not say which criterion it fell down on. Judge whether the",
  "feedback is pointing at real problems and whether it is harder on the weaker essays.",
  "Do not expect it to agree with a marker criterion by criterion: there is no such",
  "marking here to agree with.",
  "",
  "## The sheet — fill this in as you read",
  "",
  "| # | set | score | Points at things a marker would care about? | Notes |",
  "|---|---|---|---|---|",
  ...out.map((o, i) => `| ${i + 1} | ${o.row.set} | ${o.row.score} | yes / partly / no | |`),
  "",
  "**And the one question the table cannot hold:**",
  "",
  "> Does the LOWER-scored essay get more substantive comment than the higher-scored one?",
  ">",
  "> Compare the lowest-scored essay below against the highest-scored one, and answer",
  "> **yes / partly / no**, with a sentence on why:",
  ">",
  "> `                                                                        `",
  "",
  "If that answer is *no*, the feature is not ready whatever the operating characteristic",
  "says — feedback that treats a weak essay and a strong one alike is not reading either.",
  "",
  "---",
  "",
];

for (const [i, o] of out.entries()) {
  sheet.push(`## ${i + 1}. Set ${o.row.set}, essay ${o.row.id} — human score ${o.row.score}  (${o.row.words} words)`);
  sheet.push("");
  sheet.push("### The essay");
  sheet.push("");
  sheet.push("```");
  sheet.push(o.row.essay);
  sheet.push("```");
  sheet.push("");
  sheet.push("### The feedback");
  sheet.push("");
  if (o.failure) {
    sheet.push(`**Nothing came back.** ${o.failure}`);
  } else if (!o.points.length) {
    sheet.push("**No points at all.** The model read the essay and raised nothing — worth noting on the sheet.");
  } else {
    for (const p of o.points) {
      sheet.push(`- **${p.deficiency || "(no deficiency)"}**`);
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
console.log(`  ${out.filter((o) => o.points && o.points.length).length} of ${out.length} essays produced feedback.`);
console.log("  Open it, fill in the sheet at the top, and delete the file when you are done.");
