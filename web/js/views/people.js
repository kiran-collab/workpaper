import * as M from '../model.js';
import { esc, attr, fmt, fmtDelta, fmtDate, num, refChip, btn, section, table, pill, sev, avatar, who } from '../ui.js';
import { findingCard } from './findings.js';

function noteRow(ctx, n) {
  const toName = n.to === 'client' ? 'Client' : n.to ? M.userName(ctx.idx, n.to) : '';
  const late = n.due && n.status === 'open' && n.due < ctx.clock.slice(0, 10);
  return `<article class="note ${n.kind} ${n.status}">
    <header>${avatar(ctx, n.by)} <b>${esc(M.userName(ctx.idx, n.by))}</b>${toName ? ` → <b>${esc(toName)}</b>` : ''} ${pill(n.kind === 'review' ? (n.blocking ? 'review · blocks filing' : 'review') : n.kind, n.kind === 'review' ? 'warn' : '')} ${pill(n.status, n.status === 'open' ? '' : 'ok')}${n.due ? ` <span class="sm ${late ? 'warn' : 'muted'}">due ${esc(n.due)}</span>` : ''} <span class="r sm muted">${fmtDate(n.at, true)}</span></header>
    <p>${esc(n.text)}</p>
    ${n.refs?.length ? `<div class="chips">${n.refs.map(r => refChip(ctx, r)).join('')}</div>` : ''}
    ${n.replies.map(r => `<div class="rep">${avatar(ctx, r.by)} <b>${esc(M.userName(ctx.idx, r.by))}</b> <small>${fmtDate(r.at, true)}</small><div>${esc(r.text)}</div>${r.evidence ? `<span class="pill ok">📎 evidence attached</span>` : ''}</div>`).join('')}
    ${n.resolution ? `<div class="rep ok">✓ Resolved by ${esc(M.userName(ctx.idx, n.resolvedBy))}: ${esc(n.resolution)}</div>` : ''}
    <div class="actions">${n.status === 'open' ? btn('Reply', 'reply', { id: n.id }, 'sm') + btn('Resolve', 'resolveNote', { id: n.id }, 'sm ghost') : btn('Reopen', 'reopenNote', { id: n.id }, 'sm ghost')}</div></article>`;
}
export { noteRow };

export function viewPeople(ctx, q) {
  const tab = q.get('t') || 'open';
  const notes = [...ctx.state.notes.values()].reverse();
  const shown = notes.filter(n => tab === 'all' ? true : tab === 'review' ? n.kind === 'review' : tab === 'questions' ? n.kind === 'question' : tab === 'mine' ? (n.to === ctx.user.id || n.by === ctx.user.id) : n.status === 'open');
  const tasks = [...ctx.state.tasks.values()];
  const matrix = M.AREAS.filter(a => M.areaLines(ctx, a.id).length).map(a => {
    const c = (l) => { const s = M.signoffStatus(ctx, a.id, l); return `<td class="so-${s.state}">${s.state === 'none' ? '—' : s.state === 'fresh' ? '✓ ' + esc(M.userName(ctx.idx, s.so.by).split(' ')[0]) : '⟲ reopened'}</td>`; };
    return `<tr><td><a href="#/area/${a.id}">${esc(a.name)}</a></td><td>${esc(M.userName(ctx.idx, M.assigned(ctx, a.id, 'preparer')))}</td><td>${esc(M.userName(ctx.idx, M.assigned(ctx, a.id, 'reviewer')))}</td>${c('preparer')}${c('reviewer')}</tr>`;
  });
  const ps = M.signoffStatus(ctx, 'return', 'partner');
  return `<div class="hero"><div><h1>Notes, questions & review</h1><p class="sub">Questions to the client or colleagues become evidence on the item they are about. Review notes block filing until cleared. Sign-offs reopen when what was signed changes.</p></div>
    <div class="hero-a">${btn('Ask the client', 'note', { kind: 'question', to: 'client' })}${btn('Ask a colleague', 'note', { kind: 'question', to: 'st-02' }, 'ghost')}${M.can(ctx.user, 'review') ? btn('Review note', 'note', { kind: 'review' }, 'warn') : ''}${btn('Task', 'task', {}, 'ghost')}</div></div>
  <div class="cols"><div class="col2">
    <div class="tabs">${[['open', 'Open'], ['review', 'Review notes'], ['questions', 'Questions'], ['mine', 'Mine'], ['all', 'All']].map(([k, l]) => `<a href="#/people?t=${k}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}</div>
    ${shown.map(n => noteRow(ctx, n)).join('') || '<div class="empty">No notes here. Start one from any number, finding or document.</div>'}
  </div><div class="col1">
    ${section('Sign-offs', `<table class="t mini"><thead><tr><th>Area</th><th>Preparer</th><th>Reviewer</th><th>P</th><th>R</th></tr></thead><tbody>${matrix.join('')}</tbody></table>
      <div class="sobox so-${ps.state}"><small>Partner — whole return</small><b>${ps.state === 'none' ? 'Not signed' : ps.state === 'fresh' ? '✓ ' + esc(M.userName(ctx.idx, ps.so.by)) : '⟲ Reopened'}</b>${ps.why ? `<span class="sm warn">${esc(ps.why)}</span>` : ''}${M.can(ctx.user, 'signoff:partner') ? btn('Partner sign-off', 'signoff', { scope: 'return', level: 'partner' }, 'sm') : ''}</div>`)}
    ${section('Tasks & deadlines', tasks.length ? `<ul class="tasks">${tasks.map(t => `<li class="${t.status}">${t.status === 'done' ? '✓' : btn('Done', 'taskDone', { id: t.id }, 'sm ghost')} ${esc(t.title)} <span class="sm muted">${esc(M.userName(ctx.idx, t.assignee))}${t.due ? ' · due ' + t.due : ''}</span></li>`).join('')}</ul>` : '<p class="muted">No tasks.</p>')}
    ${section('Team', `<ul class="team">${ctx.idx.packet.firm.staff.map(s => `<li>${avatar(ctx, s.id)} ${esc(s.name)} <span class="sm muted">${esc(s.role.replace('_', ' '))}${s.credential ? ', ' + s.credential : ''}${(ctx.state.staff[s.id]?.sensitive_data_clearance ?? s.sensitive_data_clearance) ? '' : ' · masked data'}${s.active_from > ctx.clock.slice(0, 10) ? ' · joins ' + s.active_from : ''}</span></li>`).join('')}</ul>`)}
  </div></div>`;
}

const CONSIDERED = [
  ['Earned income credit', 'AGI far above limits'], ['Head of household', 'Married filing jointly'], ['Unemployment / Social Security benefits', 'None reported; no Forms 1099-G or SSA-1099'],
  ['Alimony', 'None (marital status unchanged, qa-01)'], ['Foreign trust distributions (Sch B line 8)', 'None — inherited account is a bank account, not a trust'],
  ['Premium tax credit (Form 8962)', 'Erik’s plan is not a marketplace plan (D25)'], ['Household employment (Sch H)', 'Child care at centers, not household employees'],
  ['Energy credits (Form 5695)', 'Heat pump is in the rental, not the residence — no residential credit'], ['Gambling, prizes, cancellation of debt', 'No documents; questionnaire silent — confirm with client'],
  ['Gift tax (Form 709)', 'Gifts were to charities (stock to DAF, car) — no 709 required'], ['Kiddie tax (Form 8615)', 'Ada files her own return; earned income only'],
  ['Home sale exclusion (§121)', 'No main-home sale (Sacramento was rented)'], ['Moving expenses', 'Not deductible (not military)'],
];

export function viewJudgment(ctx) {
  const dec = [...ctx.state.decisions.values()].reverse();
  const vars = M.variances(ctx);
  const flagged = vars.filter(v => v.flagged);
  const outside = ctx.findings.filter(f => f.kind === 'outside');
  const docs = [...ctx.idx.docs.values()].map(d => ({ d, st: M.docStatus(ctx, d) }));
  const docCounts = docs.reduce((m, x) => (m[x.st.code] = (m[x.st.code] || 0) + 1, m), {});
  const suggestions = [
    { topic: 'Studio equipment cost recovery', choice: 'Elect section 179 for the 38,000 (same federal result; California −1,050 vs bonus)', authority: 'IRC 179; IRC 168(k); CA R&TC 17255', alternatives: 'Bonus (default); elect out → MACRS (+10,245 federal)', kind: 'election', fed: 0, ca: -1050 },
    { topic: 'Itemize vs standard deduction', choice: 'Itemize', authority: 'IRC 63(e)', alternatives: 'Standard 31,500 (+12,306 federal)', kind: 'election' },
    { topic: 'Underpayment penalty method (Form 2210)', choice: 'Regular method (annualized gives the same 164)', authority: 'IRC 6654(d)(2)', alternatives: 'Annualized income installment method', kind: 'penalty' },
    { topic: 'Failure-to-pay penalty after 04/15', choice: 'Request first-time abatement after assessment', authority: 'IRM 20.1.1.3.3.2.1', alternatives: 'Pay as assessed; reasonable cause', kind: 'penalty' },
    { topic: 'Preparer penalty exposure — crypto basis from bank statement', choice: 'Position has substantial authority; basis documented by contemporaneous bank record', authority: 'IRC 6694; Treas. Reg. 1.6694-2', alternatives: 'Zero basis (overstates tax)', kind: 'judgment' },
    { topic: 'California AMT on the ISO exercise', choice: 'Compute Schedule P (540NR) manually: ISO spread 40,000 sourced to California by workdays from grant (03/2022) to exercise (07/2025)', authority: 'FTB Pub. 1004; CA R&TC 17041(b)', alternatives: 'Treat as non-CA (exercise after move)', kind: 'judgment' },
    { topic: 'Prior-year home office overstatement (2024: 300 vs 220 sq ft)', choice: 'Do not amend 2024 (400 deduction, immaterial); inform client', authority: 'Circular 230 §10.21', alternatives: 'File 2024 amended return', kind: 'judgment' },
  ];
  return `<div class="hero"><div><h1>Judgment & completeness</h1><p class="sub">Judgment calls, elections, due diligence and penalty decisions, each with the authority relied on. Proof that every document was used, every area considered and every outside filing identified.</p></div><div class="hero-a">${btn('Record judgment / election', 'decision')}</div></div>
  <div class="cols"><div class="col2">
    ${section('Decisions on file', dec.length ? table(['Kind', 'Topic', 'Decision', 'Authority', { t: 'Tax effect', r: 1 }, 'By', ''], dec.map(d => `<tr><td>${pill(d.kind)}</td><td>${esc(d.topic)}</td><td>${esc(d.choice)}${d.alternatives ? `<div class="sm muted">Alternatives: ${esc(d.alternatives)}</div>` : ''}</td><td class="sm">${esc(d.authority)}</td><td class="r">fed ${fmtDelta(d.effectFed)}<br>CA ${fmtDelta(d.effectCa)}</td><td>${esc(M.userName(ctx.idx, d.by))}${d.approvals.map(a => `<div class="sm ok-t">✓ ${esc(M.userName(ctx.idx, a.by))}</div>`).join('')}</td><td>${!d.approvals.length && M.can(ctx.user, 'approve:large') ? btn('Approve', 'approveDecision', { id: d.id }, 'sm') : ''}</td></tr>`)) : '<p class="muted">None recorded yet.</p>')}
    ${section('Suggested decisions to record', table(['Topic', 'Suggested', ''], suggestions.filter(s => ![...ctx.state.decisions.values()].some(d => d.topic === s.topic)).map(s => `<tr><td>${pill(s.kind)} ${esc(s.topic)}</td><td class="sm">${esc(s.choice)}<div class="muted">${esc(s.authority)}</div></td><td>${btn('Record', 'decision', s, 'sm')}</td></tr>`)))}
    ${section(`Variances vs 2024 (${flagged.length} over firm threshold: >${ctx.std.variance_pct}% and >${fmt(ctx.std.variance_amt)})`, table(['Line', 'Label', { t: '2024', r: 1 }, { t: '2025', r: 1 }, { t: 'Change', r: 1 }, 'Explanation'], flagged.map(v => `<tr><td><button class="link" data-a="inspect" data-ref="${attr(v.key)}">${esc(v.key)}</button></td><td class="sm">${esc(v.label.slice(0, 60))}</td><td class="r">${fmt(v.prior)}</td><td class="r">${fmt(v.current)}</td><td class="r">${fmtDelta(v.delta)} <span class="sm muted">${v.pct.toFixed(0)}%</span></td><td>${v.explained ? `<span class="sm ok-t">✓ ${esc(v.explained.text)}</span>` : btn('Explain', 'note', { kind: 'variance', ref: v.key }, 'sm')}</td></tr>`), 'compact'))}
  </div><div class="col1">
    ${section('Due diligence — Form 8867', `<p class="sm">Required for CTC/ODC and AOTC (firm rule). The engine marks 8867 “Not completed”.</p><ul class="dd">${M.DD_QUESTIONS.map(q => { const a = ctx.state.dd.get(q.id); return `<li><label class="cb"><input type="checkbox" data-a="dd" data-q="${q.id}" ${a?.answer ? 'checked' : ''}> <span>${pill(q.credit)} ${esc(q.q)}${a?.answer ? `<small class="ok-t"> — ${esc(M.userName(ctx.idx, a.by))}</small>` : ''}</span></label></li>`; }).join('')}</ul>`)}
    ${section('Every document accounted for', `<p>${Object.entries(docCounts).map(([k, v]) => `${pill(k + ' ' + v, k === 'unaccounted' ? 'warn' : '')}`).join(' ')}</p>${docs.filter(x => x.st.code === 'unaccounted').map(x => `<div class="frow">${refChip(ctx, x.d.id)} ${btn('Disposition', 'disposition', { doc: x.d.id }, 'sm ghost')}</div>`).join('')}<a href="#/docs">Document index →</a>`)}
    ${section('Outside filings identified', outside.map(f => `<div class="frow">${sev(f.severity)} <a href="#/findings?f=${f.id}">${esc(f.title)}</a><div class="sm muted">${esc(f.summary)}</div></div>`).join(''))}
    ${section('Every area considered', `<ul class="sm considered">${CONSIDERED.map(([a, why]) => { const s = ctx.state.steps.get('considered:' + a); return `<li>${s ? '✓' : '○'} <b>${esc(a)}</b> — ${esc(why)} ${s ? `<span class="ok-t">(${esc(M.userName(ctx.idx, s.by))})</span>` : btn('Confirm', 'step', { step: 'considered:' + a }, 'sm ghost')}</li>`; }).join('')}</ul>`)}
  </div></div>`;
}
