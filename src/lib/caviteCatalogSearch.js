// Cavite catalog search — runtime helpers used by the line-item
// autocomplete on quotation create + edit + revision flows.
//
// Round 35 (per cowork's Phase 2 spec).
//
// Strategy:
//   - For Labor lines: fetch all SERVICES for the vehicle's
//     (caviteMakeId, caviteModelId) once, cache, filter client-side
//     by the user's typed text.
//   - For Parts/Materials lines: fetch all PARTS for the vehicle
//     once, fetch all CONSUMABLES once (universal), cache both,
//     merge + filter client-side by description text. Each result
//     carries a `source: 'service' | 'part' | 'consumable'` tag.
//   - Caches keyed by `${makeId}-${modelId}` (and just '*' for
//     consumables). Cleared on session end via in-memory only —
//     Firestore is the source of truth.
//
// Free-text vehicle resolution: when a quote was created without a
// caviteMakeId/caviteModelId, we attempt a name-based lookup against
// refVehicleBrands + refVehicleModels. Falls back to {null, null}
// if the names don't match anything.

import {
  collection, getDocs, limit, query, where,
} from 'firebase/firestore'
import { db } from './firebase'
import { getAllBrands, getAllModels } from './refVehicles'
import { searchBranchLabor } from './branchServices'
import { searchBranchParts } from './branchParts'

// ── In-session caches ─────────────────────────────────────────────────────

const servicesCache = new Map() // `${makeId}-${modelId}` → Service[]
const partsCache    = new Map()
let consumablesCache = null     // Consumable[] | null
let brandsByNameCache = null    // Map<normalizedName, Brand>
let modelsByNameCache = null    // Map<`${makeId}|normalizedModel`, Model>

function normName(s) {
  if (s == null) return ''
  return String(s).replace(/\s+/g, ' ').trim().toUpperCase()
}

function key(makeId, modelId) {
  return `${makeId ?? '_'}-${modelId ?? '_'}`
}

// ── Vehicle ID resolver ──────────────────────────────────────────────────

// Given free-text make + model names from a legacy quote, try to
// resolve them to caviteId integers. Returns { makeId, modelId },
// either field null if no match. Fully cached after first call.
export async function resolveVehicleIds(makeName, modelName) {
  if (!db) return { makeId: null, modelId: null }
  if (!brandsByNameCache) {
    const brands = await getAllBrands()
    brandsByNameCache = new Map(brands.map((b) => [normName(b.name), { ...b }]))
  }
  const m = normName(makeName)
  const brand = m ? brandsByNameCache.get(m) : null
  if (!brand) return { makeId: null, modelId: null }
  const makeId = Number(brand.caviteId)

  if (!modelsByNameCache) {
    const models = await getAllModels()
    modelsByNameCache = new Map(
      models.map((md) => [`${md.caviteMakeId}|${normName(md.name)}`, { ...md }]),
    )
  }
  const mn = normName(modelName)
  if (!mn) return { makeId, modelId: null }
  const model = modelsByNameCache.get(`${makeId}|${mn}`)
  return { makeId, modelId: model ? Number(model.caviteId) : null }
}

// Convenience: resolve from a `vehicle` object that may already have
// caviteIds, falling back to free-text resolution otherwise.
export async function resolveVehicleFor(vehicle) {
  if (!vehicle) return { makeId: null, modelId: null }
  if (Number.isFinite(vehicle.caviteMakeId) && Number.isFinite(vehicle.caviteModelId)) {
    return { makeId: Number(vehicle.caviteMakeId), modelId: Number(vehicle.caviteModelId) }
  }
  if (vehicle.makeId && vehicle.modelId) {
    return { makeId: Number(vehicle.makeId), modelId: Number(vehicle.modelId) }
  }
  return resolveVehicleIds(vehicle.make || vehicle.brand, vehicle.model)
}

// ── Catalog fetchers (cached) ────────────────────────────────────────────

async function fetchServicesForVehicle(makeId, modelId) {
  if (!db || !Number.isFinite(makeId) || !Number.isFinite(modelId)) return []
  const k = key(makeId, modelId)
  if (servicesCache.has(k)) return servicesCache.get(k)
  const snap = await getDocs(query(
    collection(db, 'caviteServices'),
    where('serviceMakeId', '==', Number(makeId)),
    where('serviceModelId', '==', Number(modelId)),
    limit(2000),
  ))
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  servicesCache.set(k, rows)
  return rows
}

async function fetchPartsForVehicle(makeId, modelId) {
  if (!db || !Number.isFinite(makeId) || !Number.isFinite(modelId)) return []
  const k = key(makeId, modelId)
  if (partsCache.has(k)) return partsCache.get(k)
  const snap = await getDocs(query(
    collection(db, 'caviteParts'),
    where('partsMakeId', '==', Number(makeId)),
    where('partsModelId', '==', Number(modelId)),
    limit(5000),
  ))
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  partsCache.set(k, rows)
  return rows
}

async function fetchAllConsumables() {
  if (!db) return []
  if (consumablesCache) return consumablesCache
  const snap = await getDocs(query(collection(db, 'caviteConsumables'), limit(2000)))
  consumablesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  return consumablesCache
}

// ── Search functions used by the autocomplete ────────────────────────────

// Returns unified suggestion shape:
//   { code, name, unitCost, srp, source, makeName, modelName, supplier }
// `source` tells the UI how to label the row; the LineItemCard will
// show "(Service)" / "(Part)" / "(Consumable)" suffixes.

export async function searchLabor({ makeId, modelId, term }) {
  const t = normName(term)
  if (!Number.isFinite(makeId) || !Number.isFinite(modelId)) return []
  const services = await fetchServicesForVehicle(makeId, modelId)
  const tTokens = t ? t.split(/\s+/).filter((w) => w.length >= 3) : []
  const filtered = t
    ? services.filter((s) => {
        const desc = normName(s.serviceDesc)
        return desc.includes(t) || tTokens.some((tok) => desc.includes(tok))
      })
    : services
  return filtered.slice(0, 12).map((s) => ({
    code: s.serviceCode || `SVC-${s.serviceId}`,
    name: s.serviceDesc,
    unitCost: Number(s.serviceSrp) || 0,
    srp: Number(s.serviceSrp) || 0,
    source: 'service',
    makeName: s.makeName || null,
    modelName: s.modelName || null,
    supplier: null,
  }))
}

export async function searchPartsAndConsumables({ makeId, modelId, term }) {
  const t = normName(term)
  // Parts only filterable when we have IDs; without them we still
  // surface consumables so the autocomplete isn't empty.
  const [parts, consumables] = await Promise.all([
    Number.isFinite(makeId) && Number.isFinite(modelId)
      ? fetchPartsForVehicle(makeId, modelId)
      : Promise.resolve([]),
    fetchAllConsumables(),
  ])
  const tTokens = t ? t.split(/\s+/).filter((w) => w.length >= 3) : []
  const partResults = (t
    ? parts.filter((p) => {
        const desc = normName(p.partsDesc)
        return desc.includes(t) || tTokens.some((tok) => desc.includes(tok))
      })
    : parts
  ).slice(0, 8).map((p) => ({
    code: p.productCode || `PRT-${p.partsId}`,
    name: p.partsDesc,
    unitCost: Number(p.partsSrp) || 0,
    srp: Number(p.partsSrp) || 0,
    source: 'part',
    makeName: p.makeName || null,
    modelName: p.modelName || null,
    supplier: p.supplierId != null ? `S#${p.supplierId}` : null,
  }))
  const consumableResults = (t
    ? consumables.filter((c) => {
        const desc = normName(c.consumableDesc)
        return desc.includes(t) || tTokens.some((tok) => desc.includes(tok))
      })
    : consumables
  ).slice(0, 8).map((c) => ({
    code: c.consumableCode || `CON-${c.consumableId}`,
    name: c.consumableDesc,
    unitCost: Number(c.consumableSrp) || 0,
    srp: Number(c.consumableSrp) || 0,
    source: 'consumable',
    makeName: null,
    modelName: null,
    supplier: c.supplierId != null ? `S#${c.supplierId}` : null,
  }))
  // Parts first (vehicle-specific), then consumables (universal).
  return [...partResults, ...consumableResults]
}

// Convenience: the autocomplete's debounced fetcher picks the right
// search function based on the row's `type` field.
//
// When `branchCode` is provided, Labor searches hit `branchServices`
// first (flat per-branch pricing). Falls back to the vehicle-specific
// caviteServices catalog if branchServices returns nothing.
export async function searchSuggestions({ type, makeId, modelId, term, branchCode }) {
  if (type === 'Labor') {
    // Try branch-specific services first
    if (branchCode) {
      const branchResults = await searchBranchLabor({ branchCode, term })
      if (branchResults.length > 0) return branchResults
    }
    // Fallback to vehicle-specific Cavite catalog
    return searchLabor({ makeId, modelId, term })
  }
  // Parts/Materials: try branch-specific parts first, fall back to Cavite catalog
  if (branchCode) {
    const branchResults = await searchBranchParts({ branchCode, term })
    if (branchResults.length > 0) return branchResults
  }
  return searchPartsAndConsumables({ makeId, modelId, term })
}
