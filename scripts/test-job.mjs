// End-to-end test of the nightly job (scripts/run-signals.js): runs the REAL file against a simulated
// database and simulated Yahoo, and checks it measures and saves the portfolio volatility.
//
//   node scripts/test-job.mjs        (takes ~15 seconds; not part of `npm test`)
//
// The simulated database behaves like the real one where it matters: a select returns ONLY the columns
// asked for. That is what lets this catch a job that forgets to ask for a column it needs — which is how
// the volatility measure once silently failed (it never selected "shares").

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

const here = path.dirname(new URL(import.meta.url).pathname)
let fails = 0, n = 0
const ok = (name, cond, extra = '') => { n++; if (!cond) { fails++; console.log('  FAIL ' + name + ' ' + extra) } else console.log('  ok   ' + name) }

// ---------- simulated database ----------
const tables = {}
const proj = (row, cols) => (cols === '*' || !cols ? { ...row } : Object.fromEntries(cols.split(',').map(c => c.trim()).filter(Boolean).map(c => [c, row[c]])))
const KEYS = { etf_portfolio_stats: 'id', etf_market_regime: 'id', etf_prices: 'ticker', etf_signal_state: 'ticker', etf_watchlist: 'ticker', etf_settings: 'id' }
const fakeModule = `
export function createClient() { return globalThis.__fakeDb }
`
globalThis.__fakeDb = {
  from(name) {
    tables[name] ??= []
    const st = { cols: '*', filters: [], op: 'select', payload: null, single: false }
    const run = () => {
      const rows = tables[name]
      if (st.op === 'select') {
        const out = rows.filter(r => st.filters.every(([k, v]) => r[k] === v)).map(r => proj(r, st.cols))
        return st.single ? { data: out[0] ?? null, error: null } : { data: out, error: null }
      }
      if (st.op === 'upsert' || st.op === 'insert') {
        for (const p of [].concat(st.payload)) {
          const key = KEYS[name]
          const i = key ? rows.findIndex(r => r[key] === p[key]) : -1
          if (i >= 0) rows[i] = { ...rows[i], ...p }; else rows.push({ ...p })
        }
        return { data: null, error: null }
      }
      if (st.op === 'update') { rows.filter(r => st.filters.every(([k, v]) => r[k] === v)).forEach(r => Object.assign(r, st.payload)); return { data: null, error: null } }
      return { data: null, error: null }
    }
    const b = {
      select(c) { st.cols = c; return b }, eq(k, v) { st.filters.push([k, v]); return b }, is(k, v) { st.filters.push([k, v]); return b },
      in() { return b }, order() { return b }, limit() { return b }, neq() { return b }, not() { return b }, gte() { return b }, lte() { return b },
      maybeSingle() { st.single = true; return Promise.resolve(run()) }, single() { st.single = true; return Promise.resolve(run()) },
      upsert(p) { st.op = 'upsert'; st.payload = p; return b }, insert(p) { st.op = 'insert'; st.payload = p; return b },
      update(p) { st.op = 'update'; st.payload = p; return b }, delete() { st.op = 'delete'; return b },
      then(res, rej) { try { return Promise.resolve(run()).then(res, rej) } catch (e) { return Promise.reject(e).then(res, rej) } },
    }
    return b
  },
}
fs.writeFileSync(path.join(here, '_fake_supabase.mjs'), fakeModule)

// ---------- simulated Yahoo: ten years of daily history, deterministic per ticker; mutual-fund codes have none ----------
const rng = s => () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
const normal = r => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
globalThis.fetch = async url => {
  const m = String(url).match(/finance\/chart\/([^?]+)/)
  if (!m) return { ok: false, status: 404, json: async () => ({}) }
  const t = decodeURIComponent(m[1])
  if (/^FID/.test(t)) return { ok: false, status: 404, json: async () => ({}) }
  const r = rng(Array.from(t).reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0)
  const ts = [], close = [], adj = []
  let px = 50
  const end = Math.floor(Date.now() / 1000)
  for (let d = 3650; d >= 0; d--) {
    const day = new Date((end - d * 86400) * 1000)
    if ([0, 6].includes(day.getUTCDay())) continue
    px *= 1 + 0.0003 + normal(r) * 0.009
    ts.push(end - d * 86400); close.push(px); adj.push(px)
  }
  return { ok: true, status: 200, json: async () => ({ chart: { result: [{ timestamp: ts, meta: { currency: 'CAD', longName: t }, indicators: { quote: [{ close }], adjclose: [{ adjclose: adj }] } }] } }) }
}

const seedDb = () => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.etf_holdings = [
    { ticker: 'XEQT.TO', account: 'RRSP', institution: 'WEALTHSIMPLE', fund_name: 'iShares Core Equity', shares: 98.8 },
    { ticker: 'VCN.TO', account: 'RRSP', institution: 'WEALTHSIMPLE', fund_name: 'Vanguard Canada', shares: 435.2 },
    { ticker: 'XEQT.TO', account: 'TFSA', institution: 'WEALTHSIMPLE', fund_name: 'iShares Core Equity', shares: 120 },
    { ticker: 'HXQ.TO', account: 'NON_REG', institution: 'WEALTHSIMPLE', fund_name: 'Global X Nasdaq', shares: 124.3 },
    { ticker: 'FID5494', account: 'NON_REG', institution: 'MANULIFE', fund_name: 'FDLTY GLB INC', shares: 2321.6 },
    { ticker: 'FID6001', account: 'RRSP', institution: 'MANULIFE', fund_name: 'FDLTY INSIG', shares: 1113.8 },
  ]
  tables.etf_prices = [
    { ticker: 'XEQT.TO', price: 45.46 }, { ticker: 'VCN.TO', price: 73.5 }, { ticker: 'HXQ.TO', price: 118.8 },
    { ticker: 'FID5494', price: 25.6 }, { ticker: 'FID6001', price: 46.1 },
  ]
}

let runNo = 0
// Runs the job's real source (optionally altered) and returns what it logged and saved.
async function runJob(alter = s => s) {
  seedDb()
  let src = fs.readFileSync(path.join(here, 'run-signals.js'), 'utf8').replace("from '@supabase/supabase-js'", "from './_fake_supabase.mjs'")
  src = alter(src)
  const file = path.join(here, `_run-signals.copy${++runNo}.mjs`)
  fs.writeFileSync(file, src)
  process.env.SUPABASE_URL = 'http://fake'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake'
  const lines = []
  const log = console.log, err = console.error
  console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push('ERR ' + a.join(' '))
  try {
    await import(pathToFileURL(file).href)
    for (let i = 0; i < 900 && !lines.some(l => /olatil/.test(l) && !/input problem/.test(l)); i++) await new Promise(r => setTimeout(r, 100))
    await new Promise(r => setTimeout(r, 300))
  } finally { console.log = log; console.error = err; fs.unlinkSync(file) }
  return { lines, stats: (tables.etf_portfolio_stats || [])[0] || null }
}

console.log('The job as it is:')
const src = fs.readFileSync(path.join(here, 'run-signals.js'), 'utf8')
ok('the holdings query asks for the units (the volatility measure weights by them)', /from\('etf_holdings'\)\.select\('[^']*\bshares\b[^']*'\)/.test(src))

const good = await runJob()
const s = good.stats
ok('it writes the portfolio-volatility row', !!s)
ok('annual volatility is plausible', s && s.annual_vol > 0.05 && s.annual_vol < 0.25, s && String(s.annual_vol))
ok('over 60 months', s && s.months === 60)
ok('it reports how much of the portfolio could be measured (the ETFs, not the funds with no history)', s && s.coverage > 0.30 && s.coverage < 0.38, s && String(s.coverage))
ok('and names what could not be', s && JSON.stringify(s.details.uncovered.sort()) === JSON.stringify(['FID5494', 'FID6001']))
ok('and what could', s && ['HXQ.TO', 'VCN.TO', 'XEQT.TO'].every(t => s.details.covered.includes(t)))
ok('XEQT held in two accounts is one holding, not two', s && s.details.perHolding.filter(h => h.ticker === 'XEQT.TO').length === 1)
ok('it stores the year-by-year history', s && s.details.history && s.details.history.calendarYears.length >= 5 && s.details.history.rolling12Count > 0)
ok('and a longer-window figure', s && s.details.history.monthsLong > 84 && s.details.history.annualVolLong > 0)
ok('the log says what was measured', good.lines.some(l => /Portfolio volatility: \d+\.\d% a year over 60 months, \d+% of value measured/.test(l)))
ok('and what was left out', good.lines.some(l => /no history: FID5494, FID6001|no history: FID6001, FID5494/.test(l)))

console.log('The same job with the bug that caused the missing row (units not selected):')
const bad = await runJob(t => t.replace("select('ticker, account, institution, fund_name, shares')", "select('ticker, account, institution, fund_name')"))
ok('the test catches it: no row is written', bad.stats === null)
ok('and the log says why, in words, instead of "not enough history"', bad.lines.some(l => /without units/.test(l)) && bad.lines.some(l => /could not be measured/.test(l)))

console.log(fails ? `\n${fails} of ${n} FAILED` : `\nAll ${n} job checks passed`)
fs.rmSync(path.join(here, '_fake_supabase.mjs'), { force: true })
process.exit(fails ? 1 : 0)
