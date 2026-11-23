// Clean it up: find long pauses, repeated lines and false starts.
// Rule: when a line is said more than once, keep the LAST take.
// Nothing is deleted. Everything is marked cut and can be put back.

const PAD = 0.08;           // seconds of breathing room kept on each side of a cut pause
const MIN_GAP = 0.12;       // quieter than this isn't worth showing as a pause
const PHRASE_GAP = 0.35;    // a pause this long ends a phrase

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9'$%]/g, '');

// Build the item list for one take. words may be null (no transcript).
export function buildItems(take, takeIndex, runs, words, pauseSec) {
  const items = [];
  const dur = take.duration;
  const gaps = runs.filter((r) => !r.speech && r.end - r.start >= MIN_GAP)
    .map((r) => ({ start: r.start, end: Math.min(r.end, dur) }));

  if (words && words.length) {
    // Merge words and quiet stretches in time order.
    const ws = words.map((w) => ({ ...w }));
    // Whisper sometimes stretches a word over silence. Trim it to the quiet edge.
    for (const g of gaps) {
      for (const w of ws) {
        if (g.start <= w.start && g.end > w.start && g.end < w.end) w.start = g.end;
        if (g.start > w.start && g.start < w.end && g.end >= w.end) w.end = g.start;
      }
    }
    const all = [
      ...ws.map((w) => ({ type: 'word', take: takeIndex, start: w.start, end: w.end, text: w.text })),
      ...gaps.map((g) => ({ type: 'gap', take: takeIndex, start: g.start, end: g.end })),
    ].sort((a, b) => a.start - b.start || (a.type === 'gap' ? -1 : 1));
    items.push(...all);
  } else {
    for (const r of runs) {
      if (r.speech) items.push({ type: 'speech', take: takeIndex, start: r.start, end: r.end });
      else if (r.end - r.start >= MIN_GAP) items.push({ type: 'gap', take: takeIndex, start: r.start, end: r.end });
    }
  }
  for (const it of items) { it.cut = false; it.reason = ''; }
  markPauses(items, pauseSec, dur);
  return items;
}

export function markPauses(items, pauseSec, dur) {
  for (const it of items) {
    if (it.type !== 'gap' || it.reason === 'kept' || it.reason === 'manual') continue;
    const len = it.end - it.start;
    const edge = it.start < 0.05 || (dur && it.end > dur - 0.05);
    const cut = len >= pauseSec || (edge && len >= 0.25);
    it.cut = cut;
    it.reason = cut ? 'pause' : '';
  }
}

// Phrases: runs of words separated by a sentence end, a long pause or a new take.
function phrases(items) {
  const out = [];
  let cur = null, lastWord = null;
  items.forEach((it, i) => {
    if (it.type === 'gap' && it.end - it.start >= PHRASE_GAP) { cur = null; return; }
    if (it.type !== 'word') return;
    const newTake = lastWord && lastWord.take !== it.take;
    if (!cur || newTake) { cur = { idx: [], tok: [] }; out.push(cur); }
    const t = norm(it.text);
    if (t) { cur.idx.push(i); cur.tok.push(t); }
    lastWord = it;
    if (/[.?!]$/.test(it.text.trim())) cur = null;
  });
  return out.filter((p) => p.tok.length);
}

function lcs(a, b) {
  const dp = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function markRepeats(items) {
  const ph = phrases(items);
  const cut = (i, reason) => { if (items[i].reason !== 'kept') { items[i].cut = true; items[i].reason = reason; } };

  // 1. Stutters inside a phrase: "so I so I went home" -> cut the first "so I".
  for (const p of ph) {
    for (let k = 4; k >= 1; k--) {
      for (let i = 0; i + 2 * k <= p.tok.length; i++) {
        let same = true;
        for (let j = 0; j < k; j++) if (p.tok[i + j] !== p.tok[i + k + j]) { same = false; break; }
        if (same && (k > 1 || p.tok[i].length > 1 || p.tok[i] === 'i')) {
          for (let j = 0; j < k; j++) cut(p.idx[i + j], 'repeat');
        }
      }
    }
  }

  // 2. Retakes: a phrase said again later (or started and abandoned) -> keep the last one.
  for (let a = 0; a < ph.length; a++) {
    const p = ph[a];
    const live = p.idx.filter((i) => !items[i].cut);
    if (!live.length) continue;
    for (let b = a + 1; b < Math.min(ph.length, a + 7); b++) {
      const q = ph[b];
      const n = p.tok.length;
      if (n < 2) {
        // one-word false start like "So—" right before "So I went home"
        if (n === 1 && q.tok[0] === p.tok[0] && b === a + 1) { p.idx.forEach((i) => cut(i, 'false start')); break; }
        continue;
      }
      const head = q.tok.slice(0, n + 2);
      const score = lcs(p.tok, head) / n;
      const prefixSame = p.tok.every((t, i) => q.tok[i] === t);
      if ((prefixSame && q.tok.length > n) || score >= 0.7) {
        p.idx.forEach((i) => cut(i, prefixSame && q.tok.length > n ? 'false start' : 'repeat'));
        // the pause between the two takes goes too
        for (let i = p.idx[p.idx.length - 1] + 1; i < q.idx[0]; i++) if (items[i].type === 'gap') cut(i, 'pause');
        break;
      }
    }
  }

  // 3. A pause right after a cut word goes with it.
  for (let i = 1; i < items.length; i++) {
    const it = items[i], prev = items[i - 1];
    if (it.type === 'gap' && !it.cut && prev.type === 'word' && prev.cut && prev.reason !== 'manual') cut(i, 'pause');
  }
}

// Kept time ranges, per take, in order. Optionally only one part.
export function keptRanges(items, takes, split = null, part = 0) {
  const out = [];
  takes.forEach((tk, ti) => {
    const cuts = items.filter((it) => it.take === ti && it.cut).map((it) => {
      if (it.type !== 'gap') return [it.start, it.end];
      const lead = it.start < 0.05, trail = it.end > tk.duration - 0.05;
      return [lead ? 0 : it.start + PAD, trail ? tk.duration : it.end - PAD];
    }).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    let t = 0;
    const keep = [];
    for (const [s, e] of cuts) {
      if (s > t) keep.push([t, s]);
      t = Math.max(t, e);
    }
    if (t < tk.duration) keep.push([t, tk.duration]);
    for (const [s, e] of keep) if (e - s >= 0.05) out.push({ take: ti, start: s, end: e });
  });
  if (!split || !part) return out;
  // split = {take, time}: part 1 is before it, part 2 after.
  const res = [];
  for (const r of out) {
    const before = r.take < split.take || (r.take === split.take && r.end <= split.time);
    const after = r.take > split.take || (r.take === split.take && r.start >= split.time);
    if (part === 1) {
      if (before) res.push(r);
      else if (!after) res.push({ ...r, end: split.time });
    } else {
      if (after) res.push(r);
      else if (!before) res.push({ ...r, start: split.time });
    }
  }
  return res;
}

export const total = (ranges) => ranges.reduce((s, r) => s + (r.end - r.start), 0);

// Suggest where to split: the end of a sentence, Part 1 under 30 sec, near the middle.
export function suggestSplit(items, takes) {
  const ranges = keptRanges(items, takes);
  const all = total(ranges);
  const keptBefore = (take, time) => ranges.reduce((s, r) => {
    if (r.take < take) return s + r.end - r.start;
    if (r.take === take && r.start < time) return s + Math.min(r.end, time) - r.start;
    return s;
  }, 0);
  const cands = [];
  items.forEach((it, i) => {
    if (it.type === 'gap' || it.cut) return;
    const next = items[i + 1];
    const sentence = it.type === 'word' && /[.?!]$/.test(it.text.trim());
    const pause = !next || next.type === 'gap' || next.take !== it.take;
    if (!sentence && !pause) return;
    const t = keptBefore(it.take, it.end);
    if (t <= 29.5 && t > 3) cands.push({ take: it.take, time: it.end, at: t, sentence });
  });
  if (!cands.length) return null;
  const target = Math.min(all / 2, 29.5);
  cands.sort((a, b) => (Math.abs(a.at - target) - (a.sentence ? 2 : 0)) - (Math.abs(b.at - target) - (b.sentence ? 2 : 0)));
  return { take: cands[0].take, time: cands[0].time };
}

// Kept words with their time in the finished reel (for captions).
export function outWords(items, takes, ranges) {
  const out = [];
  let acc = 0;
  const starts = ranges.map((r) => { const a = acc; acc += r.end - r.start; return a; });
  let prev = null; // last kept word, in its own take's time
  items.forEach((it, i) => {
    if (it.type !== 'word' || it.cut) return;
    const pause = !!prev && (prev.take !== it.take || it.start - prev.end > 0.45);
    const mid = (it.start + it.end) / 2;
    const k = ranges.findIndex((r) => r.take === it.take && mid >= r.start && mid <= r.end);
    if (k < 0) return;
    const r = ranges[k];
    out.push({
      i, text: it.fix || it.text, hl: !!it.hl, big: !!it.big, brk: !!it.brk, join: !!it.join, hide: !!it.hide, pause,
      s: starts[k] + Math.max(0, it.start - r.start),
      e: starts[k] + Math.min(r.end, it.end) - r.start,
    });
    prev = it;
  });
  return out;
}
