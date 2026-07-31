// Fund naming and the diff between what a broker reports and what is on file.
//
// Holdings arrive from the account site's export, where fund names are heavily
// abbreviated ("FDLTY INSIG CL SR F -NL"). Expanding them gives a nickname a
// human recognizes and a name a ticker search can match.

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
    .map((word, i, all) => {
      const bare = word.replace(/[^A-Z0-9&]/gi, '').toUpperCase()
      // "INC" ends a company name ("GOOD NATURED PRODS INC*") but means income
      // inside a fund's name ("DIV INC CL").
      if (bare === 'INC' && i === all.length - 1) return word.charAt(0) + word.slice(1).toLowerCase()
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
    // The account export states the ticker outright, which beats a remembered
    // mapping or a name match — it is the broker's own answer.
    const holding = (p.ticker && holdings.find(h => h.ticker === p.ticker)) ||
      (mapped && holdings.find(h => h.ticker === mapped.ticker)) || byNorm.get(norm) || null
    const ticker = p.ticker || holding?.ticker || mapped?.ticker || ''
    if (holding) matched.add(holding.id)

    const sameUnits = holding != null && Math.abs(Number(holding.shares) - p.quantity) < 1e-4
    rows.push({
      key: norm,
      statementName: p.name,
      // The load type ("-NL") is how the fund was bought, not part of its name.
      nickname: holding?.fund_name || mapped?.fund_name || searchableFundName(p.name),
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
