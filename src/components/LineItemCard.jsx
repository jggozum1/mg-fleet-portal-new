// Shared line-item editor card. Used by:
//   - ServiceReceiptCreate (new quotation / receipt)
//   - ServiceReceiptDetails / EditableItems (edit a draft quotation)
//
// One look, one set of controls. The parent owns the items array;
// this component is purely presentational + emits onChange / onRemove
// per row.
//
// Optional props:
//   - showRevisionTag: boolean — render a "Rev N" badge next to the
//     index pill (useful in the edit flow to show which round each
//     existing item came from)

import { useEffect, useState } from 'react'
import { PARTS_CATALOG } from '../lib/partsCatalog'
import { formatMoney } from '../lib/dummyData'
import { searchSuggestions } from '../lib/caviteCatalogSearch'
import Icon from './ui/Icon'

// Autocomplete queries branchServices / branchParts first (branch-specific
// pricing), falls back to caviteServices / caviteParts / caviteConsumables
// (vehicle-specific Cavite catalog), then the hand-curated PARTS_CATALOG
// seed when no catalog results are found.
export default function LineItemCard({
  index, row, onChange, onRemove, canRemove, showRevisionTag = false,
  vehicleMakeId, vehicleModelId, branchCode,
}) {
  const [showAuto, setShowAuto] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const subTotal = (Number(row.qty) || 1) * (Number(row.unitCost) || 0)

  // Debounced live search. Re-runs when type / vehicle / typed text
  // changes. 200 ms debounce keeps Firestore reads down on fast typing.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(async () => {
      try {
        const live = await searchSuggestions({
          type: row.type,
          makeId: vehicleMakeId,
          modelId: vehicleModelId,
          term: row.description || '',
          branchCode,
        })
        if (cancelled) return
        // If the live catalog returned nothing AND the user has typed
        // something, fall back to the seed list so the UX never feels
        // dead. (Useful for legacy quotes whose make/model didn't
        // resolve to caviteIds.)
        if (live.length === 0 && row.description) {
          const term = row.description.toLowerCase()
          const fallback = PARTS_CATALOG
            .filter((p) => p.name.toLowerCase().includes(term))
            .slice(0, 6)
            .map((p) => ({
              code: p.code, name: p.name, unitCost: p.srp || p.unitCost,
              srp: p.srp || p.unitCost, source: 'seed', supplier: p.supplier || null,
              makeName: null, modelName: null,
            }))
          setSuggestions(fallback)
        } else {
          setSuggestions(live)
        }
      } catch (err) {
        console.warn('[LineItemCard] search failed:', err)
        if (!cancelled) setSuggestions([])
      }
    }, 200)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [row.type, row.description, vehicleMakeId, vehicleModelId, branchCode])

  const pick = (p) => {
    onChange({ description: p.name, unitCost: p.unitCost || p.srp })
    setShowAuto(false)
  }

  const isLabor = row.type === 'Labor'
  return (
    <div className={`bg-white rounded-2xl border overflow-hidden ${isLabor ? 'border-sky-200' : 'border-gray-200'}`}>
      <div className={`px-4 py-2 border-b flex items-center justify-between ${isLabor ? 'bg-sky-50' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${isLabor ? 'bg-sky-600 text-white' : 'bg-gray-700 text-white'}`}>
            #{index + 1} · {isLabor ? 'Labor' : 'Parts'}
          </span>
          {showRevisionTag && row.revisionRound > 1 && (
            <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-amber-500 text-white">
              Rev {row.revisionRound}
            </span>
          )}
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-red-600 hover:text-red-700 font-bold flex items-center gap-1"
          >
            <Icon name="warn" className="w-3.5 h-3.5" />
            Remove
          </button>
        )}
      </div>
      <div className="p-4 space-y-3">
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Type</label>
          <div className="grid grid-cols-2 gap-2">
            {['Labor', 'Parts/Materials'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onChange({ type: t })}
                className={`text-sm font-bold py-2.5 rounded-xl border-2 transition-colors ${
                  row.type === t
                    ? (t === 'Labor' ? 'bg-sky-600 border-sky-600 text-white' : 'bg-gray-800 border-gray-800 text-white')
                    : 'bg-white border-gray-200 text-gray-600'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">
            Service / Parts / Materials
          </label>
          <input
            className="input"
            value={row.description}
            onChange={(e) => { onChange({ description: e.target.value }); setShowAuto(true) }}
            onFocus={() => setShowAuto(true)}
            onBlur={() => setTimeout(() => setShowAuto(false), 150)}
            placeholder="Search catalog or enter custom…"
          />
          {showAuto && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-20 mt-1 bg-white border rounded-xl shadow-xl text-xs max-h-64 overflow-y-auto">
              {suggestions.map((p, i) => (
                <button type="button" key={`${p.source}-${p.code}-${i}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className="block w-full text-left px-3 py-2 hover:bg-sky-50 border-b last:border-b-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-800">{p.name}</span>
                    <span className="font-mono text-[10px] text-gray-400">({p.code})</span>
                    <SourceTag source={p.source} />
                  </div>
                  {(p.makeName || p.modelName) && (
                    <div className="text-[11px] text-gray-500">
                      {[p.makeName, p.modelName].filter(Boolean).join(' → ')}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-500 flex items-center gap-2 mt-0.5">
                    <span className="font-bold text-green-700">{formatMoney(p.srp || p.unitCost)}</span>
                    {p.supplier && <span>· {p.supplier}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Qty</label>
            <div className="flex items-center bg-gray-50 border rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => onChange({ qty: Math.max(1, (row.qty || 1) - 1) })}
                className="w-10 h-11 text-xl font-black text-gray-600 hover:bg-gray-100"
              >
                −
              </button>
              <input
                type="number"
                min="1"
                value={row.qty}
                onChange={(e) => onChange({ qty: Math.max(1, Number(e.target.value) || 1) })}
                className="flex-1 bg-transparent text-center font-bold text-base focus:outline-none min-w-0"
              />
              <button
                type="button"
                onClick={() => onChange({ qty: (row.qty || 1) + 1 })}
                className="w-10 h-11 text-xl font-black text-gray-600 hover:bg-gray-100"
              >
                +
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Unit Cost</label>
            <input
              type="number"
              min="0"
              value={row.unitCost}
              onChange={(e) => onChange({ unitCost: Number(e.target.value) || 0 })}
              className="input text-right font-mono"
            />
          </div>
        </div>

        <div className="bg-gray-50 rounded-xl px-4 py-2.5 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">Sub Total</span>
          <span className="text-lg font-black text-gray-900">{formatMoney(subTotal)}</span>
        </div>
      </div>
    </div>
  )
}

// Visual label distinguishing a Service / Part / Consumable / Seed
// suggestion in the autocomplete dropdown. Keeps the UI honest about
// which catalog produced each row.
function SourceTag({ source }) {
  const config = {
    'branch-service': { label: 'Branch',      cls: 'bg-violet-100 text-violet-800' },
    'branch-part':    { label: 'Branch Part', cls: 'bg-violet-100 text-violet-800' },
    service:    { label: 'Service',    cls: 'bg-sky-100 text-sky-800' },
    part:       { label: 'Part',       cls: 'bg-amber-100 text-amber-800' },
    consumable: { label: 'Universal',  cls: 'bg-emerald-100 text-emerald-800' },
    seed:       { label: 'Seed',       cls: 'bg-gray-100 text-gray-600' },
  }
  const c = config[source] || config.seed
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${c.cls}`}>
      {c.label}
    </span>
  )
}
