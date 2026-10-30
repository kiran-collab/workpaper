# Video walkthrough script (about 8 minutes)

## Before you record

- **Use a fresh start.** Open the app link, then go to **Firm → Data** and reset, so you start from a
  clean workpaper.
- **Prepare a second window.** Open the app in a second browser window and keep it ready for the
  live-sync part.
- **Open the submission site in a tab** (https://claude.ai/artifact/L79wZLJKfBkfZEZuZdbeXN). You'll
  use its Errors and Architecture pages near the end.
- **Choose a recorder.** Use one of these:
  - **Loom** (loom.com, free). It records your screen and webcam and gives you a link straight
    away.
  - **QuickTime.** Choose File → New Screen Recording, then upload the file to YouTube (Unlisted)
    or Google Drive ("Anyone with the link").
- **Rehearse once.** Speak in your own words. The lines below are a guide, not a script to read.

---

## 1. The problem (0:00–0:45)

**Show:** the Overview page.

> "A tax workpaper today is a spreadsheet. The numbers are in one place, and the proof is
> somewhere else: tick marks, a binder, the reviewer's memory. The case gave me a pipeline packet
> for one household, the Okafor-Lindqvists. It has documents, the values read from them, and three
> versions of the return the engine computed. My core idea is that every number on screen should
> carry its own proof."

## 2. Provenance: click any number (0:45–1:45)

**Show:**

1. On Overview, click a figure in the Return summary, for example federal **Total tax**.
2. In the inspector, point at the rule, the input tree, and the source fields.
3. Click a source field to open the document page with the field highlighted. Switch between
   **Text** and **Layout** modes.

> "Every number knows where it came from. One resolver handles every reference format in the
> packet, so any line goes back to the exact field on the exact page. Documents work the other
> way round too: each one lists every line it landed on, or why it landed nowhere."

**Technical decision:**

> "The pages are drawn from the packet's printed text, behind a DocumentSource seam. If real
> scans are added, the same highlight boxes sit over the image and nothing else changes."

## 3. Independent checks find the errors (1:45–3:15)

**Show:**

1. Open **Findings**.
2. Find "RSU sales taxed with zero basis". Point at the engine value next to the expected value,
   and the tax effect at the top right of the card.
3. Click **Details** on the card to show the evidence links and the lines it affects. Click one
   evidence link to show it opens the source.
4. Click **Propose adjustment**. Mention that **More ▾** holds the other choices: mark resolved,
   accept as is, dismiss, review note, record judgment.

> "I didn't trust the engine. There are thirty checks, and each one works out the figure again
> from the raw records: printed text, IRS and FTB transcripts, client answers, last year's return.
> None of them takes an engine line as the answer. Some checks test several things, so on screen
> that's 50 results: 40 findings and 10 that agree with the engine. When a check disagrees, it
> becomes a finding with the evidence and an adjustment ready to propose."

**Mention the big errors:**

- The RSU zero basis, about $15.5k of federal tax.
- The 1099-K counted twice.
- California wages that include the Texas months.
- A duplicate scan of a mileage log page.
- A Q4 estimate taken from the client's memory.

> "In total, federal tax goes from 81,962 to 72,478, and the balance turns from 4,220 owed into a
> 4,264 refund."

**Show the passed checks:** click the **Passed checks** tab.

> "Checks that agree with the engine are shown as passed, not hidden. That's how the reviewer
> knows what was actually tested."

## 4. Roles and approvals (3:15–4:30)

**Show:**

1. Switch to **Daniel (reviewer)** and approve the adjustments. Point out that the large ones
   still need the partner.
2. Try approving your own adjustment, and show that it is blocked.
3. Switch to **Helen (partner)** and approve the rest.
4. Switch to the **preparer without clearance** and show that SSNs are masked.

> "Roles are checked inside every action, not just by hiding buttons. Adjustments over the firm's
> $1,000 threshold need a partner, and nobody can approve their own. Staff without clearance only
> see masked SSNs, and every time someone reveals one, that is logged."

## 5. The journal, sign-offs and the season clock (4:30–5:45)

**Show:**

1. Load **Firm → Data → Load demo history**.
2. Point at a sign-off showing *reopened*, with its reason ("return recomputed v2 → v3").
3. Step the **season clock** back and forward. Documents, versions and messages appear as of
   each date.
4. Show live sync: in the second window, as a different person, make a change and watch it
   appear in the first window.

> "Nothing is ever edited in place. Every action is an event in an append-only journal, and what
> you see is the packet with the journal replayed on top. That gives me undo, a full history, and
> the season clock almost for free. A sign-off stores a fingerprint of everything it covered. If
> anything under it changes, it reopens and says why."

## 6. Filing (5:45–6:45)

**Show:**

1. Go to **Filing**. Point at the blockers.
2. Do the partner sign-off, then present the return to the client.
3. Switch to **Ngozi (client)**. Approve and sign Form 8879.
4. Try to transmit. It is blocked by Theo's SSN.
5. Fix the SSN and transmit. The return is accepted and frozen.
6. Try an edit and show that it is blocked.

> "Theo's SSN was transposed in the organizer. That is what caused the real e-file rejection in
> July. Here the filing gate catches it before transmission. Once the return is accepted it is
> frozen, and any change becomes an amendment on top."

**Optional:** show the notice response, and the read-only **IRS examiner** view.

## 7. Technical decisions and tradeoffs (6:45–8:00)

**Show:** the submission site.

1. **Errors** page: toggle Federal / California on the chart, and expand one issue.
2. **Architecture** page: press **Play** and let it step through what happens when the reviewer
   clicks Approve.
3. Optional: **Core idea → Try the fold**. Untick an event and show the sign-off reopen.

Then talk through the decisions:

- **No backend.**
  > "The journal lives in the browser's localStorage, files in IndexedDB, and tabs sync over
  > BroadcastChannel. It runs from any static link and still behaves like several people working
  > together. In production I'd replace that with one append-only server API, and the event model
  > stays the same."
- **No engine rerun.**
  > "A tax effect is estimated as the change times the engine's per-dollar rate, and it's labelled
  > as an estimate. Where the engine had a what-if result, like the HVAC change, I used that."
- **No build step, no dependencies.**
  > "It's plain JavaScript modules, so the packet loads exactly as delivered and the folder deploys
  > as it is. The cost is hand-written rendering."
- **Checks are specific to this packet.**
  > "The next step would be to match documents by type instead of by ID, so the same checks work
  > for any client."
- **How I used AI.**
  > "I built this with Claude Code. I used it to read the packet, script the cross-checks, and
  > write and test the app. I verified every error against the packet data myself."

**Close:**

> "So the workpaper isn't a grid of numbers. It's a set of claims, and each one can show you its
> proof."
