/* ==================================================================
   measure-photo-gates.mjs — COST-MODEL.md 12.7's two gates, runnable

   Gate 1 (COST): does the documented image tokenisation match the bill?
   There is an unresolved report of a 1920x1080 PNG billing ~66,000
   prompt tokens on gpt-5.4-mini where the arithmetic says ~2,400 — 27x
   — and we send exactly that shape: a base64 data URL from a canvas.
   If it reproduces, the mechanism is wrong and the recommendation is
   void.

   Gate 2 (QUALITY): can the candidate actually READ a photographed page
   of print? OCR of a phone photo is the hardest thing we ask of a
   model, and a cheap feature that garbles the reading is worth
   nothing. THIS GATE REVERSED ITS OWN FIRST ANSWER: nano passed on 16
   September on "every date and figure correct", and failed on a second
   reading of the same output, which had invented a term and welded two
   claims into a false sentence. Read the notes against the pages, and
   read them twice.

   THIS SCRIPT MAKES THE CALLS AND PRINTS BOTH ANSWERS. It does not
   decide anything: gate 2 is a judgement about four summaries you have
   to read, so it prints them side by side and stops.

   ------------------------------------------------------------------
   USAGE

     export OPENAI_API_KEY=sk-...
     node scripts/measure-photo-gates.mjs page1.jpg page2.jpg page3.jpg page4.jpg

   Four photographs of consecutive pages of a real reading, taken the
   way a student would — a phone, a page of print, whatever light was
   available. NOT screenshots and NOT clean PDF exports: the thing being
   tested is whether a model can read a photograph, and a clean render
   answers a different and easier question.

   It costs real money. At the documented rates the whole run is well
   under a cent; if gate 1 fails it could be a few cents. That is the
   point of running it.

   ------------------------------------------------------------------
   WHAT IT DOES, and why each part is there

   1. Downscales each photo the way the app does — src/aiText.jsx's
      downscalePhoto, maxEdge 1024, JPEG quality 0.8 — using sharp if it
      is available, so the bytes sent are the bytes the app would send.
      Without sharp it sends the originals and says so, which changes
      the token counts and is flagged rather than hidden.

   2. Calls each candidate with the app's REAL vision prompt, pulled out
      of supabase/functions/ai-text/prompts.js rather than retyped.

   3. Prints prompt_tokens as the API reports them, beside what this
      repo's arithmetic predicts, with the ratio. That ratio IS gate 1.

   4. Prints each summary so gate 2 can be judged.

   Needs: npm i --no-save sharp   (optional, but read (1))
   ================================================================== */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, appDownscale, loadSharp, preparePhoto, callVision } from "./lib/photo-calls.mjs";

/* ---------- the candidates, and what each one is being asked ---------- */

const CANDIDATES = [
  {
    name: "gpt-4o-mini",
    label: "the control — the previous VISION_MODEL",
    detail: "high",
    /* Tiles. 2,833 base + 5,667 a tile.

       THIS USED TO HARDCODE SIX TILES, and that is the whole reason the
       control read as "out of band" on 16 September 2026: a portrait A4
       page at maxEdge 1536 IS 6 tiles, so the constant was right about
       the configuration it was written for and wrong about the one the
       script sends, which is 1024. At 771x1024 the shortest side scales
       768/771, the long side lands at 1020, and that is 2x2 = 4 tiles.

       Computed from the real dimensions now, it predicts 102,210 for
       four pages against 102,210 reported — EXACT. The tiling model was
       never in doubt; the prediction had stopped reading its own
       inputs. Same shape as every other entry in the restatement
       ledger, in a `predict` function. */
    predict: (w, h) => {
      const scale = 768 / Math.min(w, h);
      const tiles = Math.ceil((w * scale) / 512) * Math.ceil((h * scale) / 512);
      return 2833 + tiles * 5667;
    },
  },
  {
    name: "gpt-5.4-nano",
    label: "cheaper, and REJECTED on gate 2 -- see COST-MODEL 12.11",
    detail: "original",
    predict: (w, h) => patchTokens(w, h, 2.46),
  },
  {
    name: "gpt-5.4-mini",
    label: "THE SHIPPED VISION_MODEL",
    detail: "original",
    predict: (w, h) => patchTokens(w, h, 1.62),
  },
];

/* 32x32 patches, budget 10,000 at detail:"original" (1,536 at high), a
   per-model multiplier, billed at ordinary text rates. The second step
   of the shrink — land the width on a whole patch boundary, then scale
   the height by THAT adjusted factor — is what makes the arithmetic
   come out; leaving it off is ~8% wrong. */
function patchTokens(w, h, multiplier, budget = 10000) {
  const patches = (a, b) => Math.ceil(a / 32) * Math.ceil(b / 32);
  let p = patches(w, h);
  if (p > budget) {
    const shrink = Math.sqrt((32 * 32 * budget) / (w * h));
    const wPatches = Math.floor((w * shrink) / 32);
    const adjusted = (wPatches * 32) / w;
    w = wPatches * 32;
    h = Math.floor(h * adjusted);
    p = patches(w, h);
  }
  return Math.round(p * multiplier);
}

/* ---------- the app's real prompt, extracted rather than retyped ---------- */

const { buildMessages, parseTaskResult } = await import(pathToFileURL(path.join(ROOT, "supabase/functions/ai-text/prompts.js")).href);

/* ---------- input ---------- */

const files = process.argv.slice(2);
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || files.length === 0) {
  console.error(
    "usage: OPENAI_API_KEY=sk-... node scripts/measure-photo-gates.mjs <page1.jpg> [page2.jpg ...]\n\n" +
      "Four photographs of consecutive pages of a real reading, photographed the way a\n" +
      "student would. Screenshots and clean PDF exports answer an easier question than\n" +
      "the one gate 2 asks."
  );
  process.exit(1);
}
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`no such file: ${f}`);
    process.exit(1);
  }
}

/* ---------- downscale the way the app does ---------- */

/* maxEdge and quality are READ OUT OF src/aiText.jsx's own signature,
   not retyped here — they decide how many tokens a page costs, and a
   script measuring a different downscale than the app sends produces a
   figure that prices nothing. scripts/lib/photo-calls.mjs. */
const downscale = appDownscale();
const sharp = await loadSharp();

const pages = [];
for (const f of files) pages.push(await preparePhoto(sharp, f, downscale));

console.log(`\n${files.length} page${files.length === 1 ? "" : "s"}`);
if (!sharp) {
  console.log(`  !! sharp is not installed, so the ORIGINALS were sent, not a ${downscale.maxEdge}px downscale.`);
  console.log("     Token counts below are for those bytes and are NOT what the app would bill.");
  console.log("     Install it and re-run:  npm i --no-save sharp");
} else {
  for (let i = 0; i < pages.length; i++) {
    console.log(`  page ${i + 1}: ${pages[i].w}x${pages[i].h}, ${Math.round(pages[i].dataUrl.length / 1024)} KB of base64`);
  }
}

/* ---------- the calls ---------- */

const messages = buildMessages("summarise", { images: pages.map((p) => p.dataUrl) });

/* The app sends detail per image; this script varies it per candidate,
   because "original" is what 12.3 recommends and is not what ships. */
const withDetail = (msgs, detail) =>
  msgs.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.map((c) => (c.type === "image_url" ? { ...c, image_url: { ...c.image_url, detail } } : c)) }
      : m
  );

const results = [];
for (const cand of CANDIDATES) {
  process.stdout.write(`\ncalling ${cand.name} (detail: ${cand.detail}) ... `);
  const started = Date.now();
  /* The ceiling's NAME depends on the model family, and both families
     are live here at once — scripts/lib/photo-calls.mjs carries that
     branch, so the two photo instruments cannot disagree about it. */
  const { json, error } = await callVision({
    apiKey,
    model: cand.name,
    messages: withDetail(messages, cand.detail),
    maxTokens: 2000,
  });
  if (error) {
    console.log(`FAILED (${error})`);
    if (json) console.log(`  ${JSON.stringify(json).slice(0, 400)}`);
    results.push({ cand, error });
    continue;
  }
  console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  results.push({ cand, json });
}

/* ---------- GATE 1 ---------- */

console.log("\n\n================ GATE 1: does the bill match the arithmetic? ================\n");
console.log("  model            predicted   reported   ratio    verdict");
let gate1 = true;
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.cand.name.padEnd(15)} ${"—".padStart(9)}  ${r.error}`);
    gate1 = false;
    continue;
  }
  /* Without sharp there are no real dimensions, so the prediction falls
     back to an A4 page at the app's maxEdge — which is what the app
     WOULD have sent. The banner above already says the reported count
     is not comparable in that case. */
  const perPage = r.cand.predict(pages[0].w || 724, pages[0].h || 1024);
  /* The prompt and the wrapper are text tokens on top of the images.
     Small (~200) beside any image figure, and included so the
     comparison is like for like rather than flattering. */
  const predicted = perPage * pages.length + 210;
  const reported = r.json?.usage?.prompt_tokens ?? 0;
  const ratio = reported / predicted;
  const ok = ratio > 0.8 && ratio < 1.25;
  if (!ok) gate1 = false;
  console.log(
    `  ${r.cand.name.padEnd(15)} ${String(predicted).padStart(9)}  ${String(reported).padStart(9)}  ` +
      `${ratio.toFixed(2)}x    ${ok ? "ok" : "*** OUT OF BAND ***"}`
  );
}
console.log(
  gate1
    ? "\n  GATE 1 PASSES. The documented tokenisation is what gets billed, on the shape\n" +
        "  we actually send. The 66,000-token report does not reproduce here."
    : "\n  GATE 1 FAILS or could not be completed. If a reported count is many times the\n" +
        "  prediction, the 66,000-token report is real, the photo recommendation in\n" +
        "  COST-MODEL.md 12.7 is void, and nothing should be re-weighted on it."
);

/* ---------- GATE 2 ---------- */

console.log("\n\n================ GATE 2: can it read the page? (you judge) ================");
console.log("\n  Read these against the actual pages. What matters is whether the model READ");
console.log("  them — names, numbers, the argument — not whether the prose is nice. A");
console.log("  refusal naming unreadable pages is a PASS for legibility handling; a");
console.log("  confident summary of a page it misread is the worst outcome available.\n");
for (const r of results) {
  console.log(`\n---------------- ${r.cand.name}  (${r.cand.label}) ----------------`);
  if (r.error) {
    console.log(`  no result: ${r.error}`);
    continue;
  }
  const content = r.json?.choices?.[0]?.message?.content || "";
  const finish = r.json?.choices?.[0]?.finish_reason;
  if (finish === "length") console.log("  !! hit the output ceiling — truncated, which the app treats as a hard failure");
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.unreadable)) {
      console.log(`  REFUSED as illegible, pages: ${parsed.unreadable.join(", ")}`);
      continue;
    }
    /* RENDERED THROUGH THE APP'S OWN PARSER, which is the difference
       between showing what the MODEL said and showing what a STUDENT
       would get — and the first version showed the former.

       On 16 September gpt-4o-mini returned `assessable` and
       `openQuestions` as STRINGS where the schema declares [string].
       This block read the raw JSON and iterated, so a string iterated
       BY CHARACTER and printed as 82 and 90 single-letter entries. That
       display was this script's; production did something quieter and
       worse, silently dropping both fields to []. Both are fixed —
       asArray coerces a lone string to one entry now — and gate 2 is a
       judgement about the SAVED NOTE, so it has to be judged on what
       the parser produces. */
    const shaped = parseTaskResult("summarise", content);
    console.log(`\n  overview: ${shaped.overview || "(none)"}\n`);
    for (const k of ["keyPoints", "assessable", "openQuestions"]) {
      const list = shaped[k] || [];
      console.log(`  ${k} (${list.length}):`);
      for (const item of list) console.log(`    - ${item}`);
    }
    console.log(`  terms (${shaped.terms.length}):`);
    for (const t of shaped.terms) console.log(`    - ${t.term}: ${t.content}`);
  } catch {
    console.log("  output did not parse as JSON — the app treats this as ai_failed_charged:");
    console.log(`  ${content.slice(0, 800)}`);
  }
  const u = r.json?.usage || {};
  console.log(`\n  usage: ${u.prompt_tokens} in / ${u.completion_tokens} out`);
}

console.log("\n\n================ WHAT TO DO WITH THIS ================\n");
console.log("  BOTH GATES RAN ON 16 SEPTEMBER 2026 AND THE SWAP SHIPPED. COST-MODEL.md 12.9");
console.log("  records the numbers; this script is now a RE-measurement tool rather than a");
console.log("  decision procedure. Re-run it whenever VISION_MODEL, maxEdge or the detail");
console.log("  setting moves, because MEASURED_PHOTO_BATCH_INPUT_TOKENS in _shared/model.ts");
console.log("  is what PHOTO_BATCH_CREDITS is derived from and it is a bill for ONE");
console.log("  configuration: four pages, 771x1024, detail \"original\".");
console.log("");
console.log("  A COUNT BELOW PREDICTION IS NOT THE FAILURE THIS GATE WAS BUILT FOR. It exists");
console.log("  to catch a bill MANY TIMES the arithmetic — the 66,000-token report. Under is");
console.log("  conservative; over is the thing that voids a price. Read the direction, not");
console.log("  just the band.\n");
