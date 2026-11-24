// On-screen text: hook, auto captions and list lines, drawn onto the 1080x1920 frame.
import { W, H } from './export.js';

export const FONTS = [
  'Poppins', 'Montserrat', 'Anton', 'Bebas Neue', 'Oswald', 'Archivo Black', 'Bangers',
  'Lilita One', 'Luckiest Guy', 'Fredoka', 'Nunito', 'Rubik', 'Inter', 'Permanent Marker',
  'Caveat', 'Pacifico', 'Lobster', 'DM Serif Display', 'Playfair Display', 'Roboto Condensed',
];

export const BRAND = [
  { name: 'Yellow', c: '#FFD60A' }, { name: 'Teal', c: '#0F8B8D' }, { name: 'Warm gold', c: '#E8A33D' },
  { name: 'Mint', c: '#BFE8D9' }, { name: 'White', c: '#FFFFFF' }, { name: 'Black', c: '#000000' },
];

export const MY_STYLE = {
  font: 'Poppins', weight: 900, italic: true, size: 74, color: '#FFFFFF', hl: '#FFD60A',
  outline: 9, outlineColor: '#000000', shadow: true, upper: false,
};

const loaded = new Set();
export function loadFont(name) {
  if (loaded.has(name)) return Promise.resolve();
  loaded.add(name);
  const fam = name.replace(/ /g, '+');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,700;0,900;1,400;1,700;1,900&display=swap`;
  link.onerror = () => {
    // some fonts only come in one weight; ask for the plain version
    link.href = `https://fonts.googleapis.com/css2?family=${fam}&display=swap`;
  };
  document.head.appendChild(link);
  return new Promise((r) => setTimeout(r, 300));
}
let allLoaded = false;
export function loadAllFonts() {
  if (allLoaded) return;
  allLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?' + FONTS.map((f) => 'family=' + f.replace(/ /g, '+')).join('&') + '&display=swap';
  document.head.appendChild(link);
}
export async function ready(style) {
  await loadFont(style.font);
  try { await document.fonts.load(fontStr(style, style.size)); } catch {}
}

export const fontStr = (st, px) => `${st.italic ? 'italic ' : ''}${st.weight} ${Math.round(px)}px "${st.font}", Poppins, sans-serif`;

// Lay out words (each {text, hl, big}) into centered lines no wider than maxW.
function layout(ctx, st, words, maxW) {
  const lines = [[]];
  let lineW = 0;
  const space = st.size * 0.28;
  for (const w of words) {
    const px = st.size * (w.big ? 1.35 : 1);
    ctx.font = fontStr(st, px);
    const txt = st.upper ? w.text.toUpperCase() : w.text;
    const ww = ctx.measureText(txt).width;
    const cur = lines[lines.length - 1];
    if (cur.length && lineW + space + ww > maxW) { lines.push([]); lineW = 0; }
    const line = lines[lines.length - 1];
    line.push({ ...w, txt, px, ww });
    lineW += (line.length > 1 ? space : 0) + ww;
  }
  return { lines: lines.filter((l) => l.length), space };
}

// Draw a block of words centered at (cx, cy). anim: {scale, alpha}
export function drawWords(ctx, st, words, cx, cy, anim = {}) {
  if (!words.length) return;
  const scale = anim.scale ?? 1, alpha = anim.alpha ?? 1;
  const { lines, space } = layout(ctx, st, words, W * 0.84);
  const lineH = lines.map((l) => Math.max(...l.map((w) => w.px)) * 1.15);
  const totalH = lineH.reduce((a, b) => a + b, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  let y = -totalH / 2;
  lines.forEach((line, li) => {
    const widths = line.reduce((s, w, i) => s + w.ww + (i ? space : 0), 0);
    let x = -widths / 2;
    const base = y + lineH[li] * 0.8;
    for (const w of line) {
      if (w.hidden) { x += w.ww + space; continue; }
      ctx.font = fontStr(st, w.px);
      const color = w.hl || w.now ? st.hl : st.color;
      if (st.shadow) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = w.px * 0.18; ctx.shadowOffsetY = w.px * 0.07;
        ctx.fillStyle = '#000'; ctx.fillText(w.txt, x, base);
        ctx.restore();
      }
      if (st.outline > 0) {
        ctx.lineWidth = st.outline * (w.px / st.size);
        ctx.strokeStyle = st.outlineColor;
        ctx.strokeText(w.txt, x, base);
      }
      ctx.fillStyle = color;
      ctx.fillText(w.txt, x, base);
      x += w.ww + space;
    }
    y += lineH[li];
  });
  ctx.restore();
}

// Caption chunks: kept words grouped n at a time, breaking at sentences and pauses.
export function chunks(outWords, n) {
  const out = [];
  let cur = [];
  outWords.forEach((w, i) => {
    const prev = outWords[i - 1];
    const brk = w.brk || (!w.join && (cur.length >= n || (prev && (/[.?!,]$/.test(prev.text) || w.pause || w.s - prev.e > 0.45))));
    if (cur.length && brk) { out.push(cur); cur = []; }
    cur.push(w);
  });
  if (cur.length) out.push(cur);
  return out.map((c, i) => {
    const next = out[i + 1];
    const end = next && next[0].s - c[c.length - 1].e < 0.35 ? next[0].s : c[c.length - 1].e + 0.15;
    return { words: c, s: c[0].s, e: end };
  });
}

function animFor(kind, since) {
  const k = Math.min(1, since / 0.16);
  if (kind === 'pop') return { scale: 0.75 + 0.25 * k };
  if (kind === 'bounce') { const b = Math.min(1, since / 0.28); return { scale: b < 0.6 ? 0.6 + b * 0.9 : 1.14 - (b - 0.6) * 0.35 }; }
  if (kind === 'fade') return { alpha: k };
  return {};
}

// Everything text-related drawn at reel time t. layers = {hook, caps, list}
// When each list line is said out loud: match the line's first words to the transcript.
export function syncListTimes(lines, words) {
  const EXP = { "you're": 'you are', "i'm": 'i am', "it's": 'it is', "don't": 'do not', "can't": 'can not', "won't": 'will not', "we're": 'we are', "they're": 'they are', "that's": 'that is', "you've": 'you have', "i've": 'i have', "isn't": 'is not', "didn't": 'did not', "i'd": 'i would', "you'd": 'you would', "you'll": 'you will', "i'll": 'i will' };
  const toks = (txt) => txt.toLowerCase().replace(/[’]/g, "'").split(/[\s-]+/).flatMap((x) => { x = x.replace(/[^a-z0-9']/g, ''); return (EXP[x] || x.replace(/'/g, '')).split(' '); }).filter(Boolean);
  const T = []; // [token, word index]
  words.forEach((w, i) => toks(w.text).forEach((t) => T.push([t, i])));
  const NUM = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
  let cur = 0;
  return lines.map((ln) => {
    const m = ln.match(/^\s*(\d+)[.)]?\s*/);
    const want = toks(ln.replace(/^\s*\d+[.)]?\s*/, '')).slice(0, 4);
    if (!want.length) return null;
    const need = Math.min(3, want.length);
    for (let j = cur; j < T.length; j++) {
      if (T[j][0] !== want[0]) continue;
      let hit = 0;
      for (let k = 0; k < want.length && j + k < T.length; k++) if (T[j + k][0] === want[k]) hit++;
      if (hit >= need) {
        const wi = T[j][1];
        let s = words[wi].s;
        const prev = j > 0 ? T[j - 1][0] : '';
        if (m && (prev === m[1] || prev === NUM[m[1]])) s = words[T[j - 1][1]].s; // start on the number if you said it
        cur = j + 1;
        return Math.max(0, s - 0.1);
      }
    }
    return null;
  });
}

export function drawText(ctx, T, t, layers = { hook: true, caps: true, list: true }, part = 0) {
  if (!T) return;
  // Hook (part 1 / whole reel) or "PART 2" label
  const hookText = part === 2 ? (T.hook.part2 || 'Part 2') : T.hook.text;
  if (layers.hook && T.hook.on && hookText && t < T.hook.dur) {
    const words = hookText.split(/\s+/).filter(Boolean).map((w) => ({ text: w.replace(/^\*|\*$/g, ''), hl: /^\*.*\*$/.test(w) }));
    drawWords(ctx, T.hook.style, words, W * T.hook.x, H * T.hook.y, animFor(T.hook.anim, t));
  }
  // Captions
  if (layers.caps && T.caps.on && T.caps.chunks) {
    const c = T.caps.chunks.find((ch) => t >= ch.s && t < ch.e);
    if (c && !(T.hook.on && T.caps.skipUnderHook && t < T.hook.dur)) {
      const kind = T.caps.anim;
      const words = c.words.map((w) => ({
        text: w.text, hl: w.hl, big: w.big,
        now: kind === 'karaoke' && t >= w.s && t < Math.max(w.e, w.s + 0.12),
        hidden: kind === 'word' && t < w.s,
      }));
      drawWords(ctx, T.caps.style, words, W * T.caps.x, H * T.caps.y, animFor(kind === 'karaoke' || kind === 'word' ? 'none' : kind, t - c.s));
    }
  }
  // Typed captions: cards you typed, or one block scrolling up like a teleprompter
  const TY = T.typed;
  if (layers.caps && TY && TY.on && TY.cards && TY.cards.length) {
    const parse = (ln) => ln.split(/\s+/).filter(Boolean).map((w) => ({ text: w.replace(/^\*|\*$/g, ''), hl: /^\*.*\*$/.test(w) }));
    if (TY.mode === 'scroll') {
      const a = TY.cards[0].start, last = TY.cards[TY.cards.length - 1], b = last.start + last.dur;
      if (t >= a && t < b) {
        const gap = TY.style.size * 1.5, blockH = TY.cards.length * gap;
        const p = (t - a) / Math.max(0.1, b - a);
        const top = H - p * (H + blockH); // enters at the bottom, leaves at the top
        TY.cards.forEach((c, i) => drawWords(ctx, TY.style, parse(c.text), W * TY.x, top + i * gap + gap / 2));
      }
    } else {
      const c = TY.cards.find((x) => t >= x.start && t < x.start + x.dur);
      if (c) drawWords(ctx, TY.style, parse(c.text), W * TY.x, H * TY.y, animFor(TY.anim, t - c.start));
    }
  }
  // List lines, one at a time
  if (layers.list && T.list.on && T.list.lines.trim()) {
    const lines = T.list.lines.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = (i) => (T.list.times && T.list.times[i] != null ? T.list.times[i] : T.list.start + i * T.list.every);
    // when the whole list goes away
    const lastAt = lines.length ? at(lines.length - 1) : 0;
    const endAt = T.list.hide === 'after' ? lastAt + (T.list.hideAfter ?? 3) : T.list.hide === 'at' ? (T.list.hideAt ?? lastAt + 3) : Infinity;
    const shown = t >= endAt ? [] : lines.filter((_, i) => t >= at(i));
    const toWords = (ln) => ln.split(/\s+/).map((w) => ({ text: w.replace(/^\*|\*$/g, ''), hl: /^\*.*\*$/.test(w) }));
    const items = shown.map((ln, i) => ({ i, words: toWords(ln) }));
    if ((T.list.mode || 'one') === 'one') {
      // only the newest line shows; it replaces the one before
      const it = items[items.length - 1];
      if (it) drawWords(ctx, T.list.style, it.words, W * T.list.x, H * T.list.y, animFor('pop', t - at(it.i)));
    } else {
      // stack them, each below the last (long lines wrap), shrinking to fit if needed
      const heightOf = (st, words) => { const { lines } = layout(ctx, st, words, W * 0.84); return lines.reduce((a, l) => a + Math.max(...l.map((w) => w.px)) * 1.15, 0); };
      const all = lines.map((ln) => toWords(ln)); // size for the full list so text doesn't jump as lines appear
      let st = T.list.style;
      const gapOf = (s) => s.size * 0.35;
      const totalOf = (s) => all.reduce((a, w) => a + heightOf(s, w), 0) + gapOf(s) * (all.length - 1);
      const room = H * 0.9 - H * T.list.y;
      const tot = totalOf(st);
      if (tot > room) st = { ...st, size: Math.max(st.size * 0.5, st.size * (room / tot)) };
      let y = H * T.list.y;
      items.forEach((it) => {
        const h = heightOf(st, it.words);
        drawWords(ctx, st, it.words, W * T.list.x, y + h / 2, animFor('pop', t - at(it.i)));
        y += h + gapOf(st);
      });
    }
  }
}

export function defaultText() {
  return {
    hook: { on: true, text: '', part2: 'Part 2', dur: 2, x: 0.5, y: 0.2, anim: 'pop', behind: false, style: { ...MY_STYLE, size: 92 } },
    caps: { on: true, n: 2, anim: 'karaoke', x: 0.5, y: 0.72, behind: false, skipUnderHook: false, style: { ...MY_STYLE } },
    list: { on: false, lines: '', start: 2, every: 2.5, x: 0.5, y: 0.3, behind: false, style: { ...MY_STYLE, size: 64 } },
    // typed captions for videos where the words do the work (no talking)
    typed: { on: false, lines: '', mode: 'whole', clip: 0, cards: [], anim: 'pop', x: 0.5, y: 0.6, behind: false, style: { ...MY_STYLE } },
  };
}
