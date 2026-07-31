// Tests for the Manulife statement parser.
//
// The fixtures below reproduce the geometry of a real statement page — pdf.js
// hands back fragmented text ("INVES" + "CO"), fund names wrap onto a second
// line, partly-unsegregated positions add "s"/"c" sub-rows that repeat part of
// the quantity, and pages of legal prose follow the table. Nothing here is real
// account data.
//
// Run: npm test

import {
  linesFrom, joinCells, parsePages, diffPositions,
  normalizeFundName, prettifyFundName, searchableFundName,
} from '../src/lib/statementParser.js'
import { parseHoldingsExport, toYahooSymbol } from '../src/lib/holdingsExport.js'

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

// Text items as pdf.js reports them: str, a transform whose last two entries
// are x/y, and the rendered width.
const W = 5.2 // approximate width per character in the statement's font
const item = (str, x, y, width = str.length * W) => ({ str, width, transform: [1, 0, 0, 1, x, y] })

// Fragments that render as one word sit flush against each other; a space is a
// visible gap. `frags` chains fragments with no gap, `parts` inserts one.
function frags(x, y, ...strs) {
  const out = []
  let cursor = x
  for (const s of strs) {
    out.push(item(s, cursor, y))
    cursor += s.length * W
  }
  return out
}

console.log('line reconstruction')
{
  const lines = linesFrom([
    ...frags(71.6, 452.5, 'INVES', 'CO'),
    item('EQV', 110, 452.5),
    item('CI', 71.6, 479),
    item('ETHEREUM', 84, 479),
  ])
  check('one line per baseline', lines.length, 2)
  check('top of the page first', joinCells(lines[0].cells), 'CI ETHEREUM')
  check('fragments of a word join up', joinCells(lines[1].cells), 'INVESCO EQV')
}

console.log('\nholdings table')
const holdingsPage = [
  // page header: account top right, statement date beneath it
  ...[item('RRSP', 511.3, 759.5), item('N359858R', 533.9, 759.5)],
  ...[item('September', 497.7, 749.5), item('30,', 550, 749.5), item('2023', 568, 749.5)],
  item('Holdings', 67.5, 538),
  item('Quantity', 261.8, 514),
  item('Per Unit ($)', 327.2, 513.5),
  item('Total ($)', 403.3, 513.5),
  item('Per Unit ($)', 463, 513.5),
  item('Total ($)', 548.1, 513.5),
  item('Investment Funds and Deposit Notes', 67.5, 492.5),

  // a plain position
  item('CI ETHEREUM FUND A -FE', 71.6, 479),
  item('741.0270', 258.5, 479),
  ...frags(343.1, 479, '8', '.6641'),
  item('6,420.33', 400, 479),
  ...frags(478.9, 479, '8', '.1962'),
  item('6,073.61', 544.5, 479),

  // a position whose name wraps onto the next line
  item('INVESCO EQV EUROPEAN EQUITY FUND', 71.6, 452.5),
  item('391.1750', 258.5, 452.5),
  item('12.7820', 338.4, 452.5),
  item('5,000.00', 400, 452.5),
  item('15.6300', 474.1, 452.5),
  item('6,114.07', 544.5, 452.5),
  item('SER A -FE', 71.6, 444.5),

  // a position split into segregated / unsegregated portions: the "s" and "c"
  // sub-rows repeat parts of the quantity and must be ignored
  item('FIDELITY INFLATION-FOCUSED FUND', 71.6, 256),
  item('1,403.9240', 251.6, 256),
  item('10.5632', 338.4, 256),
  ...frags(395.3, 256, '14,', '829', '.', '88'),
  ...frags(478.9, 256, '9', '.7194'),
  item('13,645.30', 539.8, 256),
  item('SERIES B -FE', 71.6, 248),
  item('s', 291.4, 245.5),
  item('1,393.2443', 249.2, 243),
  item('c', 291.3, 232),
  item('10.6797', 260.7, 229.5),

  // end of the table, then the footnote prose that follows it
  item('Total Investment Funds and Deposit Notes', 67.5, 176),
  item('$297,569.81', 386, 176),
  item('$331,457.14', 530.5, 176),
  item('Cash', 71.6, 139.5),
  item('5.14', 416.4, 139.5),
  item('5.14', 560.9, 139.5),
  item('* Please refer to the Important Information section at the end', 67.5, 92.5),
]

// A continuation page: the same "Holdings" banner, but only prose and the
// Activity table — none of it may leak into the positions.
const continuationPage = [
  ...[item('RRSP', 511.3, 759.5), item('N359858R', 533.9, 759.5)],
  item('Holdings (continued)', 67.5, 692.5),
  item('s. This portion of the security position is segregated.', 67.5, 660),
  item('Activity', 67.5, 600),
  item('Quantity', 261.8, 588),
  item('Reinvested Dividend CI GROWTH & INCOME', 120, 560),
  item('27.8500', 258.5, 560),
  item('8.7896', 338.4, 560),
  item('244.79', 400, 560),
]

{
  const r = parsePages([
    { lines: linesFrom(holdingsPage) },
    { lines: linesFrom(continuationPage) },
  ])
  check('statement date', r.statementDate, '2023-09-30')
  check('no warnings', r.warnings, [])
  check('one account', r.accounts.length, 1)

  const acct = r.accounts[0]
  check('account number', acct.accountNumber, 'N359858R')
  check('account type', acct.accountType, 'RRSP')
  check('position count', acct.positions.length, 3)
  check('names', acct.positions.map(p => p.name), [
    'CI ETHEREUM FUND A -FE',
    'INVESCO EQV EUROPEAN EQUITY FUND SER A -FE', // wrapped name joined
    'FIDELITY INFLATION-FOCUSED FUND SERIES B -FE',
  ])
  check('quantities', acct.positions.map(p => p.quantity), [741.027, 391.175, 1403.924])
  check('unit prices', acct.positions.map(p => p.unitPrice), [8.1962, 15.63, 9.7194])
  check('market values', acct.positions.map(p => p.marketValue), [6073.61, 6114.07, 13645.3])
  check('market values sum cleanly',
    acct.positions.reduce((s, p) => s + p.marketValue, 0).toFixed(2), '25832.98')
}

console.log('\naccount types')
{
  // A realistic row: name, quantity, book cost per unit + total, market value
  // per unit + total. 10 units at $10 is $100.
  const page = n => linesFrom([item(n, 500, 759.5), item('Investment Funds and Deposit Notes', 67.5, 700),
    item('SOME FUND -FE', 71.6, 680), item('10.0000', 258.5, 680), item('9.5000', 338.4, 680),
    item('95.00', 400, 680), item('10.0000', 474.1, 680), item('100.00', 544.5, 680)])
  const type = n => parsePages([{ lines: page(n) }]).accounts[0]?.accountType
  check('TFSA', type('TFSA N123456A'), 'TFSA')
  check('LIRA', type('LIRA N123456A'), 'LIRA')
  check('LIF counts as locked-in', type('LIF N123456A'), 'LIRA')
  check('RRIF counts as RRSP', type('RRIF N123456A'), 'RRSP')
  check('cash account', type('CASH N123456A'), 'NON_REG')
  const unknown = parsePages([{ lines: page('N123456A') }])
  check('unknown label leaves the type blank', unknown.accounts[0].accountType, null)
  check('and warns', unknown.warnings.some(w => /what kind of account/.test(w)), true)
}

console.log('\nFidelity-cleared format (Manulife Wealth)')
{
  // The newer statement differs in every structural way: "Account Holdings"
  // instead of "Investment Funds and Deposit Notes", dashed account numbers,
  // a "Held In" marker between the quantity and the money columns, a long
  // quantity printed a point above the rest of its row, asset-class banners,
  // and every account in one statement.
  const page = [
    item('For Accounts Belonging to MR SOMEONE', 62.3, 711.5),
    item('For Period Ending June 30, 2026', 422.4, 711.5),
    item('Account Holdings', 55.3, 683),
    item('Held', 265.9, 666.5), item('Current', 379.2, 666.5), item('Current Market', 496.7, 666.5),
    item('Quantity', 228.7, 656), item('In', 271.5, 656), item('Cost', 336.7, 656),
    item('Price', 387.4, 656), item('Value', 529.9, 656),

    item('RRSP Account (CAD) - YN5-60LA-T', 55.3, 626),
    item('Mutual Funds', 55.3, 611),
    // long quantity sits on its own baseline, one point above its row
    item('3,144.7676', 223.8, 582.5),
    item('BMO TACT GLB EQ ETF -NL', 62.3, 581.5), item('seg', 268.6, 581.5),
    item('43,482.50', 317.3, 581.5), item('16.938', 381.2, 581.5), item('53,265.13', 515.3, 581.5),
    // short quantity stays on the row
    item('CI PREC MTL FD CL F -NL', 62.3, 567), item('95.6990', 230.3, 567), item('seg', 268.6, 567),
    item('2,782.70', 321.6, 567), item('193.654', 376.8, 567), item('18,532.46', 515.3, 567),
    // a worthless position still prices out
    item('GOOD NATURED PRODS INC*', 62.3, 552.5), item('4', 254, 552.5), item('seg', 268.6, 552.5),
    item('0.28', 336.7, 552.5), item('0.000', 385.5, 552.5), item('0.00', 534.7, 552.5),
    item('Total Mutual Funds (CAD)', 55.3, 538), item('$', 303.1, 538), item('71,797.59', 308.7, 538),
    item('$', 501.1, 538), item('71,797.59', 506.7, 538),
    item('Account Total YN5-60LA-T (CAD)', 55.3, 524), item('$', 303.1, 524), item('71,797.59', 308.7, 524),

    item('TFSA (CAD) - YN5-60LA-Q', 55.3, 500),
    item('Cash and Cash Equivalents', 55.3, 486),
    item('CASH', 62.3, 472), item('318.05', 234.6, 472), item('318.05', 328.1, 472), item('318.05', 526.1, 472),
    item('Equity', 55.3, 458),
    item('FIDELITY ALL IN ONE BAL ETF', 62.3, 444), item('3,752', 238.9, 444), item('seg', 268.6, 444),
    item('54,494.32', 317.3, 444), item('15.560', 381.2, 444), item('58,381.12', 515.3, 444),
    item('GRAND TOTAL (CAD)', 55.3, 420), item('$', 303.1, 420), item('130,178.71', 308.7, 420),

    // the Income Summary that follows must not contribute positions
    item('Income Summary', 55.3, 396),
    item('TFSA (CAD)', 56.3, 380), item('YN5-60LA-Q', 178.7, 380),
    item('Total Dividends', 257.9, 380), item('0.00', 438.4, 380), item('12.82', 534.9, 380),
  ]

  const r = parsePages([{ lines: linesFrom(page) }])
  check('period-ending date is used', r.statementDate, '2026-06-30')
  check('no warnings', r.warnings, [])
  check('one section per account', r.accounts.map(a => a.accountNumber), ['YN5-60LA-T', 'YN5-60LA-Q'])
  check('account types from the banners', r.accounts.map(a => a.accountType), ['RRSP', 'TFSA'])
  check('currency', r.accounts.map(a => a.currency), ['CAD', 'CAD'])

  const rrsp = r.accounts[0]
  check('positions per account', r.accounts.map(a => a.positions.length), [3, 1])
  check('quantity from the line above joins its row', rrsp.positions[0],
    { name: 'BMO TACT GLB EQ ETF -NL', quantity: 3144.7676, unitPrice: 16.938, marketValue: 53265.13 })
  check('"seg" does not break the figures', rrsp.positions[1],
    { name: 'CI PREC MTL FD CL F -NL', quantity: 95.699, unitPrice: 193.654, marketValue: 18532.46 })
  check('a zero-value position is kept', rrsp.positions[2],
    { name: 'GOOD NATURED PRODS INC*', quantity: 4, unitPrice: 0, marketValue: 0 })
  check('cash is not a holding', r.accounts[1].positions.map(p => p.name), ['FIDELITY ALL IN ONE BAL ETF'])
  check('subtotals are not positions',
    r.accounts.flatMap(a => a.positions).some(p => /total/i.test(p.name)), false)
  check('income summary rows are not positions',
    r.accounts.flatMap(a => a.positions).some(p => /dividend/i.test(p.name)), false)
}

console.log('\ncolumn layouts')
{
  // Figures are read as (first, second-last, last) and checked against
  // units × price, so the same row parses whether or not the statement prints
  // book cost — and a fund name ending in a number isn't mistaken for one.
  const row = (...cells) => linesFrom([
    item('Investment Funds and Deposit Notes', 67.5, 700),
    ...cells.map(([str, x]) => item(str, x, 680)),
    item('RRSP N123456A', 500, 759.5),
  ])
  const parse = lines => parsePages([{ lines }]).accounts[0]?.positions?.[0] ?? null

  check('five figure columns (book cost shown)', parse(row(
    ['A FUND -FE', 71.6], ['524.7593', 251.6], ['9.9899', 338.4], ['5,242.27', 395.2],
    ['9.6371', 474.1], ['5,057.16', 539.8],
  )), { name: 'A FUND -FE', quantity: 524.7593, unitPrice: 9.6371, marketValue: 5057.16 })

  check('four figure columns (book cost total only)', parse(row(
    ['A FUND -FE', 71.6], ['524.7593', 251.6], ['5,242.27', 395.2], ['9.6371', 474.1], ['5,057.16', 539.8],
  )), { name: 'A FUND -FE', quantity: 524.7593, unitPrice: 9.6371, marketValue: 5057.16 })

  check('three figure columns (no book cost)', parse(row(
    ['A FUND -FE', 71.6], ['524.7593', 251.6], ['9.6371', 474.1], ['5,057.16', 539.8],
  )), { name: 'A FUND -FE', quantity: 524.7593, unitPrice: 9.6371, marketValue: 5057.16 })

  check('a name ending in a number is not read as a figure', parse(row(
    ['IA CLARINGTON TARGET CLICK 2030', 71.6], ['889.1130', 251.6], ['15.2630', 338.4],
    ['13,570.54', 395.2], ['13.1945', 474.1], ['11,731.40', 539.8],
  )), { name: 'IA CLARINGTON TARGET CLICK 2030', quantity: 889.113, unitPrice: 13.1945, marketValue: 11731.4 })

  check('figures that do not multiply out are rejected', parse(row(
    ['A FUND -FE', 71.6], ['1.0000', 251.6], ['99.9999', 474.1], ['12,345.67', 539.8],
  )), null)

  // Column positions are never assumed: the same row shifted 90pt right parses.
  check('shifted columns still parse', parse(row(
    ['A FUND -FE', 71.6], ['524.7593', 341.6], ['9.9899', 428.4], ['5,242.27', 485.2],
    ['9.6371', 564.1], ['5,057.16', 629.8],
  )), { name: 'A FUND -FE', quantity: 524.7593, unitPrice: 9.6371, marketValue: 5057.16 })
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

  check('a file that is not an export says so',
    /doesn't look like a holdings export/.test(parseHoldingsExport('a,b,c\n1,2,3').warnings[0]), true)
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
