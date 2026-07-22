import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeTicker, displayTicker, fmtCad } from '../lib/tickers'
import Navbar from './Navbar'

export default function Watchlist() {
  const [items, setItems] = useState([])
  const [prices, setPrices] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ticker, setTicker] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [w, p] = await Promise.all([
      supabase.from('etf_watchlist').select('*').order('ticker'),
      supabase.from('etf_prices').select('*'),
    ])
    if (w.error) { setError(w.error.message); setLoading(false); return }
    setItems(w.data || [])
    const priceMap = {}
    for (const row of p.data || []) priceMap[row.ticker] = row
    setPrices(priceMap)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function add(e) {
    e.preventDefault()
    const sym = normalizeTicker(ticker)
    if (!sym) return
    setSaving(true)
    setError('')
    const { error } = await supabase.from('etf_watchlist').upsert({ ticker: sym }, { onConflict: 'ticker' })
    if (error) setError(error.message)
    else { setTicker(''); await load() }
    setSaving(false)
  }

  async function remove(id, sym) {
    if (!window.confirm(`Remove ${displayTicker(sym)} from the watchlist?`)) return
    const { error } = await supabase.from('etf_watchlist').delete().eq('id', id)
    if (error) setError(error.message)
    await load()
  }

  return (
    <>
      <Navbar subtitle="ETFs monitored beyond your holdings" />
      <main>
        <div className="card">
          <h2>Add to watchlist</h2>
          <form className="form-row" onSubmit={add}>
            <div>
              <label className="field-label">TSX ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value)} placeholder="e.g. VDY" autoCapitalize="characters" autoCorrect="off" />
            </div>
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add'}</button>
          </form>
          {error && <div className="err">{error}</div>}
        </div>

        <div className="card">
          <h2>Watched ETFs</h2>
          {loading ? (
            <div className="empty"><span className="spin" /></div>
          ) : items.length === 0 ? (
            <div className="empty">Nothing on the watchlist yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ETF</th>
                    <th className="num">Price</th>
                    <th className="num">vs 200-day</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(w => {
                    const p = prices[w.ticker]
                    return (
                      <tr key={w.id}>
                        <td><span className="ticker">{displayTicker(w.ticker)}</span></td>
                        <td className="num">{p?.price != null ? fmtCad.format(p.price) : '—'}</td>
                        <td className="num">
                          {p?.pct_vs_ma200 != null
                            ? `${p.pct_vs_ma200 > 0 ? '+' : ''}${Number(p.pct_vs_ma200).toFixed(1)}%`
                            : '—'}
                        </td>
                        <td className="num">
                          <button className="btn small warn" onClick={() => remove(w.id, w.ticker)}>✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="muted" style={{ marginTop: 10 }}>
            Your holdings are always monitored for signals — this list adds extra ETFs on top.
          </div>
        </div>
      </main>
    </>
  )
}
