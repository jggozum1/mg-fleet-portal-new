// Smart quote prefill — given a completed assessment, suggest the line items
// for a quotation.
//
// Two strategies, picked based on what the assessment carries:
//   A. NEW (Round 18). The assessor declared `labors[]` at submit time
//      (e.g. "Preventive Maintenance Service", "Brake Service"). We emit
//      one Labor line per declared labor type, plus Parts lines for each
//      failed inspection item. This is what the user actually wants on
//      the quote — multiple PMS items collapse into a single PMS labor
//      line instead of one Labor row per item.
//   B. LEGACY fallback. If the assessment predates Round 18 and has no
//      `labors` field, fall back to per-item Labor lines (the original
//      Round 17 behavior). Keeps existing assessments working.
//
// Out of scope:
//   - Pricing. Until the Cavite catalog ingestion ships, unitCost is left
//     at 0 and the user fills it in. Round 13 deferred this.
//   - 'replaced' items. The replacement happened in the field; nothing to
//     bill on top.
//
// Round 19 — monitor items now appear too, but tagged "(Monitor)" so the
// quote reader can tell them apart from urgent failures and choose to
// defer or roll them in.

import {
  ALL_ITEMS, CATEGORIES, DEFECT_CODES, ITEM_MAP, INSP_TO_PMS,
  LABOR_TYPE_MAP, PMS_MAP, getAction,
} from './mgfms-catalog'
import { searchLabor, searchPartsAndConsumables } from './caviteCatalogSearch'
import { searchBranchLabor } from './branchServices'
import { searchBranchParts } from './branchParts'

// Stable category order so the generated quote reads like a service order
// (Engine → Brakes → Suspension → Electrical → Tires → Body → ...).
const CATEGORY_ORDER = CATEGORIES.map((c) => c.code)
const CATEGORY_INDEX = Object.fromEntries(CATEGORY_ORDER.map((code, i) => [code, i]))

// Find the parent category for an item code (item codes are prefixed with
// their category code, e.g. ENG_OIL → ENG, BRK_PAD_F → BRK).
function categoryOf(itemCode) {
  const prefix = itemCode.split('_')[0]
  return CATEGORY_INDEX[prefix] != null ? prefix : 'ZZZ'
}

function laborPrefix(action) {
  if (action === 'HOLD_UNIT') return 'URGENT —'
  if (action === 'REPAIR_IMMEDIATE') return 'Critical:'
  return 'Service:' // REPAIR_REQUIRED and any other not-skipped action
}

// Helper: normalize an assessment's labor source. Prefers `labors[]` from
// Round 18; falls back to `pmsData.laborTypes` (used by mg-fms QuickFix
// flow) so re-assessment quickfixes also benefit. Returns [] if neither
// source is present.
function normalizedLabors(assessment) {
  if (Array.isArray(assessment?.labors) && assessment.labors.length > 0) {
    return assessment.labors
  }
  const pmsLabors = assessment?.pmsData?.laborTypes
  if (Array.isArray(pmsLabors) && pmsLabors.length > 0) return pmsLabors
  return []
}

// Build the Parts lines from inspection items. Includes both
// `fail_critical` (urgent — replace now) and `monitor` (watch list, but
// the customer often opts to bundle them into the same job). Monitor
// items are prefixed "(Monitor)" so the quote distinguishes them.
//
// Round 21: when the assessor recorded a defect code (LOW_THICKNESS,
// LEAKING, etc.), it gets appended to the description so the quote
// tells the customer *why* — better-justified line item.
function partsLinesFromItemResults(itemResults) {
  const findings = []
  for (const code of Object.keys(itemResults)) {
    const r = itemResults[code]
    const item = ITEM_MAP[code]
    if (!item || !r?.resultCode) continue
    if (r.resultCode !== 'fail_critical' && r.resultCode !== 'monitor') continue
    findings.push({ item, result: r, severity: r.resultCode })
  }
  // Sort: critical first, then monitor; within each, by category, then label.
  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail_critical' ? -1 : 1
    const ca = CATEGORY_INDEX[categoryOf(a.item.code)] ?? 999
    const cb = CATEGORY_INDEX[categoryOf(b.item.code)] ?? 999
    if (ca !== cb) return ca - cb
    return (a.item.label || '').localeCompare(b.item.label || '')
  })
  return findings.map(({ item, result, severity }) => {
    const pmsCode = INSP_TO_PMS[item.code]
    const partsLabel = pmsCode && PMS_MAP[pmsCode]?.label
      ? PMS_MAP[pmsCode].label
      : item.label
    const monitorTag = severity === 'monitor' ? '(Monitor) ' : ''
    const defectLabel = result?.defectCode && DEFECT_CODES[result.defectCode]
      ? DEFECT_CODES[result.defectCode]
      : (result?.defectCode || null)
    const defectSuffix = defectLabel ? ` — ${defectLabel}` : ''
    return {
      type: 'Parts/Materials',
      qty: 1,
      description: `${monitorTag}Replace ${partsLabel}${defectSuffix}`,
      unitCost: 0,
    }
  })
}

// Given an assessment doc (from Firestore), return an array of suggested
// quotation rows in the shape ServiceReceiptCreate already expects:
//   { type: 'Labor' | 'Parts/Materials', qty, description, unitCost }
//
// Returns [] if the assessment is missing or has no actionable findings.
export function suggestQuoteItemsFromAssessment(assessment) {
  const itemResults = assessment?.itemResults || {}
  if (typeof itemResults !== 'object') return []

  const declaredLabors = normalizedLabors(assessment)
  const otherLabor = (assessment?.otherLabor || '').trim()

  // STRATEGY A — Round 18: assessor declared labor types. One Labor row
  // per declared labor (in catalog order). Parts come from failed items.
  if (declaredLabors.length > 0 || otherLabor) {
    const rows = []
    for (const lt of declaredLabors) {
      // LBR_OTHER is rendered using the free-text otherLabor field, not
      // the generic "Other" label, so the quote actually communicates
      // what the labor is.
      if (lt.code === 'LBR_OTHER') continue
      rows.push({
        type: 'Labor',
        qty: 1,
        description: lt.label || LABOR_TYPE_MAP[lt.code]?.label || lt.code,
        unitCost: 0,
      })
    }
    if (otherLabor) {
      rows.push({
        type: 'Labor',
        qty: 1,
        description: otherLabor,
        unitCost: 0,
      })
    }
    rows.push(...partsLinesFromItemResults(itemResults))
    return rows
  }

  // STRATEGY B — legacy fallback (Round 17 behavior): one Labor + one
  // Parts line per inspection finding. Now also includes monitor items
  // (Round 19), tagged "(Monitor)" on both Labor and Parts so the quote
  // surfaces watch-list items without confusing them with urgencies.
  const findings = []
  for (const code of Object.keys(itemResults)) {
    const r = itemResults[code]
    const item = ITEM_MAP[code]
    if (!item || !r?.resultCode) continue
    if (r.resultCode !== 'fail_critical' && r.resultCode !== 'monitor') continue
    const action = getAction(item, r.resultCode)
    findings.push({ item, result: r, action, severity: r.resultCode })
  }

  // Critical first, then monitor; within each, category order then label.
  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail_critical' ? -1 : 1
    const ca = CATEGORY_INDEX[categoryOf(a.item.code)] ?? 999
    const cb = CATEGORY_INDEX[categoryOf(b.item.code)] ?? 999
    if (ca !== cb) return ca - cb
    return (a.item.label || '').localeCompare(b.item.label || '')
  })

  const rows = []
  for (const { item, result, action, severity } of findings) {
    const monitorTag = severity === 'monitor' ? '(Monitor) ' : ''
    const prefix = severity === 'monitor' ? 'Watch:' : laborPrefix(action)
    rows.push({
      type: 'Labor',
      qty: 1,
      description: `${monitorTag}${prefix} ${item.label}`.trim(),
      unitCost: 0,
    })

    const pmsCode = INSP_TO_PMS[item.code]
    const partsLabel = pmsCode && PMS_MAP[pmsCode]?.label
      ? PMS_MAP[pmsCode].label
      : item.label
    const defectLabel = result?.defectCode && DEFECT_CODES[result.defectCode]
      ? DEFECT_CODES[result.defectCode]
      : (result?.defectCode || null)
    const defectSuffix = defectLabel ? ` — ${defectLabel}` : ''
    rows.push({
      type: 'Parts/Materials',
      qty: 1,
      description: `${monitorTag}Replace ${partsLabel}${defectSuffix}`,
      unitCost: 0,
    })
  }

  return rows
}

// Round 21 — pull the form-header fields the quote create page already
// asks for (odometer, customer, branch, company) directly from the
// assessment header, so the user doesn't re-type data we already have.
// Returns only the fields with a non-empty value, so existing prefill
// (from the vehicles registry) is preserved when the assessment didn't
// record a particular field.
export function extractHeaderPrefill(assessment) {
  const h = assessment?.header || {}
  const out = {}
  if (h.odometer != null && Number.isFinite(Number(h.odometer))) {
    out.odometer = Number(h.odometer)
  }
  // Driver / custodian — the assessment names the field "client" but in
  // mg-fms parlance that's the fleet company, not the driver. The
  // assessment header doesn't carry the driver's name. Skip.
  if (h.client && h.client.trim()) out.company = h.client.trim()
  if (h.branch && h.branch.trim()) out.branch = h.branch.trim().toUpperCase()
  // Mechanic-of-record on the appointment is the "technician" on the
  // assessment header. Useful as the quote's mechanic field default.
  if (h.technician && h.technician.trim()) out.mechanic = h.technician.trim()
  return out
}

// Round 21 — roll up any non-empty per-item notes the assessor wrote
// into a single block of bullet points, suitable for the quote's notes
// textarea. Each line is "<item label>: <note>". Returns empty string
// if there are no notes worth carrying over.
export function extractAssessmentNotes(assessment) {
  const itemResults = assessment?.itemResults || {}
  const lines = []
  for (const code of Object.keys(itemResults)) {
    const r = itemResults[code]
    const note = (r?.note || '').trim()
    if (!note) continue
    const item = ITEM_MAP[code]
    if (!item) continue
    lines.push(`• ${item.label}: ${note}`)
  }
  if (lines.length === 0) return ''
  const rwa = assessment?.rwaNumber || '—'
  return `From assessment ${rwa}:\n${lines.join('\n')}`
}

// Convenience wrapper: returns the counts the prefill banner shows, plus
// the source of the labor lines (declared by the assessor vs. derived
// from items) so the banner copy can be honest about it.
export function summarizeAssessmentForQuote(assessment) {
  const items = ALL_ITEMS
  const itemResults = assessment?.itemResults || {}
  let criticalCount = 0
  let holdCount = 0
  let monitorCount = 0
  for (const item of items) {
    const r = itemResults[item.code]
    if (r?.resultCode === 'fail_critical') {
      criticalCount++
      if (item.holdUnit) holdCount++
    } else if (r?.resultCode === 'monitor') {
      monitorCount++
    }
  }
  const declaredLabors = normalizedLabors(assessment)
  const otherLabor = (assessment?.otherLabor || '').trim()
  const laborCount = declaredLabors.filter((l) => l.code !== 'LBR_OTHER').length + (otherLabor ? 1 : 0)
  const laborSource = laborCount > 0 ? 'declared' : 'derived'
  return {
    criticalCount,
    holdCount,
    monitorCount,
    laborCount,
    laborSource,
    rwa: assessment?.rwaNumber || null,
  }
}

// Round 37 — auto-price prefill rows against the catalog.
// When `branchCode` is provided, Labor lines are priced from
// `branchServices` first (flat per-branch pricing). Falls back to
// the vehicle-specific Cavite catalog if no branch match is found.
// Parts/Materials still use the Cavite catalog (vehicle-specific).
//
// Returns the items array with prices populated. Async because the
// catalog search reads from Firestore.
export async function enrichItemsWithCatalogPrices(items, { makeId, modelId, branchCode } = {}) {
  if (!Array.isArray(items) || items.length === 0) return items
  // Need either branchCode or vehicle IDs to look up prices.
  if (!branchCode && (!Number.isFinite(makeId) || !Number.isFinite(modelId))) return items

  // Strip the prefill prefixes so the catalog lookup matches against
  // the actual subject. "Replace Air Filter" → "Air Filter",
  // "(Monitor) Replace Brake Pads Front" → "Brake Pads Front",
  // "Service: Brake pad thickness — front" → "Brake pad thickness".
  const stripDescriptionPrefix = (desc) => {
    let s = String(desc || '').trim()
    // Drop tags like "(Monitor) " / "(Watch) ".
    s = s.replace(/^\([^)]*\)\s+/, '')
    // Drop labor severity prefixes from Round 17 legacy fallback.
    s = s.replace(/^(URGENT —|Critical:|Service:|Watch:)\s*/i, '')
    // Drop the "Replace " verb.
    s = s.replace(/^Replace\s+/i, '')
    // Drop trailing defect-code suffix " — Low thickness".
    s = s.replace(/\s+—\s+.*$/, '')
    return s.trim()
  }

  // Score how well a catalog row matches the prefill subject. Cheap
  // tokenized overlap — each word in `term` that also appears in
  // `candidate` adds to the score, longer term wins on ties.
  const scoreMatch = (term, candidate) => {
    const t = String(term || '').toUpperCase()
    const c = String(candidate || '').toUpperCase()
    if (!t || !c) return 0
    if (c === t) return 1000
    if (c.includes(t)) return 500 + t.length
    if (t.includes(c)) return 400 + c.length
    // Token overlap.
    const tTokens = new Set(t.split(/\s+/).filter((w) => w.length >= 3))
    const cTokens = new Set(c.split(/\s+/).filter((w) => w.length >= 3))
    let hits = 0
    for (const tok of tTokens) if (cTokens.has(tok)) hits++
    return hits * 50
  }

  const enriched = []
  for (const item of items) {
    // If the line was already priced by some other path, keep it.
    if (Number(item.unitCost) > 0) {
      enriched.push(item); continue
    }
    const subject = stripDescriptionPrefix(item.description)
    if (!subject) { enriched.push(item); continue }
    try {
      // Try full subject first, then individual significant words
      const searchTerms = [subject]
      const words = subject.split(/\s+/).filter((w) => w.length >= 4)
      if (words.length > 1) {
        // Try 2-word combos
        for (let i = 0; i < words.length - 1; i++) {
          searchTerms.push(`${words[i]} ${words[i + 1]}`)
        }
        // Try individual words
        words.forEach((w) => searchTerms.push(w))
      }

      let best = null
      let bestScore = 99
      for (const term of searchTerms) {
        let pool
        if (item.type === 'Labor') {
          // Try branch services first, fall back to Cavite catalog
          if (branchCode) {
            pool = await searchBranchLabor({ branchCode, term })
          }
          if (!pool || pool.length === 0) {
            pool = Number.isFinite(makeId) && Number.isFinite(modelId)
              ? await searchLabor({ makeId, modelId, term })
              : []
          }
        } else {
          // Try branch parts first, fall back to Cavite catalog
          if (branchCode) {
            pool = await searchBranchParts({ branchCode, term })
          }
          if (!pool || pool.length === 0) {
            pool = Number.isFinite(makeId) && Number.isFinite(modelId)
              ? await searchPartsAndConsumables({ makeId, modelId, term })
              : []
          }
        }
        for (const cand of pool) {
          const score = scoreMatch(subject, cand.name)
          if (score > bestScore) { best = cand; bestScore = score }
        }
        if (bestScore >= 500) break // exact or contains match, stop searching
      }

      if (best) {
        enriched.push({ ...item, unitCost: Number(best.unitCost) || Number(best.srp) || 0 })
      } else {
        enriched.push(item)
      }
    } catch (err) {
      console.warn('[enrichItemsWithCatalogPrices] match failed for', item.description, err)
      enriched.push(item)
    }
  }
  return enriched
}
