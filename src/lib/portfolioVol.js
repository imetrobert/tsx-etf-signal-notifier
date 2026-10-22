// Measures how much YOUR portfolio actually swings, from the price history of
// what you hold — so the retirement planner's Monte Carlo can use a
// volatility that fits your mix instead of one generic number.
//
// Method: turn each holding's history into monthly total returns, blend them
// month by month using today's value weights, and take the standard deviation
// of that blended series, annualized (× √12). Blending the returns — rather
// than averaging each holding's own volatility — keeps the diversification
// between your holdings: funds that zig while others zag really do cancel.
// Because it is measured from each fund's own price history, an actively
// managed fund's behaviour (its manager's tilts, cash, hedges) is already in
// its numbers.
//
// Honest limits: it is the past, over (at most) the window below; holdings
// with no history are not measured, so coverage is reported; and it is one
// number for a distribution that really has fat tails.

export const DEFAULT_WINDOW_MONTHS = 60
// The longer look-back used for the year-by-year view and a second opinion on the volatility.
export const LONG_WINDOW_MONTHS = 120
const MIN_LONG_MONTHS = 84
export const MIN_MONTHS = 24
// A month only counts if holdings carrying at least this share of the
// measured value have a return for it, so the blend doesn't lurch when a young
// fund drops in or out.
const MIN_MONTH_SHARE = 0.6

const monthKey = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

// series: [{ date: Date, close, adj? }] oldest → newest. Uses the adjusted
// close (distributions reinvested) when present, so a fund's payout day isn't
// mistaken for a drop. Returns Map('YYYY-MM' → monthly return). The current,
// still-unfinished month is left out.
export function monthlyReturns(series, now = new Date()) {
  const lastOfMonth = new Map()
  for (const p of series) {
    const v = p.adj ?? p.close
    if (v == null || !(v > 0)) continue
    lastOfMonth.set(monthKey(p.date), v)
  }
  const keys = [...lastOfMonth.keys()].sort()
  const out = new Map()
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] >= monthKey(now)) continue
    out.set(keys[i], lastOfMonth.get(keys[i]) / lastOfMonth.get(keys[i - 1]) - 1)
  }
  return out
}

const sd = xs => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

const growth = rs => rs.reduce((acc, x) => acc * (1 + x), 1) - 1

// Calendar years that have all twelve months, as { year, return }.
function calendarYearReturns(months, returns) {
  const byYear = new Map()
  months.forEach((m, i) => {
    const y = m.slice(0, 4)
    if (!byYear.has(y)) byYear.set(y, [])
    byYear.get(y).push(returns[i])
  })
  return [...byYear.entries()].filter(([, rs]) => rs.length === 12)
    .map(([y, rs]) => ({ year: Number(y), return: growth(rs) }))
}

// Returns over every run of twelve consecutive calendar months in the data. Overlapping, so these are
// not independent — a second look at the same history, not extra history.
function rolling12Returns(months, returns) {
  const idx = new Map(months.map((m, i) => [m, i]))
  const out = []
  months.forEach((m, i) => {
    if (i < 11) return
    const start = months[i - 11]
    const [sy, sm] = start.split('-').map(Number), [ey, em] = m.split('-').map(Number)
    if ((ey - sy) * 12 + (em - sm) !== 11) return // a gap inside the window
    out.push(growth(returns.slice(i - 11, i + 1)))
  })
  return out
}

// items: [{ ticker, value, series | null }] — value is today's value (price ×
// units); series is null/empty when no history could be fetched.
// Returns null when there isn't enough to measure, else
// { annualVol, months, windowStart, windowEnd, coverage, covered, uncovered, worst12m, perHolding, history }
// where annualVol is over the latest windowMonths (60) and history adds a second opinion:
//   annualVolLong (longest history, up to longMonths), rolling12Vol, calendarYears, calendarYearVol,
//   meanAnnual / geoAnnual of the full calendar years — all for the SAME blend of today's holdings.
export function portfolioVolatility(items, { windowMonths = DEFAULT_WINDOW_MONTHS, longMonths = LONG_WINDOW_MONTHS, now = new Date() } = {}) {
  const total = items.reduce((s, i) => s + (i.value > 0 ? i.value : 0), 0)
  if (!(total > 0)) return null

  const measured = []
  const uncovered = []
  for (const it of items) {
    if (!(it.value > 0)) continue
    const returns = it.series && it.series.length ? monthlyReturns(it.series, now) : null
    if (returns && returns.size >= MIN_MONTHS) measured.push({ ...it, returns })
    else uncovered.push(it.ticker)
  }
  if (!measured.length) return null
  const measuredValue = measured.reduce((s, i) => s + i.value, 0)

  const unionMonths = [...new Set(measured.flatMap(i => [...i.returns.keys()]))].sort()
  const blendMonth = m => {
    const here = measured.filter(i => i.returns.has(m))
    const share = here.reduce((s, i) => s + i.value, 0) / measuredValue
    if (share < MIN_MONTH_SHARE) return null
    const w = here.reduce((s, i) => s + i.value, 0)
    return here.reduce((s, i) => s + i.value * i.returns.get(m), 0) / w
  }
  // One blended series over the longest look-back; the 60-month figures are its tail.
  const longMonthsList = [], longReturns = []
  for (const m of unionMonths.slice(-Math.max(longMonths, windowMonths))) {
    const r = blendMonth(m)
    if (r !== null) { longMonthsList.push(m); longReturns.push(r) }
  }
  const recentSet = new Set(unionMonths.slice(-windowMonths))
  const used = [], blended = []
  longMonthsList.forEach((m, i) => { if (recentSet.has(m)) { used.push(m); blended.push(longReturns[i]) } })
  if (blended.length < MIN_MONTHS) return null

  // Worst rolling 12 months, as a sanity figure alongside the volatility.
  let worst12m = null
  for (let i = 11; i < blended.length; i++) {
    const r = blended.slice(i - 11, i + 1).reduce((acc, x) => acc * (1 + x), 1) - 1
    if (worst12m === null || r < worst12m) worst12m = r
  }

  // The second opinion: how big the year-to-year swings actually were, not just scaled up from months.
  const recentIdx = longMonthsList.map((m, i) => ({ m, i })).filter(x => recentSet.has(x.m))
  const rolling = rolling12Returns(recentIdx.map(x => x.m), recentIdx.map(x => longReturns[x.i]))
  const years = calendarYearReturns(longMonthsList, longReturns)
  const history = {
    annualVolLong: longReturns.length >= MIN_LONG_MONTHS ? sd(longReturns) * Math.sqrt(12) : null,
    monthsLong: longReturns.length,
    windowLongStart: longMonthsList[0],
    rolling12Vol: rolling.length >= 12 ? sd(rolling) : null,
    rolling12Count: rolling.length,
    calendarYears: years,
    calendarYearVol: years.length >= 4 ? sd(years.map(y => y.return)) : null,
    meanAnnual: years.length ? years.reduce((s, y) => s + y.return, 0) / years.length : null,
    geoAnnual: years.length ? Math.pow(years.reduce((acc, y) => acc * (1 + y.return), 1), 1 / years.length) - 1 : null,
  }

  return {
    history,
    annualVol: sd(blended) * Math.sqrt(12),
    months: blended.length,
    windowStart: used[0],
    windowEnd: used[used.length - 1],
    // Share of the portfolio's value that could be measured at all.
    coverage: measuredValue / total,
    covered: measured.map(i => i.ticker),
    uncovered,
    worst12m,
    perHolding: measured.map(i => {
      const r = [...i.returns.entries()].filter(([m]) => used.includes(m)).map(([, v]) => v)
      return { ticker: i.ticker, weight: i.value / measuredValue, vol: r.length > 2 ? sd(r) * Math.sqrt(12) : null }
    }),
  }
}
