/* ==================================================================
   photo-calls.mjs — the shared half of the two photo instruments

   `measure-photo-gates.mjs` asks whether the bill matches the
   arithmetic and whether a model can READ a photographed page.
   `measure-photo-prompt.mjs` asks whether a prompt change improved the
   note. Different claims, different scripts — but both have to send
   the SAME BYTES the app would send and make the SAME CALL, or neither
   number is about production. That is what lives here.

   Nothing in this file decides anything. It prepares photos, makes a
   call, and reports what came back.
   ================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* THE DOWNSCALE IS DERIVED FROM THE APP, not retyped beside it.

   These two numbers decide how many tokens a page costs, and
   MEASURED_PHOTO_BATCH_INPUT_TOKENS in _shared/model.ts is a bill for
   ONE configuration — so a script that measured a different maxEdge
   than the app sends would produce a figure that prices nothing. That
   is the restatement ledger's shape with a price on the end of it, so
   the defaults are read out of `downscalePhoto`'s own signature. */
export function appDownscale() {
  const src = fs.readFileSync(path.join(ROOT, "src/aiText.jsx"), "utf8");
  const m = src.match(/function downscalePhoto\([^)]*\{([^}]*)\}\s*=\s*\{\}\)/);
  if (!m) throw new Error("could not find downscalePhoto's defaults in src/aiText.jsx");
  const maxEdge = Number((m[1].match(/maxEdge\s*=\s*(\d+)/) || [])[1]);
  const quality = Number((m[1].match(/quality\s*=\s*([\d.]+)/) || [])[1]);
  if (!Number.isFinite(maxEdge) || !Number.isFinite(quality)) {
    throw new Error(`could not read maxEdge/quality from: ${m[1]}`);
  }
  return { maxEdge, quality };
}

/** sharp if it is installed, else null. The caller must say so. */
export async function loadSharp() {
  try {
    const { default: sharp } = await import("sharp");
    return sharp;
  } catch {
    /* Reported by the caller rather than swallowed: without it the
       bytes sent are not the bytes the app sends, which changes every
       token count. */
    return null;
  }
}

/**
 * One photo, prepared the way the app prepares it.
 * Without sharp the ORIGINAL is sent and `resized` is false — which the
 * caller must print, because the token counts are then not the app's.
 */
export async function preparePhoto(sharp, file, { maxEdge, quality }) {
  const raw = fs.readFileSync(file);
  if (!sharp) {
    return { dataUrl: `data:image/jpeg;base64,${raw.toString("base64")}`, w: null, h: null, resized: false };
  }
  const img = sharp(raw).rotate(); // honour EXIF, as a browser canvas does
  const meta = await img.metadata();
  const scale = Math.min(1, maxEdge / Math.max(meta.width, meta.height));
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  const out = await img.resize(w, h).jpeg({ quality: Math.round(quality * 100) }).toBuffer();
  return { dataUrl: `data:image/jpeg;base64,${out.toString("base64")}`, w, h, resized: true };
}

/**
 * One chat completion. Returns { json } or { error }.
 *
 * THE CEILING'S NAME IS DECIDED BY THE MODEL FAMILY. The GPT-5 family
 * takes `max_completion_tokens` and REJECTS `max_tokens`; gpt-4o-mini
 * is the other way round. Both are live in this repo at once —
 * VISION_MODEL is a GPT-5 model and SUMMARY_MODEL is not — so getting
 * it wrong here is a 400 on every call, and the same branch is pinned
 * by a test against the real adapter.
 */
/* `jsonSchema` IS OPTIONAL AND THE DEFAULT IS UNCHANGED. Four scripts
   share this function; the photo harnesses and the photo-gate
   measurement run under JSON mode and their recorded token counts are
   a bill for THAT configuration, so changing the default here would
   quietly re-price every photo measurement on its next run. The essay
   scripts pass a strict schema because they need an enum enforced; the
   rest pass nothing and get exactly what they had. */
export async function callVision({ apiKey, model, messages, maxTokens, jsonSchema = null }) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        response_format: jsonSchema ? { type: "json_schema", json_schema: jsonSchema } : { type: "json_object" },
        ...(model.startsWith("gpt-5") ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      }),
    });
    const json = await res.json();
    if (!res.ok) return { error: `HTTP ${res.status}`, json };
    return { json };
  } catch (err) {
    return { error: err.message };
  }
}
