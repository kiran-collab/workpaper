// Append-only journal. Every human action in the workpaper is an event; nothing is ever edited
// in place. Current state is a fold over the packet (immutable pipeline output) + this journal.
// Persistence: localStorage (events) + IndexedDB (attached files). Live sync between tabs and
// people on the same machine: BroadcastChannel. A server would replace both with one append API.

const CHANNEL = 'miraflores-workpaper';

export class Journal {
  constructor(clientId) {
    this.key = `wp:journal:${clientId}`;
    this.events = this._load();
    this.listeners = new Set();
    this.channel = 'BroadcastChannel' in self ? new BroadcastChannel(CHANNEL + ':' + clientId) : null;
    if (this.channel) this.channel.onmessage = (m) => this._onRemote(m.data);
    self.addEventListener?.('storage', (e) => { if (e.key === this.key) { this.events = this._load(); this._emit({ remote: true }); } });
  }
  _load() {
    try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch { return []; }
  }
  _save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.events)); }
    catch (e) { console.error('Journal save failed', e); this.saveError = e.message; }
  }
  _onRemote(msg) {
    if (msg?.type === 'append') {
      const known = new Set(this.events.map(e => e.id));
      let added = false;
      for (const ev of msg.events) if (!known.has(ev.id)) { this.events.push(ev); added = true; }
      if (added) { this.events.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)); this._emit({ remote: true, events: msg.events }); }
    } else if (msg?.type === 'presence') {
      this._emit({ presence: msg });
    } else if (msg?.type === 'reset') {
      this.events = this._load(); this._emit({ remote: true });
    }
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(info) { for (const fn of this.listeners) fn(info); }
  nextSeq() { return (this.events.at(-1)?.seq || 0) + 1; }

  // Append one or many events atomically. Returns the stored events.
  append(list, { actor, clock, batch } = {}) {
    const arr = Array.isArray(list) ? list : [list];
    let seq = this.nextSeq();
    const b = batch || (arr.length > 1 ? 'b-' + rid() : null);
    const stored = arr.map(e => ({
      id: e.id || 'e-' + rid(),
      seq: seq++,
      at: new Date().toISOString(),
      clock: clock || null,
      actor: e.actor || actor,
      batch: b,
      type: e.type,
      payload: e.payload || {},
    }));
    this.events.push(...stored);
    this._save();
    this.channel?.postMessage({ type: 'append', events: stored });
    this._emit({ local: true, events: stored });
    return stored;
  }
  presence(p) { this.channel?.postMessage({ type: 'presence', ...p }); }
  reset() {
    this.events = []; this._save();
    this.channel?.postMessage({ type: 'reset' });
    this._emit({ local: true });
  }
  replaceAll(events) {
    this.events = events.slice().sort((a, b) => a.seq - b.seq); this._save();
    this.channel?.postMessage({ type: 'reset' });
    this._emit({ local: true });
  }
  // Events not undone. An 'undo' event lists event ids (or a batch) it reverses.
  active() {
    const undone = new Set();
    for (const e of this.events) if (e.type === 'undo') for (const id of e.payload.ids || []) undone.add(id);
    for (const e of this.events) if (e.type === 'redo') for (const id of e.payload.ids || []) undone.delete(id);
    return this.events.filter(e => !undone.has(e.id) && e.type !== 'undo' && e.type !== 'redo');
  }
  undoneIds() {
    const undone = new Set();
    for (const e of this.events) {
      if (e.type === 'undo') for (const id of e.payload.ids || []) undone.add(id);
      if (e.type === 'redo') for (const id of e.payload.ids || []) undone.delete(id);
    }
    return undone;
  }
  // The most recent action (or batch) by this actor that is still in effect.
  lastUndoable(actor) {
    const undone = this.undoneIds();
    const mine = this.events.filter(e => e.actor === actor && !['undo', 'redo', 'view.sensitive', 'presence', 'seen'].includes(e.type) && !undone.has(e.id));
    const last = mine.at(-1);
    if (!last) return null;
    return last.batch ? mine.filter(e => e.batch === last.batch) : [last];
  }
}

// The same journal, kept on the FastAPI server (server/app.py) instead of in this browser.
// Appends show at once and are confirmed or refused by the server, which re-checks permissions
// and assigns the order. Other people's appends arrive over a server-sent event stream.
export class RemoteJournal extends Journal {
  constructor(clientId, base = 'api/') {
    super(clientId);
    this.channel?.close(); this.channel = null;
    this.remote = true; this.base = base; this.user = null;
  }
  _load() { return []; }
  _save() {}
  static async available(clientId, base = 'api/') {
    try {
      const r = await fetch(base + 'health', { cache: 'no-store' });
      return r.ok && (await r.json()).client === clientId;
    } catch { return false; }
  }
  async init() {
    this.events = (await this._req('GET', 'events')).events;
    const es = new EventSource(this.base + 'stream');
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'append') this._merge(msg.events, true);
      else if (msg.type === 'reset') { this.events = []; this._emit({ remote: true }); }
      else if (msg.type === 'presence') this._emit({ presence: msg });
    };
    return this;
  }
  async _req(method, path, body, user = this.user) {
    const r = await fetch(this.base + path, { method, headers: { 'Content-Type': 'application/json', 'X-User': user || '' }, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `Server error ${r.status}`);
    return j;
  }
  // Server copies replace optimistic ones (same id, authoritative seq); unknown ids are news from others.
  _merge(list, fromStream) {
    const byId = new Map(this.events.map((e, i) => [e.id, i]));
    const fresh = [];
    for (const ev of list) {
      if (byId.has(ev.id)) this.events[byId.get(ev.id)] = ev;
      else { this.events.push(ev); fresh.push(ev); }
    }
    this.events.sort((a, b) => a.seq - b.seq);
    if (fresh.length && fromStream) this._emit({ remote: true, events: fresh });
  }
  append(list, opts = {}) {
    const stored = super.append(list, opts); // optimistic: shows immediately with a provisional seq
    // Normal writes act as their author and pass the server's rules; only demo history and imports replay.
    const replay = !!opts.replay;
    const body = { events: stored.map(({ id, type, payload, actor, clock, batch }) => ({ id, type, payload, actor, clock, batch })), replay };
    // One write at a time, so the server stores events in the order they were made.
    this._queue = (this._queue || Promise.resolve()).catch(() => {}).then(() => this._req('POST', 'events', body, replay ? this.user : stored[0].actor));
    this._queue
      .then(r => this._merge(r.events, false))
      .catch(err => {
        const ids = new Set(stored.map(e => e.id));
        this.events = this.events.filter(e => !ids.has(e.id));
        this._emit({ local: true, rejected: err.message });
      });
    return stored;
  }
  presence(p) { this._req('POST', 'presence', p).catch(() => {}); }
  reset() {
    this.events = []; this._emit({ local: true });
    this._req('DELETE', 'events').catch(err => this._emit({ local: true, rejected: err.message }));
  }
  replaceAll(events) {
    this._req('DELETE', 'events')
      .then(() => this._req('POST', 'events', { events, replay: true }))
      .then(r => { this.events = r.events; this._emit({ local: true }); })
      .catch(err => this._emit({ local: true, rejected: err.message }));
  }
}

export function rid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

// ---------- Attached files (IndexedDB) ----------
const DB = 'wp-files';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function putFile(id, blob) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(blob, id); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function getFile(id) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('files').objectStore('files').get(id); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
}

// Stable short hash for fingerprints (FNV-1a).
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
