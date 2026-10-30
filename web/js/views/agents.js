// AI agents: two Claude agents that work as members of staff. Their runs, every tool call they made,
// their findings and the reviewer's verdicts all come from the journal like any other work.
import * as M from '../model.js';
import { esc, fmt, fmtDelta, fmtDate, btn, section, pill, table } from '../ui.js';

const STATUS = { started: ['Running', 'warn'], finished: ['Finished', 'ok'], failed: ['Failed', 'bad'] };
const VERDICT = { confirmed: 'ok', refuted: 'bad', uncertain: 'warn' };

export function viewAgents(ctx) {
  const remote = !!ctx.journal.remote;
  const status = ctx.S.agentStatus;
  const runs = [...ctx.state.ai.runs.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const latest = runs[0];
  const running = status?.running || latest?.status === 'started';
  const findings = M.aiFindings(ctx.state);

  let action = '';
  if (!remote) action = `<p class="muted sm">Available when the app runs on the shared server: <code>uvicorn server.app:app</code> with <code>ANTHROPIC_API_KEY</code> set.</p>`;
  else if (status && !status.available) action = `<p class="muted sm">The server has no Anthropic credentials. Set <code>ANTHROPIC_API_KEY</code> and restart it.</p>`;
  else if (!M.can(ctx.user, 'adjust')) action = `<p class="muted sm">Preparers, reviewers and partners start the AI preparer.</p>`;
  else action = btn(running ? '<span class="live"></span>Running…' : 'Run the AI preparer', running ? 'noop' : 'runAgent', {}, running ? '' : 'primary');

  const cards = `<div class="agentgrid">
    <div class="agentcard"><b>Claude · AI preparer</b><span class="muted">Reads the packet with the same tools a person uses, recomputes disputed figures from the sources, and proposes findings with evidence and priced adjustments. Can ask the client a question.</span><span class="sm">Cannot approve, sign off or file. Sees SSNs masked.</span></div>
    <div class="agentcard"><b>Claude · AI reviewer</b><span class="muted">Tries to refute each AI finding by checking its numbers against the sources, then votes confirmed, refuted or uncertain.</span><span class="sm">Refuted findings close themselves; a person can reopen them.</span></div>
    <div class="agentcard"><b>Guardrails on the server</b><span class="muted">Every citation must resolve to a real field, every adjustment must start from the engine’s value, and the tax effect is priced by the server. The agents’ writes pass the same permission rules as everyone’s.</span></div>
  </div>`;

  const run = latest ? (() => {
    const u = latest.usage || {};
    const st = STATUS[latest.status] || [latest.status, ''];
    const steps = (latest.steps || []).slice(-80).reverse();
    return section(`Latest run · ${esc(latest.id)}`, `
      <div class="row">${pill(st[0], st[1])}<span class="muted sm">Started ${fmtDate(latest.startedAt, true)} by ${esc(M.userName(ctx.idx, latest.startedBy) || '—')} · ${esc(latest.model || '')}</span></div>
      ${latest.error ? `<div class="callout">${esc(latest.error)}</div>` : ''}
      ${latest.status === 'finished' ? `<p>${latest.findings} finding${latest.findings === 1 ? '' : 's'} proposed · ${latest.rejected || 0} refused by guardrails and corrected · reviewer: ${Object.entries(latest.verdicts || {}).map(([k, v]) => `${v} ${k}`).join(', ') || '—'}${latest.ended && latest.ended !== 'done' ? ` · stopped at ${esc(latest.ended)}` : ''}</p>${latest.summary ? `<p class="quote">${esc(latest.summary)}</p>` : ''}` : ''}
      ${u.calls ? `<p class="muted sm">${u.calls} model calls · ${fmt(u.input_tokens)} input, ${fmt(u.cache_read_tokens)} cached, ${fmt(u.output_tokens)} output tokens · about $${(u.cost_usd || 0).toFixed(2)}</p>` : ''}
      <h4>What the agents did (${(latest.steps || []).length} tool calls)</h4>
      ${steps.length ? `<ul class="runlog">${steps.map(s => `<li><span class="muted">${fmtDate(s.at, true).split(', ').pop()}</span><span class="who">${s.agent === 'reviewer' ? 'AI reviewer' : 'AI preparer'}</span><span><code>${esc(s.tool)}</code> ${esc(s.input || '')}</span></li>`).join('')}</ul>` : '<p class="muted">No tool calls yet.</p>'}`);
  })() : section('Runs', '<p class="muted">The AI preparer has not run on this return yet.</p>');

  const rows = findings.map(f => {
    const st = M.findingState(ctx, f);
    const e = (f.adjustments || []).reduce((s, a) => { const x = M.effectOf(a.effects, ctx.rates); return { fed: s.fed + x.fed, ca: s.ca + x.ca }; }, { fed: 0, ca: 0 });
    const v = f.ai.review?.verdict;
    return `<tr><td><a href="#/findings?f=${f.id}&show=all">${esc(f.title)}</a><div class="sm muted">${esc(f.lines.join(', '))}</div></td>
      <td>${v ? pill(v, VERDICT[v]) : pill('awaiting review')}</td><td class="r">${fmtDelta(e.fed)}</td><td class="r">${fmtDelta(e.ca)}</td><td>${esc(st)}</td></tr>`;
  });

  return `<div class="hero"><div><h1>AI agents</h1><p class="sub">Two Claude agents work as members of staff. Their work goes into the same journal, under the same rules, and every proposal waits for a person.</p></div>
    <div class="hero-a">${action}</div></div>
    ${cards}
    <div style="height:20px"></div>
    ${run}
    ${section(`AI findings (${findings.length})`, findings.length ? table(['Finding', 'AI review', 'Fed tax', 'CA tax', 'State'], rows) : '<p class="muted">None yet.</p>')}
    ${runs.length > 1 ? section('Earlier runs', table(['Run', 'Started', 'Status', 'Findings', 'Cost'], runs.slice(1).map(r => `<tr><td>${esc(r.id)}</td><td>${fmtDate(r.startedAt, true)}</td><td>${esc(r.status)}</td><td>${r.findings ?? '—'}</td><td>${r.usage ? '$' + r.usage.cost_usd.toFixed(2) : '—'}</td></tr>`))) : ''}`;
}
