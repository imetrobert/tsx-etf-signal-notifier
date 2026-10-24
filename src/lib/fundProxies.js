// Stand-ins for funds that have no price history of their own.
//
// Most Canadian mutual funds (the Fidelity, CI, Dynamic, RBC, TD… series F units held through Manulife)
// publish a daily price but no free history, so their swings can't be measured directly. What mostly
// drives a fund's volatility is what it holds — Canadian shares, global shares, bonds, gold — and
// low-cost index ETFs that hold the same thing do have ten years of free history. So a fund with no
// history of its own is measured through an ETF with the same mandate.
//
// What that does and does not give you:
//   + the asset-class swings of the fund, including how it moves with the rest of your portfolio
//   - NOT the manager's own record: an active fund can hold more or less risk than its index.
// Every proxied holding is reported in the export, with the ETF used and why, so nothing is hidden.
//
// You can edit this file on GitHub. To change a mapping, add a line to PROXY_OVERRIDES:
//   by the fund's code or exactly-as-shown name →  'XEQT.TO'  (use that ETF)  or  null  (don't proxy it).
// An override always beats the rules below.

export const PROXY_OVERRIDES = {
  // 'FID5494': 'XEQT.TO',
  // 'FIDELITY INSIGHTS CLASS SERIES F NL': 'XUU.TO',
  // 'SOME FUND NAME': null,
}

// First match wins. Patterns are tried against the fund's name, upper-cased with punctuation removed,
// and are written to match both the statement's abbreviations and the expanded names the app shows.
const RULES = [
  { re: /\b(MARKET NEUTRAL|MN)\b/, proxy: null, why: 'market-neutral funds are built not to move like any index, so no ETF stands in for them' },
  { re: /\b(SAVINGS ACCOUNT|SAV ACT|HIGH INTEREST|MONEY MARKET)\b/, proxy: 'CASH.TO', why: 'a savings/cash fund: barely moves' },
  { re: /\b(PRECIOUS METALS?|PREC MTL|GOLD)\b/, proxy: 'XGD.TO', why: 'gold and precious-metals miners' },
  { re: /\b(TARGET|TRGT)\b.*\b(19|20)\d\d\b|\bTARGET DATE\b/, proxy: 'XBAL.TO', why: 'target-date funds near their date are mostly balanced' },
  { re: /\b(BALANCED|BAL|ASSET ALLOCATION|AA|MONTHLY INCOME|MO HI INC|GLOBAL INCOME|GLB INC)\b|\bMONTHLY (HIGH )?INC(OME)?\b/, proxy: 'XBAL.TO', why: 'balanced / asset-allocation / income portfolios: roughly 60% shares, 40% bonds' },
  { re: /\bDIV(IDEND)?\b.*\bINC(OME)?\b|\bDIVIDEND\b/, proxy: 'XDV.TO', why: 'Canadian dividend shares' },
  { re: /\b(EMERGING|EMRG)\b/, proxy: 'XEC.TO', why: 'emerging-market shares' },
  { re: /\b(INTERNATIONAL|INTL|EAFE)\b/, proxy: 'XEF.TO', why: 'developed-market shares outside North America' },
  { re: /\b(US|USA|AMERICAN|AMER|UNITED STATES)\b/, proxy: 'XUU.TO', why: 'US shares' },
  { re: /\b(CANADIAN|CDN|CANADA)\b/, proxy: 'XIC.TO', why: 'Canadian shares' },
  { re: /\b(GLOBAL EQUITY|GLB EQ|WORLD EQUITY|GLOBAL EQUITIES|INSIGHTS?|INSIG|TACTICAL GLOBAL|TACT GLB)\b/, proxy: 'XEQT.TO', why: 'global shares' },
]

const normalize = s => String(s || '').toUpperCase().replace(/[^A-Z0-9&]+/g, ' ').replace(/\s+/g, ' ').trim()

// { ticker, name } → { proxy, why, source } or null. proxy may itself be null when a rule or an override
// says "do not proxy this one" (reported, not silently ignored).
export function proxyFor({ ticker, name } = {}) {
  const t = normalize(ticker), n = normalize(name)
  for (const key of [t, n]) {
    if (key && Object.prototype.hasOwnProperty.call(PROXY_OVERRIDES, key)) {
      const v = PROXY_OVERRIDES[key]
      return { proxy: v, why: v ? 'set by you in fundProxies.js' : 'you chose not to proxy this one', source: 'override' }
    }
  }
  if (!n) return null
  for (const r of RULES) if (r.re.test(n)) return { proxy: r.proxy, why: r.why, source: 'rule' }
  return null
}

export const PROXY_ETFS = [...new Set(RULES.map(r => r.proxy).filter(Boolean))]
