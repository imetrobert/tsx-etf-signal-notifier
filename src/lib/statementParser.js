// Parses a Manulife Securities statement PDF into per-account positions.
//
// Everything here runs in the browser: the PDF is read with pdf.js from an
// ArrayBuffer and never leaves the device.
//
// Layout notes (Manulife Securities "Your Statement"):
//   * every page carries the account in the top right — "RRSP N359858R" —
//     with the statement date on the line below it;
//   * the Holdings table runs from an "Investment Funds and Deposit Notes"
//     label to a "Total Investment Funds and Deposit Notes" line, one row per
//     position: fund name on the left, then Quantity, Book Cost (per unit /
//     total), Market value (per unit / total);
//   * long fund names wrap onto continuation lines that carry no numbers;
//   * a position held partly unsegregated adds "s" / "c" sub-rows repeating
//     portions of its quantity. Those are ignored — the main row is the total.
//
// pdf.js hands back text in fragments ("INVES" + "CO", "8" + ".6641"), so
// lines are rebuilt by y-coordinate and fragments joined by horizontal gap.

const Y_TOL = 1.2 // items whose baselines are within this many points share a line
const SPACE_GAP = 1 // a horizontal gap this wide means a space was rendered

// Column boundaries in PDF points, taken from the table's header positions.
const X_QTY = 240
const X_BOOK_UNIT = 300
const X_BOOK_TOTAL = 375
const X_MKT_UNIT = 450
const X_MKT_TOTAL = 515

// A wrapped fund name sits directly under its row; anything further away is
// unrelated text (footnotes, the next section) and must not be appended.
const WRAP_MAX_GAP = 16
const WRAP_MAX_LEN = 60

const HOLDINGS_START = /^Investment Funds and Deposit Notes/i
const HOLDINGS_END = /^(Total Investment Funds|Cash and Cash Equivalents|Total in Your Account)/i
const COLUMN_HEADER = /^Quantity/i

// Manulife account labels → the account types this app tracks.
const ACCOUNT_TYPES = [
  [/\bTFSA\b/i, 'TFSA'],
  [/\b(LIRA|LRSP|LIF|LRIF)\b/i, 'LIRA'],
  [/\b(RRSP|RSP|RRIF|SPOUSAL)\b/i, 'RRSP'],
  [/\b(CASH|MARGIN|OPEN|NON-?REG|INVESTMENT ACCOUNT)\b/i, 'NON_REG'],
]

// Account numbers mix letters and digits and can end in a letter (N359858R),
// so they can't be matched with a plain \d+ tail.
const ACCOUNT_NUMBER = '[A-Z]{1,2}\\d{4,9}[A-Z]?'
const LABELLED_ACCOUNT = new RegExp(
  `\\b(TFSA|RRSP|RSP|RRIF|LIRA|LRSP|LIF|LRIF|CASH|MARGIN|OPEN|SPOUSAL|NON-?REG)\\b\\W{0,3}(${ACCOUNT_NUMBER})\\b`, 'i')
const BARE_ACCOUNT = new RegExp(`\\b(${ACCOUNT_NUMBER})\\b`)
const HEADER_LINES = 14 // the account/date header sits at the top of every page

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']
// Tolerates missing spaces: tight kerning can leave "September30, 2023".
const DATE_RE = new RegExp(`^(${MONTHS.join('|')})\\s*(\\d{1,2}),\\s*(\\d{4})$`, 'i')

// Words that stay upper-case when a SHOUTED fund name is turned into a nickname.
const ACRONYMS = new Set(['ETF', 'ETFS', 'CI', 'BMO', 'RBC', 'TD', 'BNS', 'CIBC', 'IA', 'AGF',
  'US', 'USA', 'UK', 'EU', 'EAFE', 'REIT', 'GIC', 'NASDAQ', 'S&P', 'TSX', 'MSCI', 'EQV',
  'FE', 'DSC', 'LL', 'II', 'III', 'IV'])

// ---------- line reconstruction ----------

// Groups pdf.js text items into lines, each a list of x-sorted cells.
export function linesFrom(items) {
  const lines = []
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    const x = it.transform[4]
    const y = it.transform[5]
    let line = lines.find(l => Math.abs(l.y - y) <= Y_TOL)
    if (!line) {
      line = { y, cells: [] }
      lines.push(line)
    }
    line.cells.push({ x, end: x + (it.width || 0), str: it.str })
  }
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x)
  lines.sort((a, b) => b.y - a.y) // top of the page first
  return lines
}

// Joins fragments back into text, inserting a space only where the PDF left a
// visible gap: "INVES" + "CO" is one word, "CI" + "ETHEREUM" is two.
export function joinCells(cells) {
  let out = ''
  let prevEnd = null
  for (const c of cells) {
    if (prevEnd != null && c.x - prevEnd > SPACE_GAP) out += ' '
    out += c.str
    prevEnd = c.end
  }
  return out.replace(/\s+/g, ' ').trim()
}

// Numbers arrive fragmented and comma-grouped ("58" + "," + "884.78"), so drop
// everything that isn't part of the number before parsing.
function num(cells) {
  if (!cells.length) return null
  const raw = cells.map(c => c.str).join('').replace(/[\s$,]/g, '')
  if (!/^-?\d*\.?\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function columns(line) {
  const pick = (lo, hi) => line.cells.filter(c => c.x >= lo && c.x < hi)
  return {
    name: joinCells(pick(-Infinity, X_QTY)),
    quantity: num(pick(X_QTY, X_BOOK_UNIT)),
    bookUnit: num(pick(X_BOOK_UNIT, X_BOOK_TOTAL)),
    bookTotal: num(pick(X_BOOK_TOTAL, X_MKT_UNIT)),
    unitPrice: num(pick(X_MKT_UNIT, X_MKT_TOTAL)),
    marketValue: num(pick(X_MKT_TOTAL, Infinity)),
  }
}

// ---------- fund names ----------

export function normalizeFundName(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// "MANULIFE GLOBAL BALANCED FUND -FE" → "Manulife Global Balanced Fund -FE",
// a usable nickname the user can edit rather than having to type from scratch.
export function prettifyFundName(name) {
  return String(name || '')
    // Kerning in the PDF loses the space in a few compound words.
    .replace(/\bETFFUND\b/gi, 'ETF Fund')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(word => {
      const bare = word.replace(/[^A-Z0-9&]/gi, '').toUpperCase()
      if (ACRONYMS.has(bare)) return word.toUpperCase()
      if (/^\d/.test(word)) return word // years, target dates
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

// ---------- statement parsing ----------

// pages: [{ lines }] as produced by linesFrom, in document order.
// Returns { statementDate, accounts: [{ accountNumber, accountLabel,
// accountType, positions: [{ name, quantity, unitPrice, marketValue }] }],
// warnings }.
export function parsePages(pages) {
  const warnings = []
  const accounts = new Map()
  let statementDate = null
  let currentAccount = null

  for (const page of pages) {
    const lines = page.lines
    // Account + date live in the page header; the first page spells the account
    // out beside the owner's name, later pages repeat it in the top right.
    for (const line of lines.slice(0, HEADER_LINES)) {
      const text = joinCells(line.cells)
      const labelled = text.match(LABELLED_ACCOUNT)
      const acct = labelled || text.match(BARE_ACCOUNT)
      if (acct) {
        const label = labelled ? labelled[1].toUpperCase() : ''
        const number = labelled ? labelled[2] : acct[1]
        const type = ACCOUNT_TYPES.find(([re]) => re.test(label))?.[1] || null
        currentAccount = number
        if (!accounts.has(currentAccount)) {
          accounts.set(currentAccount, {
            accountNumber: number,
            accountLabel: label,
            accountType: type,
            positions: [],
          })
          if (!type) warnings.push(`Couldn't tell what kind of account ${[label, number].filter(Boolean).join(' ')} is — pick one below.`)
        }
      }
      if (!statementDate) {
        const d = text.match(DATE_RE)
        if (d) {
          const month = MONTHS.findIndex(m => m.toLowerCase() === d[1].toLowerCase()) + 1
          statementDate = `${d[3]}-${String(month).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`
        }
      }
    }

    let inHoldings = false
    let last = null // { position, y } — the row a wrapped name would belong to
    for (const line of lines) {
      const col = columns(line)
      const text = col.name

      if (HOLDINGS_END.test(text)) {
        inHoldings = false
        last = null
        continue
      }
      if (HOLDINGS_START.test(text) || (COLUMN_HEADER.test(text) && col.quantity == null)) {
        inHoldings = true
        last = null
        continue
      }
      if (!inHoldings) continue

      // A position: a name alongside a quantity and a market value.
      if (text && col.quantity != null && col.marketValue != null) {
        const position = {
          name: text,
          quantity: col.quantity,
          unitPrice: col.unitPrice,
          marketValue: col.marketValue,
        }
        if (!currentAccount) {
          warnings.push('Found holdings before any account number — the statement header may be in an unexpected format.')
          continue
        }
        accounts.get(currentAccount).positions.push(position)
        last = { position, y: line.y }
        continue
      }

      // A wrapped fund name: text only, directly beneath the row it extends.
      if (text && col.quantity == null && col.marketValue == null && last &&
          last.y - line.y <= WRAP_MAX_GAP && text.length <= WRAP_MAX_LEN) {
        last.position.name += ` ${text}`
        continue
      }

      // Anything else — "s"/"c" segregation sub-rows, totals, stray text.
    }
  }

  const list = [...accounts.values()].filter(a => a.positions.length)
  for (const acct of list) {
    for (const p of acct.positions) p.name = p.name.replace(/\s+/g, ' ').trim()
  }
  if (!list.length) {
    warnings.push('No holdings table found — is this a Manulife Securities statement?')
  }
  if (!statementDate) warnings.push('No statement date found on the PDF.')
  return { statementDate, accounts: list, warnings: [...new Set(warnings)] }
}

// Loads pdf.js on demand (it is large) with its worker bundled locally, so no
// CDN is needed and the parse works offline.
// The legacy build is used deliberately: it costs a little size but parses on
// older mobile Safari, which is where a statement emailed to a phone gets
// opened.
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

// data: ArrayBuffer of the statement. `pdfjs` can be injected for tests.
export async function parseStatementPdf(data, { pdfjs } = {}) {
  const lib = pdfjs || (await loadPdfjs())
  const task = lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false })
  const pages = []
  try {
    const doc = await task.promise
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push({ lines: linesFrom(content.items) })
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return parsePages(pages)
}

// ---------- diffing against stored holdings ----------

// Compares one statement account against the app's Manulife holdings for the
// same account. `holdings` are rows from etf_holdings; `fundMap` maps a
// normalized statement name to { ticker, fund_name }.
//
// Returns one row per fund with an action: add (new or switched into), adjust
// (unit count changed), remove (switched out — on file but off the statement),
// or none.
export function diffPositions(positions, holdings, fundMap = {}) {
  const rows = []
  const matched = new Set()

  const byNorm = new Map()
  for (const h of holdings) {
    if (h.fund_name) byNorm.set(normalizeFundName(h.fund_name), h)
  }

  for (const p of positions) {
    const norm = normalizeFundName(p.name)
    const mapped = fundMap[norm] || null
    const holding = (mapped && holdings.find(h => h.ticker === mapped.ticker)) || byNorm.get(norm) || null
    const ticker = holding?.ticker || mapped?.ticker || ''
    if (holding) matched.add(holding.id)

    const sameUnits = holding != null && Math.abs(Number(holding.shares) - p.quantity) < 1e-4
    rows.push({
      key: norm,
      statementName: p.name,
      nickname: holding?.fund_name || mapped?.fund_name || prettifyFundName(p.name),
      ticker,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      marketValue: p.marketValue,
      holding,
      previousShares: holding ? Number(holding.shares) : null,
      action: !holding ? 'add' : sameUnits ? 'none' : 'adjust',
    })
  }

  // On file but absent from the statement — sold or switched out.
  for (const h of holdings) {
    if (matched.has(h.id)) continue
    rows.push({
      key: `remove:${h.id}`,
      statementName: h.fund_name || h.ticker,
      nickname: h.fund_name || '',
      ticker: h.ticker,
      quantity: 0,
      unitPrice: null,
      marketValue: null,
      holding: h,
      previousShares: Number(h.shares),
      action: 'remove',
    })
  }

  return rows
}
