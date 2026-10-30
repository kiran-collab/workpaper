// Derived workpaper state: the fold of packet + journal, plus the rules that make it a workpaper
// (areas, tax effects, sign-off freshness, roles, gates). Pure functions; no DOM here.

import { line as getLine, version as getVersion, resolveRef } from './data.js';
import { runChecks } from './checks.js';
import { hash } from './journal.js';

// ------------------------------------------------------------------ Areas
export const AREAS = [
  { id: 'intake', name: 'Intake, identity & dependents', budget: 'intake_and_engagement', re: /^(F8812\.[46]|F8867)/, docs: ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D69', 'D70', 'D71', 'D72'] },
  { id: 'wages', name: 'Wages & stock compensation', budget: 'wages_and_stock_compensation', re: /^(F1040\.1|F1040\.25|Sch3\.11|F8959|F6251\.2i|F8949\.[BE]\.N|F8949\.A\.N)/, docs: ['D08', 'D09', 'D10', 'D11', 'D12', 'D13', 'D73'] },
  { id: 'payments', name: 'Payments, extension & penalties', budget: null, re: /^(F1040\.(26|31|33|37|38)$|Sch3\.(10|15)$|F2210|F540NR\.(71|72|73|78|97)$|FTB5805)/, docs: ['D67', 'D68'] },
  { id: 'passthroughs', name: 'K-1s & S corp basis', budget: 'pass_throughs_and_basis', re: /^(SchE\.(28|32|41)|F7203|F8949\.F|SchD\.12$|ScheduleS)/, docs: ['D37', 'D38', 'D39', 'D40'] },
  { id: 'business', name: 'Business — Lindqvist Studio', budget: 'business', re: /^(SchC|SchSE|F4562-C|Sch1\.(3|15|16|17)$|F8995|Sch2\.4$|FTB3885A\.STU|SchCA540NR\.12)/, docs: ['D14', 'D15', 'D16', 'D17', 'D18', 'D19', 'D20', 'D21', 'D22', 'D23', 'D24', 'D25', 'D26', 'D27'] },
  { id: 'rentals', name: 'Rentals & condo sale', budget: 'rentals_and_sale', re: /^(SchE\.|F4562-E|F4797|F8582|SchD\.(11|19)$|FTB3885A\.SAC|SchCA540NR\.17)/, docs: ['D46', 'D47', 'D48', 'D49', 'D50', 'D51', 'D52', 'D53'] },
  { id: 'investments', name: 'Investments, crypto & foreign', budget: 'investments_and_digital_assets', re: /^(SchB|F1040\.(2b|3a|3b|7)$|F8949|SchD|F8938|Sch3\.1$|F8960)/, docs: ['D28', 'D29', 'D30', 'D31', 'D32', 'D33', 'D34', 'D35', 'D36', 'D74'] },
  { id: 'retirement', name: 'Retirement & HSA', budget: null, re: /^(F8606|F1040\.4|F8889|Sch1\.13$)/, docs: ['D41', 'D42', 'D43', 'D44', 'D45'] },
  { id: 'deductions', name: 'Deductions & credits', budget: 'deductions_and_credits', re: /^(SchA|F8283|F1040\.(12|13|14|19|20)$|F8812|F8863|F2441|Sch3\.8$)/, docs: ['D54', 'D55', 'D56', 'D57', 'D58', 'D59', 'D60', 'D61', 'D62', 'D63', 'D64', 'D65', 'D66'] },
  { id: 'california', name: 'California part-year (540NR)', budget: 'california', re: /^(SchCA540NR|F540NR|FTB3885A)/, docs: [] },
  { id: 'tax', name: 'Tax computation & AMT', budget: 'partner_review', re: /^(F1040\.|F6251|Sch1\.|Sch2\.|Sch3\.)/, docs: [] },
];
export const AREA = Object.fromEntries(AREAS.map(a => [a.id, a]));
export function areaOf(key) { return (AREAS.find(a => a.re.test(key)) || AREA.tax).id; }
export function areaOfDoc(id) { return (AREAS.find(a => a.docs.includes(id)) || AREA.intake).id; }

// ------------------------------------------------------------------ People & roles
export const EXAMINER = { id: 'irs-exam', name: 'IRS examiner (shared record)', role: 'examiner' };
export function users(idx) {
  return [...idx.packet.firm.staff, ...idx.packet.firm.client_users.map(c => ({ ...c, role: 'client' })), EXAMINER];
}
export function userById(idx, id) { return users(idx).find(u => u.id === id); }
export function userName(idx, id) { return userById(idx, id)?.name || id || 'Pipeline'; }

const CAN = {
  preparer: ['verify', 'adjust', 'note', 'question', 'signoff:preparer', 'time', 'evidence', 'disposition', 'finding', 'dd', 'task', 'step', 'fix', 'decision'],
  reviewer: ['verify', 'adjust', 'note', 'review', 'question', 'signoff:reviewer', 'approve:small', 'time', 'evidence', 'disposition', 'finding', 'dd', 'task', 'step', 'fix', 'decision', 'extension'],
  partner: ['verify', 'adjust', 'note', 'review', 'question', 'signoff:partner', 'approve:small', 'approve:large', 'time', 'evidence', 'disposition', 'finding', 'task', 'step', 'fix', 'decision', 'file', 'freeze', 'amend', 'extension'],
  firm_administrator: ['standards', 'staff', 'time', 'task', 'viewlog', 'note'],
  quality_reviewer: ['review', 'note', 'time'],
  client: ['client'],
  examiner: [],
};
export function can(user, perm) { return !!user && (CAN[user.role] || []).includes(perm); }
export function isStaff(user) { return user && !['client', 'examiner'].includes(user.role); }
export function cleared(user) { return !!user?.sensitive_data_clearance; }

// ------------------------------------------------------------------ Standards (firm-wide, admin-editable)
export function standards(idx, state) {
  const base = idx.packet.firm.starter_standards;
  const o = state.standards;
  return {
    verification_types: o.verification_types || base.verification_types,
    variance_pct: o.variance_pct ?? base.variance_review.flag_if_change_over_percent,
    variance_amt: o.variance_amt ?? base.variance_review.and_over_amount,
    partner_threshold: o.partner_threshold ?? 1000,
    rules: o.rules || base.rules,
    required_steps: base.required_steps,
    review_levels: base.review_levels,
  };
}

// ------------------------------------------------------------------ Fold
export function fold(idx, journal) {
  const s = {
    verifications: new Map(), adjustments: new Map(), notes: new Map(), signoffs: [], decisions: new Map(),
    findingStatus: new Map(), disposition: new Map(), evidence: [], tasks: new Map(), time: [], views: [],
    standards: {}, staff: {}, steps: new Map(), filing: { submissions: [], amendments: [] }, fixes: new Map(), textFixes: new Map(),
    seen: new Map(), dd: new Map(), assign: {}, log: [],
  };
  for (const e of journal.active()) {
    const p = e.payload;
    s.log.push(e);
    switch (e.type) {
      case 'verify': {
        const list = s.verifications.get(p.target) || [];
        list.push({ method: p.method, note: p.note, by: e.actor, at: e.at, clock: e.clock, id: e.id, value: p.value });
        s.verifications.set(p.target, list); break;
      }
      case 'unverify': s.verifications.delete(p.target); break;
      case 'adjust.propose': s.adjustments.set(p.id, { ...p, status: 'proposed', by: e.actor, at: e.at, clock: e.clock, approvals: [], eventId: e.id }); break;
      case 'adjust.approve': { const a = s.adjustments.get(p.id); if (a) { a.approvals.push({ by: e.actor, at: e.at, level: p.level }); if (!a.requiresPartner || p.level === 'partner') a.status = 'approved'; } break; }
      case 'adjust.reject': { const a = s.adjustments.get(p.id); if (a) { a.status = 'rejected'; a.rejectReason = p.reason; a.rejectedBy = e.actor; } break; }
      case 'adjust.withdraw': { const a = s.adjustments.get(p.id); if (a) a.status = 'withdrawn'; break; }
      case 'note.create': s.notes.set(p.id, { ...p, by: e.actor, at: e.at, clock: e.clock, status: 'open', replies: [] }); break;
      case 'note.reply': { const n = s.notes.get(p.id); if (n) n.replies.push({ by: e.actor, at: e.at, clock: e.clock, text: p.text, evidence: p.evidence }); break; }
      case 'note.resolve': { const n = s.notes.get(p.id); if (n) { n.status = 'resolved'; n.resolution = p.resolution; n.resolvedBy = e.actor; n.resolvedAt = e.at; } break; }
      case 'note.reopen': { const n = s.notes.get(p.id); if (n) n.status = 'open'; break; }
      case 'signoff': s.signoffs.push({ ...p, by: e.actor, at: e.at, clock: e.clock, id: e.id }); break;
      case 'signoff.revoke': s.signoffs = s.signoffs.filter(x => x.id !== p.id); break;
      case 'decision': s.decisions.set(p.id, { ...p, by: e.actor, at: e.at, clock: e.clock, approvals: [] }); break;
      case 'decision.approve': { const d = s.decisions.get(p.id); if (d) d.approvals.push({ by: e.actor, at: e.at }); break; }
      case 'finding.status': s.findingStatus.set(p.id, { status: p.status, reason: p.reason, by: e.actor, at: e.at }); break;
      case 'doc.disposition': s.disposition.set(p.doc, { disposition: p.disposition, reason: p.reason, by: e.actor, at: e.at }); break;
      case 'evidence.attach': s.evidence.push({ ...p, by: e.actor, at: e.at, clock: e.clock }); break;
      case 'task.create': s.tasks.set(p.id, { ...p, by: e.actor, at: e.at, status: 'open' }); break;
      case 'task.done': { const t = s.tasks.get(p.id); if (t) { t.status = 'done'; t.doneBy = e.actor; t.doneAt = e.at; } break; }
      case 'task.assign': { const t = s.tasks.get(p.id); if (t) t.assignee = p.assignee; break; }
      case 'time.log': s.time.push({ ...p, by: e.actor, at: e.at, clock: e.clock }); break;
      case 'view.sensitive': s.views.push({ ...p, by: e.actor, at: e.at }); break;
      case 'standards.update': s.standards[p.key] = p.value; break;
      case 'staff.update': (s.staff[p.id] ||= {})[p.field] = p.value; break;
      case 'step.complete': s.steps.set(p.step, { by: e.actor, at: e.at, note: p.note }); break;
      case 'step.reopen': s.steps.delete(p.step); break;
      case 'household.fix': s.fixes.set(`${p.person}.${p.field}`, { ...p, by: e.actor, at: e.at }); break;
      case 'text.fix': s.textFixes.set(p.line, { ...p, by: e.actor, at: e.at }); break;
      case 'seen': s.seen.set(e.actor, { seq: p.seq, version: p.version, at: e.at }); break;
      case 'dd.answer': s.dd.set(p.q, { answer: p.answer, by: e.actor, at: e.at }); break;
      case 'assign': s.assign[`${p.area}.${p.role}`] = p.staff; break;
      case 'filing.extension': s.filing.extension = { ...p, by: e.actor, at: e.at }; break;
      case 'filing.present': s.filing.presented = { ...p, by: e.actor, at: e.at, clock: e.clock }; break;
      case 'filing.client_approve': s.filing.clientApproved = { ...p, by: e.actor, at: e.at, clock: e.clock }; break;
      case 'filing.sign8879': s.filing.signed = { ...p, by: e.actor, at: e.at, clock: e.clock }; break;
      case 'filing.submit': s.filing.submissions.push({ ...p, by: e.actor, at: e.at, clock: e.clock }); break;
      case 'filing.freeze': s.filing.frozen = { ...p, by: e.actor, at: e.at, clock: e.clock }; break;
      case 'filing.amend': s.filing.amendments.push({ ...p, by: e.actor, at: e.at, clock: e.clock }); break;
      case 'filing.payment': (s.filing.payments ||= []).push({ ...p, by: e.actor, at: e.at }); break;
      default: break;
    }
  }
  return s;
}

// ------------------------------------------------------------------ Context (everything a view needs)
export function activeVersionId(idx, clock) {
  const vs = idx.versions.filter(v => !clock || v.computed_at <= clock);
  return (vs.at(-1) || idx.versions[0]).version;
}

export function buildContext(idx, journal, clock, userId) {
  const state = fold(idx, journal);
  const vid = activeVersionId(idx, clock);
  const v = getVersion(idx, vid);
  const user = { ...userById(idx, userId), ...(state.staff[userId] || {}) };
  const findings = runChecks({ idx, vid, clock });
  const ctx = { idx, journal, state, clock, vid, v, user, findings, std: standards(idx, state) };
  ctx.amendment = state.filing.frozen ? state.filing.amendments.length : 0;
  ctx.rates = v.tax_effect_rates;
  ctx.adjusted = adjustedSummary(ctx);
  return ctx;
}

// ------------------------------------------------------------------ Tax effect of adjustments
export function effectOf(effects, rates) {
  const r = { fed: 0, ca: 0, fedPay: 0, caPay: 0 };
  for (const e of effects || []) {
    const fedOk = e.juris !== 'california', caOk = e.juris !== 'federal';
    if (e.category === 'tax') { if (fedOk && e.juris !== 'california') r.fed += e.amount; if (e.juris === 'california') r.ca += e.amount; }
    else if (e.category === 'credit') { if (fedOk) r.fed -= e.amount; if (caOk && e.juris === 'california') r.ca -= e.amount; }
    else if (e.category === 'payment') { if (e.juris === 'california') r.caPay += e.amount; else r.fedPay += e.amount; }
    else if (rates[e.category]) {
      if (fedOk) r.fed += e.amount * rates[e.category].federal_per_dollar;
      if (caOk) r.ca += e.amount * rates[e.category].california_per_dollar;
    }
  }
  r.fed = Math.round(r.fed); r.ca = Math.round(r.ca);
  return r;
}

// Default effect category for a manual adjustment on a line.
export function defaultCategory(key) {
  if (/^SchC\.(1|5|7)$/.test(key)) return { category: 'schc_profit', sign: 1 };
  if (/^SchC\./.test(key)) return { category: 'schc_profit', sign: -1 };
  if (/^F1040\.1/.test(key) || /^SchCA540NR\.1\./.test(key)) return { category: key.startsWith('SchCA') ? 'ca_source_income' : 'wages', sign: 1 };
  if (/^SchB\.1\.|^SchB\.5\.|^F1040\.(2b|3b)$/.test(key)) return { category: 'interest', sign: 1 };
  if (/^F8949\.[ABCGHI]\./.test(key) || /^SchD\.(1|2|3|6|7)/.test(key)) return { category: 'stcg', sign: 1 };
  if (/^F8949\.|^SchD\./.test(key)) return { category: 'ltcg', sign: 1 };
  if (/^SchE\.(3|28)/.test(key)) return { category: 'ordinary_income', sign: 1 };
  if (/^SchE\./.test(key)) return { category: 'ordinary_income', sign: -1 };
  if (/^Sch1\.(13|15|16|17)$/.test(key)) return { category: 'adjustment', sign: 1 };
  if (/^SchA\.5/.test(key)) return { category: 'salt', sign: 1 };
  if (/^SchA\.|^F8283/.test(key)) return { category: 'itemized', sign: 1 };
  if (/^F1040\.(25|26)|^Sch3\.(10|11)/.test(key)) return { category: 'payment', sign: 1, juris: 'federal' };
  if (/^F540NR\.(71|72|73)$/.test(key)) return { category: 'payment', sign: 1, juris: 'california' };
  if (/^F1040\.19$|^F8812|^Sch3\.1$/.test(key)) return { category: 'credit', sign: 1, juris: 'federal' };
  if (/^SchCA540NR/.test(key)) return { category: 'ca_source_income', sign: 1 };
  return { category: 'ordinary_income', sign: 1 };
}

export function activeAdjustments(ctx) {
  return [...ctx.state.adjustments.values()].filter(a => a.status === 'proposed' || a.status === 'approved');
}

export function adjustedSummary(ctx) {
  const base = ctx.v.summary;
  const out = { fed: { ...base.federal }, ca: { ...base.california }, d: { fed: 0, ca: 0, fedPay: 0, caPay: 0, agi: 0 }, approvedOnly: { fed: 0, ca: 0, fedPay: 0, caPay: 0 }, count: 0 };
  for (const a of activeAdjustments(ctx)) {
    const e = a.effect || effectOf(a.effects, ctx.rates);
    for (const k of ['fed', 'ca', 'fedPay', 'caPay']) { out.d[k] += e[k]; if (a.status === 'approved') out.approvedOnly[k] += e[k]; }
    out.d.agi += a.agiDelta || 0;
    out.count++;
  }
  out.fed.total_tax += out.d.fed; out.fed.payments += out.d.fedPay; out.fed.balance_due = out.fed.total_tax - out.fed.payments;
  out.ca.total_tax += out.d.ca; out.ca.payments += out.d.caPay; out.ca.balance_due = out.ca.total_tax - out.ca.payments;
  out.fed.agi += out.d.agi;
  return out;
}

// AGI delta of an adjustment's effects (income categories only).
export function agiDeltaOf(effects, whatIf, idx) {
  if (whatIf) { const w = idx.packet.what_if.alternatives.find(a => a.id === whatIf); if (w) return w.federal.alternative.agi - w.federal.base.agi; }
  let d = 0;
  for (const e of effects || []) {
    if (e.juris === 'california') continue;
    if (['wages', 'interest', 'schc_profit', 'stcg', 'ltcg', 'ordinary_income'].includes(e.category)) d += e.amount;
    if (e.category === 'adjustment') d -= e.amount;
  }
  return d;
}

// Value of a line after adjustments (latest active adjustment wins); original is always kept.
export function lineView(ctx, key) {
  const l = getLine(ctx.idx, ctx.vid, key);
  const adjs = [...ctx.state.adjustments.values()].filter(a => a.line === key && (a.status === 'proposed' || a.status === 'approved'));
  const adj = adjs.at(-1);
  const text = ctx.state.textFixes.get(key);
  return { line: l, original: l?.value, value: adj ? adj.to : l?.value, adj, text, verified: ctx.state.verifications.get(key) };
}

// ------------------------------------------------------------------ Findings status
export function findingState(ctx, f) {
  const st = ctx.state.findingStatus.get(f.id);
  if (f.kind === 'pass') return 'passed';
  if (st) return st.status;
  const adjs = [...ctx.state.adjustments.values()].filter(a => a.findingId === f.id && a.status !== 'withdrawn' && a.status !== 'rejected');
  if (adjs.length && adjs.every(a => a.status === 'approved')) return 'resolved';
  if (adjs.length) return 'adjusting';
  if (f.fixHousehold && ctx.state.fixes.has(`${f.fixHousehold.person}.${f.fixHousehold.field}`)) return 'resolved';
  if (f.textFix && ctx.state.textFixes.has(f.textFix.line)) return 'resolved';
  return 'open';
}
export function openFindings(ctx) {
  return ctx.findings.filter(f => f.kind !== 'pass' && ['open', 'adjusting'].includes(findingState(ctx, f)) && f.severity !== 'info');
}

// ------------------------------------------------------------------ Sign-offs (reopen when what was signed changes)
export function areaLines(ctx, areaId) {
  return [...ctx.idx.linesByVersion.get(ctx.vid).values()].filter(l => areaOf(l.key) === areaId);
}
export function areaFingerprint(ctx, areaId) {
  const parts = [];
  for (const l of areaLines(ctx, areaId)) parts.push(`${l.key}=${l.value}`);
  for (const a of ctx.state.adjustments.values()) if (areaOf(a.line) === areaId) parts.push(`adj:${a.id}:${a.status}:${a.to}`);
  for (const d of AREA[areaId].docs) { const doc = ctx.idx.docs.get(d); if (doc && (!ctx.clock || doc.received_at <= ctx.clock)) parts.push('doc:' + d); }
  for (const [k, v] of ctx.state.textFixes) if (areaOf(k) === areaId) parts.push(`txt:${k}:${v.to}`);
  return hash(parts.sort().join('|'));
}
export function returnFingerprint(ctx) {
  // Figures only: identity corrections (e.g. a dependent SSN) are journaled but do not change
  // what the partner or the client signed.
  return hash(AREAS.map(a => areaFingerprint(ctx, a.id)).join('|'));
}
// What changed in an area between a signed fingerprint and now (best effort explanation).
export function signoffStatus(ctx, scope, level) {
  const list = ctx.state.signoffs.filter(s => s.scope === scope && s.level === level);
  const last = list.at(-1);
  if (!last) return { state: 'none' };
  const fp = scope === 'return' ? returnFingerprint(ctx) : areaFingerprint(ctx, scope);
  if (fp === last.fp) return { state: 'fresh', so: last };
  return { state: 'stale', so: last, why: staleReason(ctx, scope, last) };
}
function staleReason(ctx, scope, so) {
  const reasons = [];
  if (so.version && so.version !== ctx.vid) reasons.push(`return recomputed (${so.version} → ${ctx.vid})`);
  const after = [...ctx.state.adjustments.values()].filter(a => (scope === 'return' || areaOf(a.line) === scope) && a.at > so.at);
  if (after.length) reasons.push(`${after.length} adjustment change${after.length > 1 ? 's' : ''} after sign-off`);
  if (!reasons.length) reasons.push('documents or figures changed after sign-off');
  return reasons.join('; ');
}
export function preparedBy(ctx, areaId) {
  const ids = new Set();
  for (const s of ctx.state.signoffs) if (s.scope === areaId && s.level === 'preparer') ids.add(s.by);
  for (const a of ctx.state.adjustments.values()) if (areaOf(a.line) === areaId) ids.add(a.by);
  return ids;
}
export function assigned(ctx, areaId, role) {
  return ctx.state.assign[`${areaId}.${role}`] || ctx.idx.packet.firm.assignment_at_start[role];
}

// ------------------------------------------------------------------ Documents: where each landed (or why not)
export function docLanding(ctx, docId) {
  const evs = ctx.idx.evsByDoc.get(docId) || [];
  const lines = new Set();
  for (const e of evs) for (const u of ctx.idx.usedBy.get(e.id) || []) if (u.version === ctx.vid) lines.add(u.key);
  for (const u of ctx.idx.usedBy.get(docId) || []) if (u.version === ctx.vid) lines.add(u.key);
  const usedEv = evs.filter(e => (ctx.idx.usedBy.get(e.id) || []).some(u => u.version === ctx.vid));
  return { evs, lines: [...lines], usedEv };
}
const AUTO_REASON = {
  engagement_letter: 'Engagement record (scope, fee, signatures)', consent_7216: 'Consent record', irs_ip_pin_notice: 'IP PIN used for e-file signature',
  identity_document: 'Identity verification', prior_year_return: 'Prior-year comparison and carryovers', prior_workpaper: 'Prior preparer file (reviewed)',
  irs_transcript: 'Third-party record for payments', irs_notice: 'Notice history', paystub: 'California wage split evidence', client_note: 'Home office measurements',
};
export function docStatus(ctx, d) {
  const disp = ctx.state.disposition.get(d.id);
  const received = !ctx.clock || d.received_at <= ctx.clock;
  if (!received) return { code: 'future', label: 'Not yet received' };
  const sup = ctx.v.documents_superseded.includes(d.id);
  const used = ctx.v.documents_used.includes(d.id);
  const land = docLanding(ctx, d.id);
  if (disp) return { code: 'dispositioned', label: disp.disposition, reason: disp.reason, by: disp.by, used, land };
  if (sup) return { code: 'superseded', label: 'Superseded', reason: d.id === 'D30' ? 'Replaced by corrected 1099 (D31)' : 'Superseded', land };
  if (d.id === 'D10') return { code: 'duplicate', label: 'Duplicate image', reason: 'Second image of D09; counted once', land };
  if (land.lines.length) return { code: 'used', label: `Used on ${land.lines.length} line${land.lines.length > 1 ? 's' : ''}`, land };
  if (used) return { code: 'reference', label: 'Reference', reason: AUTO_REASON[d.document_type] || 'Used by the engine without a line source', land };
  return { code: 'unaccounted', label: 'Needs disposition', reason: d.extraction.reason || 'Not used by the return', land };
}

// ------------------------------------------------------------------ Variance vs prior year
export function variances(ctx) {
  const py = ctx.idx.packet.prior_years.return_2024.lines;
  const out = [];
  for (const [k, pv] of Object.entries(py)) {
    if (typeof pv !== 'number') continue;
    const lv = lineView(ctx, k);
    if (!lv.line) continue;
    const cur = +lv.value; const d = cur - pv;
    const pct = pv === 0 ? (cur === 0 ? 0 : 100) : Math.abs(d / pv) * 100;
    const flagged = Math.abs(d) > ctx.std.variance_amt && pct > ctx.std.variance_pct;
    out.push({ key: k, label: lv.line.label, prior: pv, current: cur, delta: d, pct, flagged, explained: [...ctx.state.notes.values()].find(n => n.kind === 'variance' && n.refs?.includes(k)) });
  }
  return out;
}

// ------------------------------------------------------------------ Required steps / filing gates
export function steps(ctx) {
  const s = ctx.state;
  const auto = (name) => s.steps.get(name);
  const docsOk = [...ctx.idx.docs.values()].every(d => { const st = docStatus(ctx, d); return st.code !== 'unaccounted'; });
  const vars = variances(ctx).filter(v => v.flagged);
  const varsOk = vars.every(v => v.explained);
  const carryKeys = ['SchD.6', 'SchD.14', 'F8582.1c', 'F8606.2', 'F7203.1'];
  const carryOk = carryKeys.every(k => s.verifications.get(k)?.length);
  const payKeys = ['F1040.26', 'F540NR.72'];
  const payOk = payKeys.every(k => s.verifications.get(k)?.some(v => v.method === 'agreed_to_third_party_record')) && !openFindings(ctx).some(f => ['F-FED-EST', 'F-CA-EST'].includes(f.id));
  const ddOk = DD_QUESTIONS.every(q => s.dd.get(q.id)?.answer);
  const diagOk = openFindings(ctx).length === 0;
  const areas = AREAS.filter(a => areaLines(ctx, a.id).length);
  const revOk = areas.every(a => signoffStatus(ctx, a.id, 'reviewer').state === 'fresh');
  const partnerOk = signoffStatus(ctx, 'return', 'partner').state === 'fresh';
  const clientOk = !!(s.filing.clientApproved && s.filing.signed && s.filing.signed.fp === returnFingerprint(ctx));
  const list = [
    { name: 'Engagement letter and consents signed', ok: !!ctx.idx.evs.get('ev-0001') && !!ctx.idx.evs.get('ev-0004'), how: 'D01 signed 01/12/2026; D02 signed 01/12/2026', evidence: ['D01', 'D02'] },
    { name: 'Identity verified', ok: !!auto('Identity verified'), manual: true, how: 'Driver licenses D04, D05; IP PIN notice D03', evidence: ['D04', 'D05', 'D03'] },
    { name: 'Prior-year return reviewed', ok: !!auto('Prior-year return reviewed'), manual: true, how: 'D06 and prior preparer file D07', evidence: ['D06', 'D07'] },
    { name: 'All documents accounted for', ok: docsOk, how: 'Every received document is used, superseded, a duplicate, a reference, or has a recorded disposition' },
    { name: 'Prior-year variances explained', ok: varsOk, how: `${vars.filter(v => v.explained).length} of ${vars.length} flagged variances explained` },
    { name: 'Carryovers agreed to prior year', ok: carryOk, how: `Verify ${carryKeys.join(', ')}` },
    { name: 'Estimated payments agreed to IRS and FTB records', ok: payOk, how: 'Verify F1040.26 and F540NR.72 as agreed to third-party record; resolve payment findings' },
    { name: 'Due diligence completed', ok: ddOk, how: 'Form 8867 checklist (CTC/ODC, AOTC)' },
    { name: 'Diagnostics resolved', ok: diagOk, how: `${openFindings(ctx).length} open findings` },
    { name: 'Reviewer sign-off', ok: revOk, how: 'Reviewer sign-off on every area, still fresh' },
    { name: 'Partner sign-off', ok: partnerOk, how: 'Partner sign-off on the whole return, still fresh' },
    { name: 'Client approval and e-file authorization', ok: clientOk, how: 'Client approves the presented return and signs Forms 8879 (on the same figures)' },
  ];
  return list;
}

export function blockers(ctx) {
  const b = [];
  const reviewOpen = [...ctx.state.notes.values()].filter(n => n.kind === 'review' && n.status === 'open');
  if (reviewOpen.length) b.push({ text: `${reviewOpen.length} open review note${reviewOpen.length > 1 ? 's' : ''}`, to: '#/people' });
  const pend = [...ctx.state.adjustments.values()].filter(a => a.status === 'proposed');
  if (pend.length) b.push({ text: `${pend.length} adjustment${pend.length > 1 ? 's' : ''} awaiting approval`, to: '#/adjustments' });
  const of = openFindings(ctx);
  if (of.length) b.push({ text: `${of.length} open finding${of.length > 1 ? 's' : ''}`, to: '#/findings' });
  for (const st of steps(ctx)) if (!st.ok && !['Diagnostics resolved'].includes(st.name)) b.push({ text: st.name, to: '#/filing' });
  return b;
}

export const DD_QUESTIONS = [
  { id: 'dd-ctc-age', credit: 'CTC', q: 'Theo (born 02/09/2017) was under 17 at year end and has a valid SSN issued before the due date.' },
  { id: 'dd-ctc-res', credit: 'CTC/ODC', q: 'Each dependent lived with the taxpayers more than half the year (organizer: 12 months; Ada at college counts as temporary absence).' },
  { id: 'dd-odc-ada', credit: 'ODC', q: 'Ada (19, full-time student) is a qualifying child; she checked “someone can claim you” on her own return.' },
  { id: 'dd-support', credit: 'CTC/ODC', q: 'Neither child provided more than half of their own support.' },
  { id: 'dd-aotc', credit: 'AOTC', q: 'AOTC: Form 1098-T received (D59); scholarship 9,000 restricted to tuition subtracted; credit fully phased out by MAGI — nothing claimed.' },
  { id: 'dd-docs', credit: 'All', q: 'Documents reviewed and retained: 2024 return dependents, 1098-T, Social Security card (Theo, D71) — records kept 7 years.' },
  { id: 'dd-hoh-eic', credit: 'HOH/EIC', q: 'Head of household and EIC not claimed (MFJ; income over EIC limits).' },
];

// ------------------------------------------------------------------ Sensitive data
export const SENSITIVE_TYPES = new Set(['ssn', 'account_number']);
export function maskValue(v, kind) {
  const s = String(v ?? '');
  if (kind === 'ssn') return '•••-••-' + s.slice(-4);
  if (kind === 'ip_pin') return '••••••';
  return '••••' + s.replace(/\s/g, '').slice(-4);
}

// ------------------------------------------------------------------ Timeline replay
export function clockEvents(idx) {
  const evs = [
    ...idx.timeline.map(t => ({ at: t.at, id: t.id, label: t.event.replace(/_/g, ' '), t })),
  ];
  return evs.sort((a, b) => a.at.localeCompare(b.at));
}

// ------------------------------------------------------------------ Search
export function search(ctx, q) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const l of ctx.idx.linesByVersion.get(ctx.vid).values()) {
    if (l.form === 'F8949' && !l.key.endsWith('total') && !(l.label.toLowerCase().includes(q))) continue;
    if (l.key.toLowerCase().includes(q) || l.label.toLowerCase().includes(q) || String(l.value) === q) out.push({ kind: 'line', key: l.key, label: l.label, value: l.value });
  }
  for (const d of ctx.idx.docs.values()) if ((d.id + ' ' + d.title + ' ' + d.issuer).toLowerCase().includes(q)) out.push({ kind: 'doc', key: d.id, label: d.title });
  for (const f of ctx.findings) if ((f.title + ' ' + f.summary).toLowerCase().includes(q)) out.push({ kind: 'finding', key: f.id, label: f.title });
  for (const n of ctx.state.notes.values()) if ((n.text || '').toLowerCase().includes(q)) out.push({ kind: 'note', key: n.id, label: n.text });
  for (const e of ctx.idx.evs.values()) {
    if (out.length > 120) break;
    if (String(e.text_as_read).toLowerCase() === q || e.id === q) out.push({ kind: 'ev', key: e.id, label: `${e.document_id} · ${e.label}: ${e.text_as_read}` });
  }
  return out.slice(0, 120);
}

export { resolveRef };
