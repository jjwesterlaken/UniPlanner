/* ==================================================================
   measure-criteria-photos.mjs — does "photograph your criteria" work?

   The `criteria` task transcribes marking criteria from up to four
   photographs so the essay check can read the criteria's OWN band
   names. This sends the SHIPPED configuration: the prompt out of
   ai-text/prompts.js through its own buildMessages, the vision model
   out of _shared/model.ts, the task's output ceiling out of config.ts,
   and the photos downscaled with the app's own settings (read out of
   src/aiText.jsx). A transcription made any other way would be evidence
   about something we do not ship.

   IT ANSWERS THREE QUESTIONS, and says which it can and cannot:

     1. FIDELITY. With --truth (a .txt of the criteria as typed from the
        original), it reports word recall and precision against the
        truth, and — the one that decides whether the feature works —
        every BAND NAME in the truth that does not appear verbatim in
        the transcription. A missing or reworded band is a band the
        essay feedback can no longer name. Without --truth it prints
        the transcription for a person to read against the photo.
     2. PRICE. The ruling is 18 credits a batch, derived from the
        measured input of a photographed READING (MEASURED_PHOTO_BATCH_
        INPUT_TOKENS) plus this task's output ceiling. This prints the
        input tokens a rubric really costs and the weight they would
        imply, so a rubric that is much denser than a page of reading
        shows up as a different number rather than as a guess.
     3. HEADROOM. Completion tokens against the ceiling. finish_reason
        "length" is a truncated rubric, which the adapter turns into a
        hard error in the app.

   What it cannot see: whether the STRUCTURE is right (a criterion's
   bands grouped under it) beyond what a person reads off the printout,
   and anything about a model other than the one that ships.

   ------------------------------------------------------------------
   USAGE

     npm i --no-save sharp
     export OPENAI_API_KEY=sk-...
     node scripts/measure-criteria-photos.mjs rubric1.jpg [rubric2.jpg ...] [--truth rubric.txt]

   Up to four photos: one batch, exactly as the app sends it. Run it
   once per rubric; three or four different rubrics (a table, a
   screenshot of an LMS page, a phone photo of a printout) say more
   than one rubric run four times. One call each, about a cent.

   Options:
     --truth <file>   the criteria typed out from the original, for the
                      fidelity numbers
     --dry-run        resolve the prompt, model, ceiling and price, and
                      stop: no key, no photo and no spend
   ================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ROOT, appDownscale, loadSharp, preparePhoto, callVision } from "./lib/photo-calls.mjs";

const argv = process.argv.slice(2);
let truthFile = null;
let dryRun = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--truth") truthFile = argv[++i];
  else if (argv[i] === "--dry-run") dryRun = true;
  else files.push(argv[i]);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!dryRun && (!apiKey || files.length === 0)) {
  console.error("usage: OPENAI_API_KEY=sk-... node scripts/measure-criteria-photos.mjs <rubric1.jpg> [... up to 4] [--truth rubric.txt]");
  process.exit(1);
}
if (files.length > 4) {
  console.error(`${files.length} photos: the app sends at most 4 in one batch, so this would measure a request it never makes.`);
  process.exit(1);
}
for (const f of [...files, ...(truthFile ? [truthFile] : [])]) {
  if (!fs.existsSync(f)) {
    console.error(`no such file: ${f}`);
    process.exit(1);
  }
}

/* ---------- the shipped configuration, read rather than restated ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-measure-"));
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(
  entry,
  [
    `export { MAX_TOKENS, PHOTO_BATCH_CREDITS, TASK_CREDITS } from ${JSON.stringify(path.join(ROOT, "supabase/functions/ai-text/config.ts"))};`,
    `export { USD_PER_CREDIT, creditsFor } from ${JSON.stringify(path.join(ROOT, "supabase/functions/_shared/credits.ts"))};`,
    `export { VISION_MODEL, VISION_USD_PER_1M_INPUT, VISION_USD_PER_1M_OUTPUT, MEASURED_PHOTO_BATCH_INPUT_TOKENS } from ${JSON.stringify(path.join(ROOT, "supabase/functions/_shared/model.ts"))};`,
  ].join("\n")
);
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "cfg.mjs"), logLevel: "silent" });
const cfg = await import(pathToFileURL(path.join(tmp, "cfg.mjs")).href);
const prompts = await import(pathToFileURL(path.join(ROOT, "supabase/functions/ai-text/prompts.js")).href);
fs.rmSync(tmp, { recursive: true, force: true });

const ceiling = cfg.MAX_TOKENS.criteria;
const model = cfg.VISION_MODEL;
const usd = (inTok, outTok) => inTok * (cfg.VISION_USD_PER_1M_INPUT / 1e6) + outTok * (cfg.VISION_USD_PER_1M_OUTPUT / 1e6);
const system = prompts.buildMessages("criteria", { images: ["data:image/jpeg;base64,AA"] })[0].content;

console.log(`\nmodel ${model}, ceiling ${ceiling} output tokens, prompt ${system.length} chars`);
console.log(`charged: ${cfg.TASK_CREDITS.criteria} credits a batch (PHOTO_BATCH_CREDITS ${cfg.PHOTO_BATCH_CREDITS}), derived from ${cfg.MEASURED_PHOTO_BATCH_INPUT_TOKENS} measured input tokens of a photographed reading`);
if (!Number.isInteger(ceiling) || ceiling <= 0 || cfg.TASK_CREDITS.criteria !== cfg.PHOTO_BATCH_CREDITS) {
  console.error("the shipped configuration is not the one this script was written for: the criteria task has no ceiling, or is not priced as a photo batch");
  process.exit(1);
}
if (dryRun) {
  console.log("dry run — nothing was called and nothing was spent.");
  process.exit(0);
}

/* ---------- the photos, prepared as the app prepares them ---------- */

const downscale = appDownscale();
const sharp = await loadSharp();
if (!sharp) {
  console.error("sharp is not installed: npm i --no-save sharp");
  process.exit(1);
}
const photos = [];
for (const f of files) photos.push(await preparePhoto(sharp, f, downscale));
console.log(`photos: ${files.length}, downscaled to maxEdge ${downscale.maxEdge} at quality ${downscale.quality}, as the app does`);

const messages = prompts.buildMessages("criteria", { images: photos.map((p) => p.dataUrl) });
const started = Date.now();
const { json, error } = await callVision({ apiKey, model, messages, maxTokens: ceiling });
if (error) {
  console.error(`the call failed: ${error}\n${JSON.stringify(json || {}).slice(0, 600)}`);
  process.exit(1);
}
const inTok = json?.usage?.prompt_tokens ?? null;
const outTok = json?.usage?.completion_tokens ?? null;
const finish = json?.choices?.[0]?.finish_reason;
const raw = json?.choices?.[0]?.message?.content || "";

/* Through the app's OWN parser, so what is reported is what a student
   would get in the box, not what the model said. */
let outcome;
let transcription = "";
try {
  transcription = prompts.parseTaskResult("criteria", raw).criteria;
  outcome = "transcribed";
} catch (e) {
  outcome = e.unreadablePages ? `refused as unreadable: photos ${e.unreadablePages.join(", ")}` : e.noCriteria ? "no criteria found (free)" : `unusable reply (free): ${e.message}`;
}

console.log(`\n==== RESULT (${((Date.now() - started) / 1000).toFixed(1)}s) ====`);
console.log(`outcome: ${outcome}`);
console.log(`input tokens:  ${inTok}   (a photographed reading's batch measured ${cfg.MEASURED_PHOTO_BATCH_INPUT_TOKENS})`);
console.log(`output tokens: ${outTok} of ${ceiling}${finish === "length" ? "  <- TRUNCATED: the app would refuse this rubric" : ""}   finish_reason ${finish}`);
if (inTok !== null) {
  const implied = cfg.creditsFor(usd(inTok, ceiling));
  const actual = usd(inTok, outTok || 0);
  console.log(`this batch at the ceiling would price at ${implied} credits (charged ${cfg.PHOTO_BATCH_CREDITS}); its actual cost was $${actual.toFixed(5)}`);
  if (implied !== cfg.PHOTO_BATCH_CREDITS) console.log("  -> A RUBRIC OF THIS DENSITY IS NOT THE PRICE THE RULING SET. Report the input tokens.");
}

if (transcription) {
  console.log("\n---- transcription (what lands in the box) ----\n" + transcription + "\n----");
}

/* ---------- fidelity, against the truth ---------- */

if (truthFile && transcription) {
  const truth = fs.readFileSync(truthFile, "utf8");
  const words = (t) => (t.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || []);
  const bag = (list) => list.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map());
  const tW = words(truth);
  const oW = words(transcription);
  const overlap = (a, b) => {
    const B = bag(b);
    let n = 0;
    for (const w of a) if (B.get(w) > 0) (B.set(w, B.get(w) - 1), n++);
    return n;
  };
  const hit = overlap(tW, oW);
  console.log(`\nword recall    ${((100 * hit) / Math.max(1, tW.length)).toFixed(1)}%  (${hit} of ${tW.length} words of the truth are in the transcription)`);
  console.log(`word precision ${((100 * overlap(oW, tW)) / Math.max(1, oW.length)).toFixed(1)}%  (words the transcription added that the truth does not have lower this)`);

  /* THE BAND NAMES, verbatim. "<name>: descriptor" lines in the truth
     name the bands; each must appear in the transcription exactly, case
     aside, or the essay feedback cannot name it. */
  const bands = [...new Set(truth.split(/\r?\n/).map((l) => (l.match(/^\s*([^:\n]{1,40}?)\s*:/) || [])[1]).filter(Boolean))];
  const lower = transcription.toLowerCase();
  const missing = bands.filter((b) => !lower.includes(b.toLowerCase()));
  console.log(`band names     ${bands.length - missing.length} of ${bands.length} verbatim${missing.length ? `  MISSING: ${missing.join(" | ")}` : ""}`);
  if (bands.length === 0) console.log("  (the truth has no \"<band>: descriptor\" lines, so no band names were checked)");
}

console.log("\nPaste the block from ==== RESULT onward, without the transcription if the rubric is not yours to share.");
