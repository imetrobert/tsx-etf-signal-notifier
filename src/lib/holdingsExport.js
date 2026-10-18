// Parses a holdings export from either institution this app tracks. The kind
// is recognized from the header row, so the same paste box takes both.
//
// ---- Manulife Wealth ----
// This is the best of the three sources: unlike the statement PDF it carries
// the ticker for every position, and unlike the site's printed holdings page it
// breaks positions out by account. It is also current rather than month-end.
//
//   Security | Security Symbol | Market | Asset Class | Account Number |
//   Account Type | Account Name | Quantity | Price | Security Currency | …
//
// ---- Wealthsimple ----
//   Account Name | Account Type | Account Classification | Account Number |
//   Symbol | Exchange | MIC | Name | Security Type | Quantity |
//   Position Direction | Market Price | Market Price Currency | … |
//   Market Value | Market Value Currency | …
// One row per security per account. Cash (CURRENCY) and crypto rows are
// skipped, and positions can be priced in USD, so each carries its own
// currency.
//
// Both produce the same shape, so one review screen handles either.

import { normalizeFundName } from './funds.js'

// Account Type as the export words it → the account types this app tracks.
const ACCOUNT_TYPES = [
  [/TAX ?FREE|TFSA/i, 'TFSA'],
  [/LOCKED[ -]?IN|LIRA|LRSP|\bR?LIF\b/i, 'LIRA'],
  [/RRSP|RRIF|RSP/i, 'RRSP'],
  [/CASH|MARGIN|NON-?REG|INVESTMENT/i, 'NON_REG'],
]
export const accountTypeFor = text => ACCOUNT_TYPES.find(([re]) => re.test(text || ''))?.[1] || null

// Recognized but not tracked: contribution and withdrawal rules differ enough
// that the account-aware advice would be wrong for them.
const UNTRACKED = /RESP|RDSP|FHSA|CRYPTO|EDUCATION|DISABILITY/i

// Market → the suffix Yahoo indexes that exchange under.
const MARKET_SUFFIX = [
  [/^(TSX-?V|VENTURE|CVE)$/i, '.V'],
  [/^(NEO|CBOE|CBOE ?CANADA)$/i, '.NE'],
  [/^(TSX|TOR|TORONTO)$/i, '.TO'],
]

// US exchanges: Yahoo uses the bare symbol, with a dash for class shares.
const US_MARKET = /^(NYSE|NASDAQ|NYSE ?(ARCA|AMERICAN|MKT)|ARCA|AMEX|BATS|CBOE ?US)$/i

// Wealthsimple's exchange column can be blank while the MIC code is not.
const MIC_TO_MARKET = { XTSE: 'TSX', XTSX: 'TSXV', NEOE: 'NEO', XNAS: 'NASDAQ', XNYS: 'NYSE', ARCX: 'NYSE ARCA' }

// Rows that aren't holdings this app can track.
const CASH_ROW = /^(CASH|CASH BALANCE)$/i

// ---------- delimited text ----------

// Minimal TSV/CSV reader: quoted fields may contain the delimiter, and ""
// escapes a quote inside one.
export function parseDelimited(text) {
  let body = String(text).replace(/\r\n?/g, '\n').trim()
  if (!body) return []
  const firstLine = body.slice(0, body.indexOf('\n') + 1 || undefined)
  // Copying a table out of a browser can lose the tabs and leave columns
  // separated by runs of spaces; treat those as the delimiter instead.
  if (!firstLine.includes('\t') && !firstLine.includes(',')) {
    body = body.replace(/ {2,}/g, '\t')
  }
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
  if (!suffix) {
    if (US_MARKET.test(String(market || '').trim())) return raw.replace(/\./g, '-')
    return raw // OTC — a FundSERV code, priced via the Globe and Mail
  }
  if (/\.(TO|NE|V|CN)$/.test(raw)) return raw // already carries an exchange
  // Class shares print as DGR.B but Yahoo writes them DGR-B.TO.
  return `${raw.replace(/\./g, '-')}${suffix}`
}

// ---------- parsing ----------

// Column headings for each institution's export.
const MANULIFE_HEADERS = {
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
const WEALTHSIMPLE_HEADERS = {
  security: /^name$/i,
  symbol: /^symbol$/i,
  market: /^exchange$/i,
  mic: /^mic$/i,
  secType: /^security type$/i,
  direction: /^position direction$/i,
  accountNumber: /^account number$/i,
  accountType: /^account type$/i,
  accountName: /^account name$/i,
  quantity: /^quantity$/i,
  price: /^market price$/i,
  currency: /^market price currency$/i,
  totalValue: /^market value$/i,
  // Book value in the same currency the position is priced in, so a USD
  // stock's cost sits beside its USD value.
  bookValue: /^book value \(market\)$/i,
  // What the position cost in dollars: the figure that matters for tax, since
  // a US stock's gain in CAD includes the currency move.
  bookValueCad: /^book value \(cad\)$/i,
}

// Which institution wrote this export, from its header row.
export function detectInstitution(header) {
  const has = re => header.some(h => re.test(h))
  if (has(/^security$/i) && has(/^account type$/i) && has(/^quantity$/i)) return 'MANULIFE'
  if (has(/^symbol$/i) && has(/^security type$/i) && has(/^account type$/i) && has(/^quantity$/i)) return 'WEALTHSIMPLE'
  return null
}

const round2 = n => Math.round(n * 100) / 100

// text: the export, pasted or read from a file.
// Returns { source, institution, statementDate, accounts, warnings } — the
// statement parser's shape plus which institution it was, so the same review
// screen handles either.
export function parseHoldingsExport(text) {
  const rows = parseDelimited(text)
  const warnings = []
  const empty = extra => ({ source: 'export', institution: null, statementDate: null, accounts: [], warnings: extra })
  if (rows.length < 2) {
    return empty(['Nothing to read — paste the whole export, including its header row.'])
  }

  const header = rows[0].map(h => h.trim())
  const institution = detectInstitution(header)
  if (!institution) {
    return empty([
      "That doesn't look like a holdings export I recognize. Expected a Manulife export " +
      '(header row starting "Security, Security Symbol, Market…") or a Wealthsimple one ' +
      '(header row starting "Account Name, Account Type, Account Classification…").',
    ])
  }
  const isWs = institution === 'WEALTHSIMPLE'
  const col = {}
  for (const [key, re] of Object.entries(isWs ? WEALTHSIMPLE_HEADERS : MANULIFE_HEADERS)) {
    const i = header.findIndex(h => re.test(h))
    if (i >= 0) col[key] = i
  }

  const accounts = new Map()
  let skippedCash = 0
  let skippedCrypto = 0
  const skippedAccounts = new Set()
  const skippedShort = []
  const unreadable = []

  for (const row of rows.slice(1)) {
    const name = (row[col.security] ?? '').trim()
    if (!name) continue
    // A row with the wrong number of columns has its values under the wrong
    // headings. Reading it anyway could import a wrong unit count, and dropping
    // it quietly is worse still — the fund would look sold and be offered for
    // removal — so it is skipped loudly.
    if (row.length !== header.length) {
      unreadable.push(name)
      continue
    }
    const accountTypeText = (row[col.accountType] ?? '').trim()
    const quantity = num(row[col.quantity])
    if (quantity == null || quantity <= 0) continue
    if (isWs) {
      // Wealthsimple lists cash as a CURRENCY security and crypto alongside
      // the rest; neither is something this app tracks. Crypto first, since
      // CRYPTOCURRENCY contains the word CURRENCY.
      const secType = (row[col.secType] ?? '').trim()
      if (/CRYPTO/i.test(secType)) { skippedCrypto++; continue }
      if (/CURRENCY/i.test(secType)) { skippedCash++; continue }
      const direction = (row[col.direction] ?? '').trim()
      if (direction && !/^LONG$/i.test(direction)) { skippedShort.push(name); continue }
    } else if (CASH_ROW.test(name)) { skippedCash++; continue }
    if (UNTRACKED.test(accountTypeText)) { skippedAccounts.add(accountTypeText); continue }

    const accountType = accountTypeFor(accountTypeText)
    const number = (row[col.accountNumber] ?? '').trim() || accountTypeText
    if (!accounts.has(number)) {
      accounts.set(number, {
        accountNumber: number,
        accountLabel: accountTypeText,
        accountType,
        // Wealthsimple accounts mix currencies, so each position carries its
        // own; the account itself is the CAD one.
        currency: isWs ? 'CAD' : (row[col.currency] ?? 'CAD').trim() || 'CAD',
        positions: [],
      })
    }
    const account = accounts.get(number)
    const price = num(row[col.price])
    // The export states the value outright; only fall back to multiplying it
    // out, which lands a cent off through floating point.
    const stated = col.totalValue != null ? num(row[col.totalValue]) : null
    const market = (row[col.market] ?? '').trim() || MIC_TO_MARKET[(row[col.mic] ?? '').trim().toUpperCase()] || ''
    const position = {
      name,
      quantity,
      unitPrice: price,
      marketValue: stated != null
        ? (isWs ? round2(stated) : stated)
        : (price != null ? round2(quantity * price) : null),
      ticker: toYahooSymbol(row[col.symbol], market),
    }
    if (isWs) {
      // Already readable ("Global X Nasdaq-100 Index Corporate Class ETF"),
      // unlike Manulife's abbreviations, so it is used as the nickname as is.
      position.nickname = name
      position.currency = (row[col.currency] ?? '').trim() || 'CAD'
      const book = col.bookValue != null ? num(row[col.bookValue]) : null
      if (book != null) position.cost = round2(book)
      const bookCad = col.bookValueCad != null ? num(row[col.bookValueCad]) : null
      if (bookCad != null) position.costCad = round2(bookCad)
    }
    // One row per security per account, but a fund can appear twice if the
    // export splits a position; combine rather than showing it twice.
    const existing = account.positions.find(p => normalizeFundName(p.name) === normalizeFundName(name))
    if (existing) {
      existing.quantity += quantity
      if (existing.cost != null && position.cost != null) existing.cost = round2(existing.cost + position.cost)
      if (existing.costCad != null && position.costCad != null) existing.costCad = round2(existing.costCad + position.costCad)
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
  if (skippedCrypto) warnings.push(`Skipped ${skippedCrypto} crypto row(s) — this app doesn't track crypto.`)
  if (skippedShort.length) {
    warnings.push(`Skipped ${skippedShort.length} short position(s): ${skippedShort.join(', ')} — this app tracks long holdings only.`)
  }
  if (unreadable.length) {
    warnings.push(
      `Couldn't read ${unreadable.length} row(s) — their columns don't line up with the header: ` +
      `${unreadable.join(', ')}. They are missing from the changes below, so don't approve a removal ` +
      `for them. Copy the export again, or attach the downloaded file instead of pasting.`)
  }
  if (isWs && list.some(a => a.positions.some(p => p.currency && p.currency !== 'CAD'))) {
    warnings.push('Some positions are priced in USD (US-listed). They import under their plain ticker, and their values below are shown in USD.')
  }
  if (!list.length) warnings.push('No holdings found in that export.')

  return {
    source: 'export',
    institution,
    // An export is a snapshot of today, not of a statement period.
    statementDate: new Date().toISOString().slice(0, 10),
    accounts: list,
    warnings,
  }
}
