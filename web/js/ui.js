// Small rendering helpers shared by all views. Views return HTML strings; every interactive
// element carries data-a="<action>" and is handled by one delegated listener in app.js.

import { resolveRef, refKind } from './data.js';
import { maskValue, userName, cleared, lineView, areaOf, AREA } from './model.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;

export function fmt(v, { cents = false, sign = false } = {}) {
  if (v == null || v === '') return '—';
  if (typeof v !== 'number') { const n = Number(v); if (Number.isNaN(n) || typeof v === 'boolean') return esc(v); v = n; }
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : (Math.abs(v) < 1 && v !== 0 ? 4 : 0) });
  if (v < 0) return '(' + s + ')';
  return (sign && v > 0 ? '+' : '') + s;
}
export function fmtDelta(v) {
  if (!v) return '<span class="muted">0</span>';
  return `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}</span>`;
}
export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso);
  const o = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (withTime) Object.assign(o, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString('en-US', o);
}
export function rel(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  return fmtDate(iso);
}

// A number that explains itself: click opens the trace inspector.
export function num(ctx, key, opts = {}) {
  const lv = lineView(ctx, key);
  if (!lv.line) return `<span class="muted">—</span>`;
  const cents = lv.line.form === 'F8949' && !key.endsWith('total');
  const v = lv.value;
  const shown = typeof v === 'number' ? fmt(v, { cents }) : esc(lv.text?.to && typeof v !== 'number' ? v : v);
  const cls = ['num'];
  if (lv.adj) cls.push(lv.adj.status === 'approved' ? 'adj-ok' : 'adj-prop');
  if (lv.verified?.length) cls.push('ver');
  const orig = lv.adj ? `<s class="orig">${typeof lv.original === 'number' ? fmt(lv.original, { cents }) : esc(lv.original)}</s>` : '';
  return `${orig}<button class="${cls.join(' ')}" data-a="inspect" data-ref="${attr(key)}" title="${attr(lv.line.label)} — click to trace">${shown}${lv.verified?.length ? '<i class="tick" aria-label="verified">✓</i>' : ''}</button>`;
}

export function refChip(ctx, ref, label) {
  const r = resolveRef(ctx.idx, ref, ctx.vid);
  const k = refKind(ref);
  const icon = { ev: '◆', doc: '▤', docpage: '▤', qa: '?', msg: '✉', call: '☎', py: '↶', agency: '⚖', asset: '▦', household: '☺', param: 'ƒ', fx: '¤', timeline: '⏱', line: '#', version: 'v' }[k] || '•';
  const text = label || (k === 'ev' ? `${r.doc?.id} ${r.ev?.label}` : k === 'line' ? ref : k === 'doc' ? `${ref} ${r.doc?.title?.slice(0, 38) || ''}` : r.label);
  return `<button class="chip k-${k}" data-a="inspect" data-ref="${attr(ref)}" title="${attr(r.label)}"><span class="ci">${icon}</span>${esc(text)}</button>`;
}

export function sev(s) {
  const map = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info', pass: 'Passed' };
  return `<span class="sev sev-${s}">${map[s] || s}</span>`;
}
export function pill(text, kind = '') { return `<span class="pill ${kind}">${esc(text)}</span>`; }
export function who(ctx, id) { return `<span class="who">${esc(userName(ctx.idx, id))}</span>`; }
export function avatar(ctx, id) {
  const n = userName(ctx.idx, id);
  const ini = n.split(/\s+/).map(p => p[0]).slice(0, 2).join('');
  return `<span class="av" title="${attr(n)}" style="--h:${[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}">${esc(ini)}</span>`;
}

// Sensitive values: masked unless cleared and revealed (every reveal is logged).
export function sensitive(ctx, value, kind, ref) {
  if (value == null) return '—';
  const key = `${ref}|${kind}`;
  if (cleared(ctx.user) && ctx.revealed?.has(key)) return `<span class="sens open">${esc(value)}</span>`;
  const masked = maskValue(value, kind);
  if (!cleared(ctx.user)) return `<span class="sens" title="Masked: no sensitive-data clearance">${esc(masked)} <i class="lock">🔒</i></span>`;
  return `<span class="sens">${esc(masked)} <button class="link sm" data-a="reveal" data-key="${attr(key)}" data-ref="${attr(ref)}" title="Reveal (logged)">reveal</button></span>`;
}

export function areaLink(id) { return `<a href="#/area/${id}" class="arealink">${esc(AREA[id]?.name || id)}</a>`; }
export function areaOfKey(key) { return areaOf(key); }

export function empty(text) { return `<div class="empty">${esc(text)}</div>`; }

export function table(headers, rows, cls = '') {
  return `<table class="t ${cls}"><thead><tr>${headers.map(h => `<th${h.r ? ' class="r"' : ''}>${h.t ?? h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function section(title, body, { actions = '', sub = '', id = '' } = {}) {
  return `<section class="card"${id ? ` id="${id}"` : ''}><header class="card-h"><div><h3>${title}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="card-a">${actions}</div></header><div class="card-b">${body}</div></section>`;
}

export function btn(label, action, data = {}, cls = '') {
  const d = Object.entries(data).map(([k, v]) => `data-${k}="${attr(v)}"`).join(' ');
  return `<button class="btn ${cls}" data-a="${action}" ${d}>${label}</button>`;
}

export function methodLabel(m) {
  return { agreed_to_source_document: 'Agreed to source document', recalculated: 'Recalculated', confirmed_with_client: 'Confirmed with client', agreed_to_prior_year: 'Agreed to prior year', agreed_to_third_party_record: 'Agreed to third-party record' }[m] || m;
}
