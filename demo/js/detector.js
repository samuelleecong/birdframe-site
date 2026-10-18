// Main-thread side of the bird finder: starts the worker (or, if a browser
// offers WebGPU to the page but not to workers, runs on the page) and runs
// one 512 x 512 pass at a time.

import { MODEL_FILES, ORT_BASE } from './config.js';

export async function webgpuAvailable() {
  try {
    if (!('gpu' in navigator) || !navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

export function wasmAvailable() {
  try {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
    // The runtime needs fixed-width SIMD (Safari 16.4+, Chrome 91+, Firefox 89+).
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

function stageError(stage, message) {
  const err = new Error(message);
  err.stage = stage;
  return err;
}

/** Bird finder running in a dedicated worker. */
class WorkerDetector {
  constructor(worker, ep, file) {
    this.worker = worker;
    this.ep = ep;
    this.file = file;
    this.where = 'worker';
    this.nextId = 1;
    this.pending = new Map();
    worker.onmessage = ({ data: msg }) => {
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.pending.delete(msg.id);
      if (msg.type === 'result') job.resolve(msg);
      else job.reject(stageError(msg.stage, msg.message));
    };
    worker.onerror = (event) => this.#failAll(stageError('run', event.message || 'worker error'));
  }

  static start({ ep, candidates, ortBase, cache, sessionOptions, onProgress }) {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data: msg }) => {
        if (msg.type === 'progress') onProgress?.(msg);
        else if (msg.type === 'ready') resolve(new WorkerDetector(worker, msg.ep, msg.file));
        else if (msg.type === 'error') {
          worker.terminate();
          reject(stageError(msg.stage, msg.message));
        }
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(stageError('runtime', event.message || 'could not start'));
      };
      worker.postMessage({ type: 'init', ep, candidates, ortBase, cache, sessionOptions });
    });
  }

  run(rgba, size = 512) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, rgba, size }, [rgba]);
    });
  }

  terminate() {
    this.worker.terminate();
    this.#failAll(stageError('run', 'stopped'));
  }

  #failAll(err) {
    for (const job of this.pending.values()) job.reject(err);
    this.pending.clear();
  }
}

/** Same interface, running on the page (WebGPU work is asynchronous, so the page stays responsive). */
class PageDetector {
  constructor(engine) {
    this.engine = engine;
    this.ep = engine.ep;
    this.file = engine.file;
    this.where = 'page';
  }

  static async start(opts) {
    const { createEngine } = await import('./engine.js');
    return new PageDetector(await createEngine(opts));
  }

  run(rgba, size = 512) {
    return this.engine.run(rgba, size);
  }

  terminate() {
    this.engine.release?.();
  }
}

/**
 * Start the bird finder for one backend.
 * opts: {ep, candidates?, ortBase?, cache?, onProgress?}
 */
export async function startDetector(opts) {
  const full = { candidates: MODEL_FILES, ortBase: ORT_BASE, cache: true, ...opts };
  // Test hook: ?run=page forces the on-page path (normally used only when workers lack WebGPU).
  if (new URLSearchParams(globalThis.location?.search).get('run') === 'page') return PageDetector.start(full);
  try {
    return await WorkerDetector.start(full);
  } catch (e) {
    if (full.ep === 'webgpu' && e.stage === 'runtime' && (await webgpuAvailable())) {
      return PageDetector.start(full);
    }
    throw e;
  }
}
