// Mobile-only "More" screen — full-screen menu of every route that didn't
// fit on the bottom nav. Role-aware (matches Sidebar's logic) and also
// surfaces the plate search + branch/role info + logout that live in the
// desktop Topbar. On md+ users shouldn't reach this page because the
// sidebar exposes everything directly — if they do, we render normally.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  isCustomer, roleLabel,
  canBooking, canBookingRequests, canUnbilledQuotations, canServiceRequest, canServiceQuotation,
  canBranchInvoice, canClientInvoice, canCreditNotes,
  canReports, canMyGarage, canFleet, canCustomers, canMechanics, canScheduleService,
} from '../lib/roles'
import { watchAppointments, APPT_STATUS } from '../lib/appointments'
import { watchReceipts, availableQuotationActions, effectiveQuotationStatus, QUOT_STATUS } from '../lib/serviceReceipts'
import Icon from '../components/ui/Icon'

function SectionHeader({ children }) {
  return (
    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 pt-5 pb-2">
      {children}
    </div>
  )
}

function Row({ to, label, icon, badge, onClick }) {
  const body = (
    <div className="flex items-center gap-3 px-4 py-3.5 bg-white hover:bg-gray-50 active:bg-gray-100">
      <div className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">
        <Icon name={icon} className="w-5 h-5" />
      </div>
      <span className="flex-1 text-[15px] text-gray-800 font-medium">{label}</span>
      {badge != null && badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-semibold">
          {badge}
        </span>
      )}
      <span className="text-gray-300 text-xl leading-none">›</span>
    </div>
  )
  if (onClick) return <button type="button" onClick={onClick} className="w-full text-left">{body}</button>
  return <Link to={to}>{body}</Link>
}

export default function More() {
  const { profile, user, logout } = useAuth()
  const navigate = useNavigate()
  const [plate, setPlate] = useState('')

  const customerView = isCustomer(profile?.role) && !profile?.is_admin

  const handleSearch = (e) => {
    e.preventDefault()
    const p = plate.trim().toUpperCase().replace(/\s+/g, '')
    if (p) navigate(`/vehicles/${encodeURIComponent(p)}`)
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="pb-24 min-h-screen bg-gray-50">
      {/* Brand strip — match mg-fms TopBar feel */}
      <div className="bg-brand text-white px-4 pt-5 pb-4">
        <div className="text-[10px] font-bold tracking-widest text-white/60 mb-0.5">LOGGED IN AS</div>
        <div className="font-black text-lg leading-tight truncate">{profile?.name || user?.email || 'User'}</div>
        <div className="text-white/70 text-xs mt-0.5">
          {roleLabel(profile?.role) || 'No role'}
          {profile?.branch ? ` · ${profile.branch}` : ''}
          {profile?.is_admin ? ' · admin' : ''}
        </div>
      </div>

      {/* Plate search — staff-only; fleet customers don't look up arbitrary plates */}
      {!customerView && (
        <form onSubmit={handleSearch} className="px-4 pt-4">
          <div className="relative">
            <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={plate}
              onChange={(e) => setPlate(e.target.value)}
              placeholder="Search plate…"
              className="input pl-9 uppercase"
            />
          </div>
        </form>
      )}

      {customerView ? <CustomerMenu profile={profile} /> : <StaffMenu profile={profile} />}

      <SectionHeader>Account</SectionHeader>
      <div className="bg-white divide-y">
        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 active:bg-gray-100"
        >
          <div className="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
            <Icon name="user" className="w-5 h-5" />
          </div>
          <span className="flex-1 text-[15px] text-red-700 font-semibold">Log out</span>
        </button>
      </div>
    </div>
  )
}

function CustomerMenu({ profile }) {
  const role = profile?.role
  const [forReviewCount, setForReviewCount] = useState(0)
  useEffect(() => {
    if (!canServiceQuotation(role)) return
    const unsub = watchReceipts({ kind: 'quotation' }, ({ rows }) => {
      const cf = (profile?.company_id || profile?.company || '').toLowerCase().trim()
      const count = rows.filter((q) => {
        if (effectiveQuotationStatus(q) !== QUOT_STATUS.FOR_CLIENT_REVIEW) return false
        if (!cf) return true
        const rc = (q.company || '').toLowerCase().trim()
        return rc === cf || rc.includes(cf) || cf.includes(rc)
      }).length
      setForReviewCount(count)
    })
    return unsub
  }, [role, profile])

  return (
    <>
      <SectionHeader>Fleet</SectionHeader>
      <div className="bg-white divide-y">
        {canServiceQuotation(role) && <Row to="/portal/quotations" icon="doc" label="Service Quotations" badge={forReviewCount} />}
        {canClientInvoice(role) && <Row to="/portal/invoices" icon="doc" label="Service Receipts" />}
        {canClientInvoice(role) && <Row to="/portal/statement" icon="doc" label="Statement of Account" />}
        {canScheduleService(role) && (
          <Row to="/portal/schedule-service" icon="calendar" label="Request for Service" />
        )}
      </div>

      {profile?.is_admin && (
        <>
          <SectionHeader>Admin</SectionHeader>
          <div className="bg-white divide-y">
            <Row to="/admin/fleet-companies" icon="tool" label="Fleet Companies" />
            <Row to="/admin/users" icon="user" label="Users" />
            <Row to="/admin/vehicle-catalog" icon="car" label="Vehicle Catalog" />
            <Row to="/admin/cavite-catalog" icon="doc" label="Price Catalog" />
            <Row to="/admin/branch-services" icon="doc" label="Branch Services" />
            <Row to="/admin/branch-parts" icon="doc" label="Branch Parts" />
          </div>
        </>
      )}
    </>
  )
}

function StaffMenu({ profile }) {
  const role = profile?.role
  const [quotationNeedsAction, setQuotationNeedsAction] = useState(0)
  useEffect(() => {
    if (!canServiceQuotation(role)) return
    const isFleetMgr = String(role).toLowerCase() === 'general_manager'
    const unsub = watchReceipts({ kind: 'quotation' }, ({ rows }) => {
      const visible = isFleetMgr
        ? rows.filter((q) => effectiveQuotationStatus(q) !== QUOT_STATUS.DRAFT)
        : rows
      const count = visible.filter((q) => availableQuotationActions(q, profile).length > 0).length
      setQuotationNeedsAction(count)
    })
    return unsub
  }, [role, profile])

  const [pendingBookings, setPendingBookings] = useState(0)
  useEffect(() => {
    if (!canBookingRequests(role)) return
    const unsub = watchAppointments({ dummyFallback: false }, ({ rows }) => {
      setPendingBookings(rows.filter((a) => a.status === APPT_STATUS.PENDING_BOOKING || a.status === APPT_STATUS.PENDING_BRANCH_APPROVAL).length)
    })
    return unsub
  }, [role])

  return (
    <>
      <SectionHeader>Quick Links</SectionHeader>
      <div className="bg-white divide-y">
        {canMechanics(role) && <Row to="/home/my-mechanics" icon="user" label="My Mechanics" />}
        {canBooking(role) && <Row to="/appointments?quicklink=yes" icon="plus" label="+ Booking" />}
        {canServiceRequest(role) && <Row to="/service-receipts/create" icon="plus" label="+ Service Receipt" />}
      </div>

      <SectionHeader>Core Operations</SectionHeader>
      <div className="bg-white divide-y">
        {canBookingRequests(role) && <Row to="/booking-requests" icon="calendar" label="Booking Requests" badge={pendingBookings} />}
        {canServiceQuotation(role) && <Row to="/quotations" icon="doc" label="Service Quotations" badge={quotationNeedsAction} />}
        {canUnbilledQuotations(role) && <Row to="/quotations/unbilled" icon="doc" label="Services for Quotation" />}
        {canBranchInvoice(role) && <Row to="/branch-invoices" icon="doc" label="Branch Invoices" />}
        {canClientInvoice(role) && <Row to="/client-invoices" icon="doc" label="Client Invoices" />}
        {canCreditNotes(role) && <Row to="/credit-notes" icon="doc" label="Credit Notes" />}
        {canReports(role) && <Row to="/reports" icon="backlog" label="Reports" />}
      </div>

      <SectionHeader>Data Management</SectionHeader>
      <div className="bg-white divide-y">
        {canFleet(role) && <Row to="/vehicles" icon="car" label="Fleet" />}
        {canMechanics(role) && <Row to="/mechanics" icon="tool" label="Mechanics" />}
        {canMechanics(role) && <Row to="/services" icon="tool" label="Services Offered" />}
      </div>

      {profile?.is_admin && (
        <>
          <SectionHeader>Admin</SectionHeader>
          <div className="bg-white divide-y">
            <Row to="/admin/fleet-companies" icon="tool" label="Fleet Companies" />
            <Row to="/admin/users" icon="user" label="Users" />
            <Row to="/admin/vehicle-catalog" icon="car" label="Vehicle Catalog" />
            <Row to="/admin/cavite-catalog" icon="doc" label="Price Catalog" />
            <Row to="/admin/branch-services" icon="doc" label="Branch Services" />
            <Row to="/admin/branch-parts" icon="doc" label="Branch Parts" />
          </div>
        </>
      )}
    </>
  )
}
