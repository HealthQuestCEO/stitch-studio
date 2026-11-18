// Runs Whisper in the browser (transformers.js). The model downloads once and is
// cached by the browser; audio never leaves this computer.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.1.2';

env.allowLocalModels = false;
let asr = null, loadedName = null;

async function load(name, device) {
  if (asr && loadedName === name + device) return asr;
  asr = await pipeline('automatic-speech-recognition', name, {
    device,
    progress_callback: (p) => {
      if (p.status === 'progress') postMessage({ type: 'download', file: p.file, pct: p.progress });
    },
  });
  loadedName = name + device;
  return asr;
}

self.onmessage = async (e) => {
  const { id, audio } = e.data;
  const tries = [];
  for (const m of ['Xenova/whisper-base.en', 'Xenova/whisper-tiny.en']) {
    if (self.navigator && navigator.gpu) tries.push([m, 'webgpu']);
    tries.push([m, 'wasm']);
  }
  let lastErr;
  for (const [m, device] of tries) {
    try {
      postMessage({ type: 'status', text: 'Getting the transcript ready…' });
      const run = await load(m, device);
      postMessage({ type: 'status', text: 'Listening to your take…' });
      const out = await run(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
      const words = (out.chunks || []).map((c) => ({
        text: c.text.trim(),
        start: c.timestamp[0],
        end: c.timestamp[1] ?? c.timestamp[0] + 0.3,
      })).filter((w) => w.text);
      postMessage({ type: 'done', id, words, model: m });
      return;
    } catch (err) {
      lastErr = err;
      asr = null;
    }
  }
  postMessage({ type: 'error', id, message: String(lastErr && lastErr.message || lastErr) });
};
