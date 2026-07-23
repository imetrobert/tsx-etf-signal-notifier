import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { displayTicker, fmtCad } from '../lib/tickers'
import Navbar from './Navbar'

const ACCOUNT_LABEL = { TFSA: 'TFSA', RRSP: 'RRSP', LIRA: 'Locked-in RRSP', NON_REG: 'Non-registered' }

function draftAdvisorEmail(signal, holdings) {
  const name = holdings.find(h => h.fund_name)?.fund_name || displayTicker(signal.ticker)
  const accounts = [...new Set(holdings.map(h => ACCOUNT_LABEL[h.account] || h.account))]
  const totalShares = holdings.reduce((s, h) => s + Number(h.shares), 0)
  const dir = signal.signal === 'BUY' ? 'BUY' : 'SELL/TRIM'
  const subject = `${dir} signal on ${name} — your thoughts?`
  const lines = [
    'Hi Brad,',
    '',
    `My portfolio tracker flagged a ${dir} signal on ${name} (${signal.ticker}), which I hold in my ` +
      `${accounts.join(' and ')} account${accounts.length > 1 ? 's' : ''} at Manulife Wealth (${totalShares} units total).`,
    '',
    `Signal reasoning: ${signal.reasons}`,
  ]
  if (signal.est_recovery_text) lines.push('', signal.est_recovery_text)
  if (signal.account_advice) lines.push('', signal.account_advice)
  lines.push(
    '',
    'Wanted to get your read before doing anything — does this make sense given the rest of my portfolio? Let me know what you think.',
    '',
    'Thanks,',
    'Robert',
  )
  return { subject, body: lines.join('\n') }
}

export default function SignalHistory() {
  const [signals, setSignals] = useState([])
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [openEmailId, setOpenEmailId] = useState(null)
  const [copiedId, setCopiedId] = useState(null)

  const load = useCallback(async () => {
    setError('')
    const [s, h] = await Promise.all([
      supabase.from('etf_signals').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('etf_holdings').select('ticker, account, institution, fund_name, shares'),
    ])
    if (s.error) setError(s.error.message)
    else setSignals(s.data || [])
    setHoldings(h.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  async function copyEmail(id, subject, body) {
    const text = `Subject: ${subject}\n\n${body}`
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(c => (c === id ? null : c)), 2000)
    } catch {
      // clipboard API unavailable — the textarea below is still selectable manually
    }
  }

  return (
    <>
      <Navbar subtitle="Every alert the daily check has fired" onRefresh={refresh} refreshing={refreshing} />
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
            signals.map(s => {
              const manulifeHoldings = holdings.filter(h => h.ticker === s.ticker && h.institution === 'MANULIFE')
              const isOpen = openEmailId === s.id
              const { subject, body } = isOpen || manulifeHoldings.length
                ? draftAdvisorEmail(s, manulifeHoldings)
                : { subject: '', body: '' }
              return (
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
                  {s.account_advice && <div className="signal-meta" style={{ color: 'var(--ledger)' }}>{s.account_advice}</div>}
                  {manulifeHoldings.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="btn small secondary"
                        onClick={() => setOpenEmailId(isOpen ? null : s.id)}
                      >
                        {isOpen ? 'Hide advisor email' : '✉ Draft email to Brad'}
                      </button>
                      {isOpen && (
                        <div className="email-draft">
                          <div className="field-label" style={{ margin: '10px 0 3px' }}>Subject</div>
                          <div className="signal-reasons">{subject}</div>
                          <div className="field-label" style={{ margin: '10px 0 3px' }}>Body</div>
                          <textarea readOnly value={body} rows={10} onFocus={e => e.target.select()} />
                          <button className="btn small" style={{ marginTop: 8 }} onClick={() => copyEmail(s.id, subject, body)}>
                            {copiedId === s.id ? 'Copied!' : 'Copy to clipboard'}
                          </button>
                          <div className="muted" style={{ marginTop: 6 }}>
                            If copying doesn't work, tap the text box above to select it all manually.
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </main>
    </>
  )
}
