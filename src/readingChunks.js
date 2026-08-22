/* ==================================================================
   readingChunks.js — splitting a long reading, and pricing it first

   Pure. No React, no browser globals, no network — so the awkward cases
   (a 25,000-character paragraph, an overlap that lands mid-word, a
   merge that never ran) are exercisable directly from Node.

   WHAT THIS FEATURE IS, because the wording rule depends on it: a
   student pastes a piece of a reading they already have and gets
   something to revise from — key points, terms, what to focus on. It
   assumes they have done or will do the reading. See READING_COPY in
   aiTextCopy.js and the test that greps it.

   THE SOURCE TEXT IS NEVER STORED. Not in the planner blob, not in
   `ai_notes`, not on the server: `ai-text` writes only `ai_usage` and
   reads only `profiles`, so the pasted text exists in memory, goes to
   the provider, and is gone. That is a stronger promise than the
   lecture path can make — that one keeps a transcript for 7 or 30 days
   — and the published documents say so in those terms rather than
   blurring the two.
   ================================================================== */

import { TASK_CREDITS, PHOTO_BATCH_CREDITS } from "./aiTextLimits.js";

/* MIRRORS supabase/functions/ai-text/config.ts. Both are asserted equal
   by a test rather than trusted to a comment — see the restatement rule
   in CLAUDE.md. */
export const CHUNK_MAX_CHARS = 20_000; // MAX_INPUT_CHARS.summarise
export const MAX_READING_CHUNKS = 4;

/** The longest reading this will take in one go. */
export const READING_MAX_CHARS = CHUNK_MAX_CHARS * MAX_READING_CHUNKS;

/* Carried from the tail of one chunk into the head of the next, so a
   claim that spans a boundary appears whole in at least one of them.
   ~200 characters is two or three sentences: enough to carry an
   argument across, small enough that the duplication costs nothing
   worth counting against the input cap.

   The merge prompt is told the sections overlap. Without that the model
   reports the repetition as emphasis. */
export const CHUNK_OVERLAP_CHARS = 200;

/* ------------------------------------------------------------------ */
/*  Splitting                                                         */
/* ------------------------------------------------------------------ */

const normalise = (text) => String(text || "").replace(/\r\n?/g, "\n");

/** Paragraphs, in order, blank lines removed. */
function paragraphs(text) {
  return normalise(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/* A single paragraph longer than a whole chunk. Rare but real: dense
   academic prose runs to thousands of words without a break, and it is
   exactly the kind of reading this feature is for. Split on sentence
   ends rather than mid-word — a chunk boundary through the middle of a
   clause is where a summary goes wrong. */
function splitLongParagraph(para, limit) {
  const sentences = para.match(/[^.!?]+[.!?]+[\])'"`’”]*\s*|[^.!?]+$/g) || [para];
  const out = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length > limit) {
      out.push(current.trim());
      current = "";
    }
    /* A single sentence over the limit has no smaller natural boundary,
       so it is cut on length. Losing the sentence entirely would be
       worse than one awkward join. */
    if (s.length > limit) {
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit).trim());
      continue;
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** The tail of a chunk, trimmed forward to a word boundary. */
function overlapFrom(chunk, chars = CHUNK_OVERLAP_CHARS) {
  if (!chunk || chunk.length <= chars) return chunk || "";
  const tail = chunk.slice(-chars);
  const space = tail.search(/\s/);
  return space === -1 ? tail : tail.slice(space + 1);
}

/**
 * Split a reading into chunks a `summarise` call can each take.
 *
 * Returns `{ ok: true, chunks }`, or `{ ok: false, code }` for empty
 * input and for a reading past READING_MAX_CHARS. The ceiling is a
 * refusal with a number rather than a silent trim: quietly summarising
 * the first three quarters of someone's reading and presenting it as
 * the whole thing is the worst outcome available here.
 */
export function chunkReading(text, { maxChars = CHUNK_MAX_CHARS, maxChunks = MAX_READING_CHUNKS } = {}) {
  const clean = normalise(text).trim();
  if (!clean) return { ok: false, code: "empty" };
  if (clean.length > maxChars * maxChunks) {
    return { ok: false, code: "too_long", chars: clean.length, limit: maxChars * maxChunks };
  }

  /* Every chunk after the first carries an overlap, so pack to the
     smaller budget throughout rather than discovering afterwards that
     the overlap pushed a chunk over the cap the server enforces. */
  const budget = maxChars - CHUNK_OVERLAP_CHARS;

  const pieces = [];
  for (const p of paragraphs(clean)) {
    if (p.length > budget) pieces.push(...splitLongParagraph(p, budget));
    else pieces.push(p);
  }

  const packed = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 2 + piece.length > budget) {
      packed.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) packed.push(current);

  const chunks = packed.map((c, i) => (i === 0 ? c : `${overlapFrom(packed[i - 1])}\n\n${c}`));
  return { ok: true, chunks };
}

/* ------------------------------------------------------------------ */
/*  Pricing, before the work                                          */
/* ------------------------------------------------------------------ */

/**
 * What a reading will cost, computed from the text alone.
 *
 * MANDATORY before any call. The whole point of the client mirroring
 * the arithmetic is that a student learns the cost before pasting is
 * turned into spending — and for readings it matters more than for the
 * other tasks, because the cost is variable and nothing on screen would
 * otherwise hint that a longer reading costs four times as much.
 *
 * `credits` is what it will cost. It is not rendered as a raw number
 * here — aiTextCopy.js turns `chunks` into parts, because parts are
 * what a refusal's advice is in ("paste a shorter piece") — but a
 * credit is a sayable quantity now: one minute of recorded lecture.
 */
export function estimateReading(text, opts = {}) {
  const split = chunkReading(text, opts);
  if (!split.ok) return { ok: false, ...split, chars: normalise(text).trim().length };
  const chunks = split.chunks.length;
  const credits = chunks * (TASK_CREDITS.summarise || 0) + (chunks > 1 ? TASK_CREDITS.merge || 0 : 0);
  return { ok: true, chars: normalise(text).trim().length, chunks, credits, chunkTexts: split.chunks };
}

/* ------------------------------------------------------------------ */
/*  Photographed pages                                                */
/* ------------------------------------------------------------------ */

/* Mirrors the server's PHOTOS_PER_CHUNK / MAX_READING_PHOTOS in
   ai-text/config.ts -- a browser bundle cannot import from
   supabase/functions/, so these are restatements and a test asserts
   the equality, per the standing rule. */
export const PHOTOS_PER_CHUNK = 4;
export const MAX_READING_PHOTOS = 16;

/**
 * Batch photos exactly the way chunkReading splits text: each batch of
 * up to PHOTOS_PER_CHUNK pages is one `summarise` request, and more
 * than one batch means a merge. That symmetry is the whole pricing
 * story -- photos ride the text pipeline, in parts, with no second
 * scheme to keep in step.
 */
export function batchPhotos(count, { perChunk = PHOTOS_PER_CHUNK, maxPhotos = MAX_READING_PHOTOS } = {}) {
  if (!Number.isInteger(count) || count < 1) return { ok: false, code: "empty" };
  if (count > maxPhotos) {
    return { ok: false, code: "too_many", count, maxPhotos };
  }
  const batches = [];
  for (let start = 0; start < count; start += perChunk) {
    batches.push({ start, size: Math.min(perChunk, count - start) });
  }
  return { ok: true, batches };
}

/**
 * The photo estimate, in the same shape estimateReading returns.
 *
 * A batch is priced by PHOTO_BATCH_CREDITS rather than by
 * TASK_CREDITS.summarise, even though the two are equal today. They are
 * equal because the photo price is HELD pending the model decision, not
 * because a batch of photographed pages costs what a text chunk costs —
 * it costs about eleven times as much on the model we call. Reading the
 * held constant is what makes lifting the hold change this number
 * instead of requiring somebody to notice this line.
 */
export function estimatePhotos(count, opts = {}) {
  const split = batchPhotos(count, opts);
  if (!split.ok) return { ok: false, ...split };
  const chunks = split.batches.length;
  const credits = chunks * (PHOTO_BATCH_CREDITS || 0) + (chunks > 1 ? TASK_CREDITS.merge || 0 : 0);
  return { ok: true, count, chunks, credits, batches: split.batches };
}

/**
 * A batch position back to a photo number the student can act on.
 * The server reports unreadable pages as 1-based positions WITHIN the
 * batch it saw; the student is looking at their whole photo strip.
 */
export function photoNumberFor(batch, positionInBatch) {
  return batch.start + positionInBatch;
}

/* ------------------------------------------------------------------ */
/*  When the merge fails                                              */
/* ------------------------------------------------------------------ */

const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * Put the per-section summaries end to end, locally.
 *
 * A FAILED MERGE MUST NOT WASTE THE CHUNKS. Each section was summarised,
 * and each of those calls was charged; throwing the results away because
 * the last inexpensive step failed would take the student's allowance
 * and give them nothing. So the parts are kept and combined here — no
 * provider call, nothing further charged — and the UI says plainly that
 * the combining step failed and these are the sections as they came.
 *
 * `merged: false` is what the UI reads. Terms are deduplicated because
 * the chunks deliberately overlap, and a duplicate study card is a
 * visible defect rather than a cosmetic one.
 */
export function combineParts(parts = []) {
  const list = asArray(parts).filter((p) => p && typeof p === "object");
  if (list.length === 0) return null;
  if (list.length === 1) return { ...list[0], merged: true };

  const seen = new Set();
  const terms = [];
  for (const t of list.flatMap((p) => asArray(p.terms))) {
    const key = String((t && t.term) || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }

  return {
    merged: false,
    parts: list.length,
    overview: list.map((p, i) => `Part ${i + 1} of ${list.length}: ${p.overview || ""}`.trim()).join("\n\n"),
    keyPoints: list.flatMap((p) => asArray(p.keyPoints)),
    terms,
    assessable: list.flatMap((p) => asArray(p.assessable)),
    openQuestions: list.flatMap((p) => asArray(p.openQuestions)),
  };
}
