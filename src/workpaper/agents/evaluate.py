"""Evaluate the AI preparer against the 20 issues the verifier confirmed.

The agent runs blind (it cannot see the deterministic check results), then each of its findings is
matched to a known issue by the return lines it names. Reported: how many known issues it found,
whether it priced them like the verifier, what it found that is not on the list (for a person to
judge), how the reviewer agent voted, and what the run cost.

    workpaper eval --yes            # spends API credit: one full run
"""
from __future__ import annotations

import argparse
import json
import re
import time

from .. import config, report

# Known issue -> the line keys (regex) a finding about it would name.
KNOWN_LINES = {
    1: r'F8949\.[BE]\.N\d+', 2: r'SchC\.1', 3: r'SchCA540NR\.1\.E', 4: r'SchC\.(44a|44c|9)', 5: r'F1040\.26', 6: r'F540NR\.72',
    7: r'SchB\.1\.2', 8: r'SchB\.1\.6', 9: r'F8949\.B\.M\d+|doc:D\d\d#page32', 10: r'SchA\.8a', 11: r'SchA\.5[be]', 12: r'F8283\.A1\.vehicle|SchA\.12',
    13: r'F2441\.1b', 14: r'F2441\.1a', 15: r'F8812\.4|household:theo', 16: r'Sch1\.17', 17: r'SchE\.(14A|18A)', 18: r'F8949\.H\.C6',
    19: r'SchC\.25', 20: r'SchC\.27a\.1',
}


def known_issues() -> list[dict]:
    """The verifier's issues, as the agent sees them in normal (non-blind) runs."""
    pk = report.Packet(report.PACKET)
    return [{'n': i.n, 'title': i.title, 'basis': i.basis, 'lines_pattern': KNOWN_LINES[i.n], 'fed_tax': i.effect[0], 'ca_tax': i.effect[1]}
            for i in report.run(pk)]


def match(finding: dict) -> list[int]:
    keys = list(finding.get('lines') or []) + [a['line'] for a in finding.get('adjustments') or []] + \
        [r for r in finding.get('evidence') or [] if r.startswith(('household:', 'doc:'))]
    return [n for n, pat in KNOWN_LINES.items() if any(re.fullmatch(pat, k) for k in keys)]


def score(findings: list[dict], verdicts: dict[str, dict] | None = None) -> dict:
    truth = {i['n']: i for i in known_issues()}
    found: dict[int, dict] = {}
    novel = []
    for f in findings:  # one finding may cover several known issues (e.g. phone, internet and Spotify together)
        ns = match(f)
        for n in ns: found.setdefault(n, f)
        if not ns: novel.append(f)
    rows = []
    for n, t in sorted(truth.items()):
        f = found.get(n)
        eff = (f or {}).get('effect') or {}
        priced = None
        if f and (t['fed_tax'] or t['ca_tax']) and len(match(f)) == 1:  # a combined finding's total can't be split per issue
            exp, got = abs(t['fed_tax']) + abs(t['ca_tax']), abs(eff.get('fed', 0)) + abs(eff.get('ca', 0))
            priced = abs(got - exp) <= max(25, 0.10 * exp)  # within 10% (or $25) of the verified effect
        rows.append({'n': n, 'issue': t['title'], 'found': bool(f), 'finding': f and f['title'], 'priced_like_verifier': priced,
                     'fed_ok': bool(f) and len(match(f)) == 1 and abs(eff.get('fed', 0) - t['fed_tax']) <= max(25, 0.10 * abs(t['fed_tax'])),
                     'reviewer': (verdicts or {}).get(f['id'], {}).get('verdict') if f else None})
    quantified = [r for r in rows if r['priced_like_verifier'] is not None]
    return {'recall': f"{sum(r['found'] for r in rows)}/{len(rows)}",
            'priced_within_10pct': f"{sum(bool(r['priced_like_verifier']) for r in quantified)}/{len(quantified)}",
            'issues': rows, 'not_on_known_list': [{'title': f['title'], 'lines': f.get('lines'), 'reviewer': (verdicts or {}).get(f['id'], {}).get('verdict')} for f in novel]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--yes', action='store_true', help='confirm you want to spend API credit on a full run')
    ap.add_argument('--max-turns', type=int, default=60)
    ap.add_argument('--no-review', action='store_true')
    a = ap.parse_args(argv)
    if not a.yes:
        print('This runs the AI preparer and reviewer on the full packet with Claude Opus 5.5 and spends API credit.\nRe-run with --yes to proceed.')
        return 2
    import anthropic

    from .runner import Pipeline
    events: list[dict] = []
    pipe = Pipeline(anthropic.Anthropic(), events.extend, blind=True, max_turns=a.max_turns)
    t0 = time.time()
    res = pipe.run(started_by='eval', review=not a.no_review)
    verdicts = {e['payload']['finding']: e['payload'] for e in events if e['type'] == 'ai.review'}
    report = {'run': res, 'score': score(pipe.findings, verdicts), 'seconds': round(time.time() - t0)}
    out = config.EVAL_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({**report, 'events': events}, indent=1, default=str))
    s = report['score']
    print(f"Status {res['status']} ({res.get('ended') or res.get('error')}) in {report['seconds']}s, cost ${res['usage']['cost_usd']}")
    print(f"Known issues found: {s['recall']} · priced within 10%: {s['priced_within_10pct']} · submissions rejected by guardrails: {res.get('rejected', 0)}")
    for r in s['issues']:
        print(f"  {'✓' if r['found'] else '·'} {r['n']:>2} {r['issue'][:60]:<60} {r['reviewer'] or ''}")
    for n in s['not_on_known_list']:
        print(f"  + {n['title'][:70]} ({n['reviewer']})")
    print(f'Full transcript of events: {out}')
    return 0

