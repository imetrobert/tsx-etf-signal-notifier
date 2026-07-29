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
  normalizeFundName, prettifyFundName,
} from '../src/lib/statementParser.js'

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
  const page = n => linesFrom([item(n, 500, 759.5), item('Investment Funds and Deposit Notes', 67.5, 700),
    item('SOME FUND -FE', 71.6, 680), item('10.0000', 258.5, 680), item('100.00', 544.5, 680)])
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
    'BMO Global Low Volatility ETF Fund Adv Srs -FE')
  check('kerning fix', prettifyFundName('BMO TACTICAL GLOBAL ASSET ALLOCATION ETFFUND ADV SRS -FE'),
    'BMO Tactical Global Asset Allocation ETF Fund Adv Srs -FE')
  check('target dates kept', prettifyFundName('IA CLARINGTON TARGET CLICK 2030 -FE'),
    'IA Clarington Target Click 2030 -FE')
  check('normalizing ignores case and punctuation',
    normalizeFundName('CI Growth & Income  Personal-Portfolio Class A -FE'),
    'CI GROWTH & INCOME PERSONAL PORTFOLIO CLASS A FE')
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed')
process.exit(failures ? 1 : 0)
