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
     2. PRICE. A criteria batch is priced from its OWN measured input
        (MEASURED_CRITERIA_BATCH_INPUT_TOKENS in ai-text/config.ts), at
        the size criteria photos are really sent (CRITERIA_PHOTO_MAX_EDGE).
        --diagnose measures it; an ordinary run prints what its own
        batch would price at, so a denser rubric shows up as a number.
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
     --diagnose       ONE photo: the control arms and the price (below)
     --dry-run        resolve the prompt, model, ceiling and price, and
                      stop: no key, no photo and no spend

   --diagnose, and why it exists. rubric3 (a phone photo of a printed
   page, 27 September 2026) came back as two bullet points from a page
   with far more text, and reported success. Two explanations fit that,
   and they need different fixes: the 1,024px downscale left the lower
   page illegible, so the model transcribed what it could read; or the
   photo is the task-description page, and two bullets were genuinely
   the only criteria on it. So it runs five calls on the one photo:

     A  criteria prompt @ 1024   (the configuration that produced it)
     B  criteria prompt @ CRITERIA_PHOTO_MAX_EDGE   (what now ships)
     C  read-everything @ 1024   (a DIAGNOSTIC prompt, never shipped:
                                  transcribe every word on the page)
     D  read-everything @ CRITERIA_PHOTO_MAX_EDGE
     E  criteria prompt @ CRITERIA_PHOTO_MAX_EDGE with the photo TWICE

   C against D says whether the page is legible at each size; A against
   C says whether the criteria prompt left out text it could read. B and
   E together price it: E minus B is one photo's tokens at the shipped
   size, B minus that is the prompt's, and a four-photo batch is the
   prompt plus four photos — two measured points, not a modelled
   multiplier. It prints the constant to set.
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
let diagnose = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--truth") truthFile = argv[++i];
  else if (argv[i] === "--dry-run") dryRun = true;
  else if (argv[i] === "--diagnose") diagnose = true;
  else files.push(argv[i]);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!dryRun && (!apiKey || files.length === 0)) {
  console.error("usage: OPENAI_API_KEY=sk-... node scripts/measure-criteria-photos.mjs <rubric1.jpg> [... up to 4] [--truth rubric.txt] [--diagnose]");
  process.exit(1);
}
if (files.length > 4) {
  console.error(`${files.length} photos: the app sends at most 4 in one batch, so this would measure a request it never makes.`);
  process.exit(1);
}
if (diagnose && files.length !== 1) {
  console.error("--diagnose takes exactly ONE photo: its arms compare one page at two sizes.");
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
    `export { MAX_TOKENS, TASK_CREDITS, MEASURED_CRITERIA_BATCH_INPUT_TOKENS, CRITERIA_PHOTO_ON } from ${JSON.stringify(path.join(ROOT, "supabase/functions/ai-text/config.ts"))};`,
    `export { creditsFor } from ${JSON.stringify(path.join(ROOT, "supabase/functions/_shared/credits.ts"))};`,
    `export { VISION_MODEL, VISION_USD_PER_1M_INPUT, VISION_USD_PER_1M_OUTPUT } from ${JSON.stringify(path.join(ROOT, "supabase/functions/_shared/model.ts"))};`,
  ].join("\n")
);
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "cfg.mjs"), logLevel: "silent" });
const cfg = await import(pathToFileURL(path.join(tmp, "cfg.mjs")).href);
fs.rmSync(tmp, { recursive: true, force: true });
const prompts = await import(pathToFileURL(path.join(ROOT, "supabase/functions/ai-text/prompts.js")).href);
const limits = await import(pathToFileURL(path.join(ROOT, "src/aiTextLimits.js")).href);

const ceiling = cfg.MAX_TOKENS.criteria;
const model = cfg.VISION_MODEL;
const shippedEdge = limits.CRITERIA_PHOTO_MAX_EDGE;
const usd = (inTok, outTok) => inTok * (cfg.VISION_USD_PER_1M_INPUT / 1e6) + outTok * (cfg.VISION_USD_PER_1M_OUTPUT / 1e6);
const priceOf = (batchIn) => cfg.creditsFor(usd(batchIn, ceiling));
const system = prompts.buildMessages("criteria", { images: ["data:image/jpeg;base64,AA"] })[0].content;

console.log(`\nmodel ${model}, ceiling ${ceiling} output tokens, photos at maxEdge ${shippedEdge}, prompt ${system.length} chars`);
console.log(
  cfg.CRITERIA_PHOTO_ON
    ? `charged: ${cfg.TASK_CREDITS.criteria} credits a batch, from MEASURED_CRITERIA_BATCH_INPUT_TOKENS ${cfg.MEASURED_CRITERIA_BATCH_INPUT_TOKENS}`
    : "charged: nothing yet — MEASURED_CRITERIA_BATCH_INPUT_TOKENS is unset, so the task is off. --diagnose prints the value to set."
);
if (!Number.isInteger(ceiling) || ceiling <= 0 || !Number.isInteger(shippedEdge)) {
  console.error("the shipped configuration is not the one this script was written for: no criteria ceiling, or no CRITERIA_PHOTO_MAX_EDGE");
  process.exit(1);
}
if (dryRun) {
  console.log("dry run — nothing was called and nothing was spent.");
  process.exit(0);
}

const downscale = appDownscale();
const sharp = await loadSharp();
if (!sharp) {
  console.error("sharp is not installed: npm i --no-save sharp");
  process.exit(1);
}

const words = (t) => (String(t || "").toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || []);
const call = async (messages) => {
  const { json, error } = await callVision({ apiKey, model, messages, maxTokens: ceiling });
  if (error) return { error: `${error} ${JSON.stringify(json || {}).slice(0, 300)}` };
  return {
    inTok: json?.usage?.prompt_tokens ?? null,
    outTok: json?.usage?.completion_tokens ?? null,
    finish: json?.choices?.[0]?.finish_reason,
    raw: json?.choices?.[0]?.message?.content || "",
  };
};
/* Through the app's OWN parser, so the outcome is what a student gets. */
const outcomeOf = (raw) => {
  try {
    return { kind: "transcribed", text: prompts.parseTaskResult("criteria", raw).criteria };
  } catch (e) {
    if (e.criteriaPartial) return { kind: "PARTIAL (free)", text: e.criteriaPartial.criteria, missed: e.criteriaPartial.missed };
    if (e.unreadablePages) return { kind: `unreadable (photos ${e.unreadablePages.join(", ")})`, text: "" };
    if (e.noCriteria) return { kind: "no criteria found (free)", text: "" };
    return { kind: `unusable (free): ${e.message}`, text: "" };
  }
};

/* ---------- --diagnose: one photo, five calls ---------- */

if (diagnose) {
  const at = async (edge) => preparePhoto(sharp, files[0], { maxEdge: edge, quality: downscale.quality });
  const small = await at(1024);
  const big = await at(shippedEdge);
  console.log(`photo at 1024: ${small.w}x${small.h}, ${small.dataUrl.length} base64 chars; at ${shippedEdge}: ${big.w}x${big.h}, ${big.dataUrl.length} chars`);
  if (big.dataUrl.length > 700_000) console.log(`  -> OVER the server's 700,000-char image cap at ${shippedEdge}: the app would refuse this photo as too large.`);

  /* The diagnostic prompt reads EVERYTHING, so it can say what is
     legible; it is never shipped and changes nothing in the app. */
  const readAll = (img) => [
    { role: "system", content: 'Transcribe every word visible in the image, word for word, top to bottom. Reply with JSON only: {"text":string}.' },
    { role: "user", content: [{ type: "image_url", image_url: { url: img.dataUrl, detail: "original" } }] },
  ];
  const arms = [
    ["A criteria @1024", prompts.buildMessages("criteria", { images: [small.dataUrl] }), "criteria"],
    [`B criteria @${shippedEdge}`, prompts.buildMessages("criteria", { images: [big.dataUrl] }), "criteria"],
    ["C read-all @1024", readAll(small), "all"],
    [`D read-all @${shippedEdge}`, readAll(big), "all"],
    [`E criteria @${shippedEdge}, photo twice`, prompts.buildMessages("criteria", { images: [big.dataUrl, big.dataUrl] }), "criteria"],
  ];
  const got = {};
  for (const [label, messages, kind] of arms) {
    process.stdout.write(`calling ${label} ... `);
    const r = await call(messages);
    if (r.error) {
      console.log(`FAILED ${r.error}`);
      got[label[0]] = r;
      continue;
    }
    let text = "";
    let outcome = "";
    if (kind === "all") {
      try {
        text = JSON.parse(r.raw).text || "";
      } catch {
        text = "";
      }
      outcome = "read-all";
    } else {
      const o = outcomeOf(r.raw);
      text = o.text;
      outcome = o.kind + (o.missed ? ` — missed: ${o.missed.join("; ")}` : "");
    }
    got[label[0]] = { ...r, words: words(text).length, text };
    console.log(`${r.inTok} in / ${r.outTok} out, ${words(text).length} words, finish ${r.finish}, ${outcome}`);
  }

  console.log("\n==== DIAGNOSIS ====");
  const w = (k) => (got[k] && Number.isFinite(got[k].words) ? got[k].words : null);
  console.log(`words read: A ${w("A")}  B ${w("B")}  C ${w("C")}  D ${w("D")}`);
  if (w("C") !== null && w("D") !== null) {
    if (w("D") > 1.3 * w("C")) console.log("  the page is MORE LEGIBLE at the larger size (D reads much more than C): resolution was a cause.");
    else console.log("  the page reads about the same at both sizes (C ≈ D): resolution was NOT the limiting factor.");
  }
  if (w("A") !== null && w("C") !== null && w("C") > 3 * Math.max(1, w("A"))) {
    console.log("  at 1024 the model could read far more of the page (C) than the criteria prompt returned (A).");
    console.log("  Read the C text below: if the rest is task description rather than criteria, A was CORRECT to leave it out.");
  }
  console.log("\n---- C: everything legible at 1024 ----\n" + ((got.C && got.C.text) || "") + "\n----");
  console.log(`\n---- B: what the shipped configuration puts in the box ----\n${(got.B && got.B.text) || ""}\n----`);

  if (got.B && got.E && Number.isFinite(got.B.inTok) && Number.isFinite(got.E.inTok)) {
    const perPhoto = got.E.inTok - got.B.inTok;
    const promptTok = got.B.inTok - perPhoto;
    const batch4 = promptTok + 4 * perPhoto;
    console.log(`\n==== PRICE (at ${shippedEdge}px, this prompt) ====`);
    console.log(`one photo ${perPhoto} tokens, the prompt ${promptTok}; a four-photo batch ${batch4}`);
    console.log(`MEASURED_CRITERIA_BATCH_INPUT_TOKENS = ${batch4}  ->  ${priceOf(batch4)} credits a batch at the ${ceiling}-token ceiling`);
    console.log("That is ONE photo's density; a denser rubric photo costs more. Send me this block from two or three rubrics and I set the largest.");
  }
  console.log("\nPaste everything from ==== DIAGNOSIS onward, without the texts if the rubric is not yours to share.");
  process.exit(0);
}

/* ---------- an ordinary run: the shipped configuration ---------- */

const photos = [];
for (const f of files) photos.push(await preparePhoto(sharp, f, { maxEdge: shippedEdge, quality: downscale.quality }));
console.log(`photos: ${files.length}, downscaled to maxEdge ${shippedEdge} at quality ${downscale.quality}, as the app does for criteria`);

const started = Date.now();
const r = await call(prompts.buildMessages("criteria", { images: photos.map((p) => p.dataUrl) }));
if (r.error) {
  console.error(`the call failed: ${r.error}`);
  process.exit(1);
}
const o = outcomeOf(r.raw);

console.log(`\n==== RESULT (${((Date.now() - started) / 1000).toFixed(1)}s) ====`);
console.log(`outcome: ${o.kind}${o.missed ? ` — missed: ${o.missed.join("; ")}` : ""}`);
console.log(`input tokens:  ${r.inTok}`);
console.log(`output tokens: ${r.outTok} of ${ceiling}${r.finish === "length" ? "  <- TRUNCATED: the app would refuse this rubric" : ""}   finish_reason ${r.finish}`);
if (Number.isFinite(r.inTok)) console.log(`this batch at the ceiling would price at ${priceOf(r.inTok)} credits; its actual cost was $${usd(r.inTok, r.outTok || 0).toFixed(5)}`);
if (o.text) console.log("\n---- transcription (what lands in the box) ----\n" + o.text + "\n----");

if (truthFile && o.text) {
  const truth = fs.readFileSync(truthFile, "utf8");
  const bag = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const tW = words(truth);
  const oW = words(o.text);
  const overlap = (a, b) => {
    const B = bag(b);
    let n = 0;
    for (const x of a) if (B.get(x) > 0) (B.set(x, B.get(x) - 1), n++);
    return n;
  };
  const hit = overlap(tW, oW);
  console.log(`\nword recall    ${((100 * hit) / Math.max(1, tW.length)).toFixed(1)}%  (${hit} of ${tW.length} words of the truth are in the transcription)`);
  console.log(`word precision ${((100 * overlap(oW, tW)) / Math.max(1, oW.length)).toFixed(1)}%`);
  const bands = [...new Set(truth.split(/\r?\n/).map((l) => (l.match(/^\s*([^:\n]{1,40}?)\s*:/) || [])[1]).filter(Boolean))];
  const lower = o.text.toLowerCase();
  const missing = bands.filter((b) => !lower.includes(b.toLowerCase()));
  console.log(`band names     ${bands.length - missing.length} of ${bands.length} verbatim${missing.length ? `  MISSING: ${missing.join(" | ")}` : ""}`);
}

console.log("\nPaste the block from ==== RESULT onward, without the transcription if the rubric is not yours to share.");
