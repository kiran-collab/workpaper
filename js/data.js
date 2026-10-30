// Packet loading and indexing. The packet is used exactly as delivered; nothing here mutates it.
// Every reference format in readme.reference_formats resolves through resolveRef().

export const PACKET_URL = 'okafor_lindqvist_2025_packet.json';

export async function loadPacket(url = PACKET_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load packet (${res.status})`);
  return res.json();
}

export function buildIndex(packet) {
  const idx = {
    packet,
    clientId: packet.packet.client_id,
    docs: new Map(),
    evs: new Map(),
    evsByDoc: new Map(),
    versions: packet.return_versions,
    linesByVersion: new Map(),
    usedBy: new Map(), // ref -> [{version, key}]
    staff: new Map(packet.firm.staff.map(s => [s.id, s])),
    clientUsers: new Map(packet.firm.client_users.map(c => [c.id, c])),
    people: new Map(packet.household.people.map(p => [p.id, p])),
    qa: new Map(packet.client.questionnaire.map(q => [q.id, q])),
    msgs: new Map(packet.client.messages.map(m => [m.id, m])),
    calls: new Map(packet.client.call_notes.map(c => [c.id, c])),
    timeline: packet.timeline,
    params: packet.engine_reference.parameters,
    rules: packet.engine_reference.rules,
  };
  for (const d of packet.documents) { idx.docs.set(d.id, d); idx.evsByDoc.set(d.id, []); }
  for (const e of packet.extracted_values) {
    idx.evs.set(e.id, e);
    (idx.evsByDoc.get(e.document_id) || idx.evsByDoc.set(e.document_id, []).get(e.document_id)).push(e);
  }
  for (const v of packet.return_versions) {
    const m = new Map();
    for (const l of v.lines) m.set(l.key, l);
    idx.linesByVersion.set(v.version, m);
    for (const l of v.lines) {
      for (const s of l.sources || []) {
        if (!idx.usedBy.has(s)) idx.usedBy.set(s, []);
        idx.usedBy.get(s).push({ version: v.version, key: l.key });
      }
    }
  }
  return idx;
}

export function version(idx, id) { return idx.versions.find(v => v.version === id); }
export function line(idx, vid, key) { return idx.linesByVersion.get(vid)?.get(key); }

// RFC 6901 JSON pointer
export function jsonPointer(obj, ptr) {
  if (!ptr || ptr === '/') return obj;
  const parts = ptr.replace(/^\//, '').split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function refKind(ref) {
  if (/^ev-\d+$/.test(ref)) return 'ev';
  if (/^D\d\d$/.test(ref)) return 'doc';
  if (/^doc:D\d\d#page\d+$/.test(ref)) return 'docpage';
  if (/^qa-\d+$/.test(ref)) return 'qa';
  if (/^msg-\d+$/.test(ref)) return 'msg';
  if (/^call-\d+$/.test(ref)) return 'call';
  if (ref.startsWith('py:')) return 'py';
  if (ref.startsWith('agency:')) return 'agency';
  if (ref.startsWith('asset:')) return 'asset';
  if (ref.startsWith('household:')) return 'household';
  if (ref.startsWith('ref:param.')) return 'param';
  if (ref.startsWith('ref:fx.')) return 'fx';
  if (ref.startsWith('timeline:')) return 'timeline';
  if (/^v\d$/.test(ref)) return 'version';
  return 'line';
}

// Resolve any reference into a uniform "source" description used by the trace UI.
export function resolveRef(idx, ref, vid = 'v3') {
  const kind = refKind(ref);
  switch (kind) {
    case 'ev': {
      const e = idx.evs.get(ref);
      if (!e) return { kind, ref, missing: true, label: ref };
      const d = idx.docs.get(e.document_id);
      return { kind, ref, ev: e, doc: d, page: e.page, label: `${d.id} p${e.page} · ${e.label}`, value: e.value, valueType: e.value_type };
    }
    case 'doc': {
      const d = idx.docs.get(ref);
      return { kind, ref, doc: d, label: d ? `${d.id} · ${d.title}` : ref };
    }
    case 'docpage': {
      const [, id, pg] = ref.match(/^doc:(D\d\d)#page(\d+)$/);
      const d = idx.docs.get(id);
      return { kind, ref, doc: d, page: +pg, label: `${id} page ${pg} (not extracted)` };
    }
    case 'qa': { const q = idx.qa.get(ref); return { kind, ref, qa: q, label: `Questionnaire ${ref}: ${q?.question}`, value: q?.answer }; }
    case 'msg': { const m = idx.msgs.get(ref); return { kind, ref, msg: m, label: `Message ${ref} from ${m?.from}`, value: m?.text }; }
    case 'call': { const c = idx.calls.get(ref); return { kind, ref, call: c, label: `Call notes ${ref}`, value: c?.notes?.join(' / ') }; }
    case 'py': {
      const ptr = ref.slice(3);
      return { kind, ref, label: `Prior years ${ptr}`, value: jsonPointer(idx.packet.prior_years, ptr) };
    }
    case 'agency': {
      const ptr = ref.slice(7);
      return { kind, ref, label: `Agency records ${ptr}`, value: jsonPointer(idx.packet.tax_agency_records, ptr) };
    }
    case 'asset': {
      const id = ref.slice(6);
      const v = version(idx, vid);
      const a = v?.assets.find(x => x.asset_id === id) || idx.packet.prior_years.asset_records.find(x => x.asset_id === id);
      return { kind, ref, asset: a, label: `Asset ${id} · ${a?.description || ''}` };
    }
    case 'household': {
      const p = idx.people.get(ref.slice(10));
      return { kind, ref, person: p, label: `Household · ${p?.name} (${p?.role})` };
    }
    case 'param': {
      const n = ref.slice(10);
      return { kind, ref, label: `Engine parameter ${n}`, value: idx.params[n] };
    }
    case 'fx': {
      const [, cur, rate] = ref.split('.');
      return { kind, ref, label: `Exchange rate ${cur} ${rate}`, value: idx.params.fx?.[cur]?.[rate] };
    }
    case 'timeline': {
      const id = ref.slice(9);
      const t = idx.timeline.find(x => x.id === id);
      return { kind, ref, tl: t, label: `Timeline ${id} · ${t?.event}`, value: t?.detail };
    }
    case 'version': return { kind, ref, label: `Return version ${ref}` };
    default: {
      const l = line(idx, vid, ref);
      return { kind: 'line', ref, line: l, label: l ? `${l.key} · ${l.label}` : ref, value: l?.value };
    }
  }
}

// Which document a ref ultimately points at (for document coverage).
export function refDocId(idx, ref) {
  const r = resolveRef(idx, ref);
  if (r.doc) return r.doc.id;
  return null;
}

// All refs that a line depends on, recursively through inputs.
export function lineClosure(idx, vid, key, seen = new Set()) {
  if (seen.has(key)) return seen;
  seen.add(key);
  const l = line(idx, vid, key);
  for (const k of l?.inputs || []) lineClosure(idx, vid, k, seen);
  return seen;
}

// Lines that use a given line as input (reverse dependency).
export function dependents(idx, vid, key) {
  const out = [];
  for (const l of idx.linesByVersion.get(vid).values()) if ((l.inputs || []).includes(key)) out.push(l.key);
  return out;
}
