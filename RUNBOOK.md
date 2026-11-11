# Runbook — ETF Tracker (phone-friendly)

## No alert emails / signals look stale
1. Actions → **Daily ETF signals** → latest run. Green but no email is normal when no
   signal fired. Red: read the first failing step.
2. Verify delivery: Run workflow with "Send a test email" ticked.
3. Email fails: EmailJS quota/keys (secrets below) or `NOTIFY_EMAIL` wrong.
4. No runs for weeks: GitHub pauses schedules after 60 days without repo activity.
   Actions → Daily ETF signals → **Enable workflow**, then Run workflow.

## Site blank or not updating
Settings → Pages → Source must be **GitHub Actions**. Then Actions → Deploy to GitHub
Pages → Re-run.

## Schema change
Edit `supabase/schema.sql` (idempotent), commit to main. "Apply Supabase schema" runs it.
Needs secret `SUPABASE_DB_URL` (Session pooler connection string).

## Secrets (Settings → Secrets and variables → Actions)
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY`,
`NOTIFY_EMAIL`, `SUPABASE_DB_URL`. Rotate by replacing the secret, then run Daily ETF
signals with the test email.

## Quarterly check (5 minutes)
- Recent Daily ETF signals runs are green.
- Test email arrives.
- Repo has had a commit or a manual run within 60 days (keeps schedules enabled).

## Retiring this app
Drop `etf_*` tables, delete `app_access` rows where app='etf', remove DNS records for
invest/etf.imetrobert.com, disable workflows, archive the repo. Follow the pattern in
Supabase-platform-'s `migration/decommission_cartmatch.sql`.
