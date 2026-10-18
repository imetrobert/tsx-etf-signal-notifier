import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeTicker, displayTicker, fmtCad } from '../lib/tickers'
import { buildPlannerExport } from '../lib/plannerExport'
import Navbar from './Navbar'

const ACCOUNTS = [
  { code: 'TFSA', label: 'TFSA' },
  { code: 'RRSP', label: 'RRSP' },
  { code: 'LIRA', label: 'Locked-in RRSP' },
  { code: 'NON_REG', label: 'Non-registered' },
]
const acctLabel = code => ACCOUNTS.find(a => a.code === code)?.label ?? code

const INSTITUTIONS = [
  { code: 'WEALTHSIMPLE', label: 'Wealthsimple', short: 'WS' },
  { code: 'MANULIFE', label: 'Manulife Wealth', short: 'Manulife' },
]
const instLabel = code => INSTITUTIONS.find(i => i.code === code)?.label ?? code
const instShort = code => INSTITUTIONS.find(i => i.code === code)?.short ?? code

// Yahoo lists mutual funds under Morningstar-style 0P... symbols; their NAV
// updates once daily, unlike intraday ETF quotes.
const isFund = ticker => ticker.startsWith('0P')

export default function Dashboard() {
  const [holdings, setHoldings] = useState([])
  const [prices, setPrices] = useState({})
  const [regime, setRegime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNote, setRefreshNote] = useState('')
  const [error, setError] = useState('')
  const [ticker, setTicker] = useState('')
  const [shares, setShares] = useState('')
  const [account, setAccount] = useState('TFSA')
  const [institution, setInstitution] = useState('WEALTHSIMPLE')
  const [fundName, setFundName] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editShares, setEditShares] = useState('')
  const [editAccount, setEditAccount] = useState('NON_REG')
  const [editInstitution, setEditInstitution] = useState('WEALTHSIMPLE')
  const [editFundName, setEditFundName] = useState('')
  const [acctFilter, setAcctFilter] = useState('ALL')
  const [instFilter, setInstFilter] = useState('ALL')

  const load = useCallback(async () => {
    setError('')
    const [h, p, r] = await Promise.all([
      supabase.from('etf_holdings').select('*').order('ticker'),
      supabase.from('etf_prices').select('*'),
      supabase.from('etf_market_regime').select('*').maybeSingle(),
    ])
    if (h.error) { setError(h.error.message); setLoading(false); return }
    setHoldings(h.data || [])
    if (!r.error && r.data) setRegime(r.data)
    const priceMap = {}
    for (const row of p.data || []) priceMap[row.ticker] = row
    setPrices(priceMap)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshNote('')
    try {
      const { data, error } = await supabase.functions.invoke('refresh-prices')
      if (error) setRefreshNote('Live price refresh unavailable — showing the last stored prices. (Is the refresh-prices edge function deployed?)')
      else if (data?.failed?.length) setRefreshNote(`Prices refreshed, but ${data.failed.length} ticker(s) failed: ${data.failed.join('; ')}`)
    } catch {
      setRefreshNote('Live price refresh unavailable — showing the last stored prices.')
    }
    await load()
    setRefreshing(false)
  }, [load])

  async function addHolding(e) {
    e.preventDefault()
    const sym = normalizeTicker(ticker)
    const qty = parseFloat(shares)
    if (!sym || !(qty > 0)) return
    setSaving(true)
    setError('')
    const { error } = await supabase
      .from('etf_holdings')
      .upsert({ ticker: sym, shares: qty, account, institution, fund_name: fundName.trim() || null }, { onConflict: 'ticker,account,institution' })
    if (error) setError(error.message)
    else {
      setTicker(''); setShares(''); setFundName('')
      // Fetches the price and, when no name was typed in, backfills the
      // fund's real name from Yahoo — so it shows up immediately instead of
      // waiting for the next scheduled run.
      try { await supabase.functions.invoke('refresh-prices') } catch { /* best-effort */ }
      await load()
    }
    setSaving(false)
  }

  async function saveEdit(id) {
    const qty = parseFloat(editShares)
    if (!(qty > 0)) return
    const { error } = await supabase
      .from('etf_holdings')
      .update({
        shares: qty, account: editAccount, institution: editInstitution,
        fund_name: editFundName.trim() || null, updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (error) setError(error.message)
    setEditingId(null)
    await load()
  }

  async function remove(id, sym, acct) {
    if (!window.confirm(`Remove ${displayTicker(sym)} (${acctLabel(acct)}) from holdings?`)) return
    const { error } = await supabase.from('etf_holdings').delete().eq('id', id)
    if (error) setError(error.message)
    await load()
  }

  const rows = holdings.map(h => {
    const p = prices[h.ticker]
    // Funds sourced via the Globe and Mail fallback (Yahoo has no coverage)
    // get a current price but no historical NAV, so ma200 stays null forever
    // — that's the signal a holding can price but can't generate BUY/SELL alerts.
    const priceOnly = p?.price != null && p?.ma200 == null
    const value = p?.price != null ? p.price * h.shares : null
    // Cost (ACB) is stored in the security's own currency, like its price, so
    // the gain is always like-for-like.
    const cost = h.book_cost != null ? Number(h.book_cost) : null
    return {
      ...h, price: p?.price ?? null, priceDate: p?.price_date ?? null, value, priceOnly,
      currency: p?.currency || 'CAD', cost, gain: value != null && cost != null ? value - cost : null,
    }
  })
  const shownRows = rows.filter(r =>
    (acctFilter === 'ALL' || r.account === acctFilter) &&
    (instFilter === 'ALL' || r.institution === instFilter)
  )
  // Totals are in CAD. A USD-priced holding (a US listing) is shown in USD on
  // its own row and left out of them rather than added in as if it were CAD.
  const isCad = r => r.currency === 'CAD'
  const usdCount = shownRows.filter(r => r.value != null && !isCad(r)).length
  const total = shownRows.filter(isCad).reduce((s, r) => s + (r.value ?? 0), 0)
  const anyPrice = shownRows.some(r => r.price != null)
  const accountTotals = ACCOUNTS
    .map(a => ({ ...a, value: rows.filter(r => r.account === a.code && isCad(r)).reduce((s, r) => s + (r.value ?? 0), 0) }))
    .filter(a => a.value > 0)
  // Gain / loss against cost basis: non-registered vs registered, CAD holdings
  // that have both a price and a cost. Holdings missing either are counted
  // separately, not quietly treated as zero.
  const REGISTERED = ['RRSP', 'TFSA', 'LIRA']
  const costScope = rows.filter(r => instFilter === 'ALL' || r.institution === instFilter)
  const summarize = list => {
    const costed = list.filter(r => isCad(r) && r.gain != null)
    const value = costed.reduce((s, r) => s + r.value, 0)
    const cost = costed.reduce((s, r) => s + r.cost, 0)
    return {
      value, cost, gain: value - cost, pct: cost > 0 ? ((value - cost) / cost) * 100 : null,
      count: costed.length,
      without: list.filter(r => isCad(r) && r.value != null && r.cost == null).length,
      estimated: costed.filter(r => r.cost_source === 'estimated').length,
    }
  }
  const costSummary = [
    { label: 'Non-registered', ...summarize(costScope.filter(r => r.account === 'NON_REG')) },
    { label: 'Registered (RRSP · TFSA)', ...summarize(costScope.filter(r => REGISTERED.includes(r.account))) },
    { label: 'All accounts', ...summarize(costScope) },
  ]
  const anyCost = costSummary.some(c => c.count > 0)
  const fmtGain = n => `${n >= 0 ? '+' : '−'}${fmtCad.format(Math.abs(n))}`
  const gainColor = n => (n >= 0 ? 'var(--ok)' : 'var(--accent)')
  // ---- Export for the retirement planner ----
  const [usdCad, setUsdCad] = useState(() => {
    try { return localStorage.getItem('etf_usd_cad') || '1.4230' } catch { return '1.4230' }
  })
  const [exportNote, setExportNote] = useState('')
  const plannerExport = buildPlannerExport(rows, { usdCad: parseFloat(usdCad) })
  const plannerJson = JSON.stringify(plannerExport, null, 2)
  const hasUsd = rows.some(r => r.value != null && r.currency === 'USD')
  function changeUsdCad(v) {
    setUsdCad(v)
    try { localStorage.setItem('etf_usd_cad', v) } catch { /* private mode: the rate just isn't remembered */ }
  }
  async function copyPlannerExport() {
    try {
      await navigator.clipboard.writeText(plannerJson)
      setExportNote('Copied — open your retirement planner and paste it into “Import from my ETF tracker”.')
    } catch {
      // Clipboard can be refused; the text box below is selectable instead.
      const box = document.getElementById('plannerExportBox')
      if (box) { box.focus(); box.select() }
      setExportNote('Couldn’t copy automatically — the text below is selected, so tap and hold, then Copy.')
    }
  }
  function downloadPlannerExport() {
    const url = URL.createObjectURL(new Blob([plannerJson], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `portfolio-for-planner-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  const PLANNER_ROWS = [
    { code: 'NON_REG', label: 'Non-registered' }, { code: 'RRSP', label: 'RRSP' },
    { code: 'LIRA', label: 'Locked-in (LIRA)' }, { code: 'TFSA', label: 'TFSA' },
  ]
  const totalLabelParts = []
  if (instFilter !== 'ALL') totalLabelParts.push(instLabel(instFilter))
  if (acctFilter !== 'ALL') totalLabelParts.push(acctLabel(acctFilter))
  const totalLabel = totalLabelParts.length ? `${totalLabelParts.join(' · ')} value` : 'Portfolio value'

  // ETF quotes refresh intraday; fund NAVs are set once daily — show each
  // group's own freshness so a lagging NAV date isn't mistaken for staleness.
  const fmtTime = iso => new Date(iso).toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  const fmtNavDate = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  const priceEntries = Object.entries(prices)
  const lastEtfUpdated = priceEntries.filter(([t]) => !isFund(t)).map(([, p]) => p.updated_at).sort().pop()
  const lastFundNavDate = priceEntries.filter(([t]) => isFund(t)).map(([, p]) => p.price_date).filter(Boolean).sort().pop()

  return (
    <>
      <Navbar subtitle="Notification-only — never places trades" onRefresh={refresh} refreshing={refreshing} />
      <main>
        {refreshNote && <div className="notice">{refreshNote}</div>}
        {regime && (
          <div className="card">
            <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              Market regime
              <span className={`tag ${regime.level === 'NORMAL' ? 'buy' : regime.level === 'WATCH' ? 'watch' : 'sell'}`}>
                {regime.level}
              </span>
            </h2>
            {(regime.gauges || []).map((g, i) => (
              <div key={i} style={{ padding: '6px 0', borderBottom: i < regime.gauges.length - 1 ? '1px solid var(--ledger-line)' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{g.name}</span>
                  <span className="ticker" style={{ whiteSpace: 'nowrap' }}>{g.value}</span>
                </div>
                <div className="muted" style={{ color: g.warn ? 'var(--accent)' : undefined }}>{g.status}</div>
              </div>
            ))}
          </div>
        )}
        <div className="card">
          <h2>Add holding</h2>
          <form className="form-row" onSubmit={addHolding}>
            <div>
              <label className="field-label">TSX ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value)} placeholder="e.g. XEQT" autoCapitalize="characters" autoCorrect="off" />
            </div>
            <div>
              <label className="field-label">Shares / units</label>
              <input value={shares} onChange={e => setShares(e.target.value)} placeholder="e.g. 25" inputMode="decimal" />
            </div>
            <div>
              <label className="field-label">Account</label>
              <select value={account} onChange={e => setAccount(e.target.value)}>
                {ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Institution</label>
              <select value={institution} onChange={e => setInstitution(e.target.value)}>
                {INSTITUTIONS.map(i => <option key={i.code} value={i.code}>{i.label}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Fund name (optional)</label>
              <input value={fundName} onChange={e => setFundName(e.target.value)} placeholder="e.g. CI Precious Metals F" />
            </div>
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add'}</button>
          </form>
          <div className="muted" style={{ marginTop: 8 }}>
            Plain tickers get the TSX suffix automatically (XEQT → XEQT.TO). Re-adding a
            ticker in the same account updates its share count. Signal advice assumes your
            TFSA and RRSP are maxed out (sell-to-buy in registered accounts). Fund name is
            looked up automatically if left blank — only fill it in to override that with
            something else. It's used in the holdings table and the advisor email draft on
            the Signals tab.
          </div>
          {error && <div className="err">{error}</div>}
        </div>

        <div className="card">
          <h2>My holdings</h2>
          {!loading && rows.length > 0 && (
            <>
              <div className="filter-row">
                {[{ code: 'ALL', label: 'All' }, ...ACCOUNTS].map(a => (
                  <button
                    key={a.code}
                    className={`filter-btn${acctFilter === a.code ? ' active' : ''}`}
                    onClick={() => setAcctFilter(a.code)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <div className="filter-row">
                {[{ code: 'ALL', label: 'All institutions' }, ...INSTITUTIONS].map(i => (
                  <button
                    key={i.code}
                    className={`filter-btn${instFilter === i.code ? ' active' : ''}`}
                    onClick={() => setInstFilter(i.code)}
                  >
                    {i.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {loading ? (
            <div className="empty"><span className="spin" /></div>
          ) : rows.length === 0 ? (
            <div className="empty">No holdings yet — add your first ETF above.</div>
          ) : shownRows.length === 0 ? (
            <div className="empty">No holdings match this filter yet.</div>
          ) : (
            <>
              {shownRows.some(r => r.price == null) && (
                <div className="notice">
                  Tickers showing “—” were added since the last signal run. Prices
                  fill in on the next run (weekdays after market close), or run
                  “Daily ETF signals” manually in GitHub Actions.
                </div>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ETF / Fund</th>
                      <th>Account</th>
                      <th>Institution</th>
                      <th className="num">Shares</th>
                      <th className="num">Price</th>
                      <th className="num">Value</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map(r => (
                      <tr key={r.id}>
                        <td>
                          {editingId === r.id ? (
                            <input
                              style={{ fontSize: 13, padding: '4px 6px', marginBottom: 4 }}
                              value={editFundName}
                              onChange={e => setEditFundName(e.target.value)}
                              placeholder="Fund name (optional)"
                            />
                          ) : r.fund_name ? (
                            <>
                              {r.fund_name}<br /><span className="muted">{displayTicker(r.ticker)}</span>
                              {r.priceOnly && (
                                <><br /><span className="tag priceonly" title="This fund's data source has no historical NAV, so it can't generate BUY/SELL signals — price and value are still tracked.">Price only · no signal</span></>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="ticker">{displayTicker(r.ticker)}</span>
                              {r.priceOnly && (
                                <><br /><span className="tag priceonly" title="This fund's data source has no historical NAV, so it can't generate BUY/SELL signals — price and value are still tracked.">Price only · no signal</span></>
                              )}
                            </>
                          )}
                        </td>
                        <td>
                          {editingId === r.id ? (
                            <select
                              style={{ fontSize: 13, padding: '4px 6px', width: 'auto' }}
                              value={editAccount}
                              onChange={e => setEditAccount(e.target.value)}
                            >
                              {ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
                            </select>
                          ) : (
                            <span className="tag acct">{acctLabel(r.account)}</span>
                          )}
                        </td>
                        <td>
                          {editingId === r.id ? (
                            <select
                              style={{ fontSize: 13, padding: '4px 6px', width: 'auto' }}
                              value={editInstitution}
                              onChange={e => setEditInstitution(e.target.value)}
                            >
                              {INSTITUTIONS.map(i => <option key={i.code} value={i.code}>{i.label}</option>)}
                            </select>
                          ) : (
                            <span className="tag acct">{instShort(r.institution)}</span>
                          )}
                        </td>
                        <td className="num">
                          {editingId === r.id ? (
                            <input
                              style={{ width: 80, fontSize: 14, padding: '4px 6px' }}
                              value={editShares}
                              onChange={e => setEditShares(e.target.value)}
                              inputMode="decimal"
                              autoFocus
                            />
                          ) : r.shares}
                        </td>
                        <td className="num">{r.price != null ? fmtCad.format(r.price) : '—'}{r.price != null && !isCad(r) ? ` ${r.currency}` : ''}</td>
                        <td className="num">
                          {r.value != null ? fmtCad.format(r.value) : '—'}{r.value != null && !isCad(r) ? ` ${r.currency}` : ''}
                          {r.cost != null && (
                            <>
                              <br />
                              <span className="muted" title={`Cost basis (ACB)${r.cost_source ? `, ${r.cost_source}` : ''}${r.book_cost_date ? ` as of ${r.book_cost_date}` : ''}`}>
                                ACB {r.cost_source === 'estimated' ? '~' : ''}{fmtCad.format(r.cost)}
                              </span>
                            </>
                          )}
                          {r.gain != null && (
                            <>
                              <br />
                              <span style={{ color: gainColor(r.gain), fontFamily: 'var(--mono)', fontSize: 12 }}>
                                {fmtGain(r.gain)}{r.cost > 0 ? ` (${r.gain >= 0 ? '+' : ''}${((r.gain / r.cost) * 100).toFixed(1)}%)` : ''}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          {editingId === r.id ? (
                            <button className="btn small" onClick={() => saveEdit(r.id)}>Save</button>
                          ) : (
                            <button className="btn small secondary" onClick={() => { setEditingId(r.id); setEditShares(String(r.shares)); setEditAccount(r.account || 'NON_REG'); setEditInstitution(r.institution || 'WEALTHSIMPLE'); setEditFundName(r.fund_name || '') }}>Edit</button>
                          )}
                          {' '}
                          <button className="btn small warn" onClick={() => remove(r.id, r.ticker, r.account)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {anyPrice && (
                <>
                  {acctFilter === 'ALL' && instFilter === 'ALL' && accountTotals.length > 1 && accountTotals.map(a => (
                    <div key={a.code} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span className="muted">{a.label}</span>
                      <span className="muted" style={{ fontFamily: 'var(--mono)' }}>{fmtCad.format(a.value)}</span>
                    </div>
                  ))}
                  <div className="total-line">
                    <div>
                      <div className="field-label" style={{ margin: 0 }}>{totalLabel}</div>
                      {lastEtfUpdated && <span className="muted">ETF prices updated {fmtTime(lastEtfUpdated)}</span>}
                      {lastFundNavDate && <div className="muted">fund NAVs as of {fmtNavDate(lastFundNavDate)} close</div>}
                    </div>
                    <span className="amt">{fmtCad.format(total)}</span>
                  </div>
                  {usdCount > 0 && (
                    <div className="muted" style={{ marginTop: 6 }}>
                      {usdCount} USD-priced holding{usdCount === 1 ? ' is' : 's are'} shown in USD and left out of the CAD totals.
                    </div>
                  )}
                  {anyCost && (
                    <div style={{ marginTop: 14 }}>
                      <div className="field-label" style={{ margin: 0 }}>Gain / loss vs cost (ACB)</div>
                      {costSummary.filter(c => c.count > 0).map(c => (
                        <div key={c.label} style={{ padding: '6px 0', borderBottom: '1px solid var(--ledger-line)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 13 }}>{c.label}</span>
                            <span style={{ color: gainColor(c.gain), fontFamily: 'var(--mono)', fontWeight: 700 }}>
                              {fmtGain(c.gain)}{c.pct != null ? ` (${c.gain >= 0 ? '+' : ''}${c.pct.toFixed(1)}%)` : ''}
                            </span>
                          </div>
                          <div className="muted">
                            {fmtCad.format(c.value)} now vs {fmtCad.format(c.cost)} cost · {c.count} holding{c.count === 1 ? '' : 's'}
                            {c.without > 0 ? ` · ${c.without} without a cost yet` : ''}
                            {c.estimated > 0 ? ` · ${c.estimated} with an estimated cost` : ''}
                          </div>
                        </div>
                      ))}
                      <div className="muted" style={{ marginTop: 6 }}>
                        Gain = today's value minus cost. Inside an RRSP or TFSA this is performance only — it isn't a taxable gain.
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {!loading && rows.length > 0 && anyPrice && (
          <div className="card">
            <h2>Send to retirement planner</h2>
            <p className="muted">
              Today’s market value per account, plus the non-registered gain against
              your ACB, in the format your retirement planner imports. Everything is
              read from the holdings above; nothing is uploaded.
            </p>
            {hasUsd && (
              <div style={{ marginBottom: 10 }}>
                <label className="field-label">USD → CAD rate (for your US-listed holdings)</label>
                <input
                  value={usdCad}
                  onChange={e => changeUsdCad(e.target.value)}
                  inputMode="decimal"
                  style={{ maxWidth: 120 }}
                />
              </div>
            )}
            {PLANNER_ROWS.map(a => {
              const acc = plannerExport.accounts[a.code]
              if (!acc.holdings) return null
              return (
                <div key={a.code} style={{ padding: '6px 0', borderBottom: '1px solid var(--ledger-line)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13 }}>{a.label}</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{fmtCad.format(acc.marketValue)}</span>
                  </div>
                  {a.code === 'NON_REG' && plannerExport.planner.nonRegCapitalGainsPct != null && (
                    <div className="muted">
                      ACB {fmtCad.format(acc.acb)} · unrealized gain {fmtGain(acc.gain)} ·
                      <strong> {plannerExport.planner.nonRegCapitalGainsPct}% of its value</strong> is gain
                    </div>
                  )}
                </div>
              )
            })}
            {plannerExport.warnings.map((w, i) => <div key={i} className="notice" style={{ marginTop: 8 }}>{w}</div>)}
            <div className="muted" style={{ marginTop: 8 }}>{plannerExport.notTracked}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn" onClick={copyPlannerExport}>Copy for planner</button>
              <button className="btn secondary" onClick={downloadPlannerExport}>Download .json</button>
            </div>
            {exportNote && <div className="muted" style={{ marginTop: 8 }}>{exportNote}</div>}
            <textarea
              id="plannerExportBox"
              readOnly
              value={plannerJson}
              style={{ width: '100%', height: 90, marginTop: 10, fontFamily: 'var(--mono)', fontSize: 11 }}
            />
          </div>
        )}
      </main>
    </>
  )
}
