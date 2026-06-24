// Service Receipt / Quotation detail — live Firestore subscription.
//
// For receipts (kind='receipt'): customer/vehicle/items/totals + Cancel.
// For quotations (kind='quotation'): adds the 3-party approval chain —
// stepper, role-gated action bar, audit trail timeline, and a comment thread
// shared across admin supervisor / MG Fleet manager / fleet client.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { formatMoney } from '../lib/dummyData'
import {
  QUOT_STATUS, QUOT_STATUS_LABELS, QUOT_ACTION,
  availableQuotationActions, canEditQuotation, canAddRevision,
  currentRevisionRound, effectiveQuotationStatus,
  transitionQuotation, updateQuotationItems, addQuotationRevision,
  addQuotationComment, setReceiptStatus, watchReceiptByCode,
} from '../lib/serviceReceipts'
import {
  canGenerateBranchInvoice, generateBranchInvoice, findInvoiceForQuotation,
} from '../lib/branchInvoices'
import { getAssessmentsForPlate } from '../lib/assessments'
import { getMostRecentAppointmentByPlate } from '../lib/appointments'
import Icon from '../components/ui/Icon'
import PageHero from '../components/ui/PageHero'
import StatusPill from '../components/ui/StatusPill'
import LineItemCard from '../components/LineItemCard'
import LineItemRow, { LineItemHeader } from '../components/LineItemRow'
import { resolveVehicleIds } from '../lib/caviteCatalogSearch'

export default function ServiceReceiptDetails() {
  const { code } = useParams()
  const { profile } = useAuth()
  const [receipt, setReceipt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState('loading')

  useEffect(() => {
    const unsub = watchReceiptByCode(code, ({ receipt, source }) => {
      setReceipt(receipt); setSource(source); setLoading(false)
    })
    return unsub
  }, [code])

  if (loading) return <div className="p-4 sm:p-6 text-gray-500">Loading…</div>
  if (!receipt) return (
    <div className="p-4 sm:p-6 space-y-3">
      <div className="text-gray-500">Receipt {code} not found.</div>
      {source === 'error' && <div className="text-xs text-red-600">Firestore read failed.</div>}
    </div>
  )

  const isQuotation = receipt.kind === 'quotation'

  // Restrict quotation access based on role and status
  if (isQuotation) {
    const role = String(profile?.role || '').toLowerCase()
    const qStatus = effectiveQuotationStatus(receipt)
    const isDraft = qStatus === QUOT_STATUS.DRAFT
    const isInternalOnly = isDraft || qStatus === QUOT_STATUS.FOR_MG_FLEET_REVIEW

    // Fleet manager and call center can't see drafts
    if (isDraft && (role === 'general_manager' || role === 'call_center') && !profile?.is_admin) {
      return (
        <div className="p-4 sm:p-6 space-y-3">
          <div className="text-gray-500">This quotation is still in draft and not yet forwarded for review.</div>
          <Link to="/quotations" className="text-brand font-bold text-sm hover:underline">← Back to Quotations</Link>
        </div>
      )
    }

    // Fleet clients can only see forwarded/approved quotations
    if (isInternalOnly && (role === 'fleet_client' || role === 'fleet_client_manager')) {
      return (
        <div className="p-4 sm:p-6 space-y-3">
          <div className="text-gray-500">This quotation has not been forwarded to you yet.</div>
          <Link to="/portal/quotations" className="text-brand font-bold text-sm hover:underline">← Back to Quotations</Link>
        </div>
      )
    }
  }

  return isQuotation
    ? <QuotationDetail quot={receipt} profile={profile} />
    : <ReceiptDetail receipt={receipt} profile={profile} />
}

// ── Quotation view ───────────────────────────────────────────────────────

function QuotationDetail({ quot, profile }) {
  const navigate = useNavigate()
  const status = effectiveQuotationStatus(quot)
  const statusLabel = QUOT_STATUS_LABELS[status] || status
  const actions = availableQuotationActions(quot, profile)
  const editable = canEditQuotation(quot, profile)
  const canRevise = canAddRevision(quot, profile)
  const revision = currentRevisionRound(quot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [modalAction, setModalAction] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [revisionMode, setRevisionMode] = useState(false)

  // Reassessment gate state for the Generate Branch Invoice button. Loaded
  // once whenever status === APPROVED_FINAL (no point querying before).
  const [gateState, setGateState] = useState({ loading: true, gate: null, existingInvoice: null })
  useEffect(() => {
    if (status !== QUOT_STATUS.APPROVED_FINAL || !quot.plateNo) {
      setGateState({ loading: false, gate: null, existingInvoice: null })
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const [plateAssessments, existingInvoice] = await Promise.all([
          getAssessmentsForPlate(quot.plateNo),
          findInvoiceForQuotation(quot.id),
        ])
        if (cancelled) return
        const gate = canGenerateBranchInvoice(quot, plateAssessments)
        setGateState({ loading: false, gate, existingInvoice, plateAssessments })
      } catch (err) {
        if (!cancelled) setGateState({ loading: false, gate: { ok: false, reason: err.message || String(err) }, existingInvoice: null })
      }
    })()
    return () => { cancelled = true }
  }, [status, quot.plateNo, quot.id])

  // Gate the "Generate Invoice" visibility to finance role + admin (the
  // branch cashier/finance role actually raises the invoice; admin is the
  // escape hatch per the shared-admin pattern).
  const canIssueInvoice = Boolean(
    profile?.is_admin || profile?.role === 'finance' || profile?.role === 'admin_supervisor' || profile?.role === 'branch_manager',
  )

  const issueInvoice = async () => {
    if (busy || !gateState.gate?.ok) return
    setBusy(true); setError(null)
    try {
      const inv = await generateBranchInvoice(quot.id, {
        byProfile: profile,
        plateAssessments: gateState.plateAssessments || [],
      })
      navigate(`/branch-invoices/${inv.code}`)
    } catch (err) {
      console.error('[branchInvoice] generate failed:', err)
      setError(err.message || String(err))
      setBusy(false)
    }
  }

  const [confirmAction, setConfirmAction] = useState(null)

  const onAction = async (action) => {
    if (action.requiresText) { setModalAction(action); return }
    // Show confirmation modal for key actions
    setConfirmAction(action)
  }

  const onConfirm = async () => {
    if (!confirmAction) return
    setConfirmAction(null)
    await runTransition(confirmAction, null)
  }

  const runTransition = async (action, text) => {
    setBusy(true); setError(null)
    try {
      await transitionQuotation(quot.id, {
        action: action.key,
        nextStatus: action.nextStatus,
        text: text || null,
        byProfile: profile,
      })
      setModalAction(null)
      // Redirect fleet manager / call center to quotations list after bounce-back
      const role = String(profile?.role || '').toLowerCase()
      if (action.key === QUOT_ACTION.BOUNCE_TO_SUPERVISOR && (role === 'general_manager' || role === 'call_center')) {
        navigate('/quotations')
      }
    } catch (err) {
      console.error('[quotation] transition failed:', err)
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pb-32">
      <PageHero
        eyebrow={revision > 1 ? `QUOTATION · REV ${revision}` : 'QUOTATION'}
        title={quot.code}
        subtitle={`${quot.plateNo} · ${quot.brandModel || 'Vehicle'}`}
        right={<TotalChip value={quot.estimatedTotal} />}
      />

      <div className="px-3 sm:px-6 pt-4 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill status={statusLabel} />
          {revision > 1 && (
            <span className="text-[10px] font-bold tracking-widest uppercase bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-2 py-0.5">
              Revision {revision}
            </span>
          )}
          {quot.company && (
            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500 truncate">
              {quot.company}
            </span>
          )}
        </div>

        <ChainStepper status={status} />

        {error && (
          <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            Action failed: {error}
          </div>
        )}

        {quot.sourceAssessmentRwa && (
          <SourceAssessmentCard rwa={quot.sourceAssessmentRwa} plate={quot.plateNo} />
        )}

        <CustomerCard receipt={quot} />

        {editable && !editMode && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-center gap-3">
            <div className="text-2xl leading-none">✏️</div>
            <div className="flex-1 text-xs text-amber-800">
              <div className="font-bold">This draft is editable.</div>
              <div>Revise line items before forwarding — especially after a clarification request.</div>
            </div>
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs px-4 py-2 rounded-full shadow"
            >
              Edit items
            </button>
          </div>
        )}

        {status === QUOT_STATUS.APPROVED_FINAL && (
          <InvoiceGateCard
            gateState={gateState}
            canIssueInvoice={canIssueInvoice}
            busy={busy}
            onIssue={issueInvoice}
            plateNo={quot.plateNo}
          />
        )}

        {canRevise && !revisionMode && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-center gap-3">
            <div className="text-2xl leading-none">➕</div>
            <div className="flex-1 text-xs text-amber-800">
              <div className="font-bold">Scope grew during repair?</div>
              <div>Add new items here — they'll be forwarded up the chain for the client to approve before work on the delta starts.</div>
            </div>
            <button
              type="button"
              onClick={() => setRevisionMode(true)}
              className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs px-4 py-2 rounded-full shadow shrink-0"
            >
              Add revision
            </button>
          </div>
        )}

        {/* Round 39 — when the quote has been invoiced, surface a clear
            locked state in place of the revision affordance. canAddRevision
            already returns false in this case; this just explains why. */}
        {status === QUOT_STATUS.APPROVED_FINAL
          && (quot.branchInvoiceCode || quot.branchInvoiceId)
          && !revisionMode && (
          <div className="bg-gray-100 border-2 border-gray-300 rounded-2xl p-3 flex items-center gap-3">
            <div className="text-2xl leading-none">🔒</div>
            <div className="flex-1 text-xs text-gray-700">
              <div className="font-bold text-gray-900">Quotation locked — invoice issued</div>
              <div>
                Branch invoice <span className="font-mono font-bold">{quot.branchInvoiceCode}</span> was generated from this quote, so the line items are now immutable.
                For changes, use a <strong>credit note</strong> on the invoice or open a <strong>new quotation</strong>.
              </div>
            </div>
            {quot.branchInvoiceCode && (
              <Link
                to={`/branch-invoices/${quot.branchInvoiceCode}`}
                className="bg-gray-900 hover:bg-black text-white font-bold text-xs px-4 py-2 rounded-full shrink-0"
              >
                View invoice →
              </Link>
            )}
          </div>
        )}

        {editMode ? (
          <EditableItems
            quot={quot}
            profile={profile}
            onCancel={() => setEditMode(false)}
            onSaved={() => setEditMode(false)}
          />
        ) : revisionMode ? (
          <RevisionEditor
            quot={quot}
            profile={profile}
            onCancel={() => setRevisionMode(false)}
            onSaved={() => setRevisionMode(false)}
          />
        ) : (
          <>
            <GroupedItemsCard quot={quot} />
            <TotalsCard receipt={quot} profile={profile} />
          </>
        )}

        <CommentThread quot={quot} profile={profile} />
      </div>

      {/* Sticky action bar — only rendered when this actor has something to do. */}
      {actions.length > 0 && (
        <div
          className="fixed bottom-[3.5rem] md:bottom-0 left-0 right-0 z-40 bg-white border-t shadow-[0_-4px_12px_rgba(0,0,0,0.05)]"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
        >
          {/* Round 39 — block forward transitions when any line is ₱0. */}
          {(() => {
            const unpriced = (quot.items || []).filter((i) => Number(i.unitCost) <= 0)
            if (unpriced.length === 0) return null
            return (
              <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs sm:text-sm px-3 sm:px-6 py-2">
                ⚠ <strong>{unpriced.length} line{unpriced.length === 1 ? '' : 's'}</strong> still at ₱0 —
                set unit costs before forwarding. Edit items to enter prices, or use the catalog autocomplete to pick a priced item.
              </div>
            )
          })()}
          <div className="px-3 sm:px-6 py-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${actions.length}, 1fr)` }}>
            {actions.map((action) => {
              const isForward = action.nextStatus === QUOT_STATUS.FOR_MG_FLEET_REVIEW
                             || action.nextStatus === QUOT_STATUS.FOR_CLIENT_REVIEW
                             || action.nextStatus === QUOT_STATUS.APPROVED_FINAL
              const unpriced = (quot.items || []).filter((i) => Number(i.unitCost) <= 0).length
              const blocked = isForward && unpriced > 0
              return (
                <button
                  key={action.key}
                  type="button"
                  disabled={busy || blocked}
                  onClick={() => onAction(action)}
                  className={`text-sm font-bold px-3 py-3 rounded-xl active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed ${toneClasses(action.tone)}`}
                  title={blocked ? `Set unit costs on ${unpriced} line${unpriced === 1 ? '' : 's'} first.` : undefined}
                >
                  {actionLabel(action)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {modalAction && (
        <TextActionModal
          action={modalAction}
          busy={busy}
          onCancel={() => setModalAction(null)}
          onSubmit={(text) => runTransition(modalAction, text)}
        />
      )}

      {/* Confirmation modal for non-text actions */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="px-5 py-4">
              <div className="text-sm font-bold text-gray-900 mb-2">Confirm Action</div>
              <div className="text-sm text-gray-600">
                Are you sure you want to <strong>{confirmAction.label.toLowerCase()}</strong> this quotation?
              </div>
            </div>
            <div className="px-5 pb-5 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                disabled={busy}
                className="flex-1 text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 px-4 py-3 rounded-xl"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                className={`flex-1 text-sm font-bold text-white px-4 py-3 rounded-xl shadow disabled:opacity-40 ${
                  confirmAction.tone === 'danger'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-brand hover:bg-brand-dark'
                }`}
              >
                {busy ? 'Processing…' : confirmAction.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Invoice gate (Round 12) ─────────────────────────────────────────────
//
// Three states to render on an APPROVED_FINAL quotation:
//   1) Already invoiced → show the invoice code with a link.
//   2) Gate passes → green card + Generate Branch Invoice button.
//   3) Gate fails → amber/red card with the reason (waiting reassessment,
//      reassessment deferred, etc.)

function InvoiceGateCard({ gateState, canIssueInvoice, busy, onIssue, plateNo }) {
  if (gateState.loading) {
    return (
      <div className="bg-white rounded-2xl border px-4 py-3 text-sm text-gray-500">
        Checking invoice readiness…
      </div>
    )
  }

  const { gate, existingInvoice } = gateState

  if (existingInvoice) {
    const status = existingInvoice.status || 'OPEN'
    return (
      <div className="bg-gray-900 text-white rounded-2xl p-4 flex items-center gap-3">
        <div className="text-2xl leading-none">🧾</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase opacity-70">ALREADY INVOICED</div>
          <div className="font-black text-lg font-mono truncate">{existingInvoice.code}</div>
          <div className="text-xs opacity-70 mt-0.5">Status: {status}</div>
        </div>
        <Link
          to={`/branch-invoices/${existingInvoice.code}`}
          className="bg-white text-gray-900 font-bold text-xs px-4 py-2 rounded-full shrink-0"
        >
          View invoice →
        </Link>
      </div>
    )
  }

  if (gate?.ok) {
    return (
      <div className="bg-green-50 border-2 border-green-300 rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl leading-none">✅</div>
          <div className="flex-1 min-w-0">
            <div className="font-black text-green-800 text-sm">Ready to invoice MG Fleet</div>
            <div className="text-xs text-green-700 mt-1">
              Post-repair reassessment <span className="font-mono font-bold">{gate.reassessment?.rwaNumber}</span>
              {gate.reassessment?.submittedAt && ` · ${shortDate(gate.reassessment.submittedAt)}`} passed.
              {gate.reassessment?.classification?.overallStatus && (
                <> Unit is <strong className="uppercase">{gate.reassessment.classification.overallStatus}</strong>.</>
              )}
            </div>
            {canIssueInvoice ? (
              <button
                type="button"
                onClick={onIssue}
                disabled={busy}
                className="mt-3 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-sm font-bold px-5 py-2.5 rounded-full shadow active:scale-95 transition-transform"
              >
                {busy ? 'Generating…' : 'Generate branch invoice →'}
              </button>
            ) : (
              <div className="mt-2 text-[11px] text-gray-600">
                Only finance, admin supervisor, branch manager, or admin can issue the branch invoice.
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Gate failed.
  const isDeferred = /deferred/i.test(gate?.reason || '')
  const tone = isDeferred ? 'red' : 'amber'
  const bg = tone === 'red' ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'
  const textTitle = tone === 'red' ? 'text-red-800' : 'text-amber-800'
  const textBody = tone === 'red' ? 'text-red-700' : 'text-amber-700'

  // Round 22 — when the gate fails because no post-repair re-assessment
  // exists yet, give the user a one-click path to start one. Look up
  // the most recent appointment for this plate and deep-link to its
  // assessment form with type=Re-Assessment pre-selected.
  const needsReassessment = /reassessment/i.test(gate?.reason || '')

  return (
    <div className={`${bg} border-2 rounded-2xl p-4`}>
      <div className="flex items-start gap-3">
        <div className="text-2xl leading-none">{tone === 'red' ? '⛔' : '⏳'}</div>
        <div className="flex-1 min-w-0">
          <div className={`font-black text-sm ${textTitle}`}>
            {tone === 'red' ? 'Reassessment blocked invoicing' : 'Not ready to invoice yet'}
          </div>
          <div className={`text-xs mt-1 ${textBody}`}>{gate?.reason}</div>
          {needsReassessment && plateNo && (
            <ReassessmentLauncher plateNo={plateNo} />
          )}
          {gate?.reassessment?.rwaNumber && (
            <Link
              to={`/assessments/${gate.reassessment.rwaNumber}`}
              className="mt-2 inline-block text-[11px] text-brand font-bold hover:underline"
            >
              View reassessment {gate.reassessment.rwaNumber} →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// Round 30 — surfaces the assessment that drove this quote so the client
// can review the findings before approving / rejecting. Visible to
// everyone (staff sees it for context too). Links into the public
// AssessmentView (review_status gating still applies; if the assessment
// hasn't been forwarded, the page will show the not-yet-shared notice).
function SourceAssessmentCard({ rwa, plate }) {
  return (
    <div className="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="text-2xl leading-none">🔍</div>
        <div className="flex-1 min-w-0">
          <div className="font-black text-indigo-900 text-sm">Roadworthy assessment available</div>
          <div className="text-xs text-indigo-800 mt-1">
            This quotation is built from the technical findings of assessment{' '}
            <span className="font-mono font-bold">{rwa}</span>{plate ? ` on ${plate}` : ''}. Open it to see exactly which items
            were flagged and why — useful before approving the line items below.
          </div>
          <Link
            to={`/assessments/${rwa}`}
            className="inline-block mt-3 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 rounded-full shadow"
          >
            View assessment findings →
          </Link>
        </div>
      </div>
    </div>
  )
}

// Looks up the most recent appointment for the plate, then renders a
// "Start Re-Assessment →" button deep-linking into the assessment form
// with type=Re-Assessment pre-selected. Falls back to a hint pointing
// at My Garage if no appointment is found.
function ReassessmentLauncher({ plateNo }) {
  const { profile } = useAuth()
  const role = String(profile?.role || '').toLowerCase()
  // Fleet client users should not see the re-assessment button
  if (role === 'fleet_client' || role === 'fleet_client_manager') return null

  const [apptId, setApptId] = useState(undefined) // undefined = loading
  useEffect(() => {
    let cancelled = false
    getMostRecentAppointmentByPlate(plateNo).then((appt) => {
      if (!cancelled) setApptId(appt?.id || null)
    })
    return () => { cancelled = true }
  }, [plateNo])

  if (apptId === undefined) {
    return <div className="mt-3 text-[11px] text-gray-500 italic">Looking up appointment…</div>
  }
  if (!apptId) {
    return (
      <div className="mt-3 text-[11px] text-gray-700">
        Find the appointment in <Link to="/home" className="text-brand font-bold hover:underline">My Garage</Link>, click ASSESS, then choose <strong>Re-Assessment</strong> as the type.
      </div>
    )
  }
  return (
    <Link
      to={`/appointments/${apptId}/assess?type=Re-Assessment`}
      className="mt-3 inline-block bg-brand hover:bg-brand-dark text-white text-xs font-bold px-4 py-2 rounded-lg shadow"
    >
      Start Re-Assessment →
    </Link>
  )
}

// ── Line items grouped by revision round ────────────────────────────────
//
// Each revision is its own block so the client sees exactly what's new this
// round vs. what they already approved in previous rounds. Items without a
// revisionRound stamp (legacy or original) fall into round 1.

function GroupedItemsCard({ quot }) {
  const items = quot.items || []
  if (items.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-dashed p-5 text-center text-gray-400 text-sm">
        No line items.
      </div>
    )
  }

  // Bucket by round.
  const groups = new Map()
  for (const i of items) {
    const r = Number(i.revisionRound) || 1
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  }
  const rounds = [...groups.keys()].sort((a, b) => a - b)
  const latestRound = rounds[rounds.length - 1]
  const quotStatus = effectiveQuotationStatus(quot)
  const latestIsPending = latestRound > 1 && quotStatus !== QUOT_STATUS.APPROVED_FINAL

  return (
    <section className="space-y-3">
      {rounds.map((round) => {
        const roundItems = groups.get(round)
        const subtotal = roundItems.reduce((s, i) => s + (i.subTotal || (i.qty * i.unitCost) || 0), 0)
        const isLatestPending = round === latestRound && latestIsPending
        const isOriginal = round === 1
        return (
          <div
            key={round}
            className={`rounded-2xl border overflow-hidden ${isLatestPending ? 'border-amber-300 ring-1 ring-amber-200 bg-white' : 'border-gray-200 bg-white'}`}
          >
            <div className={`px-4 py-2.5 border-b flex items-center justify-between gap-2 ${
              isLatestPending ? 'bg-amber-50 border-amber-200' : isOriginal ? 'bg-green-50 border-green-100' : 'bg-gray-50'
            }`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-[10px] font-black tracking-widest uppercase px-2 py-0.5 rounded-full ${
                  isLatestPending ? 'bg-amber-600 text-white'
                  : isOriginal ? 'bg-green-600 text-white'
                  : 'bg-gray-700 text-white'
                }`}>
                  Rev {round}
                </span>
                <span className={`text-[11px] font-semibold truncate ${
                  isLatestPending ? 'text-amber-800'
                  : isOriginal ? 'text-green-800'
                  : 'text-gray-600'
                }`}>
                  {isLatestPending
                    ? `Pending approval · ${roundItems.length} new item${roundItems.length === 1 ? '' : 's'}`
                    : isOriginal
                      ? `Original${roundItems.length > 1 ? ` · ${roundItems.length} items` : ''}${round < latestRound ? ' (approved)' : ''}`
                      : `Approved · ${roundItems.length} item${roundItems.length === 1 ? '' : 's'}`}
                </span>
              </div>
              <span className={`text-sm font-black whitespace-nowrap ${isLatestPending ? 'text-amber-700' : 'text-gray-800'}`}>
                {formatMoney(subtotal)}
              </span>
            </div>

            {/* Mobile: card stack */}
            <div className="lg:hidden divide-y">
              {roundItems.map((item, i) => <GroupedItemRow key={i} item={item} />)}
            </div>

            {/* Desktop: table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="min-w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Type</th>
                    <th className="px-4 py-2 text-left font-medium">Qty</th>
                    <th className="px-4 py-2 text-left font-medium">Description</th>
                    <th className="px-4 py-2 text-right font-medium">Unit Cost</th>
                    <th className="px-4 py-2 text-right font-medium">Sub Total</th>
                    {round > 1 && <th className="px-4 py-2 text-left font-medium">Added</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {roundItems.map((item, i) => (
                    <tr key={i} className="bg-white">
                      <td className="px-4 py-2">{item.type}</td>
                      <td className="px-4 py-2">{item.qty}</td>
                      <td className="px-4 py-2 uppercase">{item.description}</td>
                      <td className="px-4 py-2 text-right">{formatMoney(item.unitCost)}</td>
                      <td className="px-4 py-2 text-right font-semibold">{formatMoney(item.subTotal || item.qty * item.unitCost)}</td>
                      {round > 1 && (
                        <td className="px-4 py-2 text-[11px] text-gray-500">
                          {item.addedByName || '—'}{item.addedAt ? ` · ${shortDate(item.addedAt)}` : ''}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function GroupedItemRow({ item }) {
  return (
    <div className="p-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${item.type === 'Labor' ? 'bg-sky-600 text-white' : 'bg-gray-700 text-white'}`}>
          {item.type}
        </span>
        <span className="text-xs text-gray-500 font-bold">× {item.qty}</span>
      </div>
      <div className="text-sm font-semibold text-gray-900 uppercase break-words">
        {item.description || '—'}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between">
        <span className="text-[11px] text-gray-500">
          {formatMoney(item.unitCost)} × {item.qty}
        </span>
        <span className="text-base font-black text-gray-900">{formatMoney(item.subTotal || item.qty * item.unitCost)}</span>
      </div>
      {item.addedByName && item.revisionRound > 1 && (
        <div className="mt-1 text-[10px] text-gray-400">
          added by {item.addedByName}{item.addedAt ? ` · ${shortDate(item.addedAt)}` : ''}
        </div>
      )}
    </div>
  )
}

function shortDate(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  return d.toLocaleString('en-PH', { month: 'short', day: 'numeric' })
}

// ── Revision editor — add NEW items to an approved quotation ────────────

function RevisionEditor({ quot, profile, onCancel, onSaved }) {
  const [items, setItems] = useState([{ type: 'Parts/Materials', qty: 1, description: '', unitCost: 0 }])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const [vehicleIds, setVehicleIds] = useState({ makeId: null, modelId: null })
  useEffect(() => {
    let cancelled = false
    resolveVehicleIds(quot.make || quot.brand, quot.model).then((ids) => {
      if (!cancelled) setVehicleIds(ids)
    })
    return () => { cancelled = true }
  }, [quot.make, quot.brand, quot.model])

  const deltaTotal = items.reduce((s, i) => s + ((Number(i.qty) || 0) * (Number(i.unitCost) || 0)), 0)
  const nextRound = currentRevisionRound(quot) + 1

  const update = (idx, patch) => setItems(items.map((r, i) => i === idx ? { ...r, ...patch } : r))
  const remove = (idx) => setItems(items.filter((_, i) => i !== idx))
  const add = () => setItems([...items, { type: 'Parts/Materials', qty: 1, description: '', unitCost: 0 }])

  const save = async () => {
    if (saving) return
    const cleaned = items.filter((i) => String(i.description || '').trim())
    if (cleaned.length === 0) { setError('Add at least one item with a description.'); return }
    setSaving(true); setError(null)
    try {
      await addQuotationRevision(quot.id, { newItems: cleaned, notes, byProfile: profile })
      onSaved?.()
    } catch (err) {
      console.error('[quotation] revision save failed:', err)
      setError(err.message || String(err))
      setSaving(false)
    }
  }

  return (
    <section className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-widest font-bold text-amber-800">Drafting Revision {nextRound}</div>
          <div className="text-[10px] text-amber-700">Existing items stay as approved. Add only what's new.</div>
        </div>
        <span className="text-[10px] font-bold text-amber-700">{items.length} new</span>
      </div>

      <div className="p-3 space-y-3">
        {/* Mobile: card stack */}
        <div className="lg:hidden space-y-3">
          {items.map((row, i) => (
            <LineItemCard
              key={i}
              index={i}
              row={row}
              onChange={(patch) => update(i, patch)}
              onRemove={() => remove(i)}
              canRemove={items.length > 1}
              vehicleMakeId={vehicleIds.makeId}
              vehicleModelId={vehicleIds.modelId}
              branchCode={profile?.branch_code || profile?.branch}
            />
          ))}
        </div>

        {/* Desktop: compact table */}
        <div className="hidden lg:block bg-white rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <LineItemHeader />
              <tbody className="divide-y">
                {items.map((row, i) => (
                  <LineItemRow
                    key={i}
                    row={row}
                    onChange={(patch) => update(i, patch)}
                    onRemove={() => remove(i)}
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

        <button
          type="button"
          onClick={add}
          className="w-full bg-white border-2 border-dashed border-gray-300 text-gray-600 hover:border-brand hover:text-brand rounded-2xl py-3 font-bold text-sm flex items-center justify-center gap-1.5"
        >
          <Icon name="plus" className="w-4 h-4" />
          Add item
        </button>

        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-1">Notes for this revision</div>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input text-sm"
            placeholder="Why is this needed? (e.g. discovered worn tie-rod during brake job)"
          />
        </div>

        <div className="bg-amber-50 rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-widest text-amber-800">Revision delta</span>
          <span className="text-xl font-black text-amber-700">+{formatMoney(deltaTotal)}</span>
        </div>

        {error && <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">Save failed: {error}</div>}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="bg-white border-2 border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 font-bold text-sm px-4 py-3 rounded-xl active:scale-95 transition-transform"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white font-bold text-sm px-4 py-3 rounded-xl shadow active:scale-95 transition-transform"
          >
            {saving ? 'Saving…' : `Submit revision ${nextRound}`}
          </button>
        </div>

        <div className="text-[10px] text-gray-500 text-center">
          Submitting will reset the chain to <strong>MG Fleet review</strong>. The client will see Revision {nextRound} as pending alongside the already-approved items.
        </div>
      </div>
    </section>
  )
}

// ── Editable line items (DRAFT only, supervisor/admin) ──────────────────

function EditableItems({ quot, profile, onCancel, onSaved }) {
  const [items, setItems] = useState(() =>
    (quot.items || []).map((i) => ({
      type: i.type || 'Parts/Materials',
      qty: Number(i.qty) || 1,
      description: i.description || '',
      unitCost: Number(i.unitCost) || 0,
      // Preserve revisionRound so the LineItemCard's Rev badge tracks
      // which round each line came from. New rows added during edit
      // default to round 1 (the current draft).
      revisionRound: i.revisionRound || 1,
    })),
  )
  const [notes, setNotes] = useState(quot.notes || '')
  const [saving, setSaving] = useState(false)

  // Round 35 — resolve free-text make/model on the quote to caviteIds
  // for the autocomplete vehicle filter.
  const [vehicleIds, setVehicleIds] = useState({ makeId: null, modelId: null })
  useEffect(() => {
    let cancelled = false
    resolveVehicleIds(quot.make || quot.brand, quot.model).then((ids) => {
      if (!cancelled) setVehicleIds(ids)
    })
    return () => { cancelled = true }
  }, [quot.make, quot.brand, quot.model])
  const [error, setError] = useState(null)

  const laborTotal = items.filter((i) => i.type === 'Labor').reduce((s, i) => s + i.qty * i.unitCost, 0)
  const matTotal   = items.filter((i) => i.type !== 'Labor').reduce((s, i) => s + i.qty * i.unitCost, 0)
  const grand = laborTotal + matTotal

  const updateRow = (idx, patch) => setItems(items.map((r, i) => i === idx ? { ...r, ...patch } : r))
  const removeRow = (idx) => setItems(items.filter((_, i) => i !== idx))
  const addRow = () => setItems([...items, { type: 'Parts/Materials', qty: 1, description: '', unitCost: 0 }])

  const save = async () => {
    if (saving) return
    setSaving(true); setError(null)
    try {
      await updateQuotationItems(quot.id, { items, notes, byProfile: profile })
      onSaved?.()
    } catch (err) {
      console.error('[quotation] edit save failed:', err)
      setError(err.message || String(err))
      setSaving(false)
    }
  }

  return (
    <section className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-widest font-bold text-amber-800">Editing line items</div>
        <span className="text-[10px] text-amber-700">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>

      <div className="p-3 space-y-3">
        {/* Mobile: card stack */}
        <div className="lg:hidden space-y-3">
          {items.map((row, i) => (
            <LineItemCard
              key={i}
              index={i}
              row={row}
              onChange={(patch) => updateRow(i, patch)}
              onRemove={() => removeRow(i)}
              canRemove={items.length > 1}
              showRevisionTag
              vehicleMakeId={vehicleIds.makeId}
              vehicleModelId={vehicleIds.modelId}
              branchCode={profile?.branch_code || profile?.branch}
            />
          ))}
        </div>

        {/* Desktop: compact table — same as the create page */}
        <div className="hidden lg:block bg-white rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <LineItemHeader />
              <tbody className="divide-y">
                {items.map((row, i) => (
                  <LineItemRow
                    key={i}
                    row={row}
                    onChange={(patch) => updateRow(i, patch)}
                    onRemove={() => removeRow(i)}
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

        <button
          type="button"
          onClick={addRow}
          className="w-full bg-white border-2 border-dashed border-gray-300 text-gray-600 hover:border-brand hover:text-brand rounded-2xl py-3 font-bold text-sm flex items-center justify-center gap-1.5"
        >
          <Icon name="plus" className="w-4 h-4" />
          Add item
        </button>

        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-1">Notes</div>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input text-sm"
            placeholder="Any notes for the MG Fleet manager or client…"
          />
        </div>

        <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">New Estimated Total</span>
          <span className="text-xl font-black text-green-700">{formatMoney(grand)}</span>
        </div>

        {error && <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">Save failed: {error}</div>}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="bg-white border-2 border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 font-bold text-sm px-4 py-3 rounded-xl active:scale-95 transition-transform"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white font-bold text-sm px-4 py-3 rounded-xl shadow active:scale-95 transition-transform"
          >
            {saving ? 'Saving…' : 'Save revisions'}
          </button>
        </div>
      </div>
    </section>
  )
}


// ── Chain stepper ────────────────────────────────────────────────────────

const STEPS = [
  { code: QUOT_STATUS.DRAFT,                label: 'Draft',        icon: '📝' },
  { code: QUOT_STATUS.FOR_MG_FLEET_REVIEW,  label: 'MG Fleet',     icon: '🏢' },
  { code: QUOT_STATUS.FOR_CLIENT_REVIEW,    label: 'Client',       icon: '👤' },
  { code: QUOT_STATUS.APPROVED_FINAL,       label: 'Approved',     icon: '✓'  },
]

function ChainStepper({ status }) {
  // Where are we on the happy path?
  const idx = (() => {
    if (status === QUOT_STATUS.DRAFT) return 0
    if (status === QUOT_STATUS.FOR_MG_FLEET_REVIEW) return 1
    if (status === QUOT_STATUS.FOR_CLIENT_REVIEW) return 2
    if (status === QUOT_STATUS.CLIENT_CLARIFICATION) return 2
    if (status === QUOT_STATUS.APPROVED_FINAL) return 3
    if (status === QUOT_STATUS.CLIENT_REJECTED) return 2
    return 0
  })()

  const rejected = status === QUOT_STATUS.CLIENT_REJECTED
  const clarify  = status === QUOT_STATUS.CLIENT_CLARIFICATION

  return (
    <div className="bg-white rounded-2xl border p-4">
      <div className="text-[10px] font-bold tracking-widest text-gray-500 mb-3">APPROVAL CHAIN</div>
      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const done = i < idx || (i === idx && status === QUOT_STATUS.APPROVED_FINAL)
          const here = i === idx && !done
          return (
            <div key={step.code} className="flex-1 flex items-center">
              <div className="flex flex-col items-center flex-1 min-w-0">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-black shrink-0 ${
                  done   ? 'bg-green-600 text-white'
                  : here  ? (rejected ? 'bg-red-600 text-white' : clarify ? 'bg-amber-500 text-white' : 'bg-brand text-white ring-4 ring-brand/20')
                  :         'bg-gray-100 text-gray-400'
                }`}>
                  {done ? '✓' : step.icon}
                </div>
                <div className={`text-[10px] font-bold uppercase tracking-wider mt-1.5 text-center truncate max-w-full ${
                  done ? 'text-green-700' : here ? (rejected ? 'text-red-700' : clarify ? 'text-amber-700' : 'text-brand') : 'text-gray-400'
                }`}>
                  {step.label}
                </div>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 flex-shrink-0 w-4 sm:w-6 -mt-6 ${done ? 'bg-green-600' : 'bg-gray-200'}`} />
              )}
            </div>
          )
        })}
      </div>
      {(clarify || rejected) && (
        <div className={`mt-3 text-[11px] rounded px-3 py-2 ${
          rejected ? 'bg-red-50 border border-red-200 text-red-800'
                   : 'bg-amber-50 border border-amber-200 text-amber-800'
        }`}>
          {rejected
            ? 'Client rejected this quotation. Supervisor can re-open as draft to revise and resubmit.'
            : 'Client is asking for clarification. See the comment thread, then supervisor re-opens as draft to address.'}
        </div>
      )}
    </div>
  )
}

// ── Comment thread + audit ───────────────────────────────────────────────

function CommentThread({ quot, profile }) {
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState(null)
  const endRef = useRef(null)

  // Merge audit actions and comments into a single chronological feed so the
  // reader sees "MG Fleet mgr forwarded this" next to "client asked about pad
  // brand" next to "supervisor replied with…" in one timeline.
  const feed = useMemo(() => {
    const items = []
    for (const a of (quot.audit || [])) {
      items.push({ kind: 'audit', at: a.at, ...a })
    }
    for (const c of (quot.comments || [])) {
      items.push({ kind: c.kind || 'comment', at: c.at, ...c })
    }
    items.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0))
    return items
  }, [quot.audit, quot.comments])

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'nearest' })
  }, [feed.length])

  const post = async () => {
    if (!text.trim() || posting) return
    setPosting(true); setError(null)
    try {
      await addQuotationComment(quot.id, { text, byProfile: profile })
      setText('')
    } catch (err) {
      console.error('[comment] post failed:', err)
      setError(err.message || String(err))
    } finally {
      setPosting(false)
    }
  }

  return (
    <section className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-gray-50 border-b px-4 py-2.5 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-widest font-bold text-gray-500">
          Approval Trail & Comments
        </div>
        <span className="text-[10px] text-gray-400">{feed.length} entries</span>
      </div>

      <div className="p-4 max-h-[420px] overflow-y-auto">
        {feed.length === 0 && (
          <div className="text-center text-gray-400 text-sm italic py-4">
            No activity yet. Post a comment or forward the quotation to start the trail.
          </div>
        )}
        <ol className="space-y-3">
          {feed.map((entry, i) => <FeedItem key={i} entry={entry} />)}
          <li ref={endRef} />
        </ol>
      </div>

      <div className="border-t p-3 bg-gray-50">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Post a comment — everyone in the chain will see it."
            rows={2}
            className="input flex-1 text-sm"
          />
          <button
            type="button"
            onClick={post}
            disabled={posting || !text.trim()}
            className="bg-brand hover:bg-brand-dark disabled:opacity-40 text-white font-bold text-sm px-4 py-2.5 rounded-xl shrink-0"
          >
            {posting ? '…' : 'Post'}
          </button>
        </div>
        {error && <div className="text-[11px] text-red-600 mt-1.5">Post failed: {error}</div>}
      </div>
    </section>
  )
}

function FeedItem({ entry }) {
  const when = entry.at ? new Date(entry.at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  const who = entry.byName || 'Someone'
  const role = roleLabel(entry.byRole)

  if (entry.kind === 'audit') {
    return (
      <li className="flex gap-3">
        <div className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-black ${auditIconTone(entry.action)}`}>
          {auditIconGlyph(entry.action)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-900">
            <span className="font-semibold">{who}</span>
            <span className="text-gray-500"> · {role} · </span>
            <span className="text-gray-700">{auditVerb(entry.action, entry.to)}</span>
          </div>
          {entry.note && <div className="mt-1 bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-700 italic">"{entry.note}"</div>}
          <div className="text-[10px] text-gray-400 mt-0.5">{when}</div>
        </div>
      </li>
    )
  }

  // plain comment
  return (
    <li className="flex gap-3">
      <div className="w-8 h-8 shrink-0 rounded-full bg-gray-900 text-white flex items-center justify-center text-[10px] font-black">
        {initials(who)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900">
          <span className="font-semibold">{who}</span>
          <span className="text-gray-500"> · {role}</span>
        </div>
        <div className="mt-1 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-800 whitespace-pre-wrap break-words">
          {entry.text}
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">{when}</div>
      </div>
    </li>
  )
}

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'
}

function roleLabel(role) {
  switch (role) {
    case 'admin_supervisor':  return 'Admin Supervisor'
    case 'mg_fleet_manager':  return 'MG Fleet'
    case 'fleet_client':      return 'Fleet Client'
    default:                  return role || '—'
  }
}

function auditVerb(action, to) {
  switch (action) {
    case QUOT_ACTION.FORWARD_TO_MGFLEET:    return 'forwarded to MG Fleet for review'
    case QUOT_ACTION.FORWARD_TO_CLIENT:     return 'forwarded to client for approval'
    case QUOT_ACTION.BOUNCE_TO_SUPERVISOR:  return 'bounced back to supervisor'
    case QUOT_ACTION.CLIENT_APPROVE:        return 'APPROVED the quotation'
    case QUOT_ACTION.CLIENT_REJECT:         return 'REJECTED the quotation'
    case QUOT_ACTION.CLIENT_CLARIFY:        return 'requested clarification — bounced to draft'
    case QUOT_ACTION.REOPEN_TO_DRAFT:       return 're-opened as draft'
    case 'edit_items':                      return 'revised the line items'
    case 'add_revision':                    return 'added a mid-repair revision'
    case 'create':                          return 'created the quotation'
    default:                                return `changed status to ${to || '—'}`
  }
}

function auditIconGlyph(action) {
  switch (action) {
    case QUOT_ACTION.CLIENT_APPROVE:       return '✓'
    case QUOT_ACTION.CLIENT_REJECT:        return '✕'
    case QUOT_ACTION.CLIENT_CLARIFY:       return '?'
    case QUOT_ACTION.BOUNCE_TO_SUPERVISOR: return '↩'
    case QUOT_ACTION.REOPEN_TO_DRAFT:      return '↻'
    case 'edit_items':                     return '✏'
    case 'add_revision':                   return '➕'
    default:                               return '→'
  }
}

function auditIconTone(action) {
  switch (action) {
    case QUOT_ACTION.CLIENT_APPROVE:       return 'bg-green-600 text-white'
    case QUOT_ACTION.CLIENT_REJECT:        return 'bg-red-600 text-white'
    case QUOT_ACTION.CLIENT_CLARIFY:       return 'bg-amber-500 text-white'
    case QUOT_ACTION.BOUNCE_TO_SUPERVISOR: return 'bg-amber-500 text-white'
    case 'edit_items':                     return 'bg-amber-600 text-white'
    case 'add_revision':                   return 'bg-amber-600 text-white'
    default:                               return 'bg-brand text-white'
  }
}

// ── Text-required action modal (reject / clarify / bounce) ──────────────

function TextActionModal({ action, busy, onCancel, onSubmit }) {
  const [text, setText] = useState('')
  const placeholderByAction = {
    [QUOT_ACTION.CLIENT_REJECT]:        'Why is the quotation being rejected?',
    [QUOT_ACTION.CLIENT_CLARIFY]:       'Which line items do you need clarified? Any alternatives you\'d consider?',
    [QUOT_ACTION.BOUNCE_TO_SUPERVISOR]: 'What needs to be revised before forwarding to the client?',
  }

  const canSubmit = Boolean(text.trim()) && !busy
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:w-[480px] sm:max-w-full rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="font-bold text-gray-900">{action.label}</div>
          <button onClick={onCancel} className="text-gray-500 hover:text-gray-800 text-2xl leading-none w-8 h-8 flex items-center justify-center" aria-label="Close">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-gray-600">
            Your note will be saved to the approval trail and posted in the shared comment thread so every party can see it.
          </div>
          <textarea
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholderByAction[action.key] || 'Add your note…'}
            className="input"
            autoFocus
          />
        </div>
        <div className="px-4 py-3 border-t flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="text-sm font-bold text-gray-600 hover:text-gray-900 px-3 py-2">Cancel</button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(text.trim())}
            className={`text-sm font-bold px-4 py-2 rounded-full shadow disabled:opacity-40 ${toneClasses(action.tone)}`}
          >
            {busy ? 'Saving…' : actionLabel(action)}
          </button>
        </div>
      </div>
    </div>
  )
}

function toneClasses(tone) {
  switch (tone) {
    case 'danger': return 'bg-red-600 hover:bg-red-700 text-white border-2 border-red-600'
    case 'ghost':  return 'bg-white border-2 border-gray-300 text-gray-700 hover:bg-gray-50'
    case 'primary':
    default:       return 'bg-green-600 hover:bg-green-700 text-white border-2 border-green-600'
  }
}

function actionLabel(action) {
  if (action.key === QUOT_ACTION.CLIENT_APPROVE) return `✓ ${action.label}`
  if (action.key === QUOT_ACTION.CLIENT_REJECT)  return `✕ ${action.label}`
  return action.label
}

// ── Receipt view (legacy — unchanged shell) ──────────────────────────────

function ReceiptDetail({ receipt, profile }) {
  const [cancelling, setCancelling] = useState(false)
  const [localStatus, setLocalStatus] = useState(receipt.status)

  const doCancel = async () => {
    if (!receipt.id) return
    if (!confirm('Cancel this service receipt?')) return
    setCancelling(true)
    try {
      await setReceiptStatus(receipt.id, 'CANCELLED')
      setLocalStatus('CANCELLED')
    } catch (err) {
      alert('Failed: ' + (err.message || err))
    } finally {
      setCancelling(false)
    }
  }

  const isCancelled = localStatus === 'CANCELLED'

  return (
    <div className="pb-32">
      <PageHero
        eyebrow="SERVICE RECEIPT"
        title={receipt.code}
        subtitle={`${receipt.plateNo} · ${receipt.brandModel || 'Vehicle'}`}
        right={<TotalChip value={receipt.estimatedTotal} />}
      />

      <div className="px-3 sm:px-6 pt-4 space-y-4">
        <div className="flex items-center gap-2">
          <StatusPill status={localStatus} />
          {receipt.scheduleType && (
            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
              {receipt.scheduleType}
            </span>
          )}
        </div>

        <CustomerCard receipt={receipt} />
        <LineItemsCard receipt={receipt} />
        <TotalsCard receipt={receipt} profile={profile} />
      </div>

      <div
        className="fixed bottom-[3.5rem] md:bottom-0 left-0 right-0 z-40 bg-white border-t shadow-[0_-4px_12px_rgba(0,0,0,0.05)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
      >
        <div className="px-3 sm:px-6 py-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-sm px-4 py-3 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-transform"
          >
            <Icon name="print" className="w-4 h-4" />
            Print
          </button>
          <button
            type="button"
            onClick={doCancel}
            disabled={cancelling || isCancelled}
            className="bg-red-500 hover:bg-red-600 disabled:opacity-40 text-white font-bold text-sm px-4 py-3 rounded-xl active:scale-95 transition-transform"
          >
            {isCancelled ? 'Cancelled' : cancelling ? 'Cancelling…' : 'Cancel Receipt'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Shared cards ─────────────────────────────────────────────────────────

function CustomerCard({ receipt }) {
  return (
    <div className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-gray-50 border-b px-4 py-2.5 text-[11px] uppercase tracking-widest font-bold text-gray-500">
        Customer & Vehicle
      </div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <Info label="Plate No.">
          <span className="bg-brand text-white font-mono font-bold tracking-wide px-3 py-1 rounded-lg inline-block">{receipt.plateNo}</span>
        </Info>
        <Info label="Brand / Model">{receipt.brandModel || '—'}</Info>
        <Info label="Latest Odo">{receipt.latestOdo?.toLocaleString() || '—'}</Info>
        <Info label="Customer">{receipt.customer}</Info>
        <Info label="Mobile">{receipt.mobile || '—'}</Info>
        <Info label="Person In-Charge">{receipt.personInCharge || '—'}</Info>
        <Info label="Assigned Mechanic">{receipt.mechanic || '—'}</Info>
        <Info label="Notes" className="sm:col-span-2">{receipt.notes || '—'}</Info>
      </div>
    </div>
  )
}

function LineItemsCard({ receipt }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Items</div>
        <span className="text-xs text-gray-400">{(receipt.items || []).length}</span>
      </div>
      <div className="lg:hidden space-y-2">
        {(receipt.items || []).length === 0 && (
          <div className="bg-white rounded-2xl border border-dashed p-5 text-center text-gray-400 text-sm">No line items.</div>
        )}
        {(receipt.items || []).map((item, i) => (
          <div key={i} className="bg-white rounded-2xl border p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${item.type === 'Labor' ? 'bg-sky-600 text-white' : 'bg-gray-700 text-white'}`}>
                {item.type}
              </span>
              <span className="text-xs text-gray-500 font-bold">× {item.qty}</span>
            </div>
            <div className="text-sm font-semibold text-gray-900 uppercase break-words">
              {item.description || '—'}
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-[11px] text-gray-500">
                {formatMoney(item.unitCost)} × {item.qty}
              </span>
              <span className="text-base font-black text-gray-900">{formatMoney(item.subTotal)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden lg:block bg-white rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm whitespace-nowrap">
            <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Qty</th>
                <th className="px-4 py-3 text-left font-medium">Services / Parts / Materials</th>
                <th className="px-4 py-3 text-right font-medium">Unit Cost</th>
                <th className="px-4 py-3 text-right font-medium">Sub Total</th>
              </tr>
            </thead>
            <tbody>
              {(receipt.items || []).map((item, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-amber-50' : 'bg-white'}>
                  <td className="px-4 py-2">{item.type}</td>
                  <td className="px-4 py-2">{item.qty}</td>
                  <td className="px-4 py-2 uppercase">{item.description}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(item.unitCost)}</td>
                  <td className="px-4 py-2 text-right font-semibold">{formatMoney(item.subTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function TotalsCard({ receipt, profile }) {
  const role = String(profile?.role || '').toLowerCase()
  const isClient = role === 'fleet_client' || role === 'fleet_client_manager'
  const markup = receipt.brokerMarkup
  return (
    <div className="bg-white rounded-2xl border overflow-hidden">
      <div className="bg-gray-50 border-b px-4 py-2.5 text-[11px] uppercase tracking-widest font-bold text-gray-500">
        Totals
      </div>
      <div className="p-4 space-y-2 text-sm">
        {!isClient && markup?.percent > 0 && (
          <div className="flex items-center gap-1.5 mb-1">
            <span className="inline-block px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">
              {markup.percent}% Broker Markup applied
            </span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Labor</span>
          <span className="font-bold text-gray-900">{formatMoney(receipt.laborTotal)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Materials</span>
          <span className="font-bold text-gray-900">{formatMoney(receipt.materialsTotal)}</span>
        </div>
        <div className="border-t pt-3 mt-2 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-600">Estimated Total</span>
          <span className="text-2xl font-black text-green-700">{formatMoney(receipt.estimatedTotal)}</span>
        </div>
      </div>
    </div>
  )
}

function TotalChip({ value }) {
  return (
    <div className="bg-white/15 rounded-xl px-3 py-2 text-right min-w-[110px]">
      <div className="text-[9px] font-bold tracking-widest text-white/60">TOTAL</div>
      <div className="text-xl font-black text-white leading-none mt-0.5">{formatMoney(value)}</div>
    </div>
  )
}

function Info({ label, children, className = '' }) {
  return (
    <div className={className}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</div>
      <div className="text-gray-900 text-sm break-words">{children}</div>
    </div>
  )
}
