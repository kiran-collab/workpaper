"""The independent Python verification must agree with the published figures."""
from verify_packet import EXPECTED, PACKET, Packet, main, run, summarize


def test_all_published_figures_agree():
    assert main(['--check']) == 0


def test_every_issue_is_found():
    pk = Packet(PACKET)
    assert {i.n for i in run(pk)} == set(EXPECTED)


def test_federal_balance_turns_into_a_refund():
    pk = Packet(PACKET)
    s = summarize(pk, run(pk))
    assert s['engine']['fed_balance'] == 4220 and s['workpaper']['fed_balance'] == -4264
