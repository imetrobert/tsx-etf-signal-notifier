// Reads a Bell Benefits "contribution type breakdown" — from a screenshot run
// through on-device OCR, or from text copied off the page — into a pension
// snapshot, and works out what the retirement planner needs from it.
//
// What the page shows (one fund, split by who contributed):
//
//   Fund name | Asset mix | Number of units | Market value         ← per type
//   Bimcor Balanced Fund (50-54)  100.00%  4,772.6312  $125,593.22
//   Company   $338,019.25  $6,268.25  $32,124.25  $376,411.75       ← type summary
//   Bimcor Balanced Fund (50-54)  100.00%  14,303.9124 $376,411.75
//   Total     $450,804.32  $8,357.74   $42,842.91  $502,004.97      ← all types
//
// The four dollar columns of a summary row are, left to right, opening
// balance + contributions + investment earnings = market value. The page's own
// headers for them are usually cropped out of a phone screenshot, so the
// reading is checked by that arithmetic rather than trusted from labels. A
// type whose summary row is cropped out is worked out as total − the others.

const MONEY = /\$\s?([\d,]+\.\d{2})/g
const num = s => Number(String(s).replace(/,/g, ''))
const round2 = n => Math.round(n * 100) / 100
const close = (a, b, tol = 0.05) => Math.abs(a - b) <= tol

// The row of a fund: asset mix %, units (3–4 decimals) and market value.
const FUND_ROW = /(\d{1,3}(?:\.\d+)?)\s?%\s+([\d,]+\.\d{3,4})\s+\$\s?([\d,]+\.\d{2})/g
// Four dollar amounts in a row.
const SUMMARY_ROW = /\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})/g

const HEADER_WORDS = /\b(Number of|Fund name|Asset mix|units|Market value|Bell Benefits)\b/gi

function cleanLabel(raw) {
  // Keep only trailing word-like text; OCR junk from a cropped label is dropped.
  const words = String(raw).replace(HEADER_WORDS, ' ').match(/[A-Za-z][A-Za-z&' -]{2,}/g) || []
  const last = (words[words.length - 1] || '').trim()
  if (/ompany|mpany/i.test(last)) return 'Company'
  if (/mploy|mplo/i.test(last)) return 'Employee'
  if (/^total$/i.test(last)) return 'Total'
  return last.length >= 4 && /^[A-Z]/.test(last) ? last : ''
}

function fundNameBefore(text) {
  // The name sits between the table header and the "100.00%".
  let t = text
  const m = [...t.matchAll(/Market value/gi)].pop()
  if (m) t = t.slice(m.index + m[0].length)
  else { const d = t.lastIndexOf('$'); if (d >= 0) t = t.slice(t.indexOf(' ', d) + 1) }
  t = t.replace(HEADER_WORDS, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 3 ? t : ''
}

// text: OCR output or pasted text. Returns
//   { ok, fundName, types: [{ label, units, marketValue, opening, contributions, earnings, derived }],
//     total: { opening, contributions, earnings, marketValue } | null, checks: [{ ok, text }], warnings }
export function parseBellText(text) {
  const flat = String(text || '').replace(/[\u00a0\t]+/g, ' ').replace(/\s+/g, ' ')
  const warnings = []

  const funds = []
  for (const m of flat.matchAll(FUND_ROW)) {
    funds.push({
      name: fundNameBefore(flat.slice(Math.max(0, m.index - 140), m.index)),
      units: num(m[2]), marketValue: num(m[3]), at: m.index,
    })
  }

  const summaries = []
  for (const m of flat.matchAll(SUMMARY_ROW)) {
    const [opening, contributions, earnings, marketValue] = m.slice(1, 5).map(num)
    summaries.push({
      label: cleanLabel(flat.slice(Math.max(0, m.index - 40), m.index)),
      opening, contributions, earnings, marketValue,
      adds: close(round2(opening + contributions + earnings), marketValue),
      at: m.index,
    })
  }

  if (!funds.length && !summaries.length) {
    return { ok: false, fundName: '', types: [], total: null, checks: [], warnings: ["Couldn't find a fund row or a contribution summary in that text."] }
  }

  // The last summary row is the grand total; the others are contribution types.
  let total = null
  let typeRows = summaries
  if (summaries.length >= 2) { total = summaries[summaries.length - 1]; typeRows = summaries.slice(0, -1) }
  else if (summaries.length === 1 && funds.length === 1 && close(summaries[0].marketValue, funds[0].marketValue)) {
    // A single type: its summary is also the total.
    typeRows = summaries
  }

  const types = typeRows.map(s => ({
    label: s.label, units: null, marketValue: s.marketValue,
    opening: s.opening, contributions: s.contributions, earnings: s.earnings, derived: false,
  }))

  // A fund table whose type summary isn't visible (cropped off the top of a
  // screenshot): the type is whatever is left of the total.
  const unmatched = funds.filter(f => !types.some(t => close(t.marketValue, f.marketValue)))
  if (total && unmatched.length === 1) {
    const rest = {
      opening: total.opening - types.reduce((s, t) => s + t.opening, 0),
      contributions: total.contributions - types.reduce((s, t) => s + t.contributions, 0),
      earnings: total.earnings - types.reduce((s, t) => s + t.earnings, 0),
      marketValue: total.marketValue - types.reduce((s, t) => s + t.marketValue, 0),
    }
    if (close(rest.marketValue, unmatched[0].marketValue, 0.1)) {
      const others = types.map(t => t.label)
      types.unshift({
        label: others.some(l => l === 'Company') ? 'Employee' : 'Other contributions',
        units: null, marketValue: round2(rest.marketValue), opening: round2(rest.opening),
        contributions: round2(rest.contributions), earnings: round2(rest.earnings), derived: true,
      })
      warnings.push('One contribution type was cropped out of the screenshot, so its figures were worked out as the total minus the others. It is labelled “Employee” — change that if it is wrong.')
    }
  } else if (total && unmatched.length > 1) {
    warnings.push(`${unmatched.length} fund tables didn't match any summary row, so some contribution types may be missing — check the figures.`)
  }

  // Units from the matching fund table.
  for (const t of types) {
    const f = funds.find(x => close(x.marketValue, t.marketValue, 0.1))
    if (f) t.units = f.units
  }

  // No summaries at all: fund rows alone still give a value.
  if (!types.length && funds.length) {
    for (const f of funds) types.push({ label: '', units: f.units, marketValue: f.marketValue, opening: null, contributions: null, earnings: null, derived: false })
    warnings.push('No opening/contribution/earnings columns were found, so only market values were read.')
  }

  const fundName = (funds.find(f => f.name) || {}).name || ''
  const totalOut = total
    ? { opening: total.opening, contributions: total.contributions, earnings: total.earnings, marketValue: total.marketValue }
    : (types.length ? {
      opening: types.every(t => t.opening != null) ? round2(types.reduce((s, t) => s + t.opening, 0)) : null,
      contributions: types.every(t => t.contributions != null) ? round2(types.reduce((s, t) => s + t.contributions, 0)) : null,
      earnings: types.every(t => t.earnings != null) ? round2(types.reduce((s, t) => s + t.earnings, 0)) : null,
      marketValue: round2(types.reduce((s, t) => s + t.marketValue, 0)),
    } : null)

  return { ok: types.length > 0, fundName, types, total: totalOut, checks: pensionChecks({ types, total: totalOut }), warnings }
}

// Arithmetic checks, shown next to the figures so a misread number stands out.
export function pensionChecks({ types, total }) {
  const checks = []
  for (const t of types) {
    if (t.opening != null && t.contributions != null && t.earnings != null) {
      checks.push({
        ok: close(round2(t.opening + t.contributions + t.earnings), t.marketValue),
        text: `${t.label || 'Type'}: opening + contributions + earnings = market value`,
      })
    }
  }
  if (total && types.length) {
    checks.push({ ok: close(types.reduce((s, t) => s + t.marketValue, 0), total.marketValue), text: 'Types add up to the total market value' })
  }
  const prices = types.filter(t => t.units > 0).map(t => t.marketValue / t.units)
  if (prices.length > 1) {
    checks.push({ ok: Math.max(...prices) / Math.min(...prices) < 1.002, text: 'Same unit price across types (one fund)' })
  }
  return checks
}

const DAY = 86400000

// What a saved snapshot means for the planner.
// snapshot: { snapshotDate, periodStart, types: [...] }
export function pensionMetrics(snapshot, now = new Date()) {
  const types = snapshot.types || []
  const sum = key => (types.every(t => t[key] != null) ? round2(types.reduce((s, t) => s + t[key], 0)) : null)
  const totalValue = round2(types.reduce((s, t) => s + (Number(t.marketValue) || 0), 0))
  const contributions = sum('contributions')
  const earnings = sum('earnings')
  const opening = sum('opening')

  const start = snapshot.periodStart ? new Date(`${snapshot.periodStart}T12:00:00`) : null
  const end = new Date(`${snapshot.snapshotDate}T12:00:00`)
  const years = start && end > start ? (end - start) / (365.25 * DAY) : null

  // Contributions cover the period shown, so a year's worth is that scaled up.
  // Under three months is too little to scale, and the planner keeps its own.
  const annualContribution = contributions != null && years != null && years >= 0.25
    ? Math.round(contributions / years) : null

  // Return over the period, with contributions assumed to arrive evenly through it
  // (Modified Dietz): earnings / (opening + half of what was added).
  let periodReturn = null
  let annualizedReturn = null
  if (earnings != null && opening != null && contributions != null && opening + contributions / 2 > 0) {
    periodReturn = earnings / (opening + contributions / 2)
    if (years != null && years >= 0.25) annualizedReturn = Math.pow(1 + periodReturn, 1 / years) - 1
  }

  const employee = types.find(t => t.label === 'Employee')
  const company = types.find(t => t.label === 'Company')
  return {
    totalValue, contributions, earnings, opening, years, annualContribution, periodReturn, annualizedReturn,
    employeeContributions: employee?.contributions ?? null,
    companyContributions: company?.contributions ?? null,
    totalUnits: types.length && types.every(t => t.units > 0) ? Math.round(types.reduce((s, t) => s + t.units, 0) * 10000) / 10000 : null,
    unitPrice: types.length && types.every(t => t.units > 0)
      ? Math.round((totalValue / types.reduce((s, t) => s + t.units, 0)) * 10000) / 10000 : null,
    ageDays: Math.floor((now - end) / DAY),
  }
}
