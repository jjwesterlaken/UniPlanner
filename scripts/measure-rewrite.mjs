/* ==================================================================
   measure-rewrite.mjs — are the example rewrite's scope limits right?

   The example rewrite ships OFF (ESSAY_REWRITE is null in
   ai-text/config.ts) because #142's scope check has only ever run on
   synthetic rewrites, and a refused rewrite is BILLED. This runs the
   real thing, the way the endpoint would, and reports how often the
   check would refuse what the SHIPPED prompt produces:

     1. essay feedback with the shipped prompt, schema and ceiling, and
        the reply finished by finishEssayReply at the SHIPPED thresholds,
        so the points are the ones a student would see;
     2. for each point, checkRewriteSpan at the settings under test,
        then a rewrite with the shipped prompt, schema and ceiling;
     3. checkScope over every candidate setting, reduced to numbers.

   The settings are read by the essay thresholds' rule: at most 2% of
   the rewrites refused at the chosen settings. The exit code follows it.

   NO ESSAY TEXT IS PRINTED OR KEPT. --keep writes numbers only, and
   --summarise re-evaluates them at other settings with no calls.

   USAGE
     set OPENAI_API_KEY=sk-...
     node scripts/measure-rewrite.mjs --dir "<asap folder>" --sets 1,2,8 --n 12 --keep "<outside the repo>\\rewrites.json"
     node scripts/measure-rewrite.mjs --summarise "<file>" --settings 6,1.5,120,0.25

   --settings is escapeRun,exceedsRatio,maxSpanWords,maxSpanShare. The
   default is PROPOSED below, the values config.ts names for this run.
   ================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCorpus, stratify } from "./lib/asap-corpus.mjs";
import { callVision } from "./lib/photo-calls.mjs";
import { productionModel, productionCeiling, productionThresholds } from "./lib/production-model.mjs";
import { loadPricing, usdFor } from "./lib/model-prices.mjs";
import { printRewriteSummary, ESCAPE_RUNS } from "./lib/rewrite-summary.mjs";
import { ESSAY_SYSTEM_PROMPT, essayUserMessage } from "../supabase/functions/_shared/essayPrompt.js";
import { essayFeedbackSchema } from "../supabase/functions/_shared/essaySchema.js";
import { finishEssayReply } from "../supabase/functions/_shared/essayReply.js";
import { REWRITE_SYSTEM_PROMPT, rewriteUserMessage, rewriteSchema, checkRewriteSpan } from "../supabase/functions/_shared/essayRewrite.js";
import { checkScope, wordsOf } from "../supabase/functions/_shared/essayScope.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

/* The values config.ts proposes for this run. */
export const PROPOSED = Object.freeze({ escapeRun: 6, exceedsRatio: 1.5, maxSpanWords: 120, maxSpanShare: 0.25 });

function settingsFrom(arg) {
  if (!arg) return { ...PROPOSED };
  const [escapeRun, exceedsRatio, maxSpanWords, maxSpanShare] = arg.split(",").map(Number);
  if (![escapeRun, exceedsRatio, maxSpanWords, maxSpanShare].every((n) => Number.isFinite(n) && n > 0)) {
    console.error("--settings takes four numbers: escapeRun,exceedsRatio,maxSpanWords,maxSpanShare");
    process.exit(1);
  }
  return { escapeRun, exceedsRatio, maxSpanWords, maxSpanShare };
}

/** One rewrite, reduced to the numbers the scope check reads. No text survives this. */
export function recordFor({ essay, span, rewrite, spanOk, truncated, completion }) {
  if (!spanOk) return { spanOk: false };
  if (truncated) return { spanOk: true, truncated: true, completion };
  const base = checkScope({ essay, span, rewrite, escapeRun: 99, exceedsRatio: 1e9 });
  return {
    spanOk: true,
    truncated: false,
    completion,
    fabricated: base.violations.some((v) => v.kind === "fabricated-fact"),
    escapeFires: ESCAPE_RUNS.filter((k) => checkScope({ essay, span, rewrite, escapeRun: k, exceedsRatio: 1e9 }).violations.some((v) => v.kind === "escapes-span")),
    ratio: wordsOf(rewrite).length / Math.max(1, wordsOf(span).length),
  };
}

async function main() {
  const settings = settingsFrom(opt("--settings"));
  const ceiling = await productionCeiling("rewrite");

  const summariseFile = opt("--summarise");
  if (summariseFile) {
    const kept = JSON.parse(fs.readFileSync(summariseFile, "utf8"));
    const verdict = printRewriteSummary(kept.records, settings, { ceiling: kept.ceiling });
    process.exit(verdict.ok ? 0 : 1);
  }

  const dir = opt("--dir");
  if (!dir) {
    console.error("usage: node scripts/measure-rewrite.mjs --dir <asap folder> [--sets 1,2,8] [--n 12] [--per-essay 3] [--keep file] [--dry-run]");
    process.exit(1);
  }
  const sets = opt("--sets", "1,2,8").split(",").map(Number);
  const n = Number(opt("--n", "12"));
  const perEssay = Number(opt("--per-essay", "3"));
  const keep = opt("--keep");
  if (keep && path.resolve(keep).startsWith(ROOT + path.sep)) {
    console.error("--keep must be outside the repository. It holds numbers only, but the rule for this corpus is that nothing from it lands here.");
    process.exit(1);
  }
  const corpus = loadCorpus({ dir, sets, anon: "placeholder" });
  const { rows } = corpus;
  const chosen = stratify({ rows, sets, perSet: Math.ceil(n / sets.length), seed: Number(opt("--seed", "1")) }).slice(0, n);
  const model = await productionModel({ hasImages: false, task: "rewrite" });
  const essayModel = await productionModel({ hasImages: false, task: "essay" });
  const essayCeiling = await productionCeiling("essay");
  const thresholds = await productionThresholds();

  console.log(`model        ${model} (essay feedback on ${essayModel})`);
  console.log(`ceilings     essay ${essayCeiling}, rewrite ${ceiling}`);
  console.log(`essays       ${chosen.length}, up to ${perEssay} rewrites each (at most ${chosen.length * (1 + perEssay)} provider calls)`);
  console.log(`essay ids    ${chosen.map((c) => `${c.set}:${c.id}`).join(" ")}`);
  if (argv.includes("--dry-run")) {
    console.log("\n--dry-run: nothing was called and nothing was spent.");
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set.");
    process.exit(1);
  }
  if (!thresholds) {
    console.error("ESSAY_NO_WRITING is null in config.ts, so the points a student would see cannot be reproduced.");
    process.exit(1);
  }

  const pricing = await loadPricing();
  const records = [];
  let maxUsd = 0;
  for (const [i, row] of chosen.entries()) {
    process.stderr.write(`[${i + 1}/${chosen.length}] set ${row.set} essay ${row.id}…\n`);
    const criteria = corpus.rubricFor.get(row.set) || "";
    const fb = await callVision({
      apiKey: process.env.OPENAI_API_KEY,
      model: essayModel,
      messages: [
        { role: "system", content: ESSAY_SYSTEM_PROMPT },
        { role: "user", content: essayUserMessage({ essay: row.essay, criteria }) },
      ],
      maxTokens: essayCeiling,
      jsonSchema: essayFeedbackSchema(),
    });
    if (fb.error) {
      console.error(`  feedback failed: ${fb.error}`);
      continue;
    }
    let points = [];
    try {
      points = finishEssayReply({ raw: fb.json.choices[0].message.content, essay: row.essay, criteria, thresholds }).points;
    } catch (e) {
      console.error(`  feedback refused or unusable: ${e.message.split(":")[0]}`);
      continue;
    }
    for (const p of points.slice(0, perEssay)) {
      const span = checkRewriteSpan({ essay: row.essay, span: p.quote, limits: settings });
      if (!span.ok) {
        records.push(recordFor({ spanOk: false }));
        continue;
      }
      const rw = await callVision({
        apiKey: process.env.OPENAI_API_KEY,
        model,
        messages: [
          { role: "system", content: REWRITE_SYSTEM_PROMPT },
          { role: "user", content: rewriteUserMessage({ span: p.quote, note: p.note, deficiency: p.deficiency }) },
        ],
        maxTokens: ceiling,
        jsonSchema: rewriteSchema(),
      });
      if (rw.error) {
        console.error(`  rewrite failed: ${rw.error}`);
        continue;
      }
      const choice = rw.json.choices[0];
      const usage = rw.json.usage || {};
      const usd = usdFor(usage, pricing.priceFor(model));
      if (usd !== null) maxUsd = Math.max(maxUsd, usd);
      let rewrite = "";
      try {
        rewrite = JSON.parse(choice.message.content).rewrite || "";
      } catch {
        /* unparseable counts as a refusal below: checkScope reads empty */
      }
      records.push(
        recordFor({ essay: row.essay, span: p.quote, rewrite, spanOk: true, truncated: choice.finish_reason === "length", completion: usage.completion_tokens })
      );
    }
  }

  if (keep) {
    fs.writeFileSync(keep, JSON.stringify({ ceiling, records }));
    console.error(`numbers kept in ${keep} (no essay text)`);
  }
  const verdict = printRewriteSummary(records, settings, { ceiling, usdPerRewrite: maxUsd || null });
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
