# Common edits — recipes (ETF Tracker, invest.imetrobert.com)

Edit the one file named and commit to main. The site deploys on push (Actions → Deploy to GitHub Pages). Never
commit a secret (service-role key and EmailJS keys live in Actions secrets). Free tier only.
`supabase/schema.sql` auto-applies on push to main (apply-schema.yml) so it must stay idempotent.

## 1. Add or remove holdings or watchlist tickers
No code. In the app: Import tab (Manulife or Wealthsimple export) or Watchlist tab.

## 2. Make alerts more or less sensitive
`scripts/run-signals.js`: `STRETCH_PCT` at the top (alert when price is this % above or below its
200-day average; default 10). Smaller = more alerts. Dedupe goes through `etf_signal_state`; do not
remove that.

## 3. Add or remove ETFs the daily job scans for new ideas
`scripts/run-signals.js`: the `CANDIDATE_UNIVERSE` array (Yahoo symbols like `XIC.TO`). A candidate
with a fresh signal is added to the watchlist automatically.

## 4. Change when the job runs
`.github/workflows/daily-signals.yml`: the two `cron:` lines (UTC; weekdays 13:00-21:00 hourly and
21:30). GitHub pauses schedules after 60 days of no repo activity: Actions → Daily ETF signals →
Enable workflow.

## 5. Turn email alerts on or off
No code. App → Settings tab toggle (stored in `etf_settings`). Prices still update when off.

## 6. Alert emails stopped
RUNBOOK.md section "No alert emails". Secrets: `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`,
`EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY`, `NOTIFY_EMAIL`. Rotate by replacing the secret then run
Daily ETF signals manually.

## 7. A new fund shows the wrong name or ticker after import
`src/lib/funds.js` (name cleanup and matching) and `src/lib/fundProxies.js` (stand-in tickers for
funds with no price feed). Keep `scripts/test-holdings-import.mjs` passing (`npm test`).

## 8. Support a new account export or statement format
`src/lib/holdingsExport.js` (detects the institution from the header row and parses the file),
`src/lib/statementCost.js` (Manulife PDF statement cost parser), tested by
`scripts/test-holdings-import.mjs`. Add a sample row to that test for the new format.

## 9. Change what a page shows
`src/components/`: Dashboard, Watchlist, SignalHistory, ImportHoldings, Pension, Settings, Navbar.
Routes are in `src/App.jsx` (`HashRouter`). A new page = new component + a `<Route>` + a link in
`Navbar.jsx`.

## 10. Add a database table or column
Add it to `supabase/schema.sql` (idempotent: `create table if not exists`, `add column if not
exists`). Table names start `etf_`. In the same block: `enable row level security`, a policy using
`has_app_access('etf')`, and explicit grants to `authenticated`. Pushing to main applies it
(apply-schema.yml, needs secret `SUPABASE_DB_URL`). Check the run is green.

## 11. Planner export (feeds the retirement planner)
`src/lib/plannerExport.js` builds the JSON from holdings, `portfolioVol.js` measures volatility.
Field names must stay equal to what the retirement planner import expects.

## 12. Check it works after any change
Actions: Deploy and Daily ETF signals are green; invest.imetrobert.com loads, Dashboard shows today's
prices; `npm test` passes if a terminal is available.
