/* What a model costs, read from the SAME source the product prices
   itself from. For measurement only; nothing here decides a price.

   `credits.ts` holds the rate for SUMMARY_MODEL (USD_PER_1M_INPUT /
   OUTPUT) and what a credit is worth (USD_PER_CREDIT, creditsFor);
   `model.ts` holds VISION_MODEL and its rate. A cost per essay worked
   out here therefore uses the same numbers and the same rounding a
   re-derived credit price would, rather than a second table that could
   drift from them.

   A MODEL THE REPOSITORY DOES NOT PRICE GETS NO PRICE. It is not
   guessed and not remembered: a provider's rate belongs to the
   provider, and this container cannot reach OpenAI's pricing page. The
   caller passes --usd-in and --usd-out from that page, and until it
   does the read prints tokens and says the cost is unknown.

   Bundled with esbuild rather than imported as .ts, for the reason
   production-model.mjs records: a colleague on Node 22.10 cannot
   import TypeScript at all. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHARED = path.join(ROOT, "supabase/functions/_shared");

async function bundle(file) {
  const { build } = await import("esbuild");
  const out = await build({ entryPoints: [file], bundle: true, format: "esm", platform: "neutral", write: false });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prices-"));
  try {
    const f = path.join(tmp, "m.mjs");
    fs.writeFileSync(f, out.outputFiles[0].text);
    return await import(pathToFileURL(f).href);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {{ usdIn?: number|null, usdOut?: number|null }} override  per 1M tokens, from the provider's page
 */
export async function loadPricing({ usdIn = null, usdOut = null } = {}) {
  const credits = await bundle(path.join(SHARED, "credits.ts"));
  const models = await bundle(path.join(SHARED, "model.ts"));
  for (const [name, v] of [
    ["credits.ts USD_PER_1M_INPUT", credits.USD_PER_1M_INPUT],
    ["credits.ts USD_PER_1M_OUTPUT", credits.USD_PER_1M_OUTPUT],
    ["credits.ts USD_PER_CREDIT", credits.USD_PER_CREDIT],
    ["model.ts VISION_USD_PER_1M_INPUT", models.VISION_USD_PER_1M_INPUT],
    ["model.ts VISION_USD_PER_1M_OUTPUT", models.VISION_USD_PER_1M_OUTPUT],
    ["model.ts ESSAY_USD_PER_1M_INPUT", models.ESSAY_USD_PER_1M_INPUT],
    ["model.ts ESSAY_USD_PER_1M_OUTPUT", models.ESSAY_USD_PER_1M_OUTPUT],
  ]) {
    if (!Number.isFinite(v)) throw new Error(`${name} is missing or not a number; refusing to price anything`);
  }
  if (typeof credits.creditsFor !== "function") throw new Error("credits.ts no longer exports creditsFor()");

  const table = {
    [models.SUMMARY_MODEL]: { in: credits.USD_PER_1M_INPUT, out: credits.USD_PER_1M_OUTPUT, source: "credits.ts" },
    [models.VISION_MODEL]: { in: models.VISION_USD_PER_1M_INPUT, out: models.VISION_USD_PER_1M_OUTPUT, source: "model.ts" },
    [models.ESSAY_MODEL]: { in: models.ESSAY_USD_PER_1M_INPUT, out: models.ESSAY_USD_PER_1M_OUTPUT, source: "model.ts (rates read off OpenAI's page by Jared, 25 Sep 2026)" },
  };
  const overridden = Number.isFinite(usdIn) && Number.isFinite(usdOut);

  return {
    usdPerCredit: credits.USD_PER_CREDIT,
    charsPerToken: credits.CHARS_PER_TOKEN,
    creditsFor: credits.creditsFor,
    shippedModel: models.SUMMARY_MODEL,
    essayModel: models.ESSAY_MODEL,
    /** The rate for a model, or null if nobody has supplied one. */
    priceFor(model) {
      if (overridden) return { in: usdIn, out: usdOut, source: "--usd-in/--usd-out" };
      return table[model] || null;
    },
  };
}

/** USD for one call's usage at a rate. Reasoning tokens are output tokens, and are billed as such. */
export const usdFor = (usage, price) =>
  price ? ((usage.prompt_tokens || 0) / 1e6) * price.in + ((usage.completion_tokens || 0) / 1e6) * price.out : null;
