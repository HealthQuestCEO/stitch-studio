// Audio helpers: decode a clip, resample to 16 kHz mono, and find quiet stretches.

export async function decodeClip(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(buf);
  } finally {
    ctx.close();
  }
}

// 16 kHz mono Float32Array, the format Whisper wants.
export async function to16kMono(audioBuffer) {
  const len = Math.ceil(audioBuffer.duration * 16000);
  const off = new OfflineAudioContext(1, Math.max(len, 1), 16000);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

// Loudness per 20 ms frame, in dB.
export function energyFrames(samples, rate = 16000, frameSec = 0.02) {
  const n = Math.floor(rate * frameSec), out = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += samples[j] * samples[j];
    out.push(10 * Math.log10(s / n + 1e-10));
  }
  return { db: out, frameSec };
}

// Speech/quiet stretches from loudness. The threshold adapts to the room:
// halfway (in dB) between the quiet floor and the speaking level.
export function speechRuns(samples, rate = 16000) {
  const { db, frameSec } = energyFrames(samples, rate);
  if (!db.length) return [];
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const loud = sorted[Math.floor(sorted.length * 0.9)];
  const thr = Math.max(floor + 8, floor + (loud - floor) * 0.35);
  const runs = [];
  let cur = null;
  db.forEach((v, i) => {
    const speech = v > thr;
    const t = i * frameSec;
    if (!cur || cur.speech !== speech) {
      if (cur) cur.end = t;
      cur = { speech, start: t, end: t + frameSec };
      runs.push(cur);
    } else cur.end = t + frameSec;
  });
  // Smooth: speech blips under 80 ms become quiet; quiet blips under 150 ms become speech.
  const merged = [];
  for (const r of runs) {
    const d = r.end - r.start;
    const flip = (r.speech && d < 0.08) || (!r.speech && d < 0.15);
    const speech = flip ? !r.speech : r.speech;
    const last = merged[merged.length - 1];
    if (last && last.speech === speech) last.end = r.end;
    else merged.push({ speech, start: r.start, end: r.end });
  }
  return merged;
}
