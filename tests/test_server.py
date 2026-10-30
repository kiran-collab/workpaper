"""Server tests: the journal API, server-side rules, and the AI agent runtime."""
import hashlib

import pytest
from fastapi.testclient import TestClient

from fakes import MILEAGE, FakeClient, resp, text, tool
from workpaper.server.app import AGENTS, PACKET_PATH, app, store, write_as_server
from workpaper.server.rules import Denied

PRIYA, DANIEL, HELEN, MARCUS, NGOZI, IRS = 'st-01', 'st-02', 'st-03', 'st-04', 'cu-01', 'irs-exam'
client = TestClient(app)


@pytest.fixture(autouse=True)
def clean():
    store.reset()


def post(user, *events, replay=False):
    return client.post('/api/events', json={'events': list(events), 'replay': replay}, headers={'X-User': user})


def propose(aid='a-rsu', amount=-30000, by=PRIYA):
    return post(by, {'id': 'e-' + aid, 'type': 'adjust.propose', 'payload': {
        'id': aid, 'line': 'F8949.B.N1', 'from': 31000, 'to': 1000, 'version': 'v3',
        'effects': [{'category': 'stcg', 'amount': amount}], 'requiresPartner': False}})


def approve(user, level, aid='a-rsu', eid='e-ap'):
    return post(user, {'id': eid, 'type': 'adjust.approve', 'payload': {'id': aid, 'level': level}})


def test_packet_is_served_byte_for_byte():
    r = client.get('/data/okafor_lindqvist_2025_packet.json')
    assert r.content == PACKET_PATH.read_bytes()
    assert client.get('/api/health').json()['packet_sha256'] == hashlib.sha256(r.content).hexdigest()


def test_app_files_are_served_but_not_the_database():
    assert client.get('/').status_code == 200
    assert client.get('/js/app.js').status_code == 200
    assert client.get('/var/journal.db').status_code == 404
    assert client.get('/tests/e2e/flow.html').status_code == 404  # test pages only when WP_E2E=1


def test_unknown_person_is_refused():
    assert post('nobody', {'id': 'x', 'type': 'verify', 'payload': {}}).status_code == 401


def test_server_prices_the_adjustment_and_ignores_the_browsers_flag():
    r = propose()
    assert r.status_code == 200
    stored = r.json()['events'][0]['payload']
    assert stored['effect']['fed'] == -10440  # -30,000 × 0.348 short-term rate
    assert stored['requiresPartner'] is True  # browser said False; server recomputed


def test_no_one_approves_their_own_adjustment():
    propose()
    r = approve(PRIYA, 'reviewer')
    assert r.status_code == 403 and 'own adjustment' in r.json()['detail']


def test_reviewer_cannot_give_partner_approval_but_partner_can():
    propose()
    assert approve(DANIEL, 'reviewer', eid='e1').status_code == 200
    assert approve(DANIEL, 'partner', eid='e2').status_code == 403
    assert approve(HELEN, 'partner', eid='e3').status_code == 200
    assert approve(HELEN, 'partner', eid='e4').status_code == 403  # already approved


def test_role_permissions_hold_without_the_browser():
    assert post(NGOZI, {'id': 'x1', 'type': 'verify', 'payload': {'target': 'SchC.1'}}).status_code == 403
    assert post(IRS, {'id': 'x2', 'type': 'note.create', 'payload': {'text': 'hi'}}).status_code == 403
    assert post(MARCUS, {'id': 'x3', 'type': 'filing.submit', 'payload': {}}).status_code == 403
    assert post(NGOZI, {'id': 'x4', 'type': 'filing.sign8879', 'payload': {}}).status_code == 200


def test_you_can_only_act_as_yourself():
    r = post(PRIYA, {'id': 'x', 'type': 'verify', 'payload': {}, 'actor': HELEN})
    assert r.status_code == 403


def test_demo_replay_keeps_original_actors():
    r = post(PRIYA, {'id': 'r1', 'type': 'signoff', 'payload': {'level': 'partner'}, 'actor': HELEN}, replay=True)
    assert r.status_code == 200 and r.json()['events'][0]['actor'] == HELEN


def test_frozen_return_refuses_changes_until_amended():
    assert post(HELEN, {'id': 'f1', 'type': 'filing.freeze', 'payload': {}}).status_code == 200
    assert propose('a-late').status_code == 403
    assert post(HELEN, {'id': 'f2', 'type': 'filing.amend', 'payload': {'reason': 'K-1'}}).status_code == 200
    assert propose('a-late').status_code == 200


def test_undo_only_your_own_actions():
    propose()
    assert post(DANIEL, {'id': 'u1', 'type': 'undo', 'payload': {'ids': ['e-a-rsu']}}).status_code == 403
    assert post(PRIYA, {'id': 'u2', 'type': 'undo', 'payload': {'ids': ['e-a-rsu']}}).status_code == 200


def test_a_refused_batch_stores_nothing():
    r = post(PRIYA, {'id': 'b1', 'type': 'verify', 'payload': {}}, {'id': 'b2', 'type': 'filing.submit', 'payload': {}})
    assert r.status_code == 403
    assert client.get('/api/events').json()['events'] == []


def test_server_assigns_order_and_ignores_retries():
    propose()
    propose()  # same event id again: stored once
    evs = client.get('/api/events').json()['events']
    assert len(evs) == 1 and evs[0]['seq'] >= 1


# ---------------------------------------------------------------- AI agents


def test_browsers_cannot_write_as_an_ai_agent():
    assert post('ai-01', {'id': 'x', 'type': 'ai.finding', 'payload': {}}).status_code == 403


def test_ai_agents_cannot_approve_even_from_inside_the_server():
    propose()
    with pytest.raises(Denied):
        write_as_server([{'type': 'adjust.approve', 'actor': 'ai-01', 'payload': {'id': 'a-rsu', 'level': 'reviewer'}}])


def test_running_the_ai_preparer_writes_its_work_into_the_shared_journal(monkeypatch):
    script = [resp([tool(1, 'submit_finding', MILEAGE)]), resp([text('Done.')], 'end_turn'),
              resp([tool(2, 'submit_verdict', {'verdict': 'confirmed', 'confidence': 0.9, 'reasons': ['ok']})])]
    monkeypatch.setitem(AGENTS, 'client_factory', lambda: FakeClient(script))
    monkeypatch.setitem(AGENTS, 'available', lambda: True)
    r = client.post('/api/agents/run', json={}, headers={'X-User': PRIYA})
    assert r.status_code == 200
    AGENTS['thread'].join(timeout=10)
    evs = client.get('/api/events').json()['events']
    by = {e['type']: e for e in evs}
    assert by['ai.finding']['actor'] == 'ai-01' and by['ai.review']['payload']['verdict'] == 'confirmed'
    assert [e['payload']['status'] for e in evs if e['type'] == 'ai.run'] == ['started', 'finished']
    # A person adopts the finding by proposing its adjustment; the usual rules apply from there.
    f = by['ai.finding']['payload']
    adopt = post(PRIYA, {'id': 'adopt', 'type': 'adjust.propose', 'payload': {'id': 'a-ai', 'findingId': f['id'], 'version': 'v3', **f['adjustments'][0]}})
    assert adopt.status_code == 200


def test_only_staff_who_can_adjust_start_a_run(monkeypatch):
    monkeypatch.setitem(AGENTS, 'available', lambda: True)
    assert client.post('/api/agents/run', json={}, headers={'X-User': NGOZI}).status_code == 403
    monkeypatch.setitem(AGENTS, 'available', lambda: False)
    assert client.post('/api/agents/run', json={}, headers={'X-User': PRIYA}).status_code == 503
