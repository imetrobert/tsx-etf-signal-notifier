// Tests for the holdings import: reading the account site's export, turning
// broker symbols into the ones Yahoo indexes, expanding the abbreviated fund
// names, and diffing what the broker reports against what is on file.
//
// Nothing here is real account data.
//
// Run: npm test

import {
  diffPositions, normalizeFundName, prettifyFundName, searchableFundName,
  rollForwardCost, planCost,
} from '../src/lib/funds.js'
import { parseStatementLines, buildCostIndex } from '../src/lib/statementCost.js'
import { buildPlannerExport } from '../src/lib/plannerExport.js'
import { monthlyReturns, portfolioVolatility } from '../src/lib/portfolioVol.js'
import { yearsHeld, annualizedReturn, formatHeld, summarizeReturn } from '../src/lib/returns.js'
import { parseBellText, pensionMetrics, pensionChecks } from '../src/lib/bellPension.js'
import { parseHoldingsExport, toYahooSymbol, detectInstitution, accountTypeFor } from '../src/lib/holdingsExport.js'

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
    failures++
  }
}

console.log('\naccount holdings export')
{
  const tsv = [
    'Security\tSecurity Symbol\tMarket\tAsset Class\tAccount Number\tAccount Type\tAccount Name\tQuantity\tPrice (Security Currency)\tSecurity Currency\tAccount Currency\tTotal Value (Account Currency)',
    'FIDELITY ALL IN ONE BAL ETF\tFBAL\tTSX\tOTHER\tYN560LAQ\tTAX FREE SAVINGS ACCOUNT\tA PERSON\t3,752.00\t$15.45\tCAD\tCAD\t$57,968.40',
    'FIDELITY ALL IN ONE BAL ETF\tFBAL\tTSX\tOTHER\tYN560LAR\tLOCKED IN RRSP\tA PERSON\t3,540.00\t$15.45\tCAD\tCAD\t$54,693.00',
    'CI U.S. QUALITY DIVDND GRT ETF\tDGR.B\tTSX\tEQUITY\tYN560LAT\tRRSP\tA PERSON\t1,035.00\t$63.36\tCAD\tCAD\t$65,577.60',
    'FDLTY INSIG CL SR F -NL\tFID5494\tOTC\tEQUITY\tYN560LAT\tRRSP\tA PERSON\t1,113.74\t$43.11\tCAD\tCAD\t$48,018.46',
    'GOC AA PRT CLS SR F -NL\tGOC303\tOTC\tOTHER\tYN560LAA\tCASH\tA PERSON\t2,665.00\t$24.21\tCAD\tCAD\t$64,508.38',
    'MACKENZ SYM MOD GWTH PORT -FE\tMFC6150\tOTC\tOTHER\tYC53QCUZ\tFAMILY RESP\tTWO PEOPLE\t5,478.74\t$14.85\tCAD\tCAD\t$81,370.26',
    'GOOD NATURED PRODS INC*\t\tTSXV\tEQUITY\tYN560LAT\tRRSP\tA PERSON\t4.00\t$0.00\tCAD\tCAD\t$0.00',
    'CASH\t\t\tCASH AND CASH EQUIVALENTS\tYN560LAT\tRRSP\tA PERSON\t24.55\t$1.00\tCAD\tCAD\t$24.55',
    'CASH\t\t\tCASH AND CASH EQUIVALENTS\tYN560LAB\tCASH\tA PERSON\t0.00\t$1.00\tUSD\tUSD\t$0.00',
  ].join('\n')

  const r = parseHoldingsExport(tsv)
  const byNumber = n => r.accounts.find(a => a.accountNumber === n)

  check('accounts, in the order they appear', r.accounts.map(a => a.accountNumber),
    ['YN560LAQ', 'YN560LAR', 'YN560LAT', 'YN560LAA'])
  check('account types', r.accounts.map(a => a.accountType), ['TFSA', 'LIRA', 'RRSP', 'NON_REG'])
  check('a fund held twice stays split by account',
    [byNumber('YN560LAQ').positions[0].quantity, byNumber('YN560LAR').positions[0].quantity],
    [3752, 3540])
  check('prices and values parse through $ and commas',
    byNumber('YN560LAQ').positions[0], {
      name: 'FIDELITY ALL IN ONE BAL ETF', quantity: 3752, unitPrice: 15.45,
      marketValue: 57968.4, ticker: 'FBAL.TO',
    })
  check('cash rows are skipped', r.accounts.every(a => a.positions.every(p => p.name !== 'CASH')), true)
  check('RESP is skipped', r.accounts.some(a => a.accountNumber === 'YC53QCUZ'), false)
  check('and both skips are explained', r.warnings.length, 2)
  check('a position with no symbol still imports, without a ticker',
    byNumber('YN560LAT').positions.find(p => /GOOD NATURED/.test(p.name)).ticker, '')

  // Broker symbols are not Yahoo symbols.
  check('TSX gets .TO', toYahooSymbol('VVL', 'TSX'), 'VVL.TO')
  check('class shares use a dash', toYahooSymbol('DGR.B', 'TSX'), 'DGR-B.TO')
  check('TSX Venture gets .V', toYahooSymbol('GDNP', 'TSXV'), 'GDNP.V')
  check('TSX-V spelled with a dash gets .V', toYahooSymbol('XBOT', 'TSX-V'), 'XBOT.V')
  check('a US listing stays bare', toYahooSymbol('ROK', 'NYSE'), 'ROK')
  check('a US class share uses a dash', toYahooSymbol('BRK.B', 'NYSE'), 'BRK-B')
  check('Cboe Canada gets .NE', toYahooSymbol('FBAL', 'NEO'), 'FBAL.NE')
  check('a FundSERV code is left alone', toYahooSymbol('FID5494', 'OTC'), 'FID5494')
  check('an exchange already present is kept', toYahooSymbol('VVL.TO', 'TSX'), 'VVL.TO')
  check('no symbol stays empty', toYahooSymbol('', 'TSX'), '')

  // Commas instead of tabs, with quoted fields.
  const csv = [
    'Security,Security Symbol,Market,Account Number,Account Type,Quantity,Price (Security Currency),Security Currency',
    '"VANGUARD GLOBAL VALUE ETF UN",VVL,TSX,YN560LAT,RRSP,"878.00","$74.36",CAD',
  ].join('\n')
  check('comma-separated exports read too', parseHoldingsExport(csv).accounts[0].positions[0],
    { name: 'VANGUARD GLOBAL VALUE ETF UN', quantity: 878, unitPrice: 74.36, marketValue: 65288.08, ticker: 'VVL.TO' })

  // A row whose columns don't line up would import wrong values, and dropping
  // it quietly would make the fund look sold — so it is skipped loudly.
  const ragged = [
    'Security\tSecurity Symbol\tMarket\tAccount Number\tAccount Type\tQuantity\tPrice (Security Currency)\tSecurity Currency',
    'GOOD FUND\tABC\tTSX\tYN1\tRRSP\t10.00\t$5.00\tCAD',
    'RAGGED FUND\tDEF\tTSX\tYN1\tRRSP\t10.00',
  ].join('\n')
  const raggedResult = parseHoldingsExport(ragged)
  check('a short row is not imported', raggedResult.accounts[0].positions.map(p => p.name), ['GOOD FUND'])
  check('and is named in a warning',
    /RAGGED FUND/.test(raggedResult.warnings.find(w => /columns don't line up/.test(w)) || ''), true)

  check('a file that is not an export says so',
    /doesn't look like a holdings export/.test(parseHoldingsExport('a,b,c\n1,2,3').warnings[0]), true)
}

console.log('\nWealthsimple export')
{
  const H = 'Account Name\tAccount Type\tAccount Classification\tAccount Number\tSymbol\tExchange\tMIC\tName\tSecurity Type\tQuantity\tPosition Direction\tMarket Price\tMarket Price Currency\tBook Value (CAD)\tBook Value Currency (CAD)\tBook Value (Market)\tBook Value Currency (Market)\tMarket Value\tMarket Value Currency\tMarket Unrealized Returns\tMarket Unrealized Returns Currency'
  const line = (acct, type, num, sym, exch, mic, name, sec, qty, dir, price, cur, mv) =>
    [acct, type, 'Trade', num, sym, exch, mic, name, sec, qty, dir, price, cur, '100', 'CAD', '100', cur, mv, cur, '0', cur].join('\t')
  const tsv = [
    H,
    line('Crypto', 'Crypto', 'HQ1AAAA11CAD, X10BBBB12CAD', 'BTC', '', '', 'Bitcoin', 'CRYPTOCURRENCY', '0.01077936', 'LONG', '115153.66', 'CAD', '1242.848209127'),
    line('Crypto', 'Crypto', 'HQ1AAAA11CAD, X10BBBB12CAD', 'CAD', '', '', 'CAD', 'CURRENCY', '3.34', 'LONG', '1', 'CAD', '3.34'),
    line('Non-registered', 'Non-registered', 'HQ4CCCC00CAD', 'FTS.TO', 'TSX', 'XTSE', 'Fortis Inc.', 'EQUITY', '1.0673', 'LONG', '78.81', 'CAD', '84.113913'),
    line('Non-registered', 'Non-registered', 'HQ4CCCC00CAD', 'HXQ', 'TSX', 'XTSE', 'Global X Nasdaq-100 Index Corporate Class ETF', 'EXCHANGE_TRADED_FUND', '124.3021', 'LONG', '118.82', 'CAD', '14769.575522'),
    line('Non-registered', 'Non-registered', 'HQ4CCCC00CAD', 'TTWO', 'NASDAQ', 'XNAS', 'Take-Two Interactive Software Inc.', 'EQUITY', '1', 'LONG', '205.16', 'USD', '205.16'),
    line('Non-registered', 'Non-registered', 'WZ0DDDD804CAD', 'CAD', '', '', 'CAD', 'CURRENCY', '11.26', 'LONG', '1', 'CAD', '11.26'),
    line('RRSP', 'RRSP', 'HQ88EEEE43CAD', 'ROK', 'NYSE', 'XNYS', 'Rockwell Automation Inc.', 'EQUITY', '20.0126', 'LONG', '426.23', 'USD', '8529.970498'),
    line('RRSP', 'RRSP', 'HQ88EEEE43CAD', 'USD', '', '', 'USD', 'CURRENCY', '0.02', 'LONG', '1', 'USD', '0.02'),
    line('RRSP', 'RRSP', 'HQ88EEEE43CAD', 'XEQT', 'TSX', 'XTSE', 'iShares Core Equity ETF Portfolio', 'EXCHANGE_TRADED_FUND', '98.8137', 'LONG', '45.46', 'CAD', '4492.070802'),
    line('TFSA', 'TFSA', 'HD26FFFF3CAD', 'XBOT', 'TSX-V', 'XTSX', 'Realbotix Corp', 'EQUITY', '3396.6296', 'LONG', '0.245', 'CAD', '832.174252'),
    line('TFSA', 'TFSA', 'HD26FFFF3CAD', 'CAD', '', '', 'CAD', 'CURRENCY', '0.02', 'LONG', '1', 'CAD', '0.02'),
  ].join('\n')

  const r = parseHoldingsExport(tsv)
  const byNumber = n => r.accounts.find(a => a.accountNumber === n)
  const pos = (n, sym) => byNumber(n).positions.find(p => p.ticker === sym)

  check('recognized as Wealthsimple', r.institution, 'WEALTHSIMPLE')
  check('accounts in order; crypto and cash-only accounts are gone', r.accounts.map(a => a.accountNumber),
    ['HQ4CCCC00CAD', 'HQ88EEEE43CAD', 'HD26FFFF3CAD'])
  check('account types', r.accounts.map(a => a.accountType), ['NON_REG', 'RRSP', 'TFSA'])
  check('cash (CURRENCY) rows are skipped', r.accounts.every(a => a.positions.every(p => p.name !== 'CAD' && p.name !== 'USD')), true)
  check('TSX symbol with no suffix gets .TO', pos('HQ4CCCC00CAD', 'HXQ.TO')?.quantity, 124.3021)
  check('a symbol already carrying .TO is kept', !!pos('HQ4CCCC00CAD', 'FTS.TO'), true)
  check('TSX-V gets .V', !!pos('HD26FFFF3CAD', 'XBOT.V'), true)
  check('US listings stay bare', [!!pos('HQ4CCCC00CAD', 'TTWO'), !!pos('HQ88EEEE43CAD', 'ROK')], [true, true])
  check('fractional units are kept exactly', pos('HQ88EEEE43CAD', 'XEQT.TO').quantity, 98.8137)
  check('whole position shape (CAD)', pos('HQ88EEEE43CAD', 'XEQT.TO'), {
    name: 'iShares Core Equity ETF Portfolio', quantity: 98.8137, unitPrice: 45.46,
    marketValue: 4492.07, ticker: 'XEQT.TO', nickname: 'iShares Core Equity ETF Portfolio', currency: 'CAD', cost: 100, costCad: 100,
  })
  check('a USD position carries its own currency', pos('HQ88EEEE43CAD', 'ROK').currency, 'USD')
  check('the account itself stays CAD', byNumber('HQ88EEEE43CAD').currency, 'CAD')
  check('crypto skip is explained', r.warnings.some(w => /crypto/i.test(w)), true)
  check('cash skip is explained', r.warnings.some(w => /cash/i.test(w)), true)
  check('USD is flagged', r.warnings.some(w => /USD/.test(w)), true)

  // The MIC stands in when the exchange column is blank.
  const noExch = [H, line('TFSA', 'TFSA', 'HD1', 'XIC', '', 'XTSE', 'iShares Core S&P/TSX', 'EXCHANGE_TRADED_FUND', '10', 'LONG', '30', 'CAD', '300')].join('\n')
  check('MIC fills in for a blank exchange', parseHoldingsExport(noExch).accounts[0].positions[0].ticker, 'XIC.TO')

  // FHSA and RESP aren't tracked; a short position isn't a holding.
  const odd = [
    H,
    line('FHSA', 'FHSA', 'HF1', 'XEQT', 'TSX', 'XTSE', 'iShares Core Equity ETF Portfolio', 'EXCHANGE_TRADED_FUND', '10', 'LONG', '30', 'CAD', '300'),
    line('TFSA', 'TFSA', 'HD1', 'ZUT', 'TSX', 'XTSE', 'BMO Equal Weight Utils', 'EXCHANGE_TRADED_FUND', '5', 'SHORT', '28', 'CAD', '140'),
    line('TFSA', 'TFSA', 'HD1', 'VCN', 'TSX', 'XTSE', 'Vanguard FTSE Canada', 'EXCHANGE_TRADED_FUND', '7', 'LONG', '40', 'CAD', '280'),
  ].join('\n')
  const oddR = parseHoldingsExport(odd)
  check('FHSA is skipped', oddR.accounts.map(a => a.accountNumber), ['HD1'])
  check('a short position is skipped, not imported long', oddR.accounts[0].positions.map(p => p.ticker), ['VCN.TO'])
  check('and both are explained', oddR.warnings.length, 2)

  // A row that doesn't line up is skipped loudly here too.
  const ragged = [H, 'x\tRRSP\tTrade\tHQ1\tXIC\tTSX\tXTSE\tBroken ETF\tEXCHANGE_TRADED_FUND\t10'].join('\n')
  check('a short row is reported', /columns don't line up/.test(parseHoldingsExport(ragged).warnings.join(' ')), true)

  // Both formats still tell each other apart.
  check('Manulife header still Manulife',
    detectInstitution(['Security', 'Security Symbol', 'Market', 'Account Type', 'Quantity']), 'MANULIFE')
  check('unknown header is nothing', detectInstitution(['a', 'b']), null)

  // The nickname is used as is; Manulife's abbreviation expander would mangle "S&P/TSX".
  const diffRows = diffPositions([pos('HQ88EEEE43CAD', 'XEQT.TO')], [], {})
  check('Wealthsimple nickname is the name as given', diffRows[0].nickname, 'iShares Core Equity ETF Portfolio')
  check('the row carries the currency', diffRows[0].currency, 'CAD')
  check('an existing holding with that ticker is matched', diffPositions(
    [pos('HQ88EEEE43CAD', 'XEQT.TO')],
    [{ id: 'h1', ticker: 'XEQT.TO', shares: 98.8137, fund_name: null, account: 'RRSP' }], {},
  )[0].action, 'none')
}

console.log('\nManulife statement — cost basis')
{
  const lines = [
    'For Accounts Belonging to MR TEST PERSON For Period Ending September 30, 2026',
    'Cash (CAD) - AB1-00XX-A',
    'Cash and Cash Equivalents',
    'CASH 1,001.29 1,001.29 1,001.29',
    'Total Cash and Cash Equivalents (CAD) $ 1,001.29 $ 1,001.29',
    'Equity',
    'BCE INC NEW 445 seg 14,502.55 ³ 28.970 12,891.65',
    'Mutual Funds',
    'CIG GLB EQ CC CL F -NL 1,831.0200 seg 56,945.77 33.358 61,079.35',
    'Total Mutual Funds (CAD) $ 292,666.64 $ 323,269.24',
    'Account Total AB1-00XX-A (CAD) $ 308,170.48 $ 337,162.18',
    'Cash USD (USD) - AB1-00XX-B',
    'BNS INV SAV ACT SR A -NL $US 107.1137 seg 107.11 1.000 107.11',
    'RRSP Account (CAD) - AB1-00XX-T',
    'FDLTY INSIG CL SR F -NL 1,113.8294 seg 39,925.61 46.146 51,398.33',
    // The same account carries on after a page break, with no heading.
    'Account Holdings',
    'Quantity Held In Cost Current Price Accrued Interest Current Market Value',
    'GOOD NATURED PRODS INC* 4 seg 0.28 0.000 0.00',
    'TFSA (CAD) - AB1-00XX-Q',
    'FDLTY INSIG CL SR F -NL 978.9960 seg 25,773.10 46.146 45,176.36',
  ]
  const r = parseStatementLines(lines)
  check('statement date', r.statementDate, '2026-09-30')
  check('accounts read (USD skipped)', r.accounts.map(a => [a.accountNumber, a.accountType, a.positions.length]),
    [['AB1-00XX-A', 'NON_REG', 2], ['AB1-00XX-T', 'RRSP', 2], ['AB1-00XX-Q', 'TFSA', 1]])
  check('cash lines are not holdings', r.accounts[0].positions.map(p => p.name), ['BCE INC NEW', 'CIG GLB EQ CC CL F -NL'])
  check('footnote mark is skipped', r.accounts[0].positions[0], { name: 'BCE INC NEW', quantity: 445, cost: 14502.55 })
  check('fractional units and cost', r.accounts[0].positions[1], { name: 'CIG GLB EQ CC CL F -NL', quantity: 1831.02, cost: 56945.77 })
  check('a position after a page break stays in its account', r.accounts[1].positions[1].name, 'GOOD NATURED PRODS INC*')
  check('USD account is explained', r.warnings.some(w => /USD/.test(w)), true)

  const idx = buildCostIndex(r)
  check('same fund in two accounts stays separate', [
    idx.get('RRSP|' + normalizeFundName('FDLTY INSIG CL SR F -NL')).cost,
    idx.get('TFSA|' + normalizeFundName('FDLTY INSIG CL SR F -NL')).cost,
  ], [39925.61, 25773.10])
  check('index carries the statement date', idx.get('NON_REG|' + normalizeFundName('BCE INC NEW')).date, '2026-09-30')
  check('"Locked-in RRSP" is a locked-in account, not an RRSP', [
    accountTypeFor('Locked-in RRSP'), accountTypeFor('Locked-in RRSP (CAD)'), accountTypeFor('LIRA'), accountTypeFor('RRSP Account (CAD)'),
  ], ['LIRA', 'LIRA', 'LIRA', 'RRSP'])
  check('not a statement', parseStatementLines(['hello']).warnings.some(w => /Cost column/.test(w)), true)

  // Cost carried between unit counts.
  check('same units keep the cost', rollForwardCost({ cost: 1000, units: 10, toUnits: 10, price: 120 }), { cost: 1000, estimated: false })
  check('a partial sale removes cost in proportion', rollForwardCost({ cost: 1000, units: 10, toUnits: 6, price: 120 }), { cost: 600, estimated: false })
  check('added units are costed at the going price', rollForwardCost({ cost: 1000, units: 10, toUnits: 10.5, price: 120 }), { cost: 1060, estimated: true })
  check('added units with no price can’t be costed', rollForwardCost({ cost: 1000, units: 10, toUnits: 11, price: null }), null)

  const today = '2026-10-17'
  const stmt = row => idx.get('NON_REG|' + normalizeFundName(row.statementName)) || null
  const held = (shares, cost) => ({ id: 'h', shares, book_cost: cost, book_cost_date: '2026-08-31', cost_source: 'statement' })
  const base = { action: 'adjust', statementName: 'BCE INC NEW', quantity: 445, unitPrice: 30, cost: null }
  check('a new asset takes its cost from the statement',
    planCost({ ...base, action: 'add', holding: null }, { institution: 'MANULIFE', statement: stmt, today }),
    { cost: 14502.55, costCad: 14502.55, source: 'statement', date: '2026-09-30' })
  check('a new asset with no statement has no cost', planCost({ ...base, action: 'add', holding: null }, { institution: 'MANULIFE', today }), null)
  check('a sale since the statement trims the statement cost',
    planCost({ ...base, quantity: 222.5, holding: held(445, 14000) }, { institution: 'MANULIFE', statement: stmt, today }),
    { cost: 7251.28, costCad: 7251.28, source: 'statement', date: '2026-09-30' })
  check('a held cost shrinks in proportion on a sale',
    planCost({ ...base, statementName: 'X', quantity: 5, holding: held(10, 1000) }, { institution: 'MANULIFE', today }),
    { cost: 500, costCad: 500, source: 'statement', date: '2026-08-31' })
  check('a held cost grows as an estimate when units are added',
    planCost({ ...base, statementName: 'X', quantity: 10.5, unitPrice: 120, holding: held(10, 1000) }, { institution: 'MANULIFE', today }),
    { cost: 1060, costCad: 1060, source: 'estimated', date: '2026-08-31' })
  check('unchanged units and a held cost need no write',
    planCost({ ...base, statementName: 'X', quantity: 10, holding: held(10, 1000) }, { institution: 'MANULIFE', today }), null)
  check('Wealthsimple always takes the export’s book value',
    planCost({ ...base, cost: 8612.32, holding: null, action: 'add' }, { institution: 'WEALTHSIMPLE', today }),
    { cost: 8612.32, costCad: 8612.32, source: 'export', date: today })
  check('a removed row has no cost', planCost({ ...base, action: 'remove' }, { institution: 'MANULIFE', statement: stmt, today }), null)
}

console.log('\nretirement planner export')
{
  const now = new Date('2026-10-17T15:00:00Z')
  const row = (account, value, cost, extra = {}) => ({
    account, value, currency: 'CAD', priceDate: '2026-10-16', cost_cad: cost, book_cost: cost, cost_source: 'statement', ...extra,
  })
  const rows = [
    row('NON_REG', 10000, 6000),
    row('NON_REG', 5000, 5000),
    row('RRSP', 40000, 30000),
    row('LIRA', 20000, 15000),
    row('TFSA', 30000, 25000),
  ]
  const income = { periodEnd: '2025-12-31', dividendsYtd: 300, interestYtd: 0, institution: 'MANULIFE' } // a full year: no scaling caveat
  const volatility = { annualVol: 0.09, months: 60, windowStart: '2021-10', windowEnd: '2026-09', coverage: 1, worst12m: -0.07, updatedAt: '2026-10-16T05:00:00Z' }
  const e = buildPlannerExport(rows, { usdCad: 1.4, now, income, volatility })
  check('balances per account', [e.planner.currentRrsp, e.planner.currentTfsa, e.planner.liraBalance, e.planner.currentNonReg], [40000, 30000, 20000, 15000])
  check('non-registered gain % is (value − ACB) / value', e.planner.nonRegCapitalGainsPct, 26.67)
  check('gain in dollars', e.accounts.NON_REG.gain, 4000)
  check('no warnings when everything is known', e.warnings, [])
  check('shape', [e.format, e.version, e.currency], ['etf-tracker-portfolio', 1, 'CAD'])

  // USD: value converted at the rate, cost taken from the CAD book value.
  const usd = buildPlannerExport([row('NON_REG', 1000, 1300, { currency: 'USD', book_cost: 900 })], { usdCad: 1.4, now })
  check('a USD holding is converted at the rate', usd.planner.currentNonReg, 1400)
  check('its tax cost is the CAD figure, not the USD one', usd.accounts.NON_REG.acb, 1300)
  check('conversion is disclosed', usd.warnings.some(w => /1\.4/.test(w)), true)
  check('no rate means the USD holding is left out, loudly',
    buildPlannerExport([row('NON_REG', 1000, 1300, { currency: 'USD' })], { now }).warnings.some(w => /no USD/.test(w)), true)

  // Gaps are reported, not hidden.
  const gaps = buildPlannerExport([row('NON_REG', 10000, 6000), row('NON_REG', 10000, null, { book_cost: null, cost_cad: null }), { account: 'RRSP', value: null }], { now })
  check('a holding without cost is excluded from the % and disclosed', [gaps.planner.nonRegCapitalGainsPct, gaps.warnings.some(w => /1 of 2/.test(w))], [40, true])
  check('an unpriced holding is disclosed', gaps.warnings.some(w => /no price yet/.test(w)), true)
  check('an estimated cost is disclosed', buildPlannerExport([row('NON_REG', 10000, 6000, { cost_source: 'estimated' })], { now }).warnings.some(w => /estimated/.test(w)), true)

  check('a net loss gives 0% with a warning', (() => {
    const l = buildPlannerExport([row('NON_REG', 5000, 8000)], { now })
    return [l.planner.nonRegCapitalGainsPct, l.warnings.some(w => /net loss/.test(w))]
  })(), [0, true])
  check('no cost on file leaves the % out (planner keeps its own)', buildPlannerExport([row('NON_REG', 5000, null, { book_cost: null, cost_cad: null })], { now }).planner.nonRegCapitalGainsPct, null)
  check('stale prices are flagged', buildPlannerExport([row('TFSA', 100, 90, { priceDate: '2026-10-01' })], { now }).warnings.some(w => /days old/.test(w)), true)

  // ---- taxable income (the planner's "income the account throws off each year") ----
  const inc = (periodEnd, dividendsYtd, interestYtd = 0, institution = 'MANULIFE') => ({ periodEnd, dividendsYtd, interestYtd, institution })
  const nr100k = [row('NON_REG', 100000, 80000)]
  const yearEnd = buildPlannerExport(nr100k, { now, income: inc('2025-12-31', 4000, 500) })
  check('a full year of income is a straight percentage of the balance', yearEnd.planner.nonRegYieldPct, 4.5)
  const sept = buildPlannerExport(nr100k, { now, income: inc('2026-09-30', 3000, 0) })
  check('nine months of income is scaled up to a year', sept.planner.nonRegYieldPct, 4)
  check('and says so, since December distributions can differ', sept.warnings.some(w => /9 months/.test(w)), true)
  check('income detail is carried for display', sept.accounts.NON_REG.income, { periodEnd: '2026-09-30', months: 9, ytd: 3000, annualized: 4000, yieldPct: 4 })
  check('more than the planner allows is capped at 10%', [
    buildPlannerExport(nr100k, { now, income: inc('2025-12-31', 15000) }).planner.nonRegYieldPct,
    buildPlannerExport(nr100k, { now, income: inc('2025-12-31', 15000) }).warnings.some(w => /10% limit/.test(w)),
  ], [10, true])
  check('no statement income leaves the field out so the planner keeps its own', buildPlannerExport(nr100k, { now }).planner.nonRegYieldPct, null)
  const mixedInst = buildPlannerExport([row('NON_REG', 90000, 70000, { institution: 'MANULIFE' }), row('NON_REG', 10000, 8000, { institution: 'WEALTHSIMPLE' })], { now, income: inc('2025-12-31', 4500) })
  check('income is spread over the whole account, not just the statement institution', mixedInst.planner.nonRegYieldPct, 4.5)
  check('and the other institution is disclosed as counting for $0', mixedInst.warnings.some(w => /10% of the account/.test(w)), true)
  check('an old statement is flagged', buildPlannerExport(nr100k, { now, income: inc('2024-06-30', 2000) }).warnings.some(w => /months old/.test(w)), true)

  // ---- Monte Carlo volatility ----
  const vol = (annualVol, extra = {}) => ({ annualVol, months: 60, windowStart: '2021-10', windowEnd: '2026-09', coverage: 0.9, worst12m: -0.08, updatedAt: '2026-10-16T05:00:00Z', ...extra })
  check('measured volatility becomes the Monte Carlo figure (as a percent, one decimal)', buildPlannerExport(nr100k, { now, volatility: vol(0.0874) }).planner.mcVolatility, 8.7)
  check('its basis is carried for display', buildPlannerExport(nr100k, { now, volatility: vol(0.0874) }).volatility, { annualVolPct: 8.7, months: 60, window: '2021-10 to 2026-09', coveragePct: 90, worst12mPct: -8 })
  check('no measurement leaves the field out so the planner keeps its own', buildPlannerExport(nr100k, { now }).planner.mcVolatility, null)
  check('and says why', buildPlannerExport(nr100k, { now }).warnings.some(w => /No portfolio volatility measured/.test(w)), true)
  check('thin coverage is disclosed', buildPlannerExport(nr100k, { now, volatility: vol(0.09, { coverage: 0.45 }) }).warnings.some(w => /45%/.test(w)), true)
  check('a short history is disclosed', buildPlannerExport(nr100k, { now, volatility: vol(0.09, { months: 28 }) }).warnings.some(w => /28 months/.test(w)), true)
  check('a stale measurement is disclosed', buildPlannerExport(nr100k, { now, volatility: vol(0.09, { updatedAt: '2026-09-01T00:00:00Z' }) }).warnings.some(w => /nightly job may not be running/.test(w)), true)
  // ---- the package the planner stores to lock its volatility to the portfolio's own history ----
  const hist = { annualVolLong: 0.101, monthsLong: 120, windowLongStart: '2016-10', rolling12Vol: 0.082, rolling12Count: 49, calendarYears: [{ year: 2022, return: -0.081 }, { year: 2023, return: 0.092 }, { year: 2024, return: 0.121 }, { year: 2025, return: 0.075 }, { year: 2021, return: 0.139 }], calendarYearVol: 0.085, meanAnnual: 0.0652, geoAnnual: 0.0622 }
  const ps = buildPlannerExport(nr100k, { now, volatility: vol(0.0874, { history: hist }) }).portfolioStats
  check('the stats package carries both volatility figures', [ps.volPct, ps.volLongPct, ps.calendarYearVolPct, ps.rolling12VolPct], [8.7, 10.1, 8.5, 8.2])
  check('and the year-by-year returns, in percent', ps.calendarYears.find(y => y.year === 2022), { year: 2022, returnPct: -8.1 })
  check('and the basis (window, coverage, when measured)', [ps.window, ps.coveragePct, ps.months, ps.asOf], ['2021-10 to 2026-09', 90, 60, '2026-10-16T05:00:00Z'])
  check('no history means no stats package, and the planner keeps its own', buildPlannerExport(nr100k, { now, volatility: vol(0.0874) }).portfolioStats, null)
  check('a long history that is much choppier year to year is flagged', buildPlannerExport(nr100k, { now, volatility: vol(0.0874, { history: { ...hist, calendarYearVol: 0.19 } }) }).warnings.some(w => /Year-to-year swings/.test(w)), true)
  check('a calm year-by-year record is not flagged', buildPlannerExport(nr100k, { now, volatility: vol(0.0874, { history: hist }) }).warnings.some(w => /Year-to-year swings/.test(w)), false)
  check('a too-short calendar record is not flagged either', buildPlannerExport(nr100k, { now, volatility: vol(0.0874, { history: { ...hist, calendarYears: hist.calendarYears.slice(0, 3), calendarYearVol: 0.3 } }) }).warnings.some(w => /Year-to-year swings/.test(w)), false)
  check('an absurd figure is capped at 40%', buildPlannerExport(nr100k, { now, volatility: vol(0.9) }).planner.mcVolatility, 40)
  check('CAD holding falls back to book_cost when no CAD cost column', buildPlannerExport([row('NON_REG', 100, null, { book_cost: 60 })], { now }).accounts.NON_REG.acb, 60)
}

console.log('\nportfolio volatility')
{
  const now = new Date('2026-10-17T00:00:00Z')
  // Deterministic pseudo-random monthly returns with a known spread.
  let seed = 12345
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const normal = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
  const build = (monthly, months = 60, start = 100) => {
    const out = []; let px = start
    for (let i = months; i >= 1; i--) {
      const d = new Date(Date.UTC(2026, 9 - i, 15)); px *= 1 + monthly[months - i]
      out.push({ date: d, close: px })
    }
    return out
  }
  const gen = (annualVol, n = 60, drift = 0.005) => Array.from({ length: n }, () => drift + normal() * annualVol / Math.sqrt(12))

  // 1) monthly returns come out right and drop the unfinished month
  const s1 = [
    { date: new Date('2026-07-10T00:00:00Z'), close: 100 }, { date: new Date('2026-07-30T00:00:00Z'), close: 110 },
    { date: new Date('2026-08-31T00:00:00Z'), close: 99 }, { date: new Date('2026-09-30T00:00:00Z'), close: 108.9 },
    { date: new Date('2026-10-10T00:00:00Z'), close: 50 },
  ]
  const mr = monthlyReturns(s1, now)
  check('month-end returns', [...mr.entries()].map(([k, v]) => [k, Math.round(v * 1000) / 1000]), [['2026-08', -0.1], ['2026-09', 0.1]])
  check('the current unfinished month is left out', mr.has('2026-10'), false)
  check('adjusted close beats raw close (a payout is not a drop)', [...monthlyReturns([
    { date: new Date('2026-08-31T00:00:00Z'), close: 100, adj: 100 }, { date: new Date('2026-09-30T00:00:00Z'), close: 95, adj: 100 },
  ], now).values()], [0])

  // 2) a single holding: the estimate is near the true spread
  const long = build(gen(0.12, 121), 121)
  const tenYears = portfolioVolatility([{ ticker: 'A', value: 1000, series: long }], { now, windowMonths: 120 })
  check('with 10 years of data the estimate lands near the 12% that generated it', tenYears.annualVol > 0.10 && tenYears.annualVol < 0.14, true)
  const one = portfolioVolatility([{ ticker: 'A', value: 1000, series: long }], { now })
  check('the default window keeps the latest 60 months', one.months, 60)
  check('fully covered', one.coverage, 1)

  // 3) diversification: two independent 12% funds, half each → ~8.5%, not 12%
  const two = portfolioVolatility([
    { ticker: 'A', value: 500, series: build(gen(0.12)) }, { ticker: 'B', value: 500, series: build(gen(0.12)) },
  ], { now })
  check('blending keeps the diversification benefit (two independent funds beat one)', two.annualVol < one.annualVol * 0.9, true)

  // 4) weights matter
  const lowHeavy = portfolioVolatility([
    { ticker: 'LOW', value: 900, series: build(gen(0.05)) }, { ticker: 'HIGH', value: 100, series: build(gen(0.20)) },
  ], { now })
  const highHeavy = portfolioVolatility([
    { ticker: 'LOW', value: 100, series: build(gen(0.05)) }, { ticker: 'HIGH', value: 900, series: build(gen(0.20)) },
  ], { now })
  check('more weight in the volatile fund means more portfolio volatility', highHeavy.annualVol > lowHeavy.annualVol * 1.8, true)

  // 5) coverage: a holding with no history is reported, not guessed
  const partial = portfolioVolatility([
    { ticker: 'A', value: 600, series: build(gen(0.10)) }, { ticker: 'NOHIST', value: 400, series: null },
  ], { now })
  check('uncovered share is reported', [Math.round(partial.coverage * 100), partial.uncovered], [60, ['NOHIST']])
  check('too little history is not measured', portfolioVolatility([{ ticker: 'Y', value: 1, series: build(gen(0.1, 12), 12) }], { now }), null)
  check('nothing held means nothing to measure', portfolioVolatility([], { now }), null)

  // 6) a young fund does not distort the blend (its months only count when enough value is present)
  const young = portfolioVolatility([
    { ticker: 'OLD', value: 900, series: build(gen(0.08)) }, { ticker: 'NEW', value: 100, series: build(gen(0.30, 30), 30) },
  ], { now })
  check('a young fund still lets the old history be used', young.months >= 50, true)
  check('per-holding detail is returned', young.perHolding.map(h => h.ticker), ['OLD', 'NEW'])
  // ---- the year-by-year second opinion ----
  const h10 = portfolioVolatility([{ ticker: 'A', value: 1000, series: long }], { now })
  check('a long history gives a longer-window figure too', h10.history.monthsLong >= 119 && h10.history.annualVolLong > 0.09 && h10.history.annualVolLong < 0.15, true)
  check('only complete calendar years are listed', h10.history.calendarYears.every(y => Number.isInteger(y.year)) && h10.history.calendarYears.length >= 8 && h10.history.calendarYears.length <= 10, true)
  check('calendar years run oldest to newest, with no partial year', h10.history.calendarYears.map(y => y.year).every((y, i, a) => i === 0 || y === a[i - 1] + 1) && !h10.history.calendarYears.some(y => y.year === 2026), true)
  check('rolling 12-month windows: one per month after the first eleven (60 months → 49)', h10.history.rolling12Count, 49)
  check('year-by-year spread is of the same order for independent months', h10.history.calendarYearVol > 0.05 && h10.history.calendarYearVol < 0.25, true)
  check('too little history gives no long-window or calendar-year figure', (() => { const s = portfolioVolatility([{ ticker: 'Y', value: 1, series: build(gen(0.1, 40), 40) }], { now }); return [s.history.annualVolLong, s.history.calendarYearVol] })(), [null, null])

  // Trending markets: a run of good years then bad ones. Month-to-month wiggle is small, but years swing a lot —
  // exactly where scaling monthly volatility up understates the real year-to-year risk.
  const trendSeries = (() => {
    const out = []; let px = 100
    for (let k = 0; k <= 120; k++) {
      const d = new Date(Date.UTC(2016, 8 + k, 15))
      if (k > 0) px *= 1 + (d.getUTCFullYear() % 2 === 0 ? 0.02 : -0.018)   // good calendar years, then bad ones
      out.push({ date: d, close: px })
    }
    return out
  })()
  const tr = portfolioVolatility([{ ticker: 'T', value: 1, series: trendSeries }], { now })
  check('trending history: the year-by-year spread is far larger than the monthly figure scaled up', tr.history.calendarYearVol > tr.annualVol * 2, true)
  check('and the average calendar-year return is carried', typeof tr.history.meanAnnual === 'number' && typeof tr.history.geoAnnual === 'number' && tr.history.geoAnnual <= tr.history.meanAnnual, true)
  check('a worst-12-month figure is provided', typeof one.worst12m === 'number' && one.worst12m < 0.2, true)
}

console.log('\nyears held and annualized return')
{
  const now = new Date('2026-10-17T12:00:00')
  const r1 = n => Math.round(n * 1000) / 1000
  const r2 = n => Math.round(n * 100) / 100
  check('years held, to the day', r2(yearsHeld('2024-10-17', now)), 2)
  check('no date means no years', yearsHeld(null, now), null)
  check('a date in the future is ignored', yearsHeld('2027-01-01', now), null)
  check('an unreadable date is ignored', yearsHeld('not-a-date', now), null)
  check('10% a year over 2 years', r1(annualizedReturn(1210, 1000, 2)), 0.1)
  check('10% a year over 3 years', r1(annualizedReturn(1331, 1000, 3)), 0.1)
  check('a loss annualizes negative', annualizedReturn(800, 1000, 2) < 0, true)
  check('under three months is too jumpy to annualize', annualizedReturn(1100, 1000, 0.1), null)
  check('no cost, no rate', annualizedReturn(1100, 0, 2), null)
  check('years and months', [formatHeld(3 + 2 / 12), formatHeld(1), formatHeld(2 + 11 / 12), formatHeld(8 / 12)], ['3 yrs 2 mo', '1 yr', '2 yrs 11 mo', '8 mo'])
  check('plural, singular and rounding up to a whole year', [formatHeld(5), formatHeld(1 + 3 / 12), formatHeld(11.6 / 12), formatHeld(0.02), formatHeld(null)], ['5 yrs', '1 yr 3 mo', '1 yr', '1 mo', ''])

  // Group figure: average holding period weighted by cost, then the dated rows' total return stretched over it.
  const s = summarizeReturn([
    { value: 1210, cost: 1000, held_since: '2024-10-17' },   // 2 yrs, small
    { value: 4000, cost: 3000, held_since: '2020-10-17' },   // ~6 yrs, big
    { value: 500, cost: 400, held_since: null },             // undated: left out
  ], now)
  check('undated holdings are left out and counted', s.dated, 2)
  check('average period is weighted by cost', r2(s.years), 5)   // (1000×2 + 3000×6) / 4000
  check('annualized is the dated total return over that period', r1(s.annualized), r1(Math.pow(5210 / 4000, 1 / 5) - 1))
  check('nothing dated means no summary', summarizeReturn([{ value: 1, cost: 1, held_since: null }], now), { dated: 0, years: null, annualized: null })
}

console.log('\nBell DC pension')
{
  const now = new Date('2026-10-18T12:00:00')
  // Same layout as the real screenshot's OCR (first type's summary row cropped off), made-up figures.
  const cropped = `Bell Benefits =

Number of

Fund name Asset mix units Market value

Test Balanced Fund (50-54) 100.00% 3,846.1538 $100,000.00

mpany $300,000.00 $6,000.00 $29,000.00 $335,000.00
Number of

Fund name Asset mix units Market value

Test Balanced Fund (50-54) 100.00% 12,884.6154 $335,000.00

Hid tribution t

tee coniriparon tyPe $390,000.00 $8,000.00 $37,000.00 $435,000.00
breakdown
`
  const r = parseBellText(cropped)
  check('read ok', r.ok, true)
  check('fund name', r.fundName, 'Test Balanced Fund (50-54)')
  check('two types, the cropped one first', r.types.map(t => t.label), ['Employee', 'Company'])
  check('the cropped type is worked out as total minus the others', r.types[0], {
    label: 'Employee', units: 3846.1538, marketValue: 100000, opening: 90000, contributions: 2000, earnings: 8000, derived: true,
  })
  check('the visible type is read as shown', r.types[1], {
    label: 'Company', units: 12884.6154, marketValue: 335000, opening: 300000, contributions: 6000, earnings: 29000, derived: false,
  })
  check('the total is read as shown', r.total, { opening: 390000, contributions: 8000, earnings: 37000, marketValue: 435000 })
  check('every arithmetic check passes', r.checks.every(c => c.ok), true)
  check('the cropping is disclosed', r.warnings.some(w => /cropped/.test(w)), true)

  // The whole table copied as text (cells on separate lines or tab-separated), both rows labelled.
  const full = `Fund name\tAsset mix\tNumber of units\tMarket value
Employee
$90,000.00
$2,000.00
$8,000.00
$100,000.00
Test Balanced Fund (50-54)\t100.00%\t3,846.1538\t$100,000.00
Company\t$300,000.00\t$6,000.00\t$29,000.00\t$335,000.00
Test Balanced Fund (50-54)\t100.00%\t12,884.6154\t$335,000.00
Total\t$390,000.00\t$8,000.00\t$37,000.00\t$435,000.00`
  const f = parseBellText(full)
  check('a complete pasted table reads the same', f.types.map(t => [t.label, t.marketValue, t.units, t.derived]), [['Employee', 100000, 3846.1538, false], ['Company', 335000, 12884.6154, false]])
  check('and needs no derived figures', f.warnings.length, 0)

  check('nothing recognisable is not read', parseBellText('hello world').ok, false)
  check('a misread digit trips a check', pensionChecks({ types: [{ label: 'Company', units: 1, marketValue: 335500, opening: 300000, contributions: 6000, earnings: 29000 }], total: null }).some(c => !c.ok), true)
  check('a single fund row with no breakdown still gives a value', parseBellText('Test Fund 100.00% 100.5000 $2,500.00').types[0].marketValue, 2500)

  // Metrics: contributions scaled to a year from the period start; return with contributions arriving evenly.
  const m = pensionMetrics({ snapshotDate: '2026-10-18', periodStart: '2026-01-01', types: r.types }, now)
  check('total value', m.totalValue, 435000)
  check('contributions split by who paid them', [m.employeeContributions, m.companyContributions], [2000, 6000])
  check('a 9½-month period is scaled to a year', m.annualContribution, Math.round(8000 / ((new Date('2026-10-18') - new Date('2026-01-01')) / (365.25 * 86400000))))
  check('period return is earnings over opening plus half the contributions', Math.round(m.periodReturn * 10000) / 10000, Math.round(37000 / 394000 * 10000) / 10000)
  check('unit price and total units', [m.unitPrice, m.totalUnits], [26, 16730.7692])
  check('a period under three months is not scaled', pensionMetrics({ snapshotDate: '2026-10-18', periodStart: '2026-09-01', types: r.types }, now).annualContribution, null)
  check('no period start means no yearly figure', pensionMetrics({ snapshotDate: '2026-10-18', periodStart: null, types: r.types }, now).annualContribution, null)
  check('age in days', pensionMetrics({ snapshotDate: '2025-10-18', periodStart: '2025-01-01', types: r.types }, now).ageDays, 365)

  // In the planner export.
  const rowsNR = [{ account: 'NON_REG', value: 100000, currency: 'CAD', priceDate: '2026-10-16', cost_cad: 80000, book_cost: 80000, cost_source: 'statement' }]
  const pension = { snapshotDate: '2026-10-18', periodStart: '2026-01-01', fundName: 'Test Balanced Fund (50-54)', types: r.types }
  const e = buildPlannerExport(rowsNR, { now, pension })
  check('Bell balance goes to its own planner field', e.planner.bellDcBalance, 435000)
  check('and its yearly contribution', e.planner.contribBellDc, m.annualContribution)
  check('it is kept out of the LIRA field', e.planner.liraBalance, 0)
  check('detail is carried for display', [e.pension.asOf, e.pension.marketValue, e.pension.employeeContributions, e.pension.companyContributions], ['2026-10-18', 435000, 2000, 6000])
  check('no snapshot means the planner keeps its own', [buildPlannerExport(rowsNR, { now }).planner.bellDcBalance, buildPlannerExport(rowsNR, { now }).planner.contribBellDc], [null, null])
  check('a year-old snapshot is flagged', buildPlannerExport(rowsNR, { now, pension: { ...pension, snapshotDate: '2025-06-01' } }).warnings.some(w => /over a year old/.test(w)), true)
  check('a missing contribution period is flagged, not guessed', buildPlannerExport(rowsNR, { now, pension: { ...pension, periodStart: null } }).warnings.some(w => /contributions weren’t sent/.test(w)), true)
  check('the pension being outside the volatility figure is disclosed', buildPlannerExport(rowsNR, { now, pension, volatility: { annualVol: 0.09, months: 60, windowStart: '2021-10', windowEnd: '2026-09', coverage: 1, worst12m: -0.07, updatedAt: '2026-10-16T05:00:00Z' } }).warnings.some(w => /no price history/.test(w)), true)
}

console.log('\ndiff against stored holdings')
{
  const positions = [
    { name: 'BMO BALANCED ETF PORTFOLIO ADV SRS -FE', quantity: 5461.0076, unitPrice: 13.0002, marketValue: 70994.19 },
    { name: 'CI ETHEREUM FUND A -FE', quantity: 741.027, unitPrice: 8.1962, marketValue: 6073.61 },
    { name: 'MANULIFE GLOBAL BALANCED FUND -FE', quantity: 4103.448, unitPrice: 17.6796, marketValue: 72547.32 },
  ]
  const holdings = [
    // same units as the statement → unchanged
    { id: 'h1', ticker: '0P0001.TO', shares: 741.027, fund_name: 'CI Ethereum Fund A -FE', account: 'RRSP' },
    // fewer units on file → adjust
    { id: 'h2', ticker: '0P0002.TO', shares: 5000, fund_name: 'BMO Balanced ETF Portfolio ADV SRS -FE', account: 'RRSP' },
    // not on the statement → switched out, remove
    { id: 'h3', ticker: '0P0003.TO', shares: 120.757, fund_name: 'CI Precious Metals Fund A -FE', account: 'RRSP' },
  ]
  const fundMap = {
    [normalizeFundName('MANULIFE GLOBAL BALANCED FUND -FE')]: { ticker: '0P0004.TO', fund_name: 'Manulife Global Balanced' },
  }
  const rows = diffPositions(positions, holdings, fundMap)
  const by = name => rows.find(r => r.statementName === name)

  check('unchanged position', by('CI ETHEREUM FUND A -FE').action, 'none')
  check('changed units flagged', by('BMO BALANCED ETF PORTFOLIO ADV SRS -FE').action, 'adjust')
  check('old units kept for display', by('BMO BALANCED ETF PORTFOLIO ADV SRS -FE').previousShares, 5000)
  check('new units from the statement', by('BMO BALANCED ETF PORTFOLIO ADV SRS -FE').quantity, 5461.0076)
  check('gone from statement → remove', by('CI Precious Metals Fund A -FE').action, 'remove')
  check('remembered fund is not "new"', by('MANULIFE GLOBAL BALANCED FUND -FE').action, 'add')
  check('remembered ticker is filled in', by('MANULIFE GLOBAL BALANCED FUND -FE').ticker, '0P0004.TO')
  check('unknown fund needs a ticker', diffPositions(
    [{ name: 'BRAND NEW FUND -FE', quantity: 1, unitPrice: 1, marketValue: 1 }], [], {},
  )[0].ticker, '')
  check('row count', rows.length, 4)
}

console.log('\nnicknames')
{
  check('title-cased with acronyms kept', prettifyFundName('MANULIFE GLOBAL BALANCED FUND -FE'),
    'Manulife Global Balanced Fund -FE')
  check('brand acronyms', prettifyFundName('BMO GLOBAL LOW VOLATILITY ETF FUND ADV SRS -FE'),
    'BMO Global Low Volatility ETF Fund Advisor Series -FE')
  check('kerning fix', prettifyFundName('BMO TACTICAL GLOBAL ASSET ALLOCATION ETFFUND ADV SRS -FE'),
    'BMO Tactical Global Asset Allocation ETF Fund Advisor Series -FE')
  check('target dates kept', prettifyFundName('IA CLARINGTON TARGET CLICK 2030 -FE'),
    'IA Clarington Target Click 2030 -FE')
  // The Fidelity-cleared statement abbreviates severely. Expanding gives a
  // readable nickname and, more importantly, a name a ticker search can match.
  check('expands abbreviations', prettifyFundName('FDLTY INSIG CL SR F -NL'),
    'Fidelity Insights Class Series F -NL')
  check('fund-company prefixes are FundSERV codes', prettifyFundName('GOC AA PRT CLS SR F -NL'),
    'Canoe Asset Allocation Portfolio Class Series F -NL')
  check('doubled expansions collapse', prettifyFundName('MMF MLF DIV INC CL -NL'),
    'Manulife Dividend Income Class -NL')
  check('search name drops the load type', searchableFundName('FDLTY GLB INC CL PORT SR F -NL'),
    'Fidelity Global Income Class Portfolio Series F')
  check('search name drops footnote marks', searchableFundName('GOOD NATURED PRODS INC*'),
    'Good Natured Prods Inc')
  check('"Inc" ending a company name is not "Income"', prettifyFundName('GOOD NATURED PRODS INC'),
    'Good Natured Prods Inc')

  check('normalizing ignores case and punctuation',
    normalizeFundName('CI Growth & Income  Personal-Portfolio Class A -FE'),
    'CI GROWTH & INCOME PERSONAL PORTFOLIO CLASS A FE')
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed')
process.exit(failures ? 1 : 0)
