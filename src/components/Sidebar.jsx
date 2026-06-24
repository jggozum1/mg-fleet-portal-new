// Desktop-only persistent sidebar. On mobile (< md) the BottomNav and the
// /more screen replace this. We render it `hidden md:flex` so it's never
// in the DOM on phones — no drawer mechanism, no off-canvas transform, no
// overlap risk with the mobile header.

import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  isCustomer, roleLabel,
  canBooking, canBookingRequests, canUnbilledQuotations, canAssess, canServiceRequest, canServiceQuotation,
  canBranchInvoice, canClientInvoice, canCreditNotes,
  canReports, canMyGarage, canFleet, canCustomers, canMechanics, canMyFleet, canClientDashboard, canScheduleService,
} from '../lib/roles'
import { watchAppointments, APPT_STATUS } from '../lib/appointments'
import { watchReceipts, availableQuotationActions, effectiveQuotationStatus, QUOT_STATUS } from '../lib/serviceReceipts'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'

function Section({ title, children }) {
  // Don't render section if no children are truthy
  const hasItems = Array.isArray(children)
    ? children.some(Boolean)
    : Boolean(children)
  if (!hasItems) return null
  return (
    <div className="mb-3">
      <div className="px-4 pt-4 pb-1 text-[11px] uppercase tracking-wider text-sidebar-heading font-semibold">
        {title}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  )
}

function Item({ to, label, badge }) {
  return (
    <li>
      <NavLink
        to={to}
        end
        className={({ isActive }) =>
          `flex items-center justify-between px-4 py-1.5 text-sm transition-colors ` +
          (isActive
            ? 'bg-brand text-white'
            : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white')
        }
      >
        <span>{label}</span>
        {badge != null && badge > 0 && (
          <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-semibold">
            {badge}
          </span>
        )}
      </NavLink>
    </li>
  )
}

function AdminSection({ profile }) {
  if (!profile?.is_admin) return null
  return (
    <Section title="Admin">
      <Item to="/admin/fleet-companies" label="Fleet Companies" />
      <Item to="/admin/users" label="Users" />
      <Item to="/admin/vehicle-catalog" label="Vehicle Catalog" />
      <Item to="/admin/cavite-catalog" label="Price Catalog" />
      <Item to="/admin/branch-services" label="Branch Services" />
      <Item to="/admin/branch-parts" label="Branch Parts" />
    </Section>
  )
}

function Brand() {
  return (
    <div className="px-4 pt-4 pb-3 border-b border-gray-800">
      <div className="flex justify-center mb-3">
        <img
          src="/assets/mg-logo.jpg"
          alt="Master Garage"
          className="w-28 h-28 object-cover rounded-full border-2 border-gray-700"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      </div>
      <div className="text-white font-black text-base tracking-wide text-center">
        MG FLEET PORTAL
      </div>
    </div>
  )
}

function Footer({ profile }) {
  const name = profile?.name || profile?.email || 'guest'
  return (
    <div className="mt-auto px-4 py-3 border-t border-gray-800 text-[11px] text-sidebar-heading">
      <div>Logged in as:</div>
      <div className="text-sidebar-text truncate" title={name}>
        {name.toString().toLowerCase().replace(/\s+/g, '_')}
        {profile?.is_admin ? ' · admin' : ''}
      </div>
      {profile?.role && (
        <div className="text-[10px] text-gray-600 mt-0.5">{roleLabel(profile.role)}</div>
      )}
    </div>
  )
}

export default function Sidebar() {
  const { profile } = useAuth()
  const role = profile?.role
  // Admins always get the full internal sidebar regardless of their role.
  const customerView = isCustomer(role) && !profile?.is_admin

  // Live count of landing sign-ups for the badge
  const [signupCount, setSignupCount] = useState(0)
  useEffect(() => {
    if (!profile?.is_admin || !db) return
    const unsub = onSnapshot(collection(db, 'landing_signups'), (snap) => {
      setSignupCount(snap.size)
    })
    return unsub
  }, [profile?.is_admin])

  // Live count of landing contact-us messages for the badge
  const [contactCount, setContactCount] = useState(0)
  useEffect(() => {
    if (!profile?.is_admin || !db) return
    const unsub = onSnapshot(collection(db, 'landing_contacts'), (snap) => {
      setContactCount(snap.size)
    })
    return unsub
  }, [profile?.is_admin])

  // Live count of quotations needing action for the badge
  const [quotationNeedsAction, setQuotationNeedsAction] = useState(0)
  useEffect(() => {
    if (customerView || !canServiceQuotation(role)) return
    const isFleetMgr = String(role).toLowerCase() === 'general_manager'
    const unsub = watchReceipts({ kind: 'quotation' }, ({ rows }) => {
      const visible = isFleetMgr
        ? rows.filter((q) => effectiveQuotationStatus(q) !== QUOT_STATUS.DRAFT)
        : rows
      const count = visible.filter((q) => availableQuotationActions(q, profile).length > 0).length
      setQuotationNeedsAction(count)
    })
    return unsub
  }, [role, customerView, profile])

  // Live count of pending booking requests for the badge
  const [pendingBookings, setPendingBookings] = useState(0)
  useEffect(() => {
    if (customerView || !canBookingRequests(role)) return
    const unsub = watchAppointments({ dummyFallback: false }, ({ rows }) => {
      setPendingBookings(rows.filter((a) => a.status === APPT_STATUS.PENDING_BOOKING || a.status === APPT_STATUS.PENDING_BRANCH_APPROVAL).length)
    })
    return unsub
  }, [role, customerView])

  // Live count of quotations for review (fleet client sidebar badge)
  const [forReviewCount, setForReviewCount] = useState(0)
  useEffect(() => {
    if (!customerView || !canServiceQuotation(role)) return
    const unsub = watchReceipts({ kind: 'quotation' }, ({ rows }) => {
      const cf = (profile?.company_id || profile?.company || '').toLowerCase().trim()
      const count = rows.filter((q) => {
        const s = effectiveQuotationStatus(q)
        if (s !== QUOT_STATUS.FOR_CLIENT_REVIEW) return false
        if (!cf) return true
        const rc = (q.company || '').toLowerCase().trim()
        return rc === cf || rc.includes(cf) || cf.includes(rc)
      }).length
      setForReviewCount(count)
    })
    return unsub
  }, [role, customerView, profile])

  const shellClasses = 'hidden md:flex w-60 h-full bg-sidebar text-sidebar-text overflow-y-auto flex-col shrink-0'

  if (customerView) {
    return (
      <aside className={shellClasses}>
        <Brand />
        <Section title="Fleet">
          <Item to="/portal/notifications" label="Notifications" />
          {canClientDashboard(role) && <Item to="/portal" label="Fleet Dashboard" />}
          {canMyFleet(role) && <Item to="/portal/my-fleet" label="My Fleet" />}
          {canServiceQuotation(role) && <Item to="/portal/quotations" label="Service Quotations" badge={forReviewCount} />}
          {canClientInvoice(role) && <Item to="/portal/invoices" label="Service Receipts" />}
          {canClientInvoice(role) && <Item to="/portal/statement" label="Statement of Account" />}
          {canScheduleService(role) && <Item to="/portal/schedule-service" label="+ Request for Service" />}
        </Section>
        <AdminSection profile={profile} />
        <Footer profile={profile} />
      </aside>
    )
  }

  return (
    <aside className={shellClasses}>
      <Brand />
      <Section title="Quick Links">
        {canMyGarage(role) && <Item to="/home" label="My Garage" />}
        {canMechanics(role) && <Item to="/home/my-mechanics" label="My Mechanics" />}
        {canBooking(role) && <Item to="/appointments?quicklink=yes" label="+ Booking" />}
        {canServiceRequest(role) && <Item to="/service-receipts/create" label="+ Service Receipt" />}
        <Item to="/home/notifications" label="Notifications" />
      </Section>
      {profile?.is_admin && <Section title="Sign-ups">
        <Item to="/admin/fleet-signups" label="Fleet Sign-ups" badge={signupCount} />
        <Item to="/admin/fleet-contact-us" label="Fleet Contact-us" badge={contactCount} />
      </Section>}
      <Section title="Core Operations">
        {canBookingRequests(role) && <Item to="/booking-requests" label="Booking Requests" badge={pendingBookings} />}
        {canBooking(role) && <Item to="/appointments" label="Service Bookings" />}
        {canServiceRequest(role) && <Item to="/service-receipts" label="Service Receipts" />}
        {canServiceQuotation(role) && <Item to="/quotations" label="Service Quotations" badge={quotationNeedsAction} />}
        {canUnbilledQuotations(role) && <Item to="/quotations/unbilled" label="Services for Quotation" />}
        {canBranchInvoice(role) && <Item to="/branch-invoices" label="Branch Invoices" />}
        {canClientInvoice(role) && <Item to="/client-invoices" label="Client Invoices" />}
        {canCreditNotes(role) && <Item to="/credit-notes" label="Credit Notes" />}
        {canReports(role) && <Item to="/reports" label="Reports" />}
      </Section>
      <Section title="Data Management">
        {canFleet(role) && <Item to="/vehicles" label="Fleet" />}
        {canMechanics(role) && <Item to="/mechanics" label="Mechanics" />}
        {canMechanics(role) && <Item to="/services" label="Services Offered" />}
      </Section>
      <AdminSection profile={profile} />
      <Footer profile={profile} />
    </aside>
  )
}
