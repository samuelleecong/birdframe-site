// Where the runtime and the bird finder file come from, pinned so that what
// was tested is what visitors get. Each file is checked against its SHA-256.
//
// Runtime: onnxruntime-web (MIT) from jsDelivr.
// Bird finder: RF-DETR Small, COCO weights (Apache-2.0). Self-hosted 8-bit
// build of onnx-community/rfdetr_small-ONNX, made by tools/webdemo/make_model.py.

export const ORT_VERSION = '1.30.0';
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Tried in order; the same file serves WebGPU and WebAssembly.
export const MODEL_FILES = [
  {
    // site/demo/models/ (gitignored here; copy it to the live site with the page).
    url: new URL('../models/rfdetr_small_q8.onnx', import.meta.url).href,
    bytes: 39920987,
    sha256: 'b3c73bb0c5992ade20fc38b60898288823019c6df017c272034fa8e6ac3c49e1',
  },
  {
    // Fallback if the self-hosted copy is missing: an fp16 build with the same
    // results (its GridSample stays fp32), pinned to one commit on Hugging Face.
    url: 'https://huggingface.co/tuxracer/coco-rfdetr-small/resolve/fe19ed78306e094c6f5d3d7c1506d0a21bdff23b/onnx/model_fp16.onnx',
    bytes: 57420745,
    sha256: 'abc01fe36549f06694ed51ec81d913c351333b05d8a0294d69c9b6763a34d64b',
  },
];

// How each 512 x 512 pass is resampled (Chrome: 'low' and 'medium' match best).
export const SMOOTHING = 'medium';

export const APP_STORE_URL = 'https://apps.apple.com/app/birdframe/id6754513569';
