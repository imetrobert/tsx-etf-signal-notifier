import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtCad } from '../lib/tickers'
import { parseBellText, pensionChecks, pensionMetrics } from '../lib/bellPension'
import { readImageText } from '../lib/ocr'
import Navbar from './Navbar'

const today = () => new Date().toISOString().slice(0, 10)
const toNum = s => {
  const n = Number(String(s ?? '').replace(/[$,\s]/g, ''))
  return String(s ?? '').trim() === '' || Number.isNaN(n) ? null : n
}
const money = n => (n == null ? '—' : fmtCad.format(n))
const pct = n => (n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`)
const blankType = label => ({ label, units: '', marketValue: '', opening: '', contributions: '', earnings: '', derived: false })

// Form values are strings so typing isn't fought; these turn them back into numbers.
const numericTypes = types => types.map(t => ({
  label: t.label.trim(), derived: !!t.derived,
  units: toNum(t.units), marketValue: toNum(t.marketValue),
  opening: toNum(t.opening), contributions: toNum(t.contributions), earnings: toNum(t.earnings),
}))
const stringTypes = types => types.map(t => ({
  label: t.label || '', derived: !!t.derived,
  units: t.units == null ? '' : String(t.units), marketValue: t.marketValue == null ? '' : String(t.marketValue),
  opening: t.opening == null ? '' : String(t.opening), contributions: t.contributions == null ? '' : String(t.contributions),
  earnings: t.earnings == null ? '' : String(t.earnings),
}))

const FIELDS = [
  ['units', 'Units'], ['marketValue', 'Market value'], ['opening', 'Opening balance'],
  ['contributions', 'Contributions'], ['earnings', 'Investment earnings'],
]

export default function Pension() {
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stage, setStage] = useState('idle') // idle | reading | review
  const [progress, setProgress] = useState(0)
  const [pasteText, setPasteText] = useState('')
  const [notes, setNotes] = useState([])
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { data, error } = await supabase.from('etf_pension_snapshots').select('*').order('snapshot_date', { ascending: false })
    if (error) setError(`${error.message} — push supabase/schema.sql so the table exists.`)
    else setSnapshots(data || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const latest = snapshots[0] || null
  const latestMetrics = latest
    ? pensionMetrics({ snapshotDate: latest.snapshot_date, periodStart: latest.period_start, types: latest.types || [] })
    : null

  function startReview(text, source) {
    const r = parseBellText(text)
    setNotes(r.warnings)
    if (!r.ok) {
      // Leave the text in the box so it can be corrected and read again.
      setPasteText(text)
      setStage('idle')
      return
    }
    setForm({
      source, snapshotDate: today(), periodStart: `${new Date().getFullYear()}-01-01`,
      fundName: r.fundName, types: stringTypes(r.types),
    })
    setStage('review')
  }

  async function onPickImage(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(''); setSaved(''); setNotes([]); setProgress(0); setStage('reading')
    try {
      const text = await readImageText(file, p => setProgress(p))
      startReview(text, 'screenshot')
    } catch (err) {
      setStage('idle')
      setError(`Couldn't read that screenshot (${err.message}). You can paste the page's text below, or enter the figures by hand.`)
    }
  }

  function startManual() {
    setSaved(''); setNotes([])
    setForm({ source: 'manual', snapshotDate: today(), periodStart: `${new Date().getFullYear()}-01-01`, fundName: '', types: [blankType('Employee'), blankType('Company')] })
    setStage('review')
  }

  const setType = (i, key, value) => setForm(f => ({ ...f, types: f.types.map((t, j) => (j === i ? { ...t, [key]: value } : t)) }))

  async function save() {
    const types = numericTypes(form.types).filter(t => t.marketValue != null)
    if (!types.length) { setError('Enter at least one market value.'); return }
    if (form.snapshotDate > today()) { setError('The snapshot date can’t be in the future.'); return }
    setSaving(true); setError('')
    const totalValue = Math.round(types.reduce((s, t) => s + t.marketValue, 0) * 100) / 100
    const { error } = await supabase.from('etf_pension_snapshots').upsert({
      plan: 'BELL_DC', snapshot_date: form.snapshotDate, period_start: form.periodStart || null,
      fund_name: form.fundName.trim() || null, total_value: totalValue,
      total_units: types.every(t => t.units > 0) ? types.reduce((s, t) => s + t.units, 0) : null,
      types, source: form.source,
    }, { onConflict: 'plan,snapshot_date' })
    setSaving(false)
    if (error) { setError(error.message); return }
    setSaved(`Saved the ${form.snapshotDate} snapshot — ${money(totalValue)}.`)
    setStage('idle'); setForm(null); setPasteText('')
    await load()
  }

  async function remove(id) {
    if (!window.confirm('Delete this snapshot?')) return
    const { error } = await supabase.from('etf_pension_snapshots').delete().eq('id', id)
    if (error) setError(error.message)
    else await load()
  }

  const liveTypes = form ? numericTypes(form.types) : []
  const liveChecks = form ? pensionChecks({ types: liveTypes.filter(t => t.marketValue != null), total: null }) : []
  const liveMetrics = form
    ? pensionMetrics({ snapshotDate: form.snapshotDate, periodStart: form.periodStart, types: liveTypes.filter(t => t.marketValue != null) })
    : null

  return (
    <>
      <Navbar subtitle="Bell DC pension" />
      <main>
        {error && <div className="err">{error}</div>}
        {saved && <div className="notice">{saved}</div>}

        <div className="card">
          <h2>Bell DC pension</h2>
          {loading ? (
            <div className="empty"><span className="spin" /></div>
          ) : !latest ? (
            <p className="muted">No snapshot yet. Add one below from a screenshot of your Bell Benefits page.</p>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--mono)' }}>{money(latestMetrics.totalValue)}</span>
                <span className="muted">as of {latest.snapshot_date}</span>
              </div>
              <div className="muted">
                {latest.fund_name || 'Fund'}
                {latestMetrics.totalUnits ? ` · ${latestMetrics.totalUnits.toLocaleString()} units` : ''}
                {latestMetrics.unitPrice ? ` @ ${latestMetrics.unitPrice.toFixed(4)}` : ''}
              </div>
              {(latest.types || []).map(t => (
                <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--ledger-line)' }}>
                  <span style={{ fontSize: 13 }}>{t.label || 'Contributions'}</span>
                  <span style={{ fontFamily: 'var(--mono)' }}>{money(t.marketValue)}</span>
                </div>
              ))}
              {latestMetrics.contributions != null && (
                <div className="muted" style={{ marginTop: 8 }}>
                  Since {latest.period_start || '—'}: {money(latestMetrics.contributions)} contributed
                  {latestMetrics.employeeContributions != null && latestMetrics.companyContributions != null
                    ? ` (you ${money(latestMetrics.employeeContributions)}, Bell ${money(latestMetrics.companyContributions)})` : ''}
                  {latestMetrics.earnings != null ? `, ${money(latestMetrics.earnings)} earned` : ''}.
                  {latestMetrics.periodReturn != null && ` Return ≈ ${pct(latestMetrics.periodReturn)} over the period${latestMetrics.annualizedReturn != null ? ` (≈ ${pct(latestMetrics.annualizedReturn)}/yr)` : ''}.`}
                </div>
              )}
              {latestMetrics.annualContribution != null && (
                <div className="muted">Sent to the planner as about {money(latestMetrics.annualContribution)} a year in contributions.</div>
              )}
              {latestMetrics.ageDays > 400 && (
                <div className="notice" style={{ marginTop: 8 }}>This snapshot is over a year old — add a fresh one so the planner uses a current value.</div>
              )}
            </>
          )}
        </div>

        <div className="card">
          <h2>{stage === 'review' ? 'Check the figures' : 'Add a snapshot'}</h2>

          {stage !== 'review' && (
            <>
              <p className="muted">
                Take a screenshot of your Bell Benefits page showing the fund and the contribution-type
                breakdown, then choose it here. It’s read on this device — the image is never uploaded.
                The first time, the reading engine downloads once (about 10 MB).
              </p>
              <input type="file" accept="image/*" onChange={onPickImage} disabled={stage === 'reading'} />
              {stage === 'reading' && (
                <div className="muted" style={{ marginTop: 8 }}>
                  <span className="spin" /> Reading the screenshot… {Math.round(progress * 100)}%
                </div>
              )}
              <details style={{ marginTop: 12 }} open={!!pasteText}>
                <summary className="muted" style={{ cursor: 'pointer' }}>Or paste the page’s text</summary>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder="Select the table on the Bell Benefits page, copy it, and paste here"
                  style={{ width: '100%', height: 100, marginTop: 8, fontSize: 12 }}
                />
                <button className="btn small" style={{ marginTop: 6 }} disabled={!pasteText.trim()} onClick={() => startReview(pasteText, 'paste')}>
                  Read this text
                </button>
              </details>
              <div style={{ marginTop: 12 }}>
                <button className="btn small secondary" onClick={startManual}>Enter the figures by hand</button>
              </div>
              {notes.map((n, i) => <div key={i} className="notice" style={{ marginTop: 8 }}>{n}</div>)}
            </>
          )}

          {stage === 'review' && form && (
            <>
              {notes.map((n, i) => <div key={i} className="notice" style={{ marginBottom: 8 }}>{n}</div>)}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <label className="field-label">Figures as of</label>
                  <input type="date" value={form.snapshotDate} max={today()} onChange={e => setForm(f => ({ ...f, snapshotDate: e.target.value }))} />
                </div>
                <div>
                  <label className="field-label">Contributions cover from</label>
                  <input type="date" value={form.periodStart} onChange={e => setForm(f => ({ ...f, periodStart: e.target.value }))} />
                </div>
              </div>
              <div className="muted" style={{ margin: '4px 0 8px' }}>
                The page’s own period isn’t in the screenshot, so set when the contributions column starts
                (often January 1). It’s used to scale them to a full year for the planner.
              </div>
              <label className="field-label">Fund</label>
              <input value={form.fundName} onChange={e => setForm(f => ({ ...f, fundName: e.target.value }))} style={{ width: '100%' }} />

              {form.types.map((t, i) => (
                <div key={i} style={{ marginTop: 12, padding: 10, border: '1px solid var(--ledger-line)', borderRadius: 6 }}>
                  <label className="field-label">Contribution type{t.derived ? ' (worked out as total − the others)' : ''}</label>
                  <input value={t.label} onChange={e => setType(i, 'label', e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {FIELDS.map(([key, label]) => (
                      <div key={key}>
                        <label className="field-label">{label}</label>
                        <input value={t[key]} inputMode="decimal" onChange={e => setType(i, key, e.target.value)} style={{ width: '100%' }} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <button className="btn small secondary" style={{ marginTop: 8 }} onClick={() => setForm(f => ({ ...f, types: [...f.types, blankType('')] }))}>
                + Add a contribution type
              </button>

              <div style={{ marginTop: 12 }}>
                {liveChecks.map((c, i) => (
                  <div key={i} style={{ fontSize: 12, color: c.ok ? 'var(--ok)' : 'var(--accent)' }}>{c.ok ? '✓' : '⚠'} {c.text}</div>
                ))}
              </div>
              {liveMetrics && liveMetrics.totalValue > 0 && (
                <div className="muted" style={{ marginTop: 8 }}>
                  Total {money(liveMetrics.totalValue)}
                  {liveMetrics.annualContribution != null ? ` · about ${money(liveMetrics.annualContribution)} a year in contributions` : ''}
                  {liveMetrics.annualizedReturn != null ? ` · ≈ ${pct(liveMetrics.annualizedReturn)}/yr return` : ''}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save snapshot'}</button>
                <button className="btn secondary" onClick={() => { setStage('idle'); setForm(null) }}>Cancel</button>
              </div>
            </>
          )}
        </div>

        {snapshots.length > 1 && (
          <div className="card">
            <h2>History</h2>
            {snapshots.map(s => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--ledger-line)' }}>
                <span>{s.snapshot_date}</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{money(Number(s.total_value))}</span>
                <button className="btn small secondary" onClick={() => remove(s.id)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
