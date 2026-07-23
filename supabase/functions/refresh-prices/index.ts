// Supabase Edge Function: refresh-prices
// Fetches current prices from Yahoo Finance for every ticker in
// etf_holdings + etf_watchlist and updates the etf_prices snapshot,
// so the app's Refresh button shows live values between signal-job runs.
// Snapshot-only: never touches signal state, history, or emails.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function →
// name it exactly "refresh-prices", paste this file, deploy (keep
// "Verify JWT" on). Or via CLI: supabase functions deploy refresh-prices

import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null
  let s = 0
  for (let i = values.length - n; i < values.length; i++) s += values[i]
  return s / n
}

// Supports both the legacy key model (SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY) and the newer publishable/secret key model.
function envAny(...names: string[]): string | undefined {
  for (const n of names) {
    const v = Deno.env.get(n)
    if (v) return v
  }
  return undefined
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = envAny('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY')
  const secretKey = envAny('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY')
  if (!anonKey || !secretKey) {
    return json({ error: 'Missing key env vars — add a function secret named SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) and SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY).' }, 500)
  }

  // Only a signed-in app user may trigger a refresh (the platform JWT check
  // also passes for the bare anon key, so verify a real session here).
  const authClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return json({ error: 'Not signed in' }, 401)

  const db = createClient(url, secretKey)
  const [h, w] = await Promise.all([
    db.from('etf_holdings').select('ticker'),
    db.from('etf_watchlist').select('ticker'),
  ])
  if (h.error || w.error) return json({ error: (h.error || w.error)!.message }, 500)

  const tickers = [...new Set([...(h.data ?? []), ...(w.data ?? [])].map(r => r.ticker))]
  let updated = 0
  const failed: string[] = []

  for (const ticker of tickers) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (etf-signal-notifier)' } },
      )
      if (!res.ok) throw new Error(`Yahoo ${res.status}`)
      const body = await res.json()
      const result = body?.chart?.result?.[0]
      if (!result) throw new Error('no chart data')
      const ts: number[] = result.timestamp ?? []
      const raw: (number | null)[] = result.indicators?.quote?.[0]?.close ?? []
      const closes: number[] = []
      let lastTs = 0
      for (let i = 0; i < ts.length; i++) {
        if (raw[i] != null) { closes.push(raw[i]!); lastTs = ts[i] }
      }
      if (!closes.length) throw new Error('no prices')
      const price = closes[closes.length - 1]
      const ma200 = sma(closes, 200)
      const { error } = await db.from('etf_prices').upsert({
        ticker,
        price,
        currency: result.meta?.currency ?? 'CAD',
        price_date: new Date(lastTs * 1000).toISOString().slice(0, 10),
        ma50: sma(closes, 50),
        ma200,
        pct_vs_ma200: ma200 ? (price / ma200 - 1) * 100 : null,
        updated_at: new Date().toISOString(),
      })
      if (error) throw new Error(error.message)
      updated++
      await new Promise(r => setTimeout(r, 200)) // be polite to Yahoo
    } catch (e) {
      failed.push(`${ticker}: ${(e as Error).message}`)
    }
  }

  return json({ updated, failed })
})
