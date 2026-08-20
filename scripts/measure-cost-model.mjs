/* ==================================================================
   measure-cost-model.mjs — the arithmetic behind COST-MODEL.md

   NOT part of `npm test`, and it deliberately adds no dependency to
   package.json. It needs a tokenizer, which is a large package that
   nothing else wants:

     npm i --no-save gpt-tokenizer
     node scripts/measure-cost-model.mjs

   WHY IT EXISTS: COST-MODEL.md is a document full of dollar figures,
   and a document full of dollar figures typed by hand is the
   restatement pattern in its most expensive costume — the numbers that
   set a price. Every table in that document is printed by this file,
   from the REAL prompt strings pulled out of the Edge Function sources
   and the REAL constants, so re-running it after a prompt change says
   what the change costs.

   WHAT IT CANNOT DO: reach a provider. Nothing here is a measurement of
   a bill. It is a model, and section 11 of the document is the
   procedure for checking it against two real dashboard readings.

   Published rates are the ones Jared verified on 20 August 2026 and are
   the only figures in here that are neither derived nor read from the
   source. The image-token model is NOT from that table — see
   IMAGE_TOKENS below, which carries its own provenance and is the one
   number the whole photo finding rests on.
   ================================================================== */

import { encode } from "gpt-tokenizer/model/gpt-4o-mini";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tok = (s) => encode(s).length;
const usd = (x) => "$" + (x < 0.01 ? x.toFixed(5) : x.toFixed(4));
const pad = (s, n) => String(s).padStart(n);

/* ---------- published rates (verified 20 Aug 2026) ---------- */
const GROQ_TURBO_PER_HOUR = 0.04;
const GROQ_LARGE_PER_HOUR = 0.111;
const MINI_IN = 0.15 / 1e6;
const MINI_OUT = 0.6 / 1e6;
const GROQ_PER_SECOND = GROQ_TURBO_PER_HOUR / 3600;

/* THE NUMBER THE PHOTO FINDING RESTS ON, and it is not in the rate
   table above. gpt-4o-mini does not bill images at gpt-4o's 85 + 170;
   it uses a token multiple that makes an image on the mini model cost
   about TWICE what the same image costs on gpt-4o. Corroborated from
   three independent write-ups of OpenAI's vision docs (OpenAI's own
   pages are unreachable from the build container). If this is wrong,
   the photo section of the document is wrong and nothing else is —
   which is why section 11's second reading is designed to falsify it
   with one unmistakable number. */
const MINI_IMAGE = { base: 2833, tile: 5667 };

/* ---------- assumptions, each one named in the document ---------- */
const WPM = 140; // lecture speech rate
const TOKENS_PER_WORD = 1.33; // spoken English
/* Characters per token for English prose.

   FROZEN, and the freezing is deliberate. Measuring it live off a file
   in this repository made every dollar figure in COST-MODEL.md wander a
   little each time CLAUDE.md was edited, which is a poor property in an
   instrument whose whole job is to be re-runnable. So it is a constant
   with a derivation and a CHECK: the script measures two real corpora
   below and shouts if the conservative end has moved away from this.

   4.2 is the conservative (densest) end of what was measured -- fewest
   characters per token means the most tokens for a given paste, which
   means the highest bill. Academic prose, which is what a reading
   actually is, sits between the two samples; picking the cheap end to
   make a table look better is how a cost model becomes marketing. */
const CHARS_PER_TOKEN = 4.2;

/* ---------- the real prompts, extracted from the real sources ---------- */
const notesSrc = fs.readFileSync(path.join(ROOT, "supabase/functions/ai-notes/openai.ts"), "utf8");
const grab = (re) => notesSrc.match(re)[1];
const depthRules = eval(grab(/const depthRules = (\[[\s\S]*?\])\.join\(" "\);/)).join(" ");
const base = eval(grab(/const base = (`[\s\S]*?`);/));
const ternary = notesSrc.match(/const systemPrompt = translateTo\s*\?\s*(`[\s\S]*?`)\s*:\s*(`[\s\S]*?`);/);
const SUMMARY_SCHEMA_OBJECT = eval("(" + grab(/const SUMMARY_SCHEMA_OBJECT = (\{[\s\S]*?\n\};)/).replace(/;$/, "") + ")");
const SYS_NOTES_TR = tok(eval(ternary[1].replace("${translateTo}", "es")));
const SYS_NOTES_NO = tok(eval(ternary[2]));
const SCHEMA = tok(JSON.stringify(eval("(" + grab(/const LECTURE_SUMMARY_SCHEMA = (\{[\s\S]*?\n\};)/).replace(/;$/, "") + ")")));

const { HELP_TOPICS } = await import(path.join(ROOT, "src/helpText.js"));
const HELP_PROSE = Object.values(HELP_TOPICS)
  .flatMap((t) => [t.what, t.example, t.cost, ...[].concat(t.detail || [])])
  .join(" ");

const { buildMessages } = await import(path.join(ROOT, "supabase/functions/ai-text/prompts.js"));
const sysTok = (task, body) => tok(buildMessages(task, body).find((m) => m.role === "system").content);
const SYS = {
  explain: sysTok("explain", { topic: "", text: "" }),
  weakspots: sysTok("weakspots", { topics: [] }),
  practice: sysTok("practice", { cards: [] }),
  summarise: sysTok("summarise", { text: "" }),
  merge: sysTok("merge", { parts: [] }),
  images: sysTok("summarise", { images: ["data:image/jpeg;base64,AA"] }),
};

/* English density, measured rather than assumed.

   THE SAMPLE IS THE APP'S OWN USER-FACING COPY, not CLAUDE.md, for two
   reasons. It is closer to what it is used to price -- ordinary prose a
   student pastes -- than dense technical Markdown full of tables and
   code is. And it is STABLE: measuring against a file that is edited
   every week makes every dollar figure in the document wander a little
   on each run, which is a bad property in an instrument whose whole job
   is to be re-runnable. */
const DENSITY = {
  "the app's own help copy (plain student-facing prose)": HELP_PROSE,
  "CLAUDE.md (dense technical Markdown)": fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8"),
};
const densities = Object.fromEntries(Object.entries(DENSITY).map(([k, v]) => [k, v.length / tok(v)]));
const conservative = Math.min(...Object.values(densities));

/* ---------- the models ---------- */
/* Output is NOT proportional to input: the schema is fixed and the depth
   rules scale entries with the number of distinct ideas, saturating at
   the 20 key points / 15 terms the prompt asks for. Calibrated against
   the one real measurement on record (a 4,772-char sample returned
   1,203 output tokens with a translation — see ai-notes/config.ts). */
const outputTokens = (minutes, translated) => {
  const perLanguage =
    120 + // overview, 3-5 sentences
    Math.min(20, Math.max(3, Math.round(minutes * 0.34))) * 34 + // key points
    Math.min(15, Math.max(3, Math.round(minutes * 0.24))) * 40 + // terms
    5 * 22 + // assessable
    3 * 18; // open questions
  return Math.round(perLanguage * (translated ? 2 : 1) * 1.08); // JSON overhead
};
const inputTokens = (minutes, translated) =>
  Math.round(minutes * WPM * TOKENS_PER_WORD) + (translated ? SYS_NOTES_TR : SYS_NOTES_NO) + SCHEMA;

const summariseCost = (minutes, translated) =>
  inputTokens(minutes, translated) * MINI_IN + outputTokens(minutes, translated) * MINI_OUT;
const lectureCost = (minutes, translated) => minutes * 60 * GROQ_PER_SECOND + summariseCost(minutes, translated);

/* OpenAI's tiling at detail:"high": fit inside 2048x2048, scale the
   SHORTEST side to 768, then cover with 512px tiles.

   `upscale` is the part I could not verify at the source. The documented
   wording ("scaled such that the shortest side is 768px") reads as both
   directions, and if it is, then sending a smaller photo saves nothing at
   all -- every portrait page arrives at the tiler as 768x1086. Both are
   printed so the document does not have to assert one. */
const tilesFor = (w, h, upscale = true) => {
  let s = Math.min(1, 2048 / Math.max(w, h));
  w *= s; h *= s;
  s = 768 / Math.min(w, h);
  if (s < 1 || upscale) { w *= s; h *= s; }
  return Math.ceil(w / 512) * Math.ceil(h / 512);
};
/* An A4 page photographed and downscaled by src/aiText.jsx's
   downscalePhoto to a 1536px long edge. */
const A4_TILES = tilesFor(1086, 1536);
const PHOTO_TOKENS = MINI_IMAGE.base + A4_TILES * MINI_IMAGE.tile;

const chars = (c) => Math.round(c / CHARS_PER_TOKEN);
const photoBatch = (k = 4) => (k * PHOTO_TOKENS + SYS.images + 20) * MINI_IN + 2000 * MINI_OUT;
const textChunk = (chars(20000) + SYS.summarise) * MINI_IN + 2000 * MINI_OUT;
const mergeCost = (chars(6000) + SYS.merge) * MINI_IN + 2000 * MINI_OUT;
const explainCost = (chars(4000) + SYS.explain) * MINI_IN + 600 * MINI_OUT;
const weakCost = (chars(6000) + SYS.weakspots) * MINI_IN + 800 * MINI_OUT;
const practiceCost = (chars(8000) + SYS.practice) * MINI_IN + 1500 * MINI_OUT;

/* ---------- report ---------- */
const out = [];
const say = (...a) => out.push(a.join(""));

say("MEASURED PROMPT OVERHEAD (gpt-tokenizer, o200k_base / gpt-4o-mini)\n");
say(`  ai-notes system prompt, no translation   ${pad(SYS_NOTES_NO, 6)} tokens\n`);
say(`  ai-notes system prompt, with translation ${pad(SYS_NOTES_TR, 6)} tokens\n`);
say(`  ai-notes json_schema, serialised         ${pad(SCHEMA, 6)} tokens\n`);
for (const [k, v] of Object.entries(SYS)) say(`  ai-text  ${k.padEnd(32)} ${pad(v, 6)} tokens\n`);
say(`  LONGEST PROMPT ${Math.max(SYS_NOTES_TR, ...Object.values(SYS))} tokens — below OpenAI's 1,024-token`);
say(" automatic-caching floor, so NOTHING here is a caching candidate.\n");
for (const [k, v] of Object.entries(densities))
  say(`  English density: ${v.toFixed(2)} chars/token \u2014 ${k}\n`);
say(`  the model uses ${CHARS_PER_TOKEN} (frozen); today\u2019s conservative measurement is ${conservative.toFixed(2)}`);
const drifted = Math.abs(conservative - CHARS_PER_TOKEN) / CHARS_PER_TOKEN > 0.05;
say(drifted ? "  <-- DRIFTED MORE THAN 5%, re-derive\n" : " \u2014 in step\n");

say("\nONE LECTURE\n");
say("  mins  transl   transcribe    in tok   out tok   summarise      TOTAL   per billed min\n");
for (const m of [3, 25, 50, 60, 90, 180])
  for (const t of [false, true]) {
    const billed = Math.max(m, 3);
    const c = lectureCost(m, t);
    say(
      `  ${pad(m, 4)}  ${pad(t ? "yes" : "no", 6)}   ${pad(usd(m * 60 * GROQ_PER_SECOND), 9)}  ` +
        `${pad(inputTokens(m, t), 8)}  ${pad(outputTokens(m, t), 8)}   ${pad(usd(summariseCost(m, t)), 9)}  ` +
        `${pad(usd(c), 9)}   ${pad(usd(c / billed), 9)}\n`
    );
  }
say(`  longest modelled output (180 min + translation): ${outputTokens(180, true)} tokens`);
say(` — SUMMARY_MAX_TOKENS is 8000, so the cap is not reached.\n`);

say("\nONE PHOTOGRAPHED PAGE\n");
say(`  A4 at a 1536px long edge -> ${A4_TILES} tiles of 512px\n`);
say("  does sending a SMALLER photo help? long edge -> tiles (upscaling / no upscaling)\n");
for (const edge of [1536, 1024, 768]) {
  const w = Math.round(edge / 1.414);
  say(`    ${pad(edge, 5)}px (${w}x${edge})  ${tilesFor(w, edge, true)} tiles / ${tilesFor(w, edge, false)} tiles\n`);
}
say(`  gpt-4o-mini  ${PHOTO_TOKENS} input tokens   ${usd(PHOTO_TOKENS * MINI_IN)}\n`);
const assumed = 85 + A4_TILES * 170;
say(`  what ai-text/config.ts assumes (85 + 170/tile): ${assumed} tokens  ${usd(assumed * MINI_IN)}`);
say(`  — ${(PHOTO_TOKENS / assumed).toFixed(0)}x too low\n`);
say(`\n  a batch of 4 pages   ${pad(Math.round(4 * PHOTO_TOKENS + SYS.images + 20), 8)} in tok   ${usd(photoBatch())}   3 units\n`);
say(`  a 20,000-char chunk  ${pad(chars(20000) + SYS.summarise, 8)} in tok   ${usd(textChunk)}   3 units   `);
say(`ratio ${(photoBatch() / textChunk).toFixed(1)}x\n`);

const HOUR = lectureCost(60, true);
const READING16 = 4 * photoBatch() + mergeCost;
say("\nTHE HEADLINE COMPARISON\n");
say(`  one hour of lecture, transcribed + summarised + translated   ${usd(HOUR)}\n`);
say(`  a 16-page reading photographed (4 batches + a merge)         ${usd(READING16)}   ${(READING16 / HOUR).toFixed(1)}x\n`);

say("\nCOST PER ACTION, every input and output at its ceiling\n");
const actions = [
  ["explain", explainCost, 1], ["weakspots", weakCost, 1], ["practice", practiceCost, 2],
  ["summarise (text)", textChunk, 3], ["summarise (4 photos)", photoBatch(), 3], ["merge", mergeCost, 1],
];
for (const [n, c, u] of actions) say(`  ${n.padEnd(22)} ${pad(usd(c), 9)}  ${u} unit(s)  ${pad(usd(c / u), 9)} per unit\n`);

say("\nSCENARIOS\n");
const light = 2 * lectureCost(50, false) + 4 * explainCost;
const photoReading8 = 2 * photoBatch() + mergeCost;
const typical = 8 * lectureCost(50, false) + 2 * photoReading8 + 10 * explainCost + 5 * practiceCost + 5 * weakCost;
say(`  Light   2 x 50-min lectures + 4 explains                       ${usd(light)}\n`);
say(`  Typical 8 x 50-min + 2 x 8-page photo readings + 20 text       ${usd(typical)}\n`);
say(`          of which the photos are ${usd(2 * photoReading8)} (${((200 * photoReading8) / typical).toFixed(0)}%)\n`);

say("\nCAP-HITTING, composed the most expensive LEGAL way\n");
const RESUMMARISE_MINUTES = 2;
for (const cap of [300, 900, 3000]) {
  const clips = Math.floor(cap / 3);
  const A = clips * lectureCost(3, true);
  const longs = Math.floor(cap / 180);
  const B = longs * lectureCost(180, true);
  const retries = Math.floor((cap - 180) / RESUMMARISE_MINUTES);
  const C = lectureCost(180, true) + retries * summariseCost(180, true);
  const photos = Math.floor(150 / 3) * photoBatch();
  say(`  ${cap} minutes\n`);
  say(`    ${pad(clips, 5)} x 3-min clips, translated                      ${usd(A)}\n`);
  say(`    ${pad(longs, 5)} x 180-min lectures, translated                 ${usd(B)}\n`);
  say(`    1 x 180-min + ${retries} re-summarises of it   ${pad(usd(C), 9)}  <-- WORST\n`);
  say(`    + 150 text units spent entirely on photo batches      ${usd(photos)}\n`);
  say(`    WORST TOTAL                                           ${usd(C + photos)}\n`);
}

say("\nMINIMUM_BILLED_MINUTES, re-derived with a tokenizer instead of chars/4\n");
const shortSummary = inputTokens(5, true) * MINI_IN + 1203 * MINI_OUT;
say(`  a short lecture's summary   ${usd(shortSummary)}\n`);
say(`  one billed minute buys      ${usd(60 * GROQ_PER_SECOND)}\n`);
say(`  floor needed                ${(shortSummary / (60 * GROQ_PER_SECOND)).toFixed(2)} minutes; 3 ships\n`);
say(`  config.ts TYPICAL_SUMMARY_INPUT_TOKENS = 1600 (estimated); measured equivalent ${inputTokens(5, true)}\n`);

say("\nTRANSCRIPTION MODEL\n");
say(`  whisper-large-v3-turbo (what ships)  ${usd(GROQ_TURBO_PER_HOUR)}/hr\n`);
say(`  whisper-large-v3                     ${usd(GROQ_LARGE_PER_HOUR)}/hr  (${(GROQ_LARGE_PER_HOUR / GROQ_TURBO_PER_HOUR).toFixed(1)}x)\n`);

/* ==================================================================
   THE PHOTO MODEL COMPARISON (section 12 of COST-MODEL.md)

   The models we call today TILE images. The newer mini and nano models
   PATCH them: 32x32 patches, a per-model patch budget, a per-model
   multiplier, billed at ordinary text rates. The two schemes behave in
   opposite ways when you send a smaller photo, which is the whole
   reason this block exists rather than a single number.

   RATES ARE THIRD-HAND. OpenAI's own pages are unreachable from this
   container; these came from search results that agreed with each
   other, and they are the figures the recommendation is least sure of.
   Section 12 says which ones matter and how to settle them.
   ================================================================== */

const CANDIDATES = {
  "gpt-4o-mini (today)": { in: 0.15 / 1e6, out: 0.60 / 1e6, tiles: { base: 2833, tile: 5667 } },
  "gpt-5.4-mini": { in: 0.75 / 1e6, out: 4.50 / 1e6, patch: { budget: 1536, multiplier: 1.62 } },
  "gpt-5.4-nano": { in: 0.20 / 1e6, out: 1.25 / 1e6, patch: { budget: 1536, multiplier: 2.46 } },
};

const patchesFor = (w, h) => Math.ceil(w / 32) * Math.ceil(h / 32);
function patchTokens(w, h, { budget, multiplier }) {
  let patches = patchesFor(w, h);
  if (patches > budget) {
    /* Shrink to fit the budget, then land the width on a whole patch
       boundary and scale the height by that same adjusted factor. The
       second step is what takes a raw 0.9711 to 0.9428 on our page, and
       leaving it out gets the answer wrong by ~8%. */
    const shrink = Math.sqrt((32 * 32 * budget) / (w * h));
    const wPatches = Math.floor((w * shrink) / 32);
    const adjusted = (wPatches * 32) / w;
    w = wPatches * 32;
    h = Math.floor(h * adjusted);
    patches = patchesFor(w, h);
  }
  return { patches, tokens: Math.round(patches * multiplier) };
}
const pageTokens = (model, w, h) =>
  model.patch ? patchTokens(w, h, model.patch).tokens : model.tiles.base + tilesFor(w, h) * model.tiles.tile;
/* downscalePhoto keeps the aspect ratio; an A4 page is 1:1.414. */
const a4At = (edge) => [Math.round(edge / 1.414), edge];

say("\nPHOTO MODEL CANDIDATES — one A4 page, by maxEdge\n");
say("  maxEdge   " + Object.keys(CANDIDATES).map((k) => pad(k, 22)).join("") + "\n");
for (const edge of [1536, 1280, 1024, 896, 768]) {
  const [w, h] = a4At(edge);
  const cells = Object.values(CANDIDATES).map((m) => {
    const t = pageTokens(m, w, h);
    return pad(`${t} tok ${usd(t * m.in)}`, 22);
  });
  say(`  ${pad(edge + "px", 7)}   ${cells.join("")}\n`);
}
say("  SENDING A SMALLER PHOTO: no effect under tiling, LINEAR under patches until the budget stops binding.\n");

/* detail:"original" raises the budget to 10,000 patches (max_dim 6,000),
   so nothing is resized and the cost is exactly what we chose to send.
   It is also what the docs recommend for OCR and small text, which is
   what a photographed page of print is. */
say("\n  detail:\"original\" (budget 10,000, no resize) — the page is billed exactly as sent\n");
for (const edge of [1536, 1024, 768]) {
  const [w, h] = a4At(edge);
  const cells = Object.entries(CANDIDATES)
    .filter(([, m]) => m.patch)
    .map(([name, m]) => {
      const t = patchTokens(w, h, { ...m.patch, budget: 10000 }).tokens;
      return pad(`${name.split("-").pop()} ${t} tok ${usd(t * m.in)}`, 26);
    });
  say(`    ${pad(edge + "px", 7)}  ${cells.join("")}\n`);
}

say("\nA BATCH OF 4 PAGES, and a whole 16-page reading\n");
say("  model                 maxEdge   batch in   batch out    batch      16 pages   vs today\n");
const todayBatch = (() => {
  const m = CANDIDATES["gpt-4o-mini (today)"];
  const [w, h] = a4At(1536);
  return (4 * pageTokens(m, w, h) + SYS.images + 20) * m.in + 2000 * m.out;
})();
for (const [name, m] of Object.entries(CANDIDATES)) {
  for (const edge of [1536, 1024]) {
    const [w, h] = a4At(edge);
    const inTok = 4 * pageTokens(m, w, h) + SYS.images + 20;
    const batch = inTok * m.in + 2000 * m.out;
    /* A 16-page reading is 4 batches plus one merge. The merge is TEXT,
       so it is priced on whichever model handles text -- gpt-4o-mini
       unless the whole task moves. Both shown by keeping the merge on
       the same model as the batch, which is the pessimistic reading. */
    const merge = (chars(6000) + SYS.merge) * m.in + 2000 * m.out;
    say(
      `  ${pad(name, 21)} ${pad(edge + "px", 7)}  ${pad(usd(inTok * m.in), 9)}  ${pad(usd(2000 * m.out), 9)}  ` +
        `${pad(usd(batch), 9)}  ${pad(usd(4 * batch + merge), 9)}  ${pad((todayBatch / batch).toFixed(2) + "x", 8)}\n`
    );
  }
}

say("\nTHE HALF NOBODY EXPECTED: the OUTPUT price, on a 2,000-token ceiling\n");
for (const [name, m] of Object.entries(CANDIDATES))
  say(`  ${pad(name, 21)} 2,000 output tokens = ${usd(2000 * m.out)}\n`);
say("  On gpt-5.4-mini the summary costs more than the four photos it is about.\n");

say("\nWHAT ELSE WOULD MOVE IF THE WHOLE `summarise` TASK MOVED\n");
for (const [name, m] of Object.entries(CANDIDATES)) {
  const textChunkHere = (chars(20000) + SYS.summarise) * m.in + 2000 * m.out;
  const lectureHere = inputTokens(60, true) * m.in + outputTokens(60, true) * m.out;
  say(
    `  ${pad(name, 21)} a 20k text chunk ${pad(usd(textChunkHere), 9)}   a 60-min lecture summary ${pad(usd(lectureHere), 9)}\n`
  );
}

say("\nWHAT A CREDIT WOULD BE WORTH (preview of the single-currency pass)\n");
const perBilledMinute = lectureCost(50, false) / 50;
say(`  1 credit = 1 minute of recorded lecture = ${usd(perBilledMinute)}\n`);
const asCredits = (c) => Math.max(1, Math.ceil(c / perBilledMinute));
say(`  a 20,000-char text chunk            ${pad(asCredits(textChunk), 4)} credits   (TASK_UNITS.summarise is 3 today)\n`);
for (const [name, m] of Object.entries(CANDIDATES)) {
  for (const edge of [1536, 1024]) {
    const [w, h] = a4At(edge);
    const batch = (4 * pageTokens(m, w, h) + SYS.images + 20) * m.in + 2000 * m.out;
    say(`  a 4-photo batch, ${pad(name, 21)} @${pad(edge + "px", 7)} ${pad(asCredits(batch), 4)} credits\n`);
  }
}

say("\nSECTION 11 PREDICTIONS (what the dashboards should show)\n");
say(`  A. one 50-minute lecture, no translation\n`);
say(`       Groq    50.0 min of audio           ${usd(50 * 60 * GROQ_PER_SECOND)}\n`);
say(`       OpenAI  ${inputTokens(50, false)} in / ${outputTokens(50, false)} out    ${usd(summariseCost(50, false))}\n`);
say(`       TOTAL ${usd(lectureCost(50, false))}   (+/-20% band ${usd(lectureCost(50, false) * 0.8)} to ${usd(lectureCost(50, false) * 1.2)})\n`);
const PHOTO_BATCH_TOKENS = 4 * PHOTO_TOKENS + SYS.images + 20;
const MERGE_TOKENS = chars(6000) + SYS.merge;
const in16 = 4 * PHOTO_BATCH_TOKENS + MERGE_TOKENS;
say(`  B. one 16-photo reading summary\n`);
say(`       OpenAI  ${in16} input tokens / ~10,000 output   ${usd(READING16)}\n`);
say(`       (+/-20% band ${usd(READING16 * 0.8)} to ${usd(READING16 * 1.2)})\n`);
say(`       THE DISCRIMINATING NUMBER is the input token count. ~${Math.round(in16 / 1000)}k confirms this model;\n`);
say(`       ~${Math.round((4 * (4 * assumed + SYS.images + 20) + chars(6000) + SYS.merge) / 1000)}k means the 85+170 image model is right and photos are cheap.\n`);

console.log(out.join(""));

/* Per-action input token counts, so the document does not hand-type them. */
const rows = [
  ["explain", chars(4000) + SYS.explain, 600],
  ["weakspots", chars(6000) + SYS.weakspots, 800],
  ["practice", chars(8000) + SYS.practice, 1500],
  ["summarise (text)", chars(20000) + SYS.summarise, 2000],
  ["summarise (4 photos)", PHOTO_BATCH_TOKENS, 2000],
  ["merge", MERGE_TOKENS, 2000],
];
console.log("\nPER-ACTION TOKEN COUNTS");
for (const [n, i, o] of rows) console.log(`  ${n.padEnd(22)} ${pad(i, 8)} in  ${pad(o, 6)} out`);
