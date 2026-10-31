// Burst Picker helpers with no page code, so they run in tests too:
// capture time from EXIF, the JPEG preview inside a RAW file, how sharp the bird is, and bursts.

export const RAW_EXT = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|orf|raf|rw2|rwl|dng|pef|srw|3fr|iiq|erf|kdc|mrw|x3f)$/i;
export const BURST_GAP_MS = 2000; // a new burst starts after a gap of more than 2 s, as Moments does in the app
// Long side the bird is compared at. Tests (marketing/burst-picker-2026-11-01) tried 384 to 1,024 px: larger sizes
// let sensor noise swamp the difference between soft frames, while 384 keeps a blur series in order even with heavy noise.
export const SIZES = [384];

// ------------------------------------------------------------------ EXIF

const u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o, le) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24
  : b[o] * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));

function ascii(b, o, n) {
  let s = '';
  for (let i = 0; i < n && o + i < b.length; i++) {
    const c = b[o + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

const TAGS = { 0x0112: 'orientation', 0x9003: 'original', 0x9291: 'subOriginal', 0x9004: 'digitized', 0x9292: 'subDigitized' };

/** Read the tags we need from a TIFF structure starting at `start` (EXIF block, RAW file, CR3 metadata box). */
export function parseTiff(b, start = 0) {
  if (start + 8 > b.length) return null;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return null;
  const magic = u16(b, start + 2, le);
  if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) return null; // TIFF, Olympus ORF (IIRO, IIRS), Panasonic RW2
  const out = {};
  const seen = new Set();
  const walk = (ifdOffset, depth) => {
    const at = start + ifdOffset;
    if (depth > 2 || seen.has(at) || at + 2 > b.length) return;
    seen.add(at);
    const count = u16(b, at, le);
    if (count > 1000) return;
    for (let k = 0; k < count; k++) {
      const e = at + 2 + k * 12;
      if (e + 12 > b.length) return;
      const tag = u16(b, e, le);
      const type = u16(b, e + 2, le);
      const n = u32(b, e + 4, le);
      if (tag === 0x8769 && (type === 4 || type === 13)) walk(u32(b, e + 8, le), depth + 1); // Exif IFD
      const name = TAGS[tag];
      if (!name || out[name] != null) continue;
      if (type === 2) out[name] = ascii(b, n <= 4 ? e + 8 : start + u32(b, e + 8, le), Math.min(n, 64));
      else if (type === 3) out[name] = u16(b, e + 8, le);
    }
  };
  walk(u32(b, start + 4, le), 0);
  return out;
}

/** The TIFF block inside a JPEG's APP1 "Exif" segment, or -1. */
export function jpegExifOffset(b, start = 0) {
  if (b[start] !== 0xff || b[start + 1] !== 0xd8) return -1;
  let i = start + 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return -1;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xda || m === 0xd9) return -1; // image data starts: no EXIF before it
    const len = u16(b, i + 2, false);
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) return i + 10;
    i += 2 + len;
  }
  return -1;
}

/** "2026:10:31 08:15:30" + "25" (fraction of a second) → milliseconds; null if missing or blank. */
export function exifTimeMs(dateTime, subSec) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTime || '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  let ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const frac = /^\s*(\d+)/.exec(subSec || '');
  if (frac) ms += Math.round(Number(`0.${frac[1]}`) * 1000);
  return ms;
}

function timeFrom(tags) {
  if (!tags) return null;
  return exifTimeMs(tags.original, tags.subOriginal) ?? exifTimeMs(tags.digitized, tags.subDigitized);
}

/**
 * Capture time (ms) and orientation from the start of a file: JPEG (APP1), TIFF-based RAW
 * (CR2, NEF, ARW, DNG, ORF, RW2, PEF…), or a TIFF block found further in (CR3 metadata boxes).
 */
export function readCaptureInfo(b) {
  const tryAt = (o) => {
    const tags = parseTiff(b, o);
    return tags ? { time: timeFrom(tags), orientation: tags.orientation ?? null } : null;
  };
  let first = null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    const o = jpegExifOffset(b, 0);
    return (o >= 0 && tryAt(o)) || { time: null, orientation: null };
  }
  first = tryAt(0);
  if (first?.time != null) return first;
  // Look for further TIFF blocks (CR3 keeps EXIF in its own boxes; some RAWs keep the date in a second block).
  const limit = Math.min(b.length - 8, 4 * 1024 * 1024);
  let tries = 0;
  let orientation = first?.orientation ?? null; // CR3: orientation in one block (IFD0), the date in another
  for (let i = 1; i < limit && tries < 24; i++) {
    const c = b[i];
    if (c !== 0x49 && c !== 0x4d) continue;
    if (!((c === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0) ||
          (c === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a))) continue;
    tries++;
    const r = tryAt(i);
    orientation ??= r?.orientation ?? null;
    if (r?.time != null) return { time: r.time, orientation };
  }
  return { time: null, orientation };
}

// ------------------------------------------------------- JPEG previews in RAW files

/**
 * Walk one JPEG from its SOI marker: {start, end, width, height, sof} when its structure holds up,
 * else null. `end` is just past EOI (or the end of the data if it's cut short).
 */
export function parseJpegAt(b, start) {
  const n = b.length;
  if (b[start] !== 0xff || b[start + 1] !== 0xd8 || b[start + 2] !== 0xff) return null;
  let i = start + 2;
  let width = 0;
  let height = 0;
  let sof = -1;
  let segments = 0;
  const done = (end) => (sof >= 0 && width > 0 && height > 0 ? { start, end, width, height, sof } : null);
  while (i + 1 < n) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd9) return done(i + 2);
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd8 || m === 0x00 || m < 0xc0) return null;
    if (i + 3 >= n) break;
    const len = u16(b, i + 2, false);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && sof < 0) {
      if (i + 8 >= n) break;
      sof = m;
      height = u16(b, i + 5, false);
      width = u16(b, i + 7, false);
    }
    i += 2 + len;
    if (++segments > 2000) return null;
    if (m === 0xda) {
      // Compressed data: skip to the next real marker (FF 00 is a stuffed byte, FF D0–D7 a restart).
      for (;;) {
        i = b.indexOf(0xff, i);
        if (i < 0 || i + 1 >= n) return done(n);
        const c = b[i + 1];
        if (c === 0x00 || (c >= 0xd0 && c <= 0xd7)) { i += 2; continue; }
        if (c === 0xff) { i += 1; continue; }
        break;
      }
    }
  }
  return done(n);
}

/**
 * Every embedded JPEG a browser could decode (baseline or progressive; lossless RAW data is skipped),
 * largest first. Try them in order and keep the first that decodes.
 */
export function findPreviews(b, { minLongSide = 640 } = {}) {
  const out = [];
  const n = b.length;
  let i = 0;
  while ((i = b.indexOf(0xff, i)) >= 0 && i + 2 < n) {
    if (b[i + 1] === 0xd8 && b[i + 2] === 0xff) {
      const j = parseJpegAt(b, i);
      if (j && (j.sof === 0xc0 || j.sof === 0xc1 || j.sof === 0xc2) && Math.max(j.width, j.height) >= minLongSide) out.push(j);
    }
    i += 1;
  }
  return out.sort((a, c) => c.width * c.height - a.width * a.height || a.start - c.start);
}

// ------------------------------------------------------------------ sharpness

/** Luma (Rec. 601) from RGBA pixels. */
export function grayFromRGBA(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let p = 0, q = 0; p < g.length; p++, q += 4) g[p] = 0.299 * rgba[q] + 0.587 * rgba[q + 1] + 0.114 * rgba[q + 2];
  return g;
}

// For each output index, the source indexes and weights: area average when shrinking, linear when enlarging.
function taps(srcN, dstN) {
  const scale = srcN / dstN;
  const list = [];
  for (let d = 0; d < dstN; d++) {
    const idx = [];
    const wts = [];
    if (scale >= 1) {
      const x0 = d * scale;
      const x1 = x0 + scale;
      for (let s = Math.floor(x0); s < Math.min(srcN, Math.ceil(x1)); s++) {
        const w = Math.min(x1, s + 1) - Math.max(x0, s);
        if (w > 1e-9) { idx.push(s); wts.push(w / scale); }
      }
    } else {
      const x = Math.max(0, Math.min(srcN - 1, (d + 0.5) * scale - 0.5));
      const s0 = Math.floor(x);
      const t = x - s0;
      idx.push(s0); wts.push(1 - t);
      if (s0 + 1 < srcN && t > 0) { idx.push(s0 + 1); wts.push(t); }
    }
    list.push({ idx, wts });
  }
  return list;
}

/** Resample a grey image to tw × th. */
export function resample(g, w, h, tw, th) {
  if (tw === w && th === h) return g;
  const tx = taps(w, tw);
  const ty = taps(h, th);
  const mid = new Float32Array(tw * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < tw; x++) {
      const { idx, wts } = tx[x];
      let v = 0;
      for (let k = 0; k < idx.length; k++) v += g[row + idx[k]] * wts[k];
      mid[y * tw + x] = v;
    }
  }
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const { idx, wts } = ty[y];
    for (let x = 0; x < tw; x++) {
      let v = 0;
      for (let k = 0; k < idx.length; k++) v += mid[idx[k] * tw + x] * wts[k];
      out[y * tw + x] = v;
    }
  }
  return out;
}

/**
 * Variance of the Laplacian, weighted towards the middle of the bird's box: weight 1 − r² inside the
 * ellipse that fits the box (r = 1 at its edge). The middle of a box is mostly bird, so a sharp
 * background showing in the box's corners and margins counts for little.
 */
export function laplacianVariance(g, w, h, { ellipse = true } = {}) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const ax = w / 2;
  const ay = h / 2;
  let n = 0;
  let sw = 0;
  let sum = 0;
  let sum2 = 0;
  for (let y = 1; y < h - 1; y++) {
    const dy = (y - cy) / ay;
    for (let x = 1; x < w - 1; x++) {
      let wt = 1;
      if (ellipse) {
        const dx = (x - cx) / ax;
        wt = 1 - dx * dx - dy * dy;
        if (wt <= 0) continue;
      }
      const p = y * w + x;
      const v = g[p - 1] + g[p + 1] + g[p - w] + g[p + w] - 4 * g[p];
      n++;
      sw += wt;
      sum += wt * v;
      sum2 += wt * v * v;
    }
  }
  if (n < 16 || sw <= 0) return 0;
  const mean = sum / sw;
  return Math.max(0, sum2 / sw - mean * mean);
}

export function fitLong(w, h, long) {
  const s = long / Math.max(w, h);
  return { w: Math.max(8, Math.round(w * s)), h: Math.max(8, Math.round(h * s)) };
}

/**
 * Sharpness of a bird's box (grey pixels at full resolution, or shrunk to no less than the largest size)
 * at each fixed long side in SIZES: always the smallest, larger ones only when the box is at least that big.
 */
export function birdSharpness(g, w, h, sizes = SIZES) {
  const out = {};
  const native = Math.max(w, h);
  for (const L of sizes) {
    if (L !== sizes[0] && L > native) continue;
    const t = fitLong(w, h, L);
    out[L] = laplacianVariance(resample(g, w, h, t.w, t.h), t.w, t.h);
  }
  return out;
}

// ------------------------------------------------------------------ bursts

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const byName = (a, b) => collator.compare(a.name, b.name);

/**
 * Group photos into bursts by capture time: sorted by time, a new burst after a gap of more than
 * `gapMs`. Photos with no usable time form one group, sorted by file name.
 * items: [{name, time}] → [[item, …], …]
 */
export function groupBursts(items, gapMs = BURST_GAP_MS) {
  const timed = items.filter((it) => Number.isFinite(it.time)).sort((a, b) => a.time - b.time || byName(a, b));
  const untimed = items.filter((it) => !Number.isFinite(it.time)).sort(byName);
  const groups = [];
  let cur = null;
  let last = -Infinity;
  for (const it of timed) {
    if (!cur || it.time - last > gapMs) groups.push((cur = []));
    cur.push(it);
    last = it.time;
  }
  if (untimed.length) groups.push(untimed);
  return groups;
}

/** The main bird: the largest box, ties going to the surer find. */
export function mainBird(birds) {
  let best = null;
  for (const b of birds || []) {
    const a = b.bbox.w * b.bbox.h;
    const ba = best ? best.bbox.w * best.bbox.h : -1;
    if (a > ba || (a === ba && (b.confidence ?? 0) > (best.confidence ?? 0))) best = b;
  }
  return best;
}

const STATUS_ORDER = { ok: 0, nobird: 1, unread: 2 };

/**
 * Rank one burst. frames: [{name, status: 'ok'|'nobird'|'unread', sharp: {384: v, …}}].
 * Frames with a bird are compared at the largest size they all have; score = 100 × √(sharpness ÷ the best).
 */
export function rankBurst(frames) {
  const ok = frames.filter((f) => f.status === 'ok' && f.sharp);
  const common = SIZES.filter((L) => ok.length && ok.every((f) => f.sharp[L] != null));
  const size = common.length ? common[common.length - 1] : null;
  const val = (f) => f.sharp[size] ?? 0;
  const best = ok.reduce((m, f) => Math.max(m, val(f)), 0);
  ok.sort((a, b) => val(b) - val(a) || byName(a, b));
  // Score on the square root (the Laplacian's spread rather than its variance), so it falls in step with
  // the detail you can see: about 70 for a frame a little soft, under 30 for one clearly soft.
  for (const f of ok) f.score = best > 0 ? Math.round(100 * Math.sqrt(val(f) / best)) : 0;
  const rest = frames.filter((f) => !ok.includes(f))
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || byName(a, b));
  for (const f of rest) f.score = null;
  return { size, ranked: [...ok, ...rest], keeper: ok[0] || null };
}
