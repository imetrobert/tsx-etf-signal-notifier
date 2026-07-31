// Parses the holdings export from the Manulife Wealth account site.
//
// This is the best of the three sources: unlike the statement PDF it carries
// the ticker for every position, and unlike the site's printed holdings page it
// breaks positions out by account. It is also current rather than month-end.
//
//   Security | Security Symbol | Market | Asset Class | Account Number |
//   Account Type | Account Name | Quantity | Price | Security Currency | …
//
// Produces the same shape as the statement parser, so both feed one review.

import { normalizeFundName } from './statementParser.js'

// Account Type as the export words it → the account types this app tracks.
const ACCOUNT_TYPES = [
  [/TAX ?FREE|TFSA/i, 'TFSA'],
  [/LOCKED ?IN|LIRA|LRSP|\bLIF\b/i, 'LIRA'],
  [/RRSP|RRIF|RSP/i, 'RRSP'],
  [/CASH|MARGIN|NON-?REG|INVESTMENT/i, 'NON_REG'],
]
// Recognized but not tracked: contribution and withdrawal rules differ enough
// that the account-aware advice would be wrong for them.
const UNTRACKED = /RESP|RDSP|RESP\b|EDUCATION|DISABILITY/i

// Market → the suffix Yahoo indexes that exchange under.
const MARKET_SUFFIX = [
  [/^(TSXV|VENTURE|CVE)$/i, '.V'],
  [/^(NEO|CBOE|CBOE ?CANADA)$/i, '.NE'],
  [/^(TSX|TOR|TORONTO)$/i, '.TO'],
]

// Rows that aren't holdings this app can track.
const CASH_ROW = /^(CASH|CASH BALANCE)$/i

// ---------- delimited text ----------

// Minimal TSV/CSV reader: quoted fields may contain the delimiter, and ""
// escapes a quote inside one.
export function parseDelimited(text) {
  const body = String(text).replace(/\r\n?/g, '\n').trim()
  if (!body) return []
  const delimiter = body.slice(0, body.indexOf('\n') + 1 || undefined).includes('\t') ? '\t' : ','
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  row.push(field)
  if (row.length > 1 || row[0]) rows.push(row)
  return rows
}

function num(text) {
  const raw = String(text ?? '').replace(/[\s$,]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (!/^-?\d*\.?\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// ---------- symbols ----------

// Turns the broker's symbol into the one Yahoo indexes.
//
// FundSERV codes (the OTC funds) are left exactly as they are: they aren't
// Yahoo symbols at all, and the app prices them through the Globe and Mail
// fallback, which expects the bare code.
export function toYahooSymbol(symbol, market) {
  const raw = String(symbol || '').trim().toUpperCase()
  if (!raw) return ''
  const suffix = MARKET_SUFFIX.find(([re]) => re.test(String(market || '').trim()))?.[1]
  if (!suffix) return raw // OTC — a FundSERV code, priced via the Globe and Mail
  if (/\.(TO|NE|V|CN)$/.test(raw)) return raw // already carries an exchange
  // Class shares print as DGR.B but Yahoo writes them DGR-B.TO.
  return `${raw.replace(/\./g, '-')}${suffix}`
}

// ---------- parsing ----------

const HEADERS = {
  security: /^security$/i,
  symbol: /^security symbol$/i,
  market: /^market$/i,
  accountNumber: /^account number$/i,
  accountType: /^account type$/i,
  accountName: /^account name$/i,
  quantity: /^quantity$/i,
  price: /^price/i,
  currency: /^security currency$/i,
  totalValue: /^total value/i,
}

// text: the export, pasted or read from a file.
// Returns { source, statementDate, accounts, warnings } — the statement
// parser's shape, so the same review screen handles both.
export function parseHoldingsExport(text) {
  const rows = parseDelimited(text)
  const warnings = []
  if (rows.length < 2) {
    return { source: 'export', statementDate: null, accounts: [], warnings: ['Nothing to read — paste the whole export, including its header row.'] }
  }

  const header = rows[0].map(h => h.trim())
  const col = {}
  for (const [key, re] of Object.entries(HEADERS)) {
    const i = header.findIndex(h => re.test(h))
    if (i >= 0) col[key] = i
  }
  for (const required of ['security', 'accountType', 'quantity']) {
    if (col[required] == null) {
      return {
        source: 'export', statementDate: null, accounts: [],
        warnings: [`That doesn't look like a holdings export — no "${required}" column. Expected the header row starting "Security, Security Symbol, Market…".`],
      }
    }
  }

  const accounts = new Map()
  let skippedCash = 0
  const skippedAccounts = new Set()

  for (const row of rows.slice(1)) {
    const name = (row[col.security] ?? '').trim()
    if (!name) continue
    const accountTypeText = (row[col.accountType] ?? '').trim()
    const quantity = num(row[col.quantity])
    if (quantity == null || quantity <= 0) continue
    if (CASH_ROW.test(name)) { skippedCash++; continue }
    if (UNTRACKED.test(accountTypeText)) { skippedAccounts.add(accountTypeText); continue }

    const accountType = ACCOUNT_TYPES.find(([re]) => re.test(accountTypeText))?.[1] || null
    const number = (row[col.accountNumber] ?? '').trim() || accountTypeText
    if (!accounts.has(number)) {
      accounts.set(number, {
        accountNumber: number,
        accountLabel: accountTypeText,
        accountType,
        currency: (row[col.currency] ?? 'CAD').trim() || 'CAD',
        positions: [],
      })
    }
    const account = accounts.get(number)
    const price = num(row[col.price])
    // The export states the value outright; only fall back to multiplying it
    // out, which lands a cent off through floating point.
    const stated = col.totalValue != null ? num(row[col.totalValue]) : null
    const position = {
      name,
      quantity,
      unitPrice: price,
      marketValue: stated ?? (price != null ? Math.round(quantity * price * 100) / 100 : null),
      ticker: toYahooSymbol(row[col.symbol], row[col.market]),
    }
    // One row per fund per account, but a fund can appear twice if the export
    // splits a position; combine rather than showing it twice.
    const existing = account.positions.find(p => normalizeFundName(p.name) === normalizeFundName(name))
    if (existing) {
      existing.quantity += quantity
      if (existing.marketValue != null && position.marketValue != null) existing.marketValue += position.marketValue
    } else {
      account.positions.push(position)
    }
  }

  const list = [...accounts.values()].filter(a => a.positions.length)
  for (const account of list) {
    if (!account.accountType) {
      warnings.push(`Couldn't tell what kind of account "${account.accountLabel || account.accountNumber}" is — pick one below.`)
    }
  }
  if (skippedAccounts.size) {
    warnings.push(`Skipped ${[...skippedAccounts].join(', ')} — this app doesn't track those accounts.`)
  }
  if (skippedCash) warnings.push(`Skipped ${skippedCash} cash balance row(s) — cash isn't a tracked holding.`)
  if (!list.length) warnings.push('No holdings found in that export.')

  return {
    source: 'export',
    // An export is a snapshot of today, not of a statement period.
    statementDate: new Date().toISOString().slice(0, 10),
    accounts: list,
    warnings,
  }
}
