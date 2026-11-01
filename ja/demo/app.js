// Japanese twin of ../../demo/js/app.js: the same logic, with Japanese strings and paths re-pointed.
// BirdFrame web demo page logic. No analytics, no cookies, no uploads: the photo is decoded and searched
// in this tab, and crops are made here. The bird finder, worker and model stay in ../../demo/ (shared).

import { startDetector as startBackend, webgpuAvailable, wasmAvailable } from '../../demo/js/detector.js';
import { loadImage, makeDetectionCanvas, findBirds, makeCrops, renderCrop, passesSelfTest } from '../../demo/js/pipeline.js';
import { FRAMING, cropPixelRect } from '../../demo/js/core.js';
import { MODEL_FILES } from '../../demo/js/config.js';

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
const FRAMING_JA = { tight: 'きつめ', balanced: '標準', wide: 'ゆったり' }; // Tight / Balanced / Wide, as on /ja/ and the JP App Store

// The sample photos and their English labels live with the English page; Japanese labels by key.
const SAMPLES_URL = new URL('../../demo/samples/samples.json', import.meta.url);
const SAMPLES_JA = {
  '00': { label: '草原', alt: '緑の草原で、倒木に小さな鳥が1羽とまっている写真' },
  '02': { label: '枯れ木', alt: '淡い空を背景にした2羽の鳥。1羽は枯れ木のてっぺんにとまり、もう1羽はその上を飛んでいる' },
  '07': { label: 'トウヒ', alt: '小さなトウヒの先に鳥が1羽とまり、もう1羽が枝の中に半分隠れている' },
  '09': { label: '曇り空', alt: '灰色の空を横切って飛ぶ小さな鳥' },
  '13': { label: '赤いフィンチ', alt: '暗い空を背景に、トウヒのてっぺんにとまる赤いフィンチ' },
};

// App Store links carry a campaign token so App Store Connect can say which channel an install came from:
// ?ref=… if the link had one (newsletters, directories), otherwise the kind of site the visitor came from.
// Nothing is stored and no cookie is set. Few, broad names, because Apple hides a campaign under 5 installs.
// (Same tokens as the English page; the store link uses the JP storefront path, as the other /ja/ pages do.)
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

const STORE_URL = `https://apps.apple.com/jp/app/apple-store/id6754513569?pt=127908484&ct=${campaign()}&mt=8`;

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
    else if (k.startsWith('aria-') || k === 'role' || k === 'download' || k === 'href' || k === 'rel' || k === 'hreflang') node.setAttribute(k, v);
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
  return el('a', { class: 'btn small ghost', href: STORE_URL, text: 'Mac 版 BirdFrame' });
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
        setStatus('鳥を見つける準備をしています…');
        setProgress(null);
        return;
      }
      if (total && loaded >= total) {
        setStatus('まもなく鳥を探し始めます…');
        setProgress(1);
        return;
      }
      setStatus(`鳥を見つける準備をしています：${mb(loaded)} / ${mb(total || MODEL_FILES[0].bytes)} MB。ダウンロードは初回だけで、次からはブラウザに保存されたものを使います。`);
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
    showProblem('このブラウザでは鳥を見つける処理を実行できません。最新の Safari、Chrome、Edge、Firefox か、パソコンでお試しください。Mac 版の BirdFrame は、macOS 15 以降のすべての Mac で使えます。', [appStoreLink()]);
  } else if (e.stage === 'runtime') {
    showProblem('鳥を見つける処理を開始できませんでした。接続を確認して、もう一度お試しください。それでも動かない場合は、最新の Safari、Chrome、Edge、Firefox か、パソコンでお試しください。', [retryButton('もう一度試す', retry), appStoreLink()]);
  } else if (e.stage === 'download') {
    showProblem('鳥を見つけるためのデータをダウンロードできませんでした。接続を確認して、もう一度お試しください。', [retryButton('もう一度試す', retry)]);
  } else {
    showProblem('この端末では鳥を見つける処理を実行できませんでした。メモリが足りなくなった可能性があります。ほかのタブを閉じてもう一度お試しいただくか、パソコンでお試しください。', [retryButton('もう一度試す', retry), appStoreLink()]);
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
  els.title.textContent = '鳥を探しています…';
  els.crops.replaceChildren();
  els.boxes.replaceChildren();
  els.note.textContent = '';
  setStatus('写真を開いています…');
  setProgress(null);
  els.work.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  const detectorReady = getDetector();
  detectorReady.catch(() => {});

  let loaded;
  try {
    loaded = await loadImage(source);
  } catch {
    if (controller.signal.aborted) return;
    els.title.textContent = 'この写真を開けませんでした';
    showProblem('このブラウザではこのファイルを開けません。JPEG、PNG、WebP の写真を選んでください（HEIC は Safari で開けます。カメラの RAW ファイルは、先に JPEG で書き出してください）。');
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
  els.img.alt = meta.alt || '選んだ写真';
  els.caption.replaceChildren();
  els.result.hidden = false;
  els.framing.hidden = true;
  els.crops.replaceChildren();

  let detector;
  try {
    detector = await detectorReady;
  } catch (e) {
    if (controller.signal.aborted) return;
    els.title.textContent = '鳥を探す準備ができませんでした';
    explainDetectorError(e, () => handlePhoto(source, meta));
    return;
  }
  if (controller.signal.aborted) return;

  setStatus(detectorEp === 'wasm' ? '写真全体を探しています。このブラウザでは30秒ほどかかることがあります…' : '写真全体を探しています…');
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
            ? `いまのところ ${birds.length} 羽。小さな鳥や隠れた鳥がいないか、さらに詳しく探しています…`
            : '小さな鳥や隠れた鳥がいないか、さらに詳しく探しています…');
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
    els.title.textContent = '問題が発生しました';
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
  els.title.textContent = n === 0 ? '鳥が見つかりませんでした' : `${n} 羽の鳥が見つかりました`;
  setStatus(n === 0
    ? 'BirdFrame はこの写真で鳥を見つけられませんでした。'
    : '構図を選んで、気に入ったトリミングをダウンロードしてください。');
  const tooSmall = birds.length - n;
  photo.smallNote = tooSmall > 0
    ? `ほかに ${tooSmall} 羽いましたが、小さすぎるためトリミングしていません。`
    : '';
  els.note.textContent = photo.smallNote;
  els.framing.hidden = n === 0;
  renderCrops();
  els.title.focus({ preventScroll: true });
}

// How much of the photo the main (largest) bird fills, beside the typical bird photo from the
// 1,995-photo study at /how-small-is-the-bird/ (main bird median 6.6%; that page is in English).
function sizeLine(birds, W, H) {
  if (!birds.length) return [];
  const area = (b) => b.bbox.w * b.bbox.h;
  const main = birds.reduce((a, b) => (area(b) > area(a) ? b : a));
  const pct = (100 * area(main)) / (W * H);
  const shown = pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
  return [`いちばん大きな鳥が写真に占める割合は ${shown}% です（一般的な野鳥写真では 6.6%）。`,
    el('a', { href: '../../how-small-is-the-bird/', hreflang: 'en', text: '詳しいデータ（英語）' })];
}

// Downloads here stop at 1,000 px; say so, with the full size the Mac app would save.
function sizeNote(crops, W, H) {
  const full = crops.map((c) => cropPixelRect(c.cropRect, W, H));
  const big = full.filter((r) => Math.max(r.w, r.h) > DOWNLOAD_MAX_SIDE);
  if (!big.length) return '';
  const top = big.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const size = `${Math.round(top.w).toLocaleString('ja-JP')} × ${Math.round(top.h).toLocaleString('ja-JP')} px`;
  return crops.length === 1
    ? `ここでダウンロードできるのは最大 1,000 px です。Mac 版の BirdFrame なら、このトリミングを元のフルサイズ ${size} で保存できます。`
    : `ここでダウンロードできるのは最大 1,000 px です。Mac 版の BirdFrame なら、これらのトリミングをフルサイズ（最大 ${size}）で保存できます。`;
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
    const label = FRAMING_JA[framing] || framing;
    const fileName = `${baseName(current.name)}-bird-${k}-${framing}.jpg`;
    items.push(el('li', {},
      el('img', { src: url, alt: `鳥 ${k}（${label}でトリミング）` }),
      el('div', { class: 'meta' },
        el('b', { text: `鳥 ${k}` }),
        el('a', { class: 'btn small', href: url, download: fileName, text: 'ダウンロード', 'aria-label': `鳥 ${k}（${label}）をダウンロード` }))));
  }
  els.crops.replaceChildren(...items);
}

// -------------------------------------------------------------------- input

function pickFile(file) {
  if (!file) return;
  for (const b of els.samples.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
  handlePhoto(file, { name: file.name, alt: '選んだ写真' });
}

function renderSamples() {
  const items = samples.map((s) => {
    const ja = SAMPLES_JA[s.key] || {};
    const btn = el('button', { type: 'button', 'aria-pressed': 'false' },
      el('img', { src: s.thumb, alt: '', loading: 'lazy', width: 480, height: 320 }),
      el('span', { class: 'lbl' }, el('span', { text: ja.label || s.label })),
      el('span', { class: 'visually-hidden', text: '（このサンプル写真で試す）' }));
    btn.addEventListener('click', () => {
      for (const b of els.samples.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
      handlePhoto(s.src, { name: `birdframe-sample-${s.key}`, alt: ja.alt || s.alt });
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
    // Sample paths in samples.json are relative to the English page; resolve them against the JSON's address.
    const list = await (await fetch(SAMPLES_URL)).json();
    const base = new URL('../', SAMPLES_URL);
    samples = list.map((s) => ({ ...s, src: new URL(s.src, base).href, thumb: new URL(s.thumb, base).href }));
    renderSamples();
  } catch {
    document.getElementById('samples-title').hidden = true;
  }
}

init();
