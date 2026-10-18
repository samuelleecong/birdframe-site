// Photo in, birds and crops out, all in this browser tab.
// Decoding and resampling use canvas; geometry comes from core.js.

import {
  SETTINGS, planTiles, decodePass, mapTileDetections, validatedDetection,
  mergeDetections, detectionSize, makeCrops, cropPixelRect, iou, rect,
} from './core.js';
import { SMOOTHING } from './config.js';

const MAX_CANVAS_AREA = 16_000_000; // iOS Safari refuses canvases much larger than this
const MAX_CROP_SIDE = 4096;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Decode a File/Blob or URL into an upright <img> (browsers apply EXIF orientation). */
export async function loadImage(source) {
  const img = new Image();
  img.decoding = 'async';
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
    const err = new Error('decode');
    err.cause = e;
    throw err;
  }
  return {
    img,
    url,
    revoke: () => { if (typeof source !== 'string') URL.revokeObjectURL(url); },
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

/** The pixels the bird finder looks at: at most 2,048 px on the long edge. */
export function makeDetectionCanvas(img, W, H, maxPixelSize = SETTINGS.detectionMaxPixelSize) {
  const { w, h } = detectionSize(W, H, maxPixelSize);
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

/**
 * Run the app's six-pass search (whole photo, four quarters, centre) and
 * merge the results. `onPass` gets {done, total, birds} after each pass,
 * with the birds merged so far, so the page can show early results.
 */
export async function findBirds(detector, detCanvas, W, H, opts = {}) {
  const size = SETTINGS.resolution;
  const plan = planTiles(detCanvas.width, detCanvas.height, W, H);
  const tile = canvas(size, size);
  const ctx = tile.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = opts.smoothing ?? SMOOTHING;
  // Like CGImage.cropping(to:), copy each tile's pixels out first, so resampling
  // at the tile's edges never sees pixels from outside the tile.
  const cropFirst = opts.cropFirst ?? true;
  const piece = cropFirst ? canvas(1, 1) : null;
  const pieceCtx = piece?.getContext('2d');
  const all = [];
  const timings = [];
  for (let i = 0; i < plan.tiles.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const t = plan.tiles[i];
    let source = detCanvas;
    let sx = t.src.x;
    let sy = t.src.y;
    if (cropFirst && !(t.src.x === 0 && t.src.y === 0 && t.src.w === detCanvas.width && t.src.h === detCanvas.height)) {
      piece.width = t.src.w;
      piece.height = t.src.h;
      pieceCtx.drawImage(detCanvas, t.src.x, t.src.y, t.src.w, t.src.h, 0, 0, t.src.w, t.src.h);
      source = piece;
      sx = 0;
      sy = 0;
    }
    // Opaque black under the photo matches the app's premultiplied copy for PNGs with transparency.
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(source, sx, sy, t.src.w, t.src.h, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data.buffer;
    const out = await detector.run(rgba, size);
    timings.push(out.ms);
    const decoded = decodePass(out.boxes, out.logits, t.src.w, t.src.h, {
      classCount: out.classCount,
      birdClassIndex: out.birdClassIndex,
    });
    const mapped = mapTileDetections(decoded, t, plan);
    all.push(...mapped);
    opts.onPass?.({
      done: i + 1,
      total: plan.tiles.length,
      source: t.source,
      tileDetections: mapped,
      birds: mergeDetections(all.map((d) => validatedDetection(d, W, H)).filter(Boolean), W, H),
    });
  }
  const valid = all.map((d) => validatedDetection(d, W, H)).filter(Boolean);
  return { birds: mergeDetections(valid, W, H), raw: valid, timings };
}

export { makeCrops };

/** Draw one crop from the full-resolution image, scaled down only if a canvas that big would fail. */
export function renderCrop(img, cropRect, W, H) {
  const src = cropPixelRect(cropRect, W, H);
  let scale = 1;
  const long = Math.max(src.w, src.h);
  if (long > MAX_CROP_SIDE) scale = MAX_CROP_SIDE / long;
  if (src.w * src.h * scale * scale > MAX_CANVAS_AREA) scale = Math.sqrt(MAX_CANVAS_AREA / (src.w * src.h));
  const w = Math.max(1, Math.round(src.w * scale));
  const h = Math.max(1, Math.round(src.h * scale));
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // The decoded image may be smaller than the coordinate space (samples, capped decodes).
  const sx = img.naturalWidth / W;
  const sy = img.naturalHeight / H;
  ctx.drawImage(img, src.x * sx, src.y * sy, src.w * sx, src.h * sy, 0, 0, w, h);
  return c;
}

// Some graphics drivers return wrong boxes without any error. Before trusting
// WebGPU, run one known 512 x 512 picture (the red finch) and check the answer.
const SELF_TEST = { url: new URL('../samples/selftest.jpg', import.meta.url).href, box: rect(158.7, 157.2, 161.8, 191.5), minConfidence: 0.6, minIoU: 0.7 };

export async function passesSelfTest(detector) {
  let img;
  try {
    img = new Image();
    img.src = SELF_TEST.url;
    await img.decode();
  } catch {
    return true; // test picture missing: nothing to check against
  }
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 512, 512);
  const out = await detector.run(ctx.getImageData(0, 0, 512, 512).data.buffer, 512);
  const found = decodePass(out.boxes, out.logits, 512, 512, { classCount: out.classCount, birdClassIndex: out.birdClassIndex });
  return found.some((d) => d.confidence >= SELF_TEST.minConfidence && iou(d.bbox, SELF_TEST.box) >= SELF_TEST.minIoU);
}
