"""Tools the agents can call, and the guardrails on what they may write.

Read tools return packet data (masked). Write tools never change the return: a finding is a proposal
that a person must adopt, and it is only accepted if every citation resolves, every adjustment
starts from the engine's actual value, and the tax effect can be priced at the engine's own rates.
"""
from __future__ import annotations

import json

from ..checks import price  # the same pricing rule as the server and the report
from .packet import PacketIndex, mask

MAX_TOOL_CHARS = 14000
CATEGORIES_EXTRA = {'payment', 'tax', 'credit'}


def clip(obj) -> str:
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str)
    return s if len(s) <= MAX_TOOL_CHARS else s[:MAX_TOOL_CHARS] + f'\n…[truncated {len(s) - MAX_TOOL_CHARS} characters; narrow the request]'




# ---------------------------------------------------------------- schemas
def _obj(props: dict, required: list[str]) -> dict:
    return {'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}


READ_TOOLS = [
    {'name': 'list_documents', 'description': 'List the client documents: id, type, issuer, title, page count, extraction status (and why a page was not read), and how many return lines use each. Optionally filter by text in type/issuer/title.',
     'input_schema': _obj({'filter': {'type': 'string', 'description': 'Optional case-insensitive text to match.'}}, [])},
    {'name': 'read_document', 'description': 'Read the printed text of a document (what is really on the page). Give a page number to read one page; omit it to read all pages.',
     'input_schema': _obj({'doc_id': {'type': 'string', 'description': 'e.g. D23'}, 'page': {'type': 'integer'}}, ['doc_id'])},
    {'name': 'get_extracted_values', 'description': 'What the extraction pipeline read from a document: ev ids, field, label, value, text as read and confidence. Compare these with read_document to catch misreads.',
     'input_schema': _obj({'doc_id': {'type': 'string'}}, ['doc_id'])},
    {'name': 'get_return_line', 'description': 'One engine return line (value, rule, inputs with values, sources), or every line whose key starts with a prefix such as "SchB.1." or "F8949.B.".',
     'input_schema': _obj({'key': {'type': 'string', 'description': 'A line key like F1040.11, or a prefix ending in "."'}}, ['key'])},
    {'name': 'find_lines_using', 'description': 'Which return lines cite a given source reference (an ev id, a document id, a qa-/msg-/call- id, a py:/ or agency:/ pointer).',
     'input_schema': _obj({'ref': {'type': 'string'}}, ['ref'])},
    {'name': 'search_packet', 'description': 'Full-text search across every document page, the questionnaire, client messages and call notes. Returns up to 20 snippets with their references.',
     'input_schema': _obj({'query': {'type': 'string'}}, ['query'])},
    {'name': 'get_record', 'description': 'Resolve any reference: qa-NN, msg-NN, call-NN, py:/<json pointer> (prior years), agency:/<json pointer> (IRS/FTB records), household:<id>, ref:param.<name>, ref:fx.SEK.<rate>, timeline:<id>, asset:<id>. Use agency:/ or py:/ with an empty pointer segment list to browse, e.g. agency:/ftb_account.',
     'input_schema': _obj({'ref': {'type': 'string'}}, ['ref'])},
    {'name': 'get_return_summary', 'description': 'Engine summary for the current version, its diagnostics, what changed from the previous version, and the per-dollar tax-effect rates used to price adjustments.',
     'input_schema': _obj({}, [])},
]

EFFECT = _obj({'category': {'type': 'string', 'description': 'One of the rate categories from get_return_summary (e.g. wages, interest, schc_profit, stcg, ltcg, ordinary_income, adjustment, salt, itemized, ca_source_income), or payment / tax / credit.'},
               'amount': {'type': 'number', 'description': 'Change in that category in dollars: positive raises it.'},
               'juris': {'type': 'string', 'enum': ['federal', 'california'], 'description': 'Limit to one jurisdiction; omit for both.'}}, ['category', 'amount'])

SUBMIT_FINDING = {
    'name': 'submit_finding',
    'description': 'Record one problem you have verified. It becomes a proposal for a human preparer; it does not change the return. Rejected (with the reason) if any evidence reference does not resolve, a line key does not exist, or an adjustment "from" is not the engine value.',
    'input_schema': _obj({
        'title': {'type': 'string', 'description': 'Short, specific: what is wrong.'},
        'summary': {'type': 'string', 'description': 'Two or three sentences a reviewer can check: engine value, correct value, why.'},
        'severity': {'type': 'string', 'enum': ['high', 'medium', 'low']},
        'kind': {'type': 'string', 'enum': ['engine', 'extraction', 'judgment', 'client', 'completeness']},
        'lines': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Affected return line keys.'},
        'evidence': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'description': 'References a human can click: ev ids for extracted values, D## for a document, doc:D##page#n only for a page the pipeline did not extract, qa/msg/call ids, py:/ or agency:/ pointers.'},
        'reasoning': {'type': 'array', 'items': {'type': 'string'}, 'description': 'The recomputation, step by step, with the numbers.'},
        'authority': {'type': 'string', 'description': 'Code section, regulation or form instruction relied on, if any.'},
        'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
        'adjustments': {'type': 'array', 'items': _obj({'line': {'type': 'string'}, 'from': {'type': 'number'}, 'to': {'type': 'number'},
                                                        'effects': {'type': 'array', 'items': EFFECT}, 'note': {'type': 'string'}}, ['line', 'from', 'to', 'effects']),
                        'description': 'Proposed corrections, if the fix can be quantified.'},
    }, ['title', 'summary', 'severity', 'kind', 'lines', 'evidence', 'reasoning', 'confidence']),
}
ASK_CLIENT = {
    'name': 'ask_client',
    'description': 'Send the client a question when only they can answer (for example, the cost of an asset). It appears in the client portal; the answer comes back as evidence.',
    'input_schema': _obj({'question': {'type': 'string'}, 'refs': {'type': 'array', 'items': {'type': 'string'}}}, ['question']),
}
LIST_CHECK_RESULTS = {
    'name': 'list_check_results',
    'description': 'Issues the deterministic checks have already found. Do not resubmit these; look for problems they do not cover.',
    'input_schema': _obj({}, []),
}
SUBMIT_VERDICT = {
    'name': 'submit_verdict',
    'description': 'Your verdict on the finding under review, after checking its numbers against the sources yourself.',
    'input_schema': _obj({'verdict': {'type': 'string', 'enum': ['confirmed', 'refuted', 'uncertain']},
                          'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
                          'reasons': {'type': 'array', 'items': {'type': 'string'}},
                          'checked_refs': {'type': 'array', 'items': {'type': 'string'}}}, ['verdict', 'confidence', 'reasons']),
}


# ---------------------------------------------------------------- execution
class ToolError(Exception):
    """Returned to the model as an is_error tool result so it can correct itself."""


class Toolbox:
    def __init__(self, idx: PacketIndex, known_issues: list[dict] | None = None):
        self.idx = idx
        self.known = known_issues or []

    def run_read(self, name: str, a: dict):
        idx = self.idx
        if name == 'list_documents':
            f = (a.get('filter') or '').lower()
            out = []
            for d in idx.p['documents']:
                if f and f not in f"{d['document_type']} {d.get('issuer')} {d['title']}".lower(): continue
                out.append({'id': d['id'], 'type': d['document_type'], 'issuer': d.get('issuer'), 'title': d['title'], 'pages': d['page_count'],
                            'extraction': d['extraction']['status'], 'not_read': d['extraction'].get('reason'),
                            'lines_using': len({k for e in idx.evs_by_doc.get(d['id'], []) for k in idx.used_by.get(e['id'], [])})})
            return out
        if name == 'read_document':
            if a['doc_id'] not in idx.docs: raise ToolError(f"No document {a['doc_id']}. Use list_documents.")
            d = idx.docs[a['doc_id']]
            if a.get('page') is not None and not any(p['page'] == a['page'] for p in d['pages']):
                raise ToolError(f"{a['doc_id']} has pages 1–{len(d['pages'])}.")
            return f"{d['id']} · {d['title']} ({d['document_type']}, issuer {d.get('issuer')})\n" + idx.text(d['id'], a.get('page'))
        if name == 'get_extracted_values':
            if a['doc_id'] not in idx.docs: raise ToolError(f"No document {a['doc_id']}.")
            return mask([{k: e.get(k) for k in ('id', 'page', 'field', 'label', 'value', 'text_as_read', 'confidence')} | {'used_by': idx.used_by.get(e['id'], [])}
                         for e in idx.evs_by_doc.get(a['doc_id'], [])])
        if name == 'get_return_line':
            k = a['key']
            if k.endswith('.'):
                keys = [x for x in idx.lines if x.startswith(k)][:60]
                if not keys: raise ToolError(f'No lines start with {k}')
                return [{'key': x, 'label': idx.lines[x]['label'], 'value': idx.lines[x]['value'], 'sources': idx.lines[x].get('sources')} for x in keys]
            if k not in idx.lines:
                near = [x for x in idx.lines if x.split('.')[0] == k.split('.')[0]][:30]
                raise ToolError(f'No line {k}. Lines on that form: {near}')
            return idx.line_view(k)
        if name == 'find_lines_using':
            return idx.used_by.get(a['ref'], []) or f"No line cites {a['ref']} directly."
        if name == 'search_packet':
            q = a['query'].lower()
            if len(q) < 3: raise ToolError('Search for at least 3 characters.')
            hits = []
            for d in idx.p['documents']:
                for pg in d['pages']:
                    t = pg['printed_content']; i = t.lower().find(q)
                    if i >= 0: hits.append({'ref': f"doc:{d['id']}#page{pg['page']}", 'title': d['title'], 'snippet': t[max(0, i - 120): i + 180]})
            for kind, table in (('qa', idx.qa), ('msg', idx.msgs), ('call', idx.calls)):
                for rid, r in table.items():
                    s = json.dumps(r, ensure_ascii=False)
                    i = s.lower().find(q)
                    if i >= 0: hits.append({'ref': rid, 'snippet': s[max(0, i - 120): i + 180]})
            return mask(hits[:20]) or 'No matches.'
        if name == 'get_record':
            ok, v = idx.resolve(a['ref'])
            if not ok: raise ToolError(v)
            return v
        if name == 'get_return_summary':
            v = idx.version
            return {'version': idx.vid, 'computed_at': v['computed_at'], 'summary': v['summary'], 'diagnostics': v['diagnostics'],
                    'changes_from_previous': v['changes_from_previous'], 'tax_effect_rates': idx.rates, 'documents_superseded': v['documents_superseded']}
        if name == 'list_check_results':
            return self.known
        raise ToolError(f'Unknown tool {name}')

    def validate_finding(self, f: dict, existing: list[dict]) -> dict:
        """Return the finding as it will be stored (with priced effects), or raise ToolError."""
        idx, problems = self.idx, []
        for r in f.get('evidence') or []:
            ok, why = idx.resolve(r)
            if not ok: problems.append(f'evidence {r!r}: {why}')
        if not f.get('evidence'): problems.append('at least one evidence reference is required')
        for k in f.get('lines') or []:
            if k not in idx.lines and not k.startswith('household:'): problems.append(f'line {k!r} does not exist')
        adjs = []
        for a in f.get('adjustments') or []:
            line = idx.lines.get(a['line'])
            if not line:
                problems.append(f"adjustment line {a['line']!r} does not exist"); continue
            if not isinstance(line['value'], (int, float)) or abs(line['value'] - a['from']) > 0.5:
                problems.append(f"adjustment on {a['line']}: 'from' is {a['from']} but the engine value is {line['value']}")
            for e in a.get('effects') or []:
                if e['category'] not in idx.rates and e['category'] not in CATEGORIES_EXTRA:
                    problems.append(f"unknown effect category {e['category']!r}; use one of {sorted(idx.rates)} or payment/tax/credit")
            adjs.append(a)
        mine = {a['line'] for a in adjs}
        for x in existing:  # two proposals changing the same line would double-count its effect
            if mine & {a['line'] for a in x.get('adjustments') or []} or x.get('title', '').strip().lower() == f['title'].strip().lower():
                problems.append(f"overlaps a finding already submitted: {x['title']!r}; refine that one instead of adding another")
                break
        if problems: raise ToolError('Finding not recorded:\n- ' + '\n- '.join(problems))
        stored = {**f, 'adjustments': [{**a, 'effect': price(idx.rates, a.get('effects') or [])} for a in adjs]}
        total = {k: sum(a['effect'][k] for a in stored['adjustments']) for k in ('fed', 'ca', 'fedPay', 'caPay')}
        return {**stored, 'effect': total}
