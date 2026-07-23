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

// ---------- account-aware advice ----------
// The user's TFSA and RRSP are maxed out (no new contribution room), so any
// buy inside a registered account requires selling something there first.

const ACCOUNT_LABEL = { RRSP: 'RRSP', TFSA: 'TFSA', NON_REG: 'non-registered account' }

function accountAdvice(dir, accounts) {
  const held = [...new Set(accounts)]
  const heldText = held.length
    ? `You hold this ETF in your ${held.map(a => ACCOUNT_LABEL[a] || a).join(' and ')}.`
    : `You don't currently hold this ETF (watchlist signal).`

  if (dir === 'BUY') {
    return `${heldText} Your TFSA and RRSP are maxed out — no new contribution room. ` +
      `To act on this buy inside a registered account, sell an existing TFSA/RRSP holding first ` +
      `(swaps inside a registered account have no tax impact), ideally one with a weaker outlook. ` +
      `Buying without selling means using your non-registered account, where dividends and future gains are taxable.`
  }

  // SELL / trim: what selling means in each account where it's held.
  const parts = [heldText]
  if (held.includes('TFSA')) {
    parts.push(`TFSA: selling is tax-free — keep the cash inside the TFSA to redeploy on the next BUY signal ` +
      `(withdrawing it only restores contribution room next calendar year, and you can't re-contribute since you're maxed).`)
  }
  if (held.includes('RRSP')) {
    parts.push(`RRSP: selling has no immediate tax hit, but keep the proceeds inside the account — ` +
      `withdrawals are taxed as income and the contribution room is lost for good.`)
  }
  if (held.includes('NON_REG')) {
    parts.push(`Non-registered: selling can realize capital gains tax — weigh the tax cost against the trim benefit.`)
  }
  if (!held.length) {
    parts.push(`No position to trim — no action needed.`)
  } else {
    parts.push(`Since your registered accounts are maxed, cash raised inside the TFSA/RRSP is your only way to fund future registered buys — a trim here creates that dry powder.`)
  }
  return parts.join(' ')
}

// ---------- market regime (macro layer) ----------
// Three free official gauges; each failure degrades gracefully to "unavailable".

async function fetchMarketRegime() {
  const gauges = []
  let flags = 0

  // 1. Canada yield curve: 10y minus 2y benchmark yields (Bank of Canada Valet API)
  try {
    const r = await fetch('https://www.bankofcanada.ca/valet/observations/BD.CDN.2YR.DQ.YLD,BD.CDN.10YR.DQ.YLD/json?recent=10')
    const j = await r.json()
    const obs = (j.observations || []).filter(o => o['BD.CDN.2YR.DQ.YLD']?.v && o['BD.CDN.10YR.DQ.YLD']?.v)
    const last = obs[obs.length - 1]
    const spread = parseFloat(last['BD.CDN.10YR.DQ.YLD'].v) - parseFloat(last['BD.CDN.2YR.DQ.YLD'].v)
    const inverted = spread < 0
    if (inverted) flags++
    gauges.push({
      name: 'Canada yield curve (10y−2y)',
      value: `${spread >= 0 ? '+' : ''}${spread.toFixed(2)} pts`,
      status: inverted ? 'INVERTED — has historically led recessions by 6–18 months' : 'normal shape',
      warn: inverted,
    })
  } catch (e) {
    gauges.push({ name: 'Canada yield curve (10y−2y)', value: 'unavailable', status: e.message, warn: false })
  }

  // 2. US high-yield credit spreads (FRED BAMLH0A0HYM2): stress when high or widening fast
  try {
    const csv = await (await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2')).text()
    const rows = csv.trim().split('\n').slice(1).map(l => l.split(',')).filter(r => r[1] && r[1] !== '.')
    const latest = parseFloat(rows[rows.length - 1][1])
    const threeMonthsAgo = parseFloat(rows[Math.max(0, rows.length - 64)][1])
    const elevated = latest >= 5
    const widening = latest - threeMonthsAgo >= 0.75
    if (elevated || widening) flags++
    gauges.push({
      name: 'US high-yield credit spreads',
      value: `${latest.toFixed(2)}%`,
      status: elevated ? 'ELEVATED — credit markets pricing meaningful stress'
        : widening ? `WIDENING fast (+${(latest - threeMonthsAgo).toFixed(2)} pts in ~3 months) — early risk-off tell`
        : 'calm',
      warn: elevated || widening,
    })
  } catch (e) {
    gauges.push({ name: 'US high-yield credit spreads', value: 'unavailable', status: e.message, warn: false })
  }

  // 3. Sahm Rule recession indicator (FRED SAHMREALTIME): triggered at >= 0.50
  try {
    const csv = await (await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=SAHMREALTIME')).text()
    const rows = csv.trim().split('\n').slice(1).map(l => l.split(',')).filter(r => r[1] && r[1] !== '.')
    const latest = parseFloat(rows[rows.length - 1][1])
    const triggered = latest >= 0.5
    if (triggered) flags++
    gauges.push({
      name: 'Sahm Rule (US recession indicator)',
      value: latest.toFixed(2),
      status: triggered ? 'TRIGGERED — historically a reliable recession start marker' : 'not triggered',
      warn: triggered,
    })
  } catch (e) {
    gauges.push({ name: 'Sahm Rule (US recession indicator)', value: 'unavailable', status: e.message, warn: false })
  }

  const level = flags >= 2 ? 'CAUTION' : flags === 1 ? 'WATCH' : 'NORMAL'
  return { level, flags, gauges }
}

function regimeNote(dir, level) {
  if (level === 'CAUTION') {
    return dir === 'BUY'
      ? 'Macro regime is CAUTION — dips can deepen in this environment; consider staging in rather than buying all at once.'
      : 'Macro regime is CAUTION — adds conviction to trimming.'
  }
  if (level === 'WATCH') {
    return dir === 'BUY'
      ? 'Macro regime is WATCH — one caution gauge is flashing; a somewhat riskier backdrop for dip-buying.'
      : 'Macro regime is WATCH — mildly supportive of trimming.'
  }
  return dir === 'BUY'
    ? 'Macro regime is NORMAL — supportive backdrop for buying this dip.'
    : 'Macro regime is NORMAL — no macro urgency behind this trim signal.'
}

function regimeHtml(regime) {
  const rows = regime.gauges.map(g =>
    `<li><strong>${g.name}</strong>: ${g.value} — ${g.warn ? '<span style="color:#b5502f">' + g.status + '</span>' : g.status}</li>`
  ).join('')
  return `<div style="margin-top:16px;padding-top:10px;border-top:1px solid #ddd">
    <strong>Market regime: ${regime.level}</strong>
    <ul style="margin:6px 0 0 18px;padding:0">${rows}</ul>
  </div>`
}

// ---------- email ----------

async function sendEmail(signals, regime, regimeChange) {
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, NOTIFY_EMAIL } = process.env
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !NOTIFY_EMAIL) {
    console.log('EmailJS not configured — skipping email (signals are still logged in the app).')
    return
  }
  const buys = signals.filter(s => s.dir === 'BUY').length
  const sells = signals.length - buys
  const parts = []
  if (buys) parts.push(`${buys} BUY`)
  if (sells) parts.push(`${sells} SELL/TRIM`)
  if (regimeChange) parts.push(`market regime now ${regimeChange.to}`)
  const subject = `ETF Signals: ${parts.join(', ')}`

  const regimeChangeBlock = regimeChange
    ? `<div style="margin-bottom:18px">
        <strong>Market regime changed: ${regimeChange.from} → ${regimeChange.to}</strong><br/>
        The macro backdrop shifted (details below). ${regimeChange.to === 'NORMAL'
          ? 'Conditions have normalized.'
          : 'No action required — but treat new BUY-dip signals with extra care and SELL/trim signals with extra weight while this persists.'}
      </div>`
    : ''

  const content = regimeChangeBlock + signals.map(s =>
    `<div style="margin-bottom:18px">
      <strong>${s.ticker.replace('.TO', '')} — ${s.dir === 'BUY' ? 'BUY' : 'SELL / TRIM'}</strong>
      (${s.price.toFixed(2)} CAD)<br/>
      ${s.reasons}<br/>
      <em>${s.est}</em><br/>
      ${s.advice ? `<span style="color:#2b4a4d">${s.advice}</span><br/>` : ''}
      <span style="color:#555">${regimeNote(s.dir, regime.level)}</span>
    </div>`
  ).join('') + regimeHtml(regime)
    + `<p style="color:#888;font-size:12px;margin-top:14px">Notification only — no trades are ever placed. Details: https://invest.imetrobert.com/</p>`

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
    db.from('etf_holdings').select('ticker, account'),
    db.from('etf_watchlist').select('ticker'),
    db.from('etf_signal_state').select('*'),
  ])
  for (const r of [holdings, watchlist, states]) if (r.error) throw new Error(r.error.message)

  const tickers = [...new Set([...holdings.data, ...watchlist.data].map(r => r.ticker))]
  const accountsByTicker = {}
  for (const r of holdings.data) (accountsByTicker[r.ticker] ??= []).push(r.account || 'NON_REG')
  const lastStates = Object.fromEntries(states.data.map(r => [r.ticker, r.last_state]))
  console.log(`Evaluating ${tickers.length} tickers: ${tickers.join(', ')}`)

  const regime = await fetchMarketRegime()
  console.log(`Market regime: ${regime.level} (${regime.flags} caution flag(s))`)
  for (const g of regime.gauges) console.log(`  ${g.name}: ${g.value} — ${g.status}`)

  const priorRegime = lastStates['_MARKET_REGIME'] ?? null
  const regimeChange = priorRegime && priorRegime !== regime.level
    ? { from: priorRegime, to: regime.level }
    : null
  const { error: rStateErr } = await db.from('etf_signal_state').upsert({
    ticker: '_MARKET_REGIME', last_state: regime.level, updated_at: new Date().toISOString(),
  })
  if (rStateErr) console.error(`regime state save failed: ${rStateErr.message}`)
  const { error: rErr } = await db.from('etf_market_regime').upsert({
    id: 1, level: regime.level, gauges: regime.gauges, updated_at: new Date().toISOString(),
  })
  if (rErr) console.error(`regime save failed (run supabase/schema.sql to add the table): ${rErr.message}`)

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
        const advice = accountAdvice(signal.dir, accountsByTicker[ticker] || [])
        const { error } = await db.from('etf_signals').insert({
          ticker, signal: signal.dir, reasons: signal.reasons,
          est_recovery_text: signal.est, account_advice: advice, price: ind.price,
        })
        if (error) throw new Error(error.message)
        fired.push({ ticker, dir: signal.dir, reasons: signal.reasons, est: signal.est, advice, price: ind.price })
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

  if (fired.length || regimeChange) await sendEmail(fired, regime, regimeChange)
  else console.log('No new signals today.')

  if (failures.length === tickers.length && tickers.length > 0) {
    throw new Error('Every ticker failed — check Yahoo availability or ticker symbols.')
  }
  if (failures.length) console.warn(`Completed with ${failures.length} failure(s).`)
}

main().catch(e => { console.error(e); process.exit(1) })
