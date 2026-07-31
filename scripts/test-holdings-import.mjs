// Tests for the holdings import: reading the account site's export, turning
// broker symbols into the ones Yahoo indexes, expanding the abbreviated fund
// names, and diffing what the broker reports against what is on file.
//
// Nothing here is real account data.
//
// Run: npm test

import {
  diffPositions, normalizeFundName, prettifyFundName, searchableFundName,
} from '../src/lib/funds.js'
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
