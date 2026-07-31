# Manulife statement fund codes

What each fund on the Manulife Wealth statement is, and the ticker to enter for
it on the **Import** tab. Fund names and codes only — no unit counts or
balances.

Kept as the paper trail for how each fund was identified, and as a fallback.
**The account site's export supersedes it**: it states the ticker for every
position outright, so the import needs no codes from here. Where the two
disagree, the export wins — it is the broker's own record. It corrected two
entries below, marked ⚠️.

## Which kind of code to enter

| Code | Example | What you get |
|---|---|---|
| Exchange ticker | `FBAL.NE`, `VVL.TO` | Live price **and** BUY/SELL signals |
| Yahoo fund ID | `0P00019WHF.TO` | NAV history, so signals work |
| FundSERV code | `FID5494` | Current price only, via the Globe and Mail fallback — no signals, and the daily job logs it as a failure each run |

Prefer an exchange ticker, then a Yahoo fund ID, then FundSERV. The **Find
ticker** button on the Import tab searches Yahoo by fund name and returns the
first two kinds.

To verify any FundSERV code by hand, open
`theglobeandmail.com/investing/markets/funds/<CODE>.CF/` and compare its NAV to
the per-unit price on the statement. Expect a small drift for the time elapsed,
not a different number.

## The codes

Statement names as printed, per account, from the June 30 2026 statement.

### Non-registered (`Cash`, `Cash USD`)

| Statement name | Fund | Enter |
|---|---|---|
| `CIG GLB EQ CC CL F` | CI Global Equity Corporate Class F | `CIG4323` |
| `FDLTY GLB INC CL PORT SR F` | Fidelity Global Income **Class** Portfolio Series F | `FID2682` |
| `GOC AA PRT CLS SR F` | Canoe Asset Allocation Portfolio Class Series F | `GOC303` |
| `MMF MLF GLB MO HI INC CL` | Manulife Global Monthly High Income Class | `MMF8637` (Series F — statement doesn't print the series) |
| `MMF MLF DIV INC CL` | Manulife Dividend Income Class | `MMF8645` (Series F — same caveat) |
| `RBF Q MN WE CL F` | RBC QUBE Market Neutral World Equity Fund F | ⚠️ `RBF941` per the export — research had suggested `RBF1441`/`RBF2941`, both wrong |
| `BNS INV SAV ACT SR A -NL $US` | Scotia US$ Investment Savings Account | — a savings account, always $1.00/unit. Not a security; don't import |

### Locked-in RRSP

| Statement name | Fund | Enter |
|---|---|---|
| `FIDELITY ALL IN ONE BAL ETF` | Fidelity All-in-One Balanced ETF | `FBAL.NE` |

### RRSP

| Statement name | Fund | Enter |
|---|---|---|
| `CI U.S. QUALITY DIVDND GRT ETF` | CI U.S. Quality Dividend Growth Index ETF | `DGR-B.TO` — the export shows `DGR.B`, the unhedged series |
| `VANGUARD GLOBAL VALUE ETF UN` | Vanguard Global Value Factor ETF | `VVL.TO` |
| `BMO TACT GLB EQ ETF` | BMO Tactical Global Equity ETF Fund F | ⚠️ `BMO95217` per the export — the no-load variant, not `BMO68217` |
| `CI PREC MTL FD CL F` | CI Precious Metals **Fund** Series F | `CIG54203` (`CIG54003` is the *Class* version) |
| `CIG FD CL F` | CI Ethereum Fund Series F C$ | `CIG4082` — see note below |
| `DYNAMIC PREM BAL PP CL F` | Dynamic Premium Balanced Private Pool Class F | `DYN3915` |
| `FDLTY GLOBAL EQUITY+ SR F` | Fidelity Global Equity+ Fund Series F | `FID7648` (Yahoo: `0P0001RNX5.TO`) |
| `FDLTY INSIG CL SR F` | Fidelity Insights Class Series F | `FID5494` (Yahoo: `0P00019WHF.TO`) |
| `CCM TRGT CLICK 2030 FUND F` | iA Clarington Target Click 2030 Fund F | `CCM8028` per the export |
| `GOOD NATURED PRODS INC*` | good natured Products Inc. | — delisted from the TSXV in November 2024 after Hilco Capital acquired the company; the position shows 4 units at $0.00. No live ticker; don't import |

### TFSA

| Statement name | Fund | Enter |
|---|---|---|
| `FIDELITY ALL IN ONE BAL ETF` | Fidelity All-in-One Balanced ETF | `FBAL.NE` |
| `FDLTY GLOBAL EQUITY+ SR F` | Fidelity Global Equity+ Fund Series F | `FID7648` |
| `FDLTY INSIG CL SR F` | Fidelity Insights Class Series F | `FID5494` |
| `TDB US DISP E ALPHA SR F` | TD U.S. Disciplined Equity Alpha Fund F | `TDB3173` |

## Notes on the uncertain ones

**`CIG FD CL F` → CI Ethereum Fund.** The abbreviation never says "Ethereum".
It rests on the position matching the 2023 statement's `CI ETHEREUM FUND A -FE`
(741 units at $8.20 then, 724 at $8.09 now) and a CAD Series F existing at
`CIG4082`. Check the NAV before relying on it.

**`CCM TRGT CLICK 2030 FUND F` — resolved by the export as `CCM8028`.** No
public listing carries it: only Series A (`CCM8025`) is on the Globe and Mail,
which fits a closed maturity-date fund. This is the clearest illustration of
why the export beats research.

**The two `MMF` funds print no series.** Every other holding shows `SR F` or
`CL F`; these show neither. Series F is the reasonable assumption given the
account is fee-based, but the NAV check is worth doing.

## Why nothing matched on the first import

The 2023 holdings were all `-FE` (front-end load) and the 2026 ones are all
`-NL` (fee-based F series): the accounts were converted to a fee-based
structure, and Manulife Wealth moved to Fidelity Clearing Canada, which
abbreviates fund names differently. Even where the same fund is held, the
printed name and the code differ — so a first import after the change matches
nothing, and every fund reads as new.

## Sources

- [The Globe and Mail fund database](https://www.theglobeandmail.com/investing/markets/funds/finder/) — FundSERV codes; page titles carry the code
- [Canoe Financial fund codes](https://www.canoefinancial.com/mutual-funds) — `GOC` prefix
- [iA Clarington](https://iaclarington.com/) — `CCM` prefix
- [Morningstar Canada](https://global.morningstar.com/en-ca) — Yahoo/Morningstar `0P…` fund IDs
