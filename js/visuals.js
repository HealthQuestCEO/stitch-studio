// Voice-over mode: what plays on screen while you talk.
// Visuals play in order. Each one gets its own seconds, or an equal share of what's left.
import { W, H, drawCover } from './export.js';

export function schedule(visuals, totalSec) {
  const fixed = visuals.reduce((s, v) => s + (v.sec || 0), 0);
  const autos = visuals.filter((v) => !v.sec).length;
  const each = autos ? Math.max(0.5, (totalSec - fixed) / autos) : 0;
  let t = 0;
  return visuals.map((v) => {
    const d = v.sec || each;
    const slot = { ...v, at: t, dur: d };
    t += d;
    return slot;
  });
}

export function slotAt(slots, t) {
  if (!slots.length) return null;
  for (const s of slots) if (t < s.at + s.dur) return s;
  return slots[slots.length - 1]; // past the end: hold the last one
}

function drawImageCover(ctx, img, zoom = 1) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(W / iw, H / ih) * zoom;
  const dw = iw * scale, dh = ih * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// Loads every visual once and draws the right one for a given reel time.
export class VisualTrack {
  constructor(visuals, urlFor, totalSec) {
    this.slots = schedule(visuals, totalSec);
    this.urlFor = urlFor;
    this.els = {};
    this.current = null;
  }

  async load() {
    for (const s of this.slots) {
      const url = this.urlFor(s.id);
      if (s.kind === 'image') {
        const img = new Image();
        img.src = url;
        await img.decode().catch(() => {});
        this.els[s.id] = img;
      } else {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
        await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
        this.els[s.id] = v;
      }
    }
  }

  // Called every frame while exporting. t = time in the reel.
  draw(ctx, t, running = true) {
    const s = slotAt(this.slots, t);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!s) return;
    const el = this.els[s.id];
    const local = Math.max(0, t - s.at);
    if (this.current && this.current !== s.id && this.els[this.current] instanceof HTMLVideoElement) this.els[this.current].pause();
    this.current = s.id;
    if (s.kind === 'image') {
      // slow push-in so photos don't feel frozen
      drawImageCover(ctx, el, 1 + 0.08 * Math.min(1, local / Math.max(s.dur, 0.1)));
    } else {
      const want = el.duration ? local % el.duration : local;
      if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      if (running && el.paused) el.play().catch(() => {});
      if (!running && !el.paused) el.pause();
      drawCover(ctx, el);
    }
  }

  pauseAll() { Object.values(this.els).forEach((e) => e instanceof HTMLVideoElement && e.pause()); }

  // For cover images: draw a still at time t (waits for the video frame).
  async still(ctx, t) {
    const s = slotAt(this.slots, t);
    if (!s) return;
    const el = this.els[s.id];
    if (s.kind !== 'image') {
      const local = Math.max(0, t - s.at);
      el.currentTime = el.duration ? local % el.duration : local;
      await new Promise((r) => { el.onseeked = r; setTimeout(r, 1500); });
    }
    this.draw(ctx, t, false);
  }
}
