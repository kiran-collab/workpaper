// App shell: boot, routing, per-tab identity (role switcher) and season clock, one delegated
// event handler for every action, modal dialogs, live sync and presence.

import { loadPacket, loadFindings, buildIndex, PACKET_URL } from './data.js';
import { Journal, RemoteJournal, rid, putFile, getFile } from './journal.js';
import * as M from './model.js';
import { esc, attr, fmt, avatar, fmtDate } from './ui.js';
import { viewOverview, viewActivity } from './views/overview.js';
import { inspector, viewTrace, viewDocs, viewDoc } from './views/trace.js';
import { viewFindings, viewAdjustments, viewVersions, viewArea } from './views/findings.js';
import { viewSchedule, SCHEDULES } from './views/schedules.js';
import { viewPeople, viewJudgment } from './views/people.js';
import { viewFiling, viewNotice, viewNextYear, viewClientCopy } from './views/filing.js';
import { viewFirm } from './views/firm.js';
import { viewClient, viewExaminer } from './views/client.js';
import { viewAgents } from './views/agents.js';
import { seedDemo } from './seed.js';

function ss(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
const S = {
  userId: ss('wp:user') || 'st-01',
  clock: ss('wp:clock') || '2026-06-23T12:00:00Z',
  inspect: null, revealed: new Set(), selected: new Set(), modal: null, presence: new Map(), toast: null, navOpen: {},
};
let idx, journal, ctx;
const handlers = {};

// ------------------------------------------------------------------ boot
async function boot() {
  if (window.top !== window) document.documentElement.classList.add('inframe');
  const root = document.getElementById('app');
  root.innerHTML = '<div class="boot">Loading packet…</div>';
  try {
    const url = new URLSearchParams(location.search).get('packet') || PACKET_URL;
    const packet = await loadPacket(url);
    idx = buildIndex(packet);
    idx.season = await loadFindings(packet);
  } catch (e) {
    root.innerHTML = `<div class="boot err"><h2>Could not load the packet</h2><p>${esc(e.message)}</p><p>Serve this folder over HTTP (e.g. <code>python3 -m http.server</code>) or choose the packet file:</p><input type="file" id="pk" accept=".json"></div>`;
    document.getElementById('pk').onchange = async (ev) => {
      const packet = JSON.parse(await ev.target.files[0].text());
      idx = buildIndex(packet);
      try { idx.season = await loadFindings(packet); } catch { idx.season = { points: [{ from: '', set: 0 }], sets: [[]] }; } // no findings without findings.json
      start();
    };
    return;
  }
  // Served by server/app.py: use the shared server journal. Static hosting: this browser's journal.
  if (await RemoteJournal.available(idx.clientId)) {
    try { journal = await new RemoteJournal(idx.clientId).init(); } catch (e) { console.error('Server journal unavailable', e); }
  }
  start();
}
function start() {
  journal ||= new Journal(idx.clientId);
  journal.user = S.userId;
  journal.subscribe((info) => {
    if (info.rejected) { showToast('⛔ Server refused: ' + info.rejected); render(); return; }
    if (info.presence) { S.presence.set(info.presence.user, info.presence); renderTop(); return; }
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && document.activeElement.closest('#main');
    if (info.remote && typing) { refreshCtx(); renderTop(); showToast('New changes from a colleague — they will appear when you finish typing'); return; }
    if (info.events?.some(e => e.type === 'ai.run')) refreshAgentStatus();
    if (info.remote && info.events?.length && info.events[0].type !== 'ai.step') showToast(`${M.userName(idx, info.events[0].actor)}: ${describe(info.events[0])}`);
    render();
  });
  if (!idx.staff.has(S.userId) && !idx.clientUsers.has(S.userId) && S.userId !== M.EXAMINER.id) S.userId = 'st-01';
  window.addEventListener('hashchange', () => { S.selected.clear(); render(); document.getElementById('main')?.scrollTo(0, 0); });
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', (e) => { for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false; }, true);
  document.addEventListener('toggle', (e) => { const g = e.target.dataset?.g; if (g) S.navOpen[g] = e.target.open; }, true);
  setInterval(() => journal.presence({ user: S.userId, route: location.hash || '#/', at: Date.now() }), 4000);
  if (journal.remote) refreshAgentStatus();
  if (!location.hash) location.hash = defaultRoute();
  window.__wp = { A, S, journal, get ctx() { return ctx; }, render }; // test hook
  render();
}
// Whether the server can run the AI agents (credentials present, a run in progress).
function refreshAgentStatus() {
  fetch('api/agents/status', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(st => { S.agentStatus = st; if ((location.hash || '').startsWith('#/agents')) render(); }).catch(() => {});
}
function defaultRoute() {
  const u = M.userById(idx, S.userId);
  if (u?.role === 'client') return '#/client';
  if (u?.role === 'examiner') return '#/examiner';
  if (u?.role === 'firm_administrator') return '#/firm';
  return '#/';
}

function refreshCtx() {
  ctx = M.buildContext(idx, journal, S.clock, S.userId);
  ctx.revealed = S.revealed; ctx.S = S;
  return ctx;
}

// ------------------------------------------------------------------ render
function render() {
  refreshCtx();
  const root = document.getElementById('app');
  if (!root.querySelector('.shell')) root.innerHTML = shellHTML();
  renderTop(); renderNav();
  const main = document.getElementById('main');
  const scroll = main.scrollTop;
  let html;
  try { html = route(); } catch (e) { console.error(e); html = `<div class="card err"><h3>Something went wrong rendering this view</h3><pre>${esc(e.stack || e)}</pre></div>`; }
  main.innerHTML = html;
  main.scrollTop = scroll;
  const focus = new URLSearchParams((location.hash.split('?')[1]) || '').get('f');
  if (focus) document.getElementById('f-' + focus)?.scrollIntoView({ block: 'center' });
  renderInspector();
  renderModal();
}
function shellHTML() {
  return `<div class="shell">
    <header id="top" class="top"></header>
    <nav id="nav" class="nav"></nav>
    <main id="main" class="main" tabindex="-1"></main>
    <aside id="insp" class="insp" aria-label="Trace inspector"></aside>
    <dialog id="dlg" class="dlg"></dialog>
    <div id="toast" class="toast" role="status"></div>
  </div>`;
}

function route() {
  const h = (location.hash || '#/').slice(1);
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(query || '');
  const role = ctx.user.role;
  if (role === 'client' && parts[0] !== 'client' && parts[0] !== 'copy') return viewClient(ctx);
  if (role === 'examiner') return viewExaminer(ctx);
  switch (parts[0]) {
    case undefined: return viewOverview(ctx);
    case 'area': return viewArea(ctx, parts[1]);
    case 'findings': return viewFindings(ctx, q);
    case 'adjustments': return viewAdjustments(ctx);
    case 'docs': return parts[1] ? viewDoc(ctx, parts[1], +(parts[2] || 0), q.get('ev')) : viewDocs(ctx, q);
    case 'trace': return viewTrace(ctx, decodeURIComponent(parts.slice(1).join('/')));
    case 'schedule': return viewSchedule(ctx, parts[1], q);
    case 'versions': return viewVersions(ctx, q);
    case 'people': return viewPeople(ctx, q);
    case 'judgment': return viewJudgment(ctx);
    case 'filing': return viewFiling(ctx);
    case 'notice': return viewNotice(ctx);
    case 'nextyear': return viewNextYear(ctx);
    case 'copy': return viewClientCopy(ctx);
    case 'firm': return viewFirm(ctx, q);
    case 'activity': return viewActivity(ctx);
    case 'agents': return viewAgents(ctx);
    case 'client': return viewClient(ctx);
    case 'examiner': return viewExaminer(ctx);
    default: return `<div class="card"><h3>Not found</h3></div>`;
  }
}

function renderTop() {
  const el = document.getElementById('top'); if (!el || !ctx) return;
  const u = ctx.user;
  const opts = M.users(idx).filter(x => x.role !== 'ai_agent').map(x => `<option value="${x.id}" ${x.id === S.userId ? 'selected' : ''}>${esc(x.name)} — ${esc(roleLabel(x))}</option>`).join('');
  const evs = M.clockEvents(idx);
  const cur = evs.filter(e => e.at <= S.clock).at(-1);
  const status = filingStatus(ctx);
  const others = [...S.presence.values()].filter(p => p.user !== S.userId && Date.now() - p.at < 12000);
  const notes = notifications(ctx).length;
  el.innerHTML = `
    <a class="brand" href="#/" title="Overview"><span class="logo">M</span><span><b>Okafor-Lindqvist</b><small>2025 · MFJ · ${esc(idx.clientId)}${journal.remote ? ' · shared server' : ''}</small></span></a>
    <span class="status st-${status.code}" title="Return status">${esc(status.label)}</span>
    <div class="clock" title="Season clock: replay the timeline. Documents, versions and agency records appear as of this moment.">
      <button class="icon" data-a="clockPrev" aria-label="Previous event">◀</button>
      <label><span>Season clock</span>
        <select data-a="clockSet">${evs.map(e => `<option value="${e.at}" ${cur && e.at === cur.at && e.id === cur.id ? 'selected' : ''}>${fmtDate(e.at)} · ${esc(e.label)}${e.t?.refs?.[0] && /^v\d/.test(e.t.refs[0]) ? ' ' + e.t.refs[0] : ''}</option>`).join('')}</select>
      </label>
      <button class="icon" data-a="clockNext" aria-label="Next event">▶</button>
      <span class="vtag" title="Active engine version">${ctx.vid}</span>
    </div>
    <button class="search" data-a="openSearch"><span>Search lines, documents…</span><kbd>/</kbd></button>
    <div class="presence">${others.map(p => avatar(ctx, p.user)).join('')}</div>
    <button class="bell" data-a="openNotifications" title="Notifications" aria-label="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>${notes ? `<b>${notes}</b>` : ''}</button>
    <label class="who-sel" title="Role switcher — each browser tab can be a different person">${avatar(ctx, S.userId)}<select data-a="setUser">${opts}</select></label>`;
}
function roleLabel(u) {
  if (u.role === 'preparer' && u.sensitive_data_clearance === false) return 'preparer (no clearance)';
  return u.role.replace('_', ' ');
}

function renderNav() {
  const el = document.getElementById('nav'); if (!el) return;
  const role = ctx.user.role;
  const h = location.hash || '#/';
  const of = M.openFindings(ctx).length;
  const pend = [...ctx.state.adjustments.values()].filter(a => a.status === 'proposed').length;
  const openNotes = [...ctx.state.notes.values()].filter(n => n.status === 'open').length;
  const link = (href, label, badge) => `<a href="${href}" class="${h === href || (href !== '#/' && h.startsWith(href)) ? 'on' : ''}">${label}${badge ? `<b>${badge}</b>` : ''}</a>`;
  // Collapsible sidebar groups: open when they hold the current page, otherwise as the person left them.
  const group = (id, title, active, dflt, body) => `<details class="ng" data-g="${id}" ${active || (S.navOpen[id] ?? dflt) ? 'open' : ''}><summary>${title}</summary>${body}</details>`;
  if (role === 'client') { el.innerHTML = `<div class="ng">${link('#/client', 'Your return')}${link('#/copy', 'Client copy')}</div>`; return; }
  if (role === 'examiner') { el.innerHTML = `<div class="ng">${link('#/examiner', 'Examination record')}</div>`; return; }
  el.innerHTML = `
    <div class="ng">${link('#/', 'Overview')}${link('#/findings', 'Findings', of)}${link('#/adjustments', 'Adjustments', pend)}${link('#/people', 'Notes & questions', openNotes)}${link('#/filing', 'Filing')}${link('#/agents', 'AI agents', [...ctx.state.ai.findings.values()].filter(f => M.findingState(ctx, ctx.findings.find(x => x.id === f.id) || {}) === 'open').length)}</div>
    ${group('areas', 'Areas', h.startsWith('#/area/'), true, `${M.AREAS.filter(a => M.areaLines(ctx, a.id).length || a.docs.length).map(a => {
      const st = areaDot(ctx, a.id);
      return `<a href="#/area/${a.id}" class="${h === '#/area/' + a.id ? 'on' : ''}"><i class="dot ${st}"></i>${esc(a.name)}</a>`;
    }).join('')}`)}
    ${group('records', 'Records', /^#\/(docs|schedule|versions|judgment)/.test(h), false, `${link('#/docs', 'Document index')}${SCHEDULES.map(s => link('#/schedule/' + s.id, s.name)).join('')}${link('#/versions', 'Versions & what-ifs')}${link('#/judgment', 'Judgment & completeness')}`)}
    ${group('after', 'After filing', /^#\/(notice|nextyear|copy)/.test(h), false, `${link('#/notice', 'Notice response')}${link('#/nextyear', 'Next year')}${link('#/copy', 'Client copy')}`)}
    <div class="ng">${link('#/activity', 'Activity log')}${role === 'firm_administrator' || role === 'partner' ? link('#/firm', 'Firm') : link('#/firm', 'Firm & time')}</div>`;
}
export function areaDot(ctx, id) {
  const f = M.openFindings(ctx).filter(x => x.area === id);
  const rv = M.signoffStatus(ctx, id, 'reviewer'), pr = M.signoffStatus(ctx, id, 'preparer');
  if (rv.state === 'stale' || pr.state === 'stale') return 'stale';
  if (f.some(x => x.severity === 'high')) return 'red';
  if (f.length) return 'amber';
  if (rv.state === 'fresh') return 'green';
  if (pr.state === 'fresh') return 'blue';
  return 'grey';
}
export function filingStatus(ctx) {
  const f = ctx.state.filing;
  const acc = f.submissions.filter(s => s.result === 'accepted');
  if (f.amendments.length && !f.amendments.at(-1).filed) return { code: 'amend', label: 'Amending (1040-X)' };
  if (acc.length >= 2) return { code: 'filed', label: 'Filed · accepted · frozen' };
  if (acc.length) return { code: 'filed', label: 'Federal accepted' };
  if (f.submissions.at(-1)?.result === 'rejected') return { code: 'rejected', label: 'E-file rejected' };
  if (f.signed) return { code: 'ready', label: 'Authorized — ready to file' };
  if (f.presented) return { code: 'client', label: 'With client for approval' };
  if (M.signoffStatus(ctx, 'return', 'partner').state === 'fresh') return { code: 'partner', label: 'Partner approved' };
  if (ctx.state.signoffs.some(s => s.level === 'reviewer')) return { code: 'review', label: 'In review' };
  return { code: 'prep', label: ctx.clock < '2026-04-15' ? 'Preparing' : 'Preparing · on extension' };
}

function renderInspector() {
  const el = document.getElementById('insp');
  if (!S.inspect) { el.classList.remove('open'); el.innerHTML = ''; return; }
  el.classList.add('open');
  try { el.innerHTML = inspector(ctx, S.inspect); } catch (e) { el.innerHTML = `<pre>${esc(e.stack)}</pre>`; }
}

// ------------------------------------------------------------------ notifications
export function notifications(ctx) {
  const me = S.userId; const out = [];
  const myName = M.userName(idx, me).split(' ')[0].toLowerCase();
  for (const n of ctx.state.notes.values()) {
    if (n.status !== 'open') continue;
    if (n.to === me) out.push({ text: `${M.userName(idx, n.by)} → you: ${n.text}`, to: '#/people', at: n.at });
    else if (n.text?.toLowerCase().includes('@' + myName)) out.push({ text: `Mentioned by ${M.userName(idx, n.by)}: ${n.text}`, to: '#/people', at: n.at });
    else if (n.kind === 'question' && n.to === 'client' && n.replies.some(r => idx.clientUsers.has(r.by)) && n.by === me) out.push({ text: `Client answered: ${n.text}`, to: '#/people', at: n.replies.at(-1).at });
    else if (n.kind === 'review' && ctx.user.role === 'preparer' && n.area && M.assigned(ctx, n.area, 'preparer') === me) out.push({ text: `Review note on ${M.AREA[n.area]?.name}: ${n.text}`, to: '#/people', at: n.at });
  }
  if (M.can(ctx.user, 'approve:large')) for (const a of ctx.state.adjustments.values()) if (a.status === 'proposed' && a.requiresPartner) out.push({ text: `Adjustment needs partner approval: ${a.line} (${a.reason})`, to: '#/adjustments', at: a.at });
  if (ctx.user.role === 'reviewer') for (const a of ctx.state.adjustments.values()) if (a.status === 'proposed' && !a.requiresPartner) out.push({ text: `Adjustment to review: ${a.line}`, to: '#/adjustments', at: a.at });
  for (const a of M.AREAS) for (const lvl of ['preparer', 'reviewer', 'partner']) {
    const st = M.signoffStatus(ctx, a.id, lvl);
    if (st.state === 'stale' && st.so.by === me) out.push({ text: `Your ${lvl} sign-off on ${a.name} reopened: ${st.why}`, to: '#/area/' + a.id, at: st.so.at });
  }
  for (const t of ctx.state.tasks.values()) if (t.status === 'open' && t.assignee === me) out.push({ text: `Task: ${t.title}${t.due ? ' (due ' + t.due + ')' : ''}`, to: '#/people', at: t.at });
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

// ------------------------------------------------------------------ journal helpers
function act(type, payload, extra = {}) {
  return journal.append({ type, payload }, { actor: S.userId, clock: S.clock, ...extra });
}
function actMany(list) { return journal.append(list, { actor: S.userId, clock: S.clock }); }
function describe(e) {
  const p = e.payload;
  return ({
    'verify': `verified ${p.target}`, 'adjust.propose': `proposed adjustment on ${p.line}`, 'adjust.approve': 'approved an adjustment', 'adjust.reject': 'rejected an adjustment',
    'note.create': `${p.kind === 'review' ? 'review note' : p.kind === 'question' ? 'question' : 'note'}: ${p.text?.slice(0, 60)}`, 'note.reply': 'replied', 'note.resolve': 'resolved a note', 'signoff': `signed off ${p.scope} as ${p.level}`,
    'finding.status': `marked finding ${p.status}`, 'doc.disposition': `dispositioned ${p.doc}`, 'evidence.attach': `attached ${p.name}`, 'time.log': `logged ${p.hours}h`, 'undo': 'undid an action',
    'filing.submit': `e-file ${p.jurisdiction}: ${p.result}`,
    'ai.run': `AI preparer run ${p.status}`, 'ai.step': `${p.tool}`, 'ai.finding': `proposed a finding: ${p.title}`, 'ai.review': `reviewed a finding: ${p.verdict}`, 'filing.sign8879': 'signed Form 8879', 'filing.client_approve': 'approved the return', 'household.fix': `corrected ${p.person} ${p.field}`,
  })[e.type] || e.type;
}
export { describe };
function showToast(text) {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = text; t.classList.add('on');
  clearTimeout(S.toast); S.toast = setTimeout(() => t.classList.remove('on'), 3800);
}
function deny(msg) { showToast('⛔ ' + msg); return false; }
function need(perm, msg) { if (!M.can(ctx.user, perm)) return deny(msg || `Your role (${ctx.user.role}) cannot do this`); if (ctx.state.filing.frozen && !ctx.amendment && ['adjust', 'verify', 'fix'].includes(perm)) return deny('Return is frozen at filing. Start an amendment to change it.'); return true; }

// ------------------------------------------------------------------ modal
function modal(title, body, onSubmit, { submit = 'Save', wide = false } = {}) {
  S.modal = { title, body, submit, wide };
  handlers.modal = onSubmit;
  renderModal();
}
function renderModal() {
  const d = document.getElementById('dlg');
  if (!S.modal) { if (d.open) d.close(); return; }
  d.className = 'dlg' + (S.modal.wide ? ' wide' : '');
  d.innerHTML = `<form data-form="modal" method="dialog"><header><h3>${S.modal.title}</h3><button type="button" class="icon" data-a="closeModal" aria-label="Close">✕</button></header><div class="dlg-b">${S.modal.body}</div>${S.modal.submit ? `<footer><button type="button" class="btn ghost" data-a="closeModal">Cancel</button><button class="btn primary" type="submit">${S.modal.submit}</button></footer>` : ''}</form>`;
  if (!d.open) d.showModal();
  d.querySelector('input:not([type=hidden]),textarea,select')?.focus();
}
function closeModal() { S.modal = null; handlers.modal = null; renderModal(); }

// ------------------------------------------------------------------ event handling
function onKey(e) {
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); A.openSearch(); }
  if (e.key === 'Escape' && S.inspect && !S.modal) { S.inspect = null; renderInspector(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); A.undo(); }
}
function onClick(e) {
  const el = e.target.closest('[data-a]');
  if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'button' && el.type !== 'checkbox')) return;
  if (el.type === 'checkbox' && el.dataset.a !== 'toggleSel' && el.dataset.a !== 'dd') return;
  const fn = A[el.dataset.a];
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset, el);
}
function onChange(e) {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  if (el.tagName === 'SELECT' || el.type === 'file' || el.type === 'checkbox') {
    const fn = A[el.dataset.a];
    if (fn && (el.tagName === 'SELECT' || el.type === 'file')) fn(el.dataset, el);
  }
}
function onSubmit(e) {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f).entries());
  data._files = f.querySelector('input[type=file]')?.files;
  if (f.dataset.form === 'modal') { const h = handlers.modal; const keep = h?.(data); if (keep !== true) closeModal(); return; }
  const fn = A['form_' + f.dataset.form];
  fn?.(data, f);
}

const methodOptions = () => ctx.std.verification_types.map(m => `<option value="${m}">${esc(m.replace(/_/g, ' '))}</option>`).join('');
const opt = (list, sel) => list.map(([v, l]) => `<option value="${attr(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

// All actions. Each checks permissions (roles are enforced here, not just hidden in the UI).
const A = {
  inspect(d) { S.inspect = d.ref; renderInspector(); },
  closeInspect() { S.inspect = null; renderInspector(); },
  go(d) { location.hash = d.to; },
  closeModal,
  setUser(d, el) { S.userId = el.value; journal.user = S.userId; safeSet('wp:user', S.userId); S.revealed.clear(); S.inspect = null; location.hash = defaultRoute(); render(); },
  clockSet(d, el) { S.clock = el.value; safeSet('wp:clock', S.clock); render(); },
  clockPrev() { const evs = M.clockEvents(idx); const i = evs.findLastIndex(e => e.at < S.clock); if (i >= 0) { S.clock = evs[i].at; safeSet('wp:clock', S.clock); render(); } },
  clockNext() { const evs = M.clockEvents(idx); const n = evs.find(e => e.at > S.clock); if (n) { S.clock = n.at; safeSet('wp:clock', S.clock); render(); showToast(`${fmtDate(n.at, true)} — ${n.label}`); } },
  reveal(d) {
    if (!M.cleared(ctx.user)) return deny('No sensitive-data clearance');
    S.revealed.add(d.key); act('view.sensitive', { field: d.key.split('|')[1], ref: d.ref }); showToast('Unmasked view logged');
  },
  openSearch() {
    modal('Search the workpaper', `<input class="in big" name="q" id="sq" placeholder="Line key, label, document, finding, note, amount…" autocomplete="off"><div id="sres" class="sres"></div>`, null, { submit: '', wide: true });
    const inp = document.getElementById('sq');
    inp.oninput = () => {
      const r = M.search(ctx, inp.value);
      document.getElementById('sres').innerHTML = r.map(x => `<button class="sr" data-a="searchPick" data-kind="${x.kind}" data-key="${attr(x.key)}"><span class="pill">${x.kind}</span> <b>${esc(x.key)}</b> ${esc(x.label?.slice(0, 120))}${x.value != null ? ` <span class="r">${fmt(x.value)}</span>` : ''}</button>`).join('') || '<p class="muted">No matches</p>';
    };
  },
  searchPick(d) {
    closeModal();
    if (d.kind === 'finding') location.hash = '#/findings?f=' + d.key;
    else if (d.kind === 'note') location.hash = '#/people';
    else if (d.kind === 'doc') location.hash = '#/docs/' + d.key;
    else { S.inspect = d.key; render(); }
  },
  openNotifications() {
    const n = notifications(ctx);
    modal('Notifications', n.length ? `<ul class="notifs">${n.map(x => `<li><a href="${x.to}" data-a="go" data-to="${x.to}">${esc(x.text)}</a><small>${fmtDate(x.at, true)}</small></li>`).join('')}</ul>` : '<p class="muted">Nothing needs you right now.</p>', null, { submit: '' });
  },

  // ---- evidence: verification, notes, attachments
  verify(d) {
    if (!need('verify')) return;
    modal(`Record verification — ${esc(d.target)}`, `
      <label>How was it verified?<select name="method" class="in">${methodOptions()}</select></label>
      <label>Note (what you looked at)<textarea name="note" class="in" rows="3" placeholder="e.g. Agreed box 1 to W-2 copy B"></textarea></label>`,
      (f) => { act('verify', { target: d.target, method: f.method, note: f.note, value: d.value }); showToast('Verification recorded'); });
  },
  unverify(d) { if (!need('verify')) return; act('unverify', { target: d.target }); },
  bulkVerify(d) {
    if (!need('verify')) return;
    const targets = [...S.selected];
    if (!targets.length) return deny('Select items first');
    modal(`Verify ${targets.length} items`, `<label>Method<select name="method" class="in">${methodOptions()}</select></label><label>Note<textarea name="note" class="in" rows="2"></textarea></label>`,
      (f) => { actMany(targets.map(t => ({ type: 'verify', payload: { target: t, method: f.method, note: f.note } }))); S.selected.clear(); showToast(`${targets.length} verifications recorded — Undo with ⌘Z`); });
  },
  toggleSel(d, el) { if (el.checked) S.selected.add(d.key); else S.selected.delete(d.key); const c = document.getElementById('selcount'); if (c) c.textContent = S.selected.size; },
  selAll(d) { document.querySelectorAll(`input[data-a=toggleSel][data-group="${d.group}"]`).forEach(i => { i.checked = true; S.selected.add(i.dataset.key); }); const c = document.getElementById('selcount'); if (c) c.textContent = S.selected.size; },
  note(d) {
    const kind = d.kind || 'note';
    if (kind === 'review' && !need('review', 'Only reviewers, partners and quality reviewers write review notes')) return;
    if (kind !== 'review' && !M.isStaff(ctx.user)) return deny('Clients reply to questions from the portal');
    const staff = idx.packet.firm.staff.filter(s => s.id !== S.userId).map(s => [s.id, s.name + ' (' + s.role.replace('_', ' ') + ')']);
    const toSel = kind === 'question' ? `<label>To<select name="to" class="in">${opt([['client', 'Client (Ngozi & Erik)'], ...staff], d.to || 'client')}</select></label>` : kind === 'review' ? `<label>Assign to<select name="to" class="in">${opt(staff, M.assigned(ctx, d.area || M.areaOf(d.ref || ''), 'preparer'))}</select></label>` : '';
    modal({ review: 'Review note', question: 'Question', note: 'Note', variance: 'Explain variance' }[kind] + (d.ref ? ` — ${esc(d.ref)}` : ''), `
      ${toSel}
      <label>${kind === 'question' ? 'Question' : 'Text'}<textarea name="text" class="in" rows="4" required>${esc(d.text || '')}</textarea></label>
      ${kind === 'review' ? `<label class="cb"><input type="checkbox" name="blocking" checked> Blocks filing until resolved</label>` : ''}
      ${kind === 'question' || kind === 'review' ? `<label>Due<input type="date" name="due" class="in" value="${d.due || ''}"></label>` : ''}
      <p class="muted sm">Use @name to notify a colleague. Answers become evidence on ${esc(d.ref || 'the return')}.</p>`,
      (f) => {
        const refs = [d.ref, ...(d.refs ? d.refs.split(',') : [])].filter(Boolean);
        act('note.create', { id: 'n-' + rid(), kind, to: f.to || null, text: f.text, refs, blocking: kind === 'review' ? !!f.blocking : false, area: d.area || (d.ref ? M.areaOf(d.ref) : null), due: f.due || null, findingId: d.finding || null });
        showToast(kind === 'question' ? 'Question sent' : 'Saved');
      });
  },
  reply(d) {
    const n = ctx.state.notes.get(d.id);
    modal('Reply', `<p class="quote">${esc(n.text)}</p><label>Reply<textarea name="text" class="in" rows="4" required></textarea></label><label>Attach a file (optional)<input type="file" name="file" class="in"></label>`,
      (f) => { attachThen(f._files?.[0], 'note:' + d.id, (evId) => act('note.reply', { id: d.id, text: f.text, evidence: evId })); });
  },
  resolveNote(d) {
    const n = ctx.state.notes.get(d.id);
    if (n.kind === 'review' && !M.can(ctx.user, 'review')) return deny('Only a reviewer or partner can clear a review note — reply instead');
    modal('Resolve', `<p class="quote">${esc(n.text)}</p><label>Resolution<textarea name="resolution" class="in" rows="3" required></textarea></label>`, (f) => act('note.resolve', { id: d.id, resolution: f.resolution }));
  },
  reopenNote(d) { act('note.reopen', { id: d.id }); },
  attach(d) {
    if (!M.isStaff(ctx.user) && ctx.user.role !== 'client') return;
    modal(`Attach evidence${d.target ? ' — ' + esc(d.target) : ''}`, `
      <label>File (any type)<input type="file" name="file" class="in"></label>
      <label>Or paste a message / note<textarea name="text" class="in" rows="4" placeholder="e.g. email from client confirming…"></textarea></label>
      <label>Title<input name="name" class="in" placeholder="Short description"></label>`,
      (f) => attachThen(f._files?.[0], d.target || 'return', null, f));
  },
  async openFile(d) {
    const b = await getFile(d.id);
    if (!b) return deny('File not available in this browser');
    const u = URL.createObjectURL(b);
    let body = `<p>${esc(b.type || 'file')} · ${fmt(b.size)} bytes</p>`;
    if (/^image\//.test(b.type)) body += `<div class="fileprev"><img src="${u}" alt=""></div>`;
    else if (/^text\/|json/.test(b.type)) body += `<div class="fileprev"><pre>${esc((await b.text()).slice(0, 20000))}</pre></div>`;
    else if (b.type === 'application/pdf') body += `<div class="fileprev"><object data="${u}" type="application/pdf" width="100%" height="480"></object></div>`;
    modal('Attached file', body, null, { submit: '', wide: true });
  },

  // ---- adjustments
  proposeFinding(d) {
    if (!need('adjust')) return;
    const f = ctx.findings.find(x => x.id === d.id);
    if (!f?.adjustments?.length) return;
    modal(`Propose adjustment — ${esc(f.title)}`, `
      <div class="adjlist">${f.adjustments.map(a => { const e = M.effectOf(a.effects, ctx.rates); return `<div class="adjrow"><b>${esc(a.line)}</b> ${fmt(a.from)} → <b>${fmt(a.to)}</b> <span class="muted">${esc(a.note || '')}</span> <span class="r">fed ${fmt(e.fed, { sign: true })} · CA ${fmt(e.ca, { sign: true })}${e.fedPay || e.caPay ? ` · payments ${fmt(e.fedPay + e.caPay, { sign: true })}` : ''}</span></div>`; }).join('')}</div>
      <label>Reason (kept with the adjustment)<textarea name="reason" class="in" rows="2">${esc(f.title)}</textarea></label>
      <label>Authority relied on<input name="authority" class="in" value="${attr((f.detail || []).find(x => /Authority/.test(x))?.replace(/^.*Authority:\s*/, '') || '')}"></label>`,
      (fm) => {
        const list = f.adjustments.map(a => buildAdj(a, fm.reason, fm.authority, f.id));
        actMany(list.map(p => ({ type: 'adjust.propose', payload: p })));
        showToast(`${list.length} adjustment${list.length > 1 ? 's' : ''} proposed — original values kept`);
      }, { submit: 'Propose' });
  },
  manualAdjust(d) {
    if (!need('adjust')) return;
    const lv = M.lineView(ctx, d.key);
    const cat = M.defaultCategory(d.key);
    const cats = [...Object.keys(ctx.rates), 'payment', 'credit', 'tax'];
    modal(`Adjust ${esc(d.key)}`, `
      <p>${esc(lv.line.label)}</p>
      <div class="grid2"><label>Engine value<input class="in" value="${attr(lv.original)}" disabled></label><label>New value<input name="to" class="in" type="number" step="any" required value="${attr(lv.value)}"></label></div>
      <div class="grid2"><label>Tax effect category<select name="category" class="in">${opt(cats.map(c => [c, c.replace(/_/g, ' ')]), cat.category)}</select></label>
      <label>Direction<select name="sign" class="in">${opt([['1', 'Line up = category up (income, payments)'], ['-1', 'Line up = category down (expense line)']], String(cat.sign))}</select></label></div>
      <label>Jurisdiction<select name="juris" class="in">${opt([['', 'Federal and California'], ['federal', 'Federal only'], ['california', 'California only']], cat.juris || '')}</select></label>
      <label>Reason<textarea name="reason" class="in" rows="2" required></textarea></label>
      <label>Authority<input name="authority" class="in"></label>
      <p class="muted sm">Tax effect = change × this version’s rate (${ctx.vid}). The real system recomputes; large changes can cross thresholds.</p>`,
      (f) => {
        const delta = (+f.to - +lv.original) * +f.sign;
        const effects = [{ category: f.category, amount: delta, ...(f.juris ? { juris: f.juris } : {}) }];
        act('adjust.propose', buildAdj({ line: d.key, from: lv.original, to: +f.to, effects }, f.reason, f.authority, null));
      }, { submit: 'Propose' });
  },
  approveAdj(d) { approveAdjs([d.id]); },
  bulkApprove() {
    const ids = [...S.selected].filter(id => ctx.state.adjustments.get(id)?.status === 'proposed');
    if (!ids.length) return deny('Select proposed adjustments');
    approveAdjs(ids);
    S.selected.clear();
  },
  rejectAdj(d) {
    if (!M.can(ctx.user, 'approve:small')) return deny('Only reviewers and partners reject adjustments');
    modal('Reject adjustment', `<label>Why<textarea name="reason" class="in" rows="3" required></textarea></label>`, (f) => act('adjust.reject', { id: d.id, reason: f.reason }));
  },
  withdrawAdj(d) { const a = ctx.state.adjustments.get(d.id); if (a.by !== S.userId) return deny('Only the person who proposed it can withdraw it'); act('adjust.withdraw', { id: d.id }); },
  undo() {
    const last = journal.lastUndoable(S.userId);
    if (!last) return showToast('Nothing of yours to undo');
    journal.append({ type: 'undo', payload: { ids: last.map(e => e.id) } }, { actor: S.userId, clock: S.clock });
    showToast(`Undid ${last.length > 1 ? last.length + ' actions' : describe(last[0])}`);
  },
  undoBatch(d) { journal.append({ type: 'undo', payload: { ids: d.ids.split(',') } }, { actor: S.userId, clock: S.clock }); },

  // ---- findings
  findingStatus(d) {
    if (!need('finding')) return;
    modal(`${d.status === 'accepted' ? 'Accept as is' : d.status === 'resolved' ? 'Mark resolved' : 'Dismiss'} — ${esc(d.id)}`, `<label>Reason / evidence<textarea name="reason" class="in" rows="3" required></textarea></label>`, (f) => act('finding.status', { id: d.id, status: d.status, reason: f.reason }));
  },
  reopenFinding(d) { act('finding.status', { id: d.id, status: 'open', reason: 'Reopened' }); },
  fixHousehold(d) {
    if (!need('fix')) return;
    const f = ctx.findings.find(x => x.id === d.id);
    const fx = f.fixHousehold;
    act('household.fix', { person: fx.person, field: fx.field, from: idx.people.get(fx.person)[fx.field], to: fx.to, finding: f.id });
    showToast('Dependent SSN corrected on the return (organizer value kept in history)');
  },
  fixText(d) {
    if (!need('fix')) return;
    const f = ctx.findings.find(x => x.id === d.id);
    act('text.fix', { ...f.textFix, finding: f.id });
  },
  askFromFinding(d) {
    const f = ctx.findings.find(x => x.id === d.id);
    A.note({ kind: 'question', ref: f.lines?.[0] || f.evidence?.[0], text: f.question?.text || '', finding: f.id, to: f.question?.to || 'client' });
  },

  // ---- sign-offs
  signoff(d) {
    const lvl = d.level, scope = d.scope;
    if (!M.can(ctx.user, 'signoff:' + lvl)) return deny(`Only a ${lvl} can sign off at this level`);
    if (lvl !== 'preparer' && scope !== 'return' && M.preparedBy(ctx, scope).has(S.userId)) return deny('Firm rule: you may not review or sign off on work you prepared');
    if (lvl === 'partner' && scope === 'return') {
      const rev = M.AREAS.filter(a => M.areaLines(ctx, a.id).length).filter(a => M.signoffStatus(ctx, a.id, 'reviewer').state !== 'fresh');
      if (rev.length) return deny(`Reviewer sign-off missing or reopened: ${rev.map(a => a.name).join(', ')}`);
      const big = [...ctx.state.adjustments.values()].filter(a => a.status === 'proposed');
      if (big.length) return deny(`${big.length} adjustments still awaiting approval`);
    }
    if (lvl === 'reviewer') {
      const open = [...ctx.state.notes.values()].filter(n => n.kind === 'review' && n.status === 'open' && n.area === scope && n.blocking);
      if (open.length) return deny('Open blocking review notes in this area');
    }
    const fp = scope === 'return' ? M.returnFingerprint(ctx) : M.areaFingerprint(ctx, scope);
    act('signoff', { scope, level: lvl, fp, version: ctx.vid });
    showToast('Signed off. It reopens automatically if anything it covers changes.');
  },

  // ---- documents
  disposition(d) {
    if (!need('disposition')) return;
    modal(`Disposition — ${esc(d.doc)}`, `
      <label>Disposition<select name="disposition" class="in">${opt([['Used', 'Used (manually traced)'], ['Reference only', 'Reference only'], ['Not relevant', 'Not relevant to the return'], ['Duplicate', 'Duplicate'], ['Superseded', 'Superseded'], ['Outside scope', 'Outside engagement scope']], 'Reference only')}</select></label>
      <label>Why<textarea name="reason" class="in" rows="3" required></textarea></label>`, (f) => act('doc.disposition', { doc: d.doc, disposition: f.disposition, reason: f.reason }));
  },

  // ---- people
  task(d) {
    if (!need('task')) return;
    const staff = idx.packet.firm.staff.map(s => [s.id, s.name]);
    modal('New task', `<label>Task<input name="title" class="in" required value="${attr(d.title || '')}"></label><div class="grid2"><label>Assignee<select name="assignee" class="in">${opt(staff, d.assignee || 'st-01')}</select></label><label>Due<input type="date" name="due" class="in" value="${attr(d.due || '')}"></label></div>`,
      (f) => act('task.create', { id: 't-' + rid(), title: f.title, assignee: f.assignee, due: f.due, refs: d.ref ? [d.ref] : [] }));
  },
  taskDone(d) { act('task.done', { id: d.id }); },
  assign(d, el) { if (!M.can(ctx.user, 'signoff:partner') && ctx.user.role !== 'firm_administrator') return deny('Partner or administrator assigns work'); act('assign', { area: d.area, role: d.role, staff: el.value }); },
  logTime(d) {
    if (!need('time')) return;
    modal('Log time', `<div class="grid2"><label>Area<select name="area" class="in">${opt(Object.keys(idx.packet.firm.budget_hours).map(k => [k, k.replace(/_/g, ' ')]), d.budget || 'business')}</select></label><label>Hours<input name="hours" type="number" step="0.1" min="0.1" class="in" required value="0.5"></label></div><label>What<input name="note" class="in"></label>`,
      (f) => act('time.log', { area: f.area, hours: +f.hours, note: f.note }));
  },
  step(d) { if (!need('step')) return; modal(`Complete step — ${esc(d.step)}`, `<label>Evidence / note<textarea name="note" class="in" rows="3" required></textarea></label>`, (f) => act('step.complete', { step: d.step, note: f.note })); },
  stepReopen(d) { act('step.reopen', { step: d.step }); },
  dd(d, el) { if (!need('dd')) { el.checked = !el.checked; return; } act('dd.answer', { q: d.q, answer: el.checked }); },
  decision(d) {
    if (!need('decision')) return;
    modal('Record judgment / election', `
      <label>Kind<select name="kind" class="in">${opt([['judgment', 'Judgment call'], ['election', 'Election'], ['penalty', 'Penalty decision'], ['due_diligence', 'Due diligence']], d.kind || 'judgment')}</select></label>
      <label>Topic<input name="topic" class="in" required value="${attr(d.topic || '')}"></label>
      <label>Decision<textarea name="choice" class="in" rows="2" required>${esc(d.choice || '')}</textarea></label>
      <label>Alternatives considered<textarea name="alternatives" class="in" rows="2">${esc(d.alternatives || '')}</textarea></label>
      <label>Authority relied on (firm rule: required)<input name="authority" class="in" required value="${attr(d.authority || '')}"></label>
      <div class="grid2"><label>Federal tax effect<input name="effectFed" type="number" class="in" value="${attr(d.fed || 0)}"></label><label>California tax effect<input name="effectCa" type="number" class="in" value="${attr(d.ca || 0)}"></label></div>`,
      (f) => act('decision', { id: d.id || 'd-' + rid(), kind: f.kind, topic: f.topic, choice: f.choice, alternatives: f.alternatives, authority: f.authority, effectFed: +f.effectFed, effectCa: +f.effectCa, ref: d.ref || null }));
  },
  approveDecision(d) { if (!M.can(ctx.user, 'approve:large')) return deny('Partner approval'); act('decision.approve', { id: d.id }); },

  // ---- filing
  extension() {
    if (!need('extension')) return;
    const x = idx.packet.what_if.extension;
    act('filing.extension', { federal: x.federal.paid_with_form_4868, california: x.california.paid_with_ftb_3519, basedOn: x.based_on_version });
  },
  presentToClient() {
    if (!M.can(ctx.user, 'signoff:partner') && !M.can(ctx.user, 'signoff:reviewer')) return deny('Reviewer or partner presents the return');
    if (M.signoffStatus(ctx, 'return', 'partner').state !== 'fresh') return deny('Partner sign-off (fresh) is required before presenting to the client');
    act('filing.present', { fp: M.returnFingerprint(ctx), summary: ctx.adjusted, version: ctx.vid });
    showToast('Presented to client for approval');
  },
  clientApprove() {
    if (ctx.user.role !== 'client') return deny('Only the client approves');
    const p = ctx.state.filing.presented; if (!p) return deny('Nothing presented yet');
    if (p.fp !== M.returnFingerprint(ctx)) return deny('The return changed after it was presented. The firm must present it again.');
    act('filing.client_approve', { fp: p.fp });
  },
  sign8879() {
    if (ctx.user.role !== 'client') return deny('Only the taxpayers sign Form 8879');
    const p = ctx.state.filing.presented; if (!ctx.state.filing.clientApproved) return deny('Approve the return first');
    modal('Sign Forms 8879 and FTB 8879', `<p>You authorize Miraflores (ERO EFIN ${esc(idx.packet.firm.firm_identity.efin)}) to file the return as presented: federal total tax ${fmt(p.summary.fed.total_tax)}, ${p.summary.fed.balance_due >= 0 ? 'balance due ' + fmt(p.summary.fed.balance_due) : 'refund ' + fmt(-p.summary.fed.balance_due)}; California total tax ${fmt(p.summary.ca.total_tax)}.</p>
      <div class="grid2"><label>Ngozi Okafor — 5-digit PIN<input name="tp" class="in" pattern="\\d{5}" required></label><label>Erik Lindqvist — 5-digit PIN<input name="sp" class="in" pattern="\\d{5}" required></label></div>
      <label class="cb"><input type="checkbox" name="ok" required> I declare that I have examined this return and it is true, correct and complete.</label>`,
      (f) => act('filing.sign8879', { fp: p.fp, pins: 'recorded', signedBy: [ctx.user.name] }), { submit: 'Sign' });
  },
  transmit() {
    if (!M.can(ctx.user, 'file')) return deny('Only the partner (paid preparer) transmits');
    const stepsOpen = M.steps(ctx).filter(s => !s.ok);
    const review = [...ctx.state.notes.values()].filter(n => n.kind === 'review' && n.status === 'open' && n.blocking);
    if (review.length) return deny(`${review.length} open review notes block filing`);
    if (stepsOpen.length) return deny(`Required steps open: ${stepsOpen.map(s => s.name).join('; ')}`);
    const theo = ctx.findings.find(f => f.id === 'F-DEP-SSN-theo');
    const fixed = ctx.state.fixes.has('theo.ssn');
    const subs = idx.packet.tax_agency_records.efile;
    if (theo && !fixed) {
      actMany([{ type: 'filing.submit', payload: { jurisdiction: 'federal', result: 'rejected', submissionId: subs[0].submission_id, errors: subs[0].errors } }, { type: 'filing.submit', payload: { jurisdiction: 'california', result: 'not_transmitted', submissionId: subs[1].submission_id, errors: subs[1].errors } }]);
      showToast('Federal e-file REJECTED: dependent TIN/name mismatch (R0000-504-02)');
      return;
    }
    const snap = { fp: M.returnFingerprint(ctx), summary: ctx.adjusted, version: ctx.vid, adjustments: [...ctx.state.adjustments.values()].filter(a => a.status === 'approved').map(a => ({ id: a.id, line: a.line, from: a.from, to: a.to })), lines: [...idx.linesByVersion.get(ctx.vid).keys()].map(k => [k, M.lineView(ctx, k).value]) };
    actMany([
      { type: 'filing.submit', payload: { jurisdiction: 'federal', result: 'accepted', submissionId: subs[2].submission_id } },
      { type: 'filing.submit', payload: { jurisdiction: 'california', result: 'accepted', submissionId: subs[3].submission_id } },
      { type: 'filing.freeze', payload: snap },
    ]);
    showToast('Accepted. Return frozen at filing.');
  },
  amend() {
    if (!M.can(ctx.user, 'amend')) return deny('Partner starts an amendment');
    modal('Start amended return (1040-X)', `<label>Reason<textarea name="reason" class="in" rows="3" required></textarea></label><p class="muted">The filed return stays frozen. New adjustments are tagged to amendment ${ctx.state.filing.amendments.length + 1}.</p>`, (f) => act('filing.amend', { reason: f.reason, n: ctx.state.filing.amendments.length + 1 }));
  },

  // ---- firm
  saveStandards(d) {
    if (!need('standards', 'Only the firm administrator changes firm standards')) return;
    const vals = { variance_pct: +document.getElementById('std-pct').value, variance_amt: +document.getElementById('std-amt').value, partner_threshold: +document.getElementById('std-thr').value };
    actMany(Object.entries(vals).map(([key, value]) => ({ type: 'standards.update', payload: { key, value } })));
    showToast('Firm standards updated');
  },
  addRule() {
    if (!need('standards', 'Only the firm administrator changes firm standards')) return;
    modal('Add firm rule', `<label>Rule<textarea name="r" class="in" rows="2" required></textarea></label>`, (f) => act('standards.update', { key: 'rules', value: [...ctx.std.rules, f.r] }));
  },
  clearance(d, el) { if (!need('staff', 'Only the firm administrator changes access')) return; act('staff.update', { id: d.id, field: 'sensitive_data_clearance', value: d.value === 'true' }); },
  exportJournal() {
    const blob = new Blob([JSON.stringify({ client: idx.clientId, exported: new Date().toISOString(), events: journal.events }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `workpaper-journal-${idx.clientId}.json`; a.click();
  },
  importJournal(d, el) {
    const f = el.files[0]; if (!f) return;
    f.text().then(t => { const j = JSON.parse(t); journal.replaceAll(j.events || j); showToast(`Imported ${journal.events.length} events`); });
  },
  resetJournal() {
    modal('Reset journal', `<p>Delete all ${journal.events.length} workpaper actions stored in this browser? The packet is not affected. This cannot be undone.</p>`, () => { journal.reset(); showToast('Journal cleared'); }, { submit: 'Delete everything' });
  },
  seed() {
    const go = () => { seedDemo(idx, journal); S.clock = '2026-06-23T12:00:00Z'; try { safeSet('wp:clock', S.clock); } catch {} showToast('Demo history loaded (season up to v3)'); render(); };
    if (!journal.events.length) return go();
    modal('Load demo history', `<p>The journal already has ${journal.events.length} actions. Add the demo history on top of them?</p>`, go, { submit: 'Add demo history' });
  },
  runAgent() {
    if (!journal.remote) return deny('The AI agents run on the shared server');
    if (!M.can(ctx.user, 'adjust')) return deny('Preparers, reviewers and partners start the AI preparer');
    fetch('api/agents/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': S.userId }, body: '{}' })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return deny(j.detail || 'Could not start the AI preparer');
        showToast('AI preparer started. Its work appears here as it goes.');
        refreshAgentStatus();
      }).catch(() => deny('Could not reach the server'));
  },
  markSeen() { localStorage.setItem(`wp:seen:${S.userId}`, JSON.stringify({ seq: journal.nextSeq() - 1, version: ctx.vid, at: new Date().toISOString() })); render(); },
  print() { try { window.print(); } catch { showToast('Use your browser’s print command'); } },
};

function buildAdj(a, reason, authority, findingId) {
  const effect = M.effectOf(a.effects, ctx.rates);
  const thr = ctx.std.partner_threshold;
  return {
    id: 'a-' + rid(), line: a.line, from: a.from, to: a.to, effects: a.effects, effect, whatIf: a.whatIf || null,
    agiDelta: M.agiDeltaOf(a.effects, a.whatIf, idx), reason: a.note ? `${reason} — ${a.note}` : reason, authority, findingId, version: ctx.vid,
    requiresPartner: Math.abs(effect.fed) > thr || Math.abs(effect.ca) > thr, amendment: ctx.amendment || 0,
  };
}
function approveAdjs(ids) {
  const list = [];
  for (const id of ids) {
    const a = ctx.state.adjustments.get(id);
    if (!a || a.status !== 'proposed') continue;
    if (a.by === S.userId) { deny('Firm rule: you may not approve your own adjustment'); continue; }
    if (a.requiresPartner && !M.can(ctx.user, 'approve:large')) {
      if (M.can(ctx.user, 'approve:small') && !a.approvals.some(x => x.level === 'reviewer')) list.push({ type: 'adjust.approve', payload: { id, level: 'reviewer' } });
      else deny(`${a.line}: tax effect over ${ctx.std.partner_threshold} needs partner sign-off`);
      continue;
    }
    if (!M.can(ctx.user, 'approve:small')) { deny('Only reviewers and partners approve'); continue; }
    list.push({ type: 'adjust.approve', payload: { id, level: M.can(ctx.user, 'approve:large') ? 'partner' : 'reviewer' } });
  }
  if (list.length) { actMany(list); showToast(`${list.length} approval${list.length > 1 ? 's' : ''} recorded`); }
}
async function attachThen(file, target, then, f = {}) {
  let evId = 'x-' + rid();
  const payload = { id: evId, target, name: f.name || file?.name || 'Note', text: f.text || null };
  if (file) {
    if (file.size > 25e6) { deny('File over 25 MB'); return; }
    try { await putFile(evId, file); payload.fileId = evId; payload.mime = file.type; payload.size = file.size; } catch (e) { deny('Could not store file: ' + e.message); return; }
  }
  if (file || f.text) act('evidence.attach', payload); else evId = null;
  then?.(evId);
}

export const ACTIONS = A;
boot();

function safeSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
