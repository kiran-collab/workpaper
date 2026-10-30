# Miraflores Workpaper: Okafor-Lindqvist 2025

This is a web-native tax workpaper for one household's 2025 return. Every number traces back to
its exact source field. Independent checks don't trust the engine. Adjustments keep the original.
Sign-offs reopen when what they covered changes. Filing is gated and frozen once filed. It has a
role switcher and a season clock that replays the timeline.

- **Core idea and data model:** [docs/CORE_IDEA.md](docs/CORE_IDEA.md)
- **Errors found and how they surfaced:** [docs/ERRORS_FOUND.md](docs/ERRORS_FOUND.md)

## Run it

It is static files with no build step and no dependencies. The packet loads exactly as delivered
(`okafor_lindqvist_2025_packet.json`, unchanged).

```bash
cd workpaper
python3 -m http.server 8000      # then open http://localhost:8000
```

**Host from a link:** drag the `workpaper/` folder onto Netlify Drop, or push it to GitHub Pages /
Vercel. To load a different packet, use `?packet=<url>`.

### Optional: the shared server (Python, FastAPI)

Served statically, each browser keeps its own journal. Run the FastAPI server instead and everyone
shares one journal on the server:

```bash
cd workpaper
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
.venv/bin/uvicorn server.app:app --port 8002      # then open http://localhost:8002
```

The app finds the server on its own: the top bar shows **shared server**. Nothing else changes in
the app. `js/journal.js` swaps its browser storage for `RemoteJournal`, which has the same interface.

- **Stored on the server.** Events go into one append-only SQLite log (`server/data/journal.db`), in
  the order the server assigns.
- **Permissions checked again.** The server re-checks permissions on every append (`server/rules.py`):
  - roles
  - no self-approval
  - partner approval over $1,000, with the tax effect priced by the server, not taken from the browser
  - the freeze after filing
  - undoing only your own actions

  A direct API call that skips the UI is refused just the same.
- **Live updates.** Changes reach every open browser through server-sent events.
- **Packet unchanged.** The packet is served byte for byte.
- **Sign-in is still a demo shortcut.** The browser names the acting person in an `X-User` header.
  Real authentication would replace that header.

## Independent verification (Python)

`python/verify_packet.py` is a second implementation of the error hunt, written separately from
`js/checks.js`. It uses only the standard library and does all money arithmetic in `Decimal`. It reads
the packet as delivered, recomputes all 20 issues from the source records, and prices them with the
engine's own rates:

```bash
python3 python/verify_packet.py --check    # exits 1 if any figure differs from docs/ERRORS_FOUND.md
```

It agrees with the app on every issue and on the totals: federal tax 72,478, a 4,264 refund,
California tax 13,176, and a 10,454 refund.

## A 5-minute tour

1. **Overview.** Look at the return summary (2024 vs engine vs workpaper) and the readiness gates.
   Click any number.
2. **Findings.** Thirty independent checks. Open "RSU sales taxed with zero basis" and choose
   **Propose adjustment**.
3. **Switch to Daniel (reviewer).** Approve the adjustments. The ones over $1,000 still need the
   partner. **Switch to Helen (partner)** to approve those.
4. **Firm → Data → Load demo history.** Sign-offs made at v2 show as *reopened* at v3.
5. **Documents.** Open D23, page 3, the duplicate mileage scan. Try Text and Layout modes.
6. **Season clock.** Step ▶ through the timeline. Documents, versions, the transcript and client
   messages appear as of each date.
7. **Filing.** Partner sign-off → present to client → switch to Ngozi (client) to approve and sign
   Form 8879 → transmit. Theo's SSN blocks filing until it is corrected. After acceptance the
   return is frozen; amendments go on top.
8. **Notice response.** The 2028 Letter 566 record is assembled automatically. Switch to the IRS
   examiner role to see the read-only version.
9. **Live sync.** Open a second tab as a different person. Changes appear live in both.

## Tests

```bash
# Checks engine, no browser (macOS JavaScriptCore)
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m test/checks_test.mjs
```

Python tests, covering the server rules and the independent verification:

```bash
.venv/bin/python -m pytest
```

Two browser tests run while the folder is being served. They pass both statically and against the
server:

- `test/smoke.html` renders every route at 3 clock points and in all 8 roles.
- `test/flow.html` runs the full workflow: propose → approve → sign-off → client → transmit →
  freeze.

## How AI was used

The packet analysis, the error hunt, the design and the code were done with Claude (Anthropic)
in Claude Code:

- reading the brief and packet
- scripting cross-checks of printed content against extracted values and engine lines
- writing the vanilla-JS app
- testing it with headless Chrome and JavaScriptCore

Every error listed in ERRORS_FOUND.md was verified against the packet data.
