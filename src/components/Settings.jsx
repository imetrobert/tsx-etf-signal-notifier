import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Navbar from './Navbar'

export default function Settings() {
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { data, error } = await supabase.from('etf_settings').select('*').eq('id', 1).maybeSingle()
    if (error) setError(error.message)
    else setEnabled(data ? data.email_alerts_enabled : true)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggle() {
    const next = !enabled
    setEnabled(next) // optimistic
    setSaving(true)
    setError('')
    const { error } = await supabase
      .from('etf_settings')
      .upsert({ id: 1, email_alerts_enabled: next, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    if (error) { setError(error.message); setEnabled(!next) }
    setSaving(false)
  }

  return (
    <>
      <Navbar subtitle="Notification-only — never places trades" />
      <main>
        <div className="card">
          <h2>Notifications</h2>
          {loading ? (
            <div className="empty"><span className="spin" /></div>
          ) : (
            <>
              <label className="toggle-row">
                <span>
                  <strong>Email signal alerts</strong>
                  <div className="muted" style={{ marginTop: 2 }}>
                    When off, the daily job still runs — prices refresh and
                    signals still appear on the Signals tab — it just won't
                    email you.
                  </div>
                </span>
                <span
                  role="switch"
                  aria-checked={enabled}
                  className={`switch${enabled ? ' on' : ''}`}
                  onClick={toggle}
                >
                  <span className="switch-knob" />
                </span>
              </label>
              {saving && <div className="muted" style={{ marginTop: 8 }}>Saving…</div>}
              {error && <div className="err">{error}</div>}
            </>
          )}
        </div>
      </main>
    </>
  )
}
