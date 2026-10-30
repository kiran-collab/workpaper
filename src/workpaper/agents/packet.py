"""The agents' read-only view of the packet.

Agents see what a preparer without sensitive-data clearance sees: Social Security numbers and
account numbers are masked to their last four digits everywhere (least privilege). Every other
source is available exactly as delivered, through one resolver for the packet's reference formats.
"""
from __future__ import annotations

import json
import re

from ..config import PACKET_PATH

SSN = re.compile(r'\b\d{3}-\d{2}-(\d{4})\b')
LONG_ACCOUNT = re.compile(r'\b\d{8,17}\b')
SENSITIVE_KEYS = {'ssn', 'ip_pin', 'account_number', 'routing_number', 'bank_account', 'pin'}


def mask_text(s: str) -> str:
    s = SSN.sub(lambda m: '•••-••-' + m.group(1), s)
    return LONG_ACCOUNT.sub(lambda m: '••••' + m.group(0)[-4:], s)


def mask(obj):
    """Mask sensitive values anywhere inside a JSON-like structure."""
    if isinstance(obj, dict):
        return {k: ('••••' + str(v)[-4:] if k in SENSITIVE_KEYS and v not in (None, '') else mask(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask(v) for v in obj]
    if isinstance(obj, str):
        return mask_text(obj)
    return obj


def pointer(obj, ptr: str):
    cur = obj
    for part in [p.replace('~1', '/').replace('~0', '~') for p in ptr.split('/') if p != '']:
        if isinstance(cur, list):
            if not part.isdigit() or int(part) >= len(cur): return None
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            if part not in cur: return None
            cur = cur[part]
        else:
            return None
    return cur


class PacketIndex:
    def __init__(self, packet: dict | None = None):
        self.p = packet if packet is not None else json.loads(PACKET_PATH.read_text())
        self.version = self.p['return_versions'][-1]
        self.vid = self.version['version']
        self.lines = {l['key']: l for l in self.version['lines']}
        self.rates = self.version['tax_effect_rates']
        self.docs = {d['id']: d for d in self.p['documents']}
        self.evs = {e['id']: e for e in self.p['extracted_values']}
        self.evs_by_doc: dict[str, list] = {}
        for e in self.p['extracted_values']: self.evs_by_doc.setdefault(e['document_id'], []).append(e)
        self.qa = {q['id']: q for q in self.p['client']['questionnaire']}
        self.msgs = {m['id']: m for m in self.p['client']['messages']}
        self.calls = {c['id']: c for c in self.p['client']['call_notes']}
        self.people = {h['id']: h for h in self.p['household']['people']}
        self.params = self.p['engine_reference']['parameters']
        self.used_by: dict[str, list[str]] = {}
        for l in self.version['lines']:
            for s in l.get('sources') or []: self.used_by.setdefault(s, []).append(l['key'])

    # ------------------------------------------------------------ references
    def resolve(self, ref: str):
        """(found, description) for any reference format listed in the packet's readme."""
        if not isinstance(ref, str) or not ref: return False, 'empty reference'
        if re.fullmatch(r'ev-\d+', ref):
            e = self.evs.get(ref)
            return (True, mask({k: e[k] for k in ('id', 'document_id', 'page', 'field', 'label', 'value', 'text_as_read', 'confidence')})) if e else (False, f'no extracted value {ref}')
        if re.fullmatch(r'D\d\d', ref):
            d = self.docs.get(ref)
            return (True, {'id': ref, 'title': d['title'], 'type': d['document_type'], 'pages': d['page_count']}) if d else (False, f'no document {ref}')
        m = re.fullmatch(r'doc:(D\d\d)#page(\d+)', ref)
        if m:
            d = self.docs.get(m.group(1))
            ok = bool(d) and 1 <= int(m.group(2)) <= len(d['pages'])
            return (True, {'document': m.group(1), 'page': int(m.group(2))}) if ok else (False, f'no such page {ref}')
        for prefix, table in (('qa-', self.qa), ('msg-', self.msgs), ('call-', self.calls)):
            if ref.startswith(prefix):
                return (True, mask(table[ref])) if ref in table else (False, f'no record {ref}')
        if ref.startswith('py:') or ref.startswith('agency:'):
            root = self.p['prior_years'] if ref.startswith('py:') else self.p['tax_agency_records']
            v = pointer(root, ref.split(':', 1)[1])
            return (True, mask(v)) if v is not None else (False, f'nothing at {ref}')
        if ref.startswith('household:'):
            h = self.people.get(ref[10:])
            return (True, mask(h)) if h else (False, f'no household member {ref}')
        if ref.startswith('ref:param.'):
            n = ref[10:]
            return (True, self.params[n]) if n in self.params else (False, f'no parameter {n}')
        if ref.startswith('ref:fx.'):
            parts = ref.split('.')
            v = self.params.get('fx', {}).get(parts[1], {}).get(parts[2]) if len(parts) == 3 else None
            return (True, v) if v is not None else (False, f'no exchange rate {ref}')
        if ref.startswith('timeline:'):
            t = next((x for x in self.p['timeline'] if x['id'] == ref[9:]), None)
            return (True, mask(t)) if t else (False, f'no timeline event {ref}')
        if ref.startswith('asset:'):
            aid = ref[6:]
            a = next((x for x in self.version['assets'] if x['asset_id'] == aid), None) or next((x for x in self.p['prior_years'].get('asset_records', []) if x['asset_id'] == aid), None)
            return (True, a) if a else (False, f'no asset {aid}')
        if ref in self.lines:
            return True, self.line_view(ref)
        return False, f'unknown reference {ref!r} (use ev-NNNN, D##, doc:D##page#n, qa-/msg-/call-, py:/…, agency:/…, household:id, ref:fx.SEK.rate, or a line key)'

    def line_view(self, key: str) -> dict:
        l = self.lines[key]
        out = {k: l.get(k) for k in ('key', 'label', 'value', 'rule', 'note')}
        out['inputs'] = [{'key': k, 'value': self.lines[k]['value'] if k in self.lines else None} for k in l.get('inputs') or []]
        out['sources'] = [{'ref': s, 'value': (self.resolve(s)[1] if not s.startswith(('D', 'doc:')) else s)} for s in l.get('sources') or []]
        return mask(out)

    def text(self, doc_id: str, page: int | None = None) -> str:
        d = self.docs[doc_id]
        pages = [p for p in d['pages'] if page is None or p['page'] == page]
        return mask_text('\n\n'.join(f'[page {p["page"]}]\n{p["printed_content"]}' for p in pages))
