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

| Indicator | Rule | Alert |
|---|---|---|
| Trend | 50-day MA crosses **above** 200-day MA (golden cross) | BUY |
| Trend | 50-day MA crosses **below** 200-day MA (death cross) | SELL/TRIM |
| Stretch | Price drops to **10%+ below** its 200-day MA | BUY (dip) |
| Stretch | Price rises to **10%+ above** its 200-day MA | SELL/TRIM |

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
├── scripts/run-signals.js           # the daily signal engine (Node, run by Actions)
├── .github/workflows/
│   ├── deploy.yml                   # build + deploy to GitHub Pages on push to main
│   └── daily-signals.yml            # weekday cron + manual run (test_email option)
└── src/
    ├── main.jsx / App.jsx           # HashRouter shell + Supabase auth gate
    ├── index.css                    # "ledger" theme matching tax.imetrobert.com
    ├── lib/
    │   ├── supabase.js              # client (graceful when secrets missing)
    │   └── tickers.js               # XEQT → XEQT.TO normalization, CAD formatting
    └── components/
        ├── Login.jsx                # shared-credential sign-in
        ├── Navbar.jsx               # header + Holdings/Watchlist/Signals tabs
        ├── Dashboard.jsx            # holdings CRUD + values + portfolio total
        ├── Watchlist.jsx            # watchlist CRUD + price / vs-200-day
        └── SignalHistory.jsx        # every fired signal
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

## Phone-only maintenance

- **Edit holdings/watchlist**: in the app itself — no code changes ever needed.
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
