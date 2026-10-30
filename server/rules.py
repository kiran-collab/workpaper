"""Server-side rules for the workpaper journal.

The browser checks permissions before it appends an event, but a browser can be bypassed. These
rules run again on the server, against the server's own copy of the journal, before an event is
stored. They mirror js/model.js (CAN) and the action handlers in js/app.js.
"""
from __future__ import annotations

from decimal import ROUND_FLOOR, Decimal

D = Decimal

CAN = {
    'preparer': {'verify', 'adjust', 'note', 'question', 'signoff:preparer', 'time', 'evidence', 'disposition', 'finding', 'dd', 'task', 'step', 'fix', 'decision'},
    'reviewer': {'verify', 'adjust', 'note', 'review', 'question', 'signoff:reviewer', 'approve:small', 'time', 'evidence', 'disposition', 'finding', 'dd', 'task', 'step', 'fix', 'decision', 'extension'},
    'partner': {'verify', 'adjust', 'note', 'review', 'question', 'signoff:partner', 'approve:small', 'approve:large', 'time', 'evidence', 'disposition', 'finding', 'task', 'step', 'fix', 'decision', 'file', 'freeze', 'amend', 'extension'},
    'firm_administrator': {'standards', 'staff', 'time', 'task', 'viewlog', 'note'},
    'quality_reviewer': {'review', 'note', 'time'},
    'client': {'client'},
    'examiner': set(),
}

# Event type -> permissions, any one of which allows it. Types handled specially are absent.
PERM = {
    'verify': {'verify'}, 'unverify': {'verify'},
    'adjust.propose': {'adjust'}, 'adjust.reject': {'approve:small'},
    'note.create': {'note', 'question', 'review', 'client'}, 'note.reply': {'note', 'question', 'review', 'client'},
    'note.resolve': {'note', 'review'}, 'note.reopen': {'note', 'review'},
    'finding.status': {'finding'}, 'household.fix': {'fix'}, 'text.fix': {'fix'}, 'doc.disposition': {'disposition'},
    'evidence.attach': {'evidence', 'client'},
    'task.create': {'task'}, 'task.assign': {'task'}, 'task.done': {'task', 'time'},
    'time.log': {'time'}, 'step.complete': {'step'}, 'step.reopen': {'step'}, 'dd.answer': {'dd'},
    'decision': {'decision'}, 'decision.approve': {'approve:large'},
    'filing.extension': {'extension'}, 'filing.present': {'signoff:reviewer', 'signoff:partner'},
    'filing.client_approve': {'client'}, 'filing.sign8879': {'client'},
    'filing.submit': {'file'}, 'filing.freeze': {'freeze'}, 'filing.amend': {'amend'}, 'filing.payment': {'file', 'client'},
    'standards.update': {'standards'}, 'staff.update': {'staff'}, 'assign': {'signoff:partner', 'staff'},
}
ANYONE = {'view.sensitive', 'seen', 'undo', 'redo'}
FROZEN_BLOCKS = {'adjust.propose', 'verify', 'unverify', 'household.fix', 'text.fix'}


class Denied(Exception):
    """An event the server refuses to store. The message is shown to the person."""


def js_round(x: Decimal) -> int:
    return int((D(x) + D('0.5')).to_integral_value(rounding=ROUND_FLOOR))


def users_of(packet: dict) -> dict[str, dict]:
    users = {s['id']: dict(s) for s in packet['firm']['staff']}
    users.update({c['id']: {**c, 'role': 'client'} for c in packet['firm']['client_users']})
    users['irs-exam'] = {'id': 'irs-exam', 'name': 'IRS examiner (shared record)', 'role': 'examiner'}
    return users


class State:
    """The slice of fold(packet, journal) the rules need: adjustments, freeze, firm threshold."""

    def __init__(self, packet: dict, events: list[dict]):
        self.versions = {v['version']: v for v in packet['return_versions']}
        undone = set()
        for e in events:
            if e['type'] == 'undo': undone.update(e['payload'].get('ids', []))
            if e['type'] == 'redo': undone.difference_update(e['payload'].get('ids', []))
        self.adjustments: dict[str, dict] = {}
        self.threshold = 1000
        self.frozen = False
        self.amendments = 0
        self.by_id = {e['id']: e for e in events}
        for e in events:
            if e['id'] in undone or e['type'] in ('undo', 'redo'): continue
            self.apply(e)

    def apply(self, e: dict):
        p, t = e['payload'], e['type']
        if t == 'adjust.propose':
            self.adjustments[p['id']] = {'by': e['actor'], 'status': 'proposed', 'requiresPartner': p.get('requiresPartner', False), 'approvals': []}
        elif t == 'adjust.approve' and p.get('id') in self.adjustments:
            a = self.adjustments[p['id']]
            a['approvals'].append(p.get('level'))
            if not a['requiresPartner'] or p.get('level') == 'partner': a['status'] = 'approved'
        elif t in ('adjust.reject', 'adjust.withdraw') and p.get('id') in self.adjustments:
            self.adjustments[p['id']]['status'] = 'rejected' if t == 'adjust.reject' else 'withdrawn'
        elif t == 'standards.update' and p.get('key') == 'partner_threshold':
            self.threshold = p['value']
        elif t == 'filing.freeze':
            self.frozen = True
        elif t == 'filing.amend':
            self.amendments += 1
        self.by_id[e['id']] = e

    def effect(self, payload: dict) -> tuple[int, int]:
        """Federal and California tax effect of an adjustment, priced by the server, not the browser."""
        v = self.versions.get(payload.get('version')) or list(self.versions.values())[-1]
        rates = v['tax_effect_rates']
        fed = ca = D(0)
        for e in payload.get('effects') or []:
            amt, cat, juris = D(str(e.get('amount', 0))), e.get('category'), e.get('juris')
            if cat == 'tax':
                if juris == 'california': ca += amt
                else: fed += amt
            elif cat == 'credit':
                if juris != 'california': fed -= amt
                if juris == 'california': ca -= amt
            elif cat in rates:
                if juris != 'california': fed += amt * D(str(rates[cat]['federal_per_dollar']))
                if juris != 'federal': ca += amt * D(str(rates[cat]['california_per_dollar']))
        return js_round(fed), js_round(ca)


def check(state: State, user: dict, e: dict) -> dict:
    """Raise Denied if `user` may not append `e`; otherwise return the event as it should be stored."""
    role, t, p = user['role'], e['type'], e.get('payload') or {}
    perms = CAN.get(role, set())

    if t not in ANYONE and t not in PERM and t not in ('adjust.approve', 'adjust.withdraw', 'signoff'):
        raise Denied(f'Unknown action “{t}”')
    if t in PERM and not (PERM[t] & perms):
        raise Denied(f'A {role.replace("_", " ")} cannot do “{t}”')
    if role == 'examiner' and t not in ('seen',):
        raise Denied('The IRS examiner view is read-only')
    if state.frozen and t in FROZEN_BLOCKS and not (state.amendments or p.get('amendment')):
        raise Denied('Return is frozen at filing. Start an amendment to change it.')

    if t == 'adjust.propose':
        fed, ca = state.effect(p)
        p = {**p, 'effect': {**(p.get('effect') or {}), 'fed': fed, 'ca': ca},
             'requiresPartner': abs(fed) > state.threshold or abs(ca) > state.threshold}
    elif t == 'adjust.approve':
        a = state.adjustments.get(p.get('id'))
        if not a: raise Denied('No such adjustment')
        if a['status'] != 'proposed': raise Denied('This adjustment is no longer waiting for approval')
        if a['by'] == user['id']: raise Denied('Firm rule: you may not approve your own adjustment')
        level = p.get('level')
        if level == 'partner' and 'approve:large' not in perms: raise Denied('Only a partner can give partner approval')
        if level != 'partner' and 'approve:small' not in perms: raise Denied('Only reviewers and partners approve')
    elif t == 'adjust.withdraw':
        a = state.adjustments.get(p.get('id'))
        if not a or a['by'] != user['id']: raise Denied('Only the person who proposed it can withdraw it')
    elif t == 'signoff':
        if f'signoff:{p.get("level")}' not in perms: raise Denied(f'A {role.replace("_", " ")} cannot sign off as {p.get("level")}')
    elif t in ('undo', 'redo'):
        for i in p.get('ids', []):
            target = state.by_id.get(i)
            if target and target['actor'] != user['id']: raise Denied('You can only undo your own actions')
    return {**e, 'payload': p}
