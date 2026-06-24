// Branch Services catalog — per-branch service pricing.
//
// Firestore collection: `branchServices`
// Each doc represents one service at one branch.
// Doc ID: `${branchCode}_${code}` (e.g. "MGCAVITE_AC-001") for idempotent upsert.
//
// Fields:
//   code          — service code (e.g. "AC-001")
//   serviceName   — display name (e.g. "AC CHECK UP")
//   price         — numeric price in PHP (0 for FREE / PACKAGE items)
//   priceNote     — original text when price wasn't numeric (e.g. "FREE - LEAK TEST ONLY"), else null
//   categoryCode  — category abbreviation (e.g. "AC")
//   category      — category display name (e.g. "Aircon Services")
//   branchCode    — branch identifier (e.g. "MGCAVITE")
//
// Replaces caviteServices for labor autocomplete. caviteServices is retained
// as backup — no reads, no deletes.

import {
  collection, doc, getDocs, limit, onSnapshot, orderBy, query,
  serverTimestamp, where, writeBatch,
} from 'firebase/firestore'
import { auth, db } from './firebase'

const COLLECTION = 'branchServices'

// ── Branch code mapping ──────────────────────────────────────────────────
// Maps sheet names / identifiers from the Excel to Firestore branch codes.

export const BRANCH_MAP = {
  'Cavite':      'MGCAVITE',
  'Quezon City': 'MGQUEZON CITY',
  'Pampanga':    'MGPAMPANGA',
  'Davao':       'MGDAVAO',
  'Palawan':     'MGPALAWAN',
  'Batangas':    'MGBATANGAS',
}

export const BRANCH_CODES = Object.values(BRANCH_MAP)

// ── Watcher ──────────────────────────────────────────────────────────────

export function watchBranchServices(branchCode, cb) {
  if (!db) { cb({ rows: [], source: 'unconfigured' }); return () => {} }
  const q = branchCode
    ? query(collection(db, COLLECTION), where('branchCode', '==', branchCode), orderBy('code'))
    : query(collection(db, COLLECTION), orderBy('code'))
  return onSnapshot(
    q,
    (snap) => cb({ rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })), source: 'firestore' }),
    (err) => { console.warn('[branchServices] err:', err); cb({ rows: [], source: 'error', error: err }) },
  )
}

// ── Count ────────────────────────────────────────────────────────────────

export async function countBranchServices(branchCode) {
  if (!db) return 0
  try {
    const q = branchCode
      ? query(collection(db, COLLECTION), where('branchCode', '==', branchCode), limit(10000))
      : query(collection(db, COLLECTION), limit(10000))
    const snap = await getDocs(q)
    return snap.size
  } catch {
    return 0
  }
}

// ── Row validator ────────────────────────────────────────────────────────

function normName(s) {
  if (s == null) return ''
  return String(s).replace(/\s+/g, ' ').trim().toUpperCase()
}

function parsePrice(raw) {
  if (raw == null || raw === '') return { price: 0, priceNote: null }
  // Already a number
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { price: raw, priceNote: null }
  }
  const s = String(raw).trim()
  // Try to parse as number (handles "500", "2,500", "15,000")
  const cleaned = s.replace(/,/g, '')
  const n = Number(cleaned)
  if (Number.isFinite(n) && n > 0) {
    return { price: n, priceNote: null }
  }
  // Non-numeric — FREE, PACKAGE, etc. Store as note, price = 0
  return { price: 0, priceNote: s }
}

export function cleanBranchServiceRow(raw, branchCode) {
  const code = (raw?.CODE || '').toString().trim()
  const serviceName = normName(raw?.['SERVICE NAME'])
  const { price, priceNote } = parsePrice(raw?.['PRICE (PHP)'])
  const categoryCode = (raw?.['CATEGORY CODE'] || '').toString().trim()
  const category = (raw?.CATEGORY || '').toString().trim()

  if (!code) return { ok: false, reason: 'Missing CODE' }
  if (!serviceName) return { ok: false, reason: 'Missing SERVICE NAME' }
  if (!branchCode) return { ok: false, reason: 'Missing branchCode' }

  return {
    ok: true,
    row: { code, serviceName, price, priceNote, categoryCode, category, branchCode },
  }
}

// ── Analyze (preview, no writes) ─────────────────────────────────────────

export async function analyzeBranchServices(rawRows, branchCode) {
  if (!rawRows || !branchCode) return null
  const existing = await fetchExisting(branchCode)
  const seen = new Map()
  const skipped = []
  const duplicates = []

  for (const r of rawRows) {
    const v = cleanBranchServiceRow(r, branchCode)
    if (!v.ok) { skipped.push(`Row code=${r?.CODE ?? '—'}: ${v.reason}`); continue }
    if (seen.has(v.row.code)) {
      duplicates.push(`${v.row.code} — kept first, dropped "${v.row.serviceName}"`)
      continue
    }
    seen.set(v.row.code, v.row)
  }

  let createCount = 0, updateCount = 0
  for (const row of seen.values()) {
    const e = existing.get(row.code)
    if (!e) {
      createCount++
    } else if (
      e.serviceName !== row.serviceName ||
      Number(e.price) !== Number(row.price) ||
      (e.priceNote || null) !== (row.priceNote || null) ||
      e.categoryCode !== row.categoryCode ||
      e.category !== row.category
    ) {
      updateCount++
    }
  }

  return {
    total: rawRows.length,
    cleanCount: seen.size,
    createCount,
    updateCount,
    skipped,
    duplicates,
  }
}

// ── Upsert ───────────────────────────────────────────────────────────────

export async function upsertBranchServices(rawRows, branchCode) {
  if (!db) throw new Error('Firestore not configured.')
  if (!branchCode) throw new Error('branchCode is required.')

  const cleaned = []
  let skipped = 0
  for (const r of rawRows) {
    const v = cleanBranchServiceRow(r, branchCode)
    if (!v.ok) { skipped++; continue }
    cleaned.push(v.row)
  }
  // Dedupe by code (keep first)
  const byCode = new Map()
  for (const r of cleaned) if (!byCode.has(r.code)) byCode.set(r.code, r)

  const uid = auth?.currentUser?.uid || null
  const rows = [...byCode.values()]
  let created = 0, updated = 0

  // Pre-fetch existing for this branch
  const existing = await fetchExisting(branchCode)

  const chunkSize = 400
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = writeBatch(db)
    for (const row of rows.slice(i, i + chunkSize)) {
      const docId = `${branchCode}_${row.code}`
      const found = existing.has(row.code)
      if (found) {
        batch.update(doc(db, COLLECTION, docId), {
          ...row,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        })
        updated++
      } else {
        batch.set(doc(db, COLLECTION, docId), {
          ...row,
          createdAt: serverTimestamp(),
          createdBy: uid,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        })
        created++
      }
    }
    await batch.commit()
  }
  return { created, updated, skipped: skipped + (cleaned.length - byCode.size) }
}

// ── Search (used by autocomplete) ────────────────────────────────────────

// In-session cache keyed by branchCode
const branchServicesCache = new Map()

export async function fetchBranchServicesForBranch(branchCode) {
  if (!db || !branchCode) return []
  if (branchServicesCache.has(branchCode)) return branchServicesCache.get(branchCode)
  const snap = await getDocs(query(
    collection(db, COLLECTION),
    where('branchCode', '==', branchCode),
    limit(2000),
  ))
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  branchServicesCache.set(branchCode, rows)
  return rows
}

export async function searchBranchLabor({ branchCode, term }) {
  const services = await fetchBranchServicesForBranch(branchCode)
  if (!term) {
    return services.slice(0, 12).map(toSuggestion)
  }
  const t = normName(term)
  const tTokens = t.split(/\s+/).filter((w) => w.length >= 3)
  const filtered = services.filter((s) => {
    const name = normName(s.serviceName)
    return name.includes(t) || tTokens.some((tok) => name.includes(tok))
  })
  return filtered.slice(0, 12).map(toSuggestion)
}

function toSuggestion(s) {
  return {
    code: s.code,
    name: s.serviceName,
    unitCost: Number(s.price) || 0,
    srp: Number(s.price) || 0,
    source: 'branch-service',
    priceNote: s.priceNote || null,
    categoryCode: s.categoryCode || null,
    category: s.category || null,
    makeName: null,
    modelName: null,
    supplier: null,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function fetchExisting(branchCode) {
  if (!db) return new Map()
  const snap = await getDocs(query(
    collection(db, COLLECTION),
    where('branchCode', '==', branchCode),
    limit(10000),
  ))
  return new Map(snap.docs.map((d) => [d.data().code, d.data()]))
}
