// Create Service Receipt — writes to Firestore via createReceipt.
//
// Mobile: line items become a vertical stack of cards with proper-sized
// inputs and per-card remove/duplicate controls. Grand total lives in a
// sticky footer above the submit bar. Desktop keeps the table.

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { collection, getDocs, limit, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../context/AuthContext'
import { formatMoney } from '../lib/dummyData'
import { watchVehicles } from '../lib/vehicles'
import { watchUsers } from '../lib/users'
import { createReceipt } from '../lib/serviceReceipts'
import { getFleetCompanyByName } from '../lib/fleetCompanies'
import {
  enrichItemsWithCatalogPrices,
  extractAssessmentNotes, extractHeaderPrefill,
  suggestQuoteItemsFromAssessment, summarizeAssessmentForQuote,
} from '../lib/assessmentToQuote'
import Icon from '../components/ui/Icon'
import PageHero from '../components/ui/PageHero'
import LineItemCard from '../components/LineItemCard'
import LineItemRow, { LineItemHeader } from '../components/LineItemRow'
import { resolveVehicleIds } from '../lib/caviteCatalogSearch'

// `kind` is "receipt" (default) or "quotation" — chosen by the route the user
// arrived from. A quotation enters the Round 10 approval chain at DRAFT; a
// receipt goes straight into the OPEN → PAID/CANCELLED flow.
export default function ServiceReceiptCreate({ kind = 'receipt' }) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const initialPlate = (search.get('plate') || '').toUpperCase()
  const fromAssessment = search.get('fromAssessment') || ''
  const isQuotation = kind === 'quotation'

  // Smart prefill from a completed assessment (Round 17). Loaded once on
  // mount when the URL carries ?fromAssessment=RWA-####. We replace the
  // default seed items with the suggestions; the user can still edit any
  // line and add/remove rows.
  const [prefillBanner, setPrefillBanner] = useState(null)
  // Track whether the assessment prefill already ran so the vehicle-
  // registry effect (below) doesn't clobber the assessor's odometer.
  const [assessmentPrefilled, setAssessmentPrefilled] = useState(false)

  const ASSESSOR_ROLES = new Set(['field_assessor', 'warrior', 'dispatcher', 'technician'])
  const [vehicles, setVehicles] = useState([])
  const [allUsers, setAllUsers] = useState([])
  useEffect(() => {
    const u1 = watchVehicles({}, ({ vehicles }) => setVehicles(vehicles))
    const u2 = watchUsers((list) => setAllUsers(list))
    return () => { u1?.(); u2?.() }
  }, [])

  const userBranch = (profile?.branch || '').toUpperCase().trim()
  const mechanicUsers = useMemo(() => {
    return allUsers
      .filter((u) => {
        if (!ASSESSOR_ROLES.has(String(u.role || '').toLowerCase())) return false
        if (u.is_active === 0) return false
        if (userBranch) return (u.branch || '').toUpperCase().trim() === userBranch
        return true
      })
      .map((u) => ({ id: u.id, name: u.name || u.email || '—', branch: u.branch || null }))
  }, [allUsers, userBranch])

  const [plate, setPlate] = useState(initialPlate)
  const vehicle = useMemo(
    () => vehicles.find((v) => v.plateNo === plate) || vehicles[0] || {},
    [plate, vehicles],
  )

  // Round 35/36 — vehicle catalog IDs for the autocomplete. Prefer
  // the caviteIds the assessment captured via the dropdown picker
  // (Round 36); only fall back to free-text name resolution for
  // legacy assessments that don't carry IDs.
  const [vehicleIds, setVehicleIds] = useState({ makeId: null, modelId: null })
  useEffect(() => {
    if (Number.isFinite(vehicle?.caviteMakeId) && Number.isFinite(vehicle?.caviteModelId)) {
      setVehicleIds({ makeId: vehicle.caviteMakeId, modelId: vehicle.caviteModelId })
      return
    }
    if (!vehicle?.brand && !vehicle?.brandModel) return
    let cancelled = false
    resolveVehicleIds(vehicle.brand, vehicle.model).then((ids) => {
      if (!cancelled) setVehicleIds(ids)
    })
    return () => { cancelled = true }
  }, [vehicle?.caviteMakeId, vehicle?.caviteModelId, vehicle?.brand, vehicle?.model])

  const [odo, setOdo] = useState(vehicle.latestOdo || 0)
  // Round 25a — customer name is no longer auto-populated from the
  // vehicle registry's `assignedTo` (that field used to mistakenly carry
  // the assessor's name; see vehicles.js). Defaults blank now; the user
  // types the actual driver / contact for fleet jobs, or leaves blank
  // and lets the company name carry the bill-to.
  const [customerName, setCustomerName] = useState('')
  const [mobile, setMobile] = useState('')
  const [notes, setNotes] = useState('')
  // Round 25a — was hardcoded 'Amelia Castillo' (a name from dummy
  // mechanics seed data). Now defaults blank; the prefill effect below
  // sets it from the appointment's assigned mechanic when available.
  const [mechanic, setMechanic] = useState('')
  const [items, setItems] = useState([
    { type: 'Labor', qty: 1, description: 'PREVENTIVE MAINTENANCE SERVICE', unitCost: 2500 },
    { type: 'Parts', qty: 1, description: '', unitCost: 0 },
  ])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Broker markup — look up fleet company when vehicle.company is known
  const [brokerInfo, setBrokerInfo] = useState(null) // { percent }
  const [applyBrokerMarkup, setApplyBrokerMarkup] = useState(false)
  useEffect(() => {
    const companyName = vehicle?.company
    if (!companyName) { setBrokerInfo(null); setApplyBrokerMarkup(false); return }
    let cancelled = false
    getFleetCompanyByName(companyName).then((co) => {
      if (cancelled) return
      if (co?.hasBrokerMarkup && Number(co.brokerMarkupPercent) > 0) {
        setBrokerInfo({ percent: Number(co.brokerMarkupPercent) })
        setApplyBrokerMarkup(false)
      } else {
        setBrokerInfo(null)
        setApplyBrokerMarkup(false)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [vehicle?.company])

  // Sync to selected vehicle when list arrives / plate changes. Skipped
  // when the assessment prefill already wrote the odometer/customer —
  // that path has fresher data and we don't want to clobber it.
  // Round 25a — customer no longer pulled from vehicle.assignedTo
  // (that field used to leak the assessor's name).
  useEffect(() => {
    if (!vehicle || !vehicle.plateNo) return
    if (vehicle.plateNo !== plate) return
    if (!assessmentPrefilled) setOdo(vehicle.latestOdo || 0)
    // Always prefill driver/mobile from vehicle registry
    if (vehicle.assignedTo) setCustomerName(vehicle.assignedTo)
    if (vehicle.mobileNo) setMobile(vehicle.mobileNo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, plate])

  // Load the source assessment (if any) and seed line items from it. Runs
  // exactly once per fromAssessment param value. If the assessment is
  // missing or has no failed items, leave the default seed alone and
  // surface a soft warning instead of a success banner.
  useEffect(() => {
    if (!fromAssessment || !db) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'assessments'),
          where('rwaNumber', '==', fromAssessment),
          limit(1),
        ))
        if (cancelled) return
        if (snap.empty) {
          setPrefillBanner({ tone: 'warn', text: `Assessment ${fromAssessment} not found — starting with a blank quote.` })
          return
        }
        const a = { _docId: snap.docs[0].id, ...snap.docs[0].data() }
        const suggestions = suggestQuoteItemsFromAssessment(a)
        const summary = summarizeAssessmentForQuote(a)

        // Round 21 — header + notes prefill always run, even when there
        // are zero suggested line items. The assessor's odometer reading
        // and any per-item notes are still useful on a "blank" quote.
        const headerPrefill = extractHeaderPrefill(a)
        if (headerPrefill.odometer != null) setOdo(headerPrefill.odometer)
        if (headerPrefill.mechanic) setMechanic(headerPrefill.mechanic)
        // Notes: prepend the assessment notes; preserve any user input.
        const assessmentNotes = extractAssessmentNotes(a)
        if (assessmentNotes) {
          setNotes((prev) => prev ? `${assessmentNotes}\n\n${prev}` : assessmentNotes)
        }
        // Lock out the vehicle-registry effect from overwriting the
        // odometer/customer — the assessment is now the source of truth
        // for this quote.
        setAssessmentPrefilled(true)

        if (suggestions.length === 0) {
          setPrefillBanner({ tone: 'info', text: `Assessment ${summary.rwa || fromAssessment} had no critical or monitor findings — nothing to prefill on line items. Header fields and notes were carried over.` })
          return
        }
        // Round 37 — auto-price the suggestions against the live Cavite
        // catalog. Uses the assessment header's caviteIds (Round 36)
        // so the price lookup is exact-FK, not name-resolved.
        let headerMakeId = Number(a?.header?.makeId)
        let headerModelId = Number(a?.header?.modelId)
        // If no caviteIds on the assessment, resolve from make/model names
        if (!Number.isFinite(headerMakeId) || !Number.isFinite(headerModelId)) {
          try {
            const resolved = await resolveVehicleIds(a?.header?.make, a?.header?.model)
            if (Number.isFinite(resolved.makeId)) headerMakeId = resolved.makeId
            if (Number.isFinite(resolved.modelId)) headerModelId = resolved.modelId
          } catch (err) {
            console.warn('[quote-create] resolveVehicleIds failed:', err)
          }
        }
        const priced = await enrichItemsWithCatalogPrices(suggestions, {
          makeId: Number.isFinite(headerMakeId) ? headerMakeId : null,
          modelId: Number.isFinite(headerModelId) ? headerModelId : null,
          branchCode: profile?.branch_code || profile?.branch || null,
        })
        if (cancelled) return
        const pricedCount = priced.filter((i) => Number(i.unitCost) > 0).length
        setItems(priced)
        const parts = []
        if (summary.laborCount > 0) {
          parts.push(`${summary.laborCount} labor type${summary.laborCount === 1 ? '' : 's'} declared`)
        }
        parts.push(`${summary.criticalCount} critical finding${summary.criticalCount === 1 ? '' : 's'}`)
        if (summary.monitorCount > 0) parts.push(`${summary.monitorCount} monitor item${summary.monitorCount === 1 ? '' : 's'}`)
        if (summary.holdCount > 0) parts.push(`${summary.holdCount} hold-unit`)
        const sourceNote = summary.laborSource === 'derived'
          ? ' Labor lines were derived per item (no labors declared on this assessment).'
          : ''
        const priceNote = pricedCount > 0
          ? ` ${pricedCount} of ${priced.length} priced from the branch catalog — review the rest.`
          : ' No catalog price matches — fill unit costs manually.'
        setPrefillBanner({
          tone: 'success',
          text: `Prefilled ${suggestions.length} line${suggestions.length === 1 ? '' : 's'} from ${summary.rwa || fromAssessment} (${parts.join(', ')}).${sourceNote}${priceNote}`,
        })
      } catch (err) {
        console.error('[quote prefill] failed:', err)
        if (!cancelled) setPrefillBanner({ tone: 'warn', text: 'Could not load assessment for prefill — starting with a blank quote.' })
      }
    })()
    return () => { cancelled = true }
  }, [fromAssessment])

  const markupMultiplier = applyBrokerMarkup && brokerInfo ? 1 + brokerInfo.percent / 100 : 1
  const hasMarkup = markupMultiplier !== 1
  // Display items apply markup to unitCost for rendering; base items stay editable
  const displayItems = hasMarkup
    ? items.map((i) => ({ ...i, unitCost: Math.round(i.unitCost * markupMultiplier * 100) / 100 }))
    : items
  const laborTotal = displayItems.filter((i) => i.type === 'Labor').reduce((s, i) => s + i.qty * i.unitCost, 0)
  const matTotal   = displayItems.filter((i) => i.type !== 'Labor').reduce((s, i) => s + i.qty * i.unitCost, 0)
  const grandTotal = laborTotal + matTotal

  const addRow = () => setItems([...items, { type: 'Parts/Materials', qty: 1, description: '', unitCost: 0 }])
  const removeRow = (i) => setItems(items.filter((_, idx) => idx !== i))
  const updateRow = (i, patch) => setItems(items.map((row, idx) => idx === i ? { ...row, ...patch } : row))

  const submit = async (e) => {
    e.preventDefault()
    setSubmitting(true); setError(null)
    try {
      const { code } = await createReceipt(kind, {
        plateNo: plate,
        brandModel: vehicle.brandModel || '',
        latestOdo: odo,
        customer: customerName,
        mobile,
        company: vehicle.company || null,
        branch: (profile?.branch || 'MGCAVITE').toUpperCase(),
        mechanic,
        personInCharge: profile?.name || 'Admin',
        scheduleType: 'SCHEDULED',
        items: applyBrokerMarkup && brokerInfo
          ? items.map((i) => ({
              ...i,
              baseUnitCost: i.unitCost,
              baseSubTotal: i.qty * i.unitCost,
              unitCost: Math.round(i.unitCost * markupMultiplier * 100) / 100,
            }))
          : items,
        notes,
        sourceAssessmentRwa: fromAssessment || null,
        byProfile: profile,
        brokerMarkup: applyBrokerMarkup && brokerInfo ? { percent: brokerInfo.percent, companyName: vehicle.company } : null,
      })
      navigate(`/service-receipts/${code}`)
    } catch (err) {
      console.error('[receipt] create failed', err)
      setError(err.message || String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="pb-32">
      <PageHero
        eyebrow={isQuotation ? 'NEW QUOTATION' : 'NEW RECEIPT'}
        title={isQuotation ? 'Create Service Quotation' : 'Create Service Receipt'}
        subtitle={plate ? `${plate}${vehicle.brandModel ? ` · ${vehicle.brandModel}` : ''}` : 'Enter customer + vehicle details below'}
        right={<GrandTotalChip value={grandTotal} />}
      />

      <div className="px-3 sm:px-6 pt-4 space-y-4">
        {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-3 py-2 text-sm">Save failed: {error}</div>}

        {/* Round 29 — banner shown when the user lands on quote create
            without ?fromAssessment=. The proper flow is booking →
            assess → "Create Quotation" CTA. This direct path skips
            assessment, so the prefill won't run and the audit trail
            won't link a quote to a roadworthy check. Kept as a backdoor
            for legacy / edge cases. */}
        {isQuotation && !fromAssessment && (
          <div className="rounded-xl px-3 py-2.5 text-sm border bg-amber-50 border-amber-200 text-amber-900">
            <div className="flex items-start gap-2">
              <span className="text-lg leading-none">⚠️</span>
              <div className="flex-1 text-xs sm:text-sm">
                <div className="font-bold mb-0.5">Creating a quotation without an assessment</div>
                <div>
                  The standard process is <strong>Booking → Assess → Create Quotation</strong>. Starting here skips the assessment + smart prefill,
                  and the quote won't link to a roadworthy check.
                  Use this only for legacy / out-of-system jobs. Otherwise{' '}
                  <Link to="/appointments" className="underline font-bold">go back to Service Bookings</Link>{' '}
                  and start from there.
                </div>
              </div>
            </div>
          </div>
        )}

        {prefillBanner && (
          <div className={`rounded-xl px-3 py-2.5 text-sm border ${
            prefillBanner.tone === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
            : prefillBanner.tone === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-900'
            : 'bg-sky-50 border-sky-200 text-sky-900'
          }`}>
            <div className="flex items-start gap-2">
              <span className="text-lg leading-none">
                {prefillBanner.tone === 'success' ? '✓' : prefillBanner.tone === 'warn' ? '⚠️' : 'ℹ️'}
              </span>
              <div className="flex-1 text-xs sm:text-sm">{prefillBanner.text}</div>
            </div>
          </div>
        )}

        <Section title="Customer & Vehicle">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <Field label="Plate No. *">
              <input className="input uppercase font-mono" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} required />
            </Field>
            <Field label="Driver / Contact" hint="Person who turned over the unit. Optional for fleet jobs — the company is the bill-to.">
              <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value.toUpperCase())} placeholder="e.g. Juan Dela Cruz" />
            </Field>
            <Field label="Brand / Model">
              <div className="py-2 text-gray-800 text-sm">{vehicle.brandModel || '—'}</div>
            </Field>
            <Field label="Mobile No">
              <input className="input" value={mobile} onChange={(e) => setMobile(e.target.value)} />
            </Field>
            <Field label="Latest Odometer *">
              <input type="number" className="input" value={odo} onChange={(e) => setOdo(Number(e.target.value))} required />
            </Field>
            <Field label="Schedule Type">
              <div className="py-2 text-gray-800 text-sm">SCHEDULED</div>
            </Field>
          </div>
        </Section>

        {/* Line items — mobile card stack, desktop table */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Labor · Parts · Materials</div>
            <span className="text-xs text-gray-400">{items.length} item{items.length === 1 ? '' : 's'}</span>
          </div>

          {/* Mobile: vertical card stack */}
          <div className="lg:hidden space-y-3">
            {displayItems.map((row, i) => (
              <LineItemCard
                key={i}
                index={i}
                row={row}
                onChange={(patch) => updateRow(i, patch)}
                onRemove={() => removeRow(i)}
                canRemove={items.length > 1}
                vehicleMakeId={vehicleIds.makeId}
                vehicleModelId={vehicleIds.modelId}
                branchCode={profile?.branch_code || profile?.branch}
              />
            ))}
            <button
              type="button"
              onClick={addRow}
              className="w-full bg-white border-2 border-dashed border-gray-300 text-gray-600 hover:border-brand hover:text-brand rounded-2xl py-3 font-bold text-sm flex items-center justify-center gap-1.5"
            >
              <Icon name="plus" className="w-4 h-4" />
              Add Another Item
            </button>
          </div>

          {/* Desktop: table */}
          <div className="hidden lg:block bg-white rounded-2xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <LineItemHeader />
                <tbody className="divide-y">
                  {displayItems.map((row, i) => (
                    <LineItemRow
                      key={i}
                      row={row}
                      onChange={(patch) => updateRow(i, patch)}
                      onAdd={addRow}
                      onRemove={() => removeRow(i)}
                      showAddInRowAction={i === items.length - 1}
                      canRemove={items.length > 1}
                      vehicleMakeId={vehicleIds.makeId}
                      vehicleModelId={vehicleIds.modelId}
                      branchCode={profile?.branch_code || profile?.branch}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {isQuotation && brokerInfo && (
          <div className="rounded-xl px-3 py-2.5 text-sm border bg-amber-50 border-amber-200 text-amber-900">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={applyBrokerMarkup}
                onChange={(e) => setApplyBrokerMarkup(e.target.checked)}
                className="w-4 h-4 accent-amber-600"
              />
              <span className="font-bold">Apply {brokerInfo.percent}% Broker Markup</span>
            </label>
            <div className="text-xs mt-1 ml-6 text-amber-700">
              {applyBrokerMarkup
                ? `A ${brokerInfo.percent}% markup will be added on top of all line item prices when this quotation is saved.`
                : 'Markup is available for this company but will not be applied.'}
            </div>
          </div>
        )}

        <Section title="Assignment & Notes">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <Field label="Assigned Mechanic">
              <select className="input" value={mechanic} onChange={(e) => setMechanic(e.target.value)}>
                <option value="">— select —</option>
                {mechanicUsers.map((m) => (
                  <option key={m.id} value={m.name}>{m.name}{m.branch ? ` (${m.branch})` : ''}</option>
                ))}
              </select>
            </Field>
            <Field label="Total Labor" className="text-right">
              <div className="py-2 font-bold text-gray-800">{formatMoney(laborTotal)}</div>
            </Field>
            <Field label="Total Materials" className="text-right">
              <div className="py-2 font-bold text-gray-800">{formatMoney(matTotal)}</div>
            </Field>
            <Field label="Notes" className="sm:col-span-3">
              <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </Section>
      </div>

      {/* Sticky bottom submit bar with grand total */}
      <div
        className="fixed bottom-[3.5rem] md:bottom-0 left-0 right-0 z-40 bg-white border-t shadow-[0_-4px_12px_rgba(0,0,0,0.05)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
      >
        <div className="px-3 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Grand Total</div>
            <div className="text-xl sm:text-2xl font-black text-green-700 leading-tight">{formatMoney(grandTotal)}</div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-bold text-sm px-6 py-3 rounded-xl shadow active:scale-95 transition-transform shrink-0"
          >
            {submitting ? 'Saving…' : (isQuotation ? 'Save as Draft' : 'Submit Receipt')}
          </button>
        </div>
      </div>
    </form>
  )
}

function GrandTotalChip({ value }) {
  return (
    <div className="bg-white/15 rounded-xl px-3 py-2 text-right min-w-[110px]">
      <div className="text-[9px] font-bold tracking-widest text-white/60">GRAND TOTAL</div>
      <div className="text-xl font-black text-white leading-none mt-0.5">{formatMoney(value)}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-gray-50 border-b px-4 py-2.5 text-[11px] uppercase tracking-widest font-bold text-gray-500">{title}</div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Field({ label, hint, children, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">{label}</label>
      {children}
      {hint && <div className="text-[10px] text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}


