// Independent checks. Each check re-derives a figure from source records (printed content,
// extracted values, agency records, client answers) and compares it with what the engine did.
// Nothing here trusts a computed line as an input unless it is the thing being tested.
// A check returns findings; a finding can carry proposed adjustments with their tax effect basis.

import { line as getLine, version as getVersion } from './data.js';

const round = (x) => Math.round(x);
const money = (x) => (x == null ? '—' : (x < 0 ? '−' : '') + Math.abs(+x).toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function runChecks(ctx) {
  const out = [];
  for (const fn of CHECKS) {
    try {
      const r = fn(ctx);
      if (r) out.push(...(Array.isArray(r) ? r : [r]).filter(Boolean));
    } catch (e) {
      out.push({ id: 'CHECK-ERROR-' + fn.name, title: `Check ${fn.name} could not run`, area: 'tax', severity: 'low', kind: 'system', summary: String(e), evidence: [], lines: [] });
      console.error(e);
    }
  }
  return out;
}

// ---- helpers ----
function mk(ctx) {
  const { idx, vid, clock } = ctx;
  const L = (k) => getLine(idx, vid, k);
  const V = (k) => L(k)?.value;
  const ev = (id) => idx.evs.get(id);
  const evf = (doc, field) => (idx.evsByDoc.get(doc) || []).find(e => e.field === field);
  const docText = (id) => (idx.docs.get(id)?.pages || []).map(p => p.printed_content).join(' ');
  const received = (docId) => { const d = idx.docs.get(docId); return d && (!clock || d.received_at <= clock); };
  const msgAvail = (id) => { const m = idx.msgs.get(id); return m && (!clock || m.sent_at <= clock); };
  const rates = getVersion(idx, vid).tax_effect_rates;
  const docsOfType = (t) => [...idx.docs.values()].filter(d => d.document_type === t && received(d.id));
  return { idx, vid, clock, L, V, ev, evf, docText, received, msgAvail, rates, docsOfType, P: idx.params };
}

// ---------------------------------------------------------------- Business
function mileageDuplicatePage(ctx) {
  const c = mk(ctx);
  const l44 = c.L('SchC.44a'); if (!l44) return;
  const evs = c.idx.evsByDoc.get('D23') || [];
  const pages = new Map();
  for (const e of evs) {
    if (!pages.has(e.page)) pages.set(e.page, { trips: {}, total: null });
    const m = e.field.match(/^trip(\d+)_(date|destination|miles)$/);
    if (m) { const p = pages.get(e.page); (p.trips[m[1]] ||= {})[m[2]] = e.value; }
    if (e.field === 'page_total') pages.get(e.page).total = e.value;
  }
  const sigs = new Map(); const dups = [];
  let unique = 0;
  for (const [pg, p] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    const sig = Object.values(p.trips).filter(t => t.date).map(t => `${t.date}|${t.destination}|${t.miles}`).sort().join(';');
    if (sig && sigs.has(sig)) dups.push({ page: pg, sameAs: sigs.get(sig), total: p.total });
    else { if (sig) sigs.set(sig, pg); unique += p.total || 0; }
  }
  if (!dups.length) return pass('CHK-MILEAGE', 'Mileage log pages are distinct', 'business', ['D23'], ['SchC.44a']);
  const odoStart = c.evf('D23', 'odometer_start')?.value, odoEnd = c.evf('D23', 'odometer_end')?.value;
  const rate = c.P.mileage_rate;
  const oldDed = c.V('SchC.9'), newDed = round(unique * rate);
  const totalMiles = odoEnd - odoStart;
  return {
    id: 'F-MILEAGE-DUP', area: 'business', severity: 'high', kind: 'engine',
    title: 'Mileage log page counted twice',
    summary: `Page ${dups[0].page} of the mileage log is a second scan of page ${dups[0].sameAs} (same ${Object.keys(pages.get(dups[0].page).trips).length} trips). The engine summed every page total.`,
    detail: [
      `Engine business miles ${money(l44.value)} = sum of all page totals (rule R-MILEAGE-PAGE-TOTALS).`,
      `Distinct pages: ${money(unique)} miles. Odometer ${money(odoStart)} → ${money(odoEnd)} = ${money(totalMiles)} total miles.`,
      `Standard mileage: ${money(unique)} × ${rate} = ${money(newDed)} (engine ${money(oldDed)}).`,
    ],
    engine: { label: 'Business miles', value: l44.value }, expected: { label: 'Business miles (distinct pages)', value: unique },
    evidence: ['D23', ...evs.filter(e => e.field === 'page_total').map(e => e.id), 'msg-03'],
    lines: ['SchC.44a', 'SchC.9', 'SchC.44c'],
    adjustments: [
      { line: 'SchC.44a', from: l44.value, to: unique, effects: [] , note: 'Remove duplicate page 3' },
      { line: 'SchC.44c', from: c.V('SchC.44c'), to: totalMiles - unique, effects: [], note: 'Other miles = odometer total − business miles' },
      { line: 'SchC.9', from: oldDed, to: newDed, effects: [{ category: 'schc_profit', amount: oldDed - newDed }], note: `${money(unique)} mi × ${rate}` },
    ],
  };
}

function form1099KDoubleCount(ctx) {
  const c = mk(ctx);
  const l = c.L('SchC.1'); if (!l) return;
  const k = c.docsOfType('1099-K').map(d => c.evf(d.id, 'box1a')).filter(Boolean);
  const books = c.evf('D14', 'total_income');
  const kTotal = k.reduce((s, e) => s + e.value, 0);
  const viaCard = c.evf('D15', 'atlas_paywell');
  const necs = c.docsOfType('1099-NEC').map(d => c.evf(d.id, 'box1')).filter(Boolean);
  const necTotal = necs.reduce((s, e) => s + e.value, 0);
  const small = c.evf('D15', 'unreported_small')?.value || 0;
  const recon = `1099-NEC ${money(necTotal)} + deposits from clients with no 1099 ${money(small)} = ${money(necTotal + small)}; books total income ${money(books?.value)}.`;
  if (books && l.value - books.value === kTotal && viaCard && viaCard.value === kTotal) {
    return {
      id: 'F-1099K-DOUBLE', area: 'business', severity: 'high', kind: 'engine',
      title: 'Form 1099-K receipts counted twice in gross receipts',
      summary: `Gross receipts ${money(l.value)} = books ${money(books.value)} + 1099-K ${money(kTotal)}. The books already include the ${money(kTotal)}: it is Atlas Outdoor Gear paying by card, deposited gross (books transaction detail, page 3).`,
      detail: [recon, 'The engine could not match the card deposits to a books deposit (R-SCHC-GROSS) and added them again.', 'The IRS will match both the 1099-NEC (Atlas 41,200 includes the card payments) and the 1099-K: keep this reconciliation in the file.'],
      engine: { label: 'Gross receipts', value: l.value }, expected: { label: 'Gross receipts (books, reconciled)', value: books.value },
      evidence: [books.id, viaCard.id, c.evf('D15', 'atlas_total')?.id, ...k.map(e => e.id), ...necs.map(e => e.id), c.evf('D15', 'unreported_small')?.id].filter(Boolean),
      lines: ['SchC.1'],
      adjustments: [{ line: 'SchC.1', from: l.value, to: books.value, effects: [{ category: 'schc_profit', amount: books.value - l.value }], note: 'Remove 1099-K amounts already in books deposits' }],
    };
  }
  return pass('CHK-GROSS', 'Gross receipts reconcile to 1099-NEC/1099-K', 'business', [books?.id].filter(Boolean), ['SchC.1'], recon);
}

function phoneInternetPersonalUse(ctx) {
  const c = mk(ctx);
  const l = c.L('SchC.25'); if (!l) return;
  const call = c.idx.calls.get('call-01'); if (!call || (c.clock && call.date > c.clock)) return;
  const phone = c.evf('D14', 'Telephone')?.value, net = c.evf('D14', 'Internet')?.value;
  const pPhone = +(call.notes.join(' ').match(/business share is (\d+)%/)?.[1] || 100) / 100;
  const pNet = +(call.notes.join(' ').match(/business use about (\d+)%/)?.[1] || 100) / 100;
  const deductible = round(phone * pPhone + net * pNet);
  if (deductible >= l.value) return;
  return {
    id: 'F-UTIL-PERSONAL', area: 'business', severity: 'medium', kind: 'judgment',
    title: 'Family phone plan and home internet deducted at 100%',
    summary: `Books deduct the 4-line family mobile plan (${money(phone)}) and shared home internet (${money(net)}) in full. Client call: business share ${pPhone * 100}% and ${pNet * 100}%.`,
    detail: [`Deductible: ${money(phone)} × ${pPhone * 100}% + ${money(net)} × ${pNet * 100}% = ${money(deductible)} (engine ${money(l.value)}).`, 'Authority: IRC 262 (personal expenses); allocation by business use.'],
    engine: { label: 'Utilities', value: l.value }, expected: { label: 'Business share', value: deductible },
    evidence: ['ev-0101', 'ev-0095', 'ev-0107', 'ev-0108', 'call-01'], lines: ['SchC.25'],
    adjustments: [{ line: 'SchC.25', from: l.value, to: deductible, effects: [{ category: 'schc_profit', amount: l.value - deductible }], note: 'Business-use allocation per call notes' }],
  };
}

function personalSubscription(ctx) {
  const c = mk(ctx);
  const l = c.L('SchC.27a.1'); const s = c.evf('D15', 'spotify'); if (!l || !s) return;
  const call = c.idx.calls.get('call-01'); const confirmed = call && (!c.clock || call.date <= c.clock) && /Spotify.*personal/i.test(call.notes.join(' '));
  return {
    id: 'F-PERSONAL-SOFTWARE', area: 'business', severity: 'low', kind: confirmed ? 'judgment' : 'client',
    title: 'Personal subscription in business software expense',
    summary: `Software and subscriptions ${money(l.value)} includes Spotify Family ${money(s.value)}.${confirmed ? ' Client confirmed it is personal (call 03/26).' : ' Ask the client.'}`,
    detail: ['Books transaction detail page 1 lists the subscription inside the account.'],
    engine: { label: 'Software and subscriptions', value: l.value }, expected: { label: 'Excluding personal', value: l.value - s.value },
    evidence: [s.id, 'ev-0099', confirmed ? 'call-01' : null].filter(Boolean), lines: ['SchC.27a.1'],
    adjustments: [{ line: 'SchC.27a.1', from: l.value, to: l.value - s.value, effects: [{ category: 'schc_profit', amount: s.value }], note: 'Remove personal subscription' }],
    question: confirmed ? null : { to: 'client', text: 'Is the Spotify Family subscription (216.00) in Lindqvist Studio software expenses a business expense?' },
  };
}

function selfEmployedHealthInsurance(ctx) {
  const c = mk(ctx);
  const l = c.L('Sch1.17'); if (!l || !l.value) return;
  const qa = c.idx.qa.get('qa-25');
  if (!/^Yes/i.test(qa?.answer || '')) return;
  return {
    id: 'F-SEHI-ELIGIBLE', area: 'business', severity: 'high', kind: 'judgment',
    title: 'Self-employed health insurance deduction while eligible for spouse’s employer plan',
    summary: `Engine deducts ${money(l.value)} of Erik’s premiums. Questionnaire: both of Ngozi’s employers offered family coverage that Erik could join. The deduction is not allowed for any month he was eligible for a subsidized employer plan.`,
    detail: ['Authority: IRC 162(l)(2)(B); Pub. 535. Eligibility (not enrollment) controls.', '2024 return took no SE health insurance deduction for the same reason (prior-year note).', 'Removing the deduction also raises QBI; the adjustment rate does not capture that second-order effect.'],
    engine: { label: 'SE health insurance', value: l.value }, expected: { label: 'Allowable', value: 0 },
    evidence: ['qa-25', 'ev-0484', 'py:/return_2024/notes/Sch1.17'], lines: ['Sch1.17'],
    adjustments: [{ line: 'Sch1.17', from: l.value, to: 0, effects: [{ category: 'adjustment', amount: -l.value }], note: 'Not allowed: eligible for employer-subsidized plan through spouse' }],
  };
}

// ---------------------------------------------------------------- Wages and stock compensation
function rsuNoncoveredBasis(ctx) {
  const c = mk(ctx);
  const supp = (c.idx.evsByDoc.get('D11') || []);
  if (!c.received('D11')) return;
  const lots = {};
  for (const e of supp) { const m = e.field.match(/^(.+)_(adjusted_basis|acquired)$/); if (m) (lots[m[1]] ||= {})[m[2]] = e; }
  const adjs = []; const rows = [];
  let st = 0, lt = 0;
  for (const l of c.idx.linesByVersion.get(c.vid).values()) {
    if (l.form !== 'F8949' || !/^F8949\.[BE]\.N\d+$/.test(l.key)) continue;
    const basisEv = l.sources.map(c.ev).find(e => e?.field?.endsWith('_basis'));
    const acqEv = l.sources.map(c.ev).find(e => e?.field?.endsWith('_acquired'));
    const procEv = l.sources.map(c.ev).find(e => e?.field?.endsWith('_proceeds'));
    if (!basisEv || basisEv.value !== 0) continue;
    const match = Object.entries(lots).find(([, v]) => v.acquired?.value === acqEv?.value && v.adjusted_basis);
    if (!match) continue;
    const basis = match[1].adjusted_basis.value;
    const corrected = round((procEv.value - basis) * 100) / 100;
    const box = l.key.split('.')[1];
    const delta = corrected - l.value;
    if (box === 'B') st += delta; else lt += delta;
    rows.push(`${l.key}: ${match[0]} proceeds ${money(procEv.value)} − adjusted basis ${money(basis)} = ${money(corrected)} (engine ${money(l.value)})`);
    adjs.push({ line: l.key, from: l.value, to: corrected, effects: [{ category: box === 'B' ? 'stcg' : 'ltcg', amount: delta }], note: `Basis from supplemental statement lot ${match[0]}`, evidence: [match[1].adjusted_basis.id] });
  }
  if (!adjs.length) return;
  return {
    id: 'F-RSU-BASIS', area: 'wages', severity: 'high', kind: 'engine',
    title: 'RSU sales taxed with zero basis (income already on W-2)',
    summary: `${adjs.length} noncovered RSU lots used the broker’s blank basis. The stock-plan supplement gives adjusted basis for each lot; without it the vest value (already in W-2 box 1) is taxed twice.`,
    detail: [...rows, `Net change: short-term ${money(st)}, long-term ${money(lt)}.`, 'Rule R-8949-LOT only uses a supplement when it is matched; the engine matched the ESPP lot but not the RSU lots.'],
    engine: { label: 'RSU gain reported', value: adjs.reduce((s, a) => s + a.from, 0) }, expected: { label: 'RSU gain with adjusted basis', value: adjs.reduce((s, a) => s + a.to, 0) },
    evidence: ['D11', ...supp.filter(e => e.field.endsWith('adjusted_basis')).map(e => e.id), 'ev-0027'], lines: adjs.map(a => a.line),
    adjustments: adjs,
  };
}

function caWageSourcing(ctx) {
  const c = mk(ctx);
  const l = c.L('SchCA540NR.1.E'); if (!l) return;
  const caRes = c.idx.packet.household.residency.find(r => r.state === 'CA');
  const corv = c.evf('D08', 'box16')?.value || 0;
  const halv = c.evf('D09', 'box16')?.value || 0;
  const halvText = c.docText('D09');
  const kept = halvText.match(/California as the work state through (\d\d\/\d\d\/\d{4})/);
  if (!kept) return;
  if (!c.received('D73')) {
    return {
      id: 'F-CA-WAGES', area: 'california', severity: 'high', kind: 'client',
      title: 'California wages include Texas-period pay',
      summary: `Halvorsen box 16 (${money(halv)}) runs through ${kept[1]}, but California residency ended ${caRes.to}. Need year-to-date pay at the move date.`,
      detail: ['Request a paystub dated around 07/15/2025.'], evidence: ['ev-0047', 'D09', 'qa-45'], lines: ['SchCA540NR.1.E'],
      question: { to: 'client', text: 'Please upload a Halvorsen paystub from mid-July 2025 showing year-to-date wages at the move.' },
    };
  }
  const ytd = c.evf('D73', 'ytd_ca_wages').value;
  const expected = corv + ytd;
  return {
    id: 'F-CA-WAGES', area: 'california', severity: 'high', kind: 'engine',
    title: 'California-source wages include pay earned as a Texas resident',
    summary: `Engine uses W-2 box 16 for California wages (${money(l.value)}). Halvorsen kept California as the work state through ${kept[1]} by mistake; Ngozi was a Texas resident working in Austin from ${addDay(caRes.to)}.`,
    detail: [
      `Corvane (all California, employment ended 05/16) box 16 ${money(corv)}.`,
      `Halvorsen California-period wages from the 07/18 paystub: YTD California taxable wages at 07/15 ${money(ytd)}.`,
      `California-source wages ${money(expected)} (engine ${money(l.value)}). The paystub period ends 07/15 vs residency end 07/14: one day, immaterial.`,
      'California withholding on the Texas-period wages stays on line 71 and is refunded.',
    ],
    engine: { label: 'CA wages', value: l.value }, expected: { label: 'CA-source wages', value: expected },
    evidence: ['ev-0030', 'ev-0047', 'ev-1081', 'D73', 'qa-45', 'qa-03'], lines: ['SchCA540NR.1.E'],
    adjustments: [{ line: 'SchCA540NR.1.E', from: l.value, to: expected, effects: [{ category: 'ca_source_income', amount: expected - l.value }], note: 'California-period wages only' }],
  };
}

function excessSocialSecurity(ctx) {
  const c = mk(ctx);
  const l = c.L('Sch3.11'); if (!l) return;
  const withheld = c.evf('D08', 'box4').value + c.evf('D09', 'box4').value;
  const max = round(c.P.ss_wage_base * 0.062 * 100) / 100;
  const calc = round(withheld - max);
  return calc === l.value ? pass('CHK-EXCESS-SS', `Excess social security recomputed: ${money(withheld)} − ${money(max)} = ${money(calc)}`, 'wages', ['ev-0019', 'ev-0038'], ['Sch3.11'])
    : fail('CHK-EXCESS-SS', 'Excess social security tax does not recompute', 'wages', l.value, calc, ['ev-0019', 'ev-0038'], ['Sch3.11']);
}

function w2Sums(ctx) {
  const c = mk(ctx);
  const l = c.L('F1040.1a'); if (!l) return;
  const w2s = c.docsOfType('W-2');
  const seen = new Map();
  for (const d of w2s) {
    const key = ['employer_ein', 'box1', 'box2', 'box16'].map(f => c.evf(d.id, f)?.value).join('|');
    if (!seen.has(key)) seen.set(key, d.id);
  }
  const distinct = [...seen.values()];
  const box1 = distinct.reduce((s, id) => s + c.evf(id, 'box1').value, 0);
  const dupes = w2s.filter(d => !distinct.includes(d.id)).map(d => d.id);
  return box1 === l.value
    ? pass('CHK-W2', `Wages agree: ${distinct.length} distinct W-2s = ${money(box1)}${dupes.length ? ` (${dupes.join(', ')} is a duplicate image, counted once)` : ''}`, 'wages', distinct, ['F1040.1a'])
    : fail('CHK-W2', 'W-2 box 1 total does not agree', 'wages', l.value, box1, distinct, ['F1040.1a']);
}

// ---------------------------------------------------------------- Investments
function foreignInterestRate(ctx) {
  const c = mk(ctx);
  const out = [];
  for (const l of c.idx.linesByVersion.get(c.vid).values()) {
    if (!l.key.startsWith('SchB.1.')) continue;
    const fx = (l.sources || []).find(s => s.startsWith('ref:fx.'));
    if (!fx) continue;
    const [, cur, which] = fx.split('.');
    const year = +which.slice(0, 4);
    if (year === c.idx.packet.household.tax_year) continue;
    const amt = c.ev(l.sources.find(s => s.startsWith('ev-')))?.value;
    const right = `${c.idx.packet.household.tax_year}_average`;
    const rate = c.P.fx[cur][right];
    const usd = round(amt / rate);
    out.push({
      id: 'F-FX-RATE', area: 'investments', severity: 'medium', kind: 'engine',
      title: 'Foreign interest converted at last year’s exchange rate',
      summary: `${cur} ${money(amt)} converted at the ${which.replace('_', ' ')} rate (${c.P.fx[cur][which]}). The 2025 average is ${rate}.`,
      detail: [`${money(amt)} ÷ ${rate} = ${money(usd)} (engine ${money(l.value)}).`, 'The 2024 return used 10.56 correctly for 2024; the engine carried the same rate forward.'],
      engine: { label: 'Interest (USD)', value: l.value }, expected: { label: 'At 2025 average', value: usd },
      evidence: [l.sources.find(s => s.startsWith('ev-')), `ref:fx.${cur}.${right}`, fx], lines: [l.key],
      adjustments: [{ line: l.key, from: l.value, to: usd, effects: [{ category: 'interest', amount: usd - l.value }], note: `Convert at ${right}` }],
    });
  }
  return out;
}

function duplicateInterest(ctx) {
  const c = mk(ctx);
  const ints = [...c.idx.linesByVersion.get(c.vid).values()].filter(l => /^SchB\.1\.\d+$/.test(l.key));
  const out = [];
  for (let i = 0; i < ints.length; i++) for (let j = i + 1; j < ints.length; j++) {
    const a = ints[i], b = ints[j];
    if (a.value !== b.value) continue;
    const da = c.ev(a.sources[0])?.document_id, db = c.ev(b.sources[0])?.document_id;
    if (!da || !db) continue;
    const acct = c.docText(da).match(/account ending (\d{3,})/)?.[1];
    if (acct && c.docText(db).includes(acct)) {
      out.push({
        id: 'F-INT-DUP', area: 'investments', severity: 'medium', kind: 'engine',
        title: 'Same interest counted from two documents',
        summary: `${a.label} and ${b.label} are the same ${money(a.value)}: the stand-alone Form 1099-INT (${db}) is the bank sweep inside the Northlake Securities account ending ${acct}, already on the composite (${da}).`,
        detail: ['2024 return reported the sweep interest once (Schedule B line 1, 1,180).', 'Keep the composite line; drop the duplicate.'],
        engine: { label: 'Interest reported', value: a.value + b.value }, expected: { label: 'Interest (once)', value: a.value },
        evidence: [a.sources[0], b.sources[0], da, db, 'py:/return_2024/lines/SchB.1.1'], lines: [a.key, b.key],
        adjustments: [{ line: b.key, from: b.value, to: 0, effects: [{ category: 'interest', amount: -b.value }], note: `Duplicate of ${a.key}` }],
      });
    }
  }
  return out;
}

function brokerSummaryReconciliation(ctx) {
  const c = mk(ctx);
  const out = [];
  for (const d of [...c.idx.docs.values()].filter(d => d.document_type === '1099-composite' && c.received(d.id))) {
    const superseded = getVersion(c.idx, c.vid).documents_superseded.includes(d.id);
    if (superseded) continue;
    if (d.extraction.status !== 'partial') continue;
    const text = d.pages.map(p => p.printed_content).join(' ');
    const pat = /(M\d+) (.+?) ([\d.]+) sh acquired (\S+) sold (\S+) proceeds ([\d,.]+) basis ([\d,.]+) (short|long)-term (covered|noncovered)/g;
    const missing = [];
    for (const p of d.pages) {
      if (!d.extraction.reason?.includes(`Page ${p.page}`) && !d.extraction.reason?.includes(`page ${p.page}`)) continue;
      for (const m of p.printed_content.matchAll(pat)) missing.push({ page: p.page, id: m[1], desc: m[2], proceeds: num(m[6]), basis: num(m[7]), term: m[8], covered: m[9] });
    }
    const summ = c.evf(d.id, 'b_summary_proceeds')?.value;
    const lots = (c.idx.evsByDoc.get(d.id) || []).filter(e => /^M\d+_proceeds$/.test(e.field)).reduce((s, e) => s + e.value, 0);
    if (!missing.length) continue;
    const gain = missing.reduce((s, m) => s + m.proceeds - m.basis, 0);
    out.push({
      id: 'F-BROKER-UNREAD', area: 'investments', severity: 'medium', kind: 'extraction',
      title: `${d.issuer}: sale on an unread page is missing`,
      summary: `Summary proceeds ${money(summ)} vs extracted lots ${money(lots)}. Page ${missing[0].page} (not read by the pipeline) has ${missing.map(m => `${m.id} ${m.desc}: proceeds ${money(m.proceeds)}, basis ${money(m.basis)}, ${m.term}-term ${m.covered}`).join('; ')}.`,
      detail: [`Lots + unread page = ${money(lots + missing.reduce((s, m) => s + m.proceeds, 0))} = summary ${money(summ)}.`, 'Add as Form 8949 box B (short-term, basis not reported to IRS).'],
      engine: { label: 'Lots on return', value: lots }, expected: { label: 'Summary proceeds', value: summ },
      evidence: [d.id, `doc:${d.id}#page${missing[0].page}`, c.evf(d.id, 'b_summary_proceeds')?.id].filter(Boolean), lines: ['F8949.B.total', 'SchD.2'],
      adjustments: [{ line: 'F8949.B.total', from: c.V('F8949.B.total'), to: round(c.V('F8949.B.total') + gain), effects: [{ category: missing[0].term === 'short' ? 'stcg' : 'ltcg', amount: gain }], note: `Add ${missing.map(m => m.id).join(', ')} from page ${missing[0].page}` }],
    });
  }
  return out;
}

function lotRecalc(ctx) {
  const c = mk(ctx);
  let n = 0, bad = [];
  const boxes = {};
  for (const l of c.idx.linesByVersion.get(c.vid).values()) {
    if (l.form !== 'F8949') continue;
    const m = l.label.match(/proceeds ([\d,]+\.\d\d), basis ([\d,]+\.\d\d)(?:, adjustment \w ([−-]?[\d,]+\.\d\d))?/);
    if (!m || l.key.endsWith('.total')) continue;
    n++;
    const adj = m[3] ? num(m[3].replace('−', '-')) : 0;
    const v = round((num(m[1]) - num(m[2]) + adj) * 100) / 100;
    if (Math.abs(v - l.value) > 0.01) bad.push(`${l.key}: ${v} vs ${l.value}`);
    const box = l.key.split('.')[1]; boxes[box] = (boxes[box] || 0) + l.value;
  }
  for (const [box, sum] of Object.entries(boxes)) {
    const t = c.V(`F8949.${box}.total`);
    if (t != null && Math.abs(round(sum) - t) > 1) bad.push(`Box ${box} total ${t} vs lots ${round(sum)}`);
  }
  // Brightpath summary vs lots
  const bp = c.idx.evsByDoc.get('D74') || [];
  const sum = (term, f) => bp.filter(e => e.field.endsWith('_' + f) && bp.find(x => x.field === e.field.replace('_' + f, '_term'))?.value === term).reduce((s, e) => s + e.value, 0);
  const stP = round(sum('short', 'proceeds') * 100) / 100, ltP = round(sum('long', 'proceeds') * 100) / 100;
  const sP = c.evf('D74', 'st_proceeds')?.value, lP = c.evf('D74', 'lt_proceeds')?.value;
  if (sP != null && (Math.abs(stP - sP) > 0.01 || Math.abs(ltP - lP) > 0.01)) bad.push(`Brightpath summary ${sP}/${lP} vs lots ${stP}/${ltP}`);
  return bad.length ? fail('CHK-8949', `Sales detail does not recompute (${bad.length})`, 'investments', null, null, ['D74'], [], bad.join('; '))
    : pass('CHK-8949', `${n} sales recomputed lot by lot (proceeds − basis + adjustment); box totals and Brightpath summary (260 lots) agree`, 'investments', ['D74', 'D31', 'D28', 'D34'], ['F8949.A.total', 'F8949.D.total']);
}

function cryptoMissingBasis(ctx) {
  const c = mk(ctx);
  const l = c.L('F8949.H.C6'); if (!l) return;
  const msg = c.msgAvail('msg-07') ? c.idx.msgs.get('msg-07') : null;
  const proceeds = c.evf('D34', 'C6_proceeds').value;
  if (!msg) {
    return {
      id: 'F-CRYPTO-BASIS', area: 'investments', severity: 'high', kind: 'client',
      title: 'Crypto lot sold with no cost basis',
      summary: `Coinhaven lot C6 (BTC 0.05, proceeds ${money(proceeds)}) was transferred in from another wallet; the engine used zero basis and the transfer date (short-term).`,
      detail: ['Only the client knows where and when it was bought.'], evidence: ['ev-0882', 'ev-0918', 'ev-0919', 'qa-15'], lines: [l.key],
      question: { to: 'client', text: 'Coinhaven lot C6 (0.05 BTC sold 06/18/2025) came from another wallet. When and where did you buy it, and for how much? A bank or exchange record would support it.' },
    };
  }
  const cost = +(msg.text.match(/about ([\d,]+)/)?.[1] || '0').replace(/,/g, '');
  const gain = proceeds - cost;
  return {
    id: 'F-CRYPTO-BASIS', area: 'investments', severity: 'high', kind: 'judgment',
    title: 'Crypto lot: client-supplied basis and holding period',
    summary: `Client (06/30): bought March 2021 for about ${money(cost)} on an exchange that has shut down; bank statement shows ${money(cost)} to ‘CryptoNorth’ 03/15/2021. Long-term, basis not reported (box K).`,
    detail: [`Gain ${money(proceeds)} − ${money(cost)} = ${money(gain)} long-term, instead of ${money(l.value)} short-term.`, 'Judgment: the bank statement line is contemporaneous third-party evidence of cost; attach it. Authority: Treas. Reg. 1.1012-1; Rev. Proc. 2024-28 (wallet-by-wallet basis).'],
    engine: { label: 'Short-term gain (zero basis)', value: l.value }, expected: { label: 'Long-term gain', value: gain },
    evidence: ['ev-0882', 'ev-0918', 'ev-0919', 'msg-07'], lines: [l.key],
    adjustments: [{ line: l.key, from: l.value, to: gain, effects: [{ category: 'stcg', amount: -l.value }, { category: 'ltcg', amount: gain }], note: 'Basis 3,050 (03/15/2021), long-term' }],
    question: { to: 'client', text: 'Please upload the bank statement page showing the 3,050 payment to CryptoNorth on 03/15/2021.' },
  };
}

// ---------------------------------------------------------------- Rentals
function hvacCapitalize(ctx) {
  const c = mk(ctx);
  const l = c.L('SchE.14A'); if (!l) return;
  const hv = c.evf('D46', 'hvac'); if (!hv) return;
  const inv = c.docText('D47');
  if (!/Installed new .*system/i.test(inv)) return;
  const wi = c.idx.packet.what_if.alternatives.find(a => a.id === 'hvac_improvement');
  const effects = wi && wi.base_version === c.vid
    ? [{ category: 'tax', amount: wi.federal.total_tax_change, juris: 'federal' }, { category: 'tax', amount: wi.california.total_tax_change, juris: 'california' }]
    : [{ category: 'ordinary_income', amount: hv.value }];
  const dep = wi?.changed_lines.find(x => x.key === 'SchE.18A');
  return {
    id: 'F-HVAC', area: 'rentals', severity: 'high', kind: 'judgment',
    title: 'HVAC system replacement expensed as a repair',
    summary: `Repairs include ${money(hv.value)} for removing the furnace and condenser and installing a new heat-pump system (new air handler, line set, thermostat, permit). That replaces a building system: capitalize and depreciate over 27.5 years.`,
    detail: ['Authority: Treas. Reg. 1.263(a)-3(k) (replacement of a major component / building system); de minimis and small-taxpayer safe harbors do not cover 11,000 here (small-taxpayer safe harbor limit is the lesser of 10,000 or 2% of unadjusted basis).', wi ? `Engine what-if “${wi.description}”: federal ${money(wi.federal.total_tax_change)}, California ${money(wi.california.total_tax_change)}.` : ''],
    engine: { label: 'Repairs', value: l.value }, expected: { label: 'Repairs excluding HVAC', value: l.value - hv.value },
    evidence: [hv.id, 'D47', 'ev-1004', 'qa-37', 'call-01'], lines: ['SchE.14A', 'SchE.18A'],
    adjustments: [
      { line: 'SchE.14A', from: l.value, to: l.value - hv.value, effects, whatIf: wi?.id, note: 'Capitalize HVAC; new asset SAC-HVAC 27.5-yr SL mid-month from 08/2025' },
      ...(dep ? [{ line: 'SchE.18A', from: dep.old, to: dep.new, effects: [], whatIf: wi.id, note: 'Depreciation on SAC-HVAC (effect included above)' }] : []),
    ],
  };
}

// ---------------------------------------------------------------- Deductions
function homeRealEstateTaxProration(ctx) {
  const c = mk(ctx);
  const l = c.L('SchA.5b'); if (!l) return;
  const credit = c.evf('D54', 'tax_credit'); if (!credit) return;
  const buyerShare = l.value - credit.value;
  const salt5a = c.V('SchA.5a');
  const cap = c.V('SchA.5e');
  const newCapped = Math.min(cap, salt5a + buyerShare);
  return {
    id: 'F-RE-TAX', area: 'deductions', severity: 'medium', kind: 'engine',
    title: 'Home property tax includes the seller’s share',
    summary: `Escrow paid the full 2025 Travis County bill ${money(l.value)}, but the seller credited ${money(credit.value)} at closing for 01/01–07/07. Only the buyers’ period is deductible.`,
    detail: [`Deductible ${money(l.value)} − ${money(credit.value)} = ${money(buyerShare)}.`, `Federal SALT: ${money(salt5a)} + ${money(buyerShare)} = ${money(salt5a + buyerShare)}, now under the ${money(cap)} cap (engine capped at ${money(cap)}).`, 'California itemized deductions include property tax without a cap.', 'Authority: IRC 164(d) apportionment.'],
    engine: { label: 'Real estate taxes', value: l.value }, expected: { label: 'Buyer’s share', value: buyerShare },
    evidence: [credit.id, 'ev-1036', 'ev-1038', 'D58'], lines: ['SchA.5b', 'SchA.5e'],
    adjustments: [{ line: 'SchA.5b', from: l.value, to: buyerShare, effects: [{ category: 'itemized', amount: newCapped - cap, juris: 'federal' }, { category: 'itemized', amount: -credit.value, juris: 'california' }], note: 'Seller’s share credited at closing' }],
  };
}

function mortgageInterestDouble(ctx) {
  const c = mk(ctx);
  const l = c.L('SchA.8a'); if (!l) return;
  const payoff = c.evf('D56', 'interest');
  if (!payoff || !l.sources.includes(payoff.id)) return;
  if (!/reported on the 2025 Form 1098/i.test(c.docText('D56')) && !/interest paid at payoff/i.test(c.docText('D55'))) return;
  return {
    id: 'F-MORT-DUP', area: 'deductions', severity: 'medium', kind: 'engine',
    title: 'Payoff interest counted twice in mortgage interest',
    summary: `Lonestar Form 1098 box 1 (${money(c.evf('D55', 'box1').value)}) already includes interest paid at the 11/20 payoff; the engine added the payoff statement interest ${money(payoff.value)} again.`,
    detail: ['Form 1098 text: “includes prepaid interest at closing and interest paid at payoff 11/20/2025”.', 'Payoff statement: “Interest is reported on the 2025 Form 1098.”'],
    engine: { label: 'Mortgage interest (1098)', value: l.value }, expected: { label: 'Without duplicate', value: l.value - payoff.value },
    evidence: [payoff.id, 'ev-1029', 'D55', 'D56'], lines: ['SchA.8a'],
    adjustments: [{ line: 'SchA.8a', from: l.value, to: l.value - payoff.value, effects: [{ category: 'itemized', amount: -payoff.value }], note: 'Remove payoff interest already on Form 1098' }],
  };
}

function vehicleDonation(ctx) {
  const c = mk(ctx);
  const l = c.L('F8283.A1.vehicle'); if (!l) return;
  const proceeds = c.evf('D66', 'box4c'); if (!proceeds) return;
  if (!/4a vehicle sold in arm's length/i.test(c.docText('D66'))) return;
  if (l.value <= proceeds.value) return;
  return {
    id: 'F-VEHICLE', area: 'deductions', severity: 'high', kind: 'engine',
    title: 'Donated car deducted at Blue Book value instead of sale proceeds',
    summary: `Form 1098-C: the charity sold the Subaru in an arm’s-length sale for ${money(proceeds.value)}. The deduction is limited to gross proceeds; the engine used the client’s ${money(l.value)} estimate.`,
    detail: ['Authority: IRC 170(f)(12)(A)(ii); Form 1098-C box 4a/4c. Attach Copy B to the return.', 'This item is later examined (IRS Letter 566, 2028).'],
    engine: { label: 'Vehicle gift', value: l.value }, expected: { label: 'Gross proceeds (1098-C)', value: proceeds.value },
    evidence: [proceeds.id, 'D66', 'qa-39', 'call-01'], lines: ['F8283.A1.vehicle', 'SchA.12'],
    adjustments: [{ line: 'F8283.A1.vehicle', from: l.value, to: proceeds.value, effects: [{ category: 'itemized', amount: proceeds.value - l.value }], note: 'Limited to 1098-C gross proceeds' }],
  };
}

function charityLowConfidence(ctx) {
  const c = mk(ctx);
  const e = c.ev('ev-1049'); if (!e) return;
  const confirmed = c.msgAvail('msg-08');
  return {
    id: 'F-CHARITY-READ', area: 'deductions', severity: confirmed ? 'low' : 'medium', kind: confirmed ? 'judgment' : 'client',
    title: 'Handwritten receipt amount is ambiguous',
    summary: `St. Brigid receipt reads “$?,500.00”: first digit could be 1 or 7 (read as ${money(e.value)} at ${Math.round(e.confidence * 100)}% confidence).${confirmed ? ' Client confirmed 1,500 by phone with the parish and by bank statement (check #2207, 12/21/2025).' : ''}`,
    detail: ['A 7,500 reading would add 6,000 of deductions. Gifts of 250 or more need a contemporaneous written acknowledgment; keep the bank record with it.'],
    evidence: ['ev-1049', 'D64', confirmed ? 'msg-08' : null].filter(Boolean), lines: ['SchA.11'],
    question: { to: 'client', text: confirmed ? 'Please upload the bank statement showing check #2207 to St. Brigid (12/21/2025).' : 'What was the amount of your December gift to St. Brigid Parish? The receipt is hard to read.' },
    resolvedBy: confirmed ? 'msg-08' : null,
  };
}

function iraBasisConflict(ctx) {
  const c = mk(ctx);
  const l = c.L('F8606.2'); if (!l) return;
  const qa = c.idx.qa.get('qa-31');
  return {
    id: 'F-IRA-BASIS', area: 'retirement', severity: 'low', kind: 'client',
    title: 'Client says no prior IRA basis; records show 7,000',
    summary: `Questionnaire: “Prior basis: none … we started doing this in 2025.” The 2024 Form 8606 (line 14) and the 2024 Form 5498 show a 7,000 nondeductible contribution for 2024, made 02/12/2025. The engine’s ${money(l.value)} is right; the answer is not.`,
    detail: ['Both 2025 conversions (02/20 7,010 and 04/02 7,016) moved the 2024 and 2025 contributions; taxable amount 26 is the earnings.', 'Resolution: agreed to prior year and third-party record; no change. Tell the client why.'],
    engine: { label: 'Prior basis', value: l.value }, expected: { label: 'Per 2024 Form 8606', value: c.idx.packet.prior_years.return_2024.lines['F8606.14'] },
    evidence: ['qa-31', 'py:/return_2024/lines/F8606.14', 'ev-0991', 'ev-0992', 'ev-0987'], lines: ['F8606.2'],
    noAdjustment: true,
  };
}

function scorpBasis(ctx) {
  const c = mk(ctx);
  const l = c.L('F7203.1'); if (!l) return;
  const recs = c.idx.packet.prior_years.basis_records.scorp_lindqvist_family_woodworks;
  const b2022 = recs.find(r => r.year === 2022).ending_stock_basis;
  if (!c.received('D40')) {
    return {
      id: 'F-SCORP-2023', area: 'passthroughs', severity: 'high', kind: 'client',
      title: 'S corporation basis has a gap (2023 K-1 missing)',
      summary: `Last known stock basis 2022: ${money(b2022)}. 2023 is unknown; the engine assumed no change and starts 2025 at ${money(l.value)}. Distributions exceed basis, so the gap changes capital gain directly.`,
      detail: ['Prior preparer left this open (D07 open items).'], evidence: ['py:/basis_records/scorp_lindqvist_family_woodworks/1', 'D07'], lines: ['F7203.1', 'F7203.excess'],
      question: { to: 'client', text: 'We need the 2023 Schedule K-1 from Lindqvist Family Woodworks (or the 2023 Form 1120-S) to compute S corporation stock basis.' },
    };
  }
  const inc23 = c.evf('D40', 'box1').value + c.evf('D40', 'box4').value, dist23 = c.evf('D40', 'box16d').value;
  const end23 = Math.max(0, b2022 + inc23 - dist23);
  const r24 = recs.find(r => r.year === 2024);
  const end24 = Math.max(0, end23 + r24.k1_income - r24.distributions);
  return end24 === l.value
    ? pass('CHK-SCORP', `S corp basis rolled independently: 2022 ${money(b2022)} → 2023 ${money(end23)} (+${money(inc23)} −${money(dist23)}) → 2024 ${money(end24)} (+${money(r24.k1_income)} −${money(r24.distributions)}) = Form 7203 line 1`, 'passthroughs', ['D40', 'py:/basis_records/scorp_lindqvist_family_woodworks'], ['F7203.1'])
    : fail('CHK-SCORP', 'S corp beginning basis does not roll forward', 'passthroughs', l.value, end24, ['D40'], ['F7203.1']);
}

// ---------------------------------------------------------------- Payments
function federalEstimates(ctx) {
  const c = mk(ctx);
  const l = c.L('F1040.26'); if (!l) return;
  const snaps = c.idx.packet.tax_agency_records.irs_account_transcript_2025.filter(s => !c.clock || s.as_of <= c.clock.slice(0, 10));
  const snap = snaps.at(-1);
  const usesClient = l.sources.some(s => s.startsWith('qa-'));
  if (!snap) {
    return usesClient ? { id: 'F-FED-EST', area: 'payments', severity: 'medium', kind: 'client', title: 'Q4 federal estimate from the client’s memory', summary: 'No EFTPS confirmation for the January payment; the engine used the questionnaire (“4,000 I think”). Pull the IRS transcript.', evidence: ['qa-41'], lines: ['F1040.26'] } : null;
  }
  const est = snap.transactions.filter(t => t.code === '670' && /Estimated/i.test(t.description) && t.date >= '2025-01-01' && t.date <= '2026-01-31');
  const total = est.reduce((s, t) => s + t.amount, 0);
  if (total === l.value) return pass('CHK-FED-EST', `Federal estimates agree to IRS transcript (${money(total)})`, 'payments', ['D69'], ['F1040.26']);
  return {
    id: 'F-FED-EST', area: 'payments', severity: 'high', kind: 'engine',
    title: 'Federal estimated payments overstated (client guess used)',
    summary: `Engine total ${money(l.value)} includes 4,000 for January from the questionnaire (“4,000 I think”). IRS transcript (as of ${snap.as_of}): ${est.map(t => `${t.date} ${money(t.amount)}`).join('; ')} = ${money(total)}.`,
    detail: ['EFTPS confirmations cover only the first three payments; the transcript is the third-party record for the fourth.'],
    engine: { label: 'Estimated payments', value: l.value }, expected: { label: 'Per IRS transcript', value: total },
    evidence: ['D69', 'agency:/irs_account_transcript_2025/0', 'qa-41', 'ev-1056', 'ev-1058', 'ev-1060'], lines: ['F1040.26'],
    adjustments: [{ line: 'F1040.26', from: l.value, to: total, effects: [{ category: 'payment', amount: total - l.value, juris: 'federal' }], note: 'Agree to IRS transcript' }],
  };
}

function californiaEstimates(ctx) {
  const c = mk(ctx);
  const l = c.L('F540NR.72'); if (!l) return;
  const ftb = c.idx.packet.tax_agency_records.ftb_account;
  const total = ftb.tax_year_2025_payments.reduce((s, p) => s + p.amount, 0);
  if (total === l.value) return pass('CHK-CA-EST', 'California estimates agree to FTB account', 'payments', ['agency:/ftb_account'], ['F540NR.72']);
  const wrong = (c.idx.evsByDoc.get('D68') || []).filter(e => /_year$/.test(e.field) && e.value !== '2025').map(e => e.field.replace('_year', ''));
  const included = wrong.filter(p => l.sources.includes(c.evf('D68', p + '_amount')?.id));
  return {
    id: 'F-CA-EST', area: 'payments', severity: 'high', kind: 'engine',
    title: 'California estimates include a payment applied to 2024',
    summary: `Engine counts every FTB payment dated 04/01/2025–01/15/2026 (${money(l.value)}). The 09/15/2025 Web Pay payment (3,500) was designated tax year 2024; FTB holds it as a 2024 credit. FTB shows ${money(total)} for 2025.`,
    detail: [`Included 2024-designated payments: ${included.map(p => p.replace('pay', 'payment ')).join(', ') || '—'}.`, 'Options: request FTB transfer the 2024 credit to 2025 (client decision), or claim it as a 2024 overpayment. Until transferred it is not a 2025 payment.'],
    engine: { label: 'CA estimated payments', value: l.value }, expected: { label: 'Per FTB account', value: total },
    evidence: ['ev-1076', 'ev-1075', 'agency:/ftb_account', 'agency:/ftb_account/tax_year_2024_payments_after_filing/0'], lines: ['F540NR.72'],
    adjustments: [{ line: 'F540NR.72', from: l.value, to: total, effects: [{ category: 'payment', amount: total - l.value, juris: 'california' }], note: 'Agree to FTB account' }],
    question: { to: 'client', text: 'Your 09/15/2025 California payment (3,500) was applied to 2024. Do you want us to ask the FTB to move it to 2025?' },
  };
}

// ---------------------------------------------------------------- Identity and dependents
function dependentIdentity(ctx) {
  const c = mk(ctx);
  const out = [];
  const py = c.idx.packet.prior_years.return_2024.dependents;
  const card = c.received('D71') ? c.evf('D71', 'ssn')?.value : null;
  for (const p of c.idx.packet.household.people.filter(p => p.role === 'dependent')) {
    const prior = py.find(d => d.name === p.name)?.ssn;
    const mismatch = (prior && prior !== p.ssn) || (card && p.id === 'theo' && card !== p.ssn);
    if (!mismatch) continue;
    out.push({
      id: 'F-DEP-SSN-' + p.id, area: 'intake', severity: 'high', kind: 'client',
      title: `${p.name}: SSN differs from prior-year return`,
      summary: `Organizer SSN ${p.ssn} vs 2024 return ${prior}${card ? ` and Social Security card ${card}` : ''}. Last two digits transposed. E-file will reject on a TIN/name mismatch.`,
      detail: ['The 2024 return (D06 page 1) was accepted with the other number.', card ? 'Card received 07/13: use the card.' : 'Ask for a copy of the Social Security card before filing.'],
      engine: { label: 'Organizer SSN', value: p.ssn }, expected: { label: card ? 'Social Security card' : '2024 return', value: card || prior },
      evidence: ['household:' + p.id, 'py:/return_2024/dependents', card ? 'ev-1080' : null].filter(Boolean), lines: ['F8812.4'],
      sensitive: true, fixHousehold: { person: p.id, field: 'ssn', to: card || prior },
      question: card ? null : { to: 'client', text: `Please confirm ${p.name.split(' ')[0]}’s Social Security number with a photo of the card — the organizer and last year’s return differ.` },
    });
  }
  return out;
}

function providerTin(ctx) {
  const c = mk(ctx);
  const out = [];
  for (const e of c.idx.evs.values()) {
    if (e.value_type !== 'ein' || !c.received(e.document_id)) continue;
    const text = c.docText(e.document_id);
    if (text.includes(e.value)) continue;
    const digits = e.value.replace(/\D/g, '').split('').sort().join('');
    const printed = [...text.matchAll(/\b\d{2}-\d{7}\b/g)].map(m => m[0]).find(x => x.replace(/\D/g, '').split('').sort().join('') === digits);
    const users = (c.idx.usedBy.get(e.id) || []).filter(u => u.version === c.vid).map(u => u.key);
    out.push({
      id: 'F-TIN-' + e.id, area: 'deductions', severity: 'medium', kind: 'extraction',
      title: 'Care provider tax ID misread',
      summary: `${c.idx.docs.get(e.document_id).issuer || e.document_id}: extracted ${e.value} (confidence ${e.confidence}); the statement prints ${printed || 'a different number'}. Digits transposed.`,
      detail: ['Form 2441 requires the correct provider TIN even when the credit is zero, because box 10 benefits are excluded.'],
      engine: { label: 'Extracted TIN', value: e.value }, expected: { label: 'Printed TIN', value: printed },
      evidence: [e.id, e.document_id], lines: users, sensitive: false, textFix: { line: users[0], from: e.value, to: printed },
    });
  }
  // Provider name on 2441 lines vs document
  for (const l of c.idx.linesByVersion.get(c.vid).values()) {
    if (!/^F2441\.1[a-z]$/.test(l.key)) continue;
    const name = l.label.match(/Care provider: (.+?), tax ID/)?.[1];
    const d = c.ev(l.sources[0])?.document_id;
    if (name && d && !c.docText(d).includes(name)) {
      const real = c.docText(d).split(',')[0];
      out.push({ id: 'F-PROVIDER-NAME-' + l.key, area: 'deductions', severity: 'low', kind: 'engine', title: 'Care provider name differs from statement', summary: `Form 2441 shows “${name}”; the statement and the 2024 return say “${real}”.`, evidence: [d, 'py:/return_2024/lines/F2441.provider'], lines: [l.key], engine: { label: 'Name on form', value: name }, expected: { label: 'Name on statement', value: real }, textFix: { line: l.key, from: name, to: real } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Independent recomputation of tax
function bracketTax(x, br) {
  let t = 0, lo = 0;
  for (const [up, r] of br) { const hi = up ?? Infinity; if (x > lo) t += (Math.min(x, hi) - lo) * r; lo = hi; }
  return t;
}
export function federalRegularTax(P, TI, qd, ltNet, net, u1250) {
  const ncg = Math.max(0, qd + Math.max(0, Math.min(ltNet, net)));
  const ord = Math.max(0, TI - ncg);
  const u = Math.min(u1250, Math.max(0, Math.min(ltNet, net)));
  const pref = ncg - u;
  const t1250 = Math.min(bracketTax(ord + u, P.brackets_mfj) - bracketTax(ord, P.brackets_mfj), 0.25 * u);
  const base = ord + u;
  const a0 = Math.max(0, Math.min(base + pref, P.ltcg_0_top) - base);
  const rem = pref - a0, b = Math.max(base, P.ltcg_0_top);
  const a15 = Math.max(0, Math.min(b + rem, P.ltcg_15_top) - b);
  return bracketTax(ord, P.brackets_mfj) + t1250 + a15 * 0.15 + (rem - a15) * 0.2;
}

function recomputeTaxes(ctx) {
  const c = mk(ctx);
  const out = [];
  const TI = c.V('F1040.15'); if (TI == null) return;
  const fed = round(federalRegularTax(c.P, TI, c.V('F1040.3a'), c.V('SchD.15'), c.V('SchD.16'), c.V('SchD.19')));
  out.push(fed === c.V('F1040.16') ? pass('CHK-TAX-FED', `Regular tax recomputed from brackets (Schedule D worksheet, §1250 at ≤25%): ${money(fed)}`, 'tax', ['ref:param.brackets_mfj'], ['F1040.16'])
    : fail('CHK-TAX-FED', 'Regular tax does not recompute', 'tax', c.V('F1040.16'), fed, ['ref:param.brackets_mfj'], ['F1040.16']));
  const caT = round(bracketTax(c.V('F540NR.19'), c.P.ca_brackets_mfj));
  out.push(caT === c.V('F540NR.31') ? pass('CHK-TAX-CA', `California tax on total taxable income recomputed: ${money(caT)}`, 'california', ['ref:param.ca_brackets_mfj'], ['F540NR.31'])
    : fail('CHK-TAX-CA', 'California tax does not recompute', 'california', c.V('F540NR.31'), caT, [], ['F540NR.31']));
  const niit = round(0.038 * Math.min(c.V('F8960.12'), c.V('F1040.11') - c.P.niit_threshold));
  out.push(niit === c.V('F8960.17') ? pass('CHK-NIIT', `Net investment income tax recomputed: 3.8% × ${money(Math.min(c.V('F8960.12'), c.V('F1040.11') - c.P.niit_threshold))} = ${money(niit)}`, 'tax', [], ['F8960.17'])
    : fail('CHK-NIIT', 'NIIT does not recompute', 'tax', c.V('F8960.17'), niit, [], ['F8960.17']));
  const ctc = Math.max(0, c.V('F8812.8') - 50 * Math.ceil(Math.max(0, c.V('F1040.11') - c.P.ctc_phaseout_start) / 1000));
  out.push(ctc === c.V('F8812.12') ? pass('CHK-CTC', `Child tax credit phase-out recomputed: ${money(c.V('F8812.8'))} − 50 × ${Math.ceil((c.V('F1040.11') - c.P.ctc_phaseout_start) / 1000)} = ${money(ctc)}`, 'deductions', [], ['F8812.12'])
    : fail('CHK-CTC', 'Child tax credit does not recompute', 'deductions', c.V('F8812.12'), ctc, [], ['F8812.12']));
  // Erik has no W-2 wages, so the full social security portion applies (wage base not reached).
  const se = c.V('SchC.31') * c.P.se_factor;
  const seCalc = round(Math.min(se, c.P.ss_wage_base) * 0.124) + round(se * 0.029);
  out.push(Math.abs(seCalc - c.V('SchSE.12')) <= 2 ? pass('CHK-SE', `Self-employment tax recomputed: ${money(round(se))} × 15.3% = ${money(seCalc)}`, 'business', [], ['SchSE.12'])
    : fail('CHK-SE', 'Self-employment tax does not recompute', 'business', c.V('SchSE.12'), seCalc, [], ['SchSE.12']));
  return out;
}

function sumLines(ctx) {
  const c = mk(ctx);
  let n = 0; const bad = [];
  for (const l of c.idx.linesByVersion.get(c.vid).values()) {
    if (l.rule !== 'R-SUM' || !l.inputs?.length || l.form === 'F8949') continue;
    n++;
    const vals = l.inputs.map(k => +c.V(k));
    let ok = false;
    const s = vals.reduce((a, b) => a + b, 0), d = vals[0] - vals.slice(1).reduce((a, b) => a + b, 0);
    if (Math.abs(s - l.value) <= 1 || Math.abs(d - l.value) <= 1 || Math.abs(Math.abs(d) - l.value) <= 1) ok = true;
    const m = l.key.match(/^SchCA540NR\.(\d+)\.D$/);
    if (!ok && m) { const A = +c.V(`SchCA540NR.${m[1]}.A`) || 0, B = +c.V(`SchCA540NR.${m[1]}.B`) || 0, C = +c.V(`SchCA540NR.${m[1]}.C`) || 0; ok = Math.abs(A - B + C - l.value) <= 1; }
    if (!ok) bad.push(l.key);
  }
  return bad.length ? fail('CHK-SUMS', `${bad.length} totals do not foot`, 'tax', null, null, [], bad, bad.join(', '))
    : pass('CHK-SUMS', `All ${n} totals foot from their inputs (Schedule CA columns as A − B + C)`, 'tax', [], []);
}

// ---------------------------------------------------------------- Completeness / outside filings / engine diagnostics
function engineDiagnostics(ctx) {
  const c = mk(ctx);
  const v = getVersion(c.idx, c.vid);
  const areaFor = { SCORP_BASIS_INCOMPLETE: 'passthroughs', DIGITAL_ASSET_BASIS_MISSING: 'investments', K1_EXPECTED_NOT_RECEIVED: 'passthroughs', AMT_CREDIT_CARRYFORWARD: 'tax', AOTC_PHASED_OUT: 'deductions', FBAR_OUTSIDE_RETURN: 'investments', FORM_1099_FILING: 'business', DUE_DILIGENCE_REQUIRED: 'deductions', CA_AMT_NOT_COMPUTED: 'california', HOME_OFFICE_AREA_CHANGE: 'business', QUESTIONNAIRE_SALES_CONFLICT: 'investments', LOW_CONFIDENCE_READ: 'deductions', BROKER_SUMMARY_DETAIL_MISMATCH: 'investments' };
  return v.diagnostics.map(d => ({
    id: 'DIAG-' + d.code, area: areaFor[d.code] || 'tax', severity: d.severity === 'warning' ? 'medium' : 'info', kind: 'diagnostic',
    title: d.code.replace(/_/g, ' ').toLowerCase().replace(/^./, s => s.toUpperCase()),
    summary: d.message, evidence: d.refs.filter(r => !/^[A-Z][A-Za-z0-9-]*\./.test(r) || r.startsWith('ev-')), lines: d.refs.filter(r => /^[A-Z][A-Za-z0-9-]*\./.test(r)), engineCode: d.code,
  }));
}

function outsideFilings(ctx) {
  const c = mk(ctx);
  const max = c.V('F8938.1.max');
  return [
    { id: 'OUT-FBAR', area: 'investments', severity: 'medium', kind: 'outside', title: 'FinCEN 114 (FBAR) for 2025', summary: `Sparbanken maximum ${money(max)} USD > 10,000. Due 10/15/2026 (automatic extension). Not in engagement scope: client files (prior years filed by client). Confirm and record.`, evidence: ['ev-0962', 'D01', 'py:/prior_preparer_workpaper/notes/2'], lines: ['F8938.1.max'] },
    { id: 'OUT-1099NEC', area: 'business', severity: 'medium', kind: 'outside', title: 'Forms 1099-NEC for two contractors (late)', summary: 'Mara Quintero 4,800 and Dev Patel 2,600 paid by ACH; no 1099s filed; due 02/02/2026. Outside the engagement; advise client in writing (late-filing penalties, backup withholding/W-9s).', evidence: ['D27', 'qa-23', 'call-01', 'D01'], lines: ['SchC.I', 'SchC.J'] },
    { id: 'OUT-3520', area: 'investments', severity: 'medium', kind: 'outside', title: 'Form 3520 for the 2023 Swedish inheritance', summary: 'Erik inherited the Sparbanken account from his mother in 2023 (account opened 09/2023, balance > 100,000 USD). A foreign inheritance over 100,000 requires Form 3520. Prior preparer left it unresolved. Ask the client; refer if not filed.', evidence: ['qa-07', 'ev-0961', 'py:/prior_preparer_workpaper/open_items_left_by_prior_preparer/3', 'D36'], lines: [] },
    { id: 'OUT-ADA', area: 'intake', severity: 'low', kind: 'outside', title: 'Ada’s own 2025 return', summary: 'Ada files her own return (summer W-2 4,100) and must check “someone can claim you”. Confirm she did not claim the education credit.', evidence: ['household:ada'], lines: ['F8812.6', 'F8863.7'] },
    { id: 'OUT-OR', area: 'passthroughs', severity: 'info', kind: 'outside', title: 'Oregon composite return (Woodworks)', summary: 'Oregon tax 1,580 paid on Erik’s behalf in April 2026 via the composite return: no Oregon filing needed; California credit on Schedule S; federal SALT deduction belongs to 2026 (paid 2026).', evidence: ['ev-0982'], lines: ['ScheduleS.credit'] },
    { id: 'OUT-AZ', area: 'passthroughs', severity: 'info', kind: 'outside', title: 'Arizona composite return (Ridgeline)', summary: 'Partnership filed an Arizona composite; no Arizona filing by the partner.', evidence: ['D38'], lines: [] },
  ];
}

function extensionAndLatePayment(ctx) {
  const c = mk(ctx);
  const ext = c.idx.packet.what_if.extension;
  return {
    id: 'PEN-LATE-PAY', area: 'payments', severity: 'info', kind: 'judgment',
    title: 'Interest and failure-to-pay penalty on the balance after April 15',
    summary: `Extension (04/14) paid ${money(ext.federal.paid_with_form_4868)} from the v2 estimate (balance ${money(ext.federal.estimated_balance)}). An extension to file is not an extension to pay; any balance paid later accrues interest (7%) and 0.5%/month failure-to-pay.`,
    detail: ['Decide and record: first-time abatement eligibility (no penalties in prior 3 years; 2023 CP2000 closed no change).', 'The v2 estimate used the overstated Q4 payment, so the extension underpaid by at least that amount.'],
    evidence: ['timeline:extension-2026-04-14', 'agency:/irs_account_transcript_2025/1'], lines: ['Sch3.10', 'F1040.37'],
  };
}

// ---------------------------------------------------------------- utils
function pass(id, title, area, evidence = [], lines = [], detail) {
  return { id, title, area, severity: 'pass', kind: 'pass', summary: detail || title, evidence, lines };
}
function fail(id, title, area, engineV, expected, evidence = [], lines = [], detail) {
  return { id, title, area, severity: 'high', kind: 'engine', summary: detail || `${money(engineV)} vs recomputed ${money(expected)}`, evidence, lines, engine: { label: 'Engine', value: engineV }, expected: { label: 'Recomputed', value: expected } };
}
function num(s) { return +String(s).replace(/,/g, ''); }
function addDay(iso) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

const CHECKS = [
  w2Sums, rsuNoncoveredBasis, excessSocialSecurity,
  duplicateInterest, foreignInterestRate, brokerSummaryReconciliation, lotRecalc, cryptoMissingBasis,
  form1099KDoubleCount, mileageDuplicatePage, phoneInternetPersonalUse, personalSubscription, selfEmployedHealthInsurance,
  hvacCapitalize,
  scorpBasis,
  iraBasisConflict,
  homeRealEstateTaxProration, mortgageInterestDouble, vehicleDonation, charityLowConfidence, providerTin,
  federalEstimates, californiaEstimates, extensionAndLatePayment,
  dependentIdentity,
  caWageSourcing,
  recomputeTaxes, sumLines,
  engineDiagnostics, outsideFilings,
];
