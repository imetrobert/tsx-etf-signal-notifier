// Supabase Edge Function: refresh-prices
// Fetches current prices from Yahoo Finance for every ticker in
// etf_holdings + etf_watchlist and updates the etf_prices snapshot,
// so the app's Refresh button shows live values between signal-job runs.
// Snapshot-only: never touches signal state, history, or emails.
//
// Falls back to The Globe and Mail's fund quote page (by FundSERV code)
// for Canadian mutual funds Yahoo doesn't carry. That fallback is
// current-price-only — no historical NAV, so those tickers won't get
// ma50/ma200/pct_vs_ma200 or generate BUY/SELL trend signals, just a
// live portfolio value.
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

// Fallback for Canadian mutual funds Yahoo doesn't carry: The Globe and
// Mail indexes funds directly by their FundSERV code (e.g. RBF941.CF).
// Current price only — no history, so ma50/ma200/pct_vs_ma200 stay null
// for these (no trend signal without ~200 days of NAV, just a live value).
async function fetchGlobeAndMailPrice(ticker: string): Promise<number | null> {
  const code = ticker.replace(/\.(TO|NE)$/i, '')
  const url = `https://www.theglobeandmail.com/investing/markets/funds/${encodeURIComponent(code)}.CF/`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
  })
  if (!res.ok) return null
  const html = await res.text()
  const patterns = [
    /"navps"\s*:\s*"?([\d.]+)"?/i,
    /NAVPS[^0-9$]{0,20}\$?\s*([\d.]+)/i,
    /"lastPrice"\s*:\s*"?([\d.]+)"?/i,
    /"regularMarketPrice"\s*:\s*"?([\d.]+)"?/i,
    /class="[^"]*(?:barchart|quote|price)[^"]*"[^>]*>\s*\$?\s*([\d.]+)/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m) {
      const price = parseFloat(m[1])
      if (!isNaN(price) && price > 0) return price
    }
  }
  return null
}

// Resolves an API key across all three env shapes Supabase uses:
// legacy singular strings (SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY),
// new-model singular strings (SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY,
// used by local dev), and new-model plural JSON objects keyed by key name
// (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS, e.g.
// {"default":"sb_secret_..."}).
function resolveKey(singulars: string[], plural: string): string | undefined {
  for (const n of singulars) {
    const v = Deno.env.get(n)
    if (v) return v
  }
  const raw = Deno.env.get(plural)
  if (!raw) return undefined
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (typeof obj.default === 'string') return obj.default
      const first = Object.values(obj).find(v => typeof v === 'string')
      if (typeof first === 'string') return first
    }
  } catch {
    return raw // not JSON — treat the value as the key itself
  }
  return undefined
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = resolveKey(['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'], 'SUPABASE_PUBLISHABLE_KEYS')
  const secretKey = resolveKey(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'], 'SUPABASE_SECRET_KEYS')
  if (!anonKey || !secretKey) {
    return json({ error: 'Missing key env vars — expected SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY (legacy) or SUPABASE_PUBLISHABLE_KEY(S) + SUPABASE_SECRET_KEY(S) (new key model).' }, 500)
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
    } catch (yahooErr) {
      try {
        const price = await fetchGlobeAndMailPrice(ticker)
        if (price == null) throw new Error('no price found on Globe and Mail page')
        const { error } = await db.from('etf_prices').upsert({
          ticker,
          price,
          currency: 'CAD',
          price_date: new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        if (error) throw new Error(error.message)
        updated++
      } catch (gmErr) {
        failed.push(`${ticker}: Yahoo ${(yahooErr as Error).message}; Globe and Mail ${(gmErr as Error).message}`)
      }
    }
  }

  return json({ updated, failed })
})
