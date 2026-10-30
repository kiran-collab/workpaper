import * as M from '../model.js';
import { line as getLine } from '../data.js';
import { esc, attr, fmt, fmtDelta, fmtDate, num, refChip, sev, btn, who, section, table, pill, areaLink } from '../ui.js';
import { noteMini } from './trace.js';

const KIND = { engine: ['Engine error', 'bad'], extraction: ['Extraction error', 'bad'], client: ['Needs client / conflict', 'warn'], judgment: ['Judgment call', 'warn'], outside: ['Outside filing', ''], diagnostic: ['Engine diagnostic', ''], pass: ['Independent check passed', 'ok'], system: ['System', ''], ai: ['AI finding', 'warn'] };
const VERDICT = { confirmed: ['AI reviewer: confirmed', 'ok'], refuted: ['AI reviewer: refuted', 'bad'], uncertain: ['AI reviewer: uncertain', 'warn'] };
const STATE = { open: ['Open', ''], adjusting: ['Adjustment pending', 'warn'], resolved: ['Resolved', 'ok'], accepted: ['Accepted as is', 'ok'], dismissed: ['Dismissed', 'muted'], passed: ['Passed', 'ok'] };

export function findingCard(ctx, f, focus) {
  const st = M.findingState(ctx, f);
  const adjs = [...ctx.state.adjustments.values()].filter(a => a.findingId === f.id && a.status !== 'withdrawn');
  const tot = (f.adjustments || []).reduce((s, a) => { const e = M.effectOf(a.effects, ctx.rates); return { fed: s.fed + e.fed, ca: s.ca + e.ca, fp: s.fp + e.fedPay, cp: s.cp + e.caPay }; }, { fed: 0, ca: 0, fp: 0, cp: 0 });
  const status = ctx.state.findingStatus.get(f.id);
  const notes = [...ctx.state.notes.values()].filter(n => n.findingId === f.id);
  const canAct = M.can(ctx.user, 'finding');
  const primary = [
    f.adjustments?.length && !adjs.some(a => a.status !== 'rejected') && M.can(ctx.user, 'adjust') ? btn('Propose adjustment', 'proposeFinding', { id: f.id }, 'primary') : '',
    f.fixHousehold && !ctx.state.fixes.has(`${f.fixHousehold.person}.${f.fixHousehold.field}`) ? btn('Correct on return', 'fixHousehold', { id: f.id }, 'primary') : '',
    f.textFix && !ctx.state.textFixes.has(f.textFix.line) && f.textFix.to ? btn(`Correct to ${esc(f.textFix.to)}`, 'fixText', { id: f.id }, 'primary') : '',
    f.question ? btn(f.question.to === 'client' ? 'Ask client' : 'Ask colleague', 'askFromFinding', { id: f.id }) : '',
    canAct && !['open', 'adjusting'].includes(st) ? btn('Reopen', 'reopenFinding', { id: f.id }) : '',
  ].join('');
  const secondary = [
    canAct && ['open', 'adjusting'].includes(st) ? btn('Mark resolved', 'findingStatus', { id: f.id, status: 'resolved' }) + btn('Accept as is', 'findingStatus', { id: f.id, status: 'accepted' }) + btn('Dismiss', 'findingStatus', { id: f.id, status: 'dismissed' }) : '',
    M.can(ctx.user, 'review') ? btn('Add review note', 'note', { kind: 'review', ref: f.lines?.[0] || '', area: f.area, text: f.title + ': ' }) : '',
    btn('Record judgment', 'decision', { topic: f.title, ref: f.lines?.[0] || '', fed: tot.fed, ca: tot.ca }),
  ].join('');
  const actions = f.kind === 'pass' ? '' : `<div class="fbar">${primary}<details class="menu"><summary class="btn ghost">More ▾</summary><div class="menu-b">${secondary}</div></details></div>`;
  const ev = (f.evidence || []).filter(Boolean);
  const lines = (f.lines || []).filter(k => getLine(ctx.idx, ctx.vid, k));
  const moreLabel = [ev.length ? `${ev.length} source${ev.length > 1 ? 's' : ''}` : '', lines.length ? `${lines.length} line${lines.length > 1 ? 's' : ''}` : '', f.adjustments?.length ? 'proposed changes' : ''].filter(Boolean).join(' · ');
  return `<article class="finding ${f.severity} ${focus ? 'focus' : ''} st-${st}" id="f-${f.id}">
    <header>${sev(f.severity)}<span>${esc(KIND[f.kind]?.[0] || f.kind)}</span><span>${areaLink(f.area)}</span>${st !== 'open' ? pill(STATE[st]?.[0] || st, STATE[st]?.[1]) : ''}
      ${tot.fed || tot.ca || tot.fp || tot.cp ? `<span class="r eff">Fed ${fmtDelta(tot.fed)} · CA ${fmtDelta(tot.ca)}${tot.fp || tot.cp ? ` · payments ${fmtDelta(tot.fp + tot.cp)}` : ''}</span>` : ''}</header>
    <h3>${esc(f.title)}</h3>
    <p>${esc(f.summary)}</p>
    ${f.ai ? aiLine(ctx, f) : ''}
    ${f.engine && f.expected ? `<div class="cmp"><div><small>${esc(f.engine.label)} (engine)</small><b>${typeof f.engine.value === 'number' ? fmt(f.engine.value) : esc(f.engine.value)}</b></div><span>→</span><div><small>${esc(f.expected.label)}</small><b>${typeof f.expected.value === 'number' ? fmt(f.expected.value) : esc(f.expected.value)}</b></div></div>` : ''}
    ${moreLabel || f.detail?.filter(Boolean).length ? `<details class="more" ${focus ? 'open' : ''}><summary>Details${moreLabel ? ' · ' + moreLabel : ''}</summary>
    ${f.detail?.filter(Boolean).length ? `<ul class="det">${f.detail.filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${ev.length ? `<div class="chips"><span class="muted sm">Evidence</span>${ev.map(r => refChip(ctx, r)).join('')}</div>` : ''}
    ${lines.length ? `<div class="chips"><span class="muted sm">Lines</span>${lines.map(k => `<span class="lc">${esc(k)} ${num(ctx, k)}</span>`).join('')}</div>` : ''}
    ${f.adjustments?.length ? `<div class="adjlist">${f.adjustments.map(a => { const e = M.effectOf(a.effects, ctx.rates); return `<div class="adjrow"><b>${esc(a.line)}</b> ${fmt(a.from)} → <b>${fmt(a.to)}</b> <span class="muted sm">${esc(a.note || '')}</span>${e.fed || e.ca || e.fedPay || e.caPay ? `<span class="r sm">fed ${fmtDelta(e.fed)} · CA ${fmtDelta(e.ca)}${e.fedPay || e.caPay ? ` · pay ${fmtDelta(e.fedPay + e.caPay)}` : ''}</span>` : ''}</div>`; }).join('')}</div>` : ''}
    </details>` : ''}
    ${adjs.length ? `<div class="sm">Adjustments: ${adjs.map(a => `${esc(a.line)} ${pill(a.status, a.status === 'approved' ? 'ok' : 'warn')}`).join(' ')} <a href="#/adjustments">review</a></div>` : ''}
    ${status && status.status !== 'open' ? `<div class="sm ok-t">${esc(STATE[status.status]?.[0])} by ${esc(M.userName(ctx.idx, status.by))}: ${esc(status.reason)}</div>` : ''}
    ${notes.map(n => noteMini(ctx, n)).join('')}
    ${actions}
  </article>`;
}

// Who proposed an AI finding, how sure it was, and what the reviewer agent concluded.
function aiLine(ctx, f) {
  const r = f.ai.review;
  const v = r ? VERDICT[r.verdict] : null;
  return `<div class="ailine"><span class="aibadge">AI</span> Proposed by ${esc(M.userName(ctx.idx, f.ai.by))} · confidence ${Math.round((f.ai.confidence || 0) * 100)}%
    ${v ? pill(v[0], v[1]) : '<span class="pill">awaiting AI review</span>'}${r?.reasons?.length ? `<span class="muted sm">${esc(r.reasons[0])}</span>` : ''}
    <span class="muted sm">A person adopts it by proposing the adjustment; the usual approvals apply.</span></div>`;
}

export function viewFindings(ctx, q) {
  const area = q.get('area') || '', kind = q.get('kind') || '', show = q.get('show') || 'open', focus = q.get('f'), doc = q.get('doc');
  let list = ctx.findings;
  if (area) list = list.filter(f => f.area === area);
  if (kind) list = list.filter(f => f.kind === kind);
  if (doc) list = list.filter(f => (f.evidence || []).some(r => r === doc || ctx.idx.evs.get(r)?.document_id === doc));
  if (show === 'open') list = list.filter(f => ['open', 'adjusting'].includes(M.findingState(ctx, f)) && f.kind !== 'pass');
  if (show === 'closed') list = list.filter(f => !['open', 'adjusting', 'passed'].includes(M.findingState(ctx, f)));
  if (show === 'passed') list = list.filter(f => f.kind === 'pass');
  if (focus && !list.some(f => f.id === focus)) list = [ctx.findings.find(f => f.id === focus), ...list].filter(Boolean);
  const order = { high: 0, medium: 1, low: 2, info: 3, pass: 4 };
  list = list.slice().sort((a, b) => (order[a.severity] - order[b.severity]) || a.area.localeCompare(b.area));
  const all = ctx.findings;
  const cnt = (fn) => all.filter(fn).length;
  const sum = all.filter(f => ['open', 'adjusting'].includes(M.findingState(ctx, f))).flatMap(f => f.adjustments || []).reduce((s, a) => { const e = M.effectOf(a.effects, ctx.rates); return { fed: s.fed + e.fed, ca: s.ca + e.ca, fp: s.fp + e.fedPay, cp: s.cp + e.caPay }; }, { fed: 0, ca: 0, fp: 0, cp: 0 });
  const qs = (k, v) => { const p = new URLSearchParams(q); if (v) p.set(k, v); else p.delete(k); p.delete('f'); return '#/findings?' + p; };
  return `<div class="hero"><div><h1>Findings</h1><p class="sub">Independent checks recompute figures from documents, agency records and client answers. ${cnt(f => f.kind === 'pass')} agree with the engine; ${cnt(f => f.kind !== 'pass')} do not.</p></div>
    <div class="hero-a stat"><div><small>If all open findings are adopted</small><b>Fed ${fmtDelta(sum.fed)} · CA ${fmtDelta(sum.ca)}</b><small>Payments: fed ${fmtDelta(sum.fp)} · CA ${fmtDelta(sum.cp)}</small></div></div></div>
    <div class="tabs">${[['open', 'Open'], ['all', 'All'], ['closed', 'Closed'], ['passed', 'Passed checks']].map(([k, l]) => `<a href="${qs('show', k)}" class="${show === k ? 'on' : ''}">${l}</a>`).join('')}
      <select class="in sm" onchange="location.hash=this.value"><option value="${qs('area', '')}">All areas</option>${M.AREAS.map(a => `<option value="${qs('area', a.id)}" ${area === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <select class="in sm" onchange="location.hash=this.value"><option value="${qs('kind', '')}">All kinds</option>${Object.entries(KIND).map(([k, v]) => `<option value="${qs('kind', k)}" ${kind === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      ${doc ? `<a class="pill" href="${qs('doc', '')}">doc ${esc(doc)} ✕</a>` : ''}</div>
    <div class="findings">${list.map(f => findingCard(ctx, f, f.id === focus)).join('') || '<div class="empty">Nothing here.</div>'}</div>
`;
}

export function viewAdjustments(ctx) {
  const list = [...ctx.state.adjustments.values()].reverse();
  const rows = list.map(a => {
    const e = a.effect || M.effectOf(a.effects, ctx.rates);
    return `<tr class="st-${a.status}"><td>${a.status === 'proposed' ? `<input type="checkbox" data-a="toggleSel" data-group="adj" data-key="${a.id}">` : ''}</td>
      <td>${M.lineView(ctx, a.line).line ? `<button class="link" data-a="inspect" data-ref="${attr(a.line)}">${esc(a.line)}</button>` : esc(a.line)}<div class="sm muted">${esc(getLine(ctx.idx, ctx.vid, a.line)?.label?.slice(0, 60) || '')}</div></td>
      <td class="r">${fmt(a.from)}</td><td class="r b">${fmt(a.to)}</td><td class="r">${fmtDelta(e.fed)}</td><td class="r">${fmtDelta(e.ca)}</td><td class="r">${e.fedPay || e.caPay ? fmtDelta(e.fedPay + e.caPay) : ''}</td>
      <td>${esc(a.reason)}${a.authority ? `<div class="sm muted">${esc(a.authority)}</div>` : ''}${a.findingId ? ` <a class="sm" href="#/findings?f=${a.findingId}">finding</a>` : ''}${a.amendment ? ' ' + pill('amendment ' + a.amendment, 'warn') : ''}</td>
      <td>${esc(M.userName(ctx.idx, a.by))}<div class="sm muted">${fmtDate(a.at, true)} · ${a.version}</div></td>
      <td>${pill(a.status, a.status === 'approved' ? 'ok' : a.status === 'proposed' ? 'warn' : 'muted')}${a.requiresPartner ? `<div class="sm warn">partner required</div>` : ''}${a.approvals.map(x => `<div class="sm">✓ ${esc(M.userName(ctx.idx, x.by))} (${x.level})</div>`).join('')}${a.rejectReason ? `<div class="sm">${esc(a.rejectReason)}</div>` : ''}</td>
      <td>${a.status === 'proposed' ? btn('Approve', 'approveAdj', { id: a.id }, 'sm') + btn('Reject', 'rejectAdj', { id: a.id }, 'sm ghost') + (a.by === ctx.user.id ? btn('Withdraw', 'withdrawAdj', { id: a.id }, 'sm ghost') : '') : ''}</td></tr>`;
  });
  const s = ctx.adjusted;
  return `<div class="hero"><div><h1>Adjustments</h1><p class="sub">Every change keeps the engine’s original, who made it, why, the authority and its tax effect (change × ${ctx.vid} per-dollar rates). Firm rule: tax effect over ${fmt(ctx.std.partner_threshold)} (federal or state) needs partner sign-off; nobody approves their own.</p></div>
    <div class="hero-a stat"><div><small>Net effect of active adjustments</small><b>fed tax ${fmtDelta(s.d.fed)} · CA tax ${fmtDelta(s.d.ca)}</b><small>payments fed ${fmtDelta(s.d.fedPay)} · CA ${fmtDelta(s.d.caPay)} · approved-only fed ${fmtDelta(s.approvedOnly.fed)}</small></div></div></div>
    ${section(`${list.length} adjustments`, list.length ? table(['', 'Line', { t: 'Engine', r: 1 }, { t: 'Adjusted', r: 1 }, { t: 'Fed tax', r: 1 }, { t: 'CA tax', r: 1 }, { t: 'Payments', r: 1 }, 'Why', 'Who', 'Status', ''], rows) : '<p class="muted">No adjustments yet. Propose them from findings or by clicking any number → Adjust.</p>',
      { actions: `${btn('Select all proposed', 'selAll', { group: 'adj' }, 'ghost sm')}${btn('Approve selected (<span id="selcount">0</span>)', 'bulkApprove', {}, 'sm')}${btn('Undo my last', 'undo', {}, 'ghost sm')}` })}`;
}

export function viewVersions(ctx, q) {
  const vs = ctx.idx.versions.filter(v => !ctx.clock || v.computed_at <= ctx.clock);
  const a = q.get('a') || (vs.at(-2) || vs[0]).version, b = q.get('b') || ctx.vid;
  const A = ctx.idx.linesByVersion.get(a), B = ctx.idx.linesByVersion.get(b);
  const keys = new Set([...A.keys(), ...B.keys()]);
  const diffs = [...keys].filter(k => JSON.stringify(A.get(k)?.value) !== JSON.stringify(B.get(k)?.value)).filter(k => !(k.startsWith('F8949.') && !k.endsWith('total') && Math.abs((A.get(k)?.value || 0) - (B.get(k)?.value || 0)) < 0.01));
  const sA = ctx.idx.versions.find(v => v.version === a).summary, sB = ctx.idx.versions.find(v => v.version === b).summary;
  const sumRow = (l, j, k) => `<tr><td>${l}</td><td class="r">${fmt(sA[j][k])}</td><td class="r">${fmt(sB[j][k])}</td><td class="r">${fmtDelta(sB[j][k] - sA[j][k])}</td><td class="r b">${b === ctx.vid ? fmt(ctx.adjusted[j === 'federal' ? 'fed' : 'ca'][k]) : ''}</td></tr>`;
  const wi = ctx.idx.packet.what_if.alternatives;
  return `<div class="hero"><div><h1>Versions & what-ifs</h1><p class="sub">The engine computed the return three times. Compare any two, see what triggered each, and try the engine’s pre-computed alternatives.</p></div></div>
  <div class="vers">${ctx.idx.versions.map(v => `<div class="ver ${v.version === ctx.vid ? 'on' : ''} ${ctx.clock && v.computed_at > ctx.clock ? 'future' : ''}"><b>${v.version}</b> <small>${fmtDate(v.computed_at, true)}</small><p class="sm">${esc(v.trigger)}</p><p class="sm muted">${v.documents_used.length} docs used${v.documents_superseded.length ? ' · superseded ' + v.documents_superseded.join(', ') : ''} · ${v.diagnostics.length} diagnostics</p></div>`).join('')}</div>
  ${section(`Compare ${a} → ${b}`, `<form class="row" onsubmit="return false"><select class="in sm" onchange="location.hash='#/versions?a='+this.value+'&b=${b}'">${vs.map(v => `<option ${v.version === a ? 'selected' : ''}>${v.version}</option>`).join('')}</select> → <select class="in sm" onchange="location.hash='#/versions?a=${a}&b='+this.value">${vs.map(v => `<option ${v.version === b ? 'selected' : ''}>${v.version}</option>`).join('')}</select></form>
    <table class="t sum"><thead><tr><th></th><th class="r">${a}</th><th class="r">${b}</th><th class="r">Change</th><th class="r">${b === ctx.vid ? 'Workpaper' : ''}</th></tr></thead><tbody>
    ${sumRow('Federal AGI', 'federal', 'agi')}${sumRow('Federal total tax', 'federal', 'total_tax')}${sumRow('Federal payments', 'federal', 'payments')}${sumRow('Federal balance due', 'federal', 'balance_due')}${sumRow('California tax', 'california', 'total_tax')}${sumRow('California balance', 'california', 'balance_due')}</tbody></table>
    <h4>${diffs.length} lines changed</h4>${table(['Line', 'Label', { t: a, r: 1 }, { t: b, r: 1 }, { t: 'Δ', r: 1 }], diffs.map(k => { const x = A.get(k)?.value, y = B.get(k)?.value; return `<tr><td><button class="link" data-a="inspect" data-ref="${attr(k)}">${esc(k)}</button></td><td>${esc((B.get(k) || A.get(k)).label.slice(0, 90))}</td><td class="r">${x == null ? '<i>added</i>' : fmt(x)}</td><td class="r">${y == null ? '<i>removed</i>' : fmt(y)}</td><td class="r">${typeof x === 'number' && typeof y === 'number' ? fmtDelta(y - x) : ''}</td></tr>`; }), 'compact')}`)}
  ${section('What-if alternatives (engine results on ' + wi[0].base_version + ')', table(['Alternative', { t: 'Fed tax Δ', r: 1 }, { t: 'CA tax Δ', r: 1 }, { t: 'Fed balance', r: 1 }, 'Lines', ''], wi.map(w => `<tr><td><b>${esc(w.description)}</b></td><td class="r">${fmtDelta(w.federal.total_tax_change)}</td><td class="r">${fmtDelta(w.california.total_tax_change)}</td><td class="r">${fmt(w.federal.alternative.balance_due)}</td><td>${w.changed_lines.length} <details><summary class="sm">show</summary>${w.changed_lines.slice(0, 30).map(c => `<div class="sm">${esc(c.key)}: ${fmt(c.old)} → ${fmt(c.new)}</div>`).join('')}</details></td><td>${btn('Record as election / decision', 'decision', { kind: 'election', topic: w.description, choice: w.federal.total_tax_change > 0 || w.california.total_tax_change > 0 ? 'Not elected (keep base treatment)' : 'Elect', alternatives: `Base: fed ${w.federal.base.total_tax}, CA ${w.california.base.total_tax}. Alternative: fed ${w.federal.alternative.total_tax}, CA ${w.california.alternative.total_tax}.`, fed: w.federal.total_tax_change, ca: w.california.total_tax_change }, 'sm ghost')}</td></tr>`)),
    { sub: 'Section 179 instead of bonus saves 1,050 California tax with no federal cost — a planning point the engine leaves on the table.' })}
  ${section('Diagnostics by version', table(['Code', ...ctx.idx.versions.map(v => v.version)], [...new Set(ctx.idx.versions.flatMap(v => v.diagnostics.map(d => d.code)))].map(c => `<tr><td>${esc(c)}</td>${ctx.idx.versions.map(v => `<td>${v.diagnostics.some(d => d.code === c) ? '●' : '<span class="muted">cleared</span>'}</td>`).join('')}</tr>`)))}`;
}

export function viewArea(ctx, id) {
  const a = M.AREA[id];
  if (!a) return '<div class="card">Unknown area</div>';
  const lines = M.areaLines(ctx, id);
  const shown = lines.filter(l => !(l.form === 'F8949' && !l.key.endsWith('total') && !l.key.endsWith('SCORP')));
  const hidden = lines.length - shown.length;
  const byForm = {};
  for (const l of shown) (byForm[l.form] ||= []).push(l);
  const fnd = ctx.findings.filter(f => f.area === id);
  const open = fnd.filter(f => ['open', 'adjusting'].includes(M.findingState(ctx, f)) && f.kind !== 'pass');
  const passed = fnd.filter(f => f.kind === 'pass');
  const levels = ['preparer', 'reviewer'];
  const staff = ctx.idx.packet.firm.staff;
  const so = levels.map(l => {
    const s = M.signoffStatus(ctx, id, l);
    const who = M.assigned(ctx, id, l);
    return `<div class="sobox so-${s.state}"><small>${l}</small><b>${s.state === 'none' ? 'Not signed' : s.state === 'fresh' ? '✓ Signed' : '⟲ Reopened'}</b>
      ${s.so ? `<span class="sm">${esc(M.userName(ctx.idx, s.so.by))} · ${fmtDate(s.so.at, true)} · ${s.so.version}</span>` : ''}${s.why ? `<span class="sm warn">${esc(s.why)}</span>` : ''}
      <label class="sm">Assigned <select data-a="assign" data-area="${id}" data-role="${l}" class="in sm">${staff.filter(x => x.role === l || (l === 'reviewer' && x.role === 'partner')).map(x => `<option value="${x.id}" ${x.id === who ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      ${M.can(ctx.user, 'signoff:' + l) ? btn(s.state === 'fresh' ? 'Sign again' : 'Sign off', 'signoff', { scope: id, level: l }, 'sm') : ''}</div>`;
  }).join('');
  const hrs = ctx.state.time.filter(t => t.area === a.budget).reduce((s, t) => s + t.hours, 0);
  const bud = a.budget ? ctx.idx.packet.firm.budget_hours[a.budget] : null;
  const notes = [...ctx.state.notes.values()].filter(n => n.area === id);
  return `<div class="hero"><div><div class="eyebrow">Area</div><h1>${esc(a.name)}</h1><p class="sub">${lines.length} return lines · ${a.docs.length} documents · ${open.length} open findings · ${passed.length} independent checks passed</p></div>
    <div class="hero-a">${bud ? `<div class="stat"><small>Time vs budget</small><b class="${hrs > bud ? 'warn' : ''}">${hrs.toFixed(1)} / ${bud} h</b></div>` : ''}${btn('Log time', 'logTime', { budget: a.budget || 'business' }, 'ghost')}${btn('Note', 'note', { kind: 'note', area: id })}${M.can(ctx.user, 'review') ? btn('Review note', 'note', { kind: 'review', area: id }, 'warn') : ''}</div></div>
  <div class="sorow">${so}<div class="sobox"><small>Rule</small><span class="sm">A sign-off records a fingerprint of every figure, adjustment and document it covers; any change reopens it. Reviewers cannot sign areas they prepared or adjusted.</span></div></div>
  ${open.length ? section('Open findings', open.map(f => `<div class="frow">${sev(f.severity)} <a href="#/findings?f=${f.id}">${esc(f.title)}</a> <span class="muted sm">${esc(f.summary.slice(0, 160))}…</span></div>`).join('')) : ''}
  ${passed.length ? section('Checks that agree with the engine', passed.map(f => `<div class="frow">${sev('pass')} ${esc(f.title)}</div>`).join('')) : ''}
  ${notes.length ? section('Notes in this area', notes.map(n => noteMini(ctx, n)).join('')) : ''}
  ${section('Lines', Object.entries(byForm).map(([form, ls]) => `<h4>${esc(form)}</h4><table class="t lines"><tbody>${ls.map(l => `<tr><td class="k"><label class="cb sm"><input type="checkbox" data-a="toggleSel" data-group="ln" data-key="${attr(l.key)}"> ${esc(l.key)}</label></td><td>${esc(M.lineView(ctx, l.key).text ? l.label.replace(M.lineView(ctx, l.key).text.from, M.lineView(ctx, l.key).text.to) : l.label)}</td><td class="r">${num(ctx, l.key)}</td><td class="muted sm">${esc(l.rule)}</td></tr>`).join('')}</tbody></table>`).join('') + (hidden ? `<p class="muted sm">${hidden} individual sales are summarised by box above — see <a href="#/schedule/sales">Sales detail</a>.</p>` : ''),
    { actions: `${btn('Select all', 'selAll', { group: 'ln' }, 'ghost sm')}${btn('Verify selected (<span id="selcount">0</span>)', 'bulkVerify', {}, 'sm')}` })}
  ${a.docs.length ? section('Documents', table(['', 'Document', 'Status'], a.docs.map(d => { const doc = ctx.idx.docs.get(d); const st = M.docStatus(ctx, doc); return `<tr><td><a href="#/docs/${d}">${d}</a></td><td>${esc(doc.title)}</td><td>${pill(st.label, st.code === 'used' ? 'ok' : st.code === 'unaccounted' ? 'warn' : '')} <span class="sm muted">${esc(st.reason || '')}</span></td></tr>`; }))) : ''}`;
}
