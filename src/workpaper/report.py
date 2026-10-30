#!/usr/bin/env python3
"""Report the errors the checks find, and confirm the published figures.

Runs the workpaper's checks (workpaper.checks) at the end of the season, prices every proposed
adjustment at the engine version's own per-dollar rates, and prints the 20 issues with the net
effect on the return. With --check it compares every figure with docs/ERRORS_FOUND.md and exits 1
on any difference, so a change to a check cannot silently change the published numbers.

    workpaper report            # table of issues and net effect
    workpaper report --check    # also compare against docs/ERRORS_FOUND.md
    workpaper report --json     # machine-readable output
"""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from . import checks

PACKET = checks.PACKET_PATH

# The 20 issues in docs/ERRORS_FOUND.md, by the finding that reports each one.
ISSUES = {
    'F-RSU-BASIS': 1, 'F-1099K-DOUBLE': 2, 'F-CA-WAGES': 3, 'F-MILEAGE-DUP': 4, 'F-FED-EST': 5, 'F-CA-EST': 6, 'F-INT-DUP': 7, 'F-FX-RATE': 8,
    'F-BROKER-UNREAD': 9, 'F-MORT-DUP': 10, 'F-RE-TAX': 11, 'F-VEHICLE': 12, 'F-TIN-': 13, 'F-PROVIDER-NAME-': 14, 'F-DEP-SSN-': 15,
    'F-SEHI-ELIGIBLE': 16, 'F-HVAC': 17, 'F-CRYPTO-BASIS': 18, 'F-UTIL-PERSONAL': 19, 'F-PERSONAL-SOFTWARE': 20,
}
NOTES = {13: 'form accuracy', 14: 'form accuracy', 15: 'e-file reject'}

# Published figures: (fed tax, CA tax, fed payments, CA payments).
EXPECTED = {
    1: (-15536, -1618, 0, 0), 2: (-4402, -384, 0, 0), 3: (0, -5685, 0, 0), 4: (919, 80, 0, 0),
    5: (0, 0, -1000, 0), 6: (0, 0, 0, -3500), 7: (-640, -127, 0, 0), 8: (43, 9, 0, 0),
    9: (-21, -2, 0, 0), 10: (559, 103, 0, 0), 11: (1462, 332, 0, 0), 12: (806, 149, 0, 0),
    13: (0, 0, 0, 0), 14: (0, 0, 0, 0), 15: (0, 0, 0, 0),
    16: (4464, 605, 0, 0), 17: (3633, 896, 0, 0), 18: (-1312, -104, 0, 0), 19: (464, 41, 0, 0), 20: (77, 7, 0, 0),
}
EXPECTED_TOTALS = {'fed_tax': 72478, 'fed_balance': -4264, 'ca_tax': 13176, 'ca_balance': -10454}


@dataclass
class Issue:
    n: int
    finding: str
    kind: str
    title: str
    engine: object
    expected: object
    basis: str
    effect: tuple[int, int, int, int]
    note: str = ''


class Packet:
    def __init__(self, path: Path = PACKET):
        raw = path.read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        self.p = json.loads(raw)
        self.idx = checks.Index(self.p)
        self.clock = checks.change_points(self.p)[-1]  # end of the season: everything received
        self.vid = self.idx.active_version(self.clock)
        self.version = self.idx.version(self.vid)


def run(pk: Packet) -> list[Issue]:
    out = []
    for f in checks.run_checks(pk.idx, pk.vid, pk.clock):
        n = next((v for k, v in ISSUES.items() if f['id'] == k or (k.endswith('-') and f['id'].startswith(k))), None)
        if n is None: continue
        effs = [checks.price(pk.version['tax_effect_rates'], a.get('effects') or []) for a in f.get('adjustments') or []]  # each adjustment rounds on its own
        effect = tuple(sum(e[k] for e in effs) for k in ('fed', 'ca', 'fedPay', 'caPay'))
        out.append(Issue(n, f['id'], f['kind'], f['title'], (f.get('engine') or {}).get('value'), (f.get('expected') or {}).get('value'),
                         f['summary'], effect, NOTES.get(n, '')))
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
    return f'{v:+,}' if isinstance(v, int) and v else '—'


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
                          'issues': [{'n': i.n, 'finding': i.finding, 'kind': i.kind, 'title': i.title, 'engine': i.engine, 'expected': i.expected,
                                      'fed_tax': i.effect[0], 'ca_tax': i.effect[1], 'fed_payments': i.effect[2], 'ca_payments': i.effect[3], 'note': i.note} for i in issues]}, indent=1, default=str))
    else:
        print(f'Packet sha256 {pk.sha256[:16]}…  engine {pk.vid}  ({len(pk.p["documents"])} documents, {len(pk.idx.evs)} extracted values)\n')
        print(f'{"#":>2}  {"Issue":<62} {"Fed tax":>9} {"CA tax":>8}  Other')
        for i in issues:
            other = i.note or ', '.join(x for x in [f'fed pay {i.effect[2]:+,}' if i.effect[2] else '', f'CA pay {i.effect[3]:+,}' if i.effect[3] else ''] if x)
            print(f'{i.n:>2}  {i.title[:62]:<62} {fmt(i.effect[0]):>9} {fmt(i.effect[1]):>8}  {other}')
        e, w = summary['engine'], summary['workpaper']
        bal = lambda v: f'{abs(v):,} {"due" if v > 0 else "refund"}'
        print(f'\n{"":<30}{"Engine " + pk.vid:>14}{"Workpaper":>16}')
        for label, k, f in [('Federal total tax', 'fed_tax', lambda v: f'{v:,}'), ('Federal balance', 'fed_balance', bal), ('California total tax', 'ca_tax', lambda v: f'{v:,}'), ('California balance', 'ca_balance', bal)]:
            print(f'{label:<30}{f(e[k]):>14}{f(w[k]):>16}')
        if a.check:
            print('\n' + ('All figures agree with docs/ERRORS_FOUND.md.' if not diffs else 'DIFFERENCES:\n  ' + '\n  '.join(diffs)))
    return 1 if diffs else 0


