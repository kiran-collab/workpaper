"""Agent pipeline tests. Claude is replaced by a scripted client, so these run offline and free."""
import re

import pytest

from fakes import MILEAGE, FakeClient, resp, text, tool
from workpaper.agents.evaluate import match, score
from workpaper.agents.packet import PacketIndex
from workpaper.agents.runner import INVESTIGATOR, MODEL, REVIEWER, Pipeline
from workpaper.agents.tools import Toolbox, ToolError

IDX = PacketIndex()
FULL_SSN = re.compile(r'\b\d{3}-\d{2}-\d{4}\b')

def scripted_run(verdict='confirmed'):
    script = [
        resp([tool(1, 'read_document', {'doc_id': 'D23', 'page': 3}), tool(2, 'get_return_line', {'key': 'SchC.44a'})]),
        resp([tool(3, 'submit_finding', {**MILEAGE, 'adjustments': [{**MILEAGE['adjustments'][0], 'from': 9999}]})]),  # wrong "from"
        resp([tool(4, 'submit_finding', MILEAGE)]),
        resp([text('Found one problem.')], 'end_turn'),
        # reviewer
        resp([tool(5, 'read_document', {'doc_id': 'D23', 'page': 2})]),
        resp([tool(6, 'submit_verdict', {'verdict': verdict, 'confidence': 0.85, 'reasons': ['Pages 2 and 3 list the same 22 trips.']})]),
    ]
    client, events = FakeClient(script), []
    pipe = Pipeline(client, events.extend, idx=IDX, known=[])
    return pipe, pipe.run(started_by='st-01'), events, client


def test_pipeline_records_runs_steps_findings_and_reviews():
    pipe, res, events, client = scripted_run()
    types = [e['type'] for e in events]
    assert types[0] == 'ai.run' and types[-1] == 'ai.run'
    assert events[-1]['payload']['status'] == 'finished' and events[-1]['payload']['rejected'] == 1
    f = next(e for e in events if e['type'] == 'ai.finding')
    assert f['actor'] == INVESTIGATOR and f['payload']['effect'] == {'fed': 919, 'ca': 80, 'fedPay': 0, 'caPay': 0}  # same as the verifier
    r = next(e for e in events if e['type'] == 'ai.review')
    assert r['actor'] == REVIEWER and r['payload']['verdict'] == 'confirmed' and r['payload']['finding'] == f['payload']['id']
    assert sum(t == 'ai.step' for t in types) == 6  # every tool call is logged, so a person can see what the agents read
    assert res['usage']['calls'] == 6 and res['usage']['cost_usd'] > 0


def test_rejected_finding_goes_back_to_the_model_as_an_error():
    _, _, _, client = scripted_run()
    third = client.calls[2]['messages'][-1]['content'][0]
    assert third['is_error'] is True and 'engine value is 8260' in third['content']


def test_requests_use_the_default_model_with_fallbacks_and_caching():
    _, _, _, client = scripted_run()
    c = client.calls[0]
    assert c['model'] == MODEL == 'claude-opus-5-5'
    assert c['fallbacks'] == 'default' and 'server-side-fallback-2026-07-01' in c['betas']
    assert c['cache_control'] == {'type': 'ephemeral'} and c['output_config']['effort'] == 'high'
    assert 'list_check_results' in [t['name'] for t in c['tools']]


def test_blind_mode_hides_the_check_results():
    client = FakeClient([resp([text('Nothing.')], 'end_turn')])
    Pipeline(client, lambda e: None, idx=IDX, blind=True).run(review=False)
    assert 'list_check_results' not in [t['name'] for t in client.calls[0]['tools']]


def test_agents_never_see_full_ssns():
    box = Toolbox(IDX)
    for d in IDX.p['documents']:
        assert not FULL_SSN.search(box.run_read('read_document', {'doc_id': d['id']}))
    assert not FULL_SSN.search(str(box.run_read('get_record', {'ref': 'household:theo'})))
    assert '3309' in str(box.run_read('get_record', {'ref': 'household:theo'}))  # last four still visible: the transposition is findable


@pytest.mark.parametrize('ref', ['ev-0016', 'D23', 'doc:D29#page1', 'qa-25', 'msg-07', 'call-01', 'py:/return_2024/dependents',
                                 'agency:/ftb_account', 'household:theo', 'ref:fx.SEK.2025_average', 'SchC.1'])
def test_every_reference_format_resolves(ref):
    assert IDX.resolve(ref)[0]


def test_guardrails_reject_unresolvable_evidence_and_unknown_lines():
    box = Toolbox(IDX)
    with pytest.raises(ToolError) as e:
        box.validate_finding({**MILEAGE, 'evidence': ['ev-9999'], 'lines': ['SchZ.1']}, [])
    assert 'ev-9999' in str(e.value) and 'SchZ.1' in str(e.value)


def test_duplicate_adjustment_on_the_same_line_is_refused():
    box = Toolbox(IDX)
    first = box.validate_finding(MILEAGE, [])
    with pytest.raises(ToolError):
        box.validate_finding({**MILEAGE, 'title': 'Business miles overstated'}, [first])


def test_eval_matches_findings_to_known_issues_and_checks_pricing():
    priced = Toolbox(IDX).validate_finding(MILEAGE, [])
    assert match(priced) == [4]
    s = score([{**priced, 'id': 'AI-1'}], {'AI-1': {'verdict': 'confirmed'}})
    row = next(r for r in s['issues'] if r['n'] == 4)
    assert s['recall'] == '1/20' and row['priced_like_verifier'] is True and row['reviewer'] == 'confirmed'
