import * as M from '../model.js';
import { esc, fmt, fmtDate, btn, section, pill } from '../ui.js';
import { viewNotice } from './filing.js';

// Client portal: questions to answer (answers become evidence), uploads, approval and signature.
export function viewClient(ctx) {
  const qs = [...ctx.state.notes.values()].filter(n => n.kind === 'question' && n.to === 'client');
  const open = qs.filter(n => n.status === 'open');
  const f = ctx.state.filing;
  const fp = M.returnFingerprint(ctx);
  const p = f.presented;
  const pres = p ? `<div class="client-sum"><div><small>Federal</small><b>${p.summary.fed.balance_due >= 0 ? 'You owe ' + fmt(p.summary.fed.balance_due) : 'Refund ' + fmt(-p.summary.fed.balance_due)}</b><span>total tax ${fmt(p.summary.fed.total_tax)}</span></div><div><small>California</small><b>${p.summary.ca.balance_due >= 0 ? 'You owe ' + fmt(p.summary.ca.balance_due) : 'Refund ' + fmt(-p.summary.ca.balance_due)}</b><span>total tax ${fmt(p.summary.ca.total_tax)}</span></div></div>
    ${p.fp !== fp ? '<p class="warn">Your preparer has changed the return since presenting it; they will send the updated version.</p>' : ''}
    <div class="actions">${f.clientApproved ? pill('Approved ' + fmtDate(f.clientApproved.at), 'ok') : btn('Approve this return', 'clientApprove', {}, 'primary')}${f.signed ? pill('8879 signed ' + fmtDate(f.signed.at), 'ok') : f.clientApproved ? btn('Sign e-file authorization (8879)', 'sign8879', {}, 'primary') : ''}<a class="btn ghost" href="#/copy">View summary</a></div>` : '<p class="muted">Your preparer has not sent the return for approval yet.</p>';
  return `<div class="hero"><div><h1>Hi ${esc(ctx.user.name.split(' ')[0])}</h1><p class="sub">Your 2025 tax return with Miraflores. ${open.length ? `We need ${open.length} answer${open.length > 1 ? 's' : ''} from you.` : 'Nothing needed from you right now.'}</p></div><div class="hero-a">${btn('Upload a document', 'attach', { target: 'client-upload' }, 'primary')}</div></div>
  <div class="cols"><div class="col2">
    ${section('Questions from your preparer', qs.length ? qs.map(n => `<article class="note ${n.status}"><p><b>${esc(n.text)}</b></p>${n.replies.map(r => `<div class="rep"><b>${esc(M.userName(ctx.idx, r.by))}</b>: ${esc(r.text)}</div>`).join('')}<div class="actions">${n.status === 'open' ? btn('Answer', 'reply', { id: n.id }, 'sm primary') : pill('answered', 'ok')}</div></article>`).join('') : '<p class="muted">No questions.</p>')}
    ${section('Your return', pres)}
  </div><div class="col1">
    ${section('Status', `<p>${f.frozen ? 'Filed and accepted ✓' : f.submissions.at(-1)?.result === 'rejected' ? 'The IRS rejected the e-file — your preparer is fixing it.' : f.signed ? 'Authorized — your preparer will file.' : 'In preparation (extended to 10/15/2026).'}</p>`)}
    ${section('Your uploads', ctx.state.evidence.filter(e => e.by === ctx.user.id).map(e => `<div class="frow">📎 ${esc(e.name)} <span class="sm muted">${fmtDate(e.at)}</span></div>`).join('') || '<p class="muted">None.</p>')}
  </div></div>`;
}

export function viewExaminer(ctx) {
  return `<div class="callout">Read-only examination record shared by Miraflores. Sensitive identifiers are masked.</div>${viewNotice(ctx)}`;
}
