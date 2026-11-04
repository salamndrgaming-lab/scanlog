// On-device Whisper in a Web Worker (transformers.js). Uses WebGPU when the phone
// supports it, otherwise WebAssembly. The model downloads once and is cached.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";

env.allowLocalModels = false;
let asr = null, loading = null;

async function load(model, device) {
  if (asr && asr._model === model) return asr;
  const useGPU = device === "webgpu" || (device === "auto" && "gpu" in navigator && await navigator.gpu.requestAdapter().catch(() => null));
  const opts = useGPU
    ? { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } }
    : { device: "wasm", dtype: "q8" };
  asr = await pipeline("automatic-speech-recognition", model, {
    ...opts,
    progress_callback: p => { if (p.status === "progress") postMessage({ type: "progress", file: p.file, pct: p.progress }); },
  });
  asr._model = model;
  postMessage({ type: "ready", device: opts.device });
  return asr;
}

onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      loading = load(data.model, data.device);
      await loading;
    } else if (data.type === "transcribe") {
      const p = await (loading || load(data.model, data.device));
      const out = await p(data.samples, { chunk_length_s: 30, return_timestamps: false });
      postMessage({ type: "result", id: data.id, text: (out.text || "").trim() });
    }
  } catch (e) {
    postMessage({ type: "error", id: data.id, error: String(e?.message || e) });
  }
};
