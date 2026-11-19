// Photo / carousel posts: one slide per picture, exported as images in the right size.
import { W, H } from './export.js';

export const ASPECTS = {
  '4:5': { name: 'Feed 4:5 (1080×1350)', w: 1080, h: 1350 },
  '1:1': { name: 'Square 1:1 (1080×1080)', w: 1080, h: 1080 },
  '9:16': { name: 'Story 9:16 (1080×1920)', w: 1080, h: 1920 },
};

// Where the post sits inside the 1080×1920 working frame.
export function cropRect(aspect) {
  const a = ASPECTS[aspect] || ASPECTS['4:5'];
  const h = (W * a.h) / a.w;
  return { x: 0, y: (H - h) / 2, w: W, h };
}

export async function loadImages(slides, urlFor) {
  const out = {};
  for (const s of slides) {
    const img = new Image();
    img.src = urlFor(s.id);
    try { await img.decode(); out[s.id] = img; } catch { out[s.id] = null; }
  }
  return out;
}

// Slide i shows at time i to i+1.
export function drawSlide(ctx, slides, imgs, t, aspect) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const s = slides[Math.min(slides.length - 1, Math.max(0, Math.floor(t)))];
  const img = s && imgs[s.id];
  if (!img) return;
  const r = cropRect(aspect);
  const sc = Math.max(r.w / img.naturalWidth, r.h / img.naturalHeight);
  const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
  ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.drawImage(img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  ctx.restore();
}

// Crop the finished 1080×1920 frame down to the post size.
export function cropTo(canvas, aspect) {
  const r = cropRect(aspect), a = ASPECTS[aspect] || ASPECTS['4:5'];
  const c = document.createElement('canvas'); c.width = a.w; c.height = a.h;
  c.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, a.w, a.h);
  return c;
}

// Tiny zip writer (no compression; PNGs are already compressed).
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export async function makeZip(files) { // files: [{name, blob}]
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, x) => s + (x.byteLength ?? x.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
