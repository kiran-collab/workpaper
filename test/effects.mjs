import { buildIndex } from '../js/data.js';
import { runChecks } from '../js/checks.js';
import { effectOf } from '../js/model.js';
const idx = buildIndex(JSON.parse(readFile('okafor_lindqvist_2025_packet.json')));
const vid='v3'; const rates = idx.versions[2].tax_effect_rates;
let T={fed:0,ca:0,fp:0,cp:0};
for (const f of runChecks({ idx, vid, clock: '2026-07-20T00:00:00Z' })) {
  if (!f.adjustments?.length) continue;
  const e = f.adjustments.reduce((s,a)=>{const x=effectOf(a.effects,rates);return {fed:s.fed+x.fed,ca:s.ca+x.ca,fp:s.fp+x.fedPay,cp:s.cp+x.caPay}},{fed:0,ca:0,fp:0,cp:0});
  for (const k in T) T[k]+=e[k];
  print(`${f.id.padEnd(20)} fed ${e.fed} ca ${e.ca} pay ${e.fp}/${e.cp}`);
}
print('TOTAL '+JSON.stringify(T));
