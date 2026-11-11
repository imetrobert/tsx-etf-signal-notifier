# tsx-etf-signal-notifier (ETF Tracker) — read this first, it is the map

TSX ETF tracker at invest.imetrobert.com / etf.imetrobert.com. React + Vite on GitHub
Pages; Supabase shared project (`etf_*` tables); a weekday GitHub Actions job computes
buy/sell signals and emails them via EmailJS (Brevo). Maintenance steps: `RUNBOOK.md`.
Full detail: `README.md` (sections: How signals work, Repo structure, Supabase tables,
Actions secrets, Phone-only maintenance, Custom domain) — read only the section needed.

## Rules (non-negotiable)
- Free tier only; no paid services. Never commit secrets (service-role key and EmailJS
  keys live only in GitHub Actions secrets).
- New Supabase tables: `etf_` prefix, explicit Data API grants in the same migration,
  RLS gated by `has_app_access('etf')`. `supabase/schema.sql` must stay idempotent
  (it auto-applies on push to main via apply-schema.yml).
- Pages source must stay "GitHub Actions" (Settings → Pages).
- Alerts dedupe through `etf_signal_state`; do not remove that when editing the engine.

## Where things are
- Signal engine: `scripts/run-signals.js` (tunables such as `STRETCH_PCT` at the top)
- UI: `src/components/*` (Dashboard, Watchlist, SignalHistory, ImportHoldings, Pension, Settings)
- Helpers: `src/lib/*` (funds, tickers, holdingsExport, returns, portfolioVol, bellPension)
- DB: `supabase/schema.sql`; price refresh function `supabase/functions/refresh-prices/`
- Workflows: `daily-signals.yml` (weekdays, hourly 13–21 UTC + 21:30), `deploy.yml`,
  `apply-schema.yml` (when schema.sql changes)
- Tests: `npm test` (holdings import)

## Cheap-change guide
- Holdings/watchlist changes: in the app, never in code.
- Alert sensitivity: edit one constant in `scripts/run-signals.js`, commit to main.
- Schedule: edit the `cron:` lines in `daily-signals.yml` (UTC).
- Copy/text: edit the one component; Pages redeploys on push.
