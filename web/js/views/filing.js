import * as M from '../model.js';
import { line as getLine } from '../data.js';
import { esc, attr, fmt, fmtDelta, fmtDate, num, refChip, btn, section, table, pill, sev } from '../ui.js';
import { summaryTable } from './overview.js';
import { filingStatus } from '../app.js';

export function viewFiling(ctx) {
  const st = M.steps(ctx);
  const f = ctx.state.filing;
  const fp = M.returnFingerprint(ctx);
  const ext = ctx.idx.packet.what_if.extension;
  const extTl = ctx.idx.timeline.find(t => t.id === 'extension-2026-04-14');
  const reached = (iso) => ctx.clock >= iso;
  const ps = M.signoffStatus(ctx, 'return', 'partner');
  const paidBefore = ctx.adjusted.fed.payments - (ctx.v.lines.some(l => l.key === 'Sch3.10' && l.value) ? ext.federal.paid_with_form_4868 : 0);
  const shortfall = ctx.adjusted.fed.total_tax - paidBefore - ext.federal.paid_with_form_4868;
  const stepRow = (s) => `<li class="${s.ok ? 'ok' : ''}"><span class="ck">${s.ok ? '✓' : '○'}</span><div><b>${esc(s.name)}</b><div class="sm muted">${esc(s.how)}${ctx.state.steps.get(s.name) ? ` — ${esc(M.userName(ctx.idx, ctx.state.steps.get(s.name).by))}: ${esc(ctx.state.steps.get(s.name).note)}` : ''}</div>${s.evidence ? `<div class="chips">${s.evidence.map(r => refChip(ctx, r)).join('')}</div>` : ''}</div>${s.manual ? (s.ok ? btn('Reopen', 'stepReopen', { step: s.name }, 'sm ghost') : btn('Complete', 'step', { step: s.name }, 'sm')) : ''}</li>`;
  const subs = f.submissions;
  return `<div class="hero"><div><h1>Filing</h1><p class="sub">Status: <b>${esc(filingStatus(ctx).label)}</b>. Filing is gated by the firm’s required steps, open review notes and fresh sign-offs. The client approves the exact figures presented; if anything changes after, approval is void.</p></div></div>
  <div class="cols"><div class="col2">
    ${section(`Required steps ${st.filter(s => s.ok).length}/${st.length}`, `<ul class="stepl">${st.map(stepRow).join('')}</ul>`)}
    ${section('E-file', `${subs.length ? table(['When', 'Jurisdiction', 'Submission', 'Result', 'Errors'], subs.map(s => `<tr><td>${fmtDate(s.at, true)}</td><td>${esc(s.jurisdiction)}</td><td><code>${esc(s.submissionId)}</code></td><td>${pill(s.result, s.result === 'accepted' ? 'ok' : 'warn')}</td><td class="sm">${(s.errors || []).map(e => `<b>${esc(e.code)}</b> ${esc(e.message)}`).join('<br>')}</td></tr>`)) : '<p class="muted">Nothing transmitted yet.</p>'}
      ${subs.at(-1)?.result === 'rejected' ? `<div class="callout">Rejected: dependent TIN/name mismatch. Fix: ${ctx.state.fixes.has('theo.ssn') ? '✓ SSN corrected — retransmit.' : `<a href="#/findings?f=F-DEP-SSN-theo">correct Theo’s SSN</a> (Social Security card ${ctx.idx.docs.get('D71').received_at <= ctx.clock ? 'received 07/13' : 'requested'}).`} Correcting a dependent SSN changes no figures, so the client’s 8879 still matches.</div>` : ''}
      <div class="actions">${!f.frozen ? btn('Transmit federal + California', 'transmit', {}, 'primary') : ''}${f.frozen ? btn('Start amended return', 'amend', {}, 'warn') : ''}</div>
      <p class="sm muted">Paid preparer: ${esc(M.userName(ctx.idx, ctx.idx.packet.firm.firm_identity.paid_preparer_signing_returns))} (PTIN ${esc(ctx.idx.packet.firm.firm_identity.ptins['st-03'])}), EFIN ${esc(ctx.idx.packet.firm.firm_identity.efin)}. Taxpayer IP PIN required (D03). Prior-year AGI for signature ${fmt(ctx.idx.packet.household.prior_year_agi_for_esignature)}.</p>`)}
    ${f.frozen ? section('Frozen at filing', `<p>Frozen ${fmtDate(f.frozen.at, true)} by ${esc(M.userName(ctx.idx, f.frozen.by))} · fingerprint <code>${esc(f.frozen.fp)}</code> · ${f.frozen.adjustments.length} approved adjustments · engine ${f.frozen.version}. ${f.frozen.fp === fp ? '<span class="ok-t">Current workpaper matches the filed return.</span>' : '<span class="warn">Workpaper has changed since filing (amendment in progress).</span>'}</p>
      <table class="t sum"><tbody><tr><td>Federal total tax</td><td class="r">${fmt(f.frozen.summary.fed.total_tax)}</td><td>Balance due</td><td class="r">${fmt(f.frozen.summary.fed.balance_due)}</td></tr><tr><td>California total tax</td><td class="r">${fmt(f.frozen.summary.ca.total_tax)}</td><td>Balance / (refund)</td><td class="r">${fmt(f.frozen.summary.ca.balance_due)}</td></tr></tbody></table>
      ${f.amendments.map(a => `<div class="callout">Amendment ${a.n}: ${esc(a.reason)} — ${esc(M.userName(ctx.idx, a.by))} ${fmtDate(a.at)}</div>`).join('')}`) : ''}
  </div><div class="col1">
    ${section('Extension', `<p>${reached(extTl.at) ? `Filed ${fmtDate(extTl.at)} by ${esc(M.userName(ctx.idx, extTl.actor))}: ${esc(extTl.detail)}` : 'Due 04/15/2026. Ridgeline K-1 not expected until June — extend.'}</p>
      <p class="sm">Estimate from ${ext.based_on_version}: tax ${fmt(ext.federal.estimated_total_tax)} − payments ${fmt(ext.federal.payments)} = ${fmt(ext.federal.estimated_balance)} → paid ${fmt(ext.federal.paid_with_form_4868)}. Against the workpaper’s tax the extension payment left <b>${fmt(Math.max(0, shortfall))}</b> unpaid at 04/15 (interest and failure-to-pay run from 04/16).</p>${!f.extension && reached(extTl.at) ? btn('Record extension in workpaper', 'extension', {}, 'sm ghost') : ''}${f.extension ? '<span class="pill ok">recorded</span>' : ''}`)}
    ${section('Client approval & Form 8879', `<ul class="stepl">
      <li class="${ps.state === 'fresh' ? 'ok' : ''}"><span class="ck">${ps.state === 'fresh' ? '✓' : '○'}</span><div><b>Partner sign-off</b><div class="sm muted">${ps.state === 'stale' ? esc(ps.why) : ps.state === 'fresh' ? esc(M.userName(ctx.idx, ps.so.by)) : ''}</div></div>${M.can(ctx.user, 'signoff:partner') ? btn('Sign', 'signoff', { scope: 'return', level: 'partner' }, 'sm') : ''}</li>
      <li class="${f.presented ? 'ok' : ''}"><span class="ck">${f.presented ? '✓' : '○'}</span><div><b>Presented to client</b><div class="sm muted">${f.presented ? fmtDate(f.presented.at, true) + (f.presented.fp !== fp ? ' — <span class="warn">return changed since; present again</span>' : '') : ''}</div></div>${btn('Present', 'presentToClient', {}, 'sm')}</li>
      <li class="${f.clientApproved ? 'ok' : ''}"><span class="ck">${f.clientApproved ? '✓' : '○'}</span><div><b>Client approved</b><div class="sm muted">${f.clientApproved ? esc(M.userName(ctx.idx, f.clientApproved.by)) + ' ' + fmtDate(f.clientApproved.at, true) : 'Switch to Ngozi (client) to approve'}</div></div></li>
      <li class="${f.signed ? 'ok' : ''}"><span class="ck">${f.signed ? '✓' : '○'}</span><div><b>Forms 8879 / FTB 8879 signed</b><div class="sm muted">${f.signed ? fmtDate(f.signed.at, true) + (f.signed.fp !== fp ? ' — <span class="warn">signed figures no longer match</span>' : ' — matches current figures') : ''}</div></div></li></ul>`)}
    ${section('After filing (scripted season)', `<ul class="feed sm">${ctx.idx.timeline.filter(t => t.at > '2026-07-01').map(t => `<li class="${reached(t.at) ? '' : 'muted'}"><b>${fmtDate(t.at)}</b> ${esc(t.event.replace(/_/g, ' '))}${t.detail ? ' — ' + esc(t.detail) : ''}</li>`).join('')}</ul>`)}
  </div></div>`;
}

// ------------------------------------------------------------------ notice response
export function viewNotice(ctx) {
  const n = ctx.idx.packet.tax_agency_records.notices.find(x => x.id === 'N-2025-L566');
  const arrived = ctx.clock >= '2028-01-26';
  const f = ctx.state.filing.frozen;
  const item = (title, keys, docs, extra) => section(title, `${table(['Line', 'Description', { t: 'As filed', r: 1 }, 'Verified', 'Changes from engine'], keys.filter(k => getLine(ctx.idx, ctx.vid, k)).map(k => { const lv = M.lineView(ctx, k); return `<tr><td>${esc(k)}</td><td>${esc(lv.line.label)}</td><td class="r">${num(ctx, k)}</td><td class="sm">${(lv.verified || []).map(v => `✓ ${esc(v.method.replace(/_/g, ' '))} (${esc(M.userName(ctx.idx, v.by))})`).join('<br>') || '—'}</td><td class="sm">${lv.adj ? `engine ${fmt(lv.original)} → ${fmt(lv.adj.to)}: ${esc(lv.adj.reason)}` : ''}</td></tr>`; }))}
    <h4>Supporting documents</h4><div class="chips">${docs.map(d => refChip(ctx, d)).join('')}</div>${extra || ''}`);
  const necs = ['D16', 'D17', 'D18', 'D19', 'D20'].map(d => ctx.idx.evsByDoc.get(d).find(e => e.field === 'box1'));
  return `<div class="hero"><div><div class="eyebrow">${esc(n.agency)} ${esc(n.type)} · tax year ${n.tax_year} · dated ${fmtDate(n.dated)} · response due ${fmtDate(n.response_due)}</div><h1>Notice response record</h1><p class="sub">${arrived ? 'Received 01/26/2028.' : 'Not yet received at this season clock — this is what the record would look like today.'} Self-contained: every item under examination with the filed figure, its sources, how it was verified, what we changed and why. Shareable read-only with the examiner (role switcher → IRS examiner).</p></div><div class="hero-a">${btn('Print / PDF', 'print', {}, 'primary printbtn')}</div></div>
    ${section('Return as filed', f ? `<p>Filed and frozen ${fmtDate(f.at)} · fingerprint <code>${esc(f.fp)}</code>. Federal total tax ${fmt(f.summary.fed.total_tax)}.</p>` : '<p class="warn">The return has not been filed in this workpaper yet; figures below are the current workpaper.</p>')}
    ${item('1. Noncash charitable contributions (Schedule A line 12, Form 8283)', ['F8283.A1.stock', 'F8283.A1.vehicle', 'SchA.12'], ['D65', 'D66', 'ev-1051', 'ev-1052', 'ev-1054', 'qa-39', 'call-01'],
      `<ul class="sm"><li>Stock: 200 sh Northlake Total Market Index Fund to Austin Community Foundation DAF 12/05/2025, held since 04/2019 (long-term), FMV 72.50 high/low = 14,500; written acknowledgment, no goods or services. Publicly traded — no qualified appraisal required.</li><li>Vehicle: 2012 Subaru Outback donated 08/20/2025; Form 1098-C shows an arm’s-length sale 09/09/2025 for 2,900. Deduction limited to gross proceeds (IRC 170(f)(12)); the client’s 6,000 Blue Book estimate was ${[...ctx.state.adjustments.values()].some(a => a.line === 'F8283.A1.vehicle' && a.status === 'approved') ? 'reduced to 2,900 before filing' : '<b class="warn">NOT corrected — exposure 3,100 of deduction</b>'}.</li></ul>`)}
    ${item('2. Schedule C gross receipts vs Forms 1099-NEC (142,000) and 1099-K (12,400)', ['SchC.1'], ['D14', 'D15', 'D16', 'D17', 'D18', 'D19', 'D20', 'D21'],
      `<table class="t lines"><tbody>${necs.map(e => `<tr><td>${esc(ctx.idx.docs.get(e.document_id).issuer)} 1099-NEC</td><td class="r">${fmt(e.value)}</td></tr>`).join('')}<tr class="tot"><td>Total 1099-NEC</td><td class="r">${fmt(necs.reduce((s, e) => s + e.value, 0))}</td></tr><tr><td>Deposits from 11 clients who issued no 1099</td><td class="r">9,300</td></tr><tr class="tot"><td>Gross receipts per books</td><td class="r">151,300</td></tr><tr><td>Form 1099-K Paywell 12,400 — Atlas Outdoor Gear’s card payments, already included in Atlas’s 1099-NEC 41,200 (books detail D15 p3: 12,400 card + 28,800 ACH)</td><td class="r">0</td></tr></tbody></table>`)}
    ${section('Prior notice history', `<p class="sm">CP2000 for 2023 (unreported 1099-B sale) resolved 11/18/2024, no change — ${refChip(ctx, 'D70')}.</p>`)}`;
}

// ------------------------------------------------------------------ next year
export function viewNextYear(ctx) {
  const pr = ctx.idx.packet.planning_reference_2026;
  const tax = ctx.adjusted.fed.total_tax;
  const sh = Math.ceil(tax * 1.1 / 4);
  const catax = ctx.adjusted.ca.total_tax;
  const open = [
    'Ridgeline: compute outside basis (contributions history); 2025 capital 63,660.',
    'Minimum tax credit from 2025 AMT → Form 8801 (2026).',
    'SEP contribution not deductible for 2025 carries forward (2,786).',
    'FTB 3,500 held as 2024 credit — confirm transfer or refund.',
    'Forms 1099-NEC for contractors: file 2025 late; collect W-9s for 2026.',
    'Form 3520 for the 2023 inheritance — confirm with client.',
    'Fremont Way HVAC (SAC-HVAC) added to the depreciation schedule.',
    'Crypto: keep the CryptoNorth bank record with lot C6; wallet-by-wallet basis.',
    'Home office: Austin 260 sq ft only (no Sacramento).',
    'California: nonresident in 2026 — file 540NR for Sacramento rental and Ridgeline CA share only.',
  ];
  return `<div class="hero"><div><h1>Next year (2026)</h1><p class="sub">Everything the 2026 preparer needs, carried forward with its history. Opens from the 01/15/2027 engagement.</p></div><div class="hero-a">${btn('Print', 'print', {}, 'ghost printbtn')}</div></div>
  <div class="cols"><div class="col2">
    ${section('2026 federal estimates (safe harbor)', `<p>${esc(pr.federal_safe_harbor)}</p>${table(['Due', { t: 'Amount', r: 1 }], pr.federal_estimate_due_dates.map(d => `<tr><td>${fmtDate(d)}</td><td class="r">${fmt(sh)}</td></tr>`))}<p class="sm">110% × 2025 workpaper total tax ${fmt(tax)} = ${fmt(tax * 1.1)} ÷ 4. Withholding at Halvorsen counts toward this; reduce estimates by expected withholding.</p>`)}
    ${section('2026 California estimates', `<p>${esc(pr.california_safe_harbor)}</p>${table(['Due', '%', { t: '110% of 2025 tax', r: 1 }], pr.california_estimate_due_dates.map((d, i) => `<tr><td>${fmtDate(d)}</td><td>${pr.california_installment_percentages[i] * 100}%</td><td class="r">${fmt(catax * 1.1 * pr.california_installment_percentages[i])}</td></tr>`))}<p class="sm">Likely far lower under the 90%-of-2026 test: only the Sacramento rental and Ridgeline’s California share remain California-source.</p>`)}
    ${section('Known 2026 changes', `<ul>${pr.known_2026_changes_for_this_household.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`)}
  </div><div class="col1">
    ${section('Open items carried forward', `<ul class="sm">${open.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`)}
    ${section('Carried forward', `<p class="sm"><a href="#/schedule/carryovers">Carryovers</a> · <a href="#/schedule/depreciation">Assets</a> · <a href="#/schedule/basis">Basis by year</a> · <a href="#/judgment">Decisions & authority</a> · <a href="#/activity">Full history</a></p>`)}
  </div></div>`;
}

// ------------------------------------------------------------------ client copy
export function viewClientCopy(ctx) {
  const f = ctx.state.filing.frozen;
  const s = f ? f.summary : ctx.adjusted;
  const fid = ctx.idx.packet.firm.firm_identity;
  return `<div class="hero noprint"><div><h1>Client copy</h1><p class="sub">${f ? 'As filed and accepted.' : 'Draft — not yet filed.'}</p></div><div class="hero-a">${btn('Print / save PDF', 'print', {}, 'primary printbtn')}</div></div>
  <div class="copy">
    <h2>2025 Form 1040 and California Form 540NR</h2>
    <p>Ngozi Okafor and Erik Lindqvist · Married filing jointly · 7709 Barton Ridge Dr, Austin TX 78746</p>
    <p>Prepared by ${esc(ctx.idx.packet.firm.name)}, ${esc(fid.address)} · ${esc(fid.phone)} · Paid preparer ${esc(M.userName(ctx.idx, fid.paid_preparer_signing_returns))}</p>
    <table class="t sum"><tbody>
      <tr class="grp"><td colspan="2">Federal</td></tr><tr><td>Adjusted gross income</td><td class="r">${fmt(s.fed.agi)}</td></tr><tr><td>Total tax</td><td class="r">${fmt(s.fed.total_tax)}</td></tr><tr><td>Payments and credits</td><td class="r">${fmt(s.fed.payments)}</td></tr><tr class="tot"><td>${s.fed.balance_due >= 0 ? 'Balance due' : 'Refund'}</td><td class="r">${fmt(Math.abs(s.fed.balance_due))}</td></tr>
      <tr class="grp"><td colspan="2">California (part-year resident)</td></tr><tr><td>Total tax</td><td class="r">${fmt(s.ca.total_tax)}</td></tr><tr><td>Payments</td><td class="r">${fmt(s.ca.payments)}</td></tr><tr class="tot"><td>${s.ca.balance_due >= 0 ? 'Balance due' : 'Refund (direct deposit)'}</td><td class="r">${fmt(Math.abs(s.ca.balance_due))}</td></tr>
    </tbody></table>
    <h3>What changed from the software’s first draft, in plain words</h3>
    <ul>${[...ctx.state.adjustments.values()].filter(a => a.status === 'approved').map(a => `<li>${esc(a.reason)}</li>`).join('') || '<li>No changes.</li>'}</ul>
    <h3>Things you need to do</h3>
    <ul><li>File FinCEN 114 (FBAR) for the Sparbanken account by 10/15/2026.</li><li>Issue 2025 Forms 1099-NEC to Mara Quintero and Dev Patel (late) and collect W-9s.</li><li>Make 2026 federal estimated payments (see schedule from your preparer).</li><li>Keep these records for 7 years.</li></ul>
    <p class="sm">${f ? `E-file accepted · fingerprint ${esc(f.fp)}` : 'Not yet filed'} · Signatures: ${ctx.state.filing.signed ? 'Forms 8879 signed ' + fmtDate(ctx.state.filing.signed.at) : 'pending'}</p>
  </div>`;
}
