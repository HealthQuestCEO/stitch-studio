// Smooth export: draws every frame one at a time (not in real time) and encodes with WebCodecs,
// so a slow computer can't drop frames. Falls back to the real-time recorder if anything is missing.
import { W, H, drawCover, makeVideos } from './export.js';
import * as MP4 from './vendor/mp4-muxer.mjs';
import * as WEBM from './vendor/webm-muxer.mjs';

const FPS = 30, RATE = 48000;

export function canSmooth() {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
}

async function pickCodecs() {
  const v = [
    { muxer: 'mp4', codec: 'avc', enc: 'avc1.640028' },
    { muxer: 'mp4', codec: 'avc', enc: 'avc1.4d0028' },
    { muxer: 'webm', codec: 'V_VP9', enc: 'vp09.00.40.08' },
    { muxer: 'webm', codec: 'V_VP8', enc: 'vp8' },
  ];
  for (const c of v) {
    const cfg = { codec: c.enc, width: W, height: H, bitrate: 10_000_000, framerate: FPS, ...(c.codec === 'avc' ? { avc: { format: 'avc' } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) {
      const a = c.muxer === 'mp4'
        ? [{ codec: 'aac', enc: 'mp4a.40.2' }, { codec: 'opus', enc: 'opus' }]
        : [{ codec: 'A_OPUS', enc: 'opus' }];
      for (const ac of a) {
        const acfg = { codec: ac.enc, sampleRate: RATE, numberOfChannels: 2, bitrate: 192_000 };
        try { if ((await AudioEncoder.isConfigSupported(acfg)).supported) return { ...c, cfg, audio: { ...ac, cfg: acfg } }; } catch {}
      }
    } } catch {}
  }
  return null;
}

async function seekExact(v, t) {
  t = Math.max(0, Math.min(t, (v.duration || t + 1) - 0.001));
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  await new Promise((res) => {
    const done = () => { clearTimeout(to); res(); };
    const to = setTimeout(done, 2000);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(done); else v.addEventListener('seeked', done, { once: true });
    v.currentTime = t;
  });
}

// audioBlobs[i] = the take's file (or its captured sound); ranges are the kept bits in order.
async function mixAudio(audioBlobs, ranges, vols, totalLen) {
  const dec = new AudioContext({ sampleRate: RATE });
  const bufs = [];
  try {
    for (const b of audioBlobs) bufs.push(b ? await dec.decodeAudioData(await b.arrayBuffer()) : null);
  } finally { dec.close(); }
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(totalLen * RATE)), RATE);
  let at = 0;
  for (const r of ranges) {
    const buf = bufs[r.take];
    const len = r.end - r.start;
    if (buf) {
      const s = off.createBufferSource(); s.buffer = buf;
      const g = off.createGain(); g.gain.value = r.vol ?? vols[r.take] ?? 1;
      s.connect(g).connect(off.destination);
      s.start(at, r.start, len);
    }
    at += len;
  }
  return off.startRendering();
}

export async function renderSmooth(urls, audioBlobs, ranges, onProgress = () => {}, opts = {}) {
  const { track = null, offset = 0, overlay = null, comp = null, vols = [] } = opts;
  const pick = await pickCodecs();
  if (!pick) throw new Error('no-codec');
  if (track) await track.load();
  const totalLen = ranges.reduce((s, r) => s + r.end - r.start, 0);

  onProgress(0.01);
  const audio = await mixAudio(audioBlobs, ranges, vols, totalLen);

  const isMp4 = pick.muxer === 'mp4';
  const M = isMp4 ? MP4 : WEBM;
  const target = new M.ArrayBufferTarget();
  const muxer = new M.Muxer({
    target,
    video: { codec: pick.codec, width: W, height: H, frameRate: FPS },
    audio: { codec: pick.audio.codec, sampleRate: RATE, numberOfChannels: 2 },
    ...(isMp4 ? { fastStart: 'in-memory', firstTimestampBehavior: 'offset' } : {}),
  });
  let err = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { err = e; } });
  venc.configure(pick.cfg);
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { err = e; } });
  aenc.configure(pick.audio.cfg);

  // audio, in 1024-sample blocks
  const L = audio.getChannelData(0), R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
  for (let i = 0; i < audio.length; i += 1024) {
    const n = Math.min(1024, audio.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / RATE) * 1e6), data });
    aenc.encode(ad); ad.close();
  }

  // video, frame by frame
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const vo = track ? Object.assign(document.createElement('canvas'), { width: W, height: H }) : null;
  const vids = track ? [] : await makeVideos(urls);
  const starts = []; { let a = 0; for (const r of ranges) { starts.push(a); a += r.end - r.start; } }
  const frames = Math.max(1, Math.round(totalLen * FPS));
  let k = 0;
  for (let f = 0; f < frames; f++) {
    if (err) throw err;
    const t = f / FPS;
    while (k < ranges.length - 1 && t >= starts[k + 1]) k++;
    const r = ranges[k], local = t - starts[k];
    let base;
    if (track) {
      await track.still(vo.getContext('2d'), offset + t);
      base = (c) => c.drawImage(vo, 0, 0);
    } else {
      const v = vids[r.take];
      await seekExact(v, r.start + local);
      base = (c) => drawCover(c, v);
    }
    if (overlay && overlay.prepare) await overlay.prepare(t);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (comp) comp.frame(ctx, base, t, k, local); else base(ctx);
    if (overlay) overlay(ctx, t, track ? null : vids[r.take], false);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: f % (FPS * 2) === 0 });
    vf.close();
    if (venc.encodeQueueSize > 8) await new Promise((res) => setTimeout(res, 0));
    onProgress(0.02 + 0.96 * ((f + 1) / frames));
  }
  await venc.flush(); await aenc.flush();
  if (err) throw err;
  muxer.finalize();
  venc.close(); aenc.close();
  if (overlay && overlay.pause) overlay.pause();
  onProgress(1);
  const type = isMp4 ? 'video/mp4' : 'video/webm';
  return { blob: new Blob([target.buffer], { type }), ext: isMp4 ? 'mp4' : 'webm' };
}
