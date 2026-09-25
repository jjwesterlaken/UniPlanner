/* ==================================================================
   production-model.mjs — which model the FEATURE will use, for a
   harness that must not measure a stand-in.

   THE BUG THIS REPLACES, and it is the ledger's first entry wearing a
   fallback:

     model = (src.match(/SUMMARY_MODEL\s*=\s*"([^"]+)"/) || [])[1]
             || "gpt-4o-mini";

   Two faults in one line. It RESTATES the constant as a regex, so a
   rename, a reformat, a type annotation or a move stops it matching.
   And when it stops matching it FALLS BACK to a hardcoded model
   string — silently, printing `model gpt-4o-mini` on its own header
   line, which is exactly what a correct derivation looks like.

   The two are only harmless while the fallback equals the truth. That
   is the colour-coincidence class: a stand-in indistinguishable from
   the real thing until the day the real thing moves, which is the one
   day nobody is looking at the line that did not follow.

   ------------------------------------------------------------------
   SO IT ASKS THE QUESTION THE ADAPTER ASKS.

   `modelFor({ hasImages })` in `_shared/model.ts` is what
   `ai-text/openai.ts` calls to pick a model, and it is what this
   calls. Reading the constant NAMED `SUMMARY_MODEL` is a different
   question: it happens to give the same answer for a text-only
   feature, and "happens to" is the word this file exists to remove.

   ------------------------------------------------------------------
   IT BUNDLES RATHER THAN IMPORTING THE .ts DIRECTLY, and that is
   about whose laptop this runs on.

   Node imports TypeScript only under type stripping, unflagged from
   22.18. `.nvmrc` says 22, so a colleague on 22.10 would find a direct
   import UNRUNNABLE rather than failing — the `_shared/photoCap.js`
   decision, written down in CLAUDE.md, and the same shape as the
   Windows `.bin` shim. These measurement scripts are the ones most
   likely to be run by hand on a machine nobody here has seen, so they
   get the mechanism that does not care: esbuild, which the repository
   already depends on and which `test-ai-text-function.mjs` uses for
   this very file.

   ------------------------------------------------------------------
   AND IT REFUSES RATHER THAN GUESSING. Every failure here — the file
   moved, the export renamed, the bundle broken — throws with the
   reason. A harness that cannot say what it is about to call has
   nothing worth spending money on.
   ================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_TS = path.join(ROOT, "supabase/functions/_shared/model.ts");

/**
 * The model an `ai-text` request with this medium would be sent to.
 *
 * `hasImages` defaults to FALSE and every caller here passes it
 * explicitly, because the default is the thing worth being deliberate
 * about: essay feedback is text-only and paste-only, so the day it
 * takes a photograph this is the call site that has to change rather
 * than a number in a report that quietly stopped being true.
 *
 * `modelSource` exists so a test can point this at a module that has
 * LOST its selector and require the refusal — the audioSources.js
 * arrangement, where the environment is an argument so the awkward
 * cases are a table rather than something only a real run can reach.
 * Nothing but a test ever passes it, and the default is the real file.
 */
export async function productionModel({ hasImages = false, task = null, modelSource = MODEL_TS } = {}) {
  const source = modelSource;
  if (!fs.existsSync(source)) {
    throw new Error(
      `cannot determine the production model: ${path.relative(ROOT, source)} is not there.\n` +
        "Refusing rather than guessing — a harness that cannot say what it is about to call is not worth paying for."
    );
  }

  let build;
  try {
    ({ build } = await import("esbuild"));
  } catch {
    throw new Error(
      "cannot determine the production model: esbuild is not installed.\n" +
        "Run `npm install` in the repository root first — the model is read from the Edge Function's own source, not typed into this script."
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prod-model-"));
  try {
    const out = await build({
      entryPoints: [source],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
    });
    const file = path.join(tmp, "model.mjs");
    fs.writeFileSync(file, out.outputFiles[0].text);
    const mod = await import(pathToFileURL(file).href);

    if (typeof mod.modelFor !== "function") {
      throw new Error(
        "_shared/model.ts no longer exports modelFor(), which is the function the ai-text adapter uses to pick a model.\n" +
          "Refusing rather than reading a constant by name: which constant applies is the question, and guessing it is how a harness measures a stand-in."
      );
    }
    const model = mod.modelFor({ hasImages, task });
    if (typeof model !== "string" || !model.trim()) {
      throw new Error(`modelFor({ hasImages: ${hasImages}, task: ${JSON.stringify(task)} }) returned ${JSON.stringify(model)} rather than a model id.`);
    }
    return model;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
