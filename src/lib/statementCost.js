// Reads the cost basis (ACB) off a Manulife Wealth "Statement of Account" PDF.
//
// The Account Holdings section lists every position with a Cost column — the
// statement's "book cost": what was paid, including fees, adjusted for
// reinvested distributions, returns of capital and corporate actions. That is
// the ACB. The PDF is read on this device by pdf.js; nothing is uploaded.
//
//   Cash (CAD) - YN5-60LA-A                      ← account heading
//   Mutual Funds
//   CIG GLB EQ CC CL F -NL 1,831.0200 seg 56,945.77 33.358 61,079.35
//   └ name ┘                └ units ┘      └ cost ┘  └price┘ └ value ┘
//   BCE INC NEW 445 seg 14,502.55 ³ 28.970 12,891.65     ← ³ is a footnote mark
//
// A heading's holdings can run onto the next page without repeating it, so the
// current account is remembered across page breaks.

import { accountTypeFor } from './holdingsExport.js'
import { normalizeFundName } from './funds.js'

const MONTHS = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
}

const ACCOUNT_HEADING = /^(.+?)\s+\((CAD|USD)\)\s+-\s+([A-Z0-9][A-Z0-9-]+)$/
const PERIOD_ENDING = /For Period Ending\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i
// name, units, held-in, cost, optional footnote mark, price, market value
const HOLDING = /^(.+?)\s+([\d,]+(?:\.\d+)?)\s+([A-Za-z]{2,4})\s+([\d,]+\.\d{2})\s+(?:[¹²³⁴⁵]\s+)?([\d,]+\.\d+)\s+([\d,]+\.\d{2})$/

// "Income Summary": one block per account — a Total Dividends line (which also
// names the account), then a Total Interest line; current period, then year to date.
//   Cash (CAD) YN5-60LA-A Total Dividends 468.46 11,917.42
//   Total Interest 0.00 0.00
const INCOME_DIVIDENDS = /^(.+?)\s+\((CAD|USD)\)\s+([A-Z0-9][A-Z0-9-]+)\s+Total Dividends\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/
const INCOME_INTEREST = /^Total Interest\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/

const toNum = s => Number(String(s).replace(/,/g, ''))

// lines: an array of strings (a line's pieces already joined with spaces), in
// reading order across all pages.
export function parseStatementLines(lines) {
  const warnings = []
  let statementDate = null
  let current = null
  const accounts = []
  const income = []
  let inIncome = false
  let lastIncome = null

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue

    const period = line.match(PERIOD_ENDING)
    if (period && !statementDate) {
      const month = MONTHS[period[1].toUpperCase()]
      if (month) statementDate = `${period[3]}-${String(month).padStart(2, '0')}-${String(period[2]).padStart(2, '0')}`
    }

    // The Income Summary comes after the holdings; once in it, only income lines matter.
    if (/^Income Summary$/i.test(line)) { inIncome = true; continue }
    if (inIncome) {
      const d = line.match(INCOME_DIVIDENDS)
      if (d) {
        lastIncome = {
          accountNumber: d[3], accountLabel: d[1], accountType: accountTypeFor(d[1]), currency: d[2],
          dividendsPeriod: toNum(d[4]), dividendsYtd: toNum(d[5]), interestPeriod: 0, interestYtd: 0,
        }
        income.push(lastIncome)
        continue
      }
      const i = line.match(INCOME_INTEREST)
      if (i && lastIncome) { lastIncome.interestPeriod = toNum(i[1]); lastIncome.interestYtd = toNum(i[2]) }
      continue
    }

    const heading = line.match(ACCOUNT_HEADING)
    if (heading && !/^(Total|Account Total)/i.test(line)) {
      const [, label, currency, number] = heading
      current = { accountNumber: number, accountLabel: label, accountType: accountTypeFor(label), currency, positions: [] }
      accounts.push(current)
      continue
    }

    if (!current) continue
    const m = line.match(HOLDING)
    if (!m) continue
    const [, name, units, , cost] = m
    current.positions.push({ name: name.trim(), quantity: toNum(units), cost: toNum(cost) })
  }

  const usable = []
  for (const a of accounts) {
    if (!a.positions.length) continue
    if (a.currency !== 'CAD') {
      warnings.push(`Skipped the ${a.accountLabel} account (${a.currency}) — USD accounts aren't tracked here.`)
      continue
    }
    if (!a.accountType) {
      warnings.push(`Couldn't tell what kind of account "${a.accountLabel}" is, so its costs were skipped.`)
      continue
    }
    usable.push(a)
  }
  if (!statementDate) warnings.push("Couldn't find the statement's period-ending date.")
  if (!usable.length) warnings.push("No holdings with a Cost column found — is this a Manulife Statement of Account?")
  // Income is only used for CAD accounts of a recognized type, like the holdings.
  const usableIncome = income.filter(a => a.currency === 'CAD' && a.accountType)
  return { statementDate, accounts: usable, income: usableIncome, warnings }
}

// Cost lookup keyed by app account + normalized fund name. Two statement
// accounts mapping to one app account (or one fund listed twice) are summed,
// the same way the holdings export merges them.
export function buildCostIndex(parsed) {
  const index = new Map()
  for (const a of parsed.accounts) {
    for (const p of a.positions) {
      const key = `${a.accountType}|${normalizeFundName(p.name)}`
      const prev = index.get(key)
      if (prev) { prev.cost += p.cost; prev.quantity += p.quantity }
      else index.set(key, { cost: p.cost, quantity: p.quantity, date: parsed.statementDate, name: p.name })
    }
  }
  for (const v of index.values()) v.cost = Math.round(v.cost * 100) / 100
  return index
}

// Reads a PDF File into text lines, in reading order. pdf.js is loaded only
// when a statement is actually attached, so it doesn't weigh on every page load.
export async function readStatementPdf(file) {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const lines = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    // Items on one visual line share (nearly) a baseline; read each line left to right.
    const rows = []
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue
      const y = it.transform[5]
      let row = rows.find(r => Math.abs(r.y - y) <= 2)
      if (!row) { row = { y, items: [] }; rows.push(row) }
      row.items.push({ x: it.transform[4], s: it.str })
    }
    rows.sort((a, b) => b.y - a.y)
    for (const r of rows) lines.push(r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(' '))
  }
  return lines
}
