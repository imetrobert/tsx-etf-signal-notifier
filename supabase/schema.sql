-- TSX ETF Signal Notifier — schema
-- Paste this whole file into the Supabase SQL editor of the shared project
-- (same project as the invoicing app). Safe to re-run: everything is
-- IF NOT EXISTS / ON CONFLICT DO NOTHING. Table names are prefixed etf_
-- so they can't collide with the invoicing tables.

create table if not exists etf_holdings (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  shares numeric not null check (shares > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists etf_watchlist (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  created_at timestamptz not null default now()
);

-- Latest market snapshot per ticker, refreshed by the daily signal job.
create table if not exists etf_prices (
  ticker text primary key,
  price numeric,
  currency text default 'CAD',
  price_date date,
  ma50 numeric,
  ma200 numeric,
  pct_vs_ma200 numeric,
  updated_at timestamptz not null default now()
);

-- Every alert that fired (what the notification emails contain).
create table if not exists etf_signals (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  signal text not null check (signal in ('BUY','SELL')),
  reasons text not null,
  est_recovery_text text,
  price numeric,
  created_at timestamptz not null default now()
);

-- Per-ticker signal state so the same condition never emails twice in a row.
create table if not exists etf_signal_state (
  ticker text primary key,
  last_state text not null,
  updated_at timestamptz not null default now()
);

-- Row level security: the logged-in user (any authenticated user of this
-- project) gets full access from the app; the daily job uses the service
-- role key, which bypasses RLS.
alter table etf_holdings enable row level security;
alter table etf_watchlist enable row level security;
alter table etf_prices enable row level security;
alter table etf_signals enable row level security;
alter table etf_signal_state enable row level security;

drop policy if exists "etf_holdings_auth" on etf_holdings;
create policy "etf_holdings_auth" on etf_holdings
  for all to authenticated using (true) with check (true);

drop policy if exists "etf_watchlist_auth" on etf_watchlist;
create policy "etf_watchlist_auth" on etf_watchlist
  for all to authenticated using (true) with check (true);

drop policy if exists "etf_prices_read" on etf_prices;
create policy "etf_prices_read" on etf_prices
  for select to authenticated using (true);

drop policy if exists "etf_signals_read" on etf_signals;
create policy "etf_signals_read" on etf_signals
  for select to authenticated using (true);

drop policy if exists "etf_signal_state_read" on etf_signal_state;
create policy "etf_signal_state_read" on etf_signal_state
  for select to authenticated using (true);

-- Starter watchlist of popular TSX ETFs (editable in the app).
insert into etf_watchlist (ticker) values
  ('XEQT.TO'), ('VEQT.TO'), ('XIC.TO'), ('VFV.TO'),
  ('ZSP.TO'), ('XIU.TO'), ('ZAG.TO'), ('VGRO.TO')
on conflict (ticker) do nothing;
