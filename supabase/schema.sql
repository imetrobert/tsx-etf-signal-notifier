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
    constraint etf_holdings_account_chk check (account in ('RRSP','TFSA','NON_REG','LIRA')),
  institution text not null default 'WEALTHSIMPLE'
    constraint etf_holdings_institution_chk check (institution in ('WEALTHSIMPLE','MANULIFE')),
  fund_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint etf_holdings_ticker_acct_inst_key unique (ticker, account, institution)
);
alter table etf_holdings add column if not exists fund_name text;

-- Migration for installs created before per-account / per-institution
-- holdings existed: add the columns, move uniqueness to
-- (ticker, account, institution), and add the signal advice column.
alter table etf_holdings add column if not exists account text not null default 'NON_REG';
alter table etf_holdings drop constraint if exists etf_holdings_account_chk;
alter table etf_holdings add constraint etf_holdings_account_chk
  check (account in ('RRSP','TFSA','NON_REG','LIRA'));
alter table etf_holdings add column if not exists institution text not null default 'WEALTHSIMPLE';
do $$ begin
  alter table etf_holdings add constraint etf_holdings_institution_chk
    check (institution in ('WEALTHSIMPLE','MANULIFE'));
exception when duplicate_object then null; end $$;
alter table etf_holdings drop constraint if exists etf_holdings_ticker_key;
alter table etf_holdings drop constraint if exists etf_holdings_ticker_account_key;
drop index if exists etf_holdings_ticker_account_key;
create unique index if not exists etf_holdings_ticker_acct_inst_key
  on etf_holdings (ticker, account, institution);

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
  asset_name text,
  signal text not null check (signal in ('BUY','SELL')),
  reasons text not null,
  est_recovery_text text,
  account_advice text,
  price numeric,
  created_at timestamptz not null default now()
);
alter table etf_signals add column if not exists account_advice text;
-- Human-readable name captured when the signal fired: the holding's nickname
-- (etf_holdings.fund_name) if set, else the fund name Yahoo reports.
alter table etf_signals add column if not exists asset_name text;

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

-- Maps a fund name as printed on a Manulife statement to the ticker this app
-- tracks it under, so importing next month's statement recognizes it without
-- asking again. norm_name is the name uppercased with punctuation stripped.
create table if not exists etf_fund_map (
  norm_name text primary key,
  statement_name text not null,
  ticker text not null,
  fund_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table etf_fund_map enable row level security;
drop policy if exists "etf_fund_map_auth" on etf_fund_map;
create policy "etf_fund_map_auth" on etf_fund_map
  for all to authenticated using (true) with check (true);

-- Fund codes already identified for the Manulife Wealth statement, so the
-- import recognizes them without asking. Statements print no tickers, and a
-- FundSERV code prices through the Globe and Mail fallback (current price
-- only); an exchange ticker or Yahoo 0P id also carries history, so it
-- generates signals. See docs/manulife-fund-codes.md for how each was
-- identified. Funds whose series or variant is ambiguous are deliberately
-- absent — better to be asked than to silently track the wrong one.
insert into etf_fund_map (norm_name, statement_name, ticker, fund_name) values
  ('CIG GLB EQ CC CL F NL', 'CIG GLB EQ CC CL F -NL', 'CIG4323', 'CI Global Equity Corporate Class F'),
  ('FDLTY GLB INC CL PORT SR F NL', 'FDLTY GLB INC CL PORT SR F -NL', 'FID2682', 'Fidelity Global Income Class Portfolio Series F'),
  ('GOC AA PRT CLS SR F NL', 'GOC AA PRT CLS SR F -NL', 'GOC303', 'Canoe Asset Allocation Portfolio Class Series F'),
  ('FIDELITY ALL IN ONE BAL ETF', 'FIDELITY ALL IN ONE BAL ETF', 'FBAL.NE', 'Fidelity All-in-One Balanced ETF'),
  ('VANGUARD GLOBAL VALUE ETF UN', 'VANGUARD GLOBAL VALUE ETF UN', 'VVL.TO', 'Vanguard Global Value Factor ETF'),
  ('BMO TACT GLB EQ ETF NL', 'BMO TACT GLB EQ ETF -NL', 'BMO68217', 'BMO Tactical Global Equity ETF Fund Series F'),
  ('CI PREC MTL FD CL F NL', 'CI PREC MTL FD CL F -NL', 'CIG54203', 'CI Precious Metals Fund Series F'),
  ('DYNAMIC PREM BAL PP CL F NL', 'DYNAMIC PREM BAL PP CL F -NL', 'DYN3915', 'Dynamic Premium Balanced Private Pool Class F'),
  ('FDLTY GLOBAL EQUITY SR F NL', 'FDLTY GLOBAL EQUITY+ SR F -NL', 'FID7648', 'Fidelity Global Equity+ Fund Series F'),
  ('FDLTY INSIG CL SR F NL', 'FDLTY INSIG CL SR F -NL', 'FID5494', 'Fidelity Insights Class Series F'),
  ('TDB US DISP E ALPHA SR F NL', 'TDB US DISP E ALPHA SR F -NL', 'TDB3173', 'TD U.S. Disciplined Equity Alpha Fund Series F')
on conflict (norm_name) do nothing;

-- Audit trail of applied statement imports, so a statement that has already
-- been applied can be flagged instead of silently double-counted.
create table if not exists etf_statement_imports (
  id uuid primary key default gen_random_uuid(),
  statement_date date,
  account_number text,
  account_type text,
  institution text not null default 'MANULIFE',
  file_name text,
  summary jsonb,
  created_at timestamptz not null default now()
);
alter table etf_statement_imports enable row level security;
drop policy if exists "etf_statement_imports_auth" on etf_statement_imports;
create policy "etf_statement_imports_auth" on etf_statement_imports
  for all to authenticated using (true) with check (true);

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
