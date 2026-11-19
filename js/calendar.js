// Calendar: import the content calendar (.xlsx or .csv), colors by type, checks.
// Reading .xlsx happens right here in the browser; nothing is uploaded.

export const STATUSES = ['To record', 'Recorded', 'Edited', 'Ready', 'Scheduled', 'Posted'];

export function typeClass(type = '') {
  const t = type.toLowerCase();
  if (t.includes('reddit')) return 'reddit';
  if (t.includes('ad') || t.includes('story') || t.includes('stories') || t.includes('flyer')) return t.includes('reel') ? 'reel' : 'ad';
  return 'reel';
}
export const isReel = (e) => typeClass(e.type) === 'reel';
export const bracketCount = (txt = '') => (txt.match(/\[[^\]]+\]/g) || []).length;

// ---------- .xlsx (zip of XML) ----------
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), files = {};
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(off + 26, true), lelen = dv.getUint16(off + 28, true);
    const data = u8.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files[name] = { method, data };
    p += 46 + nlen + elen + clen;
  }
  const text = async (name) => {
    const f = files[name]; if (!f) return null;
    if (f.method === 0) return new TextDecoder().decode(f.data);
    const ds = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(ds).text();
  };
  return { names: Object.keys(files), text };
}

const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export async function readXlsx(file) {
  const z = await unzip(await file.arrayBuffer());
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const shared = [];
  const ss = await z.text('xl/sharedStrings.xml');
  if (ss) for (const si of xml(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  // first sheet in workbook order
  const wb = xml(await z.text('xl/workbook.xml'));
  const rels = xml(await z.text('xl/_rels/workbook.xml.rels'));
  const first = wb.getElementsByTagName('sheet')[0];
  const rid = first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  let target = 'worksheets/sheet1.xml';
  for (const r of rels.getElementsByTagName('Relationship')) if (r.getAttribute('Id') === rid) target = r.getAttribute('Target');
  const sheet = xml(await z.text('xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '')));
  const rows = [];
  for (const row of sheet.getElementsByTagName('row')) {
    const r = [];
    for (const c of row.getElementsByTagName('c')) {
      const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0];
      let val = '';
      if (t === 's') val = shared[+v.textContent] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else if (v) val = t === 'str' || t === 'b' ? v.textContent : Number(v.textContent);
      r[colIdx(c.getAttribute('r'))] = val;
    }
    rows.push(r);
  }
  return rows;
}

export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function toISO(v) {
  if (typeof v === 'number') { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// Map rows (first row = headers) to calendar entries.
export function rowsToEntries(rows) {
  const hi = rows.findIndex((r) => r && r.some((c) => /^date$/i.test(String(c || '').trim())));
  if (hi < 0) throw new Error('Couldn\'t find a "Date" column in the first sheet.');
  const head = rows[hi].map((h) => String(h || '').toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const C = { date: col('date'), type: col('type'), topic: col('topic'), hook: col('hook'), script: col('script'), where: col('where'), times: col('post time'), cap: col('caption'), status: col('status'), notes: col('notes') };
  const get = (r, k) => (C[k] >= 0 && r[C[k]] != null ? String(r[C[k]]).trim() : '');
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || C.date < 0) continue;
    const date = toISO(r[C.date]);
    if (!date) continue;
    const status = get(r, 'status');
    out.push({
      id: 'c' + Math.random().toString(36).slice(2, 9), date,
      type: get(r, 'type') || 'Story reel', topic: get(r, 'topic'), hook: get(r, 'hook'), script: get(r, 'script'),
      where: get(r, 'where'), times: get(r, 'times'), notes: [get(r, 'cap'), get(r, 'notes')].filter(Boolean).join(' · '),
      status: STATUSES.includes(status) ? status : 'To record', reelId: null,
    });
  }
  return out;
}

// Re-import: update text and dates from the sheet, keep your reels and progress.
export function mergeImport(old, incoming) {
  const used = new Set();
  const out = incoming.map((n) => {
    const m = old.find((o) => !used.has(o.id) && o.topic === n.topic && o.type === n.type)
      || old.find((o) => !used.has(o.id) && o.date === n.date && o.type === n.type);
    if (!m) return n;
    used.add(m.id);
    const rank = (s) => STATUSES.indexOf(s);
    return { ...n, id: m.id, reelId: m.reelId, status: rank(m.status) > rank(n.status) ? m.status : n.status };
  });
  // keep entries you added in the app that aren't in the sheet
  for (const o of old) if (!used.has(o.id) && o.manual) out.push(o);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
// Part 2 should be the day after its Part 1.
export function partWarnings(entries) {
  const warn = {};
  const base = (t) => t.replace(/\(?\s*part\s*[12]\s*\)?/i, '').replace(/[:\-–·\s]+$/, '').trim().toLowerCase();
  for (const e of entries) {
    if (!/part\s*2/i.test(e.topic)) continue;
    const p1 = entries.find((x) => /part\s*1/i.test(x.topic) && base(x.topic) === base(e.topic));
    if (!p1) warn[e.id] = 'No Part 1 found for this Part 2.';
    else if (dayDiff(p1.date, e.date) !== 1) warn[e.id] = `Part 1 is on ${p1.date}. Part 2 should be the next day.`;
  }
  return warn;
}
