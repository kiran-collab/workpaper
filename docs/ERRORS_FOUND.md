# Errors found in the packet, and how the design surfaced them

Each error below is caught by an independent check in `src/workpaper/checks.py`. The check recomputes the
figure from source records and shows the result as a **finding**. A finding carries:

- the engine value and the expected value
- the evidence, as clickable links to the document field
- the affected lines
- a one-click proposed adjustment with its tax effect

Tax effects are priced at the v3 per-dollar rates. Positive means more tax.

## Engine and extraction errors (confident, wrong)

| # | Error | How it was caught | Fed tax | CA tax |
|---|---|---|---:|---:|
| 1 | **RSU sales taxed with zero basis.** Three noncovered lots (N1, N3, N4) used the broker's blank basis. The stock-plan supplement (D11) gives 19,100 / 19,100 / 9,420. Without that basis, the vest income already on the W-2 is taxed twice. | Matches supplement lots to 8949 lots by acquisition date. The engine only matched the ESPP lot. | −15,536 | −1,618 |
| 2 | **Form 1099-K counted twice.** Gross receipts are 163,700, which is books 151,300 plus 1099-K 12,400. The 12,400 is Atlas paying by card, already deposited and booked (D15 p3), and already inside Atlas's 1099-NEC. | Reconciles 1099-NECs (142,000) + no-1099 clients (9,300) = books 151,300. The card amount equals the Paywell deposit detail. | −4,402 | −384 |
| 3 | **California-source wages include Texas-period pay.** The engine used W-2 box 16 (218,400). Halvorsen kept CA as the work state through 09/30 by mistake. | Reads the W-2 text and the 07/18 paystub (D73): CA wages at the move were 22,469. CA-source wages are 129,569. | — | −5,685 |
| 4 | **Mileage log page counted twice.** Page 3 is a second scan of page 2. Business miles are 8,100, not 11,800. | Compares per-page trip signatures (date, destination, miles), then checks against the odometer. | +919 | +80 |
| 5 | **Federal Q4 estimate taken from the client's memory.** The engine used "4,000 I think" (qa-41). The IRS transcript shows 3,000 on 01/15/2026. | Agrees F1040.26 to the transcript. EFTPS confirms only three payments. | payments −1,000 | |
| 6 | **CA estimates include a payment applied to 2024.** The 09/15/2025 Web Pay payment (3,500) was designated tax year 2024. The FTB holds it as a 2024 credit. | Agrees F540NR.72 to the FTB account and the payment's designated-year field. | | payments −3,500 |
| 7 | **Same interest counted twice.** Northlake Bank 1099-INT (D29) is the sweep inside the Northlake Securities account ending 7731, which is already on the composite (D28). | Equal amounts plus a shared account number in both printed texts. The 2024 return reported the interest once. | −640 | −127 |
| 8 | **Swedish interest converted at the 2024 rate** (10.56). The 2025 average is 9.86: 1,871, not 1,747. | Any `ref:fx` source whose year differs from the tax year. | +43 | +9 |
| 9 | **Meridian page 32 never read.** Lot M18 (proceeds 250, basis 310) is missing. The summary is 71,965 against lots of 71,715. | Parses unread pages named in `extraction.reason` and reconciles the lots to the printed summary. | −21 | −2 |
| 10 | **Payoff interest double-counted.** Lonestar's 1098 already includes the payoff interest, and the engine added the payoff statement's 2,150 again. | The text of D55 and D56 says so. | +559 | +103 |
| 11 | **Home property tax includes the seller's share.** The seller credited 6,912 at closing for 01/01–07/07, so only 6,508 is deductible. SALT then drops under the cap. | Buyer closing statement (D54) vs the 1098 escrow amount. | +1,462 | +332 |
| 12 | **Donated car at Blue Book (6,000), not sale proceeds (2,900).** The 1098-C shows an arm's-length sale. | Checks the 1098-C box 4a/4c rule. This is later an examination item. | +806 | +149 |
| 13 | **Care provider TIN misread.** The pipeline read 74-3829516 at 97% confidence. The statement prints 74-3829156. | Every EIN value is checked against the printed text, with a transposition match. | form accuracy | |
| 14 | **Wrong provider name on Form 2441** ("Bright Oak Preschool"). The statement and the 2024 return say Bright Oak Kids Club. | Compares the label to the document text. | form accuracy | |
| 15 | **Theo's SSN transposed in the organizer** (…3309). The 2024 return and the SS card say …3390. | Dependents are checked against the prior-year return before filing. **The filing gate blocks transmission.** In the real season this caused the 07/13 e-file rejection. | e-file reject | |

## Judgment calls the engine made silently

| # | Issue | Evidence | Fed tax | CA tax |
|---|---|---|---:|---:|
| 16 | **SE health insurance deducted** (14,400) although Erik was eligible for Ngozi's employer family plan. IRC 162(l)(2)(B). The 2024 return took none for the same reason. | qa-25, 2024 notes | +4,464 | +605 |
| 17 | **HVAC replacement expensed** (11,000). The whole system was replaced with a heat pump, under permit, so it should be capitalized over 27.5 years. Reg. 1.263(a)-3. The effect is taken from the engine's own what-if. | D47, call-01 | +3,633 | +896 |
| 18 | **Crypto lot C6 at zero basis and short-term.** The client's bank record shows 3,050 paid on 03/15/2021, which makes it long-term. | msg-07 | −1,312 | −104 |
| 19 | **Family phone (4 lines) and home internet deducted at 100%.** Call notes say 70% and 50% business. | D15, call-01 | +464 | +41 |
| 20 | **Spotify Family in business software.** The client confirmed it is personal. | D15, call-01 | +77 | +7 |

**Net effect if all are adopted:**

| | Engine v3 | Workpaper |
|---|---:|---:|
| Federal total tax | 81,962 | 72,478 |
| Federal balance | 4,220 due | 4,264 refund |
| California total tax | 18,874 | 13,176 |
| California refund | 8,256 | 10,454 |

## Conflicts where the engine was right and the client was not

- **IRA basis.** The client said "no prior basis". The 2024 Form 8606 and the 2024 Form 5498 show
  7,000. The finding is closed as *agreed to prior year*, with no change.
- **"Did you sell investments? No."** In fact there were 295 sales.
- **St. Brigid receipt.** It reads "$?,500" at 41% confidence. It was resolved by the client's
  06/30 confirmation and the bank check.

## Outside filings and completeness the design identifies

- **FBAR 2025** (max 149,567 USD). Outside the engagement scope; the client files it.
- **Late Forms 1099-NEC** for two contractors.
- **Form 3520** for the 2023 Swedish inheritance. The prior preparer left this unresolved.
- **Ada's own return.**
- **Oregon and Arizona composite returns.**
- **California AMT on the ISO exercise**, which the engine did not compute.
- **Prior preparer's 2024 home office overstatement** (300 sq ft vs 220 measured).
- **Extension underpayment.** The v2 estimate used the overstated Q4 payment.

## Checks that agree with the engine (shown as passed, not hidden)

These all recompute to the dollar:

- W-2 totals (the D10 duplicate image is counted once)
- excess social security
- S corp basis rolled forward independently (21,300 → 15,400 → 2,300)
- regular tax from the brackets (Schedule D worksheet, §1250 gain at ≤25%), 59,727
- California tax, 32,328
- NIIT, 7,095
- CTC phase-out, 400
- SE tax, 11,565
- all 78 totals foot
- all 295 sales lot by lot, plus the 260-lot Brightpath summary
