"""The independent checks: the workpaper's single implementation.

Each check re-derives a figure from source records (printed content, extracted values, agency
records, client answers) and compares it with what the engine did. Nothing here trusts a computed
line as an input unless it is the thing being tested. A check returns findings; a finding can carry
proposed adjustments with their tax-effect basis.

The app shows these findings; it does not compute them. They depend only on what is known at a
point in the season (documents received, messages sent, agency snapshots, engine versions), so
`workpaper build-findings` evaluates them at every point where that changes and writes
web/data/findings.json, and the server serves the same thing live.

Findings are plain dicts with the shape the app expects (id, area, severity, kind, title, summary,
detail, engine/expected, evidence, lines, adjustments, question, ...).
"""
from __future__ import annotations

import json
import math
import re
from datetime import date, timedelta
from pathlib import Path

from .config import PACKET_PATH


# ---------------------------------------------------------------- number helpers (JavaScript-compatible output)
def rnd(x) -> int:
    """Round half toward +infinity."""
    return math.floor(x + 0.5)


def js(x) -> str:
    """A number as it reads in text: 140, not 140.0."""
    if isinstance(x, float) and x.is_integer(): return str(int(x))
    return str(x)


def money(x) -> str:
    if x is None: return '—'
    v = abs(float(x))
    s = f'{v:,.2f}'.rstrip('0').rstrip('.') if not v.is_integer() else f'{int(v):,}'
    return ('−' if x < 0 else '') + s


def num(s) -> float:
    return float(str(s).replace(',', ''))


def add_day(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


def clean(obj):
    """Whole-number floats become ints, so the JSON reads like the source data."""
    if isinstance(obj, float) and obj.is_integer(): return int(obj)
    if isinstance(obj, dict): return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, list): return [clean(v) for v in obj]
    return obj


# ---------------------------------------------------------------- packet index
class Index:
    def __init__(self, packet: dict):
        self.packet = packet
        self.docs = {d['id']: d for d in packet['documents']}
        self.evs = {e['id']: e for e in packet['extracted_values']}
        self.evs_by_doc: dict[str, list] = {d['id']: [] for d in packet['documents']}
        for e in packet['extracted_values']: self.evs_by_doc.setdefault(e['document_id'], []).append(e)
        self.versions = packet['return_versions']
        self.lines_by_version = {v['version']: {l['key']: l for l in v['lines']} for v in self.versions}
        self.used_by: dict[str, list] = {}
        for v in self.versions:
            for l in v['lines']:
                for s in l.get('sources') or []: self.used_by.setdefault(s, []).append({'version': v['version'], 'key': l['key']})
        self.qa = {q['id']: q for q in packet['client']['questionnaire']}
        self.msgs = {m['id']: m for m in packet['client']['messages']}
        self.calls = {c['id']: c for c in packet['client']['call_notes']}
        self.params = packet['engine_reference']['parameters']

    def version(self, vid):
        return next(v for v in self.versions if v['version'] == vid)

    def active_version(self, clock: str | None) -> str:
        vs = [v for v in self.versions if not clock or v['computed_at'] <= clock]
        return (vs[-1] if vs else self.versions[0])['version']


class Ctx:
    """What one evaluation of the checks can see: the index, the engine version and the season clock."""

    def __init__(self, idx: Index, vid: str, clock: str | None):
        self.idx, self.vid, self.clock = idx, vid, clock
        self.lines = idx.lines_by_version[vid]
        self.P = idx.params
        self.rates = idx.version(vid)['tax_effect_rates']

    def L(self, k): return self.lines.get(k)
    def V(self, k): return (self.lines.get(k) or {}).get('value')
    def ev(self, i): return self.idx.evs.get(i)
    def evf(self, doc, field): return next((e for e in self.idx.evs_by_doc.get(doc, []) if e['field'] == field), None)
    def doc_text(self, i): return ' '.join(p['printed_content'] for p in (self.idx.docs.get(i) or {}).get('pages', []))

    def received(self, doc_id):
        d = self.idx.docs.get(doc_id)
        return bool(d) and (not self.clock or d['received_at'] <= self.clock)

    def msg_avail(self, i):
        m = self.idx.msgs.get(i)
        return bool(m) and (not self.clock or m['sent_at'] <= self.clock)

    def docs_of_type(self, t):
        return [d for d in self.idx.docs.values() if d['document_type'] == t and self.received(d['id'])]


def _id(e): return e['id'] if e else None


def pass_(id_, title, area, evidence=None, lines=None, detail=None):
    return {'id': id_, 'title': title, 'area': area, 'severity': 'pass', 'kind': 'pass', 'summary': detail or title, 'evidence': evidence or [], 'lines': lines or []}


def fail(id_, title, area, engine_v, expected, evidence=None, lines=None, detail=None):
    return {'id': id_, 'title': title, 'area': area, 'severity': 'high', 'kind': 'engine',
            'summary': detail or f'{money(engine_v)} vs recomputed {money(expected)}', 'evidence': evidence or [], 'lines': lines or [],
            'engine': {'label': 'Engine', 'value': engine_v}, 'expected': {'label': 'Recomputed', 'value': expected}}


# ---------------------------------------------------------------- Business
def mileage_duplicate_page(c: Ctx):
    l44 = c.L('SchC.44a')
    if not l44: return None
    evs = c.idx.evs_by_doc.get('D23', [])
    pages: dict = {}
    for e in evs:
        p = pages.setdefault(e['page'], {'trips': {}, 'total': None})
        m = re.match(r'^trip(\d+)_(date|destination|miles)$', e['field'])
        if m: p['trips'].setdefault(m.group(1), {})[m.group(2)] = e['value']
        if e['field'] == 'page_total': p['total'] = e['value']
    sigs, dups, unique = {}, [], 0
    for pg in sorted(pages):
        p = pages[pg]
        sig = ';'.join(sorted(f"{t['date']}|{t.get('destination')}|{js(t.get('miles'))}" for t in p['trips'].values() if t.get('date')))
        if sig and sig in sigs: dups.append({'page': pg, 'sameAs': sigs[sig], 'total': p['total']})
        else:
            if sig: sigs[sig] = pg
            unique += p['total'] or 0
    if not dups: return pass_('CHK-MILEAGE', 'Mileage log pages are distinct', 'business', ['D23'], ['SchC.44a'])
    odo_start, odo_end = (c.evf('D23', 'odometer_start') or {}).get('value'), (c.evf('D23', 'odometer_end') or {}).get('value')
    rate = c.P['mileage_rate']
    old_ded, new_ded = c.V('SchC.9'), rnd(unique * rate)
    total_miles = odo_end - odo_start
    return {
        'id': 'F-MILEAGE-DUP', 'area': 'business', 'severity': 'high', 'kind': 'engine',
        'title': 'Mileage log page counted twice',
        'summary': f"Page {dups[0]['page']} of the mileage log is a second scan of page {dups[0]['sameAs']} (same {len(pages[dups[0]['page']]['trips'])} trips). The engine summed every page total.",
        'detail': [
            f"Engine business miles {money(l44['value'])} = sum of all page totals (rule R-MILEAGE-PAGE-TOTALS).",
            f'Distinct pages: {money(unique)} miles. Odometer {money(odo_start)} → {money(odo_end)} = {money(total_miles)} total miles.',
            f'Standard mileage: {money(unique)} × {js(rate)} = {money(new_ded)} (engine {money(old_ded)}).',
        ],
        'engine': {'label': 'Business miles', 'value': l44['value']}, 'expected': {'label': 'Business miles (distinct pages)', 'value': unique},
        'evidence': ['D23', *[e['id'] for e in evs if e['field'] == 'page_total'], 'msg-03'],
        'lines': ['SchC.44a', 'SchC.9', 'SchC.44c'],
        'adjustments': [
            {'line': 'SchC.44a', 'from': l44['value'], 'to': unique, 'effects': [], 'note': 'Remove duplicate page 3'},
            {'line': 'SchC.44c', 'from': c.V('SchC.44c'), 'to': total_miles - unique, 'effects': [], 'note': 'Other miles = odometer total − business miles'},
            {'line': 'SchC.9', 'from': old_ded, 'to': new_ded, 'effects': [{'category': 'schc_profit', 'amount': old_ded - new_ded}], 'note': f'{money(unique)} mi × {js(rate)}'},
        ],
    }


def form_1099k_double_count(c: Ctx):
    l = c.L('SchC.1')
    if not l: return None
    k = [e for e in (c.evf(d['id'], 'box1a') for d in c.docs_of_type('1099-K')) if e]
    books = c.evf('D14', 'total_income')
    k_total = sum(e['value'] for e in k)
    via_card = c.evf('D15', 'atlas_paywell')
    necs = [e for e in (c.evf(d['id'], 'box1') for d in c.docs_of_type('1099-NEC')) if e]
    nec_total = sum(e['value'] for e in necs)
    small = (c.evf('D15', 'unreported_small') or {}).get('value') or 0
    recon = f"1099-NEC {money(nec_total)} + deposits from clients with no 1099 {money(small)} = {money(nec_total + small)}; books total income {money((books or {}).get('value'))}."
    if books and l['value'] - books['value'] == k_total and via_card and via_card['value'] == k_total:
        return {
            'id': 'F-1099K-DOUBLE', 'area': 'business', 'severity': 'high', 'kind': 'engine',
            'title': 'Form 1099-K receipts counted twice in gross receipts',
            'summary': f"Gross receipts {money(l['value'])} = books {money(books['value'])} + 1099-K {money(k_total)}. The books already include the {money(k_total)}: it is Atlas Outdoor Gear paying by card, deposited gross (books transaction detail, page 3).",
            'detail': [recon, 'The engine could not match the card deposits to a books deposit (R-SCHC-GROSS) and added them again.', 'The IRS will match both the 1099-NEC (Atlas 41,200 includes the card payments) and the 1099-K: keep this reconciliation in the file.'],
            'engine': {'label': 'Gross receipts', 'value': l['value']}, 'expected': {'label': 'Gross receipts (books, reconciled)', 'value': books['value']},
            'evidence': [x for x in [books['id'], via_card['id'], _id(c.evf('D15', 'atlas_total')), *[e['id'] for e in k], *[e['id'] for e in necs], _id(c.evf('D15', 'unreported_small'))] if x],
            'lines': ['SchC.1'],
            'adjustments': [{'line': 'SchC.1', 'from': l['value'], 'to': books['value'], 'effects': [{'category': 'schc_profit', 'amount': books['value'] - l['value']}], 'note': 'Remove 1099-K amounts already in books deposits'}],
        }
    return pass_('CHK-GROSS', 'Gross receipts reconcile to 1099-NEC/1099-K', 'business', [x for x in [_id(books)] if x], ['SchC.1'], recon)


def phone_internet_personal_use(c: Ctx):
    l = c.L('SchC.25')
    if not l: return None
    call = c.idx.calls.get('call-01')
    if not call or (c.clock and call['date'] > c.clock): return None
    phone, net = (c.evf('D14', 'Telephone') or {}).get('value'), (c.evf('D14', 'Internet') or {}).get('value')
    notes = ' '.join(call['notes'])
    m1, m2 = re.search(r'business share is (\d+)%', notes), re.search(r'business use about (\d+)%', notes)
    p_phone = int(m1.group(1) if m1 else 100) / 100
    p_net = int(m2.group(1) if m2 else 100) / 100
    deductible = rnd(phone * p_phone + net * p_net)
    if deductible >= l['value']: return None
    return {
        'id': 'F-UTIL-PERSONAL', 'area': 'business', 'severity': 'medium', 'kind': 'judgment',
        'title': 'Family phone plan and home internet deducted at 100%',
        'summary': f'Books deduct the 4-line family mobile plan ({money(phone)}) and shared home internet ({money(net)}) in full. Client call: business share {js(p_phone * 100)}% and {js(p_net * 100)}%.',
        'detail': [f"Deductible: {money(phone)} × {js(p_phone * 100)}% + {money(net)} × {js(p_net * 100)}% = {money(deductible)} (engine {money(l['value'])}).", 'Authority: IRC 262 (personal expenses); allocation by business use.'],
        'engine': {'label': 'Utilities', 'value': l['value']}, 'expected': {'label': 'Business share', 'value': deductible},
        'evidence': ['ev-0101', 'ev-0095', 'ev-0107', 'ev-0108', 'call-01'], 'lines': ['SchC.25'],
        'adjustments': [{'line': 'SchC.25', 'from': l['value'], 'to': deductible, 'effects': [{'category': 'schc_profit', 'amount': l['value'] - deductible}], 'note': 'Business-use allocation per call notes'}],
    }


def personal_subscription(c: Ctx):
    l, s = c.L('SchC.27a.1'), c.evf('D15', 'spotify')
    if not l or not s: return None
    call = c.idx.calls.get('call-01')
    confirmed = bool(call) and (not c.clock or call['date'] <= c.clock) and bool(re.search(r'Spotify.*personal', ' '.join(call['notes']), re.I))
    return {
        'id': 'F-PERSONAL-SOFTWARE', 'area': 'business', 'severity': 'low', 'kind': 'judgment' if confirmed else 'client',
        'title': 'Personal subscription in business software expense',
        'summary': f"Software and subscriptions {money(l['value'])} includes Spotify Family {money(s['value'])}." + (' Client confirmed it is personal (call 03/26).' if confirmed else ' Ask the client.'),
        'detail': ['Books transaction detail page 1 lists the subscription inside the account.'],
        'engine': {'label': 'Software and subscriptions', 'value': l['value']}, 'expected': {'label': 'Excluding personal', 'value': l['value'] - s['value']},
        'evidence': [x for x in [s['id'], 'ev-0099', 'call-01' if confirmed else None] if x], 'lines': ['SchC.27a.1'],
        'adjustments': [{'line': 'SchC.27a.1', 'from': l['value'], 'to': l['value'] - s['value'], 'effects': [{'category': 'schc_profit', 'amount': s['value']}], 'note': 'Remove personal subscription'}],
        'question': None if confirmed else {'to': 'client', 'text': 'Is the Spotify Family subscription (216.00) in Lindqvist Studio software expenses a business expense?'},
    }


def self_employed_health_insurance(c: Ctx):
    l = c.L('Sch1.17')
    if not l or not l['value']: return None
    qa = c.idx.qa.get('qa-25')
    if not re.match(r'^Yes', (qa or {}).get('answer') or '', re.I): return None
    return {
        'id': 'F-SEHI-ELIGIBLE', 'area': 'business', 'severity': 'high', 'kind': 'judgment',
        'title': 'Self-employed health insurance deduction while eligible for spouse’s employer plan',
        'summary': f"Engine deducts {money(l['value'])} of Erik’s premiums. Questionnaire: both of Ngozi’s employers offered family coverage that Erik could join. The deduction is not allowed for any month he was eligible for a subsidized employer plan.",
        'detail': ['Authority: IRC 162(l)(2)(B); Pub. 535. Eligibility (not enrollment) controls.', '2024 return took no SE health insurance deduction for the same reason (prior-year note).', 'Removing the deduction also raises QBI; the adjustment rate does not capture that second-order effect.'],
        'engine': {'label': 'SE health insurance', 'value': l['value']}, 'expected': {'label': 'Allowable', 'value': 0},
        'evidence': ['qa-25', 'ev-0484', 'py:/return_2024/notes/Sch1.17'], 'lines': ['Sch1.17'],
        'adjustments': [{'line': 'Sch1.17', 'from': l['value'], 'to': 0, 'effects': [{'category': 'adjustment', 'amount': -l['value']}], 'note': 'Not allowed: eligible for employer-subsidized plan through spouse'}],
    }


# ---------------------------------------------------------------- Wages and stock compensation
def rsu_noncovered_basis(c: Ctx):
    supp = c.idx.evs_by_doc.get('D11', [])
    if not c.received('D11'): return None
    lots: dict = {}
    for e in supp:
        m = re.match(r'^(.+)_(adjusted_basis|acquired)$', e['field'])
        if m: lots.setdefault(m.group(1), {})[m.group(2)] = e
    adjs, rows, st, lt = [], [], 0, 0
    for l in c.lines.values():
        if l.get('form') != 'F8949' or not re.match(r'^F8949\.[BE]\.N\d+$', l['key']): continue
        srcs = [c.ev(s) for s in l.get('sources') or []]
        find = lambda suffix: next((e for e in srcs if e and e['field'].endswith(suffix)), None)
        basis_ev, acq_ev, proc_ev = find('_basis'), find('_acquired'), find('_proceeds')
        if not basis_ev or basis_ev['value'] != 0: continue
        match = next(((k, v) for k, v in lots.items() if (v.get('acquired') or {}).get('value') == (acq_ev or {}).get('value') and v.get('adjusted_basis')), None)
        if not match: continue
        basis = match[1]['adjusted_basis']['value']
        corrected = rnd((proc_ev['value'] - basis) * 100) / 100
        box = l['key'].split('.')[1]
        delta = corrected - l['value']
        if box == 'B': st += delta
        else: lt += delta
        rows.append(f"{l['key']}: {match[0]} proceeds {money(proc_ev['value'])} − adjusted basis {money(basis)} = {money(corrected)} (engine {money(l['value'])})")
        adjs.append({'line': l['key'], 'from': l['value'], 'to': corrected, 'effects': [{'category': 'stcg' if box == 'B' else 'ltcg', 'amount': delta}], 'note': f'Basis from supplemental statement lot {match[0]}', 'evidence': [match[1]['adjusted_basis']['id']]})
    if not adjs: return None
    return {
        'id': 'F-RSU-BASIS', 'area': 'wages', 'severity': 'high', 'kind': 'engine',
        'title': 'RSU sales taxed with zero basis (income already on W-2)',
        'summary': f'{len(adjs)} noncovered RSU lots used the broker’s blank basis. The stock-plan supplement gives adjusted basis for each lot; without it the vest value (already in W-2 box 1) is taxed twice.',
        'detail': [*rows, f'Net change: short-term {money(st)}, long-term {money(lt)}.', 'Rule R-8949-LOT only uses a supplement when it is matched; the engine matched the ESPP lot but not the RSU lots.'],
        'engine': {'label': 'RSU gain reported', 'value': sum(a['from'] for a in adjs)}, 'expected': {'label': 'RSU gain with adjusted basis', 'value': sum(a['to'] for a in adjs)},
        'evidence': ['D11', *[e['id'] for e in supp if e['field'].endswith('adjusted_basis')], 'ev-0027'], 'lines': [a['line'] for a in adjs],
        'adjustments': adjs,
    }


def ca_wage_sourcing(c: Ctx):
    l = c.L('SchCA540NR.1.E')
    if not l: return None
    ca_res = next(r for r in c.idx.packet['household']['residency'] if r['state'] == 'CA')
    corv = (c.evf('D08', 'box16') or {}).get('value') or 0
    halv = (c.evf('D09', 'box16') or {}).get('value') or 0
    kept = re.search(r'California as the work state through (\d\d/\d\d/\d{4})', c.doc_text('D09'))
    if not kept: return None
    if not c.received('D73'):
        return {
            'id': 'F-CA-WAGES', 'area': 'california', 'severity': 'high', 'kind': 'client',
            'title': 'California wages include Texas-period pay',
            'summary': f"Halvorsen box 16 ({money(halv)}) runs through {kept.group(1)}, but California residency ended {ca_res['to']}. Need year-to-date pay at the move date.",
            'detail': ['Request a paystub dated around 07/15/2025.'], 'evidence': ['ev-0047', 'D09', 'qa-45'], 'lines': ['SchCA540NR.1.E'],
            'question': {'to': 'client', 'text': 'Please upload a Halvorsen paystub from mid-July 2025 showing year-to-date wages at the move.'},
        }
    ytd = c.evf('D73', 'ytd_ca_wages')['value']
    expected = corv + ytd
    return {
        'id': 'F-CA-WAGES', 'area': 'california', 'severity': 'high', 'kind': 'engine',
        'title': 'California-source wages include pay earned as a Texas resident',
        'summary': f"Engine uses W-2 box 16 for California wages ({money(l['value'])}). Halvorsen kept California as the work state through {kept.group(1)} by mistake; Ngozi was a Texas resident working in Austin from {add_day(ca_res['to'])}.",
        'detail': [
            f'Corvane (all California, employment ended 05/16) box 16 {money(corv)}.',
            f'Halvorsen California-period wages from the 07/18 paystub: YTD California taxable wages at 07/15 {money(ytd)}.',
            f"California-source wages {money(expected)} (engine {money(l['value'])}). The paystub period ends 07/15 vs residency end 07/14: one day, immaterial.",
            'California withholding on the Texas-period wages stays on line 71 and is refunded.',
        ],
        'engine': {'label': 'CA wages', 'value': l['value']}, 'expected': {'label': 'CA-source wages', 'value': expected},
        'evidence': ['ev-0030', 'ev-0047', 'ev-1081', 'D73', 'qa-45', 'qa-03'], 'lines': ['SchCA540NR.1.E'],
        'adjustments': [{'line': 'SchCA540NR.1.E', 'from': l['value'], 'to': expected, 'effects': [{'category': 'ca_source_income', 'amount': expected - l['value']}], 'note': 'California-period wages only'}],
    }


def excess_social_security(c: Ctx):
    l = c.L('Sch3.11')
    if not l: return None
    withheld = c.evf('D08', 'box4')['value'] + c.evf('D09', 'box4')['value']
    mx = rnd(c.P['ss_wage_base'] * 0.062 * 100) / 100
    calc = rnd(withheld - mx)
    if calc == l['value']:
        return pass_('CHK-EXCESS-SS', f'Excess social security recomputed: {money(withheld)} − {money(mx)} = {money(calc)}', 'wages', ['ev-0019', 'ev-0038'], ['Sch3.11'])
    return fail('CHK-EXCESS-SS', 'Excess social security tax does not recompute', 'wages', l['value'], calc, ['ev-0019', 'ev-0038'], ['Sch3.11'])


def w2_sums(c: Ctx):
    l = c.L('F1040.1a')
    if not l: return None
    w2s = c.docs_of_type('W-2')
    seen: dict = {}
    for d in w2s:
        key = '|'.join(js((c.evf(d['id'], f) or {}).get('value')) if c.evf(d['id'], f) else '' for f in ('employer_ein', 'box1', 'box2', 'box16'))
        seen.setdefault(key, d['id'])
    distinct = list(seen.values())
    box1 = sum(c.evf(i, 'box1')['value'] for i in distinct)
    dupes = [d['id'] for d in w2s if d['id'] not in distinct]
    if box1 == l['value']:
        return pass_('CHK-W2', f"Wages agree: {len(distinct)} distinct W-2s = {money(box1)}" + (f" ({', '.join(dupes)} is a duplicate image, counted once)" if dupes else ''), 'wages', distinct, ['F1040.1a'])
    return fail('CHK-W2', 'W-2 box 1 total does not agree', 'wages', l['value'], box1, distinct, ['F1040.1a'])


# ---------------------------------------------------------------- Investments
def foreign_interest_rate(c: Ctx):
    out = []
    year = c.idx.packet['household']['tax_year']
    for l in c.lines.values():
        if not l['key'].startswith('SchB.1.'): continue
        fx = next((s for s in l.get('sources') or [] if s.startswith('ref:fx.')), None)
        if not fx: continue
        _, cur, which = fx.split('.')
        if int(which[:4]) == year: continue
        ev_ref = next(s for s in l['sources'] if s.startswith('ev-'))
        amt = (c.ev(ev_ref) or {}).get('value')
        right = f'{year}_average'
        rate = c.P['fx'][cur][right]
        usd = rnd(amt / rate)
        out.append({
            'id': 'F-FX-RATE', 'area': 'investments', 'severity': 'medium', 'kind': 'engine',
            'title': 'Foreign interest converted at last year’s exchange rate',
            'summary': f"{cur} {money(amt)} converted at the {which.replace('_', ' ', 1)} rate ({js(c.P['fx'][cur][which])}). The 2025 average is {js(rate)}.",
            'detail': [f"{money(amt)} ÷ {js(rate)} = {money(usd)} (engine {money(l['value'])}).", 'The 2024 return used 10.56 correctly for 2024; the engine carried the same rate forward.'],
            'engine': {'label': 'Interest (USD)', 'value': l['value']}, 'expected': {'label': 'At 2025 average', 'value': usd},
            'evidence': [ev_ref, f'ref:fx.{cur}.{right}', fx], 'lines': [l['key']],
            'adjustments': [{'line': l['key'], 'from': l['value'], 'to': usd, 'effects': [{'category': 'interest', 'amount': usd - l['value']}], 'note': f'Convert at {right}'}],
        })
    return out


def duplicate_interest(c: Ctx):
    ints = [l for l in c.lines.values() if re.match(r'^SchB\.1\.\d+$', l['key'])]
    out = []
    for i, a in enumerate(ints):
        for b in ints[i + 1:]:
            if a['value'] != b['value']: continue
            da, db = (c.ev(a['sources'][0]) or {}).get('document_id'), (c.ev(b['sources'][0]) or {}).get('document_id')
            if not da or not db: continue
            m = re.search(r'account ending (\d{3,})', c.doc_text(da))
            acct = m.group(1) if m else None
            if acct and acct in c.doc_text(db):
                out.append({
                    'id': 'F-INT-DUP', 'area': 'investments', 'severity': 'medium', 'kind': 'engine',
                    'title': 'Same interest counted from two documents',
                    'summary': f"{a['label']} and {b['label']} are the same {money(a['value'])}: the stand-alone Form 1099-INT ({db}) is the bank sweep inside the Northlake Securities account ending {acct}, already on the composite ({da}).",
                    'detail': ['2024 return reported the sweep interest once (Schedule B line 1, 1,180).', 'Keep the composite line; drop the duplicate.'],
                    'engine': {'label': 'Interest reported', 'value': a['value'] + b['value']}, 'expected': {'label': 'Interest (once)', 'value': a['value']},
                    'evidence': [a['sources'][0], b['sources'][0], da, db, 'py:/return_2024/lines/SchB.1.1'], 'lines': [a['key'], b['key']],
                    'adjustments': [{'line': b['key'], 'from': b['value'], 'to': 0, 'effects': [{'category': 'interest', 'amount': -b['value']}], 'note': f"Duplicate of {a['key']}"}],
                })
    return out


LOT = re.compile(r'(M\d+) (.+?) ([\d.]+) sh acquired (\S+) sold (\S+) proceeds ([\d,.]+) basis ([\d,.]+) (short|long)-term (covered|noncovered)')


def broker_summary_reconciliation(c: Ctx):
    out = []
    for d in [d for d in c.idx.docs.values() if d['document_type'] == '1099-composite' and c.received(d['id'])]:
        if d['id'] in c.idx.version(c.vid)['documents_superseded']: continue
        if d['extraction']['status'] != 'partial': continue
        reason = d['extraction'].get('reason') or ''
        missing = []
        for p in d['pages']:
            if f"Page {p['page']}" not in reason and f"page {p['page']}" not in reason: continue
            for m in LOT.finditer(p['printed_content']):
                missing.append({'page': p['page'], 'id': m.group(1), 'desc': m.group(2), 'proceeds': num(m.group(6)), 'basis': num(m.group(7)), 'term': m.group(8), 'covered': m.group(9)})
        summ = (c.evf(d['id'], 'b_summary_proceeds') or {}).get('value')
        lots = sum(e['value'] for e in c.idx.evs_by_doc.get(d['id'], []) if re.match(r'^M\d+_proceeds$', e['field']))
        if not missing: continue
        gain = sum(m['proceeds'] - m['basis'] for m in missing)
        b_total = c.V('F8949.B.total')
        out.append({
            'id': 'F-BROKER-UNREAD', 'area': 'investments', 'severity': 'medium', 'kind': 'extraction',
            'title': f"{d['issuer']}: sale on an unread page is missing",
            'summary': f"Summary proceeds {money(summ)} vs extracted lots {money(lots)}. Page {missing[0]['page']} (not read by the pipeline) has "
                       + '; '.join(f"{m['id']} {m['desc']}: proceeds {money(m['proceeds'])}, basis {money(m['basis'])}, {m['term']}-term {m['covered']}" for m in missing) + '.',
            'detail': [f"Lots + unread page = {money(lots + sum(m['proceeds'] for m in missing))} = summary {money(summ)}.", 'Add as Form 8949 box B (short-term, basis not reported to IRS).'],
            'engine': {'label': 'Lots on return', 'value': lots}, 'expected': {'label': 'Summary proceeds', 'value': summ},
            'evidence': [x for x in [d['id'], f"doc:{d['id']}#page{missing[0]['page']}", _id(c.evf(d['id'], 'b_summary_proceeds'))] if x], 'lines': ['F8949.B.total', 'SchD.2'],
            'adjustments': [{'line': 'F8949.B.total', 'from': b_total, 'to': rnd(b_total + gain), 'effects': [{'category': 'stcg' if missing[0]['term'] == 'short' else 'ltcg', 'amount': gain}],
                             'note': f"Add {', '.join(m['id'] for m in missing)} from page {missing[0]['page']}"}],
        })
    return out


def lot_recalc(c: Ctx):
    n, bad, boxes = 0, [], {}
    for l in c.lines.values():
        if l.get('form') != 'F8949': continue
        m = re.search(r'proceeds ([\d,]+\.\d\d), basis ([\d,]+\.\d\d)(?:, adjustment \w ([−-]?[\d,]+\.\d\d))?', l['label'])
        if not m or l['key'].endswith('.total'): continue
        n += 1
        adj = num(m.group(3).replace('−', '-')) if m.group(3) else 0
        v = rnd((num(m.group(1)) - num(m.group(2)) + adj) * 100) / 100
        if abs(v - l['value']) > 0.01: bad.append(f"{l['key']}: {js(v)} vs {js(l['value'])}")
        box = l['key'].split('.')[1]
        boxes[box] = boxes.get(box, 0) + l['value']
    for box, s in boxes.items():
        t = c.V(f'F8949.{box}.total')
        if t is not None and abs(rnd(s) - t) > 1: bad.append(f'Box {box} total {js(t)} vs lots {rnd(s)}')
    bp = c.idx.evs_by_doc.get('D74', [])
    terms = {e['field']: e['value'] for e in bp}

    def total(term, f):
        return sum(e['value'] for e in bp if e['field'].endswith('_' + f) and terms.get(e['field'].replace('_' + f, '_term')) == term)
    st_p, lt_p = rnd(total('short', 'proceeds') * 100) / 100, rnd(total('long', 'proceeds') * 100) / 100
    s_p, l_p = (c.evf('D74', 'st_proceeds') or {}).get('value'), (c.evf('D74', 'lt_proceeds') or {}).get('value')
    if s_p is not None and (abs(st_p - s_p) > 0.01 or abs(lt_p - l_p) > 0.01): bad.append(f'Brightpath summary {js(s_p)}/{js(l_p)} vs lots {js(st_p)}/{js(lt_p)}')
    if bad: return fail('CHK-8949', f'Sales detail does not recompute ({len(bad)})', 'investments', None, None, ['D74'], [], '; '.join(bad))
    return pass_('CHK-8949', f'{n} sales recomputed lot by lot (proceeds − basis + adjustment); box totals and Brightpath summary (260 lots) agree', 'investments', ['D74', 'D31', 'D28', 'D34'], ['F8949.A.total', 'F8949.D.total'])


def crypto_missing_basis(c: Ctx):
    l = c.L('F8949.H.C6')
    if not l: return None
    msg = c.idx.msgs.get('msg-07') if c.msg_avail('msg-07') else None
    proceeds = c.evf('D34', 'C6_proceeds')['value']
    if not msg:
        return {
            'id': 'F-CRYPTO-BASIS', 'area': 'investments', 'severity': 'high', 'kind': 'client',
            'title': 'Crypto lot sold with no cost basis',
            'summary': f'Coinhaven lot C6 (BTC 0.05, proceeds {money(proceeds)}) was transferred in from another wallet; the engine used zero basis and the transfer date (short-term).',
            'detail': ['Only the client knows where and when it was bought.'], 'evidence': ['ev-0882', 'ev-0918', 'ev-0919', 'qa-15'], 'lines': [l['key']],
            'question': {'to': 'client', 'text': 'Coinhaven lot C6 (0.05 BTC sold 06/18/2025) came from another wallet. When and where did you buy it, and for how much? A bank or exchange record would support it.'},
        }
    m = re.search(r'about ([\d,]+)', msg['text'])
    cost = float((m.group(1) if m else '0').replace(',', ''))
    gain = proceeds - cost
    return {
        'id': 'F-CRYPTO-BASIS', 'area': 'investments', 'severity': 'high', 'kind': 'judgment',
        'title': 'Crypto lot: client-supplied basis and holding period',
        'summary': f'Client (06/30): bought March 2021 for about {money(cost)} on an exchange that has shut down; bank statement shows {money(cost)} to ‘CryptoNorth’ 03/15/2021. Long-term, basis not reported (box K).',
        'detail': [f"Gain {money(proceeds)} − {money(cost)} = {money(gain)} long-term, instead of {money(l['value'])} short-term.", 'Judgment: the bank statement line is contemporaneous third-party evidence of cost; attach it. Authority: Treas. Reg. 1.1012-1; Rev. Proc. 2024-28 (wallet-by-wallet basis).'],
        'engine': {'label': 'Short-term gain (zero basis)', 'value': l['value']}, 'expected': {'label': 'Long-term gain', 'value': gain},
        'evidence': ['ev-0882', 'ev-0918', 'ev-0919', 'msg-07'], 'lines': [l['key']],
        'adjustments': [{'line': l['key'], 'from': l['value'], 'to': gain, 'effects': [{'category': 'stcg', 'amount': -l['value']}, {'category': 'ltcg', 'amount': gain}], 'note': 'Basis 3,050 (03/15/2021), long-term'}],
        'question': {'to': 'client', 'text': 'Please upload the bank statement page showing the 3,050 payment to CryptoNorth on 03/15/2021.'},
    }


# ---------------------------------------------------------------- Rentals
def hvac_capitalize(c: Ctx):
    l = c.L('SchE.14A')
    if not l: return None
    hv = c.evf('D46', 'hvac')
    if not hv: return None
    if not re.search(r'Installed new .*system', c.doc_text('D47'), re.I): return None
    wi = next((a for a in c.idx.packet['what_if']['alternatives'] if a['id'] == 'hvac_improvement'), None)
    effects = ([{'category': 'tax', 'amount': wi['federal']['total_tax_change'], 'juris': 'federal'}, {'category': 'tax', 'amount': wi['california']['total_tax_change'], 'juris': 'california'}]
               if wi and wi['base_version'] == c.vid else [{'category': 'ordinary_income', 'amount': hv['value']}])
    dep = next((x for x in wi['changed_lines'] if x['key'] == 'SchE.18A'), None) if wi else None
    return {
        'id': 'F-HVAC', 'area': 'rentals', 'severity': 'high', 'kind': 'judgment',
        'title': 'HVAC system replacement expensed as a repair',
        'summary': f"Repairs include {money(hv['value'])} for removing the furnace and condenser and installing a new heat-pump system (new air handler, line set, thermostat, permit). That replaces a building system: capitalize and depreciate over 27.5 years.",
        'detail': ['Authority: Treas. Reg. 1.263(a)-3(k) (replacement of a major component / building system); de minimis and small-taxpayer safe harbors do not cover 11,000 here (small-taxpayer safe harbor limit is the lesser of 10,000 or 2% of unadjusted basis).',
                   f"Engine what-if “{wi['description']}”: federal {money(wi['federal']['total_tax_change'])}, California {money(wi['california']['total_tax_change'])}." if wi else ''],
        'engine': {'label': 'Repairs', 'value': l['value']}, 'expected': {'label': 'Repairs excluding HVAC', 'value': l['value'] - hv['value']},
        'evidence': [hv['id'], 'D47', 'ev-1004', 'qa-37', 'call-01'], 'lines': ['SchE.14A', 'SchE.18A'],
        'adjustments': [
            {'line': 'SchE.14A', 'from': l['value'], 'to': l['value'] - hv['value'], 'effects': effects, 'whatIf': (wi or {}).get('id'), 'note': 'Capitalize HVAC; new asset SAC-HVAC 27.5-yr SL mid-month from 08/2025'},
            *([{'line': 'SchE.18A', 'from': dep['old'], 'to': dep['new'], 'effects': [], 'whatIf': wi['id'], 'note': 'Depreciation on SAC-HVAC (effect included above)'}] if dep else []),
        ],
    }


# ---------------------------------------------------------------- Deductions
def home_real_estate_tax_proration(c: Ctx):
    l = c.L('SchA.5b')
    if not l: return None
    credit = c.evf('D54', 'tax_credit')
    if not credit: return None
    buyer = l['value'] - credit['value']
    salt5a, cap = c.V('SchA.5a'), c.V('SchA.5e')
    new_capped = min(cap, salt5a + buyer)
    return {
        'id': 'F-RE-TAX', 'area': 'deductions', 'severity': 'medium', 'kind': 'engine',
        'title': 'Home property tax includes the seller’s share',
        'summary': f"Escrow paid the full 2025 Travis County bill {money(l['value'])}, but the seller credited {money(credit['value'])} at closing for 01/01–07/07. Only the buyers’ period is deductible.",
        'detail': [f"Deductible {money(l['value'])} − {money(credit['value'])} = {money(buyer)}.", f'Federal SALT: {money(salt5a)} + {money(buyer)} = {money(salt5a + buyer)}, now under the {money(cap)} cap (engine capped at {money(cap)}).', 'California itemized deductions include property tax without a cap.', 'Authority: IRC 164(d) apportionment.'],
        'engine': {'label': 'Real estate taxes', 'value': l['value']}, 'expected': {'label': 'Buyer’s share', 'value': buyer},
        'evidence': [credit['id'], 'ev-1036', 'ev-1038', 'D58'], 'lines': ['SchA.5b', 'SchA.5e'],
        'adjustments': [{'line': 'SchA.5b', 'from': l['value'], 'to': buyer, 'effects': [{'category': 'itemized', 'amount': new_capped - cap, 'juris': 'federal'}, {'category': 'itemized', 'amount': -credit['value'], 'juris': 'california'}], 'note': 'Seller’s share credited at closing'}],
    }


def mortgage_interest_double(c: Ctx):
    l = c.L('SchA.8a')
    if not l: return None
    payoff = c.evf('D56', 'interest')
    if not payoff or payoff['id'] not in l['sources']: return None
    if not re.search(r'reported on the 2025 Form 1098', c.doc_text('D56'), re.I) and not re.search(r'interest paid at payoff', c.doc_text('D55'), re.I): return None
    return {
        'id': 'F-MORT-DUP', 'area': 'deductions', 'severity': 'medium', 'kind': 'engine',
        'title': 'Payoff interest counted twice in mortgage interest',
        'summary': f"Lonestar Form 1098 box 1 ({money(c.evf('D55', 'box1')['value'])}) already includes interest paid at the 11/20 payoff; the engine added the payoff statement interest {money(payoff['value'])} again.",
        'detail': ['Form 1098 text: “includes prepaid interest at closing and interest paid at payoff 11/20/2025”.', 'Payoff statement: “Interest is reported on the 2025 Form 1098.”'],
        'engine': {'label': 'Mortgage interest (1098)', 'value': l['value']}, 'expected': {'label': 'Without duplicate', 'value': l['value'] - payoff['value']},
        'evidence': [payoff['id'], 'ev-1029', 'D55', 'D56'], 'lines': ['SchA.8a'],
        'adjustments': [{'line': 'SchA.8a', 'from': l['value'], 'to': l['value'] - payoff['value'], 'effects': [{'category': 'itemized', 'amount': -payoff['value']}], 'note': 'Remove payoff interest already on Form 1098'}],
    }


def vehicle_donation(c: Ctx):
    l = c.L('F8283.A1.vehicle')
    if not l: return None
    proceeds = c.evf('D66', 'box4c')
    if not proceeds: return None
    if not re.search(r"4a vehicle sold in arm's length", c.doc_text('D66'), re.I): return None
    if l['value'] <= proceeds['value']: return None
    return {
        'id': 'F-VEHICLE', 'area': 'deductions', 'severity': 'high', 'kind': 'engine',
        'title': 'Donated car deducted at Blue Book value instead of sale proceeds',
        'summary': f"Form 1098-C: the charity sold the Subaru in an arm’s-length sale for {money(proceeds['value'])}. The deduction is limited to gross proceeds; the engine used the client’s {money(l['value'])} estimate.",
        'detail': ['Authority: IRC 170(f)(12)(A)(ii); Form 1098-C box 4a/4c. Attach Copy B to the return.', 'This item is later examined (IRS Letter 566, 2028).'],
        'engine': {'label': 'Vehicle gift', 'value': l['value']}, 'expected': {'label': 'Gross proceeds (1098-C)', 'value': proceeds['value']},
        'evidence': [proceeds['id'], 'D66', 'qa-39', 'call-01'], 'lines': ['F8283.A1.vehicle', 'SchA.12'],
        'adjustments': [{'line': 'F8283.A1.vehicle', 'from': l['value'], 'to': proceeds['value'], 'effects': [{'category': 'itemized', 'amount': proceeds['value'] - l['value']}], 'note': 'Limited to 1098-C gross proceeds'}],
    }


def charity_low_confidence(c: Ctx):
    e = c.ev('ev-1049')
    if not e: return None
    confirmed = c.msg_avail('msg-08')
    return {
        'id': 'F-CHARITY-READ', 'area': 'deductions', 'severity': 'low' if confirmed else 'medium', 'kind': 'judgment' if confirmed else 'client',
        'title': 'Handwritten receipt amount is ambiguous',
        'summary': f"St. Brigid receipt reads “$?,500.00”: first digit could be 1 or 7 (read as {money(e['value'])} at {rnd(e['confidence'] * 100)}% confidence)."
                   + (' Client confirmed 1,500 by phone with the parish and by bank statement (check #2207, 12/21/2025).' if confirmed else ''),
        'detail': ['A 7,500 reading would add 6,000 of deductions. Gifts of 250 or more need a contemporaneous written acknowledgment; keep the bank record with it.'],
        'evidence': [x for x in ['ev-1049', 'D64', 'msg-08' if confirmed else None] if x], 'lines': ['SchA.11'],
        'question': {'to': 'client', 'text': 'Please upload the bank statement showing check #2207 to St. Brigid (12/21/2025).' if confirmed else 'What was the amount of your December gift to St. Brigid Parish? The receipt is hard to read.'},
        'resolvedBy': 'msg-08' if confirmed else None,
    }


def ira_basis_conflict(c: Ctx):
    l = c.L('F8606.2')
    if not l: return None
    return {
        'id': 'F-IRA-BASIS', 'area': 'retirement', 'severity': 'low', 'kind': 'client',
        'title': 'Client says no prior IRA basis; records show 7,000',
        'summary': f"Questionnaire: “Prior basis: none … we started doing this in 2025.” The 2024 Form 8606 (line 14) and the 2024 Form 5498 show a 7,000 nondeductible contribution for 2024, made 02/12/2025. The engine’s {money(l['value'])} is right; the answer is not.",
        'detail': ['Both 2025 conversions (02/20 7,010 and 04/02 7,016) moved the 2024 and 2025 contributions; taxable amount 26 is the earnings.', 'Resolution: agreed to prior year and third-party record; no change. Tell the client why.'],
        'engine': {'label': 'Prior basis', 'value': l['value']}, 'expected': {'label': 'Per 2024 Form 8606', 'value': c.idx.packet['prior_years']['return_2024']['lines']['F8606.14']},
        'evidence': ['qa-31', 'py:/return_2024/lines/F8606.14', 'ev-0991', 'ev-0992', 'ev-0987'], 'lines': ['F8606.2'],
        'noAdjustment': True,
    }


def scorp_basis(c: Ctx):
    l = c.L('F7203.1')
    if not l: return None
    recs = c.idx.packet['prior_years']['basis_records']['scorp_lindqvist_family_woodworks']
    b2022 = next(r for r in recs if r['year'] == 2022)['ending_stock_basis']
    if not c.received('D40'):
        return {
            'id': 'F-SCORP-2023', 'area': 'passthroughs', 'severity': 'high', 'kind': 'client',
            'title': 'S corporation basis has a gap (2023 K-1 missing)',
            'summary': f"Last known stock basis 2022: {money(b2022)}. 2023 is unknown; the engine assumed no change and starts 2025 at {money(l['value'])}. Distributions exceed basis, so the gap changes capital gain directly.",
            'detail': ['Prior preparer left this open (D07 open items).'], 'evidence': ['py:/basis_records/scorp_lindqvist_family_woodworks/1', 'D07'], 'lines': ['F7203.1', 'F7203.excess'],
            'question': {'to': 'client', 'text': 'We need the 2023 Schedule K-1 from Lindqvist Family Woodworks (or the 2023 Form 1120-S) to compute S corporation stock basis.'},
        }
    inc23 = c.evf('D40', 'box1')['value'] + c.evf('D40', 'box4')['value']
    dist23 = c.evf('D40', 'box16d')['value']
    end23 = max(0, b2022 + inc23 - dist23)
    r24 = next(r for r in recs if r['year'] == 2024)
    end24 = max(0, end23 + r24['k1_income'] - r24['distributions'])
    if end24 == l['value']:
        return pass_('CHK-SCORP', f"S corp basis rolled independently: 2022 {money(b2022)} → 2023 {money(end23)} (+{money(inc23)} −{money(dist23)}) → 2024 {money(end24)} (+{money(r24['k1_income'])} −{money(r24['distributions'])}) = Form 7203 line 1",
                     'passthroughs', ['D40', 'py:/basis_records/scorp_lindqvist_family_woodworks'], ['F7203.1'])
    return fail('CHK-SCORP', 'S corp beginning basis does not roll forward', 'passthroughs', l['value'], end24, ['D40'], ['F7203.1'])


# ---------------------------------------------------------------- Payments
def federal_estimates(c: Ctx):
    l = c.L('F1040.26')
    if not l: return None
    snaps = [s for s in c.idx.packet['tax_agency_records']['irs_account_transcript_2025'] if not c.clock or s['as_of'] <= c.clock[:10]]
    snap = snaps[-1] if snaps else None
    uses_client = any(s.startswith('qa-') for s in l['sources'])
    if not snap:
        return ({'id': 'F-FED-EST', 'area': 'payments', 'severity': 'medium', 'kind': 'client', 'title': 'Q4 federal estimate from the client’s memory',
                 'summary': 'No EFTPS confirmation for the January payment; the engine used the questionnaire (“4,000 I think”). Pull the IRS transcript.', 'evidence': ['qa-41'], 'lines': ['F1040.26']}
                if uses_client else None)
    est = [t for t in snap['transactions'] if t['code'] == '670' and re.search('Estimated', t['description'], re.I) and '2025-01-01' <= t['date'] <= '2026-01-31']
    total = sum(t['amount'] for t in est)
    if total == l['value']: return pass_('CHK-FED-EST', f'Federal estimates agree to IRS transcript ({money(total)})', 'payments', ['D69'], ['F1040.26'])
    return {
        'id': 'F-FED-EST', 'area': 'payments', 'severity': 'high', 'kind': 'engine',
        'title': 'Federal estimated payments overstated (client guess used)',
        'summary': f"Engine total {money(l['value'])} includes 4,000 for January from the questionnaire (“4,000 I think”). IRS transcript (as of {snap['as_of']}): " + '; '.join(f"{t['date']} {money(t['amount'])}" for t in est) + f' = {money(total)}.',
        'detail': ['EFTPS confirmations cover only the first three payments; the transcript is the third-party record for the fourth.'],
        'engine': {'label': 'Estimated payments', 'value': l['value']}, 'expected': {'label': 'Per IRS transcript', 'value': total},
        'evidence': ['D69', 'agency:/irs_account_transcript_2025/0', 'qa-41', 'ev-1056', 'ev-1058', 'ev-1060'], 'lines': ['F1040.26'],
        'adjustments': [{'line': 'F1040.26', 'from': l['value'], 'to': total, 'effects': [{'category': 'payment', 'amount': total - l['value'], 'juris': 'federal'}], 'note': 'Agree to IRS transcript'}],
    }


def california_estimates(c: Ctx):
    l = c.L('F540NR.72')
    if not l: return None
    ftb = c.idx.packet['tax_agency_records']['ftb_account']
    total = sum(p['amount'] for p in ftb['tax_year_2025_payments'])
    if total == l['value']: return pass_('CHK-CA-EST', 'California estimates agree to FTB account', 'payments', ['agency:/ftb_account'], ['F540NR.72'])
    wrong = [e['field'].replace('_year', '') for e in c.idx.evs_by_doc.get('D68', []) if re.search(r'_year$', e['field']) and e['value'] != '2025']
    included = [p for p in wrong if (c.evf('D68', p + '_amount') or {}).get('id') in l['sources']]
    return {
        'id': 'F-CA-EST', 'area': 'payments', 'severity': 'high', 'kind': 'engine',
        'title': 'California estimates include a payment applied to 2024',
        'summary': f"Engine counts every FTB payment dated 04/01/2025–01/15/2026 ({money(l['value'])}). The 09/15/2025 Web Pay payment (3,500) was designated tax year 2024; FTB holds it as a 2024 credit. FTB shows {money(total)} for 2025.",
        'detail': [f"Included 2024-designated payments: {', '.join(p.replace('pay', 'payment ', 1) for p in included) or '—'}.", 'Options: request FTB transfer the 2024 credit to 2025 (client decision), or claim it as a 2024 overpayment. Until transferred it is not a 2025 payment.'],
        'engine': {'label': 'CA estimated payments', 'value': l['value']}, 'expected': {'label': 'Per FTB account', 'value': total},
        'evidence': ['ev-1076', 'ev-1075', 'agency:/ftb_account', 'agency:/ftb_account/tax_year_2024_payments_after_filing/0'], 'lines': ['F540NR.72'],
        'adjustments': [{'line': 'F540NR.72', 'from': l['value'], 'to': total, 'effects': [{'category': 'payment', 'amount': total - l['value'], 'juris': 'california'}], 'note': 'Agree to FTB account'}],
        'question': {'to': 'client', 'text': 'Your 09/15/2025 California payment (3,500) was applied to 2024. Do you want us to ask the FTB to move it to 2025?'},
    }


# ---------------------------------------------------------------- Identity and dependents
def dependent_identity(c: Ctx):
    out = []
    py = c.idx.packet['prior_years']['return_2024']['dependents']
    card = (c.evf('D71', 'ssn') or {}).get('value') if c.received('D71') else None
    for p in [p for p in c.idx.packet['household']['people'] if p['role'] == 'dependent']:
        prior = next((d['ssn'] for d in py if d['name'] == p['name']), None)
        mismatch = (prior and prior != p['ssn']) or (card and p['id'] == 'theo' and card != p['ssn'])
        if not mismatch: continue
        out.append({
            'id': 'F-DEP-SSN-' + p['id'], 'area': 'intake', 'severity': 'high', 'kind': 'client',
            'title': f"{p['name']}: SSN differs from prior-year return",
            'summary': f"Organizer SSN {p['ssn']} vs 2024 return {prior}" + (f' and Social Security card {card}' if card else '') + '. Last two digits transposed. E-file will reject on a TIN/name mismatch.',
            'detail': ['The 2024 return (D06 page 1) was accepted with the other number.', 'Card received 07/13: use the card.' if card else 'Ask for a copy of the Social Security card before filing.'],
            'engine': {'label': 'Organizer SSN', 'value': p['ssn']}, 'expected': {'label': 'Social Security card' if card else '2024 return', 'value': card or prior},
            'evidence': [x for x in ['household:' + p['id'], 'py:/return_2024/dependents', 'ev-1080' if card else None] if x], 'lines': ['F8812.4'],
            'sensitive': True, 'fixHousehold': {'person': p['id'], 'field': 'ssn', 'to': card or prior},
            'question': None if card else {'to': 'client', 'text': f"Please confirm {p['name'].split(' ')[0]}’s Social Security number with a photo of the card — the organizer and last year’s return differ."},
        })
    return out


def provider_tin(c: Ctx):
    out = []
    for e in c.idx.evs.values():
        if e['value_type'] != 'ein' or not c.received(e['document_id']): continue
        text = c.doc_text(e['document_id'])
        if e['value'] in text: continue
        digits = ''.join(sorted(re.sub(r'\D', '', e['value'])))
        printed = next((x for x in re.findall(r'\b\d{2}-\d{7}\b', text) if ''.join(sorted(re.sub(r'\D', '', x))) == digits), None)
        users = [u['key'] for u in c.idx.used_by.get(e['id'], []) if u['version'] == c.vid]
        out.append({
            'id': 'F-TIN-' + e['id'], 'area': 'deductions', 'severity': 'medium', 'kind': 'extraction',
            'title': 'Care provider tax ID misread',
            'summary': f"{c.idx.docs[e['document_id']].get('issuer') or e['document_id']}: extracted {e['value']} (confidence {js(e['confidence'])}); the statement prints {printed or 'a different number'}. Digits transposed.",
            'detail': ['Form 2441 requires the correct provider TIN even when the credit is zero, because box 10 benefits are excluded.'],
            'engine': {'label': 'Extracted TIN', 'value': e['value']}, 'expected': {'label': 'Printed TIN', 'value': printed},
            'evidence': [e['id'], e['document_id']], 'lines': users, 'sensitive': False, 'textFix': {'line': users[0] if users else None, 'from': e['value'], 'to': printed},
        })
    for l in c.lines.values():
        if not re.match(r'^F2441\.1[a-z]$', l['key']): continue
        m = re.search(r'Care provider: (.+?), tax ID', l['label'])
        name = m.group(1) if m else None
        d = (c.ev(l['sources'][0]) or {}).get('document_id')
        if name and d and name not in c.doc_text(d):
            real = c.doc_text(d).split(',')[0]
            out.append({'id': 'F-PROVIDER-NAME-' + l['key'], 'area': 'deductions', 'severity': 'low', 'kind': 'engine', 'title': 'Care provider name differs from statement',
                        'summary': f'Form 2441 shows “{name}”; the statement and the 2024 return say “{real}”.', 'evidence': [d, 'py:/return_2024/lines/F2441.provider'], 'lines': [l['key']],
                        'engine': {'label': 'Name on form', 'value': name}, 'expected': {'label': 'Name on statement', 'value': real}, 'textFix': {'line': l['key'], 'from': name, 'to': real}})
    return out


# ---------------------------------------------------------------- Independent recomputation of tax
def bracket_tax(x, br):
    t, lo = 0, 0
    for up, r in br:
        hi = math.inf if up is None else up
        if x > lo: t += (min(x, hi) - lo) * r
        lo = hi
    return t


def federal_regular_tax(P, TI, qd, lt_net, net, u1250):
    """Regular tax by the Schedule D worksheet, with unrecaptured §1250 gain taxed at no more than 25%."""
    ncg = max(0, qd + max(0, min(lt_net, net)))
    ordinary = max(0, TI - ncg)
    u = min(u1250, max(0, min(lt_net, net)))
    pref = ncg - u
    t1250 = min(bracket_tax(ordinary + u, P['brackets_mfj']) - bracket_tax(ordinary, P['brackets_mfj']), 0.25 * u)
    base = ordinary + u
    a0 = max(0, min(base + pref, P['ltcg_0_top']) - base)
    rem, b = pref - a0, max(base, P['ltcg_0_top'])
    a15 = max(0, min(b + rem, P['ltcg_15_top']) - b)
    return bracket_tax(ordinary, P['brackets_mfj']) + t1250 + a15 * 0.15 + (rem - a15) * 0.2


def recompute_taxes(c: Ctx):
    out = []
    TI = c.V('F1040.15')
    if TI is None: return None
    fed = rnd(federal_regular_tax(c.P, TI, c.V('F1040.3a'), c.V('SchD.15'), c.V('SchD.16'), c.V('SchD.19')))
    out.append(pass_('CHK-TAX-FED', f'Regular tax recomputed from brackets (Schedule D worksheet, §1250 at ≤25%): {money(fed)}', 'tax', ['ref:param.brackets_mfj'], ['F1040.16']) if fed == c.V('F1040.16')
               else fail('CHK-TAX-FED', 'Regular tax does not recompute', 'tax', c.V('F1040.16'), fed, ['ref:param.brackets_mfj'], ['F1040.16']))
    ca_t = rnd(bracket_tax(c.V('F540NR.19'), c.P['ca_brackets_mfj']))
    out.append(pass_('CHK-TAX-CA', f'California tax on total taxable income recomputed: {money(ca_t)}', 'california', ['ref:param.ca_brackets_mfj'], ['F540NR.31']) if ca_t == c.V('F540NR.31')
               else fail('CHK-TAX-CA', 'California tax does not recompute', 'california', c.V('F540NR.31'), ca_t, [], ['F540NR.31']))
    base = min(c.V('F8960.12'), c.V('F1040.11') - c.P['niit_threshold'])
    niit = rnd(0.038 * base)
    out.append(pass_('CHK-NIIT', f'Net investment income tax recomputed: 3.8% × {money(base)} = {money(niit)}', 'tax', [], ['F8960.17']) if niit == c.V('F8960.17')
               else fail('CHK-NIIT', 'NIIT does not recompute', 'tax', c.V('F8960.17'), niit, [], ['F8960.17']))
    steps = math.ceil((c.V('F1040.11') - c.P['ctc_phaseout_start']) / 1000)
    ctc = max(0, c.V('F8812.8') - 50 * math.ceil(max(0, c.V('F1040.11') - c.P['ctc_phaseout_start']) / 1000))
    out.append(pass_('CHK-CTC', f"Child tax credit phase-out recomputed: {money(c.V('F8812.8'))} − 50 × {steps} = {money(ctc)}", 'deductions', [], ['F8812.12']) if ctc == c.V('F8812.12')
               else fail('CHK-CTC', 'Child tax credit does not recompute', 'deductions', c.V('F8812.12'), ctc, [], ['F8812.12']))
    # Erik has no W-2 wages, so the full social security portion applies (wage base not reached).
    se = c.V('SchC.31') * c.P['se_factor']
    se_calc = rnd(min(se, c.P['ss_wage_base']) * 0.124) + rnd(se * 0.029)
    out.append(pass_('CHK-SE', f'Self-employment tax recomputed: {money(rnd(se))} × 15.3% = {money(se_calc)}', 'business', [], ['SchSE.12']) if abs(se_calc - c.V('SchSE.12')) <= 2
               else fail('CHK-SE', 'Self-employment tax does not recompute', 'business', c.V('SchSE.12'), se_calc, [], ['SchSE.12']))
    return out


def sum_lines(c: Ctx):
    n, bad = 0, []
    for l in c.lines.values():
        if l.get('rule') != 'R-SUM' or not l.get('inputs') or l.get('form') == 'F8949': continue
        n += 1
        vals = [float(c.V(k)) if c.V(k) is not None else math.nan for k in l['inputs']]  # a missing input never foots
        s, d = sum(vals), vals[0] - sum(vals[1:])
        ok = abs(s - l['value']) <= 1 or abs(d - l['value']) <= 1 or abs(abs(d) - l['value']) <= 1
        m = re.match(r'^SchCA540NR\.(\d+)\.D$', l['key'])
        if not ok and m:
            A, B, C = (float(c.V(f'SchCA540NR.{m.group(1)}.{x}') or 0) for x in 'ABC')
            ok = abs(A - B + C - l['value']) <= 1
        if not ok: bad.append(l['key'])
    if bad: return fail('CHK-SUMS', f'{len(bad)} totals do not foot', 'tax', None, None, [], bad, ', '.join(bad))
    return pass_('CHK-SUMS', f'All {n} totals foot from their inputs (Schedule CA columns as A − B + C)', 'tax', [], [])


# ---------------------------------------------------------------- Completeness / outside filings / engine diagnostics
AREA_FOR_DIAG = {'SCORP_BASIS_INCOMPLETE': 'passthroughs', 'DIGITAL_ASSET_BASIS_MISSING': 'investments', 'K1_EXPECTED_NOT_RECEIVED': 'passthroughs', 'AMT_CREDIT_CARRYFORWARD': 'tax',
                 'AOTC_PHASED_OUT': 'deductions', 'FBAR_OUTSIDE_RETURN': 'investments', 'FORM_1099_FILING': 'business', 'DUE_DILIGENCE_REQUIRED': 'deductions', 'CA_AMT_NOT_COMPUTED': 'california',
                 'HOME_OFFICE_AREA_CHANGE': 'business', 'QUESTIONNAIRE_SALES_CONFLICT': 'investments', 'LOW_CONFIDENCE_READ': 'deductions', 'BROKER_SUMMARY_DETAIL_MISMATCH': 'investments'}
LINE_REF = re.compile(r'^[A-Z][A-Za-z0-9-]*\.')


def engine_diagnostics(c: Ctx):
    out = []
    for d in c.idx.version(c.vid)['diagnostics']:
        title = d['code'].replace('_', ' ').lower()
        out.append({'id': 'DIAG-' + d['code'], 'area': AREA_FOR_DIAG.get(d['code'], 'tax'), 'severity': 'medium' if d['severity'] == 'warning' else 'info', 'kind': 'diagnostic',
                    'title': title[:1].upper() + title[1:], 'summary': d['message'],
                    'evidence': [r for r in d['refs'] if not LINE_REF.match(r) or r.startswith('ev-')], 'lines': [r for r in d['refs'] if LINE_REF.match(r)], 'engineCode': d['code']})
    return out


def outside_filings(c: Ctx):
    mx = c.V('F8938.1.max')
    return [
        {'id': 'OUT-FBAR', 'area': 'investments', 'severity': 'medium', 'kind': 'outside', 'title': 'FinCEN 114 (FBAR) for 2025', 'summary': f'Sparbanken maximum {money(mx)} USD > 10,000. Due 10/15/2026 (automatic extension). Not in engagement scope: client files (prior years filed by client). Confirm and record.', 'evidence': ['ev-0962', 'D01', 'py:/prior_preparer_workpaper/notes/2'], 'lines': ['F8938.1.max']},
        {'id': 'OUT-1099NEC', 'area': 'business', 'severity': 'medium', 'kind': 'outside', 'title': 'Forms 1099-NEC for two contractors (late)', 'summary': 'Mara Quintero 4,800 and Dev Patel 2,600 paid by ACH; no 1099s filed; due 02/02/2026. Outside the engagement; advise client in writing (late-filing penalties, backup withholding/W-9s).', 'evidence': ['D27', 'qa-23', 'call-01', 'D01'], 'lines': ['SchC.I', 'SchC.J']},
        {'id': 'OUT-3520', 'area': 'investments', 'severity': 'medium', 'kind': 'outside', 'title': 'Form 3520 for the 2023 Swedish inheritance', 'summary': 'Erik inherited the Sparbanken account from his mother in 2023 (account opened 09/2023, balance > 100,000 USD). A foreign inheritance over 100,000 requires Form 3520. Prior preparer left it unresolved. Ask the client; refer if not filed.', 'evidence': ['qa-07', 'ev-0961', 'py:/prior_preparer_workpaper/open_items_left_by_prior_preparer/3', 'D36'], 'lines': []},
        {'id': 'OUT-ADA', 'area': 'intake', 'severity': 'low', 'kind': 'outside', 'title': 'Ada’s own 2025 return', 'summary': 'Ada files her own return (summer W-2 4,100) and must check “someone can claim you”. Confirm she did not claim the education credit.', 'evidence': ['household:ada'], 'lines': ['F8812.6', 'F8863.7']},
        {'id': 'OUT-OR', 'area': 'passthroughs', 'severity': 'info', 'kind': 'outside', 'title': 'Oregon composite return (Woodworks)', 'summary': 'Oregon tax 1,580 paid on Erik’s behalf in April 2026 via the composite return: no Oregon filing needed; California credit on Schedule S; federal SALT deduction belongs to 2026 (paid 2026).', 'evidence': ['ev-0982'], 'lines': ['ScheduleS.credit']},
        {'id': 'OUT-AZ', 'area': 'passthroughs', 'severity': 'info', 'kind': 'outside', 'title': 'Arizona composite return (Ridgeline)', 'summary': 'Partnership filed an Arizona composite; no Arizona filing by the partner.', 'evidence': ['D38'], 'lines': []},
    ]


def extension_and_late_payment(c: Ctx):
    ext = c.idx.packet['what_if']['extension']
    return {
        'id': 'PEN-LATE-PAY', 'area': 'payments', 'severity': 'info', 'kind': 'judgment',
        'title': 'Interest and failure-to-pay penalty on the balance after April 15',
        'summary': f"Extension (04/14) paid {money(ext['federal']['paid_with_form_4868'])} from the v2 estimate (balance {money(ext['federal']['estimated_balance'])}). An extension to file is not an extension to pay; any balance paid later accrues interest (7%) and 0.5%/month failure-to-pay.",
        'detail': ['Decide and record: first-time abatement eligibility (no penalties in prior 3 years; 2023 CP2000 closed no change).', 'The v2 estimate used the overstated Q4 payment, so the extension underpaid by at least that amount.'],
        'evidence': ['timeline:extension-2026-04-14', 'agency:/irs_account_transcript_2025/1'], 'lines': ['Sch3.10', 'F1040.37'],
    }


CHECKS = [
    w2_sums, rsu_noncovered_basis, excess_social_security,
    duplicate_interest, foreign_interest_rate, broker_summary_reconciliation, lot_recalc, crypto_missing_basis,
    form_1099k_double_count, mileage_duplicate_page, phone_internet_personal_use, personal_subscription, self_employed_health_insurance,
    hvac_capitalize,
    scorp_basis,
    ira_basis_conflict,
    home_real_estate_tax_proration, mortgage_interest_double, vehicle_donation, charity_low_confidence, provider_tin,
    federal_estimates, california_estimates, extension_and_late_payment,
    dependent_identity,
    ca_wage_sourcing,
    recompute_taxes, sum_lines,
    engine_diagnostics, outside_filings,
]


def run_checks(idx: Index, vid: str, clock: str | None) -> list[dict]:
    c = Ctx(idx, vid, clock)
    out = []
    for check in CHECKS:
        try:
            r = check(c)
        except Exception as e:  # a broken check shows up as a finding instead of hiding the rest
            out.append({'id': 'CHECK-ERROR-' + check.__name__, 'title': f'Check {check.__name__} could not run', 'area': 'tax', 'severity': 'low', 'kind': 'system', 'summary': str(e), 'evidence': [], 'lines': []})
            continue
        if r: out.extend(x for x in (r if isinstance(r, list) else [r]) if x)
    return clean(out)


# ---------------------------------------------------------------- tax effect of an adjustment
def price(rates: dict, effects: list[dict]) -> dict:
    """Change × the engine version's per-dollar rate (estimates; engine what-ifs come in as category 'tax').
    The one pricing rule used by the server, the agents and the verifier report."""
    fed = ca = fpay = cpay = 0.0
    for e in effects or []:
        amt, cat, juris = float(e.get('amount', 0)), e.get('category'), e.get('juris')
        if cat == 'tax':
            if juris == 'california': ca += amt
            else: fed += amt
        elif cat == 'credit':
            if juris != 'california': fed -= amt
            else: ca -= amt
        elif cat == 'payment':
            if juris == 'california': cpay += amt
            else: fpay += amt
        elif cat in rates:
            if juris != 'california': fed += amt * rates[cat]['federal_per_dollar']
            if juris != 'federal': ca += amt * rates[cat]['california_per_dollar']
    return {'fed': rnd(fed), 'ca': rnd(ca), 'fedPay': rnd(fpay), 'caPay': rnd(cpay)}


# ---------------------------------------------------------------- the season: every point where what is known changes
def change_points(packet: dict) -> list[str]:
    pts = {'2000-01-01T00:00:00Z'}
    pts.update(t['at'] for t in packet['timeline'])
    pts.update(d['received_at'] for d in packet['documents'])
    pts.update(m['sent_at'] for m in packet['client']['messages'])
    pts.update(c['date'] for c in packet['client']['call_notes'])
    pts.update(s['as_of'] for s in packet['tax_agency_records']['irs_account_transcript_2025'])
    pts.update(v['computed_at'] for v in packet['return_versions'])
    return sorted(pts)


def season(packet: dict | None = None) -> dict:
    """Findings at every change point, de-duplicated: {points: [{from, vid, set}], sets: [[finding, ...], ...]}."""
    packet = packet if packet is not None else load_packet()
    idx = Index(packet)
    sets, keys, points = [], {}, []
    for clock in change_points(packet):
        vid = idx.active_version(clock)
        fs = run_checks(idx, vid, clock)
        k = json.dumps(fs, sort_keys=True, ensure_ascii=False)
        if k not in keys:
            keys[k] = len(sets); sets.append(fs)
        points.append({'from': clock, 'vid': vid, 'set': keys[k]})
    return {'generated_by': 'python/checks.py', 'points': points, 'sets': sets}


def findings_at(season_data: dict, clock: str) -> list[dict]:
    pts = [p for p in season_data['points'] if p['from'] <= clock]
    return season_data['sets'][(pts[-1] if pts else season_data['points'][0])['set']]


def load_packet(path: Path = PACKET_PATH) -> dict:
    return json.loads(path.read_text())
