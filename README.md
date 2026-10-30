# Miraflores Workpaper: Okafor-Lindqvist 2025

This is an AI-native tax workpaper for one household's 2025 return. It has three parts:

- **An event-sourced web app.** Every number traces to its exact source field, and every action is
  an event in an append-only journal.
- **A Python checks engine.** It recomputes disputed figures from the source documents instead of
  trusting the engine.
- **Two Claude agents.** They work as members of staff, under the same rules as people.

Further reading:

- **Core idea and data model:** [docs/CORE_IDEA.md](docs/CORE_IDEA.md)
- **Errors found and how they surfaced:** [docs/ERRORS_FOUND.md](docs/ERRORS_FOUND.md)
- **Architecture diagram:** [docs/architecture.html](docs/architecture.html)

## Quick start

```bash
make install          # .venv + the package with dev tools (Python 3.11+)
make serve            # app + shared journal + AI agents → http://localhost:8002
```

**API credentials.** The AI agents need Anthropic credentials. Copy `.env.example` to `.env` and set
`ANTHROPIC_API_KEY`. The `.env` file is git-ignored. Everything else works without a key.

**No server at all.** For a static link with no server: `make static` → http://localhost:8001. In
that mode the journal lives in each browser. The `web/` folder deploys as-is to any static host,
such as Netlify Drop or GitHub Pages.

## Project layout

```
src/workpaper/            the Python package
  config.py               paths and settings (env-overridable), .env loading
  checks.py               the 30 checks and the one pricing rule: the single source of truth
  findings.py             findings at every point in the season → web/data/findings.json
  report.py               the 20 issues and the net effect; --check guards the published figures
  cli.py                  the `workpaper` command
  server/app.py           FastAPI: journal API, server-sent events, agent runtime, serves web/
  server/rules.py         server-side permissions, re-checked on every write
  agents/packet.py        the agents' read-only, PII-masked view of the packet
  agents/tools.py         tool schemas, execution and guardrails
  agents/runner.py        the AI preparer and AI reviewer loops (Claude tool use)
  agents/evaluate.py      blind evaluation against the 20 known issues
web/                      the app: plain JavaScript modules, no build step
  data/                   the packet (as delivered) and the generated findings.json
tests/                    pytest: checks, server, agents (Claude replaced by a scripted fake)
  e2e/                    real-browser tests in Chrome; they start their own servers
docs/                     design notes
```

## Commands

| | |
|---|---|
| `make serve` · `workpaper serve` | App, shared journal and AI agents on port 8002 |
| `make static` | The static app alone on port 8001 |
| `make findings` · `workpaper build-findings` | Rebuild `web/data/findings.json` after changing a check |
| `make report` · `workpaper report --check` | The 20 issues and the totals, checked against docs/ERRORS_FOUND.md |
| `make test` | Unit and integration tests: no browser, no API calls |
| `make e2e` | Browser tests in Chrome, in both static and server modes |
| `make lint` | ruff |
| `make eval` · `workpaper eval --yes` | Score the AI preparer blind. This spends API credit |
| `make docker` | Build the server image |

## How it works

### The checks, in Python only

The 30 checks live in `src/workpaper/checks.py`. The app displays their findings and never computes
them:

- **On the server,** they are computed live.
- **For the static link,** `workpaper build-findings` saves them at every point in the season.

Findings depend only on what is known at a point in the season, so a snapshot is exact. A test fails
if `findings.json` falls out of date.

**Port from JavaScript.** The checks were first written in JavaScript. Before that version was
deleted, the Python port reproduced its output exactly at all 102 change points: 5,059 findings and
72,672 values.

**Results.** `workpaper report --check` gives federal tax 72,478 (the engine said 81,962) and a
4,264 refund (the engine said 4,220 due). California tax is 13,176, with a 10,454 refund.

### The shared server

The journal has one interface and two stores: browser storage for the static link, or the FastAPI
server. The app detects the server on its own.

- **Storage.** The server keeps one append-only SQLite log, in the order it assigns.
- **Live updates.** It streams changes to every browser over server-sent events.
- **Rules.** It re-checks every write: roles, no self-approval, partner approval over $1,000 (with
  the tax effect priced by the server), the freeze after filing, and undoing only your own actions.
  A direct API call that skips the UI is refused all the same.
- **Identity** is a demo header (`X-User`). Real authentication is the next step.

### AI agents

Two Claude agents (`claude-opus-5-5`) run inside the server as journal members `ai-01` and `ai-02`:

1. **The AI preparer** reads the packet through the same tools a person uses, recomputes disputed
   figures, and submits findings with clickable evidence and priced fixes. It can also ask the
   client a question. In normal runs it sees the checks' results and looks for what they miss.
2. **The AI reviewer** tries to refute each finding against the sources and votes *confirmed*,
   *refuted* or *uncertain*.
3. **A person adopts a finding.** From there, the normal approvals apply.

**Guardrails, enforced on the server:**

- **Citations.** A finding is refused, with the reason sent back to the agent, if:
  - a citation does not resolve to a real field
  - a line does not exist
  - a fix does not start from the engine's value
  - it would double-count a line
- **Pricing.** The server prices the tax effect.
- **Permissions.** The agents' writes pass the same permission rules as everyone's. Their role
  cannot approve, sign off or file.
- **Privacy.** The agents see SSNs masked to the last four digits.
- **Audit.** Every tool call is logged as an event.
- **Model settings.** Requests use adaptive thinking, prompt caching and a refusal fallback. Each
  run's token use and cost are recorded.

**Evaluation (first run, blind, 60-turn cap):**

- **Recall:** 14 of the 20 known issues found.
- **Pricing:** 10 of 11 priced fixes matched the checks' federal effect to the dollar.
- **Reviewer:** 13 confirmed, 0 refuted, 1 uncertain.
- **New issue:** one finding not on the list, an SEP-IRA contribution over the limit. A person still
  needs to confirm it.
- **One miss:** the California effect of the RSU fix was overstated, and the reviewer agent missed
  it.
- **Run:** $3.91 and 11 minutes. It stopped while reading the rentals, so the remaining six issues
  were never reached.

## Testing

- **`make test`** runs 41 tests:
  - the checks against the published figures, and `findings.json` being current
  - the server rules, including direct API bypass, self-approval and the freeze
  - the AI agent loop

  The agent tests run against a scripted stand-in for Claude, so they are offline, free and
  deterministic.
- **`make e2e`** drives Chrome through Playwright against both deployments, starting its own
  servers:
  - every route in 3 season dates and all 8 roles
  - the full workflow, from findings to approvals, sign-offs, client signature, transmit and the
    frozen return
- **CI** (`.github/workflows/ci.yml`) runs lint, the tests, the report check and the browser tests.

## A 5-minute tour

1. **Overview.** Click any number to see its rule, inputs and the exact field on the page.
2. **Findings.** Open "RSU sales taxed with zero basis" and choose **Propose adjustment**.
3. **Switch to Daniel (reviewer), then Helen (partner).** Approve the fixes. The ones over $1,000
   wait for the partner.
4. **AI agents.** Run the AI preparer, watch its tool calls, then adopt one of its findings.
5. **Season clock.** Step through the timeline. Documents, versions and messages appear as of each
   date.
6. **Filing.** Partner sign-off → client approval and Form 8879 → transmit. Theo's SSN blocks
   filing until it is fixed, and the accepted return is frozen.

## How AI was used

The packet analysis, the error hunt, the design and the code were done with Claude in Claude Code.
Inside the product, Claude runs as the AI preparer and the AI reviewer. Every error in
ERRORS_FOUND.md was verified against the packet data.
