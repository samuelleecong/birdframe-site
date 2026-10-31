// Burst Picker page logic. No uploads: each photo is opened, searched and measured in this tab with the
// demo's bird finder (../demo/js), one photo at a time, and only small thumbnails and the keeper crops are kept.

import { startDetector as startBackend, webgpuAvailable, wasmAvailable } from '../demo/js/detector.js';
import { makeDetectionCanvas, findBirds, passesSelfTest, loadImage } from '../demo/js/pipeline.js';
import { FRAMING, calculateCrop, cropPixelRect } from '../demo/js/core.js';
import { MODEL_FILES } from '../demo/js/config.js';
import { RAW_EXT, readCaptureInfo, findPreviews, grayFromRGBA, birdSharpness, groupBursts, mainBird, rankBurst, byName } from './burst.js';

const MAX_FILES = 60;
const EARLY_AREA = 0.01; // a bird filling 1% of the frame on the first, whole-photo pass is the main bird: skip the closer look
const MEASURE_MAX = 2048; // the bird's box is measured at full resolution, shrunk only past this
const THUMB_SIDE = 192; // shown at 96 px
const DOWNLOAD_MAX_SIDE = 1000; // downloads are a taste; the Mac app saves full-size crops
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp|tiff?)$/i;

const $ = (id) => document.getElementById(id);
const els = {
  choose: $('choose'), file: $('file'), drop: $('drop'), work: $('work'), status: $('status'),
  meter: $('meter'), progress: $('progress'), problem: $('problem'), results: $('results'), cta: $('cta-results'),
};

let detectorPromise = null;
let detectorEp = null;
let run = null; // {controller}
let urls = []; // object URLs of the current results, revoked on the next run

// ------------------------------------------------------------------ helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-') || k.startsWith('aria-') || ['role', 'download', 'href', 'alt', 'src', 'width', 'height', 'type', 'loading'].includes(k)) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const toBlob = (c, q = 0.9) => new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', q));
const nf = (n) => Math.round(n).toLocaleString('en-US');
const mb = (bytes) => (bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0);

function keepUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}

function setStatus(text) {
  els.status.textContent = text;
}

function setProgress(fraction) {
  els.meter.hidden = fraction == null;
  if (fraction != null) els.progress.value = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

function showProblem(message, actions = []) {
  els.problem.replaceChildren(el('p', { text: message }));
  if (actions.length) els.problem.append(el('div', { class: 'row' }, ...actions));
  els.problem.hidden = false;
  setProgress(null);
}

function baseName(name) {
  return (name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
}

// ------------------------------------------------------------- bird finder (as in the demo)

function getDetector() {
  if (!detectorPromise) {
    const start = (ep) => startBackend({
      ep,
      onProgress: ({ loaded, total, cached }) => {
        if (cached || (total && loaded >= total)) {
          setStatus('Getting the bird finder ready…');
          setProgress(null);
          return;
        }
        setStatus(`Getting the bird finder ready: ${mb(loaded)} of ${mb(total || MODEL_FILES[0].bytes)} MB. It downloads once, then your browser keeps it.`);
        setProgress(total ? loaded / total : null);
      },
    });
    detectorPromise = (async () => {
      if (!wasmAvailable()) {
        const err = new Error('unsupported');
        err.stage = 'unsupported';
        throw err;
      }
      if (await webgpuAvailable()) {
        try {
          const d = await start('webgpu');
          if (await passesSelfTest(d)) {
            detectorEp = 'webgpu';
            return d;
          }
          d.terminate();
        } catch (e) {
          if (e.stage === 'download') throw e;
        }
      }
      const d = await start('wasm');
      detectorEp = 'wasm';
      return d;
    })();
    detectorPromise.catch(() => { detectorPromise = null; });
  }
  return detectorPromise;
}

function explainDetectorError(e, retry) {
  setStatus('');
  const again = el('button', { type: 'button', class: 'btn small', text: 'Try again', onclick: retry });
  if (e.stage === 'unsupported') showProblem("This browser can't run the bird finder. Try the latest Safari, Chrome, Edge or Firefox on a computer.");
  else if (e.stage === 'download') showProblem("Couldn't download the bird finder. Check your connection and try again.", [again]);
  else if (e.stage === 'runtime') showProblem("The bird finder couldn't start. Check your connection and try again, or try the latest Safari, Chrome, Edge or Firefox.", [again]);
  else showProblem('This device ran short of memory. Close other tabs and try again with fewer photos.', [again]);
}

/** The demo's search; if the whole-photo pass already found a sizeable bird, that's the main bird: stop there. */
async function detect(detector, detCanvas, W, H, signal) {
  const stop = new AbortController();
  const onOuterAbort = () => stop.abort();
  signal.addEventListener('abort', onOuterAbort);
  let early = null;
  try {
    const r = await findBirds(detector, detCanvas, W, H, {
      signal: stop.signal,
      onPass: ({ done, birds }) => {
        if (done === 1 && !signal.aborted && birds.some((b) => b.bbox.w * b.bbox.h >= EARLY_AREA * W * H)) {
          early = birds;
          stop.abort();
        }
      },
    });
    return r.birds;
  } catch (e) {
    if (early && !signal.aborted) return early;
    throw e;
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }
}

// ------------------------------------------------------------------ photos

/** Decode a Blob at full size, upright. {image, width, height, close()} */
async function decode(blob) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    if (e instanceof TypeError) bitmap = await createImageBitmap(blob).catch(() => null); // older browsers: no options
  }
  if (bitmap) return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  const loaded = await loadImage(blob); // last try: an <img> (HEIC in Safari)
  return { image: loaded.img, width: loaded.width, height: loaded.height, close: () => { loaded.revoke(); loaded.img.removeAttribute('src'); } };
}

/**
 * A RAW file's preview usually has no orientation of its own; the RAW file says how to turn it.
 * Turn the decoded preview upright (3: half turn, 6: quarter turn clockwise, 8: anticlockwise).
 */
async function upright(src, orientation) {
  if (![3, 6, 8].includes(orientation)) return src;
  try {
    const swap = orientation !== 3;
    const w = swap ? src.height : src.width;
    const h = swap ? src.width : src.height;
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    if (orientation === 3) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    else if (orientation === 6) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
    else { ctx.translate(0, h); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(src.image, 0, 0);
    const bitmap = await createImageBitmap(c);
    c.width = 0;
    src.close();
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    return src; // too big to turn on this device: measure it as it is
  }
}

async function decodePreview(file, preview) {
  return upright(await decode(file.slice(preview.start, preview.end, 'image/jpeg')), preview.turn);
}

/** Open one file: a photo, or the largest JPEG preview inside a RAW file. */
async function open(file) {
  if (RAW_EXT.test(file.name)) {
    let bytes = new Uint8Array(await file.arrayBuffer());
    const info = readCaptureInfo(bytes);
    let time = info.time;
    const candidates = findPreviews(bytes);
    let preview = null;
    let source = null;
    for (const c of candidates) {
      const own = readCaptureInfo(bytes.subarray(c.start, c.end));
      const p = { start: c.start, end: c.end, turn: own.orientation == null ? info.orientation : null };
      try {
        source = await decodePreview(file, p);
        preview = p;
        if (time == null) time = own.time;
        break;
      } catch { /* try the next one */ }
    }
    bytes = null;
    return { time, source, preview };
  }
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const time = readCaptureInfo(head).time;
  let source = null;
  try {
    source = await decode(file);
  } catch { /* unreadable */ }
  return { time, source, preview: null };
}

/** The bird's box from the full-size decode, as grey pixels, then its sharpness. */
function measure(image, bbox, W, H) {
  const r = cropPixelRect(bbox, W, H);
  const s = Math.min(1, MEASURE_MAX / Math.max(r.w, r.h));
  const w = Math.max(8, Math.round(r.w * s));
  const h = Math.max(8, Math.round(r.h * s));
  const c = canvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const gray = grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
  c.width = 0;
  return birdSharpness(gray, w, h);
}

/** A small JPEG of part of an image: the whole frame, or a tight crop around the bird so frames are easy to compare. */
async function thumbnail(image, r) {
  const s = THUMB_SIDE / Math.max(r.w, r.h);
  const c = canvas(Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const blob = await toBlob(c, 0.85);
  c.width = 0;
  return blob ? keepUrl(blob) : null;
}

async function processFile(file, detector, signal) {
  const rec = { name: file.name, file, status: 'unread', time: null, sharp: null, bird: null, W: 0, H: 0, thumb: null, preview: null };
  const opened = await open(file);
  rec.time = opened.time;
  rec.preview = opened.preview;
  const source = opened.source;
  if (!source) {
    rec.problem = RAW_EXT.test(file.name) ? "Couldn't read this file's preview" : "Couldn't open this file";
    return rec;
  }
  try {
    const W = source.width;
    const H = source.height;
    rec.W = W;
    rec.H = H;
    let detCanvas = makeDetectionCanvas(source.image, W, H);
    let main = null;
    try {
      const birds = await detect(detector, detCanvas, W, H, signal);
      main = mainBird(birds);
      rec.birdCount = birds.length;
      if (!main) rec.thumb = await thumbnail(detCanvas, { x: 0, y: 0, w: detCanvas.width, h: detCanvas.height });
    } finally {
      detCanvas.width = 0; // free the working copy
      detCanvas = null;
    }
    if (!main) {
      rec.status = 'nobird';
      return rec;
    }
    rec.bird = main.bbox;
    rec.sharp = measure(source.image, main.bbox, W, H);
    rec.thumb = await thumbnail(source.image, cropPixelRect(calculateCrop(main.bbox, W, H, FRAMING.tight), W, H));
    rec.status = 'ok';
    return rec;
  } finally {
    source.close();
  }
}

/** The keeper's crop, Balanced framing as in the demo, from the full-size frame (download capped at 1,000 px). */
async function keeperCrop(rec) {
  const src = rec.preview ? await decodePreview(rec.file, rec.preview) : await decode(rec.file);
  try {
    const r = cropPixelRect(calculateCrop(rec.bird, rec.W, rec.H, FRAMING.balanced), rec.W, rec.H);
    const s = Math.min(1, DOWNLOAD_MAX_SIDE / Math.max(r.w, r.h));
    const c = canvas(Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s)));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.image, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const out = await toBlob(c, 0.92);
    const size = { w: c.width, h: c.height };
    c.width = 0;
    return out ? { url: keepUrl(out), ...size, fullW: r.w, fullH: r.h } : null;
  } finally {
    src.close();
  }
}

// ------------------------------------------------------------------ a run

function pickFiles(list) {
  const all = [...(list || [])].filter((f) => f.size > 0 && (RAW_EXT.test(f.name) || IMAGE_EXT.test(f.name) || f.type.startsWith('image/')));
  all.sort(byName);
  return { files: all.slice(0, MAX_FILES), skipped: Math.max(0, all.length - MAX_FILES), ignored: (list?.length || 0) - all.length };
}

async function start(list) {
  const { files, skipped, ignored } = pickFiles(list);
  run?.controller.abort();
  const controller = new AbortController();
  run = { controller };
  const { signal } = controller;
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  els.results.replaceChildren();
  els.results.removeAttribute('data-done');
  els.cta.hidden = true;
  els.problem.hidden = true;
  els.work.hidden = false;
  if (!files.length) {
    setStatus('');
    showProblem(ignored ? "Those files aren't photos this page can read. Choose JPEG, PNG, WebP, HEIC or RAW files." : 'Choose some photos to check.');
    return;
  }
  setStatus('Getting the bird finder ready…');
  setProgress(null);
  els.work.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  let detector;
  try {
    detector = await getDetector();
  } catch (e) {
    if (!signal.aborted) explainDetectorError(e, () => start(files));
    return;
  }
  if (signal.aborted) return;

  const t0 = performance.now();
  const records = [];
  let birds = 0;
  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) return;
    const f = files[i];
    setStatus(`Checking photo ${i + 1} of ${files.length}: ${f.name}${birds ? ` · birds so far: ${birds}` : ''}`);
    setProgress(i / files.length);
    let rec;
    try {
      rec = await processFile(f, detector, signal);
    } catch (e) {
      if (signal.aborted) return;
      if (e.stage && detectorEp === 'webgpu') {
        // A graphics chip that fails mid-run: carry on with the slower, steadier path.
        detector.terminate();
        detectorPromise = null;
        detectorEp = null;
        try {
          detector = await (async () => { const d = await startBackend({ ep: 'wasm' }); detectorEp = 'wasm'; detectorPromise = Promise.resolve(d); return d; })();
          i -= 1;
          continue;
        } catch (e2) {
          explainDetectorError(e2, () => start(files));
          return;
        }
      }
      if (e.stage) {
        explainDetectorError(e, () => start(files));
        return;
      }
      rec = { name: f.name, file: f, status: 'unread', problem: "Couldn't open this file" };
    }
    if (rec.status === 'ok') birds += 1;
    records.push(rec);
  }
  if (signal.aborted) return;
  setProgress(1);
  setStatus('Cropping the keepers…');
  await showResults(records, { skipped, signal });
  if (signal.aborted) return;
  const seconds = (performance.now() - t0) / 1000;
  setProgress(null);
  setStatus(`Checked ${files.length} photo${files.length === 1 ? '' : 's'} in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} seconds.`);
  els.results.dataset.seconds = seconds.toFixed(2);
  els.results.dataset.done = 'true';
}

// ------------------------------------------------------------------ results

const clock = (ms) => new Date(ms).toISOString().slice(11, 19); // capture times are camera clock times; shown as is

function frameItem(rec, isKeeper) {
  const flag = rec.status === 'nobird' ? 'No bird found' : rec.status === 'unread' ? (rec.problem || "Couldn't open this file") : null;
  const detail = rec.status === 'ok' ? `Bird ${nf(rec.bird.w)} × ${nf(rec.bird.h)} px` : flag;
  return el('li', { class: 'frame' + (isKeeper ? ' best' : '') + (rec.status !== 'ok' ? ' flagged' : ''), 'data-name': rec.name, 'data-score': rec.score ?? '', 'data-status': rec.status },
    rec.thumb ? el('img', { src: rec.thumb, alt: '', loading: 'lazy' }) : el('span', { class: 'nothumb', 'aria-hidden': 'true' }),
    el('span', { class: 'fname', text: rec.name }),
    el('span', { class: 'fmeta' }, el('span', { text: detail })),
    el('span', { class: 'score', text: rec.status === 'ok' ? String(rec.score) : '–', 'aria-label': rec.status === 'ok' ? `Sharpness ${rec.score} of 100` : flag }));
}

async function showResults(records, { skipped, signal }) {
  const groups = groupBursts(records);
  const bursts = groups.map((g) => ({ photos: g, ...rankBurst(g) }));
  const keepers = bursts.map((b) => b.keeper).filter(Boolean);
  const copyNote = el('span', { class: 'fine', role: 'status' });
  const copyBtn = el('button', { type: 'button', class: 'btn ghost small', text: 'Copy keeper file names' });
  copyBtn.addEventListener('click', () => {
    const text = keepers.map((k) => k.name).join('\n');
    const done = () => { copyNote.textContent = `Copied ${keepers.length} file name${keepers.length === 1 ? '' : 's'}.`; setTimeout(() => { copyNote.textContent = ''; }, 3000); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy these file names:', text.replace(/\n/g, ', ')));
    else window.prompt('Copy these file names:', text.replace(/\n/g, ', '));
  });
  const noTime = groups.length === 1 && records.every((r) => r.time == null) && records.length > 1;
  const title = el('h2', { class: 'results-h', tabIndex: -1, text: `${bursts.length === 1 ? '1 burst' : `${bursts.length} bursts`}, ${keepers.length === 1 ? '1 keeper' : `${keepers.length} keepers`}` });
  const head = el('div', { class: 'results-head' },
    title,
    el('p', { class: 'fine', text: [
      noTime ? "These photos have no capture time, so they're checked as one burst." : 'Photos taken within 2 seconds of each other count as one burst.',
      skipped ? `Only the first ${MAX_FILES} photos (by file name) were checked; run the other ${skipped} next.` : '',
    ].filter(Boolean).join(' ') }),
    keepers.length ? el('div', { class: 'row' }, copyBtn, copyNote) : null);
  const sections = bursts.map((b, k) => {
    const times = b.photos.map((p) => p.time).filter((t) => t != null);
    const when = times.length ? ` · ${clock(Math.min(...times))}` : '';
    const keeperBox = el('div', { class: 'keeper' });
    if (b.keeper) keeperBox.append(el('p', { class: 'fine', text: 'Cropping the keeper…' }));
    else keeperBox.append(el('p', { class: 'nokeeper', text: b.photos.some((p) => p.status === 'nobird') ? 'No bird found in this burst.' : "Couldn't open the photos in this burst." }));
    return {
      b,
      keeperBox,
      node: el('section', { class: 'burst', 'aria-label': `Burst ${k + 1}` },
        el('h3', { text: `Burst ${k + 1}` }, el('span', { class: 'fine', text: ` · ${b.photos.length} photo${b.photos.length === 1 ? '' : 's'}${when}` })),
        keeperBox,
        el('ol', { class: 'frames', 'aria-label': `Burst ${k + 1}, sharpest first` }, ...b.ranked.map((r, i) => frameItem(r, i === 0 && r.status === 'ok')))),
    };
  });
  els.results.replaceChildren(head, ...sections.map((s) => s.node));
  els.cta.hidden = false;
  title.focus({ preventScroll: true });

  for (const s of sections) {
    if (signal.aborted) return;
    const k = s.b.keeper;
    if (!k) continue;
    let crop = null;
    try {
      crop = await keeperCrop(k);
    } catch { /* shown below */ }
    if (signal.aborted) return;
    if (!crop) {
      s.keeperBox.replaceChildren(el('p', { class: 'fine', text: `Keeper: ${k.name}. Couldn't make its crop.` }));
      continue;
    }
    const big = Math.max(crop.fullW, crop.fullH) > DOWNLOAD_MAX_SIDE;
    const withBird = s.b.photos.filter((p) => p.status === 'ok').length;
    const note = big
      ? `Downloads here are up to 1,000 px. BirdFrame for Mac saves this crop at its full ${nf(crop.fullW)} × ${nf(crop.fullH)} px.`
      : 'BirdFrame for Mac saves every crop at full size.';
    s.keeperBox.replaceChildren(
      el('figure', {},
        el('img', { src: crop.url, alt: `The sharpest bird in this burst, cropped from ${k.name}`, width: crop.w, height: crop.h })),
      el('div', { class: 'keeper-meta' },
        el('p', {}, el('b', { text: 'Keeper: ' }), el('span', { class: 'kname', text: k.name })),
        el('p', { class: 'fine', text: `${withBird === 1 ? 'The only frame with a bird.' : `Sharpest of the ${withBird} frames with a bird.`} The bird is ${nf(k.bird.w)} × ${nf(k.bird.h)} px.` }),
        el('a', { class: 'btn small', href: crop.url, download: `${baseName(k.name)}-keeper-balanced.jpg`, text: 'Download keeper crop' }),
        el('p', { class: 'fine', text: note })));
  }
}

// ------------------------------------------------------------------ input

function init() {
  // Outreach links carry ?ref=: credit the App Store campaign to it (as track.js does); ct=burst otherwise.
  const ref = new URLSearchParams(location.search).get('ref') || '';
  if (/^[a-z0-9][a-z0-9-]{0,39}$/i.test(ref)) {
    document.querySelectorAll('a[href*="ct=burst"]').forEach((a) => {
      const u = new URL(a.href);
      u.searchParams.set('ct', ref.toLowerCase());
      a.href = u.toString();
    });
  }
  els.choose.addEventListener('click', () => {
    els.file.click();
    getDetector().catch(() => {}); // get ready while the photos are picked
  });
  els.file.addEventListener('change', () => {
    const list = [...(els.file.files || [])];
    els.file.value = '';
    if (list.length) start(list);
  });
  ['dragenter', 'dragover'].forEach((t) => els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((t) => els.drop.addEventListener(t, () => els.drop.classList.remove('over')));
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const list = [...(e.dataTransfer?.files || [])];
    if (list.length) start(list);
  });
}

init();
