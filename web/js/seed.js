// Optional demo history: what the team would have done between v1 and v3. Sign-offs are taken
// against the v2 figures, so when v3 arrives (Ridgeline K-1, 2023 S corp K-1) they reopen.

import * as M from './model.js';
import { rid } from './journal.js';

export function seedDemo(idx, journal) {
  const at = (clock, actor, type, payload) => journal.append({ type, payload }, { actor, clock, replay: true });
  const fp = (clock, area) => M.areaFingerprint(M.buildContext(idx, journal, clock, 'st-01'), area);
  const c1 = '2026-03-10T15:00:00Z', c2 = '2026-03-20T16:00:00Z', c3 = '2026-03-26T18:00:00Z', c4 = '2026-04-07T15:00:00Z';
  at(c1, 'st-01', 'time.log', { area: 'intake_and_engagement', hours: 1.2, note: 'Engagement, identity, prior-year review' });
  at(c1, 'st-01', 'step.complete', { step: 'Identity verified', note: 'Texas driver licenses D04/D05 match organizer names and DOBs; IP PIN notice D03 on file.' });
  at(c1, 'st-01', 'step.complete', { step: 'Prior-year return reviewed', note: 'Reviewed D06 and Delta River workpaper D07; open items carried into this file.' });
  for (const k of ['F1040.1a', 'F1040.25a']) at(c1, 'st-01', 'verify', { target: k, method: 'agreed_to_source_document', note: 'Agreed to W-2 copies D08 and D09 (D10 duplicate image).' });
  for (const k of ['SchD.6', 'SchD.14', 'F8582.1c']) at(c1, 'st-01', 'verify', { target: k, method: 'agreed_to_prior_year', note: 'Agreed to 2024 Schedule D / Form 8582 and D07 carryover worksheet.' });
  at(c2, 'st-01', 'time.log', { area: 'wages_and_stock_compensation', hours: 2.5, note: 'W-2s, stock plan supplement, ISO' });
  at(c2, 'st-01', 'time.log', { area: 'investments_and_digital_assets', hours: 3.0, note: 'Brokerage, Meridian corrected 1099, crypto' });
  at(c2, 'st-01', 'signoff', { scope: 'wages', level: 'preparer', fp: fp(c2, 'wages'), version: 'v2' });
  at(c2, 'st-01', 'signoff', { scope: 'investments', level: 'preparer', fp: fp(c2, 'investments'), version: 'v2' });
  at(c2, 'st-01', 'signoff', { scope: 'passthroughs', level: 'preparer', fp: fp(c2, 'passthroughs'), version: 'v2' });
  at(c3, 'st-01', 'note.create', { id: 'n-' + rid(), kind: 'question', to: 'client', text: 'Coinhaven lot C6 (0.05 BTC sold 06/18/2025) arrived from another wallet with no cost. When and where did you buy it, and for how much?', refs: ['F8949.H.C6', 'ev-0919'], area: 'investments', due: '2026-04-03' });
  at(c3, 'st-01', 'note.create', { id: 'n-' + rid(), kind: 'note', text: 'Call with Erik: phone 70% business, internet 50%, Spotify personal, HVAC replaced whole system. See call-01.', refs: ['call-01', 'SchC.25'], area: 'business' });
  at(c3, 'st-01', 'time.log', { area: 'business', hours: 2.0, note: 'Books, client call' });
  at(c4, 'st-02', 'signoff', { scope: 'wages', level: 'reviewer', fp: fp(c4, 'wages'), version: 'v2' });
  at(c4, 'st-02', 'note.create', { id: 'n-' + rid(), kind: 'review', to: 'st-01', text: 'Meridian summary proceeds do not tie to the lots (250 short). Page 32 was not read — get the missing sale onto the return before I sign investments.', refs: ['ev-0703', 'F8949.B.total'], blocking: true, area: 'investments', due: '2026-04-10' });
  at(c4, 'st-02', 'time.log', { area: 'partner_review', hours: 0.5, note: 'First review pass' });
}
