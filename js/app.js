import * as store from './store.js';
import { decodeClip, to16kMono, speechRuns } from './audio.js';
import { buildItems, markPauses, markRepeats, keptRanges, total, suggestSplit, outWords } from './clean.js';
import { renderReel, frameAt, pickMime, drawCover, W, H } from './export.js';
import { drawText, chunks, ready, defaultText, FONTS, BRAND, MY_STYLE, loadFont, loadAllFonts } from './text.js';
import { loadSegmenter, drawPerson, segmenterFailed } from './segment.js';
import { VisualTrack } from './visuals.js';

const $ = (s) => document.querySelector(s);
const panel = $('#panel'), preview = $('#preview');

const STEPS = [
  { n: 1, name: 'Plan' },
  { n: 2, name: 'Record' },
  { n: 3, name: 'Clean' },
  { n: 4, name: 'Edit' },
  { n: 5, name: 'Export' },
  { n: 6, name: 'Post', soon: true },
];

// ---------- state ----------
const blank = () => ({
  title: '', hook: '', script: '',
  takes: [],            // {id, name, duration}
  items: [],            // clean results
  cleaned: false, transcript: false,
  pauseSec: 0.5, split: null,
  step: 1, prompter: true, prompterSpeed: 30, coverTime: null,
  mode: 'camera',       // 'camera' or 'voiceover'
  visuals: [],          // voice-over: {id, kind, name, sec}
  text: defaultText(),  // hook, captions, list
  scrub: 0,
});
const VO = () => P.mode === 'voiceover';
let P = blank();
const urls = {};        // take id -> object URL
let undoStack = [], redoStack = [];

const snap = () => JSON.stringify({ items: P.items, split: P.split, pauseSec: P.pauseSec, takes: P.takes, cleaned: P.cleaned, transcript: P.transcript, visuals: P.visuals, mode: P.mode, text: P.text });
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
    try { await store.put('project', P); $('#saved').textContent = 'Saved'; }
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
function plan() {
  panel.innerHTML = `
    <h1>Plan this reel</h1>
    <p class="sub">Type your hook and script, or skip ahead. Your calendar comes in a later update.</p>
    <label>How will this reel look?</label>
    <div class="modes">
      <button class="mode ${!VO() ? 'on' : ''}" data-mode="camera"><b>🎥 Me on camera</b><span>You talk to the camera.</span></button>
      <button class="mode ${VO() ? 'on' : ''}" data-mode="voiceover"><b>🎙 Voice-over</b><span>You talk; photos, clips or screen recordings play on screen.</span></button>
    </div>
    <label>Reel name ${tip('Just for you, so you can find it later.')}</label>
    <input type="text" id="title" placeholder="e.g. The moment at NASPGHAN" value="${esc(P.title)}">
    <label>Hook (first 1–2 seconds)</label>
    <input type="text" id="hook" placeholder="e.g. I noticed one pattern I couldn't unsee" value="${esc(P.hook)}">
    <label>Script ${tip('This scrolls on screen while you record, if you want it to.')}</label>
    <textarea id="script" placeholder="Paste your script here">${esc(P.script)}</textarea>
    <div class="next"><button class="btn" id="newReel">Start a new reel</button>
      <button class="big" id="go2">Next: Record →</button></div>`;
  ['title', 'hook', 'script'].forEach((k) => ($('#' + k).oninput = (e) => { P[k] = e.target.value; save(); }));
  $('#go2').onclick = () => go(2);
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { remember(); P.mode = b.dataset.mode; save(); render(); }));
  $('#newReel').onclick = async () => {
    if (!confirm('Start a new reel? This clears the takes and cleanup for the current one.')) return;
    for (const t of [...P.takes, ...P.visuals]) await store.del('blob:' + t.id);
    P = blank(); undoStack = []; redoStack = []; syncUndo(); save(); render();
  };
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
let stillBusy = false, stillAgain = null;
async function stillAt(t) {
  if (playing) return;
  if (stillBusy) { stillAgain = t; return; }
  stillBusy = true;
  try {
    const ranges = fullRanges();
    if (!P.takes.length || !ranges.length) { cv.classList.add('hidden'); $('#emptyPreview').classList.remove('hidden'); return; }
    $('#emptyPreview').classList.add('hidden'); cv.classList.remove('hidden');
    const ov = await makeOverlay(0);
    if (VO()) {
      cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
      if (P.visuals.length) await (await getTrack()).still(cx, t);
      ov(cx, t, null);
    } else {
      const loc = locate(t, ranges);
      await loadSrc(urls[P.takes[loc.take].id]);
      await seekTo(loc.src);
      cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
      drawCover(cx, preview);
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
  return (ctx, t, src) => {
    if (anyBehind && src && !segmenterFailed()) {
      drawText(ctx, T, t, behind, part);
      if (drawPerson(ctx, src)) {
        drawText(ctx, T, t, { hook: !behind.hook, caps: !behind.caps, list: !behind.list }, part);
        return;
      }
      drawText(ctx, T, t, { hook: !behind.hook, caps: !behind.caps, list: !behind.list }, part);
      return;
    }
    drawText(ctx, T, t, undefined, part);
  };
}

let playing = null;
$('#playClean').onclick = async () => {
  if (playing) { playing.stop = true; preview.pause(); if (previewTrack) previewTrack.pauseAll(); playing = null; $('#playClean').textContent = '▶ Play'; return; }
  if (!P.takes.length) return;
  stopCamera();
  const ranges = fullRanges();
  const ov = await makeOverlay(0);
  const track = VO() && P.visuals.length ? await getTrack() : null;
  const run = { stop: false }; playing = run; $('#playClean').textContent = '■ Stop';
  $('#emptyPreview').classList.add('hidden'); cv.classList.remove('hidden');
  let doneT = 0;
  for (const r of ranges) {
    if (run.stop) break;
    await loadSrc(urls[P.takes[r.take].id]);
    await seekTo(r.start);
    await preview.play();
    await new Promise((res) => {
      const chk = () => {
        const t = doneT + Math.max(0, preview.currentTime - r.start);
        cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
        if (track) track.draw(cx, t, true); else drawCover(cx, preview);
        ov(cx, t, track ? null : preview);
        (run.stop || preview.currentTime >= r.end - 0.02 || preview.ended) ? res() : requestAnimationFrame(chk);
      };
      chk();
    });
    if (track) track.pauseAll();
    doneT += r.end - r.start;
  }
  preview.pause(); if (track) track.pauseAll();
  if (playing === run) { playing = null; $('#playClean').textContent = '▶ Play'; }
};

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
    <div class="tabs">${[['text', 'Text'], ['broll', 'B-roll'], ['trans', 'Transitions'], ['gfx', 'Graphics']].map(([k, n]) =>
      `<button class="tab ${editTab === k ? 'on' : ''}" data-tab="${k}">${n}${k !== 'text' ? ' <span class="soon">(soon)</span>' : ''}</button>`).join('')}</div>
    ${editTab !== 'text' ? `<p class="sub" style="margin-top:20px">Coming in the next updates: ${editTab === 'broll' ? 'photos and clips over your voice, with borders, rounded corners, shadow, polaroid, phone screen and notebook paper frames.' : editTab === 'trans' ? 'cut, crossfade, swipes, zoom, flash and whip pan.' : 'arrows, circles, underlines, ✓ / ✗ stamps, sparkles, your logo and your own PNGs.'}</p>` : `
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
  if (editTab !== 'text') return;

  $('#scrub').oninput = (e) => { P.scrub = +e.target.value; $('#scrubV').textContent = fmt(P.scrub); repaint(); };
  $('#scrub').onchange = () => save();
  document.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => { moveWhat = b.dataset.move; render(); }));
  document.querySelectorAll('[data-tap]').forEach((b) => (b.onclick = () => { tapMode = b.dataset.tap; render(); }));
  document.querySelectorAll('details[data-box]').forEach((d) => (d.ontoggle = () => { d.open ? openBoxes.add(d.dataset.box) : openBoxes.delete(d.dataset.box); }));

  // generic inputs
  document.querySelectorAll('[data-k]').forEach((el) => {
    const read = () => (el.dataset.type === 'bool' ? el.checked : el.dataset.type === 'num' ? +el.value : el.value);
    const live = () => {
      setPath(el.dataset.k, read());
      const show = document.querySelector(`[data-show="${el.dataset.k}"]`); if (show) show.textContent = el.value;
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

// drag text on the preview
let dragging = false;
function dragTo(e) {
  const r = cv.getBoundingClientRect();
  const x = Math.min(0.95, Math.max(0.05, (e.clientX - r.left) / r.width));
  const y = Math.min(0.95, Math.max(0.05, (e.clientY - r.top) / r.height));
  P.text[moveWhat].x = Math.abs(x - 0.5) < 0.04 ? 0.5 : x; // snap to center
  P.text[moveWhat].y = y;
  repaint();
}
cv.addEventListener('pointerdown', (e) => {
  if (P.step !== 4 || editTab !== 'text') return;
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
    const opts = { overlay: await makeOverlay(part) };
    if (VO() && P.visuals.length) {
      opts.track = makeTrack();
      opts.offset = part === 2 ? total(keptRanges(P.items, P.takes, P.split, 1)) : 0;
    }
    const { blob, ext } = await renderReel(P.takes.map((t) => urls[t.id]), ranges, (p) => setStatus(`Exporting… ${Math.round(p * 100)}%`, p), opts);
    const name = `${(P.title || 'reel').replace(/[^\w\- ]+/g, '').trim() || 'reel'}${part ? ' - Part ' + part : ''}.${ext}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    window.__lastExport = { size: blob.size, type: blob.type, name };
    setStatus(`Done! Saved "${name}" to your Downloads.`, 1);
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
    ov(c.getContext('2d'), p.out ?? 0, null);
    return c;
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
function post() {
  panel.innerHTML = `
    <h1>Post</h1>
    <p class="sub">Coming in a later update: one card per platform (Instagram, Facebook Page, Facebook personal, TikTok, YouTube Shorts) with the post time, your caption with a copy button, each platform's rules, and checkboxes to mark it posted.</p>
    <div class="next"><button class="btn" id="back5">← Export</button><span></span></div>`;
  $('#back5').onclick = () => go(5);
}

// ---------- start ----------
(async function init() {
  try {
    const saved = await store.get('project');
    if (saved) {
      P = Object.assign(blank(), saved);
      const d = defaultText(), t = saved.text || {};
      P.text = { hook: { ...d.hook, ...t.hook, style: { ...d.hook.style, ...(t.hook || {}).style } },
        caps: { ...d.caps, ...t.caps, style: { ...d.caps.style, ...(t.caps || {}).style } },
        list: { ...d.list, ...t.list, style: { ...d.list.style, ...(t.list || {}).style } } };
    }
    for (const t of P.takes) {
      const b = await store.get('blob:' + t.id);
      if (b) urls[t.id] = URL.createObjectURL(b);
    }
    P.takes = P.takes.filter((t) => urls[t.id]);
    for (const v of P.visuals) {
      const b = await store.get('blob:' + v.id);
      if (b) urls[v.id] = URL.createObjectURL(b);
    }
    P.visuals = P.visuals.filter((v) => urls[v.id]);
    presets = (await store.get('presets')) || [];
  } catch (e) { console.warn(e); }
  if (P.step === 2) P.step = P.takes.length ? 3 : 2;
  syncUndo(); render();
})();
