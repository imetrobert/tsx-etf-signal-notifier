import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeTicker, displayTicker, fmtCad } from '../lib/tickers'
import { diffPositions, planCost, normalizeFundName, searchableFundName } from '../lib/funds'
import { readStatementPdf, parseStatementLines, buildCostIndex } from '../lib/statementCost'
import { parseHoldingsExport } from '../lib/holdingsExport'
import Navbar from './Navbar'

const ACCOUNTS = [
  { code: 'TFSA', label: 'TFSA' },
  { code: 'RRSP', label: 'RRSP' },
  { code: 'LIRA', label: 'Locked-in RRSP' },
  { code: 'NON_REG', label: 'Non-registered' },
]
const acctLabel = code => ACCOUNTS.find(a => a.code === code)?.label ?? code

const costFields = plan => plan
  ? { book_cost: plan.cost, book_cost_cad: plan.costCad ?? null, book_cost_date: plan.date, cost_source: plan.source }
  : {}
const SOURCE_LABEL = { statement: 'from statement', export: 'from export', estimated: 'estimated' }

const INSTITUTION_LABEL = { MANULIFE: 'Manulife', WEALTHSIMPLE: 'Wealthsimple' }
const instName = code => INSTITUTION_LABEL[code] ?? code
// Holdings saved before the institution column existed default to Wealthsimple.
const heldAt = h => h.institution || 'WEALTHSIMPLE'

const ACTION_LABEL = { add: 'Add', adjust: 'Adjust', remove: 'Remove', none: 'Unchanged' }
const ACTION_TAG = { add: 'buy', adjust: 'watch', remove: 'sell', none: 'hold' }

const fmtUnits = n => Number(n).toLocaleString('en-CA', { maximumFractionDigits: 4 })

// A holdings date is a plain date with no timezone — anchor it to midday so it
// can't slip to the previous day when rendered in a western timezone.
const fmtStatementDate = d => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
  : '—'
const fmtImportDate = iso => iso
  ? new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
  : '—'

// The export's accounts are grouped by the app account they map to, because an
// export can hold several that land in the same one — a CAD and a USD cash
// account are both non-registered. Left separate, each would see the other's
// funds as missing and propose removing them.
function buildSections(accounts, holdings, fundMap, institution, costCtx) {
  const groups = new Map()
  for (const acct of accounts) {
    const key = acct.accountType || `unknown:${acct.accountNumber}`
    const group = groups.get(key) || { key, institution, accountType: acct.accountType || '', sources: [], positions: [] }
    group.sources.push({
      number: acct.accountNumber,
      label: acct.accountLabel,
      currency: acct.currency || 'CAD',
    })
    for (const p of acct.positions) {
      // One app holding per fund per account, so a fund held in two of the
      // grouped accounts is one position holding the combined units.
      const norm = normalizeFundName(p.name)
      const existing = group.positions.find(q => normalizeFundName(q.name) === norm)
      if (existing) {
        existing.quantity += p.quantity
        existing.marketValue += p.marketValue || 0
      } else {
        group.positions.push({ ...p, currency: p.currency || acct.currency || 'CAD' })
      }
    }
    groups.set(key, group)
  }
  return [...groups.values()].map(g => sectionRows(g, holdings, fundMap, undefined, costCtx))
}

// Builds (or rebuilds) a section's diff against the holdings of its app account
// at the institution the export came from — the other institution's holdings
// are never compared, so they can't be proposed for removal.
// costCtx.statement is the cost index from an attached Manulife statement.
function sectionRows(group, holdings, fundMap, previousRows, costCtx = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const statementLine = costCtx.statement
    ? row => costCtx.statement.get(`${group.accountType}|${normalizeFundName(row.statementName)}`) || null
    : null
  const mine = group.accountType
    ? holdings.filter(h => heldAt(h) === group.institution && (h.account || 'NON_REG') === group.accountType)
    : []
  const edited = new Map((previousRows || []).map(r => [r.key, r]))
  const totals = {}
  for (const p of group.positions) {
    totals[p.currency || 'CAD'] = (totals[p.currency || 'CAD'] || 0) + (p.marketValue || 0)
  }
  return {
    ...group,
    totals,
    rows: diffPositions(group.positions, mine, fundMap).map(r => {
      const before = edited.get(r.key)
      const ticker = before?.tickerEdited ? before.ticker : r.ticker
      const costPlan = planCost(r, { institution: group.institution, statement: statementLine, today })
      // A holding is "without cost" until some source gives it one — a plan
      // this import, or a cost already on file.
      const needsCost = r.action !== 'remove' && !costPlan && r.holding?.book_cost == null
      // A cost write is worth doing on its own when nothing else about the row changes.
      const costChanged = !!costPlan && (r.holding?.book_cost == null || r.holding.book_cost_cad == null ||
        Math.abs(Number(r.holding.book_cost) - costPlan.cost) >= 0.005)
      return {
        ...r,
        costPlan,
        needsCost,
        costChanged,
        ticker,
        tickerEdited: before?.tickerEdited,
        nickname: before?.nicknameEdited ? before.nickname : r.nickname,
        nicknameEdited: before?.nicknameEdited,
        include: r.action !== 'none' && !(r.action === 'add' && !ticker.trim()),
      }
    }),
  }
}

export default function ImportHoldings() {
  const [holdings, setHoldings] = useState([])
  const [fundMap, setFundMap] = useState({})
  const [imports, setImports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)
  const [fileName, setFileName] = useState('')
  const [statementDate, setStatementDate] = useState(null)
  const [institution, setInstitution] = useState(null)
  // An attached Manulife statement: { index, date, name, warnings }.
  const [statement, setStatement] = useState(null)
  const [statementBusy, setStatementBusy] = useState(false)
  const [statementError, setStatementError] = useState('')
  // Income snapshots already saved (one per account per statement).
  const [incomeSaved, setIncomeSaved] = useState([])
  const [warnings, setWarnings] = useState([])
  const [lookups, setLookups] = useState({})
  const [pasted, setPasted] = useState('')
  const [sections, setSections] = useState([])
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)

  const load = useCallback(async () => {
    setError('')
    const [h, m, i, inc] = await Promise.all([
      supabase.from('etf_holdings').select('*'),
      supabase.from('etf_fund_map').select('*'),
      supabase.from('etf_statement_imports').select('*').order('created_at', { ascending: false }).limit(20),
      // A missing table (schema.sql not re-run yet) just means no income is remembered.
      supabase.from('etf_income_snapshots').select('*'),
    ])
    setIncomeSaved(inc.error ? [] : inc.data || [])
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

  function read(text, name) {
    setParsing(true)
    setError('')
    setResult(null)
    setSections([])
    setWarnings([])
    setInstitution(null)
    setFileName(name)
    try {
      const parsed = parseHoldingsExport(text)
      setStatementDate(parsed.statementDate)
      setInstitution(parsed.institution)
      setWarnings(parsed.warnings)
      setSections(buildSections(parsed.accounts, holdings, fundMap, parsed.institution, { statement: statement?.index }))
    } catch (err) {
      setError(`Couldn't read that export: ${err.message}`)
      setSections([])
    }
    setParsing(false)
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    read(await file.text(), file.name)
    e.target.value = '' // let the same file be picked again after a fix
  }

  // Reads the cost column off a Manulife statement PDF and re-plans every
  // section's costs with it. The PDF is read on this device.
  async function attachStatement(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setStatementBusy(true)
    setStatementError('')
    try {
      const parsed = parseStatementLines(await readStatementPdf(file))
      if (!parsed.accounts.length) throw new Error(parsed.warnings.join(' '))
      const next = {
        index: buildCostIndex(parsed), date: parsed.statementDate, name: file.name, warnings: parsed.warnings,
        // Only the non-registered account's income matters (it's what gets taxed).
        income: parsed.income.filter(a => a.accountType === 'NON_REG'),
      }
      setStatement(next)
      setSections(prev => prev.map(sec => sectionRows(sec, holdings, fundMap, sec.rows, { statement: next.index })))
    } catch (err) {
      setStatementError(`Couldn't read that statement: ${err.message}`)
    }
    setStatementBusy(false)
  }

  // Changing the account type re-diffs that section against the holdings in the
  // newly chosen account.
  function setSectionAccount(idx, accountType) {
    setSections(prev => prev.map((s, i) =>
      i === idx ? sectionRows({ ...s, accountType }, holdings, fundMap, s.rows, { statement: statement?.index }) : s))
  }

  // Looks the fund up by name so its ticker doesn't have to be researched by
  // hand. Yahoo's search has no CORS headers, so it is proxied by the
  // refresh-prices edge function.
  async function findTicker(row) {
    const query = searchableFundName(row.statementName)
    setLookups(prev => ({ ...prev, [row.key]: { loading: true, query } }))
    try {
      const { data, error } = await supabase.functions.invoke('refresh-prices', {
        body: { action: 'search', query },
      })
      if (error) throw new Error('lookup unavailable')
      setLookups(prev => ({
        ...prev,
        [row.key]: { loading: false, query, results: data?.results || [], error: data?.error },
      }))
    } catch {
      setLookups(prev => ({
        ...prev,
        [row.key]: {
          loading: false, query, results: [],
          error: "Lookup unavailable — redeploy the refresh-prices edge function to enable it.",
        },
      }))
    }
  }

  function updateRow(sIdx, key, patch) {
    setSections(prev => prev.map((s, i) => i !== sIdx ? s : {
      ...s,
      rows: s.rows.map(r => r.key !== key ? r : { ...r, ...patch }),
    }))
  }

  const pending = useMemo(
    () => sections.flatMap(s => s.rows.filter(r =>
      (r.include && r.action !== 'none') || (r.action === 'none' && r.costChanged))).length,
    [sections])
  // Statement income not yet saved for that period (so a statement can be
  // applied just to record it, even when no holding changed).
  const incomeToSave = (statement?.income || []).filter(a =>
    !incomeSaved.some(r => r.institution === 'MANULIFE' && r.account_type === a.accountType && r.period_end === statement.date))
  const needCost = useMemo(
    () => sections.flatMap(s => s.rows.filter(r => r.needsCost)),
    [sections])
  const blocked = useMemo(
    () => sections.flatMap(s => s.rows.filter(r => r.action === 'add' && !r.ticker.trim())).length,
    [sections])
  const noAccount = sections.some(s => !s.accountType)
  // Two sections pointing at one app account would each try to remove the
  // other's funds, so that has to be resolved before anything is written.
  const clashingAccounts = sections
    .map(s => s.accountType)
    .filter((t, i, all) => t && all.indexOf(t) !== i)
    .map(acctLabel)

  // Statement dates only compare within one institution: a Wealthsimple
  // import says nothing about how fresh the Manulife holdings are. Before an
  // export has been read, show everything.
  const scoped = institution
    ? imports.filter(i => (i.institution || 'MANULIFE') === institution)
    : imports

  const alreadyImported = statementDate
    ? scoped.filter(i => i.statement_date === statementDate &&
        sections.some(s => s.sources.some(src => (i.account_number || '').includes(src.number))))
    : []

  // Most recent import run, and the newest statement any import has covered —
  // they differ when an older statement is imported after a newer one.
  const lastImport = scoped[0] || null
  const lastStatementDate = scoped.reduce(
    (latest, i) => (i.statement_date && (!latest || i.statement_date > latest) ? i.statement_date : latest), null)

  // Same pair per account, so it's obvious which account is a month behind.
  const perAccount = Object.values(scoped.reduce((acc, i) => {
    const key = `${i.institution || 'MANULIFE'}:${i.account_number || i.account_type || '—'}`
    const seen = acc[key]
    acc[key] = {
      key,
      accountType: seen?.accountType || i.account_type,
      institution: seen?.institution || i.institution || 'MANULIFE',
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
    const done = { added: 0, adjusted: 0, removed: 0, costs: 0, income: 0 }
    const problems = []
    let remembered = true // false if etf_fund_map / etf_statement_imports are missing

    for (const section of sections) {
      if (!section.accountType) continue
      const applied = []
      for (const row of section.rows) {
        // Units unchanged but the cost moved (a statement attached, or
        // Wealthsimple's book value refreshed): write the cost alone.
        if (row.action === 'none' && row.costChanged && row.holding) {
          const { error } = await supabase.from('etf_holdings').update(costFields(row.costPlan)).eq('id', row.holding.id)
          if (error) problems.push(`${row.statementName} (cost): ${error.message}`)
          else done.costs++
          continue
        }
        if (!row.include || row.action === 'none') continue
        // Wealthsimple tickers come from the export already in Yahoo form
        // (US listings are bare, so adding .TO would break them); only one
        // typed by hand needs normalizing. Manulife behaves as before.
        const ticker = section.institution === 'WEALTHSIMPLE' && !row.tickerEdited
          ? row.ticker.trim().toUpperCase()
          : normalizeTicker(row.ticker)
        const nickname = row.nickname.trim() || null
        try {
          if (row.action === 'remove') {
            const { error } = await supabase.from('etf_holdings').delete().eq('id', row.holding.id)
            if (error) throw error
            done.removed++
          } else if (row.action === 'adjust') {
            const { error } = await supabase.from('etf_holdings')
              .update({ shares: row.quantity, fund_name: nickname, ...costFields(row.costPlan), updated_at: new Date().toISOString() })
              .eq('id', row.holding.id)
            if (error) throw error
            done.adjusted++
          } else {
            if (!ticker) throw new Error('no ticker')
            const { error } = await supabase.from('etf_holdings').upsert({
              ticker, shares: row.quantity, account: section.accountType,
              institution: section.institution, fund_name: nickname, ...costFields(row.costPlan),
            }, { onConflict: 'ticker,account,institution' })
            if (error) throw error
            done.added++
          }
          applied.push({ action: row.action, name: row.statementName, ticker, units: row.quantity })
        } catch (err) {
          problems.push(`${row.statementName}: ${err.message}`)
          continue
        }
        // Remembering the name → ticker link (a Manulife thing: Wealthsimple states
        // the ticker outright) only saves typing next month, so
        // a missing etf_fund_map table must not fail an otherwise good import.
        if (section.institution === 'MANULIFE' && ticker && row.action !== 'remove') {
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
          account_number: section.sources.map(s => s.number).join(', '),
          account_type: section.accountType,
          institution: section.institution,
          file_name: fileName,
          summary: { applied, accounts: section.sources },
        })
        if (error) remembered = false
      }
    }

    // Statement income, for the retirement planner's taxable-income estimate.
    if (incomeToSave.length) {
      const { error } = await supabase.from('etf_income_snapshots').upsert(
        incomeToSave.map(a => ({
          institution: 'MANULIFE', account_type: a.accountType, period_end: statement.date,
          dividends_ytd: a.dividendsYtd, interest_ytd: a.interestYtd, file_name: statement.name,
        })),
        { onConflict: 'institution,account_type,period_end' },
      )
      if (error) problems.push(`Statement income: ${error.message}`)
      else done.income = incomeToSave.length
    }

    setResult({ ...done, problems, remembered })
    setSections([])
    await load()
    setApplying(false)
  }

  return (
    <>
      <Navbar subtitle="Import your Manulife or Wealthsimple holdings export" />
      <main>
        <div className="card">
          <h2>Import holdings</h2>
          <p className="muted">
            Paste a holdings export below, or attach the downloaded file —
            Manulife and Wealthsimple exports are both recognized from their
            header row. On the Manulife Wealth site, open{' '}
            <strong>Holdings</strong> and press <strong>Export</strong>. It's
            read on this device — nothing is uploaded — and every change is
            listed for you to approve before anything is saved. Once applied,
            the export becomes your holdings <em>at that institution</em> for
            the accounts it covers: units are set to its numbers and funds it
            no longer lists are removed. The other institution's holdings, and
            accounts absent from the export, are never touched.
          </p>
          <div className="form-row" style={{ marginTop: 12 }}>
            <div>
              <label className="field-label">Last statement</label>
              <div className="stat-value">{fmtStatementDate(lastStatementDate)}</div>
              <div className="muted">Date of the newest holdings imported</div>
            </div>
            <div>
              <label className="field-label">Last import</label>
              <div className="stat-value">{fmtImportDate(lastImport?.created_at)}</div>
              <div className="muted">
                {lastImport ? 'When it was applied here' : 'Nothing imported yet'}
              </div>
            </div>
          </div>
          {perAccount.length > 1 && (
            <div style={{ marginTop: 8 }}>
              {perAccount.map(a => (
                <div key={a.key} className="signal-meta">
                  {institution ? '' : `${instName(a.institution)} `}{a.accountType ? acctLabel(a.accountType) : a.key.split(':')[1]}: holdings as of{' '}
                  {fmtStatementDate(a.statementDate)}, imported {fmtImportDate(a.importedAt)}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label className="field-label">Paste the export</label>
            <textarea
              rows={4}
              value={pasted}
              onChange={e => setPasted(e.target.value)}
              placeholder="Security	Security Symbol	Market	…   or   Account Name	Account Type	…"
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 11 }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn small" onClick={() => read(pasted, 'pasted export')} disabled={!pasted.trim() || parsing}>
                Read export
              </button>
              {pasted && (
                <button className="btn small secondary" onClick={() => setPasted('')} disabled={parsing}>
                  Clear
                </button>
              )}
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              Include the header row (it starts “Security” for Manulife,
              “Account Name” for Wealthsimple). Both exports carry the ticker
              and account for every position, so no ticker lookups are needed.
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="field-label">…or attach the downloaded file</label>
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              onChange={onFile}
              disabled={parsing || loading}
            />
          </div>
          {fileName && !parsing && (
            <div className="muted" style={{ marginTop: 6 }}>Read {fileName}</div>
          )}
          {parsing && <div className="muted" style={{ marginTop: 10 }}><span className="spin" /> Reading…</div>}
          {error && <div className="err">{error}</div>}
          {warnings.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          {sections.length > 0 && statementDate && (
            <div className="signal-reasons" style={{ marginTop: 10 }}>
              {instName(institution)} holdings as of <strong>{fmtStatementDate(statementDate)}</strong>.
            </div>
          )}
          {alreadyImported.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              An import for this account was already applied today
              ({fmtImportDate(alreadyImported[0].created_at)}). Doing it again is harmless —
              units are set to the export's values, not added to them.
            </div>
          )}
          {staleStatement && (
            <div className="notice" style={{ marginTop: 10 }}>
              This export is older than the one you already imported
              ({fmtStatementDate(staleStatement)}). Applying it would roll your {instName(institution)}
              holdings back to {fmtStatementDate(statementDate)}.
            </div>
          )}
          {sections.length > 0 && institution === 'MANULIFE' && (
            <div className={needCost.length > 0 ? 'notice' : 'signal-reasons'} style={{ marginTop: 10 }}>
              {needCost.length > 0 ? (
                <>
                  <strong>{needCost.length} holding{needCost.length === 1 ? ' has' : 's have'} no cost basis (ACB) yet:</strong>{' '}
                  {needCost.slice(0, 6).map(r => r.nickname || r.statementName).join(', ')}
                  {needCost.length > 6 ? `, and ${needCost.length - 6} more` : ''}.
                  {' '}Attach your latest Manulife statement (PDF) to fill it in.
                </>
              ) : (
                <>Cost basis is on file for every holding. Attach a statement any time to true it up.</>
              )}
              <div style={{ marginTop: 8 }}>
                <input type="file" accept="application/pdf,.pdf" onChange={attachStatement} disabled={statementBusy} />
              </div>
              {statementBusy && <div className="muted" style={{ marginTop: 6 }}>Reading statement…</div>}
              {statementError && <div style={{ marginTop: 6, color: 'var(--accent)' }}>{statementError}</div>}
              {statement && !statementError && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Statement for {fmtStatementDate(statement.date)} attached ({statement.name}). It is read on
                  this device — nothing is uploaded.
                  {statement.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
              {statement?.income?.length > 0 && !statementError && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Non-registered income to {fmtStatementDate(statement.date)}:{' '}
                  {fmtCad.format(statement.income.reduce((t, a) => t + a.dividendsYtd + a.interestYtd, 0))} year to date
                  {incomeToSave.length ? ' — will be saved for the retirement planner.' : ' — already saved.'}
                </div>
              )}
              {statement && needCost.length > 0 && !statementBusy && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Still without a cost: no matching line in that statement for {needCost.length === 1 ? 'it' : 'them'}.
                  A fund bought after {fmtStatementDate(statement.date)} won't be on it — attach a newer statement.
                </div>
              )}
            </div>
          )}
        </div>

        {result && (
          <div className="card">
            <h2>Import applied</h2>
            <div className="signal-reasons">
              {result.added} added, {result.adjusted} adjusted, {result.removed} removed{result.costs > 0 ? `, ${result.costs} cost basis update${result.costs === 1 ? '' : 's'}` : ''}{result.income > 0 ? ', statement income saved' : ''}.
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
            <div className="card" key={section.key}>
              <h2>
                {instName(section.institution)}: {section.sources.map(s => [s.label, s.number].filter(Boolean).join(' ')).join(' + ')}
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
                    {Object.entries(section.totals).map(([cur, amt]) =>
                      `${amt.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`
                    ).join(' · ')}
                  </div>
                </div>
              </div>
              {section.sources.length > 1 && (
                <div className="muted" style={{ marginBottom: 8 }}>
                  These {section.sources.length} statement accounts both map to{' '}
                  {section.accountType ? acctLabel(section.accountType) : 'one app account'}, so
                  they're compared together — a fund held in both counts once, with the units added up.
                </div>
              )}
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
                                <><br /><span className="muted">
                                  {fmtCad.format(row.marketValue)}
                                  {row.currency && row.currency !== 'CAD' ? ` ${row.currency}` : ''}
                                </span></>
                              )}
                              {row.costPlan ? (
                                <><br /><span className="muted" title="Cost basis (ACB) that will be saved">
                                  ACB {fmtCad.format(row.costPlan.cost)}
                                  {row.currency && row.currency !== 'CAD' ? ` ${row.currency}` : ''}
                                  {' · '}{SOURCE_LABEL[row.costPlan.source]}
                                </span></>
                              ) : row.needsCost ? (
                                <><br /><span className="tag watch">needs cost</span></>
                              ) : null}
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
                                  {needsTicker && !lookups[row.key] && (
                                    <div style={{ marginTop: 4 }}>
                                      <button className="btn small secondary" onClick={() => findTicker(row)}>
                                        Find ticker
                                      </button>
                                    </div>
                                  )}
                                  {lookups[row.key]?.loading && (
                                    <div className="muted" style={{ marginTop: 4 }}>
                                      <span className="spin" /> Searching…
                                    </div>
                                  )}
                                  {lookups[row.key] && !lookups[row.key].loading && (
                                    <div style={{ marginTop: 4 }}>
                                      <div className="muted">Searched “{lookups[row.key].query}”</div>
                                      {lookups[row.key].results?.map(hit => (
                                        <button
                                          key={hit.symbol}
                                          className="btn small secondary"
                                          style={{ margin: '3px 3px 0 0', textAlign: 'left' }}
                                          onClick={() => updateRow(sIdx, row.key, {
                                            ticker: hit.symbol, tickerEdited: true, include: true,
                                            nickname: row.nicknameEdited ? row.nickname : (hit.name || row.nickname),
                                          })}
                                        >
                                          <span className="ticker">{hit.symbol}</span> {hit.name}
                                        </button>
                                      ))}
                                      {!lookups[row.key].results?.length && (
                                        <div className="muted">
                                          {lookups[row.key].error || 'Nothing found — enter the ticker or FundSERV code by hand.'}{' '}
                                          <a
                                            href={`https://www.theglobeandmail.com/investing/markets/funds/finder/`}
                                            target="_blank"
                                            rel="noreferrer"
                                          >Fund finder</a>
                                        </div>
                                      )}
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
            {clashingAccounts.length > 0 && (
              <div className="notice">
                Two sections above are both set to {clashingAccounts.join(' and ')}. Give them
                different accounts — as it stands each would remove the other's funds.
              </div>
            )}
            <button
              className="btn"
              onClick={apply}
              disabled={applying || pending + incomeToSave.length === 0 || noAccount || clashingAccounts.length > 0}
            >
              {applying ? 'Applying…' : `Apply ${pending + incomeToSave.length} change${pending + incomeToSave.length === 1 ? '' : 's'}`}
            </button>
            <div className="muted" style={{ marginTop: 6 }}>
              Nothing has been saved yet. Applying makes this export your
              {instName(institution)} holdings for the account{sections.length > 1 ? 's' : ''} above —
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
                {instName(i.institution || 'MANULIFE')} · Statement {fmtStatementDate(i.statement_date)} ·{' '}
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
