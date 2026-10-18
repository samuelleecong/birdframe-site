// Loads the runtime and the bird finder file, then runs one 512 x 512 pass.
// Used inside the worker (normal case) or on the page itself when a browser
// offers WebGPU to pages but not to workers.

import { rgbaToTensor, selectBirdQueries, SETTINGS } from './core.js';

const CACHE_NAME = 'birdframe-demo-v1';

function tagged(stage, e) {
  const err = e instanceof Error ? e : new Error(String(e));
  err.stage = err.stage || stage;
  return err;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function openCache(enabled) {
  if (!enabled || typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // private browsing or storage blocked: download each time
  }
}

async function download(url, expectedBytes, onProgress) {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Content-Length is the compressed size when the server gzips the file, so prefer the known size.
  const total = expectedBytes || Number(response.headers.get('content-length')) || 0;
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    onProgress({ loaded: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - last > 120) {
      last = now;
      onProgress({ loaded, total });
    }
  }
  onProgress({ loaded, total: total || loaded });
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** Try each candidate file in order; use the browser cache when it has a verified copy. */
async function loadModelBytes(candidates, useCache, onProgress) {
  const cache = await openCache(useCache);
  let lastError = null;
  for (const c of candidates) {
    if (cache) {
      try {
        const hit = await cache.match(c.url);
        if (hit) {
          // Only verified files are cached; a size check catches truncation.
          const buffer = await hit.arrayBuffer();
          if (!c.bytes || buffer.byteLength === c.bytes) {
            onProgress({ loaded: buffer.byteLength, total: buffer.byteLength, cached: true });
            return { buffer, candidate: c, cached: true };
          }
          await cache.delete(c.url);
        }
      } catch { /* fall through to a fresh download */ }
    }
    try {
      const buffer = await download(c.url, c.bytes, onProgress);
      if (c.sha256 && (await sha256Hex(buffer)) !== c.sha256) throw new Error('checksum mismatch');
      if (cache) {
        try {
          await cache.put(c.url, new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } })); // copies the bytes
        } catch { /* storage full or blocked: it still runs */ }
      }
      return { buffer, candidate: c, cached: false };
    } catch (e) {
      lastError = e;
    }
  }
  throw tagged('download', lastError ?? new Error('no model URL'));
}

/**
 * opts: {ep: 'webgpu'|'wasm', candidates: [{url, bytes, sha256}], ortBase, cache, sessionOptions, onProgress}
 * Resolves to {ep, file, run(rgba, size)}.
 */
export async function createEngine({ ep, candidates, ortBase, cache = true, sessionOptions = {}, onProgress = () => {} }) {
  let ort;
  try {
    if (ep === 'webgpu') {
      if (!globalThis.navigator?.gpu) throw new Error('no WebGPU here');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no WebGPU adapter');
    }
    ort = await import(ortBase + (ep === 'webgpu' ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs'));
    ort.env.wasm.wasmPaths = ortBase;
    // Multi-threading needs cross-origin isolation, which static hosting can't set.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
    ort.env.logLevel = 'error';
  } catch (e) {
    throw tagged('runtime', e);
  }

  let bytes = await loadModelBytes(candidates, cache, onProgress);
  let session;
  try {
    session = await ort.InferenceSession.create(new Uint8Array(bytes.buffer), {
      executionProviders: [ep],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
      ...sessionOptions,
    });
  } catch (e) {
    throw tagged('session', e);
  }
  const file = bytes.candidate.url;
  bytes = null;
  const inputName = session.inputNames[0];

  async function run(rgba, size = SETTINGS.resolution) {
    const t0 = performance.now();
    const data = rgbaToTensor(new Uint8ClampedArray(rgba), size);
    const outputs = await session.run({ [inputName]: new ort.Tensor('float32', data, [1, 3, size, size]) });
    let boxes = null;
    let logits = null;
    for (const name of session.outputNames) {
      const t = outputs[name];
      if (t.dims[t.dims.length - 1] === 4) boxes = t;
      else logits = t;
    }
    const classCount = logits.dims[logits.dims.length - 1];
    const picked = selectBirdQueries(await boxes.getData(), await logits.getData(), { classCount });
    for (const name of session.outputNames) outputs[name].dispose?.();
    return { boxes: picked.boxes, logits: picked.logits, classCount: 1, birdClassIndex: 0, ms: performance.now() - t0 };
  }

  return { ep, file, run, release: () => session.release?.() };
}
