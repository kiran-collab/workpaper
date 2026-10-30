#!/usr/bin/env python3
"""Independent verification of the Okafor-Lindqvist 2025 packet.

A second implementation of the workpaper's error hunt, written separately from js/checks.js.
It reads the packet exactly as delivered, recomputes each disputed figure from source records
(printed text, extracted values, agency records, client answers, prior-year return) and prices
the correction with the engine version's own per-dollar rates.

Standard library only. Money is handled with Decimal.

    python3 python/verify_packet.py            # table of findings and net effect
    python3 python/verify_packet.py --check    # also compare against docs/ERRORS_FOUND.md figures; exit 1 on any difference
    python3 python/verify_packet.py --json     # machine-readable output
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from decimal import ROUND_FLOOR, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKET = ROOT / 'okafor_lindqvist_2025_packet.json'

D = Decimal


def js_round(x: Decimal) -> int:
    """Round half toward +infinity, matching how the published figures were rounded."""
    return int((D(x) + D('0.5')).to_integral_value(rounding=ROUND_FLOOR))


# Figures published in docs/ERRORS_FOUND.md: (fed tax, CA tax, fed payments, CA payments).
EXPECTED = {
    1: (-15536, -1618, 0, 0), 2: (-4402, -384, 0, 0), 3: (0, -5685, 0, 0), 4: (919, 80, 0, 0),
    5: (0, 0, -1000, 0), 6: (0, 0, 0, -3500), 7: (-640, -127, 0, 0), 8: (43, 9, 0, 0),
    9: (-21, -2, 0, 0), 10: (559, 103, 0, 0), 11: (1462, 332, 0, 0), 12: (806, 149, 0, 0),
    13: (0, 0, 0, 0), 14: (0, 0, 0, 0), 15: (0, 0, 0, 0),
    16: (4464, 605, 0, 0), 17: (3633, 896, 0, 0), 18: (-1312, -104, 0, 0), 19: (464, 41, 0, 0), 20: (77, 7, 0, 0),
}
EXPECTED_TOTALS = {'fed_tax': 72478, 'fed_balance': -4264, 'ca_tax': 13176, 'ca_balance': -10454}


# ---------------------------------------------------------------- packet access
class Packet:
    def __init__(self, path: Path):
        raw = path.read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        # Whole numbers come back as int and fractions as Decimal, so money is never a binary float.
        self.p = json.loads(raw, parse_float=lambda t: int(D(t)) if D(t) == D(t).to_integral_value() else D(t))
        self.version = self.p['return_versions'][-1]
        self.vid = self.version['version']
        self.lines = {l['key']: l for l in self.version['lines']}
        self.rates = self.version['tax_effect_rates']
        self.evs = {e['id']: e for e in self.p['extracted_values']}
        self.docs = {d['id']: d for d in self.p['documents']}
        self.params = self.p['engine_reference']['parameters']
        self.qa = {q['id']: q for q in self.p['client']['questionnaire']}
        self.msgs = {m['id']: m for m in self.p['client']['messages']}
        self.calls = {c['id']: c for c in self.p['client']['call_notes']}

    def line(self, key):
        return self.lines.get(key)

    def value(self, key):
        return self.lines[key]['value']

    def ev(self, doc, field):
        return next((e for e in self.p['extracted_values'] if e['document_id'] == doc and e['field'] == field), None)

    def evs_of(self, doc):
        return [e for e in self.p['extracted_values'] if e['document_id'] == doc]

    def text(self, doc):
        return ' '.join(pg['printed_content'] for pg in self.docs[doc]['pages'])

    def docs_of_type(self, t):
        return [d for d in self.p['documents'] if d['document_type'] == t]


# ---------------------------------------------------------------- tax effect
@dataclass
class Effect:
    category: str
    amount: Decimal
    juris: str | None = None  # None = both


def price(pk: Packet, effects: list[Effect]) -> tuple[int, int, int, int]:
    """(fed tax, CA tax, fed payments, CA payments) for one adjustment, at the version's per-dollar rates."""
    fed = ca = D(0); fpay = cpay = D(0)
    for e in effects:
        if e.category == 'tax':
            if e.juris == 'california': ca += e.amount
            else: fed += e.amount
        elif e.category == 'payment':
            if e.juris == 'california': cpay += e.amount
            else: fpay += e.amount
        else:
            r = pk.rates[e.category]
            if e.juris != 'california': fed += e.amount * D(str(r['federal_per_dollar']))
            if e.juris != 'federal': ca += e.amount * D(str(r['california_per_dollar']))
    return js_round(fed), js_round(ca), int(fpay), int(cpay)


@dataclass
class Issue:
    n: int
    kind: str
    title: str
    engine: object
    expected: object
    basis: str
    adjustments: list[list[Effect]] = field(default_factory=list)
    effect: tuple[int, int, int, int] = (0, 0, 0, 0)
    note: str = ''


# ---------------------------------------------------------------- the checks
def rsu_basis(pk):
    lots = {}
    for e in pk.evs_of('D11'):
        m = re.match(r'^(.+)_(adjusted_basis|acquired)$', e['field'])
        if m: lots.setdefault(m.group(1), {})[m.group(2)] = e['value']
    adjs, eng, exp = [], D(0), D(0)
    for key, l in pk.lines.items():
        if not re.match(r'^F8949\.[BE]\.N\d+$', key): continue
        src = [pk.evs.get(s) for s in l['sources']]
        f = lambda suffix: next((e for e in src if e and e['field'].endswith(suffix)), None)
        basis, acq, proc = f('_basis'), f('_acquired'), f('_proceeds')
        if not basis or basis['value'] != 0: continue
        lot = next((v for v in lots.values() if v.get('acquired') == acq['value'] and 'adjusted_basis' in v), None)
        if not lot: continue
        gain = D(str(proc['value'])) - D(str(lot['adjusted_basis']))
        delta = gain - D(str(l['value']))
        adjs.append([Effect('stcg' if key.split('.')[1] == 'B' else 'ltcg', delta)])
        eng += D(str(l['value'])); exp += gain
    return Issue(1, 'engine', 'RSU sales taxed with zero basis', eng, exp,
                 f'{len(adjs)} noncovered lots matched to the D11 stock-plan supplement by acquisition date', adjs)


def form_1099k(pk):
    gross = pk.value('SchC.1')
    books = pk.ev('D14', 'total_income')['value']
    k_total = sum(pk.ev(d['id'], 'box1a')['value'] for d in pk.docs_of_type('1099-K'))
    card = pk.ev('D15', 'atlas_paywell')['value']
    nec = sum(pk.ev(d['id'], 'box1')['value'] for d in pk.docs_of_type('1099-NEC'))
    small = pk.ev('D15', 'unreported_small')['value']
    assert gross - books == k_total == card and nec + small == books, '1099-K reconciliation did not hold'
    return Issue(2, 'engine', 'Form 1099-K counted twice in gross receipts', gross, books,
                 f'1099-NEC {nec:,} + no-1099 clients {small:,} = books {books:,}; card receipts {card:,} = 1099-K',
                 [[Effect('schc_profit', D(books - gross))]])


def ca_wages(pk):
    l = pk.value('SchCA540NR.1.E')
    corvane = pk.ev('D08', 'box16')['value']
    ytd = pk.ev('D73', 'ytd_ca_wages')['value']
    kept = re.search(r'California as the work state through (\d\d/\d\d/\d{4})', pk.text('D09'))
    assert kept, 'Halvorsen W-2 note about the CA work state not found'
    exp = corvane + ytd
    return Issue(3, 'engine', 'California-source wages include Texas-period pay', l, exp,
                 f'Corvane box 16 {corvane:,} + Halvorsen CA wages at the move (07/18 paystub) {ytd:,}; employer kept CA through {kept.group(1)}',
                 [[Effect('ca_source_income', D(exp - l))]])


def mileage(pk):
    pages = {}
    for e in pk.evs_of('D23'):
        pg = pages.setdefault(e['page'], {'trips': {}, 'total': 0})
        m = re.match(r'^trip(\d+)_(date|destination|miles)$', e['field'])
        if m: pg['trips'].setdefault(m.group(1), {})[m.group(2)] = e['value']
        if e['field'] == 'page_total': pg['total'] = e['value']
    seen, unique, dup = set(), 0, []
    for n in sorted(pages):
        sig = tuple(sorted(f"{t.get('date')}|{t.get('destination')}|{t.get('miles')}" for t in pages[n]['trips'].values() if t.get('date')))
        if sig and sig in seen: dup.append(n)
        else:
            seen.add(sig); unique += pages[n]['total']
    rate = D(str(pk.params['mileage_rate']))
    old, new = pk.value('SchC.9'), js_round(unique * rate)
    return Issue(4, 'extraction', 'Mileage log page counted twice', pk.value('SchC.44a'), unique,
                 f'page {dup} repeats an earlier page trip for trip; deduction {unique:,} mi × {rate} = {new:,} (engine {old:,})',
                 [[Effect('schc_profit', D(old - new))]])


def fed_estimates(pk):
    l = pk.value('F1040.26')
    snap = pk.p['tax_agency_records']['irs_account_transcript_2025'][-1]
    est = [t for t in snap['transactions'] if t['code'] == '670' and re.search('estimated', t['description'], re.I) and '2025-01-01' <= t['date'] <= '2026-01-31']
    total = sum(t['amount'] for t in est)
    return Issue(5, 'engine', 'Federal Q4 estimate taken from the client’s memory', l, total,
                 f'IRS transcript as of {snap["as_of"]}: ' + '; '.join(f"{t['date']} {t['amount']:,}" for t in est),
                 [[Effect('payment', D(total - l), 'federal')]])


def ca_estimates(pk):
    l = pk.value('F540NR.72')
    total = sum(p['amount'] for p in pk.p['tax_agency_records']['ftb_account']['tax_year_2025_payments'])
    wrong = [e['field'][:-5] for e in pk.evs_of('D68') if e['field'].endswith('_year') and str(e['value']) != '2025']
    return Issue(6, 'engine', 'CA estimates include a payment applied to 2024', l, total,
                 f'FTB account shows {total:,} for 2025; payments designated to another year: {", ".join(wrong)}',
                 [[Effect('payment', D(total - l), 'california')]])


def duplicate_interest(pk):
    ints = [l for k, l in pk.lines.items() if re.match(r'^SchB\.1\.\d+$', k)]
    for i, a in enumerate(ints):
        for b in ints[i + 1:]:
            if a['value'] != b['value']: continue
            da, db = pk.evs[a['sources'][0]]['document_id'], pk.evs[b['sources'][0]]['document_id']
            acct = re.search(r'account ending (\d{3,})', pk.text(da))
            if acct and acct.group(1) in pk.text(db):
                return Issue(7, 'extraction', 'Same interest counted twice', a['value'] + b['value'], a['value'],
                             f'{db} 1099-INT is the sweep in account …{acct.group(1)} already on {da}',
                             [[Effect('interest', D(-b['value']))]])


def fx_rate(pk):
    year = pk.p['household']['tax_year']
    for k, l in pk.lines.items():
        if not k.startswith('SchB.1.'): continue
        fx = next((s for s in l['sources'] if s.startswith('ref:fx.')), None)
        if not fx: continue
        _, cur, which = fx.split('.')
        if int(which[:4]) == year: continue
        amt = pk.evs[next(s for s in l['sources'] if s.startswith('ev-'))]['value']
        rate = D(str(pk.params['fx'][cur][f'{year}_average']))
        usd = js_round(D(str(amt)) / rate)
        return Issue(8, 'engine', 'Swedish interest at the 2024 FX rate', l['value'], usd,
                     f'{cur} {amt:,} ÷ {rate} (2025 average) instead of {pk.params["fx"][cur][which]} ({which})',
                     [[Effect('interest', D(usd - l['value']))]])


def unread_page(pk):
    pat = re.compile(r'(M\d+) (.+?) ([\d.]+) sh acquired (\S+) sold (\S+) proceeds ([\d,.]+) basis ([\d,.]+) (short|long)-term (covered|noncovered)')
    for d in pk.docs_of_type('1099-composite'):
        if d['id'] in pk.version['documents_superseded'] or d['extraction']['status'] != 'partial': continue
        reason = d['extraction']['reason'] or ''
        missing = []
        for pg in d['pages']:
            if f"age {pg['page']}" not in reason: continue
            for m in pat.finditer(pg['printed_content']):
                missing.append((m.group(1), D(m.group(6).replace(',', '')), D(m.group(7).replace(',', '')), m.group(8)))
        if not missing: continue
        summary = pk.ev(d['id'], 'b_summary_proceeds')['value']
        lots = sum(e['value'] for e in pk.evs_of(d['id']) if re.match(r'^M\d+_proceeds$', e['field']))
        gain = sum(p - b for _, p, b, _ in missing)
        return Issue(9, 'extraction', f'{d["issuer"]}: page never read, sale missing', lots, summary,
                     f'{", ".join(m[0] for m in missing)} on an unread page; lots + missing = summary proceeds',
                     [[Effect('stcg' if missing[0][3] == 'short' else 'ltcg', gain)]])


def payoff_interest(pk):
    l = pk.line('SchA.8a'); payoff = pk.ev('D56', 'interest')
    assert payoff['id'] in l['sources']
    assert re.search('reported on the 2025 Form 1098', pk.text('D56'), re.I) or re.search('interest paid at payoff', pk.text('D55'), re.I)
    return Issue(10, 'engine', 'Payoff interest double-counted', l['value'], l['value'] - payoff['value'],
                 'Form 1098 already includes interest paid at payoff; payoff statement says so',
                 [[Effect('itemized', D(-payoff['value']))]])


def property_tax(pk):
    l = pk.value('SchA.5b'); credit = pk.ev('D54', 'tax_credit')['value']
    buyer = l - credit
    salt5a, cap = pk.value('SchA.5a'), pk.value('SchA.5e')
    capped = min(cap, salt5a + buyer)
    return Issue(11, 'engine', 'Home property tax includes the seller’s share', l, buyer,
                 f'seller credited {credit:,} at closing; federal SALT {salt5a:,} + {buyer:,} = {salt5a + buyer:,} vs cap {cap:,}',
                 [[Effect('itemized', D(capped - cap), 'federal'), Effect('itemized', D(-credit), 'california')]])


def vehicle(pk):
    l = pk.value('F8283.A1.vehicle'); proceeds = pk.ev('D66', 'box4c')['value']
    assert re.search("4a vehicle sold in arm's length", pk.text('D66'), re.I)
    return Issue(12, 'engine', 'Donated car at Blue Book, not sale proceeds', l, proceeds,
                 'Form 1098-C box 4a checked: deduction limited to gross proceeds in box 4c',
                 [[Effect('itemized', D(proceeds - l))]])


def provider_tin(pk):
    for e in pk.p['extracted_values']:
        if e['value_type'] != 'ein': continue
        text = pk.text(e['document_id'])
        if e['value'] in text: continue
        digits = sorted(re.sub(r'\D', '', e['value']))
        printed = next((m for m in re.findall(r'\b\d{2}-\d{7}\b', text) if sorted(re.sub(r'\D', '', m)) == digits), None)
        return Issue(13, 'extraction', 'Care provider TIN misread', e['value'], printed,
                     f'confidence {e["confidence"]}; printed text has the same digits in another order', note='form accuracy')


def provider_name(pk):
    for k, l in pk.lines.items():
        if not re.match(r'^F2441\.1[a-z]$', k): continue
        m = re.search(r'Care provider: (.+?), tax ID', l['label'])
        doc = pk.evs[l['sources'][0]]['document_id']
        if m and m.group(1) not in pk.text(doc):
            return Issue(14, 'engine', 'Wrong provider name on Form 2441', m.group(1), pk.text(doc).split(',')[0],
                         'label not found anywhere in the statement text', note='form accuracy')


def dependent_ssn(pk):
    prior = {d['name']: d['ssn'] for d in pk.p['prior_years']['return_2024']['dependents']}
    for person in pk.p['household']['people']:
        if person['role'] != 'dependent': continue
        if prior.get(person['name']) and prior[person['name']] != person['ssn']:
            mask = lambda s: '…' + s[-4:]
            return Issue(15, 'extraction', f'{person["name"].split()[0]}: SSN transposed in the organizer', mask(person['ssn']), mask(prior[person['name']]),
                         'organizer vs accepted 2024 return; e-file would reject', note='e-file reject')


def se_health(pk):
    l = pk.value('Sch1.17')
    assert re.match(r'^Yes', pk.qa['qa-25']['answer'], re.I)
    return Issue(16, 'judgment', 'SE health insurance while eligible for spouse’s plan', l, 0,
                 'questionnaire qa-25: spouse’s employers offered family coverage (IRC 162(l)(2)(B))',
                 [[Effect('adjustment', D(-l))]])


def hvac(pk):
    hv = pk.ev('D46', 'hvac')['value']
    assert re.search(r'Installed new .*system', pk.text('D47'), re.I)
    wi = next(a for a in pk.p['what_if']['alternatives'] if a['id'] == 'hvac_improvement')
    assert wi['base_version'] == pk.vid
    return Issue(17, 'judgment', 'HVAC replacement expensed, not capitalized', pk.value('SchE.14A'), pk.value('SchE.14A') - hv,
                 f'new heat-pump system under permit (D47); effect from the engine’s own what-if “{wi["id"]}”',
                 [[Effect('tax', D(wi['federal']['total_tax_change']), 'federal'), Effect('tax', D(wi['california']['total_tax_change']), 'california')]])


def crypto(pk):
    l = pk.value('F8949.H.C6'); proceeds = pk.ev('D34', 'C6_proceeds')['value']
    cost = int(re.search(r'about ([\d,]+)', pk.msgs['msg-07']['text']).group(1).replace(',', ''))
    return Issue(18, 'judgment', 'Crypto lot C6 at zero basis and short-term', l, proceeds - cost,
                 f'client message msg-07: bought March 2021 for about {cost:,}; long-term',
                 [[Effect('stcg', D(-l)), Effect('ltcg', D(proceeds - cost))]])


def phone_internet(pk):
    l = pk.value('SchC.25')
    notes = ' '.join(pk.calls['call-01']['notes'])
    p_phone = D(re.search(r'business share is (\d+)%', notes).group(1)) / 100
    p_net = D(re.search(r'business use about (\d+)%', notes).group(1)) / 100
    phone, net = pk.ev('D14', 'Telephone')['value'], pk.ev('D14', 'Internet')['value']
    ded = js_round(D(str(phone)) * p_phone + D(str(net)) * p_net)
    return Issue(19, 'judgment', 'Family phone and home internet at 100%', l, ded,
                 f'call notes: phone {p_phone:.0%}, internet {p_net:.0%} business',
                 [[Effect('schc_profit', D(l - ded))]])


def spotify(pk):
    l = pk.value('SchC.27a.1'); s = pk.ev('D15', 'spotify')['value']
    assert re.search(r'Spotify.*personal', ' '.join(pk.calls['call-01']['notes']), re.I)
    return Issue(20, 'judgment', 'Spotify Family in business software', l, l - s,
                 'client confirmed personal on the 03/26 call', [[Effect('schc_profit', D(s))]])


CHECKS = [rsu_basis, form_1099k, ca_wages, mileage, fed_estimates, ca_estimates, duplicate_interest, fx_rate,
          unread_page, payoff_interest, property_tax, vehicle, provider_tin, provider_name, dependent_ssn,
          se_health, hvac, crypto, phone_internet, spotify]


def run(pk: Packet) -> list[Issue]:
    out = []
    for check in CHECKS:
        issue = check(pk)
        if issue is None: continue
        totals = [price(pk, effs) for effs in issue.adjustments]  # each adjustment rounds on its own
        issue.effect = tuple(sum(t[i] for t in totals) for i in range(4))
        out.append(issue)
    return sorted(out, key=lambda i: i.n)


def summarize(pk: Packet, issues: list[Issue]) -> dict:
    s = pk.version['summary']
    fed_tax = s['federal']['total_tax'] + sum(i.effect[0] for i in issues)
    ca_tax = s['california']['total_tax'] + sum(i.effect[1] for i in issues)
    fed_pay = s['federal']['payments'] + sum(i.effect[2] for i in issues)
    ca_pay = s['california']['payments'] + sum(i.effect[3] for i in issues)
    return {'engine': {'fed_tax': s['federal']['total_tax'], 'fed_balance': s['federal']['balance_due'], 'ca_tax': s['california']['total_tax'], 'ca_balance': s['california']['balance_due']},
            'workpaper': {'fed_tax': fed_tax, 'fed_balance': fed_tax - fed_pay, 'ca_tax': ca_tax, 'ca_balance': ca_tax - ca_pay}}


def fmt(v):
    return f'{v:+,}' if isinstance(v, int) and v else ('—' if v == 0 else str(v))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packet', type=Path, default=PACKET)
    ap.add_argument('--check', action='store_true', help='compare against the figures in docs/ERRORS_FOUND.md')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    pk = Packet(a.packet)
    issues = run(pk)
    summary = summarize(pk, issues)
    diffs = []
    if a.check:
        found = {i.n for i in issues}
        diffs += [f'#{n}: not found' for n in EXPECTED if n not in found]
        diffs += [f'#{i.n}: got {i.effect}, published {EXPECTED[i.n]}' for i in issues if i.effect != EXPECTED.get(i.n)]
        diffs += [f'{k}: got {summary["workpaper"][k]}, published {v}' for k, v in EXPECTED_TOTALS.items() if summary['workpaper'][k] != v]

    if a.json:
        print(json.dumps({'packet_sha256': pk.sha256, 'version': pk.vid, 'summary': summary, 'differences': diffs,
                          'issues': [{'n': i.n, 'kind': i.kind, 'title': i.title, 'engine': str(i.engine), 'expected': str(i.expected), 'basis': i.basis,
                                      'fed_tax': i.effect[0], 'ca_tax': i.effect[1], 'fed_payments': i.effect[2], 'ca_payments': i.effect[3], 'note': i.note} for i in issues]}, indent=1))
    else:
        print(f'Packet sha256 {pk.sha256[:16]}…  engine {pk.vid}  ({len(pk.p["documents"])} documents, {len(pk.evs)} extracted values)\n')
        print(f'{"#":>2}  {"Issue":<52} {"Engine":>12} {"Recomputed":>12} {"Fed tax":>9} {"CA tax":>8}  Other')
        for i in issues:
            other = i.note or ', '.join(x for x in [f'fed pay {i.effect[2]:+,}' if i.effect[2] else '', f'CA pay {i.effect[3]:+,}' if i.effect[3] else ''] if x)
            eng = f'{i.engine:,.0f}' if isinstance(i.engine, (int, Decimal)) else str(i.engine)
            exp = f'{i.expected:,.0f}' if isinstance(i.expected, (int, Decimal)) else str(i.expected)
            print(f'{i.n:>2}  {i.title[:52]:<52} {eng[:12]:>12} {exp[:12]:>12} {fmt(i.effect[0]):>9} {fmt(i.effect[1]):>8}  {other}')
            print(f'    {"":<52} {i.basis}' if len(i.basis) < 90 else f'    ↳ {i.basis}')
        e, w = summary['engine'], summary['workpaper']
        bal = lambda v: f'{abs(v):,} {"due" if v > 0 else "refund"}'
        print(f'\n{"":<30}{"Engine " + pk.vid:>14}{"Recomputed":>16}')
        for label, k, f in [('Federal total tax', 'fed_tax', lambda v: f'{v:,}'), ('Federal balance', 'fed_balance', bal), ('California total tax', 'ca_tax', lambda v: f'{v:,}'), ('California balance', 'ca_balance', bal)]:
            print(f'{label:<30}{f(e[k]):>14}{f(w[k]):>16}')
        if a.check:
            print('\n' + ('All figures agree with docs/ERRORS_FOUND.md (two independent implementations).' if not diffs else 'DIFFERENCES:\n  ' + '\n  '.join(diffs)))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
