"""Test doubles: a scripted stand-in for the Claude API, and a known-good finding."""
from types import SimpleNamespace as NS

MILEAGE = {
    'title': 'Mileage log page counted twice', 'summary': 'Page 3 repeats page 2; business miles are 8,100, not 11,800.',
    'severity': 'high', 'kind': 'extraction', 'lines': ['SchC.44a', 'SchC.9'], 'evidence': ['D23', 'doc:D23#page3'],
    'reasoning': ['8,100 mi × 0.70 = 5,670 vs engine 8,260'], 'confidence': 0.9,
    'adjustments': [{'line': 'SchC.9', 'from': 8260, 'to': 5670, 'effects': [{'category': 'schc_profit', 'amount': 2590}]}],
}


def text(t): return NS(type='text', text=t)
def tool(i, name, inp): return NS(type='tool_use', id=f'tu-{i}', name=name, input=inp)
def resp(content, stop='tool_use'):
    return NS(content=content, stop_reason=stop, usage=NS(input_tokens=1000, output_tokens=200, cache_read_input_tokens=500, cache_creation_input_tokens=0))


class FakeClient:
    def __init__(self, script):
        self.script, self.calls = list(script), []
        self.beta = NS(messages=NS(create=self.create))

    def create(self, **kw):
        self.calls.append({**kw, 'messages': list(kw['messages'])})  # snapshot: the runner keeps appending
        return self.script.pop(0)
