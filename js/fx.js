// Mirror effects, transitions between cuts, and graphics/stamps.
import { W, H } from './export.js';

const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// ---------- mirror effects ----------
export const MIRRORS = {
  splitLR: 'Mirror split (left ↔ right)',
  splitTB: 'Mirror split (top ↕ bottom)',
  grid2: 'Repeat grid 2×2',
  grid3: 'Repeat grid 3×3',
  clones: 'Side-by-side clones (3)',
  kaleido: 'Kaleidoscope (4-way)',
  punch: 'Close-up (punch in)',
  push: 'Slow zoom in',
};

export function applyMirror(ctx, src, kind, p = 0) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (kind === 'punch' || kind === 'push') {
    // zoom toward your face (a little above center)
    const z = kind === 'punch' ? 1.4 : 1 + 0.3 * Math.min(1, Math.max(0, p));
    const cx = W / 2, cy = H * 0.4, sw = W / z, sh = H / z;
    const sx = Math.min(W - sw, Math.max(0, cx - sw / 2)), sy = Math.min(H - sh, Math.max(0, cy - sh / 2));
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  } else if (kind === 'splitLR') {
    ctx.drawImage(src, 0, 0, W / 2, H, 0, 0, W / 2, H);
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(src, 0, 0, W / 2, H, 0, 0, W / 2, H); ctx.restore();
  } else if (kind === 'splitTB') {
    ctx.drawImage(src, 0, 0, W, H / 2, 0, 0, W, H / 2);
    ctx.save(); ctx.translate(0, H); ctx.scale(1, -1); ctx.drawImage(src, 0, 0, W, H / 2, 0, 0, W, H / 2); ctx.restore();
  } else if (kind === 'grid2' || kind === 'grid3') {
    const n = kind === 'grid2' ? 2 : 3;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) ctx.drawImage(src, (c * W) / n, (r * H) / n, W / n, H / n);
  } else if (kind === 'clones') {
    // three copies, each a centered vertical slice of you
    const sw = W / 3;
    for (let i = 0; i < 3; i++) ctx.drawImage(src, W / 2 - sw / 2, 0, sw, H, i * sw, 0, sw, H);
  } else if (kind === 'kaleido') {
    const qw = W / 2, qh = H / 2;
    const quad = (sx, sy) => { ctx.save(); ctx.translate(sx ? W : 0, sy ? H : 0); ctx.scale(sx ? -1 : 1, sy ? -1 : 1); ctx.drawImage(src, W / 4, H / 4, qw, qh, 0, 0, qw, qh); ctx.restore(); };
    quad(0, 0); quad(1, 0); quad(0, 1); quad(1, 1);
  } else ctx.drawImage(src, 0, 0);
}

// ---------- transitions ----------
export const TRANSITIONS = {
  cut: 'Hard cut', crossfade: 'Crossfade', swipeL: 'Swipe left', swipeR: 'Swipe right',
  swipeU: 'Swipe up', zoom: 'Zoom in', flash: 'Flash', whip: 'Whip pan',
};

export function composeTransition(ctx, prev, cur, kind, p) {
  const e = ease(p);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (kind === 'crossfade') { ctx.drawImage(cur, 0, 0); ctx.globalAlpha = 1 - p; ctx.drawImage(prev, 0, 0); ctx.globalAlpha = 1; }
  else if (kind === 'swipeL') { ctx.drawImage(prev, -e * W, 0); ctx.drawImage(cur, (1 - e) * W, 0); }
  else if (kind === 'swipeR') { ctx.drawImage(prev, e * W, 0); ctx.drawImage(cur, -(1 - e) * W, 0); }
  else if (kind === 'swipeU') { ctx.drawImage(prev, 0, -e * H); ctx.drawImage(cur, 0, (1 - e) * H); }
  else if (kind === 'zoom') {
    if (p < 0.5) { const s = 1 + p * 0.8; ctx.drawImage(prev, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s); }
    else { const s = 1.4 - (p - 0.5) * 0.8; ctx.drawImage(cur, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s); }
  } else if (kind === 'flash') {
    ctx.drawImage(p < 0.35 ? prev : cur, 0, 0);
    ctx.fillStyle = `rgba(255,255,255,${Math.max(0, 1 - Math.abs(p - 0.35) / 0.35) * 0.95})`; ctx.fillRect(0, 0, W, H);
  } else if (kind === 'whip') {
    const blur = Math.round(Math.sin(p * Math.PI) * 28);
    ctx.filter = blur ? `blur(${blur}px)` : 'none';
    ctx.drawImage(prev, -e * W, 0); ctx.drawImage(cur, (1 - e) * W, 0);
    ctx.filter = 'none';
  } else ctx.drawImage(cur, 0, 0);
}

// Builds frames: base -> mirror effect -> transition from the last cut.
export class Compositor {
  constructor(effects, trans, ranges, offset = 0, allowTrans = true) {
    this.effects = effects || []; this.trans = trans; this.ranges = ranges; this.offset = offset; this.allowTrans = allowTrans;
    this.base = mk(); this.fx = mk(); this.last = mk(); this.prev = mk(); this.k = -1;
    this.bctx = this.base.getContext('2d'); this.fctx = this.fx.getContext('2d');
  }
  joinKind(k) {
    if (k <= 0 || !this.allowTrans) return 'cut';
    const r = this.ranges[k];
    return (this.trans.joins || {})[joinKey(r)] || this.trans.def || 'cut';
  }
  // drawBase(ctx) paints the plain frame; t = time in this part; k = range index; local = time inside the range
  frame(ctx, drawBase, t, k, local) {
    this.bctx.fillStyle = '#000'; this.bctx.fillRect(0, 0, W, H);
    drawBase(this.bctx);
    const ft = t + this.offset;
    const eff = this.effects.find((e) => ft >= e.start && ft < e.start + e.dur);
    let cur = this.base;
    if (eff) { applyMirror(this.fctx, this.base, eff.kind, (ft - eff.start) / (eff.dur || 1)); cur = this.fx; }
    if (k !== this.k) { // new cut: freeze the last frame we showed
      this.prev.getContext('2d').drawImage(this.last, 0, 0);
      this.k = k;
    }
    const kind = this.joinKind(k), dur = this.trans.dur || 0.3;
    if (kind !== 'cut' && local < dur) composeTransition(ctx, this.prev, cur, kind, local / dur);
    else ctx.drawImage(cur, 0, 0);
    this.last.getContext('2d').drawImage(cur, 0, 0);
  }
}
export const joinKey = (r) => `${r.take}:${r.start.toFixed(2)}`;

// ---------- graphics and stamps ----------
export const GFX = {
  stampCheck: '✓ Stamp', stampX: '✗ Stamp', check: '✓ Check', cross: '✗ Cross', arrow: 'Arrow',
  circle: 'Circle', underline: 'Underline', sparkle: 'Sparkles', star: 'Star burst', emoji: 'Emoji',
  logo: 'HealthQuest logo', png: 'My PNG',
};
const DEF_COLOR = { stampCheck: '#1E9E5A', stampX: '#D7263D', check: '#1E9E5A', cross: '#D7263D', arrow: '#FFD60A', circle: '#FFD60A', underline: '#FFD60A', sparkle: '#FFD60A', star: '#E8A33D' };

export function newGfx(id, type, start, extra = {}) {
  return {
    id, type, start: Math.max(0, +start.toFixed(2)), dur: 1.5, x: 0.5, y: 0.45,
    size: ['stampCheck', 'stampX', 'logo', 'png'].includes(type) ? 0.45 : 0.3, rot: type.startsWith('stamp') ? -12 : 0,
    color: DEF_COLOR[type] || '#FFD60A', text: '', anim: type.startsWith('stamp') ? 'slam' : ['circle', 'underline', 'arrow'].includes(type) ? 'draw' : 'pop',
    ...extra,
  };
}

function roughCircle(ctx, rx, ry, p, lw) {
  ctx.beginPath();
  const end = Math.PI * 2 * 1.08 * p;
  for (let a = 0; a <= end; a += 0.05) {
    const wob = 1 + Math.sin(a * 3) * 0.03;
    const x = Math.cos(a - 0.4) * rx * wob, y = Math.sin(a - 0.4) * ry * wob;
    a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();
}
function checkPath(ctx, s) { ctx.beginPath(); ctx.moveTo(-0.35 * s, 0); ctx.lineTo(-0.1 * s, 0.25 * s); ctx.lineTo(0.38 * s, -0.28 * s); }
function crossPath(ctx, s) { ctx.beginPath(); ctx.moveTo(-0.3 * s, -0.3 * s); ctx.lineTo(0.3 * s, 0.3 * s); ctx.moveTo(0.3 * s, -0.3 * s); ctx.lineTo(-0.3 * s, 0.3 * s); }
function starPath(ctx, r, pts = 4, inner = 0.35) {
  ctx.beginPath();
  for (let i = 0; i < pts * 2; i++) { const rr = i % 2 ? r * inner : r, a = (i * Math.PI) / pts - Math.PI / 2; i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  ctx.closePath();
}
let _stamp = null;
function stampCanvas(sz) { if (!_stamp || _stamp.width < sz) { _stamp = document.createElement('canvas'); _stamp.width = _stamp.height = sz; } return _stamp; }
function drawStamp(ctx, g, s) {
  ctx.lineWidth = s * 0.06; ctx.beginPath(); ctx.arc(0, 0, s * 0.48, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = s * 0.025; ctx.beginPath(); ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = s * 0.1;
  if (g.text) {
    ctx.font = `900 ${Math.round(s * 0.2)}px Poppins, "Archivo Black", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(g.text.toUpperCase(), 0, s * 0.1, s * 0.7);
    ctx.save(); ctx.translate(0, -s * 0.14); g.type === 'stampCheck' ? checkPath(ctx, s * 0.32) : crossPath(ctx, s * 0.26); ctx.lineWidth = s * 0.06; ctx.stroke(); ctx.restore();
  } else { g.type === 'stampCheck' ? checkPath(ctx, s * 0.62) : crossPath(ctx, s * 0.55); ctx.stroke(); }
  ctx.globalCompositeOperation = 'destination-out';
  // specks only on the rings, so words and marks stay readable
  for (let i = 0; i < 30; i++) { const a = (i * 2.399) % (Math.PI * 2), r = s * (0.37 + ((i * 37) % 100) / 100 * 0.14); ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, s * 0.008 * (1 + (i % 3)), 0, Math.PI * 2); ctx.fill(); }
  ctx.globalCompositeOperation = 'source-over';
}
function outline(ctx, lw) { ctx.save(); ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = lw * 1.6; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore(); }

export class GfxLayer {
  constructor(items, urlFor, logoUrl) { this.items = items || []; this.urlFor = urlFor; this.logoUrl = logoUrl; this.imgs = {}; }
  async load() {
    for (const g of this.items) {
      const url = g.type === 'logo' ? this.logoUrl : g.type === 'png' ? this.urlFor(g.id) : null;
      if (!url || this.imgs[url]) continue;
      const img = new Image(); img.src = url; await img.decode().catch(() => {}); this.imgs[url] = img;
    }
  }
  draw(ctx, t) {
    for (const g of this.items) {
      if (t < g.start || t >= g.start + g.dur) continue;
      const local = t - g.start, out = Math.min(1, (g.dur - local) / 0.15);
      const s = W * g.size;
      let scale = 1, alpha = out, prog = 1, shake = 0;
      if (g.anim === 'pop') { const k = Math.min(1, local / 0.18); scale = 0.6 + 0.4 * (1 - Math.pow(1 - k, 3)) + (k < 1 ? 0 : 0); }
      if (g.anim === 'fade') alpha *= Math.min(1, local / 0.25);
      if (g.anim === 'slam') { const k = Math.min(1, local / 0.14); scale = 2.2 - 1.2 * k; alpha *= Math.min(1, k * 3); if (local > 0.14 && local < 0.3) shake = Math.sin(local * 120) * 6; }
      if (g.anim === 'draw') prog = Math.min(1, local / 0.45);
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(W * g.x + shake, H * g.y);
      ctx.rotate((g.rot * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.strokeStyle = ctx.fillStyle = g.color;
      ctx.lineJoin = ctx.lineCap = 'round';
      const lw = Math.max(6, s * 0.07);
      switch (g.type) {
        case 'stampCheck': case 'stampX': {
          // drawn on its own canvas so the "worn ink" specks don't cut holes in the video
          const sz = Math.ceil(s * 1.1), off = stampCanvas(sz), o = off.getContext('2d');
          o.clearRect(0, 0, sz, sz); o.save(); o.translate(sz / 2, sz / 2);
          o.strokeStyle = o.fillStyle = g.color; o.lineJoin = o.lineCap = 'round';
          drawStamp(o, g, s);
          o.restore();
          ctx.globalAlpha *= 0.92;
          ctx.drawImage(off, -sz / 2, -sz / 2);
          break;
        }
        case 'check': checkPath(ctx, s); outline(ctx, lw); ctx.lineWidth = lw; ctx.stroke(); break;
        case 'cross': crossPath(ctx, s); outline(ctx, lw); ctx.lineWidth = lw; ctx.stroke(); break;
        case 'arrow': {
          const len = s * prog;
          ctx.beginPath(); ctx.moveTo(-s / 2, 0); ctx.quadraticCurveTo(-s / 2 + len * 0.5, -s * 0.18, -s / 2 + len, 0);
          outline(ctx, lw); ctx.lineWidth = lw; ctx.stroke();
          if (prog >= 1) { ctx.beginPath(); ctx.moveTo(s / 2 - s * 0.2, -s * 0.17); ctx.lineTo(s / 2, 0); ctx.lineTo(s / 2 - s * 0.24, s * 0.1); outline(ctx, lw); ctx.lineWidth = lw; ctx.stroke(); }
          break;
        }
        case 'circle': roughCircle(ctx, s * 0.6, s * 0.38, prog, lw * 0.8); break;
        case 'underline': ctx.beginPath(); ctx.moveTo(-s / 2, 0); ctx.quadraticCurveTo(0, s * 0.06, -s / 2 + s * prog, -s * 0.02); ctx.lineWidth = lw; ctx.stroke(); break;
        case 'sparkle': {
          const tw = (k) => 0.6 + 0.4 * Math.abs(Math.sin(local * 6 + k));
          [[0, 0, 0.5], [-0.55, -0.4, 0.28], [0.5, -0.5, 0.22], [0.45, 0.45, 0.3]].forEach(([x, y, r], k) => {
            ctx.save(); ctx.translate(x * s, y * s); starPath(ctx, r * s * tw(k), 4, 0.28); ctx.lineWidth = lw * 0.3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke(); ctx.fill(); ctx.restore();
          });
          break;
        }
        case 'star': starPath(ctx, s * 0.5, 12, 0.62); ctx.lineWidth = lw * 0.4; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke(); ctx.fill();
          if (g.text) { ctx.fillStyle = '#fff'; ctx.font = `900 italic ${Math.round(s * 0.18)}px Poppins, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = s * 0.03; ctx.strokeStyle = '#000'; ctx.strokeText(g.text, 0, 0, s * 0.8); ctx.fillText(g.text, 0, 0, s * 0.8); }
          break;
        case 'emoji': ctx.font = `${Math.round(s)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(g.text || '🔥', 0, 0); break;
        case 'logo': case 'png': {
          const img = this.imgs[g.type === 'logo' ? this.logoUrl : this.urlFor(g.id)];
          if (img && img.naturalWidth) { const h = (s * img.naturalHeight) / img.naturalWidth; ctx.drawImage(img, -s / 2, -h / 2, s, h); }
          break;
        }
      }
      ctx.restore();
    }
  }
}

// ---------- auto zoom ----------
// Picks close-ups the way an editor would: the hook, words that carry the message
// (numbers, money, strong words, *highlighted* words), and every other jump cut.
const STRONG = /^(never|nobody|no|not|don't|won't|can't|why|stop|secret|truth|think|billion|million|every|only|wrong|backwards|disappear|sick|free)$/i;
export function autoZoom(words, ranges, total) {
  const out = [], GAP = 3, HOLD = 1.3;
  const free = (t) => out.every((e) => t >= e.start + e.dur + GAP || t + HOLD + GAP <= e.start);
  const add = (start, dur) => { start = Math.max(0, start); dur = Math.min(dur, Math.max(0.4, total - start)); if (dur > 0.3 && free(start)) out.push({ kind: 'punch', start: +start.toFixed(2), dur: +dur.toFixed(2), auto: true }); };
  // 1. the hook: first line, up to 1.8 s
  const firstEnd = words.find((w, i) => i > 0 && (/[.!?]$/.test(words[i - 1].text) || w.s - words[i - 1].e > 0.35));
  add(0, Math.min(1.8, firstEnd ? firstEnd.s : 1.5));
  // 2. message words
  for (const w of words) {
    const t = w.text.replace(/[^\w$%'.]/g, '');
    if (w.hl || /[\d$%]/.test(t) || STRONG.test(t)) add(w.s - 0.1, HOLD);
  }
  // 3. every other jump cut, if nothing nearby
  let acc = 0, n = 0;
  for (const r of ranges) { if (acc > 0 && n++ % 2 === 0) add(acc, Math.min(2, r.end - r.start)); acc += r.end - r.start; }
  return out.sort((a, b) => a.start - b.start);
}
