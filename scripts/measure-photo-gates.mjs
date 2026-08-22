/* ==================================================================
   measure-photo-gates.mjs — COST-MODEL.md 12.7's two gates, runnable

   Gate 1 (COST): does the documented image tokenisation match the bill?
   There is an unresolved report of a 1920x1080 PNG billing ~66,000
   prompt tokens on gpt-5.4-mini where the arithmetic says ~2,400 — 27x
   — and we send exactly that shape: a base64 data URL from a canvas.
   If it reproduces, the mechanism is wrong and the recommendation is
   void.

   Gate 2 (QUALITY): can gpt-5.4-nano actually READ a photographed page
   of print? It is the cheapest model in the family and OCR of a phone
   photo is the hardest thing we would ask of it. A cheap feature that
   garbles the reading is worth nothing.

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
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- the candidates, and what each one is being asked ---------- */

const CANDIDATES = [
  {
    name: "gpt-4o-mini",
    label: "the control — what ships today",
    detail: "high",
    /* Tiles. 2,833 base + 5,667 a tile, and the tiler normalises the
       SHORTEST side to 768px in both directions, so a portrait page is
       always 6 tiles whatever we send. */
    predict: () => 2833 + 6 * 5667,
  },
  {
    name: "gpt-5.4-nano",
    label: "THE RECOMMENDATION",
    detail: "original",
    predict: (w, h) => patchTokens(w, h, 2.46),
  },
  {
    name: "gpt-5.4-mini",
    label: "the fallback if nano cannot read a page",
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

const { buildMessages } = await import(path.join(ROOT, "supabase/functions/ai-text/prompts.js"));

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

const MAX_EDGE = 1024; // src/aiText.jsx downscalePhoto, per COST-MODEL 12.7
const QUALITY = 0.8;

let sharp = null;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  /* Reported below rather than swallowed: without it the bytes sent are
     not the bytes the app sends, which changes every token count. */
}

async function prepare(file) {
  const raw = fs.readFileSync(file);
  if (!sharp) return { dataUrl: `data:image/jpeg;base64,${raw.toString("base64")}`, w: null, h: null, resized: false };
  const img = sharp(raw).rotate(); // honour EXIF, as a browser canvas does
  const meta = await img.metadata();
  const scale = Math.min(1, MAX_EDGE / Math.max(meta.width, meta.height));
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  const out = await img.resize(w, h).jpeg({ quality: Math.round(QUALITY * 100) }).toBuffer();
  return { dataUrl: `data:image/jpeg;base64,${out.toString("base64")}`, w, h, resized: true };
}

const pages = [];
for (const f of files) pages.push(await prepare(f));

console.log(`\n${files.length} page${files.length === 1 ? "" : "s"}`);
if (!sharp) {
  console.log("  !! sharp is not installed, so the ORIGINALS were sent, not a 1024px downscale.");
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
  let res, json;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cand.name,
        messages: withDetail(messages, cand.detail),
        response_format: { type: "json_object" },
        /* The GPT-5 family takes max_completion_tokens and counts
           reasoning against it; gpt-4o-mini takes max_tokens. Sending
           the wrong one is a 400, which is itself worth learning here
           rather than during the migration. */
        ...(cand.name.startsWith("gpt-5") ? { max_completion_tokens: 2000 } : { max_tokens: 2000 }),
      }),
    });
    json = await res.json();
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    results.push({ cand, error: err.message });
    continue;
  }
  if (!res.ok) {
    console.log(`HTTP ${res.status}`);
    console.log(`  ${JSON.stringify(json).slice(0, 400)}`);
    results.push({ cand, error: `HTTP ${res.status}` });
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
    console.log(`\n  overview: ${parsed.overview || "(none)"}\n`);
    for (const k of ["keyPoints", "assessable", "openQuestions"]) {
      const list = parsed[k] || [];
      console.log(`  ${k} (${list.length}):`);
      for (const item of list) console.log(`    - ${item}`);
    }
    const terms = parsed.terms || [];
    console.log(`  terms (${terms.length}):`);
    for (const t of terms) console.log(`    - ${t.term}: ${t.content}`);
  } catch {
    console.log("  output did not parse as JSON — the app treats this as ai_failed_charged:");
    console.log(`  ${content.slice(0, 800)}`);
  }
  const u = r.json?.usage || {};
  console.log(`\n  usage: ${u.prompt_tokens} in / ${u.completion_tokens} out`);
}

console.log("\n\n================ WHAT TO DO WITH THIS ================\n");
console.log("  gate 1 passes and nano reads the pages   -> ship the recommendation:");
console.log("     VISION_MODEL = gpt-5.4-nano, detail \"original\", maxEdge 1024,");
console.log("     PHOTO_BATCH_CREDITS = 6, and update its three mirrors together.");
console.log("  gate 1 passes and nano misreads          -> gpt-5.4-mini instead, and say so:");
console.log("     worse economics (~19 credits a batch), a feature that works.");
console.log("  gate 1 fails                             -> stop. Re-derive before anything moves.\n");
