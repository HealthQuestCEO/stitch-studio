// B-roll library: photos and clips you keep across every reel, sorted into categories.
// Saved in this browser only. "Start a new reel" never clears it.
import * as store from './store.js';

export const DEFAULT_CATS = [
  'Reactions', 'Building HealthQuest', 'Screen recordings', 'Nurse / clinic',
  'Roots / Filipino', 'Tennis', 'Books', 'Mission / $19B', 'Mom life',
];

let lib = null;
const libUrls = {};

export async function loadLibrary() {
  if (lib) return lib;
  lib = (await store.get('library')) || { cats: [...DEFAULT_CATS], items: [] };
  for (const it of lib.items) {
    const b = await store.get('lib:' + it.id);
    if (b) libUrls[it.id] = URL.createObjectURL(b);
  }
  lib.items = lib.items.filter((it) => libUrls[it.id]);
  return lib;
}
export const library = () => lib;
export const libUrl = (id) => libUrls[id];
const persist = () => store.put('library', lib);

export async function addToLibrary(blob, name, cats) {
  const id = 'L' + Date.now() + Math.random().toString(36).slice(2, 6);
  await store.put('lib:' + id, blob);
  libUrls[id] = URL.createObjectURL(blob);
  const kind = (blob.type || '').startsWith('image/') ? 'image' : 'video';
  lib.items.unshift({ id, kind, name, cats: cats.filter(Boolean), added: Date.now() });
  for (const c of cats) if (c && !lib.cats.includes(c)) lib.cats.push(c);
  await persist();
  return id;
}
export async function removeFromLibrary(id) {
  lib.items = lib.items.filter((it) => it.id !== id);
  await store.del('lib:' + id);
  await persist();
}
export async function setItemCats(id, cats) {
  const it = lib.items.find((x) => x.id === id);
  if (!it) return;
  it.cats = cats.filter(Boolean);
  for (const c of it.cats) if (!lib.cats.includes(c)) lib.cats.push(c);
  await persist();
}
export async function renameItem(id, name) {
  const it = lib.items.find((x) => x.id === id);
  if (it && name) { it.name = name; await persist(); }
}
export async function setCats(cats) {
  const clean = [...new Set(cats.map((c) => c.trim()).filter(Boolean))];
  // items keep only categories that still exist
  lib.cats = clean;
  for (const it of lib.items) it.cats = it.cats.filter((c) => clean.includes(c));
  await persist();
}
export const libBlob = (id) => store.get('lib:' + id);
