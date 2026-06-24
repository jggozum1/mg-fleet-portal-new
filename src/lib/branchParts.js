// Branch Parts catalog — per-branch parts & consumables pricing.
//
// Firestore collection: `branchParts`
// Each doc represents one part at one branch.
// Doc ID: `${branchCode}_${partNumber}` for idempotent upsert.
//
// Fields:
//   partNumber    — part code (e.g. "AC60E")
//   description   — display name (e.g. "2GD MASTER KIT")
//   vehicleMake   — make name (e.g. "TOYOTA", "ALL" for universal)
//   models        — pipe-separated model list or null
//   price         — numeric SRP in PHP (0 when not yet priced)
//   branchCode    — standard branch code (e.g. "MGCAVITE")
//
// Separate from caviteParts — that collection is retained as backup.

import {
  collection, doc, getDocs, limit, onSnapshot, orderBy, query,
  serverTimestamp, where, writeBatch,
} from 'firebase/firestore'
import { auth, db } from './firebase'

const COLLECTION = 'branchParts'

// ── BranchID → standard branch code mapping ──────────────────────────────
// From the "MG Branch ID" sheet in the Excel file.

export const BRANCH_ID_MAP = {
  2: 'MGCAVITE',
  3: 'MGQUEZON CITY',
  4: 'MGDAVAO',
  5: 'MGPAMPANGA',
  6: 'MGPALAWAN',
  7: 'MGBATANGAS',
}

export const BRANCH_CODES = Object.values(BRANCH_ID_MAP)

// ── Watcher ──────────────────────────────────────────────────────────────

export function watchBranchParts(branchCode, cb) {
  if (!db) { cb({ rows: [], source: 'unconfigured' }); return () => {} }
  const q = branchCode
    ? query(collection(db, COLLECTION), where('branchCode', '==', branchCode), orderBy('description'))
    : query(collection(db, COLLECTION), orderBy('description'))
  return onSnapshot(
    q,
    (snap) => cb({ rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })), source: 'firestore' }),
    (err) => { console.warn('[branchParts] err:', err); cb({ rows: [], source: 'error', error: err }) },
  )
}

// ── Count ────────────────────────────────────────────────────────────────

export async function countBranchParts(branchCode) {
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

export function cleanBranchPartRow(raw, branchCode) {
  // The Excel columns (by index): #, Part Number, Description, Vehicle Make, Models, Branch SRP, BranchID
  // When parsed via sheet_to_json with header row, keys are the header names.
  const partNumber = (raw?.['Part Number'] || '').toString().trim()
  const description = normName(raw?.Description)
  const vehicleMake = normName(raw?.['Vehicle Make'])
  const models = raw?.Models != null ? String(raw.Models).trim() : null
  const rawPrice = raw?.['Branch SRP']
  const price = (rawPrice != null && Number.isFinite(Number(rawPrice))) ? Number(rawPrice) : 0

  if (!partNumber) return { ok: false, reason: 'Missing Part Number' }
  if (!description) return { ok: false, reason: 'Missing Description' }
  if (!branchCode) return { ok: false, reason: 'Missing branchCode' }

  return {
    ok: true,
    row: { partNumber, description, vehicleMake, models, price, branchCode },
  }
}

// ── Analyze (preview, no writes) ─────────────────────────────────────────

export async function analyzeBranchParts(rawRows, branchCode) {
  if (!rawRows || !branchCode) return null
  const existing = await fetchExisting(branchCode)
  const seen = new Map()
  const skipped = []
  const duplicates = []

  for (const r of rawRows) {
    const v = cleanBranchPartRow(r, branchCode)
    if (!v.ok) { skipped.push(`Row part=${r?.['Part Number'] ?? '—'}: ${v.reason}`); continue }
    if (seen.has(v.row.partNumber)) {
      duplicates.push(`${v.row.partNumber} — kept first, dropped "${v.row.description}"`)
      continue
    }
    seen.set(v.row.partNumber, v.row)
  }

  let createCount = 0, updateCount = 0
  for (const row of seen.values()) {
    const e = existing.get(row.partNumber)
    if (!e) {
      createCount++
    } else if (
      e.description !== row.description ||
      Number(e.price) !== Number(row.price) ||
      e.vehicleMake !== row.vehicleMake ||
      (e.models || null) !== (row.models || null)
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

export async function upsertBranchParts(rawRows, branchCode) {
  if (!db) throw new Error('Firestore not configured.')
  if (!branchCode) throw new Error('branchCode is required.')

  const cleaned = []
  let skipped = 0
  for (const r of rawRows) {
    const v = cleanBranchPartRow(r, branchCode)
    if (!v.ok) { skipped++; continue }
    cleaned.push(v.row)
  }
  // Dedupe by partNumber (keep first)
  const byPart = new Map()
  for (const r of cleaned) if (!byPart.has(r.partNumber)) byPart.set(r.partNumber, r)

  const uid = auth?.currentUser?.uid || null
  const rows = [...byPart.values()]
  let created = 0, updated = 0

  const existing = await fetchExisting(branchCode)

  const chunkSize = 400
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = writeBatch(db)
    for (const row of rows.slice(i, i + chunkSize)) {
      const docId = `${branchCode}_${row.partNumber}`
      const found = existing.has(row.partNumber)
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
  return { created, updated, skipped: skipped + (cleaned.length - byPart.size) }
}

// ── Search (used by autocomplete) ────────────────────────────────────────

// In-session cache keyed by branchCode
const branchPartsCache = new Map()

export async function fetchBranchPartsForBranch(branchCode) {
  if (!db || !branchCode) return []
  if (branchPartsCache.has(branchCode)) return branchPartsCache.get(branchCode)
  const snap = await getDocs(query(
    collection(db, COLLECTION),
    where('branchCode', '==', branchCode),
    limit(5000),
  ))
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  branchPartsCache.set(branchCode, rows)
  return rows
}

export async function searchBranchParts({ branchCode, term }) {
  const parts = await fetchBranchPartsForBranch(branchCode)
  if (!term) {
    return parts.slice(0, 12).map(toSuggestion)
  }
  const t = normName(term)
  const tTokens = t.split(/\s+/).filter((w) => w.length >= 3)
  const filtered = parts.filter((p) => {
    const desc = normName(p.description)
    return desc.includes(t) || tTokens.some((tok) => desc.includes(tok))
  })
  return filtered.slice(0, 12).map(toSuggestion)
}

function toSuggestion(p) {
  return {
    code: p.partNumber,
    name: p.description,
    unitCost: Number(p.price) || 0,
    srp: Number(p.price) || 0,
    source: 'branch-part',
    priceNote: null,
    makeName: p.vehicleMake || null,
    modelName: p.models || null,
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
  return new Map(snap.docs.map((d) => [d.data().partNumber, d.data()]))
}
