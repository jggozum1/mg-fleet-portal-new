// Branch Parts catalog ingest — per-branch parts & consumables pricing.
//
// Upload the "MGPH - Resibo App_Parts and Consumables_All Branches_prices_for MG Fleet.xlsx".
// Single flat sheet with a BranchID column (2-7). We split by BranchID,
// map to standard branch codes, and upsert to `branchParts`.
//
// Flow: pick file → preview per-branch breakdown → ingest all or per-branch.

import { useEffect, useState } from 'react'
import {
  analyzeBranchParts, BRANCH_ID_MAP, countBranchParts, upsertBranchParts,
} from '../../lib/branchParts'
import PageHero, { HeroStat } from '../../components/ui/PageHero'

const BRANCH_LABELS = {
  MGCAVITE: 'MG Cavite',
  'MGQUEZON CITY': 'MG Quezon City',
  MGDAVAO: 'MG Davao',
  MGPAMPANGA: 'MG Pampanga',
  MGPALAWAN: 'MG Palawan',
  MGBATANGAS: 'MG Batangas',
}

export default function BranchPartsIngest() {
  const [totalCount, setTotalCount] = useState(0)
  const [branchCounts, setBranchCounts] = useState({})
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const total = await countBranchParts()
        if (!cancelled) setTotalCount(total)
        const counts = {}
        for (const code of Object.values(BRANCH_ID_MAP)) {
          counts[code] = await countBranchParts(code)
        }
        if (!cancelled) setBranchCounts(counts)
      } catch (err) { console.warn('[branch-parts-ingest] counts failed:', err) }
    })()
    return () => { cancelled = true }
  }, [])

  const refreshCounts = async () => {
    const total = await countBranchParts()
    setTotalCount(total)
    const counts = {}
    for (const code of Object.values(BRANCH_ID_MAP)) {
      counts[code] = await countBranchParts(code)
    }
    setBranchCounts(counts)
  }

  return (
    <div className="pb-24">
      <PageHero
        eyebrow="ADMIN"
        title="Branch Parts Pricing"
        subtitle={`Page alive · uptime ${tick}s · ${totalCount} total parts in Firestore`}
        right={<HeroStat value={totalCount} label="ROWS" tone="solid" />}
      />

      <div className="px-3 sm:px-6 pt-4 space-y-4">
        {/* Per-branch counts */}
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-2">Parts per branch</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(BRANCH_LABELS).map(([code, label]) => (
              <div key={code} className="bg-gray-50 rounded-lg px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</div>
                <div className="text-lg font-black text-gray-800">{branchCounts[code] ?? '—'}</div>
              </div>
            ))}
          </div>
        </div>

        <UploadSection onIngestDone={refreshCounts} />
      </div>
    </div>
  )
}

// ── Upload + preview + ingest ────────────────────────────────────────────

function UploadSection({ onIngestDone }) {
  const [file, setFile] = useState(null)
  const [branchRows, setBranchRows] = useState(null)  // { [branchCode]: row[] }
  const [parsing, setParsing] = useState(false)
  const [parseStep, setParseStep] = useState('')
  const [parseError, setParseError] = useState(null)
  const [selectedBranch, setSelectedBranch] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [ingesting, setIngesting] = useState(false)
  const [ingestResult, setIngestResult] = useState(null)
  const [ingestError, setIngestError] = useState(null)
  const [batchMode, setBatchMode] = useState(false)
  const [batchProgress, setBatchProgress] = useState(null)

  // Step 1: parse the Excel, split rows by BranchID
  const handleFile = async (f) => {
    if (!f) return
    setFile(f)
    setBranchRows(null); setSelectedBranch(null); setAnalysis(null)
    setIngestResult(null); setIngestError(null)
    setParsing(true); setParseError(null); setParseStep('Loading parser…')
    try {
      const xlsx = await Promise.race([
        import('xlsx'),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('xlsx parser failed to load in 30s')),
          30000,
        )),
      ])
      setParseStep('Reading file…')
      const buf = await f.arrayBuffer()
      setParseStep('Decoding workbook…')
      const wb = xlsx.read(buf, { type: 'array' })

      const ws = wb.Sheets['Parts and Consumables']
      if (!ws) throw new Error('Sheet "Parts and Consumables" not found')

      setParseStep('Extracting rows…')
      const allRows = xlsx.utils.sheet_to_json(ws, { header: 1 })

      // Header is row 4 (index 4): #, Part Number, Description, Vehicle Make, Models, Branch SRP, BranchID
      const headers = allRows[4] || []
      const grouped = {}

      for (let i = 5; i < allRows.length; i++) {
        const cells = allRows[i]
        if (!cells || cells.length === 0) continue
        const branchId = cells[6]
        const branchCode = BRANCH_ID_MAP[branchId]
        if (!branchCode) continue

        const obj = {}
        for (let c = 0; c < headers.length; c++) {
          obj[headers[c]] = cells[c] != null ? cells[c] : null
        }
        if (!grouped[branchCode]) grouped[branchCode] = []
        grouped[branchCode].push(obj)
      }

      setBranchRows(grouped)
      const branchNames = Object.keys(grouped).map(c => BRANCH_LABELS[c] || c).join(', ')
      setParseStep(`Found ${Object.keys(grouped).length} branches: ${branchNames}`)
    } catch (err) {
      console.error('[branch-parts-ingest] parse failed:', err)
      setParseError(err.message || String(err))
    } finally {
      setParsing(false)
    }
  }

  // Step 2: select branch → analyze
  const selectBranch = (code) => {
    setSelectedBranch(code)
    setAnalysis(null); setIngestResult(null); setIngestError(null)
    setBatchMode(false)
  }

  useEffect(() => {
    if (!selectedBranch || !branchRows?.[selectedBranch]) { setAnalysis(null); return }
    let cancelled = false
    setAnalyzing(true)
    ;(async () => {
      try {
        const a = await analyzeBranchParts(branchRows[selectedBranch], selectedBranch)
        if (!cancelled) setAnalysis(a)
      } catch (err) {
        console.error('[branch-parts-ingest] analyze failed:', err)
      } finally {
        if (!cancelled) setAnalyzing(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedBranch, branchRows])

  // Step 3: ingest single branch
  const ingest = async () => {
    if (!selectedBranch || !branchRows?.[selectedBranch] || ingesting) return
    setIngesting(true); setIngestError(null); setIngestResult(null)
    try {
      const result = await upsertBranchParts(branchRows[selectedBranch], selectedBranch)
      setIngestResult(result)
      onIngestDone?.()
    } catch (err) {
      console.error('[branch-parts-ingest] failed:', err)
      setIngestError(err.message || String(err))
    } finally {
      setIngesting(false)
    }
  }

  // Batch ingest all branches
  const ingestAll = async () => {
    if (ingesting || !branchRows) return
    setBatchMode(true)
    setIngesting(true); setIngestError(null); setIngestResult(null)

    const results = []
    for (const [code, rows] of Object.entries(branchRows)) {
      setBatchProgress(`Ingesting ${BRANCH_LABELS[code] || code}…`)
      try {
        const r = await upsertBranchParts(rows, code)
        results.push({ branch: BRANCH_LABELS[code] || code, ...r })
      } catch (err) {
        results.push({ branch: BRANCH_LABELS[code] || code, error: err.message })
      }
    }
    setIngestResult(results)
    setBatchProgress(null)
    setIngesting(false)
    onIngestDone?.()
  }

  const branchCodeList = branchRows ? Object.keys(branchRows) : []

  return (
    <div className="space-y-3">
      {/* File picker */}
      <div className="bg-white rounded-2xl border p-4 space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500">Upload Parts Pricing File</div>
        <div className="text-xs text-gray-600">
          Pick <span className="font-mono text-gray-800">MGPH - Resibo App_Parts and Consumables_All Branches_prices_for MG Fleet.xlsx</span>.
          Rows are split by BranchID automatically.
        </div>
        <label className={`block bg-white rounded-2xl border-2 border-dashed p-3 cursor-pointer hover:border-brand hover:bg-gray-50 transition-colors ${parsing || ingesting ? 'opacity-60 pointer-events-none' : ''}`}>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => handleFile(e.target.files?.[0] || null)}
            className="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-brand file:text-white file:hover:bg-brand-dark file:cursor-pointer"
          />
          {file && (
            <div className="mt-2 text-[11px] text-gray-700 font-mono truncate">
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </div>
          )}
        </label>
      </div>

      {parsing && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl px-3 py-2 text-sm text-sky-900 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-sky-700 border-t-transparent rounded-full animate-spin" />
          <span>{parseStep}</span>
        </div>
      )}

      {parseError && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-3 py-2 text-sm">
          Parse failed: {parseError}
        </div>
      )}

      {/* Branch selector */}
      {branchCodeList.length > 0 && (
        <div className="bg-white rounded-2xl border p-4 space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
            {branchCodeList.length} branches detected — {Object.values(branchRows).reduce((s, r) => s + r.length, 0)} total rows
          </div>
          <div className="flex flex-wrap gap-2">
            {branchCodeList.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => selectBranch(code)}
                disabled={ingesting}
                className={`text-xs font-bold px-3 py-2 rounded-full whitespace-nowrap transition-colors ${
                  selectedBranch === code
                    ? 'bg-brand text-white'
                    : 'bg-white border text-gray-700 hover:border-brand'
                }`}
              >
                {BRANCH_LABELS[code] || code}
                <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${selectedBranch === code ? 'bg-white/20' : 'bg-gray-100 text-gray-500'}`}>
                  {branchRows[code].length}
                </span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={ingestAll}
            disabled={ingesting}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-sm px-5 py-2.5 rounded-xl"
          >
            {ingesting && batchMode ? 'Ingesting all…' : `Ingest All ${branchCodeList.length} Branches`}
          </button>
        </div>
      )}

      {batchProgress && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl px-3 py-2 text-sm text-sky-900 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-sky-700 border-t-transparent rounded-full animate-spin" />
          <span>{batchProgress}</span>
        </div>
      )}

      {/* Analysis for selected branch */}
      {analyzing && (
        <div className="bg-gray-50 border rounded-xl px-3 py-2 text-sm text-gray-600 italic">Analyzing rows…</div>
      )}

      {analysis && selectedBranch && !batchMode && (
        <AnalysisCard analysis={analysis} branch={BRANCH_LABELS[selectedBranch] || selectedBranch} />
      )}

      {analysis && selectedBranch && !batchMode && analysis.cleanCount > 0 && (
        <div className="bg-white rounded-2xl border p-4 flex items-center justify-between gap-3">
          <div className="text-xs sm:text-sm text-gray-700">
            Will write up to <strong>{(analysis.createCount || 0) + (analysis.updateCount || 0)}</strong> doc{((analysis.createCount + analysis.updateCount) === 1) ? '' : 's'} for <strong>{BRANCH_LABELS[selectedBranch] || selectedBranch}</strong>
            {' '}({analysis.createCount} new · {analysis.updateCount} updates · {analysis.cleanCount - analysis.createCount - analysis.updateCount} unchanged).
          </div>
          <button
            type="button"
            onClick={ingest}
            disabled={ingesting}
            className="bg-brand hover:bg-brand-dark disabled:opacity-40 text-white font-bold text-sm px-5 py-2.5 rounded-xl shrink-0"
          >
            {ingesting ? 'Ingesting…' : `Ingest ${BRANCH_LABELS[selectedBranch]} →`}
          </button>
        </div>
      )}

      {ingestError && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-3 py-2 text-sm">
          Ingest failed: {ingestError}
        </div>
      )}

      {/* Result — single branch */}
      {ingestResult && !Array.isArray(ingestResult) && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm space-y-1">
          <div className="font-black text-emerald-900">Ingest complete — {BRANCH_LABELS[selectedBranch] || selectedBranch}</div>
          <div className="text-emerald-800">
            Created {ingestResult.created} · Updated {ingestResult.updated} · Skipped {ingestResult.skipped}.
          </div>
        </div>
      )}

      {/* Result — batch */}
      {ingestResult && Array.isArray(ingestResult) && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm space-y-2">
          <div className="font-black text-emerald-900">Batch ingest complete</div>
          {ingestResult.map((r, i) => (
            <div key={i} className="text-emerald-800">
              <span className="font-bold">{r.branch}:</span>{' '}
              {r.error
                ? <span className="text-red-700">Error — {r.error}</span>
                : `Created ${r.created} · Updated ${r.updated} · Skipped ${r.skipped}`
              }
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Analysis card ────────────────────────────────────────────────────────

function AnalysisCard({ analysis, branch }) {
  return (
    <div className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-gray-50 border-b px-4 py-2.5 text-[11px] uppercase tracking-widest font-bold text-gray-500">
        Preview — {branch}
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label="Total" value={analysis.total} />
          <Tile label="Clean" value={analysis.cleanCount} tone="green" />
          <Tile label="Will create" value={analysis.createCount} tone="blue" />
          <Tile label="Will update" value={analysis.updateCount} tone="amber" />
        </div>
        {(analysis.duplicates?.length > 0 || analysis.skipped?.length > 0) && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-2">
            {analysis.duplicates?.length > 0 && (
              <Group title={`Duplicate parts (${analysis.duplicates.length})`} note="First occurrence kept; rest dropped." rows={analysis.duplicates} />
            )}
            {analysis.skipped?.length > 0 && (
              <Group title={`Skipped — missing required field (${analysis.skipped.length})`} note="" rows={analysis.skipped} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Group({ title, note, rows }) {
  return (
    <div>
      <div className="font-bold text-amber-900">{title}</div>
      {note && <div className="text-amber-800 mt-0.5">{note}</div>}
      <ul className="list-disc pl-5 mt-1 text-[11px] text-amber-800">
        {rows.slice(0, 6).map((r, i) => <li key={i}>{r}</li>)}
        {rows.length > 6 && <li>…and {rows.length - 6} more</li>}
      </ul>
    </div>
  )
}

function Tile({ label, value, tone = 'gray' }) {
  const map = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-emerald-100 text-emerald-800',
    blue: 'bg-sky-100 text-sky-800',
    amber: 'bg-amber-100 text-amber-800',
  }
  return (
    <div className={`rounded-lg px-3 py-2 ${map[tone] || map.gray}`}>
      <div className="text-[9px] font-bold uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-lg font-black leading-tight">{value ?? '—'}</div>
    </div>
  )
}
