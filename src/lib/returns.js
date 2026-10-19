// Turns a holding's cost (ACB) and the date it was bought into "years held" and
// an annualized rate of return, so a +40% gain can be read as +40% over what.
//
// annualized = (value / cost) ^ (1 / years) − 1
//
// It is the right figure for money put in once on that date. For a holding
// that was added to over time (reinvested distributions, regular purchases)
// the date is only an approximation — use the average date you bought — and
// cash payouts you spent rather than reinvested aren't in the cost or the
// value, so they aren't counted. Under three months the result is too
// jumpy to be worth showing.

const DAY = 86400000
export const MIN_YEARS = 0.25

// since: 'YYYY-MM-DD'. null when missing, unreadable or in the future.
export function yearsHeld(since, now = new Date()) {
  if (!since) return null
  const t = new Date(`${since}T12:00:00`)
  if (Number.isNaN(t.getTime()) || t > now) return null
  return (now - t) / (365.25 * DAY)
}

export function annualizedReturn(value, cost, years) {
  if (!(years >= MIN_YEARS) || !(cost > 0) || !(value > 0)) return null
  return Math.pow(value / cost, 1 / years) - 1
}

// "3 yrs 2 mo", "1 yr", "8 mo" — whole months, so 11.6 months reads "1 yr", not "12 mo".
export function formatHeld(years) {
  if (years == null) return ''
  const months = Math.max(1, Math.round(years * 12))
  const y = Math.floor(months / 12)
  const m = months % 12
  const parts = []
  if (y) parts.push(`${y} ${y === 1 ? 'yr' : 'yrs'}`)
  if (m) parts.push(`${m} mo`)
  return parts.join(' ')
}

// rows: [{ value, cost, held_since }] — only those with all three count.
// The average holding period is weighted by cost (so a big old position
// counts for more than a small new one), and the annualized figure is the
// dated rows' total return stretched over that average.
export function summarizeReturn(rows, now = new Date()) {
  const dated = rows
    .map(r => ({ ...r, years: yearsHeld(r.held_since, now) }))
    .filter(r => r.years != null && r.cost > 0 && r.value != null)
  if (!dated.length) return { dated: 0, years: null, annualized: null }
  const cost = dated.reduce((s, r) => s + r.cost, 0)
  const value = dated.reduce((s, r) => s + r.value, 0)
  const years = dated.reduce((s, r) => s + r.cost * r.years, 0) / cost
  return { dated: dated.length, years, annualized: annualizedReturn(value, cost, years) }
}
