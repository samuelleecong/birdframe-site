// Runs the bird finder off the main thread so the page stays responsive.
// Messages in:  {type:'init', ep, candidates, ortBase, cache}
//               {type:'run', id, rgba:ArrayBuffer, size}
// Messages out: {type:'progress', loaded, total, cached?}
//               {type:'ready', ep, file}
//               {type:'result', id, boxes, logits, classCount, birdClassIndex, ms}
//               {type:'error', id?, stage, message}
// The photo's pixels arrive here and only numbers (box positions) go back.

import { createEngine } from './engine.js';

let engine = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init') {
    try {
      engine = await createEngine({ ...msg, onProgress: (p) => postMessage({ type: 'progress', ...p }) });
      postMessage({ type: 'ready', ep: engine.ep, file: engine.file });
    } catch (e) {
      postMessage({ type: 'error', stage: e.stage || 'session', message: String(e?.message || e) });
    }
  } else if (msg.type === 'run') {
    try {
      const r = await engine.run(msg.rgba, msg.size);
      postMessage({ type: 'result', id: msg.id, ...r }, [r.boxes.buffer, r.logits.buffer]);
    } catch (e) {
      postMessage({ type: 'error', id: msg.id, stage: 'run', message: String(e?.message || e) });
    }
  }
};
