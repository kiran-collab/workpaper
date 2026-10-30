"""The checks must reproduce the published figures, and the app's copy of their findings must be current."""
import json

from workpaper import checks, findings
from workpaper.config import FINDINGS_PATH
from workpaper.report import EXPECTED, PACKET, Packet, main, run, summarize


def test_all_published_figures_agree():
    assert main(['--check']) == 0


def test_every_issue_is_found():
    assert {i.n for i in run(Packet(PACKET))} == set(EXPECTED)


def test_federal_balance_turns_into_a_refund():
    pk = Packet(PACKET)
    s = summarize(pk, run(pk))
    assert s['engine']['fed_balance'] == 4220 and s['workpaper']['fed_balance'] == -4264


def test_findings_json_matches_the_checks():
    """findings.json is what the static app shows; it must be exactly what checks.py computes now."""
    assert json.loads(FINDINGS_PATH.read_text()) == findings.build(), 'Run: workpaper build-findings'


def test_findings_follow_the_season():
    packet = checks.load_packet()
    s = checks.season(packet)
    early, late = checks.findings_at(s, '2026-03-01T00:00:00Z'), checks.findings_at(s, '2026-07-20T00:00:00Z')
    crypto = lambda fs: next(f for f in fs if f['id'] == 'F-CRYPTO-BASIS')['kind']
    assert crypto(early) == 'client' and crypto(late) == 'judgment'  # the client's 06/30 message settles the basis
