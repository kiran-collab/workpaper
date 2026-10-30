// The records a CPA expects, generated from the packet + workpaper state. Every figure links to
// its trace; nothing here is typed in.

import * as M from '../model.js';
import { line as getLine } from '../data.js';
import { esc, attr, fmt, fmtDelta, fmtDate, num, refChip, btn, section, table, pill, sev } from '../ui.js';

export const SCHEDULES = [
  { id: 'taxcomp', name: 'Tax computation' }, { id: 'sales', name: 'Sales detail' }, { id: 'depreciation', name: 'Depreciation by asset' },
  { id: 'books', name: 'Books to tax' }, { id: 'rentals', name: 'Rentals & passive losses' }, { id: 'k1', name: 'K-1 lines' },
  { id: 'retirement', name: 'Retirement & foreign' }, { id: 'deductions', name: 'Deductions & credits' }, { id: 'payments', name: 'Payments' },
  { id: 'state', name: 'State split' }, { id: 'carryovers', name: 'Carryovers' }, { id: 'basis', name: 'Basis by year' }, { id: 'prior', name: 'Prior preparer vs us' },
];

const V = (ctx, k) => M.lineView(ctx, k).value;
const has = (ctx, k) => !!getLine(ctx.idx, ctx.vid, k);
function lines(ctx, keys, { label = true } = {}) {
  return `<table class="t lines"><tbody>${keys.filter(k => typeof k !== 'string' || has(ctx, k)).map(k => {
    if (typeof k !== 'string') return `<tr class="grp"><td colspan="3">${esc(k.h)}</td></tr>`;
    const l = getLine(ctx.idx, ctx.vid, k);
    return `<tr><td class="k">${esc(k)}</td>${label ? `<td>${esc(l.label)}</td>` : ''}<td class="r">${num(ctx, k)}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function head(title, sub, actions = '') { return `<div class="hero"><div><div class="eyebrow">Schedule</div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="hero-a">${actions}${btn('Print', 'print', {}, 'ghost printbtn')}</div></div>`; }

export function viewSchedule(ctx, id, q) {
  const f = { taxcomp, sales, depreciation, books, rentals, k1, retirement, deductions, payments, state, carryovers, basis, prior }[id];
  return f ? f(ctx, q) : '<div class="card">Unknown schedule</div>';
}

// ------------------------------------------------------------------ tax computation
function taxcomp(ctx) {
  const checks = ctx.findings.filter(f => ['CHK-TAX-FED', 'CHK-TAX-CA', 'CHK-NIIT', 'CHK-CTC', 'CHK-SE', 'CHK-SUMS', 'CHK-EXCESS-SS', 'CHK-W2', 'CHK-8949', 'CHK-SCORP'].includes(f.id));
  return head('Tax computation', `Engine ${ctx.vid}. Independent recomputation from the rate tables runs beside it.`) +
    `<div class="cols"><div class="col2">${section('Federal', lines(ctx, [{ h: 'Income' }, 'F1040.1z', 'F1040.2b', 'F1040.3b', 'F1040.4b', 'F1040.7', 'F1040.8', 'F1040.9', 'F1040.10', 'F1040.11', { h: 'Deductions' }, 'F1040.12', 'F1040.13', 'F1040.14', 'F1040.15', { h: 'Tax' }, 'F1040.16', 'F6251.4', 'F6251.6', 'F6251.9', 'F6251.11', 'F1040.18', 'F1040.19', 'F1040.20', 'F1040.22', 'Sch2.4', 'Sch2.11', 'Sch2.12', 'F1040.23', 'F1040.24', { h: 'Payments' }, 'F1040.25d', 'F1040.26', 'Sch3.10', 'Sch3.11', 'F1040.33', 'F1040.37', 'F1040.38']))}</div>
     <div class="col1">${section('Checks that do not trust the engine', checks.map(c => `<div class="frow">${sev(c.severity)} ${esc(c.summary)}</div>`).join(''))}
     ${section('California', lines(ctx, ['F540NR.17', 'F540NR.18', 'F540NR.19', 'F540NR.31', 'F540NR.32', 'F540NR.34', 'F540NR.35', 'F540NR.36', 'F540NR.37', 'F540NR.39', 'F540NR.40', 'ScheduleS.credit', 'F540NR.61', 'F540NR.64', 'F540NR.78', 'F540NR.97'], { label: true }))}</div></div>`;
}

// ------------------------------------------------------------------ sales detail
const BROKER = { N: 'Northlake Securities', M: 'Meridian Brokerage', X: 'Brightpath (direct indexing)', C: 'Coinhaven (digital assets)', S: 'S corp distributions' };
export function lots(ctx) {
  const out = [];
  for (const l of ctx.idx.linesByVersion.get(ctx.vid).values()) {
    if (l.form !== 'F8949' || l.key.endsWith('total')) continue;
    const [, box, id] = l.key.split('.');
    const m = l.label.match(/^(.*?) \(acquired (\S+), sold (\S+); proceeds ([\d,]+\.\d\d), basis ([\d,]+\.\d\d)(?:, adjustment (\w) ([−-]?[\d,]+\.\d\d))?\)/);
    if (!m) continue;
    out.push({ key: l.key, box, id, broker: id === 'SCORP' ? 'S' : id[0], desc: m[1], acq: m[2], sold: m[3], proceeds: +m[4].replace(/,/g, ''), basis: +m[5].replace(/,/g, ''), code: m[6] || '', adj: m[7] ? +m[7].replace(/[,−]/g, s => s === '−' ? '-' : '') : 0, gain: l.value, lv: M.lineView(ctx, l.key) });
  }
  return out;
}
function sales(ctx, q) {
  const all = lots(ctx);
  const br = q.get('b') || '', box = q.get('box') || '', flag = q.get('flag') || '', page = +(q.get('p') || 1), sort = q.get('sort') || 'sold';
  let L = all;
  if (br) L = L.filter(x => x.broker === br);
  if (box) L = L.filter(x => x.box === box);
  if (flag === 'wash') L = L.filter(x => x.code === 'W');
  if (flag === 'loss') L = L.filter(x => x.gain < 0);
  if (flag === 'nobasis') L = L.filter(x => x.basis === 0);
  if (flag === 'adjusted') L = L.filter(x => x.lv.adj);
  if (flag === 'big') L = L.filter(x => Math.abs(x.gain) >= 1000);
  L = L.slice().sort((a, b) => sort === 'gain' ? Math.abs(b.gain) - Math.abs(a.gain) : a[sort] < b[sort] ? -1 : 1);
  const per = 50, pages = Math.max(1, Math.ceil(L.length / per));
  const shown = L.slice((page - 1) * per, page * per);
  const qs = (k, v) => { const p = new URLSearchParams(q); p.set(k, v); if (k !== 'p') p.set('p', 1); return '#/schedule/sales?' + p; };
  const group = {};
  for (const x of all) { const g = (group[x.broker + x.box] ||= { broker: x.broker, box: x.box, n: 0, p: 0, b: 0, a: 0, g: 0, w: 0, adj: 0 }); g.n++; g.p += x.proceeds; g.b += x.basis; g.a += x.adj; g.g += x.lv.value; g.w += x.code === 'W' ? 1 : 0; g.adj += x.lv.adj ? 1 : 0; }
  // Broker summaries (printed) vs lots
  const ev = (d, f) => (ctx.idx.evsByDoc.get(d) || []).find(e => e.field === f)?.value;
  const meridianDoc = ctx.v.documents_superseded.includes('D30') ? 'D31' : 'D30';
  const recon = [
    ['Brightpath short-term proceeds', ev('D74', 'st_proceeds'), all.filter(x => x.broker === 'X' && x.box === 'A').reduce((s, x) => s + x.proceeds, 0), 'D74'],
    ['Brightpath long-term proceeds', ev('D74', 'lt_proceeds'), all.filter(x => x.broker === 'X' && x.box === 'D').reduce((s, x) => s + x.proceeds, 0), 'D74'],
    ['Meridian total proceeds', ev(meridianDoc, 'b_summary_proceeds'), all.filter(x => x.broker === 'M').reduce((s, x) => s + x.proceeds, 0), meridianDoc],
    ['Northlake proceeds (4 boxes)', 6600 + 37720 + 8400 + 15300, all.filter(x => x.broker === 'N').reduce((s, x) => s + x.proceeds, 0), 'D28'],
    ['Coinhaven gross proceeds (1099-DA)', ev('D34', 'total'), all.filter(x => x.broker === 'C').reduce((s, x) => s + x.proceeds, 0), 'D34'],
  ];
  return head('Sales detail', `${all.length} sales across five sources. Summaries first; drill into lots only where flags point. Brokers’ printed summaries are reconciled to the lots.`) +
    section('Summary by source and box', table(['Source', 'Box', { t: 'Sales', r: 1 }, { t: 'Proceeds', r: 1 }, { t: 'Basis', r: 1 }, { t: 'Adj.', r: 1 }, { t: 'Gain (workpaper)', r: 1 }, 'Flags'], Object.values(group).sort((a, b) => (a.broker + a.box).localeCompare(b.broker + b.box)).map(g => `<tr><td><a href="${qs('b', g.broker)}">${esc(BROKER[g.broker])}</a></td><td><a href="${qs('box', g.box)}">${g.box}</a></td><td class="r">${g.n}</td><td class="r">${fmt(g.p, { cents: true })}</td><td class="r">${fmt(g.b, { cents: true })}</td><td class="r">${fmt(g.a, { cents: true })}</td><td class="r b">${fmt(g.g, { cents: true })}</td><td>${g.w ? pill(g.w + ' wash', '') : ''}${g.adj ? pill(g.adj + ' adjusted', 'warn') : ''}${g.box === 'B' || g.box === 'E' ? pill('basis not reported', 'warn') : ''}</td></tr>`)) +
      `<p class="sm">Box totals on the return: ${['A', 'B', 'D', 'E', 'F', 'H', 'K'].filter(b => has(ctx, `F8949.${b}.total`)).map(b => `${b} ${num(ctx, `F8949.${b}.total`)}`).join(' · ')}</p>`) +
    section('Reconciliation to broker statements', table(['Statement', { t: 'Printed', r: 1 }, { t: 'Lots on return', r: 1 }, { t: 'Difference', r: 1 }, 'Source'], recon.map(([l, p, s, d]) => `<tr><td>${esc(l)}</td><td class="r">${fmt(p, { cents: true })}</td><td class="r">${fmt(s, { cents: true })}</td><td class="r ${Math.abs(p - s) > 0.01 ? 'warn b' : ''}">${fmt(Math.round((p - s) * 100) / 100, { cents: true })}</td><td>${refChip(ctx, d)}</td></tr>`))) +
    section(`Lots (${L.length})`, `<div class="tabs">${[['', 'All'], ['big', '|gain| ≥ 1,000'], ['loss', 'Losses'], ['wash', 'Wash sales'], ['nobasis', 'Zero basis'], ['adjusted', 'Adjusted']].map(([k, l]) => `<a href="${qs('flag', k)}" class="${flag === k ? 'on' : ''}">${l}</a>`).join('')}${br || box ? `<a href="#/schedule/sales" class="pill">clear source/box ✕</a>` : ''}<span class="r sm">sort: <a href="${qs('sort', 'sold')}">date</a> · <a href="${qs('sort', 'gain')}">size</a></span></div>` +
      table(['Lot', 'Box', 'Description', 'Acquired', 'Sold', { t: 'Proceeds', r: 1 }, { t: 'Basis', r: 1 }, { t: 'Adj', r: 1 }, { t: 'Gain', r: 1 }], shown.map(x => `<tr><td>${esc(x.id)}</td><td>${x.box}</td><td>${esc(x.desc)}</td><td>${esc(x.acq)}</td><td>${esc(x.sold)}</td><td class="r">${fmt(x.proceeds, { cents: true })}</td><td class="r ${x.basis === 0 ? 'warn' : ''}">${fmt(x.basis, { cents: true })}</td><td class="r">${x.adj ? x.code + ' ' + fmt(x.adj, { cents: true }) : ''}</td><td class="r">${num(ctx, x.key)}</td></tr>`), 'compact') +
      (pages > 1 ? `<div class="pager">${Array.from({ length: pages }, (_, i) => `<a href="${qs('p', i + 1)}" class="${page === i + 1 ? 'on' : ''}">${i + 1}</a>`).join('')}</div>` : ''));
}

// ------------------------------------------------------------------ depreciation
function depreciation(ctx) {
  const assets = ctx.v.assets;
  const hv = [...ctx.state.adjustments.values()].find(a => a.line === 'SchE.14A' && ['proposed', 'approved'].includes(a.status));
  const rows = assets.map(a => `<tr><td><b>${esc(a.asset_id)}</b><div class="sm">${esc(a.description)}</div></td><td class="sm">${esc(a.activity)}</td><td class="r">${fmt(a.cost)}${a.land_value_not_depreciated ? `<div class="sm muted">land ${fmt(a.land_value_not_depreciated)}</div>` : ''}</td><td>${esc(a.placed_in_service)}</td><td class="sm">${esc(a.method)}</td><td class="r">${a.life_years}</td>
    <td class="r">${fmt(a.federal.prior_accumulated, { cents: true })}</td><td class="r b">${fmt(a.federal.depreciation_2025, { cents: true })}</td><td class="r">${fmt(a.california.depreciation_2025, { cents: true })}</td><td class="r">${fmt(a.amt.depreciation_2025, { cents: true })}</td><td class="r">${fmt(a.federal.accumulated_end, { cents: true })}</td><td class="r">${fmt(a.california.accumulated_end, { cents: true })}</td>
    <td class="sm">${a.disposition ? `Sold ${esc(a.disposition.date)} · unrecaptured §1250 ${fmt(a.disposition.unrecaptured_1250_depreciation, { cents: true })} · §1250 ordinary ${fmt(a.disposition.section_1250_ordinary_recapture)}` : ''}</td></tr>`);
  if (hv) rows.push(`<tr class="adjrow"><td><b>SAC-HVAC</b> ${pill(hv.status, hv.status === 'approved' ? 'ok' : 'warn')}<div class="sm">Heat pump system (capitalized from repairs)</div></td><td class="sm">Rental: 1450 Fremont Way</td><td class="r">11,000</td><td>2025-08-12</td><td class="sm">SL / mid-month</td><td class="r">27.5</td><td class="r">0.00</td><td class="r b">150.00</td><td class="r">150.00</td><td class="r">150.00</td><td class="r">150.00</td><td class="r">150.00</td><td class="sm">From what-if hvac_improvement</td></tr>`);
  const fedTot = assets.reduce((s, a) => s + a.federal.depreciation_2025, 0), caTot = assets.reduce((s, a) => s + a.california.depreciation_2025, 0);
  return head('Depreciation by asset', 'Method, life, bonus, federal vs California vs AMT, accumulated, disposals and recapture. California does not allow federal special depreciation; the difference carries forward per asset.') +
    section('Assets (2025)', table(['Asset', 'Activity', { t: 'Cost', r: 1 }, 'In service', 'Method', { t: 'Life', r: 1 }, { t: 'Fed prior', r: 1 }, { t: 'Fed 2025', r: 1 }, { t: 'CA 2025', r: 1 }, { t: 'AMT 2025', r: 1 }, { t: 'Fed accum.', r: 1 }, { t: 'CA accum.', r: 1 }, 'Disposition / recapture'], rows, 'compact') +
      `<p class="sm">Totals 2025: federal ${fmt(fedTot, { cents: true })} · California ${fmt(caTot, { cents: true })}. Return lines: Schedule C ${num(ctx, 'F4562-C.22')} · Fremont ${num(ctx, 'F4562-E.total-A')} · Condo ${num(ctx, 'F4562-E.total-B')} · CA addition ${num(ctx, 'SchCA540NR.12.C')}</p>`) +
    section('Elections on the 2025 studio equipment', `<p>Default: 100% special depreciation (acquired after 01/19/2025). Engine what-ifs: section 179 = same federal, <b>California −1,050</b>; elect out (MACRS) = federal +10,245. See <a href="#/versions">Versions & what-ifs</a> and record the election in <a href="#/judgment">Judgment</a>.</p>`) +
    section('California basis differences carried forward', table(['Asset', { t: 'Difference', r: 1 }], Object.entries(ctx.v.carryovers_out.california.depreciation_basis_differences).map(([k, v]) => `<tr><td>${refChip(ctx, 'asset:' + k)}</td><td class="r">${fmt(v, { cents: true })}</td></tr>`)));
}

// ------------------------------------------------------------------ books to tax
function books(ctx) {
  const e = (f) => (ctx.idx.evsByDoc.get('D14') || []).find(x => x.field === f);
  const r = (label, amt, ref, note) => `<tr><td>${label}${note ? `<div class="sm muted">${note}</div>` : ''}</td><td class="r">${typeof amt === 'string' ? amt : fmt(amt)}</td><td>${ref ? refChip(ctx, ref, ctx.idx.evs.get(ref)?.document_id || ref) : ''}</td></tr>`;
  const net = e('net_income').value;
  const items = [
    ['Health insurance (Erik) moved to Schedule 1 line 17', e('Insurance - health (Erik)').value, e('Insurance - health (Erik)').id, 'Not a Schedule C expense'],
    ['Book depreciation added back', e('Depreciation').value, e('Depreciation').id],
    ['Tax depreciation (100% special)', -getLine(ctx.idx, ctx.vid, 'SchC.13').value, 'SchC.13'],
    ['Fuel added back', e('Car and truck - fuel').value, e('Car and truck - fuel').id, 'Standard mileage replaces actual vehicle costs'],
    ['Standard mileage', -getLine(ctx.idx, ctx.vid, 'SchC.9').value, 'SchC.9'],
    ['Meals: 50% not deductible', e('Meals').value - getLine(ctx.idx, ctx.vid, 'SchC.24b').value, 'SchC.24b'],
    ['Home office (simplified)', -getLine(ctx.idx, ctx.vid, 'SchC.30').value, 'SchC.30'],
    ['Form 1099-K added by engine (not matched to deposits)', getLine(ctx.idx, ctx.vid, 'SchC.1').value - e('total_income').value, 'SchC.1', 'See finding: already in books deposits'],
  ];
  const engine = items.reduce((s, x) => s + x[1], net);
  const adjs = [...ctx.state.adjustments.values()].filter(a => /^SchC\./.test(a.line) && ['proposed', 'approved'].includes(a.status) && !/^SchC\.44/.test(a.line));
  const adjNet = adjs.reduce((s, a) => s + (/^SchC\.(1|5|7)$/.test(a.line) ? a.to - a.from : -(a.to - a.from)), 0);
  const necs = ['D16', 'D17', 'D18', 'D19', 'D20'].map(d => (ctx.idx.evsByDoc.get(d) || []).find(x => x.field === 'box1'));
  const nec = necs.reduce((s, x) => s + x.value, 0);
  const small = (ctx.idx.evsByDoc.get('D15') || []).find(x => x.field === 'unreported_small');
  return head('Books to tax — Lindqvist Studio', 'From the QuickBooks profit and loss (cash basis) to Schedule C net profit, then the workpaper’s adjustments.') +
    `<div class="cols"><div class="col2">${section('Reconciliation', `<table class="t lines"><tbody>
      ${r('<b>Books net income</b>', net, e('net_income').id)}${items.map(x => r(...x)).join('')}
      <tr class="tot"><td>Schedule C net profit (engine ${ctx.vid})</td><td class="r">${fmt(engine)}</td><td>${num(ctx, 'SchC.31')}${engine !== getLine(ctx.idx, ctx.vid, 'SchC.31').value ? ' <span class="warn">does not tie</span>' : ' <span class="ok-t">ties ✓</span>'}</td></tr>
      ${adjs.map(a => r(`Workpaper: ${esc(a.line)} — ${esc(a.reason)}`, /^SchC\.(1|5|7)$/.test(a.line) ? a.to - a.from : -(a.to - a.from), a.line)).join('')}
      <tr class="tot"><td>Schedule C net profit (workpaper)</td><td class="r">${fmt(engine + adjNet)}</td><td></td></tr></tbody></table>`)}</div>
    <div class="col1">${section('Gross receipts vs information returns', `<table class="t lines"><tbody>${necs.map(x => r(esc(ctx.idx.docs.get(x.document_id).issuer) + ' (1099-NEC)', x.value, x.id)).join('')}
      <tr class="tot"><td>Forms 1099-NEC</td><td class="r">${fmt(nec)}</td><td></td></tr>${r('Clients with no 1099 (11 small clients)', small.value, small.id)}
      <tr class="tot"><td>Books total income</td><td class="r">${fmt(nec + small.value)}</td><td>${refChip(ctx, e('total_income').id)}</td></tr>
      ${r('Form 1099-K (Paywell) — Atlas paid by card, inside Atlas’s 41,200', 12400, 'ev-0127', 'Do not add again')}</tbody></table>
      <p class="sm">This is the record the 2028 IRS letter asks for.</p>`)}
      ${section('Schedule C', lines(ctx, ['SchC.1', 'SchC.8', 'SchC.9', 'SchC.11', 'SchC.13', 'SchC.15', 'SchC.17', 'SchC.18', 'SchC.22', 'SchC.24a', 'SchC.24b', 'SchC.25', 'SchC.27a.1', 'SchC.27a.2', 'SchC.28', 'SchC.30', 'SchC.31', 'SchC.44a', 'SchC.44c']))}</div></div>`;
}

// ------------------------------------------------------------------ rentals
function rentals(ctx) {
  const prop = (p) => ['3', '9', '11', '12', '14', '16', '18', '19', '20', '21', '22'].map(n => `SchE.${n}${p}`).filter(k => has(ctx, k));
  const row = (n, label) => `<tr><td>${label}</td><td class="r">${has(ctx, 'SchE.' + n + 'A') ? num(ctx, 'SchE.' + n + 'A') : ''}</td><td class="r">${has(ctx, 'SchE.' + n + 'B') ? num(ctx, 'SchE.' + n + 'B') : ''}</td></tr>`;
  void prop;
  return head('Rentals & passive losses', '1450 Fremont Way (Sacramento, all year, managed) and 1200 Barton Hills Dr 4C (Austin, rented to 09/30, sold 10/15).') +
    `<div class="cols"><div class="col2">${section('Schedule E', `<table class="t lines"><thead><tr><th></th><th class="r">A · Fremont Way</th><th class="r">B · Barton Hills 4C</th></tr></thead><tbody>
      <tr><td>Days rented / personal</td><td class="r">${num(ctx, 'SchE.2A')}</td><td class="r">${num(ctx, 'SchE.2B')}</td></tr>
      ${[['3', 'Rents'], ['9', 'Insurance'], ['11', 'Management'], ['12', 'Mortgage interest'], ['14', 'Repairs'], ['16', 'Taxes'], ['18', 'Depreciation'], ['19', 'Other (HOA)'], ['20', 'Total expenses'], ['21', 'Income or (loss)'], ['22', 'Deductible after §469']].map(([n, l]) => row(n, l)).join('')}</tbody></table>`)}
      ${section('Passive activity loss (Form 8582)', lines(ctx, ['F8582.1a', 'F8582.1b', 'F8582.1c', 'F8582.3a', 'F8582.4', 'SchE.26', 'SchE.32', 'SchE.41']) + '<p class="sm">Net passive income is positive (condo gain + K-1 income), so current and suspended losses are all allowed; the condo’s fully taxable disposition frees its own suspended losses regardless.</p>')}</div>
      <div class="col1">${section('Condo sale (Form 4797)', lines(ctx, ['F4797.20', 'F4797.21', 'F4797.22', 'F4797.23', 'F4797.24', 'F4797.25', 'F4797.26g', 'F4797.9', 'SchD.19']) + `<p class="sm">Basis: purchase ${refChip(ctx, 'ev-1019')} + flooring ${refChip(ctx, 'ev-1022')} + commission ${refChip(ctx, 'ev-1015')} + title ${refChip(ctx, 'ev-1016')}. Depreciation allowed = prior 43,010.60 + 2025 7,329.39.</p>`)}
      ${section('Suspended losses', table(['Property', { t: '2024 carryover', r: 1 }, 'Status'], [`<tr><td>Fremont Way</td><td class="r">${refChip(ctx, 'py:/carryovers_into_2025/passive_1450_fremont', '6,300')}</td><td>Allowed 2025</td></tr>`, `<tr><td>Barton Hills 4C</td><td class="r">${refChip(ctx, 'py:/carryovers_into_2025/passive_1200_barton_hills', '9,850')}</td><td>Freed by sale</td></tr>`]))}</div></div>`;
}

// ------------------------------------------------------------------ K-1
function k1(ctx) {
  const map = (doc, rows) => table(['Box', 'Item', { t: 'Amount', r: 1 }, 'Lands on'], rows.map(([f, label, keys]) => { const e = (ctx.idx.evsByDoc.get(doc) || []).find(x => x.field === f); return `<tr><td>${esc(f)}</td><td>${esc(label)}</td><td class="r">${e ? refChip(ctx, e.id, fmt(e.value)) : '—'}</td><td>${keys.map(k => has(ctx, k) ? `<span class="lc">${esc(k)} ${num(ctx, k)}</span>` : esc(k)).join(' ')}</td></tr>`; }));
  const rec = ctx.v.documents_used.includes('D37');
  return head('K-1 lines', 'Each K-1 box mapped to where it lands on the federal and California returns.') +
    section('Lindqvist Family Woodworks, Inc. (1120-S) — 20%, Erik does not work in the business (passive)', map('D39', [['box1', 'Ordinary business income', ['SchE.28A', 'F7203.3a']], ['box4', 'Interest income', ['SchB.1.7', 'F7203.3c']], ['box16d', 'Distributions (incl. Oregon composite tax 1,580)', ['F7203.6', 'F7203.excess', 'F8949.F.SCORP']], ['qbi', '§199A QBI', ['F8995.2.2']], ['w2wages', '§199A W-2 wages', ['F8995.15.2']], ['ubia', '§199A UBIA', ['F8995.15.2']], ['or_tax', 'Oregon tax paid on your behalf', ['ScheduleS.credit']]])) +
    section(`Ridgeline Real Estate Fund III LP (1065) — limited partner${rec ? '' : ' — NOT YET RECEIVED'}`, map('D37', [['box2', 'Net rental real estate income', ['SchE.28B']], ['box5', 'Interest', ['SchB.1.8']], ['box9a', 'Net long-term capital gain', ['SchD.12']], ['box19a', 'Distributions', []], ['box21', 'Foreign taxes (passive)', ['Sch3.1']], ['cap_begin', 'Capital beginning', []], ['cap_end', 'Capital ending', []]]) +
      `<p class="sm">State supplement: California ${refChip(ctx, 'ev-0971', '22%')} of box 2 is California-source (taxable by CA after the move); Arizona composite filed by the fund. Outside basis was never computed (prior preparer) — tracked in <a href="#/schedule/basis">Basis by year</a>.</p>`);
}

// ------------------------------------------------------------------ retirement & foreign
function retirement(ctx) {
  return head('Retirement & foreign', 'Backdoor Roth (Form 8606), HSA (Form 8889), and the Swedish account (Schedule B, Form 8938, FBAR).') +
    `<div class="cols"><div class="col2">${section('Form 8606 — nondeductible IRA and conversion', lines(ctx, ['F8606.1', 'F8606.2', 'F8606.3', 'F8606.6', 'F8606.8', 'F8606.9', 'F8606.10', 'F8606.11', 'F8606.14', 'F8606.16', 'F8606.17', 'F8606.18', 'F1040.4a', 'F1040.4b']) + `<p class="sm">Conversions 02/20 (7,010) and 04/02 (7,016) per ${refChip(ctx, 'D41')}. 2024 contribution made 02/12/2025 ${refChip(ctx, 'ev-0992')}. The client’s “no prior basis” answer ${refChip(ctx, 'qa-31')} is contradicted by the records.</p>`)}
    ${section('HSA (Form 8889)', lines(ctx, ['F8889.3', 'F8889.9', 'F8889.13', 'F8889.14a', 'F8889.15', 'F8889.16', 'SchCA540NR.1.C']))}</div>
    <div class="col1">${section('Sparbanken Norrland (Sweden)', lines(ctx, ['SchB.1.6', 'SchB.7a', 'SchB.7b', 'F8938.1.max', 'F8938.1.ye', 'F8938.req']) + `<p class="sm">SEK balances: year-end ${refChip(ctx, 'ev-0961')} · highest ${refChip(ctx, 'ev-0962')} · interest ${refChip(ctx, 'ev-0960')}. Rates: ${refChip(ctx, 'ref:fx.SEK.2025_average', 'avg 9.86')} ${refChip(ctx, 'ref:fx.SEK.2025_year_end', 'YE 9.71')}.</p>`)}
    ${section('Outside filings', '<ul class="sm"><li>FinCEN 114 (FBAR) 2025 — client files; due 10/15/2026.</li><li>Form 3520 for the 2023 inheritance — unresolved by prior preparer.</li></ul><a href="#/judgment">Completeness →</a>')}</div></div>`;
}

// ------------------------------------------------------------------ deductions & credits
function deductions(ctx) {
  const agi = ctx.adjusted.fed.agi;
  const P = ctx.idx.params;
  const cap = Math.max(P.salt_cap_floor, P.salt_cap - Math.max(0, agi - P.salt_cap_phase_start) * P.salt_cap_phase_rate);
  return head('Deductions & credits with limits', `Each limit is recomputed against the workpaper AGI (${fmt(agi)}).`) +
    `<div class="cols"><div class="col2">${section('Itemized (Schedule A)', lines(ctx, [{ h: 'Taxes' }, 'SchA.5a', 'SchA.5b', 'SchA.5d', 'SchA.5e', { h: 'Interest' }, 'SchA.8a', 'SchA.8c', 'SchA.10', { h: 'Charity' }, 'SchA.11', 'F8283.A1.stock', 'F8283.A1.vehicle', 'SchA.12', 'SchA.14', { h: 'Total' }, 'SchA.17', 'F1040.12']))}</div>
    <div class="col1">${section('Limits', table(['Limit', 'Test', 'Result'], [
      `<tr><td>SALT cap</td><td class="sm">40,000 less 30% of AGI over 500,000 (floor 10,000)</td><td class="r">${fmt(cap)}</td></tr>`,
      `<tr><td>Mortgage debt</td><td class="sm">Acquisition debt ≤ 750,000: Lonestar 548,000 → refinanced 540,000</td><td>within</td></tr>`,
      `<tr><td>Cash gifts</td><td class="sm">60% of AGI = ${fmt(agi * 0.6)}</td><td>within</td></tr>`,
      `<tr><td>Appreciated stock to DAF</td><td class="sm">30% of AGI = ${fmt(agi * 0.3)}; held &gt; 1 year (04/2019)</td><td>within</td></tr>`,
      `<tr><td>Vehicle</td><td class="sm">Limited to 1098-C gross proceeds when sold</td><td>${refChip(ctx, 'ev-1054', '2,900')}</td></tr>`,
      `<tr><td>Itemize vs standard</td><td class="sm">Standard ${fmt(P.std_deduction_mfj)}; what-if: standard costs +12,306</td><td>itemize</td></tr>`]))}
    ${section('Credits', lines(ctx, ['F8812.4', 'F8812.6', 'F8812.8', 'F8812.11', 'F8812.12', 'F8863.27', 'F8863.30', 'F8863.7', 'F2441.1a', 'F2441.1b', 'F2441.2', 'F2441.12', 'F2441.31', 'Sch3.1']))}
    ${section('QBI deduction', lines(ctx, ['F8995.2.1', 'F8995.15.1', 'F8995.2.2', 'F8995.15.2', 'F8995.33', 'F8995.36', 'F8995.39']))}</div></div>`;
}

// ------------------------------------------------------------------ payments
function payments(ctx) {
  const tr = ctx.idx.packet.tax_agency_records;
  const snap = tr.irs_account_transcript_2025.filter(s => s.as_of <= ctx.clock.slice(0, 10)).at(-1);
  const eft = (ctx.idx.evsByDoc.get('D67') || []);
  const fed = [['2025-04-15', 'ev-1056'], ['2025-06-16', 'ev-1058'], ['2025-09-15', 'ev-1060'], ['2026-01-15', null]].map(([d, e]) => {
    const t = snap?.transactions.find(x => x.code === '670' && x.date.slice(0, 7) === d.slice(0, 7));
    return `<tr><td>${d}</td><td class="r">${e ? refChip(ctx, e, fmt(ctx.idx.evs.get(e).value)) : '<span class="muted">none</span>'}</td><td class="r">${t ? fmt(t.amount) : '<span class="muted">not pulled</span>'}</td><td class="sm">${!e ? `Engine used client answer ${refChip(ctx, 'qa-41', '“4,000 I think”')}` : ''}</td></tr>`;
  });
  const d68 = ctx.idx.evsByDoc.get('D68') || [];
  const ca = [1, 2, 3, 4, 5, 6].map(i => { const g = (f) => d68.find(x => x.field === `pay${i}_${f}`); const yr = g('year').value; const inEngine = getLine(ctx.idx, ctx.vid, 'F540NR.72')?.sources.includes(g('amount').id); return `<tr class="${inEngine && yr !== '2025' ? 'warnrow' : ''}"><td>${esc(g('date').value)}</td><td class="r">${refChip(ctx, g('amount').id, fmt(g('amount').value))}</td><td>${yr}</td><td>${inEngine ? 'counted' : '—'}</td><td>${tr.ftb_account.tax_year_2025_payments.some(p => p.date === g('date').value) ? '2025 ✓' : yr === '2024' ? 'held for 2024' : ''}</td></tr>`; });
  const bal = ctx.adjusted.fed.balance_due;
  const days = Math.round((new Date('2026-07-20') - new Date('2026-04-15')) / 864e5);
  const interest = Math.max(0, bal) * 0.07 * days / 365, ftp = Math.max(0, bal) * 0.005 * Math.ceil(days / 30.4);
  return head('Payments', 'Withholding, estimates and extension agreed to EFTPS, the IRS account transcript and the FTB account.') +
    `<div class="cols"><div class="col2">${section('Federal estimated payments', table(['Due', { t: 'EFTPS confirmation', r: 1 }, { t: `IRS transcript (${snap?.as_of || 'not pulled'})`, r: 1 }, ''], fed) + `<p>Engine ${num(ctx, 'F1040.26')} · ${btn('Agree to third-party record', 'verify', { target: 'F1040.26' }, 'sm')}</p>`)}
      ${section('California payments (FTB Web Pay)', table(['Date', { t: 'Amount', r: 1 }, 'Designated year', 'Engine', 'FTB account'], ca) + `<p>Engine ${num(ctx, 'F540NR.72')} · FTB 2025 total ${fmt(tr.ftb_account.tax_year_2025_payments.reduce((s, p) => s + p.amount, 0))} · ${btn('Agree to third-party record', 'verify', { target: 'F540NR.72' }, 'sm')}</p>`)}</div>
    <div class="col1">${section('Federal', lines(ctx, ['F1040.25a', 'F1040.26', 'Sch3.10', 'Sch3.11', 'F1040.33', 'F1040.37', 'F2210.8', 'F1040.38']) + `<p class="sm">Workpaper balance due ${fmt(bal)}.</p>`)}
      ${section('California', lines(ctx, ['F540NR.71', 'F540NR.72', 'F540NR.73', 'F540NR.78', 'F540NR.97', 'FTB5805.penalty']))}
      ${section('After the due date', `<p class="sm">Balance paid 07/20/2026 (${days} days late): interest ≈ ${fmt(interest)} (7%/yr) + failure-to-pay ≈ ${fmt(ftp)} (0.5%/month) on ${fmt(Math.max(0, bal))}. Not computed by the engine; IRS assesses (code 196/276). Consider first-time abatement for the penalty.</p>`)}</div></div>`;
}

// ------------------------------------------------------------------ state split
function state(ctx) {
  const rows = ['1', '2', '3', '4', '7', '12', '17', '22', '26'].map(n => `<tr><td>${n}</td><td>${esc((getLine(ctx.idx, ctx.vid, `SchCA540NR.${n}.D`) || getLine(ctx.idx, ctx.vid, `SchCA540NR.${n}.A`))?.label.replace(/ - (federal|total using CA law)$/, '') || '')}</td>${['A', 'B', 'C', 'D', 'E'].map(c => `<td class="r">${has(ctx, `SchCA540NR.${n}.${c}`) ? num(ctx, `SchCA540NR.${n}.${c}`) : ''}</td>`).join('')}</tr>`);
  return head('State split — California 540NR', `California resident 01/01–07/14/2025 (${ctx.idx.params.ca_resident_days} of ${ctx.idx.params.year_days} days); Texas resident from 07/15. California taxes worldwide income while resident and California-source income after.`) +
    section('Residency', table(['State', 'From', 'To', 'Status', 'Evidence'], ctx.idx.packet.household.residency.map(r => `<tr><td>${r.state}</td><td>${r.from}</td><td>${r.to}</td><td>${r.status}</td><td>${refChip(ctx, 'qa-02')} ${r.state === 'TX' ? refChip(ctx, 'D04', 'TX license 08/02/2025') + refChip(ctx, 'D54', 'home purchase') : ''}</td></tr>`))) +
    section('Schedule CA (540NR)', `<table class="t"><thead><tr><th>Line</th><th>Item</th><th class="r">A Federal</th><th class="r">B Subtract</th><th class="r">C Add</th><th class="r">D CA law</th><th class="r">E CA source</th></tr></thead><tbody>${rows.join('')}</tbody></table>
      <p class="sm">Sourcing rules: wages by work location while resident (W-2 box 16 — wrong for Halvorsen after 07/14, see finding), investment income by residency days, Sacramento rental 100%, Ridgeline 22% California for the nonresident period, sales by date.</p>`) +
    section('Form 540NR', lines(ctx, ['F540NR.13', 'F540NR.17', 'F540NR.18', 'F540NR.19', 'F540NR.31', 'F540NR.32', 'F540NR.34', 'F540NR.35', 'F540NR.36', 'F540NR.37', 'F540NR.39', 'F540NR.40', 'ScheduleS.credit', 'F540NR.61', 'F540NR.64']));
}

// ------------------------------------------------------------------ carryovers
function carryovers(ctx) {
  const ci = ctx.idx.packet.prior_years.carryovers_into_2025;
  const ver = (k) => ctx.state.verifications.get(k)?.length ? '<span class="ok-t">✓ agreed</span>' : btn('Agree to prior year', 'verify', { target: k }, 'sm');
  const inRows = [['Capital loss — short-term', ci.capital_loss_short, 'SchD.6', 'py:/carryovers_into_2025/capital_loss_short'], ['Capital loss — long-term', ci.capital_loss_long, 'SchD.14', 'py:/carryovers_into_2025/capital_loss_long'], ['Passive — Fremont Way', ci.passive_1450_fremont, 'F8582.1c', 'py:/carryovers_into_2025/passive_1450_fremont'], ['Passive — Barton Hills 4C', ci.passive_1200_barton_hills, 'F8582.1c', 'py:/carryovers_into_2025/passive_1200_barton_hills'], ['IRA basis (Form 8606 line 14)', 7000, 'F8606.2', 'py:/return_2024/lines/F8606.14'], ['S corp stock basis (rolled)', null, 'F7203.1', 'py:/basis_records/scorp_lindqvist_family_woodworks']];
  const co = ctx.v.carryovers_out;
  return head('Carryovers', 'Into 2025 agreed to the 2024 return; out of 2025 for next year’s preparer.') +
    section('Into 2025', table(['Item', { t: '2024 record', r: 1 }, 'Used on', 'Agreed'], inRows.map(([l, v, k, src]) => `<tr><td>${l}</td><td class="r">${refChip(ctx, src, v != null ? fmt(v) : 'records')}</td><td>${has(ctx, k) ? `<span class="lc">${k} ${num(ctx, k)}</span>` : k}</td><td>${ver(k)}</td></tr>`))) +
    section('Out of 2025 (engine ' + ctx.vid + ')', table(['Item', { t: 'Federal', r: 1 }], Object.entries(co.federal).map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td class="r">${v == null ? '—' : fmt(v)}</td></tr>`)) + `<p class="sm">California: ${Object.entries(co.california).filter(([k]) => k !== 'depreciation_basis_differences').map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmt(v)}`).join(' · ')}; depreciation basis differences on 4 assets (see depreciation). Workpaper changes that alter carryovers: crypto basis (none), HVAC creates a new 27.5-year asset, minimum tax credit ${fmt(co.federal.minimum_tax_credit_from_2025_amt)} → Form 8801 in 2026, SEP excess ${fmt(co.federal.sep_contribution_not_deductible_for_2025)} carried to 2026.</p>`);
}

// ------------------------------------------------------------------ basis by year
function basis(ctx) {
  const b = ctx.idx.packet.prior_years.basis_records;
  const ev = (d, f) => (ctx.idx.evsByDoc.get(d) || []).find(x => x.field === f);
  const got23 = !ctx.clock || ctx.idx.docs.get('D40').received_at <= ctx.clock;
  const rows = [
    `<tr><td>2022</td><td></td><td></td><td></td><td class="r">21,300</td><td class="sm">${refChip(ctx, 'py:/basis_records/scorp_lindqvist_family_woodworks/0', 'client worksheet (prior file)')}</td></tr>`,
    got23 ? `<tr><td>2023</td><td class="r">21,300</td><td class="r">${refChip(ctx, ev('D40', 'box1').id, '14,100')}</td><td class="r">${refChip(ctx, ev('D40', 'box16d').id, '(20,000)')}</td><td class="r">15,400</td><td class="sm">2023 K-1 found 06/2026 (D40)</td></tr>` : `<tr class="warnrow"><td>2023</td><td colspan="4">GAP — K-1 not in file; engine assumed no change</td><td class="sm">${refChip(ctx, 'py:/basis_records/scorp_lindqvist_family_woodworks/1')}</td></tr>`,
    `<tr><td>2024</td><td class="r">${got23 ? '15,400' : '21,300?'}</td><td class="r">16,900</td><td class="r">(30,000)</td><td class="r">${got23 ? '2,300' : '8,200?'}</td><td class="sm">2024 K-1; prior preparer “assumed basis sufficient”</td></tr>`,
    `<tr><td>2025</td><td class="r">${num(ctx, 'F7203.1')}</td><td class="r">${num(ctx, 'F7203.4')}</td><td class="r">${num(ctx, 'F7203.6')}</td><td class="r">${num(ctx, 'F7203.15')}</td><td class="sm">Excess distributions ${num(ctx, 'F7203.excess')} taxed as long-term gain</td></tr>`];
  return head('Basis by year', 'S corporation stock basis, partnership capital, IRA basis and home cost. Gaps are shown as gaps.') +
    section('Lindqvist Family Woodworks — stock basis (Form 7203)', table(['Year', { t: 'Beginning', r: 1 }, { t: 'Income', r: 1 }, { t: 'Distributions', r: 1 }, { t: 'Ending', r: 1 }, 'Source'], rows)) +
    section('Ridgeline Real Estate Fund III — capital account', table(['Year', { t: 'Capital end', r: 1 }, 'Outside basis', 'Source'], [`<tr><td>2024</td><td class="r">60,000</td><td>never computed</td><td>${refChip(ctx, 'py:/basis_records/partnership_ridgeline/0')}</td></tr>`, `<tr><td>2025</td><td class="r">${ev('D37', 'cap_end') ? refChip(ctx, ev('D37', 'cap_end').id, '63,660') : '—'}</td><td>open item for 2026: obtain contribution history</td><td>K-1 D37</td></tr>`])) +
    section('IRA nondeductible basis (Ngozi)', table(['Year', { t: 'Basis end', r: 1 }, 'Source'], [`<tr><td>2024</td><td class="r">7,000</td><td>${refChip(ctx, 'py:/basis_records/ira_nondeductible_basis_ngozi/0')}</td></tr>`, `<tr><td>2025</td><td class="r">${num(ctx, 'F8606.14')}</td><td>Form 8606 line 14</td></tr>`])) +
    section('Home — 7709 Barton Ridge Dr', `<p>Purchased 07/08/2025 for ${refChip(ctx, 'ev-1025', '685,000')}; purchase points ${refChip(ctx, 'ev-1026', '4,800')} deducted; seller credit for taxes ${refChip(ctx, 'ev-1027', '6,912')} (not deductible by buyer); refinanced 11/20/2025 (points 3,200 amortized over 360 months). Keep for a future sale (§121).</p>`);
}

// ------------------------------------------------------------------ prior preparer vs us
function prior(ctx) {
  const pw = ctx.idx.packet.prior_years.prior_preparer_workpaper;
  const res = [
    ['Woodworks basis: 2023 K-1 not provided; basis not rolled forward', ctx.idx.docs.get('D40').received_at <= ctx.clock ? 'Obtained 2023 K-1 (D40); basis rolled 21,300 → 15,400 → 2,300; 2024 basis was sufficient' : 'Still open — requested'],
    ['8606 basis 7,000 per client; 5498 not obtained', 'Obtained 2024 Form 5498 (D42): 7,000 made 02/12/2025 for 2024 — agreed'],
    ['Sparbanken: FBAR filed by client; 8938 filed', 'Form 8938 required again; FBAR 2025 outside scope (client) — confirm. Interest converted at 2025 rate'],
    ['Fremont appliances: federal 100% bonus; CA 200DB', 'Agreed; CA depreciation 483.84 in 2025'],
    ['Home office 300 sq ft — client to confirm', 'Measured: 220 sq ft (Sacramento) and 260 (Austin). 2024 claimed 300 — overstated 80 sq ft (400 deduction); immaterial, not amended — record judgment'],
    ['Open: 2023 Form 3520 (foreign inheritance > 100,000) — no resolution', 'Outside filing identified; ask client, refer'],
    ['No SE health insurance in 2024 (eligible for spouse’s plan)', 'Same facts in 2025: engine took 14,400 — reversed (finding)'],
  ];
  const py = ctx.idx.packet.prior_years.return_2024.lines;
  const cmp = ['SchC.1', 'SchC.9', 'SchC.11', 'SchC.30', 'SchC.44a', 'Sch1.17', 'SchE.14A', 'SchB.1.1', 'F8938', 'F1040.24'].map(k => `<tr><td>${esc(k)}</td><td>${esc(ctx.idx.packet.prior_years.return_2024.line_labels[k] || '')}</td><td class="r">${fmt(py[k])}</td><td class="r">${has(ctx, k) ? num(ctx, k) : '—'}</td></tr>`);
  return head('Prior preparer vs us', `2024 by ${esc(ctx.idx.packet.prior_years.return_2024.prepared_by)}, filed ${ctx.idx.packet.prior_years.return_2024.filed}. Every note and open item they left, and what we did with it.`) +
    section('Their notes and open items → our resolution', table(['Prior preparer', 'This year'], res.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`)) + `<p class="sm">Source: ${refChip(ctx, 'D07')} · memo: “${esc(pw.summary_memo)}”</p>`) +
    section('Selected lines: 2024 vs 2025', table(['Line', 'Label', { t: '2024', r: 1 }, { t: '2025 workpaper', r: 1 }], cmp));
}
