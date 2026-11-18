// Export: plays only the kept parts into a 1080x1920 canvas and records it.
// Everything happens in this browser. Nothing is uploaded.

export const W = 1080, H = 1920;

export function pickMime() {
  const list = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

// Draw a video frame into the 9:16 canvas, cropping from the center (like "cover").
export function drawCover(ctx, video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function once(el, ev) {
  return new Promise((res) => el.addEventListener(ev, res, { once: true }));
}

async function seek(video, t) {
  if (Math.abs(video.currentTime - t) < 0.01) return;
  const p = once(video, 'seeked');
  video.currentTime = t;
  await p;
}

export async function makeVideos(urls) {
  const vids = [];
  for (const url of urls) {
    const v = document.createElement('video');
    v.src = url; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    if (v.readyState < 1) await once(v, 'loadedmetadata');
    vids.push(v);
  }
  return vids;
}

export async function renderReel(urls, ranges, onProgress = () => {}, opts = {}) {
  const { track = null, offset = 0, overlay = null } = opts;
  if (track) await track.load();
  const mime = pickMime();
  if (!mime) throw new Error('This browser cannot record video. Please use an up-to-date Chrome.');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

  const vids = await makeVideos(urls);
  const ac = new AudioContext();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  vids.forEach((v) => ac.createMediaElementSource(v).connect(dest));

  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = once(rec, 'stop');

  const totalLen = ranges.reduce((s, r) => s + r.end - r.start, 0);
  let done = 0, started = false;

  for (const r of ranges) {
    const v = vids[r.take];
    await seek(v, r.start);
    if (overlay && overlay.prepare) await overlay.prepare(done);
    const paint = (running) => {
      const t = done + Math.max(0, v.currentTime - r.start);
      if (track) track.draw(ctx, offset + t, running); else drawCover(ctx, v);
      if (overlay) overlay(ctx, t, track ? null : v, running);
    };
    paint(false);
    if (!started) { rec.start(250); started = true; } else rec.resume();
    await v.play();
    await new Promise((res) => {
      const tick = () => {
        paint(true);
        onProgress(Math.min(1, (done + Math.max(0, v.currentTime - r.start)) / totalLen));
        if (v.currentTime >= r.end - 0.01 || v.ended) { v.pause(); res(); return; }
        if (v.requestVideoFrameCallback && !track) v.requestVideoFrameCallback(tick);
        else requestAnimationFrame(tick);
      };
      tick();
    });
    rec.pause();
    if (track) track.pauseAll();
    if (overlay && overlay.pause) overlay.pause();
    done += r.end - r.start;
  }
  rec.resume();
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  ac.close();
  onProgress(1);
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
}

// Grab one frame as a 1080x1920 PNG (cover image).
export async function frameAt(url, t) {
  const [v] = await makeVideos([url]);
  await seek(v, Math.max(0, t));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  drawCover(ctx, v);
  return c;
}
