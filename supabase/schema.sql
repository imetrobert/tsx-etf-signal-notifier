-- TSX ETF Signal Notifier — schema
-- Paste this whole file into the Supabase SQL editor of the shared project
-- (same project as the invoicing app). Safe to re-run: everything is
-- IF NOT EXISTS / ON CONFLICT DO NOTHING. Table names are prefixed etf_
-- so they can't collide with the invoicing tables.

create table if not exists etf_holdings (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  shares numeric not null check (shares > 0),
  account text not null default 'NON_REG'
    constraint etf_holdings_account_chk check (account in ('RRSP','TFSA','NON_REG')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint etf_holdings_ticker_account_key unique (ticker, account)
);

-- Migration for installs created before per-account holdings existed:
-- add the account column, relax the ticker-only uniqueness to
-- (ticker, account), and add the signal advice column.
alter table etf_holdings add column if not exists account text not null default 'NON_REG';
do $$ begin
  alter table etf_holdings add constraint etf_holdings_account_chk
    check (account in ('RRSP','TFSA','NON_REG'));
exception when duplicate_object then null; end $$;
alter table etf_holdings drop constraint if exists etf_holdings_ticker_key;
create unique index if not exists etf_holdings_ticker_account_key
  on etf_holdings (ticker, account);

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
  account_advice text,
  price numeric,
  created_at timestamptz not null default now()
);
alter table etf_signals add column if not exists account_advice text;

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

-- Macro market-regime snapshot (yield curve, credit spreads, Sahm rule),
-- refreshed by the signal job. Single row.
create table if not exists etf_market_regime (
  id int primary key default 1 check (id = 1),
  level text not null,
  gauges jsonb,
  updated_at timestamptz not null default now()
);
alter table etf_market_regime enable row level security;
drop policy if exists "etf_regime_read" on etf_market_regime;
create policy "etf_regime_read" on etf_market_regime
  for select to authenticated using (true);

-- Starter watchlist of popular TSX ETFs (editable in the app).
insert into etf_watchlist (ticker) values
  ('XEQT.TO'), ('VEQT.TO'), ('XIC.TO'), ('VFV.TO'),
  ('ZSP.TO'), ('XIU.TO'), ('ZAG.TO'), ('VGRO.TO')
on conflict (ticker) do nothing;
