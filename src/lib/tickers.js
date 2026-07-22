// Normalizes user-entered tickers to Yahoo Finance TSX symbols.
// "xeqt" -> "XEQT.TO"; symbols already carrying an exchange suffix pass through.
export function normalizeTicker(raw) {
  const t = raw.trim().toUpperCase().replace(/\s+/g, '')
  if (!t) return ''
  return t.includes('.') ? t : `${t}.TO`
}

export function displayTicker(symbol) {
  return symbol.replace(/\.TO$/, '')
}

export const fmtCad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
