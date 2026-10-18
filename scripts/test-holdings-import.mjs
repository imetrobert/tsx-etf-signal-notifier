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
  const e = buildPlannerExport(rows, { usdCad: 1.4, now })
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
  check('CAD holding falls back to book_cost when no CAD cost column', buildPlannerExport([row('NON_REG', 100, null, { book_cost: 60 })], { now }).accounts.NON_REG.acb, 60)
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
