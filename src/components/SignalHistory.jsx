import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { displayTicker, fmtCad } from '../lib/tickers'
import Navbar from './Navbar'

export default function SignalHistory() {
  const [signals, setSignals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('etf_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setSignals(data || [])
        setLoading(false)
      })
  }, [])

  return (
    <>
      <Navbar subtitle="Every alert the daily check has fired" />
      <main>
        <div className="card">
          <h2>Signal history</h2>
          {error && <div className="err">{error}</div>}
          {loading ? (
            <div className="empty"><span className="spin" /></div>
          ) : signals.length === 0 ? (
            <div className="empty">
              No signals yet. The daily check only fires on strong setups —
              quiet is normal.
            </div>
          ) : (
            signals.map(s => (
              <div key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--ledger-line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span>
                    <span className="ticker">{displayTicker(s.ticker)}</span>{' '}
                    <span className={`tag ${s.signal === 'BUY' ? 'buy' : 'sell'}`}>{s.signal}</span>
                  </span>
                  <span className="muted">{new Date(s.created_at).toLocaleDateString('en-CA')}</span>
                </div>
                <div className="signal-reasons">{s.reasons}</div>
                <div className="signal-meta">
                  {s.price != null && <>Price at signal: {fmtCad.format(s.price)}. </>}
                  {s.est_recovery_text && <>{s.est_recovery_text}</>}
                </div>
              </div>
            ))
          )}
        </div>
      </main>
    </>
  )
}
