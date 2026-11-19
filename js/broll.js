// B-roll: photos and clips over your voice, full screen or framed over you.
// Your audio keeps playing; clip sound is muted unless you turn its volume up (b.vol, 0-2).
import { W, H, drawCover } from './export.js';
import { loadFont } from './text.js';

export const FRAMES = { plain: 'Plain', polaroid: 'Polaroid', phone: 'Phone screen', notebook: 'Notebook paper' };

export function newBroll(id, kind, name, start) {
  return {
    id, kind, name, start: Math.max(0, +start.toFixed(2)), dur: 3,
    layout: 'framed', x: 0.5, y: 0.42, size: 0.62, tilt: 0,
    frame: 'plain', border: 10, borderColor: '#FFFFFF', radius: 28, shadow: true,
    caption: '', anim: 'pop',
  };
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const dims = (el) => [el.videoWidth || el.naturalWidth || el.width || 1, el.videoHeight || el.naturalHeight || el.height || 1];

// Draw media into a box, cropped to fill it.
function fillBox(ctx, el, x, y, w, h) {
  const [iw, ih] = dims(el);
  const s = Math.max(w / iw, h / ih), dw = iw * s, dh = ih * s;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function drawFramed(ctx, el, b, k) {
  const [iw, ih] = dims(el);
  const fw = W * b.size;
  let aspect = Math.min(Math.max(ih / iw, 0.6), 1.6); // keep frames sensible
  if (b.frame === 'phone') aspect = 2.05;
  const fh = fw * aspect;
  ctx.save();
  ctx.translate(W * b.x, H * b.y);
  ctx.rotate((b.tilt * Math.PI) / 180);
  ctx.scale(k.scale, k.scale);
  ctx.globalAlpha = k.alpha;
  ctx.translate(0, k.dy);
  const x = -fw / 2, y = -fh / 2;
  const shadow = () => { if (b.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16; } };

  if (b.frame === 'polaroid') {
    const pad = fw * 0.06, bottom = fw * 0.24;
    ctx.save(); shadow(); ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(x - pad, y - pad, fw + pad * 2, fh + pad + bottom); ctx.restore();
    fillBox(ctx, el, x, y, fw, fh);
    if (b.caption) {
      ctx.fillStyle = '#2b2b2b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(fw * 0.085)}px "Caveat", "Permanent Marker", cursive`;
      ctx.fillText(b.caption, 0, y + fh + bottom / 2 + pad * 0.2);
    }
  } else if (b.frame === 'phone') {
    const bez = fw * 0.045, r = fw * 0.14;
    ctx.save(); shadow(); ctx.fillStyle = '#111'; rr(ctx, x - bez, y - bez, fw + bez * 2, fh + bez * 2, r + bez); ctx.fill(); ctx.restore();
    ctx.save(); rr(ctx, x, y, fw, fh, r); ctx.clip(); fillBox(ctx, el, x, y, fw, fh); ctx.restore();
    ctx.fillStyle = '#111'; rr(ctx, -fw * 0.16, y + fw * 0.03, fw * 0.32, fw * 0.075, fw * 0.04); ctx.fill(); // notch
  } else if (b.frame === 'notebook') {
    const pad = fw * 0.09, px = x - pad, py = y - pad * 1.6, pw = fw + pad * 2, ph = fh + pad * 3.2;
    ctx.save(); shadow(); ctx.fillStyle = '#fffef7'; ctx.fillRect(px, py, pw, ph); ctx.restore();
    ctx.strokeStyle = 'rgba(80,140,220,0.35)'; ctx.lineWidth = 3;
    for (let ly = py + pad; ly < py + ph; ly += pw * 0.07) { ctx.beginPath(); ctx.moveTo(px, ly); ctx.lineTo(px + pw, ly); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(220,70,70,0.6)'; ctx.beginPath(); ctx.moveTo(px + pad * 0.6, py); ctx.lineTo(px + pad * 0.6, py + ph); ctx.stroke();
    fillBox(ctx, el, x, y, fw, fh);
    ctx.fillStyle = 'rgba(240,220,150,0.8)'; // tape
    ctx.save(); ctx.translate(0, py + pad * 0.3); ctx.rotate(-0.06); ctx.fillRect(-fw * 0.16, -pad * 0.35, fw * 0.32, pad * 0.7); ctx.restore();
  } else {
    const bw = b.border;
    ctx.save(); shadow();
    ctx.fillStyle = bw > 0 ? b.borderColor : '#000';
    rr(ctx, x - bw, y - bw, fw + bw * 2, fh + bw * 2, b.radius + bw); ctx.fill(); ctx.restore();
    ctx.save(); rr(ctx, x, y, fw, fh, b.radius); ctx.clip(); fillBox(ctx, el, x, y, fw, fh); ctx.restore();
  }
  ctx.restore();
}

function anim(b, local) {
  const k = Math.min(1, local / 0.22), out = Math.min(1, (b.dur - local) / 0.15);
  const ease = 1 - Math.pow(1 - k, 3);
  if (b.anim === 'pop') return { scale: (0.7 + 0.3 * ease) * (0.9 + 0.1 * out), alpha: Math.min(1, k * 2) * out, dy: 0 };
  if (b.anim === 'fade') return { scale: 1, alpha: Math.min(k, out), dy: 0 };
  if (b.anim === 'slide') return { scale: 1, alpha: out, dy: (1 - ease) * H * 0.6 };
  return { scale: 1, alpha: 1, dy: 0 };
}

export class BrollLayer {
  constructor(items, urlFor) { this.items = items; this.urlFor = urlFor; this.els = {}; }

  async load() {
    if (this.items.some((b) => b.frame === 'polaroid' && b.caption)) {
      await loadFont('Caveat');
      try { await document.fonts.load('80px "Caveat"'); } catch {}
    }
    for (const b of this.items) {
      if (this.els[b.id]) continue;
      const url = this.urlFor(b.id);
      if (!url) continue;
      if (b.kind === 'image') {
        const img = new Image(); img.src = url; await img.decode().catch(() => {}); this.els[b.id] = img;
      } else {
        const v = document.createElement('video');
        v.src = url; v.muted = !(b.vol > 0); v.volume = Math.min(1, b.vol || 0); v.playsInline = true; v.preload = 'auto';
        await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
        this.els[b.id] = v;
      }
    }
  }

  active(t) { return this.items.filter((b) => t >= b.start && t < b.start + b.dur && this.els[b.id]); }
  coversFull(t) { return this.active(t).some((b) => b.layout === 'full'); }

  // For still frames: put each visible clip on the right frame first.
  async prepare(t) {
    for (const b of this.active(t)) {
      const el = this.els[b.id];
      if (b.kind === 'image') continue;
      const want = el.duration ? (t - b.start) % el.duration : t - b.start;
      if (Math.abs(el.currentTime - want) > 0.04) {
        await new Promise((r) => { el.onseeked = r; el.currentTime = want; setTimeout(r, 1500); });
      }
    }
  }

  draw(ctx, t, running = false) {
    for (const b of this.items) {
      const el = this.els[b.id];
      if (!el) continue;
      const on = t >= b.start && t < b.start + b.dur;
      if (el instanceof HTMLVideoElement) {
        if (!on) { if (!el.paused) el.pause(); continue; }
        const want = el.duration ? (t - b.start) % el.duration : t - b.start;
        if (running) {
          if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
          if (el.paused) el.play().catch(() => {});
        } else if (!el.paused) el.pause();
      }
      if (!on) continue;
      const local = t - b.start;
      if (b.layout === 'full') {
        const k = anim(b, local);
        ctx.save(); ctx.globalAlpha = b.anim === 'none' ? 1 : Math.min(1, k.alpha + 0.0001);
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        if (el instanceof HTMLVideoElement) drawCover(ctx, el); else fillBox(ctx, el, 0, 0, W, H);
        ctx.restore();
      } else {
        drawFramed(ctx, el, b, anim(b, local));
      }
    }
  }

  // Clips with their sound turned up, for the export mix.
  audioEls() { return this.items.filter((b) => b.kind === 'video' && b.vol > 0 && this.els[b.id]).map((b) => ({ el: this.els[b.id], vol: b.vol })); }

  pauseAll() { Object.values(this.els).forEach((e) => e instanceof HTMLVideoElement && e.pause()); }
}
