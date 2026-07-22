// Daily TSX ETF signal engine.
// Fetches price history from Yahoo Finance, computes trend (50/200-day MA)
// and valuation-stretch indicators, writes a price snapshot and any fired
// signals to Supabase, and (when EmailJS is configured) emails alerts.
//
// Notification-only: this never places trades.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
//      EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY,
//      EMAILJS_PRIVATE_KEY, NOTIFY_EMAIL (optional — email is skipped if absent)

import { createClient } from '@supabase/supabase-js'

const STRETCH_PCT = 10 // alert when price is this % above/below its 200-day MA

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ---------- data fetch ----------

async function fetchHistory(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=10y&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (etf-signal-notifier)' } })
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${ticker}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`No chart data for ${ticker}`)
  const ts = result.timestamp || []
  const closes = result.indicators?.quote?.[0]?.close || []
  const series = []
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) series.push({ date: new Date(ts[i] * 1000), close: closes[i] })
  }
  if (series.length < 210) throw new Error(`Insufficient history for ${ticker} (${series.length} days)`)
  return { series, currency: result.meta?.currency || 'CAD' }
}

// ---------- indicators ----------

function sma(values, n, endIdx) {
  if (endIdx + 1 < n) return null
  let s = 0
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += values[i]
  return s / n
}

function computeIndicators(series) {
  const closes = series.map(d => d.close)
  const last = closes.length - 1
  const price = closes[last]
  const ma50 = sma(closes, 50, last)
  const ma200 = sma(closes, 200, last)
  const pctVsMa200 = (price / ma200 - 1) * 100
  const trend = ma50 >= ma200 ? 'GOLDEN' : 'DEATH'
  const stretch = pctVsMa200 <= -STRETCH_PCT ? 'LOW' : pctVsMa200 >= STRETCH_PCT ? 'HIGH' : 'NONE'
  return { price, ma50, ma200, pctVsMa200, trend, stretch, priceDate: series[last].date }
}

// ---------- hold-time estimates ----------

// For dip buys: how long similar drawdowns from a running high took to fully
// recover, historically. Returns text or null when there aren't enough episodes.
function recoveryEstimate(series) {
  const closes = series.map(d => d.close)
  let runMax = closes[0]
  const dd = closes.map(c => { runMax = Math.max(runMax, c); return c / runMax - 1 })
  const currentDD = Math.abs(dd[dd.length - 1]) * 100
  const threshold = Math.max(5, Math.floor(currentDD / 5) * 5) / 100

  const durations = []
  let inEpisode = false, startIdx = 0
  for (let i = 0; i < dd.length; i++) {
    if (!inEpisode && dd[i] <= -threshold) { inEpisode = true; startIdx = i }
    else if (inEpisode && dd[i] >= 0) { durations.push(i - startIdx); inEpisode = false }
  }
  if (durations.length === 0) {
    return `No fully recovered dip of ${(threshold * 100).toFixed(0)}%+ in the last 10 years to compare against — treat the timeline as uncertain.`
  }
  durations.sort((a, b) => a - b)
  const median = durations[Math.floor(durations.length / 2)]
  const months = Math.max(1, Math.round(median / 21))
  return `Similar dips (${(threshold * 100).toFixed(0)}%+ below a recent high) fully recovered in a median of ~${months} month${months > 1 ? 's' : ''} across ${durations.length} past episode${durations.length > 1 ? 's' : ''} — expect roughly that holding window if you buy this dip.`
}

// For trims: how long stretches above the 200-day MA took to revert, historically.
function reversionEstimate(series) {
  const closes = series.map(d => d.close)
  const durations = []
  let inEpisode = false, startIdx = 0
  for (let i = 199; i < closes.length; i++) {
    const ma200 = sma(closes, 200, i)
    const above = closes[i] / ma200 - 1 >= STRETCH_PCT / 100
    const backAt = closes[i] <= ma200
    if (!inEpisode && above) { inEpisode = true; startIdx = i }
    else if (inEpisode && backAt) { durations.push(i - startIdx); inEpisode = false }
  }
  if (durations.length === 0) {
    return `This ETF has rarely been this far above its 200-day average in the last 10 years — no historical reversion pattern to lean on.`
  }
  durations.sort((a, b) => a - b)
  const median = durations[Math.floor(durations.length / 2)]
  const weeks = Math.max(1, Math.round(median / 5))
  return `Past stretches of ${STRETCH_PCT}%+ above the 200-day average took a median of ~${weeks} week${weeks > 1 ? 's' : ''} to revert to that average (${durations.length} episode${durations.length > 1 ? 's' : ''}) — no urgency, but upside has historically been limited from here.`
}

// ---------- signal evaluation ----------

function evaluate(ticker, ind, lastState, series) {
  const stateKey = `${ind.trend}|${ind.stretch}`
  if (lastState == null) return { stateKey, signal: null } // first run: baseline only
  if (stateKey === lastState) return { stateKey, signal: null }

  const [prevTrend, prevStretch] = lastState.split('|')
  const triggers = []
  if (ind.trend === 'GOLDEN' && prevTrend === 'DEATH') {
    triggers.push({ dir: 'BUY', text: `the 50-day moving average crossed above the 200-day (golden cross) — a long-term trend turning positive` })
  }
  if (ind.trend === 'DEATH' && prevTrend === 'GOLDEN') {
    triggers.push({ dir: 'SELL', text: `the 50-day moving average crossed below the 200-day (death cross) — the long-term trend has turned negative` })
  }
  if (ind.stretch === 'LOW' && prevStretch !== 'LOW') {
    triggers.push({ dir: 'BUY', text: `price is ${Math.abs(ind.pctVsMa200).toFixed(1)}% below its 200-day average — a meaningful dip for a long-horizon buyer` })
  }
  if (ind.stretch === 'HIGH' && prevStretch !== 'HIGH') {
    triggers.push({ dir: 'SELL', text: `price is ${ind.pctVsMa200.toFixed(1)}% above its 200-day average — stretched, consider trimming` })
  }
  if (triggers.length === 0) return { stateKey, signal: null } // e.g. stretch relaxed back to NONE

  const dirs = new Set(triggers.map(t => t.dir))
  if (dirs.size > 1) {
    console.log(`  ${ticker}: mixed triggers (${triggers.map(t => t.dir).join('/')}) — skipping alert`)
    return { stateKey, signal: null }
  }
  const dir = triggers[0].dir
  const reasons = `Signal for ${ticker}: ` + triggers.map(t => t.text).join('; ') + '.'
  const est = dir === 'BUY' ? recoveryEstimate(series) : reversionEstimate(series)
  return { stateKey, signal: { dir, reasons, est } }
}

// ---------- email ----------

async function sendEmail(signals) {
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, NOTIFY_EMAIL } = process.env
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !NOTIFY_EMAIL) {
    console.log('EmailJS not configured — skipping email (signals are still logged in the app).')
    return
  }
  const buys = signals.filter(s => s.dir === 'BUY').length
  const sells = signals.length - buys
  const subject = `ETF Signals: ${buys ? `${buys} BUY` : ''}${buys && sells ? ', ' : ''}${sells ? `${sells} SELL/TRIM` : ''}`
  const content = signals.map(s =>
    `<div style="margin-bottom:18px">
      <strong>${s.ticker.replace('.TO', '')} — ${s.dir === 'BUY' ? 'BUY' : 'SELL / TRIM'}</strong>
      (${s.price.toFixed(2)} CAD)<br/>
      ${s.reasons}<br/>
      <em>${s.est}</em>
    </div>`
  ).join('') + `<p style="color:#888;font-size:12px">Notification only — no trades are ever placed. Details: https://invest.imetrobert.com/</p>`

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: { subject, content, to_email: NOTIFY_EMAIL },
    }),
  })
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`)
  console.log(`Email sent: ${subject}`)
}

// ---------- main ----------

async function main() {
  const [holdings, watchlist, states] = await Promise.all([
    db.from('etf_holdings').select('ticker'),
    db.from('etf_watchlist').select('ticker'),
    db.from('etf_signal_state').select('*'),
  ])
  for (const r of [holdings, watchlist, states]) if (r.error) throw new Error(r.error.message)

  const tickers = [...new Set([...holdings.data, ...watchlist.data].map(r => r.ticker))]
  const lastStates = Object.fromEntries(states.data.map(r => [r.ticker, r.last_state]))
  console.log(`Evaluating ${tickers.length} tickers: ${tickers.join(', ')}`)

  const fired = []
  const failures = []

  for (const ticker of tickers) {
    try {
      const { series, currency } = await fetchHistory(ticker)
      const ind = computeIndicators(series)
      const { stateKey, signal } = evaluate(ticker, ind, lastStates[ticker] ?? null, series)

      const { error: pErr } = await db.from('etf_prices').upsert({
        ticker,
        price: ind.price,
        currency,
        price_date: ind.priceDate.toISOString().slice(0, 10),
        ma50: ind.ma50,
        ma200: ind.ma200,
        pct_vs_ma200: ind.pctVsMa200,
        updated_at: new Date().toISOString(),
      })
      if (pErr) throw new Error(pErr.message)

      const { error: sErr } = await db.from('etf_signal_state').upsert({
        ticker, last_state: stateKey, updated_at: new Date().toISOString(),
      })
      if (sErr) throw new Error(sErr.message)

      console.log(`  ${ticker}: ${ind.price.toFixed(2)} ${currency}, MA50 ${ind.ma50.toFixed(2)}, MA200 ${ind.ma200.toFixed(2)} (${ind.pctVsMa200 >= 0 ? '+' : ''}${ind.pctVsMa200.toFixed(1)}%), state ${stateKey}${signal ? ` → ${signal.dir}` : ''}`)

      if (signal) {
        const { error } = await db.from('etf_signals').insert({
          ticker, signal: signal.dir, reasons: signal.reasons,
          est_recovery_text: signal.est, price: ind.price,
        })
        if (error) throw new Error(error.message)
        fired.push({ ticker, dir: signal.dir, reasons: signal.reasons, est: signal.est, price: ind.price })
      }
      await new Promise(r => setTimeout(r, 400)) // be polite to Yahoo
    } catch (e) {
      failures.push(`${ticker}: ${e.message}`)
      console.error(`  ${ticker} FAILED: ${e.message}`)
    }
  }

  if (process.env.TEST_EMAIL === 'true' && fired.length === 0) {
    console.log('TEST_EMAIL requested — sending a sample alert.')
    fired.push({
      ticker: 'TEST.TO', dir: 'BUY', price: 12.34,
      reasons: 'Signal for TEST.TO: this is a test alert to confirm email delivery works. No real signal fired.',
      est: 'If you can read this, notifications are configured correctly.',
    })
  }

  if (fired.length) await sendEmail(fired)
  else console.log('No new signals today.')

  if (failures.length === tickers.length && tickers.length > 0) {
    throw new Error('Every ticker failed — check Yahoo availability or ticker symbols.')
  }
  if (failures.length) console.warn(`Completed with ${failures.length} failure(s).`)
}

main().catch(e => { console.error(e); process.exit(1) })
