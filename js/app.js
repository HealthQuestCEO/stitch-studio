import * as store from './store.js';
import { decodeClip, to16kMono, speechRuns } from './audio.js';
import { buildItems, markPauses, markRepeats, keptRanges, total, suggestSplit, outWords } from './clean.js';
import { renderReel, frameAt, pickMime, drawCover, W, H } from './export.js';
import { drawText, chunks, ready, defaultText, FONTS, BRAND, MY_STYLE, loadFont, loadAllFonts } from './text.js';
import { loadSegmenter, drawPerson, segmenterFailed } from './segment.js';
import { BrollLayer, FRAMES, newBroll } from './broll.js';
import * as L from './library.js';
import { STATUSES, typeClass, isReel, bracketCount, readXlsx, parseCsv, rowsToEntries, mergeImport, partWarnings } from './calendar.js';
import { PLATFORMS, RULES, defaultSettings, fmtTime, timesFor, buildCaptions, nextReelDay } from './post.js';
import { Compositor, MIRRORS, TRANSITIONS, GFX, GfxLayer, newGfx, joinKey } from './fx.js';
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
  splits: [],           // reel times where you split the video into sections
  postDate: '', caption: '', closer: 0, ytTitle: '', posted: {}, capEdits: {}, status: 'To record',
  scrub: 0,
});
const VO = () => P.mode === 'voiceover';
let P = blank();
const urls = {};        // take id -> object URL
let undoStack = [], redoStack = [];

const snap = () => JSON.stringify({ splits: P.splits, items: P.items, split: P.split, pauseSec: P.pauseSec, takes: P.takes, cleaned: P.cleaned, transcript: P.transcript, visuals: P.visuals, mode: P.mode, text: P.text, broll: P.broll, effects: P.effects, trans: P.trans, gfx: P.gfx });
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
const cleanLen = () => (P.cleaned ? total(keptRanges(P.items, P.takes)) : rawLen());

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
  ({ 1: plan, 2: record, 3: clean, 4: edit, 5: exportStep, 6: post })[P.step]();
  if (P.step !== 2) repaint(); else if (!cam) { cv.classList.add('hidden'); }
  setTimer(cleanLen());
}

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
    ${isReel(e) ? `<div class="row">${reel ? `<button class="big" id="evOpen">Open this reel →</button><span class="sub">${esc(reel.status)}</span>` : `<button class="big" id="evStart">Start this reel →</button>`}</div>` : ''}
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
    if (ce && k !== 'title') { ce[k] = P[k]; saveCal(); }
  }));
  $('#go2').onclick = () => go(2);
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { remember(); P.mode = b.dataset.mode; save(); render(); }));
  $('#newReel').onclick = () => newReel();
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openReel(b.dataset.open)));
  document.querySelectorAll('[data-delreel]').forEach((b) => (b.onclick = async () => {
    const r = reelIndex[b.dataset.delreel];
    if (!confirm(`Delete "${r.title}" and its recordings? This can't be undone.`)) return;
    const old = await store.get('reel:' + r.id);
    if (old) for (const t of [...old.takes, ...old.visuals, ...old.broll, ...(old.gfx || [])]) await store.del('blob:' + t.id);
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
      toast(had ? `Updated ${incoming.length} posts from your calendar. Your reels and progress were kept.` : `Imported ${incoming.length} posts.`);
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
      sel[k] = el.value; await saveCal();
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
}

// ---------- reels ----------
function hydrate(saved) {
  const p = Object.assign(blank(), saved);
  const d = defaultText(), t = saved.text || {};
  p.text = { hook: { ...d.hook, ...t.hook, style: { ...d.hook.style, ...(t.hook || {}).style } },
    caps: { ...d.caps, ...t.caps, style: { ...d.caps.style, ...(t.caps || {}).style } },
    list: { ...d.list, ...t.list, style: { ...d.list.style, ...(t.list || {}).style } } };
  p.trans = { def: 'cut', dur: 0.3, joins: {}, ...p.trans };
  return p;
}
async function loadUrls() {
  for (const t of [...P.takes, ...P.visuals, ...P.broll, ...P.gfx.filter((x) => x.type === 'png')]) {
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
        <input type="file" id="upload" accept="${VO() ? 'audio/*,video/*' : 'video/*'}" multiple hidden></label>
    </div>
    <details class="more"><summary>More options</summary>
      <label><input type="checkbox" id="pOn" ${P.prompter ? 'checked' : ''}> Scroll my script while I record</label>
      <label>Scroll speed ${tip('Pixels per second. Slower if you read slowly.')}</label>
      <input type="range" id="pSpeed" min="10" max="80" value="${P.prompterSpeed}">
    </details>
    <h3 style="margin-top:26px">${VO() ? 'Voice takes' : 'Takes'} (${P.takes.length})</h3>
    <ul class="takes">${P.takes.map((t, i) => `<li><b>Take ${i + 1}</b><span>${fmt(t.duration)} sec</span>
      <button class="btn" data-play="${i}">▶</button><button class="x" data-del="${i}" title="Remove this take">✕</button></li>`).join('') || '<li>No takes yet.</li>'}</ul>
    ${VO() ? `<h3 style="margin-top:26px">What plays on screen (${P.visuals.length}) ${tip('Photos, clips or screen recordings. They play in this order. Leave seconds blank to share the time evenly.')}</h3>
      <label class="btn" style="display:inline-block;margin:0">＋ Add photos, clips or screen recordings
        <input type="file" id="addVis" accept="image/*,video/*" multiple hidden></label>
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
    P.cleaned = false; P.items = []; P.split = null;
    save(); render();
    toast(`Removed. Undo to bring Take ${+b.dataset.del + 1} back.`);
    void t;
  }));
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

async function addTake(blob, name) {
  let duration = 0;
  try { duration = (await decodeClip(blob)).duration; }
  catch { toast(`Couldn't read the sound in ${name}. Try exporting it from your phone as MP4.`); return; }
  const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
  await store.put('blob:' + id, blob);
  urls[id] = URL.createObjectURL(blob);
  remember();
  P.takes.push({ id, name, duration });
  if (P.status === 'To record') P.status = 'Recorded';
  P.cleaned = false; P.items = []; P.split = null;
  save();
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

const fullRanges = () => (P.cleaned ? keptRanges(P.items, P.takes) : P.takes.map((t, i) => ({ take: i, start: 0, end: t.duration })));
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
  const ranges = P.cleaned ? keptRanges(P.items, P.takes, part ? P.split : null, part) : fullRanges();
  T.caps.chunks = P.cleaned && P.transcript ? chunks(outWords(P.items, P.takes, ranges), T.caps.n) : null;
  await Promise.all([ready(T.hook.style), ready(T.caps.style), ready(T.list.style)]);
  const behind = { hook: T.hook.on && T.hook.behind, caps: T.caps.on && T.caps.behind, list: T.list.on && T.list.behind };
  const anyBehind = !VO() && (behind.hook || behind.caps || behind.list);
  if (anyBehind) await loadSegmenter();
  // B-roll times are on the whole reel; Part 2 starts after Part 1.
  const off = part === 2 ? total(keptRanges(P.items, P.takes, P.split, 1)) : 0;
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
  return fn;
}

let playing = null;
function stopPlaying() { if (playing) { playing.stop = true; preview.pause(); if (previewTrack) previewTrack.pauseAll(); playing = null; $('#playClean').textContent = '▶ Play'; } }
$('#playClean').onclick = () => (playing ? stopPlaying() : play(0));
// Plays the kept parts with everything on top, from startT for up to maxDur seconds.
async function play(startT = 0, maxDur = Infinity) {
  stopPlaying();
  if (!P.takes.length) return;
  stopCamera();
  const ranges = fullRanges();
  const ov = await makeOverlay(0);
  const comp = makeComp(0, ranges);
  const track = VO() && P.visuals.length ? await getTrack() : null;
  const run = { stop: false }; playing = run; $('#playClean').textContent = '■ Stop';
  $('#emptyPreview').classList.add('hidden'); cv.classList.remove('hidden');
  let doneT = 0;
  const endT = startT + maxDur;
  for (const [k, r] of ranges.entries()) {
    const len = r.end - r.start;
    if (doneT + len <= startT) { doneT += len; continue; }
    if (run.stop || doneT >= endT) break;
    await loadSrc(urls[P.takes[r.take].id]);
    await seekTo(r.start + Math.max(0, startT - doneT));
    await preview.play();
    await new Promise((res) => {
      const chk = () => {
        const local = Math.max(0, preview.currentTime - r.start), t = doneT + local;
        comp.frame(cx, (c) => (track ? track.draw(c, t, true) : drawCover(c, preview)), t, k, local);
        ov(cx, t, track ? null : preview, true);
        (run.stop || t >= endT || preview.currentTime >= r.end - 0.02 || preview.ended) ? res() : requestAnimationFrame(chk);
      };
      chk();
    });
    if (track) track.pauseAll();
    ov.pause();
    doneT += len;
  }
  preview.pause(); if (track) track.pauseAll(); ov.pause();
  if (playing === run) { playing = null; $('#playClean').textContent = '▶ Play'; }
}
const makeComp = (part, ranges, still = false) =>
  new Compositor(P.effects, P.trans, ranges, part === 2 ? total(keptRanges(P.items, P.takes, P.split, 1)) : 0, !VO() && !still);

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
    setStatus(`Take ${i + 1} of ${P.takes.length}: finding pauses…`, i / P.takes.length);
    const blob = await store.get('blob:' + tk.id);
    const samples = await to16kMono(await decodeClip(blob));
    const runs = speechRuns(samples);
    setStatus(`Take ${i + 1} of ${P.takes.length}: getting the transcript…`);
    const words = window.__FAKE_WORDS ? window.__FAKE_WORDS(i) : window.__NO_WHISPER ? null : await transcribe(samples);
    if (!words) gotWords = false;
    items.push(...buildItems(tk, i, runs, words, P.pauseSec));
  }
  if (gotWords) markRepeats(items);
  P.items = items; P.cleaned = true; P.transcript = gotWords; P.split = null;
  if (cleanLen() >= 30) P.split = suggestSplit(P.items, P.takes);
  save(); render();
}

function clean() {
  if (!P.takes.length) { panel.innerHTML = `<h1>Clean it up</h1><p class="sub">Record or upload a take first.</p><button class="big" onclick="">← Back to Record</button>`; panel.querySelector('button').onclick = () => go(2); return; }
  const before = rawLen(), after = cleanLen();
  const parts = P.split ? [1, 2].map((p) => total(keptRanges(P.items, P.takes, P.split, p))) : null;
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
const reelLen = () => total(fullRanges());

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
  if (!P.takes.length) { panel.innerHTML = '<h1>Edit</h1><p class="sub">Record a take first.</p>'; return; }
  loadAllFonts();
  const T = P.text;
  const words = P.cleaned && P.transcript ? outWords(P.items, P.takes, fullRanges()) : [];
  const len = reelLen();
  if (P.scrub > len) P.scrub = 0;
  panel.innerHTML = `
    <h1>Edit</h1>
    <div class="tabs">${[['text', 'Text'], ['broll', 'B-roll'], ['trans', 'Transitions & mirror'], ['gfx', 'Graphics & stamps']].map(([k, n]) =>
      `<button class="tab ${editTab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>
    ${splitBarHTML(len)}
    ${editTab === 'broll' ? brollHTML(len) : editTab === 'trans' ? transHTML(len) : editTab === 'gfx' ? gfxHTML(len) : `
    <div class="scrub">
      <label>See the frame at <b id="scrubV">${fmt(P.scrub)}</b> sec</label>
      <input type="range" id="scrub" min="0" max="${Math.max(0.1, len - 0.05).toFixed(2)}" step="0.05" value="${P.scrub}">
      <div class="row small">Drag on the preview to move:
        ${[['hook', 'Hook'], ['caps', 'Captions'], ['list', 'List']].map(([k, n]) => `<button class="chip ${moveWhat === k ? 'on' : ''}" data-move="${k}">${n}</button>`).join('')}</div>
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
    `}
    <div class="next"><button class="btn" id="back3">← Clean</button><button class="big" id="go5">Next: Export →</button></div>`;

  $('#back3').onclick = () => go(3);
  $('#go5').onclick = () => go(5);
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { editTab = b.dataset.tab; render(); }));
  splitBind(len);
  if (editTab === 'broll') { brollBind(); return; }
  if (editTab === 'trans') { transBind(); return; }
  if (editTab === 'gfx') { gfxBind(); return; }
  if (editTab !== 'text') return;

  $('#scrub').oninput = (e) => { P.scrub = +e.target.value; $('#scrubV').textContent = fmt(P.scrub); repaint(); };
  $('#scrub').onchange = () => save();
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
    <div class="scrub">
      <label>See the frame at <b id="scrubV">${fmt(P.scrub)}</b> sec</label>
      <input type="range" id="scrub" min="0" max="${Math.max(0.1, len - 0.05).toFixed(2)}" step="0.05" value="${P.scrub}">
      <p class="hint">Move the slider to where a photo or clip should start, then add it. Your voice keeps playing; clip sound is muted.</p>
    </div>
    <label class="big gold" style="display:inline-block;cursor:pointer">＋ Add photo or clip at ${fmt(P.scrub)} sec
      <input type="file" id="addBroll" accept="image/*,video/*" multiple hidden></label>
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
  $('#scrub').oninput = (e) => { P.scrub = +e.target.value; $('#scrubV').textContent = fmt(P.scrub); repaint(); };
  $('#scrub').onchange = () => { save(); render(); };
  $('#addBroll').onchange = async (e) => {
    let at = P.scrub;
    for (const f of e.target.files) {
      const id = 'b' + Date.now() + Math.random().toString(36).slice(2, 6);
      await store.put('blob:' + id, f); urls[id] = URL.createObjectURL(f);
      remember();
      const item = newBroll(id, f.type.startsWith('image/') ? 'image' : 'video', f.name, at);
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

// ---------- Split: cut the reel into sections, then change one section ----------
let secSel = -1, pendingDur = null;
const sectionsOf = (len) => {
  const cuts = [...new Set((P.splits || []).filter((t) => t > 0.05 && t < len - 0.05).map((t) => +t.toFixed(2)))].sort((a, b) => a - b);
  const edges = [0, ...cuts, len];
  return edges.slice(0, -1).map((a, i) => ({ a, b: edges[i + 1] }));
};
function splitBarHTML(len) {
  const secs = sectionsOf(len);
  if (secSel >= secs.length) secSel = -1;
  const pct = (t) => (100 * t) / Math.max(len, 0.01);
  const lane = (arr, cls, label) => arr.map((x) => `<div class="lane ${cls}" style="left:${pct(x.start)}%;width:${Math.max(0.6, pct(Math.min(x.dur, len - x.start)))}%" title="${label}"></div>`).join('');
  const sel = secs[secSel];
  return `<div class="splitbox">
    <div class="row"><b>Sections</b>
      <button class="chip on" id="splitHere">✂ Split at ${fmt(P.scrub)} sec</button>
      <span class="hint" style="margin:0">Move the slider, split, then tap a section to change just that part.</span></div>
    <div class="tl" id="tl">
      <div class="secs">${secs.map((x, i) => `<button class="sec ${i === secSel ? 'on' : ''}" data-sec="${i}" style="flex:${x.b - x.a}">${i + 1}<small>${fmt(x.a)}–${fmt(x.b)}</small></button>`).join('')}</div>
      <div class="lanes">${lane(P.broll, 'lb', 'B-roll')}${lane(P.effects, 'lm', 'Mirror')}${lane(P.gfx, 'lg', 'Graphic')}</div>
      ${secs.slice(1).map((x) => `<button class="cutmark" data-unsplit="${x.a}" style="left:${pct(x.a)}%" title="Remove this split">✂</button>`).join('')}
      <div class="playhead" style="left:${pct(P.scrub)}%"></div>
    </div>
    <div class="legend"><span class="dot" style="background:#e8a33d"></span>B-roll <span class="dot" style="background:#8a63d2"></span>Mirror <span class="dot" style="background:#0f8b8d"></span>Graphics · tap ✂ on a split line to remove it</div>
    ${sel ? `<div class="secact">
      <b>Section ${secSel + 1}: ${fmt(sel.a)}–${fmt(sel.b)} sec (${fmt(sel.b - sel.a)} sec)</b>
      <div class="row">
        <select id="secMirror"><option value="">🪞 Mirror this section…</option>${Object.entries(MIRRORS).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
        <label class="btn" style="margin:0;cursor:pointer">🖼 Cover with B-roll<input type="file" id="secBroll" accept="image/*,video/*" hidden></label>
        <button class="btn" id="secLib">📚 B-roll from library</button>
        <button class="btn" id="secPlay">▶ Play section</button>
        <button class="btn danger" id="secDel">🗑 Remove section</button>
      </div></div>` : ''}
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
function removeSection(a, b) {
  const ranges = fullRanges();
  if (!P.cleaned) { // turn every take into one kept item so cuts have something to subtract from
    P.items = P.takes.map((t, i) => ({ type: 'speech', take: i, start: 0, end: t.duration, cut: false, reason: '' }));
    P.cleaned = true;
  }
  let acc = 0;
  for (const r of ranges) {
    const s0 = acc, s1 = acc + (r.end - r.start); acc = s1;
    const lo = Math.max(a, s0), hi = Math.min(b, s1);
    if (hi - lo < 0.02) continue;
    P.items.push({ type: 'manual', take: r.take, start: r.start + (lo - s0), end: r.start + (hi - s0), cut: true, reason: 'manual' });
  }
  P.items.sort((x, y) => x.take - y.take || x.start - y.start);
  shiftAfter(a, b);
}
function splitBind(len) {
  $('#splitHere').onclick = () => {
    if (P.scrub < 0.1 || P.scrub > len - 0.1) { toast('Move the slider to the spot you want to split first.'); return; }
    remember(); P.splits = [...(P.splits || []), +P.scrub.toFixed(2)];
    const secs = sectionsOf(len); secSel = secs.findIndex((x) => x.a >= P.scrub - 0.01);
    save(); render();
  };
  $('#tl').onclick = (e) => {
    if (e.target.closest('[data-sec],[data-unsplit]')) return;
    const r = $('#tl').getBoundingClientRect();
    P.scrub = Math.max(0, Math.min(len - 0.05, ((e.clientX - r.left) / r.width) * len)); render();
  };
  document.querySelectorAll('[data-sec]').forEach((b) => (b.onclick = () => {
    const i = +b.dataset.sec; secSel = secSel === i ? -1 : i;
    if (secSel >= 0) P.scrub = Math.min(sectionsOf(len)[i].a + 0.05, len - 0.05);
    render();
  }));
  document.querySelectorAll('[data-unsplit]').forEach((b) => (b.onclick = () => {
    remember(); const t = +b.dataset.unsplit; P.splits = P.splits.filter((x) => Math.abs(x - t) > 0.011); secSel = -1; save(); render();
  }));
  const sel = sectionsOf(len)[secSel];
  if (!sel) return;
  $('#secMirror').onchange = (e) => {
    if (!e.target.value) return;
    remember(); P.effects.push({ id: newId('e'), kind: e.target.value, start: +sel.a.toFixed(2), dur: +(sel.b - sel.a).toFixed(2) });
    save(); render(); toast('Mirrored this section. Change it under Transitions & mirror.');
  };
  $('#secBroll').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const id = newId('b'); await store.put('blob:' + id, f); urls[id] = URL.createObjectURL(f);
    remember();
    const it = newBroll(id, f.type.startsWith('image/') ? 'image' : 'video', f.name, sel.a);
    it.dur = +(sel.b - sel.a).toFixed(2); it.layout = 'full'; it.anim = 'none';
    P.broll.push(it); P.broll.sort((x, y) => x.start - y.start); moveWhat = 'b:' + id;
    save(); render(); toast('B-roll covers this section. Change it under B-roll.');
  };
  $('#secLib').onclick = () => { pendingDur = +(sel.b - sel.a).toFixed(2); P.scrub = sel.a; editTab = 'broll'; libOpen = true; render(); toast('Tap a tile to cover the section.'); };
  $('#secPlay').onclick = () => play(sel.a, sel.b - sel.a);
  $('#secDel').onclick = () => {
    if (!confirm(`Remove ${fmt(sel.b - sel.a)} sec (section ${secSel + 1})? You can put it back in Clean or with Undo.`)) return;
    remember(); removeSection(sel.a, sel.b); secSel = -1; save(); render();
  };
}

// ---------- shared bits for timed items ----------
const newId = (p) => p + Date.now() + Math.random().toString(36).slice(2, 6);
function scrubBlock(len, hint) {
  return `<div class="scrub">
      <label>See the frame at <b id="scrubV">${fmt(P.scrub)}</b> sec</label>
      <input type="range" id="scrub" min="0" max="${Math.max(0.1, len - 0.05).toFixed(2)}" step="0.05" value="${P.scrub}">
      ${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
}
function bindScrub() {
  $('#scrub').oninput = (e) => { P.scrub = +e.target.value; $('#scrubV').textContent = fmt(P.scrub); repaint(); };
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
    <div class="card-h"><b class="big-l">Mirror effects</b></div>
    <p class="hint">Mirror or repeat your image for a beat (or the whole reel). Text, B-roll and graphics stay on top, not mirrored.</p>
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
    P.gfx.push(g); moveWhat = 'g:' + g.id; P.scrub = Math.min(P.scrub + 0.5, reelLen() - 0.05); save(); render();
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
      <label class="btn" style="margin:0;cursor:pointer">⬆ Add to library<input type="file" id="libUp" accept="image/*,video/*" multiple hidden></label>
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
  const lens = parts.map((p) => total(P.cleaned ? keptRanges(P.items, P.takes, P.split, p) : P.takes.map((t, i) => ({ take: i, start: 0, end: t.duration }))));
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
  const ranges = P.cleaned ? keptRanges(P.items, P.takes, P.split, part) : P.takes.map((t, i) => ({ take: i, start: 0, end: t.duration }));
  if (total(ranges) >= 30) { toast('Over 30 sec. Split it first.'); return; }
  stopCamera();
  document.querySelectorAll('[data-exp]').forEach((b) => (b.disabled = true));
  setStatus('Exporting… this plays through once, so it takes about as long as the reel.', 0);
  try {
    const opts = { overlay: await makeOverlay(part), comp: makeComp(part, ranges) };
    if (VO() && P.visuals.length) {
      opts.track = makeTrack();
      opts.offset = part === 2 ? total(keptRanges(P.items, P.takes, P.split, 1)) : 0;
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
  const ranges = P.cleaned ? keptRanges(P.items, P.takes) : P.takes.map((t, i) => ({ take: i, start: 0, end: t.duration }));
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
        <ul class="rules">${RULES[pl.key].map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
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
    </details>
    <div class="next"><button class="btn" id="back5">← Export</button><span class="sub">Status: <b>${P.status}</b></span></div>`;

  $('#back5').onclick = () => go(5);
  $('#pdate').onchange = (e) => { P.postDate = e.target.value; save(); render(); };
  let capTimer;
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
