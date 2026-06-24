// Branch Services catalog ingest — per-branch service pricing.
//
// Upload the "MGPH - Resibo App_Services_All Branches_prices.xlsx" file.
// Each branch sheet ("Services Catalog_Cavite", etc.) is parsed into
// branchServices docs keyed by branchCode + service code.
//
// Flow: pick file → select branch sheet → preview → ingest.

import { useEffect, useState } from 'react'
import {
  analyzeBranchServices, BRANCH_MAP, countBranchServices, upsertBranchServices,
} from '../../lib/branchServices'
import PageHero, { HeroStat } from '../../components/ui/PageHero'

// Sheet-name prefixes we look for inside the Excel workbook.
// The sheet names in the file are like "Services Catalog_Cavite".
const SHEET_PREFIX = 'Services Catalog_'

export default function BranchServicesIngest() {
  const [totalCount, setTotalCount] = useState(0)
  const [branchCounts, setBranchCounts] = useState({})
  const [tick, setTick] = useState(0)

  // Heartbeat
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Load counts on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const total = await countBranchServices()
        if (!cancelled) setTotalCount(total)
        // Per-branch counts
        const counts = {}
        for (const [, code] of Object.entries(BRANCH_MAP)) {
          counts[code] = await countBranchServices(code)
        }
        if (!cancelled) setBranchCounts(counts)
      } catch (err) { console.warn('[branch-services-ingest] counts failed:', err) }
    })()
    return () => { cancelled = true }
  }, [])

  const refreshCounts = async () => {
    const total = await countBranchServices()
    setTotalCount(total)
    const counts = {}
    for (const [, code] of Object.entries(BRANCH_MAP)) {
      counts[code] = await countBranchServices(code)
    }
    setBranchCounts(counts)
  }

  return (
    <div className="pb-24">
      <PageHero
        eyebrow="ADMIN"
        title="Branch Services Pricing"
        subtitle={`Page alive · uptime ${tick}s · ${totalCount} total services in Firestore`}
        right={<HeroStat value={totalCount} label="ROWS" tone="solid" />}
      />

      <div className="px-3 sm:px-6 pt-4 space-y-4">
        {/* Per-branch counts */}
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-2">Services per branch</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(BRANCH_MAP).map(([label, code]) => (
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

// ── Upload + branch picker + preview + ingest ────────────────────────────

function UploadSection({ onIngestDone }) {
  const [file, setFile] = useState(null)
  const [sheets, setSheets] = useState([])           // detected branch sheets
  const [selectedBranch, setSelectedBranch] = useState(null)  // { label, branchCode, sheetName }
  const [raw, setRaw] = useState(null)                // parsed rows for selected sheet
  const [parsing, setParsing] = useState(false)
  const [parseStep, setParseStep] = useState('')
  const [parseError, setParseError] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [ingesting, setIngesting] = useState(false)
  const [ingestResult, setIngestResult] = useState(null)
  const [ingestError, setIngestError] = useState(null)
  // Batch mode
  const [batchMode, setBatchMode] = useState(false)
  const [batchProgress, setBatchProgress] = useState(null)

  // Step 1: user picks the xlsx → we detect branch sheets
  const handleFile = async (f) => {
    if (!f) return
    setFile(f)
    setSheets([]); setSelectedBranch(null); setRaw(null)
    setAnalysis(null); setIngestResult(null); setIngestError(null)
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

      // Detect branch sheets
      const detected = []
      for (const sheetName of wb.SheetNames) {
        if (!sheetName.startsWith(SHEET_PREFIX)) continue
        const suffix = sheetName.replace(SHEET_PREFIX, '')
        const branchCode = BRANCH_MAP[suffix]
        if (branchCode) {
          detected.push({ label: suffix, branchCode, sheetName })
        }
      }

      // Store the workbook in memory for later sheet parsing
      window.__branchServicesWb = { xlsx, wb }
      setSheets(detected)
      setParseStep(`Found ${detected.length} branch sheet${detected.length === 1 ? '' : 's'}.`)
    } catch (err) {
      console.error('[branch-services-ingest] parse failed:', err)
      setParseError(err.message || String(err))
    } finally {
      setParsing(false)
    }
  }

  // Step 2: user picks a branch → parse that sheet
  const selectBranch = (branch) => {
    setSelectedBranch(branch)
    setRaw(null); setAnalysis(null); setIngestResult(null); setIngestError(null)
    const { xlsx, wb } = window.__branchServicesWb || {}
    if (!xlsx || !wb) return
    const ws = wb.Sheets[branch.sheetName]
    if (!ws) return
    // Row 0 is the title row ("MASTER GARAGE: RESIBO APP ONLINE | CAVITE")
    // Row 1 is the header row ("CODE", "SERVICE NAME", ...)
    // Data starts row 2
    const allRows = xlsx.utils.sheet_to_json(ws, { header: 1 })
    // Build objects using row 1 as headers
    const headers = allRows[1] || []
    const rows = []
    for (let i = 2; i < allRows.length; i++) {
      const cells = allRows[i]
      if (!cells || cells.length === 0) continue
      // Skip empty rows (no code)
      if (!cells[0]) continue
      const obj = {}
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = cells[c] != null ? cells[c] : null
      }
      rows.push(obj)
    }
    setRaw(rows)
  }

  // Step 2b: analyze after raw is set
  useEffect(() => {
    if (!raw || !selectedBranch) { setAnalysis(null); return }
    let cancelled = false
    setAnalyzing(true)
    ;(async () => {
      try {
        const a = await analyzeBranchServices(raw, selectedBranch.branchCode)
        if (!cancelled) setAnalysis(a)
      } catch (err) {
        console.error('[branch-services-ingest] analyze failed:', err)
      } finally {
        if (!cancelled) setAnalyzing(false)
      }
    })()
    return () => { cancelled = true }
  }, [raw, selectedBranch])

  // Step 3: ingest single branch
  const ingest = async () => {
    if (!raw || !selectedBranch || ingesting) return
    setIngesting(true); setIngestError(null); setIngestResult(null)
    try {
      const result = await upsertBranchServices(raw, selectedBranch.branchCode)
      setIngestResult(result)
      onIngestDone?.()
    } catch (err) {
      console.error('[branch-services-ingest] failed:', err)
      setIngestError(err.message || String(err))
    } finally {
      setIngesting(false)
    }
  }

  // Batch ingest: all detected branches at once
  const ingestAll = async () => {
    if (ingesting || !sheets.length) return
    setBatchMode(true)
    setIngesting(true); setIngestError(null); setIngestResult(null)
    const { xlsx, wb } = window.__branchServicesWb || {}
    if (!xlsx || !wb) { setIngestError('Workbook not loaded'); setIngesting(false); return }

    const results = []
    for (const branch of sheets) {
      setBatchProgress(`Ingesting ${branch.label}…`)
      try {
        const ws = wb.Sheets[branch.sheetName]
        const allRows = xlsx.utils.sheet_to_json(ws, { header: 1 })
        const headers = allRows[1] || []
        const rows = []
        for (let i = 2; i < allRows.length; i++) {
          const cells = allRows[i]
          if (!cells || cells.length === 0 || !cells[0]) continue
          const obj = {}
          for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = cells[c] != null ? cells[c] : null
          }
          rows.push(obj)
        }
        const r = await upsertBranchServices(rows, branch.branchCode)
        results.push({ branch: branch.label, ...r })
      } catch (err) {
        results.push({ branch: branch.label, error: err.message })
      }
    }
    setIngestResult(results)
    setBatchProgress(null)
    setIngesting(false)
    onIngestDone?.()
  }

  return (
    <div className="space-y-3">
      {/* File picker */}
      <div className="bg-white rounded-2xl border p-4 space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500">Upload Services Pricing File</div>
        <div className="text-xs text-gray-600">
          Pick <span className="font-mono text-gray-800">MGPH - Resibo App_Services_All Branches_prices.xlsx</span>.
          Each branch sheet will be detected automatically.
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

      {/* Branch sheet selector */}
      {sheets.length > 0 && (
        <div className="bg-white rounded-2xl border p-4 space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
            Detected {sheets.length} branch sheet{sheets.length === 1 ? '' : 's'}
          </div>
          <div className="flex flex-wrap gap-2">
            {sheets.map((s) => (
              <button
                key={s.branchCode}
                type="button"
                onClick={() => selectBranch(s)}
                disabled={ingesting}
                className={`text-xs font-bold px-3 py-2 rounded-full whitespace-nowrap transition-colors ${
                  selectedBranch?.branchCode === s.branchCode
                    ? 'bg-brand text-white'
                    : 'bg-white border text-gray-700 hover:border-brand'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Ingest All button */}
          <button
            type="button"
            onClick={ingestAll}
            disabled={ingesting}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-sm px-5 py-2.5 rounded-xl"
          >
            {ingesting && batchMode ? 'Ingesting all…' : `Ingest All ${sheets.length} Branches`}
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

      {analysis && selectedBranch && !batchMode && <AnalysisCard analysis={analysis} branch={selectedBranch.label} />}

      {/* Ingest single branch */}
      {analysis && selectedBranch && !batchMode && analysis.cleanCount > 0 && (
        <div className="bg-white rounded-2xl border p-4 flex items-center justify-between gap-3">
          <div className="text-xs sm:text-sm text-gray-700">
            Will write up to <strong>{(analysis.createCount || 0) + (analysis.updateCount || 0)}</strong> doc{((analysis.createCount + analysis.updateCount) === 1) ? '' : 's'} for <strong>{selectedBranch.label}</strong>
            {' '}({analysis.createCount} new · {analysis.updateCount} updates · {analysis.cleanCount - analysis.createCount - analysis.updateCount} unchanged).
          </div>
          <button
            type="button"
            onClick={ingest}
            disabled={ingesting}
            className="bg-brand hover:bg-brand-dark disabled:opacity-40 text-white font-bold text-sm px-5 py-2.5 rounded-xl shrink-0"
          >
            {ingesting ? 'Ingesting…' : `Ingest ${selectedBranch.label} →`}
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
          <div className="font-black text-emerald-900">Ingest complete — {selectedBranch?.label}</div>
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
              <Group title={`Duplicate codes (${analysis.duplicates.length})`} note="First occurrence kept; rest dropped." rows={analysis.duplicates} />
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
