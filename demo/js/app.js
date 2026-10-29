// BirdFrame web demo page logic. No analytics, no cookies, no uploads:
// the photo is decoded and searched in this tab, and crops are made here.

import { startDetector as startBackend, webgpuAvailable, wasmAvailable } from './detector.js';
import { loadImage, makeDetectionCanvas, findBirds, makeCrops, renderCrop, passesSelfTest } from './pipeline.js';
import { FRAMING, cropPixelRect } from './core.js';
import { MODEL_FILES } from './config.js';

const $ = (id) => document.getElementById(id);
const els = {
  choose: $('choose'), file: $('file'), drop: $('drop'), samples: $('samples'),
  work: $('work'), title: $('work-title'), status: $('status'), meter: $('meter'), progress: $('progress'),
  problem: $('problem'), result: $('result'), img: $('photo-img'), boxes: $('boxes'), caption: $('photo-caption'),
  crops: $('crops'), note: $('result-note'), framing: $('framing'),
};

const CROP_SOURCE_MAX_AREA = 16_000_000; // keep full resolution for crops up to 16 MP
const DOWNLOAD_MAX_SIDE = 1000; // downloads are a taste; the Mac app saves full-size crops
const mb = (bytes) => (bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0);

// App Store links carry a campaign token so App Store Connect can say which channel an install came from:
// ?ref=… if the link had one (newsletters, directories), otherwise the kind of site the visitor came from.
// Nothing is stored and no cookie is set. Few, broad names, because Apple hides a campaign under 5 installs.
const SOURCES = [
  ['hn', /(^|\.)ycombinator\.com$/],
  ['producthunt', /(^|\.)producthunt\.com$/],
  ['reddit', /(^|\.)reddit\.com$/],
  ['ai', /(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/],
  ['search', /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|ecosia\.org|search\.brave\.com|kagi\.com)$/],
  ['social', /(^|\.)(facebook\.com|instagram\.com|threads\.net|t\.co|x\.com|twitter\.com|youtube\.com|bsky\.app|linkedin\.com|lnkd\.in|pinterest\.[a-z.]+)$/],
  ['alternativeto', /(^|\.)alternativeto\.net$/],
  ['macupdate', /(^|\.)macupdate\.com$/],
  ['saashub', /(^|\.)saashub\.com$/],
  ['uneed', /(^|\.)uneed\.best$/],
  ['macrumors-forum', /(^|\.)macrumors\.com$/],
];

function campaign() {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref && /^[a-z0-9][a-z0-9-]{0,39}$/i.test(ref)) return ref.toLowerCase();
  let host = '';
  try { host = new URL(document.referrer).hostname.toLowerCase(); } catch { /* no referrer */ }
  if (!host) return 'demo-direct';
  if (host === location.hostname) return 'demo-site';
  for (const [name, pattern] of SOURCES) if (pattern.test(host)) return name;
  return 'demo-web';
}

const STORE_URL = `https://apps.apple.com/app/apple-store/id6754513569?pt=127908484&ct=${campaign()}&mt=8`;

let detectorPromise = null;
let detectorEp = null;
let run = null; // {controller, photo}
let photo = null; // {name, W, H, cropSource, url, revoke, birds}
let cropUrls = [];
let samples = [];

// ------------------------------------------------------------------ helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'download' || k === 'href' || k === 'rel') node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function setStatus(text) {
  els.status.textContent = text;
}

function setProgress(fraction) {
  if (fraction == null) {
    els.meter.hidden = true;
    return;
  }
  els.meter.hidden = false;
  els.progress.value = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

function showProblem(message, actions = []) {
  els.problem.replaceChildren(el('p', { text: message }));
  if (actions.length) {
    const row = el('div', { class: 'row' });
    for (const a of actions) row.append(a);
    els.problem.append(row);
  }
  els.problem.hidden = false;
  setProgress(null);
}

function clearProblem() {
  els.problem.hidden = true;
  els.problem.replaceChildren();
}

function retryButton(label, fn) {
  return el('button', { type: 'button', class: 'btn small', text: label, onclick: fn });
}

function appStoreLink() {
  return el('a', { class: 'btn small ghost', href: STORE_URL, text: 'BirdFrame for Mac' });
}

function shrinkForDownload(canvas) {
  const scale = DOWNLOAD_MAX_SIDE / Math.max(canvas.width, canvas.height);
  if (scale >= 1) return canvas;
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  canvas.width = 0; // free the full-size pixels
  return small;
}

function baseName(name) {
  return (name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
}

// ------------------------------------------------------------- bird finder

async function startDetector(ep) {
  return startBackend({
    ep,
    onProgress: ({ loaded, total, cached }) => {
      if (cached) {
        setStatus('Getting the bird finder ready…');
        setProgress(null);
        return;
      }
      if (total && loaded >= total) {
        setStatus('Starting the bird finder…');
        setProgress(1);
        return;
      }
      setStatus(`Getting the bird finder ready: ${mb(loaded)} of ${mb(total || MODEL_FILES[0].bytes)} MB. It downloads once, then your browser keeps it.`);
      setProgress(total ? loaded / total : null);
    },
  });
}

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      if (!wasmAvailable()) {
        const err = new Error('unsupported');
        err.stage = 'unsupported';
        throw err;
      }
      if (await webgpuAvailable()) {
        try {
          const d = await startDetector('webgpu');
          if (await passesSelfTest(d)) {
            detectorEp = 'webgpu';
            return d;
          }
          d.terminate();
        } catch (e) {
          if (e.stage === 'download') throw e;
          // WebGPU present but not usable here: fall back to the CPU path.
        }
      }
      const d = await startDetector('wasm');
      detectorEp = 'wasm';
      return d;
    })();
    detectorPromise.catch(() => { detectorPromise = null; });
  }
  return detectorPromise;
}

function explainDetectorError(e, retry) {
  setStatus('');
  if (e.stage === 'unsupported') {
    showProblem("This browser can't run the bird finder. Try the latest Safari, Chrome, Edge or Firefox, or a computer. BirdFrame for Mac works on any Mac with macOS 15 or later.", [appStoreLink()]);
  } else if (e.stage === 'runtime') {
    showProblem("The bird finder couldn't start. Check your connection and try again. If it still doesn't work, try the latest Safari, Chrome, Edge or Firefox, or a computer.", [retryButton('Try again', retry), appStoreLink()]);
  } else if (e.stage === 'download') {
    showProblem("Couldn't download the bird finder. Check your connection and try again.", [retryButton('Try again', retry)]);
  } else {
    showProblem("This device couldn't run the bird finder, probably because it ran short of memory. Close other tabs and try again, or try it on a computer.", [retryButton('Try again', retry), appStoreLink()]);
  }
}

// ------------------------------------------------------------------- photos

function releasePhoto() {
  if (photo) photo.revoke?.();
  for (const u of cropUrls) URL.revokeObjectURL(u);
  cropUrls = [];
  photo = null;
}

function makeCropSource(img, W, H) {
  if (W * H <= CROP_SOURCE_MAX_AREA) return img;
  // Very large photo: keep a 16 MP copy for crops so phones don't run out of memory.
  const s = Math.sqrt(CROP_SOURCE_MAX_AREA / (W * H));
  const c = document.createElement('canvas');
  c.width = Math.round(W * s);
  c.height = Math.round(H * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  c.naturalWidth = c.width; // renderCrop reads natural size
  c.naturalHeight = c.height;
  return c;
}

async function handlePhoto(source, meta) {
  run?.controller.abort();
  const controller = new AbortController();
  run = { controller };
  releasePhoto();
  clearProblem();
  els.work.hidden = false;
  els.result.hidden = true;
  els.title.textContent = 'Looking for birds…';
  els.crops.replaceChildren();
  els.boxes.replaceChildren();
  els.note.textContent = '';
  setStatus('Opening your photo…');
  setProgress(null);
  els.work.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  const detectorReady = getDetector();
  detectorReady.catch(() => {});

  let loaded;
  try {
    loaded = await loadImage(source);
  } catch {
    if (controller.signal.aborted) return;
    els.title.textContent = "Couldn't open that photo";
    showProblem("This browser can't open that file. Choose a JPEG, PNG or WebP photo (HEIC opens in Safari; camera RAW files need exporting as JPEG first).");
    return;
  }
  if (controller.signal.aborted) { loaded.revoke(); return; }

  const W = loaded.width;
  const H = loaded.height;
  const detCanvas = makeDetectionCanvas(loaded.img, W, H);
  const cropSource = makeCropSource(loaded.img, W, H);
  photo = { name: meta.name, W, H, cropSource, revoke: loaded.revoke, birds: [] };

  // Show the 2,048 px working copy rather than decoding the original a second time.
  const shown = await new Promise((resolve) => detCanvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (controller.signal.aborted) return;
  if (shown) {
    const shownUrl = URL.createObjectURL(shown);
    const revokeOriginal = photo.revoke;
    photo.revoke = () => { revokeOriginal(); URL.revokeObjectURL(shownUrl); };
    els.img.src = shownUrl;
  } else {
    els.img.src = loaded.url;
  }
  els.img.alt = meta.alt || 'Your photo';
  els.caption.replaceChildren();
  els.result.hidden = false;
  els.framing.hidden = true;
  els.crops.replaceChildren();

  let detector;
  try {
    detector = await detectorReady;
  } catch (e) {
    if (controller.signal.aborted) return;
    els.title.textContent = 'The bird finder didn’t start';
    explainDetectorError(e, () => handlePhoto(source, meta));
    return;
  }
  if (controller.signal.aborted) return;

  setStatus(detectorEp === 'wasm' ? 'Searching the whole photo. In this browser that can take up to 30 seconds…' : 'Searching the whole photo…');
  setProgress(0.02);
  const t0 = performance.now();
  let result;
  try {
    result = await findBirds(detector, detCanvas, W, H, {
      signal: controller.signal,
      onPass: ({ done, total, birds }) => {
        if (controller.signal.aborted) return;
        setProgress(done / total);
        if (done === 1) {
          drawBoxes(birds, true);
          setStatus(birds.length
            ? `Found ${birds.length} so far. Taking a closer look for small and hidden birds…`
            : 'Taking a closer look for small and hidden birds…');
        }
      },
    });
  } catch (e) {
    if (controller.signal.aborted || e.name === 'AbortError') return;
    // A GPU that fails mid-run: retry once on the CPU path.
    if (detectorEp === 'webgpu') {
      detector.terminate();
      detectorPromise = (async () => { const d = await startDetector('wasm'); detectorEp = 'wasm'; return d; })();
      detectorPromise.catch(() => { detectorPromise = null; });
      handlePhoto(source, meta);
      return;
    }
    els.title.textContent = 'Something went wrong';
    explainDetectorError(e, () => handlePhoto(source, meta));
    return;
  }
  if (controller.signal.aborted) return;
  const seconds = (performance.now() - t0) / 1000;
  photo.birds = result.birds;
  setProgress(null);
  showResult(seconds);
}

// ------------------------------------------------------------------ results

function drawBoxes(birds, tentative = false, numbers = null) {
  const { W, H } = photo;
  els.boxes.replaceChildren();
  birds.forEach((b, i) => {
    const box = el('div', { class: 'box' + (tentative ? ' tentative' : '') });
    box.style.left = `${(100 * b.bbox.x) / W}%`;
    box.style.top = `${(100 * b.bbox.y) / H}%`;
    box.style.width = `${(100 * b.bbox.w) / W}%`;
    box.style.height = `${(100 * b.bbox.h) / H}%`;
    if (b.bbox.y / H < 0.06) box.classList.add('low');
    const n = numbers ? numbers[i] : i + 1;
    if (n != null) box.append(el('b', { text: String(n) }));
    els.boxes.append(box);
  });
}

function currentFraming() {
  return els.framing.querySelector('input:checked')?.value ?? 'balanced';
}

function showResult(seconds) {
  const { birds, W, H } = photo;
  const crops = makeCrops(birds, W, H, FRAMING.balanced);
  const croppedIdx = new Set(crops.map((c) => c.cropIndex - 1));
  const numbers = birds.map((_, i) => (croppedIdx.has(i) ? [...croppedIdx].filter((k) => k <= i).length : null));
  drawBoxes(birds, false, numbers);

  els.caption.replaceChildren(...sizeLine(birds, W, H));

  const n = crops.length;
  els.title.textContent = n === 0 ? 'No birds found' : n === 1 ? 'Found 1 bird' : `Found ${n} birds`;
  setStatus(n === 0
    ? "BirdFrame didn't find a bird in this photo."
    : 'Pick a framing, then download the crops you like.');
  const tooSmall = birds.length - n;
  photo.smallNote = tooSmall > 0
    ? `${tooSmall === 1 ? 'One more bird was' : `${tooSmall} more birds were`} too small to crop.`
    : '';
  els.note.textContent = photo.smallNote;
  els.framing.hidden = n === 0;
  renderCrops();
  els.title.focus({ preventScroll: true });
}

// How much of the photo the main (largest) bird fills, beside the typical bird photo from the
// 1,995-photo study at /how-small-is-the-bird/ (main bird median 6.6%).
function sizeLine(birds, W, H) {
  if (!birds.length) return [];
  const area = (b) => b.bbox.w * b.bbox.h;
  const main = birds.reduce((a, b) => (area(b) > area(a) ? b : a));
  const pct = (100 * area(main)) / (W * H);
  const shown = pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
  return [`The main bird fills ${shown}% of this photo; in the typical bird photo it's 6.6%. `,
    el('a', { href: '../how-small-is-the-bird/', text: 'How small is the bird?' })];
}

// Downloads here stop at 1,000 px; say so, with the full size the Mac app would save.
function sizeNote(crops, W, H) {
  const full = crops.map((c) => cropPixelRect(c.cropRect, W, H));
  const big = full.filter((r) => Math.max(r.w, r.h) > DOWNLOAD_MAX_SIDE);
  if (!big.length) return '';
  const top = big.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const size = `${Math.round(top.w).toLocaleString('en-US')} × ${Math.round(top.h).toLocaleString('en-US')} px`;
  return crops.length === 1
    ? `Downloads here are up to 1,000 px. BirdFrame for Mac saves this crop at its full ${size}.`
    : `Downloads here are up to 1,000 px. BirdFrame for Mac saves these crops at full size, up to ${size}.`;
}

async function renderCrops() {
  if (!photo) return;
  const current = photo;
  const framing = currentFraming();
  const crops = makeCrops(current.birds, current.W, current.H, FRAMING[framing]);
  els.note.textContent = [current.smallNote, sizeNote(crops, current.W, current.H)].filter(Boolean).join(' ');
  for (const u of cropUrls) URL.revokeObjectURL(u);
  cropUrls = [];
  const items = [];
  let k = 0;
  for (const c of crops) {
    k += 1;
    const canvas = shrinkForDownload(renderCrop(current.cropSource, c.cropRect, current.W, current.H));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (photo !== current || currentFraming() !== framing) return; // superseded
    canvas.width = 0; // free the pixels
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    cropUrls.push(url);
    const label = framing[0].toUpperCase() + framing.slice(1);
    const fileName = `${baseName(current.name)}-bird-${k}-${framing}.jpg`;
    items.push(el('li', {},
      el('img', { src: url, alt: `Bird ${k}, cropped ${label}` }),
      el('div', { class: 'meta' },
        el('b', { text: `Bird ${k}` }),
        el('a', { class: 'btn small', href: url, download: fileName, text: 'Download', 'aria-label': `Download bird ${k}, ${label}` }))));
  }
  els.crops.replaceChildren(...items);
}

// -------------------------------------------------------------------- input

function pickFile(file) {
  if (!file) return;
  for (const b of els.samples.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
  handlePhoto(file, { name: file.name, alt: 'Your photo' });
}

function renderSamples() {
  const items = samples.map((s) => {
    const btn = el('button', { type: 'button', 'aria-pressed': 'false' },
      el('img', { src: s.thumb, alt: '', loading: 'lazy', width: 480, height: 320 }),
      el('span', { class: 'lbl' }, el('span', { text: s.label })),
      el('span', { class: 'visually-hidden', text: ', try this sample photo' }));
    btn.addEventListener('click', () => {
      for (const b of els.samples.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
      handlePhoto(s.src, { name: `birdframe-sample-${s.key}`, alt: s.alt });
    });
    return el('li', {}, btn);
  });
  els.samples.replaceChildren(...items);
}

async function init() {
  for (const a of document.querySelectorAll('a[href^="https://apps.apple.com/"]')) a.href = STORE_URL;
  els.choose.addEventListener('click', () => {
    els.file.click();
    // Start getting ready while the visitor picks a photo.
    getDetector().catch(() => {});
  });
  els.file.addEventListener('change', () => {
    pickFile(els.file.files?.[0]);
    els.file.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) => els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((t) => els.drop.addEventListener(t, () => els.drop.classList.remove('over')));
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    pickFile(e.dataTransfer?.files?.[0]);
  });
  els.framing.addEventListener('change', () => renderCrops());
  try {
    samples = await (await fetch('samples/samples.json')).json();
    renderSamples();
  } catch {
    document.getElementById('samples-title').hidden = true;
  }
}

init();
