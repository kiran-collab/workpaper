import { buildIndex } from '../js/data.js';
import { runChecks } from '../js/checks.js';
const packet = JSON.parse(readFile('okafor_lindqvist_2025_packet.json'));
const idx = buildIndex(packet);
for (const clock of ['2026-03-20T00:00:00Z', '2026-07-20T00:00:00Z']) {
  const vid = clock < '2026-06-23' ? 'v2' : 'v3';
  const f = runChecks({ idx, vid, clock });
  print(`==== ${clock} ${vid}: ${f.length} findings`);
  for (const x of f) {
    print(`${x.severity.padEnd(6)} ${x.kind.padEnd(10)} ${x.id.padEnd(22)} ${x.title}`);
    if (x.kind !== 'pass' && x.kind !== 'diagnostic') print('       ' + x.summary.slice(0, 220));
    for (const a of x.adjustments || []) print(`       ADJ ${a.line}: ${a.from} -> ${a.to} ${JSON.stringify(a.effects)}`);
  }
}
