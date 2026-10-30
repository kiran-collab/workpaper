import * as M from '../model.js';
import { esc, fmt, fmtDelta, fmtDate, num, section, sev, btn, who, avatar, areaLink, refChip, table, pill } from '../ui.js';
import { describe, areaDot } from '../app.js';

const FED = [['AGI', 'F1040.11', 'agi', 'F1040.11'], ['Taxable income', 'F1040.15', 'taxable_income', 'F1040.15'], ['Total tax', 'F1040.24', 'total_tax', 'F1040.24'], ['Payments', 'F1040.33', 'payments', 'F1040.33'], ['Balance due / (refund)', 'F1040.37', 'balance_due', 'F1040.34']];
const CA = [['Total AGI (CA law)', 'F540NR.17', 'total_agi', 'CA540.17'], ['California AGI', 'F540NR.32', 'ca_agi', 'CA540.17'], ['Total tax', 'F540NR.64', 'total_tax', 'CA540.64'], ['Payments', 'F540NR.78', 'payments', null], ['Balance due / (refund)', 'F540NR.97', 'balance_due', 'CA540.111']];

export function summaryTable(ctx, { compact = false } = {}) {
  const py = ctx.idx.packet.prior_years.return_2024.lines;
  const adj = ctx.adjusted;
  const row = (label, key, sk, pyk, jur) => {
    const eng = ctx.v.summary[jur === 'fed' ? 'federal' : 'california'][sk];
    const a = adj[jur][sk];
    let prior = pyk ? py[pyk] : null;
    if (pyk === 'F1040.34') prior = -py['F1040.34'];
    if (pyk === 'CA540.111' && prior != null) prior = py['CA540.111'];
    if (jur === 'ca' && sk === 'payments') prior = py['CA540.71'] + py['CA540.72'];
    const showEng = sk === 'balance_due' ? fmt(eng) : num(ctx, key);
    const varFlag = prior != null && Math.abs(a - prior) > ctx.std.variance_amt && Math.abs((a - prior) / (prior || 1)) * 100 > ctx.std.variance_pct;
    return `<tr><td>${label}</td><td class="r muted">${prior != null ? fmt(prior) : '—'}</td><td class="r">${showEng}</td><td class="r ${a !== eng ? 'b' : ''}">${fmt(a)}</td><td class="r">${fmtDelta(a - eng)}</td>${compact ? '' : `<td class="r">${prior != null ? fmtDelta(a - prior) + (varFlag ? ' <span class="flag" title="Variance over firm threshold">▲</span>' : '') : ''}</td>`}</tr>`;
  };
  const head = `<thead><tr><th></th><th class="r">2024 filed</th><th class="r">Engine ${ctx.vid}</th><th class="r">Workpaper</th><th class="r">Our changes</th>${compact ? '' : '<th class="r">vs 2024</th>'}</tr></thead>`;
  return `<table class="t sum">${head}<tbody><tr class="grp"><td colspan="6">Federal</td></tr>${FED.map(r => row(...r, 'fed')).join('')}
    <tr class="grp"><td colspan="6">California 540NR (part-year)</td></tr>${CA.map(r => row(...r, 'ca')).join('')}</tbody></table>
    <p class="muted sm">Workpaper = engine ${ctx.vid} + ${adj.count} proposed/approved adjustments × this version’s per-dollar rates (penalty ${fmt(ctx.v.summary.federal.penalty)} shown separately). The real system recomputes.</p>`;
}

export function viewOverview(ctx) {
  const st = M.steps(ctx);
  const done = st.filter(s => s.ok).length;
  const bl = M.blockers(ctx);
  const top = M.openFindings(ctx).map(f => ({ f, e: (f.adjustments || []).reduce((s, a) => { const e = M.effectOf(a.effects, ctx.rates); return s + Math.abs(e.fed) + Math.abs(e.ca) + Math.abs(e.fedPay) + Math.abs(e.caPay); }, 0) })).sort((a, b) => b.e - a.e).slice(0, 8);
  const seen = JSON.parse(localStorage.getItem(`wp:seen:${ctx.user.id}`) || 'null');
  const since = seen ? ctx.journal.events.filter(e => e.seq > seen.seq && e.actor !== ctx.user.id && e.type !== 'view.sensitive') : [];
  const dl = ctx.idx.packet.firm.deadlines.map(d => ({ ...d, days: Math.round((new Date(d.date + 'T23:59:00Z') - new Date(ctx.clock)) / 864e5) }));
  const greeting = `<div class="hero"><div><h1>2025 return — Ngozi Okafor & Erik Lindqvist</h1><p class="sub">Married filing jointly · moved Sacramento → Austin on 07/15/2025 · new client (2024 prepared by Delta River)</p></div>
    <div class="hero-a">${btn('Undo <kbd>⌘Z</kbd>', 'undo', {}, 'ghost')}</div></div>`;
  const changes = seen ? (since.length || seen.version !== ctx.vid
    ? `<ul class="feed">${seen.version !== ctx.vid ? `<li><b>Return recomputed</b> ${seen.version} → ${ctx.vid}: ${ctx.v.changes_from_previous.length} line changes. <a href="#/versions?a=${seen.version}&b=${ctx.vid}">Compare</a></li>` : ''}${since.slice(-12).reverse().map(e => `<li>${avatar(ctx, e.actor)} ${who(ctx, e.actor)} ${esc(describe(e))} <small>${fmtDate(e.at, true)}</small></li>`).join('')}</ul>`
    : '<p class="muted">Nothing new since you last looked.</p>')
    : `<p class="muted">First visit. Mark as seen to track what colleagues change from now on.</p>`;
  return `${greeting}
  <div class="cols">
    <div class="col2">
      ${section('Return summary', summaryTable(ctx), { sub: 'Click any figure to see its source and how it was built.' })}
      ${section('Biggest open findings', top.length ? `<ul class="flist">${top.map(({ f, e }) => `<li>${sev(f.severity)} <a href="#/findings?f=${f.id}" title="${esc(M.AREA[f.area]?.name || '')}">${esc(f.title)}</a>${e ? `<span class="swing">±${fmt(e)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No open findings.</p>', { actions: `<a class="btn ghost" href="#/findings">All findings</a>` })}
      ${section('Areas', `<div class="areas">${M.AREAS.filter(a => M.areaLines(ctx, a.id).length).map(a => areaCard(ctx, a)).join('')}</div>`)}
    </div>
    <div class="col1">
      ${section(`Ready to file · ${done} of ${st.length}`, `<div class="bar"><i style="width:${done / st.length * 100}%"></i></div><ul class="steps">${st.filter(s => !s.ok).map(s => `<li><span class="ck">○</span><a href="#/filing">${esc(s.name)}</a></li>`).join('')}</ul>${done ? `<p class="steps-done">✓ ${done} step${done > 1 ? 's' : ''} complete</p>` : ''}`, { actions: `<a class="btn ghost" href="#/filing">Filing</a>` })}
      ${section('Since you last looked', changes, { actions: btn('Mark as seen', 'markSeen', {}, 'ghost sm') })}
      ${section('Deadlines', `<ul class="dl">${dl.map(d => `<li class="${d.days < 0 ? 'past' : d.days < 14 ? 'soon' : ''}"><b>${fmtDate(d.date)}</b> ${esc(d.what)} <span class="r">${d.days < 0 ? Math.abs(d.days) + 'd ago' : 'in ' + d.days + 'd'}</span></li>`).join('')}</ul>`)}
    </div>
  </div>`;
}

function areaCard(ctx, a) {
  const f = M.openFindings(ctx).filter(x => x.area === a.id);
  const lv = (l) => { const s = M.signoffStatus(ctx, a.id, l); return `<span class="so so-${s.state}" title="${l}: ${s.state}${s.why ? ' — ' + s.why : ''}">${l[0].toUpperCase()}</span>`; };
  const hrs = ctx.state.time.filter(t => t.area === a.budget).reduce((s, t) => s + t.hours, 0);
  const bud = a.budget ? ctx.idx.packet.firm.budget_hours[a.budget] : null;
  return `<a class="area" href="#/area/${a.id}"><i class="dot ${areaDot(ctx, a.id)}"></i><b>${esc(a.name)}</b>
    <span class="meta">${f.length ? `${f.length} open` : 'Clear'} · ${M.areaLines(ctx, a.id).length} lines</span>
    <span class="sos">${lv('preparer')}${lv('reviewer')}</span>${bud ? `<span class="hrs ${hrs > bud ? 'over' : ''}">${hrs.toFixed(1)}/${bud}h</span>` : ''}</a>`;
}

export function viewActivity(ctx) {
  const undone = ctx.journal.undoneIds();
  const evs = ctx.journal.events.slice().reverse();
  const rows = evs.map(e => `<tr class="${undone.has(e.id) ? 'undone' : ''}"><td>${e.seq}</td><td>${fmtDate(e.at, true)}</td><td class="muted">${e.clock ? fmtDate(e.clock) : ''}</td><td>${who(ctx, e.actor)}</td><td>${esc(describe(e))}${undone.has(e.id) ? ' <span class="pill">undone</span>' : ''}${e.batch ? ' <span class="pill">batch</span>' : ''}</td><td>${e.actor === ctx.user.id && !undone.has(e.id) && e.type !== 'undo' ? btn('Undo', 'undoBatch', { ids: e.batch ? ctx.journal.events.filter(x => x.batch === e.batch).map(x => x.id).join(',') : e.id }, 'ghost sm') : ''}</td></tr>`);
  return `<div class="hero"><div><h1>Activity log</h1><p class="sub">Append-only. Nothing is edited or deleted: undo is a new event that reverses earlier ones. ${ctx.journal.events.length} events ${ctx.journal.remote ? "stored on the shared server and streamed live to everyone" : "stored in this browser and synced live to other open tabs"}.</p></div>
  <div class="hero-a">${btn('Export journal', 'exportJournal', {}, 'ghost')}<label class="btn ghost">Import<input type="file" hidden data-a="importJournal" accept=".json"></label></div></div>
  ${section('Events', evs.length ? table(['#', 'When', 'Season clock', 'Who', 'What', ''], rows) : '<p class="muted">No actions yet. Load the demo history from Firm → Data, or start working.</p>')}`;
}
