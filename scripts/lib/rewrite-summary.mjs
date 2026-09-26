/* The example rewrite's measurement, as numbers only.

   Each record is one rewrite the model produced for a point the essay
   feedback located, reduced to what the scope check reads:

     spanOk        whether checkRewriteSpan let the passage through
     escapeFires   the escape-run lengths (3..12) at which escapes-span fires
     ratio         rewrite words / passage words
     fabricated    whether fabricated-fact fired (independent of settings)
     truncated     the reply was cut off at the ceiling
     completion    completion tokens, reasoning included

   So any settings can be re-evaluated from a kept file with no provider
   call and no essay text. The rule the settings are read by is the
   essay thresholds' rule: at the chosen settings, at most 2% of the
   rewrites the SHIPPED prompt produces may be refused. */

export const ESCAPE_RUNS = [3, 4, 5, 6, 7, 8, 10, 12];
export const RATIOS = [1.25, 1.5, 1.75, 2, 2.5];
export const MAX_REFUSAL = 0.02;

/** Would this record be refused at these settings? Span refusals are free and counted apart. */
export function refusedAt(r, { escapeRun, exceedsRatio }) {
  if (!r.spanOk || r.truncated) return false;
  if (r.fabricated) return true;
  if ((r.escapeFires || []).includes(escapeRun)) return true;
  return r.ratio > exceedsRatio;
}

export function evaluateRewrites(records, settings) {
  const spanRefused = records.filter((r) => !r.spanOk).length;
  const truncated = records.filter((r) => r.spanOk && r.truncated).length;
  const judged = records.filter((r) => r.spanOk && !r.truncated);
  const refused = judged.filter((r) => refusedAt(r, settings)).length;
  const rate = judged.length ? refused / judged.length : null;
  return {
    records: records.length,
    spanRefused,
    truncated,
    judged: judged.length,
    refused,
    rate,
    byKind: {
      fabricated: judged.filter((r) => r.fabricated).length,
      escapes: judged.filter((r) => (r.escapeFires || []).includes(settings.escapeRun)).length,
      exceeds: judged.filter((r) => r.ratio > settings.exceedsRatio).length,
    },
    meetsRule: rate !== null && rate <= MAX_REFUSAL,
  };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};

/** Print the tables and return the verdict the exit code follows. */
export function printRewriteSummary(records, settings, { ceiling = null, usdPerRewrite = null } = {}) {
  const e = evaluateRewrites(records, settings);
  console.log(`\n${"=".repeat(72)}\nEXAMPLE REWRITES — ${records.length} requested\n${"=".repeat(72)}`);
  console.log(`\n  passages refused before any spend (span rules): ${e.spanRefused}`);
  console.log(`  replies cut off at the ${ceiling ?? "?"}-token ceiling:     ${e.truncated}`);
  const toks = records.filter((r) => Number.isInteger(r.completion)).map((r) => r.completion);
  if (toks.length) console.log(`  completion tokens: p50 ${pct(toks, 50)} | p90 ${pct(toks, 90)} | max ${Math.max(...toks)}`);
  if (usdPerRewrite !== null) console.log(`  cost per rewrite, max: $${usdPerRewrite.toFixed(5)}`);

  console.log("\nREFUSAL RATE by escape run (rows) and length ratio (columns):\n");
  console.log("  escape |" + RATIOS.map((r) => `  x${String(r).padEnd(5)}`).join(""));
  for (const k of ESCAPE_RUNS) {
    let row = `  ${String(k).padStart(6)} |`;
    for (const q of RATIOS) {
      const r = evaluateRewrites(records, { escapeRun: k, exceedsRatio: q }).rate;
      row += `  ${r === null ? "  —  " : `${(r * 100).toFixed(1)}%`.padStart(6)} `;
    }
    console.log(row);
  }
  console.log(`\n  fabricated-fact fired on ${e.byKind.fabricated} of ${e.judged} (does not depend on the settings)`);

  console.log(`\n${"=".repeat(72)}\nTHE GATE — rewrites the shipped prompt produced that would be refused\n${"=".repeat(72)}`);
  console.log(`\n  escape run ${settings.escapeRun} | length ratio ${settings.exceedsRatio} | span <= ${settings.maxSpanWords} words, <= ${settings.maxSpanShare} of the essay`);
  console.log(`  refused ${e.refused}/${e.judged} (${e.rate === null ? "—" : (e.rate * 100).toFixed(1) + "%"})  —  escapes ${e.byKind.escapes}, exceeds ${e.byKind.exceeds}, fabricated ${e.byKind.fabricated}`);
  console.log(`  RULE: at most ${MAX_REFUSAL * 100}% refused — ${e.meetsRule ? "MET" : "NOT MET"}\n`);
  return { ok: e.meetsRule, evaluation: e };
}
