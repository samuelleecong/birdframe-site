// BirdFrame web demo: detection geometry, merging and framing.
//
// A line-by-line port of the Mac app's pipeline (v1.2):
//   DETRCoreMLDetector.swift   decode one 512x512 pass (bird slot 16, sigmoid, 0.50)
//   GeometryHelpers.swift      createTilingCrops, validatedDetection, calculateCrop
//                              and DetectionCoordinateMapping (2,048 px decode)
//   ImageProcessor.swift       processTiling, makeCropResults
//   DetectionMerge.swift       merge (confidence-first, source-aware NMS)
//   ProcessingSettings.swift   Tight/Balanced/Wide = 2/3/5, 1:1, min crop 20 px
//
// Pure functions only (no DOM), so the parity tools can run this file as is.
// Rectangles are {x, y, w, h} in pixels. Swift's CGFloat is a double, like a
// JS number; Swift Float values (confidence, raw box values) go through
// Math.fround so threshold comparisons round the same way.

const f32 = Math.fround;

export const SETTINGS = Object.freeze({
  resolution: 512,
  birdClassIndex: 16,
  classCount: 91,
  confidenceThreshold: 0.5,
  iouThreshold: 0.5,
  minCropSize: 20,
  detectionMaxPixelSize: 2048,
  aspectRatio: 1.0, // the app's default: 1:1 square
});

export const FRAMING = Object.freeze({
  tight: 2.0,
  balanced: 3.0,
  wide: 5.0,
});

export const MEAN = [0.485, 0.456, 0.406];
export const STD = [0.229, 0.224, 0.225];

// ---------------------------------------------------------------- rectangles

export const rect = (x, y, w, h) => ({ x, y, w, h });
const maxX = (r) => r.x + r.w;
const maxY = (r) => r.y + r.h;
const midX = (r) => r.x + r.w / 2;
const midY = (r) => r.y + r.h / 2;

/** CGRect.intersection; null when the rectangles do not overlap. */
export function intersection(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(maxX(a), maxX(b));
  const y2 = Math.min(maxY(a), maxY(b));
  if (x2 < x1 || y2 < y1) return null;
  return rect(x1, y1, x2 - x1, y2 - y1);
}

/** CGRect.integral: smallest whole-pixel rectangle containing r. */
export function integral(r) {
  const x1 = Math.floor(r.x);
  const y1 = Math.floor(r.y);
  return rect(x1, y1, Math.ceil(maxX(r)) - x1, Math.ceil(maxY(r)) - y1);
}

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const area = (r) => r.w * r.h;

export function iou(a, b) {
  const i = intersection(a, b);
  if (!i) return 0;
  const inter = i.w * i.h;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of the smaller box that sits inside the larger one. */
export function containment(a, b) {
  const i = intersection(a, b);
  if (!i) return 0;
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 ? (i.w * i.h) / smaller : 0;
}

// ------------------------------------------------------------------- tiling

export const SOURCES = ['full', 'top_left', 'top_right', 'bottom_left', 'bottom_right', 'center'];
const PRIORITY = { center: 3, top_left: 2, top_right: 2, bottom_left: 2, bottom_right: 2, full: 1 };

/** GeometryHelpers.createTilingCrops: full frame, four quadrants, centre. */
export function createTilingCrops(W, H) {
  const halfW = W / 2;
  const halfH = H / 2;
  const quarterW = W / 4;
  const quarterH = H / 4;
  return [
    { source: 'full', rect: rect(0, 0, W, H) },
    { source: 'top_left', rect: rect(0, 0, halfW, halfH) },
    { source: 'top_right', rect: rect(halfW, 0, halfW, halfH) },
    { source: 'bottom_left', rect: rect(0, halfH, halfW, halfH) },
    { source: 'bottom_right', rect: rect(halfW, halfH, halfW, halfH) },
    { source: 'center', rect: rect(quarterW, quarterH, W - 2 * quarterW, H - 2 * quarterH) },
  ];
}

/** Long edge capped at 2,048 px, like ImageIO's thumbnail decode in the app. */
export function detectionSize(W, H, maxPixelSize = SETTINGS.detectionMaxPixelSize) {
  const long = Math.max(W, H);
  if (long <= maxPixelSize) return { w: W, h: H };
  const s = maxPixelSize / long;
  return W >= H
    ? { w: maxPixelSize, h: Math.max(1, Math.round(H * s)) }
    : { w: Math.max(1, Math.round(W * s)), h: maxPixelSize };
}

/** DetectionCoordinateMapping: detector pixels <-> full-resolution coordinates. */
export class CoordinateMapping {
  constructor(pixelW, pixelH, coordW, coordH) {
    this.pw = pixelW;
    this.ph = pixelH;
    this.cw = coordW ?? pixelW;
    this.ch = coordH ?? pixelH;
  }

  get isIdentity() {
    return (this.pw === this.cw && this.ph === this.ch)
      || this.pw <= 0 || this.ph <= 0 || this.cw <= 0 || this.ch <= 0;
  }

  pixelRect(r) {
    if (this.isIdentity) return r;
    const scaled = rect(
      (r.x * this.pw) / this.cw,
      (r.y * this.ph) / this.ch,
      (r.w * this.pw) / this.cw,
      (r.h * this.ph) / this.ch,
    );
    return intersection(integral(scaled), rect(0, 0, this.pw, this.ph));
  }

  coordinateRect(r) {
    if (this.isIdentity) return r;
    const sx = this.cw / this.pw;
    const sy = this.ch / this.ph;
    return rect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
  }
}

/**
 * The pixels CGImage.cropping(to:) hands the detector for a tile: the
 * whole-pixel rectangle containing `r`, clipped to the image. The detections
 * are still offset by `r`'s own origin, exactly as the app does.
 */
export function tileSourceRect(r, imageW, imageH) {
  return intersection(integral(r), rect(0, 0, imageW, imageH));
}

/** The tiles to run for one photo, with everything needed to map boxes back. */
export function planTiles(pixelW, pixelH, coordW, coordH) {
  const mapping = new CoordinateMapping(pixelW, pixelH, coordW, coordH);
  const tiles = [];
  for (const { source, rect: cropRect } of createTilingCrops(mapping.cw, mapping.ch)) {
    const pixelCropRect = mapping.pixelRect(cropRect);
    if (!pixelCropRect) continue;
    const src = tileSourceRect(pixelCropRect, pixelW, pixelH);
    if (!src || src.w <= 0 || src.h <= 0) continue;
    tiles.push({ source, cropRect, pixelCropRect, src });
  }
  return { mapping, imageW: mapping.cw, imageH: mapping.ch, tiles };
}

// ---------------------------------------------------------- decode one pass

export function sigmoid(v) {
  const c = Math.min(88, Math.max(-88, v));
  return f32(1 / (1 + Math.exp(-c)));
}

/**
 * DETRCoreMLDetector.detectBirds + decodeDetection for one pass.
 * `boxes` is [Q*4] cxcywh normalised, `logits` is [Q*classCount].
 * Returns boxes in the tile's own pixel space (tileW x tileH).
 */
export function decodePass(boxes, logits, tileW, tileH, opts = {}) {
  const threshold = opts.threshold ?? SETTINGS.confidenceThreshold;
  const classCount = opts.classCount ?? SETTINGS.classCount;
  const bird = opts.birdClassIndex ?? SETTINGS.birdClassIndex;
  const queries = Math.min(boxes.length / 4, logits.length / classCount);
  const out = [];
  for (let q = 0; q < queries; q++) {
    const confidence = sigmoid(logits[q * classCount + bird]);
    if (!(confidence >= f32(threshold))) continue;
    const cx = boxes[q * 4];
    const cy = boxes[q * 4 + 1];
    const bw = boxes[q * 4 + 2];
    const bh = boxes[q * 4 + 3];
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(bw) || !Number.isFinite(bh)) continue;
    if (!(bw > 0 && bh > 0)) continue;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const x1 = clamp01(f32(cx - f32(bw / 2)));
    const y1 = clamp01(f32(cy - f32(bh / 2)));
    const x2 = clamp01(f32(cx + f32(bw / 2)));
    const y2 = clamp01(f32(cy + f32(bh / 2)));
    const pw = (x2 - x1) * tileW;
    const ph = (y2 - y1) * tileH;
    if (!(pw > 1 && ph > 1)) continue;
    out.push({ bbox: rect(x1 * tileW, y1 * tileH, pw, ph), confidence });
  }
  return out;
}

/**
 * Only the queries that can pass the threshold, so a worker can send back a
 * few numbers instead of 300x91 logits. Same layout as decodePass expects.
 */
export function selectBirdQueries(boxes, logits, opts = {}) {
  const threshold = opts.threshold ?? SETTINGS.confidenceThreshold;
  const classCount = opts.classCount ?? SETTINGS.classCount;
  const bird = opts.birdClassIndex ?? SETTINGS.birdClassIndex;
  const queries = Math.min(boxes.length / 4, logits.length / classCount);
  const keptBoxes = [];
  const keptLogits = [];
  for (let q = 0; q < queries; q++) {
    const logit = logits[q * classCount + bird];
    if (!(sigmoid(logit) >= f32(threshold))) continue;
    keptBoxes.push(boxes[q * 4], boxes[q * 4 + 1], boxes[q * 4 + 2], boxes[q * 4 + 3]);
    keptLogits.push(logit);
  }
  return { boxes: Float32Array.from(keptBoxes), logits: Float32Array.from(keptLogits), classCount: 1, birdClassIndex: 0 };
}

/** RGBA pixels of a 512x512 pass -> ImageNet-normalised NCHW float32. */
export function rgbaToTensor(rgba, size = SETTINGS.resolution) {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const scale = 1 / (255 * STD[c]);
    const shift = MEAN[c] / STD[c];
    const base = c * n;
    for (let i = 0, p = c; i < n; i++, p += 4) {
      out[base + i] = rgba[p] * scale - shift;
    }
  }
  return out;
}

// --------------------------------------------------------------- validation

/** GeometryHelpers.validatedDetection: reject wild boxes, clip edge slop. */
export function validatedDetection(d, W, H) {
  const b = d.bbox;
  if (!(W > 1 && H > 1 && Number.isFinite(W) && Number.isFinite(H))) return null;
  if (![b.x, b.y, maxX(b), maxY(b)].every(Number.isFinite)) return null;
  if (!(b.w > 1 && b.h > 1)) return null;
  const tol = 1;
  if (!(b.x >= -tol && b.y >= -tol && maxX(b) <= W + tol && maxY(b) <= H + tol)) return null;
  const clipped = intersection(b, rect(0, 0, W, H));
  if (!clipped || !(clipped.w > 1 && clipped.h > 1)) return null;
  if (sameRect(clipped, b)) return d;
  return { ...d, bbox: clipped };
}

/**
 * ImageProcessor.processTiling, after inference: map one tile's detections
 * back to full-resolution coordinates and validate them.
 */
export function mapTileDetections(tileDetections, tile, plan) {
  const out = [];
  for (const det of tileDetections) {
    const shifted = rect(
      det.bbox.x + tile.pixelCropRect.x,
      det.bbox.y + tile.pixelCropRect.y,
      det.bbox.w,
      det.bbox.h,
    );
    const mapped = {
      bbox: plan.mapping.coordinateRect(shifted),
      confidence: det.confidence,
      source: tile.source,
    };
    const valid = validatedDetection(mapped, plan.imageW, plan.imageH);
    if (valid) out.push(valid);
  }
  return out;
}

// -------------------------------------------------------------------- merge

const MERGE = Object.freeze({
  containmentThreshold: 0.5,
  weakFullFragmentContainmentThreshold: 0.35,
  weakFullFragmentConfidenceGap: f32(0.25),
  clippedFragmentContainmentThreshold: 0.85,
  clippedFragmentSupportConfidence: f32(0.5),
  seamComparableDimensionRatio: 0.9,
  seamDuplicateContainmentThreshold: 0.25,
  seamDuplicateMaxCenterOffset: 0.65,
  seamProximityInBoxLengths: 1.25,
});

function tileRectFor(source, W, H) {
  if (source === 'full') return null;
  return createTilingCrops(W, H).find((c) => c.source === source)?.rect ?? null;
}

function clippedSides(box, tile, W, H) {
  const tol = Math.max(2, Math.min(tile.w, tile.h) * 0.01);
  const sides = [];
  if (tile.x > 0 && Math.abs(box.x - tile.x) <= tol) sides.push('minX');
  if (maxX(tile) < W && Math.abs(maxX(box) - maxX(tile)) <= tol) sides.push('maxX');
  if (tile.y > 0 && Math.abs(box.y - tile.y) <= tol) sides.push('minY');
  if (maxY(tile) < H && Math.abs(maxY(box) - maxY(tile)) <= tol) sides.push('maxY');
  return sides;
}

function isComplete(d, W, H) {
  const tile = tileRectFor(d.source, W, H);
  if (!tile) return true;
  return clippedSides(d.bbox, tile, W, H).length === 0;
}

function supportExtends(support, candidate, side) {
  switch (side) {
    case 'minX': return support.x < candidate.x;
    case 'maxX': return maxX(support) > maxX(candidate);
    case 'minY': return support.y < candidate.y;
    default: return maxY(support) > maxY(candidate);
  }
}

function removeSupportedClippedFragments(dets, W, H) {
  return dets.filter((candidate) => {
    const tile = tileRectFor(candidate.source, W, H);
    if (!tile) return true;
    const sides = clippedSides(candidate.bbox, tile, W, H);
    if (sides.length === 0) return true;
    return !dets.some((support) => {
      if (support.id === candidate.id || support.source === candidate.source) return false;
      if (!(support.confidence >= MERGE.clippedFragmentSupportConfidence)) return false;
      if (!isComplete(support, W, H)) return false;
      const i = intersection(candidate.bbox, support.bbox);
      const inter = i ? i.w * i.h : 0;
      if (!(inter / Math.max(area(candidate.bbox), 1) >= MERGE.clippedFragmentContainmentThreshold)) return false;
      return sides.some((side) => supportExtends(support.bbox, candidate.bbox, side));
    });
  });
}

function distanceTo(lower, upper, value) {
  if (value < lower) return lower - value;
  if (value > upper) return value - upper;
  return 0;
}

function isAdjacentToInternalSeam(d, W, H) {
  let vertical;
  let horizontal;
  switch (d.source) {
    case 'full': return false;
    case 'center':
      vertical = [W / 4, (W * 3) / 4];
      horizontal = [H / 4, (H * 3) / 4];
      break;
    default:
      vertical = [W / 2];
      horizontal = [H / 2];
  }
  const b = d.bbox;
  const nearV = vertical.some((s) => distanceTo(b.x, maxX(b), s) <= b.w * MERGE.seamProximityInBoxLengths);
  const nearH = horizontal.some((s) => distanceTo(b.y, maxY(b), s) <= b.h * MERGE.seamProximityInBoxLengths);
  return nearV || nearH;
}

function isComparableSeamDuplicate(a, b, W, H) {
  const A = a.bbox;
  const B = b.bbox;
  if (!(A.w > 0 && A.h > 0 && B.w > 0 && B.h > 0 && W > 0 && H > 0)) return false;
  const widthRatio = Math.min(A.w, B.w) / Math.max(A.w, B.w);
  const heightRatio = Math.min(A.h, B.h) / Math.max(A.h, B.h);
  if (!(widthRatio >= MERGE.seamComparableDimensionRatio
    && heightRatio >= MERGE.seamComparableDimensionRatio
    && containment(A, B) >= MERGE.seamDuplicateContainmentThreshold)) return false;
  const dx = Math.abs(midX(A) - midX(B)) / Math.max(A.w, B.w);
  const dy = Math.abs(midY(A) - midY(B)) / Math.max(A.h, B.h);
  if (!(dx <= MERGE.seamDuplicateMaxCenterOffset && dy <= MERGE.seamDuplicateMaxCenterOffset)) return false;
  return isAdjacentToInternalSeam(a, W, H) !== isAdjacentToInternalSeam(b, W, H);
}

function isDuplicate(a, b, iouThreshold, W, H) {
  if (iou(a.bbox, b.bbox) >= iouThreshold) return true;
  if (a.source === b.source) return false;
  const c = containment(a.bbox, b.bbox);
  if (c >= MERGE.containmentThreshold) return true;
  const stronger = a.confidence >= b.confidence ? a : b;
  const weaker = a.confidence >= b.confidence ? b : a;
  if (weaker.source === 'full'
    && stronger.source !== 'full'
    && f32(stronger.confidence - weaker.confidence) >= MERGE.weakFullFragmentConfidenceGap
    && c >= MERGE.weakFullFragmentContainmentThreshold) return true;
  if (W == null || H == null) return false;
  return isComparableSeamDuplicate(a, b, W, H);
}

function bestFirst(a, b) {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (PRIORITY[a.source] !== PRIORITY[b.source]) return PRIORITY[b.source] - PRIORITY[a.source];
  return area(b.bbox) - area(a.bbox);
}

/** DetectionMerge.merge: one canonical detection per bird, best first. */
export function mergeDetections(dets, W, H, iouThreshold = SETTINGS.iouThreshold) {
  if (dets.length === 0) return [];
  const withIds = dets.map((d, i) => (d.id == null ? { ...d, id: i } : d));
  const candidates = W > 0 && H > 0 ? removeSupportedClippedFragments(withIds, W, H) : withIds;
  let remaining = [...candidates].sort(bestFirst);
  const kept = [];
  while (remaining.length) {
    const best = remaining.shift();
    kept.push(best);
    remaining = remaining.filter((other) => !isDuplicate(best, other, iouThreshold, W, H));
  }
  return kept;
}

// ------------------------------------------------------------------ framing

function isContained(r, W, H) {
  return r.x >= 0 && r.y >= 0 && maxX(r) <= W && maxY(r) <= H;
}

function shiftedInto(r, W, H) {
  let dx = 0;
  let dy = 0;
  if (r.x < 0) dx = -r.x;
  else if (maxX(r) > W) dx = W - maxX(r);
  if (r.y < 0) dy = -r.y;
  else if (maxY(r) > H) dy = H - maxY(r);
  return rect(r.x + dx, r.y + dy, r.w, r.h);
}

function hardClamped(r, W, H) {
  const x1 = Math.max(0, r.x);
  const y1 = Math.max(0, r.y);
  const x2 = Math.min(W, maxX(r));
  const y2 = Math.min(H, maxY(r));
  return rect(x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1));
}

const centered = (cx, cy, w, h) => rect(cx - w / 2, cy - h / 2, w, h);

/** GeometryHelpers.calculateCrop: bird fills 1/centerFraction of the crop. */
export function calculateCrop(bbox, W, H, centerFraction, aspectRatio = SETTINGS.aspectRatio) {
  const cx = midX(bbox);
  const cy = midY(bbox);
  let cw = bbox.w * centerFraction;
  let ch = bbox.h * centerFraction;
  if (aspectRatio != null) {
    if (cw / ch > aspectRatio) ch = cw / aspectRatio;
    else cw = ch * aspectRatio;
  }
  let r = centered(cx, cy, cw, ch);
  if (isContained(r, W, H)) return r;
  r = shiftedInto(r, W, H);
  if (isContained(r, W, H)) return r;
  if (aspectRatio != null) {
    if (cw / W > ch / H) {
      cw = W;
      ch = cw / aspectRatio;
    } else {
      ch = H;
      cw = ch * aspectRatio;
    }
    r = shiftedInto(centered(cx, cy, cw, ch), W, H);
  }
  return hardClamped(r, W, H);
}

/** ImageProcessor.makeCropResults: crop rectangles in full-resolution space. */
export function makeCrops(detections, W, H, centerFraction, opts = {}) {
  const minCropSize = opts.minCropSize ?? SETTINGS.minCropSize;
  const aspectRatio = opts.aspectRatio === undefined ? SETTINGS.aspectRatio : opts.aspectRatio;
  const crops = [];
  detections.forEach((raw, index) => {
    const d = validatedDetection(raw, W, H);
    if (!d) return;
    if (!(d.bbox.w >= minCropSize && d.bbox.h >= minCropSize)) return;
    crops.push({
      cropIndex: index + 1,
      detection: d,
      cropRect: calculateCrop(d.bbox, W, H, centerFraction, aspectRatio),
    });
  });
  return crops;
}

/** The whole-pixel source rectangle used when the crop is rendered. */
export function cropPixelRect(cropRect, W, H) {
  return intersection(integral(cropRect), rect(0, 0, W, H));
}
