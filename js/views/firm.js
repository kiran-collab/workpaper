import * as M from '../model.js';
import { esc, attr, fmt, fmtDate, btn, section, table, pill, avatar } from '../ui.js';
import { filingStatus } from '../app.js';

export function viewFirm(ctx, q) {
  const tab = q.get('t') || (ctx.user.role === 'firm_administrator' ? 'standards' : 'time');
  const admin = M.can(ctx.user, 'standards');
  const tabs = [['standards', 'Standards'], ['access', 'Staff & access'], ['views', 'Sensitive-data view log'], ['time', 'Time vs budget'], ['status', 'Status & search'], ['data', 'Data']];
  let body = '';
  if (tab === 'standards') {
    body = section('Firm-wide standards', `${admin ? '' : '<p class="warn sm">Read-only: only the firm administrator changes standards.</p>'}
      <div class="grid3"><label>Variance flag: change over %<input id="std-pct" class="in" type="number" value="${ctx.std.variance_pct}" ${admin ? '' : 'disabled'}></label><label>…and over amount<input id="std-amt" class="in" type="number" value="${ctx.std.variance_amt}" ${admin ? '' : 'disabled'}></label><label>Partner sign-off when tax effect over<input id="std-thr" class="in" type="number" value="${ctx.std.partner_threshold}" ${admin ? '' : 'disabled'}></label></div>
      ${admin ? btn('Save standards', 'saveStandards', {}, 'primary') : ''}
      <h4>Rules</h4><ol>${ctx.std.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ol>${admin ? btn('Add rule', 'addRule', {}, 'ghost sm') : ''}
      <h4>Verification types</h4><p>${ctx.std.verification_types.map(v => pill(v.replace(/_/g, ' '))).join(' ')}</p>
      <h4>Review levels</h4><p>${ctx.std.review_levels.join(' → ')}</p>
      <h4>Required steps before filing</h4><ol>${ctx.std.required_steps.map(r => `<li>${esc(r)}</li>`).join('')}</ol>
      <p class="sm muted">How the rules are enforced: role permissions are checked in every action (not just hidden buttons); self-review is blocked by comparing who prepared/adjusted an area; adjustments over the threshold stay “proposed” until a partner approves; open blocking review notes stop transmission; non-cleared staff never receive unmasked SSNs or account numbers, and every unmask is journaled.</p>`);
  } else if (tab === 'access') {
    body = section('Staff & access', table(['', 'Name', 'Role', 'Credential', 'Active from', 'Sensitive data', 'Note'], ctx.idx.packet.firm.staff.map(s => { const cl = ctx.state.staff[s.id]?.sensitive_data_clearance ?? s.sensitive_data_clearance; return `<tr><td>${avatar(ctx, s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.role.replace('_', ' '))}</td><td>${esc(s.credential || '')}</td><td>${esc(s.active_from)}</td><td>${cl ? pill('cleared', 'ok') : pill('masked', 'warn')} ${admin ? btn(cl ? 'Revoke' : 'Grant', 'clearance', { id: s.id, value: String(!cl) }, 'sm ghost') : ''}</td><td class="sm">${esc(s.note || '')}</td></tr>`; })) +
      `<p class="sm">Client users: ${ctx.idx.packet.firm.client_users.map(c => esc(c.name)).join(', ')} — portal only. IRS examiner — read-only examination record.</p>`);
  } else if (tab === 'views') {
    body = section(`Unmasked views (${ctx.state.views.length})`, ctx.state.views.length ? table(['When', 'Who', 'Field', 'Record'], ctx.state.views.slice().reverse().map(v => `<tr><td>${fmtDate(v.at, true)}</td><td>${esc(M.userName(ctx.idx, v.by))}</td><td>${esc(v.field)}</td><td><code>${esc(v.ref)}</code></td></tr>`)) : '<p class="muted">No sensitive values have been unmasked.</p>');
  } else if (tab === 'time') {
    const bud = ctx.idx.packet.firm.budget_hours;
    const byArea = {}; const byPerson = {};
    for (const t of ctx.state.time) { byArea[t.area] = (byArea[t.area] || 0) + t.hours; byPerson[t.by] = (byPerson[t.by] || 0) + t.hours; }
    const tot = Object.values(bud).reduce((s, x) => s + x, 0), used = Object.values(byArea).reduce((s, x) => s + x, 0);
    body = section(`Time vs budget — ${used.toFixed(1)} of ${tot} h (fee ${fmt(4800)})`, table(['Area', { t: 'Budget', r: 1 }, { t: 'Actual', r: 1 }, ''], Object.entries(bud).map(([k, b]) => { const a = byArea[k] || 0; return `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td class="r">${b}</td><td class="r ${a > b ? 'warn b' : ''}">${a.toFixed(1)}</td><td><div class="bar sm"><i style="width:${Math.min(100, a / b * 100)}%" class="${a > b ? 'over' : ''}"></i></div></td></tr>`; })) + `<h4>By person</h4><ul>${Object.entries(byPerson).map(([p, h]) => `<li>${esc(M.userName(ctx.idx, p))}: ${h.toFixed(1)} h</li>`).join('') || '<li class="muted">No time logged</li>'}</ul>`, { actions: M.can(ctx.user, 'time') ? btn('Log time', 'logTime', {}, 'sm') : '' }) +
      section('Entries', ctx.state.time.length ? table(['When', 'Who', 'Area', { t: 'Hours', r: 1 }, 'What'], ctx.state.time.slice().reverse().map(t => `<tr><td>${fmtDate(t.at, true)}</td><td>${esc(M.userName(ctx.idx, t.by))}</td><td>${esc(t.area)}</td><td class="r">${t.hours}</td><td>${esc(t.note || '')}</td></tr>`)) : '<p class="muted">None.</p>');
  } else if (tab === 'status') {
    const st = filingStatus(ctx);
    body = section('Engagements', table(['Client', 'Return', 'Status', 'Open findings', 'Review notes', 'Due', 'Preparer / reviewer / partner'], [`<tr><td><a href="#/">Okafor-Lindqvist (${esc(ctx.idx.clientId)})</a></td><td>2025 1040 + 540NR</td><td>${pill(st.label)}</td><td>${M.openFindings(ctx).length}</td><td>${[...ctx.state.notes.values()].filter(n => n.kind === 'review' && n.status === 'open').length}</td><td>10/15/2026 (extended)</td><td>${['preparer', 'reviewer', 'partner'].map(r => esc(M.userName(ctx.idx, ctx.idx.packet.firm.assignment_at_start[r]))).join(' / ')}</td></tr>`]) + '<p class="sm muted">One engagement in this packet; the same row model scales to the firm’s book. Press / to search everything in the engagement.</p>');
  } else if (tab === 'data') {
    body = section('Data', `<p>Everything people do is an append-only journal (${ctx.journal.events.length} events) stored in this browser, synced live across open tabs. The packet file is never modified.</p>
      <div class="actions">${btn('Load demo history', 'seed', {}, 'primary')}${btn('Export journal', 'exportJournal', {}, 'ghost')}<label class="btn ghost">Import journal<input type="file" hidden data-a="importJournal" accept=".json"></label>${btn('Reset journal', 'resetJournal', {}, 'ghost warn')}</div>
      <p class="sm">Retention: records kept 7 years after filing (firm rule) — destruction date for this engagement: ${ctx.state.filing.frozen ? fmtDate(new Date(new Date(ctx.state.filing.frozen.at).setFullYear(new Date(ctx.state.filing.frozen.at).getFullYear() + 7)).toISOString()) : '7 years after filing'}.</p>`);
  }
  return `<div class="hero"><div><h1>Firm</h1><p class="sub">${esc(ctx.idx.packet.firm.name)} · EIN ${esc(ctx.idx.packet.firm.firm_identity.ein)} · ${esc(ctx.idx.packet.firm.firm_identity.address)}</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/firm?t=${k}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}</div>${body}`;
}
