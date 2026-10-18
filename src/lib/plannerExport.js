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
//   book_cost, cost_source } with value = today's price × units in the
//   security's own currency.

export const PLANNER_FORMAT = 'etf-tracker-portfolio'
export const PLANNER_VERSION = 1

const ACCOUNTS = ['RRSP', 'TFSA', 'LIRA', 'NON_REG']
const round2 = n => Math.round(n * 100) / 100
const daysBetween = (a, b) => Math.floor((b - a) / 86400000)

export function buildPlannerExport(rows, { usdCad, now = new Date() } = {}) {
  const warnings = []
  const accounts = Object.fromEntries(ACCOUNTS.map(code => [code, {
    marketValue: 0, acb: 0, costedValue: 0, holdings: 0, withoutCost: 0, estimatedCost: 0,
  }]))
  let unpriced = 0
  let usdConverted = 0
  let skippedCurrency = 0
  let oldestPrice = null

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
    accounts,
    // What the planner actually reads; everything above is for the person.
    planner: {
      currentRrsp: Math.round(accounts.RRSP.marketValue),
      currentTfsa: Math.round(accounts.TFSA.marketValue),
      liraBalance: Math.round(accounts.LIRA.marketValue),
      currentNonReg: Math.round(accounts.NON_REG.marketValue),
      nonRegCapitalGainsPct: gainPct,
    },
    warnings,
    notTracked: 'Cash balances, crypto, FTQ and RESP/FHSA accounts are not tracked here, so your real account totals can be somewhat higher.',
  }
}
