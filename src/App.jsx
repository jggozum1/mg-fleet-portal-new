import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import PortalLayout from './layouts/PortalLayout'

import Login from './pages/Login'
import Home from './pages/Home'
import Portal from './pages/Portal'
import MyFleet from './pages/MyFleet'
import ServiceLog from './pages/ServiceLog'
import Placeholder from './pages/Placeholder'

import Notifications from './pages/Notifications'
import MyMechanics from './pages/MyMechanics'
import Customers from './pages/Customers'
import Vehicles from './pages/Vehicles'
import VehicleDetails from './pages/VehicleDetails'
import Mechanics from './pages/Mechanics'
import Services from './pages/Services'
import Reports from './pages/Reports'

import ServiceBooking from './pages/ServiceBooking'
import VehicleServiceUpdate from './pages/VehicleServiceUpdate'
import AssessmentView from './pages/AssessmentView'
import AssessmentForm from './pages/AssessmentForm'
import PmsRecord from './pages/PmsRecord'
import AssignMechanic from './pages/AssignMechanic'

import Quotations from './pages/Quotations'
import ServiceReceipts from './pages/ServiceReceipts'
import ServiceReceiptCreate from './pages/ServiceReceiptCreate'
import ServiceReceiptDetails from './pages/ServiceReceiptDetails'
import BranchInvoices from './pages/BranchInvoices'
import BranchInvoiceDetails from './pages/BranchInvoiceDetails'
import ClientInvoices from './pages/ClientInvoices'
import ClientInvoiceDetails from './pages/ClientInvoiceDetails'
import CreditNotes from './pages/CreditNotes'
import CreditNoteDetails from './pages/CreditNoteDetails'
import ReceivablesReport from './pages/ReceivablesReport'
import StatementOfAccount from './pages/StatementOfAccount'

import BookingRequests from './pages/BookingRequests'
import ScheduleService from './pages/ScheduleService'
import FleetCompanies from './pages/admin/FleetCompanies'
import Users from './pages/admin/Users'
import VehicleCatalogIngest from './pages/admin/VehicleCatalogIngest'
import CaviteCatalogIngest from './pages/admin/CaviteCatalogIngest'
import AuthComplete from './pages/AuthComplete'
import More from './pages/More'
import LandingSignups from './pages/LandingSignups'
import LandingContacts from './pages/LandingContacts'
import FixUser from './pages/FixUser'
import OtpVerify from './pages/OtpVerify'

const INTERNAL = ['internal']
const CUSTOMER = ['customer']
const BOTH = ['internal', 'customer']

const ph = (title, description) => <Placeholder title={title} description={description} />

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/otp-verify" element={<OtpVerify />} />
        <Route path="/fix-user" element={<FixUser />} />
        <Route path="/auth/complete" element={<AuthComplete />} />

        <Route
          element={
            <ProtectedRoute>
              <PortalLayout />
            </ProtectedRoute>
          }
        >
          {/* Internal staff — My Garage (requires myGarage permission) */}
          <Route path="/home"                  element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="myGarage"><Home /></ProtectedRoute>} />
          <Route path="/home/notifications"    element={<ProtectedRoute allowedCategories={INTERNAL}><Notifications /></ProtectedRoute>} />
          <Route path="/home/my-mechanics"     element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="myGarage"><MyMechanics /></ProtectedRoute>} />

          {/* Appointments / Service Booking (requires booking permission) */}
          <Route path="/appointments"                element={<ProtectedRoute allowedCategories={BOTH} requiredPermission="booking"><ServiceBooking /></ProtectedRoute>} />
          <Route path="/appointments/:id/update"     element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="booking"><VehicleServiceUpdate /></ProtectedRoute>} />
          <Route path="/appointments/:id/assess"     element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="assessment"><AssessmentForm /></ProtectedRoute>} />
          {/* Back-compat: old /diagnose URLs bookmarked or linked from Firestore notifications. */}
          <Route path="/appointments/:id/diagnose"   element={<DiagnoseRedirect />} />
          <Route path="/appointments/:id/pms"        element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="assessment"><PmsRecord /></ProtectedRoute>} />
          <Route path="/appointments/:id/assign"     element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="booking"><AssignMechanic /></ProtectedRoute>} />

          {/* Booking Requests — call center view of fleet client requests */}
          <Route path="/booking-requests"          element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="bookingRequests"><BookingRequests /></ProtectedRoute>} />

          {/* Quotations (requires serviceQuotation permission) */}
          <Route path="/quotations"            element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="serviceQuotation"><Quotations /></ProtectedRoute>} />
          <Route path="/quotations/unbilled"   element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="unbilledQuotations"><Quotations unbilledOnly /></ProtectedRoute>} />
          <Route path="/quotations/create"     element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="serviceQuotation"><ServiceReceiptCreate kind="quotation" /></ProtectedRoute>} />

          {/* Service Receipts (requires serviceRequest permission) */}
          <Route path="/service-receipts"        element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="serviceRequest"><ServiceReceipts /></ProtectedRoute>} />
          <Route path="/service-receipts/create" element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="serviceRequest"><ServiceReceiptCreate /></ProtectedRoute>} />
          <Route path="/service-receipts/:code"  element={<ProtectedRoute allowedCategories={BOTH}><ServiceReceiptDetails /></ProtectedRoute>} />

          {/* Branch Invoices (branch → MG Fleet, Round 12) */}
          <Route path="/branch-invoices"       element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="branchInvoice"><BranchInvoices /></ProtectedRoute>} />
          <Route path="/branch-invoices/:code" element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="branchInvoice"><BranchInvoiceDetails /></ProtectedRoute>} />

          {/* Client Invoices (MG Fleet → fleet client, Round 13) */}
          <Route path="/client-invoices"       element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="clientInvoice"><ClientInvoices /></ProtectedRoute>} />
          <Route path="/client-invoices/:code" element={<ProtectedRoute allowedCategories={BOTH} requiredPermission="clientInvoice"><ClientInvoiceDetails /></ProtectedRoute>} />

          {/* Credit Notes (escape hatch for already-paid/billed invoices, Round 15) */}
          <Route path="/credit-notes"          element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="creditNotes"><CreditNotes /></ProtectedRoute>} />
          <Route path="/credit-notes/:code"    element={<ProtectedRoute allowedCategories={BOTH} requiredPermission="creditNotes"><CreditNoteDetails /></ProtectedRoute>} />

          {/* Reports (requires reports permission) */}
          <Route path="/reports"                  element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="reports"><Reports /></ProtectedRoute>} />
          <Route path="/reports/receivables"      element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="reports"><ReceivablesReport /></ProtectedRoute>} />
          <Route path="/reports/soa/:company"     element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="reports"><StatementOfAccount /></ProtectedRoute>} />

          {/* Data management */}
          <Route path="/customers"             element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="customers"><Customers /></ProtectedRoute>} />
          <Route path="/vehicles"              element={<ProtectedRoute allowedCategories={INTERNAL} requiredPermission="fleet"><Vehicles /></ProtectedRoute>} />
          <Route path="/vehicles/search"       element={<ProtectedRoute allowedCategories={BOTH}>{ph('Vehicle Search', 'Jump straight to a plate from the topbar.')}</ProtectedRoute>} />
          <Route path="/vehicles/:plateNo"     element={<ProtectedRoute allowedCategories={BOTH}><VehicleDetails /></ProtectedRoute>} />
          <Route path="/assessments/:rwa"      element={<ProtectedRoute allowedCategories={BOTH}><AssessmentView /></ProtectedRoute>} />
          <Route path="/mechanics"             element={<ProtectedRoute allowedCategories={INTERNAL}><Mechanics /></ProtectedRoute>} />
          <Route path="/services"              element={<ProtectedRoute allowedCategories={INTERNAL}><Services /></ProtectedRoute>} />

          {/* Fleet customer */}
          <Route path="/portal"                element={<ProtectedRoute allowedCategories={CUSTOMER} requiredPermission="clientDashboard"><Portal /></ProtectedRoute>} />
          <Route path="/portal/notifications"  element={<ProtectedRoute allowedCategories={CUSTOMER}><Notifications /></ProtectedRoute>} />
          <Route path="/portal/my-fleet"       element={<ProtectedRoute allowedCategories={CUSTOMER} requiredPermission="myFleet"><MyFleet /></ProtectedRoute>} />
          <Route path="/portal/service-log"    element={<ProtectedRoute allowedCategories={CUSTOMER}><ServiceLog /></ProtectedRoute>} />
          <Route path="/portal/quotations"     element={<ProtectedRoute allowedCategories={CUSTOMER} requiredPermission="serviceQuotation"><Quotations customerView /></ProtectedRoute>} />
          <Route path="/portal/invoices"       element={<ProtectedRoute allowedCategories={CUSTOMER} requiredPermission="clientInvoice"><ClientInvoices customerView /></ProtectedRoute>} />
          <Route path="/portal/statement"      element={<ProtectedRoute allowedCategories={CUSTOMER} requiredPermission="clientInvoice"><StatementOfAccount customerView /></ProtectedRoute>} />
          <Route path="/portal/schedule-service" element={<ProtectedRoute allowedCategories={CUSTOMER} requiredPermission="scheduleService"><ScheduleService /></ProtectedRoute>} />

          {/* Admin (gated by is_admin flag, not by role category) */}
          <Route path="/admin/fleet-signups"     element={<ProtectedRoute requireAdmin><LandingSignups /></ProtectedRoute>} />
          <Route path="/admin/fleet-contact-us"  element={<ProtectedRoute requireAdmin><LandingContacts /></ProtectedRoute>} />
          <Route path="/admin/fleet-companies"  element={<ProtectedRoute requireAdmin><FleetCompanies /></ProtectedRoute>} />
          <Route path="/admin/users"            element={<ProtectedRoute requireAdmin><Users /></ProtectedRoute>} />
          <Route path="/admin/vehicle-catalog"  element={<ProtectedRoute requireAdmin><VehicleCatalogIngest /></ProtectedRoute>} />
          <Route path="/admin/cavite-catalog"   element={<ProtectedRoute requireAdmin><CaviteCatalogIngest /></ProtectedRoute>} />

          {/* Mobile More screen — overflow menu for the BottomNav */}
          <Route path="/more"                  element={<ProtectedRoute allowedCategories={BOTH}><More /></ProtectedRoute>} />

          {/* Shared /notifications for users reaching it via the mobile bell */}
          <Route path="/notifications"         element={<ProtectedRoute allowedCategories={BOTH}><Notifications /></ProtectedRoute>} />
        </Route>

        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </AuthProvider>
  )
}

// Preserves old /appointments/:id/diagnose URLs — Firestore notifications
// emitted before the rename still point there. Redirects to /assess.
function DiagnoseRedirect() {
  const { id } = useParams()
  return <Navigate to={`/appointments/${id}/assess`} replace />
}
