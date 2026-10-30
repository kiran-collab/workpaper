// Trace: any number → how it was built → exact source field on a rendered document page.
// Any document → every place it landed (or why it did not).
//
// Document rendering goes through DocumentSource. Today every document is "simulated" from
// printed_content; registering a real file (window.WP_REAL_DOCS = {D08: {1: 'w2.png'}}) swaps in
// the image and the same extracted-value positions become the highlight boxes. Links never change:
// #/docs/<doc>/<page>?ev=<ev-id>.

import * as M from '../model.js';
import { resolveRef, refKind, line as getLine, dependents } from '../data.js';
import { esc, attr, fmt, fmtDate, num, refChip, sev, btn, who, section, table, pill, sensitive, methodLabel, areaLink } from '../ui.js';

const SENS_FIELDS = /ssn|account|ip_pin|routing/i;

export function inspector(ctx, ref) {
  return `<div class="insp-h"><button class="icon" data-a="closeInspect" aria-label="Close">✕</button><a class="sm" href="#/trace/${encodeURIComponent(ref)}">Open full page ↗</a></div>${traceBody(ctx, ref)}`;
}
export function viewTrace(ctx, ref) { return `<div class="tracepage">${traceBody(ctx, ref, true)}</div>`; }

function traceBody(ctx, ref, full = false) {
  const k = refKind(ref);
  if (k === 'line') return traceLine(ctx, ref, full);
  if (k === 'ev') return traceEv(ctx, ref);
  if (k === 'doc' || k === 'docpage') return traceDoc(ctx, ref);
  return traceOther(ctx, ref);
}

// ---------------------------------------------------------------- lines
function traceLine(ctx, key, full) {
  const lv = M.lineView(ctx, key);
  const l = lv.line;
  if (!l) return `<div class="tb"><h2>${esc(key)}</h2><p class="muted">Not on the return in ${ctx.vid}.</p>${history(ctx, key)}</div>`;
  const cents = l.form === 'F8949' && !key.endsWith('total');
  const area = M.areaOf(key);
  const findings = ctx.findings.filter(f => (f.lines || []).includes(key) && f.kind !== 'pass');
  const notes = [...ctx.state.notes.values()].filter(n => n.refs?.includes(key));
  const evid = ctx.state.evidence.filter(e => e.target === key);
  const ver = lv.verified || [];
  const adjs = [...ctx.state.adjustments.values()].filter(a => a.line === key);
  const deps = dependents(ctx.idx, ctx.vid, key);
  const val = typeof lv.value === 'number' ? fmt(lv.value, { cents }) : esc(lv.text ? String(lv.value).replace(lv.text.from, lv.text.to) : lv.value);
  return `<div class="tb">
    <div class="eyebrow">${esc(l.form)} · line ${esc(l.line)} · ${esc(l.jurisdiction)} · ${areaLink(area)}</div>
    <h2>${esc(lv.text ? l.label.replace(lv.text.from, lv.text.to) : l.label)}</h2>
    <div class="bigval">${lv.adj ? `<s>${typeof lv.original === 'number' ? fmt(lv.original, { cents }) : esc(lv.original)}</s>` : ''}<span>${val}</span>
      ${lv.adj ? pill(lv.adj.status === 'approved' ? 'adjusted · approved' : 'adjustment proposed', lv.adj.status === 'approved' ? 'ok' : 'warn') : pill('engine ' + ctx.vid)}
      ${ver.length ? pill('✓ ' + methodLabel(ver.at(-1).method) + ' · ' + M.userName(ctx.idx, ver.at(-1).by), 'ok') : pill('not verified', 'muted')}</div>
    <div class="actions">${btn('Verify', 'verify', { target: key, value: lv.value })}${typeof l.value === 'number' ? btn('Adjust', 'manualAdjust', { key }) : ''}${btn('Note', 'note', { kind: 'note', ref: key })}${btn('Ask client', 'note', { kind: 'question', ref: key })}${M.can(ctx.user, 'review') ? btn('Review note', 'note', { kind: 'review', ref: key }, 'warn') : ''}${btn('Attach evidence', 'attach', { target: key })}</div>
    ${findings.length ? `<div class="callout">${findings.map(f => `<div>${sev(f.severity)} <a href="#/findings?f=${f.id}"><b>${esc(f.title)}</b></a><br><span class="sm">${esc(f.summary)}</span></div>`).join('')}</div>` : ''}
    <h4>How it was built</h4>
    <div class="rule"><b>${esc(l.rule)}</b> — ${esc(ctx.idx.rules[l.rule] || 'Engine rule')}${l.note ? `<br><span class="muted">${esc(l.note)}</span>` : ''}</div>
    ${l.inputs?.length ? `<div class="tree">${l.inputs.map(k => treeNode(ctx, k, 1, full ? 3 : 2)).join('')}<div class="tn total">= ${val}</div></div>` : ''}
    ${l.sources?.length ? `<h4>Where it came from</h4>${l.sources.map(s => sourceCard(ctx, s)).join('')}` : (l.inputs?.length ? '' : '<p class="muted">No source recorded by the engine.</p>')}
    ${adjs.length ? `<h4>Adjustments (original kept)</h4>${adjs.map(a => adjCard(ctx, a)).join('')}` : ''}
    ${ver.length ? `<h4>Verification</h4><ul class="vlist">${ver.map(v => `<li>✓ ${esc(methodLabel(v.method))} by ${who(ctx, v.by)} <small>${fmtDate(v.at, true)}</small>${v.note ? `<br><span class="sm">${esc(v.note)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${notes.length || evid.length ? `<h4>Notes, questions & evidence</h4>${notes.map(n => noteMini(ctx, n)).join('')}${evid.map(e => evidMini(ctx, e)).join('')}` : ''}
    ${deps.length ? `<h4>Flows into</h4><div class="chips">${deps.map(d => refChip(ctx, d)).join('')}</div>` : ''}
    ${history(ctx, key)}
  </div>`;
}

function treeNode(ctx, key, depth, max) {
  const l = getLine(ctx.idx, ctx.vid, key);
  if (!l) return `<div class="tn d${depth}">${esc(key)} <span class="muted">(not present)</span></div>`;
  const kids = depth < max && l.inputs?.length ? `<div class="tk">${l.inputs.map(k => treeNode(ctx, k, depth + 1, max)).join('')}</div>` : (l.inputs?.length ? `<span class="muted sm"> · ${l.inputs.length} inputs</span>` : '');
  const src = !l.inputs?.length && l.sources?.length ? `<span class="srcs">${l.sources.slice(0, 3).map(s => refChip(ctx, s, s.startsWith('ev-') ? undefined : undefined)).join('')}${l.sources.length > 3 ? `<span class="muted sm">+${l.sources.length - 3}</span>` : ''}</span>` : '';
  return `<div class="tn d${depth}"><span class="tl">${esc(l.label)}</span> <span class="tkey">${esc(key)}</span> ${num(ctx, key)}${src}${kids}</div>`;
}

export function sourceCard(ctx, ref) {
  const r = resolveRef(ctx.idx, ref, ctx.vid);
  const k = refKind(ref);
  if (k === 'ev' && r.ev) {
    const e = r.ev, d = r.doc;
    const received = !ctx.clock || d.received_at <= ctx.clock;
    const sens = SENS_FIELDS.test(e.field) || ['ssn', 'account_number'].includes(e.value_type);
    const v = sens ? sensitive(ctx, e.value, e.value_type === 'ssn' ? 'ssn' : 'acct', e.id) : (typeof e.value === 'number' ? fmt(e.value, { cents: e.value % 1 !== 0 }) : esc(e.value ?? '(blank)'));
    const page = d.pages.find(p => p.page === e.page);
    const onPage = !e.text_as_read || (page && asPrinted(page.printed_content, e));
    const ver = ctx.state.verifications.get(e.id);
    return `<div class="src">
      <div class="src-h"><a href="#/docs/${d.id}/${e.page}?ev=${e.id}" class="doclink">▤ ${esc(d.id)} · ${esc(d.title)}</a><span class="muted sm">page ${e.page} of ${d.page_count}${d.marked_corrected ? ' · CORRECTED' : ''}</span></div>
      <div class="src-f"><span class="fld">${esc(e.label)}</span> <code>${esc(e.field)}</code><b class="fv">${v}</b><span class="conf ${e.confidence < 0.8 ? 'low' : e.confidence < 0.95 ? 'mid' : ''}" title="Pipeline confidence">${Math.round(e.confidence * 100)}%</span></div>
      ${page && !sens ? `<div class="snip">${snippet(page.printed_content, e)}</div>` : ''}
      ${!onPage && e.text_as_read && !sens ? `<div class="warn sm">“${esc(e.text_as_read)}” (as read) does not appear verbatim in the printed text — check the page.</div>` : ''}
      ${!received ? `<div class="warn sm">Received ${fmtDate(d.received_at)} — after the season clock.</div>` : ''}
      <div class="src-a">${ver ? `<span class="pill ok">✓ ${esc(methodLabel(ver.at(-1).method))} · ${esc(M.userName(ctx.idx, ver.at(-1).by))}</span>` : btn('Agree to source', 'verify', { target: e.id, value: e.value }, 'sm')}<a class="btn sm ghost" href="#/docs/${d.id}/${e.page}?ev=${e.id}">Open page at field</a></div>
    </div>`;
  }
  if (k === 'doc' || k === 'docpage') return `<div class="src"><a href="#/docs/${r.doc.id}${r.page ? '/' + r.page : ''}" class="doclink">▤ ${esc(r.label)}</a>${r.page ? `<div class="snip">${esc(r.doc.pages.find(p => p.page === r.page)?.printed_content || '')}</div>` : ''}</div>`;
  if (k === 'qa') return `<div class="src qa"><div class="src-h"><b>Client questionnaire ${esc(ref)}</b><span class="muted sm">${esc(r.qa.answered_by)} · ${fmtDate(r.qa.answered_at)}</span></div><div class="q">Q: ${esc(r.qa.question)}</div><div class="a">A: “${esc(r.qa.answer)}”</div><div class="muted sm">Client answer — not a third-party record.</div></div>`;
  if (k === 'msg') return `<div class="src qa"><div class="src-h"><b>Message ${esc(ref)}</b><span class="muted sm">${esc(r.msg.from)} · ${fmtDate(r.msg.sent_at, true)}</span></div><div class="a">“${esc(r.msg.text)}”</div></div>`;
  if (k === 'call') return `<div class="src qa"><div class="src-h"><b>Call notes ${esc(ref)}</b><span class="muted sm">${fmtDate(r.call.date)} · ${esc(r.call.participants.join(', '))}</span></div><ul class="sm">${r.call.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  if (k === 'asset' && r.asset) {
    const a = r.asset;
    return `<div class="src"><div class="src-h"><a href="#/schedule/depreciation" class="doclink">▦ ${esc(a.asset_id)} · ${esc(a.description)}</a></div><div class="sm">Cost ${fmt(a.cost)} · in service ${esc(a.placed_in_service)} · ${esc(a.method)} · ${a.life_years} yr${a.federal?.depreciation_2025 != null ? ` · 2025 federal ${fmt(a.federal.depreciation_2025, { cents: true })} · CA ${fmt(a.california.depreciation_2025, { cents: true })}` : ''}</div></div>`;
  }
  if (k === 'household' && r.person) return `<div class="src"><div class="src-h"><b>Household · ${esc(r.person.name)}</b></div><div class="sm">${esc(r.person.relationship || r.person.role)} · born ${esc(r.person.dob)} · SSN ${sensitive(ctx, effectiveSsn(ctx, r.person), 'ssn', 'household:' + r.person.id)}${r.person.full_time_student ? ' · full-time student' : ''}${r.person.months_lived_with_you ? ` · ${r.person.months_lived_with_you} months at home` : ''}</div></div>`;
  const v = r.value;
  return `<div class="src"><div class="src-h"><b>${esc(r.label)}</b></div>${v !== undefined ? `<pre class="val">${esc(typeof v === 'object' ? JSON.stringify(v, null, 1) : v)}</pre>` : ''}</div>`;
}
export function effectiveSsn(ctx, p) { return ctx.state.fixes.get(`${p.id}.ssn`)?.to || p.ssn; }

function snippet(text, e) {
  const pos = findInText(text, e);
  if (pos < 0) return esc(text.length > 220 ? text.slice(0, 220) + '…' : text);
  const len = asPrinted(text, e).length;
  const a = Math.max(0, pos - 90), b = Math.min(text.length, pos + len + 90);
  return (a > 0 ? '…' : '') + esc(text.slice(a, pos)) + `<mark>${esc(text.slice(pos, pos + len))}</mark>` + esc(text.slice(pos + len, b)) + (b < text.length ? '…' : '');
}
// Locate an extracted value's text on the page, preferring the occurrence near its box label.
// The string as it appears on the page: what the pipeline read, or the normalized value (dates).
export function asPrinted(text, e) {
  for (const c of [e.text_as_read, e.value == null ? '' : String(e.value)]) if (c && text.includes(String(c))) return String(c);
  return null;
}
function findInText(text, e, used = new Set()) {
  const t = asPrinted(text, e) || '';
  if (!t) return -1;
  const occ = [];
  let i = text.indexOf(t);
  while (i >= 0) { occ.push(i); i = text.indexOf(t, i + 1); }
  if (!occ.length) return -1;
  const hints = [];
  const box = e.label.match(/Box (\w+)/i)?.[1]; if (box) hints.push(`Box ${box} `, `Box ${box.toUpperCase()} `, `${box} `);
  const lot = e.field.match(/^([A-Z]+\d+)_/)?.[1]; if (lot) hints.push(lot + ' ');
  const trip = e.field.match(/^trip(\d+)_/);
  const score = (p) => { const pre = text.slice(Math.max(0, p - 60), p); let s = 0; hints.forEach((h, j) => { const k = pre.lastIndexOf(h); if (k >= 0) s += 100 - (pre.length - k) - j; }); return s; };
  const cands = occ.filter(p => !used.has(p));
  if (!cands.length) return occ[0];
  if (trip) return cands[0];
  return cands.sort((a, b) => score(b) - score(a))[0];
}

function adjCard(ctx, a) {
  const e = a.effect || M.effectOf(a.effects, ctx.rates);
  return `<div class="adj ${a.status}"><div><b>${fmt(a.from)} → ${fmt(a.to)}</b> ${pill(a.status, a.status === 'approved' ? 'ok' : a.status === 'proposed' ? 'warn' : 'muted')}${a.requiresPartner ? pill('partner required', 'warn') : ''}</div>
    <div class="sm">${esc(a.reason)}${a.authority ? ` · <i>${esc(a.authority)}</i>` : ''}</div>
    <div class="sm muted">by ${esc(M.userName(ctx.idx, a.by))} ${fmtDate(a.at, true)} · tax effect fed ${fmt(e.fed, { sign: true })}, CA ${fmt(e.ca, { sign: true })}${e.fedPay || e.caPay ? `, payments fed ${fmt(e.fedPay, { sign: true })} CA ${fmt(e.caPay, { sign: true })}` : ''}${a.approvals.length ? ' · approved by ' + a.approvals.map(x => M.userName(ctx.idx, x.by) + ' (' + x.level + ')').join(', ') : ''}</div>
    ${a.status === 'proposed' ? `<div class="src-a">${btn('Approve', 'approveAdj', { id: a.id }, 'sm')}${btn('Reject', 'rejectAdj', { id: a.id }, 'sm ghost')}${a.by === ctx.user.id ? btn('Withdraw', 'withdrawAdj', { id: a.id }, 'sm ghost') : ''}</div>` : ''}</div>`;
}
export { adjCard };

function noteMini(ctx, n) {
  return `<div class="nm ${n.kind} ${n.status}">${pill(n.kind, n.kind === 'review' ? 'warn' : '')} ${pill(n.status, n.status === 'open' ? '' : 'ok')} <b>${esc(M.userName(ctx.idx, n.by))}</b>${n.to ? ' → ' + esc(n.to === 'client' ? 'client' : M.userName(ctx.idx, n.to)) : ''}: ${esc(n.text)}
    ${n.replies.map(r => `<div class="rep"><b>${esc(M.userName(ctx.idx, r.by))}</b>: ${esc(r.text)}</div>`).join('')}${n.resolution ? `<div class="rep ok">Resolved: ${esc(n.resolution)}</div>` : ''}</div>`;
}
function evidMini(ctx, e) {
  return `<div class="nm">📎 <b>${esc(e.name)}</b> by ${esc(M.userName(ctx.idx, e.by))} ${fmtDate(e.at)}${e.text ? `<div class="sm">${esc(e.text)}</div>` : ''}${e.fileId ? ' ' + btn('Open file', 'openFile', { id: e.fileId }, 'sm ghost') : ''}</div>`;
}
export { noteMini, evidMini };

function history(ctx, key) {
  const rows = ctx.idx.versions.map(v => { const l = getLine(ctx.idx, v.version, key); return `<td class="r">${l ? (typeof l.value === 'number' ? fmt(l.value) : esc(l.value)) : '—'}</td>`; });
  const py = ctx.idx.packet.prior_years.return_2024.lines[key];
  const lv = M.lineView(ctx, key);
  return `<h4>History</h4><table class="t mini"><thead><tr><th class="r">2024 filed</th>${ctx.idx.versions.map(v => `<th class="r">${v.version} <small>${fmtDate(v.computed_at)}</small></th>`).join('')}<th class="r">Workpaper</th></tr></thead><tbody><tr><td class="r">${py != null ? fmt(py) : '—'}</td>${rows.join('')}<td class="r b">${lv.line ? (typeof lv.value === 'number' ? fmt(lv.value) : esc(lv.value)) : '—'}</td></tr></tbody></table>`;
}

// ---------------------------------------------------------------- extracted values and docs
function traceEv(ctx, id) {
  const e = ctx.idx.evs.get(id);
  if (!e) return `<div class="tb"><h2>${esc(id)}</h2><p>Unknown value.</p></div>`;
  const used = (ctx.idx.usedBy.get(id) || []);
  const byV = {};
  for (const u of used) (byV[u.version] ||= []).push(u.key);
  return `<div class="tb"><div class="eyebrow">Extracted value ${esc(id)}</div><h2>${esc(e.label)}</h2>${sourceCard(ctx, id)}
    <h4>Where it landed</h4>${Object.keys(byV).length ? ctx.idx.versions.map(v => byV[v.version] ? `<div><b>${v.version}</b> <div class="chips">${byV[v.version].map(k => v.version === ctx.vid ? refChip(ctx, k) : `<span class="chip">${esc(k)}</span>`).join('')}</div></div>` : `<div class="muted sm">${v.version}: not used</div>`).join('') : `<p class="muted">Not used on any return line. ${whyNotUsed(ctx, e)}</p>`}
    <div class="actions">${btn('Verify', 'verify', { target: id, value: e.value })}${btn('Note', 'note', { kind: 'note', ref: id })}</div></div>`;
}
function whyNotUsed(ctx, e) {
  const d = ctx.idx.docs.get(e.document_id);
  if (ctx.v.documents_superseded.includes(d.id)) return 'The document was superseded.';
  if (d.id === 'D10') return 'Duplicate image of D09 (counted once from D09).';
  if (/date|name|ein|ssn|payer|employer|description|quantity|term|covered|_year$/.test(e.field)) return 'Identifying or supporting field (used to match and label, not as an amount).';
  return 'Supporting detail.';
}

function traceDoc(ctx, ref) {
  const id = ref.replace(/^doc:/, '').split('#')[0];
  const d = ctx.idx.docs.get(id);
  const st = M.docStatus(ctx, d);
  return `<div class="tb"><div class="eyebrow">Document ${esc(d.id)} · ${esc(d.document_type)}</div><h2>${esc(d.title)}</h2>
    <p class="sm">${esc(d.issuer)} · ${esc(d.belongs_to)} · received ${fmtDate(d.received_at, true)} via ${esc(d.uploaded_by)} · ${d.page_count} pages · <code>${esc(d.file_name)}</code></p>
    <p>${pill(st.label, st.code === 'used' ? 'ok' : st.code === 'unaccounted' ? 'warn' : '')} ${esc(st.reason || '')}</p>
    ${st.land?.lines?.length ? `<h4>Landed on</h4><div class="chips">${st.land.lines.map(k => refChip(ctx, k)).join('')}</div>` : ''}
    <a class="btn" href="#/docs/${d.id}">Open document</a></div>`;
}
function traceOther(ctx, ref) {
  return `<div class="tb"><div class="eyebrow">${esc(refKind(ref))}</div><h2>${esc(ref)}</h2>${sourceCard(ctx, ref)}${(ctx.idx.usedBy.get(ref) || []).length ? `<h4>Used by</h4><div class="chips">${ctx.idx.usedBy.get(ref).filter(u => u.version === ctx.vid).map(u => refChip(ctx, u.key)).join('')}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------- document index
export function viewDocs(ctx, q) {
  const filter = q.get('s') || 'all';
  const docs = [...ctx.idx.docs.values()];
  const stats = {};
  const rows = docs.map(d => {
    const st = M.docStatus(ctx, d); stats[st.code] = (stats[st.code] || 0) + 1;
    if (filter !== 'all' && st.code !== filter) return '';
    const ev = (ctx.idx.evsByDoc.get(d.id) || []);
    const low = ev.filter(e => e.confidence < 0.9).length;
    const fnd = ctx.findings.filter(f => f.kind !== 'pass' && (f.evidence || []).some(r => r === d.id || ctx.idx.evs.get(r)?.document_id === d.id) && ['open', 'adjusting'].includes(M.findingState(ctx, f))).length;
    return `<tr class="${st.code === 'future' ? 'future' : ''}"><td><a href="#/docs/${d.id}"><b>${d.id}</b></a></td><td><a href="#/docs/${d.id}">${esc(d.title)}</a>${d.marked_corrected ? ' ' + pill('CORRECTED', 'warn') : ''}</td><td>${esc(d.document_type)}</td><td>${esc(M.AREA[M.areaOfDoc(d.id)]?.name.split(' ')[0])}</td><td>${fmtDate(d.received_at)}</td><td>${esc(d.extraction.status)}${d.extraction.status !== 'extracted' ? ` <span class="muted sm" title="${attr(d.extraction.reason)}">ⓘ</span>` : ''} · ${ev.length}${low ? ` <span class="warn sm">${low} low-conf</span>` : ''}</td>
      <td>${pill(st.label, { used: 'ok', unaccounted: 'warn', future: 'muted', superseded: '', duplicate: '', reference: '' }[st.code] || '')}${st.reason ? `<div class="sm muted">${esc(st.reason)}</div>` : ''}</td><td>${fnd ? `<a href="#/findings?doc=${d.id}" class="warn">${fnd} open</a>` : ''}</td>
      <td>${st.code === 'unaccounted' || st.code === 'reference' ? btn('Disposition', 'disposition', { doc: d.id }, 'sm ghost') : ''}</td></tr>`;
  });
  const tabs = [['all', 'All'], ['used', 'Used'], ['reference', 'Reference'], ['superseded', 'Superseded'], ['duplicate', 'Duplicate'], ['dispositioned', 'Dispositioned'], ['unaccounted', 'Needs disposition'], ['future', 'Not yet received']];
  return `<div class="hero"><div><h1>Document index</h1><p class="sub">Every document, where it landed, or why it did not. ${docs.length} documents; ${stats.unaccounted || 0} still need a disposition.</p></div><div class="hero-a">${btn('Attach a document / note', 'attach', { target: 'return' })}</div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/docs?s=${k}" class="${filter === k ? 'on' : ''}">${l}${k === 'all' ? '' : ` <b>${stats[k] || 0}</b>`}</a>`).join('')}</div>
    ${section('', table(['ID', 'Document', 'Type', 'Area', 'Received', 'Extraction', 'Where it landed', 'Findings', ''], rows))}
    ${ctx.state.evidence.length ? section('Evidence attached by people', table(['What', 'On', 'By', 'When', ''], ctx.state.evidence.map(e => `<tr><td>${esc(e.name)}${e.text ? `<div class="sm muted">${esc(e.text.slice(0, 140))}</div>` : ''}</td><td>${esc(e.target)}</td><td>${esc(M.userName(ctx.idx, e.by))}</td><td>${fmtDate(e.at, true)}</td><td>${e.fileId ? btn('Open', 'openFile', { id: e.fileId }, 'sm ghost') : ''}</td></tr>`))) : ''}`;
}

// ---------------------------------------------------------------- document viewer
export function viewDoc(ctx, id, pageNo, evSel) {
  const d = ctx.idx.docs.get(id);
  if (!d) return '<div class="card">Unknown document</div>';
  const page = d.pages.find(p => p.page === (pageNo || d.pages[0].page)) || d.pages[0];
  const evs = (ctx.idx.evsByDoc.get(id) || []).filter(e => e.page === page.page);
  const mode = new URLSearchParams(location.hash.split('?')[1] || '').get('mode') || 'text';
  const st = M.docStatus(ctx, d);
  const sel = evSel ? ctx.idx.evs.get(evSel) : null;
  const real = (window.WP_REAL_DOCS || {})[id]?.[page.page];
  const pageList = d.pages.length > 1 ? `<div class="pages">${d.pages.map(p => { const n = (ctx.idx.evsByDoc.get(id) || []).filter(e => e.page === p.page).length; const unread = d.extraction.reason?.includes(`page ${p.page}`) || d.extraction.reason?.includes(`Page ${p.page}`); return `<a href="#/docs/${id}/${p.page}" class="${p.page === page.page ? 'on' : ''} ${unread ? 'unread' : ''}" title="${n} values${unread ? ' · NOT READ by pipeline' : ''}">${p.page}${n ? `<small>${n}</small>` : ''}${unread ? '<small>!</small>' : ''}</a>`; }).join('')}</div>` : '';
  const sensDoc = d.document_type === 'identity_document' || d.document_type === 'irs_ip_pin_notice';
  return `<div class="hero"><div><div class="eyebrow">${esc(d.id)} · ${esc(d.document_type)} · ${esc(d.issuer)}</div><h1>${esc(d.title)}</h1>
    <p class="sub">Received ${fmtDate(d.received_at, true)} (${esc(d.uploaded_by)}) · <code>${esc(d.file_name)}</code> · extraction ${esc(d.extraction.status)}${d.extraction.reason ? ' — ' + esc(d.extraction.reason) : ''}</p>
    <p>${pill(st.label, st.code === 'used' ? 'ok' : st.code === 'unaccounted' ? 'warn' : '')} ${esc(st.reason || '')}</p></div>
    <div class="hero-a"><div class="seg"><a href="#/docs/${id}/${page.page}?mode=text${evSel ? '&ev=' + evSel : ''}" class="${mode === 'text' ? 'on' : ''}">Text</a><a href="#/docs/${id}/${page.page}?mode=layout${evSel ? '&ev=' + evSel : ''}" class="${mode === 'layout' ? 'on' : ''}">Layout</a></div>${btn('Note', 'note', { kind: 'note', ref: id })}${btn('Attach', 'attach', { target: id })}${btn('Disposition', 'disposition', { doc: id }, 'ghost')}</div></div>
  ${pageList}
  <div class="docwrap">
    <div class="paper-wrap">
      <div class="paper ${mode}" data-doc="${id}">
        <div class="paper-h"><span>${esc(d.issuer)}</span><span>${esc(d.file_name)} · page ${page.page}/${d.page_count}</span></div>
        ${mode === 'layout' ? layoutPage(ctx, page, evs, sel, real) : textPage(ctx, page, evs, sel, sensDoc)}
        <div class="paper-f">Simulated from printed_content · ${real ? 'real image registered' : 'replace with the source file via DocumentSource — links and highlights stay the same'}</div>
      </div>
    </div>
    <div class="fields">
      <h4>Extracted on this page (${evs.length})</h4>
      ${evs.length ? `<table class="t mini"><thead><tr><th>Field</th><th class="r">Value</th><th class="r">Conf.</th><th>Landed on</th></tr></thead><tbody>${evs.map(e => {
        const used = (ctx.idx.usedBy.get(e.id) || []).filter(u => u.version === ctx.vid).map(u => u.key);
        const sens = SENS_FIELDS.test(e.field) || ['ssn', 'account_number'].includes(e.value_type);
        const onPage = !e.text_as_read || asPrinted(page.printed_content, e);
        const v = sens ? sensitive(ctx, e.value, e.value_type === 'ssn' ? 'ssn' : 'acct', e.id) : (typeof e.value === 'number' ? fmt(e.value, { cents: e.value % 1 !== 0 }) : esc(e.value ?? '(blank)'));
        const ver = ctx.state.verifications.get(e.id);
        return `<tr class="${sel?.id === e.id ? 'sel' : ''}" id="row-${e.id}"><td><label class="cb sm"><input type="checkbox" data-a="toggleSel" data-group="ev" data-key="${e.id}"> <a href="#/docs/${id}/${page.page}?mode=${mode}&ev=${e.id}">${esc(e.label)}</a></label>${!onPage ? '<div class="warn sm">not found verbatim on page</div>' : ''}</td><td class="r">${v}${ver ? ' <span class="tick">✓</span>' : ''}</td><td class="r"><span class="conf ${e.confidence < 0.8 ? 'low' : e.confidence < 0.95 ? 'mid' : ''}">${Math.round(e.confidence * 100)}</span></td><td>${used.length ? used.slice(0, 3).map(k => refChip(ctx, k)).join('') + (used.length > 3 ? `<span class="muted sm">+${used.length - 3}</span>` : '') : `<span class="muted sm">${esc(whyNotUsed(ctx, e))}</span>`}</td></tr>`;
      }).join('')}</tbody></table><div class="bulk">${btn('Select all', 'selAll', { group: 'ev' }, 'sm ghost')}${btn('Verify selected (<span id="selcount">0</span>)', 'bulkVerify', {}, 'sm')}</div>` : `<p class="muted">${d.extraction.status === 'not_extracted' ? esc(d.extraction.reason) : 'Nothing extracted on this page.'}</p>`}
      ${sel ? `<h4>Selected</h4>${traceEvCompact(ctx, sel)}` : ''}
    </div>
  </div>`;
}
function traceEvCompact(ctx, e) {
  const used = (ctx.idx.usedBy.get(e.id) || []).filter(u => u.version === ctx.vid).map(u => u.key);
  return `<div class="src"><b>${esc(e.label)}</b> <code>${esc(e.id)}</code><div class="sm">as read “${esc(e.text_as_read)}” · confidence ${Math.round(e.confidence * 100)}% · box at (${e.position.x0.toFixed(2)}, ${e.position.y0.toFixed(2)})</div>${used.length ? `<div class="chips">${used.map(k => refChip(ctx, k)).join('')}</div>` : ''}<div class="src-a">${btn('Agree to source', 'verify', { target: e.id, value: e.value }, 'sm')}${btn('Trace', 'inspect', { ref: e.id }, 'sm ghost')}</div></div>`;
}

function textPage(ctx, page, evs, sel, sensDoc) {
  const text = page.printed_content;
  const spans = []; const used = new Set();
  for (const e of evs) {
    const p = findInText(text, e, used);
    if (p < 0) continue;
    const len = asPrinted(text, e).length;
    if (spans.some(s => p < s.b && p + len > s.a)) continue;
    used.add(p); spans.push({ a: p, b: p + len, e });
  }
  spans.sort((x, y) => x.a - y.a);
  let out = '', i = 0;
  const maskText = (t) => sensDoc || !M.cleared(ctx.user) ? t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, m => '•••-••-' + m.slice(-4)).replace(/\b(PIN for returns[^.]*? is )(\d+)/, '$1••••••').replace(/(SE\d{2}[\d ]+)/, m => '•••• ' + m.slice(-4)) : t;
  for (const s of spans) {
    out += esc(maskText(text.slice(i, s.a)));
    const used = (ctx.idx.usedBy.get(s.e.id) || []).some(u => u.version === ctx.vid);
    const sens = SENS_FIELDS.test(s.e.field) || ['ssn', 'account_number'].includes(s.e.value_type);
    out += `<a href="#/docs/${s.e.document_id}/${page.page}?ev=${s.e.id}" class="hl ${used ? 'used' : ''} ${sel?.id === s.e.id ? 'sel' : ''} ${s.e.confidence < 0.8 ? 'low' : ''}" title="${attr(s.e.label)} · ${Math.round(s.e.confidence * 100)}%">${esc(sens ? maskText(text.slice(s.a, s.b)) : text.slice(s.a, s.b))}</a>`;
    i = s.b;
  }
  out += esc(maskText(text.slice(i)));
  return `<div class="paper-b">${out.replace(/; /g, ';<br>')}</div>`;
}
function layoutPage(ctx, page, evs, sel, real) {
  const boxes = evs.map(e => {
    const p = e.position; const used = (ctx.idx.usedBy.get(e.id) || []).some(u => u.version === ctx.vid);
    const sens = SENS_FIELDS.test(e.field) || ['ssn', 'account_number'].includes(e.value_type);
    return `<a href="#/docs/${e.document_id}/${page.page}?mode=layout&ev=${e.id}" class="box ${used ? 'used' : ''} ${sel?.id === e.id ? 'sel' : ''} ${e.confidence < 0.8 ? 'low' : ''}" style="left:${p.x0 * 100}%;top:${p.y0 * 100}%;width:${Math.max(6, (p.x1 - p.x0) * 100)}%;height:${Math.max(2.2, (p.y1 - p.y0) * 100)}%" title="${attr(e.label)}"><small>${esc(e.label.slice(0, 26))}</small>${esc(sens ? '••••' : e.text_as_read || '∅')}</a>`;
  }).join('');
  return `<div class="layout">${real ? `<img src="${attr(real)}" alt="">` : `<div class="ghost-text">${esc(page.printed_content)}</div>`}${boxes}</div>`;
}
