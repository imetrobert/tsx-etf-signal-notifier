import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeTicker, displayTicker, fmtCad } from '../lib/tickers'
import { parseStatementPdf, diffPositions, normalizeFundName } from '../lib/statementParser'
import Navbar from './Navbar'

const ACCOUNTS = [
  { code: 'TFSA', label: 'TFSA' },
  { code: 'RRSP', label: 'RRSP' },
  { code: 'LIRA', label: 'Locked-in RRSP' },
  { code: 'NON_REG', label: 'Non-registered' },
]
const acctLabel = code => ACCOUNTS.find(a => a.code === code)?.label ?? code

const ACTION_LABEL = { add: 'Add', adjust: 'Adjust', remove: 'Remove', none: 'Unchanged' }
const ACTION_TAG = { add: 'buy', adjust: 'watch', remove: 'sell', none: 'hold' }

const fmtUnits = n => Number(n).toLocaleString('en-CA', { maximumFractionDigits: 4 })

// A statement date is a plain date with no timezone — anchor it to midday so it
// can't slip to the previous day when rendered in a western timezone.
const fmtStatementDate = d => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
  : '—'
const fmtImportDate = iso => iso
  ? new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
  : '—'

export default function ImportStatement() {
  const [holdings, setHoldings] = useState([])
  const [fundMap, setFundMap] = useState({})
  const [imports, setImports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)
  const [fileName, setFileName] = useState('')
  const [statementDate, setStatementDate] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [sections, setSections] = useState([])
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)

  const load = useCallback(async () => {
    setError('')
    const [h, m, i] = await Promise.all([
      supabase.from('etf_holdings').select('*').eq('institution', 'MANULIFE'),
      supabase.from('etf_fund_map').select('*'),
      supabase.from('etf_statement_imports').select('*').order('created_at', { ascending: false }).limit(20),
    ])
    if (h.error) setError(h.error.message)
    setHoldings(h.data || [])
    // A missing table just means schema.sql hasn't been re-run — the import
    // still works, it just can't remember name → ticker mappings yet.
    const map = {}
    for (const row of m.data || []) map[row.norm_name] = { ticker: row.ticker, fund_name: row.fund_name }
    setFundMap(map)
    setImports(i.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setParsing(true)
    setError('')
    setResult(null)
    setSections([])
    setFileName(file.name)
    try {
      const parsed = await parseStatementPdf(await file.arrayBuffer())
      setStatementDate(parsed.statementDate)
      setWarnings(parsed.warnings)
      setSections(parsed.accounts.map(acct => {
        const mine = holdings.filter(h => (h.account || 'NON_REG') === acct.accountType)
        return {
          accountNumber: acct.accountNumber,
          accountLabel: acct.accountLabel,
          accountType: acct.accountType || '',
          statementTotal: acct.positions.reduce((s, p) => s + (p.marketValue || 0), 0),
          rows: diffPositions(acct.positions, acct.accountType ? mine : [], fundMap)
            .map(r => ({ ...r, include: r.action !== 'none' && !(r.action === 'add' && !r.ticker) })),
        }
      }))
    } catch (err) {
      setError(`Couldn't read that PDF: ${err.message}`)
      setSections([])
    }
    setParsing(false)
    e.target.value = '' // let the same file be picked again after a fix
  }

  // Changing the account type re-diffs that section against the holdings in the
  // newly chosen account.
  function setSectionAccount(idx, accountType) {
    setSections(prev => prev.map((s, i) => {
      if (i !== idx) return s
      const mine = holdings.filter(h => (h.account || 'NON_REG') === accountType)
      const positions = s.rows.filter(r => r.action !== 'remove')
        .map(r => ({ name: r.statementName, quantity: r.quantity, unitPrice: r.unitPrice, marketValue: r.marketValue }))
      const edited = new Map(s.rows.map(r => [r.key, r]))
      return {
        ...s,
        accountType,
        rows: diffPositions(positions, accountType ? mine : [], fundMap).map(r => {
          const before = edited.get(r.key)
          const ticker = before?.tickerEdited ? before.ticker : r.ticker
          return {
            ...r,
            ticker,
            tickerEdited: before?.tickerEdited,
            nickname: before?.nicknameEdited ? before.nickname : r.nickname,
            nicknameEdited: before?.nicknameEdited,
            include: r.action !== 'none' && !(r.action === 'add' && !ticker),
          }
        }),
      }
    }))
  }

  function updateRow(sIdx, key, patch) {
    setSections(prev => prev.map((s, i) => i !== sIdx ? s : {
      ...s,
      rows: s.rows.map(r => r.key !== key ? r : { ...r, ...patch }),
    }))
  }

  const pending = useMemo(
    () => sections.flatMap(s => s.rows.filter(r => r.include && r.action !== 'none')).length,
    [sections])
  const blocked = useMemo(
    () => sections.flatMap(s => s.rows.filter(r => r.action === 'add' && !r.ticker.trim())).length,
    [sections])
  const noAccount = sections.some(s => !s.accountType)

  const alreadyImported = statementDate
    ? imports.filter(i => i.statement_date === statementDate &&
        sections.some(s => s.accountNumber === i.account_number))
    : []

  // Most recent import run, and the newest statement any import has covered —
  // they differ when an older statement is imported after a newer one.
  const lastImport = imports[0] || null
  const lastStatementDate = imports.reduce(
    (latest, i) => (i.statement_date && (!latest || i.statement_date > latest) ? i.statement_date : latest), null)

  // Same pair per account, so it's obvious which account is a month behind.
  const perAccount = Object.values(imports.reduce((acc, i) => {
    const key = i.account_number || i.account_type || '—'
    const seen = acc[key]
    acc[key] = {
      key,
      accountType: seen?.accountType || i.account_type,
      statementDate: !seen || (i.statement_date || '') > (seen.statementDate || '') ? i.statement_date : seen.statementDate,
      importedAt: seen?.importedAt || i.created_at, // imports arrive newest first
    }
    return acc
  }, {}))

  // Importing a statement older than one already applied would roll holdings
  // back to that month's positions.
  const staleStatement = statementDate && lastStatementDate && statementDate < lastStatementDate
    ? lastStatementDate : null

  async function apply() {
    setApplying(true)
    setError('')
    const done = { added: 0, adjusted: 0, removed: 0 }
    const problems = []
    let remembered = true // false if etf_fund_map / etf_statement_imports are missing

    for (const section of sections) {
      if (!section.accountType) continue
      const applied = []
      for (const row of section.rows) {
        if (!row.include || row.action === 'none') continue
        const ticker = normalizeTicker(row.ticker)
        const nickname = row.nickname.trim() || null
        try {
          if (row.action === 'remove') {
            const { error } = await supabase.from('etf_holdings').delete().eq('id', row.holding.id)
            if (error) throw error
            done.removed++
          } else if (row.action === 'adjust') {
            const { error } = await supabase.from('etf_holdings')
              .update({ shares: row.quantity, fund_name: nickname, updated_at: new Date().toISOString() })
              .eq('id', row.holding.id)
            if (error) throw error
            done.adjusted++
          } else {
            if (!ticker) throw new Error('no ticker')
            const { error } = await supabase.from('etf_holdings').upsert({
              ticker, shares: row.quantity, account: section.accountType,
              institution: 'MANULIFE', fund_name: nickname,
            }, { onConflict: 'ticker,account,institution' })
            if (error) throw error
            done.added++
          }
          applied.push({ action: row.action, name: row.statementName, ticker, units: row.quantity })
        } catch (err) {
          problems.push(`${row.statementName}: ${err.message}`)
          continue
        }
        // Remembering the name → ticker link only saves typing next month, so
        // a missing etf_fund_map table must not fail an otherwise good import.
        if (ticker && row.action !== 'remove') {
          const { error } = await supabase.from('etf_fund_map').upsert({
            norm_name: normalizeFundName(row.statementName),
            statement_name: row.statementName,
            ticker, fund_name: nickname, updated_at: new Date().toISOString(),
          }, { onConflict: 'norm_name' })
          if (error) remembered = false
        }
      }
      if (applied.length) {
        const { error } = await supabase.from('etf_statement_imports').insert({
          statement_date: statementDate,
          account_number: section.accountNumber,
          account_type: section.accountType,
          institution: 'MANULIFE',
          file_name: fileName,
          summary: { applied },
        })
        if (error) remembered = false
      }
    }

    setResult({ ...done, problems, remembered })
    setSections([])
    await load()
    setApplying(false)
  }

  return (
    <>
      <Navbar subtitle="Import a Manulife statement to sync your holdings" />
      <main>
        <div className="card">
          <h2>Import statement</h2>
          <p className="muted">
            Attach the monthly PDF from Manulife Wealth. It's read on this
            device — the file is never uploaded anywhere — and every change is
            listed for you to approve before anything is saved. Once applied,
            the statement becomes your Manulife holdings for the accounts it
            covers: units are set to its numbers and funds it no longer lists
            are removed. Wealthsimple holdings and accounts absent from the PDF
            are never touched.
          </p>
          <div className="form-row" style={{ marginTop: 12 }}>
            <div>
              <label className="field-label">Last statement</label>
              <div className="stat-value">{fmtStatementDate(lastStatementDate)}</div>
              <div className="muted">Date on the newest statement imported</div>
            </div>
            <div>
              <label className="field-label">Last import</label>
              <div className="stat-value">{fmtImportDate(lastImport?.created_at)}</div>
              <div className="muted">
                {lastImport ? 'When it was applied here' : 'No statement imported yet'}
              </div>
            </div>
          </div>
          {perAccount.length > 1 && (
            <div style={{ marginTop: 8 }}>
              {perAccount.map(a => (
                <div key={a.key} className="signal-meta">
                  {a.accountType ? acctLabel(a.accountType) : a.key}: statement{' '}
                  {fmtStatementDate(a.statementDate)}, imported {fmtImportDate(a.importedAt)}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label className="field-label">Statement PDF</label>
            <input type="file" accept="application/pdf" onChange={onFile} disabled={parsing || loading} />
          </div>
          {parsing && <div className="muted" style={{ marginTop: 10 }}><span className="spin" /> Reading the statement…</div>}
          {error && <div className="err">{error}</div>}
          {warnings.length > 0 && sections.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          {sections.length > 0 && statementDate && (
            <div className="signal-reasons" style={{ marginTop: 10 }}>
              This statement is dated <strong>{fmtStatementDate(statementDate)}</strong>.
            </div>
          )}
          {alreadyImported.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              A statement dated {fmtStatementDate(statementDate)} for this account was already
              imported on {fmtImportDate(alreadyImported[0].created_at)}. Applying it again is
              harmless — units are set to the statement's values, not added to them.
            </div>
          )}
          {staleStatement && (
            <div className="notice" style={{ marginTop: 10 }}>
              This statement is older than the one you already imported
              ({fmtStatementDate(staleStatement)}). Applying it would roll your Manulife
              holdings back to {fmtStatementDate(statementDate)} — check you picked the
              right PDF.
            </div>
          )}
        </div>

        {result && (
          <div className="card">
            <h2>Import applied</h2>
            <div className="signal-reasons">
              {result.added} added, {result.adjusted} adjusted, {result.removed} removed.
            </div>
            {result.problems.length > 0 && (
              <div className="err">
                {result.problems.length} row(s) failed:
                {result.problems.map((p, i) => <div key={i}>{p}</div>)}
              </div>
            )}
            {!result.remembered && (
              <div className="notice">
                Your holdings were updated, but the tickers you entered couldn't
                be remembered for next month — re-run supabase/schema.sql to
                add the etf_fund_map and etf_statement_imports tables.
              </div>
            )}
            <div className="muted" style={{ marginTop: 6 }}>
              New funds won't show a price or signal until the next daily run
              picks them up.
            </div>
          </div>
        )}

        {sections.map((section, sIdx) => {
          const changes = section.rows.filter(r => r.action !== 'none')
          return (
            <div className="card" key={section.accountNumber}>
              <h2>
                {section.accountLabel || 'Account'} {section.accountNumber}
                {statementDate ? ` · ${statementDate}` : ''}
              </h2>
              <div className="form-row" style={{ marginBottom: 10 }}>
                <div>
                  <label className="field-label">Account in this app</label>
                  <select value={section.accountType} onChange={e => setSectionAccount(sIdx, e.target.value)}>
                    <option value="">Choose…</option>
                    {ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Statement value</label>
                  <div className="signal-reasons" style={{ fontFamily: 'var(--mono)' }}>
                    {fmtCad.format(section.statementTotal)}
                  </div>
                </div>
              </div>
              {!section.accountType && (
                <div className="notice">
                  Pick which account this is before importing — it decides which
                  holdings are compared, adjusted and removed.
                </div>
              )}
              {section.accountType && changes.length === 0 && (
                <div className="empty">
                  Nothing changed — every fund on this statement already matches
                  your {acctLabel(section.accountType)} holdings.
                </div>
              )}
              {section.accountType && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 26 }}></th>
                        <th>Fund</th>
                        <th className="num">Units</th>
                        <th>Ticker</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...section.rows].sort((a, b) =>
                        (a.action === 'none' ? 1 : 0) - (b.action === 'none' ? 1 : 0)
                      ).map(row => {
                        const needsTicker = row.action === 'add' && !row.ticker.trim()
                        return (
                          <tr key={row.key}>
                            <td>
                              <input
                                type="checkbox"
                                style={{ width: 'auto' }}
                                checked={row.include}
                                disabled={row.action === 'none' || needsTicker}
                                onChange={e => updateRow(sIdx, row.key, { include: e.target.checked })}
                              />
                            </td>
                            <td>
                              <span className={`tag ${ACTION_TAG[row.action]}`}>{ACTION_LABEL[row.action]}</span>{' '}
                              {row.statementName}
                              {row.action !== 'remove' && (
                                <>
                                  <br />
                                  <input
                                    style={{ fontSize: 12, padding: '4px 6px', marginTop: 4 }}
                                    value={row.nickname}
                                    placeholder="Nickname shown in alerts"
                                    onChange={e => updateRow(sIdx, row.key, { nickname: e.target.value, nicknameEdited: true })}
                                  />
                                </>
                              )}
                            </td>
                            <td className="num">
                              {row.action === 'remove' ? (
                                <span className="muted">{fmtUnits(row.previousShares)} → gone</span>
                              ) : row.action === 'adjust' ? (
                                <>{fmtUnits(row.previousShares)} → <strong>{fmtUnits(row.quantity)}</strong></>
                              ) : (
                                fmtUnits(row.quantity)
                              )}
                              {row.marketValue != null && (
                                <><br /><span className="muted">{fmtCad.format(row.marketValue)}</span></>
                              )}
                            </td>
                            <td>
                              {row.action === 'add' ? (
                                <>
                                  <input
                                    style={{ fontSize: 12, padding: '4px 6px', fontFamily: 'var(--mono)' }}
                                    value={row.ticker}
                                    placeholder="0P00007xxx"
                                    onChange={e => {
                                      const ticker = e.target.value
                                      updateRow(sIdx, row.key, {
                                        ticker, tickerEdited: true,
                                        include: !!ticker.trim(),
                                      })
                                    }}
                                  />
                                  {needsTicker && (
                                    <div className="muted" style={{ marginTop: 3 }}>
                                      Not seen before — enter its ticker, or{' '}
                                      <a
                                        href={`https://finance.yahoo.com/lookup/?s=${encodeURIComponent(row.statementName)}`}
                                        target="_blank"
                                        rel="noreferrer"
                                      >look it up
                                      </a>.
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="ticker">{displayTicker(row.ticker)}</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}

        {sections.length > 0 && (
          <div className="card">
            {blocked > 0 && (
              <div className="notice">
                {blocked} new fund{blocked > 1 ? 's' : ''} still need{blocked > 1 ? '' : 's'} a
                ticker. Fill them in to include them, or leave them — the rest
                will still import.
              </div>
            )}
            <button className="btn" onClick={apply} disabled={applying || pending === 0 || noAccount}>
              {applying ? 'Applying…' : `Apply ${pending} change${pending === 1 ? '' : 's'}`}
            </button>
            <div className="muted" style={{ marginTop: 6 }}>
              Nothing has been saved yet. Applying makes this statement your
              Manulife holdings for the account{sections.length > 1 ? 's' : ''} above —
              units set to its values, checked funds removed — and remembers each
              ticker you entered for next month.
            </div>
          </div>
        )}

        {imports.length > 0 && (
          <div className="card">
            <h2>Previous imports</h2>
            {imports.map(i => (
              <div key={i.id} className="signal-meta">
                Statement {fmtStatementDate(i.statement_date)} ·{' '}
                {i.account_type ? acctLabel(i.account_type) : i.account_number} ·{' '}
                {(i.summary?.applied || []).length} change(s) · imported{' '}
                {fmtImportDate(i.created_at)}
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
