# Core idea and data model

## The idea: every number is a claim that carries its own proof

A spreadsheet workpaper is a grid of numbers, with the proof kept somewhere else: tick marks, a
binder, the reviewer's memory. This workpaper turns that around. The unit is a **claim** (a return
line, an extracted value, a document), and each claim brings its proof with it:

- **Provenance.** Each claim knows where it came from. Click any number, anywhere, and you get the
  rule that built it, the input tree, and the exact field on the exact page of the source document,
  highlighted. Each document also lists every line it landed on, or why it landed nowhere.
- **Independent checks.** Thirty checks re-derive figures from the raw records (printed text,
  agency transcripts, client answers, prior-year return). None of them takes an engine line as the
  answer. A disagreement becomes a *finding* that already contains a proposed adjustment and its
  tax effect.
- **An append-only journal of human judgment.** Verifications, adjustments, notes, questions,
  sign-offs, decisions, dispositions, filing events and sensitive-data views are all events. The
  pipeline output is never edited. The current workpaper is `fold(packet, journal)`.

The rest follows from those three parts:

- **Undo** is a new event that reverses earlier ones.
- **History** is the journal itself.
- **Freeze at filing** is a stored fingerprint.
- **Amendments** are events layered on top of the frozen return.
- **Season replay** is the same fold, run at a different clock.

## Data model

```
Packet (immutable, loaded as delivered)
  documents ─┬─ pages.printed_content           ← what is really printed
             └─ extracted_values (ev-NNNN)      ← what the pipeline read (can be wrong)
  return_versions v1..v3 ─ lines {key, rule, inputs[], sources[]}  ← engine (can be wrong)
  client answers · prior_years · agency records · firm · timeline

Index (built at load)
  usedBy: ref → [{version, line}]       (any document → everywhere it landed)
  resolveRef(ref)                        (one resolver for every reference format in the README)

Journal (append-only events: {id, seq, at, clock, actor, batch, type, payload})
  verify · adjust.propose/approve/reject/withdraw · note.create/reply/resolve (note|question|review|variance)
  signoff{scope, level, fp, version} · decision · finding.status · doc.disposition · evidence.attach
  task · time.log · view.sensitive · standards.update · staff.update · step.complete · dd.answer
  household.fix · text.fix · filing.present/client_approve/sign8879/submit/freeze/amend · undo

Derived (pure functions, recomputed on every change)
  findings = runChecks(packet, version, clock)
  lineView(key) = engine value + latest active adjustment (original always kept)
  adjusted summary = engine summary + Σ(change × version per-dollar rate)
  signoff state = stored fingerprint vs current fingerprint → fresh | reopened (with reason)
  steps / blockers = the firm's 12 required steps, evaluated from state
```

**Adjustments** record the original value, the new value, who made them, why, the authority relied
on, and a structured tax effect `[{category, amount, jurisdiction}]`. The effect is priced with the
active version's `tax_effect_rates`. For the HVAC change the effect comes straight from the
engine's what-if result. When the effect is over the firm threshold ($1,000, which the
administrator can change), the adjustment stays *proposed* until a partner approves it. No one can
approve their own adjustment.

**Sign-offs** store a hash of every figure, adjustment, text fix and received document in their
scope. If any of those change, the sign-off reopens and says why: for example "return recomputed
v2 → v3", or "2 adjustment changes after sign-off". The client's Form 8879 is bound to the
fingerprint of the return as it was presented.

**Documents** render through a `DocumentSource` seam. Today every page is simulated from
`printed_content`:

- In **Text** mode, values are highlighted inline.
- In **Layout** mode, each value is drawn as a box at the pipeline's `position`.

To use a real scan, register the file (`window.WP_REAL_DOCS = {D08: {1: 'w2.png'}}`). The same
`position` boxes then overlay the image. Links (`#/docs/D08/1?ev=ev-0016`) and all trace data stay
the same.

**Roles** are enforced inside every action, not only by hiding buttons. They are: preparer,
reviewer, partner, preparer without clearance, firm administrator, quality reviewer, client, and
IRS examiner (read-only record). Staff without clearance only ever receive masked SSNs and account
numbers. Every unmasked view is journaled.

## Tradeoffs

- **No backend required.** Served statically, the journal lives in localStorage, attached files live in IndexedDB, and open
  tabs stay in sync live through BroadcastChannel. This gives real multi-person behaviour on one
  machine and runs from any static link. That swap is built as an option: `server/` (FastAPI and
  SQLite) is one append-only API with server ordering. It re-checks every permission and streams
  changes to every browser. The event model did not change.
- **No engine rerun.** The tax effect is change × rate, labelled as an estimate everywhere it
  appears. Engine what-if results are used where they exist.
- **No build step, no dependencies.** The app is vanilla ES modules, so the packet loads as
  delivered and the folder deploys as-is. The cost is hand-rolled rendering: string templates and
  one delegated event handler.
