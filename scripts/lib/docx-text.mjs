/* Text out of a .docx, with no dependency.

   A .docx is a ZIP holding word/document.xml. Node has `zlib` but no
   zip reader, so this is ~70 lines of central-directory walk plus
   `inflateRawSync` — the same choice `scripts/lib/png.mjs` made when
   it hand-rolled a PNG encoder rather than take `sharp`: a build-time
   dependency for one file's worth of format is a dependency to keep
   in step for ever, and this format has not changed since 2007.

   IT IS DELIBERATELY NOT A GENERAL ZIP READER. No zip64, no
   encryption, no multi-disk. A .docx that needs any of those is not
   something this should paper over — `readDocxText` throws with what
   it found, and the caller tells the operator to save a .txt instead.
   Guessing at a container we cannot read is how a rubric silently
   becomes an empty string and every measurement below it means
   nothing. */

import fs from "node:fs";
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEOCD(buf) {
  /* The comment field is up to 64KB, so scan back from the end. */
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error("not a zip: no end-of-central-directory record");
}

/** Every entry's name and where its data starts. */
export function zipEntries(buf) {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error(`corrupt central directory at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function readZipEntry(buf, entry) {
  if (buf.readUInt32LE(entry.localOffset) !== LOCAL) throw new Error(`corrupt local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

/**
 * The visible text of a .docx, paragraphs separated by newlines.
 *
 * Word splits a single sentence across many <w:t> runs whenever
 * formatting changes mid-line, so runs are joined with NOTHING and only
 * paragraph ends become newlines — joining runs with a space is how a
 * rubric comes out as "cl ear thes is".
 */
export function docxToText(buf) {
  const entries = zipEntries(buf);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) {
    throw new Error(`no word/document.xml inside (found: ${entries.map((e) => e.name).slice(0, 8).join(", ")})`);
  }
  const xml = readZipEntry(buf, doc).toString("utf8");
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function readDocxText(file) {
  return docxToText(fs.readFileSync(file));
}
