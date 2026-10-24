# TSX ETF Signal Notifier

Notification-only buy/sell signal tracker for TSX ETFs, optimized for a
**5-year hold horizon**. Tracks holdings with recent prices, evaluates daily
rules-based signals, and emails high-confidence alerts with plain-language
reasoning and a historical hold-time estimate.

**This tool never places trades.** It is strictly informational.

- **Live site**: https://invest.imetrobert.com
  (imetrobert.github.io/tsx-etf-signal-notifier redirects there)
- **Login**: shared Supabase Auth account — same email/password as the
  invoicing app and claims tracker.

## How signals work

The signal job runs hourly through the trading day (weekdays ~9am–5pm
Toronto) plus a final after-close run, evaluating every ticker in your
holdings + watchlist:

**Auto-curated watchlist**: alongside holdings/watchlist, the job also scans
a fixed pool of ~35 diverse, liquid TSX ETFs (`CANDIDATE_UNIVERSE` in
`scripts/run-signals.js`) spanning broad market, fixed income, sector,
dividend/factor, and preferred-share categories. One showing a fresh
golden-cross or dip signal is auto-added to `etf_watchlist`
(`source='AUTO'`, with the reason recorded) and tracked from then on — no
manual curation needed. The Watchlist tab marks these "auto-added" with the
reason on tap; remove one anytime the same way as a manual entry.

| Indicator | Rule | Alert |
|---|---|---|
| Trend | 50-day MA crosses **above** 200-day MA (golden cross) | BUY |
| Trend | 50-day MA crosses **below** 200-day MA (death cross) | SELL/TRIM |
| Stretch | Price drops to **10%+ below** its 200-day MA | BUY (dip) |
| Stretch | Price rises to **10%+ above** its 200-day MA | SELL/TRIM |

**BUY-only for anything you don't own**: a SELL/trim alert is meaningless for
a ticker that isn't held, so watchlist entries and auto-scanned candidates
only ever generate BUY alerts — a SELL/trim condition on one of those is
tracked silently (so the next real change is still caught) but never fires
or emails. Holdings get both directions, same as always.

**Market-regime layer**: every run also checks three free official macro
gauges — the Canadian 10y−2y yield curve (Bank of Canada Valet API), US
high-yield credit spreads and the Sahm recession indicator (FRED). Two or
more flashing = CAUTION, one = WATCH, none = NORMAL. The level is shown on
the dashboard, appended to every alert email (adjusting BUY/SELL conviction
wording), stored in `etf_market_regime`, and a **regime level change
triggers its own email**.

Alerts fire only on **state changes** — one email per new condition, never
repeats while the condition persists. The first-ever run only records a
baseline. BUY alerts include a hold-time estimate from that ETF's own
10-year drawdown-recovery history; SELL alerts include how long past
stretches took to revert to the 200-day average. All signals are also
logged to the app's **Signals** tab, email or not.

**Account-aware advice**: each holding is tagged TFSA, RRSP, or
non-registered. Advice assumes the **TFSA and RRSP are maxed out** (no new
contribution room), so every BUY alert reminds you a registered-account buy
requires selling an existing TFSA/RRSP holding first (tax-free swap) or
using the taxable non-registered account; SELL alerts spell out the tax
consequences per account (TFSA sales are tax-free dry powder, RRSP proceeds
should stay inside the account, non-registered sales can realize capital
gains). The advice is stored with each signal and shown in the Signals tab
and alert emails. Signals on a Manulife Wealth holding show a **✉ Draft
email to Brad** button in the Signals tab — it generates a copy-pasteable
subject/body summarizing the signal, the reasoning, and the account
advice, so you can forward it to your advisor and ask for their take
before acting. Add an optional **fund name** when adding/editing a
Manulife holding (their tickers are cryptic Morningstar/FundSERV codes) —
it's used in the email draft and shown in the holdings table instead of
the raw ticker.

**Every alert names the asset**: cryptic codes like `0P0000768R.TO` are
impossible to recognize in a notification, so alert emails, the Signals
tab, and the signal reasoning all lead with a readable name — the fund
name you set on the holding if there is one, otherwise the name Yahoo
reports for the security — with the symbol shown underneath. Single- and
two-signal emails also carry the name in the subject line so the alert is
identifiable from a phone's lock screen. The name is stored on each signal
(`etf_signals.asset_name`), so re-run `supabase/schema.sql` after
deploying this change.

**Holdings import**: the **Import** tab syncs your Manulife holdings from the
account site's export. On the site, open **Holdings** and press **Export**,
then paste it into the tab or attach the downloaded file. It carries the
ticker *and* the account for every position and is current rather than
month-end, so no ticker research is needed. It is read on the device —
nothing is uploaded — and nothing is written until the listed changes are
approved.

**Cost basis (ACB) and gain/loss**: each holding can carry a cost
(`book_cost` on `etf_holdings`, in the security's own currency), and the
Dashboard shows ACB and gain/loss per holding plus totals for non-registered
vs registered accounts. Where the cost comes from:

- **Wealthsimple**: the export's *Book Value (Market)* column, refreshed on
  every import (`cost_source = 'export'`).
- **Manulife**: its export has no cost, so a new asset is flagged *needs cost*
  and the Import tab asks you to attach a Manulife *Statement of Account* PDF.
  The Cost column ("book cost") is read on the device with pdf.js — nothing is
  uploaded — and matched by account and fund name (`'statement'`). Attaching a
  newer statement later trues everything up.
- **Between statements**: a sale trims the cost in proportion (average-cost
  method, exact). Units added since — reinvested distributions, purchases —
  are costed at the price on the import (`'estimated'`, shown as `~`), which a
  statement then corrects.

**Held since**: neither broker's export carries a purchase date, so tap *Edit*
on a holding and enter when you bought it (the average date, if you added to it
over time). With the cost that gives each holding an annualized rate of
return, (value ÷ cost)^(1 ÷ years) − 1, shown with the period it covers ("+6.8%/yr
over the last 3 yrs 2 mo"), and each account summary a cost-weighted average. It assumes one lump purchase on that date and
leaves out cash payouts you didn't reinvest, so read it as a guide.
This is optional — nothing in either export carries purchase dates, so it
only appears for holdings you choose to date; the gain/loss vs ACB is automatic
regardless. To avoid typing every date, a collapsed bulk box on the holdings
card ("Optional: add purchase dates…") works like this: pick the account
(or institution) buttons, choose one date, and it fills every holding there that
has no date yet — holdings that already have one are left alone.
Gains inside an RRSP/TFSA are performance only, not taxable. USD-priced
holdings are shown in USD on their own row and left out of the CAD totals.

**Retirement planner export**: the Dashboard's *Send to retirement planner*
card builds a JSON snapshot (`src/lib/plannerExport.js`) for the companion
retirement planner: today's market value for RRSP, TFSA, LIRA and
non-registered, plus the non-registered unrealized gain as a % of value,
(market value − ACB) / market value, which is what the planner turns back into
a cost base to tax withdrawals. Copy it (or download the .json) and paste it
into the planner's *Import my real portfolio* card. Notes: US-listed holdings
are converted at a USD→CAD rate you set on that card; a US holding's tax cost
is its CAD book value (`book_cost_cad`), not the USD one; cash, crypto, FTQ and
RESP/FHSA aren't tracked, so account totals can run a little under the real
ones; and a net loss exports as 0% gains because the planner has no field for
a loss. "Locked-in RRSP" accounts are LIRA, not RRSP.

Two more figures ride along. **Taxable income**: attaching a Manulife statement
on the Import tab also reads its *Income Summary* (dividends and interest year
to date) for the non-registered account and saves it (`etf_income_snapshots`);
the export scales it to a full year and divides by the account's value for the
planner's "taxable income each year" %. A December statement gives the exact
year; earlier ones are scaled and flagged. **Monte Carlo volatility**: the
nightly signal job already downloads each holding's price history, and now also
measures how much the whole portfolio swings (`src/lib/portfolioVol.js`: monthly
total returns blended with today's value weights, annualized, latest 60 months)
into `etf_portfolio_stats`. That replaces the planner's generic 10% with one
measured from what you actually hold — actively managed funds included, since
their own history already reflects their manager's choices. Funds with no
Yahoo history can't be measured, so the export reports how much of the
portfolio's value was. The first figure appears after the next run of the **Daily ETF signals** workflow
(it runs hourly on weekdays; or use *Run workflow* on it in the Actions tab). Its
log has a `Portfolio volatility:` line saying what was measured, how much of the
portfolio's value had history, and which holdings had none — or why it could not
be measured. `node scripts/test-job.mjs` runs the real job against a simulated
database and Yahoo and checks that row is written (it also proves the test would
catch the job forgetting to select the units it weights holdings by).

**Funds with no price history.** Most mutual funds (Fidelity, CI, Dynamic, RBC, TD…)
have no free daily history, so a fund with none of its own is measured through an
index ETF with the same mandate — global shares → XEQT, balanced/income → XBAL,
Canadian dividend → XDV, US shares → XUU, gold → XGD, and so on
(`src/lib/fundProxies.js`, matched on the fund's name). That captures asset-class
swings and how the fund moves with the rest of your portfolio, but **not the
manager's own record**, so the export reports how much of the portfolio is its own
history versus stand-ins, lists each fund with what stood in for it, and lists
funds it could not measure (a market-neutral fund deliberately gets no stand-in:
an equity ETF would be wrong for it). To change one, edit `PROXY_OVERRIDES` in
that file: a fund's code or name → an ETF ticker, or `null` for "don't proxy this".
The same measurement also records a year-by-year second opinion (the portfolio's
actual calendar-year returns, a rolling 12-month spread, and a longer look-back
of up to ten years), because scaling monthly swings up can understate how far a
trending market moves in a year. The planner export carries it as `portfolioStats`
so the planner can lock its Monte Carlo volatility to it (*My portfolio's own
history*), show the yearly returns behind the number, and offer *Repeatable
results* (a fixed random stream, so the same inputs always give the same result).

**Bell DC pension (Pension tab)**: a workplace pension has no ticker, so it is
read from your Bell Benefits page instead. Choose a screenshot of the fund and
contribution-type breakdown (or paste the page's text, or type the figures)
and the Pension tab reads it on the device with OCR (`src/lib/ocr.js`,
tesseract.js; the engine downloads once from a CDN, the image never leaves the
phone), then `src/lib/bellPension.js` turns it into: the fund, units and
market value per contribution type (employee / Bell), and each type's
opening + contributions + earnings = market value. A type cropped out of the
screenshot is worked out as the total minus the others. You confirm the
figures and the period the contributions column covers (it isn't in the
screenshot), and the snapshot is saved in `etf_pension_snapshots`. The planner
export then carries it as the separate Bell DC pension balance and a yearly
contribution (contributions ÷ the years in that period). The value is as of the
snapshot, so add a new one about once a year; the export warns when it is old.

The review shows a per-fund diff: **add** for funds that appeared, **adjust**
where the unit count moved, **remove** for funds on file but absent from the
export, and unchanged funds for completeness. Each row has a checkbox, so a
partial import is fine. Units are *set* to the export's values rather than
added, so importing twice can't double-count. Applied imports are logged to
`etf_statement_imports`, which is what fills the **Last holdings** and **Last
import** dates.

Broker symbols aren't Yahoo symbols, so they are translated by the export's
Market column: TSX gets `.TO`, TSX Venture `.V`, Cboe Canada `.NE`, and a
class share printed `DGR.B` becomes `DGR-B.TO`. FundSERV codes for the OTC
funds are left exactly as they are — they aren't Yahoo symbols at all, and
the Globe and Mail fallback expects the bare code, which means those funds
get a price but no signals. Cash rows and RESP accounts are skipped, and both
skips are reported rather than silent. A row whose columns don't line up with
the header is skipped *loudly*: reading it could import a wrong unit count,
and dropping it quietly would make the fund look sold and offer it for
removal.

Fund names arrive abbreviated, so they are expanded for the pre-filled
**nickname** — "FDLTY INSIG CL SR F -NL" becomes "Fidelity Insights Class
Series F" — editable before saving. A position the export gives no symbol for
still imports and asks; a **Find ticker** button searches Yahoo by name,
proxied through the `refresh-prices` edge function since Yahoo's search sends
no CORS headers. Tickers are remembered in `etf_fund_map`, seeded from
`docs/manulife-fund-codes.md`.

`npm test` covers the export reader, symbol translation, account mapping, the
skips, name expansion and the diff.

A **↻ Refresh** button in the header fetches live prices
on demand via the `refresh-prices` Supabase Edge Function
(`supabase/functions/refresh-prices/index.ts` — deploy it once in the
Supabase dashboard under Edge Functions, named exactly `refresh-prices`,
with Verify JWT on). If the function isn't deployed, Refresh falls back to
reloading the last stored data and says so.

## Repo structure

```
├── index.html                       # Vite entry (imetrobert-branded, no external fonts)
├── vite.config.js                   # base path for GitHub Pages
├── package.json                     # React 18 + Vite + supabase-js
├── supabase/schema.sql              # etf_* tables — paste into Supabase SQL editor (idempotent)
├── scripts/
│   ├── run-signals.js               # the daily signal engine (Node, run by Actions)
│   └── test-holdings-import.mjs     # import tests (npm test)
├── .github/workflows/
│   ├── deploy.yml                   # build + deploy to GitHub Pages on push to main
│   └── daily-signals.yml            # weekday cron + manual run (test_email option)
└── src/
    ├── main.jsx / App.jsx           # HashRouter shell + Supabase auth gate
    ├── index.css                    # "ledger" theme matching tax.imetrobert.com
    ├── lib/
    │   ├── supabase.js              # client (graceful when secrets missing)
    │   ├── tickers.js               # XEQT → XEQT.TO normalization, CAD formatting
    │   ├── funds.js                 # fund-name expansion + the holdings diff
    │   └── holdingsExport.js        # account-site export (TSV/CSV) → positions
    └── components/
        ├── Login.jsx                # shared-credential sign-in
        ├── Navbar.jsx               # header + Holdings/Watchlist/Signals/Import tabs
        ├── Dashboard.jsx            # holdings CRUD + values + portfolio total
        ├── Watchlist.jsx            # watchlist CRUD + price / vs-200-day
        ├── SignalHistory.jsx        # every fired signal
        └── ImportHoldings.jsx       # account export → approve → sync holdings
```

## Supabase tables (shared project, `etf_` prefix)

| Table | Purpose |
|---|---|
| `etf_holdings` | ticker + shares you own, per account (TFSA / RRSP / non-registered) |
| `etf_watchlist` | extra tickers to monitor |
| `etf_prices` | latest snapshot per ticker (price, MA50, MA200, % vs MA200) |
| `etf_signals` | every fired alert (what the emails contain) |
| `etf_signal_state` | last known state per ticker (dedupes alerts) |

RLS: app users (authenticated) read/write holdings & watchlist, read the
rest; the daily job writes via the service-role key.

## GitHub Actions secrets

| Secret | Used by | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | deploy | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | deploy | anon/publishable key |
| `SUPABASE_URL` | signals | same project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | signals | service-role / secret key |
| `EMAILJS_SERVICE_ID` | signals | EmailJS SMTP service (Brevo) |
| `EMAILJS_TEMPLATE_ID` | signals | template: subject={{subject}}, body={{{content}}}, to={{to_email}}, from=invoices@aiwithrobert.com |
| `EMAILJS_PUBLIC_KEY` / `EMAILJS_PRIVATE_KEY` | signals | EmailJS account API keys |
| `NOTIFY_EMAIL` | signals | where alerts are sent |
| `SUPABASE_DB_URL` | apply-schema | Postgres connection string — Supabase dashboard → Project Settings → Database → Connection string → **Session pooler** (not "Direct connection", which needs the IPv4 add-on on GitHub's runners); paste the URI with the real password substituted in |

## Phone-only maintenance

- **Edit holdings/watchlist**: in the app itself — no code changes ever needed.
- **Schema changes apply themselves**: any push to main that touches
  `supabase/schema.sql` runs it against the database automatically (the
  "Apply Supabase schema" workflow) — no more copy-pasting into the SQL
  editor. It's safe to re-run (idempotent), and can also be triggered
  manually: Actions → "Apply Supabase schema" → Run workflow.
- **Run signals now**: repo → Actions → "Daily ETF signals" → Run workflow
  (check "Send a test email" to verify delivery).
- **Change alert sensitivity**: edit `STRETCH_PCT` at the top of
  `scripts/run-signals.js` in the GitHub web editor; committing to main is all
  it takes (the job reads the file fresh each run).
- **Change schedule**: edit the `cron:` line in
  `.github/workflows/daily-signals.yml` (UTC time).
- **Redeploy the site**: happens automatically on any push to main; manual:
  Actions → "Deploy to GitHub Pages" → Run workflow.
- **Pages must stay on** Settings → Pages → Source: **GitHub Actions**
  (switching to "Deploy from a branch" serves raw source = blank page).

## Custom domain (invest.imetrobert.com)

1. DNS: `invest` CNAME → `imetrobert.github.io.` at the domain provider
2. Repo Settings → Pages → Custom domain: `invest.imetrobert.com`, then
   Enforce HTTPS once the certificate is issued
3. `vite.config.js` base must be `'/'` for the custom domain (done). If the
   custom domain is ever removed, set it back to `'/tsx-etf-signal-notifier/'`.
