import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeTicker, displayTicker, fmtCad } from '../lib/tickers'
import Navbar from './Navbar'

export default function Dashboard() {
  const [holdings, setHoldings] = useState([])
  const [prices, setPrices] = useState({})
  const [regime, setRegime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ticker, setTicker] = useState('')
  const [shares, setShares] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editShares, setEditShares] = useState('')

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

  async function addHolding(e) {
    e.preventDefault()
    const sym = normalizeTicker(ticker)
    const qty = parseFloat(shares)
    if (!sym || !(qty > 0)) return
    setSaving(true)
    setError('')
    const { error } = await supabase
      .from('etf_holdings')
      .upsert({ ticker: sym, shares: qty }, { onConflict: 'ticker' })
    if (error) setError(error.message)
    else { setTicker(''); setShares(''); await load() }
    setSaving(false)
  }

  async function saveShares(id) {
    const qty = parseFloat(editShares)
    if (!(qty > 0)) return
    const { error } = await supabase.from('etf_holdings').update({ shares: qty, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) setError(error.message)
    setEditingId(null)
    await load()
  }

  async function remove(id, sym) {
    if (!window.confirm(`Remove ${displayTicker(sym)} from holdings?`)) return
    const { error } = await supabase.from('etf_holdings').delete().eq('id', id)
    if (error) setError(error.message)
    await load()
  }

  const rows = holdings.map(h => {
    const p = prices[h.ticker]
    return { ...h, price: p?.price ?? null, priceDate: p?.price_date ?? null, value: p?.price != null ? p.price * h.shares : null }
  })
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0)
  const anyPrice = rows.some(r => r.price != null)
  const lastUpdated = Object.values(prices).map(p => p.updated_at).sort().pop()
  const lastUpdatedText = lastUpdated
    ? new Date(lastUpdated).toLocaleString('en-CA', {
        timeZone: 'America/Toronto',
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

  return (
    <>
      <Navbar subtitle="Notification-only — never places trades" />
      <main>
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
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add'}</button>
          </form>
          <div className="muted" style={{ marginTop: 8 }}>
            Plain tickers get the TSX suffix automatically (XEQT → XEQT.TO). Re-adding a ticker updates its share count.
          </div>
          {error && <div className="err">{error}</div>}
        </div>

        <div className="card">
          <h2>My holdings</h2>
          {loading ? (
            <div className="empty"><span className="spin" /></div>
          ) : rows.length === 0 ? (
            <div className="empty">No holdings yet — add your first ETF above.</div>
          ) : (
            <>
              {rows.some(r => r.price == null) && (
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
                      <th>ETF</th>
                      <th className="num">Shares</th>
                      <th className="num">Price</th>
                      <th className="num">Value</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id}>
                        <td><span className="ticker">{displayTicker(r.ticker)}</span></td>
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
                            <button className="btn small" onClick={() => saveShares(r.id)}>Save</button>
                          ) : (
                            <button className="btn small secondary" onClick={() => { setEditingId(r.id); setEditShares(String(r.shares)) }}>Edit</button>
                          )}
                          {' '}
                          <button className="btn small warn" onClick={() => remove(r.id, r.ticker)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {anyPrice && (
                <div className="total-line">
                  <div>
                    <div className="field-label" style={{ margin: 0 }}>Portfolio value</div>
                    {lastUpdatedText && <span className="muted">prices updated {lastUpdatedText}</span>}
                  </div>
                  <span className="amt">{fmtCad.format(total)}</span>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </>
  )
}
