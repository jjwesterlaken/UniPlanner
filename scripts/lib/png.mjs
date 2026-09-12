/* ==================================================================
   png.mjs — decode, resize and encode 8-bit PNGs, with no dependency

   WHY THIS EXISTS RATHER THAN `sharp`. The icon set has to be
   CONSISTENT BY CONSTRUCTION — every slot derived from one master —
   and the only guard that really proves that is one which RE-DERIVES
   each slot and compares the bytes. That needs a resizer which is
   deterministic across machines and available in CI, on Windows and on
   Jared's Mac without a native build step.

   `sharp` is none of those things for free: it is a native module, its
   output depends on the libvips build underneath it, and this project
   has a standing rule against spawning anything out of
   `node_modules/.bin` (see CLAUDE.md, Build scripts). A byte-comparison
   guard on top of a resizer whose output can shift with a transitive
   upgrade is a guard that goes red for the wrong reason.

   So: box-filter downscale, filter-0 encode, `zlib` from Node's own
   standard library. Deterministic by construction, and the whole
   contract is "same master in, same bytes out".

   SCOPE IS DELIBERATELY NARROW. 8-bit RGB and RGBA, no interlace, no
   palette, no 16-bit. Those are the shapes an icon master takes, and a
   decoder that silently half-handles a shape it was never given is
   worse than one that refuses — so every unsupported shape THROWS
   naming what it found. The master is an artifact we control; if it
   ever arrives as something else, the build should say so rather than
   produce a quietly wrong icon.
   ================================================================== */

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for the two colour types we accept. */
const CHANNELS = { 2: 3, 6: 4 };

/**
 * Decode a PNG into `{ width, height, pixels }` with pixels as RGBA.
 *
 * RGBA REGARDLESS OF THE INPUT, so everything downstream works on one
 * shape. An RGB source gets an opaque alpha channel; that is lossless
 * and it means the resizer has exactly one case to get right.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG (signature mismatch)");

  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat = [];

  let at = 8;
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth} — this decoder handles 8 only`);
      if (!CHANNELS[colour]) throw new Error(`unsupported colour type ${colour} — this decoder handles 2 (RGB) and 6 (RGBA)`);
      if (interlace !== 0) throw new Error("interlaced PNG — this decoder handles interlace 0 only");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height) throw new Error("no IHDR");

  const bpp = CHANNELS[colour];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("truncated image data");

  /* UNFILTER. Each scanline carries its own filter byte; the five types
     are the PNG spec's and every one of them is defined against the
     already-unfiltered bytes above and to the left, which is why this
     runs top-down into the output buffer rather than in place. */
  const flat = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const line = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let value;
      if (filter === 0) value = src[i];
      else if (filter === 1) value = src[i] + a;
      else if (filter === 2) value = src[i] + b;
      else if (filter === 3) value = src[i] + ((a + b) >> 1);
      else if (filter === 4) value = src[i] + paeth(a, b, c);
      else throw new Error(`unknown scanline filter ${filter} on row ${y}`);
      line[i] = value & 0xff;
    }
  }

  /* Widen to RGBA. */
  const pixels = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    pixels[p * 4] = flat[p * bpp];
    pixels[p * 4 + 1] = flat[p * bpp + 1];
    pixels[p * 4 + 2] = flat[p * bpp + 2];
    pixels[p * 4 + 3] = bpp === 4 ? flat[p * bpp + 3] : 255;
  }
  return { width, height, pixels };
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/**
 * Encode RGBA pixels as a PNG.
 *
 * FILTER 0 ON EVERY SCANLINE, deliberately. Choosing filters adaptively
 * makes smaller files and makes the output depend on the heuristic that
 * chose them — and this file's whole contract is that the same master
 * produces the same bytes on every machine for ever. An icon is a few
 * kilobytes either way; determinism is worth more than the saving.
 *
 * `zlib.deflateSync` at a pinned level for the same reason.
 */
export function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Area-average ("box") resize.
 *
 * BOX RATHER THAN BILINEAR because every use here is a DOWNSCALE, often
 * a large one (1024 to 48), and bilinear samples four source pixels
 * whatever the ratio — so at 1/20 scale it reads 4 pixels out of 400 and
 * aliases the rest away. Averaging the whole source rectangle uses every
 * pixel that lands in the target, which is what keeps a thin tassel from
 * disappearing at mipmap sizes.
 *
 * ALPHA IS PREMULTIPLIED FOR THE AVERAGE and divided back out after.
 * Averaging colour and alpha independently pulls the colour of fully
 * transparent pixels into the edge — the classic dark halo — because a
 * transparent pixel still carries whatever RGB happened to be stored in
 * it. This matters here: the adaptive-icon foreground is a glyph on
 * transparency.
 */
export function resize(image, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * yRatio));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < image.height; sy++) {
        for (let sx = x0; sx < x1 && sx < image.width; sx++) {
          const p = (sy * image.width + sx) * 4;
          const alpha = image.pixels[p + 3];
          r += image.pixels[p] * alpha;
          g += image.pixels[p + 1] * alpha;
          b += image.pixels[p + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return { width, height, pixels: out };
}

/** A solid canvas. `colour` is `#rrggbb`. */
export function solid(width, height, colour) {
  const [r, g, b] = hexToRgb(colour);
  const pixels = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    pixels[p * 4] = r;
    pixels[p * 4 + 1] = g;
    pixels[p * 4 + 2] = b;
    pixels[p * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

/** A fully transparent canvas. */
export const blank = (width, height) => ({ width, height, pixels: Buffer.alloc(width * height * 4) });

/** Source-over composite of `top` onto `base` at (dx, dy). Mutates and returns `base`. */
export function composite(base, top, dx, dy) {
  for (let y = 0; y < top.height; y++) {
    const by = y + dy;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < top.width; x++) {
      const bx = x + dx;
      if (bx < 0 || bx >= base.width) continue;
      const s = (y * top.width + x) * 4;
      const d = (by * base.width + bx) * 4;
      const sa = top.pixels[s + 3] / 255;
      if (sa === 0) continue;
      const da = base.pixels[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        base.pixels[d + c] = Math.round((top.pixels[s + c] * sa + base.pixels[d + c] * da * (1 - sa)) / oa);
      }
      base.pixels[d + 3] = Math.round(oa * 255);
    }
  }
  return base;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/* ==================================================================
   ICO — a container of PNGs, for the one Windows slot

   electron-builder reads `desktop/build/icon.ico` for the Windows
   installer and executable, and nothing else in this repository can
   produce that container — so without this the Windows icon is the one
   slot that cannot derive from the master, which is how a second
   rendering of the glyph gets back in.

   PNG PAYLOADS AT EVERY SIZE, not BMP. Windows has read PNG-compressed
   ICO entries at any size since Vista, the deployment floor for an
   Electron app is far above that, and a BMP path would mean a second
   encoder — with its own bottom-up row order and AND-mask — to keep
   deterministic. One encoder, already proved by every other slot.

   The format: a 6-byte header, then one 16-byte directory entry per
   image, then the payloads. Width and height are single bytes with 0
   meaning 256, which is the only reason 256 is expressible at all.
   ================================================================== */

/**
 * Pack `{ size, png }` entries into an `.ico`.
 *
 * Deterministic: the directory is written in the order given and the
 * payloads are whatever `encodePng` produced, so the same master gives
 * the same bytes and `--check` can compare them.
 */
export function encodeIco(entries) {
  if (!entries.length) throw new Error("an .ico with no images is not a file Windows will read");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;
  entries.forEach((entry, i) => {
    const { size, png } = entry;
    if (size < 1 || size > 256) throw new Error(`an .ico image must be 1..256px, found ${size}`);
    const d = i * 16;
    directory[d] = size === 256 ? 0 : size; // width, 0 means 256
    directory[d + 1] = size === 256 ? 0 : size; // height
    directory[d + 2] = 0; // palette size — 0 for a truecolour image
    directory[d + 3] = 0; // reserved
    directory.writeUInt16LE(1, d + 4); // colour planes
    directory.writeUInt16LE(32, d + 6); // bits per pixel
    directory.writeUInt32LE(png.length, d + 8);
    directory.writeUInt32LE(offset, d + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

/** Read an `.ico` back as `{ size, png }`, so a guard can check one. */
export function decodeIco(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error("not an .ico file");
  const count = buffer.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = 6 + i * 16;
    out.push({
      size: buffer[d] || 256,
      height: buffer[d + 1] || 256,
      bits: buffer.readUInt16LE(d + 6),
      png: buffer.subarray(buffer.readUInt32LE(d + 12), buffer.readUInt32LE(d + 12) + buffer.readUInt32LE(d + 8)),
    });
  }
  return out;
}
