// png-squeeze: a lossless PNG compressor for make.fun's png-squeeze-01-run-20261127.
//
// One program answers all 8 screenshots of a set: it decodes each stored PNG,
// picks the smallest exact form for it (palette, grey, grey+alpha, RGB or RGBA,
// with a tRNS key when the image has a single transparent colour), screens the
// PNG filters for that form the way the competition's own scale compressor does,
// then writes the winner with an optimal-parsing deflate stream (hash-chain
// matches, five rounds of shortest-path parsing against iterated Huffman
// costs, the cheapest total kept), falling back to zlib level 9 whenever
// that is smaller. Everything is deterministic: same input bytes give same
// output bytes, and no clock is read.
//
// Node 22 runs this file as it is. Only Node built-ins are used.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const W = 1280;
const H = 720;

// Tunables for the match search. A longer chain finds rarer matches; a shorter
// one keeps the 60 second wall budget. These were set by measuring the practice
// set, not by the clock at run time.
const HASH_BITS = 18;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WINDOW = 32768;
const MAX_CHAIN = 256;
// Do not cut the chain short after a good match: a longer match further
// back is often worth more than the nearest good one, and the chain walk is
// the search that finds it. NICE_LEN at the maximum lets the walk run to
// the longest match the window holds.
const GOOD_LEN = 258;
const NICE_LEN = 258;
const BLOCK = 1 << 18;
// How many parse/Huffman rounds the deflate runs: each round re-parses
// against the Huffman costs the previous round's parse produced, and the
// cheapest total (parse bits plus header) is kept.
const DEFLATE_ITERS = 5;

// ---------------------------------------------------------------- checksums

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, from, to) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const end = Math.min(i + 5552, n);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(buf, at) {
  return (buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3];
}

function putU32(buf, at, v) {
  buf[at] = (v >>> 24) & 255;
  buf[at + 1] = (v >>> 16) & 255;
  buf[at + 2] = (v >>> 8) & 255;
  buf[at + 3] = v & 255;
}

// ---------------------------------------------------------------- PNG decode

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p < a ? a - p : p - a;
  const pb = p < b ? b - p : p - b;
  const pc = p < c ? c - p : p - c;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Undo one row's filter. cur holds the filtered bytes, prev the row above (or
// null), bpp the filter's byte step. The result is written into out.
function unfilterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      out[i] = (cur[i] + a) & 255;
    }
  } else if (type === 2) {
    for (let i = 0; i < n; i++) {
      const b = prev ? prev[i] : 0;
      out[i] = (cur[i] + b) & 255;
    }
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      out[i] = (cur[i] + ((a + b) >> 1)) & 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = i >= bpp && prev ? prev[i - bpp] : 0;
      out[i] = (cur[i] + paeth(a, b, c)) & 255;
    }
  }
}

// Read a PNG (8 bit, not interlaced) into RGBA bytes. Only the chunks the
// contest's inputs carry are needed; anything else is ignored.
function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78) {
    throw new Error('not a PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  let plte = null;
  let trns = null;
  while (pos + 12 <= bytes.length) {
    const len = u32be(bytes, pos);
    const type =
      String.fromCharCode(bytes[pos + 4]) +
      String.fromCharCode(bytes[pos + 5]) +
      String.fromCharCode(bytes[pos + 6]) +
      String.fromCharCode(bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = u32be(data, 0);
      height = u32be(data, 4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bpp = colorType === 3 ? 1 : channels;
  let raw;
  if (idat.length === 1) {
    raw = inflateSync(idat[0]);
  } else {
    const total = idat.reduce((s, c) => s + c.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of idat) {
      joined.set(c, at);
      at += c.length;
    }
    raw = inflateSync(joined);
  }
  const stride = width * channels;
  const samples = new Uint8Array(height * stride);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const type = raw[at];
    const row = samples.subarray(y * stride, (y + 1) * stride);
    unfilterRow(type, raw.subarray(at + 1, at + 1 + stride), prev, bpp, row);
    prev = row;
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colorType === 6) {
    rgba.set(samples);
  } else if (colorType === 2) {
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 3) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = samples[i];
      rgba[d + 1] = samples[i];
      rgba[d + 2] = samples[i];
      rgba[d + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 2) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else if (colorType === 3) {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const idx = samples[i] * 3;
      rgba[d] = plte[idx];
      rgba[d + 1] = plte[idx + 1];
      rgba[d + 2] = plte[idx + 2];
      rgba[d + 3] = trns && idx / 3 < trns.length ? trns[idx / 3] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- PNG encode

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      out[i] = (cur[i] - a) & 255;
    }
  } else if (type === 2) {
    for (let i = 0; i < n; i++) {
      const b = prev ? prev[i] : 0;
      out[i] = (cur[i] - b) & 255;
    }
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      out[i] = (cur[i] - ((a + b) >> 1)) & 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = i >= bpp && prev ? prev[i - bpp] : 0;
      out[i] = (cur[i] - paeth(a, b, c)) & 255;
    }
  }
}

// The minimum-sum heuristic: the sum of the absolute values of the filtered
// row's bytes, read as signed.
function signedSum(row) {
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

// How many distinct neighbouring byte pairs a filtered row holds.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- image forms

// What an image holds: whether every pixel is opaque, whether every pixel is
// grey, and its colours when there are at most 256 of them.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = words[i];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, 1);
      } else {
        counts.set(w, k + 1);
      }
    }
  }
  if (many) return { opaque, grey, colours: null };
  const scratch = new Uint8Array(4);
  const view = new Uint32Array(scratch.buffer);
  const colours = [];
  for (const [w, count] of counts) {
    view[0] = w;
    colours.push({ word: w, count, r: scratch[0], g: scratch[1], b: scratch[2], a: scratch[3] });
  }
  return { opaque, grey, colours };
}

// The one fully transparent colour an image may key by tRNS instead of an
// alpha channel: every non-opaque pixel is that colour at alpha 0, and no
// opaque pixel shares it. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// A palette form: transparent entries first (by alpha), then by count or by
// luminance. Returns the palette, the tRNS tail and the index samples.
function paletteForm(rgba, colours, byLuminance) {
  const entries = colours.slice();
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  entries.sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (byLuminance) {
      const d = lum(x) - lum(y);
      if (d !== 0) return d;
      return x.word - y.word;
    }
    if (y.count !== x.count) return y.count - x.count;
    return x.word - y.word;
  });
  const index = new Map();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let trnsLen = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) trnsLen = i + 1;
  });
  const trns = trnsLen === 0 ? null : Uint8Array.from(entries.slice(0, trnsLen), (c) => c.a);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The samples of an image in a channel colour type (0, 2, 4 or 6).
function channelSamples(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Every exact form an image can take, each with the filter choices worth
// screening for it. A palette image is tried by count and by luminance; a
// grey image is also tried in its channel form.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push({ form: paletteForm(rgba, colours, false), filters: [0] });
    forms.push({ form: paletteForm(rgba, colours, true), filters: [0, 'minsum', 'brute'] });
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 255, 0, key & 255);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    form: { colourType: ct, bpp, samples: channelSamples(rgba, ct), plte: null, trns },
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------- filtering

// Filter every row of a form's samples with all five filters, and work out
// which filter each adaptive choice would pick per row. Returns the five
// filtered streams (one per filter type) and the per-row picks.
function filterAll(samples, bpp) {
  const stride = W * bpp;
  const rowLen = stride + 1;
  const rows = [];
  for (let t = 0; t < 5; t++) {
    const r = new Uint8Array(H * rowLen);
    for (let y = 0; y < H; y++) r[y * rowLen] = t;
    rows.push(r);
  }
  const pickMin = new Uint8Array(H);
  const pickPairs = new Uint8Array(H);
  const pickBrute = new Uint8Array(H);
  const trial = new Uint8Array(stride);
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowLen;
    let bestMin = Infinity;
    let bestPairs = Infinity;
    let typeMin = 0;
    let typePairs = 0;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial);
      rows[t].set(trial, at + 1);
      const ms = signedSum(trial);
      if (ms < bestMin) {
        bestMin = ms;
        typeMin = t;
      }
      const pr = pairsOf(trial, seen, ++stamp);
      if (pr < bestPairs) {
        bestPairs = pr;
        typePairs = t;
      }
    }
    pickMin[y] = typeMin;
    pickPairs[y] = typePairs;
  }
  // Brute force in its own pass: each row's trial is compressed after the
  // brute-chosen rows written before it, the way a real deflate stream sees
  // them, so the dictionary is the stream itself and not another filter's.
  const bruteRaw = new Uint8Array(H * rowLen);
  const trialRow = new Uint8Array(rowLen);
  for (let y = 0; y < H; y++) {
    const at = y * rowLen;
    const before = bruteRaw.subarray(Math.max(0, at - 32768), at);
    let bestBrute = Infinity;
    let typeBrute = 0;
    for (let t = 0; t < 5; t++) {
      trialRow[0] = t;
      trialRow.set(rows[t].subarray(at + 1, at + rowLen), 1);
      const cost = deflateSync(
        trialRow,
        before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before },
      ).length;
      if (cost < bestBrute) {
        bestBrute = cost;
        typeBrute = t;
      }
    }
    pickBrute[y] = typeBrute;
    bruteRaw[at] = typeBrute;
    bruteRaw.set(rows[typeBrute].subarray(at + 1, at + rowLen), at + 1);
  }
  return { rows, pickMin, pickPairs, pickBrute, rowLen };
}

// Assemble the filtered stream for one filter choice from filterAll's rows.
function assemble(filtered, choice) {
  const { rows, rowLen } = filtered;
  if (typeof choice === 'number') return rows[choice];
  const pick = choice === 'minsum' ? filtered.pickMin : choice === 'pairs' ? filtered.pickPairs : filtered.pickBrute;
  const out = new Uint8Array(H * rowLen);
  for (let y = 0; y < H; y++) {
    const at = y * rowLen;
    out[at] = pick[y];
    out.set(rows[pick[y]].subarray(at + 1, at + rowLen), at + 1);
  }
  return out;
}

// Screen every form and filter choice with zlib level 6, weighing the PLTE
// and tRNS chunks, and keep the smallest. The brute-force choice is kept
// alongside it when it is close: a strong deflate can rank it above the
// zlib-6 winner, so the caller encodes both and keeps the smaller PNG.
function screen(rgba) {
  let best = null;
  let bruteBest = null;
  for (const { form, filters } of formsOf(rgba)) {
    const chunks = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    const filtered = filterAll(form.samples, form.bpp);
    for (const choice of filters) {
      const data = assemble(filtered, choice);
      const z = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = z.length + chunks;
      if (best === null || bytes < best.bytes) {
        best = { form, choice, data, bytes, zlibLen: z.length };
      }
      if (choice === 'brute' && (bruteBest === null || bytes < bruteBest.bytes)) {
        bruteBest = { form, choice, data, bytes, zlibLen: z.length };
      }
    }
  }
  const alt =
    bruteBest !== null &&
    !(bruteBest.form === best.form && bruteBest.choice === best.choice) &&
    bruteBest.bytes <= best.bytes * 1.12
      ? bruteBest
      : null;
  return { best, alt };
}

// ---------------------------------------------------------------- deflate

// The length and distance code tables of RFC 1951.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Uint8Array(259);
const DIST_SYM = new Uint16Array(32769);
for (let s = 0; s < 29; s++) {
  const top = Math.min(258, LEN_BASE[s] + (1 << LEN_EXTRA[s]) - 1);
  for (let l = LEN_BASE[s]; l <= top; l++) LEN_SYM[l] = s;
}
LEN_SYM[258] = 28;
for (let s = 0; s < 30; s++) {
  const top = Math.min(32768, DIST_BASE[s] + (1 << DIST_EXTRA[s]) - 1);
  for (let d = DIST_BASE[s]; d <= top; d++) DIST_SYM[d] = s;
}

const FIXED_LIT = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT[i] = 8;
const FIXED_DIST = new Uint8Array(30).fill(5);

// The fixed-table cost of a match, for ranking matches while searching: the
// bits a match costs minus the bits its bytes would cost as literals.
const FIXED_LEN_COST = new Float64Array(259);
for (let l = 3; l <= 258; l++) {
  const s = LEN_SYM[l];
  FIXED_LEN_COST[l] = FIXED_LIT[257 + s] + LEN_EXTRA[s];
}
const FIXED_DIST_COST = new Float64Array(32769);
for (let dd = 1; dd <= 32768; dd++) {
  const s = DIST_SYM[dd];
  FIXED_DIST_COST[dd] = FIXED_DIST[s] + DIST_EXTRA[s];
}

function hash3(d, i) {
  const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
  return (Math.imul(v, 2654435761) >>> (32 - HASH_BITS)) & HASH_MASK;
}

// Find the matches at position i of d: the longest, the nearest of length at
// least 3, and the best value (the most bits saved against literals, by the
// fixed tables). head/prev are the hash chains of the positions before i.
function findMatch(d, i, n, head, prev) {
  const maxLen = Math.min(258, n - i);
  if (maxLen < 3) return { len: 0, dist: 0, nearLen: 0, nearDist: 0, valLen: 0, valDist: 0 };
  const h = hash3(d, i);
  let cur = head[h];
  let bestLen = 0;
  let bestDist = 0;
  let nearLen = 0;
  let nearDist = 0;
  let valLen = 0;
  let valDist = 0;
  let valBest = -Infinity;
  let budget = MAX_CHAIN;
  const floor = i - WINDOW;
  while (cur >= floor && cur >= 0 && budget > 0) {
    budget--;
    if (bestLen > 0) {
      if (bestLen >= maxLen) break;
      if (d[cur + bestLen] !== d[i + bestLen]) {
        cur = prev[cur];
        continue;
      }
    }
    let k = 0;
    while (k < maxLen && d[cur + k] === d[i + k]) k++;
    if (k >= 3) {
      const dist = i - cur;
      if (nearLen === 0) {
        nearLen = k;
        nearDist = dist;
      }
      const value = k * 8 - (FIXED_LEN_COST[k] + FIXED_DIST_COST[dist]);
      if (value > valBest) {
        valBest = value;
        valLen = k;
        valDist = dist;
      }
    }
    if (k > bestLen) {
      bestLen = k;
      bestDist = i - cur;
      if (bestLen >= NICE_LEN) break;
      if (bestLen >= GOOD_LEN) budget = Math.min(budget, 8);
    }
    cur = prev[cur];
  }
  return { len: bestLen, dist: bestDist, nearLen, nearDist, valLen, valDist };
}

// Build length-limited Huffman code lengths from frequencies. A Huffman tree
// is built for the frequencies, smoothing them (adding a constant to every
// used frequency) until no length exceeds maxBits; a tree is always a
// complete code, so the lengths are always valid. Returns null only if
// smoothing cannot meet the cap (it always can for these alphabets, so this
// is a safety net).
function buildLengths(freqs, maxBits) {
  const n = freqs.length;
  const used = [];
  for (let s = 0; s < n; s++) if (freqs[s] > 0) used.push(s);
  if (used.length === 0) return null;
  if (used.length === 1) {
    const lengths = new Uint8Array(n);
    lengths[used[0]] = 1;
    return lengths;
  }
  const treeLengths = (f) => {
    const order = used.slice().sort((a, b) => f[a] - f[b] || a - b);
    const leaves = order.map((s) => ({ freq: f[s], sym: s, left: null, right: null }));
    const internal = [];
    let li = 0;
    let ii = 0;
    const takeSmallest = () => {
      if (ii >= internal.length) return leaves[li++];
      if (li >= leaves.length) return internal[ii++];
      return leaves[li].freq <= internal[ii].freq ? leaves[li++] : internal[ii++];
    };
    let root = null;
    for (;;) {
      const remaining = leaves.length - li + (internal.length - ii);
      if (remaining === 1) {
        root = li < leaves.length ? leaves[li] : internal[ii];
        break;
      }
      const a = takeSmallest();
      const b = takeSmallest();
      internal.push({ freq: a.freq + b.freq, sym: -1, left: a, right: b });
    }
    const lengths = new Uint8Array(n);
    let maxDepth = 0;
    const stack = [[root, 0]];
    while (stack.length > 0) {
      const [node, d] = stack.pop();
      if (node.sym >= 0) {
        lengths[node.sym] = d;
        if (d > maxDepth) maxDepth = d;
      } else {
        stack.push([node.left, d + 1]);
        stack.push([node.right, d + 1]);
      }
    }
    return { lengths, maxDepth };
  };
  let total = 0;
  for (const f of freqs) total += f;
  let add = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    let f = freqs;
    if (add > 0) {
      f = Array.from(freqs);
      for (const s of used) f[s] += add;
    }
    const { lengths, maxDepth } = treeLengths(f);
    if (maxDepth <= maxBits) return lengths;
    add = add === 0 ? Math.max(1, total >>> 8) : add * 2;
  }
  return null;
}

// Canonical Huffman codes for a lengths array: codes[s] is the code value,
// to be written most-significant bit first (reversed into the stream).
function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  const rev = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l === 0) continue;
    const c = nextCode[l]++;
    codes[s] = c;
    let r = 0;
    for (let k = 0; k < l; k++) r = (r << 1) | ((c >>> k) & 1);
    rev[s] = r;
  }
  return { codes, rev };
}

// A bit writer: bits go in least-significant first, Huffman codes reversed.
class BitWriter {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  grow() {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
  bits(value, len) {
    this.bitbuf |= value << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitbuf & 255;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  align() {
    if (this.bitcnt > 0) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitbuf & 255;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

// The shortest-path parse of one block: at each position take the literal or
// one of the cached matches, whichever the cost tables make cheapest. The
// parse is returned as parallel arrays: opsA holds a literal byte (>= 0) or a
// negated match length, opsB the match distance.
function optimalParse(d, n, mLen, mDist, nLen, nDist, vLen, vDist, litLen, distLen) {
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const s = LEN_SYM[l];
    lenCost[l] = litLen[257 + s] + LEN_EXTRA[s];
  }
  const distCost = new Float64Array(32769);
  for (let dd = 1; dd <= 32768; dd++) {
    const s = DIST_SYM[dd];
    distCost[dd] = distLen[s] + DIST_EXTRA[s];
  }
  const cost = new Float64Array(n + 1).fill(Infinity);
  cost[0] = 0;
  const from = new Int32Array(n + 1);
  const fromLen = new Int16Array(n + 1);
  const fromDist = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    const nc = c + litLen[d[i]];
    if (nc < cost[i + 1]) {
      cost[i + 1] = nc;
      from[i + 1] = i;
      fromLen[i + 1] = 0;
    }
    const l1 = mLen[i];
    if (l1 >= 3) {
      const mc = c + lenCost[l1] + distCost[mDist[i]];
      const j = i + l1;
      if (mc < cost[j]) {
        cost[j] = mc;
        from[j] = i;
        fromLen[j] = l1;
        fromDist[j] = mDist[i];
      }
    }
    const l2 = nLen[i];
    if (l2 >= 3 && (l2 !== l1 || nDist[i] !== mDist[i])) {
      const mc = c + lenCost[l2] + distCost[nDist[i]];
      const j = i + l2;
      if (mc < cost[j]) {
        cost[j] = mc;
        from[j] = i;
        fromLen[j] = l2;
        fromDist[j] = nDist[i];
      }
    }
    const l3 = vLen[i];
    if (l3 >= 3 && (l3 !== l1 || vDist[i] !== mDist[i]) && (l3 !== l2 || vDist[i] !== nDist[i])) {
      const mc = c + lenCost[l3] + distCost[vDist[i]];
      const j = i + l3;
      if (mc < cost[j]) {
        cost[j] = mc;
        from[j] = i;
        fromLen[j] = l3;
        fromDist[j] = vDist[i];
      }
    }
  }
  const opsA = [];
  const opsB = [];
  let i = n;
  while (i > 0) {
    const p = from[i];
    const l = fromLen[i];
    if (l === 0) {
      opsA.push(d[p]);
      opsB.push(0);
    } else {
      opsA.push(-l);
      opsB.push(fromDist[i]);
    }
    i = p;
  }
  opsA.reverse();
  opsB.reverse();
  return { opsA: Int32Array.from(opsA), opsB: Int32Array.from(opsB) };
}

// Count literal/length and distance frequencies of a parse.
function countFreqs(parse) {
  const lit = new Int32Array(288);
  const dist = new Int32Array(30);
  const { opsA, opsB } = parse;
  for (let k = 0; k < opsA.length; k++) {
    const a = opsA[k];
    if (a >= 0) {
      lit[a]++;
    } else {
      const len = -a;
      lit[257 + LEN_SYM[len]]++;
      dist[DIST_SYM[opsB[k]]]++;
    }
  }
  lit[256]++;
  return { lit, dist };
}

// The bit cost of a parse under given code lengths.
function parseBits(parse, litLen, distLen) {
  let bits = 0;
  const { opsA, opsB } = parse;
  for (let k = 0; k < opsA.length; k++) {
    const a = opsA[k];
    if (a >= 0) {
      bits += litLen[a];
    } else {
      const len = -a;
      const s = LEN_SYM[len];
      bits += litLen[257 + s] + LEN_EXTRA[s];
      const ds = DIST_SYM[opsB[k]];
      bits += distLen[ds] + DIST_EXTRA[ds];
    }
  }
  bits += litLen[256];
  return bits;
}

// Run-length encode a code-lengths array into the 19-symbol code-length
// alphabet (0-18): literals, 16 for a repeat, 17/18 for zero runs. Returns
// the symbol stream and the extra-bit value for each symbol.
function rleLengths(lengths) {
  const syms = [];
  const extras = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    if (v === 0) {
      let run = 0;
      while (i + run < lengths.length && lengths[i + run] === 0) run++;
      i += run;
      while (run >= 11) {
        const take = Math.min(run, 138);
        syms.push(18);
        extras.push(take - 11);
        run -= take;
      }
      if (run >= 3) {
        syms.push(17);
        extras.push(run - 3);
        run = 0;
      }
      while (run > 0) {
        syms.push(0);
        extras.push(0);
        run--;
      }
    } else {
      syms.push(v);
      extras.push(0);
      i++;
      let run = 0;
      while (i + run < lengths.length && lengths[i + run] === v) run++;
      i += run;
      while (run >= 3) {
        const take = Math.min(run, 6);
        syms.push(16);
        extras.push(take - 3);
        run -= take;
      }
      while (run > 0) {
        syms.push(v);
        extras.push(0);
        run--;
      }
    }
  }
  return { syms, extras };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const CL_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];

// Write one dynamic-Huffman block. litLen/distLen come from the parse.
function emitDynamic(bw, bfinal, parse, litLen, distLen) {
  const litCount = (() => {
    let c = 257;
    for (let i = 287; i >= 257; i--) if (litLen[i] > 0) {
      c = i + 1;
      break;
    }
    return c;
  })();
  const distCount = (() => {
    let c = 1;
    for (let i = 29; i >= 1; i--) if (distLen[i] > 0) {
      c = i + 1;
      break;
    }
    return c;
  })();
  const combined = new Uint8Array(litCount + distCount);
  combined.set(litLen.subarray(0, litCount), 0);
  combined.set(distLen.subarray(0, distCount), litCount);
  const { syms, extras } = rleLengths(combined);
  const clFreq = new Int32Array(19);
  for (const s of syms) clFreq[s]++;
  let clLen = buildLengths(clFreq, 7);
  if (clLen === null) return false;
  let clUsed = 0;
  for (const l of clLen) if (l > 0) clUsed++;
  if (clUsed < 2) {
    // A one-code code-length alphabet is not portable: add a dummy code.
    for (let s = 0; s < 19; s++) {
      if (clLen[s] === 0) {
        clLen[s] = 1;
        break;
      }
    }
  }
  let clCount = 4;
  for (let i = 18; i >= 4; i--) {
    if (clLen[CL_ORDER[i]] > 0) {
      clCount = i + 1;
      break;
    }
  }
  const clCodes = canonicalCodes(clLen);
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  bw.bits(bfinal ? 1 : 0, 1);
  bw.bits(2, 2);
  bw.bits(litCount - 257, 5);
  bw.bits(distCount - 1, 5);
  bw.bits(clCount - 4, 4);
  for (let i = 0; i < clCount; i++) bw.bits(clLen[CL_ORDER[i]], 3);
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    bw.bits(clCodes.rev[s], clLen[s]);
    if (CL_EXTRA[s] > 0) bw.bits(extras[k], CL_EXTRA[s]);
  }
  const { opsA, opsB } = parse;
  for (let k = 0; k < opsA.length; k++) {
    const a = opsA[k];
    if (a >= 0) {
      bw.bits(litCodes.rev[a], litLen[a]);
    } else {
      const len = -a;
      const s = LEN_SYM[len];
      bw.bits(litCodes.rev[257 + s], litLen[257 + s]);
      if (LEN_EXTRA[s] > 0) bw.bits(len - LEN_BASE[s], LEN_EXTRA[s]);
      const ds = DIST_SYM[opsB[k]];
      bw.bits(distCodes.rev[ds], distLen[ds]);
      if (DIST_EXTRA[ds] > 0) bw.bits(opsB[k] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.bits(litCodes.rev[256], litLen[256]);
  return true;
}

// Write one fixed-Huffman block.
function emitFixed(bw, bfinal, parse) {
  const litCodes = canonicalCodes(FIXED_LIT);
  const distCodes = canonicalCodes(FIXED_DIST);
  bw.bits(bfinal ? 1 : 0, 1);
  bw.bits(1, 2);
  const { opsA, opsB } = parse;
  for (let k = 0; k < opsA.length; k++) {
    const a = opsA[k];
    if (a >= 0) {
      bw.bits(litCodes.rev[a], FIXED_LIT[a]);
    } else {
      const len = -a;
      const s = LEN_SYM[len];
      bw.bits(litCodes.rev[257 + s], FIXED_LIT[257 + s]);
      if (LEN_EXTRA[s] > 0) bw.bits(len - LEN_BASE[s], LEN_EXTRA[s]);
      const ds = DIST_SYM[opsB[k]];
      bw.bits(distCodes.rev[ds], FIXED_DIST[ds]);
      if (DIST_EXTRA[ds] > 0) bw.bits(opsB[k] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.bits(litCodes.rev[256], FIXED_LIT[256]);
}

// The bit cost of a dynamic block's header, for the fixed-vs-dynamic choice.
function dynamicHeaderBits(litLen, distLen) {
  let litCount = 257;
  for (let i = 287; i >= 257; i--) if (litLen[i] > 0) {
    litCount = i + 1;
    break;
  }
  let distCount = 1;
  for (let i = 29; i >= 1; i--) if (distLen[i] > 0) {
    distCount = i + 1;
    break;
  }
  const combined = new Uint8Array(litCount + distCount);
  combined.set(litLen.subarray(0, litCount), 0);
  combined.set(distLen.subarray(0, distCount), litCount);
  const { syms, extras } = rleLengths(combined);
  const clFreq = new Int32Array(19);
  for (const s of syms) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  if (clLen === null) return Infinity;
  let clUsed = 0;
  for (const l of clLen) if (l > 0) clUsed++;
  if (clUsed < 2) {
    for (let s = 0; s < 19; s++) {
      if (clLen[s] === 0) {
        clLen[s] = 1;
        break;
      }
    }
  }
  let clCount = 4;
  for (let i = 18; i >= 4; i--) {
    if (clLen[CL_ORDER[i]] > 0) {
      clCount = i + 1;
      break;
    }
  }
  let bits = 3 + 5 + 5 + 4 + clCount * 3;
  for (let k = 0; k < syms.length; k++) bits += clLen[syms[k]] + CL_EXTRA[syms[k]];
  return bits;
}

// Compress one block of filtered bytes (a slice of the whole stream) into the
// shared bit writer. Two shortest-path parses are run: the first against the
// fixed tables, the second against Huffman tables built from the first
// parse, and the block is written fixed or dynamic, whichever is smaller.
function compressBlock(bw, d, start, end, bfinal) {
  const n = end - start;
  const block = d.subarray(start, end);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const mLen = new Int16Array(n);
  const mDist = new Int32Array(n);
  const nLen = new Int16Array(n);
  const nDist = new Int32Array(n);
  const vLen = new Int16Array(n);
  const vDist = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const m = findMatch(block, i, n, head, prev);
    mLen[i] = m.len;
    mDist[i] = m.dist;
    nLen[i] = m.nearLen;
    nDist[i] = m.nearDist;
    vLen[i] = m.valLen;
    vDist[i] = m.valDist;
    if (i + 2 < n) {
      const h = hash3(block, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  // Parse against the fixed tables first, then re-parse against the Huffman
  // costs each round's parse produces, keeping the cheapest total (parse bits
  // plus the dynamic header). More rounds converge the parse on its own
  // Huffman costs, the way zopfli iterates.
  let litLen = FIXED_LIT;
  let distLen = FIXED_DIST;
  let bestParse = null;
  let bestLitLen = null;
  let bestDistLen = null;
  let bestTotal = Infinity;
  for (let it = 0; it < DEFLATE_ITERS; it++) {
    const parse = optimalParse(block, n, mLen, mDist, nLen, nDist, vLen, vDist, litLen, distLen);
    const freq = countFreqs(parse);
    const ll = buildLengths(freq.lit, 15);
    if (ll === null) {
      if (bestParse === null) {
        emitFixed(bw, bfinal, parse);
        return;
      }
      break;
    }
    let dl = buildLengths(freq.dist, 15);
    if (dl === null) {
      dl = new Uint8Array(30);
      dl[0] = 1;
      dl[1] = 1;
    }
    const dynBits = dynamicHeaderBits(ll, dl) + parseBits(parse, ll, dl);
    if (dynBits < bestTotal) {
      bestTotal = dynBits;
      bestParse = parse;
      bestLitLen = ll;
      bestDistLen = dl;
    }
    litLen = ll;
    distLen = dl;
  }
  const parse = bestParse;
  const litLen2 = bestLitLen;
  const distLen2 = bestDistLen;
  const fixedBits = 3 + parseBits(parse, FIXED_LIT, FIXED_DIST);
  const dynBits = dynamicHeaderBits(litLen2, distLen2) + parseBits(parse, litLen2, distLen2);
  if (dynBits < fixedBits) {
    if (!emitDynamic(bw, bfinal, parse, litLen2, distLen2)) emitFixed(bw, bfinal, parse);
  } else {
    emitFixed(bw, bfinal, parse);
  }
}

// The raw deflate stream of filtered bytes, in blocks of BLOCK bytes.
function deflateOptimal(data) {
  const bw = new BitWriter(data.length + 4096);
  for (let start = 0; start < data.length; start += BLOCK) {
    const end = Math.min(start + BLOCK, data.length);
    compressBlock(bw, data, start, end, end === data.length);
  }
  bw.align();
  return bw.bytes();
}

// Wrap a raw deflate stream in a zlib stream.
function wrapZlib(raw, data) {
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  putU32(out, raw.length + 2, adler32(data));
  return out;
}

// ---------------------------------------------------------------- PNG output

function pngOf(form, zlibStream) {
  const ihdr = new Uint8Array(13);
  putU32(ihdr, 0, W);
  putU32(ihdr, 4, H);
  ihdr[8] = 8;
  ihdr[9] = form.colourType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunks = [['IHDR', ihdr]];
  if (form.plte) chunks.push(['PLTE', form.plte]);
  if (form.trns) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', zlibStream]);
  chunks.push(['IEND', new Uint8Array(0)]);
  let total = 8;
  for (const [, data] of chunks) total += 12 + data.length;
  const out = new Uint8Array(total);
  out[0] = 137;
  out[1] = 80;
  out[2] = 78;
  out[3] = 71;
  out[4] = 13;
  out[5] = 10;
  out[6] = 26;
  out[7] = 10;
  let at = 8;
  for (const [type, data] of chunks) {
    putU32(out, at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    const crc = crc32(out, at + 4, at + 8 + data.length);
    putU32(out, at + 8 + data.length, crc);
    at += 12 + data.length;
  }
  return out;
}

// ---------------------------------------------------------------- entry

// Compress one screenshot: screen its forms and filters, write the winner
// with the optimal deflate, and keep zlib level 9's stream when it is the
// smaller of the two. The close brute-force runner-up is encoded the same
// way and kept when it wins.
function encodeCandidate(candidate) {
  const mine = deflateOptimal(candidate.data);
  const z9 = deflateSync(candidate.data, { level: 9, memLevel: 9 });
  const stream = mine.length + 6 <= z9.length ? wrapZlib(mine, candidate.data) : z9;
  return pngOf(candidate.form, stream);
}

function compressImage(rgba) {
  const { best, alt } = screen(rgba);
  let png = encodeCandidate(best);
  if (alt !== null) {
    const altPng = encodeCandidate(alt);
    if (altPng.length < png.length) png = altPng;
  }
  return png;
}

for (const id of readdirSync(INPUT).sort()) {
  const bytes = readFileSync(join(INPUT, id, 'image.png'));
  const { rgba } = decodePng(new Uint8Array(bytes));
  const png = compressImage(rgba);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), png);
}
