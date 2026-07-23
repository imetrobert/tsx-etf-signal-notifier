import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeTicker, displayTicker, fmtCad } from '../lib/tickers'
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
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editShares, setEditShares] = useState('')
  const [editAccount, setEditAccount] = useState('NON_REG')
  const [editInstitution, setEditInstitution] = useState('WEALTHSIMPLE')
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
      .upsert({ ticker: sym, shares: qty, account, institution }, { onConflict: 'ticker,account,institution' })
    if (error) setError(error.message)
    else { setTicker(''); setShares(''); await load() }
    setSaving(false)
  }

  async function saveEdit(id) {
    const qty = parseFloat(editShares)
    if (!(qty > 0)) return
    const { error } = await supabase
      .from('etf_holdings')
      .update({ shares: qty, account: editAccount, institution: editInstitution, updated_at: new Date().toISOString() })
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
    return { ...h, price: p?.price ?? null, priceDate: p?.price_date ?? null, value: p?.price != null ? p.price * h.shares : null }
  })
  const shownRows = rows.filter(r =>
    (acctFilter === 'ALL' || r.account === acctFilter) &&
    (instFilter === 'ALL' || r.institution === instFilter)
  )
  const total = shownRows.reduce((s, r) => s + (r.value ?? 0), 0)
  const anyPrice = shownRows.some(r => r.price != null)
  const accountTotals = ACCOUNTS
    .map(a => ({ ...a, value: rows.filter(r => r.account === a.code).reduce((s, r) => s + (r.value ?? 0), 0) }))
    .filter(a => a.value > 0)
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
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add'}</button>
          </form>
          <div className="muted" style={{ marginTop: 8 }}>
            Plain tickers get the TSX suffix automatically (XEQT → XEQT.TO). Re-adding a
            ticker in the same account updates its share count. Signal advice assumes your
            TFSA and RRSP are maxed out (sell-to-buy in registered accounts).
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
                        <td><span className="ticker">{displayTicker(r.ticker)}</span></td>
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
                        <td className="num">{r.price != null ? fmtCad.format(r.price) : '—'}</td>
                        <td className="num">{r.value != null ? fmtCad.format(r.value) : '—'}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          {editingId === r.id ? (
                            <button className="btn small" onClick={() => saveEdit(r.id)}>Save</button>
                          ) : (
                            <button className="btn small secondary" onClick={() => { setEditingId(r.id); setEditShares(String(r.shares)); setEditAccount(r.account || 'NON_REG'); setEditInstitution(r.institution || 'WEALTHSIMPLE') }}>Edit</button>
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
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  )
}
