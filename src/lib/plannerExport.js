// Builds the portfolio snapshot the retirement planner imports.
//
// The planner wants four balances (RRSP, TFSA, LIRA, non-registered) and, for
// the non-registered account, how much of its value is unrealized gain — it
// derives the cost base as balance × (1 − gain %) and taxes withdrawals on
// the gain portion. So the figure that matters most is
//
//     gain % = (market value − ACB) / market value     (non-registered only)
//
// Registered accounts need only a balance: gains inside an RRSP/TFSA/LIRA
// aren't taxed as capital gains, so their ACB is carried for reference only.
//
// rows: Dashboard rows — { account, value, currency, priceDate, cost_cad,
//   book_cost, cost_source, institution } with value = today's price × units
//   in the security's own currency.
//
// volatility (optional): the nightly job's measure of how much the whole
//   portfolio swings — { annualVol (0.087 = 8.7%), months, windowStart,
//   windowEnd, coverage (0–1), worst12m, updatedAt, history }, where history is
//   the year-by-year second opinion from portfolioVol.js (calendar-year returns,
//   a longer-window figure, rolling 12-month spread). It becomes the Monte
//   Carlo's "annual volatility", replacing a generic guess with one measured
//   from what is actually held.
//
// pension (optional): the latest Bell DC pension snapshot —
//   { snapshotDate, periodStart, fundName, types: [{ label, units, marketValue,
//   opening, contributions, earnings }] }. It fills the planner's separate Bell
//   DC pension balance and yearly contribution (employee + company).
//
// income (optional): the latest Income Summary for the non-registered account,
//   { periodEnd: 'YYYY-MM-DD', dividendsYtd, interestYtd, institution }. The
//   planner's "taxable income each year" is a % of balance, so year-to-date
//   income is scaled to a full year and divided by the account's value.

import { pensionMetrics } from './bellPension.js'

export const PLANNER_FORMAT = 'etf-tracker-portfolio'
export const PLANNER_VERSION = 1

const ACCOUNTS = ['RRSP', 'TFSA', 'LIRA', 'NON_REG']
const round2 = n => Math.round(n * 100) / 100
const daysBetween = (a, b) => Math.floor((b - a) / 86400000)

export function buildPlannerExport(rows, { usdCad, income = null, volatility = null, pension = null, now = new Date() } = {}) {
  const warnings = []
  const accounts = Object.fromEntries(ACCOUNTS.map(code => [code, {
    marketValue: 0, acb: 0, costedValue: 0, holdings: 0, withoutCost: 0, estimatedCost: 0,
  }]))
  let unpriced = 0
  let usdConverted = 0
  let skippedCurrency = 0
  let oldestPrice = null
  const nonRegByInstitution = {}

  for (const r of rows) {
    const code = ACCOUNTS.includes(r.account) ? r.account : 'NON_REG'
    if (r.value == null) { unpriced++; continue }
    const currency = r.currency || 'CAD'
    let fx = 1
    if (currency === 'USD') {
      if (!(usdCad > 0)) { skippedCurrency++; continue }
      fx = usdCad
      usdConverted++
    } else if (currency !== 'CAD') { skippedCurrency++; continue }

    const mv = r.value * fx
    const acc = accounts[code]
    acc.marketValue += mv
    if (code === 'NON_REG') nonRegByInstitution[r.institution || 'MANULIFE'] = (nonRegByInstitution[r.institution || 'MANULIFE'] || 0) + mv
    acc.holdings++
    if (r.priceDate && (!oldestPrice || r.priceDate < oldestPrice)) oldestPrice = r.priceDate

    // The CAD cost is the tax figure. Fall back to the plain cost only when
    // the holding is itself in CAD, where the two are the same thing.
    const acb = r.cost_cad != null ? Number(r.cost_cad)
      : (r.book_cost != null && currency === 'CAD' ? Number(r.book_cost) : null)
    if (acb != null) {
      acc.acb += acb
      acc.costedValue += mv
      if (r.cost_source === 'estimated') acc.estimatedCost++
    } else {
      acc.withoutCost++
    }
  }

  for (const acc of Object.values(accounts)) {
    acc.marketValue = round2(acc.marketValue)
    acc.acb = round2(acc.acb)
    acc.costedValue = round2(acc.costedValue)
    acc.gain = round2(acc.costedValue - acc.acb)
  }

  // Non-registered gain as a share of its value, taken over the holdings whose
  // cost is known and applied to the whole account.
  const nr = accounts.NON_REG
  let gainPct = null
  if (nr.costedValue > 0) {
    const raw = ((nr.costedValue - nr.acb) / nr.costedValue) * 100
    gainPct = Math.min(100, Math.max(0, round2(raw)))
    if (raw < 0) warnings.push('Your non-registered account is at a net loss against cost, so the planner gets 0% gains (it has no field for a loss).')
    if (nr.withoutCost > 0) {
      const covered = Math.round((nr.costedValue / nr.marketValue) * 100)
      warnings.push(`Non-registered cost basis is known for ${nr.holdings - nr.withoutCost} of ${nr.holdings} holdings (${covered}% of its value); the gain % assumes the rest looks the same.`)
    }
    if (nr.estimatedCost > 0) warnings.push(`${nr.estimatedCost} non-registered holding(s) have an estimated cost (units added since the last statement). Attach a newer statement to make it exact.`)
  } else if (nr.marketValue > 0) {
    warnings.push('No cost basis on file for your non-registered holdings, so the gain % was left out — the planner keeps whatever it had.')
  }

  // Taxable income a year, as a % of the non-registered balance.
  let yieldPct = null
  let incomeDetail = null
  if (income && income.periodEnd && nr.marketValue > 0) {
    const months = Math.min(12, Math.max(1, Number(income.periodEnd.slice(5, 7)) || 12))
    const ytd = (Number(income.dividendsYtd) || 0) + (Number(income.interestYtd) || 0)
    const annualized = round2((ytd * 12) / months)
    const raw = (annualized / nr.marketValue) * 100
    // The planner's own field tops out at 10%.
    yieldPct = Math.min(10, Math.max(0, round2(raw)))
    incomeDetail = { periodEnd: income.periodEnd, months, ytd: round2(ytd), annualized, yieldPct }
    if (raw > 10) warnings.push(`Income works out to ${round2(raw)}% of the account, above the planner's 10% limit, so 10% was sent.`)
    if (months < 12) {
      warnings.push(`Taxable income is ${months} months of statement income (to ${income.periodEnd}) scaled to a full year. Distributions are often bunched in December, so a December statement gives the exact figure.`)
    }
    // Income from the other institution isn't on this statement, so it counts as nothing.
    const stmtInst = income.institution || 'MANULIFE'
    const otherValue = Object.entries(nonRegByInstitution).filter(([k]) => k !== stmtInst).reduce((s, [, v]) => s + v, 0)
    if (otherValue > 0) {
      warnings.push(`Income from your other non-registered holdings (${Math.round((otherValue / nr.marketValue) * 100)}% of the account) isn't on this statement, so it counts as $0 here.`)
    }
    const age = daysBetween(new Date(`${income.periodEnd}T12:00:00`), now)
    if (age > 400) warnings.push(`The income figure comes from a statement ${Math.floor(age / 30)} months old — attach a newer one.`)
  } else if (nr.marketValue > 0) {
    warnings.push('No statement income on file, so the taxable-income % was left out — the planner keeps whatever it had. Attach a Manulife statement on the Import tab to add it.')
  }

  // Monte Carlo volatility, measured from the real holdings.
  let volPct = null
  let volDetail = null
  let portfolioStats = null
  if (volatility && volatility.annualVol > 0) {
    volPct = Math.min(40, Math.max(0, Math.round(volatility.annualVol * 1000) / 10))
    volDetail = {
      annualVolPct: volPct,
      months: volatility.months,
      window: `${volatility.windowStart} to ${volatility.windowEnd}`,
      coveragePct: Math.round((volatility.coverage ?? 1) * 100),
      worst12mPct: volatility.worst12m == null ? null : Math.round(volatility.worst12m * 1000) / 10,
    }
    if ((volatility.coverage ?? 1) < 0.7) {
      warnings.push(`Only ${volDetail.coveragePct}% of your portfolio's value had price history (funds that only publish a daily price can't be measured), so the rest is assumed to swing like the part that was.`)
    }
    if (volatility.months < 36) warnings.push(`Volatility is based on only ${volatility.months} months of history, which can miss a bad stretch.`)
    // What the portfolio actually did year to year, so the planner can show its evidence and offer a longer view.
    const h = volatility.history
    if (h) {
      const pct1 = x => (x == null ? null : Math.round(x * 1000) / 10)
      portfolioStats = {
        asOf: volatility.updatedAt || null,
        months: volatility.months,
        window: `${volatility.windowStart} to ${volatility.windowEnd}`,
        coveragePct: volDetail.coveragePct,
        volPct,
        volLongPct: h.annualVolLong == null ? null : Math.min(40, pct1(h.annualVolLong)),
        monthsLong: h.monthsLong ?? null,
        rolling12VolPct: pct1(h.rolling12Vol),
        calendarYearVolPct: pct1(h.calendarYearVol),
        calendarYears: (h.calendarYears || []).map(y => ({ year: y.year, returnPct: pct1(y.return) })),
        meanAnnualPct: pct1(h.meanAnnual),
        geoAnnualPct: pct1(h.geoAnnual),
        worst12mPct: volDetail.worst12mPct,
      }
      if (h.calendarYearVol != null && (h.calendarYears || []).length >= 5 && h.calendarYearVol > volatility.annualVol * 1.25) {
        warnings.push(`Year-to-year swings (${pct1(h.calendarYearVol)}%) have been larger than the monthly figure suggests (${volPct}%) — markets trended. The planner's “longest history” choice or a higher number would be more cautious.`)
      }
    }
    if (volatility.updatedAt) {
      const age = daysBetween(new Date(volatility.updatedAt), now)
      if (age > 14) warnings.push(`The volatility was measured ${age} days ago — the nightly job may not be running.`)
    }
  } else {
    warnings.push('No portfolio volatility measured yet (the nightly job computes it from your holdings’ price history), so the planner keeps its own figure.')
  }

  // Bell DC pension: its own entry in the planner, from the latest snapshot.
  let pensionDetail = null
  if (pension && pension.snapshotDate && (pension.types || []).length) {
    const pm = pensionMetrics(pension, now)
    pensionDetail = {
      asOf: pension.snapshotDate, marketValue: Math.round(pm.totalValue), fundName: pension.fundName || null,
      annualContribution: pm.annualContribution, employeeContributions: pm.employeeContributions, companyContributions: pm.companyContributions,
    }
    if (pm.ageDays > 400) {
      warnings.push(`The Bell DC pension figure is from ${pension.snapshotDate}, over a year old — add a fresh snapshot on the Pension tab.`)
    } else if (pm.ageDays > 120) {
      warnings.push(`The Bell DC pension is as of ${pension.snapshotDate}; its value will have moved since.`)
    }
    if (pm.contributions != null && pm.annualContribution == null) {
      warnings.push('Bell DC contributions weren’t sent: the period they cover is missing or under three months. Set “Contributions cover from” on the Pension tab.')
    }
    // The measured volatility comes from price histories; the pension has none.
    if (volatility) {
      const invested = Object.values(accounts).reduce((s, a) => s + a.marketValue, 0)
      const share = Math.round((pm.totalValue / (invested + pm.totalValue)) * 100)
      if (share >= 5) warnings.push(`The Bell DC pension (${share}% of your total) has no price history, so it isn’t in the volatility figure — it is assumed to swing like the rest.`)
    }
  }

  if (unpriced > 0) warnings.push(`${unpriced} holding(s) have no price yet and are left out of these totals.`)
  if (skippedCurrency > 0) warnings.push(`${skippedCurrency} USD holding(s) were left out because no USD→CAD rate is set.`)
  if (usdConverted > 0) warnings.push(`${usdConverted} USD holding(s) converted to CAD at ${usdCad}.`)
  if (oldestPrice) {
    const age = daysBetween(new Date(`${oldestPrice}T12:00:00`), now)
    if (age > 5) warnings.push(`Some prices are ${age} days old (oldest ${oldestPrice}) — refresh prices first.`)
  }

  return {
    format: PLANNER_FORMAT,
    version: PLANNER_VERSION,
    asOf: now.toISOString(),
    pricesAsOf: oldestPrice,
    currency: 'CAD',
    usdCad: usdConverted > 0 ? usdCad : null,
    accounts: { ...accounts, NON_REG: { ...accounts.NON_REG, income: incomeDetail } },
    volatility: volDetail,
    portfolioStats,
    pension: pensionDetail,
    // What the planner actually reads; everything above is for the person.
    planner: {
      currentRrsp: Math.round(accounts.RRSP.marketValue),
      currentTfsa: Math.round(accounts.TFSA.marketValue),
      liraBalance: Math.round(accounts.LIRA.marketValue),
      currentNonReg: Math.round(accounts.NON_REG.marketValue),
      nonRegCapitalGainsPct: gainPct,
      nonRegYieldPct: yieldPct,
      mcVolatility: volPct,
      bellDcBalance: pensionDetail ? pensionDetail.marketValue : null,
      contribBellDc: pensionDetail ? pensionDetail.annualContribution : null,
    },
    warnings,
    notTracked: 'Cash balances, crypto, FTQ and RESP/FHSA accounts are not tracked here, so your real account totals can be somewhat higher.',
  }
}
