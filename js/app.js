import * as store from './store.js';
import { decodeClip, to16kMono, speechRuns, captureAudio } from './audio.js';
import { buildItems, markPauses, markRepeats, keptRanges, total, suggestSplit, outWords } from './clean.js';
import { renderReel, frameAt, pickMime, drawCover, W, H } from './export.js';
import { drawText, drawWords, chunks, ready, defaultText, FONTS, BRAND, MY_STYLE, loadFont, loadAllFonts } from './text.js';
import { loadSegmenter, drawPerson, segmenterFailed } from './segment.js';
import { BrollLayer, FRAMES, newBroll } from './broll.js';
import * as L from './library.js';
import { ASPECTS, cropRect, loadImages, drawSlide, cropTo, makeZip } from './photo.js';
import { STATUSES, typeClass, isReel, bracketCount, readXlsx, parseCsv, rowsToEntries, mergeImport, partWarnings } from './calendar.js';
import { PLATFORMS, RULES, rulesFor, defaultSettings, fmtTime, timesFor, buildCaptions, nextReelDay } from './post.js';
import { Compositor, MIRRORS, TRANSITIONS, GFX, GfxLayer, newGfx, joinKey, autoZoom } from './fx.js';
import { VisualTrack } from './visuals.js';

const $ = (s) => document.querySelector(s);
const panel = $('#panel'), preview = $('#preview');

const STEPS = [
  { n: 1, name: 'Plan' },
  { n: 2, name: 'Record' },
  { n: 3, name: 'Clean' },
  { n: 4, name: 'Edit' },
  { n: 5, name: 'Export' },
  { n: 6, name: 'Post' },
];

// ---------- state ----------
const blank = () => ({
  id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6), calId: null,
  title: '', hook: '', script: '',
  takes: [],            // {id, name, duration}
  items: [],            // clean results
  cleaned: false, transcript: false,
  pauseSec: 0.5, split: null,
  step: 1, prompter: true, prompterSpeed: 30, coverTime: null,
  mode: 'camera',       // 'camera' or 'voiceover'
  visuals: [],          // voice-over: {id, kind, name, sec}
  text: defaultText(),  // hook, captions, list
  broll: [],            // photos/clips over you
  effects: [],          // mirror effects {id, kind, start, dur}
  trans: { def: 'cut', dur: 0.3, joins: {} },
  gfx: [],              // graphics and stamps
  slides: [], aspect: '4:5', // photo / carousel posts
  splits: [],           // old split markers (replaced by clips)
  clips: [],            // main-line order: {take, start, end, vol?} source windows; empty = one clip per take
  postDate: '', caption: '', closer: 0, ytTitle: '', posted: {}, capEdits: {}, status: 'To record',
  scrub: 0,
});
const VO = () => P.mode === 'voiceover';
const PHOTO = () => P.mode === 'photo';
let P = blank();
const urls = {};        // take id -> object URL
let undoStack = [], redoStack = [];

const snap = () => JSON.stringify({ clips: P.clips, splits: P.splits, items: P.items, split: P.split, pauseSec: P.pauseSec, takes: P.takes, cleaned: P.cleaned, transcript: P.transcript, visuals: P.visuals, mode: P.mode, slides: P.slides, aspect: P.aspect, text: P.text, broll: P.broll, effects: P.effects, trans: P.trans, gfx: P.gfx });
function remember() { undoStack.push(snap()); if (undoStack.length > 100) undoStack.shift(); redoStack = []; syncUndo(); }
function restore(s) { Object.assign(P, JSON.parse(s)); save(); render(); }
$('#undo').onclick = () => { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); syncUndo(); };
$('#redo').onclick = () => { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); syncUndo(); };
function syncUndo() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  e.preventDefault(); (e.shiftKey ? $('#redo') : $('#undo')).click();
});

let saveTimer;
function save() {
  $('#saved').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await store.put('reel:' + P.id, P);
      await store.put('currentReel', P.id);
      reelIndex[P.id] = { id: P.id, title: P.title || P.hook || 'Untitled reel', postDate: P.postDate, status: P.status, calId: P.calId, updated: Date.now() };
      await store.put('reelIndex', reelIndex);
      const ce = CAL.entries.find((e) => e.id === P.calId);
      if (ce && STATUSES.indexOf(P.status) > STATUSES.indexOf(ce.status)) { ce.status = P.status; await saveCal(); }
      $('#saved').textContent = 'Saved';
    }
    catch { $('#saved').textContent = 'Not saved'; }
  }, 400);
}

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

const fmt = (s) => (Math.round(s * 10) / 10).toFixed(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tip = (t) => `<span class="tip" title="${esc(t)}">?</span>`;
const rawLen = () => P.takes.reduce((s, t) => s + t.duration, 0);
const cleanLen = () => (PHOTO() ? P.slides.length : total(fullRanges()));

function setTimer(sec) {
  $('#timerNum').textContent = fmt(sec);
  $('#timer').classList.toggle('over', sec >= 30);
}

// ---------- steps bar ----------
function renderSteps() {
  $('#steps').innerHTML = STEPS.map((s) =>
    `<button class="step ${s.n === P.step ? 'on' : s.n < P.step ? 'done' : ''}" data-n="${s.n}">${s.n} ${s.name}${s.soon ? ' <span class="soon">(soon)</span>' : ''}</button>`).join('');
  document.querySelectorAll('.step').forEach((b) => (b.onclick = () => go(+b.dataset.n)));
}
function go(n) { if (P.step === 2 && n !== 2) stopCamera(); P.step = n; save(); render(); }

function render() {
  renderSteps();
  (PHOTO() ? { 1: plan, 2: photoRecord, 3: photoClean, 4: edit, 5: photoExport, 6: post } : { 1: plan, 2: record, 3: clean, 4: edit, 5: exportStep, 6: post })[P.step]();
  if (P.step !== 2 || PHOTO()) repaint(); else if (!cam) { cv.classList.add('hidden'); }
  setTimer(cleanLen());
  if (PHOTO()) { $('#timerNum').textContent = P.slides.length; $('#timer').classList.remove('over'); $('#timer small').textContent = P.slides.length === 1 ? ' slide' : ' slides'; }
  else $('#timer small').textContent = ' sec';
  const g = $('#cropGuide'), r = cropRect(P.aspect);
  g.classList.toggle('hidden', !PHOTO() || P.aspect === '9:16');
  g.style.setProperty('--band', `${(100 * r.y) / H}%`);
}

// ---------- Start over ----------
$('#startOver').onclick = () => $('#overModal').classList.remove('hidden');
$('#overCancel').onclick = () => $('#overModal').classList.add('hidden');
$('#overModal').onclick = (e) => { if (e.target.id === 'overModal') $('#overModal').classList.add('hidden'); };
document.querySelectorAll('[data-over]').forEach((b) => (b.onclick = async () => {
  const kind = b.dataset.over;
  $('#overModal').classList.add('hidden');
  stopPlaying(); stopCamera();
  if (kind === 'clean') {
    if (!P.takes.length) { toast('Record a take first.'); return; }
    remember(); P.cleaned = false; P.items = []; P.split = null; P.step = 3; save(); render(); runClean();
  } else if (kind === 'edits') {
    remember();
    const keepHook = P.text.hook.text;
    P.text = defaultText(); P.text.hook.text = keepHook;
    P.broll = []; P.effects = []; P.gfx = []; P.splits = []; P.clips = []; P.trans = { def: 'cut', dur: 0.3, joins: {} };
    save(); render(); toast('Edits cleared. Undo brings them back.');
  } else if (kind === 'reel') {
    if (!confirm('Delete every take and edit for this reel? This can\'t be undone.')) return;
    for (const t of [...P.takes, ...P.visuals, ...P.broll, ...P.gfx, ...P.slides]) { await store.del('blob:' + t.id); if (t.audioId) await store.del('blob:' + t.audioId); if (t.imgId) await store.del('blob:' + t.imgId); }
    const keep = { id: P.id, calId: P.calId, title: P.title, hook: P.hook, script: P.script, postDate: P.postDate, mode: P.mode, caption: P.caption, closer: P.closer, ytTitle: P.ytTitle };
    P = Object.assign(blank(), keep, { step: 2, status: 'To record' });
    undoStack = []; redoStack = []; syncUndo(); previewTrack = null; preview.removeAttribute('src');
    const ce = CAL.entries.find((x) => x.id === P.calId); if (ce) { ce.status = 'To record'; await saveCal(); }
    save(); render(); toast('Fresh start. Your hook and script are still here.');
  }
}));

// ---------- Step 1: Plan ----------
let CAL = { entries: [] }, reelIndex = {};
let calView = 'month', calCursor = new Date().toISOString().slice(0, 10), calSel = null;
async function saveCal() { await store.put('calendar', CAL); }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const parseD = (s) => new Date(s + 'T12:00:00');
const hlBrackets = (t) => esc(t).replace(/\[[^\]]+\]/g, (m) => `<mark>${m}</mark>`);

function calendarHTML() {
  const cur = parseD(calCursor);
  let days = [];
  if (calView === 'month') {
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1, 12);
    const start = new Date(first); start.setDate(1 - first.getDay());
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    if (days.slice(35).every((d) => d.getMonth() !== cur.getMonth())) days = days.slice(0, 35);
  } else {
    const start = new Date(cur); start.setDate(cur.getDate() - cur.getDay());
    for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  }
  const warn = partWarnings(CAL.entries);
  const today = iso(new Date());
  const label = calView === 'month' ? cur.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : `Week of ${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  return `
  <div class="calbar">
    <button class="btn" id="calPrev">‹</button><b class="callabel">${label}</b><button class="btn" id="calNext">›</button>
    <button class="chip" id="calToday">Today</button>
    <span style="flex:1"></span>
    <button class="chip ${calView === 'month' ? 'on' : ''}" data-view="month">Month</button><button class="chip ${calView === 'week' ? 'on' : ''}" data-view="week">Week</button>
    <label class="btn" style="margin:0;cursor:pointer">⬆ Import calendar<input type="file" id="calImport" accept=".xlsx,.csv" hidden></label>
  </div>
  <div class="legend"><span class="dot reel"></span>Reel <span class="dot ad"></span>Ad or holiday Story <span class="dot reddit"></span>Reddit <span class="fill">3 to fill</span> = [brackets] left</div>
  <div class="cal ${calView}">
    ${DAYS.map((d) => `<div class="dow">${d}</div>`).join('')}
    ${days.map((d) => {
      const ds = iso(d), es = CAL.entries.filter((e) => e.date === ds);
      const out = calView === 'month' && d.getMonth() !== cur.getMonth();
      return `<div class="day ${out ? 'out' : ''} ${ds === today ? 'today' : ''}" data-day="${ds}">
        <div class="dnum">${d.getDate()}<button class="plus" data-addday="${ds}" title="Add a post">＋</button></div>
        ${es.map((e) => { const n = bracketCount(e.hook + ' ' + e.script); return `<div class="ev ${typeClass(e.type)} ${calSel === e.id ? 'sel' : ''}" draggable="true" data-ev="${e.id}" title="${esc(e.type)}: ${esc(e.topic)}">
          <span class="evt">${esc(e.topic || e.type)}</span>
          ${calView === 'week' && e.hook ? `<span class="evh">${esc(e.hook)}</span>` : ''}
          <span class="evs"><i class="st st-${e.status.replace(/\s/g, '')}">${e.status}</i>${n ? `<i class="fill">${n} to fill</i>` : ''}${warn[e.id] ? '<i class="warnp" title="' + esc(warn[e.id]) + '">⚠ Part 2</i>' : ''}</span></div>`; }).join('')}
      </div>`;
    }).join('')}
  </div>
  ${calSel ? entryHTML(CAL.entries.find((e) => e.id === calSel), warn) : CAL.entries.length ? '<p class="hint">Tap a post to see its hook and script, fill in your answers, or start the reel. Drag a post to move it to another day.</p>' : '<div class="note">Import your content calendar (.xlsx or .csv) to fill this in, or tap ＋ on a day to add a post.</div>'}`;
}

function entryHTML(e, warn) {
  if (!e) return '';
  const reel = e.reelId && reelIndex[e.reelId];
  return `<div class="card entry ${typeClass(e.type)}">
    <div class="card-h"><b class="big-l">${parseD(e.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</b>
      <span><select data-ef="status">${STATUSES.map((s) => `<option ${e.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="x" id="evDel" title="Delete this post">🗑</button><button class="x" id="evClose" title="Close">✕</button></span></div>
    ${warn[e.id] ? `<div class="note bad">⚠ ${esc(warn[e.id])}</div>` : ''}
    <div class="row"><label class="inline">Type <input type="text" class="short" data-ef="type" value="${esc(e.type)}"></label>
      <label class="inline">Date <input type="date" data-ef="date" value="${e.date}"></label></div>
    <label>Topic</label><input type="text" data-ef="topic" value="${esc(e.topic)}">
    <label>Hook</label><input type="text" data-ef="hook" value="${esc(e.hook)}">
    <label>Script ${bracketCount(e.script) ? `<span class="fill">${bracketCount(e.script)} to fill</span>` : ''}</label>
    ${bracketCount(e.script) ? `<div class="scriptview">${hlBrackets(e.script)}</div><p class="hint">Replace each yellow [bracket] with your real answer below.</p>` : ''}
    <textarea data-ef="script">${esc(e.script)}</textarea>
    ${e.where || e.times ? `<p class="hint"><b>Where:</b> ${esc(e.where)}${e.times ? ` · <b>Times:</b> ${esc(e.times)}` : ''}</p>` : ''}
    ${e.notes ? `<p class="hint"><b>Notes:</b> ${esc(e.notes)}</p>` : ''}
    ${isReel(e) ? `<div class="row">${reel ? `<button class="big" id="evOpen">Open this reel →</button><span class="sub">${esc(reel.status)}</span>` : `<button class="big" id="evStart">Start this reel →</button>`}</div>`
      : typeClass(e.type) === 'ad' ? `<div class="row">${reel ? `<button class="big" id="evOpen">Open this post →</button><span class="sub">${esc(reel.status)}</span>` : `<button class="big" id="evStartPhoto">Start this post (photo or carousel) →</button>`}</div>` : ''}
  </div>`;
}

function reelsHTML() {
  const list = Object.values(reelIndex).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return `<details class="more"><summary>My reels (${list.length})</summary>
    ${list.map((r) => `<div class="row reelrow ${r.id === P.id ? 'cur' : ''}"><b>${esc(r.title)}</b><span class="sub">${r.postDate || ''} · ${r.status || ''}</span>
      ${r.id === P.id ? '<span class="chip on">Open now</span>' : `<button class="chip" data-open="${r.id}">Open</button><button class="x" data-delreel="${r.id}" title="Delete reel">✕</button>`}</div>`).join('')}
  </details>`;
}

function plan() {
  panel.innerHTML = `
    <h1>Plan</h1>
    ${calendarHTML()}
    <h2 style="margin-top:28px">This reel${P.calId ? ' <span class="sub">(from your calendar)</span>' : ''}</h2>
    <label>How will this reel look?</label>
    <div class="modes">
      <button class="mode ${!VO() ? 'on' : ''}" data-mode="camera"><b>🎥 Me on camera</b><span>You talk to the camera.</span></button>
      <button class="mode ${VO() ? 'on' : ''}" data-mode="voiceover"><b>🎙 Voice-over</b><span>You talk; photos, clips or screen recordings play on screen.</span></button>
      <button class="mode ${PHOTO() ? 'on' : ''}" data-mode="photo"><b>🖼 Photo or carousel</b><span>Pictures with text, stamps and your logo. For a post, a carousel or an ad.</span></button>
    </div>
    <label>Reel name ${tip('Just for you, so you can find it later.')}</label>
    <input type="text" id="title" placeholder="e.g. The moment at NASPGHAN" value="${esc(P.title)}">
    <label>Hook (first 1–2 seconds)</label>
    <input type="text" id="hook" placeholder="e.g. I noticed one pattern I couldn't unsee" value="${esc(P.hook)}">
    <label>Script ${tip('This scrolls on screen while you record, if you want it to.')} ${bracketCount(P.script) ? `<span class="fill">${bracketCount(P.script)} to fill</span>` : ''}</label>
    <textarea id="script" placeholder="Paste your script here">${esc(P.script)}</textarea>
    ${reelsHTML()}
    <div class="next"><button class="btn" id="newReel">Start a new reel</button>
      <button class="big" id="go2">Next: Record →</button></div>`;
  ['title', 'hook', 'script'].forEach((k) => ($('#' + k).oninput = (e) => {
    P[k] = e.target.value; save();
    const ce = CAL.entries.find((x) => x.id === P.calId);
    if (ce && k !== 'title') { ce[k] = P[k]; ce.edited = { ...(ce.edited || {}), [k]: true }; saveCal(); }
  }));
  $('#go2').onclick = () => go(2);
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { remember(); P.mode = b.dataset.mode; save(); render(); }));
  $('#newReel').onclick = () => newReel();
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openReel(b.dataset.open)));
  document.querySelectorAll('[data-delreel]').forEach((b) => (b.onclick = async () => {
    const r = reelIndex[b.dataset.delreel];
    if (!confirm(`Delete "${r.title}" and its recordings? This can't be undone.`)) return;
    const old = await store.get('reel:' + r.id);
    if (old) for (const t of [...old.takes, ...old.visuals, ...old.broll, ...(old.gfx || []), ...(old.slides || [])]) { await store.del('blob:' + t.id); if (t.audioId) await store.del('blob:' + t.audioId); if (t.imgId) await store.del('blob:' + t.imgId); }
    await store.del('reel:' + r.id); delete reelIndex[r.id]; await store.put('reelIndex', reelIndex);
    const ce = CAL.entries.find((x) => x.reelId === r.id); if (ce) { ce.reelId = null; await saveCal(); }
    render();
  }));
  calendarBind();
}

function calendarBind() {
  const move = (n) => { const d = parseD(calCursor); calView === 'month' ? d.setMonth(d.getMonth() + n) : d.setDate(d.getDate() + 7 * n); calCursor = iso(d); render(); };
  $('#calPrev').onclick = () => move(-1);
  $('#calNext').onclick = () => move(1);
  $('#calToday').onclick = () => { calCursor = iso(new Date()); render(); };
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { calView = b.dataset.view; render(); }));
  $('#calImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const rows = /\.csv$/i.test(f.name) ? parseCsv(await f.text()) : await readXlsx(f);
      const incoming = rowsToEntries(rows);
      if (!incoming.length) { toast('No dated rows found in that file.'); return; }
      const had = CAL.entries.length;
      CAL.entries = mergeImport(CAL.entries, incoming);
      await saveCal();
      for (const ce of CAL.entries.filter((x) => x.reelId)) { // keep linked reels on the same date
        if (ce.reelId === P.id) { P.postDate = ce.date; save(); continue; }
        const r = await store.get('reel:' + ce.reelId);
        if (r && r.postDate !== ce.date) { r.postDate = ce.date; await store.put('reel:' + r.id, r); }
      }
      calCursor = incoming[0].date; calView = 'month';
      toast(had ? `Updated ${incoming.length} posts from your calendar. Your reels, progress and anything you typed here were kept.` : `Imported ${incoming.length} posts.`);
      render();
    } catch (err) { toast('Couldn\'t read that file: ' + err.message, 6000); }
  };
  document.querySelectorAll('[data-ev]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); calSel = calSel === el.dataset.ev ? null : el.dataset.ev; render(); };
    el.ondragstart = (ev) => ev.dataTransfer.setData('text/plain', el.dataset.ev);
  });
  document.querySelectorAll('[data-day]').forEach((d) => {
    d.ondragover = (ev) => { ev.preventDefault(); d.classList.add('over'); };
    d.ondragleave = () => d.classList.remove('over');
    d.ondrop = async (ev) => {
      ev.preventDefault(); d.classList.remove('over');
      const e = CAL.entries.find((x) => x.id === ev.dataTransfer.getData('text/plain'));
      if (!e || e.date === d.dataset.day) return;
      e.date = d.dataset.day; await saveCal();
      const w = partWarnings(CAL.entries);
      if (w[e.id]) toast('⚠ ' + w[e.id], 6000);
      if (e.reelId) { const r = await store.get('reel:' + e.reelId); if (r) { r.postDate = e.date; await store.put('reel:' + r.id, r); if (r.id === P.id) P.postDate = e.date; } }
      render();
    };
  });
  document.querySelectorAll('[data-addday]').forEach((b) => (b.onclick = async (ev) => {
    ev.stopPropagation();
    const e = { id: 'c' + Math.random().toString(36).slice(2, 9), date: b.dataset.addday, type: 'Story reel', topic: '', hook: '', script: '', where: '', times: '', notes: '', status: 'To record', reelId: null, manual: true };
    CAL.entries.push(e); CAL.entries.sort((a, c) => a.date.localeCompare(c.date)); calSel = e.id; await saveCal(); render();
  }));
  const sel = CAL.entries.find((x) => x.id === calSel);
  if (!sel) return;
  document.querySelectorAll('[data-ef]').forEach((el) => {
    const k = el.dataset.ef;
    const set = async () => {
      sel[k] = el.value; if (['topic', 'hook', 'script', 'type'].includes(k)) sel.edited = { ...(sel.edited || {}), [k]: true }; await saveCal();
      if (sel.reelId === P.id && ['hook', 'script'].includes(k)) { P[k] = el.value; save(); }
      else if (sel.reelId && ['hook', 'script', 'date'].includes(k)) { const r = await store.get('reel:' + sel.reelId); if (r) { r[k === 'date' ? 'postDate' : k] = el.value; await store.put('reel:' + r.id, r); } }
    };
    el.oninput = set;
    el.onchange = async () => { await set(); if (['status', 'date', 'type', 'topic', 'script'].includes(k)) render(); };
  });
  $('#evClose').onclick = () => { calSel = null; render(); };
  $('#evDel').onclick = async () => { if (!confirm('Delete this post from the calendar? Its reel (if any) is kept.')) return; CAL.entries = CAL.entries.filter((x) => x.id !== sel.id); calSel = null; await saveCal(); render(); };
  if ($('#evStart')) $('#evStart').onclick = async () => {
    await newReel({ title: sel.topic, hook: sel.hook, script: sel.script, postDate: sel.date, calId: sel.id }, true);
    sel.reelId = P.id; await saveCal(); go(2);
  };
  if ($('#evOpen')) $('#evOpen').onclick = () => openReel(sel.reelId, 2);
  if ($('#evStartPhoto')) $('#evStartPhoto').onclick = async () => {
    await newReel({ title: sel.topic, hook: '', script: '', postDate: sel.date, calId: sel.id, mode: 'photo' }, true);
    sel.reelId = P.id; await saveCal(); go(2);
  };
}

// ---------- reels ----------
function hydrate(saved) {
  const p = Object.assign(blank(), saved);
  const d = defaultText(), t = saved.text || {};
  p.text = { hook: { ...d.hook, ...t.hook, style: { ...d.hook.style, ...(t.hook || {}).style } },
    caps: { ...d.caps, ...t.caps, style: { ...d.caps.style, ...(t.caps || {}).style } },
    list: { ...d.list, ...t.list, style: { ...d.list.style, ...(t.list || {}).style } },
    typed: { ...d.typed, ...t.typed, style: { ...d.typed.style, ...(t.typed || {}).style } } };
  p.trans = { def: 'cut', dur: 0.3, joins: {}, ...p.trans };
  return p;
}
async function loadUrls() {
  for (const t of [...P.takes, ...P.visuals, ...P.broll, ...P.slides, ...P.gfx.filter((x) => x.type === 'png')]) {
    if (urls[t.id]) continue;
    const b = await store.get('blob:' + t.id);
    if (b) urls[t.id] = URL.createObjectURL(b);
  }
  P.takes = P.takes.filter((t) => urls[t.id]);
  P.visuals = P.visuals.filter((v) => urls[v.id]);
  P.broll = P.broll.filter((b) => urls[b.id]);
}
async function flushSave() { clearTimeout(saveTimer); await store.put('reel:' + P.id, P); }
async function openReel(id, step) {
  stopCamera(); stopPlaying();
  await flushSave();
  const saved = await store.get('reel:' + id); if (!saved) return;
  P = hydrate(saved); await loadUrls();
  undoStack = []; redoStack = []; syncUndo();
  previewTrack = null; preview.removeAttribute('src');
  if (step) P.step = step;
  save(); render();
}
async function newReel(fields = {}, quiet = false) {
  stopCamera(); stopPlaying();
  if (P.takes.length || P.title || P.script) await flushSave();
  P = Object.assign(blank(), fields);
  P.text.hook.text = '';
  undoStack = []; redoStack = []; syncUndo(); previewTrack = null; preview.removeAttribute('src');
  save(); if (!quiet) { P.step = 1; render(); toast('New reel started. Your other reels are under "My reels".'); }
}

// ---------- Step 2: Record ----------
let cam = null, recorder = null, recChunks = [], scrollRAF = null;

function record() {
  panel.innerHTML = `
    <h1>${VO() ? 'Record your voice' : 'Record'}</h1>
    <p class="sub">${VO() ? 'Just talk. Stumble, pause, repeat a line, it\'s fine. Step 3 cleans it up. Then add what plays on screen below.' : 'Talk to the camera. Stumble, pause, repeat a line, it\'s fine. Step 3 cleans it up. Record as many takes as you want.'}</p>
    <div class="row">
      <button class="big" id="camBtn">${cam ? '● Start recording' : VO() ? 'Turn on mic' : 'Turn on camera'}</button>
      <label class="btn" style="margin:22px 0 0">⬆ Upload ${VO() ? 'voice (audio or video)' : 'from phone'}
        <input type="file" id="upload" accept="${VO() ? 'audio/*,video/*,.mov,.m4a' : 'video/*,.mov,.MOV,.mp4'}" multiple hidden></label>
    </div>
    <details class="more"><summary>More options</summary>
      <label><input type="checkbox" id="pOn" ${P.prompter ? 'checked' : ''}> Scroll my script while I record</label>
      <label>Scroll speed ${tip('Pixels per second. Slower if you read slowly.')}</label>
      <input type="range" id="pSpeed" min="10" max="80" value="${P.prompterSpeed}">
    </details>
    <h3 style="margin-top:26px">${VO() ? 'Voice takes' : 'Takes'} (${P.takes.length})</h3>
    <ul class="takes">${P.takes.map((t, i) => `<li><b>Take ${i + 1}</b><span>${fmt(t.duration)} sec</span>
      <button class="btn" data-play="${i}">▶</button>
      <button class="x" data-tup="${i}" title="Move earlier" ${i === 0 ? 'disabled' : ''}>↑</button><button class="x" data-tdn="${i}" title="Move later" ${i === P.takes.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="x" data-del="${i}" title="Remove this take">✕</button></li>`).join('') || '<li>No takes yet.</li>'}</ul>
    ${VO() ? `<h3 style="margin-top:26px">What plays on screen (${P.visuals.length}) ${tip('Photos, clips or screen recordings. They play in this order. Leave seconds blank to share the time evenly.')}</h3>
      <label class="btn" style="display:inline-block;margin:0">＋ Add photos, clips or screen recordings
        <input type="file" id="addVis" accept="image/*,video/*,.mov,.MOV,.heic" multiple hidden></label>
      <ul class="takes vis">${P.visuals.map((v, i) => `<li>${v.kind === 'image' ? `<img src="${urls[v.id]}">` : `<video src="${urls[v.id]}#t=0.5" muted></video>`}
        <b>${esc(v.name)}</b>
        <input type="number" min="0.5" step="0.5" placeholder="auto" value="${v.sec || ''}" data-sec="${i}" title="Seconds on screen (blank = auto)"> sec
        <button class="x" data-up="${i}" title="Move up">↑</button><button class="x" data-dn="${i}" title="Move down">↓</button>
        <button class="x" data-vdel="${i}" title="Remove">✕</button></li>`).join('') || '<li>Nothing added yet.</li>'}</ul>` : ''}
    <div class="next"><span></span><button class="big" id="go3" ${P.takes.length ? '' : 'disabled'}>Next: Clean it up →</button></div>`;
  if (VO()) {
    $('#addVis').onchange = async (e) => { for (const f of e.target.files) await addVisual(f); render(); };
    document.querySelectorAll('[data-sec]').forEach((el) => (el.onchange = () => { remember(); P.visuals[+el.dataset.sec].sec = +el.value || null; save(); render(); }));
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= P.visuals.length) return; remember(); [P.visuals[i], P.visuals[j]] = [P.visuals[j], P.visuals[i]]; save(); render(); };
    document.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => move(+b.dataset.up, -1)));
    document.querySelectorAll('[data-dn]').forEach((b) => (b.onclick = () => move(+b.dataset.dn, 1)));
    document.querySelectorAll('[data-vdel]').forEach((b) => (b.onclick = () => { remember(); P.visuals.splice(+b.dataset.vdel, 1); save(); render(); }));
  }

  $('#camBtn').onclick = async () => {
    if (!cam) { await startCamera(); render(); return; }
    if (recorder && recorder.state === 'recording') stopRecording(); else startRecording();
  };
  $('#upload').onchange = async (e) => { for (const f of e.target.files) await addTake(f, f.name); render(); };
  $('#pOn').onchange = (e) => { P.prompter = e.target.checked; save(); };
  $('#pSpeed').oninput = (e) => { P.prompterSpeed = +e.target.value; save(); };
  $('#go3').onclick = () => go(3);
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const t = P.takes[+b.dataset.del];
    remember();
    P.takes.splice(+b.dataset.del, 1);
    P.cleaned = false; P.items = []; P.split = null; P.clips = [];
    save(); render();
    toast(`Removed. Undo to bring Take ${+b.dataset.del + 1} back.`);
    void t;
  }));
  document.querySelectorAll('[data-tup]').forEach((b) => (b.onclick = () => moveTake(+b.dataset.tup, -1)));
  document.querySelectorAll('[data-tdn]').forEach((b) => (b.onclick = () => moveTake(+b.dataset.tdn, 1)));
  document.querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => {
    stopCamera(); const t = P.takes[+b.dataset.play];
    preview.classList.remove('mirror'); preview.srcObject = null; preview.muted = false;
    preview.src = urls[t.id]; $('#emptyPreview').classList.add('hidden'); preview.play();
  }));
  if (cam) attachCamera();
}

async function startCamera() {
  try {
    cam = await navigator.mediaDevices.getUserMedia({
      video: VO() ? false : { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) { toast(VO() ? 'Mic blocked. Allow the microphone in Chrome, then try again.' : 'Camera blocked. Allow camera and mic in Chrome, then try again.'); }
}
function attachCamera() {
  if (VO()) { $('#emptyPreview').textContent = '🎙 Mic is on'; $('#emptyPreview').classList.remove('hidden'); $('#vcanvas').classList.add('hidden'); return; }
  preview.src = ''; preview.srcObject = cam; preview.muted = true; preview.classList.add('mirror');
  $('#emptyPreview').classList.add('hidden'); preview.play();
}
function stopCamera() {
  if (recorder && recorder.state === 'recording') stopRecording();
  if (cam) cam.getTracks().forEach((t) => t.stop());
  cam = null; preview.srcObject = null; preview.classList.remove('mirror');
  stopPrompter();
}
function startRecording() {
  const left = bracketCount(P.hook + ' ' + P.script);
  if (P.prompter && left && !confirm(`Your script still has ${left} [bracket${left > 1 ? 's' : ''}] to fill in. Record anyway?`)) return;
  const mime = VO() ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) : pickMime();
  recorder = new MediaRecorder(cam, mime ? (VO() ? { mimeType: mime } : { mimeType: mime, videoBitsPerSecond: 12_000_000 }) : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: (recorder.mimeType || 'video/webm').split(';')[0] });
    await addTake(blob, `Take ${P.takes.length + 1}`);
    $('#recDot').classList.add('hidden'); stopPrompter(); render();
  };
  recorder.start(500);
  const t0 = performance.now();
  const tick = () => { if (recorder.state !== 'recording') return; setTimer((performance.now() - t0) / 1000); requestAnimationFrame(tick); };
  tick();
  $('#recDot').classList.remove('hidden');
  $('#camBtn').textContent = '■ Stop';
  $('#camBtn').classList.add('red');
  if (P.prompter && P.script.trim()) startPrompter();
}
function stopRecording() { recorder.stop(); }
function startPrompter() {
  const box = $('#prompter'), txt = $('#prompterText');
  txt.textContent = (P.hook ? P.hook + '\n\n' : '') + P.script;
  txt.style.whiteSpace = 'pre-wrap';
  box.classList.remove('hidden');
  let y = -40, last = performance.now(); const t0 = last;
  const step = (now) => {
    if (now - t0 > 1500) y += (now - last) / 1000 * P.prompterSpeed;
    last = now;
    txt.style.transform = `translateY(${-y}px)`;
    scrollRAF = requestAnimationFrame(step);
  };
  scrollRAF = requestAnimationFrame(step);
}
function stopPrompter() { cancelAnimationFrame(scrollRAF); $('#prompter').classList.add('hidden'); }

// Swap two takes and keep the cleanup, split and per-cut transitions pointing at the right take.
function moveTake(i, d) {
  const j = i + d;
  if (j < 0 || j >= P.takes.length) return;
  remember();
  [P.takes[i], P.takes[j]] = [P.takes[j], P.takes[i]];
  const sw = (t) => (t === i ? j : t === j ? i : t);
  for (const it of P.items) it.take = sw(it.take);
  P.items.sort((a, b) => a.take - b.take || a.start - b.start);
  if (P.split) P.split = { ...P.split, take: sw(P.split.take) };
  for (const c of P.clips || []) c.take = sw(c.take);
  const joins = {};
  for (const [k, v] of Object.entries(P.trans.joins || {})) { const [t, st] = k.split(':'); joins[`${sw(+t)}:${st}`] = v; }
  P.trans.joins = joins;
  save(); render();
  toast(`Moved. Take ${j + 1} is now "${P.takes[j].name}". B-roll, mirror and graphics stay at the same seconds, so check them in Edit.`, 5000);
}

async function addTake(blob, name, keepClean = false) {
  let duration = 0, audioId = null;
  const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
  try { if (window.__FORCE_CAPTURE) throw new Error('test'); duration = (await decodeClip(blob)).duration; }
  catch {
    // Plan B for phone videos Chrome can't read directly: play it once and record the sound.
    try {
      toast(`Getting the sound out of ${name}. This plays it once (silently), so it takes as long as the clip…`, 600000);
      const { audio, duration: d } = await captureAudio(blob, (p) => { $('#toast').textContent = `Getting the sound out of ${name}… ${Math.round(p * 100)}%`; });
      await decodeClip(audio);
      audioId = id + 'a'; duration = d;
      await store.put('blob:' + audioId, audio);
      toast(`Got it. ${name} is ready.`);
    } catch (err) {
      toast(`Chrome can't open ${name} (${err.message}). On your Mac: open it in QuickTime, choose File → Export As → 1080p, and upload that copy. Or set your iPhone to Settings → Camera → Formats → Most Compatible.`, 15000);
      return;
    }
  }
  await store.put('blob:' + id, blob);
  urls[id] = URL.createObjectURL(blob);
  remember();
  P.takes.push(audioId ? { id, name, duration, audioId } : { id, name, duration });
  if (P.status === 'To record') P.status = 'Recorded';
  if (!keepClean) { P.cleaned = false; P.items = []; P.split = null; }
  if (P.clips && P.clips.length) P.clips.push({ take: P.takes.length - 1, start: 0, end: duration });
  save();
  return true;
}

// ---------- Photos on the main line ----------
// A photo becomes a short silent clip (slow push-in), so Clean, transitions, preview and export treat it like any take.
async function photoClip(imgBlob, sec) {
  const img = new Image(); img.src = URL.createObjectURL(imgBlob); await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  const ac = new AudioContext(); await ac.resume();
  const dest = ac.createMediaStreamDestination(), src = ac.createConstantSource(), g = ac.createGain();
  g.gain.value = 0; src.connect(g).connect(dest); src.start(); // silent track so every clip has sound
  const mime = pickMime();
  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const parts = []; rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  const draw = (p) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * (1 + 0.06 * p);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  };
  draw(0); rec.start(100);
  const t0 = performance.now();
  await new Promise((res) => { const tick = () => { const el = (performance.now() - t0) / 1000; draw(Math.min(1, el / sec)); if (el >= sec + 0.1) res(); else setTimeout(tick, 33); }; tick(); });
  rec.stop(); await stopped;
  stream.getTracks().forEach((t) => t.stop()); ac.close(); URL.revokeObjectURL(img.src);
  return new Blob(parts, { type: mime.split(';')[0] });
}
async function addPhotoTake(file, sec = 3) {
  if (/\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type)) file = await heicToJpeg(file);
  toast(`Adding ${file.name}…`, 60000);
  const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6), imgId = id + 'i';
  const blob = await photoClip(file, sec);
  await store.put('blob:' + imgId, file); await store.put('blob:' + id, blob);
  urls[id] = URL.createObjectURL(blob);
  remember();
  P.takes.push({ id, name: file.name, duration: sec, kind: 'image', imgId, vol: 1 });
  if (P.clips && P.clips.length) P.clips.push({ take: P.takes.length - 1, start: 0, end: sec });
  if (P.cleaned) P.items.push({ type: 'visual', take: P.takes.length - 1, start: 0, end: sec, cut: false, reason: '' });
  save(); toast(`Added ${file.name}.`);
}
async function setPhotoSec(i, sec) {
  const tk = P.takes[i]; if (!tk || tk.kind !== 'image') return;
  sec = Math.min(15, Math.max(0.5, +sec || 3));
  toast('Updating the photo…', 60000);
  const blob = await photoClip(await store.get('blob:' + tk.imgId), sec);
  await store.put('blob:' + tk.id, blob);
  if (urls[tk.id]) URL.revokeObjectURL(urls[tk.id]);
  urls[tk.id] = URL.createObjectURL(blob);
  remember();
  tk.duration = sec;
  for (const c of P.clips || []) if (c.take === i) { c.start = 0; c.end = sec; }
  P.items = P.items.filter((it) => it.take !== i || it.type === 'visual');
  P.items.forEach((it) => { if (it.take === i) it.end = sec; });
  save(); render(); toast(`Photo shows for ${sec} sec.`);
}
// Remove one clip from the main line, keeping the cleanup of the others.
function removeTake(i) {
  if (!P.takes[i]) return;
  remember();
  P.takes.splice(i, 1);
  P.items = P.items.filter((it) => it.take !== i).map((it) => (it.take > i ? { ...it, take: it.take - 1 } : it));
  if (P.split) P.split = P.split.take === i ? null : P.split.take > i ? { ...P.split, take: P.split.take - 1 } : P.split;
  P.clips = (P.clips || []).filter((c) => c.take !== i).map((c) => (c.take > i ? { ...c, take: c.take - 1 } : c));
  const joins = {};
  for (const [k, v] of Object.entries(P.trans.joins || {})) { const [t, st] = k.split(':'); if (+t !== i) joins[`${+t > i ? +t - 1 : +t}:${st}`] = v; }
  P.trans.joins = joins;
  if (!P.takes.length) { P.cleaned = false; P.items = []; }
  save(); render();
  toast('Removed. Undo brings it back. B-roll, mirror and graphics stay at the same seconds, so check them.', 5000);
}


async function addVisual(file) {
  const kind = file.type.startsWith('image/') ? 'image' : 'video';
  const id = 'v' + Date.now() + Math.random().toString(36).slice(2, 6);
  await store.put('blob:' + id, file);
  urls[id] = URL.createObjectURL(file);
  remember();
  P.visuals.push({ id, kind, name: file.name, sec: null });
  save();
}

// Clips: the main line's order. Each clip is a window of one take; a split cuts one clip into two.
const clipList = () => (P.clips && P.clips.length ? P.clips : P.takes.map((t, i) => ({ take: i, start: 0, end: t.duration })));
function ensureClips() { if (!P.clips || !P.clips.length) P.clips = clipList().map((c) => ({ ...c })); return P.clips; }
// Kept ranges (after Clean) laid out in clip order, each tagged with its clip and volume.
const fullRanges = () => {
  const base = P.cleaned ? keptRanges(P.items, P.takes) : P.takes.map((t, i) => ({ take: i, start: 0, end: t.duration }));
  const out = [];
  clipList().forEach((c, ci) => {
    const tk = P.takes[c.take]; if (!tk) return;
    const vol = c.vol ?? tk.vol ?? 1;
    for (const r of base) {
      if (r.take !== c.take) continue;
      const a = Math.max(r.start, c.start), b = Math.min(r.end, c.end);
      if (b - a >= 0.05) out.push({ take: r.take, start: a, end: b, ci, vol });
    }
  });
  return out;
};
// Part 1 / Part 2 (Clean's split at the end of a sentence), cut by reel time so reordered clips still work.
function partRanges(part) {
  const full = fullRanges();
  if (!P.split || !part) return full;
  let acc = 0, at = null;
  for (const r of full) {
    if (r.take === P.split.take && P.split.time >= r.start - 0.01 && P.split.time <= r.end + 0.01) { at = acc + Math.max(0, P.split.time - r.start); break; }
    acc += r.end - r.start;
  }
  if (at == null) return part === 1 ? full : [];
  const res = []; acc = 0;
  for (const r of full) {
    const a = acc, b = acc + (r.end - r.start); acc = b;
    if (part === 1) { if (b <= at) res.push(r); else if (a < at) res.push({ ...r, end: r.start + (at - a) }); }
    else { if (a >= at) res.push(r); else if (b > at) res.push({ ...r, start: r.start + (at - a) }); }
  }
  return res.filter((r) => r.end - r.start >= 0.05);
}
const makeTrack = () => new VisualTrack(P.visuals, (id) => urls[id], total(fullRanges()));

// ---------- preview (canvas: video + text, exactly like the export) ----------
const cv = $('#vcanvas'), cx = cv.getContext('2d');
let previewTrack = null, previewTrackKey = '';
async function getTrack() {
  const key = JSON.stringify([P.visuals, total(fullRanges())]);
  if (!previewTrack || key !== previewTrackKey) { previewTrack = makeTrack(); previewTrackKey = key; await previewTrack.load(); }
  return previewTrack;
}
function loadSrc(u) {
  if (preview.src === u) return Promise.resolve();
  preview.srcObject = null; preview.classList.remove('mirror'); preview.muted = false; preview.preload = 'auto';
  preview.src = u;
  return new Promise((res) => preview.addEventListener('loadeddata', res, { once: true }));
}
function seekTo(t) {
  if (Math.abs(preview.currentTime - t) < 0.01) return Promise.resolve();
  return new Promise((res) => { preview.addEventListener('seeked', res, { once: true }); preview.currentTime = t; });
}
// Find the take and source time for a reel time.
function locate(t, ranges) {
  let acc = 0;
  for (const r of ranges) { const d = r.end - r.start; if (t < acc + d) return { take: r.take, src: r.start + (t - acc) }; acc += d; }
  const r = ranges[ranges.length - 1];
  return r ? { take: r.take, src: Math.max(r.start, r.end - 0.04) } : null;
}
let stillBusy = false, stillAgain = null, _still = null;
const stillCanvas = () => { if (!_still) { _still = document.createElement('canvas'); _still.width = W; _still.height = H; } return _still; };
async function stillAt(t) {
  if (playing) return;
  if (stillBusy) { stillAgain = t; return; }
  stillBusy = true;
  try {
    if (PHOTO()) {
      if (!P.slides.length) { cv.classList.add('hidden'); $('#emptyPreview').classList.remove('hidden'); return; }
      $('#emptyPreview').classList.add('hidden'); cv.classList.remove('hidden');
      await paintSlide(cx, Math.floor(t));
      return;
    }
    const ranges = fullRanges();
    if (!P.takes.length || !ranges.length) { cv.classList.add('hidden'); $('#emptyPreview').classList.remove('hidden'); return; }
    $('#emptyPreview').classList.add('hidden'); cv.classList.remove('hidden');
    const ov = await makeOverlay(0);
    const comp = makeComp(0, ranges, true);
    if (VO()) {
      const vc = stillCanvas(); const vx = vc.getContext('2d');
      vx.fillStyle = '#000'; vx.fillRect(0, 0, W, H);
      if (P.visuals.length) await (await getTrack()).still(vx, t);
      await ov.prepare(t);
      comp.frame(cx, (c) => c.drawImage(vc, 0, 0), t, 0, 1);
      ov(cx, t, null);
    } else {
      const loc = locate(t, ranges);
      await loadSrc(urls[P.takes[loc.take].id]);
      await seekTo(loc.src);
      await ov.prepare(t);
      comp.frame(cx, (c) => drawCover(c, preview), t, 0, 1);
      ov(cx, t, preview);
    }
  } finally {
    stillBusy = false;
    if (stillAgain != null) { const n = stillAgain; stillAgain = null; stillAt(n); }
  }
}
let paintRAF = 0;
function repaint() { cancelAnimationFrame(paintRAF); paintRAF = requestAnimationFrame(() => stillAt(P.scrub || 0)); }

// Builds the text drawer for the whole reel (part 0) or one part (1 or 2).
async function makeOverlay(part) {
  const T = JSON.parse(JSON.stringify(P.text));
  if (!T.hook.text) T.hook.text = P.hook;
  if (PHOTO()) T.hook.dur = 1; // the hook sits on slide 1
  const ranges = partRanges(part);
  T.caps.chunks = !PHOTO() && P.cleaned && P.transcript ? chunks(outWords(P.items, P.takes, ranges), T.caps.n) : null;
  await Promise.all([ready(T.hook.style), ready(T.caps.style), ready(T.list.style), ready(T.typed.style)]);
  const behind = { hook: T.hook.on && T.hook.behind, caps: T.caps.on && T.caps.behind, list: T.list.on && T.list.behind };
  const anyBehind = !VO() && (behind.hook || behind.caps || behind.list);
  if (anyBehind) await loadSegmenter();
  // B-roll times are on the whole reel; Part 2 starts after Part 1.
  const off = part === 2 ? total(partRanges(1)) : 0;
  const br = new BrollLayer(P.broll, (id) => urls[id]);
  await br.load();
  const front = { hook: !behind.hook, caps: !behind.caps, list: !behind.list };
  const gl = new GfxLayer(P.gfx, (id) => urls[id], 'assets/healthquest-logo.png');
  await gl.load();
  const LG = { ...defaultSettings().logo, ...(S.logo || {}) };
  let logoImg = null;
  if (LG.on && P.logoOn !== false) { logoImg = new Image(); logoImg.src = 'assets/healthquest-logo.png'; await logoImg.decode().catch(() => {}); }
  const mirrored = (ft) => P.effects.some((e) => ft >= e.start && ft < e.start + e.dur);
  const fn = (ctx, t, src, running = false) => {
    const ft = t + off;
    if (br.coversFull(ft)) { br.draw(ctx, ft, running); drawText(ctx, T, t, undefined, part); }
    else if (anyBehind && src && !mirrored(ft) && !segmenterFailed()) {
      drawText(ctx, T, t, behind, part);
      drawPerson(ctx, src);
      br.draw(ctx, ft, running);
      drawText(ctx, T, t, front, part);
    } else {
      br.draw(ctx, ft, running);
      drawText(ctx, T, t, undefined, part);
    }
    if (PHOTO()) { // text you typed for this slide
      const sl = P.slides[Math.floor(t)];
      if (sl && sl.text) drawWords(ctx, T.caps.style, sl.text.split(/\s+/).filter(Boolean).map((w) => ({ text: w.replace(/^\*|\*$/g, ''), hl: /^\*.*\*$/.test(w) })), W * T.caps.x, H * T.caps.y);
    }
    gl.draw(ctx, ft);
    if (logoImg && logoImg.naturalWidth) { // the logo on every reel
      const w = W * LG.size, h = (w * logoImg.naturalHeight) / logoImg.naturalWidth, m = W * 0.04;
      const x = LG.corner.includes('l') ? m : W - w - m;
      const y = LG.corner.includes('t') ? H * 0.07 : H - h - H * 0.12; // clear of the top bar and the caption area
      ctx.save(); ctx.globalAlpha = LG.opacity; ctx.drawImage(logoImg, x, y, w, h); ctx.restore();
    }
  };
  fn.prepare = (t) => br.prepare(t + off);
  fn.pause = () => br.pauseAll();
  fn.audioEls = () => br.audioEls();
  return fn;
}

let playing = null;
function playLabel(on) { $('#playClean').textContent = on ? '■ Stop' : '▶ Play'; const b = $('#tlPlay'); if (b) b.textContent = on ? '■' : '▶'; }
function stopPlaying() { if (playing) { playing.stop = true; preview.pause(); if (previewTrack) previewTrack.pauseAll(); playing = null; playLabel(false); } }
// Preview sound goes through a gain so a take can play louder than 100%.
let pac = null, pgain = null;
function previewGain(v) {
  try {
    if (!pac) { pac = new AudioContext(); pgain = pac.createGain(); pac.createMediaElementSource(preview).connect(pgain).connect(pac.destination); }
    pac.resume(); pgain.gain.value = v;
  } catch { preview.volume = Math.min(1, v); }
}
// Moves the timeline playhead while playing (Edit step).
function followPlayhead(t, len) {
  const ph = $('#playhead'); if (!ph) return;
  ph.style.left = (100 * Math.min(t, len)) / Math.max(len, 0.01) + '%';
  const v = $('#scrubV'); if (v) v.textContent = fmt(t);
  const sl = $('#scrub'); if (sl) sl.value = t;
}
$('#playClean').onclick = () => (PHOTO() ? toast('Photo posts have no playback. Use the slider in Edit to see each slide.') : playing ? stopPlaying() : play(0));
// Plays the kept parts with everything on top, from startT for up to maxDur seconds.
async function play(startT = 0, maxDur = Infinity) {
  stopPlaying();
  if (!P.takes.length) return;
  stopCamera();
  const ranges = fullRanges();
  const ov = await makeOverlay(0);
  const comp = makeComp(0, ranges);
  const track = VO() && P.visuals.length ? await getTrack() : null;
  const run = { stop: false }; playing = run; playLabel(true);
  const reelT = total(ranges);
  $('#emptyPreview').classList.add('hidden'); cv.classList.remove('hidden');
  let doneT = 0;
  const endT = startT + maxDur;
  for (const [k, r] of ranges.entries()) {
    const len = r.end - r.start;
    if (doneT + len <= startT) { doneT += len; continue; }
    if (run.stop || doneT >= endT) break;
    await loadSrc(urls[P.takes[r.take].id]);
    previewGain(r.vol ?? P.takes[r.take].vol ?? 1);
    await seekTo(r.start + Math.max(0, startT - doneT));
    await preview.play();
    await new Promise((res) => {
      const chk = () => {
        const local = Math.max(0, preview.currentTime - r.start), t = doneT + local;
        comp.frame(cx, (c) => (track ? track.draw(c, t, true) : drawCover(c, preview)), t, k, local);
        ov(cx, t, track ? null : preview, true);
        if (P.step === 4) followPlayhead(t, reelT);
        (run.stop || t >= endT || preview.currentTime >= r.end - 0.02 || preview.ended) ? res() : requestAnimationFrame(chk);
      };
      chk();
    });
    if (track) track.pauseAll();
    ov.pause();
    doneT += len;
  }
  preview.pause(); if (track) track.pauseAll(); ov.pause();
  if (playing === run) { playing = null; playLabel(false); }
}
const makeComp = (part, ranges, still = false) =>
  new Compositor(P.effects, P.trans, ranges, part === 2 ? total(partRanges(1)) : 0, !VO() && !still);

// ---------- Photo / carousel ----------
let slideImgs = {}, slideKey = '';
async function getSlideImgs() {
  const key = P.slides.map((x) => x.id).join(',');
  if (key !== slideKey) { slideImgs = await loadImages(P.slides, (id) => urls[id]); slideKey = key; }
  return slideImgs;
}
// Draw slide i with everything on top, into ctx (1080x1920 working frame).
async function paintSlide(ctx, i) {
  const t = i + 0.6; // animations have settled by now
  const imgs = await getSlideImgs();
  const ov = await makeOverlay(0);
  await ov.prepare(t);
  drawSlide(ctx, P.slides, imgs, t, P.aspect);
  ov(ctx, t, null);
}
let heicLib = null;
function heicToJpeg(f) {
  heicLib = heicLib || new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js'; sc.onload = () => res(window.heic2any); sc.onerror = rej; document.head.appendChild(sc); });
  return heicLib.then(async (h) => { const out = await h({ blob: f, toType: 'image/jpeg', quality: 0.92 }); const bl = Array.isArray(out) ? out[0] : out; return new File([bl], f.name.replace(/\.hei[cf]$/i, '') + '.jpg', { type: 'image/jpeg' }); });
}
function photoRecord() {
  panel.innerHTML = `
    <h1>Photos</h1>
    <p class="sub">Add one picture for a single post or ad, or several for a carousel. Each picture is one slide.</p>
    <label class="big" style="cursor:pointer">⬆ Add photos from your phone or computer<input type="file" id="addSlides" accept="image/*,.heic,.HEIC" multiple hidden></label>
    <label>Size</label>
    <div class="row">${Object.entries(ASPECTS).map(([k, a]) => `<button class="chip ${P.aspect === k ? 'on' : ''}" data-aspect="${k}">${a.name}</button>`).join('')}</div>
    <p class="hint">Feed posts, carousels and feed ads: 4:5. Stories: 9:16.</p>
    <h3 style="margin-top:22px">Slides (${P.slides.length})</h3>
    <ul class="takes vis">${P.slides.map((x, i) => `<li><img src="${urls[x.id]}"><b>${i + 1}</b>
      <input type="text" class="short" style="flex:1" data-stext="${i}" value="${esc(x.text || '')}" placeholder="${i === 0 ? 'Slide 1 uses your hook; add more text here if you want' : 'Text on this slide (optional, *stars* = highlight)'}">
      <button class="x" data-sup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="x" data-sdn="${i}" ${i === P.slides.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="x" data-sdel="${i}" title="Remove">✕</button></li>`).join('') || '<li>No photos yet.</li>'}</ul>
    <div class="next"><span></span><button class="big" id="goEdit" ${P.slides.length ? '' : 'disabled'}>Next: Edit →</button></div>`;
  $('#addSlides').onchange = async (e) => {
    let bad = 0;
    const files = [...e.target.files];
    if (files.length) toast(`Adding ${files.length} photo${files.length > 1 ? 's' : ''}…`, 60000);
    for (let f of files) {
      let ok = false;
      try { const im = new Image(); im.src = URL.createObjectURL(f); await im.decode(); ok = true; } catch {}
      if (!ok && /hei[cf]/i.test(f.type + f.name)) { // iPhone photo: convert to JPEG
        try { f = await heicToJpeg(f); const im = new Image(); im.src = URL.createObjectURL(f); await im.decode(); ok = true; } catch (err) { console.warn('HEIC convert failed', err); }
      }
      if (!ok) { bad++; continue; }
      const id = 's' + Date.now() + Math.random().toString(36).slice(2, 6);
      await store.put('blob:' + id, f); urls[id] = URL.createObjectURL(f);
      remember(); P.slides.push({ id, name: f.name, text: '' });
    }
    if (bad) toast(`${bad} photo${bad > 1 ? 's' : ''} wouldn't open. Try saving ${bad > 1 ? 'them' : 'it'} as JPEG first (on iPhone: Share → Save to Files, or Settings → Camera → Formats → Most Compatible).`, 9000);
    else if (files.length) toast('Added.');
    if (P.status === 'To record' && P.slides.length) P.status = 'Recorded';
    save(); render();
  };
  document.querySelectorAll('[data-aspect]').forEach((b) => (b.onclick = () => { remember(); P.aspect = b.dataset.aspect; save(); render(); }));
  document.querySelectorAll('[data-stext]').forEach((el) => {
    el.onfocus = () => { P.scrub = +el.dataset.stext; repaint(); };
    el.oninput = () => { P.slides[+el.dataset.stext].text = el.value; save(); repaint(); };
  });
  const mv = (i, d) => { const j = i + d; if (j < 0 || j >= P.slides.length) return; remember(); [P.slides[i], P.slides[j]] = [P.slides[j], P.slides[i]]; save(); render(); };
  document.querySelectorAll('[data-sup]').forEach((b) => (b.onclick = () => mv(+b.dataset.sup, -1)));
  document.querySelectorAll('[data-sdn]').forEach((b) => (b.onclick = () => mv(+b.dataset.sdn, 1)));
  document.querySelectorAll('[data-sdel]').forEach((b) => (b.onclick = () => { remember(); P.slides.splice(+b.dataset.sdel, 1); P.scrub = 0; save(); render(); }));
  $('#goEdit').onclick = () => go(4);
}
function photoClean() {
  panel.innerHTML = `<h1>Clean</h1><p class="sub">Photos don't need cleanup. Go straight to Edit to add text, stamps and your logo.</p>
    <div class="next"><button class="btn" id="b2">← Photos</button><button class="big" id="g4">Next: Edit →</button></div>`;
  $('#b2').onclick = () => go(2); $('#g4').onclick = () => go(4);
}
function photoExport() {
  const a = ASPECTS[P.aspect];
  panel.innerHTML = `
    <h1>Export</h1>
    <p class="sub">${P.slides.length > 1 ? `Your carousel: ${P.slides.length} slides` : 'Your post'} at ${a.w}×${a.h}, with your text, graphics and logo on each slide.</p>
    ${!P.slides.length ? '<div class="note bad">Add a photo first.</div>' : `
    <div class="row"><button class="big" id="expAll">⬇ Download ${P.slides.length > 1 ? 'all slides (zip)' : 'the picture'}</button></div>
    <div class="cover-strip" id="slideThumbs"><span class="sub">Making previews…</span></div>
    <p class="hint">Tap a slide to download just that one. Upload them in this order for a carousel. For an ad, use the 4:5 size.</p>`}
    <div class="next"><button class="btn" id="b4">← Edit</button><button class="big" id="g6">Next: Post →</button></div>`;
  $('#b4').onclick = () => go(4); $('#g6').onclick = () => go(6);
  if (!P.slides.length) return;
  const base = (P.title || 'post').replace(/[^\w\- ]+/g, '').trim() || 'post';
  const render1 = async (i) => { const c = document.createElement('canvas'); c.width = W; c.height = H; await paintSlide(c.getContext('2d'), i); return cropTo(c, P.aspect); };
  const dl = (blob, name) => { const x = document.createElement('a'); x.href = URL.createObjectURL(blob); x.download = name; x.click(); };
  const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
  (async () => {
    const box = $('#slideThumbs'); box.innerHTML = '';
    for (let i = 0; i < P.slides.length; i++) {
      const c = await render1(i);
      const img = new Image(); img.src = c.toDataURL('image/jpeg', 0.7); img.title = `Download slide ${i + 1}`;
      img.style.aspectRatio = `${a.w}/${a.h}`;
      img.onclick = async () => dl(await toBlob(await render1(i)), `${base} - slide ${i + 1}.png`);
      if (!$('#slideThumbs')) return; box.appendChild(img);
    }
  })();
  $('#expAll').onclick = async () => {
    $('#expAll').disabled = true;
    const files = [];
    for (let i = 0; i < P.slides.length; i++) files.push({ name: `${base} - slide ${i + 1}.png`, blob: await toBlob(await render1(i)) });
    if (files.length === 1) dl(files[0].blob, files[0].name);
    else dl(await makeZip(files), `${base} - carousel.zip`);
    window.__lastExport = { count: files.length };
    if (P.status !== 'Posted') { P.status = 'Edited'; save(); }
    $('#expAll').disabled = false; toast('Saved to your Downloads.');
  };
}

// ---------- Step 3: Clean ----------
let worker = null;
function transcribe(samples) {
  return new Promise((resolve) => {
    if (!worker) worker = new Worker('js/whisper-worker.js', { type: 'module' });
    const id = Math.random();
    const timeout = setTimeout(() => resolve(null), 10 * 60 * 1000);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'download') setStatus(`Downloading the transcript tool (one time only)… ${Math.round(m.pct || 0)}%`, m.pct / 100);
      else if (m.type === 'status') setStatus(m.text);
      else if (m.id === id) { clearTimeout(timeout); resolve(m.type === 'done' ? m.words : null); }
    };
    worker.onerror = () => { clearTimeout(timeout); resolve(null); };
    worker.postMessage({ id, audio: samples });
  });
}
function setStatus(text, pct) {
  const s = $('#status'); if (s) s.textContent = text;
  const b = $('#bar'); if (b && pct != null) b.style.width = Math.round(pct * 100) + '%';
}

async function runClean() {
  $('#cleanBtn').disabled = true;
  remember();
  const items = []; let gotWords = true;
  for (let i = 0; i < P.takes.length; i++) {
    const tk = P.takes[i];
    if (tk.kind === 'image') { items.push({ type: 'visual', take: i, start: 0, end: tk.duration, cut: false, reason: '' }); continue; } // photos have no pauses to cut
    setStatus(`Take ${i + 1} of ${P.takes.length}: finding pauses…`, i / P.takes.length);
    const blob = await store.get('blob:' + (tk.audioId || tk.id));
    const samples = await to16kMono(await decodeClip(blob));
    const runs = speechRuns(samples);
    setStatus(`Take ${i + 1} of ${P.takes.length}: getting the transcript…`);
    const words = window.__FAKE_WORDS ? window.__FAKE_WORDS(i) : window.__NO_WHISPER ? null : await transcribe(samples);
    if (!words) gotWords = false;
    items.push(...buildItems(tk, i, runs, words, P.pauseSec));
  }
  if (gotWords) markRepeats(items);
  P.items = items; P.cleaned = true; P.transcript = gotWords; P.split = null;
  if (P.autoZoom !== false) applyAutoZoom();
  if (cleanLen() >= 30) P.split = suggestSplit(P.items, P.takes);
  save(); render();
}

function applyAutoZoom() {
  if (VO() || PHOTO() || !P.cleaned) return 0;
  const ranges = keptRanges(P.items, P.takes);
  const words = P.transcript ? outWords(P.items, P.takes, ranges) : [];
  P.effects = (P.effects || []).filter((e) => !e.auto);
  const z = autoZoom(words, ranges, total(ranges)).map((e) => ({ id: newId('e'), ...e }));
  P.effects.push(...z);
  return z.length;
}
function clean() {
  if (!P.takes.length) { panel.innerHTML = `<h1>Clean it up</h1><p class="sub">Record or upload a take first.</p><button class="big" onclick="">← Back to Record</button>`; panel.querySelector('button').onclick = () => go(2); return; }
  const before = rawLen(), after = cleanLen();
  const parts = P.split ? [1, 2].map((p) => total(partRanges(p))) : null;
  panel.innerHTML = `
    <h1>Clean it up</h1>
    <p class="sub">Cuts long pauses and repeated lines. When you said a line more than once, it keeps your <b>last</b> take. Nothing is gone for good: tap anything crossed out to put it back.</p>
    ${!P.cleaned ? `<button class="big" id="cleanBtn">✨ Clean it up</button>
      <div class="progress"><div id="bar"></div></div><div id="status" class="sub"></div>` : `
      <div class="compare"><div>Before<br><b>${fmt(before)} sec</b></div><div>After<br><b>${fmt(after)} sec</b></div><div>Cut<br><b>${fmt(before - after)} sec</b></div></div>
      ${P.transcript ? '' : `<div class="note">The transcript didn't load, so I only cut pauses. Repeated lines need the transcript. Check your internet and press "Clean again".</div>`}
      ${splitNote(after, parts)}
      <div class="transcript" id="tx">${transcriptHTML()}</div>`}
    <details class="more"><summary>More options</summary>
      <label>Cut pauses longer than <b id="pv">${P.pauseSec.toFixed(1)}</b> sec ${tip('Shorter = snappier. Longer = more natural breathing room.')}</label>
      <input type="range" id="pause" min="0.2" max="1.5" step="0.1" value="${P.pauseSec}">
      ${P.cleaned ? '<br><button class="btn" id="again" style="margin-top:12px">Clean again from scratch</button>' : ''}
      ${!VO() ? `<div class="row" style="margin-top:12px"><label class="inline"><input type="checkbox" id="autoZ" ${P.autoZoom !== false ? 'checked' : ''}> 🔍 Auto zoom: close-ups on your hook, key words and jump cuts</label>
        ${P.cleaned ? `<span class="sub">${(P.effects || []).filter((e) => e.auto).length} close-ups</span><button class="chip" id="redoZ">Pick again</button>` : ''}</div>` : ''}
    </details>
    <div class="next"><button class="btn" id="back2">← Record more</button>
      <button class="big" id="go4" ${P.cleaned ? '' : 'disabled'}>Next: Edit →</button></div>`;

  if (!P.cleaned) $('#cleanBtn').onclick = runClean;
  $('#pause').oninput = (e) => {
    $('#pv').textContent = (+e.target.value).toFixed(1);
  };
  $('#pause').onchange = (e) => {
    remember(); P.pauseSec = +e.target.value;
    if (P.cleaned) P.takes.forEach((tk, i) => markPauses(P.items.filter((it) => it.take === i), P.pauseSec, tk.duration));
    save(); render();
  };
  if ($('#autoZ')) $('#autoZ').onchange = (e) => { remember(); P.autoZoom = e.target.checked; if (!P.autoZoom) P.effects = (P.effects || []).filter((x) => !x.auto); else applyAutoZoom(); save(); render(); };
  if ($('#redoZ')) $('#redoZ').onclick = () => { remember(); const n = applyAutoZoom(); save(); render(); toast(`${n} close-ups picked. Change or delete any in Edit → Transitions & mirror.`); };
  if ($('#again')) $('#again').onclick = () => { P.cleaned = false; save(); render(); runClean(); };
  $('#back2').onclick = () => go(2);
  $('#go4').onclick = () => go(4);
  if ($('#doSplit')) $('#doSplit').onclick = () => { remember(); P.split = suggestSplit(P.items, P.takes); save(); render(); if (!P.split) toast("Couldn't find a sentence end before 30 sec. Try cutting a bit more."); };
  if ($('#noSplit')) $('#noSplit').onclick = () => { remember(); P.split = null; save(); render(); };
  document.querySelectorAll('[data-i]').forEach((el) => (el.onclick = () => {
    remember();
    const it = P.items[+el.dataset.i];
    it.cut = !it.cut; it.reason = it.cut ? 'manual' : 'kept';
    if (P.split && cleanLen() < 30) P.split = null;
    save(); render();
  }));
}

function splitNote(after, parts) {
  if (P.split) {
    const ok = parts.every((p) => p < 30);
    return `<div class="note ${ok ? 'ok' : 'bad'}">Split into <b>Part 1 (${fmt(parts[0])} sec)</b> and <b>Part 2 (${fmt(parts[1])} sec)</b>, at the end of a sentence. Look for the gold PART 2 marker.
      ${ok ? '' : ' One part is still 30 sec or more. Cut a little more, or tap a crossed-out line back only if you need it.'}
      <br><button class="btn" id="noSplit" style="margin-top:8px">Remove the split</button></div>`;
  }
  if (after >= 30) return `<div class="note bad">This is ${fmt(after)} sec, and reels need to be under 30. Split it into Part 1 and Part 2 at the end of a sentence?
    <br><button class="big gold" id="doSplit" style="margin-top:10px">Split into Part 1 and Part 2</button></div>`;
  return `<div class="note ok">Under 30 sec. You're good.</div>`;
}

function transcriptHTML() {
  let html = '', lastTake = -1, splitShown = false;
  P.items.forEach((it, i) => {
    if (it.take !== lastTake) { html += `<span class="take-mark">TAKE ${it.take + 1}</span>`; lastTake = it.take; }
    if (P.split && !splitShown && (it.take > P.split.take || (it.take === P.split.take && it.start >= P.split.time - 0.01))) {
      html += '<span class="split-mark">PART 2 ▸</span>'; splitShown = true;
    }
    const why = it.reason && it.reason !== 'kept' ? ` (${it.reason})` : '';
    if (it.type === 'word') html += `<span class="w ${it.cut ? 'cut' : ''}" data-i="${i}" title="${it.cut ? 'Cut' + why + '. Tap to put back.' : 'Tap to cut'}">${esc(it.text)}</span> `;
    else if (it.type === 'gap') html += `<span class="gap ${it.cut ? 'cut' : ''}" data-i="${i}" title="${it.cut ? 'Pause cut. Tap to keep.' : 'Pause kept. Tap to cut.'}">⏸ ${fmt(it.end - it.start)}s</span>`;
    else if (it.type === 'visual') html += `<span class="gap ${it.cut ? 'cut' : ''}" style="background:#fdf1dc;color:#7a4f0e" data-i="${i}" title="${it.cut ? 'Photo cut. Tap to keep.' : 'Photo. Tap to cut.'}">🖼 photo ${fmt(it.end - it.start)}s</span>`;
    else if (it.type === 'manual') html += `<span class="gap ${it.cut ? 'cut' : ''}" data-i="${i}" title="${it.cut ? 'Section you removed in Edit. Tap to put it back.' : 'Put back. Tap to remove again.'}">✂ removed ${fmt(it.end - it.start)}s</span>`;
    else html += `<span class="gap ${it.cut ? 'cut' : ''}" style="background:#e6f4f1;color:#0a6466" data-i="${i}" title="${it.cut ? 'Cut. Tap to keep.' : 'Talking. Tap to cut.'}">🗣 ${fmt(it.end - it.start)}s</span>`;
  });
  return html;
}

// ---------- Step 4: Edit ----------
let editTab = 'text', moveWhat = 'caps', tapMode = 'hl', presets = [];
const openBoxes = new Set(['hook', 'caps']);
const getPath = (path) => path.split('.').reduce((o, k) => o[k], P);
function setPath(path, val) { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], P)[last] = val; }
const reelLen = () => (PHOTO() ? P.slides.length : total(fullRanges()));

function swatches(path, cur) {
  return `<div class="row sw">${BRAND.map((b) => `<button class="swatch ${cur.toLowerCase() === b.c.toLowerCase() ? 'on' : ''}" style="background:${b.c}" title="${b.name}" data-set="${path}" data-val="${b.c}"></button>`).join('')}
    <input type="color" value="${cur}" data-k="${path}" data-type="str" title="Any color"></div>`;
}

function styleEditor(base) {
  const st = getPath(base);
  return `<details class="more" data-box="${base}" ${openBoxes.has(base) ? 'open' : ''}><summary>Style: ${esc(st.font)}, ${st.size}px</summary>
    <label>Font ${tip('Each one shows your words. Tap to use it.')}</label>
    <div class="fonts">${FONTS.map((f) => `<button class="font ${st.font === f ? 'on' : ''}" data-set="${base}.font" data-val="${f}" style="font-family:'${f}';font-weight:${st.weight};font-style:${st.italic ? 'italic' : 'normal'}">${esc(sampleText())}</button>`).join('')}</div>
    <div class="row">
      <label class="inline">Weight <select data-k="${base}.weight" data-type="num">${[400, 700, 900].map((w) => `<option ${st.weight === w ? 'selected' : ''} value="${w}">${w === 900 ? 'Black' : w === 700 ? 'Bold' : 'Regular'}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" data-k="${base}.italic" data-type="bool" ${st.italic ? 'checked' : ''}> Italic</label>
      <label class="inline"><input type="checkbox" data-k="${base}.upper" data-type="bool" ${st.upper ? 'checked' : ''}> ALL CAPS</label>
    </div>
    <label>Size <b data-show="${base}.size">${st.size}</b>px</label>
    <input type="range" min="30" max="160" step="2" value="${st.size}" data-k="${base}.size" data-type="num" data-live>
    <label>Text color</label>${swatches(base + '.color', st.color)}
    <label>Highlight color ${tip('Used for key words and the karaoke word.')}</label>${swatches(base + '.hl', st.hl)}
    <label>Outline <b data-show="${base}.outline">${st.outline}</b>px</label>
    <input type="range" min="0" max="24" value="${st.outline}" data-k="${base}.outline" data-type="num" data-live>
    ${swatches(base + '.outlineColor', st.outlineColor)}
    <label class="inline"><input type="checkbox" data-k="${base}.shadow" data-type="bool" ${st.shadow ? 'checked' : ''}> Drop shadow</label>
    <div class="row" style="margin-top:12px">
      <select data-preset="${base}"><option value="">Apply a preset…</option><option value="__my">My style (default)</option>${presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn" data-savepreset="${base}">Save as preset</button>
    </div>
  </details>`;
}
const sampleText = () => (P.text.hook.text || P.hook || 'Your words here').split(/\s+/).slice(0, 4).join(' ').replace(/\*/g, '');

const ANIMS = { karaoke: 'Karaoke (word lights up)', word: 'Word by word', pop: 'Pop in', bounce: 'Bounce', fade: 'Fade in', none: 'None' };

function edit() {
  if (!P.takes.length && !(PHOTO() && P.slides.length)) { panel.innerHTML = `<h1>Edit</h1><p class="sub">${PHOTO() ? 'Add a photo first.' : 'Record a take first.'}</p>`; return; }
  if (PHOTO() && (editTab === 'trans')) editTab = 'text';
  if (!PHOTO()) migrateSplits();
  loadAllFonts();
  const T = P.text;
  const words = P.cleaned && P.transcript ? outWords(P.items, P.takes, fullRanges()) : [];
  const len = reelLen();
  if (P.scrub > len) P.scrub = 0;
  panel.innerHTML = `
    <h1>Edit</h1>
    <div class="tabs">${[['text', 'Text'], ['broll', 'B-roll'], ['trans', 'Transitions & mirror'], ['gfx', 'Graphics & stamps']].filter(([k]) => !(PHOTO() && k === 'trans')).map(([k, n]) =>
      `<button class="tab ${editTab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>
    ${splitBarHTML(len)}
    ${editTab === 'broll' ? brollHTML(len) : editTab === 'trans' ? transHTML(len) : editTab === 'gfx' ? gfxHTML(len) : `
    <div class="scrub">
      ${PHOTO() ? `<label>Slide <b id="scrubV">${Math.floor(P.scrub) + 1}</b></label>
      <input type="range" id="scrub" min="0" max="${Math.max(0, len - 1)}" step="1" value="${P.scrub}">` : ''}
      <div class="row small" style="padding-top:8px">Drag on the preview to move:
        ${[['hook', 'Hook'], ['caps', 'Captions'], ['list', 'List'], ...(T.typed.on ? [['typed', 'Typed captions']] : [])].map(([k, n]) => `<button class="chip ${moveWhat === k ? 'on' : ''}" data-move="${k}">${n}</button>`).join('')}</div>
    </div>

    <div class="card">
      <div class="card-h"><label class="inline big-l"><input type="checkbox" data-k="text.hook.on" data-type="bool" data-re ${T.hook.on ? 'checked' : ''}> Hook text</label>
        <span class="sub">first ${T.hook.dur} sec</span></div>
      ${T.hook.on ? `
      <input type="text" data-k="text.hook.text" data-type="str" data-live value="${esc(T.hook.text)}" placeholder="${esc(P.hook || 'Type your hook')}">
      <p class="hint">Put *stars* around a word to make it the highlight color, like: I'm *done* giving tips</p>
      <div class="row">
        <label class="inline">On screen for <input type="number" min="0.5" max="10" step="0.5" value="${T.hook.dur}" data-k="text.hook.dur" data-type="num" class="num"> sec</label>
        <label class="inline">Animation <select data-k="text.hook.anim" data-type="str">${['pop', 'bounce', 'fade', 'none'].map((a) => `<option value="${a}" ${T.hook.anim === a ? 'selected' : ''}>${ANIMS[a]}</option>`).join('')}</select></label>
        ${VO() ? '' : `<label class="inline"><input type="checkbox" data-k="text.hook.behind" data-type="bool" ${T.hook.behind ? 'checked' : ''}> Behind me ${tip('Puts the words behind your head and shoulders. Works best with a plain background and you not moving much.')}</label>`}
      </div>
      ${P.split ? `<label class="inline">Part 2 label <input type="text" class="short" data-k="text.hook.part2" data-type="str" data-live value="${esc(T.hook.part2)}"></label>` : ''}
      ${styleEditor('text.hook.style')}` : ''}
    </div>

    <div class="card">
      <div class="card-h"><label class="inline big-l"><input type="checkbox" data-k="text.caps.on" data-type="bool" data-re ${T.caps.on ? 'checked' : ''}> Captions</label>
        <span class="sub">${words.length ? words.length + ' words' : ''}</span></div>
      ${!T.caps.on ? '' : !words.length ? `<div class="note">Captions come from the transcript. ${P.cleaned ? 'The transcript didn\'t load, so go back to Clean and press "Clean again" with internet on.' : 'Run Clean first.'}</div>` : `
      <div class="row">
        <label class="inline">Words at a time <select data-k="text.caps.n" data-type="num">${[1, 2, 3, 4].map((n) => `<option ${T.caps.n === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="inline">Style <select data-k="text.caps.anim" data-type="str">${Object.entries(ANIMS).map(([k, n]) => `<option value="${k}" ${T.caps.anim === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${VO() ? '' : `<label class="inline"><input type="checkbox" data-k="text.caps.behind" data-type="bool" ${T.caps.behind ? 'checked' : ''}> Behind me</label>`}
        <label class="inline"><input type="checkbox" data-k="text.caps.skipUnderHook" data-type="bool" ${T.caps.skipUnderHook ? 'checked' : ''}> Hide while the hook shows</label>
      </div>
      <div class="row small" style="margin-top:12px">Tap a word to:
        ${[['hl', 'Highlight'], ['big', 'Make bigger'], ['fix', 'Fix spelling']].map(([k, n]) => `<button class="chip ${tapMode === k ? 'on' : ''}" data-tap="${k}">${n}</button>`).join('')}</div>
      <div class="words">${words.map((w) => `<span class="wd ${w.hl ? 'hl' : ''} ${w.big ? 'bg' : ''}" data-w="${w.i}" data-s="${w.s.toFixed(2)}">${esc(w.text)}</span>`).join(' ')}</div>
      ${styleEditor('text.caps.style')}`}
    </div>

    <div class="card">
      <div class="card-h"><label class="inline big-l"><input type="checkbox" data-k="text.list.on" data-type="bool" data-re ${T.list.on ? 'checked' : ''}> List lines (appear one at a time)</label></div>
      ${T.list.on ? `
      <textarea data-k="text.list.lines" data-type="str" data-live placeholder="One line per row, e.g.&#10;$116 more per kid, every year&#10;$19,000 more per kid, lifetime">${esc(T.list.lines)}</textarea>
      <div class="row">
        <label class="inline">First line at <input type="number" class="num" min="0" step="0.5" value="${T.list.start}" data-k="text.list.start" data-type="num"> sec</label>
        <label class="inline">Next line every <input type="number" class="num" min="0.5" step="0.5" value="${T.list.every}" data-k="text.list.every" data-type="num"> sec</label>
        ${VO() ? '' : `<label class="inline"><input type="checkbox" data-k="text.list.behind" data-type="bool" ${T.list.behind ? 'checked' : ''}> Behind me</label>`}
      </div>
      ${styleEditor('text.list.style')}` : ''}
    </div>
    ${PHOTO() ? '' : typedHTML(len)}
    `}
    <div class="next"><button class="btn" id="back3">← Clean</button><button class="big" id="go5">Next: Export →</button></div>`;

  $('#back3').onclick = () => go(3);
  $('#go5').onclick = () => go(5);
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { editTab = b.dataset.tab; render(); }));
  if (!PHOTO()) splitBind(len);
  if (editTab === 'broll') { brollBind(); return; }
  if (editTab === 'trans') { transBind(); return; }
  if (editTab === 'gfx') { gfxBind(); return; }
  if (editTab !== 'text') return;

  if (PHOTO()) {
    $('#scrub').oninput = (e) => { P.scrub = +e.target.value; $('#scrubV').textContent = Math.floor(P.scrub) + 1; repaint(); };
    $('#scrub').onchange = () => save();
  }
  typedBind();
  document.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => { moveWhat = b.dataset.move; render(); }));
  document.querySelectorAll('[data-tap]').forEach((b) => (b.onclick = () => { tapMode = b.dataset.tap; render(); }));
  document.querySelectorAll('details[data-box]').forEach((d) => (d.ontoggle = () => { d.open ? openBoxes.add(d.dataset.box) : openBoxes.delete(d.dataset.box); }));

  bindInputs();
  document.querySelectorAll('[data-preset]').forEach((sel) => (sel.onchange = () => {
    if (sel.value === '') return;
    remember();
    const base = sel.dataset.preset, cur = getPath(base);
    const st = sel.value === '__my' ? { ...MY_STYLE, size: cur.size } : { ...presets[+sel.value].style };
    setPath(base, st); save(); render();
  }));
  document.querySelectorAll('[data-savepreset]').forEach((b) => (b.onclick = async () => {
    const name = prompt('Name this preset (e.g. "Teal hook"):'); if (!name) return;
    presets.push({ name, style: { ...getPath(b.dataset.savepreset) } });
    await store.put('presets', presets); toast(`Saved "${name}". It's in "Apply a preset" on every text.`); render();
  }));
  document.querySelectorAll('[data-w]').forEach((el) => (el.onclick = () => {
    const it = P.items[+el.dataset.w];
    P.scrub = +el.dataset.s + 0.05;
    if (tapMode === 'fix') {
      const v = prompt('Fix this word:', it.fix || it.text); if (v == null) return;
      remember(); it.fix = v.trim() || undefined;
    } else { remember(); it[tapMode] = !it[tapMode]; }
    save(); render();
  }));
}

function bindInputs() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const read = () => (el.dataset.type === 'bool' ? el.checked : el.dataset.type === 'num' ? +el.value : el.value);
    const live = () => {
      setPath(el.dataset.k, read());
      const show = document.querySelector(`[data-show="${el.dataset.k}"]`); if (show) show.textContent = el.dataset.pct !== undefined ? Math.round(el.value * 100) : el.value;
      save(); repaint();
    };
    el.addEventListener('focus', () => remember(), { once: true });
    if (el.dataset.live !== undefined) el.oninput = live;
    el.onchange = () => {
      if (el.dataset.live === undefined) remember();
      live();
      if (el.dataset.re !== undefined || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'number') render();
    };
  });
  document.querySelectorAll('[data-set]').forEach((b) => (b.onclick = async () => {
    remember(); setPath(b.dataset.set, b.dataset.val);
    if (b.dataset.set.endsWith('.font')) await loadFont(b.dataset.val);
    save(); render();
  }));
}

// ---------- B-roll tab ----------
const LAYOUTS = { framed: 'Framed over me', full: 'Full screen' };
const ENTER = { pop: 'Pop in', fade: 'Fade in', slide: 'Slide up', none: 'None' };
function brollHTML(len) {
  const b = (i) => P.broll[i];
  return `
    ${scrubBlock(len, 'Move the slider to where a photo or clip should start, then add it. Your voice keeps playing; clip sound is muted unless you turn it up (tap it on the timeline).')}
    <label class="big gold" style="display:inline-block;cursor:pointer">＋ Add photo or clip at ${fmt(P.scrub)} sec
      <input type="file" id="addBroll" accept="image/*,video/*,.mov,.MOV,.heic" multiple hidden></label>
    ${libraryHTML()}
    <h3 style="margin-top:22px">In this reel (${P.broll.length})</h3>
    ${P.broll.map((x, i) => `
    <div class="card">
      <div class="card-h"><button class="namebtn" data-bmove="${x.id}" title="Show settings">${moveWhat === 'b:' + x.id ? '▾' : '▸'} ${x.kind === 'image' ? '🖼' : '🎞'} ${esc(x.name)} <span class="sub">${fmt(x.start)}–${fmt(x.start + x.dur)} sec</span></button>
        <span><button class="chip ${moveWhat === 'b:' + x.id ? 'on' : ''}" data-bmove="${x.id}" title="Then drag it on the preview">Move on preview</button>
        ${x.lib ? '<span class="sub">📚 in library</span>' : `<button class="chip" data-bsave="${i}" title="Keep it for future reels">📚 Save to library</button>`}
        <button class="x" data-bdup="${i}" title="Duplicate">⧉</button><button class="x" data-bdel="${i}" title="Remove">✕</button></span></div>
      ${moveWhat !== 'b:' + x.id ? '' : `<div class="row">
        <label class="inline">Starts at <input type="number" class="num" min="0" step="0.1" value="${x.start}" data-k="broll.${i}.start" data-type="num"> sec</label>
        <button class="chip" data-bnow="${i}">Use ${fmt(P.scrub)} sec</button>
        <label class="inline">for <input type="number" class="num" min="0.3" step="0.1" value="${x.dur}" data-k="broll.${i}.dur" data-type="num"> sec</label>
        <label class="inline"><select data-k="broll.${i}.layout" data-type="str">${Object.entries(LAYOUTS).map(([k, n]) => `<option value="${k}" ${x.layout === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="inline">Enter <select data-k="broll.${i}.anim" data-type="str">${Object.entries(ENTER).map(([k, n]) => `<option value="${k}" ${x.anim === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      ${x.layout === 'framed' ? `
      <label>Frame</label>
      <div class="row">${Object.entries(FRAMES).map(([k, n]) => `<button class="chip ${x.frame === k ? 'on' : ''}" data-set="broll.${i}.frame" data-val="${k}">${n}</button>`).join('')}</div>
      ${x.frame === 'polaroid' ? `<label class="inline">Caption <input type="text" class="short" data-k="broll.${i}.caption" data-type="str" data-live value="${esc(x.caption)}" placeholder="e.g. Version 1, 2023"></label>` : ''}
      <label>Size <b data-show="broll.${i}.size">${Math.round(x.size * 100)}</b>%</label>
      <input type="range" min="0.25" max="0.95" step="0.01" value="${x.size}" data-k="broll.${i}.size" data-type="num" data-live data-pct>
      <label>Tilt <b data-show="broll.${i}.tilt">${x.tilt}</b>°</label>
      <input type="range" min="-15" max="15" step="1" value="${x.tilt}" data-k="broll.${i}.tilt" data-type="num" data-live>
      ${x.frame === 'plain' ? `
      <label>Border <b data-show="broll.${i}.border">${x.border}</b>px</label>
      <input type="range" min="0" max="40" value="${x.border}" data-k="broll.${i}.border" data-type="num" data-live>
      ${swatches(`broll.${i}.borderColor`, x.borderColor)}
      <label>Rounded corners <b data-show="broll.${i}.radius">${x.radius}</b>px</label>
      <input type="range" min="0" max="120" value="${x.radius}" data-k="broll.${i}.radius" data-type="num" data-live>` : ''}
      <label class="inline"><input type="checkbox" data-k="broll.${i}.shadow" data-type="bool" ${x.shadow ? 'checked' : ''}> Drop shadow</label>` : ''}`}
    </div>`).join('') || '<p class="sub" style="margin-top:16px">No B-roll yet.</p>'}`;
}
function brollBind() {
  bindScrub();
  $('#addBroll').onchange = async (e) => {
    let at = P.scrub;
    for (const f of e.target.files) {
      const id = 'b' + Date.now() + Math.random().toString(36).slice(2, 6);
      await store.put('blob:' + id, f); urls[id] = URL.createObjectURL(f);
      remember();
      const item = newBroll(id, f.type.startsWith('image/') ? 'image' : 'video', f.name, at);
      if (PHOTO()) { item.start = Math.floor(at); item.dur = 1; }
      P.broll.push(item); moveWhat = 'b:' + id; at += item.dur;
    }
    P.broll.sort((a, b) => a.start - b.start); P.scrub = Math.min(P.scrub + 0.3, reelLen() - 0.05);
    save(); render();
  };
  bindInputs();
  libraryBind();
  document.querySelectorAll('[data-bsave]').forEach((b) => (b.onclick = async () => {
    const x = P.broll[+b.dataset.bsave];
    const cat = libCat !== 'All' ? libCat : (prompt(`Which category? (${L.library().cats.join(', ')})`, L.library().cats[0]) || '').trim();
    if (!cat) return;
    await L.addToLibrary(await store.get('blob:' + x.id), x.name, [cat]);
    x.lib = true; save(); render(); toast(`Saved to your library under "${cat}".`);
  }));
  document.querySelectorAll('[data-bmove]').forEach((b) => (b.onclick = () => {
    moveWhat = 'b:' + b.dataset.bmove; const x = P.broll.find((y) => y.id === b.dataset.bmove);
    P.scrub = Math.min(x.start + Math.min(0.6, x.dur / 2), reelLen() - 0.05); render();
  }));
  document.querySelectorAll('[data-bnow]').forEach((b) => (b.onclick = () => { remember(); P.broll[+b.dataset.bnow].start = +P.scrub.toFixed(2); save(); render(); }));
  document.querySelectorAll('[data-bdel]').forEach((b) => (b.onclick = () => { remember(); P.broll.splice(+b.dataset.bdel, 1); save(); render(); }));
  document.querySelectorAll('[data-bdup]').forEach((b) => (b.onclick = () => {
    const x = P.broll[+b.dataset.bdup];
    const id = 'b' + Date.now() + Math.random().toString(36).slice(2, 6);
    store.get('blob:' + x.id).then((bl) => store.put('blob:' + id, bl));
    urls[id] = urls[x.id];
    remember(); P.broll.push({ ...x, id, start: +(x.start + x.dur).toFixed(2) }); save(); render();
  }));
}

// ---------- Timeline (Edit, above the tabs): play, time, slider and split on one line; every clip can move or go ----------
let selClip = null, pendingDur = null; // selClip: clip index, or 'b:' + B-roll id
const TRANS_CYCLE = Object.keys(TRANSITIONS);
// One block per clip on the main line, with its reel times.
function clipSpans() {
  const out = []; let acc = 0;
  fullRanges().forEach((r) => {
    const d = r.end - r.start, last = out[out.length - 1];
    if (last && last.ci === r.ci) last.b = acc + d;
    else out.push({ ci: r.ci, take: r.take, a: acc, b: acc + d, r });
    acc += d;
  });
  return out;
}
const clipName = (ci) => {
  const cl = clipList(), c = cl[ci]; if (!c) return '';
  const tk = P.takes[c.take];
  if (tk.kind === 'image') return 'Photo';
  const same = cl.map((x, i) => [x, i]).filter(([x]) => x.take === c.take);
  const letter = same.length > 1 ? 'abcdefghijklmnopqrstuvwxyz'[same.findIndex(([, i]) => i === ci)] || '' : '';
  return `${VO() ? 'Voice' : 'Take'} ${c.take + 1}${letter}`;
};
const volIcon = (v) => (v === 0 ? '🔇' : '🔊');
// Old reels saved split markers; turn them into real clip cuts.
function migrateSplits() {
  if (!P.splits || !P.splits.length) return;
  const ts = [...P.splits].sort((a, b) => b - a); P.splits = [];
  for (const t of ts) splitAt(t);
  save();
}
// Cut the clip under reel time t into two clips.
function splitAt(t) {
  let acc = 0;
  for (const r of fullRanges()) {
    const d = r.end - r.start;
    if (t > acc && t < acc + d) {
      const src = r.start + (t - acc), cl = ensureClips(), c = cl[r.ci];
      if (src - c.start < 0.1 || c.end - src < 0.1) return false;
      cl.splice(r.ci, 1, { ...c, end: +src.toFixed(3) }, { ...c, start: +src.toFixed(3) });
      return true;
    }
    acc += d;
  }
  return false;
}
function clipPanelHTML(spans) {
  if (selClip == null) return '';
  if (typeof selClip === 'string') {
    const b = P.broll.find((x) => 'b:' + x.id === selClip);
    if (!b) { selClip = null; return ''; }
    const v = Math.round((b.vol || 0) * 100);
    return `<div class="clippanel"><div class="row"><b class="cpname">🎞 B-roll: ${esc(b.name)}</b>
      ${b.kind === 'video' ? `<span class="row cpvol">${volIcon(v)} <input type="range" id="cpVol" min="0" max="200" step="5" value="${v}"> <b id="cpVolV">${v}%</b>
        <button class="chip" id="cpMute">${v ? 'Mute' : 'Sound on'}</button></span>` : '<span class="sub" style="margin:0">Photos have no sound.</span>'}
      <button class="chip" id="cpBrollTab">Edit in B-roll</button><button class="x" id="cpClose" title="Close">✕</button></div>
      ${b.kind === 'video' ? '<p class="hint">B-roll is muted (0%) unless you turn it up. Over 100% makes it louder.</p>' : ''}</div>`;
  }
  const ci = selClip, c = clipList()[ci], sp = spans.find((x) => x.ci === ci);
  if (!c || !P.takes[c.take]) { selClip = null; return ''; }
  const tk = P.takes[c.take], img = tk.kind === 'image', v = Math.round((c.vol ?? tk.vol ?? 1) * 100);
  const n = clipList().length;
  return `<div class="clippanel"><div class="row">
      <b class="cpname">${img ? '🖼' : VO() ? '🎙' : '🎬'} ${clipName(ci)}${sp ? ` <span class="sub" style="margin:0">${fmt(sp.a)}–${fmt(sp.b)} sec</span>` : ''}</b>
      ${img ? `<label class="inline" style="margin:0">Shows for <input type="number" class="num" id="cpSec" min="0.5" max="15" step="0.5" value="${tk.duration}"> sec</label>`
        : `<span class="row cpvol">${volIcon(v)} <input type="range" id="cpVol" min="0" max="200" step="5" value="${v}"> <b id="cpVolV">${v}%</b>
        <button class="chip" id="cpMute">${v ? 'Mute' : 'Sound on'}</button></span>`}
      <button class="x" id="cpClose" title="Close">✕</button></div>
    <div class="row" style="margin-top:8px;gap:6px">
      <button class="chip" id="cpLeft" ${ci ? '' : 'disabled'}>◀ Earlier</button><button class="chip" id="cpRight" ${ci < n - 1 ? '' : 'disabled'}>Later ▶</button>
      <button class="chip" id="cpPlay">▶ Play clip</button>
      <select id="cpMirror" style="font-size:13px"><option value="">🪞 Mirror…</option>${Object.entries(MIRRORS).map(([k, nm]) => `<option value="${k}">${nm}</option>`).join('')}</select>
      <label class="chip" style="margin:0;cursor:pointer">🖼 Cover with B-roll<input type="file" id="cpCover" accept="image/*,video/*,.mov,.MOV,.heic" hidden></label>
      <button class="chip" id="cpLib">📚 Cover from library</button>
      <button class="chip danger" id="cpDel">🗑 Delete clip</button></div>
    <p class="hint">${img ? 'Photos have no sound. They get a slow push-in.' : 'Over 100% boosts a quiet clip.'} To trim, put the slider where it should end, tap ✂ Split here, then delete the piece you don't want.</p></div>`;
}
function splitBarHTML(len) {
  if (PHOTO()) return '';
  const pct = (t) => (100 * t) / Math.max(len, 0.01);
  const box = (a, b) => `left:${pct(a)}%;width:${Math.max(0.8, pct(Math.min(b, len) - a))}%`;
  const spans = clipSpans();
  const TY = P.text.typed;
  const cards = TY.on ? TY.cards : [];
  const capBlocks = !cards.length ? '' : TY.mode === 'scroll'
    ? `<button class="tclip cap" data-at="${cards[0].start}" style="${box(cards[0].start, cards[cards.length - 1].start + cards[cards.length - 1].dur)}">⇡ Scrolling text</button>`
    : cards.map((c, i) => `<button class="tclip cap" data-at="${c.start}" style="${box(c.start, c.start + c.dur)}" title="${esc(c.text)}">${i + 1}</button>`).join('');
  const lane = (arr, cls, label) => arr.map((x) => `<div class="lane ${cls}" style="left:${pct(x.start)}%;width:${Math.max(0.6, pct(Math.min(x.dur, len - x.start)))}%" title="${label}"></div>`).join('');
  return `<div class="splitbox tlbox">
    <div class="tlrow">
      <button class="btn tlplay" id="tlPlay" title="Play from the slider">${playing ? '■' : '▶'}</button>
      <span class="tltime"><b id="scrubV">${fmt(P.scrub)}</b> / ${fmt(len)} sec</span>
      <input type="range" id="scrub" min="0" max="${Math.max(0.1, len - 0.05).toFixed(2)}" step="0.05" value="${P.scrub}">
      <button class="chip on" id="splitHere" title="Cut the clip at the slider into two clips">✂ Split here</button>
    </div>
    <div class="tl" id="tl"><div class="tlin" id="tlin">
      <div class="lname">Captions</div>
      <div class="tlane">${capBlocks || '<span class="lempty">Type captions in the Text tab</span>'}</div>
      <div class="lname">B-roll <span>(your voice keeps playing)</span></div>
      <div class="tlane">${P.broll.map((b) => `<button class="tclip broll ${selClip === 'b:' + b.id ? 'sel' : ''}" data-bclip="${b.id}" style="${box(b.start, b.start + b.dur)}" title="${esc(b.name)}">${b.kind === 'video' ? volIcon(b.vol || 0) + ' ' : ''}${esc(b.name)}</button>`).join('') || '<span class="lempty">None yet</span>'}</div>
      <div class="lname">Main line</div>
      <div class="tlane main">
        ${spans.map((sp) => { const c = clipList()[sp.ci], tk = P.takes[sp.take], img = tk.kind === 'image'; return `<button class="tclip ${img ? 'photo' : 'video'} ${selClip === sp.ci ? 'sel' : ''}" data-clip="${sp.ci}" style="${box(sp.a, sp.b)}" title="${esc(tk.name)}">${img ? '🖼' : volIcon(c.vol ?? tk.vol ?? 1)} ${clipName(sp.ci)} · ${fmt(sp.b - sp.a)}s</button>`; }).join('')}
        ${VO() ? '' : spans.slice(1).map((sp) => { const k = joinKey(sp.r), kind = (P.trans.joins || {})[k] || P.trans.def || 'cut'; return `<button class="tdia ${kind !== 'cut' ? 'on' : ''}" data-dia="${k}" style="left:${pct(sp.a)}%" title="${TRANSITIONS[kind]}. Tap to change."></button>`; }).join('')}
      </div>
      ${P.effects.length || P.gfx.length ? `<div class="lanes small2">${lane(P.effects, 'lm', 'Mirror')}${lane(P.gfx, 'lg', 'Graphic')}</div>` : ''}
      <div class="playhead" id="playhead" style="left:${pct(P.scrub)}%"></div>
    </div>
    ${VO() ? '' : `<label class="tplus" title="Add a photo or video to the end">＋<input type="file" id="addMain" accept="image/*,video/*,.mov,.MOV,.heic" multiple hidden></label>`}
    </div>
    <div class="legend"><span class="dot" style="background:#0f8b8d"></span>Video <span class="dot" style="background:#e8a33d"></span>Photo <span class="dot" style="background:#bfe8d9"></span>B-roll <span class="dot" style="background:#a99be6"></span>Captions
      ${P.effects.length ? '<span class="dot" style="background:#8a63d2"></span>Mirror' : ''} ${P.gfx.length ? '<span class="dot" style="background:#1d2433"></span>Graphics' : ''}
      ${VO() || spans.length < 2 ? '' : '· tap ◆ for a transition'} · tap a clip to move, delete or set volume</div>
    ${clipPanelHTML(spans)}
  </div>`;
}
function shiftAfter(a, b) {
  const len = b - a;
  for (const arr of [P.broll, P.effects, P.gfx]) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const x = arr[i], end = x.start + x.dur;
      if (x.start >= b) x.start = +(x.start - len).toFixed(2);
      else if (end <= a) continue;
      else if (x.start >= a && end <= b) arr.splice(i, 1);
      else if (x.start < a) x.dur = +Math.max(0.2, (a - x.start) + Math.max(0, end - b)).toFixed(2);
      else { x.dur = +Math.max(0.2, end - b).toFixed(2); x.start = a; }
    }
  }
  P.splits = (P.splits || []).filter((t) => t <= a || t >= b).map((t) => (t >= b ? +(t - len).toFixed(2) : t));
}
function splitBind(len) {
  const pct = (t) => (100 * t) / Math.max(len, 0.01);
  const setScrub = (v, slider = true) => {
    P.scrub = Math.max(0, Math.min(len - 0.05, v));
    $('#scrubV').textContent = fmt(P.scrub); $('#playhead').style.left = pct(P.scrub) + '%';
    if (slider) $('#scrub').value = P.scrub;
    repaint();
  };
  $('#scrub').oninput = (e) => setScrub(+e.target.value, false);
  $('#scrub').onchange = () => save();
  $('#tlPlay').onclick = () => (playing ? stopPlaying() : play(P.scrub >= len - 0.15 ? 0 : P.scrub));
  $('#splitHere').onclick = () => {
    const snapBefore = snap();
    if (!splitAt(P.scrub)) { toast('Move the slider into the middle of a clip first (not right at its start or end).'); return; }
    undoStack.push(snapBefore); redoStack = []; syncUndo();
    const sp = clipSpans().find((x) => Math.abs(x.a - P.scrub) < 0.06); selClip = sp ? sp.ci : null;
    save(); render(); toast('Split into two clips. Tap either one to move or delete it.');
  };
  $('#tlin').onclick = (e) => {
    if (e.target.closest('button,label,input')) return;
    const r = $('#tlin').getBoundingClientRect();
    setScrub(((e.clientX - r.left) / r.width) * len);
    save();
  };
  document.querySelectorAll('[data-clip]').forEach((b) => (b.onclick = () => {
    const ci = +b.dataset.clip; selClip = selClip === ci ? null : ci;
    const sp = clipSpans().find((x) => x.ci === ci); if (sp) P.scrub = Math.min(sp.a + 0.05, len - 0.05);
    render();
  }));
  document.querySelectorAll('[data-bclip]').forEach((b) => (b.onclick = () => {
    const k = 'b:' + b.dataset.bclip; selClip = selClip === k ? null : k;
    const x = P.broll.find((y) => y.id === b.dataset.bclip); if (x) P.scrub = Math.min(x.start + 0.05, len - 0.05);
    render();
  }));
  document.querySelectorAll('[data-at]').forEach((b) => (b.onclick = () => { setScrub(+b.dataset.at + 0.05); save(); }));
  document.querySelectorAll('[data-dia]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.dia, cur = (P.trans.joins || {})[k] || P.trans.def || 'cut';
    const next = TRANS_CYCLE[(TRANS_CYCLE.indexOf(cur) + 1) % TRANS_CYCLE.length];
    remember(); P.trans.joins = { ...(P.trans.joins || {}), [k]: next };
    save(); render(); toast(`Transition: ${TRANSITIONS[next]}. Tap again for the next one.`, 2000);
    const at = clipSpans().find((x) => joinKey(x.r) === k); if (at) play(Math.max(0, at.a - 0.6), 1.6);
  }));
  if ($('#addMain')) $('#addMain').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      if (f.type.startsWith('image/') || /\.hei[cf]$/i.test(f.name)) await addPhotoTake(f);
      else if (await addTake(f, f.name, true) && P.cleaned) toast(`Added ${f.name}. It isn't cleaned yet. Go to Clean and press "Clean again" if you want its pauses cut.`, 6000);
    }
    selClip = clipList().length - 1; render();
  };
  // selected B-roll or clip
  const curB = () => P.broll.find((x) => 'b:' + x.id === selClip);
  const setVol = (v) => {
    remember();
    if (typeof selClip === 'string') { const b = curB(); if (b) b.vol = v; }
    else { const c = ensureClips()[selClip]; if (c) c.vol = v; }
    save();
  };
  if ($('#cpVol')) {
    $('#cpVol').oninput = (e) => { $('#cpVolV').textContent = e.target.value + '%'; };
    $('#cpVol').onchange = (e) => { setVol(+e.target.value / 100); render(); };
    $('#cpMute').onclick = () => {
      let cur;
      if (typeof selClip === 'string') cur = (curB() || {}).vol || 0;
      else { const c = clipList()[selClip]; cur = c.vol ?? P.takes[c.take].vol ?? 1; }
      setVol(cur ? 0 : 1); render();
    };
  }
  if ($('#cpClose')) $('#cpClose').onclick = () => { selClip = null; render(); };
  if ($('#cpBrollTab')) $('#cpBrollTab').onclick = () => { moveWhat = selClip; editTab = 'broll'; render(); };
  if (typeof selClip !== 'number') return;
  const ci = selClip, sp = clipSpans().find((x) => x.ci === ci);
  const move = (d) => {
    const cl = ensureClips(), j = ci + d; if (j < 0 || j >= cl.length) return;
    remember(); [cl[ci], cl[j]] = [cl[j], cl[ci]]; selClip = j; save(); render();
    toast('Moved. B-roll, captions, mirror and graphics stay at the same seconds, so check them.', 4000);
  };
  if ($('#cpLeft')) $('#cpLeft').onclick = () => move(-1);
  if ($('#cpRight')) $('#cpRight').onclick = () => move(1);
  if ($('#cpPlay')) $('#cpPlay').onclick = () => sp && play(sp.a, sp.b - sp.a);
  if ($('#cpSec')) $('#cpSec').onchange = (e) => setPhotoSec(clipList()[ci].take, +e.target.value);
  if ($('#cpDel')) $('#cpDel').onclick = () => {
    if (clipList().length < 2) { toast("That's your only clip. Remove takes in Record instead."); return; }
    if (!confirm(`Delete ${clipName(ci)}${sp ? ` (${fmt(sp.b - sp.a)} sec)` : ''}? Undo brings it back.`)) return;
    remember(); ensureClips().splice(ci, 1);
    if (sp) shiftAfter(sp.a, sp.b);
    selClip = null; save(); render(); toast('Deleted. Undo brings it back.');
  };
  if (!sp) return;
  $('#cpMirror').onchange = (e) => {
    if (!e.target.value) return;
    remember(); P.effects.push({ id: newId('e'), kind: e.target.value, start: +sp.a.toFixed(2), dur: +(sp.b - sp.a).toFixed(2) });
    save(); render(); toast('Mirrored this clip. Change it under Transitions & mirror.');
  };
  $('#cpCover').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const id = newId('b'); await store.put('blob:' + id, f); urls[id] = URL.createObjectURL(f);
    remember();
    const it = newBroll(id, f.type.startsWith('image/') ? 'image' : 'video', f.name, sp.a);
    it.dur = +(sp.b - sp.a).toFixed(2); it.layout = 'full'; it.anim = 'none';
    P.broll.push(it); P.broll.sort((x, y) => x.start - y.start); moveWhat = 'b:' + id;
    save(); render(); toast('B-roll covers this clip. Change it under B-roll.');
  };
  $('#cpLib').onclick = () => { pendingDur = +(sp.b - sp.a).toFixed(2); P.scrub = sp.a; editTab = 'broll'; libOpen = true; render(); toast('Tap a tile to cover the clip.'); };
}

// ---------- Typed captions (Text tab): for reels where the words do the work ----------
const TYPED_MODES = { whole: 'Spread across the whole reel', clip: 'Spread across one clip', scroll: 'Scroll up like a teleprompter' };
function typedHTML(len) {
  const TY = P.text.typed, spans = clipSpans();
  return `<div class="card">
    <div class="card-h"><label class="inline big-l"><input type="checkbox" data-k="text.typed.on" data-type="bool" data-re ${TY.on ? 'checked' : ''}> Type captions</label>
      <span class="sub">${TY.cards.length ? TY.cards.length + ' cards' : 'for reels with no talking'}</span></div>
    ${!TY.on ? '<p class="hint">For reading, reactions or B-roll where you\'re not talking and the words do the work.</p>' : `
    <textarea id="typedLines" placeholder="One line per caption card, e.g.&#10;Kids and dogs are *better than adults*&#10;You love being outside, especially *cartwheels*">${esc(TY.lines)}</textarea>
    <p class="hint">One line = one caption card. Put *stars* around words to make them yellow.${P.text.caps.on ? ' Your speech captions are on too; turn them off above if you only want these.' : ''}</p>
    <div class="row">
      <select id="typedMode">${Object.entries(TYPED_MODES).map(([k, n]) => `<option value="${k}" ${TY.mode === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      ${TY.mode === 'clip' ? `<select id="typedClip">${spans.map((sp) => `<option value="${sp.ci}" ${TY.clip === sp.ci ? 'selected' : ''}>${clipName(sp.ci)} (${fmt(sp.a)}–${fmt(sp.b)} sec)</option>`).join('')}</select>` : ''}
      <button class="big" id="typedMake" style="margin:0;font-size:15px;padding:10px 18px">${TY.cards.length ? 'Update caption cards' : 'Make caption cards'}</button>
    </div>
    ${TY.mode === 'scroll' ? '' : `<label class="inline">Animation <select data-k="text.typed.anim" data-type="str">${['pop', 'bounce', 'fade', 'none'].map((a) => `<option value="${a}" ${TY.anim === a ? 'selected' : ''}>${ANIMS[a]}</option>`).join('')}</select></label>`}
    ${TY.cards.length ? `<details class="more" ${TY.cards.length <= 6 ? 'open' : ''}><summary>Timing for each card (${TY.cards.length})</summary>
      ${TY.cards.map((c, i) => `<div class="row joinrow"><b style="min-width:24px">${i + 1}</b><span style="flex:1;min-width:160px">${esc(c.text)}</span>${timeRow('text.typed.cards', i, c)}</div>`).join('')}</details>` : ''}
    ${styleEditor('text.typed.style')}`}
  </div>`;
}
function makeTypedCards() {
  const TY = P.text.typed, len = reelLen();
  const lines = TY.lines.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { toast('Type at least one line first.'); return; }
  let a = 0, b = len;
  if (TY.mode === 'clip') { const sp = clipSpans().find((x) => x.ci === TY.clip) || clipSpans()[0]; if (sp) { a = sp.a; b = sp.b; } }
  else if (TY.mode === 'whole' && P.text.hook.on && (P.text.hook.text || P.hook)) a = Math.min(P.text.hook.dur, len / 2); // start after the hook
  const each = (b - a) / lines.length;
  remember();
  TY.cards = lines.map((text, i) => ({ id: newId('c'), text, start: +(a + i * each).toFixed(2), dur: +Math.max(0.3, each - 0.02).toFixed(2) }));
  P.scrub = Math.min(a + 0.1, len - 0.05);
  save(); render(); toast(`${lines.length} caption cards. Drag them into place with the Timing list, or tap them on the timeline.`);
}
function typedBind() {
  if (!$('#typedLines')) return;
  $('#typedLines').addEventListener('focus', () => remember(), { once: true });
  $('#typedLines').oninput = (e) => { P.text.typed.lines = e.target.value; save(); };
  $('#typedMode').onchange = (e) => { remember(); P.text.typed.mode = e.target.value; save(); render(); };
  if ($('#typedClip')) $('#typedClip').onchange = (e) => { P.text.typed.clip = +e.target.value; save(); };
  $('#typedMake').onclick = makeTypedCards;
  bindTimed();
}

// ---------- shared bits for timed items ----------
const newId = (p) => p + Date.now() + Math.random().toString(36).slice(2, 6);
function scrubBlock(len, hint) {
  if (!PHOTO()) return hint ? `<p class="hint">${hint}</p>` : '';
  return `<div class="scrub">
      <label>Slide <b id="scrubV">${Math.floor(P.scrub) + 1}</b></label>
      <input type="range" id="scrub" min="0" max="${Math.max(0, len - 1)}" step="1" value="${P.scrub}">
      ${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
}
function bindScrub() {
  if (!PHOTO()) return; // the timeline slider handles reels
  $('#scrub').oninput = (e) => { P.scrub = +e.target.value; $('#scrubV').textContent = PHOTO() ? Math.floor(P.scrub) + 1 : fmt(P.scrub); repaint(); };
  $('#scrub').onchange = () => { save(); render(); };
}
const timeRow = (arr, i, x) => `
  <label class="inline">Starts at <input type="number" class="num" min="0" step="0.1" value="${x.start}" data-k="${arr}.${i}.start" data-type="num"> sec</label>
  <button class="chip" data-now="${arr}.${i}">Use ${fmt(P.scrub)} sec</button>
  <label class="inline">for <input type="number" class="num" min="0.2" step="0.1" value="${x.dur}" data-k="${arr}.${i}.dur" data-type="num"> sec</label>
  <button class="chip" data-see="${x.start}">▶ See it</button>`;
function bindTimed() {
  document.querySelectorAll('[data-now]').forEach((b) => (b.onclick = () => { remember(); setPath(b.dataset.now + '.start', +P.scrub.toFixed(2)); save(); render(); }));
  document.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => play(Math.max(0, +b.dataset.see - 0.6), 2.6)));
}

// ---------- Transitions & mirror tab ----------
function transHTML(len) {
  const ranges = fullRanges();
  const tr = P.trans;
  let acc = 0;
  const joins = ranges.map((r) => { const at = acc; acc += r.end - r.start; return { r, at }; }).slice(1);
  return `${scrubBlock(len)}
  <div class="card">
    <div class="card-h"><b class="big-l">Transitions between cuts</b><span class="sub">${joins.length} cuts</span></div>
    ${VO() ? `<div class="note">Voice-over reels: transitions go between on-camera cuts, so they're off here. Mirror effects below still work.</div>` : `
    <p class="hint">Every place Clean cut something is a cut. Pick one look for all of them, then change any single cut below. Transitions don't add time: they play over the start of the next bit.</p>
    <label>For every cut</label>
    <div class="row">${Object.entries(TRANSITIONS).map(([k, n]) => `<button class="chip ${tr.def === k ? 'on' : ''}" data-set="trans.def" data-val="${k}">${n}</button>`).join('')}</div>
    <label>Length <b data-show="trans.dur">${tr.dur}</b> sec</label>
    <input type="range" min="0.1" max="0.8" step="0.05" value="${tr.dur}" data-k="trans.dur" data-type="num" data-live>
    ${joins.length ? `<details class="more" ${joins.length <= 6 ? 'open' : ''}><summary>Change a single cut (${joins.length})</summary>
      ${joins.map(({ r, at }) => `<div class="row joinrow"><b>${fmt(at)} sec</b>
        <select data-join="${joinKey(r)}"><option value="">Same as all (${TRANSITIONS[tr.def]})</option>${Object.entries(TRANSITIONS).map(([k, n]) => `<option value="${k}" ${(tr.joins || {})[joinKey(r)] === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button class="chip" data-see="${at}">▶ See it</button></div>`).join('')}</details>` : '<p class="sub">No cuts yet. Run Clean first.</p>'}`}
  </div>
  <div class="card">
    <div class="card-h"><b class="big-l">Zoom and mirror effects</b></div>
    <p class="hint">Zoom in on your face, or mirror and repeat your image, for a beat or the whole reel. Text, B-roll and graphics stay on top.</p>
    <div class="row"><button class="chip on" id="zoomHook">🔍 Zoom hook: close-up on your first line</button></div>
    <div class="row">${Object.entries(MIRRORS).map(([k, n]) => `<button class="chip" data-addfx="${k}">＋ ${n}</button>`).join('')}</div>
    ${P.effects.map((e, i) => `<div class="card inner">
      <div class="card-h"><select data-k="effects.${i}.kind" data-type="str">${Object.entries(MIRRORS).map(([k, n]) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <span><button class="chip" data-fxall="${i}">Whole reel</button><button class="x" data-fxdel="${i}" title="Remove">✕</button></span></div>
      <div class="row">${timeRow('effects', i, e)}</div></div>`).join('') || ''}
  </div>`;
}
function transBind() {
  bindScrub(); bindInputs(); bindTimed();
  document.querySelectorAll('[data-join]').forEach((sel) => (sel.onchange = () => {
    remember(); P.trans.joins = P.trans.joins || {};
    if (sel.value) P.trans.joins[sel.dataset.join] = sel.value; else delete P.trans.joins[sel.dataset.join];
    save(); repaint();
  }));
  document.querySelectorAll('[data-addfx]').forEach((b) => (b.onclick = () => {
    remember(); P.effects.push({ id: newId('e'), kind: b.dataset.addfx, start: +P.scrub.toFixed(2), dur: 2 }); save(); render();
  }));
  if ($('#zoomHook')) $('#zoomHook').onclick = () => {
    remember(); P.effects = P.effects.filter((e) => !(e.kind === 'punch' && e.start === 0));
    P.effects.push({ id: newId('e'), kind: 'punch', start: 0, dur: 1.5 }); P.scrub = 0.5; save(); render(); toast('Close-up added for the first 1.5 seconds. Drag the times to change it.');
  };
  document.querySelectorAll('[data-fxall]').forEach((b) => (b.onclick = () => { remember(); Object.assign(P.effects[+b.dataset.fxall], { start: 0, dur: +reelLen().toFixed(2) + 1 }); save(); render(); }));
  document.querySelectorAll('[data-fxdel]').forEach((b) => (b.onclick = () => { remember(); P.effects.splice(+b.dataset.fxdel, 1); save(); render(); }));
}

// ---------- Graphics & stamps tab ----------
const GANIM = { pop: 'Pop in', slam: 'Stamp slam', draw: 'Draw on', fade: 'Fade in', none: 'None' };
const gIcon = { stampCheck: '✅', stampX: '❌', check: '✔', cross: '✖', arrow: '➜', circle: '◯', underline: '﹏', sparkle: '✨', star: '💥', emoji: '😀', logo: '🟢', png: '🖼' };
function gfxHTML(len) {
  const LG = { ...defaultSettings().logo, ...(S.logo || {}) };
  return `${scrubBlock(len, 'Move the slider to the moment, tap a graphic to add it there, then drag it on the preview.')}
  <div class="card">
    <div class="card-h"><label class="inline big-l" style="margin:0"><input type="checkbox" id="logoOn" ${LG.on ? 'checked' : ''}> HealthQuest logo on every reel</label><span class="sub">applies to all reels</span></div>
    ${LG.on ? `<div class="row">
      <label class="inline">Corner <select id="logoCorner">${[['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']].map(([k, n]) => `<option value="${k}" ${LG.corner === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="inline">Size <input type="range" id="logoSize" min="0.08" max="0.3" step="0.01" value="${LG.size}"></label>
      <label class="inline">See-through <input type="range" id="logoOp" min="0.3" max="1" step="0.05" value="${LG.opacity}"></label>
      <label class="inline"><input type="checkbox" id="logoHere" ${P.logoOn === false ? 'checked' : ''}> Hide it on this reel only</label></div>
      <p class="hint">Top and bottom spots stay clear of Instagram's and TikTok's buttons and your captions. Check the preview.</p>` : ''}
  </div>
  <div class="gpal">${Object.entries(GFX).filter(([k]) => k !== 'png').map(([k, n]) => `<button class="gbtn" data-gadd="${k}"><span>${gIcon[k]}</span>${n}</button>`).join('')}
    <label class="gbtn" style="cursor:pointer"><span>🖼</span>Upload PNG<input type="file" id="gpng" accept="image/png,image/*" hidden></label></div>
  <h3 style="margin-top:20px">In this reel (${P.gfx.length})</h3>
  ${P.gfx.map((g, i) => {
    const sel = moveWhat === 'g:' + g.id;
    return `<div class="card">
    <div class="card-h"><button class="namebtn" data-gsel="${g.id}">${sel ? '▾' : '▸'} ${gIcon[g.type]} ${GFX[g.type]}${g.text ? ` "${esc(g.text)}"` : ''} <span class="sub">${fmt(g.start)}–${fmt(g.start + g.dur)} sec</span></button>
      <span><button class="x" data-gdup="${i}" title="Duplicate">⧉</button><button class="x" data-gdel="${i}" title="Remove">✕</button></span></div>
    ${!sel ? '' : `<div class="row">${timeRow('gfx', i, g)}</div>
      ${['stampCheck', 'stampX', 'star'].includes(g.type) ? `<label class="inline">Word on it (optional) <input type="text" class="short" data-k="gfx.${i}.text" data-type="str" data-live value="${esc(g.text)}" placeholder="${g.type === 'stampX' ? 'MYTH' : g.type === 'stampCheck' ? 'FACT' : 'NEW!'}"></label>` : ''}
      ${g.type === 'emoji' ? `<label class="inline">Emoji <input type="text" class="short" data-k="gfx.${i}.text" data-type="str" data-live value="${esc(g.text)}" placeholder="🔥"></label>` : ''}
      <div class="row"><label class="inline">Animation <select data-k="gfx.${i}.anim" data-type="str">${Object.entries(GANIM).map(([k, n]) => `<option value="${k}" ${g.anim === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <label>Size <b data-show="gfx.${i}.size">${Math.round(g.size * 100)}</b>%</label>
      <input type="range" min="0.08" max="0.9" step="0.01" value="${g.size}" data-k="gfx.${i}.size" data-type="num" data-live data-pct>
      <label>Rotate <b data-show="gfx.${i}.rot">${g.rot}</b>°</label>
      <input type="range" min="-180" max="180" step="1" value="${g.rot}" data-k="gfx.${i}.rot" data-type="num" data-live>
      ${['logo', 'png', 'emoji'].includes(g.type) ? '' : `<label>Color</label>${swatches(`gfx.${i}.color`, g.color)}`}`}
  </div>`;
  }).join('') || '<p class="sub">No graphics yet.</p>'}`;
}
function gfxBind() {
  bindScrub(); bindInputs(); bindTimed();
  const setLogo = async (k, v, re = true) => { S.logo = { ...defaultSettings().logo, ...(S.logo || {}), [k]: v }; await saveSettings(); re ? render() : repaint(); };
  $('#logoOn').onchange = (e) => setLogo('on', e.target.checked);
  if ($('#logoCorner')) {
    $('#logoCorner').onchange = (e) => setLogo('corner', e.target.value);
    $('#logoSize').oninput = (e) => setLogo('size', +e.target.value, false);
    $('#logoOp').oninput = (e) => setLogo('opacity', +e.target.value, false);
    $('#logoHere').onchange = (e) => { P.logoOn = e.target.checked ? false : true; save(); repaint(); };
  }
  document.querySelectorAll('[data-gadd]').forEach((b) => (b.onclick = () => {
    remember();
    const g = newGfx(newId('g'), b.dataset.gadd, P.scrub, b.dataset.gadd === 'emoji' ? { text: '🔥' } : {});
    if (PHOTO()) { g.start = Math.floor(P.scrub); g.dur = 1; }
    P.gfx.push(g); moveWhat = 'g:' + g.id; if (!PHOTO()) P.scrub = Math.min(P.scrub + 0.5, reelLen() - 0.05); save(); render();
  }));
  $('#gpng').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const id = newId('g'); await store.put('blob:' + id, f); urls[id] = URL.createObjectURL(f);
    remember(); P.gfx.push(newGfx(id, 'png', P.scrub, { name: f.name })); moveWhat = 'g:' + id; save(); render();
  };
  document.querySelectorAll('[data-gsel]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.gsel; const g = P.gfx.find((x) => x.id === id);
    moveWhat = moveWhat === 'g:' + id ? '' : 'g:' + id;
    if (moveWhat) P.scrub = Math.min(g.start + Math.min(0.5, g.dur / 2), reelLen() - 0.05);
    render();
  }));
  document.querySelectorAll('[data-gdel]').forEach((b) => (b.onclick = () => { remember(); P.gfx.splice(+b.dataset.gdel, 1); save(); render(); }));
  document.querySelectorAll('[data-gdup]').forEach((b) => (b.onclick = () => {
    const g = P.gfx[+b.dataset.gdup]; const id = newId('g');
    if (g.type === 'png') { urls[id] = urls[g.id]; store.get('blob:' + g.id).then((bl) => store.put('blob:' + id, bl)); }
    remember(); P.gfx.push({ ...g, id, start: +(g.start + g.dur).toFixed(2) }); moveWhat = 'g:' + id; save(); render();
  }));
}

// ---------- B-roll library ----------
let libCat = 'All', libSearch = '', libOpen = true, libEditing = null;
function libraryHTML() {
  const lib = L.library();
  if (!lib) return '<p class="sub">Loading your library…</p>';
  const q = libSearch.toLowerCase();
  const shown = lib.items.filter((it) => (libCat === 'All' || it.cats.includes(libCat)) && (!q || it.name.toLowerCase().includes(q)));
  const count = (c) => lib.items.filter((it) => it.cats.includes(c)).length;
  const upCat = libCat !== 'All' ? libCat : lib.cats[0] || '';
  return `
  <details class="card lib" id="libBox" ${libOpen ? 'open' : ''}>
    <summary><b>📚 B-roll library</b> <span class="sub">${lib.items.length} saved · kept for every reel</span></summary>
    <div class="row" style="margin-top:10px">
      <label class="btn" style="margin:0;cursor:pointer">⬆ Add to library<input type="file" id="libUp" accept="image/*,video/*,.mov,.MOV,.heic" multiple hidden></label>
      <label class="inline" style="margin-top:0">into <select id="libUpCat">${lib.cats.map((c) => `<option ${c === upCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">＋ New category…</option></select></label>
      <input type="text" id="libSearch" class="short" placeholder="Search by name" value="${esc(libSearch)}">
    </div>
    <div class="row cats">
      <button class="chip ${libCat === 'All' ? 'on' : ''}" data-cat="All">All (${lib.items.length})</button>
      ${lib.cats.map((c) => `<button class="chip ${libCat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)} (${count(c)})</button>`).join('')}
      <button class="chip" id="catAdd">＋ Category</button><button class="chip" id="catEdit">✎ Edit categories</button>
    </div>
    <div class="libgrid">${shown.map((it) => `
      <div class="tile">
        <button class="thumb" data-libadd="${it.id}" title="Add to this reel at ${fmt(P.scrub)} sec">
          ${it.kind === 'image' ? `<img src="${L.libUrl(it.id)}" loading="lazy">` : `<video src="${L.libUrl(it.id)}#t=0.5" muted preload="metadata"></video><span class="play">▶</span>`}</button>
        <div class="tname" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="tcats">${it.cats.map(esc).join(' · ') || '<i>no category</i>'}</div>
        <div class="tact"><button class="x" data-libcat="${it.id}" title="Categories">🏷</button><button class="x" data-libren="${it.id}" title="Rename">✎</button><button class="x" data-libdel="${it.id}" title="Delete from library">✕</button></div>
        ${libEditing === it.id ? `<div class="catpick">${lib.cats.map((c) => `<label><input type="checkbox" data-itcat="${esc(c)}" ${it.cats.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}<button class="chip on" id="catDone">Done</button></div>` : ''}
      </div>`).join('') || `<p class="sub">${lib.items.length ? 'Nothing here yet.' : 'Upload the B-roll you reuse (reactions, typing at night, screen recordings, the books) and sort it into categories.'}</p>`}</div>
    ${shown.length ? `<p class="hint">Tap a tile to add it to this reel at ${fmt(P.scrub)} sec.</p>` : ''}
  </details>`;
}
async function newCategory() {
  const c = (prompt('New category name:') || '').trim();
  if (!c) return null;
  const lib = L.library();
  if (!lib.cats.includes(c)) await L.setCats([...lib.cats, c]);
  return c;
}
function libraryBind() {
  const box = $('#libBox'); if (!box) return;
  box.ontoggle = () => { libOpen = box.open; };
  $('#libUp').onchange = async (e) => {
    let cat = $('#libUpCat').value;
    if (cat === '__new') { cat = await newCategory(); if (!cat) return; }
    for (const f of e.target.files) await L.addToLibrary(f, f.name, [cat]);
    toast(`Added ${e.target.files.length} to "${cat}".`); libCat = cat; render();
  };
  $('#libUpCat').onchange = async (e) => { if (e.target.value === '__new') { const c = await newCategory(); if (c) libCat = c; render(); } };
  $('#libSearch').oninput = (e) => { libSearch = e.target.value; const pos = e.target.selectionStart; render(); const el = $('#libSearch'); el.focus(); el.setSelectionRange(pos, pos); };
  document.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { libCat = b.dataset.cat; render(); }));
  $('#catAdd').onclick = async () => { const c = await newCategory(); if (c) { libCat = c; render(); } };
  $('#catEdit').onclick = async () => {
    const v = prompt('Your categories, separated by commas. Rename or delete here (items keep the ones that still exist):', L.library().cats.join(', '));
    if (v == null) return;
    await L.setCats(v.split(',')); if (!L.library().cats.includes(libCat)) libCat = 'All'; render();
  };
  document.querySelectorAll('[data-libadd]').forEach((b) => (b.onclick = async () => {
    const it = L.library().items.find((x) => x.id === b.dataset.libadd);
    const id = 'b' + Date.now() + Math.random().toString(36).slice(2, 6);
    await store.put('blob:' + id, await L.libBlob(it.id)); urls[id] = L.libUrl(it.id);
    remember();
    const item = newBroll(id, it.kind, it.name, P.scrub); item.lib = true;
    if (pendingDur) { item.dur = pendingDur; item.layout = 'full'; item.anim = 'none'; pendingDur = null; }
    P.broll.push(item); P.broll.sort((a, c) => a.start - c.start); moveWhat = 'b:' + id;
    save(); render(); toast(`Added "${it.name}" at ${fmt(item.start)} sec.`);
  }));
  document.querySelectorAll('[data-libdel]').forEach((b) => (b.onclick = async () => {
    const it = L.library().items.find((x) => x.id === b.dataset.libdel);
    if (!confirm(`Delete "${it.name}" from your library? Reels that already use it keep their copy.`)) return;
    await L.removeFromLibrary(it.id); render();
  }));
  document.querySelectorAll('[data-libren]').forEach((b) => (b.onclick = async () => {
    const it = L.library().items.find((x) => x.id === b.dataset.libren);
    const n = prompt('New name:', it.name); if (n) { await L.renameItem(it.id, n.trim()); render(); }
  }));
  document.querySelectorAll('[data-libcat]').forEach((b) => (b.onclick = () => { libEditing = libEditing === b.dataset.libcat ? null : b.dataset.libcat; render(); }));
  if (libEditing) {
    document.querySelectorAll('[data-itcat]').forEach((cb) => (cb.onchange = async () => {
      const cats = [...document.querySelectorAll('[data-itcat]')].filter((x) => x.checked).map((x) => x.dataset.itcat);
      await L.setItemCats(libEditing, cats);
    }));
    $('#catDone').onclick = () => { libEditing = null; render(); };
  }
}

// drag text on the preview
let dragging = false;
function dragTo(e) {
  const r = cv.getBoundingClientRect();
  const x = Math.min(0.95, Math.max(0.05, (e.clientX - r.left) / r.width));
  const y = Math.min(0.95, Math.max(0.05, (e.clientY - r.top) / r.height));
  const target = moveWhat.startsWith('b:') ? P.broll.find((b) => 'b:' + b.id === moveWhat)
    : moveWhat.startsWith('g:') ? P.gfx.find((g) => 'g:' + g.id === moveWhat) : P.text[moveWhat];
  if (!target) return;
  target.x = Math.abs(x - 0.5) < 0.04 ? 0.5 : x; // snap to center
  target.y = y;
  repaint();
}
cv.addEventListener('pointerdown', (e) => {
  if (P.step !== 4 || editTab === 'trans') return;
  if (editTab === 'gfx' && !moveWhat.startsWith('g:')) return;
  if (editTab === 'text' && /^[bg]:/.test(moveWhat)) moveWhat = 'caps';
  if (editTab === 'broll' && !moveWhat.startsWith('b:')) return;
  remember(); dragging = true; cv.setPointerCapture(e.pointerId); dragTo(e);
});
cv.addEventListener('pointermove', (e) => dragging && dragTo(e));
cv.addEventListener('pointerup', () => { if (dragging) { dragging = false; save(); } });

// ---------- Step 5: Export ----------
function exportStep() {
  const parts = P.split ? [1, 2] : [0];
  const lens = parts.map((p) => total(partRanges(p)));
  const mime = pickMime();
  panel.innerHTML = `
    <h1>Export</h1>
    <p class="sub">MP4, 9:16, 1080×1920. Works for Instagram, Facebook, TikTok and YouTube Shorts. No music; add that later in Canva or the app.</p>
    ${!P.takes.length ? '<div class="note bad">Record a take first.</div>' : ''}
    ${!P.cleaned && P.takes.length ? '<div class="note">You haven\'t cleaned this yet. You can still export, but pauses and repeats stay in.</div>' : ''}
    ${VO() && !P.visuals.length ? '<div class="note bad">Voice-over mode: add photos, clips or screen recordings in Step 2, or the video will be black.</div>' : ''}
    ${mime && !mime.startsWith('video/mp4') ? '<div class="note">This Chrome can\'t save MP4, so it will save WebM. Update Chrome (Settings → About Chrome) to get MP4.</div>' : ''}
    ${parts.map((p, k) => {
      const over = lens[k] >= 30;
      const label = p ? `Part ${p}` : 'Your reel';
      return `<div class="note ${over ? 'bad' : 'ok'}"><b>${label}: ${fmt(lens[k])} sec</b>
        ${over ? `<br>Reels need to be under 30 sec. <button class="btn" data-back="1">Go back and split it</button>`
               : `<br><button class="big" data-exp="${p}" ${P.takes.length ? '' : 'disabled'}>⬇ Export ${label} (MP4)</button>`}</div>`;
    }).join('')}
    <div class="progress"><div id="bar"></div></div><div id="status" class="sub"></div>
    <h3>Cover image ${tip('Pick the frame people see before they tap play.')}</h3>
    <div class="cover-strip" id="covers"><span class="sub">Loading frames…</span></div>
    <button class="btn" id="coverDl">⬇ Download cover image</button>
    <div class="next"><button class="btn" id="back4">← Edit</button><span class="sub">Post cards come in a later update.</span></div>`;
  $('#back4').onclick = () => go(4);
  document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => go(3)));
  document.querySelectorAll('[data-exp]').forEach((b) => (b.onclick = () => doExport(+b.dataset.exp)));
  $('#coverDl').onclick = downloadCover;
  buildCovers();
}

async function doExport(part) {
  const ranges = partRanges(part);
  if (total(ranges) >= 30) { toast('Over 30 sec. Split it first.'); return; }
  stopCamera();
  document.querySelectorAll('[data-exp]').forEach((b) => (b.disabled = true));
  setStatus('Exporting… this plays through once, so it takes about as long as the reel.', 0);
  try {
    const opts = { overlay: await makeOverlay(part), comp: makeComp(part, ranges), vols: P.takes.map((t) => t.vol ?? 1) };
    if (VO() && P.visuals.length) {
      opts.track = makeTrack();
      opts.offset = part === 2 ? total(partRanges(1)) : 0;
    }
    const { blob, ext } = await renderReel(P.takes.map((t) => urls[t.id]), ranges, (p) => setStatus(`Exporting… ${Math.round(p * 100)}%`, p), opts);
    const name = `${(P.title || 'reel').replace(/[^\w\- ]+/g, '').trim() || 'reel'}${part ? ' - Part ' + part : ''}.${ext}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    window.__lastExport = { size: blob.size, type: blob.type, name };
    setStatus(`Done! Saved "${name}" to your Downloads.`, 1);
    if (P.status !== 'Posted') { P.status = 'Edited'; save(); }
  } catch (e) {
    setStatus('Export stopped: ' + e.message);
  }
  document.querySelectorAll('[data-exp]').forEach((b) => (b.disabled = false));
}

async function buildCovers() {
  const box = $('#covers'); if (!box) return;
  const ranges = fullRanges();
  if (!ranges.length) { box.innerHTML = ''; return; }
  const len = total(ranges), picks = [];
  for (let k = 0; k < 8; k++) {
    let at = (len * (k + 0.5)) / 8;
    for (const r of ranges) { const d = r.end - r.start; if (at <= d) { picks.push({ take: r.take, t: r.start + at }); break; } at -= d; }
  }
  picks.forEach((p, k) => (p.out = (len * (k + 0.5)) / 8));
  const ov = await makeOverlay(0);
  if (P.coverTime == null) P.coverTime = picks[0];
  const track = VO() && P.visuals.length ? makeTrack() : null;
  if (track) await track.load();
  const coverCanvas = async (p) => {
    let c;
    if (!track) c = await frameAt(urls[P.takes[p.take].id], p.t);
    else { c = document.createElement('canvas'); c.width = W; c.height = H; await track.still(c.getContext('2d'), p.out ?? 0); }
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    makeComp(0, fullRanges(), true).frame(out.getContext('2d'), (x) => x.drawImage(c, 0, 0), p.out ?? 0, 0, 1);
    await ov.prepare(p.out ?? 0); ov(out.getContext('2d'), p.out ?? 0, null);
    return out;
  };
  coverCanvasFn = coverCanvas;
  box.innerHTML = '';
  for (const p of picks) {
    const c = await coverCanvas(p);
    const img = new Image(); img.src = c.toDataURL('image/jpeg', 0.6);
    img.className = P.coverTime && P.coverTime.take === p.take && Math.abs(P.coverTime.t - p.t) < 0.01 ? 'on' : '';
    img.onclick = () => { P.coverTime = p; save(); box.querySelectorAll('img').forEach((x) => x.classList.remove('on')); img.classList.add('on'); };
    if (!$('#covers')) return;
    box.appendChild(img);
  }
}
let coverCanvasFn = null;
async function downloadCover() {
  const p = P.coverTime; if (!p) return;
  const c = coverCanvasFn ? await coverCanvasFn(p) : await frameAt(urls[P.takes[p.take].id], p.t);
  c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${P.title || 'reel'} - cover.png`; a.click(); }, 'image/png');
}

// ---------- Step 6: Post (later update) ----------
let S = defaultSettings();
async function saveSettings() { await store.put('settings', S); }
function post() {
  if (!P.postDate) P.postDate = nextReelDay();
  const tm = timesFor(S, P.postDate);
  const day = new Date(P.postDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const closers = S.closers;
  const caps = buildCaptions(S, { body: P.caption, closer: P.closer >= 0 ? closers[P.closer] : '', title: P.ytTitle || P.title, hook: P.hook, date: P.postDate });
  const done = PLATFORMS.filter((pl) => P.posted[pl.key]).length;
  const tester = S.testerOn && P.postDate <= S.testerEnd;
  panel.innerHTML = `
    <h1>Post</h1>
    <p class="sub">Write your caption once. Each platform gets its own version with the right link, hashtags and sign-off. You post by hand; nothing connects to your accounts.</p>
    <div class="row">
      <label class="inline" style="margin-top:0">Posting on <input type="date" id="pdate" value="${P.postDate}"></label>
      <span class="sub">${day}${tm.usual ? '' : ' · not a usual reel day, so Thursday times are used'}</span>
    </div>
    ${tester ? `<div class="note">Tester line is on until ${new Date(S.testerEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. After that it drops off by itself.</div>` : ''}
    <label>Your caption</label>
    <div class="row" style="margin:-2px 0 8px">
      <button class="chip" id="capSaid" ${P.cleaned && P.transcript ? '' : 'disabled title="Needs the transcript from Clean"'}>✨ Fill from what I said</button>
      <button class="chip" id="capScript" ${P.script.trim() ? '' : 'disabled title="No script on this reel"'}>📝 Fill from my script</button>
      ${calNote() ? `<span class="hint" style="margin:0">Calendar note: ${esc(calNote())}</span>` : ''}
    </div>
    <textarea id="pcap" placeholder="What happened, in your words. A short story, then why it matters. Hashtags and links get added for you.">${esc(P.caption)}</textarea>
    <div class="row">
      <label class="inline">Closer <select id="pcloser"><option value="-1">None</option>${closers.map((c, i) => `<option value="${i}" ${+P.closer === i ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    </div>
    <label>YouTube title</label>
    <input type="text" id="ptitle" maxlength="100" value="${esc(P.ytTitle || caps.ytTitle)}">
    <div class="postbar"><b>${done} of ${PLATFORMS.length} posted</b>${done === PLATFORMS.length ? ' 🎉 All done. This reel is marked Posted.' : ''}</div>
    <div class="pgrid">${PLATFORMS.map((pl) => {
      const txt = P.capEdits[pl.key] ?? caps[pl.key];
      const t = tm[pl.time];
      return `<div class="pcard ${P.posted[pl.key] ? 'done' : ''}">
        <div class="card-h"><b>${pl.icon} ${pl.name}</b><span class="ptime">⏰ ${fmtTime(t)}</span></div>
        <ul class="rules">${rulesFor(pl.key, S).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${pl.key === 'yt' ? `<div class="yttitle"><b>Title:</b> ${esc(P.ytTitle || caps.ytTitle)} <button class="chip" data-copytxt="${esc(P.ytTitle || caps.ytTitle)}">Copy title</button></div>` : ''}
        <textarea class="ptext" data-pcap="${pl.key}">${esc(txt)}</textarea>
        <div class="row"><button class="big pcopy" data-copy="${pl.key}">Copy caption</button>
          ${P.capEdits[pl.key] != null ? `<button class="chip" data-reset="${pl.key}">Reset to template</button>` : ''}
          <span class="sub">${txt.length} chars</span>
          <label class="inline"><input type="checkbox" data-posted="${pl.key}" ${P.posted[pl.key] ? 'checked' : ''}> Posted</label></div>
      </div>`;
    }).join('')}</div>
    <details class="more"><summary>Settings: post times, links, sign-off, closers, hashtags</summary>
      <p class="hint">These apply to every reel. Times are Central.</p>
      <table class="ttable"><tr><th></th><th>YouTube</th><th>Instagram + FB Page</th><th>TikTok</th></tr>
        ${[[2, 'Tue'], [3, 'Wed'], [4, 'Thu']].map(([d, n]) => `<tr><td><b>${n}</b></td>${['yt', 'meta', 'tt'].map((k) => `<td><input type="time" data-st="times.${d}.${k}" value="${S.times[d][k]}"></td>`).join('')}</tr>`).join('')}
      </table>
      <label class="inline">Facebook personal, every reel day <input type="time" data-st="fbMe" value="${S.fbMe}"></label>
      <label>Main link</label><input type="text" data-st="mainLink" value="${esc(S.mainLink)}">
      <label class="inline"><input type="checkbox" data-st="testerOn" ${S.testerOn ? 'checked' : ''}> Add the tester line until <input type="date" data-st="testerEnd" value="${S.testerEnd}"></label>
      <label>Tester line</label><input type="text" data-st="testerLine" value="${esc(S.testerLine)}">
      <label>Tester sign-up link (Facebook)</label><input type="text" data-st="testerLink" value="${esc(S.testerLink)}">
      <label>Sign-off (Instagram and Facebook only)</label><input type="text" data-st="signoff" value="${esc(S.signoff)}">
      <label>Closers (one per line)</label><textarea data-st="closers">${esc(S.closers.join('\n'))}</textarea>
      <label>Hashtags (Instagram and TikTok use the first 5, Facebook and YouTube the first 3)</label><input type="text" data-st="hashtags" value="${esc(S.hashtags)}">
      <label>Instagram Collab partner</label><input type="text" data-st="collab" value="${esc(S.collab || '')}" placeholder="@healthquestapp">
      <label>Personal Instagram to tag</label><input type="text" data-st="igTag" value="${esc(S.igTag || '')}" placeholder="@yourname">
      <label>Personal Facebook to tag</label><input type="text" data-st="fbTag" value="${esc(S.fbTag || '')}" placeholder="Your name on Facebook">
    </details>
    <div class="next"><button class="btn" id="back5">← Export</button><span class="sub">Status: <b>${P.status}</b></span></div>`;

  $('#back5').onclick = () => go(5);
  $('#pdate').onchange = (e) => { P.postDate = e.target.value; save(); render(); };
  let capTimer;
  const fillCap = (txt) => {
    if (!txt) return;
    if (P.caption.trim() && !confirm('Replace the caption you already have?')) return;
    P.caption = txt; save(); render();
    if (/\[[^\]]+\]/.test(txt)) toast('Your caption still has [brackets]. Fill them in before you copy it.', 5000);
  };
  if ($('#capSaid')) $('#capSaid').onclick = () => fillCap(captionFromSpeech());
  if ($('#capScript')) $('#capScript').onclick = () => fillCap(captionFromScript());
  $('#pcap').oninput = (e) => { P.caption = e.target.value; save(); clearTimeout(capTimer); capTimer = setTimeout(refreshCaps, 300); };
  $('#pcloser').onchange = (e) => { P.closer = +e.target.value; save(); render(); };
  $('#ptitle').oninput = (e) => { P.ytTitle = e.target.value; save(); };
  $('#ptitle').onchange = () => render();
  document.querySelectorAll('[data-pcap]').forEach((t) => (t.oninput = () => { P.capEdits[t.dataset.pcap] = t.value; save(); }));
  document.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => { delete P.capEdits[b.dataset.reset]; save(); render(); }));
  const copy = async (txt, btn) => {
    try { await navigator.clipboard.writeText(txt); } catch { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = old), 1400);
  };
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(document.querySelector(`[data-pcap="${b.dataset.copy}"]`).value, b)));
  document.querySelectorAll('[data-copytxt]').forEach((b) => (b.onclick = () => copy(b.dataset.copytxt, b)));
  document.querySelectorAll('[data-posted]').forEach((cb) => (cb.onchange = () => {
    P.posted[cb.dataset.posted] = cb.checked;
    const all = PLATFORMS.every((pl) => P.posted[pl.key]);
    if (all) P.status = 'Posted'; else if (P.status === 'Posted') P.status = 'Edited';
    save(); render();
  }));
  document.querySelectorAll('[data-st]').forEach((el) => (el.onchange = async () => {
    const k = el.dataset.st;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'closers') v = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const ks = k.split('.'); const last = ks.pop(); ks.reduce((o, x) => o[x], S)[last] = v;
    await saveSettings(); render();
  }));
}
// Caption drafts from her own words: what she said (after Clean) or her script. No AI, no rewriting.
const FILLER = /^(um+|uh+|erm|hmm+|like,?|you know,?)$/i;
function sentences(txt) { return (txt.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g) || []).map((x) => x.trim()).filter(Boolean); }
function tidy(arr, max) {
  const out = []; let n = 0;
  for (const x of arr) { const w = x.split(' ').length; if (out.length && n + w > max) break; out.push(x[0].toUpperCase() + x.slice(1)); n += w; }
  return out.join(' ');
}
function captionFromSpeech() {
  const words = outWords(P.items, P.takes, fullRanges()).map((w) => w.text.trim()).filter((t) => t && !FILLER.test(t));
  const txt = words.join(' ').replace(/\s+([,.!?])/g, '$1');
  const s = sentences(txt);
  return tidy(s, 70) + (s.length > 1 ? '' : '');
}
function captionFromScript() {
  const lines = P.script.replace(/^ON SCREEN[^:]*:\s*/i, '').replace(/Part 2 next\.?|Part 2 tomorrow\.?/gi, '');
  return tidy(sentences(lines), 70);
}
function calNote() { const ce = CAL.entries.find((x) => x.id === P.calId); return ce ? ce.notes : ''; }

// Update the platform captions while typing without losing focus.
function refreshCaps() {
  const caps = buildCaptions(S, { body: P.caption, closer: P.closer >= 0 ? S.closers[P.closer] : '', title: P.ytTitle || P.title, hook: P.hook, date: P.postDate });
  document.querySelectorAll('[data-pcap]').forEach((t) => {
    if (P.capEdits[t.dataset.pcap] != null) return;
    t.value = caps[t.dataset.pcap];
    const n = t.parentElement.querySelector('.row .sub'); if (n) n.textContent = t.value.length + ' chars';
  });
}

// ---------- start ----------
(async function init() {
  try {
    reelIndex = (await store.get('reelIndex')) || {};
    CAL = (await store.get('calendar')) || { entries: [] };
    let cur = await store.get('currentReel');
    let saved = cur ? await store.get('reel:' + cur) : null;
    if (!saved) {
      const old = await store.get('project'); // from before reels had ids
      if (old) { saved = old; if (!saved.id) saved.id = 'r' + Date.now(); await store.del('project'); }
    }
    if (saved) P = hydrate(saved);
    await loadUrls();
    presets = (await store.get('presets')) || [];
    await L.loadLibrary();
    const st = await store.get('settings');
    if (st) S = { ...defaultSettings(), ...st, times: { ...defaultSettings().times, ...(st.times || {}) } };
    if (P.postDate) calCursor = P.postDate;
  } catch (e) { console.warn(e); }
  if (P.step === 2) P.step = P.takes.length ? 3 : 2;
  syncUndo(); render(); save();
})();
