"""The AI pipeline: an investigator agent proposes findings, a reviewer agent tries to refute each one.

Both agents are members of staff in the journal (ai-01 and ai-02, role ai_agent). Everything they do
is written as events: the run, every tool call (so a reviewer can see what the agent read), each
finding, each verdict, and any question to the client. Nothing they write changes the return; a
person adopts a finding by proposing its adjustment, and the usual approval rules apply.
"""
from __future__ import annotations

import json
import uuid
from typing import Callable

import anthropic

from .packet import PacketIndex
from .tools import ASK_CLIENT, LIST_CHECK_RESULTS, READ_TOOLS, SUBMIT_FINDING, SUBMIT_VERDICT, Toolbox, ToolError, clip

MODEL = 'claude-opus-5-5'
INVESTIGATOR, REVIEWER = 'ai-01', 'ai-02'
# USD per million tokens for MODEL (cache writes at 1.25x input).
PRICE = {'input': 4.00, 'output': 20.00, 'cache_read': 0.20, 'cache_write': 5.00}

INVESTIGATOR_SYSTEM = """You are the AI preparer at Miraflores, a tax firm, working on the Okafor-Lindqvist 2025 federal and California (540NR part-year) return.

The packet holds the client's documents (with their printed text), what an extraction pipeline read from them, and the return an engine computed from those readings. Both the extraction and the engine can be wrong, confidently. Your job is to find where, the way a careful senior preparer would.

How to work:
- Never take an engine line or an extracted value as the answer. Recompute disputed figures from what is printed on the documents, the IRS and FTB account records, the client's questionnaire answers, messages and call notes, and last year's return.
- Look across the whole return: wages and stock compensation, the Schedule C business, rentals, investments (every broker statement and its summary), deductions and credits, estimated payments, California residency and sourcing, dependents and identity, and anything that should be filed but is not.
- Read documents the pipeline only partly extracted, and pages it never read.
- When you have verified a problem, call submit_finding once for it, with evidence references a reviewer can click and the arithmetic in reasoning. Quantify a correction as adjustments when you can: "from" must be the engine's value for that line, and effects say which income, deduction or payment category changes and by how much.
- If only the client can settle something, use ask_client.
- If submit_finding is rejected, fix what it names and resubmit.
- Prefer a few well-supported findings over many guesses. A finding a reviewer can refute costs the firm time.

When you have covered the return, end with a short summary of what you found and what you could not settle."""

REVIEWER_SYSTEM = """You are the AI reviewer at Miraflores. Another agent has proposed a finding on the Okafor-Lindqvist 2025 return. Your job is to try to refute it before a person spends time on it.

Check every number in the finding against the sources yourself, using the read tools. Look for a misread document, a wrong line, double counting, a rule applied incorrectly, or a correction that is right in direction but wrong in amount. Then call submit_verdict: confirmed if the problem is real and the proposed correction is right, refuted if the problem is not real, uncertain if the evidence cannot settle it. Give the specific reasons."""


class Usage:
    def __init__(self):
        self.input = self.output = self.cache_read = self.cache_write = 0
        self.calls = 0

    def add(self, u):
        self.calls += 1
        self.input += getattr(u, 'input_tokens', 0) or 0
        self.output += getattr(u, 'output_tokens', 0) or 0
        self.cache_read += getattr(u, 'cache_read_input_tokens', 0) or 0
        self.cache_write += getattr(u, 'cache_creation_input_tokens', 0) or 0

    def cost(self) -> float:
        return round((self.input * PRICE['input'] + self.output * PRICE['output'] + self.cache_read * PRICE['cache_read'] + self.cache_write * PRICE['cache_write']) / 1e6, 4)

    def as_dict(self):
        return {'calls': self.calls, 'input_tokens': self.input, 'output_tokens': self.output, 'cache_read_tokens': self.cache_read,
                'cache_write_tokens': self.cache_write, 'cost_usd': self.cost(), 'model': MODEL}


def _short(name: str, a: dict) -> str:
    if name == 'submit_finding': return a.get('title', '')[:120]
    if name == 'submit_verdict': return f"{a.get('verdict')} ({a.get('confidence')})"
    if name == 'ask_client': return a.get('question', '')[:120]
    return ', '.join(f'{k}={v}' for k, v in a.items())[:120]


class Pipeline:
    def __init__(self, client, write: Callable[[list[dict]], None], *, idx: PacketIndex | None = None, known: list[dict] | None = None,
                 blind: bool = False, max_turns: int = 60, review_turns: int = 12, effort: str = 'high'):
        self.client, self.write = client, write
        self.idx = idx or PacketIndex()
        self.box = Toolbox(self.idx, known)
        self.blind, self.max_turns, self.review_turns, self.effort = blind, max_turns, review_turns, effort
        self.usage = Usage()
        self.run_id = 'run-' + uuid.uuid4().hex[:8]
        self.findings: list[dict] = []
        self.rejected = 0

    # ------------------------------------------------------------ plumbing
    def _event(self, actor: str, type_: str, payload: dict):
        self.write([{'type': type_, 'actor': actor, 'payload': {'run': self.run_id, **payload}}])

    def _create(self, system: str, tools: list[dict], messages: list, effort: str):
        resp = self.client.beta.messages.create(
            model=MODEL, max_tokens=16000, system=system, tools=tools, messages=messages,
            output_config={'effort': effort},
            cache_control={'type': 'ephemeral'},  # the packet reads repeat every turn; cache the prefix
            betas=['server-side-fallback-2026-07-01'], fallbacks='default',  # on a policy decline, re-run on a fallback model
        )
        self.usage.add(resp.usage)
        return resp

    def _loop(self, agent: str, system: str, tools: list[dict], task: str, turns: int, effort: str, handle) -> tuple[str, str]:
        """Run one agent until it stops calling tools. Returns (final text, how it ended)."""
        messages: list = [{'role': 'user', 'content': task}]
        for _ in range(turns):
            resp = self._create(system, tools, messages, effort)
            messages.append({'role': 'assistant', 'content': resp.content})  # append-only: thinking blocks stay intact
            if resp.stop_reason == 'refusal':
                return '', 'refused'
            uses = [b for b in resp.content if b.type == 'tool_use']
            if not uses:
                if resp.stop_reason == 'pause_turn': continue
                if resp.stop_reason == 'max_tokens':
                    messages.append({'role': 'user', 'content': 'Continue.'}); continue
                return '\n'.join(b.text for b in resp.content if b.type == 'text').strip(), 'done'
            results, stop = [], False
            for u in uses:
                inp = u.input if isinstance(u.input, dict) else json.loads(u.input)
                self._event(agent, 'ai.step', {'agent': 'investigator' if agent == INVESTIGATOR else 'reviewer', 'tool': u.name, 'input': _short(u.name, inp)})
                try:
                    out, stop_after = handle(u.name, inp)
                    results.append({'type': 'tool_result', 'tool_use_id': u.id, 'content': clip(out)})
                    stop = stop or stop_after
                except ToolError as e:
                    results.append({'type': 'tool_result', 'tool_use_id': u.id, 'content': str(e), 'is_error': True})
            messages.append({'role': 'user', 'content': results})  # all results for the turn in one message
            if stop: return '', 'done'
        return '', 'turn limit'

    # ------------------------------------------------------------ the two agents
    def _investigate(self) -> tuple[str, str]:
        tools = READ_TOOLS + [SUBMIT_FINDING, ASK_CLIENT] + ([] if self.blind else [LIST_CHECK_RESULTS])

        def handle(name, a):
            if name == 'submit_finding':
                try:
                    f = self.box.validate_finding(a, self.findings)
                except ToolError:
                    self.rejected += 1
                    raise
                f = {**f, 'id': f'AI-{self.run_id[4:]}-{len(self.findings) + 1}', 'by': INVESTIGATOR}
                self.findings.append(f)
                self._event(INVESTIGATOR, 'ai.finding', f)
                return {'recorded': f['id'], 'priced_effect': f['effect']}, False
            if name == 'ask_client':
                for r in a.get('refs') or []:
                    if not self.idx.resolve(r)[0]: raise ToolError(f'reference {r!r} does not resolve')
                self._event(INVESTIGATOR, 'note.create', {'id': 'n-ai-' + uuid.uuid4().hex[:6], 'kind': 'question', 'to': 'client', 'text': a['question'], 'refs': a.get('refs') or [], 'blocking': False})
                return 'Question sent to the client portal.', False
            return self.box.run_read(name, a), False

        task = ('Investigate the return and record every problem you can verify.' if self.blind else
                'Investigate the return. The deterministic checks have already run (see list_check_results): do not resubmit those. '
                'Look for problems they do not cover, then record each one you can verify.')
        return self._loop(INVESTIGATOR, INVESTIGATOR_SYSTEM, tools, task, self.max_turns, self.effort, handle)

    def _review(self, f: dict) -> dict:
        verdict: dict = {}

        def handle(name, a):
            if name == 'submit_verdict':
                verdict.update(a)
                return 'Verdict recorded.', True
            return self.box.run_read(name, a), False

        shown = {k: f[k] for k in ('title', 'summary', 'kind', 'lines', 'evidence', 'reasoning', 'authority', 'adjustments') if k in f}
        _, how = self._loop(REVIEWER, REVIEWER_SYSTEM, READ_TOOLS + [SUBMIT_VERDICT],
                            'Review this finding:\n' + json.dumps(shown, ensure_ascii=False, indent=1), self.review_turns, 'medium', handle)
        v = verdict or {'verdict': 'uncertain', 'confidence': 0, 'reasons': [f'Reviewer did not reach a verdict ({how}).']}
        self._event(REVIEWER, 'ai.review', {'finding': f['id'], **v})
        return v

    # ------------------------------------------------------------ entry point
    def run(self, started_by: str | None = None, review: bool = True) -> dict:
        self._event(INVESTIGATOR, 'ai.run', {'status': 'started', 'startedBy': started_by, 'blind': self.blind, 'model': MODEL})
        try:
            summary, how = self._investigate()
            verdicts = {f['id']: self._review(f) for f in self.findings} if review else {}
            counts = {v: sum(1 for x in verdicts.values() if x['verdict'] == v) for v in ('confirmed', 'refuted', 'uncertain')}
            result = {'status': 'finished', 'ended': how, 'summary': summary, 'findings': len(self.findings), 'rejected': self.rejected,
                      'verdicts': counts, 'usage': self.usage.as_dict()}
        except anthropic.AuthenticationError:
            result = {'status': 'failed', 'error': 'No valid Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) where the server runs.'}
        except anthropic.RateLimitError:
            result = {'status': 'failed', 'error': 'Rate limited by the Anthropic API. Try again shortly.'}
        except anthropic.APIStatusError as e:
            result = {'status': 'failed', 'error': f'Anthropic API error {e.status_code}: {e.message}'}
        except anthropic.APIConnectionError:
            result = {'status': 'failed', 'error': 'Could not reach the Anthropic API.'}
        except Exception as e:  # e.g. the server refused one of the agent's writes
            result = {'status': 'failed', 'error': f'{type(e).__name__}: {e}'}
        result['usage'] = self.usage.as_dict()
        self._event(INVESTIGATOR, 'ai.run', result)
        return {**result, 'run': self.run_id, 'finding_list': self.findings}
