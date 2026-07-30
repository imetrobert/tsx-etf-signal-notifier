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

// Baselines within this many points are one row. The Fidelity-cleared format
// prints a long quantity a point above the rest of its row, so this has to be
// forgiving — but below the ~2.5pt that separates genuinely different rows.
const Y_TOL = 2
const SPACE_GAP = 1 // a horizontal gap this wide means a space was rendered

// Figures are read by position within the row rather than by fixed x
// coordinates, so a restyled statement with shifted columns still parses.
// A number's decimal point or thousands comma can arrive as its own fragment
// ("14," + "829" + "." + "88"), so a cell needs no digit of its own to belong to
// the run — only the assembled token has to parse as a number.
const NUMERIC_PART = /^[\d.,$()%-]+$/
const COL_GAP = 6 // cells further apart than this are separate columns, not one number

// A wrapped fund name sits directly under its row; anything further away is
// unrelated text (footnotes, the next section) and must not be appended.
const WRAP_MAX_GAP = 16
const WRAP_MAX_LEN = 60

// Two statement formats are in circulation: the older Manulife Securities one
// ("Investment Funds and Deposit Notes", one account per statement) and the
// Fidelity-cleared Manulife Wealth one ("Account Holdings", every account in a
// single statement). Both are recognized.
const HOLDINGS_START = /^(Investment Funds and Deposit Notes|Account Holdings)\b/i
const HOLDINGS_END = /^(Total Investment Funds|Total in Your Account|GRAND TOTAL|TOTAL ACCOUNTS)\b/i
// The holdings table's own column header, used to reopen the table where it
// continues onto another page. It must name a per-unit or book-cost column: the
// Activity table of transactions also has a "Quantity" column, and its rows
// (units, price, amount) would otherwise read as positions.
const COLUMN_HEADER = /Quantity/i
const HOLDINGS_COLUMN = /(Per Unit|Book Cost|Market Value)/i
// Sections that follow the table; reaching one means the table is over.
const SECTION_BREAK = /^(Activity|Account Activity|Summary of Income|Income Summary|Important Information|Your Account Performance|Portfolio Summary|Asset Allocation|Transaction)\b/i
// Asset-class banners inside the table. They carry no figures, so without this
// they would look like a fund name wrapping from the row above.
const ASSET_CLASS = /^(Cash and Cash Equivalents|Cash|Mutual Funds|Equity|Equities|Fixed Income|Bonds|Options|Other|Other Assets|Exchange Traded Funds|Guaranteed Investment Certificates|Segregated Funds|Held In|Quantity)\b/i
// Cash is reported as a position but isn't a holding this app can track.
const CASH_ROW = /^(CASH|CASH BALANCE|CAD CASH|USD CASH)$/i

// Account labels → the account types this app tracks. Locked-in plans are
// checked before RRSP because "Locked-in RRSP" contains both.
const ACCOUNT_TYPES = [
  [/\bTFSA\b/i, 'TFSA'],
  [/(\bLIRA\b|\bLRSP\b|\bLIF\b|\bLRIF\b|LOCKED-?IN)/i, 'LIRA'],
  [/\b(RRSP|RSP|RRIF|SPOUSAL)\b/i, 'RRSP'],
  [/\b(CASH|MARGIN|OPEN|NON-?REG|INVESTMENT ACCOUNT)\b/i, 'NON_REG'],
]

// Account numbers take two shapes: YN5-60LA-T on the Fidelity-cleared format,
// N359858R on the older one — the latter ending in a letter, so neither can be
// matched with a plain \d+ tail.
const ACCOUNT_NUMBER = '(?:[A-Z0-9]{2,5}-[A-Z0-9]{2,6}-[A-Z0-9]{1,3}|[A-Z]{1,2}\\d{4,9}[A-Z]?)'
// "RRSP Account (CAD) - YN5-60LA-T" — the section banner that introduces each
// account's holdings, and the only thing allowed to switch account mid-table.
const ACCOUNT_SECTION = new RegExp(`^(.{1,48}?)\\s*\\((CAD|USD)\\)\\s*[-–—]\\s*(${ACCOUNT_NUMBER})$`, 'i')
const LABELLED_ACCOUNT = new RegExp(
  `\\b(TFSA|RRSP|RSP|RRIF|LIRA|LRSP|LIF|LRIF|CASH|MARGIN|OPEN|SPOUSAL|NON-?REG)\\b\\W{0,3}(${ACCOUNT_NUMBER})\\b`, 'i')
const BARE_ACCOUNT = new RegExp(`\\b(${ACCOUNT_NUMBER})\\b`)
const HEADER_LINES = 14 // the account/date header sits at the top of every page

// "Held In" column values ("seg" for segregated) sit between the quantity and
// the money columns, and must not break the run of figures.
const HELD_IN = /^(seg|unseg|segregated|safe|sk|s|c|k)$/i

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']
// Tolerates missing spaces: tight kerning can leave "September30, 2023".
const DATE_RE = new RegExp(`^(${MONTHS.join('|')})\\s*(\\d{1,2}),\\s*(\\d{4})$`, 'i')
// "For Period Ending June 30, 2026" — states the period outright, so it beats a
// bare date that could belong to the previous statement's line.
const PERIOD_DATE = new RegExp(`Period Ending\\W{0,4}(${MONTHS.join('|')})\\s*(\\d{1,2}),\\s*(\\d{4})`, 'i')

function toIsoDate(monthName, day, year) {
  const month = MONTHS.findIndex(m => m.toLowerCase() === String(monthName).toLowerCase()) + 1
  if (!month) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// "RRSP Account (CAD) - YN5-60LA-T" → { label, currency, number }
function matchAccountSection(text) {
  const m = String(text).match(ACCOUNT_SECTION)
  return m ? { label: m[1].trim(), currency: m[2].toUpperCase(), number: m[3] } : null
}

// Statements print fund names heavily abbreviated ("FDLTY INSIG CL SR F"),
// which makes a poor nickname and an even worse search query. Expanding them
// gives a name a human — and a ticker search — can recognize. Fund-company
// prefixes are FundSERV codes: GOC is Canoe, CCM is iA Clarington.
const ABBREVIATIONS = {
  FDLTY: 'Fidelity', MMF: 'Manulife', MLF: 'Manulife', CIG: 'CI', RBF: 'RBC',
  TDB: 'TD', BNS: 'Scotia', DYN: 'Dynamic', GOC: 'Canoe', CCM: 'iA Clarington',
  GLB: 'Global', EQ: 'Equity', EQUITIES: 'Equity', INTL: 'International',
  CDN: 'Canadian', AMER: 'American', EMRG: 'Emerging', MKT: 'Market', MKTS: 'Markets',
  BAL: 'Balanced', DIV: 'Dividend', DIVDND: 'Dividend', INC: 'Income',
  GRT: 'Growth', GRWTH: 'Growth', MO: 'Monthly', HI: 'High', PREM: 'Premium',
  PREC: 'Precious', MTL: 'Metals', TACT: 'Tactical', TRGT: 'Target',
  DISP: 'Disciplined', ALLOC: 'Allocation', AA: 'Asset Allocation',
  PRT: 'Portfolio', PORT: 'Portfolio', PP: 'Private Pool', PVT: 'Private',
  CL: 'Class', CLS: 'Class', CC: 'Corporate Class', SR: 'Series', SRS: 'Series',
  ADV: 'Advisor', FD: 'Fund', UN: 'Units', SAV: 'Savings', ACT: 'Account',
  INV: 'Investment', MN: 'Market Neutral', WE: 'World Equity', INSIG: 'Insights',
}

// Words that stay upper-case when a SHOUTED fund name is turned into a nickname.
const ACRONYMS = new Set(['ETF', 'ETFS', 'CI', 'BMO', 'RBC', 'TD', 'BNS', 'CIBC', 'IA', 'AGF',
  'US', 'USA', 'UK', 'EU', 'EAFE', 'REIT', 'GIC', 'NASDAQ', 'S&P', 'TSX', 'MSCI', 'EQV',
  // Load types printed after the fund name: front-end, no-load, deferred.
  'FE', 'NL', 'DSC', 'LL', 'II', 'III', 'IV'])

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
function num(text) {
  const raw = String(text).replace(/[\s$,]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (!/^-?\d*\.?\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// Splits a line into its leading text and the run of figures that ends it.
//
// Reading the figures right-to-left is what makes this layout-independent: the
// table's numbers are always the last thing on the row, so a name that itself
// ends in a number ("TARGET CLICK 2030") can't be mistaken for one — the run
// stops at the first non-numeric cell, and only the rightmost columns count.
export function rowValues(line) {
  const cells = line.cells
  let i = cells.length
  const figures = []
  let token = null
  while (i > 0 && (NUMERIC_PART.test(cells[i - 1].str) || HELD_IN.test(cells[i - 1].str))) {
    i--
    const cell = cells[i]
    if (HELD_IN.test(cell.str)) {
      // A "Held In" marker separates columns without being one.
      if (token) figures.unshift(token)
      token = null
      continue
    }
    if (token && token.x - cell.end <= COL_GAP) {
      token = { x: cell.x, end: token.end, str: cell.str + token.str } // same number
    } else {
      if (token) figures.unshift(token)
      token = { x: cell.x, end: cell.end, str: cell.str }
    }
  }
  if (token) figures.unshift(token)
  const values = figures.map(f => num(f.str)).filter(v => v != null)
  return { text: joinCells(cells.slice(0, i)), values }
}

// Maps a row's figures onto the three columns that matter, without assuming how
// many columns the statement prints. The row always ends with the market value
// per unit and in total, and opens with the quantity — so the shape is
// (first, second-last, last) whether or not book cost sits between them.
//
// Every row carries its own proof: units × price is the market value. That
// settles the one real ambiguity — a fund name ending in a number ("TARGET
// CLICK 2030") looks like a leading figure — and means a column layout that
// isn't understood is rejected rather than silently misread.
function figuresToPosition(values) {
  const candidates = []
  const shape = vals => ({ quantity: vals[0], unitPrice: vals.at(-2), marketValue: vals.at(-1) })
  if (values.length >= 3) candidates.push(shape(values))
  // Retry dropping leading figures, in case they belong to the fund's name.
  for (let drop = 1; drop <= values.length - 3; drop++) candidates.push(shape(values.slice(drop)))

  for (const c of candidates) {
    // A worthless position prices at zero, so only the quantity must be real.
    if (!(c.quantity > 0) || !(c.unitPrice >= 0) || c.marketValue == null) continue
    const implied = c.quantity * c.unitPrice
    if (Math.abs(implied - c.marketValue) <= Math.max(0.01 * Math.abs(c.marketValue), 0.02)) return c
  }
  return null
}

// Fund names always carry real words; a stray "s" or "c" segregation marker
// beside a repeated part-quantity does not.
const hasWords = text => /[A-Za-z]{2,}/.test(text)

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
      if (ABBREVIATIONS[bare]) return word.replace(/[A-Za-z]+/, ABBREVIATIONS[bare])
      if (ACRONYMS.has(bare)) return word.toUpperCase()
      if (/^\d/.test(word)) return word // years, target dates
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
    // Expansion can double a word up: "MMF MLF" are both Manulife, and
    // "CC CL" expands to "Corporate Class Class".
    .replace(/\b(\w+)(\s+\1)+\b/gi, '$1')
}

// The name to search a ticker database with: expanded, and stripped of the
// load-type suffix ("-NL", "-FE") and series markers, which no database indexes.
export function searchableFundName(name) {
  return prettifyFundName(name)
    .replace(/\s*[-–]\s*(NL|FE|DSC|LL)\b/gi, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- statement parsing ----------

// pages: [{ lines }] as produced by linesFrom, in document order.
// Returns { statementDate, accounts: [{ accountNumber, accountLabel,
// accountType, positions: [{ name, quantity, unitPrice, marketValue }] }],
// warnings }.
export function parsePages(pages) {
  const warnings = []
  const accounts = new Map()
  let periodDate = null
  let bareDate = null
  let currentAccount = null

  // Registers an account the first time it is seen and returns its number.
  function openAccount({ label, number, currency }) {
    const clean = String(label || '').replace(/[^A-Za-z0-9 &-]/g, ' ').trim()
    const type = ACCOUNT_TYPES.find(([re]) => re.test(clean))?.[1] || null
    const existing = accounts.get(number)
    if (!existing) {
      accounts.set(number, {
        accountNumber: number,
        accountLabel: clean,
        accountType: type,
        currency: currency || 'CAD',
        positions: [],
      })
    } else if (type && !existing.accountType) {
      // A number spotted in a summary table carries no label; the section
      // banner that introduces the account's holdings does.
      existing.accountLabel = clean
      existing.accountType = type
      if (currency) existing.currency = currency
    }
    return number
  }
  // Recorded per page so a statement that doesn't parse can say why — a scanned
  // PDF has no text items at all, an unrecognized layout has text but no table.
  const diagnostics = { pageCount: pages.length, pages: [] }

  for (const page of pages) {
    const lines = page.lines
    // Account + date live in the page header; the first page spells the account
    // out beside the owner's name, later pages repeat it in the top right.
    let headerAccount = false
    for (const line of lines.slice(0, HEADER_LINES)) {
      const text = joinCells(line.cells)
      // The header sits above the table. Once the table starts, its own rows
      // are authoritative about which account they belong to — on the newer
      // format a page holds several accounts, and reading further here would
      // attribute a page's positions to whichever account is named last.
      if (HOLDINGS_START.test(text) || COLUMN_HEADER.test(text)) break

      const section = matchAccountSection(text)
      const labelled = text.match(LABELLED_ACCOUNT)
      // A bare number is the weakest signal — a summary table lists every
      // account — so it only counts when nothing is established yet.
      const bare = !section && !labelled && !currentAccount ? text.match(BARE_ACCOUNT) : null
      if (!headerAccount && (section || labelled || bare)) {
        currentAccount = openAccount(
          section ? section : labelled
            ? { label: labelled[1], number: labelled[2], currency: null }
            : { label: '', number: bare[1], currency: null })
        headerAccount = true
      }
      // The period covered is stated outright on the newer format's every page;
      // a bare date is only a fallback, and never one labelled "Previous".
      const period = text.match(PERIOD_DATE)
      if (period) periodDate = periodDate || toIsoDate(period[1], period[2], period[3])
      if (!bareDate && !/previous/i.test(text)) {
        const d = text.match(DATE_RE)
        if (d) bareDate = toIsoDate(d[1], d[2], d[3])
      }
    }

    const seen = {
      page: diagnostics.pages.length + 1,
      textItems: lines.reduce((n, l) => n + l.cells.length, 0),
      account: currentAccount != null,
      tableLabel: false,
      columnHeader: false,
      tableEnd: false,
      figureRows: 0,
      positions: 0,
    }
    diagnostics.pages.push(seen)

    let inHoldings = false
    let last = null // { position, y } — the row a wrapped name would belong to
    for (const line of lines) {
      const { text, values } = rowValues(line)

      if (HOLDINGS_END.test(text) || (SECTION_BREAK.test(text) && !values.length)) {
        seen.tableEnd = true
        inHoldings = false
        last = null
        continue
      }
      if (HOLDINGS_START.test(text)) {
        seen.tableLabel = true
        inHoldings = true
        last = null
        continue
      }
      if (COLUMN_HEADER.test(text) && HOLDINGS_COLUMN.test(text) && !values.length) {
        seen.columnHeader = true
        inHoldings = true
        last = null
        continue
      }
      if (!inHoldings) continue

      // "RRSP Account (CAD) - YN5-60LA-T": every account's holdings follow such
      // a banner on the newer format, so this is what switches account.
      const section = !values.length && matchAccountSection(text)
      if (section) {
        currentAccount = openAccount(section)
        seen.accountSection = true
        seen.account = true
        last = null
        continue
      }
      // Asset-class banners, "Total …" subtotals and the cash line are inside
      // the table but are not positions.
      if (ASSET_CLASS.test(text) || /^Total\b/i.test(text) || CASH_ROW.test(text)) {
        last = null
        continue
      }
      if (values.length) seen.figureRows++

      // A position: a named row ending in the table's figures.
      const figures = hasWords(text) ? figuresToPosition(values) : null
      if (figures && figures.quantity != null && figures.marketValue != null) {
        if (!currentAccount) {
          warnings.push('Found holdings before any account number — the statement header may be in an unexpected format.')
          continue
        }
        const position = { name: text, ...figures }
        accounts.get(currentAccount).positions.push(position)
        seen.positions++
        last = { position, y: line.y }
        continue
      }

      // A wrapped fund name: words only, directly beneath the row it extends.
      if (!values.length && hasWords(text) && last &&
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
    // Only worth mentioning for accounts that actually hold something: a
    // summary table names every account, including ones with no positions.
    if (!acct.accountType) {
      warnings.push(`Couldn't tell what kind of account ${[acct.accountLabel, acct.accountNumber].filter(Boolean).join(' ')} is — pick one below.`)
    }
  }
  diagnostics.textItems = diagnostics.pages.reduce((n, p) => n + p.textItems, 0)
  diagnostics.figureRows = diagnostics.pages.reduce((n, p) => n + p.figureRows, 0)
  diagnostics.sawTable = diagnostics.pages.some(p => p.tableLabel || p.columnHeader)
  diagnostics.sawAccount = diagnostics.pages.some(p => p.account)

  if (!list.length) {
    if (!diagnostics.textItems) {
      warnings.push('This PDF has no readable text — it looks like a scan or an image, so there is nothing to extract. Download the statement PDF from Manulife rather than a photo or printout of it.')
    } else if (!diagnostics.sawTable) {
      warnings.push("Read the PDF, but couldn't find the holdings table — the statement layout may have changed. The details below will pin down what's different.")
    } else {
      warnings.push("Found the holdings table but couldn't read any positions from it — the columns may have moved. The details below will pin down what's different.")
    }
  }
  const statementDate = periodDate || bareDate
  if (!statementDate) warnings.push('No statement date found on the PDF.')
  return { statementDate, accounts: list, warnings: [...new Set(warnings)], diagnostics }
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

// pdf.js's own getTextContent() consumes its text stream with `for await`,
// which needs async iteration over a ReadableStream — Safari doesn't implement
// that, and fails with "undefined is not a function". Reading the stream with a
// reader is equivalent and works everywhere.
export async function textItems(page) {
  if (typeof page.streamTextContent !== 'function') {
    return (await page.getTextContent()).items
  }
  const reader = page.streamTextContent().getReader()
  const items = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value?.items) items.push(...value.items)
  }
  return items
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
      pages.push({ lines: linesFrom(await textItems(page)) })
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
